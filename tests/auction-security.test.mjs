import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import sharp from 'sharp';
import { canBindAuctionHold, hasMovedAuctionReservation, holdMatchesIdentity, isAuctionBidInput, isAuctionPoster, serializeAuctionBid } from '../lib/auctionSecurity.ts';
import { optimizeAuctionImage, verifyAuctionImageType, AuctionImageError, MAX_AUCTION_IMAGE_BYTES, MAX_AUCTION_UPLOAD_IMAGE_BYTES } from '../lib/auctionImage.ts';
import Auction from '../lib/models/Auction.ts';
import AuctionHold from '../lib/models/AuctionHold.ts';
import { canRetryAuctionSettlement } from '../lib/auctionSettlement.ts';

const identity = { owner: 'Ada', account: 'Main' };
const reservation = (rowIndex, amount, account = 'Main') => ({ rowIndex, amount, owner: 'Ada', account });

test('auction ownership requires a stable creator ID even when a nickname is reused', () => {
  const aliceId = new mongoose.Types.ObjectId();
  const otherId = new mongoose.Types.ObjectId();
  assert.equal(isAuctionPoster({ createdByUserId: aliceId }, aliceId), true);
  assert.equal(isAuctionPoster({ createdByUserId: aliceId }, otherId), false);
  assert.equal(isAuctionPoster({ createdBy: 'Ada' }, aliceId), false);
});

test('accepted hydrated bids serialize only their public fields', () => {
  const userId = new mongoose.Types.ObjectId();
  const placedAt = new Date('2026-10-17T12:00:00Z');
  const auction = new Auction({
    itemName: 'Parent document must never be serialized',
    highBid: { userId, nickname: 'Ada', rowIndex: 3, ...identity, amount: 10, placedAt },
  });
  const serialized = serializeAuctionBid(auction.highBid, userId);
  assert.deepEqual(serialized, {
    userId: userId.toString(), isMine: true, nickname: 'Ada', rowIndex: 3,
    ...identity, amount: 10, placedAt: placedAt.toISOString(),
  });
  assert.doesNotThrow(() => JSON.stringify(serialized));
  assert.equal(serializeAuctionBid(undefined, userId), null);
});

test('legacy reservation adoption proves the identity and exact total of every outstanding bid', () => {
  const hold = { rowIndex: 3, heldPoints: 40 };
  const valid = [reservation(3, 10), reservation(3, 30), reservation(4, 100, 'Alt')];
  assert.equal(canBindAuctionHold(hold, identity, valid), true);
  assert.equal(canBindAuctionHold(hold, identity, [reservation(3, 10)]), false);
  assert.equal(canBindAuctionHold(hold, identity, [reservation(3, 40, 'Alt')]), false);
  assert.equal(canBindAuctionHold(hold, identity, []), false);
  assert.equal(canBindAuctionHold(hold, identity, [reservation(3, -40)]), false);
  assert.equal(canBindAuctionHold(hold, identity, [reservation(3, Infinity)]), false);
});

test('bound holds reject row reuse and corrupt counters, and unused rows can be rebound', () => {
  const hold = { rowIndex: 3, heldPoints: 40, ...identity };
  assert.equal(canBindAuctionHold(hold, { owner: ' ada ', account: 'MAIN' }, [reservation(3, 40)]), true);
  assert.equal(canBindAuctionHold(hold, { owner: 'Bea', account: 'Main' }, [reservation(3, 40)]), false);
  assert.equal(canBindAuctionHold(hold, identity, [reservation(3, 20)]), false);
  assert.equal(canBindAuctionHold({ ...hold, heldPoints: 0 }, identity, [reservation(3, 40)]), false);
  assert.equal(canBindAuctionHold({ ...hold, heldPoints: 0 }, { owner: 'Bea', account: 'Alt' }, []), true);
  assert.equal(canBindAuctionHold({ ...hold, heldPoints: -1 }, identity, []), false);
  assert.equal(canBindAuctionHold({ ...hold, heldPoints: 1.5 }, identity, []), false);
  assert.equal(holdMatchesIdentity(hold, { owner: ' ada ', account: 'MAIN' }), true);
  assert.equal(holdMatchesIdentity({ rowIndex: 3, heldPoints: 40 }, identity), false);
});

test('moved identities cannot open a second reservation on their new roster row', () => {
  assert.equal(hasMovedAuctionReservation({ ...identity, rowIndex: 8 }, [reservation(3, 10)]), true);
  assert.equal(hasMovedAuctionReservation({ ...identity, rowIndex: 3 }, [reservation(3, 10)]), false);
  assert.equal(hasMovedAuctionReservation({ ...identity, rowIndex: 8 }, [reservation(3, 10, 'Alt')]), false);
});

test('financial settlement recovery requires a senior manager and a known safe replay marker', () => {
  const recoverable = { status: 'settlement-failed', settlementAttemptId: 'attempt-1' };
  assert.equal(canRetryAuctionSettlement('chief', recoverable), true);
  assert.equal(canRetryAuctionSettlement('general', recoverable), true);
  assert.equal(canRetryAuctionSettlement('guardian', recoverable), false);
  assert.equal(canRetryAuctionSettlement('clansman', recoverable), false);
  assert.equal(canRetryAuctionSettlement('chief', { status: 'settlement-failed' }), false);
  assert.equal(canRetryAuctionSettlement('chief', { status: 'settlement-failed', settlementDkpApplied: true }), true);
  assert.equal(canRetryAuctionSettlement('chief', { ...recoverable, status: 'active' }), false);
});

test('bid inputs require canonical object IDs, roster rows, and safe positive integer amounts', () => {
  const input = { auctionId: new mongoose.Types.ObjectId().toString(), rowIndex: 3, amount: 10 };
  assert.equal(isAuctionBidInput(input), true);
  for (const rowIndex of [2, 1001, 3.5, NaN, Infinity, '3']) {
    assert.equal(isAuctionBidInput({ ...input, rowIndex }), false);
  }
  for (const amount of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '10']) {
    assert.equal(isAuctionBidInput({ ...input, amount }), false);
  }
  assert.equal(isAuctionBidInput({ ...input, auctionId: { $ne: null } }), false);
  assert.equal(isAuctionBidInput({ ...input, auctionId: 'not-an-id' }), false);
});

test('persistence rejects invalid financial values without any database connection', async () => {
  for (const heldPoints of [-1, 0.1, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const hold = new AuctionHold({ rowIndex: 3, heldPoints, ...identity });
    await assert.rejects(hold.validate(), (error) => Boolean(error.errors.heldPoints));
  }
  const auction = new Auction({
    itemId: new mongoose.Types.ObjectId(), itemName: 'Boots', requiredRoles: ['Druid'], requiredRole: 'Druid',
    createdBy: 'Ada', endsAt: new Date(),
    highBid: { userId: new mongoose.Types.ObjectId(), nickname: 'Ada', rowIndex: 3, ...identity, amount: 1.5, placedAt: new Date() },
  });
  await assert.rejects(auction.validate(), (error) => Boolean(error.errors['highBid.amount']));
});

test('image processing rejects unsupported content, corrupt decoders, and oversized bodies', async () => {
  assert.equal(verifyAuctionImageType(new TextEncoder().encode('<svg onload="alert(1)"></svg>')), null);
  await assert.rejects(optimizeAuctionImage(new Uint8Array()), AuctionImageError);
  await assert.rejects(optimizeAuctionImage(new Uint8Array(MAX_AUCTION_UPLOAD_IMAGE_BYTES + 1)), AuctionImageError);
  const corruptPng = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(verifyAuctionImageType(corruptPng), 'image/png');
  await assert.rejects(optimizeAuctionImage(corruptPng), /could not be decoded/);
});

test('uploaded raster images are resized, reencoded, and stripped of original metadata', async () => {
  const source = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#152439' } })
    .withMetadata({ orientation: 6 }).png().toBuffer();
  const optimized = await optimizeAuctionImage(source);
  const metadata = await sharp(optimized).metadata();
  assert.equal(metadata.format, 'webp');
  assert.ok(metadata.width <= 1000 && metadata.height <= 1000);
  assert.ok(optimized.byteLength <= MAX_AUCTION_IMAGE_BYTES);
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.orientation, undefined);
});
