// Sandhost v1 protocol client, adapted from sandhost/client for CommonJS.
// Shared by the Meteor server and bundled setup helper; keep wire compatibility with Sandhost.
"use strict";

const { transport } = require('./transport.js');
const { createPrivateKey, createPublicKey, createHash, randomBytes, sign } = require('node:crypto');
const { apiUrl } = require('./validation.js');

function apiHeaders({ apiToken } = {}) {
  return { 'X-Sandstorm-Passthrough': 'address', ...(apiToken ? { Authorization: `Bearer ${apiToken}` } : {}) };
}

// Reuses Sandstorm's existing PEM id_rsa key. No certificate upload or TLS mTLS required.
function signedRequest(origin, path, fields, privateKey, options = {}) {
  if (apiUrl(origin, options.allowLocalHttp).origin !== origin || !/^\/[a-z/-]+$/.test(path)) {
    throw new Error('Invalid Sandcats API origin or path');
  }
  const body = new URLSearchParams(fields).toString();
  const timestamp = String(options.timestamp ?? Date.now());
  const nonce = options.nonce ?? randomBytes(24).toString('base64url');
  const bodyHash = createHash('sha256').update(body).digest('base64url');
  const message = ['sandhost-v1', origin, 'POST', path, timestamp, nonce, bodyHash].join('\n');
  const signature = sign('RSA-SHA256', Buffer.from(message), createPrivateKey(privateKey)).toString('base64url');
  return new Request(origin + path, { method: 'POST', body, headers: {
    ...apiHeaders(options), 'Content-Type': 'application/x-www-form-urlencoded', 'X-Sandstorm-App-Sandhost': 'cats',
    'X-Sandstorm-App-Sandhost-Timestamp': timestamp, 'X-Sandstorm-App-Sandhost-Nonce': nonce, 'X-Sandstorm-App-Sandhost-Signature': signature,
  } });
}
function publicKey(privateKey) {
  return createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64url');
}
async function call(origin, path, fields, privateKey, options = {}) {
  const response = await (options.transport || transport)(signedRequest(origin, path, fields, privateKey, options), options);
  let result;
  try { result = await response.json(); } catch {
    // A parser's error can quote the response body. Never expose provider-controlled text.
    throw new Error('Sandcats API returned invalid JSON');
  }
  if (!response.ok) {
    const error = new Error(`Sandcats API request failed (HTTP ${response.status})`);
    error.status = response.status; error.code = result.error; throw error;
  }
  return result; // publication=pending is accepted desired state, not confirmed DNS publication.
}

module.exports = { apiHeaders, signedRequest, publicKey, call };
