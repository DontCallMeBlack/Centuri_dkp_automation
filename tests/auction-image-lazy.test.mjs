import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

test('catalog image metadata and rejected signatures do not initialize the native image processor', async () => {
  let processorLoads = 0;
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier === 'sharp') {
      processorLoads++;
      throw new Error('Image processor must only load for a valid upload');
    }
    return nextResolve(specifier, context);
  } });
  try {
    const images = await import('../lib/auctionImage.ts');
    assert.equal(images.MAX_AUCTION_ITEM_IMAGE_BYTES, 150 * 1024);
    assert.equal(processorLoads, 0);
    await assert.rejects(images.optimizeAuctionImage(new Uint8Array([1, 2, 3])), /Upload a PNG/);
    assert.equal(processorLoads, 0);
    await assert.rejects(images.optimizeAuctionImage(new Uint8Array([0xff, 0xd8, 0xff])), /could not be decoded/);
    assert.equal(processorLoads, 1);
  } finally { hooks.deregister(); }
});
