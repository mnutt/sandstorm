import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRustShellBridge } from '../../../shell/imports/server/rust-shell-bridge-core.mjs';

test('bridge authority: one-use handoff, account scoping, expiry and logout', async () => {
  let now = 1000;
  const accounts = new Map([['alice', { hash: 'alice-hash', name: 'Alice', expires: 99999999 }],
    ['bob', { hash: 'bob-hash', name: 'Bob', expires: 99999999 }]]);
  const rows = [{ key: 'a', user: 'alice', unread: true }, { key: 'b', user: 'bob', unread: true }];
  const bridge = createRustShellBridge({ now: () => now,
    authorize: async (id, hash) => { const user = accounts.get(id); return user?.hash === hash ? user : null; },
    snapshot: async (user) => ({ entries: rows.filter((row) => row.user === user) }),
    dismiss: async (user, id) => {
      const index = rows.findIndex((row) => row.key === id && row.user === user);
      if (index < 0) throw Object.assign(new Error('Not yours'), { status: 403 });
      rows.splice(index, 1);
    },
    markRead: async (user, key) => { rows.filter((row) => row.user === user && (key === undefined || row.key === key)).forEach((row) => { row.unread = false; }); },
  });
  const state = 'a'.repeat(64);
  const signIn = async (id = 'alice', previous) => {
    const code = await bridge.issue(id, accounts.get(id).hash, state);
    return bridge.handle('exchange', { code, state, previous });
  };
  await assert.rejects(bridge.issue('alice', 'forged', state), { status: 401 });
  await assert.rejects(bridge.issue(null, null, state), { status: 401 });
  let code = await bridge.issue('alice', 'alice-hash', state);
  await assert.rejects(bridge.handle('exchange', { code, state: 'b'.repeat(64) }), { status: 401 });
  await assert.rejects(bridge.handle('exchange', { code, state }), { status: 401 });
  code = await bridge.issue('alice', 'alice-hash', state);
  const exchanges = await Promise.allSettled([bridge.handle('exchange', { code, state }), bridge.handle('exchange', { code, state })]);
  assert.equal(exchanges.filter((result) => result.status === 'fulfilled').length, 1);
  const { token } = await signIn();
  assert.deepEqual((await bridge.handle('snapshot', { token, accountId: 'bob' })).entries.map((row) => row.key), ['a']);
  await assert.rejects(bridge.handle('dismiss', { token, id: 'b' }), { status: 403 });
  await bridge.handle('read', { token, key:'b' });
  assert.equal(rows[1].unread,true);
  await assert.rejects(bridge.handle('read',{token,key:{$ne:null}}),{status:400});
  await assert.rejects(bridge.handle('read',{token,key:''}),{status:400});
  await bridge.handle('read',{token,key:'a'});
  assert.equal(rows[0].unread,false); assert.equal(rows[1].unread,true);
  await bridge.handle('read', { token });
  assert.equal(rows[0].unread, false); assert.equal(rows[1].unread, true);
  rows.push({ key: 'legacy-write', user: 'alice', unread: true });
  assert.equal((await bridge.handle('snapshot', { token })).entries.length, 2);
  await bridge.handle('dismiss', { token, id: 'a' });
  assert.equal(rows.some((row) => row.key === 'a'), false);
  const switched = await signIn('bob', token);
  await assert.rejects(bridge.handle('snapshot', { token }), { status: 401 });
  assert.equal((await bridge.handle('snapshot', { token: switched.token })).entries[0].key, 'b');
  await bridge.handle('logout', { token: switched.token });
  await assert.rejects(bridge.handle('dismiss', { token: switched.token, id: 'b' }), { status: 401 });
  const revoked = await signIn();
  accounts.get('alice').hash = 'new-login';
  await assert.rejects(bridge.handle('snapshot', { token: revoked.token }), { status: 401 });
  const expired = await signIn();
  now += 12 * 60 * 60 * 1000;
  await assert.rejects(bridge.handle('session', { token: expired.token }), { status: 401 });
});

test('bridge does not send a projection if the session is revoked during its read', async () => {
  let release;
  const bridge = createRustShellBridge({
    authorize: async () => ({ name: 'Alice', expires: Date.now() + 1000000 }),
    snapshot: () => new Promise((resolve) => { release = resolve; }),
    dismiss: async () => {}, markRead: async () => {},
  });
  const state = 'f'.repeat(64);
  const code = await bridge.issue('alice', 'hash', state);
  const { token } = await bridge.handle('exchange', { code, state });
  const pending = bridge.handle('snapshot', { token });
  while (!release) await new Promise((resolve) => setTimeout(resolve, 0));
  await bridge.handle('logout', { token });
  release({ entries: ['must not escape'] });
  await assert.rejects(pending, { status: 401 });
});

async function watchFixture(overrides = {}) {
  let reads = 0;
  let active = 0;
  let changed;
  let value = 0;
  const bridge = createRustShellBridge({
    authorize: async () => ({ name: 'Alice', expires: Date.now() + 1000000 }),
    snapshot: async () => { ++reads; return { entries: [{ value }], total: 1 }; },
    observe: async (_id, notify) => { ++active; changed = notify; return () => { --active; }; },
    dismiss: async () => {}, markRead: async () => {}, ...overrides,
  });
  const state = 'f'.repeat(64);
  const code = await bridge.issue('alice', 'hash', state);
  const { token } = await bridge.handle('exchange', { code, state });
  const initial = await bridge.handle('snapshot', { token });
  return { bridge, token, initial, get reads() { return reads; }, get active() { return active; },
    change: () => { ++value; changed?.(); } };
}
const until = async (predicate) => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test('list queries are independent, account-scoped, and reject arbitrary Mongo selectors', async () => {
  const observed = [];
  const f = await watchFixture({
    snapshot: async (account, pages, query) => ({account, pages, query}),
    observe: async (account, _changed, pages, query) => {
      observed.push({account, pages, query});
      return () => {};
    },
  });
  const query = {search:'[draft].*',appId:'app-a',sort:'title',ownership:'owned'};
  const [grains, notifications] = await Promise.all([
    f.bridge.handle('watch', {token:f.token,after:'0'.repeat(64),pages:{grains:2},query,accountId:'bob'}),
    f.bridge.handle('watch', {token:f.token,after:'0'.repeat(64),pages:{notifications:1}}),
  ]);
  assert.equal(grains.account, 'alice');
  assert.deepEqual(grains.query, query);
  assert.deepEqual(notifications.pages, {notifications:1});
  assert.equal(notifications.query, undefined);
  assert.equal(observed.length, 2);
  for (const invalid of [{...query,search:{$ne:null}}, {...query,$where:'true'}, {...query,sort:'arbitrary'}]) {
    await assert.rejects(f.bridge.handle('snapshot', {token:f.token,query:invalid}), {status:400});
  }
});

test('watch wakes on legacy writes, coalesces bursts, avoids idle snapshot reads, and cleans up', async () => {
  const f = await watchFixture();
  const pending = f.bridge.handle('watch', { token: f.token, after: f.initial.version });
  await until(() => f.reads === 2);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(f.reads, 2, 'idle authorization checks must not rebuild projections');
  for (let i = 0; i < 100; ++i) f.change();
  const next = await pending;
  assert.equal(next.entries[0].value, 100);
  assert.equal(f.active, 0);
  const controller = new AbortController();
  const canceled = f.bridge.handle('watch', { token: f.token, after: next.version }, controller.signal);
  const rejected = assert.rejects(canceled, /disconnected/);
  await until(() => f.active === 1);
  controller.abort();
  await rejected;
  assert.equal(f.active, 0);
});

test('watch catches writes between requests and during a pending snapshot', async () => {
  let release, changed;
  let value = 0;
  let block = false;
  const f = await watchFixture({
    observe: async (_id, notify) => { changed = notify; return () => {}; },
    snapshot: async () => {
      const result = { entries: [{ value }], total: 1 };
      if (block) await new Promise((resolve) => { release = resolve; });
      return result;
    },
  });
  block = true;
  const pending = f.bridge.handle('watch', { token: f.token, after: f.initial.version });
  await until(() => release);
  ++value; changed(); block = false; release();
  assert.equal((await pending).entries[0].value, 1);
  ++value; // No live observer here: the next watch must still detect it.
  const next = await f.bridge.handle('watch', { token: f.token, after: f.initial.version });
  assert.equal(next.entries[0].value, 2);
});

test('idle watch enforces revocation and releases its observers', async () => {
  const f = await watchFixture();
  const pending = f.bridge.handle('watch', { token: f.token, after: f.initial.version });
  const rejected = assert.rejects(pending, { status: 401 });
  await until(() => f.active === 1);
  await f.bridge.handle('logout', { token: f.token });
  await rejected;
  assert.equal(f.active, 0);
});

test('more than 32 watches are admitted and cancellation releases observers', async () => {
  const f = await watchFixture();
  const controller = new AbortController();
  const pending = Array.from({ length: 40 }, () => assert.rejects(
    f.bridge.handle('watch', { token: f.token, after: f.initial.version }, controller.signal), /disconnected/));
  await until(() => f.active === 40);
  controller.abort();
  await Promise.all(pending);
  assert.equal(f.active, 0);
  f.change();
  assert.equal((await f.bridge.handle('watch', { token: f.token, after: f.initial.version })).entries[0].value, 1);
});

test('an idle watch returns its unchanged snapshot at the heartbeat deadline', { timeout: 25000 }, async () => {
  const f = await watchFixture();
  const result = await f.bridge.handle('watch', { token: f.token, after: f.initial.version });
  assert.equal(result.version, f.initial.version);
  assert.equal(f.reads, 2);
  assert.equal(f.active, 0);
});

test('durable linked sessions survive restart without persisting grants or raw tokens', async () => {
  const { memorySessionStore } = await import('../../../shell/imports/server/rust-shell-session-store.mjs');
  const store = memorySessionStore();
  let time = 1000;
  let authorized = true;
  let unavailable = false;
  const options = { sessionStore: store, now: () => time,
    authorize: async () => {
      if (unavailable) throw Object.assign(new Error('Database unavailable'), { status: 503 });
      return authorized ? { name: 'Alice', expires: 999999999 } : null;
    }, snapshot: async () => ({ entries: [], total: 0 }) };
  let bridge = createRustShellBridge(options);
  const state = 'e'.repeat(64);
  const signIn = async previous => bridge.handle('exchange', {
    code: await bridge.issue('alice', 'source-login-hash', state), state, previous,
  });
  const linked = await signIn();
  const grant = await bridge.issue('alice', 'source-login-hash', state);
  const { createHash } = await import('node:crypto');
  const key = createHash('sha256').update(linked.token).digest('hex');
  assert.equal(await store.get(linked.token), undefined);
  assert.deepEqual(await store.get(key), { accountId: 'alice', loginHash: 'source-login-hash', expires: linked.expires });
  bridge = createRustShellBridge(options);
  await assert.rejects(bridge.handle('exchange', { code: grant, state }), { status: 401 });
  assert.equal((await bridge.handle('session', { token: linked.token })).expires, linked.expires);
  unavailable = true;
  await assert.rejects(bridge.handle('session', { token: linked.token }), { status: 503 });
  assert.ok(await store.get(key), 'outage must not erase the link');
  unavailable = false;
  const replacement = await signIn(linked.token);
  bridge = createRustShellBridge(options);
  await assert.rejects(bridge.handle('session', { token: linked.token }), { status: 401 });
  await bridge.handle('logout', { token: replacement.token });
  bridge = createRustShellBridge(options);
  await assert.rejects(bridge.handle('session', { token: replacement.token }), { status: 401 });
  const revoked = await signIn();
  authorized = false;
  bridge = createRustShellBridge(options);
  await assert.rejects(bridge.handle('session', { token: revoked.token }), { status: 401 });
  authorized = true;
  const expired = await signIn();
  time = expired.expires;
  bridge = createRustShellBridge(options);
  await assert.rejects(bridge.handle('session', { token: expired.token }), { status: 401 });
  await bridge.pruneSessions();
  assert.equal(await store.count(), 0);
});

test('concurrent exchanges can exceed 1024 persisted sessions', async () => {
  const { memorySessionStore } = await import('../../../shell/imports/server/rust-shell-session-store.mjs');
  const store = memorySessionStore();
  for (let i = 0; i < 1023; ++i) await store.put(String(i), { expires: Date.now() + 60000 });
  const bridge = createRustShellBridge({ sessionStore: store,
    authorize: async () => ({ name: 'Alice', expires: Date.now() + 60000 }) });
  const state = 'd'.repeat(64);
  const codes = await Promise.all([bridge.issue('alice', 'hash', state), bridge.issue('alice', 'hash', state)]);
  const results = await Promise.allSettled(codes.map(code => bridge.handle('exchange', { code, state })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 2);
  assert.equal(await store.count(), 1025);
});

test('grain creation is account-scoped, bounded and revalidates before committing', async () => {
  let release, entered, commits = 0;
  const bridge = createRustShellBridge({
    authorize: async id => ({name:id, expires:Date.now()+1000000}),
    listApps: async id => ({actions:[{key:id+'-action'}],limited:false}),
    createGrain: async (id, action, title, beforeCreate) => {
      assert.equal(action, id+'-action');
      assert.equal(title, 'New grain');
      await new Promise(resolve => { release = resolve; entered?.(); });
      await beforeCreate();
      ++commits;
      return 'created-grain';
    },
  });
  const signIn = async id => {
    const state = 'a'.repeat(64);
    const code = await bridge.issue(id, 'hash', state);
    return (await bridge.handle('exchange',{state,code})).token;
  };
  const token = await signIn('alice');
  const bob = await signIn('bob');
  assert.equal((await bridge.handle('listApps',{token,accountId:'bob'})).actions[0].key,'alice-action');
  assert.equal((await bridge.handle('listApps',{token:bob})).actions[0].key,'bob-action');
  const input = {token,actionId:'alice-action',title:' New grain '};
  await assert.rejects(bridge.handle('createGrain',{...input,title:' '}),{status:400});
  const ready = new Promise(resolve => { entered = resolve; });
  const abort = new AbortController();
  const pending = bridge.handle('createGrain',input,abort.signal);
  const rejected = assert.rejects(pending,{status:409});
  await ready;
  await assert.rejects(bridge.handle('createGrain',input),{status:409});
  abort.abort(); release(); await rejected;
  assert.equal(commits,0);
  const ready2 = new Promise(resolve => { entered = resolve; });
  const revoked = bridge.handle('createGrain',input);
  const revocation = assert.rejects(revoked,{status:401});
  await ready2;
  await bridge.handle('logout',{token}); release(); await revocation;
  assert.equal(commits,0);
  const fresh = await signIn('alice');
  const ready3 = new Promise(resolve => { entered = resolve; });
  const success = bridge.handle('createGrain',{...input,token:fresh});
  await ready3; release();
  assert.equal((await success).grainId,'created-grain');
  assert.equal(commits,1);
});

test('profile operations use linked identity, validate input, and recheck authority before writes and reads', async () => {
  let authorized = true;
  let writes = 0;
  let blockWrite, blockRead;
  const profile = {name:'Alice',handle:'alice',pronoun:'neutral',mainHref:'https://main.test/account'};
  const bridge = createRustShellBridge({
    authorize: async () => authorized ? {name:'Alice',expires:Date.now()+60000} : null,
    getProfile: async id => { assert.equal(id,'alice'); if (blockRead) await blockRead; return profile; },
    updateProfile: async (id, value, beforeWrite) => {
      assert.equal(id,'alice');
      if (blockWrite) await blockWrite;
      await beforeWrite();
      ++writes;
      Object.assign(profile,value);
    },
  });
  const state = 'a'.repeat(64);
  const code = await bridge.issue('alice','login',state);
  const {token} = await bridge.handle('exchange',{code,state});
  const input = {token,accountId:'bob',profile:{name:'Updated',handle:'alice',pronoun:'neutral'}};
  assert.equal((await bridge.handle('updateProfile',input)).name,'Updated');
  for (const patch of [{handle:'INVALID'},{pronoun:'invalid'},{isAdmin:true}]) {
    await assert.rejects(bridge.handle('updateProfile',{...input,profile:{...input.profile,...patch}}),{status:400});
  }
  let release;
  blockWrite = new Promise(resolve => {release=resolve;});
  const controller = new AbortController();
  const pending = bridge.handle('updateProfile',input,controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(bridge.handle('updateProfile',input),{status:409});
  controller.abort();
  release();
  await assert.rejects(pending,{status:409});
  assert.equal(writes,1);
  blockRead = new Promise(resolve => {release=resolve;});
  const reading = bridge.handle('getProfile',{token});
  await new Promise(resolve => setImmediate(resolve));
  authorized = false;
  release();
  await assert.rejects(reading,{status:401});
});

test('installation binds account, validates operations and fences writes after revocation', async () => {
  let release, entered;
  let calls = 0, writes = 0;
  const bridge = createRustShellBridge({
    authorize: async () => ({name:'Alice',expires:Date.now()+100000}),
    install: async (account, operation, data, beforeWrite) => {
      ++calls; assert.equal(account,'alice');
      if (operation === 'confirm') {
        entered?.(); await new Promise(resolve => { release = resolve; });
        await beforeWrite(); ++writes;
      }
      return {status:'ready'};
    },
  });
  const nonce = 'a'.repeat(64);
  const code = await bridge.issue('alice','hash',nonce);
  const {token} = await bridge.handle('exchange',{code,state:nonce});
  const call = (operation, data = {}) => bridge.handle('install',{token,accountId:'bob',operation,data});
  assert.deepEqual(await call('status',{packageId:'a'.repeat(32)}),{status:'ready'});
  for (const [operation,data] of [['unknown',{}],['confirm',{accountId:'bob'}],['upload',null]]) {
    await assert.rejects(call(operation,data),{status:400});
  }
  assert.equal(calls,1);
  const started = new Promise(resolve => { entered = resolve; });
  const pending = call('confirm',{packageId:'a'.repeat(32)});
  await started;
  await assert.rejects(call('upload'),{status:409});
  await bridge.handle('logout',{token});
  release();
  await assert.rejects(pending,{status:401});
  assert.equal(writes,0);
  await assert.rejects(call('status'),{status:401});
});

test('notification operations validate inputs and recheck authority before writes', async () => {
  let valid = true;
  let revokeOnWrite = false;
  let writes = 0;
  const bridge = createRustShellBridge({
    authorize: async () => valid ? {name:'Alice',expires:Date.now()+1000000} : null,
    notification: async (account,key,operation,enabled,beforeWrite) => {
      assert.equal(account,'alice');
      assert.equal(key,'notice');
      if (operation === 'setStats') {
        if (revokeOnWrite) valid=false;
        await beforeWrite(); ++writes;
      }
      return {kind:'stats',enabled};
    },
  });
  const state='a'.repeat(64);
  const code=await bridge.issue('alice','login',state);
  const {token}=await bridge.handle('exchange',{code,state});
  const call = input => bridge.handle('notification',{token,key:'notice',operation:'details',...input});
  for (const input of [{key:''},{key:{$ne:null}},{operation:'setSetting'},{operation:'setStats',enabled:'true'}]) {
    await assert.rejects(call(input),{status:400});
  }
  assert.equal((await call({accountId:'bob'})).kind,'stats');
  await call({operation:'setStats',enabled:false});
  assert.equal(writes,1);
  revokeOnWrite=true;
  await assert.rejects(call({operation:'setStats',enabled:true}),{status:401});
  assert.equal(writes,1);
});

test('picture upload issuance is scoped to the linked account and rechecks revoked authority', async () => {
  let authorized=true, revoke=false, issued=0;
  const bridge=createRustShellBridge({authorize:async()=>authorized?{name:'Alice',expires:Date.now()+1000000}:null,
    uploadPicture:async(accountId,beforeWrite)=>{
      assert.equal(accountId,'alice');
      if (revoke) authorized=false;
      await beforeWrite(); ++issued; return {uploadUrl:'https://static.example/token'};
    }});
  const state='a'.repeat(64),code=await bridge.issue('alice','login',state);
  const {token}=await bridge.handle('exchange',{code,state});
  assert.equal((await bridge.handle('uploadPicture',{token,accountId:'bob'})).uploadUrl,'https://static.example/token');
  revoke=true;
  await assert.rejects(bridge.handle('uploadPicture',{token}),{status:401});
  assert.equal(issued,1);
});

test('account settings bind identity, validate fields, serialize writes, and recheck revocation', async () => {
  let authorized = true, writes = 0, release, entered;
  let gate;
  const bridge = createRustShellBridge({
    authorize: async () => authorized ? {name:'Alice',expires:Date.now()+60000} : null,
    accountSettings: async (id, operation, data, beforeWrite) => {
      assert.equal(id,'alice');
      if (gate) { entered(); await gate; }
      await beforeWrite();
      if (operation !== 'state') ++writes;
      return {emails:[],credentials:[],emailEnabled:true};
    },
  });
  const state = 'a'.repeat(64);
  const code = await bridge.issue('alice','login',state);
  const {token} = await bridge.handle('exchange',{code,state});
  const call = (operation, data = {}) => bridge.handle('accountSettings',{token,accountId:'bob',operation,data});
  await call('state');
  for (const [operation,data] of [['constructor',{}],['state',{id:'foreign'}],['primary',{email:42}],['unlink',{id:'x',accountId:'bob'}],['verifyEmail',{email:'a@b',code:'code',allowLogin:'yes'}]]) {
    await assert.rejects(call(operation,data),{status:400});
  }
  await call('primary',{email:'a@b'});
  const waiting = new Promise(resolve => { entered=resolve; });
  gate = new Promise(resolve => { release=resolve; });
  const pending = call('unlink',{id:'credential'});
  await waiting;
  await assert.rejects(call('unlink',{id:'credential'}),{status:409});
  authorized = false; release();
  await assert.rejects(pending,{status:401});
  assert.equal(writes,1);
});

test('private bridge accepts request and response bodies above the prototype ceilings', async () => {
  const { bridgeHandler } = await import('../../../shell/imports/server/rust-shell-bridge-core.mjs');
  const { Readable } = await import('node:stream');
  const { EventEmitter } = await import('node:events');
  const input = { value: 'x'.repeat(300000) };
  const output = { value: 'y'.repeat(500000) };
  const request = Readable.from([Buffer.from(JSON.stringify(input))]);
  request.method = 'POST';
  request.url = '/accountSettings';
  const response = new EventEmitter();
  response.setHeader = () => {};
  let result;
  response.end = body => { result = JSON.parse(body); };
  await bridgeHandler({handle: async (action, data) => {
    assert.equal(action, 'accountSettings');
    assert.deepEqual(data, input);
    return output;
  }})(request, response);
  assert.deepEqual(result, output);
});

test('revocation after a completed write hides its result without claiming rejection', async () => {
  const operations = [
    ['createGrain',{actionId:'action',title:'New grain'}],
    ['updateProfile',{profile:{name:'Alice',handle:'alice',pronoun:'neutral'}}],
    ['accountSettings',{operation:'primary',data:{email:'alice@example.test'}}],
    ['install',{operation:'confirm',data:{packageId:'a'.repeat(32)}}],
    ['notification',{operation:'setStats',key:'stats',enabled:true}],
    ['uploadPicture',{}],
  ];
  for (const [action,input] of operations) {
    let authorized=true,writes=0;
    const commit=async (...args)=>{await args.at(-1)();++writes;authorized=false;return {};};
    const bridge=createRustShellBridge({
      authorize:async()=>authorized?{name:'Alice',expires:Date.now()+60000}:null,
      createGrain:commit,updateProfile:commit,accountSettings:commit,install:commit,
      notification:commit,uploadPicture:commit,getProfile:async()=>({name:'Alice',handle:'alice',pronoun:'neutral'}),
    });
    const state='b'.repeat(64), code=await bridge.issue('alice','hash',state);
    const {token}=await bridge.handle('exchange',{state,code});
    await assert.rejects(bridge.handle(action,{token,...input}),{status:500},action);
    assert.equal(writes,1,action+' must not replay or undo a committed write');
  }
});

test('logout revokes locally before provider work and never uses caller-supplied account authority', async () => {
  let token, mode='redirect', calls=0;
  const bridge=createRustShellBridge({
    authorize:async()=>({name:'Alice',expires:Date.now()+60000}),
    logoutDestination:async accountId=>{
      ++calls;
      assert.equal(accountId,'alice');
      await assert.rejects(bridge.handle('session',{token}),{status:401});
      if(mode==='failure') throw new Error('private provider detail');
      return 'https://idp.example/logout';
    },
  });
  const login=async()=>{
    const state='b'.repeat(64), code=await bridge.issue('alice','hash',state);
    token=(await bridge.handle('exchange',{code,state})).token;
  };
  await login();
  assert.deepEqual(await bridge.handle('logout',{token,accountId:'bob'}),{redirectUrl:'https://idp.example/logout'});
  assert.deepEqual(await bridge.handle('logout',{token}),{});
  assert.equal(calls,1);
  mode='failure';await login();
  const result=await bridge.handle('logout',{token});
  assert.match(result.warning,/Signed out/);
  assert.ok(!JSON.stringify(result).includes('private provider detail'));
  await assert.rejects(bridge.handle('session',{token}),{status:401});
});

test('native login transfers its account token only after successful session creation', async () => {
  for(const failure of ['none','authorize','aborted']) {
    let committed=false,disposed=false;
    const controller=new AbortController();
    const bridge=createRustShellBridge({
      authorize:async()=>failure==='authorize'?null:{name:'Alice',expires:Date.now()+60000},
      nativeAuth:async()=>{
        if(failure==='aborted') controller.abort();
        return {accountId:'alice',loginHash:'hash',commit(){committed=true;},dispose(){disposed=true;}};
      },
    });
    const pending=bridge.handle('nativeAuth',{operation:'dev',data:{name:'Alice'},flow:'a'.repeat(64)},controller.signal);
    if(failure==='none') assert.ok((await pending).token);
    else await assert.rejects(pending);
    assert.equal(committed,failure==='none');assert.equal(disposed,true);
  }
});


test('grain management binds the account and rechecks cancellation before writing', async () => {
  let allowed=true;const writes=[];
  const bridge=createRustShellBridge({authorize:async()=>allowed?{name:'Alice',expires:Date.now()+60000}:null,
    manageGrain:async(account,id,operation,beforeWrite)=>{await beforeWrite();writes.push([account,id,operation]);return {};}});
  const state='a'.repeat(64),code=await bridge.issue('alice','hash',state);
  const {token}=await bridge.handle('exchange',{code,state});
  await bridge.handle('manageGrain',{token,grainId:'grain',operation:'trash',accountId:'bob'});
  assert.deepEqual(writes,[['alice','grain','trash']]);
  const controller=new AbortController();controller.abort();
  await assert.rejects(bridge.handle('manageGrain',{token,grainId:'grain',operation:'remove'},controller.signal),{status:409});
  allowed=false;
  await assert.rejects(bridge.handle('manageGrain',{token,grainId:'grain',operation:'restore'}),{status:401});
  assert.equal(writes.length,1);
});

test('a restart completed during login revocation is reported as uncertain and is not replayed', async () => {
  let allowed = true;
  let restarts = 0;
  const bridge = createRustShellBridge({
    authorize: async () => allowed ? {name:'Alice',expires:Date.now()+60000} : null,
    manageGrain: async (account, id, operation, beforeWrite) => {
      assert.deepEqual([account,id,operation], ['alice','grain','restart']);
      await beforeWrite();
      restarts++;
      allowed = false;
      return {};
    },
  });
  const state = 'b'.repeat(64), code = await bridge.issue('alice','hash',state);
  const {token} = await bridge.handle('exchange',{code,state});
  await assert.rejects(bridge.handle('manageGrain',{token,grainId:'grain',operation:'restart'}), {status:500});
  assert.equal(restarts,1);
});
