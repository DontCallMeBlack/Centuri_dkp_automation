import ToonRoleChange from '@/lib/models/ToonRoleChange';
import ToonRoleChangeRequest from '@/lib/models/ToonRoleChangeRequest';

async function readSchedules(identities: string[]) {
  const roleChanges = identities.length
    ? await ToonRoleChange.find({ identityKey: { $in: identities } }).lean()
    : [];
  // Without a scheduled role and effective date, no approval can affect the
  // displayed role. Keep the existing approval verification in each caller.
  const scheduledIdentities = roleChanges
    .filter((change) => change.scheduledRole && change.effectiveAt)
    .map((change) => change.identityKey);
  const roleApprovals = scheduledIdentities.length
    ? await ToonRoleChangeRequest.find({
      identityKey: { $in: scheduledIdentities }, status: { $in: ['approved', 'applied'] },
      decidedByUserId: { $exists: true }, decidedAt: { $exists: true },
    }).sort({ createdAt: -1 }).lean()
    : [];
  return { roleChanges, roleApprovals };
}

const pending = new Map<string, ReturnType<typeof readSchedules>>();

/** Display reads only: share concurrent work, never retain completed results.
 * Financial/transactional reads must continue using their own session queries.
 */
export function readToonRoleSchedules(identityKeys: string[]) {
  const identities = [...new Set(identityKeys)].sort();
  const key = JSON.stringify(identities);
  const existing = pending.get(key);
  if (existing) return existing;
  const request = readSchedules(identities).finally(() => {
    if (pending.get(key) === request) pending.delete(key);
  });
  pending.set(key, request);
  return request;
}
