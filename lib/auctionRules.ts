export const AUCTION_WEEKLY_MINIMUM = 20;
export const AUCTION_DURATION_MS = 2 * 60 * 1000;
export const AUCTION_ANTI_SNIPE_MS = 2 * 60 * 1000;

export function normalizeAuctionRole(role: string) {
  return role.trim().replace(/\s+/g, ' ').toLowerCase();
}
