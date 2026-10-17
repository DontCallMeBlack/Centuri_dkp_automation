// lib/googleSheets.ts
import { createHash, randomUUID } from 'node:crypto';
import { google } from 'googleapis';
import AuctionHold from '@/lib/models/AuctionHold';
import DkpSheetMutation from '@/lib/models/DkpSheetMutation';
import SheetRosterCache, { type ISheetRosterRecord } from '@/lib/models/SheetRosterCache';
import dbConnect from '@/lib/mongodb';
import {
  buildWeeklyDkpResetPlan,
  getCurrentDkpWeekStart,
  initializeWeeklyDkpActivityHistory,
  buildHistoricalDkpActivityCorrection,
  getDkpElapsedWeeks,
} from '@/lib/dkpCycle';
import { buildDkpAdjustmentUpdates, DkpIntegrityError, getDkpReplayState, snapshotDkpCells } from '@/lib/dkpAccounting';
import { getSheetRecordKey } from '@/lib/sheetRecordLinks';
import User from '@/lib/models/User';
import { withClanAdministrationTransaction } from '@/lib/auth/administration';
import { RequestValidationError } from '@/lib/security/request';

const SHEET_NAME = "'DKP_Sheet_automated'";
const ROSTER_CACHE_TTL_MS = 30_000;
const ROSTER_REFRESH_LOCK_MS = 20_000;
const ROSTER_REFRESH_WAIT_MS = 15_000;
const ROSTER_CACHE_POLL_MS = 250;
const WEEKLY_RESET_LOCK_MS = 120_000;
const WEEKLY_RESET_WAIT_MS = 30_000;
const WEEKLY_RESET_POLL_MS = 250;
type SheetValueUpdate = { range: string; values: number[][] };
type SheetIdentity = { rowIndex: number; owner: string; account: string };

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
  if (!Number.isFinite(parsed) || Math.abs(parsed) > Number.MAX_SAFE_INTEGER) {
    throw new DkpIntegrityError('The roster contains an invalid DKP value. A manager must correct it in Google Sheets.');
  }
  return parsed;
}

function createSheetsClient() {
  return google.sheets({ version: 'v4', auth, timeout: 20_000 });
}

async function readSheetRows(sheets = createSheetsClient()) {
  const response = await withGoogleSheetsRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: getSpreadsheetId(), range: `${SHEET_NAME}!A3:I1000`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  }), true);
  // Display rounding and spreadsheet locale must never change the amounts used
  // for debits. Normalize unformatted numeric values at this one boundary.
  return (response.data.values ?? []).map((row) => row.map((value) => String(value ?? '')));
}

function rosterFromRows(rows: string[][]): ISheetRosterRecord[] {
  return rows.map((row, index) => ({
    rowIndex: index + 3,
    owner: String(row[0] || '').trim(), account: String(row[1] || '').trim(), subClass: String(row[2] || ''),
    weeklyEarned: readDkpValue(row[3]), weeklySpent: readDkpValue(row[4]),
    earned: readDkpValue(row[5]), spent: readDkpValue(row[6]), available: readDkpValue(row[7]),
    fiveWeekActivity: readDkpValue(row[8]),
  })).filter((record) => record.owner);
}

async function fetchSheetRoster(): Promise<ISheetRosterRecord[]> {
  return rosterFromRows(await readSheetRows());
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

  throw new DkpIntegrityError('The DKP ledger is busy. Retry the same request shortly.');
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

async function assertLedgerLock(cacheKey: string, lockId: string) {
  const renewed = await SheetRosterCache.updateOne(
    { cacheKey, weeklyResetLockId: lockId, weeklyResetLockUntil: { $gt: new Date() } },
    { $set: { weeklyResetLockUntil: new Date(Date.now() + WEEKLY_RESET_LOCK_MS) } },
  );
  if (renewed.matchedCount === 0) throw new DkpIntegrityError('The DKP ledger lock expired. Retry the same request to recover safely.');
}

function assertRecoveryIdentities(identities: SheetIdentity[] | undefined, rows: string[][]) {
  if (!identities) throw new DkpIntegrityError('An older interrupted DKP operation has no identity snapshot. A manager must reconcile it before further changes.');
  for (const identity of identities) {
    const row = rows[identity.rowIndex - 3];
    if (!row || getSheetRecordKey({ owner: row[0] ?? '', account: row[1] ?? '' }) !== getSheetRecordKey(identity)) {
      throw new DkpIntegrityError('A roster row moved during an interrupted DKP operation. A manager must reconcile it before further changes.');
    }
  }
}

async function replayPendingSheetMutation(spreadsheetId: string, sheets: ReturnType<typeof google.sheets>, lockId: string) {
  const pending = await DkpSheetMutation.findOne({ spreadsheetId, status: 'pending' }).sort({ createdAt: 1 });
  if (!pending) return false;
  const rows = await readSheetRows(sheets);
  assertRecoveryIdentities(pending.identities, rows);
  if (!pending.previousValues) throw new DkpIntegrityError('An older interrupted DKP operation needs manager review before it can be retried.');
  const state = getDkpReplayState(pending.previousValues, pending.updates, rows);
  await assertLedgerLock(spreadsheetId, lockId);
  if (state === 'pending' && pending.updates.length > 0) {
    await withGoogleSheetsRetry(() => sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data: pending.updates },
    }), false);
  }
  await assertLedgerLock(spreadsheetId, lockId);
  if (pending.weeklyActivityHistory) {
    await SheetRosterCache.updateOne({ cacheKey: spreadsheetId, weeklyResetLockId: lockId }, {
      $set: { weeklyActivityHistory: pending.weeklyActivityHistory },
    });
  }
  await DkpSheetMutation.updateOne({ _id: pending._id, status: 'pending' }, { $set: { status: 'applied' } });
  await invalidateSheetRosterCache();
  return true;
}

async function processWeeklyDkpResetWhileLocked(cacheKey: string, lockId: string) {
  const sheets = createSheetsClient();
  const spreadsheetId = getSpreadsheetId();

  while (true) {
    const cache = await SheetRosterCache.findOne({ cacheKey }).lean();
    if (!cache || cache.weeklyResetLockId !== lockId) {
      throw new DkpIntegrityError('The DKP ledger lost its lock. Retry the same request.');
    }

    const pending = cache.weeklyResetPending;
    if (pending) {
      const rows = await readSheetRows(sheets);
      assertRecoveryIdentities(pending.identities, rows);
      if (!pending.previousValues) throw new DkpIntegrityError('An older interrupted weekly reset needs manager review before it can be retried.');
      const updates = pending.updates;
      const state = getDkpReplayState(pending.previousValues, updates, rows);
      await assertLedgerLock(cacheKey, lockId);

      if (updates.length > 0 && state === 'pending') {
        await withGoogleSheetsRetry(
          () => sheets.spreadsheets.values.batchUpdate({
            spreadsheetId,
            requestBody: {
              valueInputOption: 'RAW',
              data: updates,
            },
          }),
          false,
        );
      }

      await assertLedgerLock(cacheKey, lockId);

      const completed = await SheetRosterCache.updateOne(
        { cacheKey, weeklyResetLockId: lockId },
        {
          $set: {
            weeklyResetFor: pending.cycleStart,
            fetchedAt: new Date(0),
            refreshLockUntil: new Date(0),
            ...(pending.weeklyActivityHistory
              ? { weeklyActivityHistory: pending.weeklyActivityHistory }
              : {}),
          },
          $inc: { generation: 1 },
          $unset: { weeklyResetPending: 1 },
        },
      );
      if (completed.matchedCount === 0) {
        throw new DkpIntegrityError('The DKP ledger lost its lock. Retry the same request.');
      }
      continue;
    }

    if (await replayPendingSheetMutation(spreadsheetId, sheets, lockId)) continue;

    const currentWeekStart = getCurrentDkpWeekStart();
    if (cache.weeklyResetFor && cache.weeklyResetFor.getTime() >= currentWeekStart.getTime()) {
      return;
    }

    // On first activation, keep the current week's points in Weekly Earned.
    // The first transfer happens at the next Sunday boundary.
    if (!cache.weeklyResetFor) {
      const roster = await fetchSheetRoster();
      const activityRoster = roster.map((record) => ({ ...record, fiveWeekActivity: record.fiveWeekActivity ?? 0 }));
      const initialized = await SheetRosterCache.updateOne(
        { cacheKey, weeklyResetLockId: lockId, weeklyResetFor: { $exists: false } },
        {
          $set: {
            weeklyResetFor: currentWeekStart,
            weeklyActivityHistory: cache.weeklyActivityHistory ?? initializeWeeklyDkpActivityHistory(activityRoster),
          },
        },
      );
      if (initialized.matchedCount === 0) continue;
      return;
    }

    const rows = await readSheetRows(sheets);
    const roster = rosterFromRows(rows);
    const activityRoster = roster.map((record) => ({ ...record, fiveWeekActivity: record.fiveWeekActivity ?? 0 }));
    const resetPlan = buildWeeklyDkpResetPlan(
      activityRoster,
      SHEET_NAME,
      cache.weeklyActivityHistory ?? initializeWeeklyDkpActivityHistory(activityRoster),
      getDkpElapsedWeeks(cache.weeklyResetFor, currentWeekStart),
    );

    const before = snapshotDkpCells(resetPlan.updates, rows);
    getDkpReplayState(before, resetPlan.updates, rows); // Validate every planned value before persisting recovery state.
    const holds = await AuctionHold.find({ heldPoints: { $ne: 0 } }).select('rowIndex owner account heldPoints').lean();
    for (const hold of holds) {
      const record = roster.find((entry) => entry.rowIndex === hold.rowIndex);
      if (!record || !Number.isFinite(hold.heldPoints) || hold.heldPoints < 0 ||
        (hold.owner !== undefined && getSheetRecordKey(record) !== getSheetRecordKey({ owner: hold.owner, account: hold.account ?? '' })) ||
        record.available + record.weeklyEarned < hold.heldPoints) {
        throw new DkpIntegrityError('Weekly rollover would invalidate an auction reservation. A manager must reconcile the roster and holds first.');
      }
    }

    await assertLedgerLock(cacheKey, lockId);

    const planned = await SheetRosterCache.updateOne(
      { cacheKey, weeklyResetLockId: lockId },
      {
        $set: {
          weeklyResetPending: {
            cycleStart: currentWeekStart,
            updates: resetPlan.updates,
            previousValues: before,
            identities: roster.map(({ rowIndex, owner, account }) => ({ rowIndex, owner, account })),
            weeklyActivityHistory: resetPlan.weeklyActivityHistory,
          },
        },
      },
    );
    if (planned.matchedCount === 0) {
      throw new DkpIntegrityError('The DKP ledger lost its lock. Retry the same request.');
    }
  }
}

async function withWeeklyResetLock<T>(cacheKey: string, operation: (lockId: string) => Promise<T>) {
  const lockId = await acquireWeeklyResetLock(cacheKey);
  let heartbeat: Promise<unknown> = Promise.resolve();
  let heartbeatError: unknown;
  const interval = setInterval(() => {
    heartbeat = heartbeat.then(() => assertLedgerLock(cacheKey, lockId)).catch((error: unknown) => { heartbeatError = error; });
  }, WEEKLY_RESET_LOCK_MS / 4);
  interval.unref();
  try {
    await processWeeklyDkpResetWhileLocked(cacheKey, lockId);
    if (heartbeatError) throw heartbeatError;
    await assertLedgerLock(cacheKey, lockId);
    const result = await operation(lockId);
    await assertLedgerLock(cacheKey, lockId);
    return result;
  } finally {
    clearInterval(interval);
    await heartbeat;
    await releaseWeeklyResetLock(cacheKey, lockId);
  }
}

/** Serialize reservations with debits and weekly rollover using a fresh ledger. */
export async function withDkpLedgerLock<T>(operation: (roster: ISheetRosterRecord[]) => Promise<T>) {
  await dbConnect();
  const cacheKey = getSpreadsheetId();
  await ensureSheetRosterCacheDocument(cacheKey);
  return withWeeklyResetLock(cacheKey, async (lockId) => {
    const roster = await fetchSheetRoster();
    await assertLedgerLock(cacheKey, lockId);
    return operation(roster);
  });
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
      console.error('Weekly DKP reset did not complete; it will be retried.', error instanceof Error ? error.name : 'UnknownError');
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
    fiveWeekActivity: record.fiveWeekActivity ?? 0,
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
    /** Award occurrence time: determines the credited week inside the ledger lock. */
    earnedAt?: Date;
    /** For staff awards, authorize the durable plan atomically with role edits. */
    actorUserId?: string;
  } = {},
) {
  if (adjustments.length === 0) return;

  const requestedMode = options.mode ?? 'balance';
  if (options.earnedAt && !Number.isFinite(options.earnedAt.getTime())) throw new DkpIntegrityError('Invalid award occurrence time.');
  const combined = new Map<number, typeof adjustments[number]>();
  for (const adjustment of adjustments) {
    const previous = combined.get(adjustment.rowIndex);
    if (previous && (previous.owner !== adjustment.owner || previous.account !== adjustment.account)) {
      throw new DkpIntegrityError('Conflicting roster identities in a DKP operation.');
    }
    combined.set(adjustment.rowIndex, {
      rowIndex: adjustment.rowIndex, owner: adjustment.owner, account: adjustment.account,
      points: (previous?.points ?? 0) + adjustment.points,
    });
  }
  const targets = [...combined.values()].sort((a, b) => a.rowIndex - b.rowIndex);
  const operationKey = options.idempotencyKey ?? `internal:${randomUUID()}`;
  const requestFingerprint = createHash('sha256').update(JSON.stringify({
    targets, mode: requestedMode, earnedAt: options.earnedAt?.toISOString(),
    reserved: [...(options.reservedPointsToConsume ?? new Map()).entries()].sort(([a], [b]) => a - b),
  })).digest('hex');
  await dbConnect();
  const spreadsheetId = getSpreadsheetId();
  await ensureSheetRosterCacheDocument(spreadsheetId);

  await withWeeklyResetLock(spreadsheetId, async (lockId) => {
    // Check the durable key before inspecting balances: a completed retry must
    // never be rejected merely because the original operation changed them.
    const existing = await DkpSheetMutation.findOne({ spreadsheetId, operationKey });
    if (existing) {
      if (existing.requestFingerprint && existing.requestFingerprint !== requestFingerprint) {
        throw new DkpIntegrityError('This request ID was already used for a different DKP operation.');
      }
      if (existing.status === 'applied') return;
      throw new DkpIntegrityError('The previous DKP operation is awaiting recovery. Retry the same request.');
    }
    const sheets = createSheetsClient();
    const rows = await readSheetRows(sheets);
    const roster = rosterFromRows(rows);
    const now = new Date();
    const historical = requestedMode === 'weekly-earned' && options.earnedAt &&
      options.earnedAt < getCurrentDkpWeekStart(now);
    const mode = historical ? 'balance' : requestedMode;
    const holds = mode === 'weekly-earned' ? [] : await AuctionHold.find({ heldPoints: { $ne: 0 } })
      .select('rowIndex owner account heldPoints').lean();
    const holdsByRow = new Map<number, number>();
    for (const target of targets.filter(({ points }) => points < 0)) {
      const row = rows[target.rowIndex - 3];
      if (!row) continue; // The accounting validator below reports the missing row.
      const identity = { owner: row[0] ?? '', account: row[1] ?? '' };
      for (const hold of holds) {
        const matchesIdentity = typeof hold.owner === 'string' &&
          getSheetRecordKey({ owner: hold.owner, account: hold.account ?? '' }) === getSheetRecordKey(identity);
        if (hold.rowIndex !== target.rowIndex && !matchesIdentity) continue;
        if (!matchesIdentity || hold.rowIndex !== target.rowIndex) {
          throw new DkpIntegrityError('A held auction reservation belongs to a moved or unverified roster row. A manager must reconcile it before changing its DKP.');
        }
        holdsByRow.set(target.rowIndex, (holdsByRow.get(target.rowIndex) ?? 0) + hold.heldPoints);
      }
    }
    const updates = targets.flatMap(({ rowIndex, points, owner, account }) => buildDkpAdjustmentUpdates({
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
    let weeklyActivityHistory;
    if (historical && options.earnedAt) {
      const cache = await SheetRosterCache.findOne({ cacheKey: spreadsheetId }).lean();
      const activityRoster = roster.map((record) => ({ ...record, fiveWeekActivity: record.fiveWeekActivity ?? 0 }));
      const correction = buildHistoricalDkpActivityCorrection(
        activityRoster, cache?.weeklyActivityHistory ?? initializeWeeklyDkpActivityHistory(activityRoster),
        targets, options.earnedAt, now, SHEET_NAME,
      );
      updates.push(...correction.updates);
      weeklyActivityHistory = correction.weeklyActivityHistory;
    }
    const identities = targets.map(({ rowIndex }) => {
      const record = roster.find((entry) => entry.rowIndex === rowIndex)!;
      return { rowIndex, owner: record.owner, account: record.account };
    });
    const before = snapshotDkpCells(updates, rows);
    getDkpReplayState(before, updates, rows);
    await assertLedgerLock(spreadsheetId, lockId);
    const mutation = {
      spreadsheetId, operationKey, requestFingerprint, status: 'pending' as const, updates,
      actorUserId: options.actorUserId,
      previousValues: before, identities, weeklyActivityHistory,
    };
    if (options.actorUserId) {
      await withClanAdministrationTransaction(async (session) => {
        const actor = await User.findOne({
          _id: options.actorUserId, status: 'approved', role: { $in: ['chief', 'general', 'guardian'] },
        }).select('_id').session(session).lean();
        if (!actor) throw new RequestValidationError('Your role no longer permits DKP changes.', 403);
        await assertLedgerLock(spreadsheetId, lockId);
        await DkpSheetMutation.create([mutation], { session });
      });
    } else {
      await DkpSheetMutation.create(mutation);
    }
    await replayPendingSheetMutation(spreadsheetId, sheets, lockId);
  });
  try {
    await invalidateSheetRosterCache();
  } catch (error: unknown) {
    console.error('DKP was updated in Google Sheets, but the roster cache could not be invalidated', error instanceof Error ? error.name : 'UnknownError');
  }
}

export async function updatePlayerDKP(rowIndex: number, pointsToAdd: number) {
  await adjustPlayersDKP([{ rowIndex, points: pointsToAdd }], { mode: 'weekly-earned' });
}

export async function isDkpMutationApplied(operationKey: string) {
  await dbConnect();
  return Boolean(await DkpSheetMutation.exists({ spreadsheetId: getSpreadsheetId(), operationKey, status: 'applied' }));
}
