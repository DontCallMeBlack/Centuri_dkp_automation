import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const state = globalThis.__auctionPushAuth = {};
const key = process.env.ABLY_API_KEY;
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  const mocks = {
    '@/lib/auth/session': 'export async function getSessionUser(){return globalThis.__auctionPushAuth.user;}',
    '@/lib/auth/rateLimit': 'export async function limitMemberRequests(){globalThis.__auctionPushAuth.limits++;}',
  };
  if (mocks[specifier]) return { url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}`, shortCircuit: true };
  if (specifier.startsWith('@/')) return nextResolve(new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href, context);
  return nextResolve(specifier, context);
} });
const { POST } = await import('../app/api/auction/realtime/route.ts');
after(() => {
  hooks.deregister();
  if (key === undefined) delete process.env.ABLY_API_KEY; else process.env.ABLY_API_KEY = key;
  delete globalThis.__auctionPushAuth;
});
beforeEach(() => { state.user = { _id: 'approved-user' }; state.limits = 0; process.env.ABLY_API_KEY = 'app.key:private-secret'; });
const request = (origin = new URL(process.env.APP_ORIGIN || 'https://centuri.test').origin) => new Request(
  new URL(process.env.APP_ORIGIN || 'https://centuri.test').origin + '/api/auction/realtime', { method: 'POST', headers: { origin } });

test('cross-origin websites cannot mint a subscription', async () => {
  assert.equal((await POST(request('https://hostile.test'))).status, 403);
  assert.equal(state.limits, 0);
});
test('an expired or revoked session cannot obtain or renew a subscription', async () => {
  state.user = null;
  const response = await POST(request());
  assert.equal(response.status, 401);
  assert.equal((await response.text()).includes('token'), false);
});
test('approved sessions receive an uncached subscribe-only token with rate limiting', async () => {
  const response = await POST(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(state.limits, 1);
  const body = await response.json();
  const claims = JSON.parse(Buffer.from(body.token.split('.')[1], 'base64url'));
  assert.deepEqual(JSON.parse(claims['x-ably-capability']), { 'centuri:auction-changes': ['subscribe'] });
  assert.match(claims['x-ably-clientId'], /^member-[a-f0-9]{32}$/);
});
