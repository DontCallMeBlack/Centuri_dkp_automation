import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createSheetRecordLinkResolver, getLinkedSheetRecordRows } from '../lib/sheetRecordLinks.ts';

// Exercise the real read handler and identity resolver without a live database.
const state = globalThis.__adminToonReads = {};
state.createResolver = (roster) => {
  const resolve = createSheetRecordLinkResolver(roster);
  return (user) => { state.linkReads++; return resolve(user); };
};
state.query = (kind, filter) => {
  state.queries.push({ kind, filter });
  return {
    select() { return this; },
    async lean() {
      return kind === 'users'
        ? state.users.filter(user => user.status === filter.status)
        : state.pending;
    },
  };
};
const unused = names => names.map(name => `export function ${name}(){throw Error('Unexpected mutation: ${name}');}`).join('\n');
const mocks = {
  '@/lib/auth/session': `export async function getSessionUser(){return globalThis.__adminToonReads.actor;}
    export function canManageClan(role){return role==='chief'||role==='general';}`,
  '@/lib/auth/rateLimit': `export async function limitMemberRequests(...args){globalThis.__adminToonReads.limits.push(args);}`,
  '@/lib/sheetRosterSnapshot': `export async function getSheetRoster(){globalThis.__adminToonReads.rosterReads++;return globalThis.__adminToonReads.roster;}`,
  '@/lib/googleSheets': unused(['changeClanToon', 'ensureWeeklyDkpReset', 'resetToonDkp']),
  '@/lib/sheetRecordLinks': `export const createSheetRecordLinkResolver=(roster)=>globalThis.__adminToonReads.createResolver(roster);`,
  '@/lib/models/User': `export default {find(filter){return globalThis.__adminToonReads.query('users',filter);}};`,
  '@/lib/models/RosterMutation': `export default {findOne(filter){return globalThis.__adminToonReads.query('pending',filter);}};`,
  '@/lib/models/ClanAuditEvent': 'export default {};',
  '@/lib/dkpWeeklyEarned': unused(['getRosterWithWeeklyEarned']),
  '@/lib/auctionBidWithdrawal': unused(['withdrawToonOpenAuctionBids']),
};
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'next/server') return nextResolve('next/server.js', context);
  if (mocks[specifier]) return { url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}`, shortCircuit: true };
  if (specifier.startsWith('@/')) return nextResolve(new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href, context);
  return nextResolve(specifier, context);
} });
const { GET } = await import('../app/api/admin/toons/route.ts');
hooks.deregister();

beforeEach(() => {
  state.actor = { _id: 'manager-id', role: 'chief' };
  state.roster = [];
  state.users = [];
  state.pending = null;
  state.linkReads = 0;
  state.rosterReads = 0;
  state.queries = [];
  state.limits = [];
});
const user = (nickname, links) => ({ nickname, status: 'approved', ...links });
const read = async () => {
  const response = await GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  return response.json();
};
const originalToons = () => state.roster.map(toon => ({
  ...toon,
  linkedAccounts: state.users.filter(account => account.status === 'approved' &&
    getLinkedSheetRecordRows(account, state.roster).includes(toon.rowIndex)).map(account => account.nickname),
}));

test('toon reads preserve normal, legacy, stale-row and duplicate-identity links and account order', async () => {
  state.roster = [
    { rowIndex: 9, owner: 'Ada', account: 'Main', available: 42 },
    { rowIndex: 3, owner: 'Bea', account: 'New' },
    { rowIndex: 12, owner: 'Cal', account: 'Main' },
    { rowIndex: 4, owner: 'Ada', account: 'Alt' },
    { rowIndex: 11, owner: 'CAL', account: ' main ' },
    { rowIndex: 6, owner: 'Dee', account: '' },
    { rowIndex: 7, owner: 'Unlinked', account: 'Main' },
  ];
  state.users = [
    user('Zed explicit', { sheetRecords: [{ rowIndex: 9, owner: ' ADA ', account: 'main' }] }),
    user('Able stale', { sheetRecords: [{ rowIndex: 3, owner: 'Ada', account: 'Main' }] }),
    user('Legacy owner', { sheetRecordName: ' ADA ' }),
    user('Identity only', { sheetRecords: [{ owner: 'Cal', account: 'Main' }] }),
    user('Specific duplicate', { sheetRecords: [{ rowIndex: 12, owner: 'cal', account: 'MAIN' }] }),
    user('Stale duplicate', { sheetRecords: [{ rowIndex: 999, owner: 'Cal', account: 'Main' }] }),
    user('Empty links legacy', { sheetRecords: [], sheetRecordName: 'Dee' }),
    user('Repeated link', { sheetRecords: [{ rowIndex: 9, owner: 'Ada', account: 'Main' }, { rowIndex: 9, owner: 'Ada', account: 'Main' }] }),
    user('Missing identity', { sheetRecords: [{ rowIndex: 3, owner: 'Missing', account: 'Gone' }] }),
    { ...user('Pending account', { sheetRecordName: 'Ada' }), status: 'pending' },
  ];
  const original = structuredClone({ roster: state.roster, users: state.users });
  const result = await read();
  assert.deepEqual(result, { toons: originalToons(), pending: null });
  assert.deepEqual(result.toons[0].linkedAccounts, ['Zed explicit', 'Able stale', 'Legacy owner', 'Repeated link']);
  assert.deepEqual(result.toons[1].linkedAccounts, []);
  assert.deepEqual(result.toons[2].linkedAccounts, ['Identity only', 'Specific duplicate', 'Stale duplicate']);
  assert.deepEqual(result.toons[4].linkedAccounts, ['Identity only', 'Stale duplicate']);
  assert.equal(state.linkReads, 9, 'resolve links once per approved account, independent of roster size');
  assert.deepEqual({ roster: state.roster, users: state.users }, original);
  assert.deepEqual(state.limits, [['manager-id', 'roster-read']]);
});

test('empty roster preserves pending-operation response without resolving account links', async () => {
  state.users = [user('Legacy', { sheetRecordName: 'Ada' })];
  state.pending = { action: 'remove', owner: 'Ada', account: 'Main', rowIndex: 9, privateField: 'not returned' };
  assert.deepEqual(await read(), { toons: [], pending: { action: 'remove', owner: 'Ada', account: 'Main' } });
  assert.equal(state.linkReads, 0);
});

test('each request resolves current links and retains duplicate account names', async () => {
  state.roster = [{ rowIndex: 3, owner: 'Ada', account: 'Main' }, { rowIndex: 4, owner: 'Ada', account: 'Alt' }];
  state.users = [user('Same nickname', { sheetRecordName: 'Ada' }), user('Same nickname', { sheetRecordName: 'Ada' })];
  assert.deepEqual((await read()).toons[0].linkedAccounts, ['Same nickname', 'Same nickname']);
  state.users[0] = user('Updated', { sheetRecords: [{ rowIndex: 4, owner: 'Ada', account: 'Alt' }] });
  const result = await read();
  assert.deepEqual(result.toons, originalToons());
  assert.deepEqual(result.toons[0].linkedAccounts, ['Same nickname']);
  assert.deepEqual(result.toons[1].linkedAccounts, ['Updated', 'Same nickname']);
  assert.equal(state.linkReads, 4);
});

test('unauthenticated and non-manager reads still stop before roster or account reads', async () => {
  for (const [actor, status] of [[null, 401], [{ _id: 'member-id', role: 'guardian' }, 403]]) {
    state.actor = actor;
    assert.equal((await GET()).status, status);
  }
  assert.equal(state.rosterReads, 0);
  assert.equal(state.linkReads, 0);
  assert.deepEqual(state.queries, []);
  assert.deepEqual(state.limits, []);
});
