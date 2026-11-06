const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const { driver } = require('./helpers/http-api-driver.cjs');
const tls = require('./helpers/http-api-tls.cjs');
const loadTransport = require('./helpers/http-transport.cjs');

function receiver() {
  let close;
  const closed = new Promise(resolve => { close = resolve; });
  const chunks = [];
  const sink = { async write(data) { chunks.push(data); }, async done() {}, close };
  return { sink, closed, text: () => Buffer.concat(chunks).toString() };
}
async function serve(t, handler, secure = true) {
  const server = (secure ? tls : http).createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `${secure ? 'https' : 'http'}://127.0.0.1:${server.address().port}`;
}
function session(t, baseUrl, registry = driver({ outboundOnly: true })) {
  const value = registry.restore({}, {}, { baseUrl, auth: { bearer: 'secret' } });
  t.after(() => value.close());
  return value;
}

for (const late of [false, true]) {
  test(`expectSize enforces bytes and ${late ? 'keeps chunked framing when late' : 'sets Content-Length before upload'}`, async t => {
    let headers;
    let sawFirstChunk;
    const firstChunk = new Promise(resolve => { sawFirstChunk = resolve; });
    const baseUrl = await serve(t, (req, res) => {
      headers = req.headers;
      const chunks = [];
      req.on('data', data => { chunks.push(data); sawFirstChunk(); });
      req.on('end', () => res.end(Buffer.concat(chunks)));
    });
    const output = receiver();
    const { requestStream } = await session(t, baseUrl).requestStreaming('put', '', [], output.sink);
    if (!late) requestStream.expectSize(4);
    await requestStream.write(Buffer.from('ab'));
    if (late) await firstChunk;
    requestStream.expectSize('2'); // UInt64 may arrive as a string; this is the remaining size.
    await requestStream.write(Buffer.from('cd'));
    await requestStream.done();
    assert.equal((await requestStream.getResponse()).statusCode, 200);
    await output.closed;
    assert.equal(output.text(), 'abcd');
    assert.equal(headers['content-length'], late ? undefined : '4');
    assert.equal(headers['transfer-encoding'], late ? 'chunked' : undefined);
  });
}

test('zero-length streaming uploads use Content-Length: 0', async t => {
  let length;
  const baseUrl = await serve(t, (req, res) => { length = req.headers['content-length']; res.end(); });
  const output = receiver();
  const { requestStream } = await session(t, baseUrl).requestStreaming('post', '', [], output.sink);
  requestStream.expectSize(0);
  await requestStream.done();
  await requestStream.getResponse();
  await output.closed;
  assert.equal(length, '0');
});

for (const mode of ['too-long', 'too-short', 'inconsistent', 'unsafe-size']) {
  test(`invalid upload size cancels the request: ${mode}`, async t => {
    const baseUrl = await serve(t, req => req.resume());
    const output = receiver();
    const { requestStream } = await session(t, baseUrl).requestStreaming('post', '', [], output.sink);
    requestStream.expectSize(2);
    if (mode === 'too-long') assert.throws(() => requestStream.write(Buffer.from('abc')), /size/);
    if (mode === 'too-short') {
      await requestStream.write(Buffer.from('a'));
      assert.throws(() => requestStream.done(), /size/);
    }
    if (mode === 'inconsistent') assert.throws(() => requestStream.expectSize(3), /size/);
    if (mode === 'unsafe-size') assert.throws(() => requestStream.expectSize('18446744073709551615'), /size/);
    await assert.rejects(requestStream.getResponse());
    await output.closed;
  });
}

test('steady upload can outlive setup timeout; done waits until the request is sent', { timeout: 3000 }, async t => {
  let observed;
  const first = new Promise(resolve => { observed = resolve; });
  const url = await serve(t, (req, res) => {
    req.on('data', observed);
    req.on('end', () => res.end('complete'));
  }, false);
  const transport = loadTransport();
  const op = transport.startHttpRequest({ db: {}, url, method: 'POST', headers: {},
    timeoutMs: 100, uploadTimeoutMs: 1500, uploadIdleTimeoutMs: 250,
    consumeResponse: transport.readHttpBody });
  const req = await op.started;
  req.write('first');
  await first;
  for (let i = 0; i < 6; i++) { await delay(30); req.write('next'); }
  req.end();
  await req.uploadComplete;
  assert.equal((await op.completion).toString(), 'complete');
});

for (const mode of ['idle', 'total', 'headers', 'duplex-idle']) {
  test(`bounded ${mode} deadline cancels upload and response`, { timeout: 3000 }, async t => {
    let interval;
    const url = await serve(t, (req, res) => {
      req.resume();
      if (mode === 'duplex-idle') {
        res.writeHead(200);
        interval = setInterval(() => res.write('response progress'), 10);
        res.on('close', () => clearInterval(interval));
      }
    }, false);
    const transport = loadTransport();
    const op = transport.startHttpRequest({ db: {}, url, method: 'POST', headers: {},
      timeoutMs: 100, uploadTimeoutMs: mode === 'total' ? 100 : 1500,
      uploadIdleTimeoutMs: 150,
      consumeResponse: async (resp, lifecycle) => {
        lifecycle.beginStreaming();
        for await (const chunk of resp) lifecycle.progress();
      } });
    const req = await op.started;
    req.write('first');
    let writes;
    if (mode === 'total') writes = setInterval(() => req.write('next'), 10);
    if (mode === 'headers') req.end();
    try { await assert.rejects(op.completion, { kjType: 'overloaded' }); }
    finally { clearInterval(writes); clearInterval(interval); }
    assert.equal(req.destroyed, true);
  });
}

test('restoring a grant twice shares its concurrency cap and canceled requests free slots', async t => {
  const baseUrl = await serve(t, req => req.resume());
  const registry = driver({ outboundOnly: true, checkLiveRequirements: async () => 'same-root' });
  const sessions = [session(t, baseUrl, registry), session(t, baseUrl, registry)];
  const streams = [];
  for (let i = 0; i < 16; i++) {
    streams.push((await sessions[i % 2].requestStreaming('post', '', [], receiver().sink)).requestStream);
  }
  await assert.rejects(sessions[0].requestStreaming('post', '', [], receiver().sink), { kjType: 'overloaded' });
  streams[0].close();
  await assert.rejects(streams[0].getResponse());
  await delay(0);
  const next = await sessions[0].requestStreaming('post', '', [], receiver().sink);
  next.requestStream.close();
});

test('session cap bounds pending DNS; process cap spans requests and releases on cancellation', async t => {
  const blockedLookup = () => new Promise(() => {});
  const registry = driver({ outboundOnly: true, ssrfSafeLookupOrProxy: blockedLookup });
  const cap = session(t, 'https://example.com', registry);
  const pending = [];
  for (let i = 0; i < 16; i++) {
    pending.push(cap.requestStreaming('post', '', [], receiver().sink).catch(() => {}));
  }
  assert.throws(() => cap.requestStreaming('post', '', [], receiver().sink), { kjType: 'overloaded' });
  cap.close();
  await Promise.all(pending);

  const transport = loadTransport({ ssrfSafeLookupOrProxy: blockedLookup });
  const start = () => transport.startHttpRequest({ db: {}, url: 'https://example.com', method: 'GET',
    headers: {}, consumeResponse: transport.readHttpBody });
  const operations = Array.from({ length: 256 }, start);
  await assert.rejects(start().started, { kjType: 'overloaded' });
  operations.forEach(op => op.cancel());
  const next = start();
  next.cancel();
  await assert.rejects(next.started, { kjType: 'disconnected' });
});
