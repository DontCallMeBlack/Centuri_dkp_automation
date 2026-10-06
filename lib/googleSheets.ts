// lib/googleSheets.ts
import { google } from 'googleapis';
import AuctionHold from '@/lib/models/AuctionHold';

const SHEET_NAME = "'DKP Sheet'";

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

function readDkpValue(value: string | undefined) {
  if (!value || value.trim() === '-') return 0;
  const parsed = Number(value.replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function getSheetRoster() {
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = getSpreadsheetId();

  // Owner (A), Account (B), Sub class (C), Earned (D), Spent (E), Earned (F), Spent (G), Available (H)
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SHEET_NAME}!A3:H1000`,
  });

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
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SHEET_NAME}!A3:H1000`,
  });
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

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: updates,
    },
  });
}

export async function updatePlayerDKP(rowIndex: number, pointsToAdd: number) {
  await adjustPlayersDKP([{ rowIndex, points: pointsToAdd }]);
}