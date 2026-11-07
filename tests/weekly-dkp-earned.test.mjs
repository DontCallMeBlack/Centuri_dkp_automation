import test from 'node:test';
import assert from 'node:assert/strict';
import { addWeeklyEarnedFromAwards } from '../lib/weeklyDkpEarned.ts';
import { getSheetRecordKey } from '../lib/sheetRecordLinks.ts';

// Keep the original calculation as a reference for roster and attendance edge cases.
function referenceWeeklyEarned(roster, weeklyAwards) {
  const weeklyEarnedByRow = new Map();
  for (const award of weeklyAwards) {
    if (!Number.isFinite(award.points)) continue;
    const creditedRows = new Set();
    for (const participant of award.participants) {
      const matches = roster.filter((record) => getSheetRecordKey(record) === getSheetRecordKey(participant));
      const record = matches.find((match) => match.rowIndex === participant.rowIndex)
        ?? (matches.length === 1 ? matches[0] : undefined);
      if (!record || creditedRows.has(record.rowIndex)) continue;
      creditedRows.add(record.rowIndex);
      weeklyEarnedByRow.set(record.rowIndex, (weeklyEarnedByRow.get(record.rowIndex) ?? 0) + award.points);
    }
  }
  return roster.map((record) => ({ ...record, weeklyEarned: weeklyEarnedByRow.get(record.rowIndex) ?? 0 }));
}

test('weekly awards preserve row disambiguation, legacy fallback, deduplication, and roster order', () => {
  const roster = [
    { rowIndex: 8, owner: ' Ada ', account: 'MAIN', weeklyEarned: 999, label: 'first' },
    { rowIndex: 3, owner: 'ada', account: 'main', label: 'second' },
    { rowIndex: 12, owner: 'Bea', account: 'Alt', label: 'third' },
    { rowIndex: 3, owner: 'ADA', account: ' MAIN ', label: 'duplicate row' },
  ];
  const awards = [
    { points: 12, participants: [
      { rowIndex: 3, owner: 'ada', account: 'MAIN' },
      { rowIndex: 3, owner: ' ADA ', account: 'main' },
      { owner: 'Ada', account: 'Main' },
      { rowIndex: 100, owner: 'Ada', account: 'Main' },
      { rowIndex: 8, owner: 'Ada', account: 'Main' },
      { rowIndex: 12, owner: 'wrong owner', account: 'Alt' },
      { owner: ' BEA ', account: 'alt' },
      { rowIndex: 100, owner: 'Bea', account: 'Alt' },
    ] },
    { points: -2, participants: [{ rowIndex: 3, owner: 'Ada', account: 'Main' }] },
    { points: 0.5, participants: [{ owner: 'Bea', account: 'Alt' }] },
  ];
  const before = structuredClone({ roster, awards });
  const result = addWeeklyEarnedFromAwards(roster, awards);
  assert.deepEqual(result.map(({ weeklyEarned }) => weeklyEarned), [12, 10, 12.5, 10]);
  assert.deepEqual(result, referenceWeeklyEarned(roster, awards));
  assert.deepEqual(result.map(({ label }) => label), ['first', 'second', 'third', 'duplicate row']);
  assert.deepEqual({ roster, awards }, before);
  result.forEach((record, index) => assert.notEqual(record, roster[index]));
});

test('nonfinite points are skipped and row-index equality retains its original behavior', () => {
  const roster = [
    { rowIndex: NaN, owner: 'Ada', account: 'Main' },
    { rowIndex: 4, owner: 'Ada', account: 'Main' },
    { rowIndex: NaN, owner: 'Bea', account: 'Alt' },
    { rowIndex: 0, owner: 'Cal', account: 'Main' },
  ];
  const awards = [
    { points: 10, participants: [{ rowIndex: NaN, owner: 'Ada', account: 'Main' }] },
    { points: 2, participants: [{ rowIndex: NaN, owner: 'Bea', account: 'Alt' }] },
    { points: 3, participants: [{ rowIndex: -0, owner: 'Cal', account: 'Main' }] },
    ...[NaN, Infinity, -Infinity].map((points) => ({ points, participants: roster })),
  ];
  assert.deepEqual(addWeeklyEarnedFromAwards(roster, awards), referenceWeeklyEarned(roster, awards));
  assert.deepEqual(addWeeklyEarnedFromAwards(roster, awards).map(({ weeklyEarned }) => weeklyEarned), [2, 0, 2, 3]);
  assert.deepEqual(addWeeklyEarnedFromAwards(roster, []), referenceWeeklyEarned(roster, []));
  assert.deepEqual(addWeeklyEarnedFromAwards([], awards), []);
});

test('indexed weekly awards match the original calculation across deterministic mixed histories', () => {
  let seed = 7654321;
  const random = (max) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % max;
  };
  const names = [
    { owner: 'Ada', account: 'Main' },
    { owner: ' ada ', account: ' MAIN ' },
    { owner: 'Bea', account: 'Alt' },
    { owner: 'A|B', account: 'C' },
    { owner: 'A', account: 'B|C' },
    { owner: '', account: '' },
  ];
  const rows = [3, 3, 8, 12, 16, NaN, Infinity, -0, 0, -Infinity];
  const points = [0, -0, 2, -4, 0.25, 12, NaN, Infinity, -Infinity];
  for (let fixture = 0; fixture < 150; fixture += 1) {
    const roster = Array.from({ length: random(35) }, (_, index) => ({
      ...names[random(names.length)], rowIndex: rows[random(rows.length)], label: `${fixture}:${index}`, weeklyEarned: random(100),
    }));
    const awards = Array.from({ length: random(30) }, () => ({
      points: points[random(points.length)],
      participants: Array.from({ length: random(20) }, () => {
        const identity = names[random(names.length)];
        return random(3) === 0 ? { ...identity } : { ...identity, rowIndex: rows[random(rows.length)] };
      }),
    }));
    assert.deepEqual(addWeeklyEarnedFromAwards(roster, awards), referenceWeeklyEarned(roster, awards), `fixture ${fixture}`);
  }
});
