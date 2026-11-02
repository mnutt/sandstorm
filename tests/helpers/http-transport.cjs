const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Match the existing standalone driver tests: run the module with Meteor's boundary mocked,
// while retaining the real Undici dispatcher and Node streams.
module.exports = function loadTransport(overrides = {}) {
  const source = fs.readFileSync(path.join(__dirname,
      '../../shell/imports/server/http-transport.js'), 'utf8')
      .replace(/^import [\s\S]*?;\n/gm, '').replace(/export /g, '');
  return vm.runInNewContext(source + `\n({validateBaseUrl, buildHttpUrl, sanitizeHeaders,
    startHttpRequest, readHttpBody, makeTransportError, makeHttpLimitError, reserveHttpBuffer,
    HTTP_MAX_BUFFERED_UPLOAD_BYTES, HTTP_MAX_UPLOAD_CHUNK_BYTES})`, {
    URL, Buffer, setTimeout, clearTimeout,
    Meteor: { Error: class extends Error {
      constructor(code, message) { super(message); this.error = code; }
    } },
    Match: { Optional() {} }, check() {},
    PassThrough: require('node:stream').PassThrough, isIP: require('node:net').isIP,
    Client: require('undici').Client, ProxyAgent: require('undici').ProxyAgent,
    buildConnector: require('undici').buildConnector,
    ssrfSafeLookupOrProxy: async (db, url) => ({ url, host: new URL(url).host }),
    ...overrides,
  });
};
