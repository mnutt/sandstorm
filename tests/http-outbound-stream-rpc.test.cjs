// Requires a built sandstorm-outbound-http-stream-probe, the shell capnp-es package, and Node 24.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('./helpers/http-api-tls.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { driver } = require('./helpers/http-api-driver.cjs');
const probe = process.env.OUTBOUND_HTTP_STREAM_PROBE;

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
    { kind: 'authorization', scheme: 'Bot' }, { kind: 'none' },
    { kind: 'queryKey', parameterName: 'api_key' },
    { kind: 'sigV4', region: 'auto', allowUnsignedPayload: true }]) {
    const requested = { baseUrl: 'https://example.com/v1', methods: ['post'],
      authenticationMethods: [mechanism] };
    const wire = Capnp.serialize(schema, requested);
    const parsed = Capnp.parse(schema, wire);
    assert.equal(parsed.baseUrl, requested.baseUrl);
    assert.deepEqual(parsed.methods, requested.methods);
    for (const [key, value] of Object.entries(mechanism)) {
      assert.equal(parsed.authenticationMethods[0][key], value);
    }
    assert.equal(driver({ Capnp, outboundOnly: true }).query(null, null, wire).length, 1);
  }
  const legacy = Capnp.parse(schema, Capnp.serialize(schema, { baseUrl: 'https://example.com/v1' }));
  assert.equal(legacy.authenticationMethods, undefined);
});

