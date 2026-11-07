import { after, NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import Auction, { type IAuction, type IAuctionBid } from '@/lib/models/Auction';
import AuctionHold from '@/lib/models/AuctionHold';
import AuctionBidHistory from '@/lib/models/AuctionBidHistory';
import AuctionItem from '@/lib/models/AuctionItem';
import User from '@/lib/models/User';
import ToonRoleChange from '@/lib/models/ToonRoleChange';
import ToonRoleChangeRequest from '@/lib/models/ToonRoleChangeRequest';
import AuctionCreationRequest from '@/lib/models/AuctionCreationRequest';
import { isDkpRequestId } from '@/lib/bossDkp';
import { limitMemberRequests } from '@/lib/auth/rateLimit';
import { readHistoryPage, historyCursor } from '@/lib/historyPagination';
import { getSessionUser } from '@/lib/auth/session';
import { adjustPlayersDKP, getSheetRoster, getSheetRosterSnapshot, withDkpLedgerLock } from '@/lib/googleSheets';
import { getLinkedSheetRecordRows, getSheetRecordKey } from '@/lib/sheetRecordLinks';
import { canRetryAuctionSettlement } from '@/lib/auctionSettlement';
import { settleExpiredAuctions } from '@/lib/auctionSettlementWorker';
import { getBoundAuctionHold } from '@/lib/auctionHold';
import { canAffordBid, DkpIntegrityError } from '@/lib/dkpAccounting';
import { getRosterWithWeeklyEarned } from '@/lib/dkpWeeklyEarned';
import { readToonRoleSchedules } from '@/lib/readToonRoleSchedules';
import { readAuctionCreatorRoles } from '@/lib/auctionFollowUpReads';
import { auctionDisplayFilter } from '@/lib/auctionReadScope';
import { canBindAuctionHold, hasMovedAuctionReservation, holdMatchesIdentity, isAuctionBidInput, isAuctionPoster, serializeAuctionBid as serializeBid } from '@/lib/auctionSecurity';
import { guardMutationRequest, readJsonObject, requestErrorResponse, RequestValidationError } from '@/lib/security/request';
import { withClanAdministrationTransaction } from '@/lib/auth/administration';
import { requireRosterValues } from '@/lib/sheetRoster';
import { getEffectiveToonRole, isApprovedToonRoleSchedule } from '@/lib/toonRoleChanges';
import {
  AUCTION_DURATION_MS,
  AUCTION_HISTORY_PAGE_SIZE,
  AUCTION_WEEKLY_MINIMUM,
  getAuctionBidEndTime,
  normalizeAuctionBossType,
  ITEM_SUBROLES,
  resolveItemSubroles,
  canRoleBid,
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
    await limitMemberRequests(user._id.toString(), 'auction-read');
    if (new URL(request.url).searchParams.get('live') === '1') return getLiveAuctionUpdates(request, user);
    const url = new URL(request.url);
    if (url.searchParams.get('includeArchive') === '1') return await getAuctionHistory(url, user);
    scheduleExpirySweep();
    const [rosterSnapshot, auctions, items, holds] = await Promise.all([
      getSheetRosterSnapshot(),
      Auction.find(auctionDisplayFilter()).sort({ createdAt: -1, _id: -1 }).lean(),
      AuctionItem.find().select('name requiredRoles requiredRole bossType imageCount isListed').sort({ name: 1 }).lean(),
      AuctionHold.find().select('rowIndex heldPoints owner account').lean(),
    ]);
    const roster = rosterSnapshot.roster;
    const { roleChanges, roleApprovals } = await readToonRoleSchedules(roster.map(getSheetRecordKey));
    const roleChangesByIdentity = new Map(roleChanges.map((change) => [change.identityKey, change] as const));
    const roleApprovalsByIdentity = new Map<string, typeof roleApprovals>();
    for (const approval of roleApprovals) {
      roleApprovalsByIdentity.set(approval.identityKey, [...(roleApprovalsByIdentity.get(approval.identityKey) ?? []), approval]);
    }
    const roleReadAt = new Date();
    const rosterWithWeekly = await getRosterWithWeeklyEarned(roster);
    const roles = ITEM_SUBROLES;
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
      .map((record) => {
        const roleChange = roleChangesByIdentity.get(getSheetRecordKey(record));
        const scheduleApproval = roleApprovalsByIdentity.get(getSheetRecordKey(record))?.find((approval) =>
          isApprovedToonRoleSchedule(roleChange, approval));
        const effectiveRole = getEffectiveToonRole(record.subClass, roleChange, roleReadAt, scheduleApproval);
        return {
          ...record,
          subClass: effectiveRole,
          roleChange: scheduleApproval && roleChange?.scheduledRole && roleChange.effectiveAt && roleChange.effectiveAt.getTime() > roleReadAt.getTime()
            ? { scheduledRole: roleChange.scheduledRole, effectiveAt: roleChange.effectiveAt.toISOString() }
            : null,
          heldPoints: holds.filter((hold) => holdMatchesIdentity(hold, record) ||
            (hold.owner === undefined && hold.rowIndex === record.rowIndex))
            .reduce((sum, hold) => sum + hold.heldPoints, 0),
          canBid: !record.dkpIssues.some((issue) => ['weeklySpent', 'spent', 'available'].includes(issue.field)) && record.available !== null,
        };
      });
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
      dkpIssues: roster.flatMap((record) => record.dkpIssues),
      toons: linkedToons,
      items: items.filter((item) => item.isListed !== false).map(({ _id, name, requiredRoles, requiredRole }) => ({
        id: _id.toString(),
        name,
        requiredRoles: requiredRoles?.length ? requiredRoles : requiredRole ? [requiredRole] : [],
        bossType: catalogBossTypes.get(_id.toString()) ?? 'Unassigned',
        imageCount: catalogImageCounts.get(_id.toString()) ?? 1,
      })),
      nextCursor: null,
      auctions: await serializeReadAuctions(auctions, user, items),
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error: unknown) {
    return requestErrorResponse(error, 'Unable to load auction house. Please retry shortly.');
  }
}

type AuctionReadRecord = Omit<IAuction, keyof mongoose.Document> & { _id: mongoose.Types.ObjectId };
type AuctionReader = NonNullable<Awaited<ReturnType<typeof getSessionUser>>>;

async function serializeReadAuctions(auctions: AuctionReadRecord[], user: AuctionReader,
  metadata?: Array<{ _id: mongoose.Types.ObjectId; imageCount?: number; bossType?: string }>) {
  if (!auctions.length) return [];
  const [items, creators] = await Promise.all([
    metadata ?? AuctionItem.find({ _id: { $in: [...new Set(auctions.map((auction) => auction.itemId.toString()))] } })
      .select('imageCount bossType').lean(),
    readAuctionCreatorRoles(user.role, auctions),
  ]);
  const catalogImageCounts = new Map(items.map((item) => [item._id.toString(), item.imageCount ?? 1]));
  const catalogBossTypes = new Map(items.map((item) => [item._id.toString(), item.bossType ?? 'Unassigned']));
  const creatorById = new Map(creators.map((creator) => [creator._id.toString(), creator]));
  return auctions.map((auction) => ({
    id: auction._id.toString(),
    itemId: auction.itemId.toString(),
    imageCount: catalogImageCounts.get(auction.itemId.toString()) ?? 1,
    itemName: auction.itemName,
    bossType: auction.bossType ?? catalogBossTypes.get(auction.itemId.toString()) ?? 'Unassigned',
    requiredRoles: auction.requiredRoles?.length ? auction.requiredRoles : [auction.requiredRole],
    createdBy: auction.createdBy,
    isPoster: isAuctionPoster(auction, user._id),
    isWinner: Boolean(auction.winner?.userId && auction.winner.userId.equals(user._id)),
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
      (isManager(user.role) || isAuctionPoster(auction, user._id)),
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
  }));
}

/** History never rebuilds balances, eligibility, roster, or the posting catalog. */
async function getAuctionHistory(url: URL, user: AuctionReader) {
  const onlyWins = url.searchParams.get('won') === '1';
  const records = await Auction.find({
    status: 'completed',
    ...(onlyWins ? { 'winner.userId': user._id } : {}),
    ...readHistoryPage(url),
  }).sort({ createdAt: -1, _id: -1 }).limit(AUCTION_HISTORY_PAGE_SIZE + 1).lean();
  const page = records.slice(0, AUCTION_HISTORY_PAGE_SIZE);
  return NextResponse.json({
    success: true,
    auctions: await serializeReadAuctions(page, user),
    nextCursor: records.length > AUCTION_HISTORY_PAGE_SIZE ? historyCursor(page[page.length - 1]) : null,
  }, { headers: { 'Cache-Control': 'private, no-store' } });
}

/** Lightweight polling path: reads auction state without rebuilding roster and catalog data. */
async function getLiveAuctionUpdates(request: Request, user: NonNullable<Awaited<ReturnType<typeof getSessionUser>>>) {
  const url = new URL(request.url);
  let targetIds: mongoose.Types.ObjectId[] | null = null;
  const rawIds = url.searchParams.get('ids');
  if (rawIds !== null) {
    try {
      if (rawIds.length > 6_000) throw new Error();
      const ids: unknown = JSON.parse(rawIds);
      if (!Array.isArray(ids) || ids.length > 200 || ids.some((id) => typeof id !== 'string' || !/^[a-f\d]{24}$/i.test(id))) throw new Error();
      targetIds = [...new Set(ids as string[])].map((id) => new mongoose.Types.ObjectId(id));
    } catch {
      return Response.json({ error: 'Invalid auction IDs' }, { status: 400 });
    }
  }
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

  if (targetIds !== null) {
    const requestedIds = new Set(targetIds.map((id) => id.toString()));
    for (const id of knownVersions.keys()) if (!requestedIds.has(id)) knownVersions.delete(id);
  }
  try {
    scheduleExpirySweep();
    const fields = '_id itemId itemName bossType requiredRole requiredRoles createdBy createdByUserId createdAt endsAt biddingClosed status highBid winner deliveryStatus deliveredBy deliveredAt settlementError settlementAttemptId settlementDkpApplied settlementLeaseUntil settlementNeedsReview bidVersion';
    const auctions = await Auction.find(targetIds !== null ? { _id: { $in: targetIds } } : auctionDisplayFilter([...knownVersions.keys()].map((id) => new mongoose.Types.ObjectId(id))))
      .select(fields).sort({ createdAt: -1, _id: -1 }).lean();
    const versionToken = (auction: typeof auctions[number]) => [
      auction.bidVersion ?? 0,
      auction.status,
      auction.endsAt.toISOString(),
      auction.deliveryStatus,
      auction.itemId.toString(),
    ].join(':');
    const returnedIds = new Set(auctions.map((auction) => auction._id.toString()));
    const removedIds = [...knownVersions.keys()].filter((id) => !returnedIds.has(id));
    const changedAuctions = auctions.filter((auction) =>
      knownVersions.get(auction._id.toString()) !== versionToken(auction));
    const changed = removedIds.length > 0 || changedAuctions.length > 0;
    if (!changed) {
      return NextResponse.json({ changed: false }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
    }

    const serialized = await serializeReadAuctions(changedAuctions, user);
    const responseAuctions = serialized.map((auction, index) => ({ ...auction, versionToken: versionToken(changedAuctions[index]) }));

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
    await limitMemberRequests(user._id.toString(), 'auction-write');
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
      const { itemId, requestId } = payload;
      if (typeof itemId !== 'string' || !mongoose.isValidObjectId(itemId)) {
        return NextResponse.json({ error: 'Select a valid saved item' }, { status: 400 });
      }
      if (!isDkpRequestId(requestId)) throw new RequestValidationError('A request ID is required. Reload this page before posting an auction.');
      const receiptId = createHash('sha256').update(`auction-create:${user._id.toString()}:${requestId}`).digest('hex');
      const auction = await withClanAdministrationTransaction(async (session) => {
        const actor = await getAuctionActor(user._id, session);
        if (!isManager(actor.role)) throw new RequestValidationError('Permission denied.', 403);
        const receipt = await AuctionCreationRequest.findById(receiptId).session(session).lean();
        if (receipt) {
          if (receipt.itemId.toString() !== itemId.toLowerCase()) throw new RequestValidationError('This posting request was already used for another item.', 409);
          return { _id: receipt.auctionId };
        }
        const currentItem = await AuctionItem.findOne({ _id: itemId, isListed: { $ne: false } }).session(session);
        if (!currentItem) throw new RequestValidationError('This catalog item is no longer listed.', 409);
        const bossType = normalizeAuctionBossType(currentItem.bossType);
        if (!bossType || bossType === 'Unassigned') throw new RequestValidationError('Set this item’s boss type before posting it.');
        const itemRoles = currentItem.requiredRoles?.length ? currentItem.requiredRoles : currentItem.requiredRole ? [currentItem.requiredRole] : [];
        const selectedRoles = resolveItemSubroles(itemRoles);
        if (!selectedRoles) throw new RequestValidationError('Update this item’s eligible subroles in the catalog before posting.');
        const [created] = await Auction.create([{
          itemId: currentItem._id,
          itemName: currentItem.name,
          bossType,
          requiredRoles: selectedRoles,
          requiredRole: selectedRoles[0],
          createdBy: actor.nickname,
          endsAt: new Date(Date.now() + AUCTION_DURATION_MS),
          createdByUserId: actor._id,
          status: 'active',
          deliveryStatus: 'not-required',
        }], { session });
        await AuctionCreationRequest.create([{ _id: receiptId, actorUserId: actor._id, itemId: currentItem._id, auctionId: created._id }], { session });
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
      if (!isManager(user.role) && !isPoster) {
        return NextResponse.json({ error: 'Only auction managers can resolve an auction with no bids' }, { status: 403 });
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
          if (!isManager(actor.role) && !isPoster) throw new RequestValidationError('Permission denied.', 403);
          const ownershipFilter = isPoster
            ? {
              $or: [
                { createdByUserId: user._id },
                { createdByUserId: { $exists: false }, createdBy: auction.createdBy },
              ],
            }
            : isManager(actor.role)
              ? {}
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
            { returnDocument: 'after', session },
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
          { returnDocument: 'after', session },
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
          { returnDocument: 'after', session },
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
          const scheduledRole = toon
            ? await ToonRoleChange.findOne({ identityKey: getSheetRecordKey(toon) }).session(session).lean()
            : null;
          const scheduleApproval = toon && scheduledRole
            ? await ToonRoleChangeRequest.findOne({
              identityKey: getSheetRecordKey(toon), status: { $in: ['approved', 'applied'] },
              requestedRole: scheduledRole.scheduledRole, effectiveAt: scheduledRole.effectiveAt,
              decidedByUserId: { $exists: true }, decidedAt: { $exists: true },
            }).session(session).lean()
            : null;
          const effectiveRole = toon ? getEffectiveToonRole(toon.subClass, scheduledRole, bidAt, scheduleApproval) : '';
          if (!toon || !canRoleBid(effectiveRole, auctionRoles)) {
            throw new RequestValidationError(`Only a linked ${auctionRoles.join(' or ')} toon can bid.`, 403);
          }
          requireRosterValues(toon, ['weeklySpent', 'spent', 'available']);
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
          if (currentBid && !await AuctionBidHistory.exists({
            auctionId: currentAuction._id, userId: currentBid.userId,
            identityKey: getSheetRecordKey(currentBid), amount: currentBid.amount,
            withdrawnAt: { $exists: false },
          }).session(session)) {
            await AuctionBidHistory.create([{
              auctionId: currentAuction._id, userId: currentBid.userId, nickname: currentBid.nickname,
              rowIndex: currentBid.rowIndex, owner: currentBid.owner, account: currentBid.account,
              identityKey: getSheetRecordKey(currentBid), amount: currentBid.amount, placedAt: currentBid.placedAt,
            }], { session });
          }
          const endsAt = getAuctionBidEndTime(currentAuction.endsAt, bidAt);
          currentAuction.highBid = {
            userId: actor._id, nickname: actor.nickname, rowIndex,
            owner: toon.owner, account: toon.account, amount, placedAt: bidAt,
          };
          await AuctionBidHistory.create([{
            auctionId: currentAuction._id, userId: actor._id, nickname: actor.nickname,
            rowIndex, owner: toon.owner, account: toon.account,
            identityKey: getSheetRecordKey(toon), amount, placedAt: bidAt,
          }], { session });
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
          { returnDocument: 'after', session },
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
