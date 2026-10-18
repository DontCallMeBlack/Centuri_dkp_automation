import test from 'node:test';
import assert from 'node:assert/strict';
import { planStaleRowReferenceRelease } from '../lib/auth/staleRowReferences.ts';

const roster = [
  { rowIndex: 18, owner: 'dontcallmeblack', account: 'dontcallmeblack' },
  { rowIndex: 19, owner: 'dontcallmeblack', account: 'Xeops' },
  { rowIndex: 20, owner: 'druidprov66', account: 'khuno' },
  { rowIndex: 21, owner: 'druidprov66', account: 'nines' },
];

test('moved sheet rows release stale index keys while preserving Dpro toon identities', () => {
  assert.deepEqual(planStaleRowReferenceRelease({ sheetRecords: [
    { rowIndex: 19, owner: 'druidprov66', account: 'khuno' },
    { rowIndex: 20, owner: 'druidprov66', account: 'nines' },
  ] }, roster, [18, 19]), {
    before: [20, 21], records: [
      { owner: 'druidprov66', account: 'khuno' },
      { owner: 'druidprov66', account: 'nines' },
    ],
  });
});

test('actual toon ownership is never released', () => {
  assert.equal(planStaleRowReferenceRelease({ sheetRecords: [roster[1]] }, roster, [19]), null);
});

test('owner-wide legacy links are not changed', () => {
  assert.equal(planStaleRowReferenceRelease({ sheetRecordName: 'dontcallmeblack' }, roster, [19]), null);
});

test('unrelated stored row references are untouched', () => {
  assert.equal(planStaleRowReferenceRelease({ sheetRecords: [
    { rowIndex: 20, owner: 'druidprov66', account: 'nines' },
  ] }, roster, [19]), null);
});

test('repair is refused when removing row metadata would broaden access to duplicate toons', () => {
  const ambiguous = [...roster, { ...roster[3], rowIndex: 22 }];
  assert.equal(planStaleRowReferenceRelease({ sheetRecords: [
    { rowIndex: 19, owner: 'druidprov66', account: 'khuno' }, roster[3],
  ] }, ambiguous, [19]), null);
});

test('already repaired identity-only links do not need another release', () => {
  assert.equal(planStaleRowReferenceRelease({ sheetRecords: [
    { owner: 'druidprov66', account: 'khuno' },
  ] }, roster, [19]), null);
});
