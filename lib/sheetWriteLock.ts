import { randomUUID } from 'node:crypto';
import SheetWriteLock from '@/lib/models/SheetWriteLock';
import dbConnect from '@/lib/mongodb';

const LOCK_ID = 'dkp-sheet-writer';
const LOCK_LEASE_MS = 2 * 60 * 1000;
const LOCK_WAIT_MS = 30 * 1000;
const LOCK_POLL_MS = 200;

function isDuplicateKeyError(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}

export async function withDkpSheetWriteLock<T>(operation: () => Promise<T>): Promise<T> {
  await dbConnect();
  const token = randomUUID();
  const waitUntil = Date.now() + LOCK_WAIT_MS;

  while (Date.now() < waitUntil) {
    const now = new Date();
    try {
      const acquired = await SheetWriteLock.findOneAndUpdate(
        { _id: LOCK_ID, lockUntil: { $lte: now } },
        { $set: { token, lockUntil: new Date(now.getTime() + LOCK_LEASE_MS) } },
        { upsert: true, new: true },
      ).lean();

      if (acquired?.token === token) {
        try {
          return await operation();
        } finally {
          await SheetWriteLock.updateOne(
            { _id: LOCK_ID, token },
            { $set: { lockUntil: new Date(0) }, $unset: { token: 1 } },
          ).catch((error: unknown) => {
            console.error('Could not release the Google Sheets write lock; it will expire automatically', error);
          });
        }
      }
    } catch (error: unknown) {
      if (!isDuplicateKeyError(error)) throw error;
    }

    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }

  throw new Error('Google Sheets is busy processing another DKP update. Please retry shortly.');
}
