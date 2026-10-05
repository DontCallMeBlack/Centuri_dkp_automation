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
    range: `${SHEET_NAME}!A2:H1000`,
  });

  const rows = response.data.values;
  if (!rows) return [];

  return rows.map((row, index) => ({
    rowIndex: index + 2, // 1-based index for updating later (+2 because of header row)
    owner: row[0] || '',
    account: row[1] || '',
    subClass: row[2] || '',
    available: Number(row[7]) || 0, // Column H
  })).filter(r => r.owner); // Filter out empty rows
}

export async function updatePlayerDKP(rowIndex: number, pointsToAdd: number) {
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = getSpreadsheetId();

  // First, get the current available value to correctly increment it
  const currentCellRange = `${SHEET_NAME}!H${rowIndex}`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: currentCellRange,
  });

  const currentVal = Number(res.data.values?.[0]?.[0] || 0);
  const newVal = currentVal + pointsToAdd;

  // Update the Available DKP column (Column H)
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: currentCellRange,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[newVal]],
    },
  });
}