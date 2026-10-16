import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWeeklyDkpResetUpdates,
  getCurrentDkpWeekStart,
  getPreviousDkpWeekRange,
} from '../lib/dkpCycle.ts';
import {
  getAuctionSettlementMutationKey,
  isSettlementLeaseExpired,
  needsSettlementManualReview,
} from '../lib/auctionSettlement.ts';

const SHEET = "'DKP_Sheet_automated'";

test('weekly cycle starts at Sunday midnight in America/New_York', async (t) => {
  const cases = [
    ['Sunday immediately before boundary', '2026-10-18T03:59:59.999Z', '2026-10-11T04:00:00.000Z'],
    ['Sunday at boundary', '2026-10-18T04:00:00.000Z', '2026-10-18T04:00:00.000Z'],
    ['Sunday after boundary', '2026-10-18T04:00:00.001Z', '2026-10-18T04:00:00.000Z'],
    ['Monday', '2026-10-19T12:00:00.000Z', '2026-10-18T04:00:00.000Z'],
    ['Saturday', '2026-10-24T23:59:59.000Z', '2026-10-18T04:00:00.000Z'],
    ['spring DST boundary', '2026-03-08T05:00:00.000Z', '2026-03-08T05:00:00.000Z'],
    ['fall DST boundary', '2026-11-01T04:00:00.000Z', '2026-11-01T04:00:00.000Z'],
    ['new year crossing', '2026-01-04T05:00:00.000Z', '2026-01-04T05:00:00.000Z'],
    ['leap day Saturday', '2024-03-02T18:00:00.000Z', '2024-02-25T05:00:00.000Z'],
    ['leap day Sunday', '2024-03-03T05:00:00.000Z', '2024-03-03T05:00:00.000Z'],
  ];
  for (const [label, input, expected] of cases) {
    await t.test(label, () => assert.equal(getCurrentDkpWeekStart(new Date(input)).toISOString(), expected));
  }
});

test('previous completed weekly activity range', async (t) => {
  const cases = [
    ['Saturday daytime', '2026-10-17T12:00:00.000Z', '2026-10-04T04:00:00.000Z', '2026-10-11T04:00:00.000Z'],
    ['Sunday just before rollover', '2026-10-18T03:59:59.000Z', '2026-10-04T04:00:00.000Z', '2026-10-11T04:00:00.000Z'],
    ['Sunday after rollover', '2026-10-18T04:00:01.000Z', '2026-10-11T04:00:00.000Z', '2026-10-18T04:00:00.000Z'],
    ['spring DST week is 167 hours', '2026-03-08T06:00:00.000Z', '2026-03-01T05:00:00.000Z', '2026-03-08T05:00:00.000Z'],
    ['fall DST week is 169 hours', '2026-11-08T06:00:00.000Z', '2026-11-01T04:00:00.000Z', '2026-11-08T05:00:00.000Z'],
  ];
  for (const [label, input, start, end] of cases) {
    await t.test(label, () => {
      const range = getPreviousDkpWeekRange(new Date(input));
      assert.equal(range.start.toISOString(), start);
      assert.equal(range.end.toISOString(), end);
      assert.ok(range.start < range.end);
    });
  }
});

test('weekly rollover clears earned and spent, and carries weekly earned into lifetime totals', async (t) => {
  const cases = [
    ['positive weekly points', { rowIndex: 3, weeklyEarned: 12, earned: 100, available: 40 }, [
      [`${SHEET}!D3`, 0], [`${SHEET}!E3`, 0], [`${SHEET}!F3`, 112], [`${SHEET}!H3`, 52],
    ]],
    ['zero weekly points', { rowIndex: 4, weeklyEarned: 0, earned: 15, available: 7 }, [
      [`${SHEET}!D4`, 0], [`${SHEET}!E4`, 0],
    ]],
    ['fractional values', { rowIndex: 5, weeklyEarned: 2.5, earned: 4.25, available: 3.5 }, [
      [`${SHEET}!D5`, 0], [`${SHEET}!E5`, 0], [`${SHEET}!F5`, 6.75], [`${SHEET}!H5`, 6],
    ]],
    ['negative correction carries through', { rowIndex: 6, weeklyEarned: -3, earned: 20, available: 9 }, [
      [`${SHEET}!D6`, 0], [`${SHEET}!E6`, 0], [`${SHEET}!F6`, 17], [`${SHEET}!H6`, 6],
    ]],
    ['large weekly spent still only clears E', { rowIndex: 7, weeklyEarned: 1, earned: 500, available: 499 }, [
      [`${SHEET}!D7`, 0], [`${SHEET}!E7`, 0], [`${SHEET}!F7`, 501], [`${SHEET}!H7`, 500],
    ]],
  ];
  for (const [label, row, expected] of cases) {
    await t.test(label, () => {
      const updates = buildWeeklyDkpResetUpdates([row], SHEET);
      assert.deepEqual(updates.map(({ range, values }) => [range, values[0][0]]), expected);
    });
  }
  await t.test('multiple roster rows do not share ranges or values', () => {
    const updates = buildWeeklyDkpResetUpdates([
      { rowIndex: 3, weeklyEarned: 5, earned: 10, available: 6 },
      { rowIndex: 10, weeklyEarned: 0, earned: 20, available: 4 },
    ], SHEET);
    assert.deepEqual(updates.map((update) => update.range), [
      `${SHEET}!D3`, `${SHEET}!E3`, `${SHEET}!F3`, `${SHEET}!H3`, `${SHEET}!D10`, `${SHEET}!E10`,
    ]);
  });
  await t.test('empty roster yields no writes', () => {
    assert.deepEqual(buildWeeklyDkpResetUpdates([], SHEET), []);
  });
});

test('auction settlement retry and review rules', async (t) => {
  const reviewCases = [
    ['old in-progress without audit marker requires review', { status: 'settling' }, true],
    ['old failed without audit marker requires review', { status: 'settlement-failed' }, true],
    ['known attempt can be replayed', { status: 'settling', settlementAttemptId: 'attempt-1' }, false],
    ['known failed attempt can be replayed', { status: 'settlement-failed', settlementAttemptId: 'attempt-1' }, false],
    ['already deducted legacy settlement can finish', { status: 'settling', settlementDkpApplied: true }, false],
    ['active auction is not a legacy interrupted settlement', { status: 'active' }, false],
    ['completed auction is not a legacy interrupted settlement', { status: 'completed' }, false],
    ['removing auction is not a legacy interrupted settlement', { status: 'removing' }, false],
  ];
  for (const [label, input, expected] of reviewCases) {
    await t.test(label, () => assert.equal(needsSettlementManualReview(input), expected));
  }

  const now = new Date('2026-10-16T12:00:00Z');
  const leaseCases = [
    ['expired lease is recoverable', 'settling', new Date('2026-10-16T11:59:59Z'), true],
    ['lease expiring now is recoverable', 'settling', now, true],
    ['future lease is not recovered early', 'settling', new Date('2026-10-16T12:00:01Z'), false],
    ['missing lease is recoverable', 'settling', undefined, true],
    ['active status does not use settlement lease recovery', 'active', undefined, false],
    ['failed status does not use settlement lease recovery', 'settlement-failed', undefined, false],
  ];
  for (const [label, status, lease, expected] of leaseCases) {
    await t.test(label, () => assert.equal(isSettlementLeaseExpired(status, lease, now), expected));
  }

  await t.test('same auction always receives the same mutation key', () => {
    assert.equal(getAuctionSettlementMutationKey('auction-123'), 'auction-settlement:auction-123');
    assert.equal(getAuctionSettlementMutationKey('auction-123'), getAuctionSettlementMutationKey('auction-123'));
  });
  await t.test('different auctions receive independent mutation keys', () => {
    assert.notEqual(getAuctionSettlementMutationKey('auction-123'), getAuctionSettlementMutationKey('auction-456'));
  });
});
