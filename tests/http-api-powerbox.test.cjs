// Run with: NODE_PATH=shell/node_modules node --test tests/http-api-powerbox.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const http = require('node:http');
const test = require('node:test');
const path = require('node:path');
const root = path.join(__dirname, '..');
const { driver, profile, apiHeaders } = require('./helpers/http-api-driver.cjs');

test('authentication hints open configuration; unknown hints never downgrade', () => {
  const registry = driver();
  for (const authentication of ['basic', 'bearer']) {
    const cards = registry.query(null, null, { canonicalUrl: 'https://example.com', authentication });
    assert.equal(cards[0].configureTemplate, 'httpArbitraryPowerboxConfiguration');
    assert.equal(cards[0].authentication, authentication);
  }
  assert.equal(registry.query(null, null, { authentication: 'unknown' }).length, 0);
  assert.equal(registry.query(null, null, { canonicalUrl: 'https://example.com' })[0]
      .configureTemplate, undefined);
  assert.equal(registry.query(null, null, {
    canonicalUrl: 'https://api.github.com', oauthScopes: [{ name: 'repo' }],
  })[0].configureTemplate, 'httpOAuthPowerboxConfiguration');
});

test('connection validation rejects credential URLs and unapproved headers without secret errors', () => {
  const valid = { url: 'https://api.openai.com/v1', auth: { bearer: 'test-secret' },
    connectionHeaders: [{ name: 'openai-project', value: 'proj-test' }] };
  profile.validateHttpConnection(valid);
  for (const patch of [
    { url: 'https://api.openai.com.evil/v1' },
    { url: 'https://user:secret@example.com' },
    { url: 'https://example.com/#secret' },
    { auth: { bearer: 'secret\r\ninjected' } },
    { auth: { basic: { username: 'a:b', password: 'secret' } } },
    { connectionHeaders: [{ name: 'Authorization', value: 'secret' }] },
    { connectionHeaders: [{ name: 'openai-project', value: 'secret\r\n' }] },
    { connectionHeaders: [...valid.connectionHeaders, ...valid.connectionHeaders] },
  ]) {
    assert.throws(() => profile.validateHttpConnection({ ...valid, ...patch }), error => {
      assert.ok(!error.message.includes('secret'));
      return true;
    });
  }
  const result = driver().validate(null, null, valid);
  assert.ok(!JSON.stringify(result.descriptor).includes('test-secret'));
  assert.equal(result.frontendRef.auth.bearer, 'test-secret');
});

test('restored grants inject credentials and headers with isolated per-request headers', async t => {
  const received = [];
  const server = http.createServer((req, res) => {
    received.push(req.headers);
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const session = driver().restore({}, {}, {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    auth: { bearer: 'remote-key' },
    connectionHeaders: [{ name: 'openai-project', value: 'proj-test' }],
  });
  await Promise.all([
    session.get('first', { additionalHeaders: [{ name: 'x-test', value: 'first' }] }),
    session.get('second', {}),
  ]);
  assert.equal(received.length, 2);
  received.forEach(headers => {
    assert.equal(headers.authorization, 'Bearer remote-key');
    assert.equal(headers['openai-project'], 'proj-test');
  });
  assert.equal(received.filter(headers => headers['x-test']).length, 1);
  for (const name of ['Authorization', 'OPENAI-PROJECT', 'OpenAI-Project']) {
    assert.throws(() => session.get('blocked', {
      additionalHeaders: [{ name, value: 'override' }],
    }), /Cannot override/);
  }
  assert.equal(received.length, 2);
});

test('credential form submits to the shell and clears its secret input', () => {
  const templates = new Proxy({}, { get(target, key) {
    if (!target[key]) target[key] = {
      helpers() {}, events(value) { this.handlers = value; },
      onCreated(value) { this.created = value; },
      onDestroyed(value) { this.destroyed = value; },
    };
    return target[key];
  } });
  const source = fs.readFileSync(path.join(root,
      'shell/imports/client/powerbox-builtins.js'), 'utf8')
      .replace(/^import [\s\S]*?;\n/gm, '');
  vm.runInNewContext(source, {
    ...profile, Template: templates,
    ReactiveVar: class {
      constructor(value) { this.value = value; }
      get() { return this.value; }
      set(value) { this.value = value; }
    },
  });
  const template = templates.httpArbitraryPowerboxConfiguration;
  const input = { value: 'test-secret' };
  let submitted;
  const data = {
    option: { httpUrl: 'https://api.openai.com/v1', authentication: 'bearer' },
    powerboxRequest: { completeNewFrontendRef(value) { submitted = value; } },
  };
  const instance = {
    data, find: () => input,
    findAll: selector => selector === 'input.secret' ? [input] : [],
  };
  template.created.call(instance);
  template.handlers['submit form'].call(data, { preventDefault() {} }, instance);
  assert.equal(submitted.http.auth.bearer, 'test-secret');
  assert.equal(input.value, '');
  input.value = 'another-secret';
  template.handlers['input input.secret'].call(data, { currentTarget: input }, instance);
  template.destroyed.call(instance);
  assert.equal(input.value, '');
});

test('ApiSession rejects escaped paths before lookup or credential acquisition', () => {
  let lookups = 0;
  const session = driver({ ssrfSafeLookupOrProxy() { lookups++; } }).restore({}, {}, {
    url: 'https://example.com/v1', auth: { bearer: 'remote-key' },
  });
  session._ensureAuthorization = () => { throw new Error('must not acquire credentials'); };
  for (const path of ['../outside', '//other.example', 'https://other.example', '%2e%2e/outside']) {
    assert.throws(() => session.get(path, {}));
  }
  assert.throws(() => session.get('responses', { additionalHeaders: [
    { name: 'X-Test', value: 'a' }, { name: 'x-test', value: 'b' },
  ] }));
  assert.equal(lookups, 0);
});

test('Basic authentication survives restore; closing ApiSession aborts pending requests', async t => {
  let authorize;
  const authorized = new Promise(resolve => { authorize = resolve; });
  const server = http.createServer((req, res) => {
    authorize(req.headers.authorization);
    res.writeHead(200);
    res.write('pending');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const session = driver().restore({}, {}, {
    url: `http://127.0.0.1:${server.address().port}/api`,
    auth: { basic: { username: 'user', password: 'password' } },
  });
  const result = session.get('pending', {});
  assert.equal(await authorized, 'Basic ' + Buffer.from('user:password').toString('base64'));
  session.close();
  await assert.rejects(result, { kjType: 'disconnected' });
  assert.equal(session._requests.size, 0);
  assert.throws(() => session.get('again', {}), /closed/);
});


test('external ApiSession preserves API error JSON and only approved operational headers', async t => {
  const server = http.createServer((req, res) => {
    const status = Number(req.url.split('/').pop());
    res.writeHead(status, {
      'content-type': 'application/json', 'retry-after': '3', 'x-request-id': 'req-test',
      'x-ratelimit-remaining-tokens': '10',
      'www-authenticate': 'Bearer realm="remote"', 'set-cookie': 'unsafe=value',
      'access-control-allow-origin': '*', 'content-security-policy': "default-src *",
    });
    res.end(JSON.stringify({ error: { status } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const session = driver().restore({}, {}, {
    url: `http://127.0.0.1:${server.address().port}/v1`, auth: { bearer: 'remote-key' },
  });
  for (const [status, kind, code] of [
    [401, 'clientError', 'unauthorized'], [429, 'clientError', 'tooManyRequests'],
    [500, 'serverError', 'internalServerError'], [502, 'serverError', 'badGateway'],
    [503, 'serverError', 'serviceUnavailable'], [504, 'serverError', 'gatewayTimeout'],
  ]) {
    const result = await session.get(String(status), {});
    assert.equal(result[kind].statusCode, code);
    assert.equal(result[kind].nonHtmlBody.mimeType, 'application/json');
    assert.equal(JSON.parse(result[kind].nonHtmlBody.data.toString()).error.status, status);
    assert.equal(result.additionalHeaders.length, 3);
    assert.ok(result.additionalHeaders.every(header => apiHeaders.includes(header.name)));
  }
});

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

async function streamingFixture(t, handler, requestOptions = {}) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return driver({ requestOptions }).restore({}, {}, {
    url: `http://127.0.0.1:${server.address().port}/v1`, auth: { bearer: 'test' },
  });
}

test('SSE headers and chunks arrive before EOF; writes honor backpressure', async t => {
  const first = deferred();
  const unblock = deferred();
  const closed = deferred();
  let upstream;
  const session = await streamingFixture(t, (req, res) => {
    upstream = res;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    res.flushHeaders();
  });
  const chunks = [];
  let done = false;
  let active = 0;
  const response = await session.post('responses', { content: Buffer.from('{}') }, {
    responseStream: {
      async write(data) {
        assert.equal(active++, 0, 'only one outstanding write');
        if (data.length) {
          chunks.push(data.toString());
          first.resolve();
          await unblock.promise;
        }
        active--;
      },
      done() { done = true; },
      close() { closed.resolve(); },
    },
  });
  assert.ok(response.content.body.stream);
  assert.equal(response.content.mimeType, 'text/event-stream; charset=utf-8');
  upstream.write('data: one\n\n');
  await first.promise;
  upstream.end('data: two\n\n');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(chunks.join(''), 'data: one\n\n');
  assert.equal(done, false);
  unblock.resolve();
  await closed.promise;
  assert.equal(chunks.join(''), 'data: one\n\ndata: two\n\n');
  assert.equal(done, true);
  response.content.body.stream.close();
});

for (const mode of ['handle', 'session', 'upstream', 'write', 'idle', 'lifetime']) {
  test(`SSE ${mode} failure closes the stream without done and releases the socket`, async t => {
    const closed = deferred();
    const socketClosed = deferred();
    let upstream;
    let done = false;
    let canceledWrite = false;
    const session = await streamingFixture(t, (req, res) => {
      upstream = res;
      res.on('close', socketClosed.resolve);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
    }, { streamIdleTimeoutMs: mode === 'idle' ? 30 : 1000,
      streamTimeoutMs: mode === 'lifetime' ? 30 : 1000 });
    const response = await session.get('responses', { responseStream: {
      write() {
        if (mode === 'write') return Promise.reject(new Error('receiver failed'));
        if (mode === 'idle') {
          const pending = new Promise(() => {});
          pending.cancel = () => { canceledWrite = true; };
          return pending;
        }
      },
      done() { done = true; },
      close() { closed.resolve(); },
    } });
    if (mode === 'handle') response.content.body.stream.close();
    if (mode === 'session') session.close();
    if (mode === 'upstream') upstream.destroy();
    await closed.promise;
    await socketClosed.promise;
    assert.equal(done, false);
    if (mode === 'idle') assert.equal(canceledWrite, true);
    response.content.body.stream.close();
  });
}


test('SSE proxy responses retain early bytes while the receiver stalls', async t => {
  const closed = deferred();
  const firstWrite = deferred();
  const unblock = deferred();
  const server = http.createServer((req, res) => {
    assert.equal(req.url, 'http://approved.example/v1/responses');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: first\n\ndata: last\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const session = driver({ ssrfSafeLookupOrProxy: async () => ({
    proxy: `http://127.0.0.1:${server.address().port}`,
  }) }).restore({}, {}, { url: 'http://approved.example/v1', auth: { bearer: 'test' } });
  const chunks = [];
  let done = false;
  await session.get('responses', { responseStream: {
    async write(data) {
      if (!data.length) { firstWrite.resolve(); await unblock.promise; }
      chunks.push(data);
    },
    done() { done = true; },
    close() { closed.resolve(); },
  } });
  await firstWrite.promise;
  await new Promise(resolve => setTimeout(resolve, 25));
  unblock.resolve();
  await closed.promise;
  assert.equal(done, true);
  assert.equal(Buffer.concat(chunks).toString(), 'data: first\n\ndata: last\n\n');
});
