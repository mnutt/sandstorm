const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { driver } = require('./helpers/http-api-driver.cjs');
const source = fs.readFileSync(path.join(__dirname,
  '../shell/imports/sandstorm-ui-powerbox/powerbox-server.js'), 'utf8');
const helpers = source.slice(source.indexOf('function normalizeOutboundHttpMethods('),
  source.indexOf('function normalizePowerboxTagId('));
const optionClass = source.slice(source.indexOf('class PowerboxOption'),
  source.indexOf('function powerboxDescriptorDiagnostics('));
const PowerboxOption = vm.runInNewContext(helpers + optionClass + '\nPowerboxOption', {
  OUTBOUND_HTTP_METHODS: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
});

test('managed URL card submits the intersected methods, including reversed tag order', () => {
  const registry = driver({ outboundOnly: true });
  const tag = { baseUrl: 'https://example.com', authenticationMethods: [{ kind: 'bearer' }] };
  for (const methods of [[['get', 'post'], ['post', 'delete']], [['post', 'delete'], ['get', 'post']]]) {
    const left = new PowerboxOption(registry.query(null, null, { ...tag, methods: methods[0] })[0]);
    const right = new PowerboxOption(registry.query(null, null, { ...tag, methods: methods[1] })[0]);
    assert.equal(left.intersect(right), true);
    assert.equal(left.methods.join(','), 'POST');
    assert.equal(left.frontendRef.outboundHttp.methods.join(','), 'POST');
    const grant = registry.validate(null, null, { baseUrl: tag.baseUrl, methods: left.methods,
      authenticationMethods: left.authenticationMethods, auth: { bearer: 'secret' } });
    assert.equal(grant.frontendRef.methods.join(','), 'POST');
  }
});

test('authentication-specific cards cannot accidentally union unrelated method permissions', () => {
  const registry = driver({ outboundOnly: true });
  const tag = { baseUrl: 'https://example.com', methods: ['get'] };
  const caller = registry.query(null, null, { ...tag, authenticationMethods: [{ kind: 'caller' }] });
  const bearer = registry.query(null, null, { ...tag, authenticationMethods: [{ kind: 'bearer' }] });
  const basic = registry.query(null, null, { ...tag, methods: ['post'], authenticationMethods: [{ kind: 'basic' }] });
  for (let i = 0; i < 2; i++) {
    assert.notEqual(bearer[i]._id, basic[i]._id);
    assert.notEqual(caller[i]._id, bearer[i]._id);
  }
  const first = registry.query(null, null, { ...tag, authenticationMethods: [{ kind: 'bearer' }, { kind: 'basic' }] });
  const reverse = registry.query(null, null, { ...tag, authenticationMethods: [{ kind: 'basic' }, { kind: 'bearer' }] });
  assert.equal(first.length, 0);
  assert.equal(reverse.length, 0);
  assert.equal(registry.query(null, null, { ...tag, methods: ['connect'] }).length, 0);
});

test('registry rejects malformed credential requests without echoing their contents', async () => {
  const registrySource = fs.readFileSync(path.join(__dirname,
    '../shell/imports/server/frontend-ref.js'), 'utf8').replace(/^import .*;\n/gm, '')
    .replace(/export \{ FrontendRefRegistry \};/, 'FrontendRefRegistry;');
  const Registry = vm.runInNewContext(registrySource, {});
  const registry = new Registry();
  const request = { unknownType: { auth: { bearer: 'private-key' } } };
  await assert.rejects(registry.validate({}, {}, request), error => {
    assert.ok(!error.message.includes('private-key'));
    return true;
  });
  assert.throws(() => registry.restore({}, {}, request), error => {
    assert.ok(!error.message.includes('private-key'));
    return true;
  });
});

test('existing external ApiSession forms also retain conjunctive method attenuation', () => {
  const registry = driver();
  const tag = { canonicalUrl: 'https://example.com', authenticationMethods: [{ kind: 'bearer' }] };
  for (const index of [0, 1]) {
    const left = new PowerboxOption(registry.query(null, null, { ...tag, methods: ['get', 'post'] })[index]);
    const right = new PowerboxOption(registry.query(null, null, { ...tag, methods: ['post'] })[index]);
    assert.equal(left.intersect(right), true);
    assert.equal(left.methods.join(','), 'POST');
  }
});
