import test from 'node:test';
import assert from 'node:assert/strict';
import { planToonOwnerChange, ownerChangeReplayUpdates, planOwnerMutationReplay } from '../lib/toonOwnerChange.ts';
import { snapshotDkpCells, DkpIntegrityError } from '../lib/dkpAccounting.ts';

const record = { rowIndex: 3, owner: 'Old Member', account: 'Healsbeast' };
const change = planToonOwnerChange(record, 'New Member', [record]);
const row = () => ['Old Member', 'Healsbeast', 'Support Druid', '10', '2', '100', '20', '80', '9'];
const zeros = ['D', 'E', 'F', 'G', 'H', 'I'].map(column => ({ range: `'DKP_Sheet_automated'!${column}3`, values: [[0]] }));
const apply = (updates, rows) => {
  for (const update of updates) {
    const [, column, rowNumber] = /!([A-I])(\d+)$/.exec(update.range);
    rows[Number(rowNumber) - 3][column.charCodeAt(0) - 65] = String(update.values[0][0]);
  }
};

test('owner and all six DKP cells change in the same RAW batch; toon and role stay unchanged', () => {
  const rows = [row()];
  const before = snapshotDkpCells(zeros, rows);
  const updates = planOwnerMutationReplay(change, [record], before, zeros, rows);
  assert.equal(updates.length, 7);
  apply(updates, rows);
  assert.deepEqual(rows[0], ['New Member', 'Healsbeast', 'Support Druid', '0', '0', '0', '0', '0', '0']);
  assert.deepEqual(planOwnerMutationReplay(change, [record], before, zeros, rows), [], 'acknowledged/retried batch is not repeated');
});

test('a toon already at zero still receives the new owner', () => {
  const rows = [['Old Member', 'Healsbeast', 'Support Druid', '0', '0', '0', '0', '0', '0']];
  const before = snapshotDkpCells(zeros, rows);
  assert.deepEqual(planOwnerMutationReplay(change, [record], before, zeros, rows), [
    { range: "'DKP_Sheet_automated'!A3", values: [['New Member']] },
  ]);
});

test('recovery refuses a reused/moved row, different owner, or changed DKP', () => {
  const before = snapshotDkpCells(zeros, [row()]);
  for (const mutation of [r => { r[0] = 'Unrelated member'; }, r => { r[1] = 'Other toon'; }, r => { r[7] = '999'; }]) {
    const rows = [row()]; mutation(rows[0]);
    assert.throws(() => planOwnerMutationReplay(change, [record], before, zeros, rows), DkpIntegrityError);
  }
  assert.throws(() => planOwnerMutationReplay(change, [{ ...record, rowIndex: 4 }], before, zeros, [row()]), DkpIntegrityError);
});

test('an owner-only external edit cannot authorize resetting the new owner’s balances', () => {
  const before = snapshotDkpCells(zeros, [row()]);
  const rows = [row()]; rows[0][0] = 'New Member';
  assert.throws(() => planOwnerMutationReplay(change, [record], before, zeros, rows), /owner and DKP snapshot/);
});

test('undo restores both previous owner and exact saved values, and is replay-safe', () => {
  const original = row();
  const rows = [row()];
  apply(planOwnerMutationReplay(change, [record], snapshotDkpCells(zeros, rows), zeros, rows), rows);
  const undoRecord = { ...record, owner: 'New Member' };
  const undoChange = planToonOwnerChange(undoRecord, 'Old Member', [undoRecord]);
  const restore = zeros.map((update, index) => ({ range: update.range, values: [[Number(original[index + 3])]] }));
  const beforeUndo = snapshotDkpCells(restore, rows);
  apply(planOwnerMutationReplay(undoChange, [undoRecord], beforeUndo, restore, rows), rows);
  assert.deepEqual(rows[0], original);
  assert.deepEqual(planOwnerMutationReplay(undoChange, [undoRecord], beforeUndo, restore, rows), []);
});

test('recipient-name collisions are rejected, but other toon names and unchanged owners are allowed', () => {
  assert.throws(() => planToonOwnerChange(record, 'New Member', [record, { rowIndex: 4, owner: 'new member', account: 'Healsbeast' }]), /duplicate/);
  assert.ok(planToonOwnerChange(record, 'New Member', [record, { rowIndex: 4, owner: 'New Member', account: 'Tank' }]));
  assert.equal(planToonOwnerChange(record, 'Old Member', [record]), undefined);
  for (const owner of ['', ' ', 'a'.repeat(81), 'New\nMember']) assert.throws(() => planToonOwnerChange(record, owner, [record]));
});

test('legacy mutations need no owner update; harmless Sheet whitespace is recognized', () => {
  assert.deepEqual(ownerChangeReplayUpdates(undefined, [row()]), []);
  const padded = row(); padded[0] = ' Old Member '; padded[1] = ' Healsbeast ';
  assert.equal(ownerChangeReplayUpdates(change, [padded])[0].values[0][0], 'New Member');
});
