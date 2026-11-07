import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { clearClientData, getData, notifyDkpChanged, peekData, rememberData } from '../lib/client/api.ts';

// Run the actual action handler without mounting JSX or contacting live storage.
// The real cache and invalidation event expose duplicate post-mutation requests.
const panelSource = (await readFile(new URL('../components/AuctionHousePanel.tsx', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const handlerStart = panelSource.indexOf('  const retrySettlement = async ');
const handlerEnd = panelSource.indexOf('\n\n  if (loading)', handlerStart);
assert.ok(handlerStart >= 0 && handlerEnd > handlerStart, 'Settlement retry handler is present');
const handlerSource = stripTypeScriptTypes(panelSource.slice(handlerStart, handlerEnd));
const dependencies = ['saving', 'setSaving', 'setError', 'setNotice', 'updateAuctionInView', 'refreshInBackground', 'notifyDkpChanged'];
const createHandler = new Function(...dependencies, `${handlerSource}\nreturn retrySettlement;`);
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearClientData();
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
});

test('a confirmed settlement retry refreshes fresh auction data once across local and event consumers', async () => {
  globalThis.window = new EventTarget();
  rememberData('/api/auction', { revision: 'stale' });
  const requests = [], reads = [], finishReads = [], notices = [], errors = [], updates = [], saving = [];
  globalThis.fetch = (url, options = {}) => {
    requests.push({ url, options });
    if (options.method === 'POST') return Promise.resolve(Response.json({ message: 'Retry accepted' }));
    return new Promise(resolve => finishReads.push(resolve));
  };
  window.addEventListener('centuri:dkp-changed', () => reads.push(getData('/api/auction')));
  const retry = createHandler(false, value => saving.push(value), value => errors.push(value),
    value => notices.push(value), (...args) => updates.push(args),
    () => reads.push(getData('/api/auction')), notifyDkpChanged);

  await retry({ id: 'auction-1' });

  assert.equal(requests.filter(request => request.options.method === 'POST').length, 1);
  assert.deepEqual(JSON.parse(requests[0].options.body), { action: 'retry-settlement', auctionId: 'auction-1' });
  assert.equal(reads.length, 2, 'Both existing consumers still receive the refresh');
  assert.equal(finishReads.length, 1, 'Both consumers share one fresh GET after invalidation');
  assert.equal(peekData('/api/auction'), null, 'The previous snapshot is invalidated before the read');
  finishReads[0](Response.json({ revision: 'fresh' }));
  assert.deepEqual(await Promise.all(reads), [{ revision: 'fresh' }, { revision: 'fresh' }]);
  assert.deepEqual(peekData('/api/auction'), { revision: 'fresh' });
  assert.deepEqual(updates, [['auction-1', { status: 'settling', canRetrySettlement: false, settlementError: null }]]);
  assert.deepEqual(saving, [true, false]);
  assert.deepEqual(errors, ['']);
  assert.deepEqual(notices, ['Retrying auction settlement…', 'Retry accepted']);
});

test('a failed settlement retry keeps its error and does not announce or refresh a successful mutation', async () => {
  globalThis.window = new EventTarget();
  const errors = [], refreshes = [], updates = [];
  let changes = 0;
  window.addEventListener('centuri:dkp-changed', () => changes++);
  globalThis.fetch = async () => Response.json({ error: 'Settlement cannot be retried' }, { status: 409 });
  const retry = createHandler(false, () => {}, value => errors.push(value), () => {},
    (...args) => updates.push(args), () => refreshes.push(true), notifyDkpChanged);

  await retry({ id: 'auction-1' });

  assert.deepEqual(errors, ['', 'Settlement cannot be retried']);
  assert.deepEqual(refreshes, []);
  assert.deepEqual(updates, []);
  assert.equal(changes, 0);
});
