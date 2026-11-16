// Sandhost v1 protocol client, adapted from sandhost/client for CommonJS.
// Used by the Meteor server; keep wire compatibility with the Bash installer and Sandhost.
"use strict";

const { call, apiHeaders } = require('./index.js');
const { transport } = require('./transport.js');
const { observedAddress, apiUrl } = require('./validation.js');
const { addressConfig } = require('./config.js');

class Updater {
  constructor({ origin, rawHostname, privateKey, baseDomain,
    localAddress, apiToken, allowLocalHttp = false,
    addressMode = 'observed', ipAddress = '', request = transport }) {
    this.origin = origin; this.rawHostname = rawHostname; this.privateKey = privateKey;
    this.expectedHostname = baseDomain && rawHostname + '.' + baseDomain;
    this.discoveryUrl = origin + '/check-ip';
    if (apiUrl(origin, allowLocalHttp).origin !== origin) throw new Error('Invalid Sandcats API origin');
    this.options = { localAddress, apiToken, allowLocalHttp, transport: request };
    this.request = request;
    this.state = null;
    this.desiredAddress = addressConfig(addressMode, ipAddress);
    this.refreshedAt = 0;
  }
  async api(path, fields = {}) {
    const result = await call(this.origin, path, { ...fields, rawHostname: this.rawHostname }, this.privateKey, this.options);
    if (this.expectedHostname && result.hostname !== this.expectedHostname) {
      throw new Error('Sandcats API hostname does not match SANDCATS_BASE_DOMAIN');
    }
    return result;
  }
  async refresh() {
    this.state = await this.api('/status');
    this.refreshedAt = Date.now();
    return this.state;
  }
  async check() {
    // Re-read authoritative state once on process startup; never trust a stale disk cache.
    if (!this.state || Date.now() - this.refreshedAt > 300000) await this.refresh();
    if (this.state.publication === 'pending') return this.refresh();
    if (this.state.addressMode !== this.desiredAddress.addressMode) {
      this.state = await this.api('/set-address-mode', this.desiredAddress);
      return this.state;
    }
    if (this.desiredAddress.addressMode === 'explicit') {
      if (this.state.ipAddress !== this.desiredAddress.ipAddress) {
        this.state = await this.api('/update-address', { ipAddress: this.desiredAddress.ipAddress });
      }
      return this.state;
    }
    const response = await this.request(new Request(this.discoveryUrl, {
      headers: { ...apiHeaders(this.options), 'Cache-Control': 'no-cache' },
    }), this.options);
    if (!response.ok) throw new Error(`IP discovery failed: ${response.status}`);
    const address = observedAddress((await response.json()).ipAddress);
    if (address === this.state.ipAddress) return this.state;
    try {
      // Discovery is a hint only. The service independently observes this authenticated request.
      this.state = await this.api('/update');
    } catch (error) {
      if (error.code === 'explicit_mode_requires_update_address') return this.refresh();
      throw error;
    }
    return this.state;
  }
}

// Schedule after completion: slow requests never overlap. Errors back off up to 15 minutes.
function startUpdater(updater, { schedule = setTimeout, cancel = clearTimeout,
  random = Math.random, onError = () => {} } = {}) {
  let stopped = false;
  let failures = 0;
  let timer;
  async function poll() {
    try {
      await updater.check();
      failures = 0;
    } catch (error) {
      updater.state = null;
      failures++;
      onError(error);
    }
    if (!stopped) {
      const seconds = Math.min(900, 60 * 2 ** Math.min(failures, 4));
      timer = schedule(poll, seconds * 1000 * (0.9 + random() * 0.2));
    }
  }
  timer = schedule(poll, 0);
  return () => { stopped = true; cancel(timer); };
}

module.exports = { Updater, startUpdater };
