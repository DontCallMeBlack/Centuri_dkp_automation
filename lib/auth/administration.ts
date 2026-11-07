import mongoose, { type ClientSession } from 'mongoose';
import dbConnect from '@/lib/mongodb';
import ClanAdministrationState from '@/lib/models/ClanAdministrationState';
import RosterMutation from '@/lib/models/RosterMutation';
import { RequestValidationError } from '@/lib/security/request';
export const CLAN_ADMINISTRATION_KEY = 'clan-administration';

function isTransientTransactionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const transactionError = error as Error & { code?: number; errorLabels?: string[] };
  if (transactionError.errorLabels?.includes('TransientTransactionError')) {
    return true;
  }
  return new Set([24, 91, 112, 211, 244, 251, 10107, 11000]).has(transactionError.code ?? -1);
}

/** Shared write fence prevents snapshot-isolation write skew across account
 * roles, toon links, bids and the first-Chief bootstrap. */
export async function withClanAdministrationTransaction<T>(operation: (session: ClientSession) => Promise<T>, options: { recoveringRoster?: boolean } = {}): Promise<T> {
  await dbConnect();
  await ClanAdministrationState.updateOne(
    { _id: CLAN_ADMINISTRATION_KEY }, { $setOnInsert: { revision: 0, bootstrapClaimed: false } }, { upsert: true },
  ).catch((error: unknown) => {
    if (typeof error === 'object' && error && 'code' in error && error.code === 11000) return;
    throw error;
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const session = await mongoose.startSession();
    try {
      let result!: T;
      await session.withTransaction(async () => {
        await ClanAdministrationState.updateOne({ _id: CLAN_ADMINISTRATION_KEY }, { $inc: { revision: 1 } }, { session });
        if (!options.recoveringRoster && await RosterMutation.exists({ status: 'pending' }).session(session)) {
          throw new RequestValidationError('A clan toon change is finishing. Open Clan toons to recover it before making another change.', 409);
        }
        result = await operation(session);
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 10_000 });
      return result;
    } catch (error: unknown) {
      if (!isTransientTransactionError(error) || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    } finally {
      await session.endSession();
    }
  }
  throw new Error('Auction transaction retries exhausted.');
}
