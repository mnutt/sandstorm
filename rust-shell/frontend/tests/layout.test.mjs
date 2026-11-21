import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium, expect } from '@playwright/test';
import { start, stop } from './harness.mjs';

test('sidebar preference survives reloads; navigation stays pinned while content scrolls', { timeout: 60000 }, async () => {
  let browser, server;
  try {
    const running = await start('debug/sandstorm-rust-shell', [], {
      RUST_SHELL_ADDR: '127.0.0.1:0', RUST_SHELL_FIXTURE_SOCKET: '',
    }, /Rust shell: (http:\/\/\S+)/);
    server = running.child;
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', headless: true });
    const page = await browser.newPage({viewport:{width:1280,height:720}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const ready = () => page.getByRole('status').filter({hasText:/^ready$/}).waitFor();
    await page.goto(running.match[1]);
    await ready();
    const sidebar = page.getByRole('complementary', {name:'Shell navigation'});
    const expandedWidth = (await sidebar.boundingBox()).width;
    await page.getByRole('button', {name:'Collapse sidebar',exact:true}).click();
    await expect(page.getByRole('button', {name:'Expand sidebar',exact:true})).toHaveAttribute('aria-expanded','false');
    assert.ok((await sidebar.boundingBox()).width < expandedWidth / 2);
    await expect(sidebar.getByRole('link',{name:'Apps',exact:true})).toBeVisible();
    await page.reload();
    await ready();
    await expect(page.getByRole('button', {name:'Expand sidebar',exact:true})).toBeVisible();
    await page.screenshot({path:'/tmp/sandstorm-rust-ui-collapsed.png',fullPage:true});
    await sidebar.getByRole('link',{name:'Apps',exact:true}).click();
    await expect(sidebar.getByRole('link',{name:'Apps',exact:true})).toHaveAttribute('aria-current','page');
    await page.getByRole('button', {name:'Expand sidebar',exact:true}).click();
    await page.reload();
    await expect(page.getByRole('button', {name:'Collapse sidebar',exact:true})).toBeVisible();
    assert.equal((await sidebar.boundingBox()).width, expandedWidth);
    await page.getByRole('link',{name:'Notifications',exact:true}).click();
    await ready();
    for (let i=0;i<12;++i) {
      await page.getByRole('button',{name:'Add test notification'}).click();
      await expect(page.locator('.notification-item')).toHaveCount(i+2);
    }
    await page.evaluate(() => scrollTo(0,400));
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(100);
    assert.equal(Math.round((await page.locator('header').boundingBox()).y),0);
    assert.equal(Math.round((await sidebar.boundingBox()).y),Math.round((await page.locator('header').boundingBox()).height));
    const account = page.getByRole('button',{name:'Account: Fixture mode',exact:true});
    await account.click();
    const menu = page.locator('.account-menu');
    await expect(menu).toBeVisible();
    await expect.poll(async () => (await menu.boundingBox()).y).toBeLessThan(60);
    const bounds = await menu.boundingBox();
    assert.ok(bounds.y >= (await account.boundingBox()).height);
    assert.ok(bounds.y + bounds.height <= 720);
    await page.screenshot({path:'/tmp/sandstorm-rust-ui-account.png'});
    await page.keyboard.press('Escape');
    await expect(account).toBeFocused();
    await page.screenshot({path:'/tmp/sandstorm-rust-ui-sticky.png'});
    for (const width of [390,320]) {
      await page.setViewportSize({width,height:844});
      await page.evaluate(() => scrollTo(0,300));
      await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(100);
      assert.equal(Math.round((await page.locator('header').boundingBox()).y),0);
      assert.equal(Math.round((await sidebar.boundingBox()).y),Math.round((await page.locator('header').boundingBox()).height));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
    }
    await page.getByRole('button', {name:'Collapse sidebar',exact:true}).click();
    assert.equal((await sidebar.boundingBox()).width,56);
    await page.reload();
    await ready();
    assert.equal((await sidebar.boundingBox()).width,56);
    await page.getByRole('button', {name:'Expand sidebar',exact:true}).click();
    assert.equal((await sidebar.boundingBox()).width,208);
    // Storage refusal must not break the shell or the in-memory toggle.
    const restricted = await browser.newPage();
    await restricted.addInitScript(() => {
      Storage.prototype.getItem = () => { throw new DOMException('Blocked','SecurityError'); };
      Storage.prototype.setItem = () => { throw new DOMException('Blocked','SecurityError'); };
    });
    await restricted.goto(running.match[1]);
    await restricted.getByRole('button', {name:'Collapse sidebar',exact:true}).click();
    await expect(restricted.getByRole('button', {name:'Expand sidebar',exact:true})).toBeVisible();
    await restricted.close();
    assert.deepEqual(errors,[]);
  } finally { await browser?.close(); await stop(server); }
});
