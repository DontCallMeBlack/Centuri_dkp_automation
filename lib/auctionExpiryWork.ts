import type { QueryFilter } from 'mongoose';
import type { IAuction } from './models/Auction.ts';

export interface AuctionExpiryRecord {
  status: string;
  endsAt: Date;
  updatedAt?: Date;
  settlementNeedsReview?: boolean;
  settlementRetryAt?: Date | null;
  settlementLeaseUntil?: Date | null;
}

const REMOVAL_RECOVERY_MS = 5 * 60_000;

/** Shared with the worker so reads do not wake it during a live lease/backoff. */
export function auctionSettlementRecoveryStates(now: Date): QueryFilter<IAuction>[] {
  return [
    { status: 'active' },
    {
      status: 'settlement-failed', settlementNeedsReview: { $ne: true },
      $or: [{ settlementRetryAt: { $lte: now } }, { settlementRetryAt: { $exists: false } }],
    },
    { status: 'settling', $or: [{ settlementLeaseUntil: { $lte: now } }, { settlementLeaseUntil: { $exists: false } }] },
  ];
}

/** Targeted reads cannot rule out work elsewhere. Probe globally before loading
 * the worker; keep legacy removals without timestamps conservative.
 */
export function auctionExpiryWorkFilter(now: Date): QueryFilter<IAuction> {
  return { $or: [
    { status: 'removing', $or: [
      { updatedAt: { $lt: new Date(now.getTime() - REMOVAL_RECOVERY_MS) } },
      { updatedAt: { $exists: false } },
    ] },
    { endsAt: { $lte: now }, $or: auctionSettlementRecoveryStates(now) },
  ] };
}

/** Use only a fresh, complete outstanding-auction read. */
export function hasAuctionExpiryWork(auctions: ReadonlyArray<AuctionExpiryRecord>, now: number) {
  return auctions.some((auction) => {
    if (auction.status === 'removing') {
      return !auction.updatedAt || auction.updatedAt.getTime() < now - REMOVAL_RECOVERY_MS;
    }
    if (!(auction.endsAt.getTime() <= now)) return false;
    if (auction.status === 'active') return true;
    if (auction.status === 'settlement-failed') {
      return auction.settlementNeedsReview !== true &&
        (auction.settlementRetryAt === undefined || (auction.settlementRetryAt instanceof Date && auction.settlementRetryAt.getTime() <= now));
    }
    return auction.status === 'settling' &&
      (auction.settlementLeaseUntil === undefined || (auction.settlementLeaseUntil instanceof Date && auction.settlementLeaseUntil.getTime() <= now));
  });
}
