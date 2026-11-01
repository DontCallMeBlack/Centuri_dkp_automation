import { DkpIntegrityError, getDkpReplayState, type DkpCellSnapshot } from './dkpAccounting.ts';
import { getSheetRecordKey } from './sheetRecordLinks.ts';

export interface ToonOwnerChange {
  rowIndex: number;
  account: string;
  beforeOwner: string;
  afterOwner: string;
}

export function planToonOwnerChange(
  record: { rowIndex: number; owner: string; account: string },
  owner: string,
  roster: Array<{ rowIndex: number; owner: string; account: string }>,
): ToonOwnerChange | undefined {
  if (!owner.trim() || owner.length > 80 || /[\u0000-\u001f\u007f]/.test(owner)) {
    throw new DkpIntegrityError('The receiving account has an invalid owner name.');
  }
  const targetKey = getSheetRecordKey({ owner, account: record.account });
  if (roster.some((entry) => entry.rowIndex !== record.rowIndex && getSheetRecordKey(entry) === targetKey)) {
    throw new DkpIntegrityError('The receiving member already has a toon with this name. Resolve the duplicate before transferring.');
  }
  return record.owner === owner ? undefined : {
    rowIndex: record.rowIndex, account: record.account, beforeOwner: record.owner, afterOwner: owner,
  };
}

/** Accept only the saved before/after owner on the original toon row. This
 * handles an acknowledged or interrupted RAW Sheets batch without double reset.
 */
export function ownerChangeReplayUpdates(change: ToonOwnerChange | undefined, rows: string[][]) {
  if (!change) return [];
  if (!Number.isInteger(change.rowIndex) || change.rowIndex < 3 || change.rowIndex > 1000 ||
    !change.beforeOwner || !change.afterOwner || !change.afterOwner.trim() || change.afterOwner.length > 80 ||
    typeof change.account !== 'string') throw new DkpIntegrityError('The saved transfer owner change is invalid.');
  const row = rows[change.rowIndex - 3];
  if (!row || String(row[1] ?? '').trim() !== change.account || ![change.beforeOwner, change.afterOwner].includes(String(row[0] ?? '').trim())) {
    throw new DkpIntegrityError('The transferred toon row or owner changed. Reconcile the Sheet before retrying.');
  }
  return row[0] === change.afterOwner ? [] : [{
    range: `'DKP_Sheet_automated'!A${change.rowIndex}`, values: [[change.afterOwner]],
  }];
}

export function planOwnerMutationReplay(
  change: ToonOwnerChange,
  identities: Array<{ rowIndex: number; owner: string; account: string }> | undefined,
  before: DkpCellSnapshot[], after: DkpCellSnapshot[], rows: string[][],
) {
  const ownerUpdates = ownerChangeReplayUpdates(change, rows);
  if (!identities?.length || !identities.some((identity) => identity.rowIndex === change.rowIndex &&
    identity.owner === change.beforeOwner && identity.account === change.account)) {
    throw new DkpIntegrityError('The saved owner change does not match its DKP mutation identity.');
  }
  for (const identity of identities) {
    const row = rows[identity.rowIndex - 3];
    const expected = identity.rowIndex === change.rowIndex ? { ...identity, owner: String(row?.[0] ?? '').trim() } : identity;
    if (!row || getSheetRecordKey({ owner: row[0] ?? '', account: row[1] ?? '' }) !== getSheetRecordKey(expected)) {
      throw new DkpIntegrityError('A roster row moved during an interrupted transfer.');
    }
  }
  const state = getDkpReplayState(before, after, rows);
  if (String(rows[change.rowIndex - 3][0]).trim() === change.afterOwner && state !== 'applied') {
    throw new DkpIntegrityError('The transfer owner and DKP snapshot do not match. Reconcile the Sheet before retrying.');
  }
  return [...(state === 'pending' ? after : []), ...ownerUpdates];
}
