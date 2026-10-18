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
import RosterMutation from '@/lib/models/RosterMutation';
import ClanAuditEvent from '@/lib/models/ClanAuditEvent';
import Auction from '@/lib/models/Auction';
import BossAward from '@/lib/models/BossAward';
import { getLinkedSheetRecordRows } from '@/lib/sheetRecordLinks';
import { getReservationConflict } from '@/lib/auth/reservationProtection';
import { ITEM_SUBROLES } from '@/lib/auctionRules';
import { withClanAdministrationTransaction } from '@/lib/auth/administration';
import { RequestValidationError } from '@/lib/security/request';
import { parseSheetRoster, requireRosterValues } from '@/lib/sheetRoster';

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
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') {
    throw new RequestValidationError('Live DKP access is disabled outside production deployments.', 503);
  }
  const spreadsheetId = process.env.GOOGLE_SHEET_ID?.trim();
  if (!spreadsheetId) {
    throw new RequestValidationError('Google Sheets is not configured. The site owner must set GOOGLE_SHEET_ID in the server environment.', 503);
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
  return parseSheetRoster(rows, { allowInvalid: true });
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
  assertDkpWritesEnabled();
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
  assertDkpWritesEnabled();
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
      const activityRoster = roster.filter((record) => record.fiveWeekActivity !== null).map((record) => ({ ...record, fiveWeekActivity: record.fiveWeekActivity! }));
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
    const activityRoster = roster.map((record) => {
      requireRosterValues(record, ['weeklyEarned', 'fiveWeekActivity']);
      return record;
    });
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
        record.available === null || record.weeklyEarned === null || record.available + record.weeklyEarned < hold.heldPoints) {
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
    await replayPendingRosterMutation(cacheKey, lockId);
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
  assertDkpWritesEnabled();
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
  assertDkpWritesEnabled();
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
    !(await RosterMutation.exists({ spreadsheetId: cacheKey, status: 'pending' })) &&
    cache.weeklyResetFor &&
    cache.weeklyResetFor.getTime() >= currentWeekStart.getTime()
  ) {
    return;
  }

  await withWeeklyResetLock(cacheKey, async () => undefined);
}

function assertDkpWritesEnabled() {
  if (process.env.DKP_WRITES_PAUSED === 'true') {
    throw new RequestValidationError('DKP updates are paused for Sheet maintenance. Try again later.', 503);
  }
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

export async function getSheetRosterSnapshot(options: { fresh?: boolean } = {}) {
  await dbConnect();
  const cacheKey = getSpreadsheetId();
  // Read-only views must remain available while a different toon's data needs
  // repair. Rollover/recovery still runs under the ledger lock before writes.
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
  assertDkpWritesEnabled();
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
      const activityRoster = roster;
      const correction = buildHistoricalDkpActivityCorrection(
        activityRoster, cache?.weeklyActivityHistory ?? initializeWeeklyDkpActivityHistory(activityRoster.filter((record) => record.fiveWeekActivity !== null).map((record) => ({ ...record, fiveWeekActivity: record.fiveWeekActivity! }))),
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

/** Apply one durable roster change before any new financial work. A whole-row
 * RAW write is replayed only when the exact before/after snapshot matches. */
async function replayPendingRosterMutation(spreadsheetId: string, lockId: string) {
  const mutation = await RosterMutation.findOne({ spreadsheetId, status: 'pending' });
  if (!mutation) return;
  const sheets = createSheetsClient();
  const rows = await readSheetRows(sheets);
  const current = Array.from({ length: 9 }, (_, index) => String(rows[mutation.rowIndex - 3]?.[index] ?? ''));
  const same = (values: Array<string | number>) => values.length === 9 && values.every((value, index) => String(value) === current[index]);
  if (!same(mutation.after)) {
    if (!same(mutation.before)) throw new DkpIntegrityError('An interrupted clan toon change no longer matches its Sheet snapshot. Clan leadership must reconcile the row before continuing.');
    await assertLedgerLock(spreadsheetId, lockId);
    await withGoogleSheetsRetry(() => sheets.spreadsheets.values.update({
      spreadsheetId, range: `${SHEET_NAME}!A${mutation.rowIndex}:I${mutation.rowIndex}`,
      valueInputOption: 'RAW', requestBody: { values: [mutation.after] },
    }), false);
  }
  await assertLedgerLock(spreadsheetId, lockId);
  await withClanAdministrationTransaction(async (session) => {
    const pending = await RosterMutation.findOne({ _id: mutation._id, status: 'pending' }).session(session);
    if (!pending) return;
    for (const change of pending.linkChanges) {
      await User.updateOne({ _id: change.userId }, change.links.length
        ? { $set: { sheetRecords: change.links }, $unset: { sheetRecordName: '' } }
        : { $unset: { sheetRecords: '', sheetRecordName: '' } }, { session });
    }
    const cache = await SheetRosterCache.findOne({ cacheKey: spreadsheetId }).session(session);
    if (!cache || cache.weeklyResetLockId !== lockId || cache.weeklyResetLockUntil.getTime() <= Date.now()) throw new DkpIntegrityError('The roster change lost its ledger lock. Retry the original request.');
    cache.weeklyActivityHistory = (cache.weeklyActivityHistory ?? []).filter((entry) => entry.rowIndex !== pending.rowIndex && getSheetRecordKey(entry) !== pending.identityKey);
    cache.fetchedAt = new Date(0); cache.refreshLockUntil = new Date(0); cache.generation += 1;
    await cache.save({ session });
    const toon = { rowIndex: pending.rowIndex, owner: pending.owner, account: pending.account };
    await ClanAuditEvent.create([{
      eventType: pending.action === 'create' ? 'toon-created' : 'toon-removed',
      actorUserId: pending.actorUserId, actorNickname: pending.actorNickname, actorRole: pending.actorRole,
      targetNickname: pending.account || pending.owner, previousRole: 'unlinked',
      ...(pending.action === 'create' ? { addedToons: [toon] } : { removedToons: [toon], forfeitedDkp: pending.before.slice(3, 9) }),
    }], { session });
    pending.status = 'applied';
    await pending.save({ session });
  }, { recoveringRoster: true });
}

export async function changeClanToon(actorUserId: string, requestId: string, input:
  | { action: 'create'; owner: string; account: string; subClass: string }
  | { action: 'remove'; rowIndex: number; owner: string; account: string }) {
  assertDkpWritesEnabled();
  await dbConnect();
  const spreadsheetId = getSpreadsheetId();
  await ensureSheetRosterCacheDocument(spreadsheetId);
  const id = createHash('sha256').update(`roster:${spreadsheetId}:${actorUserId}:${requestId}`).digest('hex');
  const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  return withWeeklyResetLock(spreadsheetId, async (lockId) => {
    const previous = await RosterMutation.findById(id).lean();
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new RequestValidationError('This request ID was already used for a different toon change.', 409);
      return { rowIndex: previous.rowIndex, replayed: true };
    }
    if (input.action === 'create' && (!ITEM_SUBROLES.includes(input.subClass as typeof ITEM_SUBROLES[number]) || input.subClass === 'Everyone')) throw new RequestValidationError('Choose a supported toon subrole.');
    const rows = await readSheetRows();
    const roster = rosterFromRows(rows);
    const identityKey = getSheetRecordKey(input);
    let rowIndex: number;
    let subClass: string;
    if (input.action === 'create') {
      if (roster.some((record) => record.account.trim().toLowerCase() === input.account.toLowerCase())) throw new RequestValidationError('A toon with this name is already in the clan.', 409);
      if (await RosterMutation.exists({ spreadsheetId, identityKey })) throw new RequestValidationError('This toon identity already has a roster lifecycle and cannot be recreated with its old history.', 409);
      if (await BossAward.exists({ participants: { $elemMatch: { owner: input.owner, account: input.account } } }).collation({ locale: 'en', strength: 2 })) throw new RequestValidationError('This owner/toon identity already has clan award history. Reconcile the existing identity instead of creating it as a brand-new toon.', 409);
      // Never place a new toon on a row still referenced by saved identities,
      // historical bids, awards, or earlier financial/roster operations.
      const referenced = await Promise.all([
        User.distinct('sheetRecords.rowIndex'), Auction.distinct('highBid.rowIndex'), Auction.distinct('winner.rowIndex'),
        BossAward.distinct('participants.rowIndex'), BossAward.distinct('pendingChange.participants.rowIndex'),
        DkpSheetMutation.distinct('identities.rowIndex', { spreadsheetId }), RosterMutation.distinct('rowIndex', { spreadsheetId }),
      ]);
      const reserved = new Set<number>([...roster.map((record) => record.rowIndex), ...referenced.flat().filter((value): value is number => typeof value === 'number')]);
      rowIndex = 0;
      for (let row = 3; row <= 1000; row += 1) {
        if (!reserved.has(row) && Array.from({ length: 3 }, (_, index) => rows[row - 3]?.[index] ?? '').every((value) => !value.trim())) { rowIndex = row; break; }
      }
      if (!rowIndex) throw new RequestValidationError('No unused roster row is available within rows 3–1000. Contact the site owner to expand roster capacity.', 409);
      subClass = input.subClass;
    } else {
      rowIndex = input.rowIndex;
      const record = roster.find((entry) => entry.rowIndex === rowIndex);
      if (!record || getSheetRecordKey(record) !== identityKey) throw new RequestValidationError('This roster entry changed. Refresh the list before removing it.', 409);
      if (roster.filter((entry) => getSheetRecordKey(entry) === identityKey).length !== 1) throw new RequestValidationError('This toon has a duplicate owner/toon identity. Reconcile the duplicate rows before removing it.', 409);
      subClass = record.subClass;
    }
    const before = Array.from({ length: 9 }, (_, index) => String(rows[rowIndex - 3]?.[index] ?? ''));
    const after = input.action === 'create' ? [input.owner, input.account, subClass, 0, 0, 0, 0, 0, 0] : Array<string>(9).fill('');
    await assertLedgerLock(spreadsheetId, lockId);
    await withClanAdministrationTransaction(async (session) => {
      const actor = await User.findOne({ _id: actorUserId, status: 'approved', role: { $in: ['chief', 'general'] } }).session(session);
      if (!actor) throw new RequestValidationError('Only Chief and General accounts can manage clan toons.', 403);
      const holds = await AuctionHold.find({ heldPoints: { $ne: 0 } }).select('rowIndex owner account heldPoints').session(session).lean();
      const auctions = await Auction.find({ $or: [{ status: { $in: ['active', 'removing', 'settling', 'settlement-failed'] } }, { status: 'completed', deliveryStatus: 'pending' }] }).select('status deliveryStatus highBid winner').session(session).lean();
      const awards = await BossAward.find({ status: { $in: ['pending', 'updating'] } }).select('participants pendingChange').session(session).lean();
      const users = await User.find().select('_id sheetRecords sheetRecordName').session(session).lean();
      if (getReservationConflict({ identities: [input], rows: [rowIndex], rejectUnverifiedLegacyHolds: true }, holds, auctions)) throw new RequestValidationError('Resolve this toon’s reserved bids, unfinished auctions or pending delivery before removing it. Its DKP can then be forfeited.', 409);
      if (awards.some((award) => [...award.participants, ...(award.pendingChange?.participants ?? [])].some((participant) => participant.rowIndex === rowIndex || getSheetRecordKey(participant) === identityKey))) throw new RequestValidationError('Finish this toon’s pending boss award or attendance change before changing its roster entry.', 409);
      const linkChanges = users.flatMap((user) => {
        const legacyMatches = user.sheetRecordName?.trim().toLowerCase() === input.owner.toLowerCase();
        if (!legacyMatches && !user.sheetRecords?.some((record) => record.rowIndex === rowIndex || getSheetRecordKey(record) === identityKey)) return [];
        const existing = user.sheetRecords?.length ? user.sheetRecords : roster.filter((record) => getLinkedSheetRecordRows(user, roster).includes(record.rowIndex));
        // Identity-only links avoid retaining any stale physical row ownership.
        const links = existing.filter((record) => getSheetRecordKey(record) !== identityKey).map(({ owner, account }) => ({ owner, account }));
        return [{ userId: user._id.toString(), links }];
      });
      await RosterMutation.create([{
        _id: id, spreadsheetId, fingerprint, action: input.action, status: 'pending', rowIndex, identityKey,
        owner: input.owner, account: input.account, subClass, before, after,
        actorUserId: actor._id, actorNickname: actor.nickname, actorRole: actor.role, linkChanges,
      }], { session });
    });
    await replayPendingRosterMutation(spreadsheetId, lockId);
    return { rowIndex, replayed: false };
  });
}

export async function updatePlayerDKP(rowIndex: number, pointsToAdd: number) {
  await adjustPlayersDKP([{ rowIndex, points: pointsToAdd }], { mode: 'weekly-earned' });
}

export async function isDkpMutationApplied(operationKey: string) {
  await dbConnect();
  return Boolean(await DkpSheetMutation.exists({ spreadsheetId: getSpreadsheetId(), operationKey, status: 'applied' }));
}
