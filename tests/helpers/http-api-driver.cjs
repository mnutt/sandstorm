// Run with: NODE_PATH=shell/node_modules node --test tests/http-api-powerbox.test.cjs
const fs = require('node:fs');
const vm = require('node:vm');
const http = require('node:http');
const path = require('node:path');
const root = path.join(__dirname, '../..');
const loadTransport = require('./http-transport.cjs');
const profileSource = fs.readFileSync(path.join(root,
    'shell/imports/shared/http-api-profile.js'), 'utf8').replace(/export /g, '');
const profile = vm.runInNewContext(profileSource +
    '\n({httpApiProfile, httpAuthenticationHint, validateHttpConnection})', { URL });

const { stripTypeScriptTypes } = require('node:module');
const responseCodeSource = stripTypeScriptTypes(fs.readFileSync(path.join(root,
    'shell/imports/server/web-session.ts'), 'utf8')).replace(/export /g, '');
const responseCodes = vm.runInNewContext(responseCodeSource + '\nresponseCodes');
// Use the actual schema constants while mocking the Cap'n Proto boundary.
const apiSchema = fs.readFileSync(path.join(root, 'src/sandstorm/api-session.capnp'), 'utf8');
const headerList = apiSchema.match(/const responseHeaderWhitelist[^=]*=\s*\[([\s\S]*?)\];/)[1]
    .replace(/#[^\n]*/g, '');
const apiHeaders = Array.from(headerList.matchAll(/"([^"]+)"/g), match => match[1]);

function driver(overrides = {}) {
  let registration;
  const source = fs.readFileSync(path.join(root,
      'shell/imports/server/drivers/external-ui-view.js'), 'utf8')
      .replace(/^import [\s\S]*?;\n/gm, '');
  const context = {
    ...profile, ...loadTransport(overrides), URL, Buffer, Promise,
    startHttpRequest: options => loadTransport(overrides).startHttpRequest({
      ...options, ...overrides.requestOptions,
    }),
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
    API_RESPONSE_HEADER_WHITELIST: { matches: name => apiHeaders.includes(name.toLowerCase()) },
    responseCodes,
  };
  if (overrides.Capnp) context.Capnp = overrides.Capnp;
  vm.runInNewContext(source, context);
  return registration;
}


module.exports = { driver, profile, apiHeaders };
