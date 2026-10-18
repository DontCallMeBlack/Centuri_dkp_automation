import mongoose from 'mongoose';
import Auction from '@/lib/models/Auction';
import AuctionHold from '@/lib/models/AuctionHold';
import type { IAuctionBid, IAuction } from '@/lib/models/Auction';
import { canBindAuctionHold } from '@/lib/auctionSecurity';
import { RequestValidationError } from '@/lib/security/request';
const RESERVING_STATUSES: IAuction['status'][] = ['active', 'removing', 'settling', 'settlement-failed'];

/** Called inside a transaction; old holds are bound only after checking their outstanding bids. */
export async function getBoundAuctionHold(bid: Pick<IAuctionBid, 'rowIndex' | 'owner' | 'account'>, session: mongoose.ClientSession) {
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
