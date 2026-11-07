import test from 'node:test';
import assert from 'node:assert/strict';
import { hasAuctionExpiryWork } from '../lib/auctionExpiryWork.ts';

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
