import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { once } from 'node:events';
import { chromium, expect } from '@playwright/test';
import { start, stop, serveProbe } from './harness.mjs';
import { httpsProxy } from './https-harness.mjs';
import { memorySessionStore } from '../../../shell/imports/server/rust-shell-session-store.mjs';
import { createRustShellBridge, bridgeHandler } from '../../../shell/imports/server/rust-shell-bridge-core.mjs';

// Uses the production bridge authority/HTTP implementation with an in-memory DB
// adapter. No test writes or login tokens touch the installed Meteor/Mongo server.
test('authenticated notifications: handoff, shared writes, account switching and revocation', { timeout: 90000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rust-shell-auth-'));
  const socket = join(directory, 'rust.sock');
  const bridgeSocket = join(directory, 'meteor.sock');
  let proxy, main, grainServer, bridgeServer, browser, rust;
  const liveGrains = new Set();
  let grainOrigin;
  let mainOrigin;
  let serial = 0;
  let leaseClockOffset = 0;
  let renewals = 0;
  let templates = 0;
  let holdOpen = false;
  let releaseOpen;
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
  let bridgeOffline = false;
  const sessionStore = memorySessionStore();
  const bridgeOptions = {
    sessionStore,
    now: () => Date.now() + leaseClockOffset,
    grains: {
      open: async (id, grainId) => {
        if (![`${id}-grain`, `${id}-hidden`].includes(grainId)) throw Object.assign(new Error('Denied'), { status: 403 });
        if (holdOpen) await new Promise(resolve => { releaseOpen = resolve; });
        const handle = ++serial; liveGrains.add(handle);
        return { handle, view: { grainId, title: grainId.endsWith('-hidden') ? 'Hidden grain' : '', mainHref: mainOrigin + '/grain/' + grainId, origin: grainOrigin, url: grainOrigin + '/_sandstorm-init?sessionid=' + handle } };
      },
      keep: async (handle) => { ++renewals; if (!liveGrains.has(handle)) throw new Error('Session revoked'); },
      close: async (handle) => { liveGrains.delete(handle); },
      template: async () => ({ id: ++templates, token: 'sensitive-template-token', host: new URL(grainOrigin).host }),
      revokeTemplate: async () => { --templates; },
    },
    authorize: async (id, hash) => {
      if (bridgeOffline) throw Object.assign(new Error('Main shell starting'), { status: 503 });
      return users[id]?.hash === hash ? users[id] : null;
    },
    observe: async (_id, notify) => { ++observationStarts; observers.add(notify); return () => observers.delete(notify); },
    snapshot: async (id) => {
      const entries = [...rows.values()].filter((row) => row.user === id).map(({ user, ...entry }) => entry);
      return { entries, total: entries.length, grains: [{ key: `${id}-grain`, title: `${users[id].name} grain`,
        href: `${mainOrigin}/grain/${id}-grain`, appTitle: 'Text Editor', owned: id === 'alice', lastUsed: new Date(0).toISOString() },
        ...(id === 'alice' ? [{ key: 'alice-extra', title: 'Zebra shared', href: `${mainOrigin}/grain/alice-extra`,
          owned: false, appTitle: 'Spreadsheet', lastUsed: new Date(1000).toISOString() }] : [])], grainsLimited: false };
    },
    dismiss: async (id, key) => {
      if (rows.get(key)?.user !== id) throw Object.assign(new Error('Not your notification'), { status: 403 });
      rows.delete(key); changed();
    },
    markRead: async (id) => { for (const row of rows.values()) if (row.user === id) row.unread = false; changed(); },
  };
  let bridge = createRustShellBridge(bridgeOptions);
  try {
    proxy = await httpsProxy(directory, socket);
    grainServer = httpsServer(proxy.tls, (_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end('<h1>Embedded test grain</h1><input aria-label="App state"><script>window.addEventListener("message", event => { window.reply = event.data; });</script>');
    });
    grainServer.listen(0, '127.0.0.1'); await once(grainServer, 'listening');
    grainOrigin = `https://localhost:${grainServer.address().port}`;
    bridgeServer = httpServer((req, res) => {
      if (bridgeOffline) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":"Main shell starting"}'); return; }
      return bridgeHandler(bridge)(req, res);
    });
    bridgeServer.listen(bridgeSocket); await once(bridgeServer, 'listening'); await chmod(bridgeSocket, 0o600);
    main = httpsServer(proxy.tls, async (req, res) => {
      try {
        if (req.url === '/rust-shell-powerbox') {
          res.setHeader('Content-Type', 'text/html');
          res.end(`<button id="choose">Choose test capability</button><script>
            window.addEventListener('message', event => {
              if (event.source !== opener || event.origin !== '${proxy.origin}' || event.data.type !== 'rust-powerbox-request') return;
              window.request = event.data;
            });
            opener.postMessage({type:'rust-powerbox-ready'}, '${proxy.origin}');
            document.getElementById('choose').onclick = () => opener.postMessage({type:'rust-powerbox-result',
              nonce:request.nonce, result:{rpcId:request.request.rpcId, token:'test-capability', descriptor:'test-descriptor'}}, '${proxy.origin}');
          </script>`);
          return;
        }
        const state = new URL(req.url, 'https://localhost').searchParams.get('state');
        const code = await bridge.issue(activeMainAccount, users[activeMainAccount].hash, state);
        res.setHeader('Content-Type', 'text/html');
        res.end(`<form method="POST" action="${proxy.origin}/auth/login"><input type="hidden" name="state" value="${state}"><input type="hidden" name="code" value="${code}"><button>Connect ${users[activeMainAccount].name}</button></form>`);
      } catch { res.writeHead(400); res.end(); }
    });
    main.listen(0, '127.0.0.1'); await once(main, 'listening');
    mainOrigin = `https://localhost:${main.address().port}`;
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
    let receivedFrames = 0;
    page.on('websocket', (socket) => socket.on('framereceived', () => { ++receivedFrames; }));
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
    await page.reload();
    await page.getByRole('link', { name: 'Alice grain', exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/grains');
    assert.equal(await page.getByRole('link', { name: 'Alice grain', exact: true }).getAttribute('href'), `${mainOrigin}/grain/alice-grain`);
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
    await serveProbe(page, './grain-session-probe.ts', 'grain-session-probe.js');
    await page.evaluate(() => import('/grain-session-probe.js').then((probe) => probe.open()));
    await expect.poll(() => liveGrains.size).toBe(1);
    await page.evaluate(() => import('/grain-session-probe.js').then((probe) => probe.release()));
    await expect.poll(() => liveGrains.size).toBe(0);
    await page.evaluate(() => import('/grain-session-probe.js').then((probe) => probe.disconnect()));
    await page.getByRole('button', { name: 'Open Alice grain here', exact: true }).click();
    await page.frameLocator('iframe').getByRole('heading', { name: 'Embedded test grain' }).waitFor();
    assert.equal(liveGrains.size, 1);
    assert.equal(new URL(page.url()).pathname, '/grain/alice-grain');
    const originalUrl = await page.locator('iframe').getAttribute('src');
    await page.frames().find(frame => frame.url().startsWith(grainOrigin)).evaluate(() =>
      parent.postMessage({setPath:'/folder/document?mode=edit#heading'}, '*'));
    await page.waitForURL('**/grain/alice-grain/folder/document?mode=edit#heading');
    await page.reload();
    await page.frameLocator('iframe').getByRole('heading', { name: 'Embedded test grain' }).waitFor();
    const restoredUrl = new URL(await page.locator('iframe').getAttribute('src'));
    assert.equal(restoredUrl.searchParams.get('path'), '/folder/document?mode=edit#heading');
    assert.notEqual(restoredUrl.searchParams.get('sessionid'), new URL(originalUrl).searchParams.get('sessionid'));
    assert.equal(page.url().includes('sessionid'), false);
    await page.goBack();
    await page.getByRole('link', { name: 'Alice grain', exact: true }).waitFor();
    await expect.poll(() => liveGrains.size).toBe(0);
    await page.goForward();
    await page.frameLocator('iframe').getByRole('heading', { name: 'Embedded test grain' }).waitFor();
    const app = page.frames().find((frame) => frame.url().startsWith(grainOrigin));
    const pathBeforeForged = page.url();
    await app.evaluate(() => parent.postMessage({setPath:'//untrusted.test/'}, '*'));
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.equal(page.url(), pathBeforeForged);
    await app.getByLabel('App state').fill('keep this iframe alive');
    await page.evaluate((origin) => window.dispatchEvent(new MessageEvent('message', {
      origin, source: window, data: { setTitle: 'Forged title' },
    })), grainOrigin);
    assert.equal(await page.getByRole('heading', { name: 'Forged title' }).count(), 0);
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', {
      origin: 'https://untrusted.test', source: document.querySelector('iframe').contentWindow,
      data: { setTitle: 'Wrong origin' },
    })));
    assert.equal(await page.getByRole('heading', { name: 'Wrong origin' }).count(), 0);
    await app.evaluate(() => parent.postMessage({ setTitle: 'App page title', setPath: '/document?x=1#section' }, '*'));
    await page.getByRole('heading', { name: 'App page title' }).waitFor();
    await app.evaluate(() => parent.postMessage({ getGrainTitle: {}, rpcId: 'title' }, '*'));
    await expect.poll(() => app.evaluate(() => window.reply?.grainTitle)).toBe('Alice grain');
    await app.evaluate(() => parent.postMessage({ renderTemplate: { rpcId: 'template',
      template: '<script>window.injected=true</script> $API_TOKEN $API_HOST $GRAIN_TITLE_SLUG',
      clipboardButton: 'right', style: { color: '#123456' } } }, '*'));
    await expect.poll(() => app.evaluate(() => window.reply?.uri)).toContain('/offer-template.html#');
    const offered = await app.evaluate(() => {
      const reply = window.reply;
      const iframe = document.createElement('iframe'); iframe.id = 'offer'; iframe.src = reply.uri;
      document.body.appendChild(iframe);
      return reply;
    });
    assert.deepEqual(Object.keys(offered).sort(), ['rpcId', 'uri']);
    assert.equal(offered.uri.includes('sensitive'), false);
    const offer = app.frameLocator('#offer');
    await expect(offer.locator('#text')).toContainText('sensitive-template-token');
    await expect(offer.locator('#text')).toContainText('alice-grain');
    await expect(offer.getByRole('button', { name: 'Copy API instructions' })).toBeVisible();
    assert.equal(await app.evaluate(() => {
      try { return !!document.getElementById('offer').contentWindow.document.body; } catch { return false; }
    }), false, 'app must not read shell-origin token text');
    assert.equal(await page.evaluate(() => window.injected), undefined);
    await app.evaluate(() => parent.postMessage({renderTemplate:{rpcId:'unsupported',template:'$API_TOKEN',clientapp:'davros'}}, '*'));
    await expect.poll(() => app.evaluate(() => window.reply?.rpcId)).toBe('unsupported');
    assert.match(await app.evaluate(() => window.reply.error), /requires the main shell/);
    assert.equal(templates, 1);
    // Davros renders these simultaneously; token-specific host and password must match.
    await app.evaluate(() => {
      window.templateReplies = {};
      window.addEventListener('message', e => { if (e.data?.rpcId?.startsWith('davros-')) window.templateReplies[e.data.rpcId] = e.data; });
      const unauthenticated = { resources: { '/status.php': { type: 'text/json', language: 'en', body: '{"installed":true}' } },
        options: { dav: ['1', '2', '3', 'mkcol-extended'] } };
      for (const [id, template] of [['host','$API_HOST'],['user','$GRAIN_TITLE_SLUG'],['password','$API_TOKEN']]) {
        parent.postMessage({renderTemplate:{rpcId:'davros-'+id, template, unauthenticated, clipboardButton:'right'}}, '*');
      }
    });
    await expect.poll(() => app.evaluate(() => Object.keys(window.templateReplies).length)).toBe(3);
    const davrosReplies = await app.evaluate(() => window.templateReplies);
    for (const reply of Object.values(davrosReplies)) assert.ok(reply.uri, JSON.stringify(reply));
    assert.equal(templates, 2, 'three matching requests issue only one additional token');
    const records = await page.evaluate(replies => Object.values(replies).map(reply =>
      JSON.parse(sessionStorage.getItem('rustOfferTemplate:' + new URL(reply.uri).hash.slice(1)))), davrosReplies);
    assert.equal(new Set(records.map(record => record.token)).size, 1);
    assert.equal(new Set(records.map(record => record.host)).size, 1);

    await app.evaluate(() => parent.postMessage({ powerboxRequest: { rpcId: 'powerbox' } }, '*'));
    await page.getByRole('button', { name: 'Choose in Sandstorm' }).waitFor();
    await app.evaluate(() => parent.postMessage({ powerboxRequest: { rpcId: 'duplicate' } }, '*'));
    await expect.poll(() => app.evaluate(() => window.reply?.rpcId)).toBe('duplicate');
    assert.match(await app.evaluate(() => window.reply.error), /already open/);
    const popupPromise = context.waitForEvent('page');
    await page.getByRole('button', { name: 'Choose in Sandstorm' }).click();
    const popup = await popupPromise;
    await popup.waitForURL(mainOrigin + '/rust-shell-powerbox');
    await popup.waitForLoadState('domcontentloaded');
    await expect.poll(() => popup.evaluate(() => !!window.request)).toBe(true);
    assert.equal(await popup.evaluate(() => window.request.sessionId), String(serial));
    assert.equal(new URL(popup.url()).search, '');
    await page.evaluate(origin => window.dispatchEvent(new MessageEvent('message', {
      origin, source: window, data: { type: 'rust-powerbox-result', result: {rpcId:'powerbox', token:'forged'} },
    })), mainOrigin);
    await popup.evaluate(() => opener.postMessage({type:'rust-powerbox-result', nonce:'wrong',
      result:{rpcId:'powerbox', token:'forged'}}, '*'));
    await popup.getByRole('button', { name: 'Choose test capability' }).click();
    await expect.poll(() => app.evaluate(() => window.reply?.token)).toBe('test-capability');
    assert.equal(await app.evaluate(() => window.reply.descriptor), 'test-descriptor');
    await expect.poll(() => popup.isClosed()).toBe(true);
    await app.evaluate(() => parent.postMessage({ powerboxRequest: { rpcId: 'cancel' } }, '*'));
    await page.getByRole('button', { name: 'Cancel request' }).click();
    await expect.poll(() => app.evaluate(() => window.reply?.canceled)).toBe(true);
    assert.equal(await app.evaluate(() => window.reply.rpcId), 'cancel');
    await app.evaluate(() => parent.postMessage({ powerboxRequest: { rpcId: 'window-close' } }, '*'));
    const closedPopupPromise = context.waitForEvent('page');
    await page.getByRole('button', { name: 'Choose in Sandstorm' }).click();
    const closedPopup = await closedPopupPromise;
    await closedPopup.close();
    await expect.poll(() => app.evaluate(() => window.reply?.rpcId)).toBe('window-close');
    assert.equal(await app.evaluate(() => window.reply.canceled), true);
    const beforeUpdate = receivedFrames;
    add('while-open', 'alice', 'Notification while grain is open');
    await expect.poll(() => receivedFrames).toBeGreaterThan(beforeUpdate);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await expect(app.getByLabel('App state')).toHaveValue('keep this iframe alive');
    await expect.poll(() => renewals, { timeout: 15000 }).toBeGreaterThan(0);
    await app.evaluate(() => parent.postMessage({ powerboxRequest: { rpcId: 'grain-close' } }, '*'));
    const grainClosePopupPromise = context.waitForEvent('page');
    await page.getByRole('button', { name: 'Choose in Sandstorm' }).click();
    const grainClosePopup = await grainClosePopupPromise;
    await page.getByRole('button', { name: 'Close grain', exact: true }).click();
    await expect.poll(() => grainClosePopup.isClosed()).toBe(true);
    assert.equal(await page.evaluate(() => Object.keys(sessionStorage).filter(k => k.startsWith('rustOfferTemplate:')).length), 0);
    await expect.poll(() => liveGrains.size).toBe(0);
    await page.getByRole('button', { name: 'Open Alice grain here', exact: true }).click();
    await page.frameLocator('iframe').getByRole('heading', { name: 'Embedded test grain' }).waitFor();
    // A Rust crash closes the browser view; Meteor's bounded lease survives only
    // until expiry. The independent grain host stays alive throughout.
    rust.kill('SIGKILL'); await stop(rust);
    await expect.poll(() => page.locator('iframe').count()).toBe(0);
    leaseClockOffset += 46000;
    await bridge.sweepGrains();
    assert.equal(liveGrains.size, 0);
    await rm(socket, { force: true });
    rust = (await start('debug/sandstorm-rust-shell', [], {
      RUST_SHELL_SOCKET: socket, RUST_SHELL_ORIGIN: proxy.origin,
      RUST_SHELL_MAIN_URL: mainOrigin, RUST_SHELL_BRIDGE_SOCKET: bridgeSocket,
      RUST_SHELL_FIXTURE_SOCKET: '',
    }, /Rust shell: (https:\/\/\S+)/)).child;
    await page.reload();
    await page.frameLocator('iframe').getByRole('heading', { name: 'Embedded test grain' }).waitFor();
    // Recreate Meteor's bridge over the same durable store while an app and
    // chooser are active. Startup discards UI sessions, never the linked login.
    const loginBeforeRestart = (await context.cookies()).find(c => c.name === '__Host-sandstorm-rust-session').value;
    const restartApp = page.frames().find(frame => frame.url().startsWith(grainOrigin));
    await restartApp.evaluate(() => parent.postMessage({powerboxRequest:{rpcId:'restart'}}, '*'));
    const restartPopupPromise = context.waitForEvent('page');
    await page.getByRole('button', {name:'Choose in Sandstorm'}).click();
    const restartPopup = await restartPopupPromise;
    bridgeOffline = true;
    changed();
    await page.getByText('Waiting for the main shell… Your login will be checked when it returns.').waitFor();
    assert.equal(await page.locator('iframe').count(), 0);
    await expect.poll(() => restartPopup.isClosed()).toBe(true);
    bridge = createRustShellBridge(bridgeOptions);
    liveGrains.clear(); // Production removes marked Mongo UI sessions at startup.
    bridgeOffline = false;
    await page.getByRole('button', {name:'Reopen grain', exact:true}).waitFor();
    assert.equal(await page.locator('iframe').count(), 0, 'restart must not replay grain opening');
    assert.equal((await context.cookies()).find(c => c.name === '__Host-sandstorm-rust-session').value, loginBeforeRestart);
    await page.reload();
    await page.frameLocator('iframe').getByRole('heading', {name:'Embedded test grain'}).waitFor();
    await page.getByRole('button', { name: 'Notifications', exact: true }).click();
    await page.getByRole('heading', { name: /Alice notification/ }).waitFor();
    await expect.poll(() => liveGrains.size).toBe(0);
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
    const deep = await context.newPage();
    await deep.goto(proxy.origin + '/grain/alice-hidden/deep?q=1#part');
    await deep.frameLocator('iframe').getByRole('heading', {name:'Embedded test grain'}).waitFor();
    await deep.getByRole('heading', {name:'Hidden grain', exact:true}).waitFor();
    await deep.goto(proxy.origin + '/grain/bob-grain');
    await expect(deep.getByRole('alert')).toContainText('Unable to open grain');
    assert.equal(await deep.locator('iframe').count(), 0);
    await deep.close();
    const racing = await context.newPage();
    await racing.goto(proxy.origin + '/grains');
    holdOpen = true;
    await racing.getByRole('button', {name:'Open Alice grain here', exact:true}).click();
    await expect.poll(() => !!releaseOpen).toBe(true);
    await racing.getByRole('button', {name:'Notifications', exact:true}).click();
    holdOpen = false; releaseOpen();
    await racing.waitForURL('**/notifications');
    await racing.getByRole('heading', {name:/Alice notification/}).waitFor();
    assert.equal(await racing.locator('iframe').count(), 0);
    await expect.poll(() => liveGrains.size).toBe(0);
    assert.equal(await racing.evaluate(async () => (await fetch('/auth/unknown')).status), 404);
    assert.equal(await racing.evaluate(async () => (await fetch('/missing.js')).status), 404);
    await racing.close();
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
    await other.getByRole('button', { name: 'Open Bob grain here', exact: true }).click();
    await other.frameLocator('iframe').getByRole('heading', { name: 'Embedded test grain' }).waitFor();
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect.poll(() => liveGrains.size).toBe(0);
    await expect.poll(() => other.locator('iframe').count()).toBe(0);
    await other.getByRole('link', { name: 'Sign in with Sandstorm' }).waitFor();
    assert.equal(await other.locator('.grain-item').count(), 0);
    await page.getByRole('link', { name: 'Sign in with Sandstorm' }).click();
    await page.getByRole('button', { name: 'Connect Bob' }).click();
    await page.getByRole('heading', { name: /Bob notification/ }).waitFor();
    users.bob.hash = 'revoked-by-main-shell';
    await page.getByRole('link', { name: 'Sign in with Sandstorm' }).waitFor();
    assert.equal(await page.locator('.notification-item').count(), 0);
    const freshContext = await browser.newContext();
    const fresh = await freshContext.newPage();
    activeMainAccount = 'alice';
    await fresh.goto(proxy.origin + '/grain/alice-hidden/clients?tab=sync#url');
    await fresh.getByRole('link', {name:'Sign in with Sandstorm'}).click();
    await fresh.getByRole('button', {name:'Connect Alice'}).click();
    await fresh.frameLocator('iframe').getByRole('heading', {name:'Embedded test grain'}).waitFor();
    assert.equal(new URL(fresh.url()).pathname + new URL(fresh.url()).search + new URL(fresh.url()).hash,
      '/grain/alice-hidden/clients?tab=sync#url');
    await freshContext.close();
    assert.deepEqual(errors, []);
  } catch (error) {
    console.error("Grain browser test failed:", error.message);
    throw error;
  } finally {
    await browser?.close(); await stop(rust);
    leaseClockOffset += 46000;
    await bridge.sweepGrains();
    await expect.poll(() => observers.size).toBe(0);
    await expect.poll(() => liveGrains.size).toBe(0);
    for (const server of [main, grainServer, bridgeServer]) if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    await proxy?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
