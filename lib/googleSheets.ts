// lib/googleSheets.ts
import { google } from 'googleapis';
import AuctionHold from '@/lib/models/AuctionHold';
import SheetRosterCache, { type ISheetRosterRecord } from '@/lib/models/SheetRosterCache';
import dbConnect from '@/lib/mongodb';

const SHEET_NAME = "'DKP Sheet'";
const ROSTER_CACHE_TTL_MS = 30_000;
const ROSTER_REFRESH_LOCK_MS = 20_000;
const ROSTER_REFRESH_WAIT_MS = 15_000;
const ROSTER_CACHE_POLL_MS = 250;

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
  const now = Date.now();
  const staleAtRequest = await SheetRosterCache.findOneAndUpdate(
    { cacheKey },
    {
      $setOnInsert: {
        cacheKey,
        roster: [],
        fetchedAt: new Date(0),
        refreshLockUntil: new Date(0),
        generation: 0,
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
  options: { reservedPointsToConsume?: Map<number, number> } = {},
) {
  if (adjustments.length === 0) return;

  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = getSpreadsheetId();
  const response = await withGoogleSheetsRetry(
    () => sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${SHEET_NAME}!A3:H1000`,
    }),
    true,
  );
  const rows = response.data.values ?? [];
  const holds = await AuctionHold.find({
    rowIndex: { $in: adjustments.filter(({ points }) => points < 0).map(({ rowIndex }) => rowIndex) },
  }).select('rowIndex heldPoints').lean();
  const holdsByRow = new Map(holds.map((hold) => [hold.rowIndex, hold.heldPoints]));
  const updates = adjustments.flatMap(({ rowIndex, points, owner, account }) => {
    if (!Number.isInteger(rowIndex) || rowIndex < 3 || rowIndex > 1000) {
      throw new Error(`Invalid Google Sheets roster row: ${rowIndex}`);
    }
    if (!Number.isFinite(points)) {
      throw new Error('DKP adjustment must be a finite number.');
    }

    const row = rows[rowIndex - 3];
    if (!row || !row[0]) {
      throw new Error(`Google Sheets roster row ${rowIndex} could not be read.`);
    }
    if (
      (owner !== undefined && row[0].trim().toLowerCase() !== owner.trim().toLowerCase()) ||
      (account !== undefined && (row[1] || '').trim().toLowerCase() !== account.trim().toLowerCase())
    ) {
      throw new Error(`Google Sheets roster row ${rowIndex} changed; reload the roster and retry.`);
    }

    const readValue = (columnIndex: number, columnName: string) => {
      const value = row[columnIndex];
      if (value === undefined || value === '' || value === '-') return 0;
      const parsed = Number(String(value).replace(/,/g, '').trim());
      if (!Number.isFinite(parsed)) {
        throw new Error(`Cannot adjust DKP: ${columnName}${rowIndex} is not numeric.`);
      }
      return parsed;
    };

    if (points < 0) {
      const heldPoints = holdsByRow.get(rowIndex) ?? 0;
      const reservedPointsToConsume = options.reservedPointsToConsume?.get(rowIndex) ?? 0;
      if (
        reservedPointsToConsume < 0 ||
        reservedPointsToConsume > heldPoints ||
        readValue(7, 'H') + points < heldPoints - reservedPointsToConsume
      ) {
        throw new Error(`Cannot reduce DKP for row ${rowIndex} below its ${heldPoints} held auction points.`);
      }
    }

    return [
      { range: `${SHEET_NAME}!D${rowIndex}`, values: [[readValue(3, 'D') + points]] },
      { range: `${SHEET_NAME}!F${rowIndex}`, values: [[readValue(5, 'F') + points]] },
      { range: `${SHEET_NAME}!H${rowIndex}`, values: [[readValue(7, 'H') + points]] },
    ];
  });

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
  try {
    await invalidateSheetRosterCache();
  } catch (error: unknown) {
    console.error('DKP was updated in Google Sheets, but the roster cache could not be invalidated', error);
  }
}

export async function updatePlayerDKP(rowIndex: number, pointsToAdd: number) {
  await adjustPlayersDKP([{ rowIndex, points: pointsToAdd }]);
}