import mongoose, { type ClientSession } from 'mongoose';
import dbConnect from '@/lib/mongodb';
import ClanAdministrationState from '@/lib/models/ClanAdministrationState';
export const CLAN_ADMINISTRATION_KEY = 'clan-administration';

/** Shared write fence prevents snapshot-isolation write skew across account
 * roles, toon links, bids and the first-Chief bootstrap. */
export async function withClanAdministrationTransaction<T>(operation: (session: ClientSession) => Promise<T>): Promise<T> {
  await dbConnect();
  await ClanAdministrationState.updateOne(
    { _id: CLAN_ADMINISTRATION_KEY }, { $setOnInsert: { revision: 0, bootstrapClaimed: false } }, { upsert: true },
  ).catch((error: unknown) => {
    if (typeof error === 'object' && error && 'code' in error && error.code === 11000) return;
    throw error;
  });
  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      await ClanAdministrationState.updateOne({ _id: CLAN_ADMINISTRATION_KEY }, { $inc: { revision: 1 } }, { session });
      result = await operation(session);
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 10_000 });
    return result;
  } finally { await session.endSession(); }
}
