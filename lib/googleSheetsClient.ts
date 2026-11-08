import { sheets, auth } from 'googleapis/build/src/apis/sheets';

// Keep SDK initialization behind actual Sheet I/O. Reads served from the Mongo
// roster snapshot should not load Google's HTTP/authentication dependency tree.
const credentials = new auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  },
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

export function createSheetsClient() {
  return sheets({ version: 'v4', auth: credentials, timeout: 20_000 });
}
