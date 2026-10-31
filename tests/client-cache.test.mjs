import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, clearClientData, getData, invalidateData, isDataFresh, peekData, rememberData, notifyDkpChanged } from '../lib/client/api.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; clearClientData(); });
const json = (value) => Response.json(value);

test('fresh navigation data is reused, while explicit refresh still fetches', async () => {
  let requests = 0;
  globalThis.fetch = async () => json({ revision: ++requests });
  assert.deepEqual(await getData('/roster'), { revision: 1 });
  assert.equal(isDataFresh('/roster'), true);
  assert.deepEqual(await getData('/roster', { maxAgeMs: 15_000 }), { revision: 1 });
  assert.deepEqual(await getData('/roster'), { revision: 2 });
  assert.equal(requests, 2);
});

test('expired data remains available for display but is revalidated', async () => {
  const realNow = Date.now;
  let time = realNow();
  Date.now = () => time;
  try {
    rememberData('/roster', { revision: 1 });
    time += 15_001;
    assert.equal(isDataFresh('/roster'), false);
    assert.deepEqual(peekData('/roster'), { revision: 1 });
    globalThis.fetch = async () => json({ revision: 2 });
    assert.deepEqual(await getData('/roster', { maxAgeMs: 15_000 }), { revision: 2 });
  } finally { Date.now = realNow; }
});

test('concurrent consumers share one network request', async () => {
  let resolve;
  let requests = 0;
  globalThis.fetch = () => { requests++; return new Promise((done) => { resolve = done; }); };
  const first = getData('/roster');
  const second = getData('/roster');
  resolve(json({ revision: 1 }));
  assert.deepEqual(await Promise.all([first, second]), [{ revision: 1 }, { revision: 1 }]);
  assert.equal(requests, 1);
});

test('mutation invalidation prevents an older in-flight read from overwriting new data', async () => {
  const responses = [];
  globalThis.fetch = () => new Promise((resolve) => { responses.push(resolve); });
  const oldRead = getData('/roster');
  invalidateData('/roster');
  const newRead = getData('/roster', { maxAgeMs: 15_000 });
  responses[0](json({ revision: 1 }));
  responses[1](json({ revision: 2 }));
  assert.deepEqual(await oldRead, { revision: 2 });
  assert.deepEqual(await newRead, { revision: 2 });
  assert.deepEqual(peekData('/roster'), { revision: 2 });
});

test('signing out rejects old responses and clears private data', async () => {
  let resolve;
  globalThis.fetch = () => new Promise((done) => { resolve = done; });
  const pending = getData('/roster');
  clearClientData();
  resolve(json({ private: true }));
  await assert.rejects(pending, (error) => error instanceof ApiError && error.status === 499);
  assert.equal(peekData('/roster'), null);
});

test('failed reads are never cached and can be retried', async () => {
  globalThis.fetch = async () => Response.json({ error: 'Unavailable' }, { status: 503 });
  await assert.rejects(getData('/roster'), (error) => error.status === 503);
  assert.equal(peekData('/roster'), null);
  globalThis.fetch = async () => json({ recovered: true });
  assert.deepEqual(await getData('/roster'), { recovered: true });
});

test('DKP mutations invalidate every affected view', () => {
  const previousWindow = globalThis.window;
  globalThis.window = new EventTarget();
  try {
    const urls = ['/api/dkp', '/api/auction', '/api/admin/boss-history', '/api/admin/toons', '/api/admin/requests', '/api/role-changes'];
    for (const url of urls) rememberData(url, { stale: true });
    notifyDkpChanged();
    for (const url of urls) assert.equal(peekData(url), null);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
