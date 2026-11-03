import test from 'node:test';
import assert from 'node:assert/strict';
import { auctionPollPlan, AUCTION_DISCOVERY_MS } from '../lib/client/auctionPolling.ts';
const now=Date.parse('2026-11-03T12:00:00Z');
const auction=(remaining,extra={})=>({id:'a',status:'active',endsAt:new Date(now+remaining*60_000).toISOString(),biddingClosed:false,requiredRoles:['Tank'],highBid:null,...extra});
const toon={rowIndex:3,subClass:'Tank',available:100,heldPoints:0};
const data=(a,toons=[toon],extra={})=>({auctions:[a],toons,canBidWeekly:true,...extra});
const checked=a=>new Set([`${a.id}:${a.endsAt}`]);
test('outside the final five minutes, only a local timer wakes at the boundary',()=>{
 const a=auction(6);const plan=auctionPollPlan(data(a),now,now,0);
 assert.deepEqual(plan.ids,[]);assert.deepEqual(plan.eligibilityWindows,[]);assert.equal(plan.discover,false);assert.equal(plan.delay,60_000);
});
test('eligible auction checks are spaced by a minute, including the exact five-minute boundary',()=>{
 const a=auction(5);
 const first=auctionPollPlan(data(a),now,now,now-60_000,checked(a));assert.deepEqual(first.ids,['a']);assert.equal(first.delay,0);
 const next=auctionPollPlan(data(a),now,now,now,checked(a));assert.equal(next.delay,60_000);
});
test('only ending auctions the account can bid on are selected',()=>{
 const a=auction(3);const others=[auction(3,{id:'wrong-role',requiredRoles:['Ranger']}),auction(30,{id:'later'}),auction(3,{id:'closed',biddingClosed:true})];
 const result=auctionPollPlan({...data(a),auctions:[a,...others]},now,now,0,checked(a));assert.deepEqual(result.ids,['a']);
});
test('stale insufficient funds trigger one eligibility refresh, not permanent exclusion',()=>{
 const a=auction(4);const state=data(a,[{...toon,available:0}]);
 assert.equal(auctionPollPlan(state,now,now,0).eligibilityWindows.length,1);
 const result=auctionPollPlan(state,now,now,0,checked(a));assert.deepEqual(result.ids,[]);assert.equal(result.delay,AUCTION_DISCOVERY_MS);
});
test('funds held on other auctions prevent rapid polling, while an existing lead remains watched',()=>{
 const a=auction(3,{highBid:{isMine:false,rowIndex:4,amount:10}});
 assert.deepEqual(auctionPollPlan(data(a,[{...toon,heldPoints:100}]),now,now,0,checked(a)).ids,[]);
 const lead={...a,highBid:{isMine:true,rowIndex:3,amount:100}};
 assert.deepEqual(auctionPollPlan(data(lead,[{...toon,heldPoints:100}]),now,now,0,checked(lead)).ids,['a']);
});
test('anti-snipe extensions reschedule the boundary using the updated end time',()=>{
 const a=auction(12);const result=auctionPollPlan(data(a),now,now,0,checked(a));assert.deepEqual(result.ids,[]);assert.equal(result.delay,7*60_000);
});
test('known scheduled role changes are applied when deciding which auction to watch',()=>{
 const a=auction(3,{requiredRoles:['Ranger']});const changed={...toon,roleChange:{scheduledRole:'Ranger',effectiveAt:new Date(now-1).toISOString()}};
 assert.deepEqual(auctionPollPlan(data(a,[changed]),now,now,0,checked(a)).ids,['a']);
});
test('settlement receives a bounded final follow-up; expired records do not poll forever',()=>{
 const a=auction(-1,{highBid:{isMine:true,rowIndex:3,amount:10},status:'settling'});
 assert.deepEqual(auctionPollPlan(data(a),now,now,0,checked(a)).ids,['a']);
 const old=auction(-6,{...a,endsAt:new Date(now-6*60_000).toISOString()});
 assert.deepEqual(auctionPollPlan(data(old),now,now,0,checked(old)).ids,[]);
});
test('new-auction discovery is hourly and is independent of displayed eligibility',()=>{
 const result=auctionPollPlan({auctions:[],toons:[],canBidWeekly:false},now,now-AUCTION_DISCOVERY_MS,0);
 assert.equal(result.discover,true);assert.equal(result.delay,0);
});
