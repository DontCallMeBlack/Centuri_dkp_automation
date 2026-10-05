export interface SheetRecordIdentity {
  rowIndex?: number;
  owner: string;
  account: string;
}

interface RosterRecord extends SheetRecordIdentity {
  rowIndex: number;
}

interface UserSheetLinks {
  sheetRecords?: SheetRecordIdentity[];
  sheetRecordName?: string;
}

function normalize(value: string) {
  return value.trim().toLowerCase();
}

export function getSheetRecordKey(record: SheetRecordIdentity) {
  return JSON.stringify([normalize(record.owner), normalize(record.account)]);
}

export function getLinkedSheetRecordRows(user: UserSheetLinks, roster: RosterRecord[]) {
  if (user.sheetRecords?.length) {
    const linkedRows = new Set<number>();
    const legacyRecords = new Set<string>();
    for (const linkedRecord of user.sheetRecords) {
      if (linkedRecord.rowIndex !== undefined) {
        const row = roster.find((record) => record.rowIndex === linkedRecord.rowIndex);
        if (row && getSheetRecordKey(row) === getSheetRecordKey(linkedRecord)) {
          linkedRows.add(row.rowIndex);
          continue;
        }
      }
      legacyRecords.add(getSheetRecordKey(linkedRecord));
    }

    for (const record of roster) {
      if (legacyRecords.has(getSheetRecordKey(record))) linkedRows.add(record.rowIndex);
    }
    return [...linkedRows];
  }

  const legacyOwner = normalize(user.sheetRecordName ?? '');
  if (!legacyOwner) return [];

  return roster
    .filter((record) => normalize(record.owner) === legacyOwner)
    .map((record) => record.rowIndex);
}
