import { timingSafeEqual } from 'node:crypto';
import { ensureWeeklyDkpReset } from '@/lib/googleSheets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return Response.json({ error: 'Cron authentication is not configured.' }, { status: 503 });
  }
  const expected = Buffer.from(`Bearer ${secret}`);
  const provided = Buffer.from(request.headers.get('authorization') ?? '');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  }
  try {
    await ensureWeeklyDkpReset();
    return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Scheduled DKP rollover failed.', error instanceof Error ? error.name : 'UnknownError');
    return Response.json({ error: 'DKP rollover did not complete. Check server logs and roster values.' }, { status: 500 });
  }
}
