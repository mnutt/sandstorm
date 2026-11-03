const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Crypto = require('node:crypto');
const { serialize, deserialize } = require('node:v8');
const { driver: loadDriver, profile } = require('./helpers/http-api-driver.cjs');
const tls = require('./helpers/http-api-tls.cjs');
const clone = value => deserialize(serialize(value));
const root = path.join(__dirname, '..');
// Exercise the outbound driver directly; ApiSession enhancements are deferred.
const driver = (options = {}) => loadDriver({ ...options, outboundOnly: true });
async function get(session, path, context = {}) {
  return session.request('get', path, context.additionalHeaders || [], Buffer.alloc(0),
    context.responseStream || { async write() {}, async done() {}, close() {} });
}
function persistence() {
  const source = fs.readFileSync(path.join(root, 'shell/imports/server/persistent.js'), 'utf8')
    .replace(/^import [\s\S]*?;\n/gm, '').replace(/export \{[\s\S]*?\};/, '');
  return vm.runInNewContext(source + '\n({PersistentImpl, insertApiToken, fetchApiToken, checkRequirements})', {
    Crypto, Buffer, Date, Capnp: require('./helpers/capnp-es.cjs'), check() {},
    Random: { secret: () => Crypto.randomBytes(32).toString('base64') },
    Meteor: { Error: class extends Error { constructor(code, message) { super(message); } } },
    inMeteor: fn => fn(),
  });
}
function database() {
  const records = new Map();
  return { records, collections: { apiTokens: {
    async insertAsync(entry) { records.set(entry._id, clone(entry)); },
    async findOneAsync(query) {
      const record = records.get(typeof query === 'string' ? query : query._id);
      if (query.revoked && record?.revoked) return undefined;
      return record && clone(record);
    },
    async updateAsync(query, modifier) {
      const record = records.get(query._id);
      if (!record || record.frontendRef.http.encryptedSettings) return 0;
      record.frontendRef.http.encryptedSettings = clone(modifier.$set['frontendRef.http.encryptedSettings']);
      delete record.frontendRef.http.connectionHeaders;
      if (record.frontendRef.http.auth.basic) delete record.frontendRef.http.auth.basic.username;
      return 1;
    },
  } } };
}

test('outbound credentials round-trip encrypted without modifying the live grant', async () => {
  const { insertApiToken, fetchApiToken } = persistence();
  for (const auth of [{ bearer: 'private-token' },
    { basic: { username: 'private-user', password: 'private-password' } },
    { apiKey: { headerName: 'x-api-key', value: 'private-key' } },
    { queryKey: { parameterName: 'api_key', value: 'private-query-key' } },
    { sigV4: { region: 'auto', accessKeyId: 'private-access-id', secretAccessKey: 'private-secret-key',
      sessionToken: 'private-session-token', allowUnsignedPayload: true } },
    { authorization: { scheme: 'Bot', value: 'private-bot' } }]) {
    const db = database();
    const grant = { baseUrl: 'https://example.com', methods: ['POST'], auth };
    const original = clone(grant);
    const key = await insertApiToken(db, { frontendRef: { outboundHttp: grant } });
    assert.deepEqual(grant, original);
    const stored = [...db.records.values()][0].frontendRef.outboundHttp;
    assert.ok(!JSON.stringify(stored).includes('private-'));
    const restored = (await fetchApiToken(db, key)).frontendRef.outboundHttp;
    assert.deepEqual(clone(restored.auth), auth);
    assert.deepEqual(restored.methods, grant.methods);
    assert.equal(stored.auth, undefined);
    const originalUrl = stored.baseUrl;
    stored.baseUrl = 'https://attacker.example';
    await assert.rejects(fetchApiToken(db, key), /Unable to decrypt/);
    stored.baseUrl = originalUrl;
    stored.methods = [];
    await assert.rejects(fetchApiToken(db, key), /Unable to decrypt/);
    stored.methods = ['POST'];
    stored.encryptedCredentials.data[0] ^= 1;
    await assert.rejects(fetchApiToken(db, key), /Unable to decrypt/);
    delete stored.encryptedCredentials;
    stored.auth = auth;
    await assert.rejects(fetchApiToken(db, key), /Unencrypted/);
  }
});
async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  return `https://127.0.0.1:${server.address().port}`;
}

test('authenticated HTTP is rejected on creation and restoration for every credential kind', () => {
  for (const auth of [{ bearer: 'secret' }, { apiKey: { headerName: 'x-api-key', value: 'secret' } },
    { basic: { username: 'user', password: 'secret' } }, { caller: null }]) {
    const request = { url: 'http://example.com', auth };
    assert.throws(() => profile.validateHttpConnection(request), /HTTPS/);
    assert.throws(() => driver().restore({}, {}, { baseUrl: request.url, auth }), /HTTPS/);
  }
  profile.validateHttpConnection({ url: 'http://example.com', auth: { none: null } });
});

for (const proxy of [false, true]) {
  test(`credentials stay on the approved HTTPS destination; redirects are not followed (${proxy ? 'CONNECT proxy' : 'direct'})`, async t => {
    let escaped = 0;
    const other = await listen(t, tls.createServer((req, res) => { escaped++; res.end('leaked'); }));
    const seen = [];
    const origin = await listen(t, tls.createServer((req, res) => {
      seen.push(req.headers);
      res.writeHead(302, { location: other + '/collect' }); res.end();
    }));
    const overrides = {};
    if (proxy) {
      const net = require('node:net');
      const server = require('node:http').createServer();
      const sockets = new Set();
      server.on('connect', (req, downstream, head) => {
        const upstream = net.connect(Number(new URL(origin).port), '127.0.0.1', () => {
          downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head.length) upstream.write(head);
          upstream.pipe(downstream); downstream.pipe(upstream);
        });
        for (const socket of [upstream, downstream]) {
          sockets.add(socket); socket.on('error', () => socket.destroy());
          socket.on('close', () => sockets.delete(socket));
        }
      });
      await listen(t, server);
      t.after(() => sockets.forEach(socket => socket.destroy()));
      overrides.ssrfSafeLookupOrProxy = async () => ({ proxy: `http://127.0.0.1:${server.address().port}` });
    }
    const session = driver(overrides).restore({}, {}, { baseUrl: origin + '/v1',
      auth: { apiKey: { headerName: 'x-api-key', value: 'private-key' } } });
    t.after(() => session.close());
    const result = await get(session, 'redirect', {});
    assert.equal(result.headers.find(header => header.name === 'location').value, other + '/collect');
    assert.equal(seen.length, 1);
    assert.equal(seen[0]['x-api-key'], 'private-key');
    assert.equal(escaped, 0);
    await assert.rejects(get(session, '//evil.example', {}));
    await assert.rejects(get(session, 'request', { additionalHeaders: [{ name: 'X-Api-Key', value: 'replacement' }] }));
    assert.equal(seen.length, 1);
  });
}

for (const change of ['revoke', 'delete', 'expire', 'requirement']) {
  test(`live grant ${change} blocks subsequent requests, saves, and a newly restored session`, async t => {
    const db = database();
    db.records.set('child', { parentToken: 'parent' });
    db.records.set('parent', { requirements: [{ tokenValid: 'requirement' }] });
    db.records.set('requirement', {});
    let calls = 0;
    const origin = await listen(t, tls.createServer((req, res) => { calls++; res.end('ok'); }));
    const registry = driver({ PersistentImpl: persistence().PersistentImpl });
    const ref = { baseUrl: origin, auth: { bearer: 'private-key' } };
    const session = registry.restore(db, { parentToken: 'child' }, ref);
    t.after(() => session.close());
    await get(session, 'one', {});
    if (change === 'revoke') db.records.get('parent').revoked = true;
    if (change === 'delete') db.records.delete('parent');
    if (change === 'expire') db.records.get('parent').expires = new Date(Date.now() - 1000);
    if (change === 'requirement') db.records.get('requirement').revoked = true;
    await assert.rejects(get(session, 'two', {}), /revoked|expired|Outbound HTTP request failed/);
    await assert.rejects(session.save({ sealFor: {} }), /closed/);
    const restored = registry.restore(db, { parentToken: 'child' }, ref);
    await assert.rejects(get(restored, 'three', {}), /revoked|expired|Outbound HTTP request failed/);
    assert.equal(calls, 1);
  });
}

test('revocation closes an active stream without signaling successful completion', { timeout: 5000 }, async t => {
  const db = database();
  db.records.set('grant', {});
  let upstreamClosed;
  const closed = new Promise(resolve => { upstreamClosed = resolve; });
  const origin = await listen(t, tls.createServer((req, res) => {
    res.on('close', upstreamClosed);
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: one\n\n');
  }));
  const session = driver({ PersistentImpl: persistence().PersistentImpl }).restore(db,
    { parentToken: 'grant' }, { baseUrl: origin, auth: { bearer: 'private-key' } });
  t.after(() => session.close());
  let done = false;
  let receiverClosed = false;
  await get(session, 'events', { responseStream: {
    async write() {}, done() { done = true; }, close() { receiverClosed = true; },
  } });
  db.records.get('grant').revoked = true;
  await closed;
  assert.equal(done, false);
  assert.equal(receiverClosed, true);
  assert.equal(session._requests.size, 0);
  assert.equal(session._closed, true);
});

for (const proxy of [false, true]) {
  test(`transport errors never expose credentials (${proxy ? 'proxy' : 'direct'})`, async () => {
    let attempted = false;
    const Failure = class { constructor() {
      attempted = true;
      throw new Error('private-key https://user:password@example.com');
    } };
    const session = driver(proxy ? {
      ssrfSafeLookupOrProxy: async () => ({ proxy: 'http://proxy.example' }), ProxyAgent: Failure,
    } : { ssrfSafeLookupOrProxy: async () => ({ url: 'https://127.0.0.1', host: 'example.com' }),
      Client: Failure }).restore({}, {}, {
      baseUrl: 'https://example.com', auth: { apiKey: { headerName: 'x-api-key', value: 'private-key' } },
    });
    await assert.rejects(get(session, 'request', {}), err => {
      assert.equal(err.message, 'Outbound HTTP request failed.');
      assert.ok(!JSON.stringify(err).includes('private-key'));
      return true;
    });
    assert.equal(attempted, true);
    session.close();
  });
}

test('revocation during DNS lookup prevents credential acquisition and network activity', async () => {
  let releaseLookup;
  let lookupStarted;
  const started = new Promise(resolve => { lookupStarted = resolve; });
  let revoked = false;
  const session = driver({
    async checkLiveRequirements() { if (revoked) throw new Error('revoked'); },
    ssrfSafeLookupOrProxy: () => { lookupStarted(); return new Promise(resolve => { releaseLookup = resolve; }); },
    Client: class { constructor() { assert.fail('must not open a connection'); } },
  }).restore({}, {}, { baseUrl: 'https://example.com', auth: { bearer: 'private-key' } });
  session._ensureAuthorization = () => assert.fail('must not acquire credentials');
  const result = get(session, 'request', {});
  await started;
  revoked = true;
  releaseLookup({ url: 'https://example.com', host: 'example.com' });
  await assert.rejects(result);
  assert.equal(session._closed, true);
});

// Run the production restore path as well as exercising an already-live driver.
test('core restore rejects revoked and expired grant chains before creating a capability', async () => {
  const db = database();
  const source = fs.readFileSync(path.join(root, 'shell/imports/server/core.js'), 'utf8');
  const templateStart = source.indexOf('const makeSaveTemplateForChild =');
  const templateEnd = source.indexOf('\n};', templateStart) + 3;
  const restoreStart = source.indexOf('export const restoreInternal =');
  const restoreEnd = source.indexOf('\n};', restoreStart) + 3;
  let created = 0;
  const restore = vm.runInNewContext(source.slice(templateStart, templateEnd) + '\n' +
    source.slice(restoreStart, restoreEnd).replace('export ', '') + '\nrestoreInternal', {
    Buffer, Date, check() {}, Match: { Any: {} },
    Meteor: { Error: class extends Error { constructor(code, message) { super(message); } } },
    checkRequirements: persistence().checkRequirements,
    fetchApiToken: (database, key) => database.collections.apiTokens.findOneAsync(key),
    frontendRefRegistry: { restore() { created++; return {}; } },
  });
  for (const change of ['revoke-child', 'revoke-parent', 'delete-child', 'expire-parent', 'requirement']) {
    db.records.set('child', { _id: 'child', parentToken: 'parent' });
    db.records.set('parent', { _id: 'parent', frontendRef: { outboundHttp: {} }, requirements: [{ tokenValid: 'requirement' }] });
    db.records.set('requirement', {});
    await restore(db, 'child', {});
    const before = created;
    if (change === 'revoke-child') db.records.get('child').revoked = true;
    if (change === 'revoke-parent') db.records.get('parent').revoked = true;
    if (change === 'delete-child') db.records.delete('child');
    if (change === 'expire-parent') db.records.get('parent').expires = new Date(Date.now() - 1000);
    if (change === 'requirement') db.records.get('requirement').revoked = true;
    await assert.rejects(restore(db, 'child', {}), /revoked|expired|No token/);
    assert.equal(created, before);
  }
});
