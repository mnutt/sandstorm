import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { start, stop, serveProbe } from './harness.mjs';

test('browser ↔ Rust ↔ C++ forwarding, streams, release and backend restart', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rust-shell-interop-'));
  const socket = join(directory, 'fixture.sock');
  let fixture, server, browser;
  try {
    fixture = (await start('cpp-fixture', [socket], {}, /C\+\+ fixture ready/)).child;
    const running = await start('debug/sandstorm-rust-shell', [], {
      RUST_SHELL_ADDR: '127.0.0.1:0', RUST_SHELL_FIXTURE_SOCKET: socket,
    }, /Rust shell: (http:\/\/\S+)/);
    server = running.child;
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(running.match[1]);
    await serveProbe(page, './interop-probe.ts', 'interop-probe.js');
    const result = await page.evaluate(async () => (await import('/interop-probe.js')).runInterop());
    assert.deepEqual(result, {
      value: 42, callback: 42, bytes: 65536, received: 4,
      backpressure: true, cancelled: true, released: true, exception: true,
    });
    assert.equal(await page.evaluate(async () => (await import('/interop-probe.js')).holdCounter()), 10);
    await stop(fixture); fixture = undefined;
    assert.equal(await page.evaluate(async () => (await import('/interop-probe.js')).useHeldCounter()), true);
    // Only remove the dead fixture's socket in this test's private temp directory.
    await rm(socket, { force: true });
    fixture = (await start('cpp-fixture', [socket], {}, /C\+\+ fixture ready/)).child;
    assert.equal(await page.evaluate(async () => (await import('/interop-probe.js')).useHeldCounter()), true);
    assert.equal(await page.evaluate(async () => (await import('/interop-probe.js')).freshCounter()), 99);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await stop(server);
    await stop(fixture);
    await rm(directory, { recursive: true, force: true });
  }
});
