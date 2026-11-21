import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { createServer, get } from 'node:https';
import { request } from 'node:http';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { chromium } from '@playwright/test';
import { start, stop } from './harness.mjs';

// Exercises the installed transport arrangement (HTTPS -> private Unix HTTP ->
// Axum, including WSS). The actual Sandstorm TLS manager is checked on deployment.
test('HTTPS origin and WSS through a private Unix socket', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rust-shell-https-'));
  const socketPath = join(directory, 'http.sock');
  let proxy, browser, rust;
  const connections = new Set();
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')], { stdio: 'ignore' });
    const cert = await readFile(join(directory, 'cert.pem'));
    proxy = createServer({ cert, key: await readFile(join(directory, 'key.pem')) }, (req, res) => {
      const upstream = request({ socketPath, method: req.method, path: req.url, headers: req.headers }, (response) => {
        res.writeHead(response.statusCode, response.headers); response.pipe(res);
      });
      upstream.on('error', () => { res.writeHead(502); res.end(); });
      req.pipe(upstream);
    });
    proxy.on('connection', (socket) => { connections.add(socket); socket.on('close', () => connections.delete(socket)); });
    proxy.on('upgrade', (req, downstream, head) => {
      const upstream = createConnection(socketPath, () => {
        upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
        for (let i = 0; i < req.rawHeaders.length; i += 2) upstream.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`);
        upstream.write('\r\n'); upstream.write(head);
        downstream.pipe(upstream); upstream.pipe(downstream);
      });
      upstream.on('error', () => downstream.destroy());
      downstream.on('error', () => upstream.destroy());
      downstream.on('close', () => upstream.destroy());
    });
    proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
    const origin = `https://localhost:${proxy.address().port}`;
    rust = (await start('debug/sandstorm-rust-shell', [], {
      RUST_SHELL_SOCKET: socketPath, RUST_SHELL_ORIGIN: origin,
      RUST_SHELL_MAIN_URL: 'https://main.example.test', RUST_SHELL_FIXTURE_SOCKET: '',
    }, /Rust shell: (https:\/\/\S+)/)).child;
    assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
    // Verify TLS with an explicit test CA; do not disable certificate validation.
    const status = await new Promise((resolve, reject) => {
      get(`${origin}/healthz`, { ca: cert }, (response) => { response.resume(); resolve(response.statusCode); }).on('error', reject);
    });
    assert.equal(status, 200);
    const spki = new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' });
    const pin = createHash('sha256').update(spki).digest('base64');
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium',
      headless: true, args: [`--ignore-certificate-errors-spki-list=${pin}`] });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let websocket;
    page.on('websocket', (ws) => { websocket = ws.url(); });
    await page.goto(origin);
    await page.getByRole('status').filter({ hasText: /^ready$/ }).waitFor();
    assert.equal(websocket, origin.replace('https:', 'wss:') + '/rpc');
    await page.getByRole('button', { name: 'Add test notification' }).click();
    await page.getByRole('heading', { name: 'Test notification 2' }).waitFor();
    const rejected = await page.evaluate(() => new Promise((resolve) => {
      const ws = new WebSocket(location.origin.replace('https:', 'wss:').replace('localhost', '127.0.0.1') + '/rpc');
      ws.onopen = () => { ws.close(); resolve(false); }; ws.onerror = () => resolve(true);
    }));
    assert.equal(rejected, true, 'wrong Host must be rejected even over TLS');
    const wrongHost = await page.request.get(`${origin}/auth/start`, { headers: {Host:'foreign.example'}, ignoreHTTPSErrors:true });
    assert.equal(wrongHost.status(),403,'ordinary auth endpoints reject a foreign Host too');
    const redirect = await page.request.get(`${origin}/main-shell`, { maxRedirects: 0, ignoreHTTPSErrors: true });
    assert.equal(redirect.headers().location, 'https://main.example.test');
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await stop(rust);
    for (const socket of connections) socket.destroy();
    if (proxy) await new Promise((resolve) => proxy.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
