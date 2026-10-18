import BossAward from '@/lib/models/BossAward';
import { getPreviousDkpWeekRange } from '@/lib/dkpCycle';
import { addWeeklyEarnedFromAwards, type WeeklyRosterRecord } from './weeklyDkpEarned';
export { addWeeklyEarnedFromAwards } from './weeklyDkpEarned';
export type { WeeklyRosterRecord } from './weeklyDkpEarned';

/** Calculates completed-week DKP for auction activity and eligibility. */
export async function getRosterWithWeeklyEarned<T extends WeeklyRosterRecord>(roster: T[]) {
  const { start, end } = getPreviousDkpWeekRange();
  const weeklyAwards = await BossAward.find({
    // An interrupted attendance edit still owns its original credited award
    // until the replacement participants are finalized atomically.
    status: { $in: ['applied', 'updating'] },
    createdAt: { $gte: start, $lt: end },
  }).select('points participants').lean();

  return addWeeklyEarnedFromAwards(roster, weeklyAwards);
}
