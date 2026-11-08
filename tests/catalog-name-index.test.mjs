import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import sharp from 'sharp';

const state = globalThis.__catalogNameIndex = {};
const listedIndex = { name: 'listed_item_name_unique', key: { name: 1 }, unique: true,
  collation: { locale: 'en', strength: 2 }, partialFilterExpression: { isListed: true } };
const mocks = {
  '@/lib/models/AuctionItem': `export default {get collection(){return globalThis.__catalogNameIndex.collection;},
    async create(rows){return rows.map(row=>globalThis.__catalogNameIndex.insert({...row,isListed:true}));},
    findOneAndUpdate(filter,update){return {then(resolve){const item=globalThis.__catalogNameIndex.items.find(x=>x._id===filter._id&&x.isListed!==false);if(item)Object.assign(item,update.$set);return Promise.resolve(item).then(resolve);}};}};`,
  '@/lib/models/User': `export default {findById(){return {select(){return this;},session(){return Promise.resolve({_id:'000000000000000000000001',nickname:'Chief',role:'chief',status:'approved'});}};}};`,
  '@/lib/models/Auction': 'export default {};',
  '@/lib/auth/session': `export async function getSessionUser(){return {_id:'000000000000000000000001',role:'chief'};}`,
  '@/lib/auth/rateLimit': 'export async function limitMemberRequests(){}',
  '@/lib/auth/administration': 'export async function withClanAdministrationTransaction(operation){return operation({});}',
};
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (mocks[specifier]) return { url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}`, shortCircuit: true };
  if (specifier.startsWith('@/')) return nextResolve(new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href, context);
  if (specifier === 'next/server') return nextResolve('next/server.js', context);
  return nextResolve(specifier, context);
} });
const { migrateCatalogNameIndex } = await import('../lib/catalogNameIndex.ts');
const catalog = await import('../app/api/auction/items/route.ts');
after(() => hooks.deregister());
beforeEach(() => {
  state.items = []; state.calls = []; state.failCreate = false; state.dropError = null;
  state.indexes = [{ name: '_id_', key: { _id: 1 }, unique: true }, { name: 'name_1', key: { name: 1 }, unique: true }];
  state.collection = {
    async indexes() { state.calls.push('indexes'); return state.indexes.slice(); },
    aggregate(_, options) {
      assert.deepEqual(options.collation, { locale: 'en', strength: 2 });
      state.calls.push('duplicates');
      const counts = new Map();
      for (const item of state.items.filter(item => item.isListed !== false)) {
        const key = item.name.toLowerCase(); counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return { toArray: async () => [...counts].filter(([,count]) => count > 1).map(([_id,count]) => ({_id,count})) };
    },
    async updateMany(filter, update) {
      assert.deepEqual(filter, { isListed: { $ne: false } }); state.calls.push('normalize');
      for (const item of state.items.filter(item => item.isListed !== false)) Object.assign(item, update.$set);
    },
    async createIndex(key, options) {
      state.calls.push('create');
      assert.deepEqual({ key, ...options }, listedIndex);
      if (state.failCreate) throw new Error('index creation failed');
      if (!state.indexes.some(index => index.name === options.name)) state.indexes.push({ key, ...options });
    },
    async dropIndex(name) {
      state.calls.push('drop:' + name);
      if (state.dropError) throw state.dropError;
      state.indexes = state.indexes.filter(index => index.name !== name);
    },
  };
  state.insert = item => {
    for (const index of state.indexes.filter(index => index.unique && index.key.name)) {
      const eligible = !index.partialFilterExpression || item.isListed === true;
      if (eligible && state.items.some(old => (!index.partialFilterExpression || old.isListed === true) &&
        (index.collation ? old.name.toLowerCase() === item.name.toLowerCase() : old.name === item.name))) {
        throw Object.assign(new Error('duplicate name'), { code: 11000 });
      }
    }
    const created = { _id: String(state.items.length + 1).padStart(24, '0'), ...item };
    state.items.push(created); return created;
  };
});

test('real catalog DELETE then POST reuses a name while keeping the archived record and rejecting a second listed duplicate', async () => {
  state.items = [{ _id: '000000000000000000000005', name: 'Ancient Ring', isListed: true }];
  const origin = 'https://centuri.test';
  const deleted = await catalog.DELETE(new Request(origin + '/api/auction/items', {
    method: 'DELETE', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ itemId: state.items[0]._id }),
  }));
  assert.equal(deleted.status, 200); assert.equal(state.items[0].isListed, false);
  const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#123456' } }).png().toBuffer();
  const post = async name => {
    const form = new FormData(); form.set('name', name); form.set('bossType', 'Bt'); form.set('requiredRoles', 'Everyone');
    form.append('images', new Blob([image], { type: 'image/png' }), 'ring.png');
    return catalog.POST(new Request(origin + '/api/auction/items', { method: 'POST', headers: { origin }, body: form }));
  };
  const readded = await post('Ancient Ring');
  assert.equal(readded.status, 200, await readded.text());
  assert.equal(state.items.length, 2); assert.equal(state.items[0].isListed, false);
  assert.equal(state.items[1].isListed, true);
  assert.equal((await post('ancient ring')).status, 409);
  assert.ok(state.calls.indexOf('create') < state.calls.indexOf('drop:name_1'));
});

test('migration normalizes legacy listed flags but preserves archived records and unrelated indexes', async () => {
  state.items = [{ name: 'Archived', isListed: false }, { name: 'Legacy' }];
  state.indexes.push({ name: 'createdBy_1', key: { createdBy: 1 }, unique: true });
  await migrateCatalogNameIndex(state.collection);
  assert.equal(state.items[0].isListed, false); assert.equal(state.items[1].isListed, true);
  assert.deepEqual(state.indexes.map(index => index.name), ['_id_', 'createdBy_1', 'listed_item_name_unique']);
});

test('existing active name conflicts stop migration before any write or index removal', async () => {
  state.items = [{ name: 'Ring' }, { name: 'ring', isListed: true }];
  await assert.rejects(migrateCatalogNameIndex(state.collection), /listed catalog names conflict/);
  assert.deepEqual(state.calls, ['indexes', 'duplicates']);
});

test('failure installing the replacement index leaves legacy uniqueness protection in place', async () => {
  state.failCreate = true;
  await assert.rejects(migrateCatalogNameIndex(state.collection), /index creation failed/);
  assert.ok(state.indexes.some(index => index.name === 'name_1'));
  assert.ok(!state.calls.includes('drop:name_1'));
});

test('already migrated catalogs skip scans and schema writes', async () => {
  state.indexes = [listedIndex];
  await migrateCatalogNameIndex(state.collection);
  assert.deepEqual(state.calls, ['indexes']);
});

test('concurrent migration can finish after another instance removes the old index', async () => {
  state.dropError = Object.assign(new Error('already removed'), { code: 27 });
  await migrateCatalogNameIndex(state.collection);
  assert.ok(state.calls.includes('drop:name_1'));
});

test('failed initialization retries and successful concurrent callers share one index check', async () => {
  const { ensureCatalogNameIndex } = await import('../lib/catalogNameIndex.ts?retry');
  state.failCreate = true;
  await assert.rejects(ensureCatalogNameIndex(), /index creation failed/);
  state.failCreate = false; state.calls = [];
  await Promise.all([ensureCatalogNameIndex(), ensureCatalogNameIndex()]);
  assert.equal(state.calls.filter(call => call === 'indexes').length, 1);
  await ensureCatalogNameIndex();
  assert.equal(state.calls.filter(call => call === 'indexes').length, 1);
});
