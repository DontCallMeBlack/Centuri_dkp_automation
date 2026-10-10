import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import Auction from '@/lib/models/Auction';
import AuctionHold from '@/lib/models/AuctionHold';
import { spendPlayerDKP } from '@/lib/googleSheets';
import dbConnect from '@/lib/mongodb';

const SETTLEMENT_LEASE_MS = 5 * 60 * 1000;
const MAX_AUCTIONS_PER_RUN = 25;
const MIN_RETRY_DELAY_MS = 60 * 1000;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;

function dueSettlementQuery(now: Date): Record<string, any> {
  return {
    $or: [
      { status: 'active', endsAt: { $lte: now } },
      {
        status: 'settlement-failed',
        nextSettlementAttemptAt: { $lte: now },
      },
      {
        status: 'settling',
        settlementLockToken: { $exists: true },
        $or: [
          { settlementLockUntil: null },
          { settlementLockUntil: { $lte: now } },
        ],
      },
    ],
  };
}

export async function settleExpiredAuctions() {
  await dbConnect();
  await Auction.updateMany(
    { status: 'settling', settlementLockToken: { $exists: false } },
    {
      $set: {
        status: 'settlement-failed',
        settlementError: 'This auction was mid-settlement before safe retries were enabled. Check the sheet before retrying it.',
      },
    },
  );
  const now = new Date();
  const dueAuctions: any[] = await Auction.find(dueSettlementQuery(now) as any)
    .sort({ endsAt: 1 })
    .limit(MAX_AUCTIONS_PER_RUN);
  let completed = 0;
  let failed = 0;

  for (const due of dueAuctions) {
    const leaseToken = randomUUID();
    const leaseUntil = new Date(Date.now() + SETTLEMENT_LEASE_MS);
    const claimed: any = await Auction.findOneAndUpdate(
      {
        _id: due._id,
        ...dueSettlementQuery(new Date()),
      },
      {
        $set: {
          status: 'settling',
          settlementLockUntil: leaseUntil,
          settlementLockToken: leaseToken,
          settlementError: undefined,
        },
      },
      { new: true },
    );
    if (!claimed) continue;

    try {
      const winningBid = claimed.highBid;
      if (!winningBid) {
        const finished = await Auction.updateOne(
          { _id: claimed._id, status: 'settling', settlementLockToken: leaseToken },
          {
            $set: {
              status: 'completed',
              deliveryStatus: 'not-required',
              settlementLockUntil: new Date(0),
            },
            $unset: { settlementLockToken: 1, settlementError: 1, nextSettlementAttemptAt: 1 },
          },
        );
        if (finished.modifiedCount === 1) completed += 1;
        continue;
      }

      await spendPlayerDKP(
        {
          rowIndex: winningBid.rowIndex,
          points: winningBid.amount,
          owner: winningBid.owner,
          account: winningBid.account,
        },
        {
          operationId: `auction-settlement:${claimed._id.toString()}`,
          reservedPointsToConsume: winningBid.amount,
        },
      );

      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const auction = await Auction.findOne({
            _id: claimed._id,
            status: 'settling',
            settlementLockToken: leaseToken,
          }).session(session);
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
          auction.settlementLockUntil = new Date(0);
          auction.settlementLockToken = undefined;
          auction.nextSettlementAttemptAt = undefined;
          await auction.save({ session });
        });
      } finally {
        await session.endSession();
      }
      completed += 1;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown auction settlement failure';
      const attempts = (claimed.settlementAttempts ?? 0) + 1;
      const retryDelay = Math.min(MAX_RETRY_DELAY_MS, MIN_RETRY_DELAY_MS * (2 ** Math.min(attempts - 1, 6)));
      await Auction.updateOne(
        { _id: claimed._id, status: 'settling', settlementLockToken: leaseToken },
        {
          $set: {
            status: 'settlement-failed',
            settlementError: message,
            settlementLockUntil: new Date(0),
            nextSettlementAttemptAt: new Date(Date.now() + retryDelay),
          },
          $inc: { settlementAttempts: 1 },
          $unset: { settlementLockToken: 1 },
        },
      );
      failed += 1;
      console.error(`Failed to settle auction ${claimed._id.toString()}; it will be retried`, error);
    }
  }

  return { examined: dueAuctions.length, completed, failed };
}
