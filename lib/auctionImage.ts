import sharp from 'sharp';

export const MAX_AUCTION_IMAGE_BYTES = 75 * 1024;
export const MAX_AUCTION_ITEM_IMAGE_BYTES = 150 * 1024;

const WEBP_VARIANTS = [
  { width: 1000, quality: 78 },
  { width: 900, quality: 72 },
  { width: 800, quality: 66 },
  { width: 700, quality: 60 },
  { width: 600, quality: 54 },
] as const;

export async function optimizeAuctionImage(imageBytes: Uint8Array) {
  for (const { width, quality } of WEBP_VARIANTS) {
    const optimized = await sharp(imageBytes, { limitInputPixels: 40_000_000 })
      .rotate()
      .resize({ width, height: width, fit: 'inside', withoutEnlargement: true })
      .webp({ quality, effort: 4 })
      .toBuffer();

    if (optimized.byteLength <= MAX_AUCTION_IMAGE_BYTES) {
      return optimized;
    }
  }

  throw new Error('Image cannot be optimized below 75 KB. Choose a simpler or smaller image.');
}
