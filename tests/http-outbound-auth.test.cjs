const test = require('node:test');
const assert = require('node:assert/strict');
const { driver } = require('./helpers/http-api-driver.cjs');
const tls = require('./helpers/http-api-tls.cjs');

const cases = [
  [{ kind: 'none' }, { none: null }, 'authorization', undefined],
  [{ kind: 'bearer' }, { bearer: 'secret-key' }, 'authorization', 'Bearer secret-key'],
  [{ kind: 'basic' }, { basic: { username: 'user', password: 'password' } },
    'authorization', 'Basic ' + Buffer.from('user:password').toString('base64')],
  [{ kind: 'apiKey', headerName: 'X-Api-Key' },
    { apiKey: { headerName: 'X-Api-Key', value: 'secret-key' } }, 'x-api-key', 'secret-key'],
  [{ kind: 'rawAuthorization' }, { authorization: { scheme: '', value: 'secret-key' } },
    'authorization', 'secret-key'],
  [{ kind: 'authorization', scheme: 'Bot' }, { authorization: { scheme: 'Bot', value: 'secret-key' } },
    'authorization', 'Bot secret-key'],
];

for (const [declaration, credentials, header, expected] of cases) {
  test(`outbound managed ${declaration.kind}: Powerbox, restore, both request paths and overrides`, async t => {
    const registry = driver({ outboundOnly: true });
    let calls = 0;
    const server = tls.createServer((req, res) => {
      calls++;
      assert.equal(req.headers[header], expected);
      assert.equal(req.headers['x-provider-version'], '2026');
      res.writeHead(418, { 'content-type': 'application/octet-stream' });
      req.pipe(res);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const request = { baseUrl: `https://127.0.0.1:${server.address().port}/v1`, methods: ['POST'],
      authenticationMethods: [declaration], auth: structuredClone(credentials) };
    const cards = registry.query(null, null, request);
    assert.equal(cards.length, 2);
    for (const card of cards) {
      assert.equal(card.configureTemplate, 'httpArbitraryPowerboxConfiguration');
      assert.equal(card.outboundHttp, true);
    }
    const grant = registry.validate(null, null, request);
    assert.ok(!JSON.stringify(grant.descriptor).includes('secret-key'));
    const session = registry.restore({}, {}, grant.frontendRef);
    t.after(() => session.close());
    for (const streaming of [false, true]) {
      let finished;
      const closed = new Promise(resolve => { finished = resolve; });
      const chunks = [];
      let done = false;
      const sink = { async write(data) { chunks.push(Buffer.from(data)); },
        async done() { done = true; }, close() { finished(); } };
      const headers = [{ name: 'X-Provider-Version', value: '2026' }];
      let response;
      if (streaming) {
        const { requestStream } = await session.requestStreaming('post', 'echo', headers, sink);
        response = requestStream.getResponse();
        await requestStream.write(Buffer.from('payload'));
        await requestStream.done();
      } else {
        response = session.request('post', 'echo', headers, Buffer.from('payload'), sink);
      }
      assert.equal((await response).statusCode, 418);
      await closed;
      assert.equal(done, true);
      assert.equal(Buffer.concat(chunks).toString(), 'payload');
    }
    for (const name of [header.toUpperCase(), 'Authorization']) {
      assert.throws(() => session.request('post', '', [{ name, value: 'override' }], Buffer.alloc(0), {}), /override/);
    }
    assert.throws(() => session.request('get', '', [], Buffer.alloc(0), {}), /not allowed/);
    assert.throws(() => session.request('post', '../escape', [], Buffer.alloc(0), {}));
    assert.equal(calls, 2);
    if (declaration.kind === 'none') {
      const anonymous = registry.validate(null, null, { ...request, baseUrl: 'http://example.com' });
      registry.restore({}, {}, anonymous.frontendRef).close();
    } else {
      assert.throws(() => registry.validate(null, null, { ...request, baseUrl: 'http://example.com' }), /HTTPS/);
      assert.throws(() => registry.restore({}, {}, { ...grant.frontendRef, baseUrl: 'http://example.com' }), /HTTPS/);
    }
  });
}

test('outbound auth declarations fail closed; legacy grants keep their caller-auth behavior', () => {
  const registry = driver({ outboundOnly: true });
  const request = { baseUrl: 'https://example.com', authenticationMethods: [{ kind: 'bearer' }] };
  assert.throws(() => registry.validate(null, null, request));
  assert.throws(() => registry.validate(null, null, { ...request, auth: { caller: null } }));
  assert.equal(registry.query(null, null, { ...request, authenticationMethods: [{ kind: 'unknown' }] }).length, 0);
  assert.throws(() => registry.validate(null, null, { baseUrl: 'http://example.com', methods: ['GET'] }));
  assert.equal(registry.query(null, null, { baseUrl: 'http://example.com' }).length, 0);
  const legacy = registry.restore({}, {}, { baseUrl: 'http://example.com', methods: ['GET'] });
  legacy.close();
});

test('new HTTP grants require exactly one explicit mechanism, including none', () => {
  for (const outboundOnly of [false, true]) {
    const registry = driver({ outboundOnly });
    const destination = outboundOnly ? { baseUrl: 'https://example.com' } :
      { url: 'https://example.com' };
    for (const authenticationMethods of [undefined, [], [{ kind: 'bearer' }, { kind: 'basic' }],
      [{ kind: 'none' }, { kind: 'bearer' }]]) {
      assert.throws(() => registry.validate(null, null, {
        ...destination, authenticationMethods, auth: { none: null },
      }), /exactly one/);
      assert.equal(registry.query(null, null, { authenticationMethods }).length, 0);
    }
    const grant = registry.validate(null, null, { ...destination,
      authenticationMethods: [{ kind: 'none' }], auth: { none: null } });
    assert.equal(grant.frontendRef.auth.none, null);
    assert.throws(() => registry.validate(null, null, { ...destination,
      authenticationMethods: [{ kind: 'none' }], auth: { bearer: 'secret' } }), /requested/);
  }
});
