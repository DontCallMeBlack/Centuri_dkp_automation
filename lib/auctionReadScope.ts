import type { QueryFilter, Types } from 'mongoose';
import type { IAuction } from './models/Auction';

/** Display reads include unresolved work, never the completed archive by default. */
export function auctionDisplayFilter(knownIds: Types.ObjectId[] = []): QueryFilter<IAuction> {
  return { $or: [
    { status: { $in: ['active', 'removing', 'settling', 'settlement-failed'] } },
    { status: 'completed', deliveryStatus: 'pending' },
    { status: 'completed', deliveryStatus: 'not-required', highBid: { $exists: false } },
    // Read tracked records once more so clients observe completion/delivery.
    ...(knownIds.length ? [{ _id: { $in: knownIds } }] : []),
  ] };
}
