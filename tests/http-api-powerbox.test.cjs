// Run with: node --test tests/http-api-powerbox.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const http = require('node:http');
const test = require('node:test');
const path = require('node:path');
const root = path.join(__dirname, '..');
const profileSource = fs.readFileSync(path.join(root,
    'shell/imports/shared/http-api-profile.js'), 'utf8').replace(/export /g, '');
const profile = vm.runInNewContext(profileSource +
    '\n({httpApiProfile, httpAuthenticationHint, validateHttpConnection})', { URL });

function driver() {
  let registration;
  const source = fs.readFileSync(path.join(root,
      'shell/imports/server/drivers/external-ui-view.js'), 'utf8')
      .replace(/^import [\s\S]*?;\n/gm, '');
  const context = {
    ...profile, URL, Buffer, Promise,
    Meteor: { startup: fn => fn(), Error: class extends Error {
      constructor(code, message) { super(message); }
    } },
    Match: { OneOf() {}, Optional() {} }, check() {},
    frontendRefRegistry: { register: value => { registration = value; } },
    PersistentImpl: class {},
    Capnp: {
      importSystem: () => ({ ApiSession: { typeId: 'api', PowerboxTag: {} } }),
      parse: (schema, value) => value,
      serialize: (schema, value) => value,
      Capability: class { constructor(value) { return value; } },
    },
    Url: require('node:url'), Http: http, Https: require('node:https'),
    ssrfSafeLookup: async (db, url) => ({ url, host: new URL(url).host }),
    REQUEST_HEADER_WHITELIST: { matches: name => name === 'x-test' },
    RESPONSE_HEADER_WHITELIST: { matches: () => false },
    responseCodes: { 200: { type: 'content', code: 'ok' } },
  };
  vm.runInNewContext(source, context);
  return registration;
}

test('authentication hints open configuration; unknown hints never downgrade', () => {
  const registry = driver();
  for (const authentication of ['basic', 'bearer']) {
    const cards = registry.query(null, null, { canonicalUrl: 'https://example.com', authentication });
    assert.equal(cards[0].configureTemplate, 'httpArbitraryPowerboxConfiguration');
    assert.equal(cards[0].authentication, authentication);
  }
  assert.equal(registry.query(null, null, { authentication: 'unknown' }).length, 0);
  assert.equal(registry.query(null, null, { canonicalUrl: 'https://example.com' })[0]
      .configureTemplate, undefined);
  assert.equal(registry.query(null, null, {
    canonicalUrl: 'https://api.github.com', oauthScopes: [{ name: 'repo' }],
  })[0].configureTemplate, 'httpOAuthPowerboxConfiguration');
});

test('connection validation rejects credential URLs and unapproved headers without secret errors', () => {
  const valid = { url: 'https://api.openai.com/v1', auth: { bearer: 'test-secret' },
    connectionHeaders: [{ name: 'openai-project', value: 'proj-test' }] };
  profile.validateHttpConnection(valid);
  for (const patch of [
    { url: 'https://api.openai.com.evil/v1' },
    { url: 'https://user:secret@example.com' },
    { url: 'https://example.com/#secret' },
    { auth: { bearer: 'secret\r\ninjected' } },
    { auth: { basic: { username: 'a:b', password: 'secret' } } },
    { connectionHeaders: [{ name: 'Authorization', value: 'secret' }] },
    { connectionHeaders: [{ name: 'openai-project', value: 'secret\r\n' }] },
    { connectionHeaders: [...valid.connectionHeaders, ...valid.connectionHeaders] },
  ]) {
    assert.throws(() => profile.validateHttpConnection({ ...valid, ...patch }), error => {
      assert.ok(!error.message.includes('secret'));
      return true;
    });
  }
  const result = driver().validate(null, null, valid);
  assert.ok(!JSON.stringify(result.descriptor).includes('test-secret'));
  assert.equal(result.frontendRef.auth.bearer, 'test-secret');
});

test('restored grants inject credentials and headers with isolated per-request headers', async t => {
  const received = [];
  const server = http.createServer((req, res) => {
    received.push(req.headers);
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const session = driver().restore({}, {}, {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    auth: { bearer: 'remote-key' },
    connectionHeaders: [{ name: 'openai-project', value: 'proj-test' }],
  });
  await Promise.all([
    session.get('first', { additionalHeaders: [{ name: 'x-test', value: 'first' }] }),
    session.get('second', {}),
  ]);
  assert.equal(received.length, 2);
  received.forEach(headers => {
    assert.equal(headers.authorization, 'Bearer remote-key');
    assert.equal(headers['openai-project'], 'proj-test');
  });
  assert.equal(received.filter(headers => headers['x-test']).length, 1);
  for (const name of ['Authorization', 'OPENAI-PROJECT', 'OpenAI-Project']) {
    await assert.rejects(session.get('blocked', {
      additionalHeaders: [{ name, value: 'override' }],
    }), /Cannot override/);
  }
  assert.equal(received.length, 2);
});

test('credential form submits to the shell and clears its secret input', () => {
  const templates = new Proxy({}, { get(target, key) {
    if (!target[key]) target[key] = {
      helpers() {}, events(value) { this.handlers = value; },
      onCreated(value) { this.created = value; },
      onDestroyed(value) { this.destroyed = value; },
    };
    return target[key];
  } });
  const source = fs.readFileSync(path.join(root,
      'shell/imports/client/powerbox-builtins.js'), 'utf8')
      .replace(/^import [\s\S]*?;\n/gm, '');
  vm.runInNewContext(source, {
    ...profile, Template: templates,
    ReactiveVar: class {
      constructor(value) { this.value = value; }
      get() { return this.value; }
      set(value) { this.value = value; }
    },
  });
  const template = templates.httpArbitraryPowerboxConfiguration;
  const input = { value: 'test-secret' };
  let submitted;
  const data = {
    option: { httpUrl: 'https://api.openai.com/v1', authentication: 'bearer' },
    powerboxRequest: { completeNewFrontendRef(value) { submitted = value; } },
  };
  const instance = {
    data, find: () => input,
    findAll: selector => selector === 'input.secret' ? [input] : [],
  };
  template.created.call(instance);
  template.handlers['submit form'].call(data, { preventDefault() {} }, instance);
  assert.equal(submitted.http.auth.bearer, 'test-secret');
  assert.equal(input.value, '');
  input.value = 'another-secret';
  template.handlers['input input.secret'].call(data, { currentTarget: input }, instance);
  template.destroyed.call(instance);
  assert.equal(input.value, '');
});
