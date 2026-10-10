import { NextResponse } from 'next/server';
import { settleExpiredAuctions } from '@/lib/auctionSettlement';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await settleExpiredAuctions();
    return NextResponse.json({ success: true, ...result });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unable to settle expired auctions';
    console.error('Scheduled auction settlement failed', error);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
