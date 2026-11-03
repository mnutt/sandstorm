// Run with: NODE_PATH=shell/node_modules node --test tests/http-outbound-powerbox.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const path = require('node:path');
const root = path.join(__dirname, '..');
const { profile } = require('./helpers/http-api-driver.cjs');

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
    ...profile, validateOutboundHttpConnection: profile.validateHttpConnection, Template: templates,
    ReactiveVar: class {
      constructor(value) { this.value = value; }
      get() { return this.value; }
      set(value) { this.value = value; }
    },
  });
  const template = templates.outboundHttpCredentialsConfiguration;
  const input = { value: 'test-secret' };
  let submitted;
  const data = {
    option: { httpUrl: 'https://api.openai.com/v1', authenticationMethods: [{ kind: 'bearer' }] },
    powerboxRequest: { completeNewFrontendRef(value) { submitted = value; } },
  };
  const instance = {
    data, find: () => input,
    findAll: selector => selector === 'input.secret' ? [input] : [],
  };
  template.created.call(instance);
  template.handlers['submit form'].call(data, { preventDefault() {} }, instance);
  assert.equal(submitted.outboundHttp.auth.bearer, 'test-secret');
  assert.equal(input.value, '');
  input.value = 'another-secret';
  template.handlers['input input.secret, input input.connection-header'].call(data, { currentTarget: input }, instance);
  template.destroyed.call(instance);
  assert.equal(input.value, '');
  data.option.authenticationMethods = [{ kind: 'apiKey', headerName: 'x-provider-key' }];
  template.created.call(instance);
  input.value = 'private-api-key';
  template.handlers['submit form'].call(data, { preventDefault() {} }, instance);
  assert.equal(submitted.outboundHttp.auth.apiKey.headerName, 'x-provider-key');
  assert.equal(submitted.outboundHttp.auth.apiKey.value, 'private-api-key');
  assert.equal(input.value, '');
  data.option.outboundHttp = true;
  data.option.methods = ['post'];
  for (const method of [{ kind: 'bearer' }, { kind: 'rawAuthorization' },
    { kind: 'authorization', scheme: 'Bot' }]) {
    data.option.authenticationMethods = [method];
    template.created.call(instance);
    input.value = 'outbound-secret';
    template.handlers['submit form'].call(data, { preventDefault() {} }, instance);
    assert.equal(submitted.http, undefined);
    assert.equal(submitted.outboundHttp.baseUrl, data.option.httpUrl);
    assert.equal(submitted.outboundHttp.methods[0], 'post');
    if (method.kind === 'bearer') assert.equal(submitted.outboundHttp.auth.bearer, 'outbound-secret');
    else {
      assert.equal(submitted.outboundHttp.auth.authorization.value, 'outbound-secret');
      assert.equal(submitted.outboundHttp.auth.authorization.scheme, method.scheme || '');
    }
    assert.equal(input.value, '');
  }
  data.option.authenticationMethods = [{ kind: 'queryKey', parameterName: 'api_key' }];
  template.created.call(instance);
  input.value = 'private-query-key';
  template.handlers['submit form'].call(data, { preventDefault() {} }, instance);
  assert.equal(submitted.outboundHttp.auth.queryKey.value, 'private-query-key');
  assert.equal(submitted.outboundHttp.auth.queryKey.parameterName, 'api_key');
  assert.equal(input.value, '');
  data.option.authenticationMethods = [{ kind: 'sigV4', region: 'auto', allowUnsignedPayload: true }];
  const fields = {
    'input.s3-access-key': { value: 'access-id' }, 'input.s3-secret-key': { value: 'private-key' },
    'input.s3-session-token': { value: 'private-token' },
  };
  instance.find = selector => fields[selector];
  instance.findAll = selector => selector === 'input.secret' ? Object.values(fields) : [];
  template.created.call(instance);
  template.handlers['submit form'].call(data, { preventDefault() {} }, instance);
  assert.equal(submitted.outboundHttp.auth.sigV4.region, 'auto');
  assert.equal(submitted.outboundHttp.auth.sigV4.allowUnsignedPayload, true);
  assert.equal(submitted.outboundHttp.auth.sigV4.accessKeyId, 'access-id');
  assert.equal(submitted.outboundHttp.auth.sigV4.secretAccessKey, 'private-key');
  assert.equal(submitted.outboundHttp.auth.sigV4.sessionToken, 'private-token');
  assert.ok(Object.values(fields).every(field => field.value === ''));
  data.option.authenticationMethods = [{ kind: 'none' }];
  instance.find = () => { throw new Error('Unauthenticated forms must not read credentials'); };
  template.created.call(instance);
  template.handlers['submit form'].call(data, { preventDefault() {} }, instance);
  assert.equal(submitted.outboundHttp.auth.none, null);
  const html = fs.readFileSync(path.join(root, 'shell/imports/client/powerbox-builtins.html'), 'utf8');
  assert.ok(!html.includes('chooseAuthentication'));
  assert.ok(!html.slice(html.indexOf('<template name="outboundHttpCredentialsConfiguration">')).includes('select class="authentication"'));
});
