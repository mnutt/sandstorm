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
    markRead: async (user) => { rows.filter((row) => row.user === user).forEach((row) => { row.unread = false; }); },
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
