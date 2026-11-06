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
