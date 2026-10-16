import BossAward from '@/lib/models/BossAward';
import { getPreviousDkpWeekRange } from '@/lib/dkpCycle';
import { addWeeklyEarnedFromAwards, type WeeklyRosterRecord } from './weeklyDkpEarned';
export { addWeeklyEarnedFromAwards } from './weeklyDkpEarned';
export type { WeeklyRosterRecord } from './weeklyDkpEarned';

/** Calculates completed-week DKP for auction activity and eligibility. */
export async function getRosterWithWeeklyEarned<T extends WeeklyRosterRecord>(roster: T[]) {
  const { start, end } = getPreviousDkpWeekRange();
  const weeklyAwards = await BossAward.find({
    status: 'applied',
    createdAt: { $gte: start, $lt: end },
  }).select('points participants').lean();

  return addWeeklyEarnedFromAwards(roster, weeklyAwards);
}
