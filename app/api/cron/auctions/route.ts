import { timingSafeEqual } from 'node:crypto';
import dbConnect from '@/lib/mongodb';
import { settleExpiredAuctions } from '@/lib/auctionSettlementWorker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: 'Cron authentication is not configured.' }, { status: 503 });
  const expected = Buffer.from(`Bearer ${secret}`);
  const received = Buffer.from(request.headers.get('authorization') ?? '');
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  try {
    await dbConnect();
    await settleExpiredAuctions();
    return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Scheduled auction settlement failed.', error instanceof Error ? error.name : 'UnknownError');
    return Response.json({ error: 'Auction settlement did not complete.' }, { status: 500 });
  }
}
