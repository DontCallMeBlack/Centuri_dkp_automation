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
  return (['Prot', 'Bt', 'Gele', 'Dino', 'Crom', 'Unassigned'] as const).find((type) => type === value) ?? null;
}

export function normalizeAuctionRole(role: string) {
  return role.trim().replace(/\s+/g, ' ').toLowerCase();
}
