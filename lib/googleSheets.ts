// lib/googleSheets.ts
import { randomUUID } from 'node:crypto';
import { google } from 'googleapis';
import AuctionHold from '@/lib/models/AuctionHold';
import DkpSheetMutation from '@/lib/models/DkpSheetMutation';
import SheetRosterCache, { type ISheetRosterRecord } from '@/lib/models/SheetRosterCache';
import dbConnect from '@/lib/mongodb';
import { buildWeeklyDkpResetUpdates, getCurrentDkpWeekStart } from '@/lib/dkpCycle';
import { buildDkpAdjustmentUpdates } from '@/lib/dkpAccounting';

const SHEET_NAME = "'DKP_Sheet_automated'";
const ROSTER_CACHE_TTL_MS = 30_000;
const ROSTER_REFRESH_LOCK_MS = 20_000;
const ROSTER_REFRESH_WAIT_MS = 15_000;
const ROSTER_CACHE_POLL_MS = 250;
const WEEKLY_RESET_LOCK_MS = 120_000;
const WEEKLY_RESET_WAIT_MS = 30_000;
const WEEKLY_RESET_POLL_MS = 250;
type SheetValueUpdate = { range: string; values: number[][] };

const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  },
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

function getSpreadsheetId() {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID?.trim();
  if (!spreadsheetId) {
    throw new Error('Google Sheets is not configured: set GOOGLE_SHEET_ID in the deployment environment.');
  }
  return spreadsheetId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getGoogleSheetsErrorStatus(error: unknown) {
  if (!isRecord(error) || !isRecord(error.response)) return undefined;
  return typeof error.response.status === 'number' ? error.response.status : undefined;
}

function isGoogleSheetsRateLimitError(error: unknown) {
  const status = getGoogleSheetsErrorStatus(error);
  if (status === 429) return true;
  if (status !== 403) return false;
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return message.includes('quota') || message.includes('rate limit') || message.includes('ratelimit');
}

function isRetryableGoogleSheetsReadError(error: unknown) {
  const status = getGoogleSheetsErrorStatus(error);
  return isGoogleSheetsRateLimitError(error) ||
    status === 408 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504;
}

async function withGoogleSheetsRetry<T>(operation: () => Promise<T>, retryTransientErrors: boolean) {
  const maxRetries = 3;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error: unknown) {
      const canRetry = retryTransientErrors
        ? isRetryableGoogleSheetsReadError(error)
        : isGoogleSheetsRateLimitError(error);
      if (!canRetry || attempt >= maxRetries) throw error;
      const exponentialDelay = 500 * (2 ** attempt);
      await new Promise((resolve) =>
        setTimeout(resolve, exponentialDelay + Math.floor(Math.random() * 250)),
      );
    }
  }
}

function readDkpValue(value: string | undefined) {
  if (!value || value.trim() === '-') return 0;
  const parsed = Number(value.replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

async function fetchSheetRoster(): Promise<ISheetRosterRecord[]> {
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = getSpreadsheetId();

  // Owner (A), Account (B), Sub class (C), Earned (D), Spent (E), Earned (F), Spent (G), Available (H)
  const response = await withGoogleSheetsRetry(
    () => sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${SHEET_NAME}!A3:H1000`,
    }),
    true,
  );

  const rows = response.data.values;
  if (!rows) return [];

  return rows.map((row, index) => ({
    rowIndex: index + 3,
    owner: row[0] || '',
    account: row[1] || '',
    subClass: row[2] || '',
    weeklyEarned: readDkpValue(row[3]),
    weeklySpent: readDkpValue(row[4]),
    earned: readDkpValue(row[5]),
    spent: readDkpValue(row[6]),
    available: readDkpValue(row[7]),
  })).filter(r => r.owner); // Filter out empty rows
}

async function ensureSheetRosterCacheDocument(cacheKey: string) {
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
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean().catch(async (error: unknown) => {
    if (isRecord(error) && error.code === 11000) {
      const existing = await SheetRosterCache.findOne({ cacheKey }).lean();
      if (existing) return existing;
    }
    throw error;
  });
}

async function acquireWeeklyResetLock(cacheKey: string) {
  const waitUntil = Date.now() + WEEKLY_RESET_WAIT_MS;
  const lockId = randomUUID();
  while (Date.now() < waitUntil) {
    const now = new Date();
    const acquired = await SheetRosterCache.findOneAndUpdate(
      {
        cacheKey,
        $or: [
          { weeklyResetLockUntil: { $lte: now } },
          { weeklyResetLockUntil: { $exists: false } },
        ],
      },
      {
        $set: {
          weeklyResetLockUntil: new Date(now.getTime() + WEEKLY_RESET_LOCK_MS),
          weeklyResetLockId: lockId,
        },
      },
      { new: true },
    ).lean();
    if (acquired) return lockId;
    await new Promise((resolve) => setTimeout(resolve, WEEKLY_RESET_POLL_MS));
  }

  throw new Error('The weekly DKP sheet update is still in progress. Please retry shortly.');
}

async function releaseWeeklyResetLock(cacheKey: string, lockId: string) {
  await SheetRosterCache.updateOne(
    { cacheKey, weeklyResetLockId: lockId },
    {
      $set: { weeklyResetLockUntil: new Date(0) },
      $unset: { weeklyResetLockId: 1 },
    },
  );
}

async function replayPendingSheetMutation(spreadsheetId: string, sheets: ReturnType<typeof google.sheets>) {
  const pending = await DkpSheetMutation.findOne({ spreadsheetId, status: 'pending' }).sort({ createdAt: 1 });
  if (!pending) return false;
  await withGoogleSheetsRetry(() => sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'USER_ENTERED', data: pending.updates },
  }), false);
  await DkpSheetMutation.updateOne({ _id: pending._id, status: 'pending' }, { $set: { status: 'applied' } });
  await invalidateSheetRosterCache();
  return true;
}

async function processWeeklyDkpResetWhileLocked(cacheKey: string, lockId: string) {
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = getSpreadsheetId();

  while (true) {
    const cache = await SheetRosterCache.findOne({ cacheKey }).lean();
    if (!cache || cache.weeklyResetLockId !== lockId) {
      throw new Error('The weekly DKP sheet update lost its lock. Please retry.');
    }

    const pending = cache.weeklyResetPending;
    if (pending) {
      // Add weekly-column clears when recovering a pending reset created by an
      // earlier version that only cleared Weekly Earned.
      const roster = await fetchSheetRoster();
      const updates = [
        ...pending.updates.filter(({ range }) => !/![DE]\d+$/.test(range)),
        ...roster.flatMap((record) => [
          { range: `${SHEET_NAME}!D${record.rowIndex}`, values: [[0]] },
          { range: `${SHEET_NAME}!E${record.rowIndex}`, values: [[0]] },
        ]),
      ];

      if (updates.length > 0) {
        await withGoogleSheetsRetry(
          () => sheets.spreadsheets.values.batchUpdate({
            spreadsheetId,
            requestBody: {
              valueInputOption: 'USER_ENTERED',
              data: updates,
            },
          }),
          false,
        );
      }

      const completed = await SheetRosterCache.updateOne(
        { cacheKey, weeklyResetLockId: lockId },
        {
          $set: {
            weeklyResetFor: pending.cycleStart,
            fetchedAt: new Date(0),
            refreshLockUntil: new Date(0),
          },
          $inc: { generation: 1 },
          $unset: { weeklyResetPending: 1 },
        },
      );
      if (completed.matchedCount === 0) {
        throw new Error('The weekly DKP sheet update lost its lock. Please retry.');
      }
      continue;
    }

    if (await replayPendingSheetMutation(spreadsheetId, sheets)) continue;

    const currentWeekStart = getCurrentDkpWeekStart();
    if (cache.weeklyResetFor && cache.weeklyResetFor.getTime() >= currentWeekStart.getTime()) {
      return;
    }

    // On first activation, keep the current week's points in Weekly Earned.
    // The first transfer happens at the next Sunday boundary.
    if (!cache.weeklyResetFor) {
      const initialized = await SheetRosterCache.updateOne(
        { cacheKey, weeklyResetLockId: lockId, weeklyResetFor: { $exists: false } },
        { $set: { weeklyResetFor: currentWeekStart } },
      );
      if (initialized.matchedCount === 0) continue;
      return;
    }

    const roster = await fetchSheetRoster();
    const updates = buildWeeklyDkpResetUpdates(roster, SHEET_NAME);

    const planned = await SheetRosterCache.updateOne(
      { cacheKey, weeklyResetLockId: lockId },
      {
        $set: {
          weeklyResetPending: { cycleStart: currentWeekStart, updates },
        },
      },
    );
    if (planned.matchedCount === 0) {
      throw new Error('The weekly DKP sheet update lost its lock. Please retry.');
    }
  }
}

async function withWeeklyResetLock<T>(cacheKey: string, operation: () => Promise<T>) {
  const lockId = await acquireWeeklyResetLock(cacheKey);
  try {
    await processWeeklyDkpResetWhileLocked(cacheKey, lockId);
    return await operation();
  } finally {
    await releaseWeeklyResetLock(cacheKey, lockId);
  }
}

export async function ensureWeeklyDkpReset() {
  await dbConnect();
  const cacheKey = getSpreadsheetId();
  await ensureSheetRosterCacheDocument(cacheKey);

  const currentWeekStart = getCurrentDkpWeekStart();
  const cache = await SheetRosterCache.findOne({ cacheKey })
    .select('weeklyResetFor weeklyResetPending')
    .lean();
  if (
    cache &&
    !cache.weeklyResetPending &&
    !(await DkpSheetMutation.exists({ spreadsheetId: cacheKey, status: 'pending' })) &&
    cache.weeklyResetFor &&
    cache.weeklyResetFor.getTime() >= currentWeekStart.getTime()
  ) {
    return;
  }

  await withWeeklyResetLock(cacheKey, async () => undefined);
}

export function startDkpWeeklyResetScheduler() {
  if (
    !process.env.GOOGLE_SHEET_ID?.trim() ||
    !process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim() ||
    !process.env.GOOGLE_PRIVATE_KEY?.trim() ||
    !process.env.MONGODB_URI
  ) return;

  const globalWithScheduler = globalThis as typeof globalThis & {
    __centuriDkpWeeklyResetInterval?: NodeJS.Timeout;
  };
  if (globalWithScheduler.__centuriDkpWeeklyResetInterval) return;

  const runReset = () => {
    void ensureWeeklyDkpReset().catch((error: unknown) => {
      console.error('Weekly DKP reset did not complete; it will be retried.', error);
    });
  };
  const interval = setInterval(runReset, 60_000);
  interval.unref();
  globalWithScheduler.__centuriDkpWeeklyResetInterval = interval;
  runReset();
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
  };
}

function isRosterCacheFresh(fetchedAt: Date | undefined, now: number) {
  return fetchedAt instanceof Date && now - fetchedAt.getTime() < ROSTER_CACHE_TTL_MS;
}

export async function getSheetRosterSnapshot(options: { fresh?: boolean } = {}) {
  await dbConnect();
  const cacheKey = getSpreadsheetId();
  await ensureWeeklyDkpReset();
  const now = Date.now();
  const staleAtRequest = await ensureSheetRosterCacheDocument(cacheKey);

  const requestStartedAt = new Date(now);
  if (!options.fresh && staleAtRequest && isRosterCacheFresh(staleAtRequest.fetchedAt, now)) {
    return {
      roster: staleAtRequest.roster.map(serializeRosterRecord),
      fetchedAt: staleAtRequest.fetchedAt,
      stale: false,
      refreshDelayed: Boolean(staleAtRequest.lastRefreshError),
    };
  }

  const waitUntil = Date.now() + ROSTER_REFRESH_WAIT_MS;
  let lastError: unknown;
  while (Date.now() < waitUntil) {
    const current = await SheetRosterCache.findOne({ cacheKey }).lean();
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
      };
    }
    if (!options.fresh && current?.roster.length && isRosterCacheFresh(current.fetchedAt, Date.now())) {
      return {
        roster: current.roster.map(serializeRosterRecord),
        fetchedAt: current.fetchedAt,
        stale: false,
        refreshDelayed: Boolean(current.lastRefreshError),
      };
    }

    const lockUntil = new Date(Date.now() + ROSTER_REFRESH_LOCK_MS);
    const acquired = await SheetRosterCache.findOneAndUpdate(
      { cacheKey, refreshLockUntil: { $lte: new Date() } },
      { $set: { refreshLockUntil: lockUntil } },
      { new: true },
    ).lean();

    if (acquired) {
      try {
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
        const failedCache = await SheetRosterCache.findOne({ cacheKey }).lean();
        if (!options.fresh && failedCache?.roster.length) {
          return {
            roster: failedCache.roster.map(serializeRosterRecord),
            fetchedAt: failedCache.fetchedAt,
            stale: true,
            refreshDelayed: true,
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
      };
    }

    await new Promise((resolve) => setTimeout(resolve, ROSTER_CACHE_POLL_MS));
  }

  const latest = await SheetRosterCache.findOne({ cacheKey }).lean();
  if (!options.fresh && latest?.roster.length) {
    return {
      roster: latest.roster.map(serializeRosterRecord),
      fetchedAt: latest.fetchedAt,
      stale: true,
      refreshDelayed: Boolean(latest.lastRefreshError),
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
  const cacheKey = getSpreadsheetId();
  await SheetRosterCache.updateOne(
    { cacheKey },
    { $set: { fetchedAt: new Date(0) }, $inc: { generation: 1 } },
  );
}

export async function adjustPlayersDKP(
  adjustments: Array<{
    rowIndex: number;
    points: number;
    owner?: string;
    account?: string;
  }>,
  options: {
    reservedPointsToConsume?: Map<number, number>;
    mode?: 'balance' | 'weekly-earned' | 'auction-spend';
    idempotencyKey?: string;
  } = {},
) {
  if (adjustments.length === 0) return;

  const mode = options.mode ?? 'balance';
  await dbConnect();
  const spreadsheetId = getSpreadsheetId();
  await ensureSheetRosterCacheDocument(spreadsheetId);

  await withWeeklyResetLock(spreadsheetId, async () => {
    const sheets = google.sheets({ version: 'v4', auth });
    const response = await withGoogleSheetsRetry(
      () => sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${SHEET_NAME}!A3:H1000`,
      }),
      true,
    );
    const rows = response.data.values ?? [];
    const holds = mode === 'weekly-earned' ? [] : await AuctionHold.find({
      rowIndex: { $in: adjustments.filter(({ points }) => points < 0).map(({ rowIndex }) => rowIndex) },
    }).select('rowIndex heldPoints').lean();
    const holdsByRow = new Map(holds.map((hold) => [hold.rowIndex, hold.heldPoints]));
    const updates = adjustments.flatMap(({ rowIndex, points, owner, account }) => buildDkpAdjustmentUpdates({
      rowIndex,
      points,
      owner,
      account,
      row: rows[rowIndex - 3],
      mode,
      heldPoints: holdsByRow.get(rowIndex),
      reservedPointsToConsume: options.reservedPointsToConsume?.get(rowIndex),
      sheetName: SHEET_NAME,
    }));

    if (options.idempotencyKey) {
      const existing = await DkpSheetMutation.findOne({ spreadsheetId, operationKey: options.idempotencyKey });
      if (existing?.status === 'applied') return;
      const mutation = existing ?? await DkpSheetMutation.create({
        spreadsheetId,
        operationKey: options.idempotencyKey,
        status: 'pending',
        updates,
      });
      if (mutation.status === 'pending') await replayPendingSheetMutation(spreadsheetId, sheets);
    } else {
      await withGoogleSheetsRetry(
        () => sheets.spreadsheets.values.batchUpdate({
          spreadsheetId,
          requestBody: { valueInputOption: 'USER_ENTERED', data: updates },
        }),
        false,
      );
    }
  });
  try {
    await invalidateSheetRosterCache();
  } catch (error: unknown) {
    console.error('DKP was updated in Google Sheets, but the roster cache could not be invalidated', error);
  }
}

export async function updatePlayerDKP(rowIndex: number, pointsToAdd: number) {
  await adjustPlayersDKP([{ rowIndex, points: pointsToAdd }], { mode: 'weekly-earned' });
}
