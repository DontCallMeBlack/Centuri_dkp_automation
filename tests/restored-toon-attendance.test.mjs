import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { getSheetRecordKey } from '../lib/sheetRecordLinks.ts';

const state = globalThis.__restoredToonAttendance = {};
const chain = value => ({
  session() { return this; }, select() { return this; },
  lean() { return Promise.resolve(value); },
  then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
});
state.model = name => {
  if (name === 'User') return { findOne: () => chain(state.user) };
  if (name === 'RosterMutation') return {
    find(filter) {
      return chain(state.removals.filter(removal =>
        removal.spreadsheetId === filter.spreadsheetId &&
        filter.identityKey.$in.includes(removal.identityKey) &&
        (removal.action === 'create' || (removal.action === 'remove' && !('restoredAt' in removal)))));
    },
  };
  if (name === 'BossAward') return {
    findById: () => chain(state.award),
    findOneAndUpdate(filter, update) {
      Object.assign(state.award, update.$set);
      return chain(state.award);
    },
    async updateOne(filter, update) {
      Object.assign(state.award, update.$set);
      state.award.completedRequests.push(update.$push.completedRequests);
      for (const key of Object.keys(update.$unset)) delete state.award[key];
    },
  };
  throw new Error(`Unexpected model ${name}`);
};
const mocks = {
  '@/lib/auth/session': 'export async function getSessionUser(){return globalThis.__restoredToonAttendance.user;}',
  '@/lib/auth/administration': 'export async function withClanAdministrationTransaction(run){return run({});}',
  '@/lib/auth/rateLimit': 'export async function limitMemberRequests(){}',
  '@/lib/googleSheets': `export async function getSheetRoster(){return globalThis.__restoredToonAttendance.roster;}
    export async function isDkpMutationApplied(){return false;}
    export async function adjustPlayersDKP(adjustments){globalThis.__restoredToonAttendance.adjustments.push(...adjustments);}`,
};
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  let source = mocks[specifier];
  if (specifier.startsWith('@/lib/models/')) source = `export default globalThis.__restoredToonAttendance.model('${specifier.split('/').at(-1)}');`;
  if (source) return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  if (specifier.startsWith('@/')) return nextResolve(new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href, context);
  if (specifier === 'next/server') return nextResolve('next/server.js', context);
  return nextResolve(specifier, context);
} });
const { PATCH, DELETE } = await import('../app/api/admin/boss-history/route.ts');
hooks.deregister();
const request = selectedRows => new Request('https://centuri.example/api/admin/boss-history', {
  method: 'PATCH', headers: { origin: 'https://centuri.example', 'content-type': 'application/json' },
  body: JSON.stringify({ awardId: '100000000000000000000001', requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', selectedRows }),
});
beforeEach(() => {
  state.user = { _id: '100000000000000000000002', nickname: 'Chief', role: 'chief' };
  state.roster = [{ rowIndex: 3, owner: 'Ada', account: 'Moonblade', subClass: 'Ranger' },
    { rowIndex: 4, owner: 'Bea', account: 'Ironroot', subClass: 'Tank' }];
  state.award = { participants: [state.roster[0]], bossName: 'Base', points: 1,
    status: 'applied', createdAt: new Date(), completedRequests: [] };
  state.removals = [{ spreadsheetId: process.env.GOOGLE_SHEET_ID?.trim(), action: 'remove',
    identityKey: getSheetRecordKey(state.roster[0]), createdAt: new Date(Date.now() - 60_000), restoredAt: new Date() }];
  state.adjustments = [];
});

test('restored attendee permits edits and only newly added attendees gain DKP', async () => {
  const response = await PATCH(request([3, 4]));
  assert.equal(response.status, 200, JSON.stringify(await response.json()));
  assert.deepEqual(state.adjustments.map(({ account, points }) => [account, points]), [['Ironroot', 1]]);
  assert.equal(state.award.status, 'applied');
  assert.equal(state.award.participants.length, 2);
});

test('manually readding an archived name allows attendance edits', async () => {
  delete state.removals[0].restoredAt;
  const response = await PATCH(request([3, 4]));
  assert.equal(response.status, 200, JSON.stringify(await response.json()));
  assert.equal(state.award.status, 'applied');
  assert.deepEqual(state.adjustments.map(({ account, points }) => [account, points]), [['Ironroot', 1]]);
});

test('an old kill can add other names after an attendee was removed and readded', async () => {
  state.removals.push({ ...state.removals[0] });
  delete state.removals[1].restoredAt;
  state.removals[1].createdAt = new Date(Date.now() + 1);
  const response = await PATCH(request([3, 4]));
  assert.equal(response.status, 200, JSON.stringify(await response.json()));
  assert.deepEqual(state.adjustments.map(({ account, points }) => [account, points]), [['Ironroot', 1]]);
});

test('adding a reentered toon to an old kill cannot restore forfeited DKP', async () => {
  state.award.participants = [state.roster[1]];
  delete state.removals[0].restoredAt;
  state.removals[0].createdAt = new Date(Date.now() + 1);
  const response = await PATCH(request([3, 4]));
  assert.equal(response.status, 200, JSON.stringify(await response.json()));
  assert.deepEqual(state.adjustments, []);
  assert.equal(state.award.participants.length, 2);
});

test('a toon added again through the app can earn DKP on newer kills', async () => {
  state.award.participants = [state.roster[1]];
  state.removals.push({ ...state.removals[0], action: 'create', createdAt: new Date(Date.now() - 1_000) });
  const response = await PATCH(request([3, 4]));
  assert.equal(response.status, 200, JSON.stringify(await response.json()));
  assert.deepEqual(state.adjustments.map(({ account, points }) => [account, points]), [['Moonblade', 1]]);
});

test('deleting an old kill does not subtract forfeited points from a readded toon', async () => {
  state.award.participants = [...state.roster];
  delete state.removals[0].restoredAt;
  state.removals[0].createdAt = new Date(Date.now() + 1);
  const response = await DELETE(request([]));
  assert.equal(response.status, 200, JSON.stringify(await response.json()));
  assert.deepEqual(state.adjustments.map(({ account, points }) => [account, points]), [['Ironroot', -1]]);
  assert.equal(state.award.status, 'deleted');
});
