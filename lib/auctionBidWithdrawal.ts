import type mongoose from 'mongoose';
import type { ISheetRosterRecord } from '@/lib/models/SheetRosterCache';
import type { IAuctionBid } from '@/lib/models/Auction';
import Auction from '@/lib/models/Auction';
import AuctionBidHistory from '@/lib/models/AuctionBidHistory';
import ToonRoleChange from '@/lib/models/ToonRoleChange';
import ToonRoleChangeRequest from '@/lib/models/ToonRoleChangeRequest';
import User from '@/lib/models/User';
import { getBoundAuctionHold } from '@/lib/auctionHold';
import { canAffordBid, DkpIntegrityError } from '@/lib/dkpAccounting';
import { getLinkedSheetRecordRows, getSheetRecordKey } from '@/lib/sheetRecordLinks';
import { canRoleBid, AUCTION_WEEKLY_MINIMUM } from '@/lib/auctionRules';
import { getEffectiveToonRole } from '@/lib/toonRoleChanges';
import { RequestValidationError } from '@/lib/security/request';

type Identity = { rowIndex: number; owner: string; account: string };
type WeeklyRecord = { rowIndex: number; weeklyEarned: number };

function isSameToon(bid: Partial<IAuctionBid> | undefined, identity: Identity) {
  if (!bid) return false;
  if (bid.owner !== undefined && bid.account !== undefined) {
    return getSheetRecordKey({ owner: bid.owner, account: bid.account }) === getSheetRecordKey(identity);
  }
  return bid.rowIndex === identity.rowIndex;
}

/** Remove one toon from active auctions and promote each auction's best still-valid bid. */
export async function withdrawToonOpenAuctionBids(
  identity: Identity,
  roster: ISheetRosterRecord[],
  rosterWithWeeklyEarned: WeeklyRecord[],
  session: mongoose.ClientSession,
) {
  const now = new Date();
  const inFlight = await Auction.find({
    status: { $in: ['removing', 'settling', 'settlement-failed'] },
    $or: [
      { 'highBid.rowIndex': identity.rowIndex },
      { 'highBid.owner': identity.owner, 'highBid.account': identity.account },
    ],
  }).select('status highBid').session(session).lean();
  if (inFlight.some((auction) => isSameToon(auction.highBid, identity))) {
    throw new RequestValidationError('This toon has an auction being settled. Try the wipe or transfer again after it finishes.', 409);
  }

  const auctions = await Auction.find({ status: 'active' }).session(session);
  const openAuctionIds = auctions.map((auction) => auction._id);
  const history = openAuctionIds.length
    ? await AuctionBidHistory.find({ auctionId: { $in: openAuctionIds }, withdrawnAt: { $exists: false } })
      .sort({ amount: -1, placedAt: 1 }).session(session)
    : [];
  const targetKey = getSheetRecordKey(identity);
  const affectedHistory = history.filter((bid) => bid.identityKey === targetKey);
  if (!affectedHistory.length && !auctions.some((auction) => isSameToon(auction.highBid, identity))) {
    const hold = await getBoundAuctionHold(identity, session);
    if (hold.heldPoints !== 0) throw new DkpIntegrityError('This toon has reserved auction DKP without an open bid. A manager must reconcile the hold before changing DKP.');
    return { withdrawnBids: 0, promotedBids: 0 };
  }

  const affectedAuctionIds = new Set(affectedHistory.map((bid) => bid.auctionId.toString()));
  const targetCurrentAuctions = auctions.filter((auction) => isSameToon(auction.highBid, identity));
  const legacyHighBids = targetCurrentAuctions.filter((auction) => !affectedHistory.some((bid) =>
    bid.auctionId.equals(auction._id) && bid.userId.equals(auction.highBid?.userId) && bid.amount === auction.highBid?.amount,
  )).length;
  for (const auction of targetCurrentAuctions) affectedAuctionIds.add(auction._id.toString());
  if (affectedHistory.length) {
    await AuctionBidHistory.updateMany(
      { _id: { $in: affectedHistory.map((bid) => bid._id) }, withdrawnAt: { $exists: false } },
      { $set: { withdrawnAt: now } }, { session },
    );
  }

  let promotedBids = 0;
  for (const auction of auctions) {
    if (!affectedAuctionIds.has(auction._id.toString())) continue;
    if (!isSameToon(auction.highBid, identity)) continue;

    const currentBid = auction.highBid;
    if (!currentBid) continue;
    const targetHold = await getBoundAuctionHold(identity, session);
    if (targetHold.heldPoints < currentBid.amount) {
      throw new DkpIntegrityError('The toon’s auction hold is smaller than its open bid. A manager must reconcile the hold before changing DKP.');
    }
    targetHold.heldPoints -= currentBid.amount;
    await targetHold.save({ session });

    const candidateHistory = history.filter((bid) => bid.auctionId.equals(auction._id) && bid.identityKey !== targetKey &&
      !affectedHistory.some((removed) => removed._id.equals(bid._id)) && bid.amount < currentBid.amount);
    const seenBidders = new Set<string>();
    let replacement: IAuctionBid | undefined;
    for (const candidate of candidateHistory) {
      const bidderKey = `${candidate.userId.toString()}:${candidate.identityKey}`;
      if (seenBidders.has(bidderKey)) continue;
      seenBidders.add(bidderKey);
      const toon = roster.find((record) => getSheetRecordKey(record) === candidate.identityKey);
      if (!toon || toon.rowIndex !== candidate.rowIndex || toon.owner !== candidate.owner || toon.account !== candidate.account) continue;
      const user = await User.findOne({ _id: candidate.userId, status: 'approved' })
        .select('_id nickname role sheetRecords sheetRecordName').session(session);
      if (!user || !getLinkedSheetRecordRows(user, roster).includes(toon.rowIndex)) continue;

      const linkedRows = new Set(getLinkedSheetRecordRows(user, roster));
      const weeklyEarnedTotal = rosterWithWeeklyEarned.filter((record) => linkedRows.has(record.rowIndex))
        .reduce((total, record) => total + record.weeklyEarned, 0);
      if (weeklyEarnedTotal < AUCTION_WEEKLY_MINIMUM || toon.available === null || toon.available < 0) continue;
      const roleChange = await ToonRoleChange.findOne({ identityKey: candidate.identityKey }).session(session).lean();
      const approval = roleChange ? await ToonRoleChangeRequest.findOne({
        identityKey: candidate.identityKey, status: { $in: ['approved', 'applied'] },
        requestedRole: roleChange.scheduledRole, effectiveAt: roleChange.effectiveAt,
        decidedByUserId: { $exists: true }, decidedAt: { $exists: true },
      }).session(session).lean() : null;
      const effectiveRole = getEffectiveToonRole(toon.subClass, roleChange, now, approval);
      const roles = auction.requiredRoles?.length ? auction.requiredRoles : [auction.requiredRole ?? ''];
      if (!canRoleBid(effectiveRole, roles)) continue;

      const hold = await getBoundAuctionHold({ rowIndex: toon.rowIndex, owner: toon.owner, account: toon.account }, session);
      if (!canAffordBid(candidate.amount, hold.heldPoints, toon.available)) continue;
      hold.heldPoints += candidate.amount;
      await hold.save({ session });
      replacement = {
        userId: user._id,
        nickname: user.nickname,
        rowIndex: toon.rowIndex,
        owner: toon.owner,
        account: toon.account,
        amount: candidate.amount,
        placedAt: candidate.placedAt,
      };
      break;
    }

    auction.highBid = replacement;
    auction.bidVersion = (auction.bidVersion ?? 0) + 1;
    await auction.save({ session });
    if (replacement) promotedBids += 1;
  }

  const remainingHold = await getBoundAuctionHold(identity, session);
  if (remainingHold.heldPoints !== 0) throw new DkpIntegrityError('This toon still has reserved auction DKP after its open bids were withdrawn. A manager must reconcile the hold before changing DKP.');

  return { withdrawnBids: affectedHistory.length + legacyHighBids, promotedBids };
}
