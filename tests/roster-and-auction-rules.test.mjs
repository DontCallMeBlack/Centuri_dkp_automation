import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSheetRoster } from '../lib/sheetRoster.ts';
import { readDkpCell, DkpIntegrityError } from '../lib/dkpAccounting.ts';
import { requestErrorResponse } from '../lib/security/request.ts';
import { AUCTION_DURATION_MS, AUCTION_ANTI_SNIPE_MS, getAuctionBidEndTime, normalizeAuctionBossType } from '../lib/auctionRules.ts';

test('unused spreadsheet template rows cannot block real roster awards or auctions', () => {
  const roster = parseSheetRoster([
    ['Ada', 'Main', 'Ranger', '5', '0', '100', '10', '90', '20'],
    ['', '', '', '#DIV/0!', '#REF!', 'not a balance', '', '#N/A', 'Weekly total'],
    ['   ', '', '', '#VALUE!'],
    ['Bea', 'Alt', 'Tank', '2', '0', '25', '5', '20', '8'],
  ]);
  assert.equal(roster.length, 2);
  assert.deepEqual(roster.map(toon=>toon.rowIndex), [3, 6]);
  assert.equal(roster[0].available, 90);
  assert.equal(roster[1].weeklyEarned, 2);
});

test('real toon errors identify the exact cell and never silently become zero', () => {
  assert.throws(() => parseSheetRoster([['Ada', 'Main', 'Ranger', '2', '0', '40', '5', '#REF!']]), /H3/);
  assert.throws(() => parseSheetRoster([[], ['Ada', 'Main', 'Tank', '#N\/A']]), /D4/);
  for (const value of ['NaN', 'Infinity', '1,2', '0x10', 'text', '#VALUE!', true, {}, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(()=>readDkpCell(value, 'H', 15), DkpIntegrityError);
  }
});

test('legitimate blank placeholders and numeric text retain their exact values', () => {
  for (const value of [undefined, null, '', ' ', '-', ' — ', '–']) assert.equal(readDkpCell(value, 'D', 3), 0);
  for (const [value, expected] of [['1,234.5', 1234.5], ['−2.5', -2.5], [' 7.25 ', 7.25], [0, 0], [-3.5, -3.5]]) {
    assert.equal(readDkpCell(value, 'H', 3), expected);
  }
});

test('auction/API errors preserve safe actionable roster details', async () => {
  const response = requestErrorResponse(new DkpIntegrityError('DKP cell H15 is not numeric.'), 'Unable to process auction request.');
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {error:'DKP cell H15 is not numeric.'});
});

test('new auctions last a full day and only late bids receive a five-minute window', () => {
  assert.equal(AUCTION_DURATION_MS, 86_400_000);
  assert.equal(AUCTION_ANTI_SNIPE_MS, 300_000);
  const bidAt = new Date('2026-10-18T12:00:00Z');
  for (const remaining of [1, 120_000, 300_000]) {
    assert.equal(getAuctionBidEndTime(new Date(bidAt.getTime()+remaining), bidAt).getTime(), bidAt.getTime()+300_000);
  }
  for (const remaining of [-1, 0, 300_001, AUCTION_DURATION_MS]) {
    assert.equal(getAuctionBidEndTime(new Date(bidAt.getTime()+remaining), bidAt).getTime(), bidAt.getTime()+remaining);
  }
  const originalEnd = new Date('2026-10-18T12:02:00Z');
  const extended = getAuctionBidEndTime(originalEnd, bidAt);
  assert.equal(getAuctionBidEndTime(extended, new Date('2026-10-18T12:04:00Z')).toISOString(), '2026-10-18T12:09:00.000Z');
});

test('legacy Base/Prime catalog entries can be posted with the current boss schema', () => {
  assert.equal(normalizeAuctionBossType('Base'), 'Prot');
  assert.equal(normalizeAuctionBossType('Prime'), 'Prot');
  assert.equal(normalizeAuctionBossType('Crom'), 'Crom');
  assert.equal(normalizeAuctionBossType(undefined), 'Unassigned');
  assert.equal(normalizeAuctionBossType('invalid'), null);
});
