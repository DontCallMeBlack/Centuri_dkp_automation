import { DkpIntegrityError, readDkpCell } from './dkpAccounting.ts';

export const DKP_COLUMNS = { weeklyEarned: 'D', weeklySpent: 'E', earned: 'F', spent: 'G', available: 'H', fiveWeekActivity: 'I' } as const;
export type DkpField = keyof typeof DKP_COLUMNS;
export interface DkpCellIssue { field: DkpField; cell: string; value: string; message: string }
interface RosterIdentity { rowIndex: number; owner: string; account: string; subClass: string }
export type ReadableRosterRecord = RosterIdentity & Record<DkpField, number | null> & { dkpIssues: DkpCellIssue[] };
export type StrictRosterRecord = RosterIdentity & Record<DkpField, number> & { dkpIssues: DkpCellIssue[] };

export function requireRosterValues<K extends DkpField>(record: ReadableRosterRecord, fields: readonly K[]): asserts record is ReadableRosterRecord & Record<K, number> {
  for (const field of fields) {
    const issue = record.dkpIssues.find((entry) => entry.field === field);
    if (issue) throw new DkpIntegrityError(issue.message);
    if (typeof record[field] !== 'number' || !Number.isFinite(record[field])) {
      throw new DkpIntegrityError(`DKP cell ${DKP_COLUMNS[field]}${record.rowIndex} is unavailable. Correct it in Google Sheets before using this toon for this action.`);
    }
  }
}

/** Keep physical row numbers intact, and exclude empty identities before
 * reading template formulas in unused rows. Real toon balances stay strict. */
export function parseSheetRoster(rows: string[][]): StrictRosterRecord[];
export function parseSheetRoster(rows: string[][], options: { allowInvalid: true }): ReadableRosterRecord[];
export function parseSheetRoster(rows: string[][], options?: { allowInvalid: true }): ReadableRosterRecord[] {
  return rows.flatMap((row, index) => {
    const owner = String(row[0] ?? '').trim();
    if (!owner) return [];
    const rowIndex = index + 3;
    const dkpIssues: DkpCellIssue[] = [];
    const read = (field: DkpField, index: number) => {
      try { return readDkpCell(row[index], DKP_COLUMNS[field], rowIndex); }
      catch (error) {
        if (!options?.allowInvalid || !(error instanceof DkpIntegrityError)) throw error;
        dkpIssues.push({ field, cell: `${DKP_COLUMNS[field]}${rowIndex}`, value: String(row[index] ?? '').slice(0, 100), message: error.message });
        return null;
      }
    };
    return [{
      rowIndex, owner, account: String(row[1] ?? '').trim(), subClass: String(row[2] ?? '').trim(),
      weeklyEarned: read('weeklyEarned', 3), weeklySpent: read('weeklySpent', 4),
      earned: read('earned', 5), spent: read('spent', 6), available: read('available', 7), fiveWeekActivity: read('fiveWeekActivity', 8), dkpIssues,
    }];
  });
}
