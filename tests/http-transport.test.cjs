// NODE_PATH=shell/node_modules node --test tests/http-transport.test.cjs
const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const loadTransport = require('./helpers/http-transport.cjs');

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function perform(transport, url, options = {}) {
  const operation = transport.startHttpRequest({
    db: {}, url, method: 'GET', headers: {}, consumeResponse: transport.readHttpBody,
    timeoutMs: 1000, ...options,
  });
  operation.started.then(req => req.end(options.body), () => {});
  return operation.completion;
}

test('base URL and relative path confinement, including empty and trailing slash behavior', () => {
  const { validateBaseUrl, buildHttpUrl } = loadTransport();
  for (const url of [
    'https://example.com/api/../outside', 'https://example.com/api/%2e%2e/outside',
    'https://example.com/api%2foutside', 'https://example.com/api%5coutside',
    'https://example.com/api\\outside', 'https://example.com/api/%zz',
    'https://user:secret@example.com/api', 'https://example.com/api?query',
    'https://example.com/api#fragment', 'https://example.com/a\nb',
  ]) assert.throws(() => validateBaseUrl(url));
  const base = validateBaseUrl('https://example.com/v1');
  for (const suffix of ['', '/']) {
    assert.equal(buildHttpUrl(base + suffix, 'responses'), base + '/responses');
    assert.equal(buildHttpUrl(base + suffix, ''), base + suffix);
  }
  assert.equal(buildHttpUrl(base, 'responses?text=a%20b'), base + '/responses?text=a%20b');
  for (const path of [
    '/outside', '//evil.com', 'https://evil.com', '../outside', '%2e%2e/outside',
    '.%2E/outside', 'a/../../b', 'a%2Fb', 'a%5cb', 'a\\b', 'a/%zz', 'a#fragment',
    '\nhttps://evil.com', 'a?query=%zz',
  ]) assert.throws(() => buildHttpUrl(base, path));
});

test('header names normalize and reject duplicates, transport controls and injection', () => {
  const { sanitizeHeaders } = loadTransport();
  assert.equal(sanitizeHeaders([{ name: 'X-Test', value: 'ok' }])['x-test'], 'ok');
  for (const name of ['Host', 'Connection', 'Content-Length', 'Proxy-Authorization',
    'Transfer-Encoding', 'Sec-Fetch-Site', 'X-Forwarded-For']) {
    assert.throws(() => sanitizeHeaders([{ name, value: 'value' }]));
  }
  assert.throws(() => sanitizeHeaders([
    { name: 'X-Test', value: 'a' }, { name: 'x-test', value: 'b' },
  ]));
  assert.throws(() => sanitizeHeaders([{ name: 'x-test', value: 'a\r\nb' }]));
});

test('resolves policy on each request, retains Host, and never follows redirects', async t => {
  const seen = [];
  const base = await serve(t, (req, res) => {
    seen.push({ path: req.url, headers: req.headers });
    res.writeHead(302, { location: '/steal-key' });
    res.end('redirect');
  });
  let lookups = 0;
  const transport = loadTransport({ ssrfSafeLookupOrProxy: async (db, url) => {
    lookups++;
    return { url: base + new URL(url).pathname, host: 'approved.example' };
  } });
  for (let i = 0; i < 2; i++) {
    const result = await perform(transport, 'http://approved.example/v1/responses', {
      getAuthorization: async () => 'Bearer remote-secret',
    });
    assert.equal(result.toString(), 'redirect');
  }
  assert.equal(lookups, 2);
  assert.equal(seen.length, 2);
  seen.forEach(({ path, headers }) => {
    assert.equal(path, '/v1/responses');
    assert.equal(headers.host, 'approved.example');
    assert.equal(headers.authorization, 'Bearer remote-secret');
  });
});

test('proxy requests use the approved destination and do not follow redirects', async t => {
  let received;
  const proxy = await serve(t, (req, res) => {
    received = { url: req.url, headers: req.headers };
    res.writeHead(302, { location: 'http://other.example/steal' });
    res.end('proxy response');
  });
  const transport = loadTransport({ ssrfSafeLookupOrProxy: async () => ({ proxy }) });
  const result = await perform(transport, 'http://approved.example/v1/responses', {
    getAuthorization: async () => 'Bearer remote-secret',
  });
  assert.equal(result.toString(), 'proxy response');
  assert.equal(received.url, 'http://approved.example/v1/responses');
  assert.equal(received.headers.host, 'approved.example');
  assert.equal(received.headers.authorization, 'Bearer remote-secret');
});

test('deadline includes unresolved DNS and authorization, without later network activity', async () => {
  let finishLookup;
  let requests = 0;
  let authorizations = 0;
  const transport = loadTransport({
    Http: { request() { requests++; throw new Error('should not request'); } },
    ssrfSafeLookupOrProxy: () => new Promise(resolve => { finishLookup = resolve; }),
  });
  await assert.rejects(perform(transport, 'http://example.com', {
    timeoutMs: 10, getAuthorization: () => { authorizations++; },
  }), { kjType: 'overloaded' });
  finishLookup({ url: 'http://127.0.0.1', host: 'example.com' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 0);
  assert.equal(authorizations, 0);
  const normal = loadTransport();
  await assert.rejects(perform(normal, 'http://example.com', {
    timeoutMs: 10, getAuthorization: () => new Promise(() => {}),
  }), { kjType: 'overloaded' });
});

test('truncated bodies fail; deadlines destroy stalled responses; cancellation closes sockets', async t => {
  const base = await serve(t, (req, res) => {
    if (req.url === '/truncated') {
      res.writeHead(200, { 'Content-Length': '100' });
      res.write('partial');
      setImmediate(() => res.destroy());
    } else {
      res.writeHead(200);
      res.write('partial');
    }
  });
  const transport = loadTransport();
  await assert.rejects(perform(transport, base + '/truncated'), { kjType: 'disconnected' });
  await assert.rejects(perform(transport, base + '/stalled', { timeoutMs: 20 }),
      { kjType: 'overloaded' });
  const operation = transport.startHttpRequest({ db: {}, url: base + '/cancel', method: 'GET',
    headers: {}, consumeResponse: transport.readHttpBody });
  const req = await operation.started;
  req.end();
  await operation.response;
  operation.cancel();
  await assert.rejects(operation.completion, { kjType: 'disconnected' });
  assert.equal(req.destroyed, true);
});

test('TLS uses original hostname for verification and pins the approved IP', async () => {
  let options;
  const transport = loadTransport({
    ssrfSafeLookupOrProxy: async () => ({ url: 'https://192.0.2.1/v1', host: 'approved.example:443' }),
    Https: { request(value) {
      options = value;
      const req = new EventEmitter();
      req.destroy = () => {};
      req.end = () => req.emit('error', new Error('TLS failure with secret'));
      return req;
    } },
  });
  await assert.rejects(perform(transport, 'https://approved.example/v1'), error => {
    assert.equal(error.kjType, 'disconnected');
    assert.ok(!error.message.includes('secret'));
    return true;
  });
  assert.equal(options.hostname, '192.0.2.1');
  assert.equal(options.servername, 'approved.example');
  assert.equal(options.headers.host, 'approved.example:443');
});

test('DNS and response-consumer failures reject cleanly', async t => {
  const failedLookup = loadTransport({ ssrfSafeLookupOrProxy: async () => {
    throw new Error('DNS failed');
  } });
  await assert.rejects(perform(failedLookup, 'http://example.com'), { kjType: 'disconnected' });
  const base = await serve(t, (req, res) => res.end('body'));
  await assert.rejects(perform(loadTransport(), base, {
    consumeResponse: async () => { throw new Error('write rejected'); },
  }), { kjType: 'disconnected' });
});

test('legacy outbound adapter shares transport, streams response and drops failed streams', async t => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  let registration;
  const source = fs.readFileSync(path.join(__dirname,
      '../shell/imports/server/drivers/outbound-http-session.js'), 'utf8')
      .replace(/^import [\s\S]*?;\n/gm, '');
  vm.runInNewContext(source, {
    ...loadTransport(), Buffer,
    Meteor: { startup: fn => fn(), Error: class extends Error {
      constructor(code, message) { super(message); }
    } },
    Match: { Optional() {}, OneOf() {} }, check() {}, PersistentImpl: class {},
    globalFrontendRefRegistry: { register(value) { registration = value; } },
    Capnp: {
      importSystem: () => ({ OutboundHttpSession: { typeId: 'outbound' } }),
      Capability: class { constructor(value) { return value; } },
    },
  });
  const baseUrl = await serve(t, (req, res) => {
    res.writeHead(200);
    res.write('first');
    setImmediate(() => {
      if (req.url === '/failed') res.destroy();
      else res.end('last');
    });
  });
  const session = registration.restore({}, {}, { baseUrl });
  for (const route of ['ok', 'failed']) {
    const chunks = [];
    let done = false;
    let release;
    const released = new Promise(resolve => { release = resolve; });
    const response = await session.request('get', route, [], Buffer.alloc(0), {
      async write(chunk) { chunks.push(chunk); },
      async done() { done = true; },
      close() { release(); },
    });
    assert.equal(response.statusCode, 200);
    await released;
    assert.equal(done, route === 'ok');
    if (done) assert.equal(Buffer.concat(chunks).toString(), 'firstlast');
  }
  session.close();
});
