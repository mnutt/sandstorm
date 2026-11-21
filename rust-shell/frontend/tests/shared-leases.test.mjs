import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSharedLeases } from '../../../shell/imports/server/rust-shell-shared-leases.mjs';

function fixture(overrides={}) {
  let now=1000, revoked=false, loggedIn=true, guestsAllowed=true, serial=0;
  const live=new Set(), opened=[];
  const leases=createSharedLeases({now:()=>now,
    inspect:async webkey=>{
      if(webkey!=='valid' || revoked) throw Object.assign(new Error('Revoked'),{status:403});
      return {title:'Shared',guestsAllowed};
    },
    account:async token=>{
      if(token!=='login' || !loggedIn) throw Object.assign(new Error('Signed out'),{status:401});
      return {id:'alice',name:'Alice'};
    },
    open:async (webkey,accountId)=>{opened.push({webkey,accountId}); const handle=++serial;live.add(handle);return {handle,view:{title:'Shared'}};},
    keep:async handle=>{assert.ok(live.has(handle));}, close:async handle=>{live.delete(handle);},...overrides});
  return {leases,live,opened,request:{scope:'a'.repeat(64),webkey:'valid',revealIdentity:false,accountToken:'login'},
    signal:new AbortController().signal,revoke:()=>{revoked=true;},logout:()=>{loggedIn=false;},expire:()=>{now+=46000;},blockGuests:()=>{guestsAllowed=false;}};
}

test('shared views require explicit identity consent and never substitute account access for webkey access',async()=>{
  const f=fixture();
  assert.equal((await f.leases.inspect({webkey:'valid'})).signedIn,false);
  assert.equal((await f.leases.inspect(f.request)).signedIn,true);
  await f.leases.open(f.request,f.signal);
  assert.deepEqual(f.opened,[{webkey:'valid',accountId:null}]);
  await f.leases.close(f.request);
  await f.leases.open({...f.request,revealIdentity:true},f.signal);
  assert.deepEqual(f.opened.at(-1),{webkey:'valid',accountId:'alice'});
  await f.leases.close(f.request);
  await assert.rejects(f.leases.open({...f.request,webkey:'invalid',revealIdentity:true},f.signal),{status:403});
  await assert.rejects(f.leases.open({...f.request,accountToken:undefined,revealIdentity:true},f.signal),{status:401});
  assert.equal(f.live.size,0);
});

test('shared lease expiry, revocation, guest policy, and revealed-login revocation close sessions',async()=>{
  for(const mode of ['expire','revoke','logout','blockGuests']) {
    const f=fixture();
    await f.leases.open({...f.request,revealIdentity:mode==='logout'},f.signal);
    f[mode](); await f.leases.sweep();
    assert.equal(f.live.size,0,mode);
    await assert.rejects(f.leases.keep(f.request),{status:410});
  }
  const f=fixture(); f.blockGuests();
  await assert.rejects(f.leases.open(f.request,f.signal),{status:403});
  await f.leases.open({...f.request,revealIdentity:true},f.signal);
  assert.equal(f.live.size,1);
});

test('closing or revoking a pending shared open destroys its late session',async()=>{
  for(const mode of ['close','revoke','abort']) {
    let resolve; const closed=[];
    const f=fixture({open:()=>new Promise(done=>{resolve=done;}),close:async handle=>{closed.push(handle);}});
    const controller=new AbortController();
    const opening=f.leases.open(f.request,controller.signal);
    while(!resolve) await new Promise(done=>setImmediate(done));
    if(mode==='close') await f.leases.close(f.request);
    if(mode==='revoke') f.revoke();
    if(mode==='abort') controller.abort();
    resolve({handle:'late',view:{title:'Shared'}});
    await assert.rejects(opening);
    assert.deepEqual(closed,['late']);
  }
});

test('more than 32 shared scopes can open and close cannot target a different scope',async()=>{
  const f=fixture();
  for(let i=0;i<40;i++) await f.leases.open({...f.request,scope:i.toString(16).padStart(64,'0')},f.signal);
  await f.leases.close(f.request); assert.equal(f.live.size,40);
  f.expire(); await f.leases.sweep(); assert.equal(f.live.size,0);
});
