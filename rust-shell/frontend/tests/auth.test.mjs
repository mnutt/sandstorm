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
test('authenticated notifications: handoff, shared writes, account switching and revocation', { timeout: 120000 }, async () => {
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
  const grainTitles = {};
  let creations = 0;
  let failCreation = false;
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
  const profiles = {alice:{name:'Alice',handle:'alice',pronoun:'neutral'},bob:{name:'Bob',handle:'bob',pronoun:'neutral'}};
  const bridgeOptions = {
    getProfile: async id => ({...profiles[id],mainHref:mainOrigin+'/account'}),
    updateProfile: async (id, profile, beforeWrite) => { await beforeWrite(); profiles[id] = profile; users[id].name = profile.name; },
    sessionStore,
    listApps: async id => ({actions:[{key:id+'-action',title:'New document',appTitle:'Test app'}],limited:false}),
    createGrain: async (id, action, title, beforeCreate) => {
      assert.equal(action,id+'-action');
      assert.equal(title,'Created in Rust');
      await beforeCreate(); ++creations;
      if (failCreation) throw new Error('Simulated lost creation result');
      return id+'-created';
    },
    now: () => Date.now() + leaseClockOffset,
    grains: {
      open: async (id, grainId) => {
        if (![`${id}-grain`, `${id}-hidden`, `${id}-created`, `${id}-extra`].includes(grainId)) throw Object.assign(new Error('Denied'), { status: 403 });
        if (holdOpen) await new Promise(resolve => { releaseOpen = resolve; });
        const handle = ++serial; liveGrains.add(handle);
        return { handle, view: { grainId, iconSrc: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="24" height="24"%3E%3Crect width="24" height="24" fill="orange"/%3E%3C/svg%3E', title: grainId.endsWith('-hidden') ? 'Hidden grain' : grainId.endsWith('-extra') ? 'Zebra shared' : '', ownerTitle: grainTitles[id] || 'Owner title', mainHref: mainOrigin + '/grain/' + grainId, origin: grainOrigin, url: grainOrigin + '/_sandstorm-init?sessionid=' + handle } };
      },
      keep: async (handle) => { ++renewals; if (!liveGrains.has(handle)) throw new Error('Session revoked'); },
      close: async (handle) => { liveGrains.delete(handle); },
      rename: async (_handle, title, beforeWrite) => { await beforeWrite(); grainTitles.alice = title; changed(); return { title, ownerTitle: title }; },
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
      return { entries, total: entries.length, grains: [{ key: `${id}-grain`, title: grainTitles[id] || `${users[id].name} grain`, ownerTitle: grainTitles[id] || (id === 'alice' ? 'Alice grain' : 'Owner title'),
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
  let sharedRevoked = false;
  let guestsAllowed = true;
  const sharedOpens = [];
  bridgeOptions.shared = {
    inspect: async webkey => {
      if (webkey !== 'valid-share' || sharedRevoked) throw Object.assign(new Error('Sharing link revoked or invalid'), {status:403});
      return {title:'Shared test grain',guestsAllowed};
    },
    open: async (webkey,accountId) => {
      sharedOpens.push({webkey,accountId});
      const handle = ++serial; liveGrains.add(handle);
      return {handle,view:{grainId:'shared-grain',title:'Shared test grain',ownerTitle:'Shared test grain',
        origin:grainOrigin,url:grainOrigin+'/_sandstorm-init?sessionid='+handle,mainHref:mainOrigin+'/shared/'+webkey}};
    },
    keep: async handle => {if (!liveGrains.has(handle)) throw new Error('Revoked');},
    close: async handle => {liveGrains.delete(handle);},
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
        if (req.url === '/rust-shell-sharing') {
          res.setHeader('Content-Type', 'text/html');
          res.end(`<p>Sharing test window</p><script>
            addEventListener('message', event => {
              if (event.source !== opener || event.origin !== '${proxy.origin}' || event.data.type !== 'rust-sharing-request') return;
              window.request = event.data;
              opener.postMessage({type:'rust-sharing-result', nonce:request.nonce, opened:true}, '${proxy.origin}');
            });
            opener.postMessage({type:'rust-sharing-ready'}, '${proxy.origin}');
          </script>`);
          return;
        }
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
    const guest = await context.newPage();
    await guest.goto(proxy.origin+'/shared/valid-share/folder?view=guest#document');
    await guest.frameLocator('iframe').getByRole('heading',{name:'Embedded test grain'}).waitFor();
    await serveProbe(guest, './shared-probe.ts', 'shared-probe.js');
    assert.equal(await guest.evaluate(async ()=>(await import('/shared-probe.js')).probe()),true,'public shared bootstrap cannot be cast to account Shell');
    for (const kind of ['reply', 'flood']) {
      assert.equal(await guest.evaluate(async kind => (await import('/shared-probe.js')).attack(kind), kind), true,
        `unauthenticated ${kind} attack is disconnected`);
    }
    assert.equal(await guest.evaluate(async () => (await fetch('/healthz')).status), 200, 'server survives malformed RPC and flooding');
    assert.equal(sharedOpens.at(-1).accountId,null);
    assert.equal(new URL(await guest.locator('iframe').getAttribute('src')).searchParams.get('path'),'/folder?view=guest#document');
    assert.equal(await guest.getByRole('button',{name:'Rename grain',exact:true}).count(),0);
    await guest.frameLocator('iframe').locator('body').evaluate(()=>parent.postMessage({setPath:'/next?x=1#part'},'*'));
    await guest.waitForURL('**/shared/valid-share/next?x=1#part');
    await guest.getByRole('link',{name:'Notifications',exact:true}).click();
    assert.equal(await guest.locator('iframe').count(),1,'shared views stay mounted in the background');
    await guest.getByRole('link',{name:'Switch to Shared test grain'}).click();
    sharedRevoked = true; await bridge.sweepGrains();
    await expect.poll(()=>liveGrains.size).toBe(0);
    await expect(guest.getByRole('alert')).toContainText('Shared session ended',{timeout:15000});
    await guest.close(); sharedRevoked = false;
    guestsAllowed = false;
    const blockedGuest = await context.newPage();
    await blockedGuest.goto(proxy.origin+'/shared/valid-share');
    await blockedGuest.getByText('This server requires you to sign in before viewing shared grains.').waitFor();
    assert.equal(await blockedGuest.locator('iframe').count(),0);
    await blockedGuest.close(); guestsAllowed = true;
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
    await page.getByRole('button', {name:'Account: Alice',exact:true}).click();
    await page.getByRole('link', {name:'Account',exact:true}).click();
    await expect(page).toHaveTitle('Account · Sandstorm');
    await expect(page.locator('.route-content')).toBeFocused();
    await expect(page.getByLabel('Display name', {exact:true})).toHaveValue('Alice');
    await page.getByLabel('Display name', {exact:true}).fill('Alice renamed');
    await page.getByLabel('Handle', {exact:true}).fill('alice_renamed');
    await page.getByLabel('Pronouns', {exact:true}).selectOption('female');
    await page.getByRole('button', {name:'Save profile',exact:true}).click();
    await page.getByText('Profile saved.', {exact:true}).waitFor();
    await page.getByRole('button', {name:'Account: Alice renamed',exact:true}).waitFor();
    assert.equal(profiles.bob.name,'Bob');
    await page.reload();
    await expect(page.getByLabel('Display name', {exact:true})).toHaveValue('Alice renamed');
    profiles.alice = {name:'Legacy edit',handle:'alice',pronoun:'neutral'};
    await page.getByRole('button', {name:'Refresh profile',exact:true}).click();
    await expect(page.getByLabel('Display name', {exact:true})).toHaveValue('Legacy edit');
    await page.getByLabel('Display name', {exact:true}).fill('Alice');
    await page.getByRole('button', {name:'Save profile',exact:true}).click();
    await page.getByText('Profile saved.', {exact:true}).waitFor();
    await page.getByRole('link', {name:'Apps',exact:true}).click();
    await page.getByLabel('Installed app action').waitFor();
    assert.equal(new URL(page.url()).pathname,'/apps');
    await expect(page).toHaveTitle('Apps · Sandstorm');
    await expect(page.locator('.route-content')).toBeFocused();
    await expect(page.getByRole('link', {name:'Apps',exact:true})).toHaveAttribute('aria-current','page');
    await page.reload();
    await page.getByLabel('Installed app action').selectOption('alice-action');
    await page.getByLabel('Grain title').fill('Created in Rust');
    await page.getByRole('button', {name:'Create grain',exact:true}).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/grain/alice-created');
    await page.locator('.open-grains li.current button').waitFor();
    const signedShare = await context.newPage();
    await signedShare.goto(proxy.origin+'/shared/valid-share');
    await signedShare.getByRole('button',{name:'Open as Alice',exact:true}).waitFor();
    assert.equal(await signedShare.locator('iframe').count(),0,'signed-in identity must not be revealed automatically');
    await signedShare.getByRole('button',{name:'Open anonymously',exact:true}).click();
    await signedShare.frameLocator('iframe').getByRole('heading',{name:'Embedded test grain'}).waitFor();
    assert.equal(sharedOpens.at(-1).accountId,null);
    await signedShare.reload();
    await signedShare.getByRole('button',{name:'Open as Alice',exact:true}).click();
    await signedShare.frameLocator('iframe').getByRole('heading',{name:'Embedded test grain'}).waitFor();
    assert.equal(sharedOpens.at(-1).accountId,'alice');
    await signedShare.screenshot({path:'/tmp/sandstorm-rust-ui-shared.png'});
    await signedShare.close();
    await expect.poll(()=>liveGrains.size).toBe(1);
    assert.equal(creations,1);
    await page.locator('.open-grains li.current button').click();
    failCreation = true;
    await page.getByRole('link', {name:'Apps',exact:true}).click();
    await page.getByText('Grain created.', {exact:true}).waitFor();
    await page.getByRole('button', {name:'Create another grain',exact:true}).click();
    await page.getByLabel('Installed app action').selectOption('alice-action');
    await page.getByLabel('Grain title').fill('Created in Rust');
    await page.getByRole('button', {name:'Create grain',exact:true}).click();
    await page.getByText('The request was not retried. Check your grains before creating another.').waitFor();
    await expect(page.getByRole('button', {name:'Create grain',exact:true})).toBeDisabled();
    assert.equal(creations,2);
    await page.getByRole('button', {name:'Check grains',exact:true}).click();
    assert.equal(creations,2);
    failCreation = false;
    await page.getByRole('link', {name:'Apps',exact:true}).click();
    await page.getByText('The request was not retried. Check your grains before creating another.').waitFor();
    await expect(page.getByRole('button', {name:'Create grain',exact:true})).toBeDisabled();
    await page.getByRole('link', { name: 'Grains', exact: true }).click();
    await page.getByRole('link', { name: 'Alice grain', exact: true }).waitFor();
    await page.reload();
    await page.getByRole('link', { name: 'Alice grain', exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/grains');
    assert.equal(await page.getByRole('link', { name: 'Alice grain', exact: true }).getAttribute('href'), '/grain/alice-grain');
    assert.equal(await page.getByRole('link', { name: 'Bob grain', exact: true }).count(), 0);
    await page.locator('.grain-item').getByText('Owned by you', { exact: true }).waitFor();
    assert.equal(await page.locator('.grain-item .grain-name').first().innerText(), 'Zebra shared');
    await page.screenshot({path:'/tmp/sandstorm-rust-ui-grains.png',fullPage:true});
    await page.getByLabel('Sort by').selectOption('title');
    assert.equal(await page.locator('.grain-item .grain-name').first().innerText(), 'Alice grain');
    await page.getByLabel('Filter shown grains').fill('editor');
    assert.equal(await page.locator('.grain-item').count(), 1);
    await page.getByLabel('Filter shown grains').fill('');
    await page.getByLabel('Show', { exact: true }).selectOption('shared');
    assert.equal(await page.locator('.grain-item .grain-name').innerText(), 'Zebra shared');
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
    await page.getByRole('link', { name: 'Alice grain', exact: true }).click();
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
    await expect.poll(() => liveGrains.size).toBe(1);
    await page.goForward();
    await page.frameLocator('iframe').getByRole('heading', { name: 'Embedded test grain' }).waitFor();
    const app = page.frames().find((frame) => frame.url().startsWith(grainOrigin));
    await app.evaluate(() => { window.renameFrameMarker = 'still here'; });
    await app.getByLabel('App state').fill('background draft');
    const firstSession = await page.locator('iframe').getAttribute('src');
    await page.getByRole('link', {name:'Grains',exact:true}).click();
    await page.getByRole('link', { name: 'Zebra shared', exact: true }).click();
    await expect(page.locator('iframe')).toHaveCount(2);
    await expect.poll(() => liveGrains.size).toBe(2);
    await expect(page.locator('iframe:visible')).toHaveAttribute('title','Zebra shared');
    const secondSession = await page.locator('iframe:visible').getAttribute('src');
    await page.frameLocator('iframe:visible').getByLabel('App state').fill('second draft');
    await app.evaluate(() => parent.postMessage({setPath:'/background-path'}, '*'));
    await expect(page.getByRole('link',{name:'Switch to Alice grain'})).toHaveAttribute('href','/grain/alice-grain/background-path');
    assert.equal(new URL(page.url()).pathname, '/grain/alice-extra');
    await page.getByRole('link',{name:'Switch to Alice grain'}).click();
    await expect(page.locator('iframe:visible')).toHaveAttribute('src',firstSession);
    assert.equal(await app.getByLabel('App state').inputValue(),'background draft');
    await page.getByRole('link',{name:'Switch to Zebra shared'}).click();
    await expect(page.locator('iframe:visible')).toHaveAttribute('src',secondSession);
    await expect(page.frameLocator('iframe:visible').getByLabel('App state')).toHaveValue('second draft');
    await expect.poll(() => page.getByRole('link',{name:'Switch to Zebra shared'}).locator('img').evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
    const frameBox = await page.locator('iframe:visible').boundingBox();
    const headerBox = await page.locator('header').boundingBox();
    const sideBox = await page.getByRole('complementary').boundingBox();
    assert.equal(frameBox.x,sideBox.width);
    assert.equal(frameBox.y,headerBox.height);
    assert.equal(frameBox.width,page.viewportSize().width-sideBox.width);
    assert.equal(frameBox.height,page.viewportSize().height-headerBox.height);
    const accountTrigger = page.getByRole('button',{name:'Account: Alice',exact:true});
    await accountTrigger.click();
    const accountBounds = await page.locator('.account-menu').boundingBox();
    const triggerBounds = await accountTrigger.boundingBox();
    assert.ok(accountBounds.y >= triggerBounds.y + triggerBounds.height);
    assert.ok(accountBounds.y < triggerBounds.y + triggerBounds.height + 12);
    assert.ok(accountBounds.y + accountBounds.height <= page.viewportSize().height);
    await page.keyboard.press('Escape');
    await page.screenshot({path:'/tmp/sandstorm-rust-ui-workspace.png'});
    await page.setViewportSize({width:390,height:844});
    await page.getByRole('button',{name:'Collapse sidebar',exact:true}).click();
    const toggleBox = await page.getByRole('button',{name:'Expand sidebar',exact:true}).boundingBox();
    assert.ok(toggleBox.x >= 0 && toggleBox.x+toggleBox.width <= 56, 'Collapsed toggle stays fully visible');
    const mobileFrame = await page.locator('iframe:visible').boundingBox();
    assert.equal(mobileFrame.x,56);
    assert.equal(mobileFrame.y,(await page.locator('header').boundingBox()).height);
    assert.equal(mobileFrame.y+mobileFrame.height,844);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
    await page.screenshot({path:'/tmp/sandstorm-rust-ui-workspace-mobile.png'});
    await page.setViewportSize({width:1280,height:720});
    await page.getByRole('button',{name:'Expand sidebar',exact:true}).click();
    await page.locator('.open-grains li.current button').click();
    await expect.poll(() => liveGrains.size).toBe(1);
    await expect(page.locator('iframe')).toHaveCount(1);
    await page.getByRole('link',{name:'Switch to Alice grain'}).click();
    assert.equal(await app.evaluate(() => window.renameFrameMarker),'still here');
    await page.getByRole('link',{name:'Notifications',exact:true}).hover();
    await expect(page.locator('.grain-title:visible .rename-action')).toHaveCSS('opacity','0');
    await page.locator('.grain-title:visible').hover();
    await expect(page.locator('.grain-title:visible .rename-action')).toHaveCSS('opacity','1');
    const currentRow = page.locator('.open-grains li.current');
    await expect(currentRow.locator('.close-grain')).toHaveCSS('opacity','0');
    await currentRow.hover();
    await expect(currentRow.locator('.close-grain')).toHaveCSS('opacity','1');
    await expect(currentRow.locator('a span')).toHaveCSS('text-overflow','ellipsis');
    const grainIcon = await currentRow.locator('svg, img').first().boundingBox();
    const navIcon = await page.getByRole('link',{name:'Grains',exact:true}).locator('svg').boundingBox();
    assert.equal(grainIcon.x,navIcon.x);
    assert.equal(grainIcon.width,navIcon.width);
    assert.equal(await page.locator('header').getByRole('link',{name:/Main shell/}).count(),0);
    await page.screenshot({path:'/tmp/sandstorm-rust-ui-grain.png',fullPage:true});
    await page.locator('.grain-title:visible').hover();
    await page.getByRole('button', {name:'Rename grain',exact:true}).click();
    const dialog = page.getByRole('dialog', {name:'Rename grain',exact:true});
    await expect(dialog).toBeVisible();
    await expect(page.getByLabel('Grain title', {exact:true})).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('button', {name:'Cancel rename',exact:true})).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Grain title', {exact:true})).toBeFocused();
    assert.equal(await dialog.evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(255, 255, 255)');
    await page.screenshot({path:'/tmp/sandstorm-rust-ui-dialog.png'});
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', {name:'Rename grain',exact:true})).toBeFocused();
    await page.locator('.grain-title:visible').hover();
    await page.getByRole('button', {name:'Rename grain',exact:true}).click();

    await page.getByLabel('Grain title', {exact:true}).fill('Renamed in Rust with a long title that must fit in the sidebar');
    await page.getByRole('button', {name:'Save title',exact:true}).click();
    await page.getByRole('heading', {name:'Renamed in Rust with a long title that must fit in the sidebar',exact:true}).waitFor();
    assert.equal(grainTitles.alice,'Renamed in Rust with a long title that must fit in the sidebar');
    await page.screenshot({path:'/tmp/sandstorm-rust-ui-long-title.png'});
    assert.ok(await page.locator('.open-grains li.current a span').evaluate(label => label.scrollWidth > label.clientWidth));
    assert.equal(await app.evaluate(() => window.renameFrameMarker),'still here');
    grainTitles.alice = 'Legacy rename'; changed();
    await page.getByRole('heading', {name:'Legacy rename',exact:true}).waitFor();
    assert.equal(await app.evaluate(() => window.renameFrameMarker),'still here');
    await page.locator('.grain-title:visible').hover();
    await page.getByRole('button', {name:'Rename grain',exact:true}).click();
    await page.getByLabel('Grain title', {exact:true}).fill('Alice grain');
    await page.getByRole('button', {name:'Save title',exact:true}).click();
    await page.getByRole('heading', {name:'Alice grain',exact:true}).waitFor();

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
    await app.evaluate(() => parent.postMessage({ getGrainTitle: {}, subscribe: true, rpcId:'subscribed-title' }, '*'));
    await expect.poll(() => app.evaluate(() => window.reply?.rpcId)).toBe('subscribed-title');
    grainTitles.alice = 'Owner rename'; changed();
    await expect.poll(() => app.evaluate(() => window.reply?.grainTitle)).toBe('Owner rename');
    grainTitles.alice = 'Alice grain'; changed();
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
    await app.evaluate(() => parent.postMessage({renderTemplate:{rpcId:'client',template:'Connect desktop client',clientapp:'DaVrOs'}}, '*'));
    await expect.poll(() => app.evaluate(() => window.reply?.rpcId)).toBe('client');
    const clientOffer = await app.evaluate(() => {
      const iframe = document.createElement('iframe'); iframe.id = 'client-offer'; iframe.src = window.reply.uri;
      document.body.appendChild(iframe);
      return window.reply;
    });
    assert.deepEqual(Object.keys(clientOffer).sort(), ['rpcId', 'uri']);
    assert.equal(clientOffer.uri.includes('sensitive'), false);
    const clientFrame = app.frameLocator('#client-offer');
    await expect(clientFrame.getByRole('link', {name:'Connect desktop client'})).toHaveAttribute('href',
      `clientapp-davros:https://${new URL(grainOrigin).host}#sensitive-template-token`);
    await expect(clientFrame.locator('#link')).toHaveAttribute('rel', 'noopener noreferrer');
    assert.equal(await app.evaluate(() => {
      try { return !!document.getElementById('client-offer').contentWindow.document.body; } catch { return false; }
    }), false, 'app must not read the desktop client credential');
    // Display options share the same canonical token; invalid schemes issue nothing.
    assert.equal(templates, 1);
    for (const clientapp of ['javascript:alert(1)', 'foo/bar', 'foo\\bar', 'foo\nbar', 'x'.repeat(129), 42, {}]) {
      await app.evaluate(clientapp => parent.postMessage({renderTemplate:{rpcId:'invalid-client',template:'Connect',clientapp}}, '*'), clientapp);
      await expect.poll(() => app.evaluate(() => window.reply?.rpcId)).toBe('invalid-client');
      assert.match(await app.evaluate(() => window.reply.error), /Invalid template request/);
      await app.evaluate(() => { window.reply = null; });
    }
    assert.equal(templates, 1);
    await page.evaluate(uri => sessionStorage.removeItem('rustOfferTemplate:' + new URL(uri).hash.slice(1)), clientOffer.uri);
    await expect(clientFrame.locator('#link')).toHaveCount(0);
    await expect(clientFrame.locator('#text')).toContainText('expired');
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

    // App requests only prompt; a user click opens the trusted sharing window.
    await app.evaluate(() => parent.postMessage({startSharing:{pathname:'/folder',hash:'#document'}}, '*'));
    await page.getByText('Open sharing in Sandstorm.', {exact:true}).waitFor();
    const sharingOpened = page.waitForEvent('popup');
    await page.getByRole('button', {name:'Open sharing window',exact:true}).click();
    const sharingPopup = await sharingOpened;
    await sharingPopup.waitForURL(mainOrigin + '/rust-shell-sharing');
    await sharingPopup.waitForLoadState();
    await expect.poll(() => sharingPopup.evaluate(() => window.request?.mode)).toBe('share');
    const sharingRequest = await sharingPopup.evaluate(() => window.request);
    assert.deepEqual(sharingRequest.shareData, {pathname:'/folder',hash:'#document'});
    assert.equal(sharingPopup.url(), mainOrigin + '/rust-shell-sharing');
    assert.equal(new URL(sharingPopup.url()).search + new URL(sharingPopup.url()).hash, '');
    assert.equal(typeof sharingRequest.sessionId, 'string');
    assert.ok(sharingRequest.sessionId);
    await page.getByText('Sharing is open in Sandstorm.', {exact:true}).waitFor();
    await sharingPopup.evaluate(origin => opener.postMessage({type:'rust-sharing-result',nonce:'forged',error:'Forged sharing error'}, origin), proxy.origin);
    await page.evaluate(origin => dispatchEvent(new MessageEvent('message', {origin,source:window,
      data:{type:'rust-sharing-result',nonce:'forged',error:'Forged sharing error'}})), mainOrigin);
    assert.equal(await page.getByText('Forged sharing error').count(), 0);
    await page.getByRole('button', {name:'Close sharing window',exact:true}).click();
    await expect.poll(() => sharingPopup.isClosed()).toBe(true);
    await app.evaluate(() => parent.postMessage({startSharing:{pathname:'/%2e%2e/escape'}}, '*'));
    assert.equal(await page.getByRole('button', {name:'Open sharing window',exact:true}).count(), 0);
    const accessOpened = page.waitForEvent('popup');
    await page.getByRole('button', {name:'Who has access',exact:true}).click();
    const accessPopup = await accessOpened;
    await accessPopup.waitForURL(mainOrigin + '/rust-shell-sharing');
    await accessPopup.waitForLoadState();
    await expect.poll(() => accessPopup.evaluate(() => window.request?.mode)).toBe('access');
    await accessPopup.close();
    await expect(page.getByRole('button', {name:'Close sharing window',exact:true})).toHaveCount(0);

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
    assert.equal(await popup.evaluate(() => window.request.sessionId), new URL(firstSession).searchParams.get('sessionid'));
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
    await page.locator('.open-grains li.current button').click();
    await expect.poll(() => grainClosePopup.isClosed()).toBe(true);
    assert.equal(await page.evaluate(() => Object.keys(sessionStorage).filter(k => k.startsWith('rustOfferTemplate:')).length), 0);
    await expect.poll(() => liveGrains.size).toBe(0);
    await page.getByRole('link', { name: 'Alice grain', exact: true }).click();
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
    await page.getByRole('link', { name: 'Notifications', exact: true }).click();
    await page.getByRole('heading', { name: /Alice notification/ }).waitFor();
    await expect.poll(() => liveGrains.size).toBe(1);
    const cookie = (await context.cookies()).find((cookie) => cookie.name === '__Host-sandstorm-rust-session');
    assert.equal(cookie.httpOnly, true); assert.equal(cookie.secure, true); assert.equal(cookie.sameSite, 'Lax');
    assert.equal(await page.evaluate(() => document.cookie.includes('__Host-sandstorm-rust-session')), false);
    await page.evaluate(() => sessionStorage.setItem('rustOfferTemplate:orphaned-before-reload', 'stale credential'));
    await page.reload();
    await page.getByRole('heading', { name: /Alice notification/ }).waitFor();
    assert.equal(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('rustOfferTemplate:')).length), 0,
      'a shell reload must clear stale template credentials even without opening a grain');
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
    await racing.getByRole('link', { name: 'Alice grain', exact: true }).click();
    await expect.poll(() => !!releaseOpen).toBe(true);
    await racing.getByRole('link', {name:'Notifications', exact:true}).click();
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
    await page.getByRole('button', {name:'Account: Alice',exact:true}).click();
    await page.getByRole('link', { name: 'Switch account' }).click();
    await page.getByRole('button', { name: 'Connect Bob' }).click();
    await page.getByRole('heading', { name: /Bob notification/ }).waitFor();
    await other.getByRole('heading', { name: /Bob notification/ }).waitFor();
    assert.equal(await other.getByRole('heading', { name: /Alice notification/ }).count(), 0);
    await other.getByRole('link', { name: 'Grains', exact: true }).click();
    await other.getByRole('link', { name: 'Bob grain', exact: true }).waitFor();
    await other.locator('.grain-item').getByText('Shared with you', { exact: true }).waitFor();
    assert.equal(await other.getByRole('link', { name: 'Alice grain', exact: true }).count(), 0);
    await other.getByRole('link', { name: 'Bob grain', exact: true }).click();
    await other.frameLocator('iframe').getByRole('heading', { name: 'Embedded test grain' }).waitFor();
    await other.frameLocator('iframe').locator('body').evaluate(() => parent.postMessage({ getGrainTitle: {}, rpcId: 'shared-title' }, '*'));
    await expect.poll(() => other.frameLocator('iframe').locator('body').evaluate(() => window.reply?.grainTitle)).toBe('Owner title');
    await page.getByRole('button', {name:'Account: Bob',exact:true}).click();
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
