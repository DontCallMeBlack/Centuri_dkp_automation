import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWeeklyDkpResetPlan,
  initializeWeeklyDkpActivityHistory,
  getCurrentDkpWeekStart,
  getPreviousDkpWeekRange,
} from '../lib/dkpCycle.ts';
import {
  getAuctionSettlementMutationKey,
  isSettlementLeaseExpired,
  needsSettlementManualReview,
} from '../lib/auctionSettlement.ts';
import { buildDkpAdjustmentUpdates, canAffordBid } from '../lib/dkpAccounting.ts';
import { addWeeklyEarnedFromAwards } from '../lib/weeklyDkpEarned.ts';
import { getLinkedSheetRecordRows } from '../lib/sheetRecordLinks.ts';
import { BOSS_DKP_POINTS, isRosterRowArray } from '../lib/bossDkp.ts';

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

test('weekly rollover clears weekly totals, carries earned forward, and writes five-week activity', async (t) => {
  const cases = [
    ['positive weekly points', { rowIndex: 3, owner: 'Ada', account: 'Main', weeklyEarned: 12, earned: 100, available: 40, fiveWeekActivity: 0 }, [
      [`${SHEET}!D3`, 0], [`${SHEET}!E3`, 0], [`${SHEET}!I3`, 12], [`${SHEET}!F3`, 112], [`${SHEET}!H3`, 52],
    ]],
    ['zero weekly points', { rowIndex: 4, owner: 'Ada', account: 'Alt', weeklyEarned: 0, earned: 15, available: 7, fiveWeekActivity: 0 }, [
      [`${SHEET}!D4`, 0], [`${SHEET}!E4`, 0], [`${SHEET}!I4`, 0],
    ]],
    ['fractional values', { rowIndex: 5, owner: 'Bea', account: 'Main', weeklyEarned: 2.5, earned: 4.25, available: 3.5, fiveWeekActivity: 0 }, [
      [`${SHEET}!D5`, 0], [`${SHEET}!E5`, 0], [`${SHEET}!I5`, 2.5], [`${SHEET}!F5`, 6.75], [`${SHEET}!H5`, 6],
    ]],
    ['negative correction carries through', { rowIndex: 6, owner: 'Cal', account: 'Main', weeklyEarned: -3, earned: 20, available: 9, fiveWeekActivity: 0 }, [
      [`${SHEET}!D6`, 0], [`${SHEET}!E6`, 0], [`${SHEET}!I6`, -3], [`${SHEET}!F6`, 17], [`${SHEET}!H6`, 6],
    ]],
    ['large weekly spent still only clears E', { rowIndex: 7, owner: 'Dee', account: 'Main', weeklyEarned: 1, earned: 500, available: 499, fiveWeekActivity: 0 }, [
      [`${SHEET}!D7`, 0], [`${SHEET}!E7`, 0], [`${SHEET}!I7`, 1], [`${SHEET}!F7`, 501], [`${SHEET}!H7`, 500],
    ]],
  ];
  for (const [label, row, expected] of cases) {
    await t.test(label, () => {
      const updates = buildWeeklyDkpResetPlan([row], SHEET).updates;
      assert.deepEqual(updates.map(({ range, values }) => [range, values[0][0]]), expected);
    });
  }
  await t.test('multiple roster rows do not share ranges or values', () => {
    const updates = buildWeeklyDkpResetPlan([
      { rowIndex: 3, owner: 'Ada', account: 'Main', weeklyEarned: 5, earned: 10, available: 6, fiveWeekActivity: 0 },
      { rowIndex: 10, owner: 'Bea', account: 'Main', weeklyEarned: 0, earned: 20, available: 4, fiveWeekActivity: 0 },
    ], SHEET).updates;
    assert.deepEqual(updates.map((update) => update.range), [
      `${SHEET}!D3`, `${SHEET}!E3`, `${SHEET}!I3`, `${SHEET}!F3`, `${SHEET}!H3`, `${SHEET}!D10`, `${SHEET}!E10`, `${SHEET}!I10`,
    ]);
  });
  await t.test('empty roster yields no writes', () => {
    assert.deepEqual(buildWeeklyDkpResetPlan([], SHEET).updates, []);
  });
});

test('five-week activity drops the oldest completed week on each rollover', () => {
  const weeklyEarned = [2, 3, 4, 5, 6, 7, 8];
  let history = [];
  const totals = [];
  for (const [index, points] of weeklyEarned.entries()) {
    const plan = buildWeeklyDkpResetPlan([{
      rowIndex: 3, owner: 'Ada', account: 'Main', weeklyEarned: points,
      earned: 0, available: 0, fiveWeekActivity: 0,
    }], SHEET, history);
    history = plan.weeklyActivityHistory;
    totals.push(plan.updates.find((update) => update.range === `${SHEET}!I3`).values[0][0]);
    assert.equal(history[0].weeks.length, Math.min(index + 1, 5));
  }
  assert.deepEqual(totals, [2, 5, 9, 14, 20, 25, 30]);
});

test('five-week activity preserves a preexisting sheet total as a legacy bucket', () => {
  const rows = [{
    rowIndex: 3, owner: 'Ada', account: 'Main', weeklyEarned: 4,
    earned: 100, available: 20, fiveWeekActivity: 25,
  }];
  const initialHistory = initializeWeeklyDkpActivityHistory(rows);
  const plan = buildWeeklyDkpResetPlan(rows, SHEET, initialHistory);
  assert.deepEqual(plan.weeklyActivityHistory[0].weeks, [25, 4]);
  assert.equal(plan.updates.find((update) => update.range === `${SHEET}!I3`).values[0][0], 29);
});

test('five-week history follows a toon when its sheet row moves', () => {
  const plan = buildWeeklyDkpResetPlan([{
    rowIndex: 8, owner: 'ADA', account: 'main', weeklyEarned: 7,
    earned: 0, available: 0, fiveWeekActivity: 10,
  }], SHEET, [{ rowIndex: 3, owner: 'Ada', account: 'Main', weeks: [4, 6] }]);
  assert.deepEqual(plan.weeklyActivityHistory[0].weeks, [4, 6, 7]);
  assert.equal(plan.updates.find((update) => update.range === `${SHEET}!I8`).values[0][0], 17);
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

test('DKP grant, adjustment, and auction-spend accounting', async (t) => {
  const sheet = (column, row) => `${SHEET}!${column}${row}`;
  const rosterRow = ['Ada', 'Account 1', 'Druid', '4', '6', '100', '30', '94'];
  const cases = [
    ['weekly award increments D and current five-week activity', { points: 5, mode: 'weekly-earned' }, [[sheet('D', 3), 9], [sheet('I', 3), 5]]],
    ['weekly award correction adjusts current activity', { points: -2, mode: 'weekly-earned' }, [[sheet('D', 3), 2], [sheet('I', 3), -2]]],
    ['lifetime balance grant increments F and H', { points: 10, mode: 'balance' }, [[sheet('F', 3), 110], [sheet('H', 3), 104]]],
    ['lifetime balance reversal decrements F and H', { points: -10, mode: 'balance' }, [[sheet('F', 3), 90], [sheet('H', 3), 84]]],
    ['auction spend increments E and G, decrements H', { points: -20, mode: 'auction-spend' }, [[sheet('E', 3), 26], [sheet('G', 3), 50], [sheet('H', 3), 74]]],
    ['empty cells and dash values count as zero', { row: ['Ada', 'A', 'Druid', '-', '', '-', '-', '-', '-'], points: 2, mode: 'weekly-earned' }, [[sheet('D', 3), 2], [sheet('I', 3), 2]]],
    ['comma formatted cells parse as numbers', { row: ['Ada', 'A', 'Druid', '1,000', '2,000', '3,000', '4,000', '5,000'], points: -5, mode: 'auction-spend' }, [[sheet('E', 3), 2005], [sheet('G', 3), 4005], [sheet('H', 3), 4995]]],
  ];
  for (const [label, input, expected] of cases) {
    await t.test(label, () => {
      const updates = buildDkpAdjustmentUpdates({
        rowIndex: 3,
        row: input.row ?? rosterRow,
        points: input.points,
        mode: input.mode,
        sheetName: SHEET,
      });
      assert.deepEqual(updates.map((update) => [update.range, update.values[0][0]]), expected);
    });
  }

  const errorCases = [
    ['reject row below data range', { rowIndex: 2, points: 1, row: rosterRow, mode: 'balance' }, /Invalid Google Sheets roster row/],
    ['reject row beyond data range', { rowIndex: 1001, points: 1, row: rosterRow, mode: 'balance' }, /Invalid Google Sheets roster row/],
    ['reject fractional row index', { rowIndex: 3.5, points: 1, row: rosterRow, mode: 'balance' }, /Invalid Google Sheets roster row/],
    ['reject NaN adjustment', { rowIndex: 3, points: Number.NaN, row: rosterRow, mode: 'balance' }, /finite number/],
    ['reject missing roster record', { rowIndex: 3, points: 1, row: undefined, mode: 'balance' }, /could not be read/],
    ['reject owner changed since bid', { rowIndex: 3, points: -2, row: rosterRow, owner: 'Someone Else', mode: 'auction-spend' }, /roster row 3 changed/],
    ['reject account changed since bid', { rowIndex: 3, points: -2, row: rosterRow, account: 'Other Account', mode: 'auction-spend' }, /roster row 3 changed/],
    ['reject nonnumeric target cell', { rowIndex: 3, points: 1, row: ['Ada', 'A', 'Druid', 'bad'], mode: 'weekly-earned' }, /D3 is not numeric/],
    ['reject positive auction spend', { rowIndex: 3, points: 1, row: rosterRow, mode: 'auction-spend' }, /must not add DKP/],
    ['reject spend below total holds', { rowIndex: 3, points: -90, row: rosterRow, mode: 'balance', heldPoints: 10 }, /below its 10 held auction points/],
    ['reject spending a hold that does not exist', { rowIndex: 3, points: -1, row: rosterRow, mode: 'balance', heldPoints: 0, reservedPointsToConsume: 1 }, /below its 0 held auction points/],
    ['reject negative reservation release', { rowIndex: 3, points: -1, row: rosterRow, mode: 'balance', heldPoints: 10, reservedPointsToConsume: -1 }, /below its 10 held auction points/],
    ['reject release larger than hold', { rowIndex: 3, points: -1, row: rosterRow, mode: 'balance', heldPoints: 10, reservedPointsToConsume: 11 }, /below its 10 held auction points/],
    ['allow balance reduction exactly to remaining holds', { rowIndex: 3, points: -84, row: rosterRow, mode: 'balance', heldPoints: 10 }, null],
    ['allow auction settlement to consume its reservation', { rowIndex: 3, points: -94, row: rosterRow, mode: 'auction-spend', heldPoints: 94, reservedPointsToConsume: 94 }, null],
  ];
  for (const [label, input, expectedError] of errorCases) {
    await t.test(label, () => {
      const run = () => buildDkpAdjustmentUpdates({ ...input, sheetName: SHEET });
      if (expectedError) assert.throws(run, expectedError);
      else assert.doesNotThrow(run);
    });
  }
});

test('bid affordability respects available DKP and reservations', async (t) => {
  const cases = [
    ['zero balance cannot make positive bid', 1, 0, 0, false],
    ['zero balance cannot bid zero', 0, 0, 0, false],
    ['balance covers exact bid', 25, 0, 25, true],
    ['one point below bid is rejected', 25, 0, 24, false],
    ['reservations reduce unspent amount', 10, 10, 19, false],
    ['bid fits after other holds', 10, 10, 20, true],
    ['no held points leaves full balance', 10, 0, 10, true],
    ['negative holds are rejected', 10, -1, 10, false],
    ['negative available is rejected', 1, 0, -1, false],
    ['fractional bid is rejected', 1.5, 0, 5, false],
    ['unsafe integer bid is rejected', Number.MAX_SAFE_INTEGER + 1, 0, Infinity, false],
  ];
  for (const [label, amount, held, available, expected] of cases) {
    await t.test(label, () => assert.equal(canAffordBid(amount, held, available), expected));
  }
});

test('weekly earned totals map awards to the correct roster entries', async (t) => {
  const roster = [
    { rowIndex: 3, owner: 'Ada', account: 'Main' },
    { rowIndex: 4, owner: 'Ada', account: 'Alt' },
    { rowIndex: 5, owner: 'Bea', account: 'Main' },
  ];
  const cases = [
    ['adds multiple awards for one toon', [{ points: 2, participants: [roster[0]] }, { points: 5, participants: [roster[0]] }], [7, 0, 0]],
    ['keeps alt accounts separate', [{ points: 3, participants: [{ owner: 'ada', account: 'ALT' }] }], [0, 3, 0]],
    ['stale participant row resolves by unique account identity', [{ points: 4, participants: [{ ...roster[0], rowIndex: 99 }] }], [4, 0, 0]],
    ['ignores ambiguous legacy identity without row', [{ points: 4, participants: [{ owner: 'Ada', account: 'Main' }] }], [4, 0, 0]],
    ['ignores award for removed record', [{ points: 4, participants: [{ owner: 'Gone', account: 'Old' }] }], [0, 0, 0]],
    ['negative reversal reduces weekly total', [{ points: 5, participants: [roster[2]] }, { points: -2, participants: [roster[2]] }], [0, 0, 3]],
    ['empty award list adds zero to all toons', [], [0, 0, 0]],
  ];
  for (const [label, awards, expected] of cases) {
    await t.test(label, () => {
      assert.deepEqual(addWeeklyEarnedFromAwards(roster, awards).map((record) => record.weeklyEarned), expected);
    });
  }
});

test('account links only resolve to matching roster records', async (t) => {
  const roster = [
    { rowIndex: 3, owner: 'Ada', account: 'Main' },
    { rowIndex: 4, owner: 'Ada', account: 'Alt' },
    { rowIndex: 5, owner: 'Bea', account: 'Main' },
  ];
  const cases = [
    ['exact account link', { sheetRecords: [{ rowIndex: 3, owner: 'Ada', account: 'Main' }] }, [3]],
    ['case and whitespace normalized', { sheetRecords: [{ rowIndex: 3, owner: ' ada ', account: ' MAIN ' }] }, [3]],
    ['stale row falls back to identity', { sheetRecords: [{ rowIndex: 99, owner: 'Ada', account: 'Alt' }] }, [4]],
    ['row reused by another account does not link', { sheetRecords: [{ rowIndex: 3, owner: 'Ada', account: 'Alt' }] }, [4]],
    ['legacy owner link includes all matching accounts', { sheetRecordName: 'ADA' }, [3, 4]],
    ['unknown link resolves to no rows', { sheetRecords: [{ rowIndex: 8, owner: 'Gone', account: 'Old' }] }, []],
    ['empty legacy link resolves to no rows', { sheetRecordName: '' }, []],
  ];
  for (const [label, user, expected] of cases) {
    await t.test(label, () => assert.deepEqual(getLinkedSheetRecordRows(user, roster), expected));
  }
});

test('boss DKP awards validate boss values and roster row selections', async (t) => {
  const bossCases = [
    ['Base', 1], ['Prime', 2], ['Bt', 5], ['Gele', 6], ['Dino', 7], ['Crom', 12],
  ];
  for (const [boss, points] of bossCases) {
    await t.test(`${boss} award is ${points} DKP`, () => assert.equal(BOSS_DKP_POINTS[boss], points));
  }

  const rowCases = [
    ['one valid row', [3], false, true],
    ['several distinct rows', [3, 8, 99], false, true],
    ['empty selection rejected for an award', [], false, false],
    ['empty selection accepted for history edits', [], true, true],
    ['duplicate row rejected', [3, 3], false, false],
    ['fractional row rejected', [3, 3.5], false, false],
    ['string row rejected', ['3'], false, false],
    ['null selection rejected', null, true, false],
    ['object selection rejected', { row: 3 }, false, false],
  ];
  for (const [label, value, allowEmpty, expected] of rowCases) {
    await t.test(label, () => assert.equal(isRosterRowArray(value, allowEmpty), expected));
  }
});

test('weekly award identity disambiguates duplicate roster identities by row', () => {
  const duplicateRoster = [
    { rowIndex: 3, owner: 'Ada', account: 'Main' },
    { rowIndex: 4, owner: 'Ada', account: 'Main' },
  ];
  const result = addWeeklyEarnedFromAwards(duplicateRoster, [{
    points: 6,
    participants: [{ rowIndex: 4, owner: 'Ada', account: 'Main' }],
  }]);
  assert.deepEqual(result.map((record) => record.weeklyEarned), [0, 6]);
});
