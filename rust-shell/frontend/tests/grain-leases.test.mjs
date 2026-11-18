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

test('grain scope admission is bounded and logout frees capacity', async () => {
  const f = await fixture();
  for (let i = 0; i < 8; ++i) await f.call('openGrain', { grainId: 'allowed', scope: i.toString(16).padStart(64, '0') });
  await assert.rejects(f.call('openGrain', { grainId: 'allowed' }), { status: 503 });
  await f.call('logout');
  assert.equal(f.live.size, 0);
});

test('template issuance is scoped, bounded and rolls back a token created after close', async () => {
  let created = 0;
  let revoked = 0;
  let release;
  const f = await fixture({ template: async () => ({ id: ++created, token: 'secret', host: 'api.test' }),
    revokeTemplate: async () => { ++revoked; } });
  const view = await f.call('openGrain', { grainId: 'allowed' });
  await assert.rejects(f.call('renderTemplate', { lease: 'b'.repeat(64), options: {} }), { status: 403 });
  for (let i = 0; i < 8; ++i) assert.equal((await f.call('renderTemplate', { lease: view.lease, options: {} })).token, 'secret');
  await assert.rejects(f.call('renderTemplate', { lease: view.lease, options: {} }), { status: 429 });
  assert.equal(created, 8);
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
