import SheetRosterCache, { type ISheetRosterRecord } from '@/lib/models/SheetRosterCache';
import dbConnect from '@/lib/mongodb';
import { RequestValidationError } from '@/lib/security/request';

const ROSTER_CACHE_TTL_MS = 30_000;
const ROSTER_REFRESH_LOCK_MS = 20_000;
const ROSTER_REFRESH_WAIT_MS = 15_000;
const ROSTER_CACHE_POLL_MS = 250;
// Display reads should not decode the financial recovery journal/activity log.
const ROSTER_SNAPSHOT_FIELDS = 'roster fetchedAt lastRefreshError';

export function getSpreadsheetId() {
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') {
    throw new RequestValidationError('Live DKP access is disabled outside production deployments.', 503);
  }
  const spreadsheetId = process.env.GOOGLE_SHEET_ID?.trim();
  if (!spreadsheetId) {
    throw new RequestValidationError('Google Sheets is not configured. The site owner must set GOOGLE_SHEET_ID in the server environment.', 503);
  }
  return spreadsheetId;
}

export async function ensureSheetRosterCacheDocument(cacheKey: string) {
  return SheetRosterCache.findOneAndUpdate(
    { cacheKey },
    {
      $setOnInsert: {
        cacheKey,
        roster: [],
        fetchedAt: new Date(0),
        refreshLockUntil: new Date(0),
        generation: 0,
        weeklyResetLockUntil: new Date(0),
      },
    },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  ).select(ROSTER_SNAPSHOT_FIELDS).lean().catch(async (error: unknown) => {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
      const existing = await SheetRosterCache.findOne({ cacheKey }).select(ROSTER_SNAPSHOT_FIELDS).lean();
      if (existing) return existing;
    }
    throw error;
  });
}

function serializeRosterRecord(record: ISheetRosterRecord): ISheetRosterRecord {
  return {
    rowIndex: record.rowIndex,
    owner: record.owner,
    account: record.account,
    subClass: record.subClass,
    weeklyEarned: record.weeklyEarned,
    weeklySpent: record.weeklySpent,
    earned: record.earned,
    spent: record.spent,
    available: record.available,
    fiveWeekActivity: record.fiveWeekActivity === undefined ? 0 : record.fiveWeekActivity,
    dkpIssues: record.dkpIssues ?? [],
  };
}

function isRosterCacheFresh(fetchedAt: Date | undefined, now: number) {
  return fetchedAt instanceof Date && now - fetchedAt.getTime() < ROSTER_CACHE_TTL_MS;
}

let rosterRead: ReturnType<typeof readSheetRosterSnapshot> | null = null;

export function getSheetRosterSnapshot(options: { fresh?: boolean } = {}) {
  // Share concurrent display reads in this instance, without retaining a stale
  // balance or weakening explicit fresh reads used before an award.
  if (options.fresh) return readSheetRosterSnapshot(options);
  if (rosterRead) return rosterRead;
  const request = readSheetRosterSnapshot(options).finally(() => {
    if (rosterRead === request) rosterRead = null;
  });
  rosterRead = request;
  return request;
}

async function readSheetRosterSnapshot(options: { fresh?: boolean } = {}) {
  await dbConnect();
  const cacheKey = getSpreadsheetId();
  // Read-only views must remain available while a different toon's data needs
  // repair. Rollover/recovery still runs under the ledger lock before writes.
  const now = Date.now();
  // Ordinary reads must not queue writes against the same shared document.
  const staleAtRequest = await SheetRosterCache.findOne({ cacheKey }).select(ROSTER_SNAPSHOT_FIELDS).lean()
    ?? await ensureSheetRosterCacheDocument(cacheKey);

  const requestStartedAt = new Date(now);
  if (!options.fresh && staleAtRequest && isRosterCacheFresh(staleAtRequest.fetchedAt, now)) {
    return {
      roster: staleAtRequest.roster.map(serializeRosterRecord),
      fetchedAt: staleAtRequest.fetchedAt,
      stale: false,
      refreshDelayed: Boolean(staleAtRequest.lastRefreshError),
      cacheStatus: 'cache' as const,
    };
  }

  const waitUntil = Date.now() + ROSTER_REFRESH_WAIT_MS;
  let lastError: unknown;
  while (Date.now() < waitUntil) {
    const current = await SheetRosterCache.findOne({ cacheKey }).select(ROSTER_SNAPSHOT_FIELDS).lean();
    if (
      options.fresh &&
      current?.fetchedAt &&
      current.fetchedAt.getTime() >= requestStartedAt.getTime()
    ) {
      return {
        roster: current.roster.map(serializeRosterRecord),
        fetchedAt: current.fetchedAt,
        stale: false,
        refreshDelayed: Boolean(current.lastRefreshError),
        cacheStatus: 'sheet' as const,
      };
    }
    if (!options.fresh && current?.roster.length && isRosterCacheFresh(current.fetchedAt, Date.now())) {
      return {
        roster: current.roster.map(serializeRosterRecord),
        fetchedAt: current.fetchedAt,
        stale: false,
        refreshDelayed: Boolean(current.lastRefreshError),
        cacheStatus: 'cache' as const,
      };
    }

    const lockUntil = new Date(Date.now() + ROSTER_REFRESH_LOCK_MS);
    const acquired = await SheetRosterCache.findOneAndUpdate(
      { cacheKey, refreshLockUntil: { $lte: new Date() } },
      { $set: { refreshLockUntil: lockUntil } },
      { returnDocument: 'after' },
    ).select('generation').lean();

    if (acquired) {
      try {
        const { fetchSheetRoster } = await import('./googleSheets');
        const roster = await fetchSheetRoster();
        const saved = await SheetRosterCache.updateOne(
          {
            cacheKey,
            generation: acquired.generation,
            refreshLockUntil: lockUntil,
          },
          {
            $set: {
              roster,
              fetchedAt: new Date(),
              refreshLockUntil: new Date(0),
            },
            $unset: { lastRefreshError: 1 },
          },
        );
        if (saved.modifiedCount > 0) {
          const updated = await SheetRosterCache.findOne({ cacheKey }).select('fetchedAt').lean();
          return {
            roster,
            fetchedAt: updated?.fetchedAt ?? new Date(),
            stale: false,
            refreshDelayed: false,
            cacheStatus: 'sheet' as const,
          };
        }
        await SheetRosterCache.updateOne(
          { cacheKey, refreshLockUntil: lockUntil },
          { $set: { refreshLockUntil: new Date(0) } },
        );
      } catch (error: unknown) {
        lastError = error;
        const errorMessage = error instanceof Error ? error.message : 'Google Sheets refresh failed';
        await SheetRosterCache.updateOne(
          { cacheKey, refreshLockUntil: lockUntil },
          {
            $set: {
              refreshLockUntil: new Date(0),
              lastRefreshError: errorMessage.slice(0, 500),
            },
          },
        );
        const failedCache = await SheetRosterCache.findOne({ cacheKey }).select(ROSTER_SNAPSHOT_FIELDS).lean();
        if (!options.fresh && failedCache?.roster.length) {
          return {
            roster: failedCache.roster.map(serializeRosterRecord),
            fetchedAt: failedCache.fetchedAt,
            stale: true,
            refreshDelayed: true,
            cacheStatus: 'stale' as const,
          };
        }
        throw error;
      }
    } else if (!options.fresh && current?.roster.length) {
      return {
        roster: current.roster.map(serializeRosterRecord),
        fetchedAt: current.fetchedAt,
        stale: true,
        refreshDelayed: Boolean(current.lastRefreshError),
        cacheStatus: 'stale' as const,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, ROSTER_CACHE_POLL_MS));
  }

  const latest = await SheetRosterCache.findOne({ cacheKey }).select(ROSTER_SNAPSHOT_FIELDS).lean();
  if (!options.fresh && latest?.roster.length) {
    return {
      roster: latest.roster.map(serializeRosterRecord),
      fetchedAt: latest.fetchedAt,
      stale: true,
      refreshDelayed: Boolean(latest.lastRefreshError),
      cacheStatus: 'stale' as const,
    };
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error('Google Sheets roster refresh is still in progress. Please retry shortly.');
}

export async function getSheetRoster(options: { fresh?: boolean } = {}) {
  const snapshot = await getSheetRosterSnapshot(options);
  return snapshot.roster;
}

export async function invalidateSheetRosterCache() {
  rosterRead = null;
  const cacheKey = getSpreadsheetId();
  await SheetRosterCache.updateOne(
    { cacheKey },
    { $set: { fetchedAt: new Date(0) }, $inc: { generation: 1 } },
  );
}
