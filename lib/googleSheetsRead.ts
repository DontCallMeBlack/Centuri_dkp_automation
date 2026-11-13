import type { sheets as googleSheets } from 'googleapis/build/src/apis/sheets';
import type { ISheetRosterRecord } from '@/lib/models/SheetRosterCache';
import { parseSheetRoster } from '@/lib/sheetRoster';
import { getSpreadsheetId } from './sheetRosterSnapshot';

const SHEET_NAME = "'DKP_Sheet_automated'";

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

export async function withGoogleSheetsRetry<T>(operation: () => Promise<T>, retryTransientErrors: boolean) {
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

export async function createSheetsClient() {
  const client = await import('./googleSheetsClient');
  return client.createSheetsClient();
}

export async function readSheetRows(sheets?: ReturnType<typeof googleSheets>) {
  const client = sheets ?? await createSheetsClient();
  const response = await withGoogleSheetsRetry(() => client.spreadsheets.values.get({
    spreadsheetId: getSpreadsheetId(), range: `${SHEET_NAME}!A3:I1000`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  }), true);
  // Display rounding and spreadsheet locale must never change the amounts used
  // for debits. Normalize unformatted numeric values at this one boundary.
  return (response.data.values ?? []).map((row) => row.map((value) => String(value ?? '')));
}

export function rosterFromRows(rows: string[][]): ISheetRosterRecord[] {
  return parseSheetRoster(rows, { allowInvalid: true });
}

// Display refreshes must not initialize the financial mutation/model graph.
export async function fetchSheetRoster(): Promise<ISheetRosterRecord[]> {
  return rosterFromRows(await readSheetRows());
}
