import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { optimizeImageForUpload } from '../lib/auctionImageClient.ts';

const originalDocument = globalThis.document;
const originalBitmap = globalThis.createImageBitmap;
let bitmap, calls, backgrounds, encode;
beforeEach(() => {
  calls = []; backgrounds = 0;
  bitmap = { width: 768, height: 768, closed: false, close() { this.closed = true; } };
  globalThis.createImageBitmap = async () => bitmap;
  globalThis.document = { createElement: () => {
    const canvas = { width: 0, height: 0 };
    canvas.getContext = () => ({ drawImage() {}, fillRect() { backgrounds++; } });
    canvas.toBlob = (callback, type, quality) => {
      calls.push({ width: canvas.width, height: canvas.height, type, quality });
      callback(encode(canvas, type, quality));
    };
    return canvas;
  } };
});
afterEach(() => {
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
  if (originalBitmap === undefined) delete globalThis.createImageBitmap;
  else globalThis.createImageBitmap = originalBitmap;
});
const file = () => new File(['source'], 'IMG_8176-square.webp', { type: 'image/webp' });
const blob = (size, type) => new Blob([new Uint8Array(size)], { type });

test('normal WebP uploads retain their format without an extra encoding pass', async () => {
  encode = () => blob(80_000, 'image/webp');
  const result = await optimizeImageForUpload(file());
  assert.equal(result.type, 'image/webp'); assert.equal(result.name, 'IMG_8176-square.webp');
  assert.equal(calls.length, 1); assert.equal(bitmap.closed, true);
});

test('a browser returning oversized PNG for WebP can upload through JPEG fallback', async () => {
  encode = (_, type) => type === 'image/webp' ? blob(300_000, 'image/png') : blob(90_000, 'image/jpeg');
  const result = await optimizeImageForUpload(file());
  assert.equal(result.type, 'image/jpeg'); assert.equal(result.name, 'IMG_8176-square.jpg');
  assert.equal(backgrounds, 1); assert.equal(bitmap.closed, true);
});

test('small native PNG output is accepted with its actual MIME type and extension', async () => {
  encode = () => blob(90_000, 'image/png');
  const result = await optimizeImageForUpload(file());
  assert.equal(result.type, 'image/png'); assert.equal(result.name, 'IMG_8176-square.png');
  assert.equal(calls.length, 1);
});

test('detailed images continue below the old 700-pixel stopping point and preserve aspect ratio', async () => {
  bitmap.width = 1536; bitmap.height = 768;
  encode = canvas => blob(canvas.width <= 384 ? 200_000 : 300_000, 'image/webp');
  const result = await optimizeImageForUpload(file());
  assert.ok(result.size <= 256 * 1024);
  assert.equal(calls.at(-1).width, 384); assert.equal(calls.at(-1).height, 192);
  assert.equal(bitmap.closed, true);
});

test('a missing WebP encoder can fall back after a null canvas result', async () => {
  encode = (_, type) => type === 'image/webp' ? null : blob(90_000, 'image/jpeg');
  assert.equal((await optimizeImageForUpload(file())).type, 'image/jpeg');
});

test('failed encodes never produce an empty upload and always release the bitmap', async () => {
  encode = () => blob(0, 'image/webp');
  await assert.rejects(optimizeImageForUpload(file()), /could not be compressed enough/);
  assert.equal(bitmap.closed, true);
});

test('the browser pixel limit remains enforced before allocating a canvas', async () => {
  bitmap.width = 7000; bitmap.height = 7000;
  await assert.rejects(optimizeImageForUpload(file()), /too large to process/);
  assert.equal(calls.length, 0); assert.equal(bitmap.closed, true);
});
