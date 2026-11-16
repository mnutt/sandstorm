// Sandhost v1 protocol client, adapted from sandhost/client for CommonJS.
// Used by the Meteor server; keep wire compatibility with the Bash installer and Sandhost.
"use strict";

const https = require('node:https');
const http = require('node:http');
const { apiUrl } = require('./validation.js');

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 4 });
const agent = new https.Agent({ keepAlive: true, maxSockets: 4 });

// Force IPv4 for BOTH discovery and authenticated updates. Otherwise the two calls could
// take different address families. Use the same localAddress for multi-homed installations.
async function transport(request, { localAddress, allowLocalHttp = false } = {}) {
  const url = apiUrl(request.url, allowLocalHttp);
  const localHttp = url.protocol === 'http:';
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
  return new Promise((resolve, reject) => {
    const req = (localHttp ? http : https).request(url, {
      method: request.method, headers: Object.fromEntries(request.headers),
      family: 4, localAddress, agent: localHttp ? httpAgent : agent,
      // Pin local development hostnames to loopback rather than trusting DNS.
      ...(localHttp ? { lookup: (_name, options, cb) => options.all
        ? cb(null, [{address: '127.0.0.1', family: 4}]) : cb(null, '127.0.0.1', 4) } : {}),
      signal: AbortSignal.timeout(20000),
    }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 65536) res.destroy(new Error('Response too large'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), {
        status: res.statusCode, headers: Object.fromEntries(Object.entries(res.headers)
          .filter(([, value]) => value !== undefined).map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : value])),
      })));
    });
    req.on('error', reject);
    req.end(body);
  });
}

module.exports = { transport };
