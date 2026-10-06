export const AUCTION_ROLES = [
  'ranger',
  'dps rogue',
  'fire mage',
  'ice mage',
  'support druid',
  'dps druid',
  'support rogue',
  'dps warrior',
  'tank',
] as const;

export const AUCTION_WEEKLY_MINIMUM = 0;
export const AUCTION_DURATION_MS = 24 * 60 * 60 * 1000;
export const AUCTION_ANTI_SNIPE_MS = 5 * 60 * 1000;

export function normalizeAuctionRole(role: string) {
  return role.trim().replace(/\s+/g, ' ').toLowerCase();
}
