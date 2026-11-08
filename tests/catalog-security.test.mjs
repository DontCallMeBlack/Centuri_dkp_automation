import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';
import mongoose from 'mongoose';
import { optimizeAuctionImage, AuctionImageError } from '../lib/auctionImage.ts';

// Exercise the real route handlers and validators with isolated session/database
// boundaries. These tests never connect to MongoDB or change live inventory.
const state = globalThis.__catalogSecurityFixture = {};
const mocks = {
  '@/lib/auth/session': 'export async function getSessionUser() { globalThis.__catalogSecurityFixture.sessionReads++; return globalThis.__catalogSecurityFixture.user; }',
  '@/lib/models/AuctionItem': 'export default { find(...args) { return globalThis.__catalogSecurityFixture.find(...args); }, findById(...args) { return globalThis.__catalogSecurityFixture.findById(...args); } };',
  '@/lib/models/Auction': 'export default {};',
  '@/lib/models/User': 'export default {};',
  '@/lib/auth/administration': 'export async function withClanAdministrationTransaction() { throw new Error("Unexpected write"); }',
  '@/lib/auth/rateLimit': 'export async function limitMemberRequests() { globalThis.__catalogSecurityFixture.rateLimits++; }',
};
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (mocks[specifier]) return { url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}`, shortCircuit: true };
  if (specifier.startsWith('@/')) return nextResolve(new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href, context);
  if (specifier === 'next/server') return nextResolve('next/server.js', context);
  return nextResolve(specifier, context);
} });
const catalog = await import('../app/api/auction/items/route.ts');
const images = await import('../app/api/auction/image/route.ts');
hooks.deregister();

const origin = 'https://centuri.example';
const id = '000000000000000000000001';
const request = (path = `/api/auction/image?id=${id}`, headers = {}) => new Request(origin + path, { headers });
const mutation = (method, body, suppliedOrigin = origin) => new Request(origin + '/api/auction/items', {
  method, headers: { origin: suppliedOrigin, ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }) }, body,
});
const upload = (count = 1, type = 'image/svg+xml', bytes = '<svg onload="alert(1)"/>') => {
  const form = new FormData();
  form.set('name', 'Test item'); form.set('bossType', 'Bt'); form.set('requiredRoles', 'Everyone'); form.set('itemId', id);
  for (let index = 0; index < count; index++) form.append('images', new Blob([bytes], { type }), 'attack.png');
  return form;
};
beforeEach(() => {
  state.user = { _id: id, role: 'chief' }; state.rateLimits = 0; state.sessionReads = 0;
  state.find = state.findById = () => { throw new Error('Unexpected database read'); };
});

test('catalog and image handlers require authentication before touching item storage', async () => {
  state.user = null;
  assert.equal((await catalog.GET()).status, 401);
  assert.equal((await images.GET(request())).status, 401);
  for (const method of ['POST', 'PATCH', 'DELETE']) assert.equal((await catalog[method](mutation(method, '{}'))).status, 401);
});

test('members and unknown roles cannot read or mutate the manager catalog', async () => {
  for (const role of ['clansman', 'unknown']) {
    state.user.role = role;
    assert.equal((await catalog.GET()).status, 403);
    for (const method of ['POST', 'PATCH', 'DELETE']) assert.equal((await catalog[method](mutation(method, '{}'))).status, 403);
  }
  assert.equal(state.rateLimits, 0);
});

test('all catalog writes reject cross-site requests before decoding uploads', async () => {
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    for (const suppliedOrigin of ['https://attacker.example', 'null', origin + '.attacker.example']) {
      assert.equal((await catalog[method](mutation(method, '{}', suppliedOrigin))).status, 403);
    }
  }
});

test('1000-item response projects metadata and never serializes image bytes or internal fields', async (t) => {
  const storedImage = Buffer.alloc(150 * 1024);
  const items = Array.from({ length: 1000 }, (_, index) => ({
    _id: String(index).padStart(24, '0'), name: `Item ${String(index).padStart(4, '0')}`,
    requiredRoles: ['Everyone'], bossType: 'Bt', imageCount: 8,
    images: [{ data: storedImage }], createdBy: 'PRIVATE_CREATOR',
  }));
  state.find = (filter) => {
    assert.deepEqual(filter, { isListed: { $ne: false } });
    return { select(fields) {
      assert.equal(fields, 'name requiredRoles requiredRole bossType imageCount imageVersion');
      return { sort(order) { assert.deepEqual(order, { name: 1 }); return { lean: async () => items }; } };
    } };
  };
  const start = performance.now();
  const response = await catalog.GET(); const body = await response.text();
  assert.equal(response.status, 200); assert.equal(JSON.parse(body).items.length, 1000);
  assert.ok(Buffer.byteLength(body) < 250_000);
  assert.ok(!body.includes('PRIVATE_CREATOR') && !body.includes('"data"') && !body.includes('"images"'));
  t.diagnostic(`1000-item fixture: ${Buffer.byteLength(body)} bytes; handler/serialization ${(performance.now() - start).toFixed(1)} ms (database mocked).`);
});

test('all three manager roles can read the catalog', async () => {
  state.find = () => ({ select: () => ({ sort: () => ({ lean: async () => [] }) }) });
  for (const role of ['chief', 'general', 'guardian']) {
    state.user.role = role;
    assert.equal((await catalog.GET()).status, 200);
  }
});

test('compressed images exceeding the pixel budget are rejected by the decoder', async () => {
  const compressed = await sharp({ create: { width: 6400, height: 6400, channels: 3, background: '#000000' } }).png().toBuffer();
  assert.ok(compressed.length < 1024 * 1024, 'Pixel bomb fits inside the upload byte budget');
  await assert.rejects(optimizeAuctionImage(compressed), AuctionImageError);
});

test('image handler rejects query injection, malformed IDs, and invalid array indexes', async () => {
  for (const value of ['{"$ne":null}', '../secret', 'x'.repeat(1000)]) {
    assert.equal((await images.GET(request('/api/auction/image?id=' + encodeURIComponent(value)))).status, 400);
  }
  for (const index of ['-1', '8', '999999', '0.5', '1e0', '01', 'NaN', 'Infinity', '']) {
    assert.equal((await images.GET(request(`/api/auction/image?id=${id}&index=${index}`))).status, 400);
  }
});

test('image reads are sliced, private, non-sniffable and conditionally cached after authentication', async () => {
  const bytes = Buffer.from('fixture-image'); let reads = 0;
  state.findById = (itemId) => {
    reads++; assert.equal(itemId, id);
    return { select(projection) {
      assert.deepEqual(projection, { images: { $slice: [7, 1] }, image: 1, imageType: 1, imageVersion: 1 });
      return { lean: async () => ({ images: [{ data: bytes, contentType: 'image/webp' }] }) };
    } };
  };
  const path = `/api/auction/image?id=${id}&index=7`;
  const response = await images.GET(request(path));
  assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal(response.headers.get('cache-control'), 'private, max-age=60, must-revalidate');
  assert.equal(response.headers.get('vary'), 'Cookie');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('content-security-policy'), /sandbox/);
  const headers = { 'if-none-match': response.headers.get('etag') };
  const cached = await images.GET(request(path, headers));
  assert.equal(cached.status, 304); assert.equal(await cached.text(), '');
  state.user = null;
  assert.equal((await images.GET(request(path, headers))).status, 401);
  assert.equal(reads, 2);
});

test('missing items and missing image slots return 404', async () => {
  state.findById = () => ({ select: () => ({ lean: async () => null }) });
  assert.equal((await images.GET(request())).status, 404);
  state.findById = () => ({ select: () => ({ lean: async () => ({ images: [] }) }) });
  assert.equal((await images.GET(request())).status, 404);
});

test('lean BSON images preserve bytes, legacy slot rules, and changed-image revalidation', async () => {
  const first = new mongoose.mongo.Binary();
  for (const byte of Buffer.from('first-image')) first.put(byte);
  assert.ok(first.buffer.byteLength > first.position, 'Exercise spare BSON buffer capacity');
  let item = { images: [{ data: first, contentType: 'image/webp' }] };
  state.findById = () => ({ select: () => ({ lean: async () => item }) });
  const response = await images.GET(request());
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), 'first-image');
  assert.equal(response.headers.get('content-length'), '11');
  const etag = response.headers.get('etag');
  item = { images: [], image: new mongoose.mongo.Binary(Buffer.from('legacy-image')), imageType: 'image/png' };
  const updated = await images.GET(request(undefined, { 'if-none-match': etag }));
  assert.equal(updated.status, 200);
  assert.notEqual(updated.headers.get('etag'), etag);
  assert.equal(updated.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await updated.arrayBuffer()).toString(), 'legacy-image');
  assert.equal((await images.GET(request(`/api/auction/image?id=${id}&index=1`))).status, 404);
});

test('immutable version reads reuse bytes and ETags only after a fresh session check', async () => {
  const imageVersion = '00000000-0000-4000-8000-000000000001';
  const path = `/api/auction/image?id=${id}&index=0&version=${imageVersion}`;
  let reads = 0;
  state.findById = () => { reads++; return { select: () => ({ lean: async () => ({
    imageVersion, images: [{ data: Buffer.from('version-one'), contentType: 'image/webp' }],
  }) }) }; };
  const first = await images.GET(request(path));
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.equal(first.headers.get('vary'), 'Cookie');
  assert.equal(await first.text(), 'version-one');
  const headers = { 'if-none-match': first.headers.get('etag') };
  state.findById = () => { throw new Error('Warm immutable images should not read storage'); };
  const unchanged = await images.GET(request(path, headers));
  assert.equal(unchanged.status, 304); assert.equal(await unchanged.text(), '');
  assert.equal(await (await images.GET(request(path))).text(), 'version-one');
  state.user = null;
  assert.equal((await images.GET(request(path, headers))).status, 401);
  assert.equal(reads, 1);
  assert.equal(state.sessionReads, 4, 'Authorization must run even on warm/conditional requests');
});

test('a stale uncached version never receives replacement bytes or a long-lived error', async () => {
  const oldVersion = '00000000-0000-4000-8000-000000000002';
  const imageVersion = '00000000-0000-4000-8000-000000000003';
  state.findById = () => ({ select: () => ({ lean: async () => ({
    imageVersion, images: [{ data: Buffer.from('replacement'), contentType: 'image/webp' }],
  }) }) });
  const response = await images.GET(request(`/api/auction/image?id=${id}&version=${oldVersion}`));
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.ok(!(await response.text()).includes('replacement'));
  const current = await images.GET(request(`/api/auction/image?id=${id}&version=${imageVersion}`));
  assert.equal(current.status, 200); assert.equal(await current.text(), 'replacement');
});

test('existing image sets have a stable legacy revision and version syntax is bounded', async () => {
  state.findById = () => ({ select: () => ({ lean: async () => ({
    images: [{ data: Buffer.from('existing'), contentType: 'image/webp' }],
  }) }) });
  const existing = await images.GET(request(`/api/auction/image?id=${id}&index=6&version=legacy`));
  assert.equal(existing.status, 200);
  assert.equal(existing.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  for (const version of ['', 'x'.repeat(1000), '../secret', '0', '{"$ne":null}']) {
    assert.equal((await images.GET(request(`/api/auction/image?id=${id}&version=${encodeURIComponent(version)}`))).status, 400);
  }
});

test('create and edit reject executable images, MIME spoofing, corrupt rasters and too many files', async () => {
  for (const method of ['POST', 'PATCH']) {
    for (const form of [upload(), upload(1, 'image/png'), upload(9), upload(1, 'image/png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))]) {
      assert.equal((await catalog[method](mutation(method, form))).status, 400);
    }
  }
  assert.equal(state.rateLimits, 8);
});

test('catalog uploads and deletes enforce payload size and scalar item IDs', async () => {
  for (const method of ['POST', 'PATCH']) {
    assert.equal((await catalog[method](mutation(method, upload(1, 'image/png', 'x'.repeat(2300000))))).status, 413);
  }
  for (const itemId of [{ $ne: null }, ['000000000000000000000001'], 'bad-id']) {
    assert.equal((await catalog.DELETE(mutation('DELETE', JSON.stringify({ itemId })))).status, 400);
  }
});
