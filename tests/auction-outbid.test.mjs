import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import mongoose from 'mongoose';
import Auction from '../lib/models/Auction.ts';
import AuctionHold from '../lib/models/AuctionHold.ts';
import AuctionBidHistory from '../lib/models/AuctionBidHistory.ts';

// Keep real hydrated bid subdocuments and reservation validation. Only replace
// persistence, authentication and the external Sheet transport.
const state = globalThis.__auctionOutbid = {};
const id = n => new mongoose.Types.ObjectId(n.toString(16).padStart(24, '0'));
const schemaModels = { Auction, AuctionHold, AuctionBidHistory };
const plain = value => value?.toObject ? value.toObject() : value;
const same = (left, right) => left instanceof Date || right instanceof Date
  ? Number(left) === Number(right) : String(left) === String(right);
function matches(record, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    const value = key.split('.').reduce((result, field) => result?.[field], record);
    if (expected && typeof expected === 'object' && !(expected instanceof mongoose.Types.ObjectId) && !(expected instanceof Date)) {
      return Object.entries(expected).every(([operator, operand]) => {
        if (operator === '$in') return operand.some(item => same(value, item));
        if (operator === '$ne') return !same(value, operand);
        if (operator === '$exists') return (value !== undefined) === operand;
        if (operator === '$gt') return value > operand;
        throw new Error('Unsupported fixture operator: ' + operator);
      });
    }
    return same(value, expected);
  });
}
function query(value) {
  return {
    select() { return this; }, session() { return this; },
    lean() { return Promise.resolve(Array.isArray(value) ? value.map(plain) : plain(value)); },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
  };
}
function document(kind, data) {
  const result = new schemaModels[kind](data);
  Object.defineProperty(result, 'save', { value: async () => { await result.validate(); return result; } });
  return result;
}
state.model = kind => ({
  find(filter = {}) { return query((state[kind] ?? []).filter(record => matches(record, filter))); },
  findOne(filter) { return query((state[kind] ?? []).find(record => matches(record, filter)) ?? null); },
  findById(value) { return this.findOne({ _id: value }); },
  exists(filter) { return this.findOne(filter); },
  async create(records) {
    const created = records.map(record => document(kind, record));
    for (const record of created) await record.validate();
    state[kind].push(...created);
    return created;
  },
});
state.transaction = async operation => {
  const snapshots = Object.fromEntries(Object.keys(schemaModels).map(kind => [kind, state[kind].map(plain)]));
  try { return await operation({}); }
  catch (error) {
    for (const [kind, records] of Object.entries(snapshots)) state[kind] = records.map(record => document(kind, record));
    throw error;
  }
};
const mocks = {
  'next/server': 'export const NextResponse={json:(value,init)=>Response.json(value,init)}; export function after(){}',
  '@/lib/auth/session': 'export async function getSessionUser(){return globalThis.__auctionOutbid.user;}',
  '@/lib/auth/rateLimit': 'export async function limitMemberRequests(){}',
  '@/lib/auth/administration': 'export const withClanAdministrationTransaction=operation=>globalThis.__auctionOutbid.transaction(operation);',
  '@/lib/googleSheets': 'export const withDkpLedgerLock=operation=>operation(globalThis.__auctionOutbid.roster);',
  '@/lib/dkpWeeklyEarned': 'export async function getRosterWithWeeklyEarned(roster){return roster;}',
};
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  let source = mocks[specifier];
  if (specifier.startsWith('@/lib/models/')) source = `export default globalThis.__auctionOutbid.model('${specifier.split('/').at(-1)}');`;
  if (source) return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  if (specifier.startsWith('@/')) return nextResolve(new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href, context);
  if (specifier.startsWith('.') && context.parentURL?.startsWith(new URL('../lib/', import.meta.url).href) && !/\.[a-z]+$/i.test(specifier)) {
    return nextResolve(new URL(`${specifier}.ts`, context.parentURL).href, context);
  }
  return nextResolve(specifier, context);
} });
const { POST } = await import('../app/api/auction/route.ts');
after(() => hooks.deregister());

const initialBid = { userId: id(1), nickname: 'Ada', rowIndex: 3, owner: 'Ada', account: 'Main', amount: 20, placedAt: new Date('2026-11-01') };
const current = () => state.Auction[0];
const held = rowIndex => state.AuctionHold.find(hold => hold.rowIndex === rowIndex)?.heldPoints ?? 0;
async function bid(amount, rowIndex = 4) {
  const origin = new URL(process.env.APP_ORIGIN || 'https://centuri.test').origin;
  const response = await POST(new Request(origin + '/api/auction', {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'bid', auctionId: String(current()._id), rowIndex, amount }),
  }));
  return { status: response.status, body: await response.json() };
}
beforeEach(() => {
  state.roster = [
    { rowIndex: 3, owner: 'Ada', account: 'Main', subClass: 'Tank', weeklyEarned: 0, weeklySpent: 0, spent: 0, available: 100, dkpIssues: [] },
    { rowIndex: 4, owner: 'Bea', account: 'Alt', subClass: 'Tank', weeklyEarned: 0, weeklySpent: 0, spent: 0, available: 100, dkpIssues: [] },
  ];
  state.User = state.roster.map((toon, index) => ({ _id: id(index + 1), nickname: toon.owner, role: 'clansman', status: 'approved', sheetRecords: [toon] }));
  state.user = state.User[1];
  state.Auction = [document('Auction', {
    _id: id(100), itemId: id(200), itemName: 'Boots', requiredRoles: ['Tank'], requiredRole: 'Tank', createdBy: 'Chief',
    endsAt: new Date(Date.now() + 60 * 60_000), status: 'active', highBid: initialBid,
  })];
  state.AuctionHold = [document('AuctionHold', { rowIndex: 3, owner: 'Ada', account: 'Main', heldPoints: 20 })];
  state.AuctionBidHistory = [];
  state.ToonRoleChange = []; state.ToonRoleChangeRequest = [];
});

test('another user outbids a hydrated bid, releases its hold and records both bids', async () => {
  assert.equal(current().highBid.owner, 'Ada');
  assert.equal({ ...current().highBid }.owner, undefined, 'real Mongoose bids cannot be copied with object spread');
  const result = await bid(30);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.highBid.owner, 'Bea');
  assert.equal(result.body.highBid.isMine, true);
  assert.equal(current().highBid.amount, 30);
  assert.equal(current().bidVersion, 1);
  assert.equal(held(3), 0); assert.equal(held(4), 30);
  assert.deepEqual(state.AuctionBidHistory.map(record => [record.owner, record.account, record.amount]), [
    ['Ada', 'Main', 20], ['Bea', 'Alt', 30],
  ]);
  assert.equal(state.AuctionHold.find(hold => hold.rowIndex === 3).owner, 'Ada');
});

test('a toon increases its own bid using only the additional unreserved DKP', async () => {
  state.user = state.User[0]; state.roster[0].available = 30;
  const result = await bid(30, 3);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(held(3), 30); assert.equal(state.AuctionHold.length, 1);
  assert.equal(current().highBid.userId.toString(), state.user._id.toString());
});

test('an unaffordable outbid rolls back the previous hold, new hold and bid history', async () => {
  state.roster[1].available = 29;
  const result = await bid(30);
  assert.equal(result.status, 409);
  assert.match(result.body.error, /enough unreserved DKP/);
  assert.equal(held(3), 20); assert.equal(held(4), 0);
  assert.equal(state.AuctionHold.length, 1);
  assert.equal(current().highBid.owner, 'Ada');
  assert.equal(current().highBid.amount, 20); assert.equal(current().bidVersion, 0);
  assert.equal(state.AuctionBidHistory.length, 0);
});

test('equal and stale bids cannot change the leader or reservations', async () => {
  for (const amount of [20, 19]) {
    const result = await bid(amount);
    assert.equal(result.status, 409); assert.match(result.body.error, /must exceed 20/);
    assert.equal(held(3), 20); assert.equal(held(4), 0);
    assert.equal(current().highBid.amount, 20); assert.equal(current().bidVersion, 0);
    assert.equal(state.AuctionBidHistory.length, 0);
  }
});

test('a first bid creates the toon hold and records only its own bid', async () => {
  current().highBid = undefined; state.AuctionHold = [];
  const result = await bid(10);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(held(4), 10); assert.equal(state.AuctionHold.length, 1);
  assert.equal(state.AuctionBidHistory.length, 1);
});

test('outbidding reconciles a legacy row hold against its proven reservation identity', async () => {
  state.AuctionHold[0].owner = undefined; state.AuctionHold[0].account = undefined;
  const result = await bid(30);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(held(3), 0); assert.equal(held(4), 30);
  assert.equal(state.AuctionHold[0].owner, 'Ada'); assert.equal(state.AuctionHold[0].account, 'Main');
});

test('outbidding preserves both users reservations on other auctions and avoids duplicate history', async () => {
  state.Auction.push(document('Auction', { ...plain(current()), _id: id(101), highBid: { ...initialBid, amount: 7 } }));
  state.Auction.push(document('Auction', { ...plain(current()), _id: id(102), highBid: {
    ...initialBid, userId: id(2), nickname: 'Bea', rowIndex: 4, owner: 'Bea', account: 'Alt', amount: 11,
  } }));
  state.AuctionHold[0].heldPoints = 27;
  state.AuctionHold.push(document('AuctionHold', { rowIndex: 4, owner: 'Bea', account: 'Alt', heldPoints: 11 }));
  state.AuctionBidHistory.push(document('AuctionBidHistory', { ...initialBid, auctionId: current()._id, identityKey: '["ada","main"]' }));
  const result = await bid(30);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(held(3), 7); assert.equal(held(4), 41);
  assert.equal(state.AuctionBidHistory.length, 2);
});

test('a previously outbid user can bid again and reacquire only their new reservation', async () => {
  const first = await bid(30);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  state.user = state.User[0];
  const second = await bid(40, 3);
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(held(3), 40); assert.equal(held(4), 0);
  assert.equal(current().highBid.owner, 'Ada'); assert.equal(current().bidVersion, 2);
  assert.deepEqual(state.AuctionBidHistory.map(record => record.amount), [20, 30, 40]);
});

test('an outbid reservation can be released after the previous toon leaves the roster', async () => {
  state.roster = state.roster.filter(toon => toon.rowIndex !== 3);
  const result = await bid(30);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(held(3), 0); assert.equal(held(4), 30);
});

test('closed and expired auctions reject bids before changing any reservation', async () => {
  current().biddingClosed = true;
  let result = await bid(30);
  assert.equal(result.status, 409); assert.match(result.body.error, /Auction closed/);
  current().biddingClosed = false; current().endsAt = new Date(Date.now() - 1);
  result = await bid(30);
  assert.equal(result.status, 409); assert.match(result.body.error, /Auction closed/);
  assert.equal(held(3), 20); assert.equal(held(4), 0);
  assert.equal(current().highBid.amount, 20); assert.equal(state.AuctionBidHistory.length, 0);
});
