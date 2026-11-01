import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// Isolated storage fixtures: no live database reads or writes.
const state = globalThis.__readEfficiencyFixture = {};
function query(kind, filter) {
  const call = { kind, filter };
  state.calls.push(call);
  return {
    select(value) { call.select = value; return this; },
    sort(value) { call.sort = value; return this; },
    session(value) { call.session = value; return this; },
    lean() { return state.read(kind, filter); },
  };
}
const models = {
  '@/lib/models/ToonRoleChange': 'changes',
  '@/lib/models/ToonRoleChangeRequest': 'approvals',
  '@/lib/models/Auction': 'followUps',
  '@/lib/models/BossAward': 'awards',
  '@/lib/models/ToonDkpReset': 'resets',
  '@/lib/models/RosterMutation': 'lifecycles',
  '@/lib/models/User': 'creators',
};
state.query = query;
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (models[specifier]) return {
    url: `data:text/javascript,${encodeURIComponent(`export default {find(filter) {return globalThis.__readEfficiencyFixture.query('${models[specifier]}',filter);}}`)}`,
    shortCircuit: true,
  };
  if (specifier.startsWith('@/')) return nextResolve(new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href, context);
  if (specifier.startsWith('.') && context.parentURL?.includes('/lib/') && !/\.[a-z]+$/i.test(specifier)) {
    return nextResolve(new URL(`${specifier}.ts`, context.parentURL).href, context);
  }
  return nextResolve(specifier, context);
} });
const { readToonRoleSchedules } = await import('../lib/readToonRoleSchedules.ts');
const { readAuctionCreatorRoles, readAuctionFollowUpTasks } = await import('../lib/auctionFollowUpReads.ts');
const { getRosterWithWeeklyEarned } = await import('../lib/dkpWeeklyEarned.ts');
hooks.deregister();

beforeEach(() => {
  state.calls = [];
  state.changes = []; state.approvals = []; state.followUps = []; state.awards = []; state.resets = []; state.creators = []; state.lifecycles = [];
  state.read = async (kind) => state[kind];
});

test('empty role lists use no queries; unscheduled toons need no approval query', async () => {
  assert.deepEqual(await readToonRoleSchedules([]), { roleChanges: [], roleApprovals: [] });
  assert.equal(state.calls.length, 0);
  state.changes = [{ identityKey: 'a', currentRole: 'Tank' }];
  const result = await readToonRoleSchedules(['a']);
  assert.deepEqual(result.roleChanges, state.changes);
  assert.deepEqual(result.roleApprovals, []);
  assert.deepEqual(state.calls.map(call => call.kind), ['changes']);
});

test('scheduled roles still load authoritative approved/applied decisions', async () => {
  state.changes = [
    { identityKey: 'a', scheduledRole: 'Ice Mage', effectiveAt: new Date() },
    { identityKey: 'b', currentRole: 'Tank' },
    { identityKey: 'c', scheduledRole: 'Support Rogue' },
  ];
  state.approvals = [{ identityKey: 'a', status: 'approved', decidedByUserId: 'manager' }];
  const result = await readToonRoleSchedules(['a', 'b', 'c']);
  assert.deepEqual(result.roleApprovals, state.approvals);
  assert.deepEqual(state.calls[1], {
    kind: 'approvals',
    filter: { identityKey: { $in: ['a'] }, status: { $in: ['approved', 'applied'] },
      decidedByUserId: { $exists: true }, decidedAt: { $exists: true } },
    sort: { createdAt: -1 },
  });
});

test('identical concurrent display reads share work, but completed results are never cached', async () => {
  let finish;
  state.read = () => new Promise(resolve => { finish = resolve; });
  const first = readToonRoleSchedules(['b', 'a', 'a']);
  const second = readToonRoleSchedules(['a', 'b']);
  assert.equal(first, second);
  assert.equal(state.calls.length, 1);
  finish([]);
  await first;
  state.read = async () => [{ identityKey: 'a', currentRole: 'Fire Mage' }];
  assert.equal((await readToonRoleSchedules(['a', 'b'])).roleChanges[0].currentRole, 'Fire Mage');
  assert.equal(state.calls.length, 2);
});

test('failed reads are removed from in-flight sharing and retried on next request', async () => {
  state.read = async () => { throw new Error('database unavailable'); };
  await assert.rejects(readToonRoleSchedules(['a']), /database unavailable/);
  state.read = async () => [];
  assert.deepEqual(await readToonRoleSchedules(['a']), { roleChanges: [], roleApprovals: [] });
  assert.equal(state.calls.length, 2);
});

test('different identity sets cannot share another roster result', async () => {
  const first = readToonRoleSchedules(['a']);
  const second = readToonRoleSchedules(['b']);
  assert.notEqual(first, second);
  await Promise.all([first, second]);
  assert.deepEqual(state.calls.map(call => call.filter.identityKey.$in), [['a'], ['b']]);
});

test('follow-up query preserves delivery/no-bid distinctions, including legacy null bid fields', async () => {
  state.followUps = [
    { id: 'delivery', deliveryStatus: 'pending', highBid: { amount: 20 } },
    { id: 'no-bid', deliveryStatus: 'not-required' },
    // MongoDB $exists:false excludes explicit null and undefined properties.
    { id: 'null', deliveryStatus: 'not-required', highBid: null },
    { id: 'undefined', deliveryStatus: 'not-required', highBid: undefined },
  ];
  const result = await readAuctionFollowUpTasks();
  assert.deepEqual(result.pendingDeliveryTasks.map(task => task.id), ['delivery']);
  assert.deepEqual(result.pendingNoBidTasks.map(task => task.id), ['no-bid']);
  assert.deepEqual(state.calls, [{ kind: 'followUps', filter: {
    status: 'completed', $or: [{ deliveryStatus: 'pending' },
      { deliveryStatus: 'not-required', highBid: { $exists: false } }],
  }, sort: { createdAt: 1 } }]);
});

test('combined follow-up read never caps or drops outstanding delivery tasks', async () => {
  state.followUps = Array.from({ length: 1500 }, (_, id) => ({ id, deliveryStatus: 'pending' }));
  assert.equal((await readAuctionFollowUpTasks()).pendingDeliveryTasks.length, 1500);
  assert.equal(state.calls.length, 1);
});

const toon = { rowIndex: 3, owner: 'Ada', account: 'Main', weeklyEarned: 999 };
test('creator-role lookup is skipped only for permissions independent of creator rank', async () => {
  const auctions = [{ createdByUserId: 'guardian-id' }];
  for (const role of ['chief', 'guardian', 'clansman', 'unknown']) {
    assert.deepEqual(await readAuctionCreatorRoles(role, auctions), []);
  }
  assert.deepEqual(await readAuctionCreatorRoles('general', []), []);
  assert.equal(state.calls.length, 0);
  state.creators = [{ _id: 'guardian-id', role: 'guardian' }];
  assert.deepEqual(await readAuctionCreatorRoles('general', [...auctions, ...auctions, {}]), state.creators);
  assert.deepEqual(state.calls[0], { kind: 'creators', filter: { _id: { $in: ['guardian-id'] } }, select: '_id role' });
  // A later request must see changed creator permissions immediately.
  state.creators = [{ _id: 'guardian-id', role: 'general' }];
  assert.equal((await readAuctionCreatorRoles('general', auctions))[0].role, 'general');
  assert.equal(state.calls.length, 2);
});

test('empty roster and zero weekly awards avoid irrelevant reads without changing the zero result', async () => {
  assert.deepEqual(await getRosterWithWeeklyEarned([]), []);
  assert.equal(state.calls.length, 0);
  assert.deepEqual(await getRosterWithWeeklyEarned([toon]), [{ ...toon, weeklyEarned: 0 }]);
  assert.deepEqual(state.calls.map(call => call.kind), ['awards']);
  assert.deepEqual(state.calls[0].filter.status, { $in: ['applied', 'updating'] });
});

test('nonempty weekly activity retains transactional sessions and reset cutoffs', async () => {
  const { getSheetRecordKey } = await import('../lib/sheetRecordLinks.ts');
  state.awards = [
    { points: 5, createdAt: new Date('2026-10-20'), participants: [toon] },
    { points: 7, createdAt: new Date('2026-10-22'), participants: [toon] },
  ];
  state.resets = [{ identityKey: getSheetRecordKey(toon), resetAt: new Date('2026-10-21') }];
  const session = { transaction: 'unchanged-session' };
  assert.deepEqual(await getRosterWithWeeklyEarned([toon], session), [{ ...toon, weeklyEarned: 7 }]);
  assert.deepEqual(state.calls.map(call => call.kind), ['awards', 'resets', 'lifecycles']);
  assert.ok(state.calls.every(call => call.session === session));
});

test('readded toons do not inherit weekly eligibility from before their removal', async () => {
  const { getSheetRecordKey } = await import('../lib/sheetRecordLinks.ts');
  state.awards = [
    { points: 5, createdAt: new Date('2026-10-20'), participants: [toon] },
    { points: 7, createdAt: new Date('2026-10-22'), participants: [toon] },
  ];
  state.lifecycles = [{ identityKey: getSheetRecordKey(toon), createdAt: new Date('2026-10-21') }];
  assert.deepEqual(await getRosterWithWeeklyEarned([toon]), [{ ...toon, weeklyEarned: 7 }]);
});
