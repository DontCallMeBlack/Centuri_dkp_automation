import test from 'node:test';
import assert from 'node:assert/strict';
import { createSheetRecordLinkResolver, getLinkedSheetRecordRows } from '../lib/sheetRecordLinks.ts';

const roster = [
  { rowIndex: 9, owner: 'Ada', account: 'Main' },
  { rowIndex: 3, owner: 'Bea', account: 'Other' },
  { rowIndex: 12, owner: 'Cal', account: 'Main' },
  { rowIndex: 4, owner: 'Ada', account: 'Alt' },
  { rowIndex: 11, owner: ' CAL ', account: ' main ' },
  { rowIndex: 6, owner: 'Dee', account: '' },
];

test('indexed and single-account links preserve identity checks, duplicates and resolution order', () => {
  const resolve = createSheetRecordLinkResolver(roster);
  const cases = [
    [{ sheetRecords: [{ rowIndex: 9, owner: ' ADA ', account: 'main' }] }, [9]],
    [{ sheetRecords: [{ rowIndex: 3, owner: 'Ada', account: 'Main' }] }, [9]],
    [{ sheetRecords: [{ owner: 'cal', account: 'MAIN' }] }, [12, 11]],
    [{ sheetRecords: [{ rowIndex: 12, owner: 'cal', account: 'MAIN' }] }, [12]],
    [{ sheetRecords: [{ rowIndex: 999, owner: 'cal', account: 'MAIN' }] }, [12, 11]],
    [{ sheetRecordName: ' ADA ' }, [9, 4]],
    [{ sheetRecords: [], sheetRecordName: 'Dee' }, [6]],
    [{ sheetRecords: [{ rowIndex: 9, owner: 'Ada', account: 'Main' }, { rowIndex: 9, owner: 'Ada', account: 'Main' }] }, [9]],
    [{ sheetRecords: [{ rowIndex: 3, owner: 'Missing', account: 'Gone' }], sheetRecordName: 'Bea' }, []],
    [{ sheetRecords: [
      { owner: 'Cal', account: 'Main' },
      { rowIndex: 4, owner: 'Ada', account: 'Alt' },
      { owner: 'Ada', account: 'Main' },
    ] }, [4, 9, 12, 11]],
    [{ sheetRecords: [{ rowIndex: 11, owner: 'Cal', account: 'Main' }, { owner: 'Cal', account: 'Main' }] }, [11, 12]],
    [{}, []],
  ];
  const original = structuredClone(roster);
  for (const [user, expected] of cases) {
    assert.deepEqual(resolve(user), expected);
    assert.deepEqual(getLinkedSheetRecordRows(user, roster), expected);
  }
  assert.deepEqual(roster, original);
});

test('duplicate physical rows retain first-match checks and owner-fallback duplicates', () => {
  const duplicateRows = [
    { rowIndex: 3, owner: 'Ada', account: 'Main' },
    { rowIndex: 3, owner: 'Bea', account: 'Alt' },
    { rowIndex: 4, owner: 'Bea', account: 'Alt' },
    { rowIndex: 3, owner: 'Ada', account: 'Duplicate' },
  ];
  const resolve = createSheetRecordLinkResolver(duplicateRows);
  const account = { sheetRecords: [{ rowIndex: 3, owner: 'Bea', account: 'Alt' }] };
  assert.deepEqual(resolve(account), [3, 4]);
  assert.deepEqual(resolve({ sheetRecordName: 'Ada' }), [3, 3]);
  assert.deepEqual(resolve(account), getLinkedSheetRecordRows(account, duplicateRows));
});

test('verified modern links avoid serializing unrelated roster identities', () => {
  const unrelated = { rowIndex: 4, owner: 'Other' };
  Object.defineProperty(unrelated, 'account', { get() { throw new Error('Unrelated identity should not be read'); } });
  const records = [{ rowIndex: 3, owner: 'Ada', account: 'Main' }, unrelated];
  const user = { sheetRecords: [{ rowIndex: 3, owner: 'Ada', account: 'Main' }] };
  assert.deepEqual(getLinkedSheetRecordRows(user, records), [3]);
  assert.deepEqual(createSheetRecordLinkResolver(records)(user), [3]);
});

test('resolvers keep results private and are rebuilt for later roster snapshots', () => {
  const user = { sheetRecordName: 'Ada' };
  const resolve = createSheetRecordLinkResolver(roster);
  resolve(user).push(999);
  assert.deepEqual(resolve(user), [9, 4]);
  assert.deepEqual(createSheetRecordLinkResolver([{ rowIndex: 20, owner: 'Ada', account: 'Main' }])(user), [20]);
  const modern = { sheetRecords: [{ rowIndex: 9, owner: 'Ada', account: 'Main' }] };
  assert.deepEqual(resolve(modern), [9]);
  modern.sheetRecords = [{ rowIndex: 4, owner: 'Ada', account: 'Alt' }];
  assert.deepEqual(resolve(modern), [4]);
  assert.deepEqual(createSheetRecordLinkResolver([])(user), []);
});
