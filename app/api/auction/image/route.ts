import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import AuctionItem from '@/lib/models/AuctionItem';
import { getSessionUser } from '@/lib/auth/session';
import { requestErrorResponse } from '@/lib/security/request';
import { LEGACY_AUCTION_IMAGE_VERSION } from '@/lib/auctionImageUrl';
import { cacheAuctionImage, readCachedAuctionImage } from '@/lib/auctionImageCache';

function imageResponse(image: { bytes: Uint8Array<ArrayBuffer>; contentType: string; etag: string }, request: Request, immutable: boolean) {
  const headers = {
    'Cache-Control': immutable ? 'private, max-age=31536000, immutable' : 'private, max-age=60, must-revalidate',
    ETag: image.etag,
    Vary: 'Cookie',
  };
  if (request.headers.get('if-none-match') === image.etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(image.bytes, { headers: {
    ...headers,
    'Content-Type': image.contentType,
    'Content-Length': image.bytes.byteLength.toString(),
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': 'inline',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  } });
}

export async function GET(request: Request) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const imageUrl = new URL(request.url);
    const itemId = imageUrl.searchParams.get('id');
    const rawIndex = imageUrl.searchParams.get('index') ?? '0';
    const version = imageUrl.searchParams.get('version');
    const requestedImageIndex = Number(rawIndex);
    if (!itemId || !mongoose.isValidObjectId(itemId)) {
      return NextResponse.json({ error: 'Invalid auction item ID' }, { status: 400 });
    }
    if (!/^[0-7]$/.test(rawIndex)) {
      return NextResponse.json({ error: 'Invalid auction image index' }, { status: 400 });
    }
    if (version !== null && !/^(?:legacy|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(version)) {
      return NextResponse.json({ error: 'Invalid auction image version' }, { status: 400 });
    }

    const cacheKey = `${itemId}:${rawIndex}:${version}`;
    const cached = version === null ? null : readCachedAuctionImage(cacheKey);
    if (cached) return imageResponse(cached, request, true);

    type StoredImage = { data: Buffer | mongoose.mongo.Binary; contentType: string };
    const item = await AuctionItem.findById(itemId).select({
      images: { $slice: [requestedImageIndex, 1] }, image: 1, imageType: 1,
      imageVersion: 1,
    }).lean<{ images?: StoredImage[]; image?: Buffer | mongoose.mongo.Binary; imageType?: string; imageVersion?: string }>();
    if (!item) return NextResponse.json({ error: 'Auction item not found' }, { status: 404 });
    if (version !== null && version !== (item.imageVersion ?? LEGACY_AUCTION_IMAGE_VERSION)) {
      // An old URL must never cache replacement bytes under the old revision.
      return NextResponse.json({ error: 'Auction image version is no longer available' }, { status: 404, headers: { 'Cache-Control': 'private, no-store' } });
    }
    const storedImage = item.images?.[0];
    const legacyImage = requestedImageIndex === 0 && item.image && item.imageType
      ? { data: item.image, contentType: item.imageType }
      : undefined;
    const selectedImage = storedImage ?? legacyImage;
    if (!selectedImage) {
      return NextResponse.json({ error: 'Auction item image not found' }, { status: 404 });
    }
    // Lean reads avoid hydrating image arrays and Mongoose buffers. BSON Binary
    // value() respects its used length, including buffers with spare capacity.
    const image = Buffer.isBuffer(selectedImage.data) ? selectedImage.data : selectedImage.data.value();
    const cachedImage = {
      bytes: Uint8Array.from(image),
      contentType: selectedImage.contentType,
      etag: version === null ? `"${createHash('sha256').update(image).digest('base64url')}"` : `"${version}:${rawIndex}"`,
    };
    if (version !== null) cacheAuctionImage(cacheKey, cachedImage);
    return imageResponse(cachedImage, request, version !== null);
  } catch (error: unknown) {
    return requestErrorResponse(error, 'Unable to load auction item image. Please retry shortly.');
  }
}
