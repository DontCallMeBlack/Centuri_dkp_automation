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

function normalize(value: unknown) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
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

    if (legacyRecords.size) {
      for (const record of roster) {
        if (legacyRecords.has(getSheetRecordKey(record))) linkedRows.add(record.rowIndex);
      }
    }
    return [...linkedRows];
  }

  const legacyOwner = normalize(user.sheetRecordName ?? '');
  if (!legacyOwner) return [];

  return roster
    .filter((record) => normalize(record.owner) === legacyOwner)
    .map((record) => record.rowIndex);
}

/** Resolve multiple accounts against one unchanged roster snapshot. Keep this
 * resolver local to the read/transaction so later requests see current links.
 */
export function createSheetRecordLinkResolver(roster: RosterRecord[]) {
  const rowsByIndex = new Map<number, RosterRecord>();
  for (const record of roster) {
    // A malformed duplicate row must retain Array.find's first-match behavior.
    if (!rowsByIndex.has(record.rowIndex)) rowsByIndex.set(record.rowIndex, record);
  }
  const keys = new Map<RosterRecord, string>();
  const keyFor = (record: RosterRecord) => {
    let key = keys.get(record);
    if (key === undefined) { key = getSheetRecordKey(record); keys.set(record, key); }
    return key;
  };
  let identities: Map<string, Array<{ rowIndex: number; position: number }>> | undefined;
  let owners: Map<string, number[]> | undefined;

  return (user: UserSheetLinks): number[] => {
    if (user.sheetRecords?.length) {
      const linkedRows = new Set<number>();
      const legacyRecords = new Set<string>();
      for (const linkedRecord of user.sheetRecords) {
        const key = getSheetRecordKey(linkedRecord);
        const row = linkedRecord.rowIndex === undefined ? undefined : rowsByIndex.get(linkedRecord.rowIndex);
        if (row && keyFor(row) === key) linkedRows.add(row.rowIndex);
        else legacyRecords.add(key);
      }
      if (legacyRecords.size) {
        if (!identities) {
          identities = new Map();
          roster.forEach((record, position) => {
            const key = keyFor(record);
            const matches = identities!.get(key);
            const match = { rowIndex: record.rowIndex, position };
            if (matches) matches.push(match);
            else identities!.set(key, [match]);
          });
        }
        // Legacy matches follow roster order, after explicitly verified rows.
        const matches = [...legacyRecords].flatMap((key) => identities!.get(key) ?? []);
        matches.sort((first, second) => first.position - second.position);
        for (const match of matches) linkedRows.add(match.rowIndex);
      }
      return [...linkedRows];
    }

    const owner = normalize(user.sheetRecordName ?? '');
    if (!owner) return [];
    if (!owners) {
      owners = new Map();
      for (const record of roster) {
        const key = normalize(record.owner);
        const rows = owners.get(key);
        if (rows) rows.push(record.rowIndex);
        else owners.set(key, [record.rowIndex]);
      }
    }
    return [...(owners.get(owner) ?? [])];
  };
}
