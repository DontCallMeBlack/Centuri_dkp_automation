import BossAward from '@/lib/models/BossAward';
import { getDkpCycleRange } from '@/lib/dkpCycle';
import { getSheetRecordKey } from '@/lib/sheetRecordLinks';

export interface WeeklyRosterRecord {
  rowIndex: number;
  owner: string;
  account: string;
}

export async function getRosterWithWeeklyEarned<T extends WeeklyRosterRecord>(roster: T[]) {
  const { start, end } = getDkpCycleRange();
  const weeklyAwards = await BossAward.find({
    status: 'applied',
    createdAt: { $gte: start, $lt: end },
  }).select('points participants').lean();

  const weeklyEarnedByRow = new Map<number, number>();
  for (const award of weeklyAwards) {
    for (const participant of award.participants) {
      const matches = roster.filter((record) =>
        getSheetRecordKey(record) === getSheetRecordKey(participant)
      );
      const record = matches.find((match) => match.rowIndex === participant.rowIndex)
        ?? (matches.length === 1 ? matches[0] : undefined);
      if (!record) continue;

      weeklyEarnedByRow.set(
        record.rowIndex,
        (weeklyEarnedByRow.get(record.rowIndex) ?? 0) + award.points,
      );
    }
  }

  return roster.map((record) => ({
    ...record,
    weeklyEarned: weeklyEarnedByRow.get(record.rowIndex) ?? 0,
  }));
}
