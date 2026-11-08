import test from 'node:test';
import assert from 'node:assert/strict';
import { auctionImageUrl } from '../lib/auctionImageUrl.ts';
import { cacheAuctionImage, readCachedAuctionImage } from '../lib/auctionImageCache.ts';

const image = size => ({ bytes: new Uint8Array(size), contentType: 'image/webp', etag: '"fixture"' });

test('all image consumers can use stable, encoded revision URLs including existing records', () => {
  assert.equal(auctionImageUrl('id', 2, 'revision'), '/api/auction/image?id=id&index=2&version=revision');
  assert.equal(auctionImageUrl('id'), '/api/auction/image?id=id&index=0&version=legacy');
  assert.match(auctionImageUrl('a&b', 1, 'x&y'), /id=a%26b&index=1&version=x%26y$/);
});

test('immutable image bytes expire after ten minutes rather than accumulating indefinitely', () => {
  const value = image(10);
  cacheAuctionImage('expiry', value, 0);
  assert.equal(readCachedAuctionImage('expiry', 599_999), value);
  assert.equal(readCachedAuctionImage('expiry', 600_000), null);
});

test('server image cache uses a byte budget and evicts least recently used revisions', () => {
  const value = image(6 * 1024 * 1024);
  cacheAuctionImage('bytes-first', value, 0);
  cacheAuctionImage('bytes-second', value, 0);
  assert.equal(readCachedAuctionImage('bytes-first', 1), value);
  cacheAuctionImage('bytes-third', value, 1);
  assert.equal(readCachedAuctionImage('bytes-second', 1), null);
  assert.equal(readCachedAuctionImage('bytes-first', 1), value);
  assert.equal(readCachedAuctionImage('bytes-third', 1), value);
});

test('server image cache also bounds many tiny entries and rejects oversized entries', () => {
  for (let index = 0; index <= 256; index++) cacheAuctionImage(`tiny-${index}`, image(1), 0);
  assert.equal(readCachedAuctionImage('tiny-0', 1), null);
  assert.ok(readCachedAuctionImage('tiny-256', 1));
  cacheAuctionImage('oversized', image(16 * 1024 * 1024 + 1), 0);
  assert.equal(readCachedAuctionImage('oversized', 1), null);
});
