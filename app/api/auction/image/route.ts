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
    const item = await AuctionItem.findById(itemId).select('image imageType');
    if (!item) return NextResponse.json({ error: 'Auction item not found' }, { status: 404 });
    const image = Buffer.from(item.image);
    return new Response(Uint8Array.from(image), {
      headers: {
        'Content-Type': item.imageType,
        'Cache-Control': 'private, no-store',
        'Content-Length': image.byteLength.toString(),
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unable to load auction item image';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
