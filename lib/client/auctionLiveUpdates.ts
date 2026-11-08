interface AuctionVersion {
  id: string;
  createdAt: string;
  itemId: string;
  endsAt: string;
  status: string;
  deliveryStatus: string;
  bidVersion?: number;
  versionToken?: string;
}

interface BalanceAuction {
  id: string;
  status: string;
  bidVersion?: number;
  highBid?: { isMine: boolean; amount: number } | null;
  winner?: { isMine: boolean } | null;
}

interface LiveUpdates<T> {
  changed: boolean;
  auctions: T[];
  removedIds: string[];
}

/** Every tracked auction needs a version, including those outside the first batch. */
export async function readAuctionLiveUpdates<T extends AuctionVersion>(auctions: T[], discover: boolean): Promise<LiveUpdates<T>> {
  const sorted = [...auctions].sort((first, second) => Date.parse(second.createdAt) - Date.parse(first.createdAt));
  const batches: T[][] = [];
  for (let offset = 0; offset < sorted.length; offset += 100) batches.push(sorted.slice(offset, offset + 100));
  if (discover && !batches.length) batches.push([]);

  const results = await Promise.all(batches.map(async (batch, index) => {
    const versions = batch.map((auction) => [auction.id, auction.versionToken ??
      `${auction.bidVersion ?? 0}:${auction.status}:${auction.endsAt}:${auction.deliveryStatus}:${auction.itemId}`]);
    // Only the discovery request may include auctions outside this batch.
    const scope = discover && index === 0 ? '' : `&ids=${encodeURIComponent(JSON.stringify(batch.map((auction) => auction.id)))}`;
    const response = await fetch(`/api/auction?live=1&versions=${encodeURIComponent(JSON.stringify(versions))}${scope}`, { cache: 'no-store' });
    if (!response.ok) throw new Error('Live bid updates are delayed. Retrying automatically.');
    return await response.json() as Partial<LiveUpdates<T>>;
  }));

  const changed = new Map<string, T>();
  const removed = new Set<string>();
  for (const result of results) {
    if (!result.changed) continue;
    for (const auction of result.auctions ?? []) changed.set(auction.id, auction);
    for (const id of result.removedIds ?? []) removed.add(id);
  }
  // A targeted deletion can race the discovery read; deletion wins for this poll.
  for (const id of removed) changed.delete(id);
  return { changed: results.some((result) => result.changed === true), auctions: [...changed.values()], removedIds: [...removed] };
}

/** Removing a leading auction releases funds just as replacing its high bid does. */
export function auctionBalanceChanged(previous: BalanceAuction[], updates: BalanceAuction[], removedIds: string[]) {
  const oldById = new Map(previous.map((auction) => [auction.id, auction]));
  if (removedIds.some((id) => oldById.get(id)?.highBid?.isMine || oldById.get(id)?.winner?.isMine)) return true;
  return updates.some((live) => {
    const old = oldById.get(live.id);
    return Boolean(old?.highBid?.isMine || live.highBid?.isMine || old?.winner?.isMine) &&
      (old?.bidVersion !== live.bidVersion || old?.status !== live.status || old?.highBid?.amount !== live.highBid?.amount);
  });
}
