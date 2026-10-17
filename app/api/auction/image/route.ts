import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import AuctionItem from '@/lib/models/AuctionItem';
import { getSessionUser } from '@/lib/auth/session';
import { requestErrorResponse } from '@/lib/security/request';

export async function GET(request: Request) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const imageUrl = new URL(request.url);
    const itemId = imageUrl.searchParams.get('id');
    const rawIndex = imageUrl.searchParams.get('index') ?? '0';
    const requestedImageIndex = Number(rawIndex);
    if (!itemId || !mongoose.isValidObjectId(itemId)) {
      return NextResponse.json({ error: 'Invalid auction item ID' }, { status: 400 });
    }
    if (!/^[0-7]$/.test(rawIndex)) {
      return NextResponse.json({ error: 'Invalid auction image index' }, { status: 400 });
    }

    const item = await AuctionItem.findById(itemId).select({
      images: { $slice: [requestedImageIndex, 1] }, image: 1, imageType: 1,
    });
    if (!item) return NextResponse.json({ error: 'Auction item not found' }, { status: 404 });
    const storedImage = item.images?.[0];
    const legacyImage = requestedImageIndex === 0 && item.image && item.imageType
      ? { data: item.image, contentType: item.imageType }
      : undefined;
    const selectedImage = storedImage ?? legacyImage;
    if (!selectedImage) {
      return NextResponse.json({ error: 'Auction item image not found' }, { status: 404 });
    }
    const image = Buffer.from(selectedImage.data);
    const etag = `"${createHash('sha256').update(image).digest('base64url')}"`;
    const cacheHeaders = {
      'Cache-Control': 'private, max-age=60, must-revalidate',
      ETag: etag,
      Vary: 'Cookie',
    };
    if (request.headers.get('if-none-match') === etag) {
      return new Response(null, { status: 304, headers: cacheHeaders });
    }
    return new Response(Uint8Array.from(image), {
      headers: {
        ...cacheHeaders,
        'Content-Type': selectedImage.contentType,
        'Content-Length': image.byteLength.toString(),
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'inline',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    });
  } catch (error: unknown) {
    return requestErrorResponse(error, 'Unable to load auction item image. Please retry shortly.');
  }
}
