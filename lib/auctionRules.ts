export const AUCTION_WEEKLY_MINIMUM = 0;
export const AUCTION_DURATION_MS = 24 * 60 * 60 * 1000;
export const AUCTION_ANTI_SNIPE_MS = 5 * 60 * 1000;

export function getAuctionBidEndTime(endsAt: Date, bidAt: Date) {
  const remaining = endsAt.getTime() - bidAt.getTime();
  return remaining > 0 && remaining <= AUCTION_ANTI_SNIPE_MS
    ? new Date(bidAt.getTime() + AUCTION_ANTI_SNIPE_MS) : endsAt;
}

export function normalizeAuctionBossType(value: unknown) {
  if (value === 'Base' || value === 'Prime') return 'Prot';
  if (value === undefined || value === null || value === '') return 'Unassigned';
  return (['Prot', 'Bt', 'Gele', 'Dino', 'Crom', 'Legacy', 'Unassigned'] as const).find((type) => type === value) ?? null;
}

export const ITEM_SUBROLES = ['Ranger', 'DPS Rogue', 'Fire Mage', 'Ice Mage', 'Support Druid', 'DPS Druid', 'Support Rogue', 'DPS Warrior', 'Tank', 'Everyone'] as const;

export function resolveItemSubroles(roles: string[]): string[] | null {
  const resolved = [...new Set(roles.map(normalizeAuctionRole))].map((role) => ITEM_SUBROLES.find((entry) => normalizeAuctionRole(entry) === role));
  if (!resolved.length || resolved.length > 2 || resolved.some((role) => !role) || (resolved.includes('Everyone') && resolved.length !== 1)) return null;
  return resolved as string[];
}

export function canRoleBid(subClass: string, roles: string[]) {
  return roles.some((role) => normalizeAuctionRole(role) === 'everyone' || normalizeAuctionRole(role) === normalizeAuctionRole(subClass));
}

export function normalizeAuctionRole(role: string) {
  return role.trim().replace(/\s+/g, ' ').toLowerCase();
}
