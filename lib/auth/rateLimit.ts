import { createHash } from 'node:crypto';
import AuthRateLimit from '@/lib/models/AuthRateLimit';
import { normalizeNickname } from './validation';
async function consume(key: string, limit: number, windowMs: number): Promise<number> {
  const now = Date.now();
  const bucket = Math.floor(now / windowMs);
  const _id = `${key}:${bucket}`;
  const expiresAt = new Date((bucket + 1) * windowMs);
  const increment = () => AuthRateLimit.findOneAndUpdate({ _id }, { $inc: { count: 1 }, $setOnInsert: { expiresAt } }, { upsert: true, new: true }).lean();
  const record = await increment().catch((error: unknown) => {
    if (typeof error === 'object' && error && 'code' in error && error.code === 11000) return increment();
    throw error;
  });
  return record.count > limit ? Math.max(1, Math.ceil((expiresAt.getTime() - now) / 1000)) : 0;
}
export async function authRetryAfter(request: Request, nickname: string, action: 'signup' | 'signin') {
  const account = createHash('sha256').update(normalizeNickname(nickname)).digest('hex');
  const globalRetry = await consume(`auth:global:${action}`, action === 'signup' ? 30 : 120, 60_000);
  const accountRetry = await consume(`auth:account:${action}:${account}`, action === 'signup' ? 5 : 15, 15 * 60_000);
  // Enable proxy IP limits only behind a trusted proxy that replaces the header.
  const ip = process.env.TRUST_PROXY === 'true' ? request.headers.get('x-forwarded-for')?.split(',')[0].trim().slice(0, 64) : undefined;
  const ipRetry = ip ? await consume(`auth:ip:${action}:${createHash('sha256').update(ip).digest('hex')}`, action === 'signup' ? 8 : 60, 15 * 60_000) : 0;
  return Math.max(globalRetry, accountRetry, ipRetry);
}
