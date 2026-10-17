import { createHash, timingSafeEqual } from 'node:crypto';

/** Bootstrap must prove knowledge of a private deployment token. Public signup
 * alone can never grant the first administrative role. */
export function validBootstrapToken(provided: unknown, configured: string | undefined) {
  if (!configured || configured.length < 32 || typeof provided !== 'string' || provided.length > 256) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(provided), digest(configured));
}
