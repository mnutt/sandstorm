const test = require('node:test');
const assert = require('node:assert/strict');
const { driver, profile } = require('./helpers/http-api-enhanced-driver.cjs');
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
