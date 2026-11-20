import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRustShellBridge } from '../../../shell/imports/server/rust-shell-bridge-core.mjs';

async function fixture(overrides = {}) {
  let now = 1000;
  let authorized = true;
  let allowed = true;
  let serial = 0;
  const live = new Set();
  const bridge = createRustShellBridge({ now: () => now,
    authorize: async () => authorized ? { name: 'Alice', expires: 10000000 } : null,
    snapshot: async () => ({ entries: [], total: 0 }), dismiss: async () => {}, markRead: async () => {},
    grains: {
      open: async (_account, grainId) => {
        if (grainId !== 'allowed') throw Object.assign(new Error('Denied'), { status: 403 });
        const handle = ++serial; live.add(handle);
        return { handle, view: { grainId, origin: 'https://grain.test', url: 'https://grain.test/init' } };
      },
      keep: async (handle) => { if (!allowed || !live.has(handle)) throw Object.assign(new Error('Revoked'), { status: 403 }); },
      close: async (handle) => { live.delete(handle); },
      ...overrides,
    },
  });
  const signIn = async (previous) => {
    const state = 'f'.repeat(64);
    const code = await bridge.issue('alice', 'login-hash', state);
    return (await bridge.handle('exchange', { code, state, previous })).token;
  };
  const token = await signIn();
  const call = (action, input = {}, signal) => bridge.handle(action, { token, scope: 'a'.repeat(64), ...input }, signal);
  return { bridge, token, call, live, signIn, expire: () => { now += 46000; }, revokeLogin: () => { authorized = false; }, revokeShare: () => { allowed = false; } };
}

test('grain leases enforce account/scope ownership and close idempotently', async () => {
  const f = await fixture();
  await assert.rejects(f.call('openGrain', { grainId: 'forbidden' }), { status: 403 });
  const view = await f.call('openGrain', { grainId: 'allowed' });
  assert.equal(f.live.size, 1);
  const other = await f.signIn();
  await assert.rejects(f.call('closeGrain', { token: other, lease: view.lease }), { status: 403 });
  await assert.rejects(f.call('openGrain', { grainId: 'allowed' }), { status: 409 });
  await f.call('keepGrain', { lease: view.lease });
  await f.call('closeGrain', { lease: view.lease });
  await f.call('closeGrain', { lease: view.lease });
  assert.equal(f.live.size, 0);
  const next = await f.call('openGrain', { grainId: 'allowed' });
  await assert.rejects(f.call('closeGrain', { lease: view.lease }), { status: 403 });
  await f.call('closeGrain', { lease: next.lease });
});

test('logout, account switch, source-login revocation and crash expiry close UI sessions', async () => {
  for (const mode of ['logout', 'switch', 'login', 'expiry', 'share']) {
    const f = await fixture();
    const view = await f.call('openGrain', { grainId: 'allowed' });
    if (mode === 'logout') await f.call('logout');
    if (mode === 'switch') await f.signIn(f.token);
    if (mode === 'login') { f.revokeLogin(); await f.bridge.sweepGrains(); }
    if (mode === 'expiry') { f.expire(); await f.bridge.sweepGrains(); }
    if (mode === 'share') { f.revokeShare(); await assert.rejects(f.call('keepGrain', { lease: view.lease }), { status: 403 }); }
    assert.equal(f.live.size, 0, mode);
  }
});

test('cancellation and logout during session creation destroy the late session', async () => {
  for (const mode of ['close', 'logout', 'abort']) {
    let release;
    const destroyed = [];
    const f = await fixture({ open: () => new Promise((resolve) => { release = resolve; }), close: async (handle) => destroyed.push(handle) });
    const controller = new AbortController();
    const pending = f.call('openGrain', { grainId: 'allowed' }, controller.signal);
    const rejected = assert.rejects(pending);
    while (!release) await new Promise((resolve) => setTimeout(resolve, 0));
    if (mode === 'close') await f.call('closeGrain');
    if (mode === 'logout') await f.call('logout');
    if (mode === 'abort') controller.abort();
    release({ handle: 'late', view: {} });
    await rejected;
    assert.deepEqual(destroyed, ['late']);
  }
});

test('more than eight grains can open and logout closes all of them', async () => {
  const f = await fixture();
  for (let i = 0; i < 40; ++i) await f.call('openGrain', { grainId: 'allowed', scope: i.toString(16).padStart(64, '0') });
  assert.equal(f.live.size, 40);
  await f.call('logout');
  assert.equal(f.live.size, 0);
});

test('template issuance has no lifetime quota and rolls back a token created after close', async () => {
  let created = 0;
  let revoked = 0;
  let release;
  const f = await fixture({ template: async () => ({ id: ++created, token: 'secret', host: 'api.test' }),
    revokeTemplate: async () => { ++revoked; } });
  const view = await f.call('openGrain', { grainId: 'allowed' });
  await assert.rejects(f.call('renderTemplate', { lease: 'b'.repeat(64), options: {} }), { status: 403 });
  for (let i = 0; i < 40; ++i) assert.equal((await f.call('renderTemplate', { lease: view.lease, options: {} })).token, 'secret');
  assert.equal(created, 40);
  const late = await fixture({ template: () => new Promise(resolve => { release = () => resolve({ id: 9, token: 'late', host: 'api.test' }); }),
    revokeTemplate: async () => { ++revoked; } });
  const opened = await late.call('openGrain', { grainId: 'allowed' });
  const pending = late.call('renderTemplate', { lease: opened.lease, options: {} });
  while (!release) await new Promise(resolve => setTimeout(resolve, 0));
  await late.call('closeGrain', { lease: opened.lease });
  release();
  await assert.rejects(pending, { status: 410 });
  assert.equal(revoked, 1);
});


test('disconnected template requests revoke late tokens', async () => {
  let release;
  let revoked = false;
  const f = await fixture({ template: () => new Promise(resolve => { release = () => resolve({ id: 'late', token: 'secret', host: 'api.test' }); }),
    revokeTemplate: async () => { revoked = true; } });
  const view = await f.call('openGrain', { grainId: 'allowed' });
  const controller = new AbortController();
  const pending = f.call('renderTemplate', { lease: view.lease, options: {} }, controller.signal);
  while (!release) await new Promise(resolve => setTimeout(resolve, 0));
  controller.abort(); release();
  await assert.rejects(pending, { status: 410 });
  assert.equal(revoked, true);
  await f.call('closeGrain', { lease: view.lease });
});

test('renames use the live lease, reject overlapping calls and cancel before writes', async () => {
  let writes = 0;
  const f = await fixture({ rename: async (_handle, title, beforeWrite) => { await beforeWrite(); ++writes; return { title, ownerTitle: "Owner title" }; } });
  const view = await f.call('openGrain',{grainId:'allowed'});
  const input = {lease:view.lease,title:' New title '};
  assert.deepEqual(await f.call('renameGrain',input), {title:'New title',ownerTitle:'Owner title'});
  assert.equal(writes,1);
  const other = await f.signIn();
  await assert.rejects(f.call('renameGrain',{...input,token:other}),{status:403});
  await assert.rejects(f.call('renameGrain',{...input,title:' '}),{status:400});
  await f.call('closeGrain',{lease:view.lease});
  await assert.rejects(f.call('renameGrain',input),{status:410});
  for (const mode of ['close','logout','abort','share']) {
    let release, entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const g = await fixture({ rename: async (_handle,title,beforeWrite) => {
      entered(); await new Promise(resolve => { release = resolve; });
      await beforeWrite(); ++writes; return { title, ownerTitle: "Owner title" };
    } });
    const opened = await g.call('openGrain',{grainId:'allowed'});
    const controller = new AbortController();
    const request = {lease:opened.lease,title:'Must not write'};
    const pending = g.call('renameGrain',request,controller.signal);
    const denied = assert.rejects(pending);
    await ready;
    await assert.rejects(g.call('renameGrain',request),{status:409});
    if (mode === 'close') await g.call('closeGrain',{lease:opened.lease});
    if (mode === 'logout') await g.call('logout');
    if (mode === 'abort') controller.abort();
    if (mode === 'share') g.revokeShare();
    release(); await denied;
    assert.equal(writes,1,mode);
  }
});

test('sharing operations require a live account-bound grain lease and serialize mutations', async () => {
  let writes = 0;
  let release;
  const f = await fixture({ sharing: async () => ({ grants: [] }),
    createShare: async (_handle, _input, beforeWrite) => {
      await new Promise(resolve => { release = resolve; });
      await beforeWrite(); ++writes; return {id:'id',token:'secret'};
    }, revokeTemplate: async () => {}, updateShare: async (_handle, _input, beforeWrite) => { await beforeWrite(); ++writes; return {}; } });
  const {lease} = await f.call('openGrain', {grainId:'allowed'});
  await assert.rejects(f.call('getSharing'), {status:410});
  await assert.rejects(f.call('getSharing', {lease,token:await f.signIn()}), {status:403});
  assert.deepEqual(await f.call('getSharing',{lease}), {grants:[]});
  const pending = f.call('createShare', {lease,label:'Team',role:'none'});
  const rejected = assert.rejects(pending);
  while (!release) await new Promise(resolve => setTimeout(resolve,0));
  await assert.rejects(f.call('updateShare',{lease,id:'id',changes:{revoked:true}}), {status:409});
  f.revokeShare(); release(); await rejected;
  assert.equal(writes,0);
  await assert.rejects(f.call('getSharing',{lease}), {status:403});
});

test('canceled sharing issuance removes late bearer tokens', async () => {
  for (const mode of ['abort','close','login','expiry']) {
    let release;
    const removed = [];
    const f = await fixture({createShare: () => new Promise(resolve => {release = resolve;}), revokeTemplate: async result => removed.push(result.id)});
    const {lease} = await f.call('openGrain', {grainId:'allowed'});
    const controller = new AbortController();
    const pending = f.call('createShare',{lease,label:'Link',role:'none'},controller.signal);
    const rejected = assert.rejects(pending);
    while (!release) await new Promise(resolve => setTimeout(resolve,0));
    if (mode === 'abort') controller.abort();
    if (mode === 'close') await f.call('closeGrain',{lease});
    if (mode === 'login') f.revokeLogin();
    if (mode === 'expiry') f.expire();
    release({id:'late-id',token:'late-secret'});
    await rejected;
    assert.deepEqual(removed,['late-id'],mode);
  }
});

test('Powerbox requests are bound to the account, grain lease and request generation', async () => {
  const live = new Set();
  const f = await fixture({powerbox:{
    open: async () => { const handle = {}; live.add(handle); return {handle,view:{status:'choices'}}; },
    select: async () => ({status:'complete',token:'selected'}),
    poll: async () => ({status:'waiting'}),
    close: async handle => { live.delete(handle); },
  }});
  const {lease} = await f.call('openGrain',{grainId:'allowed'});
  const request = 'b'.repeat(64);
  const call = (operation, extra={}) => f.call('powerbox',{lease,request,operation,...extra});
  await assert.rejects(call('begin',{token:await f.signIn()}), {status:403});
  await call('begin');
  await assert.rejects(call('begin'), {status:409});
  await assert.rejects(call('select',{request:'c'.repeat(64)}), {status:410});
  await call('cancel',{request:'c'.repeat(64)});
  assert.equal(live.size,1,'old cancellation cannot cancel another request');
  assert.equal((await call('select')).token,'selected');
  await assert.rejects(call('select'), {status:410});
  await call('cancel');
  assert.equal(live.size,0);
  await call('begin',{request:'c'.repeat(64)});
  await f.call('closeGrain',{lease});
  assert.equal(live.size,0,'grain close disposes providers');
});

test('Powerbox closes late providers and discards undelivered results after cancellation or revocation', async () => {
  for (const operation of ['begin','select']) for (const mode of ['cancel','close','login','share','abort']) {
    let release;
    const handles = [];
    const closed = [];
    const powerbox = {
      open: async () => { const handle = {delivered:false}; handles.push(handle);
        if (operation === 'begin') await new Promise(resolve => { release = resolve; });
        return {handle,view:{status:'choices'}};
      },
      select: async handle => { await new Promise(resolve => { release = resolve; }); handle.token = 'late'; return {status:'complete',token:'late'}; },
      close: async handle => { closed.push(handle); },
    };
    const f = await fixture({powerbox});
    const {lease} = await f.call('openGrain',{grainId:'allowed'});
    const input = {lease,request:'b'.repeat(64)};
    if (operation === 'select') await f.call('powerbox',{...input,operation:'begin'});
    const controller = new AbortController();
    const pending = f.call('powerbox',{...input,operation},controller.signal);
    const rejected = assert.rejects(pending);
    while (!release) await new Promise(resolve => setTimeout(resolve,0));
    if (mode === 'cancel') await f.call('powerbox',{...input,operation:'cancel'});
    if (mode === 'close') await f.call('closeGrain',{lease});
    if (mode === 'login') f.revokeLogin();
    if (mode === 'share') f.revokeShare();
    if (mode === 'abort') controller.abort();
    release(); await rejected;
    assert.ok(closed.includes(handles[0]),operation+' '+mode);
    assert.equal(handles[0].delivered,false);
  }
});
