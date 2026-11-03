import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { Types } from 'mongoose';

const state = globalThis.__auctionReads = {};
const id = n => new Types.ObjectId(n.toString(16).padStart(24, '0'));
const at = value => value?.toString();
function matches(record, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') return expected.some(part => matches(record, part));
    const value = key.split('.').reduce((result, field) => result?.[field], record);
    if (expected && typeof expected === 'object' && !(expected instanceof Types.ObjectId) && !(expected instanceof Date)) {
      return Object.entries(expected).every(([operator, operand]) => {
        if (operator === '$in') return operand.some(item => at(item) === at(value));
        if (operator === '$exists') return (value !== undefined) === operand;
        if (operator === '$lt') return value < operand;
        throw Error('Unhandled fixture operator: '+operator);
      });
    }
    return at(value) === at(expected);
  });
}
state.model = kind => ({ find(filter = {}) {
  const call = { kind, filter }; state.calls.push(call);
  let cap = Infinity; let order = {};
  return {
    select(fields) { call.fields = fields; return this; },
    sort(value) { order = value; return this; },
    limit(value) { cap = value; return this; },
    async lean() { return (kind === 'Auction' ? state.auctions : kind === 'AuctionItem' ? state.items : [])
      .filter(row => matches(row, filter)).sort((a,b) => {
        for (const [key,direction] of Object.entries(order)) {
          const left=a[key] instanceof Date ? a[key].getTime() : at(a[key]);
          const right=b[key] instanceof Date ? b[key].getTime() : at(b[key]);
          if(left<right)return -direction; if(left>right)return direction;
        }
        return 0;
      }).slice(0, cap); },
  };
} });
const unused = names => names.map(name => `export function ${name}(){throw Error('Unexpected write: ${name}');}`).join('\n');
const mocks = {
  'next/server': `export const NextResponse = {json: (value, init) => Response.json(value, init)}; export function after(){globalThis.__auctionReads.sweeps++;}`,
  '@/lib/auth/session': `export async function getSessionUser(){return globalThis.__auctionReads.user;}`,
  '@/lib/auth/rateLimit': `export async function limitMemberRequests(){}`,
  '@/lib/googleSheets': `export async function getSheetRosterSnapshot(){globalThis.__auctionReads.rosterReads++; return {roster:[],fetchedAt:new Date(),stale:false,refreshDelayed:false};} ${unused(['adjustPlayersDKP','getSheetRoster','withDkpLedgerLock'])}`,
  '@/lib/dkpWeeklyEarned': `export async function getRosterWithWeeklyEarned(rows){return rows;}`,
  '@/lib/readToonRoleSchedules': `export async function readToonRoleSchedules(){return {roleChanges:[],roleApprovals:[]};}`,
  '@/lib/auctionFollowUpReads': `export async function readAuctionCreatorRoles(){return [];}`,
  '@/lib/auctionSettlementWorker': unused(['settleExpiredAuctions']),
  '@/lib/auctionHold': unused(['getBoundAuctionHold']),
  '@/lib/auth/administration': unused(['withClanAdministrationTransaction']),
};
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  let source = mocks[specifier];
  if (specifier.startsWith('@/lib/models/')) source = `export default globalThis.__auctionReads.model('${specifier.split('/').at(-1)}');`;
  if (source) return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit:true };
  if (specifier.startsWith('@/')) return nextResolve(new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href, context);
  if (specifier.startsWith('.') && context.parentURL?.includes('/lib/') && !/\.[a-z]+$/i.test(specifier)) return nextResolve(new URL(`${specifier}.ts`,context.parentURL).href,context);
  return nextResolve(specifier,context);
} });
const { GET } = await import('../app/api/auction/route.ts');
hooks.deregister();
const auction = (n, extra = {}) => ({ _id:id(n), itemId:id(900), itemName:'Boots', requiredRoles:['tank'],
  createdBy:'Chief', createdByUserId:id(800), createdAt:new Date('2026-11-01'), endsAt:new Date('2026-11-05'),
  status:'active', deliveryStatus:'not-required', bidVersion:0, ...extra });
const bid = {userId:id(800), nickname:'Chief', rowIndex:3, owner:'Chief', account:'Main', amount:10, placedAt:new Date('2026-11-01')};
const read = async suffix => { const response = await GET(new Request('https://centuri.test/api/auction'+suffix)); assert.equal(response.status,200); return response.json(); };
const token = a => `${a.bidVersion}:${a.status}:${a.endsAt.toISOString()}:${a.deliveryStatus}:${a.itemId}`;
beforeEach(() => {
  state.user = {_id:id(800),nickname:'Chief',role:'chief',sheetRecords:[]}; state.calls=[]; state.rosterReads=0; state.sweeps=0;
  state.items=[{_id:id(900),name:'Boots',requiredRoles:['tank'],imageCount:1,isListed:true}]; state.auctions=[];
});

test('initial load excludes resolved history but preserves every outstanding workflow',async()=>{
  state.auctions=[auction(1),auction(2,{status:'settling'}),auction(3,{status:'settlement-failed'}),
    auction(4,{status:'completed',deliveryStatus:'pending',highBid:bid,winner:bid}),
    auction(5,{status:'completed'}),auction(6,{status:'completed',deliveryStatus:'done',highBid:bid,winner:bid}),
    auction(7,{status:'completed',deliveryStatus:'banked'}),auction(8,{status:'removing'})];
  const result=await read('');
  assert.deepEqual(result.auctions.map(a=>a.id),[8,5,4,3,2,1].map(n=>at(id(n))));
  assert.equal(state.calls.filter(c=>c.kind==='Auction').length,1);
  assert.equal(result.auctions.find(a=>a.id===at(id(4))).canMarkDelivered,true);
  assert.equal(result.auctions.find(a=>a.id===at(id(5))).canResolveNoBid,true);
});

test('live view never caps active records at the newest 100',async()=>{
  state.auctions=Array.from({length:140},(_,n)=>auction(n+1));
  assert.equal((await read('')).auctions.length,140);
});

test('history is one bounded page and skips balances, holds, and the full catalog',async()=>{
  state.auctions=Array.from({length:55},(_,n)=>auction(n+1,{status:'completed',deliveryStatus:'done'}));
  const result=await read('?includeArchive=1');
  assert.equal(result.auctions.length,50); assert.ok(result.nextCursor);
  assert.equal(state.rosterReads,0); assert.equal(state.sweeps,0);
  assert.deepEqual(state.calls.map(c=>c.kind),['Auction','AuctionItem']);
  assert.ok(state.calls[1].filter._id.$in.length===1);
  assert.equal(result.toons,undefined);
});

test('personal wins are filtered by the authenticated account before pagination',async()=>{
  state.auctions=[auction(1,{status:'completed',winner:{...bid,userId:id(799)}}),auction(2,{status:'completed',winner:bid})];
  const result=await read('?includeArchive=1&won=1');
  assert.deepEqual(result.auctions.map(a=>a.id),[at(id(2))]); assert.equal(result.auctions[0].isWinner,true);
  assert.equal(state.rosterReads,0);
});

test('live check returns no data for unchanged records and only changed auctions otherwise',async()=>{
  const first=auction(1), second=auction(2); state.auctions=[first,second];
  const query='?live=1&versions='+encodeURIComponent(JSON.stringify(state.auctions.map(a=>[at(a._id),token(a)])));
  assert.deepEqual(await read(query),{changed:false});
  first.bidVersion=1; first.highBid=bid;
  const result=await read(query); assert.equal(result.auctions.length,1); assert.equal(result.auctions[0].id,at(first._id));
  assert.equal(result.auctions[0].highBid.isMine,true); assert.equal(state.rosterReads,0);
});

test('tracked auctions report final delivery and actual deletion without reading the archive',async()=>{
  const old=auction(1,{highBid:bid});
  state.auctions=[{...old,status:'completed',deliveryStatus:'done',winner:bid},auction(3,{status:'completed',deliveryStatus:'done'})];
  const result=await read('?live=1&versions='+encodeURIComponent(JSON.stringify([[at(id(1)),token(old)],[at(id(2)),'old']])));
  assert.deepEqual(result.removedIds,[at(id(2))]); assert.equal(result.auctions.length,1);
  assert.equal(result.auctions[0].status,'completed'); assert.equal(result.auctions[0].deliveryStatus,'done');
});

test('unauthenticated reads cannot access live, history, or personal wins',async()=>{
  state.user=null;
  for(const suffix of ['', '?live=1', '?includeArchive=1&won=1']) assert.equal((await GET(new Request('https://centuri.test/api/auction'+suffix))).status,401);
  assert.equal(state.calls.length,0);
});

test('closed history cursor pages never duplicate or omit completed records', async()=>{
  state.auctions=Array.from({length:55},(_,n)=>auction(n+1,{status:'completed',deliveryStatus:'done'}));
  const first=await read('?includeArchive=1');
  const second=await read('?includeArchive=1&cursor='+first.nextCursor);
  assert.equal(second.auctions.length,5); assert.equal(second.nextCursor,null);
  assert.equal(new Set([...first.auctions,...second.auctions].map(a=>a.id)).size,55);
});

test('invalid history cursors return a validation response rather than an unhandled rejection',async()=>{
  const response=await GET(new Request('https://centuri.test/api/auction?includeArchive=1&cursor=invalid'));
  assert.equal(response.status,400);
  assert.equal(state.rosterReads,0);
});

test('targeted live checks read only the requested auction and never remove unrelated cards',async()=>{
  state.auctions=[auction(1),auction(2),auction(3,{status:'completed',deliveryStatus:'done'})];
  const query='?live=1&ids='+encodeURIComponent(JSON.stringify([at(id(1))]))+'&versions='+encodeURIComponent(JSON.stringify([[at(id(1)),'old'],[at(id(2)),'old']]));
  const result=await read(query);assert.deepEqual(result.auctions.map(a=>a.id),[at(id(1))]);assert.deepEqual(result.removedIds,[]);
  assert.deepEqual(state.calls.find(c=>c.kind==='Auction').filter,{_id:{$in:[id(1)]}});
});
test('targeted live checks reject malformed or oversized ID lists',async()=>{
  for(const ids of ['{}','["bad"]',JSON.stringify(Array.from({length:201},()=>at(id(1))))]){
    assert.equal((await GET(new Request('https://centuri.test/api/auction?live=1&ids='+encodeURIComponent(ids)))).status,400);
  }
  assert.equal(state.calls.length,0);
});
