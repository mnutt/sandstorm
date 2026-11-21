import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AuthorizationAttempts} from '../../../shell/imports/server/rust-shell-auth-attempts.mjs';
import {loginExchange} from '../../../shell/imports/server/rust-shell-login-exchange.mjs';

const deferred = () => {let resolve; const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const turn = () => new Promise(resolve=>setImmediate(resolve));

test('authorization attempts expire actively and consumption transfers ownership exactly once', async () => {
  let now=0, timerId=0;
  const timers=new Map(), discarded=[], removed=[];
  const store=new AuthorizationAttempts({
    now:()=>now,lifetime:100,
    schedule:fn=>{timers.set(++timerId,fn);return timerId;},unschedule:id=>timers.delete(id),
    onRemove:(key)=>removed.push(key),onDiscard:async(key)=>discarded.push(key),
  });
  store.set('expired',{binding:'alice'}); now=101;
  timers.get(1)(); await turn();
  assert.equal(store.get('expired'),undefined);
  assert.deepEqual(discarded,['expired']);assert.equal(timers.size,0);
  store.set('consumed',{binding:'bob'});
  assert.equal(store.take('consumed').binding,'bob');
  assert.equal(store.take('consumed'),undefined);
  await store.discard('consumed');
  assert.deepEqual(discarded,['expired']);assert.equal(timers.size,0);
  store.set('cancelled',{binding:'alice'});await store.discard('cancelled');
  assert.deepEqual(removed,['expired','consumed','cancelled']);
  assert.deepEqual(discarded,['expired','cancelled']);
});

function fixture(applyAsync) {
  const revoked=[];let closed=false;
  return {
    revoked,get closed(){return closed;},
    options:{open:async()=>({connection:{applyAsync,close(){closed=true;}},ready:Promise.resolve()}),
      revoke:async token=>revoked.push(token.token)},
  };
}
test('a timed-out login receives and revokes late credentials without starting another method', async () => {
  const late=deferred();let calls=0;
  const f=fixture(()=>{++calls;return late.promise;});
  const pending=loginExchange({...f.options,timeout:5},async({call})=>{
    await call('login');await call('must-not-run');
  });
  await assert.rejects(pending,/timed out/);
  assert.equal(f.closed,false,'retain the connection to observe the pending result');
  late.resolve({id:'credential',token:'late'});
  await turn();await turn();
  assert.deepEqual(f.revoked,['late']);assert.equal(calls,1);assert.equal(f.closed,true);
});
test('temporary tokens are revoked and only an explicitly committed account token survives', async () => {
  for (const commit of [false,true]) {
    let count=0;
    const f=fixture(async()=>({id:++count===1?'credential':'account',token:count===1?'temporary':'retained'}));
    const exchange=await loginExchange(f.options,async({call,retain})=>{
      await call('login');
      const token=await call('loginWithCredential');retain(token);
      return {accountId:token.id};
    });
    assert.deepEqual(f.revoked,['temporary']);assert.equal(f.closed,true);
    if(commit) exchange.commit();
    await exchange.dispose();await exchange.dispose();
    assert.deepEqual(f.revoked,commit?['temporary']:['temporary','retained']);
  }
});
test('cancellation during local account lookup prevents linking and cleans up the credential', async () => {
  const lookup=deferred(), controller=new AbortController();
  const f=fixture(async()=>({id:'credential',token:'temporary'}));let linked=false;
  const pending=loginExchange({...f.options,signal:controller.signal},async({call,check})=>{
    await call('login');await lookup.promise;check();linked=true;
  });
  await turn();controller.abort(new Error('gone'));
  await assert.rejects(pending,/gone/);
  lookup.resolve();await turn();await turn();
  assert.equal(linked,false);assert.deepEqual(f.revoked,['temporary']);
});
test('an aborted connection handshake is closed without sending login', async () => {
  const controller=new AbortController(), ready=deferred();let closed=false,calls=0;
  const pending=loginExchange({signal:controller.signal,revoke:async()=>{},
    open:async()=>({ready:ready.promise,connection:{applyAsync(){calls++;},close(){closed=true;}}})},
    async({call})=>call('login'));
  await turn();controller.abort(new Error('gone'));
  await assert.rejects(pending,/gone/);await turn();
  assert.equal(closed,true);assert.equal(calls,0);
});
