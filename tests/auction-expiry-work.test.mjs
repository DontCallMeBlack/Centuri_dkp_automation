import test from 'node:test';
import assert from 'node:assert/strict';
import { auctionExpiryWorkFilter, hasAuctionExpiryWork } from '../lib/auctionExpiryWork.ts';

const now = Date.parse('2026-11-07T12:00:00Z');
const auction = (status, time) => ({status, endsAt:new Date(time)});

test('38 future live auctions and completed follow-ups require no settlement sweep', () => {
  const records = Array.from({length:38}, () => auction('active', now + 86_400_000));
  records.push(auction('completed', now - 86_400_000));
  assert.equal(hasAuctionExpiryWork(records, now), false);
  assert.equal(hasAuctionExpiryWork([], now), false);
});

test('expiry is inclusive and all recovery states retain the worker', () => {
  for (const status of ['active', 'settling', 'settlement-failed']) {
    assert.equal(hasAuctionExpiryWork([auction(status, now + 1)], now), false);
    assert.equal(hasAuctionExpiryWork([auction(status, now)], now), true);
    assert.equal(hasAuctionExpiryWork([auction(status, now - 1)], now), true);
  }
  assert.equal(hasAuctionExpiryWork([auction('removing', now + 86_400_000)], now), true);
});

test('manual review, retry backoff and live settlement leases do not wake an idle worker', () => {
  const ended = now - 1;
  assert.equal(hasAuctionExpiryWork([{...auction('settlement-failed', ended), settlementNeedsReview:true}], now), false);
  for (const [status, field] of [['settlement-failed', 'settlementRetryAt'], ['settling', 'settlementLeaseUntil']]) {
    assert.equal(hasAuctionExpiryWork([{...auction(status, ended), [field]:new Date(now + 1)}], now), false);
    assert.equal(hasAuctionExpiryWork([{...auction(status, ended), [field]:new Date(now)}], now), true);
    assert.equal(hasAuctionExpiryWork([{...auction(status, ended), [field]:new Date(now - 1)}], now), true);
    assert.equal(hasAuctionExpiryWork([{...auction(status, ended), [field]:null}], now), false);
  }
});

test('recent removals retain their transaction grace period and legacy removals remain conservative', () => {
  const removing = auction('removing', now + 86_400_000);
  assert.equal(hasAuctionExpiryWork([{...removing, updatedAt:new Date(now)}], now), false);
  assert.equal(hasAuctionExpiryWork([{...removing, updatedAt:new Date(now - 5 * 60_000)}], now), false);
  assert.equal(hasAuctionExpiryWork([{...removing, updatedAt:new Date(now - 5 * 60_000 - 1)}], now), true);
  assert.equal(hasAuctionExpiryWork([removing], now), true);
});

test('the global database probe agrees with complete-read eligibility for recovery states', () => {
  const matches = (record, filter) => Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') return expected.some(part => matches(record, part));
    const value = record[key];
    if (typeof expected !== 'object' || expected === null) return value === expected;
    return Object.entries(expected).every(([operator, operand]) => {
      if (operator === '$ne') return value !== operand;
      if (operator === '$exists') return (value !== undefined) === operand;
      if (operator === '$lt') return value < operand;
      if (operator === '$lte') return value <= operand;
      throw Error('Unsupported filter operator: ' + operator);
    });
  });
  const filter = auctionExpiryWorkFilter(new Date(now));
  for (const status of ['active', 'completed', 'removing', 'settling', 'settlement-failed']) {
    for (const endsAt of [now - 1, now, now + 1]) {
      for (const settlementNeedsReview of [undefined, false, true]) {
        for (const time of [undefined, new Date(now - 5 * 60_000 - 1), new Date(now), new Date(now + 1)]) {
          const record = {...auction(status, endsAt), settlementNeedsReview, updatedAt:time,
            settlementRetryAt:time, settlementLeaseUntil:time};
          assert.equal(hasAuctionExpiryWork([record], now), matches(record, filter), JSON.stringify(record));
        }
      }
    }
  }
});
