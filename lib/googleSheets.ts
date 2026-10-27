// lib/googleSheets.ts
import { createHash, randomUUID } from 'node:crypto';
import mongoose, { type ClientSession, type Types } from 'mongoose';
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
import { buildDkpAdjustmentUpdates, DkpIntegrityError, getDkpReplayState, readDkpCell, snapshotDkpCells } from '@/lib/dkpAccounting';
import { getSheetRecordKey } from '@/lib/sheetRecordLinks';
import User from '@/lib/models/User';
import RosterMutation, { type RosterMutationRecord } from '@/lib/models/RosterMutation';
import ToonRoleChange from '@/lib/models/ToonRoleChange';
import ToonRoleChangeAudit from '@/lib/models/ToonRoleChangeAudit';
import ToonRoleChangeRequest from '@/lib/models/ToonRoleChangeRequest';
import ClanAuditEvent from '@/lib/models/ClanAuditEvent';
import Auction from '@/lib/models/Auction';
import AuctionBidHistory from '@/lib/models/AuctionBidHistory';
import BossAward from '@/lib/models/BossAward';
import { getLinkedSheetRecordRows } from '@/lib/sheetRecordLinks';
import { getReservationConflict } from '@/lib/auth/reservationProtection';
import { ITEM_SUBROLES, normalizeAuctionRole } from '@/lib/auctionRules';
import { withClanAdministrationTransaction } from '@/lib/auth/administration';
import { RequestValidationError } from '@/lib/security/request';
import { parseSheetRoster, requireRosterValues } from '@/lib/sheetRoster';
import { isApprovedToonRoleSchedule } from '@/lib/toonRoleChanges';

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

async function getRosterSheetId(sheets: ReturnType<typeof google.sheets>) {
  const response = await withGoogleSheetsRetry(() => sheets.spreadsheets.get({
    spreadsheetId: getSpreadsheetId(), fields: 'sheets.properties(sheetId,title)',
  }), true);
  const sheet = response.data.sheets?.find((entry) => entry.properties?.title === 'DKP_Sheet_automated');
  if (typeof sheet?.properties?.sheetId !== 'number') throw new DkpIntegrityError('The DKP roster tab could not be found.');
  return sheet.properties.sheetId;
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

/** Apply approved subclass switches to the Sheet after their effective time. */
export async function applyDueToonRoleChanges(at?: Date) {
  assertDkpWritesEnabled();
  await dbConnect();
  const spreadsheetId = getSpreadsheetId();
  await ensureSheetRosterCacheDocument(spreadsheetId);

  return withWeeklyResetLock(spreadsheetId, async (lockId) => {
    const now = at ?? new Date();
    const unverifiedDueChanges = await ToonRoleChange.find({
      scheduledRole: { $exists: true, $nin: ['', null] }, effectiveAt: { $lte: now },
    }).sort({ effectiveAt: 1 }).lean();
    const scheduleApprovals = unverifiedDueChanges.length ? await ToonRoleChangeRequest.find({
      identityKey: { $in: unverifiedDueChanges.map((change) => change.identityKey) },
      status: { $in: ['approved', 'applied'] }, decidedByUserId: { $exists: true }, decidedAt: { $exists: true },
    }).sort({ createdAt: -1 }).lean() : [];
    const dueChanges = unverifiedDueChanges.filter((change) => scheduleApprovals.some((approval) =>
      approval.identityKey === change.identityKey && isApprovedToonRoleSchedule(change, approval)));
    const sheets = createSheetsClient();
    const rows = dueChanges.length ? await readSheetRows(sheets) : [];
    const roster = dueChanges.length ? rosterFromRows(rows) : [];
    const updates: Array<{ range: string; values: string[][] }> = [];
    const completed: Array<{ identityKey: string; owner: string; account: string; currentRole: string; scheduledRole: string; effectiveAt: Date }> = [];

    for (const change of dueChanges) {
      const scheduledRole = change.scheduledRole ?? '';
      if (!ITEM_SUBROLES.some((role) => role !== 'Everyone' && role === scheduledRole)) {
        throw new DkpIntegrityError('A scheduled toon subrole is invalid. A manager must review it before the Sheet can be updated.');
      }
      const matches = roster.filter((toon) => getSheetRecordKey(toon) === change.identityKey);
      if (matches.length !== 1) {
        throw new DkpIntegrityError('A scheduled toon subrole could not be matched to exactly one Google Sheets row. Reconcile the roster before retrying.');
      }
      const toon = matches[0];
      const sheetRole = String(rows[toon.rowIndex - 3]?.[2] ?? '').trim();
      const normalizedSheetRole = normalizeAuctionRole(sheetRole);
      const normalizedCurrentRole = normalizeAuctionRole(change.currentRole);
      const normalizedScheduledRole = normalizeAuctionRole(scheduledRole);
      if (normalizedSheetRole !== normalizedCurrentRole && normalizedSheetRole !== normalizedScheduledRole) {
        throw new DkpIntegrityError('The toon subrole in Google Sheets changed after approval. A manager must reconcile it before the scheduled change can be applied.');
      }
      if (normalizedSheetRole !== normalizedScheduledRole) {
        updates.push({ range: `${SHEET_NAME}!C${toon.rowIndex}`, values: [[scheduledRole]] });
      }
      completed.push({
        identityKey: change.identityKey, owner: toon.owner, account: toon.account,
        currentRole: change.currentRole, scheduledRole, effectiveAt: change.effectiveAt!,
      });
    }

    if (updates.length) {
      await assertLedgerLock(spreadsheetId, lockId);
      await withGoogleSheetsRetry(() => sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: { valueInputOption: 'RAW', data: updates },
      }), false);
      await assertLedgerLock(spreadsheetId, lockId);
    }
    await assertLedgerLock(spreadsheetId, lockId);

    if (!completed.length && !await ToonRoleChangeRequest.exists({ status: 'pending', effectiveAt: { $lte: now } })) {
      return { applied: 0, expired: 0 };
    }

    let expiredCount = 0;
    await withClanAdministrationTransaction(async (session) => {
      for (const change of completed) {
        const current = await ToonRoleChange.findOne({ identityKey: change.identityKey }).session(session);
        if (!current) throw new DkpIntegrityError('A scheduled toon role record disappeared while its Sheet update was being finalized.');
        const hasSameDueSchedule = current.scheduledRole === change.scheduledRole && current.effectiveAt?.getTime() === change.effectiveAt.getTime();
        if (hasSameDueSchedule) {
          current.currentRole = change.scheduledRole;
          current.scheduledRole = undefined;
          current.effectiveAt = undefined;
          await current.save({ session });
        } else if (normalizeAuctionRole(current.currentRole) !== normalizeAuctionRole(change.scheduledRole) ||
          (current.effectiveAt && current.effectiveAt.getTime() <= now.getTime())) {
          throw new DkpIntegrityError('A scheduled toon role changed while its Sheet update was being finalized. A manager must review it.');
        }
      }

      if (completed.length) {
        await ToonRoleChangeRequest.updateMany({
          identityKey: { $in: completed.map((change) => change.identityKey) },
          status: 'approved', effectiveAt: { $lte: now },
        }, { $set: { status: 'applied' } }, { session });
      }

      const expiredRequests = await ToonRoleChangeRequest.find({ status: 'pending', effectiveAt: { $lte: now } }).session(session).lean();
      if (expiredRequests.length) {
        expiredCount = expiredRequests.length;
        await ToonRoleChangeRequest.updateMany(
          { _id: { $in: expiredRequests.map((request) => request._id) }, status: 'pending' },
          { $set: { status: 'expired' } }, { session },
        );
        await ToonRoleChangeAudit.insertMany(expiredRequests.map((request) => ({
          action: 'expired' as const, identityKey: request.identityKey, owner: request.owner, account: request.account,
          previousRole: request.currentRole, scheduledRole: request.requestedRole, effectiveAt: request.effectiveAt,
          actorNickname: 'System', actorRole: 'system' as const,
        })), { session });
      }
    });

    if (completed.length) await invalidateSheetRosterCache();
    return { applied: completed.length, expired: expiredCount };
  });
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
      cacheStatus: 'cache' as const,
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
        const failedCache = await SheetRosterCache.findOne({ cacheKey }).lean();
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

  const latest = await SheetRosterCache.findOne({ cacheKey }).lean();
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
  const cacheKey = getSpreadsheetId();
  await SheetRosterCache.updateOne(
    { cacheKey },
    { $set: { fetchedAt: new Date(0) }, $inc: { generation: 1 } },
  );
}

type ToonDkpResetMode = 'available' | 'all';
type ToonDkpResetIdentity = { owner: string; account: string };
type ToonDkpResetActor = { _id: Types.ObjectId; nickname: string; role: string };

/** Reset a toon through the recoverable sheet-mutation ledger. Related Mongo changes
 * can be committed in the same transaction as the pending sheet write. */
export async function resetToonDkp(options: {
  actorUserId: string;
  requestId: string;
  identity: ToonDkpResetIdentity;
  mode: ToonDkpResetMode;
  fingerprintData?: unknown;
  beforeMutation?: (session: ClientSession, record: ISheetRosterRecord, actor: ToonDkpResetActor, roster: ISheetRosterRecord[]) => Promise<void>;
  mutate?: (session: ClientSession, record: ISheetRosterRecord, actor: ToonDkpResetActor, roster: ISheetRosterRecord[]) => Promise<void>;
}) {
  assertDkpWritesEnabled();
  await dbConnect();
  const spreadsheetId = getSpreadsheetId();
  await ensureSheetRosterCacheDocument(spreadsheetId);
  const operationKey = createHash('sha256')
    .update(`toon-dkp:${spreadsheetId}:${options.actorUserId}:${options.requestId}`).digest('hex');
  const requestFingerprint = createHash('sha256').update(JSON.stringify({
    identity: options.identity, mode: options.mode, fingerprintData: options.fingerprintData,
  })).digest('hex');

  return withWeeklyResetLock(spreadsheetId, async (lockId) => {
    const existing = await DkpSheetMutation.findOne({ spreadsheetId, operationKey });
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        throw new RequestValidationError('This request ID was already used for a different toon DKP change.', 409);
      }
      if (existing.status === 'applied') return { rowIndex: existing.identities?.[0]?.rowIndex, replayed: true };
      throw new DkpIntegrityError('The previous toon DKP change is awaiting recovery. Retry the same request.');
    }

    const sheets = createSheetsClient();
    const rows = await readSheetRows(sheets);
    const roster = rosterFromRows(rows);
    const matchingRecords = roster.filter((record) => getSheetRecordKey(record) === getSheetRecordKey(options.identity));
    if (matchingRecords.length !== 1) throw new RequestValidationError('This toon identity is missing or duplicated in the Sheet. Correct the roster before changing DKP.', 409);
    const record = matchingRecords[0];
    requireRosterValues(record, options.mode === 'available' ? ['available'] : ['weeklyEarned', 'weeklySpent', 'earned', 'spent', 'available', 'fiveWeekActivity']);

    const loadActor = async (session: ClientSession) => {
      const actor = await User.findOne({ _id: options.actorUserId, status: 'approved' })
        .select('_id nickname role').session(session);
      if (!actor || !['chief', 'general'].includes(actor.role)) throw new RequestValidationError('Only Chiefs and Generals can change toon DKP.', 403);
      return actor as ToonDkpResetActor;
    };
    if (options.beforeMutation) {
      await withClanAdministrationTransaction(async (session) => {
        const actor = await loadActor(session);
        await options.beforeMutation!(session, record, actor, roster);
      });
    }

    const columns = options.mode === 'available' ? ['H'] : ['D', 'E', 'F', 'G', 'H', 'I'];
    const updates: SheetValueUpdate[] = columns.map((column) => ({ range: `${SHEET_NAME}!${column}${record.rowIndex}`, values: [[0]] }));
    const previousValues = snapshotDkpCells(updates, rows);
    getDkpReplayState(previousValues, updates, rows);
    let weeklyActivityHistory: Array<{ rowIndex: number; owner: string; account: string; weeks: number[] }> | undefined;
    if (options.mode === 'all') {
      const cache = await SheetRosterCache.findOne({ cacheKey: spreadsheetId }).lean();
      const currentHistory = cache?.weeklyActivityHistory ?? initializeWeeklyDkpActivityHistory(
        roster.filter((entry) => entry.fiveWeekActivity !== null).map((entry) => ({ ...entry, fiveWeekActivity: entry.fiveWeekActivity! })),
      );
      const resetKey = getSheetRecordKey(record);
      weeklyActivityHistory = currentHistory.map((entry) => getSheetRecordKey(entry) === resetKey
        ? { ...entry, rowIndex: record.rowIndex, weeks: [] }
        : entry);
      if (!weeklyActivityHistory.some((entry) => getSheetRecordKey(entry) === resetKey)) {
        weeklyActivityHistory.push({ rowIndex: record.rowIndex, owner: record.owner, account: record.account, weeks: [] });
      }
    }

    await assertLedgerLock(spreadsheetId, lockId);
    await withClanAdministrationTransaction(async (session) => {
      const actor = await loadActor(session);
      if (options.mutate) await options.mutate(session, record, actor, roster);
      await DkpSheetMutation.create([{
        spreadsheetId, operationKey, requestFingerprint, status: 'pending', updates, previousValues,
        identities: [{ rowIndex: record.rowIndex, owner: record.owner, account: record.account }],
        actorUserId: options.actorUserId,
        ...(weeklyActivityHistory ? { weeklyActivityHistory } : {}),
      }], { session });
    });
    await replayPendingSheetMutation(spreadsheetId, sheets, lockId);
    return { rowIndex: record.rowIndex, replayed: false };
  });
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
    mode?: 'balance' | 'available' | 'weekly-earned' | 'auction-spend';
    idempotencyKey?: string;
    /** Award occurrence time: determines the credited week inside the ledger lock. */
    earnedAt?: Date;
    /** For staff awards, authorize the durable plan atomically with role edits. */
    actorUserId?: string;
    /** Commit related audit changes atomically with the recoverable Sheet operation. */
    mutate?: (session: ClientSession) => Promise<void>;
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
    const operationalTargets = targets.map((target) => {
      if (typeof target.owner !== 'string' || typeof target.account !== 'string') return target;
      const identity = { owner: target.owner, account: target.account };
      const identityMatches = roster.filter((record) => getSheetRecordKey(record) === getSheetRecordKey(identity));
      if (identityMatches.length !== 1) throw new RequestValidationError('This toon identity is missing or duplicated in the Sheet. Correct the roster before changing DKP.', 409);
      return { ...target, rowIndex: identityMatches[0].rowIndex };
    });
    const now = new Date();
    const historical = requestedMode === 'weekly-earned' && options.earnedAt &&
      options.earnedAt < getCurrentDkpWeekStart(now);
    const mode = historical ? 'balance' : requestedMode;
    const holds = mode === 'weekly-earned' ? [] : await AuctionHold.find({ heldPoints: { $ne: 0 } })
      .select('rowIndex owner account heldPoints').lean();
    const holdsByRow = new Map<number, number>();
    for (const target of operationalTargets.filter(({ points }) => points < 0)) {
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
    const updates = operationalTargets.flatMap(({ rowIndex, points, owner, account }) => buildDkpAdjustmentUpdates({
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
        operationalTargets, options.earnedAt, now, SHEET_NAME,
      );
      updates.push(...correction.updates);
      weeklyActivityHistory = correction.weeklyActivityHistory;
    }
    const identities = operationalTargets.map(({ rowIndex }) => {
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
    if (options.actorUserId || options.mutate) {
      await withClanAdministrationTransaction(async (session) => {
        if (options.actorUserId) {
          const actor = await User.findOne({
            _id: options.actorUserId, status: 'approved', role: { $in: ['chief', 'general', 'guardian'] },
          }).select('_id').session(session).lean();
          if (!actor) throw new RequestValidationError('Your role no longer permits DKP changes.', 403);
        }
        if (options.mutate) await options.mutate(session);
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

/** Restore a toon’s exact D:I snapshot after undoing a transfer. The write and
 * related Mongo changes are durably committed together before Sheets is updated. */
export async function restoreToonDkpSnapshot(options: {
  actorUserId: string;
  requestId: string;
  identity: { owner: string; account: string };
  values: number[];
  weeklyActivity: number[];
  mutate: (session: ClientSession, record: ISheetRosterRecord, roster: ISheetRosterRecord[]) => Promise<void>;
}) {
  assertDkpWritesEnabled();
  if (options.values.length !== 6 || options.values.some((value) => !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) ||
    options.weeklyActivity.length > 5 || options.weeklyActivity.some((value) => !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) {
    throw new RequestValidationError('The transfer’s saved DKP snapshot is incomplete or invalid.', 409);
  }
  await dbConnect();
  const spreadsheetId = getSpreadsheetId();
  await ensureSheetRosterCacheDocument(spreadsheetId);
  const operationKey = createHash('sha256').update(`transfer-undo:${spreadsheetId}:${options.actorUserId}:${options.requestId}`).digest('hex');
  const requestFingerprint = createHash('sha256').update(JSON.stringify({
    identity: options.identity, values: options.values, weeklyActivity: options.weeklyActivity,
  })).digest('hex');

  return withWeeklyResetLock(spreadsheetId, async (lockId) => {
    const existing = await DkpSheetMutation.findOne({ spreadsheetId, operationKey });
    if (existing) {
      if (existing.requestFingerprint && existing.requestFingerprint !== requestFingerprint) {
        throw new DkpIntegrityError('This request ID was already used for a different DKP operation.');
      }
      let recoveredStatus = existing.status;
      let recoveredRowIndex = existing.identities?.[0]?.rowIndex;
      if (recoveredStatus === 'pending') {
        const sheets = createSheetsClient();
        while (recoveredStatus === 'pending') {
          const replayed = await replayPendingSheetMutation(spreadsheetId, sheets, lockId);
          const refreshed = await DkpSheetMutation.findById(existing._id).lean();
          if (!refreshed) throw new DkpIntegrityError('The pending transfer DKP recovery record disappeared.');
          recoveredStatus = refreshed.status;
          recoveredRowIndex = refreshed.identities?.[0]?.rowIndex;
          if (recoveredStatus === 'pending' && !replayed) throw new DkpIntegrityError('The transfer DKP recovery record is still pending. Retry after the Sheet ledger is recovered.');
        }
      }
      return { rowIndex: recoveredRowIndex, replayed: true };
    }

    const sheets = createSheetsClient();
    const rows = await readSheetRows(sheets);
    const roster = rosterFromRows(rows);
    const matching = roster.filter((record) => getSheetRecordKey(record) === getSheetRecordKey(options.identity));
    if (matching.length !== 1) throw new RequestValidationError('The transferred toon is missing or duplicated in the Sheet.', 409);
    const record = matching[0];
    requireRosterValues(record, ['weeklyEarned', 'weeklySpent', 'earned', 'spent', 'available', 'fiveWeekActivity']);
    if ([record.weeklyEarned, record.weeklySpent, record.earned, record.spent, record.available, record.fiveWeekActivity].some((value) => value !== 0)) {
      throw new RequestValidationError('This toon has changed DKP since the transfer. Resolve its DKP before undoing the transfer.', 409);
    }
    const updates: SheetValueUpdate[] = ['D', 'E', 'F', 'G', 'H', 'I'].map((column, index) => ({
      range: `${SHEET_NAME}!${column}${record.rowIndex}`, values: [[options.values[index]]],
    }));
    const previousValues = snapshotDkpCells(updates, rows);
    getDkpReplayState(previousValues, updates, rows);
    await assertLedgerLock(spreadsheetId, lockId);
    await withClanAdministrationTransaction(async (session) => {
      const actor = await User.findOne({ _id: options.actorUserId, status: 'approved', role: { $in: ['chief', 'general'] } })
        .select('_id').session(session).lean();
      if (!actor) throw new RequestValidationError('Only Chief and General accounts can undo a transfer.', 403);
      await options.mutate(session, record, roster);
      const cache = await SheetRosterCache.findOne({ cacheKey: spreadsheetId }).session(session).lean();
      if (!cache) throw new DkpIntegrityError('The roster cache is unavailable while restoring the transfer snapshot.');
      const identityKey = getSheetRecordKey(record);
      const weeklyActivityHistory = (cache.weeklyActivityHistory ?? []).map((entry) => getSheetRecordKey(entry) === identityKey
        ? { ...entry, rowIndex: record.rowIndex, owner: record.owner, account: record.account, weeks: [...options.weeklyActivity] }
        : entry);
      if (!weeklyActivityHistory.some((entry) => getSheetRecordKey(entry) === identityKey)) {
        weeklyActivityHistory.push({ rowIndex: record.rowIndex, owner: record.owner, account: record.account, weeks: [...options.weeklyActivity] });
      }
      await DkpSheetMutation.create([{
        spreadsheetId, operationKey, requestFingerprint, status: 'pending', updates, previousValues,
        identities: [{ rowIndex: record.rowIndex, owner: record.owner, account: record.account }],
        actorUserId: options.actorUserId, weeklyActivityHistory,
      }], { session });
    });
    await replayPendingSheetMutation(spreadsheetId, sheets, lockId);
    try { await invalidateSheetRosterCache(); }
    catch (error: unknown) { console.error('Transfer DKP was restored in Google Sheets, but the roster cache could not be invalidated', error instanceof Error ? error.name : 'UnknownError'); }
    return { rowIndex: record.rowIndex, replayed: false };
  });
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
  const compaction = mutation.compaction;
  const currentRows = compaction ? Array.from({ length: compaction.endRow - 2 }, (_, rowOffset) =>
    Array.from({ length: 9 }, (_, column) => String(rows[rowOffset]?.[column] ?? ''))) : [];
  const sameRows = (expected: Array<Array<string | number>>) => expected.length === currentRows.length &&
    expected.every((row, rowIndex) => row.length === 9 && row.every((value, column) => String(value) === currentRows[rowIndex][column]));
  const alreadyApplied = compaction ? sameRows(compaction.afterRows) : same(mutation.after);
  if (!alreadyApplied) {
    const matchesBefore = compaction ? sameRows(compaction.beforeRows) : same(mutation.before);
    if (!matchesBefore) throw new DkpIntegrityError('An interrupted clan toon change no longer matches its Sheet snapshot. Clan leadership must reconcile the roster before continuing.');
    await assertLedgerLock(spreadsheetId, lockId);
    if (compaction) {
      const sheetId = await getRosterSheetId(sheets);
      const deletedRows = [...compaction.deletedRows].sort((first, second) => second - first);
      const requests: Array<Record<string, unknown>> = deletedRows.map((rowIndex) => ({
        deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: rowIndex - 1, endIndex: rowIndex } },
      }));
      if (deletedRows.length) requests.push({ appendDimension: { sheetId, dimension: 'ROWS', length: deletedRows.length } });
      if (mutation.action === 'create' || mutation.action === 'restore') requests.push({
        updateCells: {
          range: { sheetId, startRowIndex: mutation.rowIndex - 1, endRowIndex: mutation.rowIndex, startColumnIndex: 0, endColumnIndex: 9 },
          rows: [{ values: mutation.after.map((value) => typeof value === 'number'
            ? { userEnteredValue: { numberValue: value } }
            : { userEnteredValue: { stringValue: String(value) } }) }],
          fields: 'userEnteredValue',
        },
      });
      await withGoogleSheetsRetry(() => sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } }), false);
    } else {
      await withGoogleSheetsRetry(() => sheets.spreadsheets.values.update({
        spreadsheetId, range: `${SHEET_NAME}!A${mutation.rowIndex}:I${mutation.rowIndex}`,
        valueInputOption: 'RAW', requestBody: { values: [mutation.after] },
      }), false);
    }
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
    if (pending.compaction?.deletedRows.length) {
      await AuctionHold.deleteMany({ rowIndex: { $in: pending.compaction.deletedRows }, heldPoints: 0 }, { session });
    }
    if (pending.action === 'remove') {
      await AuctionHold.deleteMany({ $or: [
        { rowIndex: pending.rowIndex },
        { owner: pending.owner, account: pending.account },
      ] }, { session });
      const activeAuctionIds = await Auction.find({ status: 'active' }).distinct('_id').session(session);
      if (activeAuctionIds.length) await AuctionBidHistory.updateMany({
        identityKey: pending.identityKey, auctionId: { $in: activeAuctionIds }, withdrawnAt: { $exists: false },
      }, { $set: { withdrawnAt: new Date() } }, { session });
    }
    if (pending.action === 'restore' && pending.toonRoleChangeBefore) {
      const roleChange = pending.toonRoleChangeBefore;
      await ToonRoleChange.create([{
        ...roleChange,
        _id: new mongoose.Types.ObjectId(String(roleChange._id)),
        identityKey: pending.identityKey,
        owner: pending.owner,
        account: pending.account,
      }], { session });
    }
    for (const move of pending.compaction?.moves ?? []) {
      await AuctionHold.updateOne(
        { rowIndex: move.fromRow, $or: [
          { owner: move.owner, account: move.account },
          { owner: { $exists: false } },
        ] },
        { $set: { rowIndex: move.toRow } }, { session },
      );
      await Auction.updateMany({ 'highBid.owner': move.owner, 'highBid.account': move.account },
        { $set: { 'highBid.rowIndex': move.toRow } }, { session });
      await Auction.updateMany({ 'winner.owner': move.owner, 'winner.account': move.account },
        { $set: { 'winner.rowIndex': move.toRow } }, { session });
      await AuctionBidHistory.updateMany({ owner: move.owner, account: move.account },
        { $set: { rowIndex: move.toRow } }, { session });
      await BossAward.updateMany(
        { participants: { $elemMatch: { owner: move.owner, account: move.account } } },
        { $set: { 'participants.$[participant].rowIndex': move.toRow } },
        { session, arrayFilters: [{ 'participant.owner': move.owner, 'participant.account': move.account }] },
      );
      await BossAward.updateMany(
        { 'pendingChange.participants': { $elemMatch: { owner: move.owner, account: move.account } } },
        { $set: { 'pendingChange.participants.$[participant].rowIndex': move.toRow } },
        { session, arrayFilters: [{ 'participant.owner': move.owner, 'participant.account': move.account }] },
      );
    }
    if (pending.compaction?.moves.length) {
      await User.updateMany({ 'sheetRecords.rowIndex': { $exists: true } },
        { $unset: { 'sheetRecords.$[].rowIndex': '' } }, { session });
    }
    const cache = await SheetRosterCache.findOne({ cacheKey: spreadsheetId }).session(session);
    if (!cache || cache.weeklyResetLockId !== lockId || cache.weeklyResetLockUntil.getTime() <= Date.now()) throw new DkpIntegrityError('The roster change lost its ledger lock. Retry the original request.');
    const movedRows = new Map((pending.compaction?.moves ?? []).map((move) => [getSheetRecordKey(move), move.toRow]));
    const movedHistory = (cache.weeklyActivityHistory ?? [])
      .filter((entry) => getSheetRecordKey(entry) !== pending.identityKey)
      .map((entry) => ({ ...entry, rowIndex: movedRows.get(getSheetRecordKey(entry)) ?? entry.rowIndex }));
    if (pending.action === 'create' || pending.action === 'restore') movedHistory.push({
      rowIndex: pending.rowIndex, owner: pending.owner, account: pending.account,
      weeks: pending.action === 'restore' ? pending.restoredWeeklyActivity ?? [] : [],
    });
    cache.weeklyActivityHistory = movedHistory;
    cache.fetchedAt = new Date(0); cache.refreshLockUntil = new Date(0); cache.generation += 1;
    await cache.save({ session });
    const toon = { rowIndex: pending.rowIndex, owner: pending.owner, account: pending.account };
    const [rosterEvent] = await ClanAuditEvent.create([{
      eventType: pending.action === 'create' ? 'toon-created' : pending.action === 'restore' ? 'toon-restored' : 'toon-removed',
      actorUserId: pending.actorUserId, actorNickname: pending.actorNickname, actorRole: pending.actorRole,
      targetNickname: pending.account || pending.owner, previousRole: pending.action === 'restore' ? 'archived' : 'unlinked',
      ...(pending.action === 'remove' ? { removedToons: [toon], forfeitedDkp: pending.before.slice(3, 9) } : { addedToons: [toon] }),
    }], { session });
    if (pending.action === 'remove') {
      pending.removalEventId = rosterEvent._id;
      await pending.save({ session });
    }
    if (pending.archiveMutationId) {
      const archived = await RosterMutation.findOne({ _id: pending.archiveMutationId, action: 'remove', status: 'applied', restoredAt: { $exists: false } }).session(session);
      if (!archived) throw new DkpIntegrityError('The toon archive changed before restoration could be finalized. A manager must review the roster history.');
      archived.restoredAt = new Date(); archived.restoredByUserId = pending.actorUserId;
      archived.restoredByNickname = pending.actorNickname; archived.restoreRequestId = pending.restoreRequestId;
      await archived.save({ session });
    }
    const undoEventId = pending.undoEventId ?? (pending.archiveMutationId
      ? (await RosterMutation.findById(pending.archiveMutationId).select('removalEventId').session(session).lean())?.removalEventId?.toString()
      : undefined);
    if (undoEventId) {
      const original = await ClanAuditEvent.findOne({ _id: undoEventId, eventType: { $in: ['toon-created', 'toon-removed'] }, undoneAt: { $exists: false } }).session(session);
      if (!original) throw new DkpIntegrityError('The source toon activity changed before restoration could be finalized. A manager must review the roster history.');
      original.undoneAt = new Date(); original.undoneByUserId = pending.actorUserId;
      original.undoneByNickname = pending.actorNickname; original.undoRequestId = pending.undoRequestId ?? pending.restoreRequestId;
      await original.save({ session });
    }
    pending.status = 'applied';
    await pending.save({ session });
  }, { recoveringRoster: true });
}

export async function changeClanToon(actorUserId: string, requestId: string, input:
  | { action: 'create'; owner: string; account: string; subClass: string }
  | { action: 'remove'; rowIndex: number; owner: string; account: string; undoCreatedEventId?: string }
  | { action: 'restore'; archiveMutationId: string; undoEventId?: string }) {
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
      if (previous.status === 'pending') await replayPendingRosterMutation(spreadsheetId, lockId);
      return { rowIndex: previous.rowIndex, replayed: true };
    }
    const archived = input.action === 'restore'
      ? await RosterMutation.findOne({ _id: input.archiveMutationId, spreadsheetId, action: 'remove', status: 'applied', restoredAt: { $exists: false } }).lean()
      : null;
    if (input.action === 'restore' && !archived) throw new RequestValidationError('This toon archive was already restored or is unavailable.', 409);
    const owner = input.action === 'restore' ? archived!.owner : input.owner;
    const account = input.action === 'restore' ? archived!.account : input.account;
    if (input.action === 'create' && (!ITEM_SUBROLES.includes(input.subClass as typeof ITEM_SUBROLES[number]) || input.subClass === 'Everyone')) throw new RequestValidationError('Choose a supported toon subrole.');
    const rows = await readSheetRows();
    const roster = rosterFromRows(rows);
    const orphanedDataRow = rows.findIndex((row) => !String(row[0] ?? '').trim() && row.some((value) => String(value ?? '').trim()));
    if (orphanedDataRow >= 0) throw new RequestValidationError(`Roster row ${orphanedDataRow + 3} contains data without an owner. Clear or repair that row before arranging the roster.`, 409);
    const identityKey = input.action === 'restore' ? archived!.identityKey : getSheetRecordKey({ owner, account });
    let rowIndex: number;
    let subClass: string;
    if (input.action === 'create') {
      if (roster.some((record) => record.account.trim().toLowerCase() === account.toLowerCase())) throw new RequestValidationError('A toon with this name is already in the clan.', 409);
      if (await RosterMutation.exists({ spreadsheetId, identityKey })) throw new RequestValidationError('This toon identity already has a roster lifecycle and cannot be recreated with its old history.', 409);
      if (await BossAward.exists({ participants: { $elemMatch: { owner, account } } }).collation({ locale: 'en', strength: 2 })) throw new RequestValidationError('This owner/toon identity already has clan award history. Reconcile the existing identity instead of creating it as a brand-new toon.', 409);
      // The durable roster mutation compacts all live toons, so the new toon is
      // appended immediately after the current live roster.
      rowIndex = roster.length + 3;
      if (rowIndex > 1000) throw new RequestValidationError('No unused roster row is available within rows 3–1000. Contact the site owner to expand roster capacity.', 409);
      subClass = input.subClass;
    } else if (input.action === 'remove') {
      rowIndex = input.rowIndex;
      const record = roster.find((entry) => entry.rowIndex === rowIndex);
      if (!record || getSheetRecordKey(record) !== identityKey) throw new RequestValidationError('This roster entry changed. Refresh the list before removing it.', 409);
      if (roster.filter((entry) => getSheetRecordKey(entry) === identityKey).length !== 1) throw new RequestValidationError('This toon has a duplicate owner/toon identity. Reconcile the duplicate rows before removing it.', 409);
      subClass = record.subClass;
    } else {
      if (roster.some((record) => getSheetRecordKey(record) === identityKey)) throw new RequestValidationError('This toon is already on the roster.', 409);
      if (archived!.before.length !== 9 || getSheetRecordKey({ owner: archived!.before[0], account: archived!.before[1] }) !== identityKey ||
        archived!.before[2] !== archived!.subClass) {
        throw new RequestValidationError('The saved toon snapshot is incomplete.', 409);
      }
      rowIndex = roster.length + 3;
      if (rowIndex > 1000) throw new RequestValidationError('No unused roster row is available within rows 3â€“1000. Contact the site owner to expand roster capacity.', 409);
      subClass = archived!.subClass;
    }
    const before = Array.from({ length: 9 }, (_, index) => String(rows[rowIndex - 3]?.[index] ?? ''));
    let restoredWeeklyActivity: number[] | undefined;
    let restoreValues: Array<string | number> | undefined;
    if (input.action === 'restore') {
      const savedValues = ['D', 'E', 'F', 'G', 'H', 'I'].map((column, index) => readDkpCell(archived!.before[index + 3], column, archived!.rowIndex));
      restoredWeeklyActivity = archived!.weeklyActivityBefore ?? (savedValues[5] === 0 ? [] : [savedValues[5]]);
      restoreValues = [owner, account, subClass, ...savedValues];
    }
    const after = input.action === 'create' ? [owner, account, subClass, 0, 0, 0, 0, 0, 0]
      : input.action === 'restore' ? restoreValues! : Array<string>(9).fill('');
    const retained = roster
      .filter((record) => input.action !== 'remove' || getSheetRecordKey(record) !== identityKey)
      .map((record) => ({
        record,
        values: Array.from({ length: 9 }, (_, index) => String(rows[record.rowIndex - 3]?.[index] ?? '')),
      }));
    if (input.action === 'create' || input.action === 'restore') retained.push({
      record: { rowIndex, owner, account, subClass,
        weeklyEarned: Number(after[3]), weeklySpent: Number(after[4]), earned: Number(after[5]), spent: Number(after[6]), available: Number(after[7]), fiveWeekActivity: Number(after[8]), dkpIssues: [] },
      values: after.map(String),
    });
    const lastOccupiedRow = roster.reduce((highest, record) => Math.max(highest, record.rowIndex), 3);
    const endRow = Math.max(lastOccupiedRow, retained.length + 2, rowIndex);
    const beforeRows = Array.from({ length: endRow - 2 }, (_, offset) =>
      Array.from({ length: 9 }, (_, column) => String(rows[offset]?.[column] ?? '')));
    const afterRows: Array<Array<string | number>> = Array.from({ length: endRow - 2 }, (_, offset) =>
      retained[offset]?.values ?? Array<string>(9).fill(''));
    const moves = retained.flatMap(({ record }, index) => record.rowIndex === index + 3 ? [] : [{
      owner: record.owner, account: record.account, fromRow: record.rowIndex, toRow: index + 3,
    }]);
    const deletedRows = Array.from({ length: Math.max(0, lastOccupiedRow - 2) }, (_, index) => index + 3)
      .filter((candidate) => !String(rows[candidate - 3]?.[0] ?? '').trim() ||
        (input.action === 'remove' && candidate === input.rowIndex));
    if (input.action === 'create' || input.action === 'restore') rowIndex = retained.length + 2;
    await assertLedgerLock(spreadsheetId, lockId);
    await withClanAdministrationTransaction(async (session) => {
      const actor = await User.findOne({ _id: actorUserId, status: 'approved', role: { $in: ['chief', 'general'] } }).session(session);
      if (!actor) throw new RequestValidationError('Only Chief and General accounts can manage clan toons.', 403);
      const holds = await AuctionHold.find({ heldPoints: { $ne: 0 } }).select('rowIndex owner account heldPoints').session(session).lean();
      const auctions = await Auction.find({ $or: [{ status: { $in: ['active', 'removing', 'settling', 'settlement-failed'] } }, { status: 'completed', deliveryStatus: 'pending' }] }).select('status deliveryStatus highBid winner').session(session).lean();
      const awards = await BossAward.find({ status: { $in: ['pending', 'updating'] } }).select('participants pendingChange').session(session).lean();
      const users = await User.find().select('_id sheetRecords sheetRecordName').session(session).lean();
      if (input.action === 'remove' && input.undoCreatedEventId) {
        const createdEvent = await ClanAuditEvent.findOne({ _id: input.undoCreatedEventId, eventType: 'toon-created', undoneAt: { $exists: false } }).session(session);
        const latestEvents = await ClanAuditEvent.find().sort({ createdAt: -1 }).limit(100).select('_id').session(session).lean();
        if (!createdEvent || !latestEvents.some((event) => event._id.toString() === input.undoCreatedEventId) ||
          !createdEvent.addedToons?.some((toon) => getSheetRecordKey(toon) === identityKey)) {
          throw new RequestValidationError('This toon creation is no longer available to undo.', 409);
        }
        const currentToon = roster.find((record) => getSheetRecordKey(record) === identityKey);
        if (!currentToon) throw new RequestValidationError('This toon is no longer on the roster.', 409);
        requireRosterValues(currentToon, ['weeklyEarned', 'weeklySpent', 'earned', 'spent', 'available', 'fiveWeekActivity']);
        if ([currentToon.weeklyEarned, currentToon.weeklySpent, currentToon.earned, currentToon.spent, currentToon.available, currentToon.fiveWeekActivity].some((value) => value !== 0)) {
          throw new RequestValidationError('This toon has DKP history and cannot be safely undone.', 409);
        }
        const relatedEvents = await ClanAuditEvent.find({ $or: [
          { addedToons: { $elemMatch: { owner: currentToon.owner, account: currentToon.account } } },
          { removedToons: { $elemMatch: { owner: currentToon.owner, account: currentToon.account } } },
          { 'affectedToon.owner': currentToon.owner, 'affectedToon.account': currentToon.account },
          { eventType: 'toon-dkp-wiped', targetNickname: { $in: [currentToon.account, currentToon.owner].filter(Boolean) } },
        ] }).sort({ createdAt: 1, _id: 1 }).select('_id').collation({ locale: 'en', strength: 2 }).session(session).lean();
        const creationPosition = relatedEvents.findIndex((event) => event._id.toString() === input.undoCreatedEventId);
        if (creationPosition < 0 || creationPosition !== relatedEvents.length - 1) {
          throw new RequestValidationError('This toon has later roster activity and cannot be safely undone.', 409);
        }
        const linked = users.some((user) => getLinkedSheetRecordRows(user, roster).includes(currentToon.rowIndex));
        const roleHistory = await Promise.all([
          ToonRoleChange.exists({ identityKey }).session(session),
          ToonRoleChangeAudit.exists({ identityKey }).session(session),
          ToonRoleChangeRequest.exists({ identityKey }).session(session),
          AuctionBidHistory.exists({ identityKey }).session(session),
          Auction.exists({ $or: [
            { 'highBid.owner': currentToon.owner, 'highBid.account': currentToon.account },
            { 'winner.owner': currentToon.owner, 'winner.account': currentToon.account },
          ] }).session(session),
          BossAward.exists({ participants: { $elemMatch: { owner: currentToon.owner, account: currentToon.account } } }).collation({ locale: 'en', strength: 2 }).session(session),
          RosterMutation.exists({ action: 'remove', identityKey }).session(session),
        ]);
        if (linked || roleHistory.some(Boolean)) throw new RequestValidationError('This toon has account, auction, award, or role history and cannot be safely undone.', 409);
      }
      if (holds.some((hold) => deletedRows.includes(hold.rowIndex) &&
        !roster.some((record) => record.rowIndex === hold.rowIndex && getSheetRecordKey(record) === getSheetRecordKey({ owner: hold.owner ?? '', account: hold.account ?? '' })))) {
        throw new RequestValidationError('A DKP reservation is attached to an empty roster row. Reconcile auction holds before arranging the roster.', 409);
      }
      const reservationSubject = { identities: [{ owner, account }], rejectUnverifiedLegacyHolds: true,
        ...(input.action === 'remove' ? { rows: [rowIndex] } : {}) };
      if (getReservationConflict(reservationSubject, holds, auctions)) throw new RequestValidationError('Resolve this toon’s reserved bids, unfinished auctions or pending delivery before changing its roster entry.', 409);
      if (awards.some((award) => [...award.participants, ...(award.pendingChange?.participants ?? [])].some((participant) => participant.rowIndex === rowIndex || getSheetRecordKey(participant) === identityKey))) throw new RequestValidationError('Finish this toon’s pending boss award or attendance change before changing its roster entry.', 409);
      let linkChanges: Array<{ userId: string; links: Array<{ owner: string; account: string; rowIndex?: number }> }> = [];
      let archiveLinks: RosterMutationRecord['archiveLinks'];
      let weeklyActivityBefore: number[] | undefined;
      let toonRoleChangeBefore: Record<string, unknown> | undefined;
      if (input.action === 'remove') {
        const removed = roster.find((record) => record.rowIndex === rowIndex && getSheetRecordKey(record) === identityKey);
        if (!removed) throw new RequestValidationError('This toon is no longer on the roster.', 409);
        requireRosterValues(removed, ['weeklyEarned', 'weeklySpent', 'earned', 'spent', 'available', 'fiveWeekActivity']);
        const cache = await SheetRosterCache.findOne({ cacheKey: spreadsheetId }).select('weeklyActivityHistory').session(session).lean();
        weeklyActivityBefore = cache?.weeklyActivityHistory?.find((entry) => getSheetRecordKey(entry) === identityKey)?.weeks
          ?? (removed.fiveWeekActivity === 0 ? [] : [removed.fiveWeekActivity]);
        const roleChange = await ToonRoleChange.findOne({ identityKey }).session(session).lean();
        if (roleChange) toonRoleChangeBefore = { ...roleChange, _id: roleChange._id.toString() };
        archiveLinks = users.flatMap((user) => {
          const legacyMatches = user.sheetRecordName?.trim().toLowerCase() === owner.toLowerCase();
          if (!legacyMatches && !user.sheetRecords?.some((record) => record.rowIndex === rowIndex || getSheetRecordKey(record) === identityKey)) return [];
          const existing = user.sheetRecords?.length ? user.sheetRecords : roster.filter((record) => getLinkedSheetRecordRows(user, roster).includes(record.rowIndex));
          const beforeSheetRecords = existing.map(({ rowIndex: linkedRow, owner: linkedOwner, account: linkedAccount }) => ({ rowIndex: linkedRow, owner: linkedOwner, account: linkedAccount }));
          const afterLinks = beforeSheetRecords.filter((record) => getSheetRecordKey(record) !== identityKey).map(({ owner: linkedOwner, account: linkedAccount }) => ({ owner: linkedOwner, account: linkedAccount }));
          return [{ userId: user._id.toString(), beforeSheetRecords, beforeSheetRecordName: user.sheetRecordName, afterLinks }];
        });
        linkChanges = (archiveLinks ?? []).map(({ userId, afterLinks }) => ({ userId, links: afterLinks }));
        await ToonRoleChange.deleteOne({ identityKey }).session(session);
      } else if (input.action === 'restore') {
        if (input.undoEventId) {
          const latestEvents = await ClanAuditEvent.find().sort({ createdAt: -1 }).limit(100).select('_id').session(session).lean();
          if (!latestEvents.some((event) => event._id.toString() === input.undoEventId)) {
            throw new RequestValidationError('Only the latest 100 activity entries can be undone.', 409);
          }
        }
        const restoredRoster = retained.map(({ record }, index) => ({ ...record, rowIndex: index + 3 }));
        const savedLinks = archived!.archiveLinks?.length ? archived!.archiveLinks : archived!.linkChanges.map((change) => ({
          userId: change.userId,
          beforeSheetRecords: [...change.links, { owner, account }],
          afterLinks: change.links.map(({ owner: linkedOwner, account: linkedAccount }) => ({ owner: linkedOwner, account: linkedAccount })),
        }));
        const assignedRows = new Map<number, string>();
        const usersById = new Map(users.map((user) => [user._id.toString(), user]));
        for (const saved of savedLinks) {
          const user = usersById.get(saved.userId);
          if (!user) continue;
          const current = user.sheetRecords?.map(({ owner: linkedOwner, account: linkedAccount }) => getSheetRecordKey({ owner: linkedOwner, account: linkedAccount })).sort() ?? [];
          const expectedAfter = saved.afterLinks.map(getSheetRecordKey).sort();
          if (current.length !== expectedAfter.length || current.some((key, index) => key !== expectedAfter[index]) || user.sheetRecordName?.trim()) {
            throw new RequestValidationError('An account’s toon links changed after this toon was removed.', 409);
          }
          const beforeSheetRecords = saved.beforeSheetRecords ?? [...saved.afterLinks, { owner, account }];
          const matchesForUser = beforeSheetRecords.map((identity) => restoredRoster.filter((record) => getSheetRecordKey(record) === getSheetRecordKey(identity)));
          if (matchesForUser.some((matches) => matches.length !== 1)) throw new RequestValidationError('A toon from the saved account links is no longer on the roster.', 409);
          const restoredForUser = matchesForUser.map((matches) => matches[0]);
          const otherUsers = users.filter((candidate) => candidate._id.toString() !== user._id.toString());
          const candidateLinks = (candidate: typeof users[number], record: (typeof restoredRoster)[number]) => candidate.sheetRecords?.length
            ? candidate.sheetRecords.some((saved) => getSheetRecordKey(saved) === getSheetRecordKey(record))
            : candidate.sheetRecordName?.trim().toLowerCase() === record.owner.trim().toLowerCase();
          if (otherUsers.some((candidate) => restoredForUser.some((record) => candidateLinks(candidate, record)))) {
            throw new RequestValidationError('A saved toon is now linked to another account.', 409);
          }
          for (const record of restoredForUser) {
            const assigned = assignedRows.get(record.rowIndex);
            if (assigned && assigned !== user._id.toString()) throw new RequestValidationError('The archived toon was linked to multiple accounts. Resolve the links manually before restoring it.', 409);
            assignedRows.set(record.rowIndex, user._id.toString());
          }
          const openAuctions = auctions.filter(({ status }) => ['active', 'removing', 'settling', 'settlement-failed'].includes(status));
          if (getReservationConflict({ identities: restoredForUser.map(({ owner: linkedOwner, account: linkedAccount }) => ({ owner: linkedOwner, account: linkedAccount })), rejectUnverifiedLegacyHolds: true }, holds, openAuctions)) {
            throw new RequestValidationError('A saved toon has an open auction reservation. Resolve it before restoring these account links.', 409);
          }
          linkChanges.push({ userId: user._id.toString(), links: restoredForUser.map(({ rowIndex: linkedRow, owner: linkedOwner, account: linkedAccount }) => ({ rowIndex: linkedRow, owner: linkedOwner, account: linkedAccount })) });
        }
        if (await ToonRoleChange.exists({ identityKey }).session(session)) throw new RequestValidationError('A toon role schedule already exists for this archived toon.', 409);
        toonRoleChangeBefore = archived!.toonRoleChangeBefore;
      }
      await RosterMutation.create([{
        _id: id, spreadsheetId, fingerprint, action: input.action, status: 'pending', rowIndex, identityKey,
        owner, account, subClass, before, after,
        compaction: { endRow, beforeRows, afterRows, deletedRows, moves },
        actorUserId: actor._id, actorNickname: actor.nickname, actorRole: actor.role, linkChanges,
        ...(input.action === 'remove' ? { archiveLinks, weeklyActivityBefore, toonRoleChangeBefore } : {}),
        ...(input.action === 'restore' ? { archiveMutationId: input.archiveMutationId, restoreRequestId: requestId, restoredWeeklyActivity, toonRoleChangeBefore,
          ...(input.undoEventId ? { undoEventId: input.undoEventId, undoRequestId: requestId } : {}) } : {}),
        ...(input.action === 'remove' && input.undoCreatedEventId ? { undoEventId: input.undoCreatedEventId, undoRequestId: requestId } : {}),
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
