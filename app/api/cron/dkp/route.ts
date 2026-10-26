import { timingSafeEqual } from 'node:crypto';
import { applyDueToonRoleChanges } from '@/lib/googleSheets';

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
    const roleChanges = await applyDueToonRoleChanges();
    return Response.json({ ok: true, roleChanges }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Scheduled roster maintenance failed.', error instanceof Error ? error.name : 'UnknownError');
    return Response.json({ error: 'Scheduled roster maintenance did not complete. Check server logs and roster values.' }, { status: 500 });
  }
}
