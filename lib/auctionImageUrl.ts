/** Existing image sets keep this revision until an image replacement assigns a UUID. */
export const LEGACY_AUCTION_IMAGE_VERSION = 'legacy';

export function auctionImageUrl(itemId: string, index = 0, imageVersion?: string) {
  return `/api/auction/image?id=${encodeURIComponent(itemId)}&index=${index}&version=${encodeURIComponent(imageVersion ?? LEGACY_AUCTION_IMAGE_VERSION)}`;
}
