/** Use only a fresh, complete outstanding-auction read. Targeted reads cannot
 * rule out expired auctions elsewhere and must retain the global sweep.
 * Keep removal recovery conservative, including records without timestamps.
 */
export function hasAuctionExpiryWork(auctions: ReadonlyArray<{ status: string; endsAt: Date }>, now: number) {
  return auctions.some((auction) => auction.status === 'removing' ||
    (['active', 'settling', 'settlement-failed'].includes(auction.status) && auction.endsAt.getTime() <= now));
}
