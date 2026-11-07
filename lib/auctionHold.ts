import mongoose from 'mongoose';
import Auction from '@/lib/models/Auction';
import AuctionHold from '@/lib/models/AuctionHold';
import type { IAuctionBid, IAuction } from '@/lib/models/Auction';
import { canBindAuctionHold } from '@/lib/auctionSecurity';
import { RequestValidationError } from '@/lib/security/request';
import { getSheetRecordKey } from '@/lib/sheetRecordLinks';
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
  const hasKnownOwner = typeof hold.owner === 'string' && hold.owner.trim().length > 0;
  const hasKnownAccount = typeof hold.account === 'string' && hold.account.trim().length > 0;
  const hasBoundIdentity = hasKnownOwner &&
    typeof hold.account === 'string' && hold.account.trim().length > 0;
  const reservationPoints = reservations.reduce((sum, reservation) => sum + reservation.amount, 0);
  const reservationsFullyMatchCurrent = reservations.length > 0 && reservations.every((reservation) =>
    typeof reservation.owner === 'string' && reservation.owner.trim().length > 0 &&
    typeof reservation.account === 'string' && reservation.account.trim().length > 0 &&
    getSheetRecordKey(reservation) === getSheetRecordKey(bid));
  if (reservationsFullyMatchCurrent) {
    hold.owner = bid.owner;
    hold.account = bid.account;
    hold.heldPoints = reservationPoints;
  }
  if (reservations.length > 0 && reservations.every((reservation) =>
    Number.isSafeInteger(reservation.amount) && reservation.amount > 0 &&
    (!hasBoundIdentity || getSheetRecordKey(reservation) === getSheetRecordKey(bid)) &&
    (!hasKnownOwner || typeof reservation.owner !== 'string' || reservation.owner.trim().toLowerCase() === hold.owner!.trim().toLowerCase() || !reservation.owner.trim()) &&
    (!hasKnownAccount || typeof reservation.account !== 'string' || reservation.account.trim().toLowerCase() === hold.account!.trim().toLowerCase() || !reservation.account.trim()))) {
    hold.heldPoints = reservationPoints;
  }
  if (!canBindAuctionHold(hold, bid, reservations)) {
    console.error('Auction reservation bind mismatch', {
      rowIndex: bid.rowIndex,
      hold: {
        heldPoints: hold.heldPoints,
        hasOwner: typeof hold.owner === 'string' && hold.owner.trim().length > 0,
        hasAccount: typeof hold.account === 'string' && hold.account.trim().length > 0,
      },
      reservations: reservations.map((reservation) => ({
        amount: reservation.amount,
        hasOwner: typeof reservation.owner === 'string' && reservation.owner.trim().length > 0,
        hasAccount: typeof reservation.account === 'string' && reservation.account.trim().length > 0,
      })),
      reservationPoints: reservations.reduce((sum, reservation) => sum + reservation.amount, 0),
    });
    throw new RequestValidationError('This toon has an inconsistent or moved auction reservation. Ask a manager to review it.', 409);
  }
  hold.owner = bid.owner;
  hold.account = bid.account;
  return hold;
}
