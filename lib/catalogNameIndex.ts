import type { mongo } from 'mongoose';
import AuctionItem from '@/lib/models/AuctionItem';
import { RequestValidationError } from '@/lib/security/request';

type CatalogCollection = Pick<mongo.Collection, 'indexes' | 'aggregate' | 'updateMany' | 'createIndex' | 'dropIndex'>;
const indexName = 'listed_item_name_unique';
const collation = { locale: 'en', strength: 2 };

/** Replace the legacy global name constraint without deleting archived items. */
export async function migrateCatalogNameIndex(items: CatalogCollection) {
  const indexes = await items.indexes().catch((error: unknown) => {
    if (typeof error === 'object' && error && 'code' in error && error.code === 26) return [];
    throw error;
  });
  const legacy = indexes.filter(index => index.name !== indexName && index.unique &&
    !index.partialFilterExpression && Object.keys(index.key).length === 1 && index.key.name === 1);
  const ready = indexes.some(index => index.name === indexName && index.unique &&
    Object.keys(index.key).length === 1 && index.key.name === 1 &&
    index.partialFilterExpression?.isListed === true && index.collation?.locale === 'en' && index.collation?.strength === 2);
  if (ready && !legacy.length) return;

  const duplicates = await items.aggregate([
    { $match: { isListed: { $ne: false } } },
    { $group: { _id: '$name', count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 1 },
  ], { collation }).toArray();
  if (duplicates.length) {
    throw new RequestValidationError('Existing listed catalog names conflict. A manager must resolve those duplicates before adding or editing items.', 409);
  }

  await items.updateMany({ isListed: { $ne: false } }, { $set: { isListed: true } });
  // Install the listed-only constraint before removing any older protection.
  await items.createIndex({ name: 1 }, {
    name: indexName, unique: true, collation, partialFilterExpression: { isListed: true },
  });
  for (const index of legacy) {
    await items.dropIndex(index.name!).catch((error: unknown) => {
      // Another server instance may finish the same migration first.
      if (typeof error === 'object' && error && 'code' in error && error.code === 27) return;
      throw error;
    });
  }
}

let indexReady: Promise<void> | undefined;
export function ensureCatalogNameIndex() {
  indexReady ??= migrateCatalogNameIndex(AuctionItem.collection).catch((error: unknown) => {
    indexReady = undefined;
    throw error;
  });
  return indexReady;
}
