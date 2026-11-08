import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// Exercise the production cache/lease algorithm with isolated persistence.
const state = globalThis.__rosterSnapshot = { mutationLoads: 0 };
const project = (document, fields) => {
  if (!document) return null;
  const value = structuredClone(document);
  return fields ? Object.fromEntries(fields.split(' ').map(field => [field, value[field]])) : value;
};
const matches = filter => state.cache && Object.entries(filter).every(([key, value]) => {
  const actual = state.cache[key];
  if (value?.$lte instanceof Date) return actual instanceof Date && actual <= value.$lte;
  return value instanceof Date ? actual instanceof Date && actual.getTime() === value.getTime() : actual === value;
});
state.query = (kind, filter, update) => {
  const call = { kind, filter, update };
  state.calls.push(call);
  return {
    select(fields) { call.fields = fields; return this; },
    async lean() {
      if (kind === 'read') {
        if (state.beforeRead) await state.beforeRead();
        return project(state.cache, call.fields);
      }
      if (update.$setOnInsert) {
        state.cache ??= structuredClone(update.$setOnInsert);
        return project(state.cache, call.fields);
      }
      if (state.denyLock || !matches(filter)) return null;
      Object.assign(state.cache, update.$set);
      return project(state.cache, call.fields);
    },
  };
};
state.update = async (filter, update) => {
  const matched = matches(filter);
  state.calls.push({ kind: 'update', filter, update, matched });
  if (!matched) return { matchedCount: 0, modifiedCount: 0 };
  Object.assign(state.cache, structuredClone(update.$set ?? {}));
  for (const field of Object.keys(update.$unset ?? {})) delete state.cache[field];
  for (const [field, value] of Object.entries(update.$inc ?? {})) state.cache[field] += value;
  return { matchedCount: 1, modifiedCount: 1 };
};
const mocks = {
  '@/lib/models/SheetRosterCache': `export default {
    findOne(filter){return globalThis.__rosterSnapshot.query('read',filter);},
    findOneAndUpdate(filter,update){return globalThis.__rosterSnapshot.query('acquire',filter,update);},
    updateOne(filter,update){return globalThis.__rosterSnapshot.update(filter,update);},
  };`,
  '@/lib/mongodb': `export default async function(){globalThis.__rosterSnapshot.connections++;}`,
  './googleSheets': `globalThis.__rosterSnapshot.mutationLoads++;
    export async function fetchSheetRoster(){globalThis.__rosterSnapshot.fetches++;return globalThis.__rosterSnapshot.fetch();}`,
};
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (mocks[specifier]) return { url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}`, shortCircuit: true };
  if (specifier.startsWith('@/')) return nextResolve(new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href, context);
  return nextResolve(specifier, context);
} });
const { getSheetRosterSnapshot, getSheetRoster, invalidateSheetRosterCache } = await import('../lib/sheetRosterSnapshot.ts');
const previousSheetId = process.env.GOOGLE_SHEET_ID;
const previousEnvironment = process.env.VERCEL_ENV;
after(() => {
  hooks.deregister();
  if (previousSheetId === undefined) delete process.env.GOOGLE_SHEET_ID;
  else process.env.GOOGLE_SHEET_ID = previousSheetId;
  if (previousEnvironment === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = previousEnvironment;
});
const toon = available => ({ rowIndex: 3, owner: 'Ada', account: 'Main', subClass: 'Tank',
  weeklyEarned: 1, weeklySpent: 0, earned: available, spent: 0, available });
beforeEach(() => {
  process.env.GOOGLE_SHEET_ID = 'sheet-id';
  delete process.env.VERCEL_ENV;
  state.cache = { cacheKey: 'sheet-id', roster: [toon(10)], fetchedAt: new Date(Date.now() - 5000),
    refreshLockUntil: new Date(0), generation: 0, weeklyActivityHistory: ['not part of display reads'] };
  state.calls = []; state.connections = 0; state.fetches = 0; state.beforeRead = null; state.denyLock = false;
  state.fetch = async () => [toon(20)];
});

test('fresh cached snapshots never import financial mutations or the Sheets SDK', async () => {
  assert.equal(state.mutationLoads, 0);
  const result = await getSheetRosterSnapshot();
  assert.equal(state.mutationLoads, 0);
  assert.equal(state.fetches, 0);
  assert.equal(result.cacheStatus, 'cache');
  assert.equal(result.roster[0].available, 10);
  assert.equal(result.roster[0].fiveWeekActivity, 0);
  assert.deepEqual(result.roster[0].dkpIssues, []);
  assert.deepEqual(state.calls.map(call => call.fields), ['roster fetchedAt lastRefreshError']);
});

test('a held refresh lease serves the stale display snapshot without loading mutations', async () => {
  state.cache.fetchedAt = new Date(0);
  state.denyLock = true;
  const result = await getSheetRosterSnapshot();
  assert.equal(result.cacheStatus, 'stale');
  assert.equal(result.roster[0].available, 10);
  assert.equal(state.fetches, 0);
  assert.equal(state.mutationLoads, 0);
});

test('stale refresh loads the Sheet fetch implementation only after acquiring the lease', async () => {
  state.cache.fetchedAt = new Date(0);
  const result = await getSheetRosterSnapshot();
  assert.equal(state.mutationLoads, 1);
  assert.equal(state.fetches, 1);
  assert.equal(result.roster[0].available, 20);
  assert.equal(result.cacheStatus, 'sheet');
  const acquire = state.calls.find(call => call.kind === 'acquire');
  assert.equal(acquire.fields, 'generation');
  const saved = state.calls.find(call => call.kind === 'update' && call.update.$set?.roster);
  assert.equal(saved.filter.generation, 0);
  assert.ok(saved.filter.refreshLockUntil instanceof Date);
  state.cache.fetchedAt = new Date(0);
  await getSheetRosterSnapshot();
  assert.equal(state.fetches, 2);
  assert.equal(state.mutationLoads, 1);
});

test('explicit fresh reads bypass a valid cached TTL and normal in-flight sharing', async () => {
  let resume;
  state.beforeRead = () => new Promise(resolve => { resume = resolve; });
  const ordinary = getSheetRosterSnapshot();
  const same = getSheetRosterSnapshot();
  assert.equal(ordinary, same);
  await Promise.resolve();
  const finishOrdinary = resume;
  state.beforeRead = null;
  const fresh = getSheetRosterSnapshot({ fresh: true });
  assert.notEqual(fresh, ordinary);
  assert.equal((await fresh).roster[0].available, 20);
  finishOrdinary();
  await ordinary;
  assert.equal(state.fetches, 1);
});

test('completed reads do not retain balances, and concurrent cache hits share one query', async () => {
  const first = getSheetRosterSnapshot();
  assert.equal(first, getSheetRosterSnapshot());
  await first;
  assert.equal(state.calls.length, 1);
  state.cache.roster = [toon(30)];
  assert.equal((await getSheetRoster())[0].available, 30);
  assert.equal(state.calls.length, 2);
});

test('failed display refresh preserves stale fallback but explicit fresh reads fail and can retry', async () => {
  state.cache.fetchedAt = new Date(0);
  state.fetch = async () => { throw new Error('Sheet offline'); };
  const stale = await getSheetRosterSnapshot();
  assert.equal(stale.stale, true);
  assert.equal(stale.refreshDelayed, true);
  assert.equal(stale.roster[0].available, 10);
  await assert.rejects(getSheetRosterSnapshot({ fresh: true }), /Sheet offline/);
  state.fetch = async () => [toon(25)];
  assert.equal((await getSheetRosterSnapshot()).roster[0].available, 25);
  assert.equal(state.cache.lastRefreshError, undefined);
  assert.equal(state.fetches, 3);
});

test('failure without a prior roster clears shared work so the next request retries', async () => {
  state.cache = null;
  state.fetch = async () => { throw new Error('Sheet unavailable'); };
  const first = getSheetRosterSnapshot();
  assert.equal(first, getSheetRosterSnapshot());
  await assert.rejects(first, /Sheet unavailable/);
  state.fetch = async () => [toon(40)];
  const retry = getSheetRosterSnapshot();
  assert.notEqual(retry, first);
  assert.equal((await retry).roster[0].available, 40);
});

test('cache generation fencing rejects data fetched before a concurrent mutation invalidation', async () => {
  state.cache.fetchedAt = new Date(0);
  state.fetch = async () => {
    if (state.fetches === 1) {
      await invalidateSheetRosterCache();
      return [toon(999)];
    }
    return [toon(50)];
  };
  const result = await getSheetRosterSnapshot();
  assert.equal(result.roster[0].available, 50);
  assert.equal(state.cache.roster[0].available, 50);
  assert.equal(state.fetches, 2);
  const saves = state.calls.filter(call => call.kind === 'update' && call.update.$set?.roster);
  assert.deepEqual(saves.map(call => [call.filter.generation, call.matched]), [[0, false], [1, true]]);
});

test('preview and missing-sheet guards reject before cache reads or Sheet refreshes', async () => {
  process.env.VERCEL_ENV = 'preview';
  await assert.rejects(getSheetRosterSnapshot(), /outside production/);
  delete process.env.VERCEL_ENV;
  delete process.env.GOOGLE_SHEET_ID;
  await assert.rejects(getSheetRosterSnapshot(), /GOOGLE_SHEET_ID/);
  assert.deepEqual(state.calls, []);
  assert.equal(state.fetches, 0);
});
