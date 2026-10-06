import { NextResponse } from 'next/server';
import mongoose from 'mongoose';
import AuctionItem from '@/lib/models/AuctionItem';
import { getSessionUser } from '@/lib/auth/session';

export async function GET(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const imageUrl = new URL(request.url);
  const itemId = imageUrl.searchParams.get('id');
  const requestedImageIndex = Number(imageUrl.searchParams.get('index') ?? 0);
  if (!itemId || !mongoose.isValidObjectId(itemId)) {
    return NextResponse.json({ error: 'Invalid auction item ID' }, { status: 400 });
  }
  if (!Number.isInteger(requestedImageIndex) || requestedImageIndex < 0) {
    return NextResponse.json({ error: 'Invalid auction image index' }, { status: 400 });
  }

  try {
    const item = await AuctionItem.findById(itemId).select('images image imageType');
    if (!item) return NextResponse.json({ error: 'Auction item not found' }, { status: 404 });
    const storedImage = item.images[requestedImageIndex];
    const legacyImage = requestedImageIndex === 0 && item.image && item.imageType
      ? { data: item.image, contentType: item.imageType }
      : undefined;
    const selectedImage = storedImage ?? legacyImage;
    if (!selectedImage) {
      return NextResponse.json({ error: 'Auction item image not found' }, { status: 404 });
    }
    const image = Buffer.from(selectedImage.data);
    return new Response(Uint8Array.from(image), {
      headers: {
        'Content-Type': selectedImage.contentType,
        'Cache-Control': 'private, max-age=31536000, immutable',
        'Content-Length': image.byteLength.toString(),
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unable to load auction item image';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
