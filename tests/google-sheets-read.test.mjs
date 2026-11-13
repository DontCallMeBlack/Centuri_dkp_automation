import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// Run the actual read transport/parser without credentials, HTTP, or financial models.
const state = globalThis.__sheetRead = { sdkLoads: 0 };
state.client = { spreadsheets: { values: { async get(options) {
  state.requests.push(options);
  return { data: { values: state.rows } };
} } } };
const mocks = {
  '@/lib/models/SheetRosterCache': 'export default {};',
  '@/lib/mongodb': `export default async function(){throw new Error('Unexpected database read');}`,
  './googleSheetsClient': `globalThis.__sheetRead.sdkLoads++;
    export function createSheetsClient(){return globalThis.__sheetRead.client;}`,
};
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (mocks[specifier]) return { url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}`, shortCircuit: true };
  if (specifier === './googleSheets' || specifier.startsWith('@/lib/models/')) {
    throw new Error(`Read transport loaded a financial dependency: ${specifier}`);
  }
  if (specifier.startsWith('@/')) return nextResolve(new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href, context);
  if (specifier.startsWith('.') && context.parentURL?.startsWith(new URL('../lib/', import.meta.url).href) && !/\.[a-z]+$/i.test(specifier)) {
    return nextResolve(new URL(`${specifier}.ts`, context.parentURL).href, context);
  }
  return nextResolve(specifier, context);
} });
const { fetchSheetRoster, readSheetRows, rosterFromRows, withGoogleSheetsRetry } = await import('../lib/googleSheetsRead.ts');
const previousSheetId = process.env.GOOGLE_SHEET_ID;
const previousEnvironment = process.env.VERCEL_ENV;
after(() => {
  hooks.deregister();
  if (previousSheetId === undefined) delete process.env.GOOGLE_SHEET_ID;
  else process.env.GOOGLE_SHEET_ID = previousSheetId;
  if (previousEnvironment === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = previousEnvironment;
});
beforeEach(() => {
  process.env.GOOGLE_SHEET_ID = ' sheet-id ';
  delete process.env.VERCEL_ENV;
  state.requests = [];
  state.rows = [[' Ada ', ' Main ', 'Tank', 1, 0, 10.5, 2, 8.5, null]];
});

test('the read transport imports without initializing the Sheets SDK or financial models', () => {
  assert.equal(state.sdkLoads, 0);
});

test('a supplied client preserves the unformatted range and numeric normalization', async () => {
  const rows = await readSheetRows(state.client);
  assert.deepEqual(rows, [[' Ada ', ' Main ', 'Tank', '1', '0', '10.5', '2', '8.5', '']]);
  assert.deepEqual(state.requests, [{ spreadsheetId: 'sheet-id', range: "'DKP_Sheet_automated'!A3:I1000", valueRenderOption: 'UNFORMATTED_VALUE' }]);
  assert.equal(state.sdkLoads, 0);
  const [record] = rosterFromRows(rows);
  assert.equal(record.owner, 'Ada');
  assert.equal(record.account, 'Main');
  assert.equal(record.available, 8.5);
  assert.equal(record.fiveWeekActivity, 0);
});

test('a real display refresh loads only the Sheet read client and keeps invalid balances visible', async () => {
  state.rows.push(['Grace', 'Other', 'Healer', 0, 0, 10, 0, 'bad cell', 0]);
  const roster = await fetchSheetRoster();
  assert.equal(state.sdkLoads, 1);
  assert.equal(roster.length, 2);
  assert.equal(roster[0].available, 8.5);
  assert.equal(roster[1].available, null);
  assert.equal(roster[1].dkpIssues[0].cell, 'H4');
});

test('read transport still rejects preview and unconfigured Sheets before an HTTP call', async () => {
  process.env.VERCEL_ENV = 'preview';
  await assert.rejects(readSheetRows(state.client), /outside production/);
  delete process.env.VERCEL_ENV;
  delete process.env.GOOGLE_SHEET_ID;
  await assert.rejects(readSheetRows(state.client), /GOOGLE_SHEET_ID/);
  assert.deepEqual(state.requests, []);
});

test('shared retries preserve transient read recovery and rate-limit-only write recovery', async () => {
  const realSetTimeout = globalThis.setTimeout;
  const delays = [];
  globalThis.setTimeout = (callback, delay) => { delays.push(delay); callback(); return 0; };
  const retryError = status => Object.assign(new Error('Service unavailable'), { response: { status } });
  try {
    let reads = 0;
    assert.equal(await withGoogleSheetsRetry(async () => {
      if (++reads < 4) throw retryError(503);
      return 'read';
    }, true), 'read');
    assert.equal(reads, 4);
    assert.deepEqual(delays.map((delay, index) => delay >= 500 * 2 ** index && delay < 500 * 2 ** index + 250), [true, true, true]);
    let writes = 0;
    await assert.rejects(withGoogleSheetsRetry(async () => { writes++; throw retryError(503); }, false), /unavailable/);
    assert.equal(writes, 1);
    writes = 0;
    assert.equal(await withGoogleSheetsRetry(async () => {
      if (++writes === 1) throw retryError(429);
      return 'write';
    }, false), 'write');
    assert.equal(writes, 2);
    let attempts = 0;
    await assert.rejects(withGoogleSheetsRetry(async () => { attempts++; throw retryError(429); }, true), /unavailable/);
    assert.equal(attempts, 4);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});
