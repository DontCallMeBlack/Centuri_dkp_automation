import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDkpAdjustmentUpdates, canAffordBid, getDkpReplayState, snapshotDkpCells } from '../lib/dkpAccounting.ts';
import { buildHistoricalDkpActivityCorrection, buildWeeklyDkpResetPlan, getDkpElapsedWeeks } from '../lib/dkpCycle.ts';
import { getBossRequestFingerprint, isDkpRequestId, isRosterRowArray } from '../lib/bossDkp.ts';
import { addWeeklyEarnedFromAwards } from '../lib/weeklyDkpEarned.ts';

const sheetName = "'DKP_Sheet_automated'";
const row = ['Ada', 'Main', 'Druid', '6', '0', '100', '20', '80', '20'];
const record = { rowIndex: 3, owner: 'Ada', account: 'Main', weeklyEarned: 6, earned: 100, available: 80, fiveWeekActivity: 20 };
const update = (column, value) => ({ range: `${sheetName}!${column}3`, values: [[value]] });

test('interrupted DKP writes replay once from the recorded before state', () => {
  const after = [update('F', 105), update('H', 85)];
  const before = snapshotDkpCells(after, [row]);
  assert.equal(getDkpReplayState(before, after, [row]), 'pending');
  const alreadyApplied = [...row];
  alreadyApplied[5] = '105';
  alreadyApplied[7] = '85';
  assert.equal(getDkpReplayState(before, after, [alreadyApplied]), 'applied');
});

test('recovery refuses mixed writes and later manual changes instead of overwriting them', () => {
  const after = [update('F', 105), update('H', 85)];
  const before = snapshotDkpCells(after, [row]);
  const mixed = [...row]; mixed[5] = '105';
  assert.throws(() => getDkpReplayState(before, after, [mixed]), /reconcile/);
  const externalChange = [...row]; externalChange[7] = '500';
  assert.throws(() => getDkpReplayState(before, after, [externalChange]), /reconcile/);
});

test('recovery rejects malformed, incomplete, nonnumeric, and overflowing write plans', () => {
  assert.throws(() => getDkpReplayState([], [update('F', 105)], [row]), /Incomplete/);
  assert.throws(() => getDkpReplayState([update('F', 100)], [update('H', 105)], [row]), /Invalid/);
  assert.throws(() => getDkpReplayState([update('F', 100)], [update('F', Infinity)], [row]), /Unsafe/);
  const malformed = [...row]; malformed[5] = 'not a number';
  assert.throws(() => snapshotDkpCells([update('F', 105)], [malformed]), /not numeric/);
  assert.throws(() => getDkpReplayState([update('F', 100)], [update('F', Number.MAX_SAFE_INTEGER + 1)], [row]), /Unsafe/);
});

test('numeric overflow and corrupted reservation amounts cannot bypass balance checks', () => {
  const large = [...row]; large[5] = String(Number.MAX_SAFE_INTEGER);
  assert.throws(() => buildDkpAdjustmentUpdates({ rowIndex: 3, row: large, points: 1, mode: 'balance', sheetName }), /safe numeric/);
  for (const heldPoints of [Infinity, Number.NaN, -1]) {
    assert.throws(() => buildDkpAdjustmentUpdates({ rowIndex: 3, row, points: -1, mode: 'balance', heldPoints, sheetName }), /held auction/);
    assert.equal(canAffordBid(1, heldPoints, 80), false);
  }
  assert.equal(canAffordBid(1, 0, Infinity), false);
  assert.equal(canAffordBid(1, 0, Number.NaN), false);
});

test('request IDs and selected rows are bounded, and equivalent attendance has one fingerprint', () => {
  assert.equal(isDkpRequestId('761a8674-9a22-47fe-831d-00a10a96bf7b'), true);
  for (const value of ['', 'boss-1', '761a8674-9a22-17fe-831d-00a10a96bf7b', null, {}]) assert.equal(isDkpRequestId(value), false);
  for (const rows of [[2], [1001], [Infinity], [-1], [3, 3]]) assert.equal(isRosterRowArray(rows), false);
  assert.equal(getBossRequestFingerprint('grant', 'Crom', [3, 8]), getBossRequestFingerprint('grant', 'Crom', [8, 3]));
  assert.notEqual(getBossRequestFingerprint('grant', 'Crom', [3]), getBossRequestFingerprint('grant', 'Dino', [3]));
  assert.notEqual(getBossRequestFingerprint('edit', 'Crom', [3]), getBossRequestFingerprint('delete', 'Crom', [3]));
});

test('editing a completed week changes its activity bucket and retains the correction at the next rollover', () => {
  const history = [{ rowIndex: 3, owner: 'Ada', account: 'Main', weeks: [3, 4, 7] }];
  const corrected = buildHistoricalDkpActivityCorrection([record], history, [{ rowIndex: 3, points: -2 }],
    new Date('2026-10-10T18:00:00Z'), new Date('2026-10-17T18:00:00Z'), sheetName);
  assert.deepEqual(corrected.weeklyActivityHistory[0].weeks, [3, 4, 5]);
  assert.deepEqual(history[0].weeks, [3, 4, 7]);
  assert.deepEqual(corrected.updates, [update('I', 18)]);
  const next = buildWeeklyDkpResetPlan([record], sheetName, corrected.weeklyActivityHistory);
  assert.deepEqual(next.weeklyActivityHistory[0].weeks, [3, 4, 5, 6]);
  assert.equal(next.updates.find(({ range }) => range.endsWith('!I3')).values[0][0], 18);
});

test('old attendance outside the five completed weeks does not reenter activity totals', () => {
  const history = [{ rowIndex: 3, owner: 'Ada', account: 'Main', weeks: [1, 2, 3, 4, 5] }];
  const result = buildHistoricalDkpActivityCorrection([record], history, [{ rowIndex: 3, points: 12 }],
    new Date('2026-08-01T12:00:00Z'), new Date('2026-10-17T18:00:00Z'), sheetName);
  assert.deepEqual(result.updates, []);
  assert.deepEqual(result.weeklyActivityHistory, history);
});

test('missed weekly rollovers age activity and transfer earned points exactly once', () => {
  const history = [{ rowIndex: 3, owner: 'Ada', account: 'Main', weeks: [1, 2, 3, 4, 5] }];
  const plan = buildWeeklyDkpResetPlan([record], sheetName, history, 3);
  assert.deepEqual(plan.weeklyActivityHistory[0].weeks, [4, 5, 6, 0, 0]);
  assert.equal(plan.updates.find(({ range }) => range.endsWith('!F3')).values[0][0], 106);
  assert.equal(plan.updates.find(({ range }) => range.endsWith('!H3')).values[0][0], 86);
  assert.deepEqual(buildWeeklyDkpResetPlan([record], sheetName, history, 8).weeklyActivityHistory[0].weeks, [0, 0, 0, 0, 0]);
});

test('elapsed calendar weeks remain correct across both daylight saving transitions', () => {
  assert.equal(getDkpElapsedWeeks(new Date('2026-03-08T05:00:00Z'), new Date('2026-03-15T04:00:00Z')), 1);
  assert.equal(getDkpElapsedWeeks(new Date('2026-11-01T04:00:00Z'), new Date('2026-11-08T05:00:00Z')), 1);
});

test('duplicate legacy participant entries cannot inflate weekly auction eligibility', () => {
  const result = addWeeklyEarnedFromAwards([record], [{ points: 12, participants: [record, record, { owner: 'ada', account: ' MAIN ' }] }]);
  assert.equal(result[0].weeklyEarned, 12);
});
