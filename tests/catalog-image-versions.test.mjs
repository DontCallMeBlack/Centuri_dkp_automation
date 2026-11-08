import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import sharp from 'sharp';

const state = globalThis.__catalogVersions = {};
const mocks = {
  'next/server': 'export const NextResponse = {json: (value, init) => Response.json(value, init)};',
  '@/lib/auth/session': 'export async function getSessionUser() { return {_id:"000000000000000000000009",role:"chief"}; }',
  '@/lib/models/AuctionItem': `export default {
    findById(){ return {session:async()=>globalThis.__catalogVersions.item}; },
    async create(items){globalThis.__catalogVersions.created.push(...items);return items.map(item=>({...item,_id:"000000000000000000000002"}));}
  };`,
  '@/lib/models/Auction': `export default {
    exists(){return {session:async()=>globalThis.__catalogVersions.hasAuctions};},
    async updateMany(filter,update,options){globalThis.__catalogVersions.remaps.push({filter,update,options});}
  };`,
  '@/lib/models/User': 'export default {findById(){return {select(){return {session:async()=>({nickname:"Chief",role:"chief",status:"approved"})};}};}};',
  '@/lib/auth/administration': 'export async function withClanAdministrationTransaction(operation){return operation({fixture:true});}',
  '@/lib/catalogNameIndex': 'export async function ensureCatalogNameIndex(){}',
  '@/lib/auth/rateLimit': 'export async function limitMemberRequests(){}',
};
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (mocks[specifier]) return { url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}`, shortCircuit: true };
  if (specifier.startsWith('@/')) return nextResolve(new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href, context);
  return nextResolve(specifier, context);
} });
const catalog = await import('../app/api/auction/items/route.ts');
hooks.deregister();

const id = '000000000000000000000001';
const originalVersion = '00000000-0000-4000-8000-000000000001';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#55aaff' } }).webp().toBuffer();
const mutation = (method, replaceImage = false) => {
  const form = new FormData();
  form.set('itemId', id); form.set('name', 'Updated name'); form.set('requiredRoles', 'Everyone'); form.set('bossType', 'Bt');
  if (replaceImage) form.append('images', new Blob([bytes], { type: 'image/webp' }), 'fixture.webp');
  return new Request('https://centuri.test/api/auction/items', {
    method, headers: { origin: 'https://centuri.test' }, body: form,
  });
};
beforeEach(() => {
  state.created = []; state.remaps = []; state.hasAuctions = false; state.saves = 0;
  state.item = {
    _id: id, name: 'Original name', requiredRoles: ['Tank'], bossType: 'Gele', imageCount: 1,
    imageVersion: originalVersion, images: [{ data: Buffer.from('original-image'), contentType: 'image/webp' }],
    createdBy: 'Original creator', createdAt: new Date('2026-01-01'),
    async save() { state.saves++; },
  };
});

test('new items return an immutable image revision for the optimistic catalog view', async () => {
  const response = await catalog.POST(mutation('POST', true));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.match(result.imageVersion, uuid);
  assert.equal(state.created[0].imageVersion, result.imageVersion);
  assert.equal(state.created[0].imageCount, 1);
});

test('metadata edits retain the existing image revision and do not copy images', async () => {
  const response = await catalog.PATCH(mutation('PATCH'));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).imageVersion, originalVersion);
  assert.equal(state.item.imageVersion, originalVersion);
  assert.equal(state.created.length, 0); assert.equal(state.saves, 1);
});

test('image replacement pins auction snapshots to the old revision and rotates the catalog URL', async () => {
  state.hasAuctions = true;
  const response = await catalog.PATCH(mutation('PATCH', true));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.match(result.imageVersion, uuid); assert.notEqual(result.imageVersion, originalVersion);
  assert.equal(state.item.imageVersion, result.imageVersion);
  assert.equal(state.created.length, 1);
  assert.equal(state.created[0].imageVersion, originalVersion);
  assert.equal(state.created[0].images[0].data.toString(), 'original-image');
  assert.equal(state.created[0].isListed, false);
  assert.deepEqual(state.remaps[0].filter, { itemId: id });
  assert.deepEqual(state.remaps[0].update, { $set: { itemId: '000000000000000000000002' } });
  assert.equal(state.saves, 1);
});

test('old documents retain their legacy snapshot revision when images are replaced', async () => {
  state.hasAuctions = true; delete state.item.imageVersion;
  const response = await catalog.PATCH(mutation('PATCH', true));
  assert.equal(response.status, 200);
  assert.equal(state.created[0].imageVersion, undefined);
  assert.match((await response.json()).imageVersion, uuid);
});
