const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { driver } = require('./helpers/http-api-driver.cjs');
const tls = require('./helpers/http-api-tls.cjs');
const loadTransport = require('./helpers/http-transport.cjs');
const MiB = 1024 * 1024;

function receiver() {
  let release;
  const closed = new Promise(resolve => { release = resolve; });
  const chunks = [];
  let done = false;
  return { closed, chunks, get done() { return done; }, sink: {
    async write(data) { chunks.push(data); }, async done() { done = true; }, close: release,
  } };
}
async function serve(t, handler, secure = true) {
  const server = (secure ? tls : http).createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `${secure ? 'https' : 'http'}://127.0.0.1:${server.address().port}`;
}
function session(t, baseUrl, overrides = {}) {
  const registry = driver({ outboundOnly: true, ...overrides });
  const cap = registry.restore({}, {}, { baseUrl, auth: { bearer: 'secret' } });
  t.after(() => cap.close());
  return cap;
}

test('oversized buffered requests fail before DNS; canceled pending bodies release the shared budget', async t => {
  let lookups = 0;
  const registry = driver({ outboundOnly: true,
    ssrfSafeLookupOrProxy: () => { lookups++; return new Promise(() => {}); },
  });
  const ref = { baseUrl: 'https://example.com', auth: { bearer: 'secret' } };
  const cap = registry.restore({}, {}, ref);
  t.after(() => cap.close());
  assert.throws(() => cap.request('post', '', [], Buffer.alloc(8 * MiB + 1), receiver().sink),
    { kjType: 'overloaded' });
  assert.equal(lookups, 0);
  const body = Buffer.alloc(8 * MiB);
  const requests = Array.from({ length: 8 }, () =>
    cap.request('post', '', [], body, receiver().sink).catch(() => {}));
  assert.throws(() => cap.request('post', '', [], Buffer.from('x'), receiver().sink),
    /buffer budget/);
  cap.close();
  await Promise.all(requests);
  const next = registry.restore({}, {}, ref);
  t.after(() => next.close());
  const pending = next.request('post', '', [], body, receiver().sink);
  next.close();
  await assert.rejects(pending, { kjType: 'disconnected' });
});

test('buffered uploads larger than the write queue are sent as bounded chunks', async t => {
  let bytes = 0;
  const base = await serve(t, (req, res) => {
    req.on('data', chunk => { bytes += chunk.length; });
    req.on('end', () => res.end('ok'));
  });
  const output = receiver();
  const response = await session(t, base).request('put', '', [], Buffer.alloc(5 * MiB), output.sink);
  await output.closed;
  assert.equal(response.statusCode, 200);
  assert.equal(bytes, 5 * MiB);
  assert.equal(output.done, true);
});

test('buffered upload exposes response headers before the peer resumes reading the body', { timeout: 3000 }, async t => {
  let incoming;
  let uploaded = 0;
  const base = await serve(t, (req, res) => {
    incoming = req;
    req.on('data', chunk => { uploaded += chunk.length; });
    req.pause();
    res.writeHead(200);
    res.write('ready');
    req.on('end', () => res.end('complete'));
  });
  let exposeHeaders;
  const headersReady = new Promise(resolve => { exposeHeaders = resolve; });
  const output = receiver();
  output.sink.write = async () => { await headersReady; incoming.resume(); };
  const response = await session(t, base).request('post', '', [], Buffer.alloc(8 * MiB), output.sink);
  assert.equal(response.statusCode, 200);
  exposeHeaders();
  await output.closed;
  assert.equal(uploaded, 8 * MiB);
  assert.equal(output.done, true);
});

test('oversized streaming write cancels without sending a body', async t => {
  let calls = 0;
  const base = await serve(t, () => { calls++; });
  const cap = session(t, base);
  const output = receiver();
  const { requestStream } = await cap.requestStreaming('post', '', [], output.sink);
  assert.throws(() => requestStream.write(Buffer.alloc(MiB + 1)), { kjType: 'overloaded' });
  await assert.rejects(requestStream.getResponse());
  await output.closed;
  assert.equal(output.done, false);
  assert.equal(calls, 0);
});

for (const empty of [false, true]) {
  test(`ignoring upload backpressure hits the ${empty ? 'write-count' : 'queued-byte'} limit`, async t => {
    const base = await serve(t, req => req.resume());
    const cap = session(t, base, { requestOptions: {
      maxQueuedUploadBytes: 8, maxQueuedUploadWrites: empty ? 2 : 64,
    } });
    const output = receiver();
    const { requestStream } = await cap.requestStreaming('post', '', [], output.sink);
    const data = empty ? Buffer.alloc(0) : Buffer.from('abcd');
    const writes = [requestStream.write(data), requestStream.write(data), requestStream.write(data)];
    const results = await Promise.allSettled(writes);
    assert.ok(results.every(result => result.status === 'rejected'));
    assert.ok(results.some(result => result.reason.kjType === 'overloaded'));
    await assert.rejects(requestStream.getResponse());
    await output.closed;
    assert.equal(output.done, false);
  });
}

for (const declared of [false, true]) {
  test(`total upload limit applies ${declared ? 'to expectSize' : 'across separate writes'}`, async t => {
    const base = await serve(t, req => req.resume());
    const cap = session(t, base, { requestOptions: { maxUploadBytes: 5 } });
    const output = receiver();
    const { requestStream } = await cap.requestStreaming('post', '', [], output.sink);
    if (declared) assert.throws(() => requestStream.expectSize(6), { kjType: 'overloaded' });
    else {
      await requestStream.write(Buffer.from('abc'));
      await assert.rejects(requestStream.write(Buffer.from('def')), { kjType: 'overloaded' });
    }
    await assert.rejects(requestStream.getResponse());
    await output.closed;
    assert.equal(output.done, false);
  });
}

test('oversized response releases receiver without done; a subsequent request still works', async t => {
  const base = await serve(t, (req, res) => res.end(req.url === '/large' ? '123456' : '12345'));
  const cap = session(t, base, { requestOptions: { maxResponseBytes: 5 } });
  const failed = receiver();
  await cap.request('get', 'large', [], Buffer.alloc(0), failed.sink);
  await failed.closed;
  assert.equal(failed.done, false);
  assert.ok(Buffer.concat(failed.chunks).length <= 5);
  const success = receiver();
  await cap.request('get', 'small', [], Buffer.alloc(0), success.sink);
  await success.closed;
  assert.equal(success.done, true);
  assert.equal(Buffer.concat(success.chunks).toString(), '12345');
});

test('buffered response limit releases retained bytes and does not return partial data', async t => {
  const base = await serve(t, (req, res) => {
    res.write('123');
    setImmediate(() => res.end('456'));
  }, false);
  const transport = loadTransport();
  const op = transport.startHttpRequest({ db: {}, url: base, method: 'GET', headers: {},
    consumeResponse: response => transport.readHttpBody(response, { maxBytes: 5 }) });
  (await op.started).end();
  await assert.rejects(op.completion, { kjType: 'overloaded' });
  const release = transport.reserveHttpBuffer(64 * MiB);
  release();
});

test('pending upload cancellation releases the process buffer budget exactly once', async t => {
  const base = await serve(t, req => req.resume(), false);
  const transport = loadTransport();
  const op = transport.startHttpRequest({ db: {}, url: base, method: 'POST', headers: {},
    consumeResponse: transport.readHttpBody });
  const req = await op.started;
  const write = new Promise(resolve => req.write(Buffer.alloc(MiB), error => { assert.ok(error); resolve(); }));
  op.cancel();
  await write;
  await assert.rejects(op.completion);
  const release = transport.reserveHttpBuffer(64 * MiB);
  assert.throws(() => transport.reserveHttpBuffer(1), { kjType: 'overloaded' });
  release(); release(); // Idempotent release must not create extra budget.
  assert.throws(() => transport.reserveHttpBuffer(64 * MiB + 1), { kjType: 'overloaded' });
});
