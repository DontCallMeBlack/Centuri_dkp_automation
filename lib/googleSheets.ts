// lib/googleSheets.ts
import { google } from 'googleapis';
import AuctionHold from '@/lib/models/AuctionHold';
import SheetRosterCache, { type ISheetRosterRecord } from '@/lib/models/SheetRosterCache';
import dbConnect from '@/lib/mongodb';
import { withDkpSheetWriteLock } from '@/lib/sheetWriteLock';

const SHEET_NAME = "'DKP_Sheet_automated'";
const AUCTION_LEDGER_SHEET_NAME = 'DKP_Auction_Transactions';
const AUCTION_LEDGER_RANGE = `'${AUCTION_LEDGER_SHEET_NAME}'!A2:F`;
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

function updateNumberCell(sheetId: number, rowIndex: number, columnIndex: number, value: number) {
  return {
    updateCells: {
      range: {
        sheetId,
        startRowIndex: rowIndex - 1,
        endRowIndex: rowIndex,
        startColumnIndex: columnIndex,
        endColumnIndex: columnIndex + 1,
      },
      rows: [{ values: [{ userEnteredValue: { numberValue: value } }] }],
      fields: 'userEnteredValue',
    },
  };
}

async function getSheetId(sheets: ReturnType<typeof google.sheets>, spreadsheetId: string, title: string) {
  const response = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties(sheetId,title)',
  });
  const properties = response.data.sheets?.find((sheet) => sheet.properties?.title === title)?.properties;
  if (typeof properties?.sheetId !== 'number') {
    throw new Error(`Google Sheets tab "${title}" could not be found.`);
  }
  return properties.sheetId;
}

async function getOrCreateAuctionLedgerSheet(sheets: ReturnType<typeof google.sheets>, spreadsheetId: string) {
  let metadata = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties(sheetId,title)',
  });
  let properties = metadata.data.sheets?.find((sheet) =>
    sheet.properties?.title === AUCTION_LEDGER_SHEET_NAME,
  )?.properties;

  if (typeof properties?.sheetId !== 'number') {
    const created = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          addSheet: {
            properties: {
              title: AUCTION_LEDGER_SHEET_NAME,
              hidden: true,
              gridProperties: { rowCount: 100_000, columnCount: 6 },
            },
          },
        }],
      },
    });
    properties = created.data.replies?.[0]?.addSheet?.properties;
    if (typeof properties?.sheetId !== 'number') {
      metadata = await sheets.spreadsheets.get({
        spreadsheetId,
        fields: 'sheets.properties(sheetId,title)',
      });
      properties = metadata.data.sheets?.find((sheet) =>
        sheet.properties?.title === AUCTION_LEDGER_SHEET_NAME,
      )?.properties;
    }
  }

  if (typeof properties?.sheetId !== 'number') {
    throw new Error('Could not initialize the auction settlement ledger tab.');
  }

  const header = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${AUCTION_LEDGER_SHEET_NAME}'!A1:F1`,
  });
  if (!header.data.values?.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          updateCells: {
            range: { sheetId: properties.sheetId, startRowIndex: 0, startColumnIndex: 0 },
            rows: [{ values: [
              { userEnteredValue: { stringValue: 'operationId' } },
              { userEnteredValue: { stringValue: 'rowIndex' } },
              { userEnteredValue: { stringValue: 'points' } },
              { userEnteredValue: { stringValue: 'owner' } },
              { userEnteredValue: { stringValue: 'account' } },
              { userEnteredValue: { stringValue: 'appliedAt' } },
            ] }],
            fields: 'userEnteredValue',
          },
        }],
      },
    });
  }

  return properties.sheetId;
}

async function invalidateRosterCacheAfterSheetWrite() {
  try {
    await invalidateSheetRosterCache();
  } catch (error: unknown) {
    console.error('Google Sheets was updated, but the roster cache could not be invalidated', error);
  }
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
  await withDkpSheetWriteLock(async () => {
    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = getSpreadsheetId();
    const [response, sheetId] = await Promise.all([
      withGoogleSheetsRetry(
        () => sheets.spreadsheets.values.get({ spreadsheetId, range: `${SHEET_NAME}!A3:H1000` }),
        true,
      ),
      getSheetId(sheets, spreadsheetId, 'DKP_Sheet_automated'),
    ]);
    const rows = response.data.values ?? [];
    const holds = await AuctionHold.find({
      rowIndex: { $in: adjustments.filter(({ points }) => points < 0).map(({ rowIndex }) => rowIndex) },
    }).select('rowIndex heldPoints').lean();
    const holdsByRow = new Map(holds.map((hold) => [hold.rowIndex, hold.heldPoints]));
    const requests = adjustments.flatMap(({ rowIndex, points, owner, account }) => {
      if (!Number.isInteger(rowIndex) || rowIndex < 3 || rowIndex > 1000) {
        throw new Error(`Invalid Google Sheets roster row: ${rowIndex}`);
      }
      if (!Number.isFinite(points)) throw new Error('DKP adjustment must be a finite number.');

      const row = rows[rowIndex - 3];
      if (!row || !row[0]) throw new Error(`Google Sheets roster row ${rowIndex} could not be read.`);
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
        if (!Number.isFinite(parsed)) throw new Error(`Cannot adjust DKP: ${columnName}${rowIndex} is not numeric.`);
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
        updateNumberCell(sheetId, rowIndex, 3, readValue(3, 'D') + points),
        updateNumberCell(sheetId, rowIndex, 5, readValue(5, 'F') + points),
        updateNumberCell(sheetId, rowIndex, 7, readValue(7, 'H') + points),
      ];
    });

    await withGoogleSheetsRetry(
      () => sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } }),
      false,
    );
    await invalidateRosterCacheAfterSheetWrite();
  });
}

export async function spendPlayerDKP(input: {
  rowIndex: number;
  points: number;
  owner: string;
  account: string;
}, options: { operationId: string; reservedPointsToConsume: number }) {
  const { rowIndex, points, owner, account } = input;
  const { operationId, reservedPointsToConsume } = options;
  if (!operationId.trim()) throw new Error('An idempotency key is required for an auction charge.');
  if (!Number.isSafeInteger(points) || points <= 0) throw new Error('Auction spend must be a positive whole number.');
  if (!Number.isSafeInteger(reservedPointsToConsume) || reservedPointsToConsume < 0) {
    throw new Error('Reserved auction points are invalid.');
  }

  return withDkpSheetWriteLock(async () => {
    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = getSpreadsheetId();
    const [response, mainSheetId, ledgerSheetId] = await Promise.all([
      withGoogleSheetsRetry(
        () => sheets.spreadsheets.values.get({ spreadsheetId, range: `${SHEET_NAME}!A3:H1000` }),
        true,
      ),
      getSheetId(sheets, spreadsheetId, 'DKP_Sheet_automated'),
      getOrCreateAuctionLedgerSheet(sheets, spreadsheetId),
    ]);

    const previousOperations = await withGoogleSheetsRetry(
      () => sheets.spreadsheets.values.get({ spreadsheetId, range: AUCTION_LEDGER_RANGE }),
      true,
    );
    const previousOperation = previousOperations.data.values?.find((row) => row[0] === operationId);
    if (previousOperation) {
      if (Number(previousOperation[1]) !== rowIndex || Number(previousOperation[2]) !== points) {
        throw new Error('This auction settlement key was already used for a different DKP charge.');
      }
      await invalidateRosterCacheAfterSheetWrite();
      return { alreadyApplied: true };
    }

    if (!Number.isInteger(rowIndex) || rowIndex < 3 || rowIndex > 1000) {
      throw new Error(`Invalid Google Sheets roster row: ${rowIndex}`);
    }
    const row = response.data.values?.[rowIndex - 3];
    if (!row || !row[0]) throw new Error(`Google Sheets roster row ${rowIndex} could not be read.`);
    if (
      row[0].trim().toLowerCase() !== owner.trim().toLowerCase() ||
      (row[1] || '').trim().toLowerCase() !== account.trim().toLowerCase()
    ) {
      throw new Error(`Google Sheets roster row ${rowIndex} changed; reload the roster and retry.`);
    }

    const readValue = (columnIndex: number, columnName: string) => {
      const value = row[columnIndex];
      if (value === undefined || value === '' || value === '-') return 0;
      const parsed = Number(String(value).replace(/,/g, '').trim());
      if (!Number.isFinite(parsed)) throw new Error(`Cannot settle auction: ${columnName}${rowIndex} is not numeric.`);
      return parsed;
    };
    const hold = await AuctionHold.findOne({ rowIndex }).select('heldPoints').lean();
    const heldPoints = hold?.heldPoints ?? 0;
    if (
      reservedPointsToConsume > heldPoints ||
      readValue(7, 'H') - points < heldPoints - reservedPointsToConsume
    ) {
      throw new Error(`Cannot charge row ${rowIndex} below its remaining ${heldPoints - reservedPointsToConsume} held auction points.`);
    }

    const weeklySpent = readValue(4, 'E') + points;
    const spent = readValue(6, 'G') + points;
    const available = readValue(7, 'H') - points;
    const requests = [
      updateNumberCell(mainSheetId, rowIndex, 4, weeklySpent),
      updateNumberCell(mainSheetId, rowIndex, 6, spent),
      updateNumberCell(mainSheetId, rowIndex, 7, available),
      {
        appendCells: {
          sheetId: ledgerSheetId,
          rows: [{ values: [
            { userEnteredValue: { stringValue: operationId } },
            { userEnteredValue: { numberValue: rowIndex } },
            { userEnteredValue: { numberValue: points } },
            { userEnteredValue: { stringValue: owner } },
            { userEnteredValue: { stringValue: account } },
            { userEnteredValue: { stringValue: new Date().toISOString() } },
          ] }],
          fields: 'userEnteredValue',
        },
      },
    ];

    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
    await invalidateRosterCacheAfterSheetWrite();
    return { alreadyApplied: false };
  });
}

export async function updatePlayerDKP(rowIndex: number, pointsToAdd: number) {
  await adjustPlayersDKP([{ rowIndex, points: pointsToAdd }]);
}
