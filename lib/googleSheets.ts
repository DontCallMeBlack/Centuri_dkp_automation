// lib/googleSheets.ts
import { google } from 'googleapis';

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
    available: Number(row[7]) || 0, // Column H
  })).filter(r => r.owner); // Filter out empty rows
}

export async function adjustPlayersDKP(
  adjustments: Array<{ rowIndex: number; points: number }>,
) {
  if (adjustments.length === 0) return;

  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = getSpreadsheetId();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SHEET_NAME}!D3:H1000`,
  });
  const rows = response.data.values ?? [];
  const updates = adjustments.flatMap(({ rowIndex, points }) => {
    if (!Number.isInteger(rowIndex) || rowIndex < 3 || rowIndex > 1000) {
      throw new Error(`Invalid Google Sheets roster row: ${rowIndex}`);
    }
    if (!Number.isFinite(points)) {
      throw new Error('DKP adjustment must be a finite number.');
    }

    const row = rows[rowIndex - 3];
    if (!row) {
      throw new Error(`Google Sheets roster row ${rowIndex} could not be read.`);
    }

    const readValue = (columnIndex: number, columnName: string) => {
      const value = row[columnIndex];
      if (value === undefined || value === '') return 0;
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        throw new Error(`Cannot adjust DKP: ${columnName}${rowIndex} is not numeric.`);
      }
      return parsed;
    };

    return [
      { range: `${SHEET_NAME}!D${rowIndex}`, values: [[readValue(0, 'D') + points]] },
      { range: `${SHEET_NAME}!F${rowIndex}`, values: [[readValue(2, 'F') + points]] },
      { range: `${SHEET_NAME}!H${rowIndex}`, values: [[readValue(4, 'H') + points]] },
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