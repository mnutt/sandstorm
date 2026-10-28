const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Match the existing standalone driver tests: run the module with Meteor's boundary mocked,
// while retaining the real Node HTTP implementation and request proxy client.
module.exports = function loadTransport(overrides = {}) {
  const source = fs.readFileSync(path.join(__dirname,
      '../../shell/imports/server/http-transport.js'), 'utf8')
      .replace(/^import [\s\S]*?;\n/gm, '').replace(/export /g, '');
  return vm.runInNewContext(source + `\n({validateBaseUrl, buildHttpUrl, sanitizeHeaders,
    startHttpRequest, readHttpBody, makeTransportError})`, {
    URL, Buffer, setTimeout, clearTimeout,
    Meteor: { Error: class extends Error {
      constructor(code, message) { super(message); this.error = code; }
    } },
    Match: { Optional() {} }, check() {},
    Http: require('node:http'), Https: require('node:https'), Request: require('request'),
    ssrfSafeLookupOrProxy: async (db, url) => ({ url, host: new URL(url).host }),
    ...overrides,
  });
};
