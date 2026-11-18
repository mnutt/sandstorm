import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { once } from 'node:events';
import { chromium, expect } from '@playwright/test';
import { start, stop } from './harness.mjs';
import { httpsProxy } from './https-harness.mjs';
import { createRustShellBridge, bridgeHandler } from '../../../shell/imports/server/rust-shell-bridge-core.mjs';

// Uses the production bridge authority/HTTP implementation with an in-memory DB
// adapter. No test writes or login tokens touch the installed Meteor/Mongo server.
test('authenticated notifications: handoff, shared writes, account switching and revocation', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rust-shell-auth-'));
  const socket = join(directory, 'rust.sock');
  const bridgeSocket = join(directory, 'meteor.sock');
  let proxy, main, bridgeServer, browser, rust;
  const users = { alice: { name: 'Alice', hash: 'alice-login', expires: Date.now() + 3600000 },
    bob: { name: 'Bob', hash: 'bob-login', expires: Date.now() + 3600000 } };
  const rows = new Map();
  const observers = new Set();
  let observationStarts = 0;
  const changed = () => { for (const notify of observers) notify(); };
  const add = (key, user, title) => { rows.set(key, { user, key, title, body: 'Shared notification',
    unread: true, ongoing: false, href: '', senderName: '<script>window.senderInjected = true</script>', timestamp: new Date().toISOString() }); changed(); };
  add('alice-real-id', 'alice', 'Alice notification');
  add('bob-real-id', 'bob', 'Bob notification');
  let activeMainAccount = 'alice';
  const bridge = createRustShellBridge({
    authorize: async (id, hash) => users[id]?.hash === hash ? users[id] : null,
    observe: async (_id, notify) => { ++observationStarts; observers.add(notify); return () => observers.delete(notify); },
    snapshot: async (id) => {
      const entries = [...rows.values()].filter((row) => row.user === id).map(({ user, ...entry }) => entry);
      return { entries, total: entries.length, grains: [{ key: `${id}-grain`, title: `${users[id].name} grain`,
        href: `/grain/${id}-grain`, appTitle: 'Text Editor', owned: id === 'alice', lastUsed: new Date(0).toISOString() },
        ...(id === 'alice' ? [{ key: 'alice-extra', title: 'Zebra shared', href: '/grain/alice-extra',
          owned: false, appTitle: 'Spreadsheet', lastUsed: new Date(1000).toISOString() }] : [])], grainsLimited: false };
    },
    dismiss: async (id, key) => {
      if (rows.get(key)?.user !== id) throw Object.assign(new Error('Not your notification'), { status: 403 });
      rows.delete(key); changed();
    },
    markRead: async (id) => { for (const row of rows.values()) if (row.user === id) row.unread = false; changed(); },
  });
  try {
    proxy = await httpsProxy(directory, socket);
    bridgeServer = httpServer(bridgeHandler(bridge));
    bridgeServer.listen(bridgeSocket); await once(bridgeServer, 'listening'); await chmod(bridgeSocket, 0o600);
    main = httpsServer(proxy.tls, async (req, res) => {
      try {
        const state = new URL(req.url, 'https://localhost').searchParams.get('state');
        const code = await bridge.issue(activeMainAccount, users[activeMainAccount].hash, state);
        res.setHeader('Content-Type', 'text/html');
        res.end(`<form method="POST" action="${proxy.origin}/auth/login"><input type="hidden" name="state" value="${state}"><input type="hidden" name="code" value="${code}"><button>Connect ${users[activeMainAccount].name}</button></form>`);
      } catch { res.writeHead(400); res.end(); }
    });
    main.listen(0, '127.0.0.1'); await once(main, 'listening');
    const mainOrigin = `https://localhost:${main.address().port}`;
    rust = (await start('debug/sandstorm-rust-shell', [], {
      RUST_SHELL_SOCKET: socket, RUST_SHELL_ORIGIN: proxy.origin,
      RUST_SHELL_MAIN_URL: mainOrigin, RUST_SHELL_BRIDGE_SOCKET: bridgeSocket,
      RUST_SHELL_FIXTURE_SOCKET: '',
    }, /Rust shell: (https:\/\/\S+)/)).child;
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium',
      headless: true, args: [`--ignore-certificate-errors-spki-list=${proxy.pin}`] });
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(proxy.origin);
    await page.getByRole('link', { name: 'Sign in with Sandstorm' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Add test notification' }).count(), 0);
    const denied = await page.evaluate(() => new Promise((resolve) => {
      const ws = new WebSocket(location.origin.replace('https:', 'wss:') + '/rpc');
      ws.onopen = () => { ws.close(); resolve(false); }; ws.onerror = () => resolve(true);
    }));
    assert.equal(denied, true);
    const bad = await page.evaluate(async () => (await fetch('/auth/login', { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `code=${'a'.repeat(64)}&state=${'b'.repeat(64)}` })).status);
    assert.equal(bad, 403);
    await page.getByRole('link', { name: 'Sign in with Sandstorm' }).click();
    await page.getByRole('button', { name: 'Connect Alice' }).click();
    await page.getByRole('heading', { name: /Alice notification/ }).waitFor();
    assert.equal(await page.getByRole('heading', { name: /Bob notification/ }).count(), 0);
    await page.getByText('From <script>window.senderInjected = true</script>', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.senderInjected), undefined);
    await page.getByRole('button', { name: 'Grains', exact: true }).click();
    await page.getByRole('link', { name: 'Alice grain', exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Alice grain', exact: true }).getAttribute('href'), '/grain/alice-grain');
    assert.equal(await page.getByRole('link', { name: 'Bob grain', exact: true }).count(), 0);
    await page.locator('.grain-item').getByText('Owned by you', { exact: true }).waitFor();
    assert.equal(await page.locator('.grain-item h3').first().innerText(), 'Zebra shared');
    await page.getByLabel('Sort by').selectOption('title');
    assert.equal(await page.locator('.grain-item h3').first().innerText(), 'Alice grain');
    await page.getByLabel('Filter shown grains').fill('editor');
    assert.equal(await page.locator('.grain-item').count(), 1);
    await page.getByLabel('Filter shown grains').fill('');
    await page.getByLabel('Show', { exact: true }).selectOption('shared');
    assert.equal(await page.locator('.grain-item h3').innerText(), 'Zebra shared');
    await page.getByLabel('Show', { exact: true }).selectOption('all');
    await page.getByLabel('Filter shown grains').fill('nothing matches');
    await page.getByText('No matching grains.', { exact: true }).waitFor();
    await page.getByLabel('Filter shown grains').fill('');
    await page.getByRole('button', { name: 'Notifications', exact: true }).click();
    const cookie = (await context.cookies()).find((cookie) => cookie.name === '__Host-sandstorm-rust-session');
    assert.equal(cookie.httpOnly, true); assert.equal(cookie.secure, true); assert.equal(cookie.sameSite, 'Lax');
    assert.equal(await page.evaluate(() => document.cookie.includes('__Host-sandstorm-rust-session')), false);
    await page.reload();
    await page.getByRole('heading', { name: /Alice notification/ }).waitFor();
    assert.equal((await context.cookies()).find((entry) => entry.name === cookie.name).value, cookie.value,
      'ordinary reload must preserve the linked session');
    await expect.poll(() => observers.size).toBe(1);
    const starts = observationStarts;
    await new Promise((resolve) => setTimeout(resolve, 6000));
    assert.equal(observationStarts, starts, 'idle watch must survive the ordinary five-second HTTP timeout');
    add('from-legacy', 'alice', 'Written by main shell');
    await page.getByRole('heading', { name: /Written by main shell/ }).waitFor();
    await page.getByRole('button', { name: 'Dismiss Written by main shell', exact: true }).click();
    await page.getByRole('heading', { name: /Written by main shell/ }).waitFor({ state: 'detached' });
    assert.equal(rows.has('from-legacy'), false);
    await page.getByRole('button', { name: 'Mark all as read' }).click();
    await expect.poll(() => rows.get('alice-real-id').unread).toBe(false);
    assert.equal(rows.get('bob-real-id').unread, true);
    const other = await context.newPage();
    await other.goto(proxy.origin);
    await other.getByRole('heading', { name: /Alice notification/ }).waitFor();
    activeMainAccount = 'bob';
    await page.getByRole('link', { name: 'Switch account' }).click();
    await page.getByRole('button', { name: 'Connect Bob' }).click();
    await page.getByRole('heading', { name: /Bob notification/ }).waitFor();
    await other.getByRole('heading', { name: /Bob notification/ }).waitFor();
    assert.equal(await other.getByRole('heading', { name: /Alice notification/ }).count(), 0);
    await other.getByRole('button', { name: 'Grains', exact: true }).click();
    await other.getByRole('link', { name: 'Bob grain', exact: true }).waitFor();
    await other.locator('.grain-item').getByText('Shared with you', { exact: true }).waitFor();
    assert.equal(await other.getByRole('link', { name: 'Alice grain', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await other.getByRole('link', { name: 'Sign in with Sandstorm' }).waitFor();
    assert.equal(await other.locator('.grain-item').count(), 0);
    await page.getByRole('link', { name: 'Sign in with Sandstorm' }).click();
    await page.getByRole('button', { name: 'Connect Bob' }).click();
    await page.getByRole('heading', { name: /Bob notification/ }).waitFor();
    users.bob.hash = 'revoked-by-main-shell';
    await page.getByRole('link', { name: 'Sign in with Sandstorm' }).waitFor();
    assert.equal(await page.locator('.notification-item').count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close(); await stop(rust);
    await expect.poll(() => observers.size).toBe(0);
    for (const server of [main, bridgeServer]) if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    await proxy?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
