import { NextResponse } from 'next/server';
import mongoose from 'mongoose';
import AuctionItem from '@/lib/models/AuctionItem';
import { getSessionUser } from '@/lib/auth/session';

export async function GET(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const itemId = new URL(request.url).searchParams.get('id');
  if (!itemId || !mongoose.isValidObjectId(itemId)) {
    return NextResponse.json({ error: 'Invalid auction item ID' }, { status: 400 });
  }

  try {
    const item = await AuctionItem.findById(itemId).select('image imageType').lean();
    if (!item) return NextResponse.json({ error: 'Auction item not found' }, { status: 404 });
    const image = new Uint8Array(item.image.byteLength);
    image.set(item.image);
    return new Response(image.buffer, {
      headers: {
        'Content-Type': item.imageType,
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unable to load auction item image';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
