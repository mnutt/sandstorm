const test = require('node:test');
const assert = require('node:assert/strict');
const { driver, profile } = require('./helpers/http-api-driver.cjs');
const tls = require('./helpers/http-api-tls.cjs');
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function receiver() {
  const closed = deferred(); const chunks = [];
  const sink = { doneCalled: false, async write(data) { chunks.push(data); },
    async done() { sink.doneCalled = true; }, close() { closed.resolve(); } };
  return { sink, closed: closed.promise, text: () => Buffer.concat(chunks).toString() };
}
async function fixture(t, managed, handler, overrides = {}) {
  const server = tls.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const baseUrl = `https://127.0.0.1:${server.address().port}/v1`;
  const session = driver({ outboundOnly: !managed || managed === 'outbound', ...overrides }).restore({}, {},
    managed === 'outbound' ? { baseUrl, auth: { bearer: 'managed-secret' } } : managed ?
      { url: baseUrl, auth: { bearer: 'managed-secret' } } : { baseUrl });
  t.after(() => session.close());
  return session;
}
for (const managed of [false, 'outbound']) {
  const name = managed ? 'managed OutboundHttpSession' : 'OutboundHttpSession';
  test(`${name}: all raw verbs, numeric statuses and end-to-end headers`, async t => {
    const seen = [];
    const session = await fixture(t, managed, (req, res) => {
      seen.push(req.method);
      assert.equal(req.headers.authorization, managed ? 'Bearer managed-secret' : 'Bearer grain-secret');
      assert.equal(req.headers['openai-project'], 'project');
      res.writeHead(418, 'Tea only', { 'x-provider-detail': 'preserved', 'set-cookie': ['a=b', 'c=d'] });
      res.end('error-body');
    });
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
      const output = receiver();
      const headers = [{ name: 'OpenAI-Project', value: 'project' }];
      if (!managed) headers.push({ name: 'Authorization', value: 'Bearer grain-secret' });
      const response = await session.request(method, 'anything', headers, Buffer.alloc(0), output.sink);
      assert.equal(response.statusCode, 418);
      assert.equal(response.statusText, 'Tea only');
      assert.equal(response.headers.find(h => h.name === 'x-provider-detail').value, 'preserved');
      assert.equal(response.headers.filter(h => h.name === 'set-cookie').length, 2);
      await output.closed;
      assert.equal(output.sink.doneCalled, true);
      assert.equal(output.text(), method === 'head' ? '' : 'error-body');
    }
    assert.equal(seen.length, 7);
    assert.throws(() => session.request('connect', '', [], Buffer.alloc(0), receiver().sink));
    assert.throws(() => session.request('get', '../escape', [], Buffer.alloc(0), receiver().sink));
    if (managed) assert.throws(() => session.request('get', '',
      [{ name: 'AUTHORIZATION', value: 'override' }], Buffer.alloc(0), receiver().sink), /override/);
  });

  test(`${name}: streaming uploads and non-SSE full-duplex responses`, async t => {
    let upload = '';
    const session = await fixture(t, managed, (req, res) => {
      res.writeHead(201, { 'content-type': 'application/octet-stream' });
      req.on('data', data => { upload += data.toString(); res.write(data); });
      req.on('end', () => res.end());
    });
    const output = receiver();
    const { requestStream } = await session.requestStreaming('patch', 'upload', [], output.sink);
    const response = requestStream.getResponse();
    await requestStream.write(Buffer.from('first'));
    assert.equal((await response).statusCode, 201);
    assert.equal(output.sink.doneCalled, false);
    await requestStream.write(Buffer.from('second'));
    await requestStream.done();
    await output.closed;
    assert.equal(upload, 'firstsecond');
    assert.equal(output.text(), 'firstsecond');
    assert.equal(output.sink.doneCalled, true);
  });

  test(`${name}: dropping an unfinished upload cancels without done`, async t => {
    const session = await fixture(t, managed, (req, res) => { req.on('data', () => {}); });
    const output = receiver();
    const { requestStream } = await session.requestStreaming('post', 'upload', [], output.sink);
    const response = requestStream.getResponse();
    requestStream.close();
    await assert.rejects(response);
    await output.closed;
    assert.equal(output.sink.doneCalled, false);
  });

  test(`${name}: stalled receiver is canceled and released at idle deadline`, async t => {
    const session = await fixture(t, managed, (req, res) => {
      res.writeHead(200); res.write('pending');
    }, { requestOptions: { streamIdleTimeoutMs: 35 } });
    const output = receiver(); let canceled = false;
    output.sink.write = () => Object.assign(new Promise(() => {}), { cancel() { canceled = true; } });
    const response = await session.request('get', 'stream', [], Buffer.alloc(0), output.sink);
    assert.equal(response.statusCode, 200);
    await output.closed;
    assert.equal(canceled, true);
    assert.equal(output.sink.doneCalled, false);
  });

  test(`${name}: live revocation cancels a stream and blocks subsequent requests`, { timeout: 5000 }, async t => {
    let revoked = false;
    const session = await fixture(t, managed, (req, res) => { res.writeHead(200); res.write('pending'); },
      { checkLiveRequirements: async () => { if (revoked) throw new Error('revoked'); } });
    const output = receiver();
    await session.request('get', 'stream', [], Buffer.alloc(0), output.sink);
    revoked = true;
    await output.closed;
    assert.equal(output.sink.doneCalled, false);
    assert.throws(() => session.request('get', 'again', [], Buffer.alloc(0), receiver().sink), /closed/);
  });
}

for (const scheme of ['', 'Bot']) {
  test(`simple managed ${scheme || 'raw'} Authorization`, async t => {
    let received;
    const server = tls.createServer((req, res) => { received = req.headers.authorization; res.end('ok'); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const registry = driver();
    const value = registry.validate(null, null, {
      url: `https://127.0.0.1:${server.address().port}`, auth: { authorization: { scheme, value: 'private-key' } },
      authenticationMethods: [scheme ? { kind: 'authorization', scheme } : { kind: 'rawAuthorization' }],
    });
    assert.ok(!JSON.stringify(value.descriptor).includes('private-key'));
    const session = registry.restore({}, {}, value.frontendRef);
    t.after(() => session.close());
    await session.get('', {});
    assert.equal(received, scheme ? 'Bot private-key' : 'private-key');
  });
}

test('unsupported schemes and malformed credentials fail closed', () => {
  for (const scheme of ['Basic', 'DPoP', 'bad scheme', 'Bot\r\nX: bad']) {
    assert.throws(() => profile.validateHttpAuthenticationMethods([{ kind: 'authorization', scheme }]));
  }
  const registry = driver();
  assert.equal(registry.query(null, null, { authentication: 'authorization' }).length, 0);
  assert.equal(registry.query(null, null, { authentication: 'authorization',
    authenticationMethods: [{ kind: 'authorization', scheme: 'Bot' }] }).length, 1);
});

test('ApiSession caller-auth mode is explicit, HTTPS-only, and attenuated by methods', async t => {
  let calls = 0;
  const server = tls.createServer((req, res) => {
    calls++;
    assert.equal(req.headers.authorization, 'Bearer grain-secret');
    res.end('ok');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const registry = driver();
  const request = { url: `https://127.0.0.1:${server.address().port}`, auth: { caller: null },
    authenticationMethods: [{ kind: 'caller' }], methods: ['GET'] };
  const grant = registry.validate(null, null, request);
  assert.equal(grant.descriptor.tags[0].value.authentication, 'caller');
  const session = registry.restore({}, {}, grant.frontendRef);
  t.after(() => session.close());
  assert.equal(session.request, undefined);
  assert.equal(session.requestStreaming, undefined);
  await session.get('', { additionalHeaders: [{ name: 'Authorization', value: 'Bearer grain-secret' }] });
  await assert.rejects(session.post('', { content: Buffer.alloc(0), mimeType: 'text/plain' }, {}), /not allowed/);
  assert.equal(calls, 1);
  assert.throws(() => registry.validate(null, null, { ...request, url: 'http://example.com',
    authenticationMethods: [{ kind: 'caller' }] }), /HTTPS/);
  assert.equal(registry.query(null, null, { authentication: 'caller', methods: ['connect'] }).length, 0);
});

test('ApiSession sends grain-owned provider metadata without allowing key replacement', async t => {
  let received;
  const session = await fixture(t, true, (req, res) => { received = req.headers; res.end('{}'); });
  await session.post('responses', { content: Buffer.from('{}'), mimeType: 'application/json' }, {
    additionalHeaders: [{ name: 'OpenAI-Organization', value: 'org-1' },
      { name: 'OpenAI-Project', value: 'project-1' }, { name: 'Notion-Version', value: '2026' }],
  });
  assert.equal(received['openai-organization'], 'org-1');
  assert.equal(received['openai-project'], 'project-1');
  assert.equal(received['notion-version'], '2026');
  assert.equal(received.authorization, 'Bearer managed-secret');
  await assert.rejects(session.get('responses', {
    additionalHeaders: [{ name: 'Authorization', value: 'override' }],
  }), /override/);
});
