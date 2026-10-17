import { readDkpCell } from './dkpAccounting.ts';

/** Keep physical row numbers intact, and exclude empty identities before
 * reading template formulas in unused rows. Real toon balances stay strict. */
export function parseSheetRoster(rows: string[][]) {
  return rows.flatMap((row, index) => {
    const owner = String(row[0] ?? '').trim();
    if (!owner) return [];
    const rowIndex = index + 3;
    return [{
      rowIndex, owner, account: String(row[1] ?? '').trim(), subClass: String(row[2] ?? '').trim(),
      weeklyEarned: readDkpCell(row[3], 'D', rowIndex), weeklySpent: readDkpCell(row[4], 'E', rowIndex),
      earned: readDkpCell(row[5], 'F', rowIndex), spent: readDkpCell(row[6], 'G', rowIndex),
      available: readDkpCell(row[7], 'H', rowIndex), fiveWeekActivity: readDkpCell(row[8], 'I', rowIndex),
    }];
  });
}
