import { createHash } from 'node:crypto';
import AuthRateLimit from '@/lib/models/AuthRateLimit';
import { normalizeNickname } from './validation';
import { isIP } from 'node:net';
import { RequestValidationError } from '@/lib/security/request';
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

export async function limitMemberRequests(userId: string, action: 'auction-read' | 'auction-write' | 'catalog-write' | 'boss-write' | 'roster-read' | 'roster-write' | 'role-read' | 'role-write') {
  const limit = action.endsWith('-read') ? 120 : action === 'auction-write' ? 30 : 20;
  const retry = await consume(`member:${action}:${userId}`, limit, 60_000);
  if (retry) throw new RequestValidationError(`Too many requests. Try again in ${retry} seconds.`, 429);
}
export async function authRetryAfter(request: Request, nickname: string, action: 'signup' | 'signin') {
  const account = createHash('sha256').update(normalizeNickname(nickname)).digest('hex');
  // Vercel replaces this header. Other hosts must explicitly trust a proxy
  // that does the same; arbitrary client-provided IP headers are never used.
  const trusted = process.env.VERCEL === '1' || process.env.TRUST_PROXY === 'true';
  const ip = trusted ? request.headers.get('x-forwarded-for')?.split(',')[0].trim() : undefined;
  if (process.env.NODE_ENV === 'production' && (!ip || !isIP(ip))) {
    throw new RequestValidationError('Secure sign-in rate limiting is not configured for this host.', 503);
  }
  const source = createHash('sha256').update(ip && isIP(ip) ? ip : 'local-development').digest('hex');
  const sourceRetry = await consume(`auth:source:${action}:${source}`, action === 'signup' ? 8 : 120, 15 * 60_000);
  if (sourceRetry) return sourceRetry;
  // A hostile source cannot lock out an account signing in from another IP.
  return consume(`auth:source-account:${action}:${source}:${account}`, action === 'signup' ? 5 : 15, 15 * 60_000);
}
