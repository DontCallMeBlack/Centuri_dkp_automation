import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createSheetRecordLinkResolver, getSheetRecordKey } from '../lib/sheetRecordLinks.ts';

// The previous resolver is retained here only to measure the same fixtures.
function originalResolve(user, roster) {
  if (user.sheetRecords?.length) {
    const linkedRows = new Set();
    const legacyRecords = new Set();
    for (const linkedRecord of user.sheetRecords) {
      if (linkedRecord.rowIndex !== undefined) {
        const row = roster.find(record => record.rowIndex === linkedRecord.rowIndex);
        if (row && getSheetRecordKey(row) === getSheetRecordKey(linkedRecord)) {
          linkedRows.add(row.rowIndex);
          continue;
        }
      }
      legacyRecords.add(getSheetRecordKey(linkedRecord));
    }
    for (const record of roster) {
      if (legacyRecords.has(getSheetRecordKey(record))) linkedRows.add(record.rowIndex);
    }
    return [...linkedRows];
  }
  const owner = (user.sheetRecordName ?? '').trim().toLowerCase();
  return owner ? roster.filter(record => record.owner.trim().toLowerCase() === owner).map(record => record.rowIndex) : [];
}

const roster = Array.from({ length: 750 }, (_, index) => ({ rowIndex: index + 3, owner: `Owner ${Math.floor(index / 3)}`, account: `Toon ${index}` }));
const measure = (operation) => {
  for (let count = 0; count < 3; count++) operation();
  const cpuStart = process.cpuUsage();
  const start = performance.now();
  let iterations = 0;
  // Windows CPU counters have coarse resolution; collect at least 350 ms.
  do { operation(); iterations++; } while (iterations < 40 || performance.now() - start < 350);
  const elapsed = performance.now() - start;
  const cpu = process.cpuUsage(cpuStart);
  return { iterations, cpuMsPerRead: (cpu.user + cpu.system) / 1000 / iterations, elapsedMsPerRead: elapsed / iterations };
};

for (const mode of ['modern', 'legacy', 'mixed']) {
  const users = Array.from({ length: 250 }, (_, index) => {
    const records = roster.slice(index * 3, index * 3 + 3);
    if (mode === 'legacy' || (mode === 'mixed' && index % 3 === 0)) return { sheetRecordName: records[0].owner };
    return { sheetRecords: records.map(record => ({ ...record, ...(mode === 'mixed' && index % 3 === 1 ? { rowIndex: record.rowIndex + 1000 } : {}) })) };
  });
  const before = () => users.map(user => originalResolve(user, roster));
  const after = () => { const resolve = createSheetRecordLinkResolver(roster); return users.map(resolve); };
  assert.deepEqual(after(), before());
  const original = measure(before);
  const indexed = measure(after);
  console.log(JSON.stringify({ mode, rosterSize: roster.length, accounts: users.length, original, indexed,
    cpuReductionPercent: Math.round((1 - indexed.cpuMsPerRead / original.cpuMsPerRead) * 1000) / 10 }));
}
