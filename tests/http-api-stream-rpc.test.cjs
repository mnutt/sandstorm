// Requires a built sandstorm-api-stream-probe, the shell capnp-es package, and Node 24.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('./helpers/http-api-tls.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { driver } = require('./helpers/http-api-driver.cjs');
const probe = process.env.API_STREAM_PROBE;

test('native outbound RPC sends a managed known-length streaming upload', { skip: !probe, timeout: 10000 }, async t => {
  const Capnp = require('./helpers/capnp-es.cjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'outbound-upload-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const server = http.createServer((req, res) => {
    assert.equal(req.method, 'PUT');
    assert.equal(req.headers['content-length'], '5');
    assert.equal(req.headers['transfer-encoding'], undefined);
    assert.equal(req.headers.authorization, 'Bearer upload-key');
    res.writeHead(201);
    req.pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const session = driver({ Capnp, outboundOnly: true }).restore({}, {}, {
    baseUrl: `https://127.0.0.1:${server.address().port}/v1`, auth: { bearer: 'upload-key' },
  });
  const child = spawn(probe, [`unix:${directory}/rpc`, 'upload']);
  t.after(() => child.kill());
  let connection;
  let output = '';
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  child.stdout.on('data', data => {
    output += data;
    if (!connection && output.includes('ready\n')) connection = Capnp.connect(`unix:${directory}/rpc`, session);
  });
  t.after(() => { connection?.close(); session.close(); });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, stderr);
  assert.match(output, /passed/);
});

test('OutboundHttpSession Powerbox authentication declarations round-trip through capnp-es', () => {
  const Capnp = require('./helpers/capnp-es.cjs');
  const schema = Capnp.importSystem('sandstorm/outbound-http-session.capnp').OutboundHttpSession.PowerboxTag;
  for (const mechanism of [{ kind: 'apiKey', headerName: 'x-api-key' },
    { kind: 'authorization', scheme: 'Bot' }, { kind: 'none' }]) {
    const requested = { baseUrl: 'https://example.com/v1', methods: ['post'],
      authenticationMethods: [mechanism] };
    const wire = Capnp.serialize(schema, requested);
    const parsed = Capnp.parse(schema, wire);
    assert.equal(parsed.baseUrl, requested.baseUrl);
    assert.deepEqual(parsed.methods, requested.methods);
    for (const [key, value] of Object.entries(mechanism)) {
      assert.equal(parsed.authenticationMethods[0][key], value);
    }
    assert.equal(driver({ Capnp, outboundOnly: true }).query(null, null, wire).length, 2);
  }
  const legacy = Capnp.parse(schema, Capnp.serialize(schema, { baseUrl: 'https://example.com/v1' }));
  assert.equal(legacy.authenticationMethods, undefined);
});

for (const mode of ['success', 'upstream', 'idle', 'stalled', 'cancel']) {
  test(`real Node/C++ stream lifecycle: ${mode}`, { skip: !probe, timeout: 10000 }, async t => {
    const Capnp = require('./helpers/capnp-es.cjs');
    const capnp = Capnp;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'api-stream-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    let providerResponse;
    let headersAt;
    let closedAt;
    let socketClosed;
    const socketDone = new Promise(resolve => { socketClosed = resolve; });
    const server = http.createServer((req, res) => {
      providerResponse = res;
      res.on('close', () => { closedAt = Date.now(); socketClosed(); });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const session = driver({ Capnp: capnp,
      requestOptions: { streamIdleTimeoutMs: ['idle', 'stalled'].includes(mode) ? 150 : 2000 },
    }).restore({}, {}, { url: `https://127.0.0.1:${server.address().port}`, auth: { bearer: 'fake' } });
    const child = spawn(probe, [`unix:${directory}/rpc`, mode]);
    t.after(() => child.kill());
    const exited = once(child, 'exit');
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    let output = '';
    let connection;
    child.stdout.on('data', data => {
      output += data;
      if (!connection && output.includes('ready\n')) {
        connection = Capnp.connect(`unix:${directory}/rpc`, session);

      }
      if (output.includes('headers\n') && providerResponse) {
        headersAt = Date.now();
        const res = providerResponse;
        providerResponse = null;
        if (mode === 'success') {
          res.write('data: one\n\n');
          setTimeout(() => res.end('data: two\n\n'), 20);
        } else if (mode === 'stalled') {
          res.write(Buffer.alloc(256 * 1024, 120));
        } else if (mode === 'upstream') {
          res.write('data: partial');
          setTimeout(() => res.destroy(), 20);
        }
      }
    });
    t.after(() => { if (connection) connection.close(); session.close(); });
    const [code] = await exited;
    assert.equal(code, 0, `${stderr}\nOutput: ${output}\nHTTP response received: ${!!providerResponse}`);
    assert.match(output, /passed/);
    await socketDone;
    if (mode === 'cancel') assert.ok(closedAt - headersAt < 300, 'handle release must cancel before RPC disconnect');
  });
}

test('capnp-es preserves API error enums and the response metadata policy', { skip: !probe }, () => {
  const Capnp = require('./helpers/capnp-es.cjs');
  const { apiHeaders } = require('./helpers/http-api-driver.cjs');
  const ApiSession = Capnp.importSystem('sandstorm/api-session.capnp').ApiSession;
  assert.deepEqual(ApiSession.responseHeaderWhitelist, apiHeaders);
  const schema = Capnp.importSystem('sandstorm/web-session.capnp').WebSession.Response;
  for (const [kind, statusCode] of [['clientError', 'unauthorized'], ['clientError', 'tooManyRequests'],
    ['serverError', 'badGateway'], ['serverError', 'serviceUnavailable'], ['serverError', 'gatewayTimeout']]) {
    const value = { [kind]: { statusCode, nonHtmlBody: {
      mimeType: 'application/json', data: Buffer.from('{"error":"test"}'),
    } } };
    const parsed = Capnp.parse(schema, Capnp.serialize(schema, value));
    assert.equal(parsed[kind].statusCode, statusCode);
    assert.equal(parsed[kind].nonHtmlBody.data.toString(), '{"error":"test"}');
  }
});

test('declarative connection fields and auth methods survive the real schema', { skip: !probe }, () => {
  const Capnp = require('./helpers/capnp-es.cjs');
  const schema = Capnp.importSystem('sandstorm/api-session.capnp').ApiSession.PowerboxTag;
  const requested = { canonicalUrl: 'https://example.com/v1', authentication: 'apiKey',
    authenticationMethods: [{ kind: 'apiKey', headerName: 'x-api-key' }, { kind: 'bearer' }],
    connectionFields: [{ headerName: 'x-workspace', label: 'Workspace', description: 'Your workspace', required: true }] };
  const parsed = Capnp.parse(schema, Capnp.serialize(schema, requested));
  assert.equal(parsed.authenticationMethods[0].kind, 'apiKey');
  assert.equal(parsed.authenticationMethods[0].headerName, 'x-api-key');
  assert.equal(parsed.authenticationMethods[1].kind, 'bearer');
  assert.equal(parsed.connectionFields[0].required, true);
  assert.equal(parsed.connectionFields[0].label, 'Workspace');
});

test('named-header API keys use the persistent credential encryption path', { skip: !probe }, async () => {
  const Capnp = require('./helpers/capnp-es.cjs');
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../shell/imports/server/persistent.js'), 'utf8');
  const start = source.indexOf('function cryptApiToken(');
  const end = source.indexOf('async function checkRequirements(', start);
  const persistence = vm.runInNewContext(source.slice(start, end) + '\n({insertApiToken, fetchApiToken})', {
    Capnp, Buffer, Crypto: require('node:crypto'), check() {}, hashSturdyRef: key => key,
  });
  const key = Buffer.alloc(32, 7).toString('base64');
  let saved;
  const db = { collections: { apiTokens: {
    async insertAsync(entry) { saved = entry; },
    async findOneAsync() { return saved; },
  } } };
  await persistence.insertApiToken(db, { frontendRef: { http: {
    auth: { apiKey: { headerName: 'x-api-key', value: 'test-private-key' } },
  } } }, key);
  assert.ok(Buffer.isBuffer(saved.frontendRef.http.auth.apiKey.value));
  assert.ok(!saved.frontendRef.http.auth.apiKey.value.includes(Buffer.from('test-private-key')));
  const restored = await persistence.fetchApiToken(db, key);
  assert.equal(restored.frontendRef.http.auth.apiKey.headerName, 'x-api-key');
  assert.equal(restored.frontendRef.http.auth.apiKey.value, 'test-private-key');
});
