import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { auctionBalanceChanged, readAuctionLiveUpdates } from '../lib/client/auctionLiveUpdates.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const auction = (n, extra = {}) => ({
  id: n.toString(16).padStart(24, '0'), itemId: 'f'.repeat(24),
  createdAt: new Date(n * 1000).toISOString(), endsAt: '2027-01-01T00:00:00.000Z',
  status: 'active', bidVersion: 1, deliveryStatus: 'not-required', highBid: null, ...extra,
});
const parse = path => new URL(path, 'https://centuri.test').searchParams;

test('small unchanged polls remain one lightweight request with their exact version tokens', async () => {
  const a = auction(1, { versionToken: 'server-token' });
  let calls = 0;
  globalThis.fetch = async (path, options) => {
    calls++;
    const params = parse(path);
    assert.deepEqual(JSON.parse(params.get('versions')), [[a.id, 'server-token']]);
    assert.deepEqual(JSON.parse(params.get('ids')), [a.id]);
    assert.equal(options.cache, 'no-store');
    return Response.json({ changed: false });
  };
  assert.deepEqual(await readAuctionLiveUpdates([a], false), { changed: false, auctions: [], removedIds: [] });
  assert.equal(calls, 1);
});

test('all 251 tracked auctions participate in targeted checks without exceeding request bounds', async () => {
  const auctions = Array.from({ length: 251 }, (_, n) => auction(n + 1));
  const seen = [], sizes = [];
  globalThis.fetch = async path => {
    const params = parse(path), ids = JSON.parse(params.get('ids')), versions = JSON.parse(params.get('versions'));
    sizes.push(ids.length); seen.push(...ids);
    assert.ok(params.get('versions').length <= 32_768);
    assert.ok(params.get('ids').length <= 6_000);
    assert.deepEqual(versions.map(entry => entry[0]), ids);
    return Response.json({ changed: false });
  };
  await readAuctionLiveUpdates(auctions, false);
  assert.deepEqual(sizes, [100, 100, 51]);
  assert.equal(new Set(seen).size, 251);
  assert.deepEqual(seen, auctions.map(a => a.id).reverse());
  assert.equal(auctions[0].id, auction(1).id, 'Polling must not reorder React state');
});

test('discovery reconciles older deletions and deduplicates updates returned by multiple batches', async () => {
  const auctions = Array.from({ length: 205 }, (_, n) => auction(n + 1));
  const updated = { ...auctions[1], bidVersion: 2 };
  let discoveries = 0, targeted = 0;
  globalThis.fetch = async path => {
    const params = parse(path);
    if (!params.has('ids')) {
      discoveries++;
      return Response.json({ changed: true, auctions: [updated], removedIds: [] });
    }
    targeted++;
    const ids = JSON.parse(params.get('ids'));
    return ids.includes(auctions[0].id)
      ? Response.json({ changed: true, auctions: [updated], removedIds: [auctions[0].id] })
      : Response.json({ changed: false });
  };
  const result = await readAuctionLiveUpdates(auctions, true);
  assert.equal(discoveries, 1); assert.equal(targeted, 2);
  assert.deepEqual(result, { changed: true, auctions: [updated], removedIds: [auctions[0].id] });
});

test('a deletion observed by a targeted batch wins over an earlier discovery copy', async () => {
  const auctions = Array.from({ length: 101 }, (_, n) => auction(n + 1));
  globalThis.fetch = async path => Response.json(parse(path).has('ids')
    ? { changed: true, auctions: [], removedIds: [auctions[0].id] }
    : { changed: true, auctions: [auctions[0]], removedIds: [] });
  assert.deepEqual(await readAuctionLiveUpdates(auctions, true), {
    changed: true, auctions: [], removedIds: [auctions[0].id],
  });
});

test('an empty view still discovers newly posted auctions but makes no empty targeted request', async () => {
  let calls = 0;
  globalThis.fetch = async path => {
    calls++;
    assert.equal(parse(path).has('ids'), false);
    return Response.json({ changed: true, auctions: [auction(1)], removedIds: [] });
  };
  assert.equal((await readAuctionLiveUpdates([], true)).auctions.length, 1);
  await readAuctionLiveUpdates([], false);
  assert.equal(calls, 1);
});

test('a failed batch rejects the poll instead of applying a partial auction view', async () => {
  const auctions = Array.from({ length: 101 }, (_, n) => auction(n + 1));
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1
    ? Response.json({ changed: true, auctions: [auction(1)], removedIds: [] })
    : Response.json({ error: 'Retry later' }, { status: 503 });
  await assert.rejects(readAuctionLiveUpdates(auctions, false), /Live bid updates are delayed/);
});

test('only removals affecting personal reservations or wins trigger a balance refresh', () => {
  const mine = auction(1, { highBid: { isMine: true, amount: 50 } });
  const other = auction(2, { highBid: { isMine: false, amount: 20 } });
  const won = auction(3, { status: 'completed', winner: { isMine: true } });
  assert.equal(auctionBalanceChanged([mine, other, won], [], [mine.id]), true);
  assert.equal(auctionBalanceChanged([mine, other, won], [], [won.id]), true);
  assert.equal(auctionBalanceChanged([mine, other, won], [], [other.id]), false);
  assert.equal(auctionBalanceChanged([mine, other, won], [], ['unknown']), false);
});

test('normal outbids and settlement continue refreshing personal balances while unchanged bids do not', () => {
  const mine = auction(1, { highBid: { isMine: true, amount: 50 } });
  assert.equal(auctionBalanceChanged([mine], [{ ...mine, bidVersion: 2, highBid: { isMine: false, amount: 60 } }], []), true);
  assert.equal(auctionBalanceChanged([mine], [{ ...mine, status: 'completed' }], []), true);
  assert.equal(auctionBalanceChanged([mine], [mine], []), false);
  assert.equal(auctionBalanceChanged([], [mine], []), true);
});

// Execute the real component callback so wiring, state removal and the awaited
// balance refresh are checked as well as the transport and predicate helpers.
const source = (await readFile(new URL('../components/AuctionHousePanel.tsx', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const start = source.indexOf('    const pollLiveAuctions = async ');
const end = source.indexOf('\n    const schedulePoll', start);
assert.ok(start >= 0 && end > start);
const createPoll = new Function('dependencies', `const {dataRef,fullRefreshCount,activeRef,document,navigator,
  clientDataVersion,liveEpoch,auctionPollPlan,lastDiscoveryAt,lastTargetAt,checkedAuctionWindows,
  refreshRef,readAuctionLiveUpdates,auctionBalanceChanged,setError,setLastSyncedAt,setData,
  rememberAuctionData,setArchiveAuctions,setWonHistory}=dependencies;
  let mounted=true,pollInFlight=false,pushConnected=false;
  const pendingPush=dependencies.pendingPush ?? {current:undefined};
  ${stripTypeScriptTypes(source.slice(start,end))}
  return pollLiveAuctions;`);

test('a remote manager removal clears the card and reloads spendable DKP in the real poll callback', async () => {
  const mine = auction(1, { highBid: { isMine: true, amount: 50 } });
  const dataRef = { current: { auctions: [mine], toons: [{ available: 50, heldPoints: 50 }] } };
  let refreshes = 0, remembered, archive = [mine], wins = [];
  globalThis.fetch = async () => Response.json({ changed: true, auctions: [], removedIds: [mine.id] });
  const poll = createPoll({
    dataRef, fullRefreshCount: { current: 0 }, activeRef: { current: true },
    document: { visibilityState: 'visible' }, navigator: { onLine: true },
    clientDataVersion: () => 0, liveEpoch: { current: 0 },
    auctionPollPlan: () => ({ discover: true, ids: [], eligibilityWindows: [] }),
    lastDiscoveryAt: { current: 0 }, lastTargetAt: { current: 0 }, checkedAuctionWindows: { current: new Set() },
    readAuctionLiveUpdates, auctionBalanceChanged, setError: () => {}, setLastSyncedAt: () => {},
    setData: update => { dataRef.current = update(dataRef.current); },
    rememberAuctionData: value => { remembered = value; },
    setArchiveAuctions: update => { archive = update(archive); },
    setWonHistory: update => { wins = update(wins); },
    refreshRef: { current: async () => { refreshes++; dataRef.current.toons = [{ available: 50, heldPoints: 0 }]; } },
  });
  await poll();
  assert.equal(refreshes, 1);
  assert.deepEqual(remembered.auctions, []);
  assert.deepEqual(archive, []); assert.deepEqual(wins, []);
  assert.equal(dataRef.current.toons[0].available - dataRef.current.toons[0].heldPoints, 50);
});
