// Local HTTPS fixtures only. Never disable TLS verification in the production transport.
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const undici = require('undici');
const key = fs.readFileSync(path.join(__dirname, '../fixtures/http-api/test-only.key'));
const cert = fs.readFileSync(path.join(__dirname, '../fixtures/http-api/test-only.crt'));
module.exports = {
  createServer: handler => https.createServer({ key, cert }, handler),
  transport: {
    buildConnector: options => undici.buildConnector({ ...options, ca: cert }),
    ProxyAgent: class extends undici.ProxyAgent {
      constructor(options) {
        super({ ...options, requestTls: { ...options.requestTls, ca: cert } });
      }
    },
  },
  cert,
};
