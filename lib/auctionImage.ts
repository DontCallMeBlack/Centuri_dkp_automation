import sharp from 'sharp';

export const MAX_AUCTION_IMAGE_BYTES = 75 * 1024;
export const MAX_AUCTION_ITEM_IMAGE_BYTES = 150 * 1024;
export const MAX_AUCTION_UPLOAD_IMAGE_BYTES = 1024 * 1024;

export class AuctionImageError extends Error {}

export function verifyAuctionImageType(bytes: Uint8Array) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}

const WEBP_VARIANTS = [
  { width: 1000, quality: 78 },
  { width: 900, quality: 72 },
  { width: 800, quality: 66 },
  { width: 700, quality: 60 },
  { width: 600, quality: 54 },
] as const;

export async function optimizeAuctionImage(imageBytes: Uint8Array) {
  if (!imageBytes.byteLength || imageBytes.byteLength > MAX_AUCTION_UPLOAD_IMAGE_BYTES || !verifyAuctionImageType(imageBytes)) {
    throw new AuctionImageError('Upload a PNG, JPEG, or WebP image no larger than 1 MB.');
  }
  try {
    for (const { width, quality } of WEBP_VARIANTS) {
      const optimized = await sharp(imageBytes, { limitInputPixels: 40_000_000, failOn: 'warning', animated: false })
        .rotate()
        .resize({ width, height: width, fit: 'inside', withoutEnlargement: true })
        .webp({ quality, effort: 4 })
        .toBuffer();

      if (optimized.byteLength <= MAX_AUCTION_IMAGE_BYTES) return optimized;
    }
  } catch {
    throw new AuctionImageError('The uploaded image could not be decoded. Choose a valid image under 40 megapixels.');
  }
  throw new AuctionImageError('Image cannot be optimized below 75 KB. Choose a simpler or smaller image.');
}
