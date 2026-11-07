import { getSheetRecordKey } from './sheetRecordLinks.ts';

export interface WeeklyRosterRecord {
  rowIndex: number;
  owner: string;
  account: string;
}

export interface WeeklyAwardRecord {
  points: number;
  participants: Array<{ rowIndex?: number; owner: string; account: string }>;
}

export function addWeeklyEarnedFromAwards<T extends WeeklyRosterRecord>(roster: T[], weeklyAwards: WeeklyAwardRecord[]) {
  if (!weeklyAwards.length) return roster.map((record) => ({ ...record, weeklyEarned: 0 }));

  const rosterByIdentity = new Map<string, { first: T; count: number; byRow: Map<number | undefined, T> }>();
  for (const record of roster) {
    const key = getSheetRecordKey(record);
    let matches = rosterByIdentity.get(key);
    if (!matches) {
      matches = { first: record, count: 0, byRow: new Map() };
      rosterByIdentity.set(key, matches);
    }
    matches.count += 1;
    // Preserve the first matching row and the original strict row-index comparison.
    if (!Number.isNaN(record.rowIndex) && !matches.byRow.has(record.rowIndex)) {
      matches.byRow.set(record.rowIndex, record);
    }
  }

  const weeklyEarnedByRow = new Map<number, number>();
  for (const award of weeklyAwards) {
    if (!Number.isFinite(award.points)) continue;
    const creditedRows = new Set<number>();
    for (const participant of award.participants) {
      const matches = rosterByIdentity.get(getSheetRecordKey(participant));
      const record = matches?.byRow.get(participant.rowIndex)
        ?? (matches?.count === 1 ? matches.first : undefined);
      if (!record || creditedRows.has(record.rowIndex)) continue;
      creditedRows.add(record.rowIndex);

      const currentWeeklyEarned = weeklyEarnedByRow.get(record.rowIndex) ?? 0;
      weeklyEarnedByRow.set(
        record.rowIndex,
        currentWeeklyEarned + award.points,
      );
    }
  }

  return roster.map((record) => ({
    ...record,
    weeklyEarned: weeklyEarnedByRow.get(record.rowIndex) ?? 0,
  }));
}
