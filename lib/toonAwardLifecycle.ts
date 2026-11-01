import type { ClientSession } from 'mongoose';
import RosterMutation from '@/lib/models/RosterMutation';
import { getSheetRecordKey } from './sheetRecordLinks.ts';

type ToonIdentity = { owner: string; account: string };

/** Re-added names are usable, but awards forfeited in a previous stay are not. */
export async function readToonAwardCutoffs(identities: ToonIdentity[], session?: ClientSession) {
  if (identities.length === 0) return new Map<string, number>();
  const query = RosterMutation.find({
    spreadsheetId: process.env.GOOGLE_SHEET_ID?.trim(),
    identityKey: { $in: [...new Set(identities.map(getSheetRecordKey))] },
    $or: [{ action: 'create' }, { action: 'remove', restoredAt: { $exists: false } }],
  }).select('identityKey createdAt');
  if (session) query.session(session);
  const mutations = await query.lean();
  const cutoffs = new Map<string, number>();
  for (const mutation of mutations) {
    const cutoff = mutation.createdAt.getTime();
    cutoffs.set(mutation.identityKey, Math.max(cutoffs.get(mutation.identityKey) ?? -Infinity, cutoff));
  }
  return cutoffs;
}

export function isAwardInToonLifecycle(identity: ToonIdentity, earnedAt: Date, cutoffs: Map<string, number>) {
  const cutoff = cutoffs.get(getSheetRecordKey(identity));
  return cutoff === undefined || earnedAt.getTime() > cutoff;
}
