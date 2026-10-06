import { NextResponse } from 'next/server';
import mongoose from 'mongoose';
import Auction, { type IAuctionBid } from '@/lib/models/Auction';
import AuctionHold from '@/lib/models/AuctionHold';
import AuctionItem from '@/lib/models/AuctionItem';
import { getSessionUser } from '@/lib/auth/session';
import { adjustPlayersDKP, getSheetRoster } from '@/lib/googleSheets';
import { getLinkedSheetRecordRows } from '@/lib/sheetRecordLinks';
import { getRosterWithWeeklyEarned } from '@/lib/dkpWeeklyEarned';
import {
  AUCTION_ANTI_SNIPE_MS,
  AUCTION_DURATION_MS,
  AUCTION_ROLES,
  AUCTION_WEEKLY_MINIMUM,
  normalizeAuctionRole,
} from '@/lib/auctionRules';

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MANAGER_ROLES = new Set(['chief', 'general', 'guardian']);

function isManager(role: string) {
  return MANAGER_ROLES.has(role);
}

function verifyImageType(bytes: Uint8Array) {
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
    const highBid = expired.highBid;
    if (!highBid) {
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
      await adjustPlayersDKP(
        [{
          rowIndex: highBid.rowIndex,
          points: -highBid.amount,
          owner: highBid.owner,
          account: highBid.account,
        }],
        { reservedPointsToConsume: new Map([[highBid.rowIndex, highBid.amount]]) },
      );

      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const auction = await Auction.findOne({ _id: claimed._id, status: 'settling' }).session(session);
          const hold = await AuctionHold.findOne({ rowIndex: highBid.rowIndex }).session(session);
          if (!auction || !hold || hold.heldPoints < highBid.amount) {
            throw new Error('Auction settlement records are inconsistent; manual review is required.');
          }

          hold.heldPoints -= highBid.amount;
          await hold.save({ session });
          auction.status = 'completed';
          auction.winner = highBid;
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
    const [roster, recentAuctions, items, holds, pendingDeliveryTasks] = await Promise.all([
      getSheetRoster(),
      Auction.find().sort({ createdAt: -1 }).limit(100).lean(),
      AuctionItem.find().select('name').sort({ name: 1 }).lean(),
      AuctionHold.find().select('rowIndex heldPoints').lean(),
      Auction.find({ status: 'completed', deliveryStatus: 'pending' }).sort({ createdAt: 1 }).lean(),
    ]);
    const auctionsById = new Map(recentAuctions.map((auction) => [auction._id.toString(), auction]));
    for (const auction of pendingDeliveryTasks) auctionsById.set(auction._id.toString(), auction);
    const auctions = [...auctionsById.values()].sort((first, second) =>
      second.createdAt.getTime() - first.createdAt.getTime(),
    );
    const rosterWithWeekly = await getRosterWithWeeklyEarned(roster);
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
      toons: linkedToons,
      items: items.map(({ _id, name }) => ({ id: _id.toString(), name })),
      auctions: auctions.map((auction) => ({
        id: auction._id.toString(),
        itemId: auction.itemId.toString(),
        itemName: auction.itemName,
        requiredRole: auction.requiredRole,
        createdBy: auction.createdBy,
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
      const image = form.get('image');

      if (
        action !== 'create-auction' ||
        typeof role !== 'string' ||
        !(AUCTION_ROLES as readonly string[]).includes(normalizeAuctionRole(role))
      ) {
        return NextResponse.json({ error: 'Select a valid auction role' }, { status: 400 });
      }

      let item;
      if (typeof itemId === 'string' && mongoose.isValidObjectId(itemId)) {
        if (image instanceof File || (typeof itemName === 'string' && itemName.trim())) {
          return NextResponse.json({ error: 'Choose an existing item or add a new item, not both' }, { status: 400 });
        }
        item = await AuctionItem.findById(itemId);
        if (!item) return NextResponse.json({ error: 'That catalog item no longer exists' }, { status: 404 });
      } else {
        if (
          typeof itemName !== 'string' ||
          !itemName.trim() ||
          itemName.trim().length > 120 ||
          !(image instanceof File)
        ) {
          return NextResponse.json({ error: 'A new item needs its full name and an image' }, { status: 400 });
        }
        if (!IMAGE_TYPES.has(image.type) || image.size <= 0 || image.size > MAX_IMAGE_BYTES) {
          return NextResponse.json({ error: 'Upload a PNG, JPEG, or WebP image no larger than 4 MB' }, { status: 400 });
        }
        const imageBytes = new Uint8Array(await image.arrayBuffer());
        const imageType = verifyImageType(imageBytes);
        if (imageType !== image.type) {
          return NextResponse.json({ error: 'The uploaded image file is invalid or does not match its file type' }, { status: 400 });
        }
        try {
          item = await AuctionItem.create({
            name: itemName.trim(),
            image: Buffer.from(imageBytes),
            imageType,
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
        requiredRole: normalizeAuctionRole(role),
        createdBy: user.nickname,
        endsAt: new Date(Date.now() + AUCTION_DURATION_MS),
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
      const auction = await Auction.findOneAndUpdate(
        { _id: auctionId, status: 'completed', deliveryStatus: 'pending', winner: { $exists: true } },
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
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: 'Unknown auction action' }, { status: 400 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unable to process auction request';
    const status = message.startsWith('Auction closed') || message.startsWith('A higher bid') ? 409 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
