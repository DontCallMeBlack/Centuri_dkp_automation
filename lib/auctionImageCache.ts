interface CachedImage {
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
  etag: string;
}

// Exact immutable revisions may be shared across authenticated origin requests.
// Authorization always runs before a cache lookup; private images never enter a CDN.
const images = new Map<string, { image: CachedImage; expiresAt: number }>();
const MAX_IMAGE_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_CACHE_ENTRIES = 256;
const IMAGE_CACHE_TTL_MS = 10 * 60_000;
let imageBytes = 0;

function removeImage(key: string) {
  const existing = images.get(key);
  if (existing) imageBytes -= existing.image.bytes.byteLength;
  images.delete(key);
}

export function readCachedAuctionImage(key: string, now = Date.now()) {
  const entry = images.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) { removeImage(key); return null; }
  images.delete(key);
  images.set(key, entry);
  return entry.image;
}

export function cacheAuctionImage(key: string, image: CachedImage, now = Date.now()) {
  removeImage(key);
  if (image.bytes.byteLength > MAX_IMAGE_CACHE_BYTES) return;
  images.set(key, { image, expiresAt: now + IMAGE_CACHE_TTL_MS });
  imageBytes += image.bytes.byteLength;
  while (images.size > MAX_IMAGE_CACHE_ENTRIES || imageBytes > MAX_IMAGE_CACHE_BYTES) {
    const oldestKey = images.keys().next().value;
    if (oldestKey === undefined) break;
    removeImage(oldestKey);
  }
}
