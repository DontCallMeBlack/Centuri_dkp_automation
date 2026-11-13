import { canRoleBid } from '../auctionRules.ts';

export const AUCTION_DISCOVERY_MS = 60 * 60_000;
export const AUCTION_FINAL_POLL_MS = 60_000;
export const AUCTION_FINAL_WINDOW_MS = 5 * 60_000;

interface PollAuction {
  id: string; status: string; endsAt: string; biddingClosed: boolean;
  requiredRoles: string[]; requiredRole?: string;
  highBid: { isMine: boolean; rowIndex: number; amount: number } | null;
}
interface PollToon {
  rowIndex: number; subClass: string; available: number | null; heldPoints: number;
  canBid?: boolean; roleChange?: { scheduledRole: string; effectiveAt: string } | null;
}
interface PollData { auctions: PollAuction[]; toons: PollToon[]; canBidWeekly: boolean }

/** Display scheduling only: bid acceptance always checks current server state. */
export function auctionPollPlan(data: PollData, now: number, lastDiscoveryAt: number, lastTargetAt: number,
  checkedWindows: ReadonlySet<string> = new Set(), pushConnected = false) {
  const ids: string[] = [];
  const eligibilityWindows: string[] = [];
  let nextWindowAt = Infinity;
  let expiredTrackedAuction = false;
  for (const auction of data.auctions) {
    const remaining = Date.parse(auction.endsAt) - now;
    if (!Number.isFinite(remaining) || remaining < -AUCTION_FINAL_WINDOW_MS) continue;
    const ownsBid = auction.highBid?.isMine === true;
    if (auction.status !== 'active' && !(ownsBid && auction.status === 'settling')) continue;
    const roles = auction.requiredRoles?.length ? auction.requiredRoles : [auction.requiredRole ?? ''];
    const roleMatches = (toon: PollToon) => {
      const role = toon.roleChange && Date.parse(toon.roleChange.effectiveAt) <= now
        ? toon.roleChange.scheduledRole : toon.subClass;
      return canRoleBid(role, roles);
    };
    // Refresh eligibility once at the boundary, even if the displayed funds are stale.
    if (!auction.biddingClosed && data.toons.some(roleMatches)) {
      if (remaining > AUCTION_FINAL_WINDOW_MS) nextWindowAt = Math.min(nextWindowAt, now + remaining - AUCTION_FINAL_WINDOW_MS);
      else if (remaining > 0 && !checkedWindows.has(`${auction.id}:${auction.endsAt}`)) eligibilityWindows.push(`${auction.id}:${auction.endsAt}`);
    }
    const eligible = data.canBidWeekly && !auction.biddingClosed && data.toons.some((toon) => {
      const ownHold = ownsBid && auction.highBid?.rowIndex === toon.rowIndex ? auction.highBid.amount : 0;
      return toon.canBid !== false && toon.available !== null && roleMatches(toon) &&
        toon.available - toon.heldPoints + ownHold >= (auction.highBid?.amount ?? 0) + 1;
    });
    if (!eligible && !ownsBid) continue;
    if (remaining <= AUCTION_FINAL_WINDOW_MS) {
      ids.push(auction.id);
      if (remaining <= 0) expiredTrackedAuction = true;
      else if (pushConnected) nextWindowAt = Math.min(nextWindowAt, now + remaining);
    }
    else nextWindowAt = Math.min(nextWindowAt, now + remaining - AUCTION_FINAL_WINDOW_MS);
  }
  const discoveryIn = Math.max(0, lastDiscoveryAt + AUCTION_DISCOVERY_MS - now);
  // Push replaces empty checks during bidding. Expiry still drives settlement
  // promptly, even if a notification is lost or the publisher is unavailable.
  const interval = pushConnected && !expiredTrackedAuction ? 5 * 60_000 : AUCTION_FINAL_POLL_MS;
  const targetIn = ids.length ? Math.max(0, lastTargetAt + interval - now) : Infinity;
  return {
    ids,
    eligibilityWindows,
    discover: discoveryIn === 0,
    delay: Math.max(0, Math.min(discoveryIn, targetIn, nextWindowAt - now, eligibilityWindows.length ? 0 : Infinity)),
  };
}
