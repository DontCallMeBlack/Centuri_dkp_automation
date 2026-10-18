import { getLinkedSheetRecordRows, type SheetRecordIdentity } from '../sheetRecordLinks.ts';

interface LinkedAccount {
  sheetRecords?: SheetRecordIdentity[];
  sheetRecordName?: string;
}

/** Release obsolete physical-row keys only when stable identities still grant
 * exactly the same toon access. The unique row index needs this release to
 * commit before a later transaction can assign the freed row. */
export function planStaleRowReferenceRelease(
  account: LinkedAccount,
  roster: Array<SheetRecordIdentity & { rowIndex: number }>,
  requestedRows: number[],
) {
  if (!account.sheetRecords?.length) return null;
  const requested = new Set(requestedRows);
  const before = getLinkedSheetRecordRows(account, roster);
  // Actual ownership is never released by this metadata repair.
  if (before.some((row) => requested.has(row))) return null;
  if (!account.sheetRecords.some((record) => record.rowIndex !== undefined && requested.has(record.rowIndex))) return null;
  const withoutRows = account.sheetRecords.map(({ owner, account }) => ({ owner, account }));
  const after = getLinkedSheetRecordRows({ sheetRecords: withoutRows }, roster);
  if (before.length !== after.length || before.some((row) => !after.includes(row))) return null;
  return { before, records: withoutRows };
}
