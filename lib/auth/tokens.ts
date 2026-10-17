import { createHash, randomBytes } from 'node:crypto';
export const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
// The browser enforces Secure, Path=/ and no Domain for a __Host- cookie,
// preventing a sibling subdomain from injecting an authenticated session.
export function sessionCookieOptions(production: boolean) {
  return { name: production ? '__Host-centuri-session' : 'centuri-session',
    httpOnly: true, secure: production, sameSite: 'strict' as const, path: '/' };
}
export function newSessionToken() { return randomBytes(32).toString('base64url'); }
export function hashSessionToken(token: string) { return createHash('sha256').update(token).digest('hex'); }
