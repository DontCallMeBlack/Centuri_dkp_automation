import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const fixture=globalThis.__manualRefreshTest={};
const hooks=registerHooks({resolve(specifier,context,next){
 if(specifier==='react')return {url:'data:text/javascript,'+encodeURIComponent('export function useRef(value){return {current:value}};export function useEffect(effect){globalThis.__manualRefreshTest.effect=effect}'),shortCircuit:true};
 return next(specifier,context);
}});
const {useManualRefresh}=await import('../lib/client/useManualRefresh.ts');hooks.deregister();
const originalWindow=globalThis.window;
afterEach(()=>{fixture.cleanup?.();fixture.cleanup=null;globalThis.window=originalWindow;});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('ordinary data loads once and remains stable across focus and visibility changes',async()=>{
 globalThis.window=new EventTarget();const calls=[];
 useManualRefresh(async force=>{calls.push(force)});fixture.cleanup=fixture.effect();await flush();
 window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('online'));await flush();
 assert.deepEqual(calls,[false]);
 window.dispatchEvent(new Event('centuri:dkp-changed'));await flush();assert.deepEqual(calls,[false,true]);
 fixture.cleanup();fixture.cleanup=null;window.dispatchEvent(new Event('centuri:dkp-changed'));await flush();assert.equal(calls.length,2);
});
test('inactive views fetch nothing; a local mutation during a pending load is replayed once',async()=>{
 globalThis.window=new EventTarget();let calls=[];
 useManualRefresh(async force=>calls.push(force),false);fixture.cleanup=fixture.effect();await flush();assert.deepEqual(calls,[]);
 let complete;
 useManualRefresh(force=>{calls.push(force);return force?Promise.resolve():new Promise(resolve=>complete=resolve)});
 fixture.cleanup=fixture.effect();window.dispatchEvent(new Event('centuri:dkp-changed'));window.dispatchEvent(new Event('centuri:catalog-changed'));
 assert.deepEqual(calls,[false]);complete();await flush();assert.deepEqual(calls,[false,true]);
});
