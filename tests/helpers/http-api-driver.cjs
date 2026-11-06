// Run with: NODE_PATH=shell/node_modules node --test tests/http-api-powerbox.test.cjs
const fs = require('node:fs');
const vm = require('node:vm');
const http = require('node:http');
const path = require('node:path');
const root = path.join(__dirname, '../..');
const loadTransport = require('./http-transport.cjs');
const profileSource = fs.readFileSync(path.join(root,
    'shell/imports/shared/outbound-http-profile.js'), 'utf8').replace(/export /g, '');
const profile = vm.runInNewContext(profileSource +
    '\n({validateHttpConnectionFields, validateHttpAuthenticationMethods, validateHttpApiKeyHeader, ' +
    'httpAuthenticationChoices, httpAuthenticationHint, validateHttpConnection, requireHttpCredentialTls, validateHttpAuthorizationScheme, validateHttpMethods})', { URL });

function driver(overrides = {}) {
  overrides = { ...require('./http-api-tls.cjs').transport, ...overrides };
  const transport = loadTransport(overrides);
  let registration;
  const context = {
    ...profile, ...transport, URL, Buffer, Promise, setInterval, clearInterval,
    startHttpRequest: options => transport.startHttpRequest({
      ...options, ...overrides.requestOptions,
    }),
    Meteor: { startup: fn => fn(), Error: class extends Error {
      constructor(code, message) { super(message); }
    } },
    Match: { OneOf() {}, Optional() {} }, check() {},
    frontendRefRegistry: { register: value => { registration = value; } },
    PersistentImpl: class {
      async checkLiveRequirements() { if (overrides.checkLiveRequirements) return overrides.checkLiveRequirements(); }
    },
    Capnp: {
      importSystem: () => ({ ApiSession: { typeId: 'api', PowerboxTag: {} }, OutboundHttpSession: { typeId: 'outbound', RequestStream: {} } }),
      parse: (schema, value) => value,
      serialize: (schema, value) => value,
      Capability: class { constructor(value) { return value; } },
    },
    Url: require('node:url'), Http: http, Https: require('node:https'),
    ssrfSafeLookup: async (db, url) => ({ url, host: new URL(url).host }),
    REQUEST_HEADER_WHITELIST: { matches: name => name === 'x-test' },
    RESPONSE_HEADER_WHITELIST: { matches: () => false },
  };
  if (overrides.PersistentImpl) context.PersistentImpl = overrides.PersistentImpl;
  if (overrides.Capnp) context.Capnp = overrides.Capnp;
  context.globalFrontendRefRegistry = context.frontendRefRegistry;
  const outbound = fs.readFileSync(path.join(root,
    'shell/imports/server/drivers/outbound-http-session.js'), 'utf8')
    .replace(/^import [\s\S]*?;\n/gm, '').replace(/export /g, '');
  const sandbox = vm.createContext(context);
  sandbox.Crypto = require('node:crypto');
  const signing = fs.readFileSync(path.join(root, 'shell/imports/server/s3-sigv4.js'), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/export /g, '');
  vm.runInContext(signing, sandbox);
  const sharedSession = fs.readFileSync(path.join(root, 'shell/imports/server/outbound-http-session-base.js'), 'utf8')
    .replace(/^import [\s\S]*?;\n/gm, '').replace(/export /g, '');
  vm.runInContext(sharedSession, sandbox);
  vm.runInContext(outbound, sandbox);
  return registration;
}


module.exports = { driver, profile };
