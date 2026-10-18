// Run inside the configured deployment environment. Credentials are never
// logged. Default mode is read-only; --apply performs the index migration.
const { MongoClient } = require('mongoose').mongo;

const indexName = 'listed_item_name_unique';
const collation = { locale: 'en', strength: 2 };
const apply = process.argv.includes('--apply');

(async () => {
  if (!process.env.MONGODB_URI) throw new Error('Database configuration is required.');
  const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000, maxPoolSize: 1 });
  try {
    await client.connect();
    const items = client.db().collection('auctionitems');
    const indexesBefore = await items.indexes();
    const duplicates = await items.aggregate([
      { $match: { isListed: { $ne: false } } },
      { $group: { _id: '$name', count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $count: 'groups' },
    ], { collation }).toArray();
    if (duplicates.length) throw new Error('Listed catalog names conflict. Resolve them before migrating.');

    let normalized = 0;
    const dropped = [];
    if (apply) {
      // Match the app's existing visibility semantics, including legacy rows
      // without this field, before enforcing the explicit active-only filter.
      const result = await items.updateMany({ isListed: { $ne: false } }, { $set: { isListed: true } });
      normalized = result.modifiedCount;
      // Install the replacement first. Never leave listed names unprotected.
      await items.createIndex({ name: 1 }, {
        name: indexName, unique: true, collation, partialFilterExpression: { isListed: true },
      });
      for (const index of indexesBefore) {
        if (index.name !== indexName && index.unique && !index.partialFilterExpression &&
          Object.keys(index.key).length === 1 && index.key.name === 1) {
          await items.dropIndex(index.name);
          dropped.push(index.name);
        }
      }
    }
    const indexes = await items.indexes();
    const [listed, archived] = await Promise.all([
      items.countDocuments({ isListed: { $ne: false } }),
      items.countDocuments({ isListed: false }),
    ]);
    console.log('CATALOG_NAME_INDEX ' + JSON.stringify({ applied: apply, normalized, dropped, listed, archived,
      indexes: indexes.map(({ name, key, unique, partialFilterExpression, collation }) => ({ name, key, unique, partialFilterExpression,
        ...(collation ? { collation: { locale: collation.locale, strength: collation.strength } } : {}),
      })),
    }));
  } finally { await client.close(); }
})().catch((error) => {
  // Database/provider errors can embed credentials or record contents.
  console.error('Catalog name-index migration failed.', error.name);
  process.exitCode = 1;
});
