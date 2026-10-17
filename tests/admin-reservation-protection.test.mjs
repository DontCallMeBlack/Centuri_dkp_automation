import test from 'node:test';
import assert from 'node:assert/strict';
import { getChangedLinkIdentities, getReservationConflict } from '../lib/auth/reservationProtection.ts';

const ada = { rowIndex: 3, owner: 'Ada', account: 'Main' };
const movedAda = { ...ada, rowIndex: 8 };
const adaAlt = { rowIndex: 4, owner: 'Ada', account: 'Alt' };
const bea = { rowIndex: 9, owner: 'Bea', account: 'Main' };
const hold = (record, heldPoints = 10) => ({ ...record, heldPoints });
const auction = (bid, status = 'active', deliveryStatus = 'not-required') => ({
  status, deliveryStatus, ...(status === 'completed' ? { winner: bid } : { highBid: bid }),
});

test('moved toon holds block both unlinking and adopting its new row by stable identity', () => {
  assert.equal(getReservationConflict({ identities: [movedAda] }, [hold(ada)], []), 'reserved-toon');
  assert.equal(getReservationConflict({ identities: [{ ...movedAda, owner: ' ADA ', account: 'main' }] }, [hold(ada)], []), 'reserved-toon');
  assert.equal(getReservationConflict({ identities: [movedAda], rejectUnverifiedLegacyHolds: true }, [hold(ada)], []), 'reserved-toon');
});

test('old and current row IDs both protect unidentified legacy reservations', () => {
  const subject = { identities: [ada, movedAda] };
  assert.equal(getReservationConflict(subject, [hold({ rowIndex: 3 })], []), 'reserved-toon');
  assert.equal(getReservationConflict(subject, [hold({ rowIndex: 8 })], []), 'reserved-toon');
  assert.equal(getReservationConflict(subject, [], [auction({ rowIndex: 3 })]), 'reserved-toon');
  assert.equal(getReservationConflict(subject, [], [auction({ rowIndex: 8 }, 'completed', 'pending')]), 'reserved-toon');
});

test('all unfinished bid states protect the original identity after a row move', () => {
  for (const status of ['active', 'settling', 'settlement-failed', 'removing']) {
    assert.equal(getReservationConflict({ identities: [movedAda] }, [], [auction(ada, status)]), 'reserved-toon');
  }
  assert.equal(getReservationConflict({ identities: [movedAda] }, [], [auction(ada, 'completed', 'pending')]), 'reserved-toon');
  assert.equal(getReservationConflict({ identities: [movedAda] }, [], [auction(ada, 'completed', 'done')]), null);
  assert.equal(getReservationConflict({ identities: [movedAda] }, [], [auction(ada, 'completed', 'banked')]), null);
});

test('row metadata refreshes do not count as granting or relinquishing an existing identity', () => {
  assert.deepEqual(getChangedLinkIdentities([ada, movedAda], [movedAda]), { removed: [], added: [] });
  const change = getChangedLinkIdentities([ada, movedAda], [movedAda, bea]);
  assert.deepEqual(change.removed, []);
  assert.deepEqual(change.added, [bea]);
  assert.equal(getReservationConflict({ identities: change.added, rejectUnverifiedLegacyHolds: true }, [hold(ada)], []), null);
});

test('replacing a toon protects old identities absent from the current roster', () => {
  const change = getChangedLinkIdentities([ada], [bea]);
  assert.deepEqual(change, { removed: [ada], added: [bea] });
  assert.equal(getReservationConflict({ identities: change.removed }, [hold(movedAda)], []), 'reserved-toon');
  assert.equal(getReservationConflict({ identities: change.removed }, [], [auction(movedAda, 'completed', 'pending')]), 'reserved-toon');
});

test('orphan holds block new assignments and ambiguous legacy holds fail closed', () => {
  assert.equal(getReservationConflict({ identities: [movedAda], rejectUnverifiedLegacyHolds: true }, [hold(ada)], []), 'reserved-toon');
  assert.equal(getReservationConflict({ identities: [bea], rejectUnverifiedLegacyHolds: true }, [hold({ rowIndex: 50 })], []), 'unverified-legacy-hold');
  assert.equal(getReservationConflict({ identities: [bea], rejectUnverifiedLegacyHolds: true }, [hold({ rowIndex: 50, owner: 'Ada' })], []), 'unverified-legacy-hold');
  assert.equal(getReservationConflict({ identities: [bea], rejectUnverifiedLegacyHolds: true }, [hold({ rowIndex: 50, owner: '', account: '' })], []), 'unverified-legacy-hold');
  assert.equal(getReservationConflict({ identities: [bea], rejectUnverifiedLegacyHolds: true }, [hold({ rowIndex: 50 }, 0)], []), null);
});

test('one owner has distinct toon identities and released reservations do not block changes', () => {
  assert.equal(getReservationConflict({ identities: [adaAlt] }, [hold(ada)], [auction(ada)]), null);
  assert.equal(getReservationConflict({ identities: [movedAda] }, [hold(ada, 0)], []), null);
  assert.equal(getReservationConflict({ identities: [movedAda] }, [hold(ada, -10)], []), 'reserved-toon');
});

test('owner-wide legacy removals protect missing toons while retaining unchanged identities', () => {
  const subject = { identities: [], legacyOwners: [' ADA '], ignoredIdentities: [movedAda] };
  assert.equal(getReservationConflict(subject, [hold(ada)], [auction(ada)]), null);
  assert.equal(getReservationConflict(subject, [hold(adaAlt)], []), 'reserved-toon');
  assert.equal(getReservationConflict(subject, [], [auction(adaAlt, 'completed', 'pending')]), 'reserved-toon');
  assert.equal(getReservationConflict({ identities: [], legacyOwners: ['Ada'] }, [hold(adaAlt)], []), 'reserved-toon');
});
