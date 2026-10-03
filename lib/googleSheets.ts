// lib/googleSheets.ts
import { google } from 'googleapis';

const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  },
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

export async function getSheetRoster() {
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  // Assuming your data sheet is named "Sheet1" and columns run from A to H
  // Owner (A), Account (B), Sub class (C), Earned (D), Spent (E), Earned (F), Spent (G), Available (H)
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'Sheet1!A2:H1000', // Adjust "Sheet1" if your tab has a different name
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
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  // First, get the current available value to correctly increment it
  const currentCellRange = `Sheet1!H${rowIndex}`;
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