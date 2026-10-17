import { getSheetRecordKey } from './sheetRecordLinks.ts';

interface ToonIdentity { owner: string; account: string }
interface Reservation extends ToonIdentity { rowIndex: number; amount: number }
interface Hold { rowIndex: number; heldPoints: number; owner?: string; account?: string }
interface BidForResponse extends Reservation {
  userId: { toString(): string }; nickname: string; placedAt: Date;
}

/** Explicit fields avoid spreading Mongoose subdocument internals into JSON. */
export function serializeAuctionBid(bid: BidForResponse | undefined, currentUserId: { toString(): string }) {
  if (!bid) return null;
  return {
    userId: bid.userId.toString(),
    isMine: bid.userId.toString() === currentUserId.toString(),
    nickname: bid.nickname,
    rowIndex: bid.rowIndex,
    owner: bid.owner,
    account: bid.account,
    amount: bid.amount,
    placedAt: bid.placedAt.toISOString(),
  };
}

/** Nicknames can change or be reused; only a stored user ID establishes ownership. */
export function isAuctionPoster(auction: { createdByUserId?: { toString(): string } }, userId: { toString(): string }) {
  return Boolean(auction.createdByUserId && auction.createdByUserId.toString() === userId.toString());
}

export function holdMatchesIdentity(hold: Hold, identity: ToonIdentity) {
  return typeof hold.owner === 'string' && typeof hold.account === 'string' &&
    getSheetRecordKey({ owner: hold.owner, account: hold.account }) === getSheetRecordKey(identity);
}

/** Adopt an old row-only reservation only when every outstanding bid proves its identity and total. */
export function canBindAuctionHold(hold: Hold, identity: ToonIdentity, reservations: Reservation[]) {
  if (!Number.isSafeInteger(hold.heldPoints) || hold.heldPoints < 0) return false;
  const rowReservations = reservations.filter((bid) => bid.rowIndex === hold.rowIndex);
  if (hold.heldPoints === 0) return rowReservations.length === 0;
  if ((hold.owner !== undefined || hold.account !== undefined) && !holdMatchesIdentity(hold, identity)) return false;
  return rowReservations.length > 0 && rowReservations.every((bid) =>
    Number.isSafeInteger(bid.amount) && bid.amount > 0 && getSheetRecordKey(bid) === getSheetRecordKey(identity),
  ) && rowReservations.reduce((sum, bid) => sum + bid.amount, 0) === hold.heldPoints;
}

/** A moved toon cannot reserve again against a second row while its original hold is outstanding. */
export function hasMovedAuctionReservation(identity: ToonIdentity & { rowIndex: number }, reservations: Reservation[]) {
  const key = getSheetRecordKey(identity);
  return reservations.some((bid) => bid.rowIndex !== identity.rowIndex && getSheetRecordKey(bid) === key);
}

export function isAuctionBidInput(value: Record<string, unknown>): value is Record<string, unknown> & {
  auctionId: string; rowIndex: number; amount: number;
} {
  return typeof value.auctionId === 'string' && /^[a-f\d]{24}$/i.test(value.auctionId) &&
    typeof value.rowIndex === 'number' && Number.isInteger(value.rowIndex) && value.rowIndex >= 3 && value.rowIndex <= 1000 &&
    typeof value.amount === 'number' && Number.isSafeInteger(value.amount) && value.amount > 0;
}
