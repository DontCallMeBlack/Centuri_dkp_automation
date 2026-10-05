export interface SheetRecordIdentity {
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
    const linkedRecords = new Set(user.sheetRecords.map(getSheetRecordKey));
    return roster
      .filter((record) => linkedRecords.has(getSheetRecordKey(record)))
      .map((record) => record.rowIndex);
  }

  const legacyOwner = normalize(user.sheetRecordName ?? '');
  if (!legacyOwner) return [];

  return roster
    .filter((record) => normalize(record.owner) === legacyOwner)
    .map((record) => record.rowIndex);
}
