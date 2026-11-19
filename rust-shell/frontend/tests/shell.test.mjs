import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium, expect } from '@playwright/test';
import { start, stop, serveProbe } from './harness.mjs';

test('browser ↔ Rust RPC, subscription lifecycle, isolation and admission', { timeout: 60000 }, async () => {
  let browser, server;
  try {
    const running = await start('debug/sandstorm-rust-shell', [], {
      RUST_SHELL_ADDR: '127.0.0.1:0', RUST_SHELL_FIXTURE_SOCKET: '',
    }, /Rust shell: (http:\/\/\S+)/);
    server = running.child;
    const origin = running.match[1];
    assert.match(await (await fetch(`${origin}/healthz`)).text(), /fixture spike/);
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin);
    await page.getByRole('status').filter({ hasText: /^ready$/ }).waitFor();
    assert.equal(await page.locator('.notification-item').count(), 1);
    await page.screenshot({path:'/tmp/sandstorm-rust-ui-desktop.png',fullPage:true});
    const unstyled = await page.evaluate(() => {
      const section = document.createElement('section');
      const button = document.createElement('button');
      button.textContent = 'Unrelated control'; section.append(button); document.body.append(section);
      const result = {sectionBorder:getComputedStyle(section).borderTopWidth,buttonHeight:button.getBoundingClientRect().height};
      section.remove(); return result;
    });
    assert.equal(unstyled.sectionBorder,'0px');
    assert.ok(unstyled.buttonHeight < 44, 'Shared button styles must not reach unrelated native buttons');
    await page.getByRole('button', { name: 'Add test notification' }).click();
    await page.getByRole('heading', { name: 'Test notification 2' }).waitFor();
    await page.getByRole('button', { name: 'Dismiss Test notification 2' }).click();
    await page.getByRole('heading', { name: 'Test notification 2' }).waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Dismiss Welcome to the Rust shell' }).click();
    await page.getByText('You have no notifications.').waitFor();
    const second = await browser.newPage();
    await second.goto(origin);
    await second.getByRole('heading', { name: 'Welcome to the Rust shell' }).waitFor();
    await second.close();
    await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await page.getByRole('heading', { name: 'Welcome to the Rust shell' }).waitFor();

    await serveProbe(page, './rpc-probe.ts', 'rpc-probe.js');
    const result = await page.evaluate(async () => (await import('/rpc-probe.js')).probe());
    assert.deepEqual(result, { fixtureDisabled: true, duplicateRejected: true, oldCancelSafe: true, cancelled: true, limitRejected: true, entries: 50 });

    // A browser on another port is a different origin, even on the same host.
    const foreign = await browser.newPage();
    await foreign.route('http://127.0.0.1:45678/**', (route) => route.fulfill({ contentType: 'text/html', body: '<p>Foreign origin</p>' }));
    await foreign.goto('http://127.0.0.1:45678/');
    const rejected = await foreign.evaluate((url) => new Promise((resolve) => {
      const ws = new WebSocket(url.replace('http', 'ws') + '/rpc');
      ws.onopen = () => { ws.close(); resolve(false); }; ws.onerror = () => resolve(true);
    }), origin);
    assert.equal(rejected, true);
    await foreign.close();

    for (const payload of ['text', new Array(8).fill(255), new Array(256 * 1024 + 1).fill(0)]) {
      const closed = await page.evaluate((payload) => new Promise((resolve) => {
        const ws = new WebSocket(location.origin.replace('http', 'ws') + '/rpc');
        ws.onopen = () => ws.send(typeof payload === 'string' ? payload : new Uint8Array(payload));
        ws.onclose = () => resolve(true);
        setTimeout(() => { ws.close(); resolve(false); }, 3000);
      }), payload);
      assert.equal(closed, true);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button',{name:'Collapse sidebar',exact:true}).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({path:'/tmp/sandstorm-rust-ui-mobile.png',fullPage:true});
    assert.ok((await page.locator('#notifications-title').boundingBox()).y < 200, 'Mobile content starts below the compact navigation');
    const account = page.getByRole('button', {name:'Account: Fixture mode',exact:true});
    await account.click();
    await expect(page.getByRole('link', {name:'Account',exact:true})).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('link', {name:'Account',exact:true})).toHaveCount(0);
    await expect(account).toBeFocused();

    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await stop(server);
  }
});
