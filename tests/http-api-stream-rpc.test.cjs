// Requires a built sandstorm-api-stream-probe, the shell capnp-es package, and Node 24.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { driver } = require('./helpers/http-api-driver.cjs');
const probe = process.env.API_STREAM_PROBE;

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
    }).restore({}, {}, { url: `http://127.0.0.1:${server.address().port}`, auth: { bearer: 'fake' } });
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
