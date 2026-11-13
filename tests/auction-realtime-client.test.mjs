import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { subscribeAuctionChanges } from '../lib/client/auctionRealtime.ts';

const originals = Object.fromEntries(['document', 'window', 'navigator', 'EventSource', 'fetch'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
let cleanup;
afterEach(() => {
  cleanup?.(); cleanup = undefined;
  for (const [key, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});
const drain = () => new Promise((resolve) => setImmediate(resolve));
function fixture(t, status = 200) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 });
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const window = new EventTarget();
  const navigator = { onLine: true };
  const sources = [], states = [], updates = [];
  let requests = 0;
  class Source {
    closed = false;
    constructor(url) { this.url = new URL(url); sources.push(this); }
    close() { this.closed = true; }
    open() { this.onopen?.(); }
    message(ids) { this.onmessage?.({ data: JSON.stringify({ auctionIds: ids }) }); }
    fail() { this.onerror?.(); }
  }
  for (const [key, value] of Object.entries({ document, window, navigator, EventSource: Source })) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  globalThis.fetch = async (url, options) => {
    requests++;
    assert.equal(url, '/api/auction/realtime');
    assert.equal(options.method, 'POST');
    assert.equal(options.cache, 'no-store');
    return Response.json({ token: 'short-lived-token', channel: 'centuri:auction-changes', expiresAt: Date.now() + 900_000 }, { status });
  };
  cleanup = subscribeAuctionChanges((ids) => updates.push(ids), (value) => states.push(value));
  return { document, window, navigator, sources, states, updates, requests: () => requests };
}

test('connection reconciles missed changes, batches bursts, and does not poll or mint tokens per bid', async (t) => {
  const f = fixture(t); await drain();
  assert.equal(f.sources.length, 1);
  const source = f.sources[0];
  assert.equal(source.url.origin, 'https://main.realtime.ably.net');
  assert.equal(source.url.searchParams.get('accessToken'), 'short-lived-token');
  assert.equal(source.url.searchParams.has('key'), false);
  source.open(); t.mock.timers.tick(250);
  assert.deepEqual(f.updates, [null]);
  for (let n = 0; n < 100; n++) source.message(['a'.repeat(24), 'b'.repeat(24)]);
  t.mock.timers.tick(4999); assert.equal(f.updates.length, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(f.updates[1], ['a'.repeat(24), 'b'.repeat(24)]);
  assert.equal(f.requests(), 1);
  source.message(['invalid']); t.mock.timers.tick(10_000);
  assert.equal(f.updates.length, 2);
});

test('disconnect falls back immediately and reconnect always reconciles instead of trusting replay', async (t) => {
  const f = fixture(t); await drain();
  f.sources[0].open(); t.mock.timers.tick(250);
  f.sources[0].fail();
  assert.equal(f.states.at(-1), false);
  assert.equal(f.sources[0].closed, true);
  t.mock.timers.tick(15_000); await drain();
  assert.equal(f.sources.length, 2);
  f.sources[1].open(); t.mock.timers.tick(250);
  assert.deepEqual(f.updates, [null, null]);
});

test('hidden/offline tabs close the stream; logout prevents reconnection and late events', async (t) => {
  const f = fixture(t); await drain();
  f.sources[0].open();
  f.document.visibilityState = 'hidden'; f.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.sources[0].closed, true);
  t.mock.timers.tick(60_000); assert.equal(f.sources.length, 1);
  f.document.visibilityState = 'visible'; f.document.dispatchEvent(new Event('visibilitychange')); await drain();
  assert.equal(f.sources.length, 2);
  assert.equal(f.requests(), 1, 'reuse a still-valid subscribe-only token on tab return');
  f.navigator.onLine = false; f.window.dispatchEvent(new Event('offline'));
  assert.equal(f.sources[1].closed, true);
  f.window.dispatchEvent(new Event('centuri:clear-data'));
  f.navigator.onLine = true; f.window.dispatchEvent(new Event('online'));
  f.sources[1].message(['a'.repeat(24)]);
  t.mock.timers.tick(900_000); await drain();
  assert.equal(f.sources.length, 2);
  assert.equal(f.updates.length, 0);
});

test('authorization failure stops retries and never opens an external connection', async (t) => {
  const f = fixture(t, 401); await drain();
  t.mock.timers.tick(900_000); await drain();
  assert.equal(f.sources.length, 0);
  assert.equal(f.requests(), 1);
});

test('token renewal reauthenticates before expiry and replaces the old stream', async (t) => {
  const f = fixture(t); await drain();
  f.sources[0].open();
  t.mock.timers.tick(870_000); await drain();
  assert.equal(f.sources[0].closed, true);
  assert.equal(f.requests(), 2);
  assert.equal(f.sources.length, 2);
});
