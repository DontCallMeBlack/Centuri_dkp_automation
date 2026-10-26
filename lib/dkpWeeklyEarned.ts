import BossAward from '@/lib/models/BossAward';
import ToonDkpReset from '@/lib/models/ToonDkpReset';
import { getPreviousDkpWeekRange } from '@/lib/dkpCycle';
import { addWeeklyEarnedFromAwards, type WeeklyRosterRecord } from './weeklyDkpEarned';
import { getSheetRecordKey } from './sheetRecordLinks';
import type { ClientSession } from 'mongoose';
export { addWeeklyEarnedFromAwards } from './weeklyDkpEarned';
export type { WeeklyRosterRecord } from './weeklyDkpEarned';

/** Calculates completed-week DKP for auction activity and eligibility. */
export async function getRosterWithWeeklyEarned<T extends WeeklyRosterRecord>(roster: T[], session?: ClientSession) {
  const { start, end } = getPreviousDkpWeekRange();
  const awardQuery = BossAward.find({
    // An interrupted attendance edit still owns its original credited award
    // until the replacement participants are finalized atomically.
    status: { $in: ['applied', 'updating'] },
    createdAt: { $gte: start, $lt: end },
  }).select('points participants createdAt');
  if (session) awardQuery.session(session);
  const weeklyAwards = await awardQuery.lean();
  const resetQuery = ToonDkpReset.find({ identityKey: { $in: roster.map(getSheetRecordKey) } })
    .select('identityKey resetAt');
  if (session) resetQuery.session(session);
  const resets = await resetQuery.lean();
  const resetAtByIdentity = new Map(resets.map((reset) => [reset.identityKey, reset.resetAt.getTime()]));
  const adjustedAwards = weeklyAwards.map((award) => ({
    ...award,
    participants: award.participants.filter((participant) => {
      const resetAt = resetAtByIdentity.get(getSheetRecordKey(participant));
      return resetAt === undefined || award.createdAt.getTime() > resetAt;
    }),
  }));

  return addWeeklyEarnedFromAwards(roster, adjustedAwards);
}
