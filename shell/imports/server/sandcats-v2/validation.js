// Sandhost v1 protocol client, adapted from sandhost/client for CommonJS.
// Shared by the Meteor server and bundled setup helper; keep wire compatibility with Sandhost.
"use strict";

// Strict IPv4 parsing shared by IP discovery and client-side validation.
function observedAddress(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(value)) throw new Error('invalid_ipv4');
  const [a, b, c, d] = value.split('.').map(Number);
  if ([a,b,c,d].some(n => n > 255) || a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) || (a === 198 && (b === 18 || b === 19))) throw new Error('observed_address_not_public_ipv4');
  return value;
}

// HTTP is an explicit development exception for loopback destinations only.
function apiUrl(value, allowLocalHttp = false) {
  const url = new URL(value);
  if (url.username || url.password || url.hash) throw new Error('API URL cannot contain credentials or a fragment');
  const local = url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(allowLocalHttp && url.protocol === 'http:' && local)) {
    throw new Error('HTTPS required (local HTTP requires --allow-local-http and a localhost URL)');
  }
  return url;
}

module.exports = { observedAddress, apiUrl };
