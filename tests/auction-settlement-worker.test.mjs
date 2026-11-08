import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const state = globalThis.__auctionSettlementWorker = { sheetModuleLoads:0 };
const mocks = {
  '@/lib/models/Auction': `export default {
    async updateMany(filter, update){globalThis.__auctionSettlementWorker.calls.push({operation:'updateMany',filter,update});},
    find(filter){globalThis.__auctionSettlementWorker.calls.push({operation:'find',filter});return {
      sort(){return this;},limit(){return Promise.resolve(globalThis.__auctionSettlementWorker.auctions);}
    };},
    async updateOne(filter, update){globalThis.__auctionSettlementWorker.calls.push({operation:'updateOne',filter,update});}
  };`,
  '@/lib/auctionHold': `export async function getBoundAuctionHold(){throw Error('Unexpected financial work');}`,
  '@/lib/googleSheets': `globalThis.__auctionSettlementWorker.sheetModuleLoads++;
    export async function adjustPlayersDKP(){throw Error('Unexpected Sheet write');}`,
};
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (mocks[specifier]) return {url:`data:text/javascript,${encodeURIComponent(mocks[specifier])}`,shortCircuit:true};
  if (specifier.startsWith('@/')) return nextResolve(new URL(`../${specifier.slice(2)}.ts`,import.meta.url).href,context);
  if (specifier.startsWith('.') && context.parentURL?.startsWith(new URL('../lib/',import.meta.url).href) && !/\.[a-z]+$/i.test(specifier)) {
    return nextResolve(new URL(`${specifier}.ts`,context.parentURL).href,context);
  }
  return nextResolve(specifier,context);
} });
const { settleExpiredAuctions } = await import('../lib/auctionSettlementWorker.ts');
after(()=>hooks.deregister());
beforeEach(()=>{state.calls=[];state.auctions=[];});

test('a cold idle expiry worker never loads the Sheet mutation module',async()=>{
  await settleExpiredAuctions();
  assert.equal(state.sheetModuleLoads,0);
  assert.deepEqual(state.calls.map(call=>call.operation),['updateMany','find']);
});

test('no-bid auctions complete without loading the Sheet mutation module or touching reservations',async()=>{
  state.auctions=[{_id:'no-bids',status:'active',endsAt:new Date(Date.now()-1)}];
  await settleExpiredAuctions();
  assert.equal(state.sheetModuleLoads,0);
  const completion=state.calls.find(call=>call.operation==='updateOne');
  assert.equal(completion.filter._id,'no-bids');
  assert.equal(completion.filter.highBid,null);
  assert.equal(completion.update.$set.status,'completed');
  assert.equal(completion.update.$set.deliveryStatus,'not-required');
});
