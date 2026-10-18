import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import Auction from '@/lib/models/Auction';
import { getBoundAuctionHold } from '@/lib/auctionHold';
import { adjustPlayersDKP } from '@/lib/googleSheets';
import { DkpIntegrityError } from '@/lib/dkpAccounting';
import { RequestValidationError } from '@/lib/security/request';
import { needsSettlementManualReview, getAuctionSettlementMutationKey } from '@/lib/auctionSettlement';

export async function settleExpiredAuctions() {
  if (process.env.DKP_WRITES_PAUSED === 'true') return;
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
