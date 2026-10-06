import { NextResponse } from 'next/server';
import mongoose from 'mongoose';
import Auction, { type IAuctionBid } from '@/lib/models/Auction';
import AuctionHold from '@/lib/models/AuctionHold';
import AuctionItem from '@/lib/models/AuctionItem';
import User from '@/lib/models/User';
import {
  MAX_AUCTION_ITEM_IMAGE_BYTES,
  optimizeAuctionImage,
} from '@/lib/auctionImage';
import { getSessionUser } from '@/lib/auth/session';
import { adjustPlayersDKP, getSheetRoster } from '@/lib/googleSheets';
import { getLinkedSheetRecordRows } from '@/lib/sheetRecordLinks';
import { getRosterWithWeeklyEarned } from '@/lib/dkpWeeklyEarned';
import {
  AUCTION_ANTI_SNIPE_MS,
  AUCTION_DURATION_MS,
  AUCTION_WEEKLY_MINIMUM,
  normalizeAuctionRole,
} from '@/lib/auctionRules';

const MAX_UPLOAD_IMAGE_BYTES = 1024 * 1024;
const MAX_TOTAL_UPLOAD_BYTES = 2 * 1024 * 1024;
type AuctionImageType = 'image/png' | 'image/jpeg' | 'image/webp';
const MANAGER_ROLES = new Set(['chief', 'general', 'guardian']);

export const dynamic = 'force-dynamic';

function isManager(role: string) {
  return MANAGER_ROLES.has(role);
}

function verifyImageType(bytes: Uint8Array): AuctionImageType | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  ) return 'image/webp';
  return null;
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

async function settleExpiredAuctions() {
  const now = new Date();
  const expiredAuctions = await Auction.find({
    status: 'active',
    endsAt: { $lte: now },
  }).sort({ endsAt: 1 }).limit(25);

  for (const expired of expiredAuctions) {
    if (!expired.highBid) {
      await Auction.updateOne(
        { _id: expired._id, status: 'active', endsAt: { $lte: now } },
        { $set: { status: 'completed', deliveryStatus: 'not-required' } },
      );
      continue;
    }

    const claimed = await Auction.findOneAndUpdate(
      { _id: expired._id, status: 'active', endsAt: { $lte: now } },
      { $set: { status: 'settling' } },
      { new: true },
    );
    if (!claimed?.highBid) continue;

    try {
      const winningBid = claimed.highBid;
      await adjustPlayersDKP(
        [{
          rowIndex: winningBid.rowIndex,
          points: -winningBid.amount,
          owner: winningBid.owner,
          account: winningBid.account,
        }],
        { reservedPointsToConsume: new Map([[winningBid.rowIndex, winningBid.amount]]) },
      );

      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const auction = await Auction.findOne({ _id: claimed._id, status: 'settling' }).session(session);
          const hold = await AuctionHold.findOne({ rowIndex: winningBid.rowIndex }).session(session);
          if (!auction || !hold || hold.heldPoints < winningBid.amount) {
            throw new Error('Auction settlement records are inconsistent; manual review is required.');
          }

          hold.heldPoints -= winningBid.amount;
          await hold.save({ session });
          auction.status = 'completed';
          auction.winner = winningBid;
          auction.deliveryStatus = 'pending';
          auction.settlementError = undefined;
          await auction.save({ session });
        });
      } finally {
        await session.endSession();
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown auction settlement failure';
      await Auction.updateOne(
        { _id: claimed._id, status: 'settling' },
        { $set: { status: 'settlement-failed', settlementError: message } },
      );
      console.error(`Failed to settle auction ${claimed._id.toString()}`, error);
    }
  }
}

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    await settleExpiredAuctions();
    const [roster, recentAuctions, items, holds, pendingDeliveryTasks, pendingNoBidTasks, personalWinningAuctions, allWinnerAuctions] = await Promise.all([
      getSheetRoster(),
      Auction.find().sort({ createdAt: -1 }).limit(100).lean(),
      AuctionItem.find().select('name imageCount').sort({ name: 1 }).lean(),
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
    ]);
    const auctionsById = new Map(recentAuctions.map((auction) => [auction._id.toString(), auction]));
    for (const auction of pendingDeliveryTasks) auctionsById.set(auction._id.toString(), auction);
    for (const auction of pendingNoBidTasks) auctionsById.set(auction._id.toString(), auction);
    for (const auction of personalWinningAuctions) auctionsById.set(auction._id.toString(), auction);
    for (const auction of allWinnerAuctions) auctionsById.set(auction._id.toString(), auction);
    const auctions = [...auctionsById.values()].sort((first, second) =>
      second.createdAt.getTime() - first.createdAt.getTime(),
    );
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
      roles,
      toons: linkedToons,
      items: items.map(({ _id, name }) => ({
        id: _id.toString(),
        name,
        imageCount: catalogImageCounts.get(_id.toString()) ?? 1,
      })),
      auctions: auctions.map((auction) => ({
        id: auction._id.toString(),
        itemId: auction.itemId.toString(),
        imageCount: catalogImageCounts.get(auction.itemId.toString()) ?? 1,
        itemName: auction.itemName,
        requiredRole: auction.requiredRole,
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
      if (!isManager(user.role)) return NextResponse.json({ error: 'Permission denied' }, { status: 403 });
      const form = await req.formData();
      const action = form.get('action');
      const role = form.get('requiredRole');
      const itemId = form.get('itemId');
      const itemName = form.get('itemName');
      const images = form.getAll('images');

      if (action !== 'create-auction' || typeof role !== 'string' || !role.trim()) {
        return NextResponse.json({ error: 'Select a valid auction role' }, { status: 400 });
      }
      const roster = await getSheetRoster();
      const requiredRole = roster.find((record) =>
        normalizeAuctionRole(record.subClass) === normalizeAuctionRole(role),
      )?.subClass.trim();
      if (!requiredRole) {
        return NextResponse.json({ error: 'Select a role currently listed in the Google Sheets roster' }, { status: 400 });
      }

      let item;
      if (typeof itemId === 'string' && mongoose.isValidObjectId(itemId)) {
        if (images.some((image) => image instanceof File && image.size > 0) ||
          (typeof itemName === 'string' && itemName.trim())) {
          return NextResponse.json({ error: 'Choose an existing item or add a new item, not both' }, { status: 400 });
        }
        item = await AuctionItem.findById(itemId);
        if (!item) return NextResponse.json({ error: 'That catalog item no longer exists' }, { status: 404 });
      } else {
        if (
          typeof itemName !== 'string' ||
          !itemName.trim() ||
          itemName.trim().length > 120 ||
          images.length === 0 ||
          images.some((image) => !(image instanceof File))
        ) {
          return NextResponse.json({ error: 'A new item needs its full name and at least one image' }, { status: 400 });
        }
        if (images.length > 8) {
          return NextResponse.json({ error: 'Upload no more than 8 images per item' }, { status: 400 });
        }
        const totalUploadBytes = images.reduce(
          (total, image) => total + (image instanceof File ? image.size : 0),
          0,
        );
        if (totalUploadBytes > MAX_TOTAL_UPLOAD_BYTES) {
          return NextResponse.json({ error: 'The optimized images must total no more than 2 MB per item' }, { status: 413 });
        }
        const storedImages: Array<{ data: Buffer; contentType: AuctionImageType }> = [];
        let totalStoredBytes = 0;
        for (const image of images) {
          if (!(image instanceof File) || image.size <= 0 || image.size > MAX_UPLOAD_IMAGE_BYTES) {
            return NextResponse.json({ error: 'Each optimized upload must be no larger than 1 MB' }, { status: 400 });
          }
          const imageBytes = new Uint8Array(await image.arrayBuffer());
          const imageType = verifyImageType(imageBytes);
          if (imageType !== image.type) {
            return NextResponse.json({ error: 'An uploaded image is invalid or does not match its file type' }, { status: 400 });
          }
          let optimizedImage: Buffer;
          try {
            optimizedImage = await optimizeAuctionImage(imageBytes);
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Unable to optimize image';
            return NextResponse.json({ error: message }, { status: 400 });
          }
          totalStoredBytes += optimizedImage.byteLength;
          if (totalStoredBytes > MAX_AUCTION_ITEM_IMAGE_BYTES) {
            return NextResponse.json({
              error: 'The optimized images exceed 150 KB total for this item. Remove an image and try again.',
            }, { status: 413 });
          }
          storedImages.push({ data: optimizedImage, contentType: 'image/webp' });
        }

        try {
          item = await AuctionItem.create({
            name: itemName.trim(),
            images: storedImages,
            imageCount: storedImages.length,
            createdBy: user.nickname,
          });
        } catch (error: unknown) {
          if (error instanceof mongoose.Error.ValidationError ||
            (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000)) {
            return NextResponse.json({ error: 'An item with that name already exists; select it from the catalog' }, { status: 409 });
          }
          throw error;
        }
      }

      const auction = await Auction.create({
        itemId: item._id,
        itemName: item.name,
        requiredRole,
        createdBy: user.nickname,
        endsAt: new Date(Date.now() + AUCTION_DURATION_MS),
        createdByUserId: user._id,
        status: 'active',
        deliveryStatus: 'not-required',
      });
      return NextResponse.json({ success: true, auctionId: auction._id.toString() });
    }

    const body: unknown = await req.json();
    if (typeof body !== 'object' || body === null) {
      return NextResponse.json({ error: 'Invalid auction request' }, { status: 400 });
    }
    const payload = body as Record<string, unknown>;

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
              requiredRole: resolvedAuction.requiredRole,
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
            : 'Auction reposted for another two minutes.',
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

      const [roster, auction] = await Promise.all([
        getSheetRoster(),
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
      if (!toon || normalizeAuctionRole(toon.subClass) !== auction.requiredRole) {
        return NextResponse.json({ error: `Only a linked ${auction.requiredRole} toon can bid` }, { status: 403 });
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
          currentAuction.highBid = {
            userId: user._id,
            nickname: user.nickname,
            rowIndex,
            owner: toon.owner,
            account: toon.account,
            amount,
            placedAt: now,
          };
          currentAuction.endsAt = endsAt;
          currentAuction.bidVersion += 1;
          await currentAuction.save({ session });
        });
      } finally {
        await session.endSession();
      }

      return NextResponse.json({ success: true, message: 'Bid placed and DKP reserved until the auction ends or you are outbid.' });
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
