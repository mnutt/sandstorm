import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitForGrainResponse } from '../../../shell/imports/server/rust-shell-grain-ready.mjs';
import { createGrainLeases } from '../../../shell/imports/server/rust-shell-grain-leases.mjs';
import { createSharedLeases } from '../../../shell/imports/server/rust-shell-shared-leases.mjs';
const turn = () => new Promise(resolve => setImmediate(resolve));
function database(initial = {hasLoaded:false}, delay = Promise.resolve()) {
  let callbacks, stops=0;
  const db={collections:{sessions:{find(query,options){
    assert.deepEqual(query,{_id:'session',rustShellSession:true});
    assert.deepEqual(options.fields,{hasLoaded:1,denied:1});
    return {async observeChangesAsync(value){callbacks=value;if(initial) value.added('session',initial);await delay;return {stop(){++stops;}};}};
  }}}};
  return {db,get callbacks(){return callbacks;},get stops(){return stops;}};
}
test('gateway readiness observes initial, changed, and error-response states and always stops',async()=>{
  for(const initial of [{hasLoaded:true},{denied:'revoked'},{hasLoaded:false}]){
    const f=database(initial), c=new AbortController();
    const pending=waitForGrainResponse(f.db,{sessionId:'session'},c.signal);
    if(!initial.hasLoaded && !initial.denied){await turn();f.callbacks.changed('session',{hasLoaded:true});}
    assert.deepEqual(await pending,{loaded:true});assert.equal(f.stops,1);
  }
});
test('readiness cleans up on timeout, removal, and abort during asynchronous observer setup',async()=>{
  const timed=database();assert.deepEqual(await waitForGrainResponse(timed.db,{sessionId:'session'},new AbortController().signal,1),{loaded:false});assert.equal(timed.stops,1);
  for(const mode of ['removed','missing','abort']){
    let release;const setup=new Promise(resolve=>{release=resolve;});
    const f=database(mode==='missing'?null:undefined,setup),c=new AbortController();
    const pending=waitForGrainResponse(f.db,{sessionId:'session'},c.signal);
    if(mode==='abort') c.abort();
    if(mode==='removed') f.callbacks.removed('session');
    release();await assert.rejects(pending,{status:410});assert.equal(f.stops,1);
  }
});
test('signed and anonymous readiness waits are lease scoped, revalidated, and aborted on close',async()=>{
  for(const shared of [false,true]){
    let allowed=true, release, observedSignal;
    const check=async()=>{if(!allowed)throw Object.assign(new Error('Revoked'),{status:403});return {guestsAllowed:true};};
    const common={open:async()=>({handle:{sessionId:'session'},view:{}}),close:async()=>{},keep:async()=>{},
      waitForResponse:async(handle,signal)=>{assert.equal(handle.sessionId,'session');observedSignal=signal;return new Promise(resolve=>{release=resolve;signal.addEventListener('abort',()=>resolve({loaded:true}),{once:true});});}};
    const leases=shared?createSharedLeases({...common,inspect:check}):createGrainLeases({...common,validate:check});
    const input={scope:'a'.repeat(64),grainId:'grain',webkey:'valid',revealIdentity:false};
    const signal=new AbortController().signal;
    const opened=shared?await leases.open(input,signal):await leases.open('token','alice',input,signal);
    input.lease=opened.lease;
    const wait=()=>shared?leases.waitForResponse(input,signal):leases.waitForResponse('token',input,signal);
    if(!shared) await assert.rejects(leases.waitForResponse('foreign',input,signal),{status:403});
    const first=wait();await turn();allowed=false;release({loaded:true});await assert.rejects(first,{status:403});
    allowed=true;const pending=wait();await turn();
    if(shared)await leases.close(input);else await leases.close('token',input);
    await assert.rejects(pending,{status:410});assert.equal(observedSignal.aborted,true);
  }
});
