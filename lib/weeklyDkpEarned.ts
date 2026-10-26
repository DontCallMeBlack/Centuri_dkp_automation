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
  const weeklyEarnedByRow = new Map<number, number>();
  for (const award of weeklyAwards) {
    if (!Number.isFinite(award.points)) continue;
    const creditedRows = new Set<number>();
    for (const participant of award.participants) {
      const matches = roster.filter((record) =>
        getSheetRecordKey(record) === getSheetRecordKey(participant)
      );
      const record = matches.find((match) => match.rowIndex === participant.rowIndex)
        ?? (matches.length === 1 ? matches[0] : undefined);
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
