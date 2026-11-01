import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import mongoose from 'mongoose';

// Exercise the real transfer/undo HTTP handlers with isolated storage adapters.
const state = globalThis.__transferOwnerRoute = {};
const id = value => new mongoose.Types.ObjectId(value.padStart(24, '0'));
const ids = { manager: id('1'), source: id('2'), destination: id('3') };
function matches(document, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (value?.$nin) return !value.$nin.some(entry => String(entry) === String(document[key]));
    if (value?.$in) return value.$in.some(entry => String(entry) === String(document[key]));
    return String(document[key]) === String(value);
  });
}
function chain(value) {
  return { session() { return this; }, select() { return this; }, sort() { return this; }, limit() { return this; },
    collation() { return this; }, lean() { return Promise.resolve(value); }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } };
}
state.model = name => {
  const collection = () => state[name] ?? [];
  return {
    findById(value) { return chain(collection().find(document => String(document._id) === String(value)) ?? null); },
    findOne(filter) { return chain(collection().find(document => matches(document, filter)) ?? null); },
    find(filter = {}) { return chain(collection().filter(document => filter.$or || matches(document, filter))); },
    exists(filter) { return chain(collection().find(document => matches(document, filter)) ?? null); },
    async create(documents) {
      for (const document of documents) collection().push({ ...document, _id: id(String(collection().length + 10)), createdAt: new Date(), async save() {} });
    },
    async updateOne(filter, update) {
      let document = collection().find(entry => matches(entry, filter));
      if (!document) { document = { ...filter }; collection().push(document); }
      Object.assign(document, update.$set);
    },
    async updateMany(filter, update) {
      for (const document of collection().filter(entry => matches(entry, filter))) Object.assign(document, update.$set);
    },
    deleteOne(filter) {
      state[name] = collection().filter(document => !matches(document, filter));
      return chain({ deletedCount: 1 });
    },
  };
};
state.reset = async options => {
  if (state.completed.has(options.requestId)) return { replayed: true, rowIndex: 3 };
  const record = state.roster.find(entry => entry.owner === options.identity.owner && entry.account === options.identity.account);
  assert.ok(record, 'transfer resolves the old Sheet identity');
  await options.beforeMutation?.(state.session, record, state.manager, state.roster);
  if (state.failBeforeCommit) { state.failBeforeCommit = false; throw new Error('simulated interruption before commit'); }
  const result = await options.mutate(state.session, record, state.manager, state.roster);
  assert.equal(result.owner, 'New Member', 'ledger receives the receiving nickname, not a client-supplied owner');
  record.owner = result.owner;
  for (const key of ['weeklyEarned', 'weeklySpent', 'earned', 'spent', 'available', 'fiveWeekActivity']) record[key] = 0;
  state.completed.add(options.requestId);
  return { replayed: false, rowIndex: record.rowIndex };
};
state.restore = async options => {
  const record = state.roster.find(entry => entry.owner === options.identity.owner && entry.account === options.identity.account);
  assert.ok(record, 'undo resolves the receiving owner identity');
  await options.mutate(state.session, record, state.roster);
  record.owner = options.ownerAfter ?? record.owner;
  ['weeklyEarned', 'weeklySpent', 'earned', 'spent', 'available', 'fiveWeekActivity'].forEach((key, index) => { record[key] = options.values[index]; });
};
const mocks = {
  '@/lib/auth/session': 'export async function getSessionUser(){return globalThis.__transferOwnerRoute.manager;} export function canManageClan(role){return ["chief","general"].includes(role);}',
  '@/lib/auth/administration': 'export async function withClanAdministrationTransaction(run){return run(globalThis.__transferOwnerRoute.session);}',
  '@/lib/auth/rateLimit': 'export async function limitMemberRequests(){}',
  '@/lib/auctionBidWithdrawal': 'export async function withdrawToonOpenAuctionBids(){globalThis.__transferOwnerRoute.withdrawals++; return {withdrawnBids:1,promotedBids:1};}',
  '@/lib/dkpWeeklyEarned': 'export async function getRosterWithWeeklyEarned(roster){return roster;}',
  '@/lib/googleSheets': `export const resetToonDkp=(options)=>globalThis.__transferOwnerRoute.reset(options);
    export const restoreToonDkpSnapshot=(options)=>globalThis.__transferOwnerRoute.restore(options);
    export async function adjustPlayersDKP(){throw Error('unexpected write');}
    export async function changeClanToon(){throw Error('unexpected write');}
    export async function getSheetRoster(){throw Error('unexpected read');}
    export async function getSheetRosterSnapshot(){throw Error('unexpected read');}
    export async function withDkpLedgerLock(){throw Error('unexpected write');}`,
};
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  let source = mocks[specifier];
  if (specifier.startsWith('@/lib/models/')) source = `export default globalThis.__transferOwnerRoute.model('${specifier.split('/').at(-1)}');`;
  if (source) return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  if (specifier.startsWith('@/')) return nextResolve(new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href, context);
  if (specifier.startsWith('.') && context.parentURL?.startsWith(new URL('../lib/', import.meta.url).href) && !/\.[a-z]+$/i.test(specifier)) return nextResolve(new URL(`${specifier}.ts`, context.parentURL).href, context);
  if (specifier === 'next/server') return nextResolve('next/server.js', context);
  return nextResolve(specifier, context);
} });
const { POST } = await import('../app/api/admin/requests/route.ts');
hooks.deregister();
const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const request = body => new Request('https://centuri.example/api/admin/requests', {
  method: 'POST', headers: { origin: 'https://centuri.example', 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const payload = () => ({ action: 'transfer', userId: String(ids.source), toUserId: String(ids.destination), rowIndex: 3,
  owner: 'Old Member', account: 'Healsbeast', requestId });
beforeEach(() => {
  state.session = {}; state.completed = new Set(); state.withdrawals = 0;
  state.failBeforeCommit = false;
  state.manager = { _id: ids.manager, nickname: 'Chief', role: 'chief', status: 'approved', async save() {} };
  state.User = [state.manager,
    { _id: ids.source, nickname: 'Old Member', role: 'clansman', status: 'approved', sheetRecords: [{ rowIndex: 3, owner: 'Old Member', account: 'Healsbeast' }, { rowIndex: 4, owner: 'Old Member', account: 'Alt' }], async save() {} },
    { _id: ids.destination, nickname: 'New Member', role: 'clansman', status: 'approved', sheetRecordName: 'New Member', async save() {} },
  ];
  state.roster = [
    { rowIndex: 3, owner: 'Old Member', account: 'Healsbeast', subClass: 'Support Druid', weeklyEarned: 10, weeklySpent: 2, earned: 100, spent: 20, available: 80, fiveWeekActivity: 9 },
    { rowIndex: 4, owner: 'Old Member', account: 'Alt', subClass: 'Ranger', available: 50 },
    { rowIndex: 5, owner: 'New Member', account: 'Existing', subClass: 'Tank', available: 60 },
  ];
  state.ClanAuditEvent = []; state.RosterMutation = []; state.ToonDkpReset = []; state.AuctionHold = []; state.Auction = [];
  state.SheetRosterCache = [{ cacheKey: process.env.GOOGLE_SHEET_ID?.trim(), weeklyActivityHistory: [{ owner: 'Old Member', account: 'Healsbeast', weeks: [9] }] }];
  state.ToonRoleChange = [{ identityKey: JSON.stringify(['old member', 'healsbeast']), owner: 'Old Member', account: 'Healsbeast', scheduledRole: 'DPS Druid' }];
  state.ToonRoleChangeRequest = [{ identityKey: JSON.stringify(['old member', 'healsbeast']), owner: 'Old Member', account: 'Healsbeast', status: 'approved', requestedRole: 'DPS Druid' }];
});

test('transfer changes owner, preserves toon/class and both accounts’ other links, and zeroes all DKP', async () => {
  const response = await POST(request(payload()));
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  assert.equal(state.roster[0].owner, 'New Member');
  assert.equal(state.roster[0].account, 'Healsbeast');
  assert.equal(state.roster[0].subClass, 'Support Druid');
  for (const key of ['weeklyEarned', 'weeklySpent', 'earned', 'spent', 'available', 'fiveWeekActivity']) assert.equal(state.roster[0][key], 0);
  assert.deepEqual(state.User[1].sheetRecords.map(toon => toon.account), ['Alt']);
  assert.deepEqual(state.User[2].sheetRecords.map(toon => [toon.owner, toon.account]), [['New Member', 'Existing'], ['New Member', 'Healsbeast']]);
  assert.equal(state.roster[1].available, 50); assert.equal(state.roster[2].available, 60);
  assert.equal(state.ClanAuditEvent[0].removedToons[0].owner, 'Old Member');
  assert.equal(state.ClanAuditEvent[0].addedToons[0].owner, 'New Member');
  assert.equal(state.withdrawals, 1);
  assert.equal(state.ToonRoleChange[0].owner, 'New Member');
  assert.equal(state.ToonRoleChangeRequest[0].owner, 'New Member');
  assert.equal(state.ToonRoleChange[0].identityKey, state.ToonRoleChangeRequest[0].identityKey);
  assert.equal((await POST(request(payload()))).status, 200);
  assert.equal(state.withdrawals, 1, 'retry does not withdraw bids twice');
});

test('undo restores the original owner, balances, and account links', async () => {
  assert.equal((await POST(request(payload()))).status, 200);
  const event = state.ClanAuditEvent[0];
  const response = await POST(request({ action: 'undo-activity', eventId: String(event._id), requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }));
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  assert.equal(state.roster[0].owner, 'Old Member'); assert.equal(state.roster[0].available, 80);
  assert.equal(state.roster[0].weeklyEarned, 10); assert.equal(state.roster[0].fiveWeekActivity, 9);
  assert.deepEqual(state.User[1].sheetRecords.map(toon => toon.account), ['Healsbeast', 'Alt']);
  assert.deepEqual(state.User[2].sheetRecords.map(toon => toon.account), ['Existing']);
  assert.ok(event.undoneAt);
  assert.equal(state.ToonRoleChange[0].owner, 'Old Member');
  assert.equal(state.ToonRoleChangeRequest[0].owner, 'Old Member');
  assert.equal((await POST(request({ action: 'undo-activity', eventId: String(event._id), requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }))).status, 200);
});

test('duplicate destination toon identity is rejected before unlinking the source', async () => {
  state.roster.push({ ...state.roster[0], rowIndex: 6, owner: 'New Member' });
  const response = await POST(request(payload()));
  assert.equal(response.status, 409);
  assert.equal(state.User[1].sheetRecords.length, 2);
  assert.equal(state.roster[0].owner, 'Old Member');
});

test('a pending transfer resumes with the original identity after source unlinking', async () => {
  state.failBeforeCommit = true;
  assert.equal((await POST(request(payload()))).status, 500);
  assert.equal(state.ClanAuditEvent[0].transferStatus, 'pending');
  assert.deepEqual(state.User[1].sheetRecords.map(toon => toon.account), ['Alt']);
  const response = await POST(request({ ...payload(), resumeOperationKey: state.ClanAuditEvent[0].operationKey }));
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  assert.equal(state.roster[0].owner, 'New Member');
  assert.equal(state.roster[0].available, 0);
  assert.equal(state.withdrawals, 1);
});

test('undo restores an existing original reset cutoff and removes the receiving reset', async () => {
  const originalReset = { identityKey: JSON.stringify(['old member', 'healsbeast']), owner: 'Old Member', account: 'Healsbeast',
    resetAt: new Date('2026-10-01'), resetByUserId: ids.manager, resetByNickname: 'Chief' };
  state.ToonDkpReset = [{ ...originalReset }];
  assert.equal((await POST(request(payload()))).status, 200);
  assert.equal(state.ToonDkpReset.length, 2);
  const event = state.ClanAuditEvent[0];
  const response = await POST(request({ action: 'undo-activity', eventId: String(event._id), requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }));
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  assert.deepEqual(state.ToonDkpReset, [originalReset]);
});

test('a previously used receiving identity can transfer again without losing its prior reset on undo', async () => {
  const priorDestinationReset = { identityKey: JSON.stringify(['new member', 'healsbeast']), owner: 'New Member', account: 'Healsbeast',
    resetAt: new Date('2026-09-01'), resetByUserId: ids.manager, resetByNickname: 'Chief' };
  state.ToonDkpReset = [{ ...priorDestinationReset }];
  assert.equal((await POST(request(payload()))).status, 200);
  assert.notEqual(state.ToonDkpReset[0].resetAt.getTime(), priorDestinationReset.resetAt.getTime());
  const event = state.ClanAuditEvent[0];
  const response = await POST(request({ action: 'undo-activity', eventId: String(event._id), requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }));
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  assert.deepEqual(state.ToonDkpReset, [priorDestinationReset]);
});
