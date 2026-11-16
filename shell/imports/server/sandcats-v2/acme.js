// Sandhost v1 protocol client, adapted from sandhost/client for CommonJS.
// Used by the Meteor server; keep wire compatibility with the Bash installer and Sandhost.
"use strict";

const { Resolver } = require('node:dns/promises');
const { call } = require('./index.js');

// ACME.js challenge adapter. Reuses the existing installation key and Sandcats value field.
function create({ hostname, key, baseDomain = 'sandcats.org', origin,
  bindIp, apiToken, allowLocalHttp = false, request, publicationTimeout = 120000 }) {
  const dnsHost = `_acme-challenge.${hostname}.${baseDomain}`;
  const options = { localAddress: bindIp, apiToken, allowLocalHttp, ...(request ? { transport: request } : {}) };
  function validate(challenge) {
    if (challenge.dnsHost !== dnsHost) throw new Error('Challenge hostname does not belong to this installation');
  }
  async function publish(fields) {
    let result = await call(origin, '/acme-challenge', { rawHostname: hostname, ...fields }, key, options);
    const deadline = Date.now() + publicationTimeout;
    while (result.publication === 'pending') {
      if (Date.now() >= deadline) throw new Error('DNS publication still pending; retry certificate issuance later');
      await new Promise(resolve => setTimeout(resolve, 2000));
      result = await call(origin, '/status', { rawHostname: hostname }, key, options);
    }
  }
  return {
    propagationDelay: 60000,
    async init() {},
    async zones() { return [`${hostname}.${baseDomain}`]; },
    async set({ challenge }) { validate(challenge); await publish({ value: challenge.dnsAuthorization }); },
    async remove({ challenge }) { validate(challenge); await publish({ value: challenge.dnsAuthorization, action: 'remove' }); },
    async get({ challenge }) {
      validate(challenge);
      const resolver = new Resolver({ timeout: 5000, tries: 2 });
      try {
        const records = await resolver.resolveTxt(dnsHost);
        return records.some(chunks => chunks.join('') === challenge.dnsAuthorization)
          ? { dnsAuthorization: challenge.dnsAuthorization } : null;
      } catch (error) {
        if (['ENODATA', 'ENOTFOUND'].includes(error.code)) return null;
        throw error;
      }
    },
  };
}

module.exports = { create };
