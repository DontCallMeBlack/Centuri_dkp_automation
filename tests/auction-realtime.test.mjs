import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { auctionRealtimeEnabled, createAuctionSubscription, publishAuctionChanges, AUCTION_CHANNEL, AUCTION_TOKEN_TTL_MS } from '../lib/auctionRealtime.ts';

const originalKey = process.env.ABLY_API_KEY;
const originalFetch = globalThis.fetch;
afterEach(() => {
  if (originalKey === undefined) delete process.env.ABLY_API_KEY;
  else process.env.ABLY_API_KEY = originalKey;
  globalThis.fetch = originalFetch;
});

test('an unconfigured integration neither issues tokens nor contacts the broker', async () => {
  delete process.env.ABLY_API_KEY;
  globalThis.fetch = () => { throw new Error('Must not contact broker'); };
  assert.equal(auctionRealtimeEnabled(), false);
  assert.equal(createAuctionSubscription('user-1'), null);
  await publishAuctionChanges(['a'.repeat(24)]);
  process.env.ABLY_API_KEY = 'malformed';
  assert.equal(auctionRealtimeEnabled(), false);
});

test('subscription JWT is signed correctly and grants only short-lived channel subscription', () => {
  process.env.ABLY_API_KEY = 'app.key:private-secret';
  const now = Date.parse('2026-11-08T20:00:00Z');
  const subscription = createAuctionSubscription('user-1', now);
  const [header, body, signature] = subscription.token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { typ: 'JWT', alg: 'HS256', kid: 'app.key' });
  const claims = JSON.parse(Buffer.from(body, 'base64url'));
  assert.deepEqual(JSON.parse(claims['x-ably-capability']), { [AUCTION_CHANNEL]: ['subscribe'] });
  assert.equal(claims.exp - claims.iat, AUCTION_TOKEN_TTL_MS / 1000);
  assert.equal(subscription.expiresAt, now + AUCTION_TOKEN_TTL_MS);
  assert.equal(signature, createHmac('sha256', 'private-secret').update(`${header}.${body}`).digest('base64url'));
  assert.equal(JSON.stringify(subscription).includes('private-secret'), false);
  assert.match(claims['x-ably-clientId'], /^member-[a-f0-9]{32}$/);
  assert.equal(JSON.stringify(claims).includes('user-1'), false);
  const decode = (user) => JSON.parse(Buffer.from(createAuctionSubscription(user, now).token.split('.')[1], 'base64url'))['x-ably-clientId'];
  assert.equal(decode('user-1'), claims['x-ably-clientId']);
  assert.notEqual(decode('user-2'), claims['x-ably-clientId']);
});

test('publishing sends bounded IDs without account details and tolerates provider failure', async () => {
  process.env.ABLY_API_KEY = 'app.key:private-secret';
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, 'https://rest.ably.io/channels/centuri%3Aauction-changes/messages');
    const message = JSON.parse(options.body);
    assert.deepEqual(message, { name: 'changed', clientId: 'centuri-auction-server', data: JSON.stringify({ auctionIds: ['a'.repeat(24)] }) });
    assert.equal(Buffer.from(options.headers['X-Ably-ClientId'], 'base64').toString(), 'centuri-auction-server');
    assert.equal(options.method, 'POST');
    assert.ok(options.signal);
    return new Response(null, { status: 503 });
  };
  await publishAuctionChanges(['a'.repeat(24), 'a'.repeat(24), 'not-an-id']);
  globalThis.fetch = async () => { throw new Error('secret in provider exception'); };
  await assert.doesNotReject(publishAuctionChanges());
  assert.equal(calls, 1);
});
