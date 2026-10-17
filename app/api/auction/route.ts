import { after, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import Auction, { type IAuction, type IAuctionBid } from '@/lib/models/Auction';
import AuctionHold from '@/lib/models/AuctionHold';
import AuctionItem from '@/lib/models/AuctionItem';
import User from '@/lib/models/User';
import { getSessionUser } from '@/lib/auth/session';
import { adjustPlayersDKP, getSheetRoster, getSheetRosterSnapshot, withDkpLedgerLock } from '@/lib/googleSheets';
import { getLinkedSheetRecordRows, getSheetRecordKey } from '@/lib/sheetRecordLinks';
import { canRetryAuctionSettlement, getAuctionSettlementMutationKey, needsSettlementManualReview } from '@/lib/auctionSettlement';
import { canAffordBid, DkpIntegrityError } from '@/lib/dkpAccounting';
import { getRosterWithWeeklyEarned } from '@/lib/dkpWeeklyEarned';
import { canBindAuctionHold, hasMovedAuctionReservation, holdMatchesIdentity, isAuctionBidInput, isAuctionPoster, serializeAuctionBid as serializeBid } from '@/lib/auctionSecurity';
import { guardMutationRequest, readJsonObject, requestErrorResponse, RequestValidationError } from '@/lib/security/request';
import { withClanAdministrationTransaction } from '@/lib/auth/administration';
import {
  AUCTION_DURATION_MS,
  AUCTION_WEEKLY_MINIMUM,
  getAuctionBidEndTime,
  normalizeAuctionBossType,
  normalizeAuctionRole,
} from '@/lib/auctionRules';

const MANAGER_ROLES = new Set(['chief', 'general', 'guardian']);
const RESERVING_STATUSES: IAuction['status'][] = ['active', 'removing', 'settling', 'settlement-failed'];
let lastLiveExpirySweepAt = 0;
let expirySweepRunning = false;

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function isManager(role: string) {
  return MANAGER_ROLES.has(role);
}

async function getAuctionActor(userId: mongoose.Types.ObjectId, session: mongoose.ClientSession) {
  const actor = await User.findById(userId).select('_id nickname role status sheetRecords sheetRecordName').session(session);
  if (!actor || actor.status !== 'approved') throw new RequestValidationError('Your session is no longer authorized.', 401);
  return actor;
}

/** Called inside a transaction; old holds are bound only after checking their outstanding bids. */
async function getBoundAuctionHold(bid: Pick<IAuctionBid, 'rowIndex' | 'owner' | 'account'>, session: mongoose.ClientSession) {
  let hold = await AuctionHold.findOne({ rowIndex: bid.rowIndex }).session(session);
  if (!hold) {
    [hold] = await AuctionHold.create([{
      rowIndex: bid.rowIndex, heldPoints: 0, owner: bid.owner, account: bid.account,
    }], { session });
  }
  const auctions = await Auction.find({ status: { $in: RESERVING_STATUSES }, 'highBid.rowIndex': bid.rowIndex })
    .select('highBid').session(session).lean();
  const reservations = auctions.flatMap((auction) => auction.highBid ? [auction.highBid] : []);
  if (!canBindAuctionHold(hold, bid, reservations)) {
    throw new RequestValidationError('This toon has an inconsistent or moved auction reservation. Ask a manager to review it.', 409);
  }
  hold.owner = bid.owner;
  hold.account = bid.account;
  return hold;
}

async function settleExpiredAuctions() {
  const now = new Date();
  const deadline = Date.now() + 45_000;
  // Older versions claimed removal outside the deletion transaction. An existing
  // stale record still owns its hold, because releasing and deleting were atomic.
  await Auction.updateMany(
    { status: 'removing', updatedAt: { $lt: new Date(now.getTime() - 5 * 60_000) } },
    { $set: { status: 'active' } },
  );
  const recoverable: Record<string, unknown>[] = [
    { status: 'active' },
    {
      status: 'settlement-failed', settlementNeedsReview: { $ne: true },
      $or: [{ settlementRetryAt: { $lte: now } }, { settlementRetryAt: { $exists: false } }],
    },
    { status: 'settling', $or: [{ settlementLeaseUntil: { $lte: now } }, { settlementLeaseUntil: { $exists: false } }] },
  ];
  const expiredAuctions = await Auction.find({
    $or: recoverable,
    endsAt: { $lte: now },
  }).sort({ endsAt: 1 }).limit(25);

  for (const expired of expiredAuctions) {
    if (Date.now() >= deadline) break;
    if (!expired.highBid) {
      await Auction.updateOne(
        { _id: expired._id, status: expired.status, highBid: null, endsAt: { $lte: now } },
        {
          $set: { status: 'completed', deliveryStatus: 'not-required' },
          $unset: { settlementAttemptId: 1, settlementLeaseUntil: 1 },
        },
      );
      continue;
    }

    const attemptId = randomUUID();
    const wasLegacyUntrackedSettlement = needsSettlementManualReview(expired);
    if (wasLegacyUntrackedSettlement) {
      await Auction.updateOne(
        { _id: expired._id, status: expired.status, settlementAttemptId: { $exists: false }, settlementDkpApplied: { $ne: true } },
        { $set: { status: 'settlement-failed', settlementNeedsReview: true, settlementError: 'Interrupted settlement has no replay record. Verify the Sheet balance before retrying.' } },
      );
      continue;
    }
    const claimed = await Auction.findOneAndUpdate(
      {
        _id: expired._id,
        endsAt: { $lte: now },
        $or: recoverable,
      },
      { $set: { status: 'settling', settlementError: undefined, settlementAttemptId: attemptId, settlementLeaseUntil: new Date(Date.now() + 5 * 60_000) } },
      { new: true },
    );
    if (!claimed?.highBid) continue;

    let dkpDeductionCompleted = claimed.settlementDkpApplied;
    try {
      const winningBid = claimed.highBid;
      if (!claimed.settlementDkpApplied) {
        const bindingSession = await mongoose.startSession();
        try {
          await bindingSession.withTransaction(async () => {
            const hold = await getBoundAuctionHold(winningBid, bindingSession);
            if (hold.heldPoints < winningBid.amount) throw new DkpIntegrityError('The winning auction reservation is missing.');
            await hold.save({ session: bindingSession });
          });
        } finally {
          await bindingSession.endSession();
        }
        await adjustPlayersDKP(
          [{
            rowIndex: winningBid.rowIndex,
            points: -winningBid.amount,
            owner: winningBid.owner,
            account: winningBid.account,
          }],
          {
            reservedPointsToConsume: new Map([[winningBid.rowIndex, winningBid.amount]]),
            mode: 'auction-spend',
            idempotencyKey: getAuctionSettlementMutationKey(claimed._id.toString()),
          },
        );
        dkpDeductionCompleted = true;
        const markedApplied = await Auction.updateOne(
          { _id: claimed._id, status: 'settling', settlementAttemptId: attemptId, settlementDkpApplied: { $ne: true } },
          { $set: { settlementDkpApplied: true } },
        );
        if (markedApplied.modifiedCount !== 1) {
          throw new Error('DKP was deducted, but settlement progress could not be recorded. Manual review is required.');
        }
      }

      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const auction = await Auction.findOne({ _id: claimed._id, status: 'settling', settlementAttemptId: attemptId }).session(session);
          const hold = await getBoundAuctionHold(winningBid, session);
          if (!auction || !hold || hold.heldPoints < winningBid.amount) {
            throw new DkpIntegrityError('Auction settlement records are inconsistent; manual review is required.');
          }

          hold.heldPoints -= winningBid.amount;
          await hold.save({ session });
          auction.status = 'completed';
          auction.winner = winningBid;
          auction.deliveryStatus = 'pending';
          auction.settlementError = undefined;
          auction.settlementAttemptId = undefined;
          auction.settlementLeaseUntil = undefined;
          auction.settlementRetryAt = undefined;
          await auction.save({ session });
        });
      } finally {
        await session.endSession();
      }
    } catch (error: unknown) {
      await Auction.updateOne(
        { _id: claimed._id, status: 'settling', settlementAttemptId: attemptId },
        {
          $set: {
            status: 'settlement-failed',
            settlementError: 'Settlement could not finish. Reserved DKP remains protected while a manager reviews the records.',
            ...(dkpDeductionCompleted ? { settlementDkpApplied: true } : {}),
            settlementAttemptId: attemptId,
            settlementLeaseUntil: new Date(0),
            settlementRetryAt: new Date(Date.now() + 30_000),
            ...((error instanceof DkpIntegrityError || error instanceof RequestValidationError) ? { settlementNeedsReview: true } : {}),
          },
        },
      );
      console.error(`Failed to settle auction ${claimed._id.toString()}`, error instanceof Error ? error.name : 'UnknownError');
    }
  }
}

/** Financial work can finish after the response while the UI continues polling. */
function scheduleExpirySweep() {
  if (expirySweepRunning || Date.now() - lastLiveExpirySweepAt < 2_000) return;
  lastLiveExpirySweepAt = Date.now();
  after(async () => {
    if (expirySweepRunning) return;
    expirySweepRunning = true;
    try {
      await settleExpiredAuctions();
    } catch (error: unknown) {
      console.error('Auction expiry sweep will retry on a later request.', error instanceof Error ? error.name : 'UnknownError');
    } finally {
      expirySweepRunning = false;
    }
  });
}

export async function GET(request: Request) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (new URL(request.url).searchParams.get('live') === '1') return getLiveAuctionUpdates(request, user);
    const includeArchive = new URL(request.url).searchParams.get('includeArchive') === '1';
    scheduleExpirySweep();
    const [rosterSnapshot, recentAuctions, items, holds, pendingDeliveryTasks, pendingNoBidTasks, personalWinningAuctions, allWinnerAuctions, unresolvedAuctions] = await Promise.all([
      getSheetRosterSnapshot(),
      includeArchive
        ? Auction.find().sort({ createdAt: -1 }).lean()
        : Auction.find().sort({ createdAt: -1 }).limit(100).lean(),
      AuctionItem.find().select('name requiredRoles requiredRole bossType imageCount isListed').sort({ name: 1 }).lean(),
      AuctionHold.find().select('rowIndex heldPoints owner account').lean(),
      Auction.find({ status: 'completed', deliveryStatus: 'pending' }).sort({ createdAt: 1 }).lean(),
      Auction.find({
        status: 'completed',
        highBid: { $exists: false },
        deliveryStatus: 'not-required',
      }).sort({ createdAt: 1 }).lean(),
      Auction.find({
        status: 'completed',
        'winner.userId': user._id,
      }).sort({ createdAt: -1 }).limit(100).lean(),
      Auction.find({
        status: 'completed',
        winner: { $exists: true },
      }).sort({ createdAt: -1 }).limit(100).lean(),
      Auction.find({ status: { $in: ['active', 'settling', 'settlement-failed'] } }).lean(),
    ]);
    const roster = rosterSnapshot.roster;
    const auctionsById = new Map(recentAuctions.map((auction) => [auction._id.toString(), auction]));
    for (const auction of pendingDeliveryTasks) auctionsById.set(auction._id.toString(), auction);
    for (const auction of pendingNoBidTasks) auctionsById.set(auction._id.toString(), auction);
    for (const auction of personalWinningAuctions) auctionsById.set(auction._id.toString(), auction);
    for (const auction of allWinnerAuctions) auctionsById.set(auction._id.toString(), auction);
    for (const auction of unresolvedAuctions) auctionsById.set(auction._id.toString(), auction);
    const auctions = [...auctionsById.values()].sort((first, second) =>
      second.createdAt.getTime() - first.createdAt.getTime(),
    );
    const creatorUserIds = [...new Set(
      auctions.flatMap((auction) => auction.createdByUserId ? [auction.createdByUserId] : []),
    )];
    const creators = await User.find({ _id: { $in: creatorUserIds } }).select('_id role').lean();
    const creatorById = new Map(creators.map((creator) => [creator._id.toString(), creator]));
    const rosterWithWeekly = await getRosterWithWeeklyEarned(roster);
    const roles = [...new Map(
      roster
        .map((record) => record.subClass.trim().replace(/\s+/g, ' '))
        .filter(Boolean)
        .map((role) => [normalizeAuctionRole(role), role] as const),
    ).values()].sort((first, second) =>
      first.localeCompare(second, undefined, { sensitivity: 'base' }),
    );
    const catalogImageCounts = new Map(
      items.map((item) => [item._id.toString(), item.imageCount ?? 1]),
    );
    const catalogBossTypes = new Map(
      items.map((item) => [item._id.toString(), item.bossType ?? 'Unassigned']),
    );
    const linkedRows = getLinkedSheetRecordRows(user, rosterWithWeekly);
    const linkedRowSet = new Set(linkedRows);
    const linkedToons = rosterWithWeekly
      .filter((record) => linkedRowSet.has(record.rowIndex))
      .map((record) => ({
        ...record,
        heldPoints: holds.filter((hold) => holdMatchesIdentity(hold, record) ||
          (hold.owner === undefined && hold.rowIndex === record.rowIndex))
          .reduce((sum, hold) => sum + hold.heldPoints, 0),
      }));
    const weeklyEarnedTotal = linkedToons.reduce((total, record) => total + record.weeklyEarned, 0);

    return NextResponse.json({
      success: true,
      manager: isManager(user.role),
      weeklyEarnedTotal,
      weeklyMinimum: AUCTION_WEEKLY_MINIMUM,
      canBidWeekly: weeklyEarnedTotal >= AUCTION_WEEKLY_MINIMUM,
      rosterSync: {
        fetchedAt: rosterSnapshot.fetchedAt.toISOString(),
        stale: rosterSnapshot.stale,
        refreshDelayed: rosterSnapshot.refreshDelayed,
      },
      roles,
      toons: linkedToons,
      items: items.filter((item) => item.isListed !== false).map(({ _id, name, requiredRoles, requiredRole }) => ({
        id: _id.toString(),
        name,
        requiredRoles: requiredRoles?.length ? requiredRoles : requiredRole ? [requiredRole] : [],
        bossType: catalogBossTypes.get(_id.toString()) ?? 'Unassigned',
        imageCount: catalogImageCounts.get(_id.toString()) ?? 1,
      })),
      auctions: auctions.map((auction) => ({
        id: auction._id.toString(),
        itemId: auction.itemId.toString(),
        imageCount: catalogImageCounts.get(auction.itemId.toString()) ?? 1,
        itemName: auction.itemName,
        bossType: auction.bossType ?? catalogBossTypes.get(auction.itemId.toString()) ?? 'Unassigned',
        requiredRoles: auction.requiredRoles?.length ? auction.requiredRoles : [auction.requiredRole],
        createdBy: auction.createdBy,
        isPoster: isAuctionPoster(auction, user._id),
        isWinner: auction.winner?.userId.equals(user._id) === true,
        canMarkDelivered: auction.status === 'completed' &&
          auction.deliveryStatus === 'pending' &&
          Boolean(auction.winner) &&
          (isManager(user.role) || isAuctionPoster(auction, user._id)),
        canRemove: user.role === 'chief' ||
          user.role === 'general' ||
          (user.role === 'guardian' && isAuctionPoster(auction, user._id)),
        canClose: user.role === 'chief' ||
          isAuctionPoster(auction, user._id) ||
          (user.role === 'general' && creatorById.get(auction.createdByUserId?.toString() ?? '')?.role === 'guardian'),
        canResolveNoBid: auction.status === 'completed' &&
          !auction.highBid &&
          auction.deliveryStatus === 'not-required' &&
          (isAuctionPoster(auction, user._id) || (!auction.createdByUserId && (user.role === 'chief' || user.role === 'general'))),
        createdAt: auction.createdAt.toISOString(),
        endsAt: auction.endsAt.toISOString(),
        biddingClosed: auction.biddingClosed === true,
        status: auction.status,
        bidVersion: auction.bidVersion ?? 0,
        highBid: serializeBid(auction.highBid, user._id),
        winner: serializeBid(auction.winner, user._id),
        deliveryStatus: auction.deliveryStatus,
        deliveredBy: auction.deliveredBy ?? null,
        deliveredAt: auction.deliveredAt?.toISOString() ?? null,
        settlementError: auction.settlementError ? 'Settlement needs attention. Reserved DKP remains protected.' : null,
        canRetrySettlement: canRetryAuctionSettlement(user.role, auction),
      })),
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error: unknown) {
    return requestErrorResponse(error, 'Unable to load auction house. Please retry shortly.');
  }
}

/** Lightweight polling path: reads auction state without rebuilding roster and catalog data. */
async function getLiveAuctionUpdates(request: Request, user: NonNullable<Awaited<ReturnType<typeof getSessionUser>>>) {
  const url = new URL(request.url);
  const knownVersions = new Map<string, string>();
  const rawVersions = url.searchParams.get('versions');
  if (rawVersions) {
    if (rawVersions.length > 32_768) return NextResponse.json({ error: 'Too many auction versions' }, { status: 400 });
    try {
      const parsed: unknown = JSON.parse(rawVersions);
      if (Array.isArray(parsed) && parsed.length <= 200) {
        for (const entry of parsed) {
          if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && /^[a-f\d]{24}$/i.test(entry[0]) && typeof entry[1] === 'string' && entry[1].length <= 200) {
            knownVersions.set(entry[0], entry[1]);
          } else throw new Error('Invalid auction version');
        }
      } else throw new Error('Invalid auction versions');
    } catch {
      return Response.json({ error: 'Invalid auction versions' }, { status: 400 });
    }
  }

  try {
    scheduleExpirySweep();
    const fields = '_id itemId itemName bossType requiredRole requiredRoles createdBy createdByUserId createdAt endsAt biddingClosed status highBid winner deliveryStatus deliveredBy deliveredAt settlementError settlementAttemptId settlementDkpApplied settlementLeaseUntil settlementNeedsReview bidVersion';
    const [recent, unresolved] = await Promise.all([
      Auction.find({ status: { $in: ['active', 'settling', 'settlement-failed', 'completed'] } })
        .select(fields).sort({ createdAt: -1 }).limit(100).lean(),
      Auction.find({ status: { $in: ['active', 'settling', 'settlement-failed'] } }).select(fields).lean(),
    ]);
    const byId = new Map(recent.map((auction) => [auction._id.toString(), auction]));
    for (const auction of unresolved) byId.set(auction._id.toString(), auction);
    const auctions = [...byId.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const versionToken = (auction: typeof auctions[number]) => [
      auction.bidVersion ?? 0,
      auction.status,
      auction.endsAt.toISOString(),
      auction.deliveryStatus,
    ].join(':');
    const returnedIds = new Set(auctions.map((auction) => auction._id.toString()));
    const outsideWindow = [...knownVersions.keys()].filter((id) => !returnedIds.has(id));
    // A record leaving the recent window is still part of the archive. Only
    // report an actual deletion to avoid removing delivery tasks/history.
    const persisted = outsideWindow.length
      ? await Auction.find({ _id: { $in: outsideWindow } }).select('_id').lean() : [];
    const persistedIds = new Set(persisted.map((auction) => auction._id.toString()));
    const removedIds = outsideWindow.filter((id) => !persistedIds.has(id));
    const changed = removedIds.length > 0 || auctions.some((auction) =>
      knownVersions.get(auction._id.toString()) !== versionToken(auction),
    );
    if (!changed) {
      return NextResponse.json({ changed: false }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
    }

    const itemIds = [...new Set(auctions.map((auction) => auction.itemId))];
    const items = await AuctionItem.find({ _id: { $in: itemIds } }).select('_id imageCount bossType').lean();
    const itemById = new Map(items.map((item) => [item._id.toString(), item]));
    const creatorUserIds = [...new Set(auctions.flatMap((auction) => auction.createdByUserId ? [auction.createdByUserId] : []))];
    const creators = await User.find({ _id: { $in: creatorUserIds } }).select('_id role').lean();
    const creatorById = new Map(creators.map((creator) => [creator._id.toString(), creator]));
    const responseAuctions = auctions.map((auction) => {
      const id = auction._id.toString();
      const isPoster = isAuctionPoster(auction, user._id);
      return {
        id,
        itemId: auction.itemId.toString(),
        imageCount: itemById.get(auction.itemId.toString())?.imageCount ?? 1,
        itemName: auction.itemName,
        bossType: auction.bossType ?? itemById.get(auction.itemId.toString())?.bossType ?? 'Unassigned',
        requiredRoles: auction.requiredRoles?.length ? auction.requiredRoles : [auction.requiredRole ?? ''],
        createdBy: auction.createdBy,
        isPoster,
        isWinner: auction.winner?.userId.equals(user._id) === true,
        canMarkDelivered: auction.status === 'completed' && auction.deliveryStatus === 'pending' && Boolean(auction.winner) && (isManager(user.role) || isPoster),
        canRemove: user.role === 'chief' || user.role === 'general' || (user.role === 'guardian' && isPoster),
        canClose: user.role === 'chief' || isPoster || (user.role === 'general' && creatorById.get(auction.createdByUserId?.toString() ?? '')?.role === 'guardian'),
        canResolveNoBid: auction.status === 'completed' && !auction.highBid && auction.deliveryStatus === 'not-required' &&
          (isPoster || (!auction.createdByUserId && (user.role === 'chief' || user.role === 'general'))),
        createdAt: auction.createdAt.toISOString(),
        endsAt: auction.endsAt.toISOString(),
        biddingClosed: auction.biddingClosed === true,
        status: auction.status,
        highBid: serializeBid(auction.highBid, user._id),
        winner: serializeBid(auction.winner, user._id),
        deliveryStatus: auction.deliveryStatus,
        deliveredBy: auction.deliveredBy ?? null,
        deliveredAt: auction.deliveredAt?.toISOString() ?? null,
        settlementError: auction.settlementError ? 'Settlement needs attention. Reserved DKP remains protected.' : null,
        canRetrySettlement: canRetryAuctionSettlement(user.role, auction),
        bidVersion: auction.bidVersion ?? 0,
        versionToken: versionToken(auction),
      };
    });

    return NextResponse.json({ changed: true, auctions: responseAuctions, removedIds }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error: unknown) {
    return requestErrorResponse(error, 'Unable to refresh live auctions. Please retry shortly.');
  }
}

export async function POST(req: Request) {
  const rejected = guardMutationRequest(req);
  if (rejected) return rejected;
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const contentType = req.headers.get('content-type') ?? '';
    if (contentType.includes('multipart/form-data')) {
      return NextResponse.json({
        error: 'Catalog changes are managed from the Items tab. Select an existing saved item to post an auction.',
      }, { status: 400 });

    }

    const payload = await readJsonObject(req);

    if (payload.action === 'retry-settlement') {
      const { auctionId } = payload;
      if (typeof auctionId !== 'string' || !mongoose.isValidObjectId(auctionId)) {
        throw new RequestValidationError('Invalid auction ID.');
      }
      await withClanAdministrationTransaction(async (session) => {
        const actor = await getAuctionActor(user._id, session);
        if (actor.role !== 'chief' && actor.role !== 'general') throw new RequestValidationError('Permission denied.', 403);
        const auction = await Auction.findById(auctionId).session(session);
        if (!auction) throw new RequestValidationError('Auction not found.', 404);
        if (!canRetryAuctionSettlement(actor.role, auction)) {
          throw new RequestValidationError('This settlement cannot safely retry. Its original charge must be verified and reconciled first.', 409);
        }
        auction.settlementNeedsReview = false;
        auction.settlementRetryAt = new Date(0);
        await auction.save({ session });
      });
      scheduleExpirySweep();
      return NextResponse.json({ success: true, message: 'Settlement queued for a safe retry. Reserved DKP stays protected until it finishes.' });
    }

    if (payload.action === 'create-auction') {
      if (!isManager(user.role)) return NextResponse.json({ error: 'Permission denied' }, { status: 403 });
      const { itemId } = payload;
      if (typeof itemId !== 'string' || !mongoose.isValidObjectId(itemId)) {
        return NextResponse.json({ error: 'Select a valid saved item' }, { status: 400 });
      }
      const [item, roster] = await Promise.all([
        AuctionItem.findById(itemId),
        getSheetRoster({ fresh: true }),
      ]);
      if (!item) return NextResponse.json({ error: 'That catalog item no longer exists' }, { status: 404 });
      if (item.isListed === false) return NextResponse.json({ error: 'That item is no longer in the catalog' }, { status: 404 });
      const bossType = normalizeAuctionBossType(item.bossType);
      if (!bossType) throw new RequestValidationError('Update this item’s boss type in the item catalog before posting it.');
      const itemRoles = item.requiredRoles?.length ? item.requiredRoles : item.requiredRole ? [item.requiredRole] : [];
      if (!itemRoles.length) {
        return NextResponse.json({ error: 'Set this item’s auction role in the Items tab before posting it' }, { status: 400 });
      }
      const selectedRoles = itemRoles.map((role) => roster.find((record) =>
        normalizeAuctionRole(record.subClass) === normalizeAuctionRole(role),
      )?.subClass.trim()).filter((role): role is string => Boolean(role));
      if (selectedRoles.length !== itemRoles.length) {
        return NextResponse.json({ error: 'This item’s saved role is no longer in the roster. Update it in the Items tab before posting.' }, { status: 400 });
      }
      const auction = await withClanAdministrationTransaction(async (session) => {
        const actor = await getAuctionActor(user._id, session);
        if (!isManager(actor.role)) throw new RequestValidationError('Permission denied.', 403);
        const currentItem = await AuctionItem.findOne({ _id: item._id, isListed: { $ne: false } }).select('_id').session(session);
        if (!currentItem) throw new RequestValidationError('This catalog item is no longer listed.', 409);
        const [created] = await Auction.create([{
          itemId: item._id,
          itemName: item.name,
          bossType,
          requiredRoles: selectedRoles,
          requiredRole: selectedRoles[0],
          createdBy: actor.nickname,
          endsAt: new Date(Date.now() + AUCTION_DURATION_MS),
          createdByUserId: actor._id,
          status: 'active',
          deliveryStatus: 'not-required',
        }], { session });
        return created;
      });
      return NextResponse.json({ success: true, auctionId: auction._id.toString() });
    }

    if (payload.action === 'resolve-no-bid') {
      const auctionId = payload.auctionId;
      const resolution = payload.resolution;
      if (
        typeof auctionId !== 'string' ||
        !mongoose.isValidObjectId(auctionId) ||
        (resolution !== 'banked' && resolution !== 'repost')
      ) {
        return NextResponse.json({ error: 'Invalid no-bid auction action' }, { status: 400 });
      }

      const auction = await Auction.findById(auctionId);
      if (!auction) return NextResponse.json({ error: 'Auction not found' }, { status: 404 });
      const isPoster = isAuctionPoster(auction, user._id);
      const mayRecoverLegacyAuction = !auction.createdByUserId && (user.role === 'chief' || user.role === 'general');
      if (!isPoster && !mayRecoverLegacyAuction) {
        return NextResponse.json({ error: 'Only the auction poster can resolve an auction with no bids' }, { status: 403 });
      }
      if (
        auction.status !== 'completed' ||
        auction.highBid ||
        auction.deliveryStatus !== 'not-required'
      ) {
        return NextResponse.json({ error: 'Only an ended auction with no bids can be resolved' }, { status: 409 });
      }

      try {
        let repostedAuctionId = '';
        await withClanAdministrationTransaction(async (session) => {
          const actor = await getAuctionActor(user._id, session);
          if (!isPoster && actor.role !== 'chief' && actor.role !== 'general') throw new RequestValidationError('Permission denied.', 403);
          const ownershipFilter = isPoster
            ? { createdByUserId: user._id }
            : { createdByUserId: null };
          const resolvedAuction = await Auction.findOneAndUpdate(
            {
              _id: auction._id,
              status: 'completed',
              highBid: null,
              deliveryStatus: 'not-required',
              ...ownershipFilter,
            },
            {
              $set: {
                deliveryStatus: resolution === 'banked' ? 'banked' : 'reposted',
                deliveredBy: actor.nickname,
                deliveredAt: new Date(),
              },
            },
            { new: true, session },
          );
          if (!resolvedAuction) {
            throw new Error('This no-bid auction has already been resolved.');
          }

          if (resolution === 'repost') {
            const bossType = normalizeAuctionBossType(resolvedAuction.bossType);
            if (!bossType) throw new RequestValidationError('Update this item’s boss type before reposting it.');
            const [newAuction] = await Auction.create([{
              itemId: resolvedAuction.itemId,
              itemName: resolvedAuction.itemName,
              bossType,
              requiredRoles: resolvedAuction.requiredRoles?.length ? resolvedAuction.requiredRoles : [resolvedAuction.requiredRole ?? ''],
              requiredRole: resolvedAuction.requiredRole ?? '',
              createdBy: actor.nickname,
              createdByUserId: actor._id,
              endsAt: new Date(Date.now() + AUCTION_DURATION_MS),
              status: 'active',
              deliveryStatus: 'not-required',
            }], { session });
            repostedAuctionId = newAuction._id.toString();
          }
        });

        return NextResponse.json({
          success: true,
          message: resolution === 'banked'
            ? 'Item marked as mailed to the bank.'
            : 'Auction reposted for another 24 hours.',
          auctionId: repostedAuctionId || auctionId,
        });
      } catch (error: unknown) {
        if (error instanceof Error && error.message === 'This no-bid auction has already been resolved.') {
          return NextResponse.json({ error: error.message }, { status: 409 });
        }
        throw error;
      }
    }

    if (payload.action === 'remove-auction') {
      const auctionId = payload.auctionId;
      if (typeof auctionId !== 'string' || !mongoose.isValidObjectId(auctionId)) {
        return NextResponse.json({ error: 'Invalid auction ID' }, { status: 400 });
      }

      const auction = await Auction.findById(auctionId);
      if (!auction) return NextResponse.json({ error: 'Auction not found' }, { status: 404 });
      const ownsAuction = isAuctionPoster(auction, user._id);
      const mayRemove = user.role === 'chief' ||
        user.role === 'general' ||
        (user.role === 'guardian' && ownsAuction);
      if (!mayRemove) {
        return NextResponse.json({ error: 'You cannot remove this auction' }, { status: 403 });
      }
      if (auction.status !== 'active' || auction.endsAt.getTime() <= Date.now()) {
        return NextResponse.json({ error: 'Only open auctions can be removed; ended auctions remain in the history' }, { status: 409 });
      }

      await withClanAdministrationTransaction(async (session) => {
        const actor = await getAuctionActor(user._id, session);
        if (actor.role !== 'chief' && actor.role !== 'general' && !(actor.role === 'guardian' && ownsAuction)) {
          throw new RequestValidationError('You cannot remove this auction.', 403);
        }
        const claimed = await Auction.findOneAndUpdate(
          { _id: auctionId, status: 'active', endsAt: { $gt: new Date() } },
          { $set: { status: 'removing' } },
          { new: true, session },
        );
        if (!claimed) throw new RequestValidationError('This auction ended or changed while you were removing it.', 409);
        if (claimed.highBid) {
          const hold = await getBoundAuctionHold(claimed.highBid, session);
          if (hold.heldPoints < claimed.highBid.amount) throw new RequestValidationError('Auction hold could not be released. Ask a manager to review it.', 409);
          hold.heldPoints -= claimed.highBid.amount;
          await hold.save({ session });
        }

        const deletion = await Auction.deleteOne({ _id: claimed._id, status: 'removing' }).session(session);
        if (deletion.deletedCount !== 1) throw new Error('Auction could not be removed; manual review is required.');
      });

      return NextResponse.json({ success: true, message: 'Auction removed and its reserved DKP released.' });
    }

    if (payload.action === 'close-auction') {
      const auctionId = payload.auctionId;
      if (typeof auctionId !== 'string' || !mongoose.isValidObjectId(auctionId)) {
        return NextResponse.json({ error: 'Invalid auction ID' }, { status: 400 });
      }

      const auction = await Auction.findById(auctionId).select('createdBy createdByUserId status endsAt biddingClosed');
      if (!auction) return NextResponse.json({ error: 'Auction not found' }, { status: 404 });
      const createdByUser = auction.createdByUserId
        ? await User.findById(auction.createdByUserId).select('_id nickname role').lean()
        : undefined;
      const ownsAuction = isAuctionPoster(auction, user._id);
      const mayClose = user.role === 'chief' ||
        ownsAuction ||
        (user.role === 'general' && createdByUser?.role === 'guardian');
      if (!mayClose) return NextResponse.json({ error: 'You cannot close this auction' }, { status: 403 });
      const now = new Date();
      if (auction.status !== 'active' || auction.biddingClosed || auction.endsAt.getTime() <= now.getTime()) {
        return NextResponse.json({ error: 'Only an open auction can be closed' }, { status: 409 });
      }

      const closedAuction = await withClanAdministrationTransaction(async (session) => {
        const actor = await getAuctionActor(user._id, session);
        const creator = auction.createdByUserId
          ? await User.findById(auction.createdByUserId).select('role').session(session) : undefined;
        if (actor.role !== 'chief' && !ownsAuction && !(actor.role === 'general' && creator?.role === 'guardian')) {
          throw new RequestValidationError('You cannot close this auction.', 403);
        }
        return Auction.findOneAndUpdate(
          { _id: auctionId, status: 'active', biddingClosed: { $ne: true }, endsAt: { $gt: now } },
          { $set: { biddingClosed: true, endsAt: now } },
          { new: true, session },
        ).select('_id');
      });
      if (!closedAuction) return NextResponse.json({ error: 'This auction ended or changed while you were closing it' }, { status: 409 });

      scheduleExpirySweep();
      return NextResponse.json({ success: true, message: 'Bidding closed. The leading bid will be settled.' });
    }

    if (payload.action === 'bid') {
      if (!isAuctionBidInput(payload)) {
        return NextResponse.json({ error: 'Enter a valid toon and a positive whole-number bid' }, { status: 400 });
      }
      const { auctionId, rowIndex, amount } = payload;
      // Balance reads and reservation writes share the same lock as all Sheet
      // adjustments. A debit cannot slip between affordability and reservation.
      const accepted = await withDkpLedgerLock(async (roster) => {
        const rosterWithWeekly = await getRosterWithWeeklyEarned(roster);
        return withClanAdministrationTransaction(async (session) => {
          const actor = await getAuctionActor(user._id, session);
          const bidAt = new Date();
          const currentAuction = await Auction.findOne({
            _id: auctionId, status: 'active', biddingClosed: { $ne: true }, endsAt: { $gt: bidAt },
          }).session(session);
          if (!currentAuction) throw new RequestValidationError('Auction closed while the bid was being placed. Refresh and try again.', 409);
          if (currentAuction.highBid && amount <= currentAuction.highBid.amount) {
            throw new RequestValidationError(`A higher bid was placed. Your bid must exceed ${currentAuction.highBid.amount} DKP.`, 409);
          }
          const linkedRows = new Set(getLinkedSheetRecordRows(actor, roster));
          const weeklyEarnedTotal = rosterWithWeekly.filter((record) => linkedRows.has(record.rowIndex))
            .reduce((total, record) => total + record.weeklyEarned, 0);
          if (weeklyEarnedTotal < AUCTION_WEEKLY_MINIMUM) {
            throw new RequestValidationError(`Your linked toons need at least ${AUCTION_WEEKLY_MINIMUM} weekly DKP to bid.`, 403);
          }
          if (!linkedRows.has(rowIndex)) throw new RequestValidationError('Choose one of your linked toons.', 403);
          const toon = roster.find((record) => record.rowIndex === rowIndex);
          const auctionRoles = currentAuction.requiredRoles?.length ? currentAuction.requiredRoles : [currentAuction.requiredRole ?? ''];
          if (!toon || !auctionRoles.some((role) => normalizeAuctionRole(toon.subClass) === normalizeAuctionRole(role))) {
            throw new RequestValidationError(`Only a linked ${auctionRoles.join(' or ')} toon can bid.`, 403);
          }
          if (roster.filter((record) => getSheetRecordKey(record) === getSheetRecordKey(toon)).length !== 1) {
            throw new RequestValidationError('This toon has a duplicate roster identity. Ask a manager to correct the roster.', 409);
          }
          const outstanding = await Auction.find({ status: { $in: RESERVING_STATUSES }, highBid: { $exists: true } })
            .select('highBid').session(session).lean();
          const reservations = outstanding.flatMap((auction) => auction.highBid ? [auction.highBid] : []);
          if (hasMovedAuctionReservation(toon, reservations)) {
            throw new RequestValidationError('This toon moved in the roster while DKP was reserved. Resolve its existing auctions before bidding again.', 409);
          }
          const currentBid = currentAuction.highBid;
          const holdChanges = new Map<number, number>();
          if (currentBid) holdChanges.set(currentBid.rowIndex, -currentBid.amount);
          holdChanges.set(rowIndex, (holdChanges.get(rowIndex) ?? 0) + amount);
          for (const [holdRow, delta] of holdChanges) {
            const identity = holdRow === rowIndex ? toon : currentBid!;
            const hold = await getBoundAuctionHold({ ...identity, rowIndex: holdRow }, session);
            const nextHeldPoints = hold.heldPoints + delta;
            if (!Number.isSafeInteger(nextHeldPoints) || nextHeldPoints < 0) {
              throw new RequestValidationError('Auction point reservation is inconsistent. Ask a manager to review it.', 409);
            }
            // Releasing an outbid reservation remains possible if that toon has
            // left the roster or its externally maintained balance changed.
            if (delta > 0 && !canAffordBid(delta, hold.heldPoints, toon.available)) {
              throw new RequestValidationError('This toon does not have enough unreserved DKP for that bid.', 409);
            }
            hold.heldPoints = nextHeldPoints;
            await hold.save({ session });
          }
          const endsAt = getAuctionBidEndTime(currentAuction.endsAt, bidAt);
          currentAuction.highBid = {
            userId: actor._id, nickname: actor.nickname, rowIndex,
            owner: toon.owner, account: toon.account, amount, placedAt: bidAt,
          };
          currentAuction.endsAt = endsAt;
          currentAuction.bidVersion = (currentAuction.bidVersion ?? 0) + 1;
          await currentAuction.save({ session });
          return { highBid: currentAuction.highBid, endsAt };
        });
      });
      return NextResponse.json({
        success: true,
        message: 'Bid placed and DKP reserved until the auction ends or you are outbid.',
        highBid: serializeBid(accepted.highBid, user._id),
        endsAt: accepted.endsAt.toISOString(),
      });
    }
    if (payload.action === 'mark-delivered') {
      const auctionId = payload.auctionId;
      if (typeof auctionId !== 'string' || !mongoose.isValidObjectId(auctionId)) {
        return NextResponse.json({ error: 'Invalid auction ID' }, { status: 400 });
      }
      const candidate = await Auction.findById(auctionId).select('createdBy createdByUserId status deliveryStatus winner');
      if (!candidate) {
        return NextResponse.json({ error: 'Auction not found' }, { status: 404 });
      }
      const isPoster = isAuctionPoster(candidate, user._id);
      if (!isManager(user.role) && !isPoster) {
        return NextResponse.json({ error: 'Only the poster or an auction manager can complete this mail task' }, { status: 403 });
      }

      const auction = await withClanAdministrationTransaction(async (session) => {
        const actor = await getAuctionActor(user._id, session);
        if (!isManager(actor.role) && !isPoster) throw new RequestValidationError('Permission denied.', 403);
        const ownershipFilter = isManager(actor.role) ? {} : { createdByUserId: actor._id };
        return Auction.findOneAndUpdate(
          {
            _id: auctionId,
            status: 'completed',
            deliveryStatus: 'pending',
            winner: { $exists: true },
            ...ownershipFilter,
          },
          {
            $set: {
              deliveryStatus: 'done',
              deliveredBy: actor.nickname,
              deliveredAt: new Date(),
            },
          },
          { new: true, session },
        );
      });
      if (!auction) {
        return NextResponse.json({ error: 'This winner is already marked done or is not awaiting delivery' }, { status: 409 });
      }
      return NextResponse.json({
        success: true,
        message: 'Item marked mailed. DKP was deducted when the auction was won.',
      });
    }

    return NextResponse.json({ error: 'Unknown auction action' }, { status: 400 });
  } catch (error: unknown) {
    if (error instanceof DkpIntegrityError) return NextResponse.json({ error: error.message }, { status: 409 });
    return requestErrorResponse(error, 'Unable to process auction request. Please refresh and retry.');
  }
}
