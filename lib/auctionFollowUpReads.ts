import Auction from '@/lib/models/Auction';
import User from '@/lib/models/User';
import type { Types } from 'mongoose';

/** Creator rank is only used by the General-specific close permission rule.
 * Chief/poster permissions do not depend on it. Never cache permission data.
 */
export async function readAuctionCreatorRoles(viewerRole: string, auctions: Array<{ createdByUserId?: Types.ObjectId }>) {
  const ids = viewerRole === 'general'
    ? [...new Set(auctions.flatMap((auction) => auction.createdByUserId ? [auction.createdByUserId.toString()] : []))]
    : [];
  return ids.length ? User.find({ _id: { $in: ids } }).select('_id role').lean() : [];
}

/** Same two follow-up sets in one read; no limits or additional caching. */
export async function readAuctionFollowUpTasks() {
  const tasks = await Auction.find({
    status: 'completed',
    $or: [
      { deliveryStatus: 'pending' },
      { deliveryStatus: 'not-required', highBid: { $exists: false } },
    ],
  }).sort({ createdAt: 1 }).lean();
  return {
    pendingDeliveryTasks: tasks.filter((auction) => auction.deliveryStatus === 'pending'),
    pendingNoBidTasks: tasks.filter((auction) => auction.deliveryStatus === 'not-required' &&
      !Object.prototype.hasOwnProperty.call(auction, 'highBid')),
  };
}
