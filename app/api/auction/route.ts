import { NextResponse } from 'next/server';
import mongoose from 'mongoose';
import Auction, { type IAuctionBid } from '@/lib/models/Auction';
import AuctionBid from '@/lib/models/AuctionBid';
import AuctionHold from '@/lib/models/AuctionHold';
import AuctionItem from '@/lib/models/AuctionItem';
import User from '@/lib/models/User';
import { getSessionUser } from '@/lib/auth/session';
import { getSheetRoster, getSheetRosterSnapshot } from '@/lib/googleSheets';
import { withDkpSheetWriteLock } from '@/lib/sheetWriteLock';
import { settleExpiredAuctions } from '@/lib/auctionSettlement';
import { getLinkedSheetRecordRows } from '@/lib/sheetRecordLinks';
import { getRosterWithWeeklyEarned } from '@/lib/dkpWeeklyEarned';
import {
  AUCTION_ANTI_SNIPE_MS,
  AUCTION_DURATION_MS,
  AUCTION_WEEKLY_MINIMUM,
  normalizeAuctionRole,
} from '@/lib/auctionRules';

const MANAGER_ROLES = new Set(['chief', 'general', 'guardian']);

export const dynamic = 'force-dynamic';

function isManager(role: string) {
  return MANAGER_ROLES.has(role);
}

function serializeBid(bid: IAuctionBid | undefined, currentUserId: mongoose.Types.ObjectId) {
  if (!bid) return null;
  return {
    ...bid,
    userId: bid.userId.toString(),
    isMine: bid.userId.equals(currentUserId),
    placedAt: bid.placedAt.toISOString(),
  };
}

export async function GET(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const includeArchive = new URL(request.url).searchParams.get('includeArchive') === '1';
    await settleExpiredAuctions();
    const [rosterSnapshot, recentAuctions, items, holds, pendingDeliveryTasks, pendingNoBidTasks, personalWinningAuctions, allWinnerAuctions, personalBidRecords] = await Promise.all([
      getSheetRosterSnapshot(),
      includeArchive
        ? Auction.find().sort({ createdAt: -1 }).lean()
        : Auction.find().sort({ createdAt: -1 }).limit(100).lean(),
      AuctionItem.find().select('name requiredRoles requiredRole bossType imageCount isListed').sort({ name: 1 }).lean(),
      AuctionHold.find().select('rowIndex heldPoints').lean(),
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
      AuctionBid.find({ userId: user._id }).sort({ placedAt: -1 }).limit(100).select('auctionId').lean(),
    ]);
    const roster = rosterSnapshot.roster;
    const personalBidAuctions = personalBidRecords.length
      ? await Auction.find({ _id: { $in: [...new Set(personalBidRecords.map((bid) => bid.auctionId.toString()))] } }).lean()
      : [];
    const auctionsById = new Map(recentAuctions.map((auction) => [auction._id.toString(), auction]));
    for (const auction of pendingDeliveryTasks) auctionsById.set(auction._id.toString(), auction);
    for (const auction of pendingNoBidTasks) auctionsById.set(auction._id.toString(), auction);
    for (const auction of personalWinningAuctions) auctionsById.set(auction._id.toString(), auction);
    for (const auction of allWinnerAuctions) auctionsById.set(auction._id.toString(), auction);
    for (const auction of personalBidAuctions) auctionsById.set(auction._id.toString(), auction);
    const auctions = [...auctionsById.values()].sort((first, second) =>
      second.createdAt.getTime() - first.createdAt.getTime(),
    );
    const bidRecords = auctions.length
      ? await AuctionBid.find({ auctionId: { $in: auctions.map((auction) => auction._id) } })
        .sort({ placedAt: -1 })
        .lean()
      : [];
    const bidHistoryByAuction = new Map<string, IAuctionBid[]>();
    for (const bid of bidRecords) {
      const auctionId = bid.auctionId.toString();
      const history = bidHistoryByAuction.get(auctionId) ?? [];
      history.push({
        userId: bid.userId,
        nickname: bid.nickname,
        rowIndex: bid.rowIndex,
        owner: bid.owner,
        account: bid.account,
        amount: bid.amount,
        placedAt: bid.placedAt,
      });
      bidHistoryByAuction.set(auctionId, history);
    }
    const creatorNicknames = [...new Set(auctions.map((auction) => auction.createdBy))];
    const creatorUserIds = [...new Set(
      auctions.flatMap((auction) => auction.createdByUserId ? [auction.createdByUserId] : []),
    )];
    const creators = await User.find({
      $or: [
        { nickname: { $in: creatorNicknames } },
        ...(creatorUserIds.length > 0 ? [{ _id: { $in: creatorUserIds } }] : []),
      ],
    }).select('_id nickname role').lean();
    const creatorByNickname = new Map(creators.map((creator) => [creator.nickname, creator]));
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
        heldPoints: holds.find((hold) => hold.rowIndex === record.rowIndex)?.heldPoints ?? 0,
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
        isPoster: auction.createdByUserId?.equals(user._id) === true ||
          (!auction.createdByUserId && auction.createdBy === user.nickname),
        isWinner: auction.winner?.userId.equals(user._id) === true,
        canMarkDelivered: auction.status === 'completed' &&
          auction.deliveryStatus === 'pending' &&
          Boolean(auction.winner) &&
          (isManager(user.role) ||
            auction.createdByUserId?.equals(user._id) === true ||
            (!auction.createdByUserId && auction.createdBy === user.nickname)),
        canRemove: user.role === 'chief' ||
          auction.createdByUserId?.equals(user._id) === true ||
          auction.createdBy === user.nickname ||
          (user.role === 'general' && (
            creatorById.get(auction.createdByUserId?.toString() ?? '')?.role === 'guardian' ||
            creatorByNickname.get(auction.createdBy)?.role === 'guardian'
          )),
        canResolveNoBid: auction.status === 'completed' &&
          !auction.highBid &&
          auction.deliveryStatus === 'not-required' &&
          (auction.createdByUserId?.equals(user._id) === true ||
            (!auction.createdByUserId && auction.createdBy === user.nickname)),
        createdAt: auction.createdAt.toISOString(),
        endsAt: auction.endsAt.toISOString(),
        status: auction.status,
        highBid: serializeBid(auction.highBid, user._id),
        bidHistory: (bidHistoryByAuction.get(auction._id.toString()) ??
          (auction.highBid ? [auction.highBid] : []))
          .map((bid) => serializeBid(bid, user._id)),
        winner: serializeBid(auction.winner, user._id),
        deliveryStatus: auction.deliveryStatus,
        deliveredBy: auction.deliveredBy ?? null,
        deliveredAt: auction.deliveredAt?.toISOString() ?? null,
        settlementError: auction.settlementError ?? null,
      })),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unable to load auction house';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const contentType = req.headers.get('content-type') ?? '';
    if (contentType.includes('multipart/form-data')) {
      return NextResponse.json({
        error: 'Catalog changes are managed from the Items tab. Select an existing saved item to post an auction.',
      }, { status: 400 });

    }

    const body: unknown = await req.json();
    if (typeof body !== 'object' || body === null) {
      return NextResponse.json({ error: 'Invalid auction request' }, { status: 400 });
    }
    const payload = body as Record<string, unknown>;

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
      const auction = await Auction.create({
        itemId: item._id,
        itemName: item.name,
        bossType: item.bossType,
        requiredRoles: selectedRoles,
        requiredRole: selectedRoles[0],
        createdBy: user.nickname,
        endsAt: new Date(Date.now() + AUCTION_DURATION_MS),
        createdByUserId: user._id,
        status: 'active',
        deliveryStatus: 'not-required',
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
      const isPoster = auction.createdByUserId
        ? auction.createdByUserId.equals(user._id)
        : auction.createdBy === user.nickname;
      if (!isPoster) {
        return NextResponse.json({ error: 'Only the auction poster can resolve an auction with no bids' }, { status: 403 });
      }
      if (
        auction.status !== 'completed' ||
        auction.highBid ||
        auction.deliveryStatus !== 'not-required'
      ) {
        return NextResponse.json({ error: 'Only an ended auction with no bids can be resolved' }, { status: 409 });
      }

      const session = await mongoose.startSession();
      try {
        let repostedAuctionId = '';
        await session.withTransaction(async () => {
          const ownershipFilter = auction.createdByUserId
            ? { createdByUserId: user._id }
            : { createdByUserId: { $exists: false }, createdBy: user.nickname };
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
                deliveredBy: user.nickname,
                deliveredAt: new Date(),
              },
            },
            { new: true, session },
          );
          if (!resolvedAuction) {
            throw new Error('This no-bid auction has already been resolved.');
          }

          if (resolution === 'repost') {
            const [newAuction] = await Auction.create([{
              itemId: resolvedAuction.itemId,
              itemName: resolvedAuction.itemName,
              bossType: resolvedAuction.bossType,
              requiredRoles: resolvedAuction.requiredRoles?.length ? resolvedAuction.requiredRoles : [resolvedAuction.requiredRole ?? ''],
              requiredRole: resolvedAuction.requiredRole ?? '',
              createdBy: user.nickname,
              createdByUserId: user._id,
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
      } finally {
        await session.endSession();
      }
    }

    if (payload.action === 'remove-auction') {
      const auctionId = payload.auctionId;
      if (typeof auctionId !== 'string' || !mongoose.isValidObjectId(auctionId)) {
        return NextResponse.json({ error: 'Invalid auction ID' }, { status: 400 });
      }

      const auction = await Auction.findById(auctionId);
      if (!auction) return NextResponse.json({ error: 'Auction not found' }, { status: 404 });
      const createdByUser = auction.createdByUserId
        ? await User.findById(auction.createdByUserId).select('_id nickname role').lean()
        : await User.findOne({ nickname: auction.createdBy }).select('_id nickname role').lean();
      const ownsAuction = auction.createdByUserId
        ? auction.createdByUserId.equals(user._id)
        : auction.createdBy === user.nickname;
      const mayRemove = user.role === 'chief' ||
        ownsAuction ||
        (user.role === 'general' && createdByUser?.role === 'guardian');
      if (!mayRemove) {
        return NextResponse.json({ error: 'You cannot remove this auction' }, { status: 403 });
      }
      if (auction.status !== 'active' || auction.endsAt.getTime() <= Date.now()) {
        return NextResponse.json({ error: 'Only open auctions can be removed; ended auctions remain in the history' }, { status: 409 });
      }

      const claimed = await Auction.findOneAndUpdate(
        { _id: auctionId, status: 'active', endsAt: { $gt: new Date() } },
        { $set: { status: 'removing' } },
        { new: true },
      );
      if (!claimed) {
        return NextResponse.json({ error: 'This auction ended or changed while you were removing it' }, { status: 409 });
      }

      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          if (claimed.highBid) {
            const holdUpdate = await AuctionHold.updateOne(
              {
                rowIndex: claimed.highBid.rowIndex,
                heldPoints: { $gte: claimed.highBid.amount },
              },
              { $inc: { heldPoints: -claimed.highBid.amount } },
              { session },
            );
            if (holdUpdate.modifiedCount !== 1) {
              throw new Error('Auction hold could not be released; manual review is required.');
            }
          }

          await AuctionBid.deleteMany({ auctionId: claimed._id }).session(session);
          const deletion = await Auction.deleteOne({ _id: claimed._id, status: 'removing' }).session(session);
          if (deletion.deletedCount !== 1) {
            throw new Error('Auction could not be removed; manual review is required.');
          }
        });
      } catch (error: unknown) {
        await Auction.updateOne(
          { _id: claimed._id, status: 'removing' },
          { $set: { status: 'active' } },
        );
        throw error;
      } finally {
        await session.endSession();
      }

      return NextResponse.json({ success: true, message: 'Auction removed and its reserved DKP released.' });
    }

    if (payload.action === 'bid') {
      const { auctionId, rowIndex, amount } = payload;
      if (
        typeof auctionId !== 'string' ||
        !mongoose.isValidObjectId(auctionId) ||
        typeof rowIndex !== 'number' ||
        !Number.isInteger(rowIndex) ||
        typeof amount !== 'number' ||
        !Number.isSafeInteger(amount) ||
        amount <= 0
      ) {
        return NextResponse.json({ error: 'Enter a valid toon and a positive whole-number bid' }, { status: 400 });
      }

      return withDkpSheetWriteLock(async () => {
      const [roster, auction] = await Promise.all([
        getSheetRoster({ fresh: true }),
        Auction.findById(auctionId),
      ]);
      if (!auction) return NextResponse.json({ error: 'Auction not found' }, { status: 404 });
      if (auction.status !== 'active' || auction.endsAt.getTime() <= Date.now()) {
        return NextResponse.json({ error: 'This auction has ended and no longer accepts bids' }, { status: 409 });
      }
      if (auction.highBid && amount <= auction.highBid.amount) {
        return NextResponse.json({ error: `Your bid must be higher than ${auction.highBid.amount} DKP` }, { status: 400 });
      }

      const linkedRows = new Set(getLinkedSheetRecordRows(user, roster));
      const rosterWithWeekly = await getRosterWithWeeklyEarned(roster);
      const weeklyEarnedTotal = rosterWithWeekly
        .filter((record) => linkedRows.has(record.rowIndex))
        .reduce((total, record) => total + record.weeklyEarned, 0);
      if (weeklyEarnedTotal < AUCTION_WEEKLY_MINIMUM) {
        return NextResponse.json({
          error: `Your linked toons need at least ${AUCTION_WEEKLY_MINIMUM} weekly DKP to bid`,
        }, { status: 403 });
      }
      if (!linkedRows.has(rowIndex)) {
        return NextResponse.json({ error: 'Choose one of your linked toons' }, { status: 403 });
      }
      const toon = roster.find((record) => record.rowIndex === rowIndex);
      const auctionRoles: string[] = auction.requiredRoles?.length ? auction.requiredRoles : [auction.requiredRole ?? ''];
      if (!toon || !auctionRoles.some((role) => normalizeAuctionRole(toon.subClass) === normalizeAuctionRole(role))) {
        return NextResponse.json({ error: `Only a linked ${auctionRoles.join(' or ')} toon can bid` }, { status: 403 });
      }
      if (amount > toon.available) {
        return NextResponse.json({ error: 'Your bid is higher than this toon’s current available DKP' }, { status: 400 });
      }

      await AuctionHold.updateOne(
        { rowIndex },
        { $setOnInsert: { rowIndex, heldPoints: 0 } },
        { upsert: true },
      ).catch(async (error: unknown) => {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
          if (await AuctionHold.exists({ rowIndex })) return;
        }
        throw error;
      });

      const session = await mongoose.startSession();
      const now = new Date();
      let placedBid: IAuctionBid | undefined;
      let placedBidEndsAt: Date | undefined;
      try {
        await session.withTransaction(async () => {
          const currentAuction = await Auction.findOne({
            _id: auctionId,
            status: 'active',
            endsAt: { $gt: now },
          }).session(session);
          if (!currentAuction) throw new Error('Auction closed while the bid was being placed; refresh and try again.');
          if (currentAuction.highBid && amount <= currentAuction.highBid.amount) {
            throw new Error(`A higher bid was placed. Your bid must exceed ${currentAuction.highBid.amount} DKP.`);
          }

          const currentBid = currentAuction.highBid;
          const holdChanges = new Map<number, number>();
          if (currentBid) {
            holdChanges.set(currentBid.rowIndex, (holdChanges.get(currentBid.rowIndex) ?? 0) - currentBid.amount);
          }
          holdChanges.set(rowIndex, (holdChanges.get(rowIndex) ?? 0) + amount);

          for (const [holdRow, delta] of holdChanges) {
            const hold = await AuctionHold.findOne({ rowIndex: holdRow }).session(session);
            if (!hold) throw new Error('Auction point reservation is missing; contact a clan manager.');
            const holdToon = roster.find((record) => record.rowIndex === holdRow);
            if (!holdToon) throw new Error('A toon with a reserved bid is no longer on the roster.');
            const nextHeldPoints = hold.heldPoints + delta;
            if (nextHeldPoints < 0) throw new Error('Auction point reservation is inconsistent; contact a clan manager.');
            if (nextHeldPoints > holdToon.available) {
              throw new Error('This toon does not have enough unreserved DKP for that bid.');
            }
            hold.heldPoints = nextHeldPoints;
            await hold.save({ session });
          }

          const endsAt = currentAuction.endsAt.getTime() - now.getTime() <= AUCTION_ANTI_SNIPE_MS
            ? new Date(now.getTime() + AUCTION_ANTI_SNIPE_MS)
            : currentAuction.endsAt;
          placedBid = {
            userId: user._id,
            nickname: user.nickname,
            rowIndex,
            owner: toon.owner,
            account: toon.account,
            amount,
            placedAt: now,
          };
          currentAuction.highBid = placedBid;
          currentAuction.endsAt = endsAt;
          placedBidEndsAt = endsAt;
          currentAuction.bidVersion += 1;
          await currentAuction.save({ session });
          await AuctionBid.create([{
            auctionId: currentAuction._id,
            userId: user._id,
            nickname: user.nickname,
            rowIndex,
            owner: toon.owner,
            account: toon.account,
            amount,
            placedAt: now,
          }], { session });
        });
      } finally {
        await session.endSession();
      }

      return NextResponse.json({
        success: true,
        message: 'Bid placed and DKP reserved until the auction ends or you are outbid.',
        bid: serializeBid(placedBid, user._id),
        endsAt: placedBidEndsAt?.toISOString(),
      });
      });
    }

    if (payload.action === 'mark-delivered') {
      if (!isManager(user.role)) return NextResponse.json({ error: 'Permission denied' }, { status: 403 });
      const auctionId = payload.auctionId;
      if (typeof auctionId !== 'string' || !mongoose.isValidObjectId(auctionId)) {
        return NextResponse.json({ error: 'Invalid auction ID' }, { status: 400 });
      }
      const candidate = await Auction.findById(auctionId).select('createdBy createdByUserId status deliveryStatus winner');
      if (!candidate) {
        return NextResponse.json({ error: 'Auction not found' }, { status: 404 });
      }
      const isPoster = candidate.createdByUserId
        ? candidate.createdByUserId.equals(user._id)
        : candidate.createdBy === user.nickname;
      if (!isManager(user.role) && !isPoster) {
        return NextResponse.json({ error: 'Only the poster or an auction manager can complete this mail task' }, { status: 403 });
      }

      const ownershipFilter = isManager(user.role)
        ? {}
        : candidate.createdByUserId
          ? { createdByUserId: user._id }
          : { createdByUserId: { $exists: false }, createdBy: user.nickname };
      const auction = await Auction.findOneAndUpdate(
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
            deliveredBy: user.nickname,
            deliveredAt: new Date(),
          },
        },
        { new: true },
      );
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
    const message = error instanceof Error ? error.message : 'Unable to process auction request';
    const status = message.startsWith('Auction closed') || message.startsWith('A higher bid') ? 409 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
