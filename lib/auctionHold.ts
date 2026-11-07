import mongoose from 'mongoose';
import Auction from '@/lib/models/Auction';
import AuctionHold from '@/lib/models/AuctionHold';
import type { IAuctionBid, IAuction } from '@/lib/models/Auction';
import { canBindAuctionHold } from '@/lib/auctionSecurity';
import { getSheetRecordKey } from '@/lib/sheetRecordLinks';
import { RequestValidationError } from '@/lib/security/request';
const RESERVING_STATUSES: IAuction['status'][] = ['active', 'removing', 'settling', 'settlement-failed'];

/** Called inside a transaction; old holds are bound only after checking their outstanding bids. */
export async function getBoundAuctionHold(
  bid: Pick<IAuctionBid, 'rowIndex' | 'owner' | 'account'>,
  session: mongoose.ClientSession,
  release?: { auctionId: mongoose.Types.ObjectId; amount: number },
) {
  let hold = await AuctionHold.findOne({ rowIndex: bid.rowIndex }).session(session);
  if (!hold) {
    [hold] = await AuctionHold.create([{
      rowIndex: bid.rowIndex, heldPoints: 0, owner: bid.owner, account: bid.account,
    }], { session });
  }
  const auctions = await Auction.find({ status: { $in: RESERVING_STATUSES }, 'highBid.rowIndex': bid.rowIndex })
    .select('highBid').session(session).lean();
  const reservations = auctions.flatMap((auction) => auction.highBid ? [auction.highBid] : []);
  const rowReservations = reservations.filter((reservation) => reservation.rowIndex === bid.rowIndex);
  const reservationsMatchIdentity = rowReservations.length > 0 && rowReservations.every((reservation) =>
    getSheetRecordKey(reservation) === getSheetRecordKey(bid));
  const reservedPoints = rowReservations.reduce((sum, reservation) => sum + reservation.amount, 0);
  const reservationsAreValid = reservationsMatchIdentity && rowReservations.every((reservation) =>
    Number.isSafeInteger(reservation.amount) && reservation.amount > 0) &&
    Number.isSafeInteger(reservedPoints);
  if (reservationsAreValid && ((release && hold.heldPoints !== reservedPoints) ||
    (!release && hold.heldPoints < reservedPoints))) {
    hold.heldPoints = reservedPoints;
    hold.owner = bid.owner;
    hold.account = bid.account;
    await hold.save({ session });
  }
  if (release && release.amount > 0) {
    const remaining = auctions
      .filter((auction) => auction._id.toString() !== release.auctionId.toString() &&
        auction.highBid?.rowIndex === bid.rowIndex)
      .flatMap((auction) => auction.highBid ? [auction.highBid] : []);
    const remainingPoints = remaining.reduce((sum, reservation) => sum + reservation.amount, 0);
    if (Number.isSafeInteger(remainingPoints) &&
      remaining.every((reservation) => getSheetRecordKey(reservation) === getSheetRecordKey(bid)) &&
      hold.heldPoints - release.amount === remainingPoints) {
      hold.owner = bid.owner;
      hold.account = bid.account;
    }
  }
  if (!canBindAuctionHold(hold, bid, reservations)) {
    throw new RequestValidationError('This toon has an inconsistent or moved auction reservation. Ask a manager to review it.', 409);
  }
  hold.owner = bid.owner;
  hold.account = bid.account;
  return hold;
}
