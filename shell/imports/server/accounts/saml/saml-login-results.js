import Crypto from "crypto";
import { Random } from "meteor/random";

export const SAML_LOGIN_RESULT_TIMEOUT_MS = 10 * 60 * 1000;
export const MAX_SAML_LOGIN_RESULTS = 10000;

const results = new Map();

function hashSecret(secret) {
  return Crypto.createHash("sha256").update(secret).digest();
}

function prune(now) {
  for (const [token, entry] of results) {
    if (now - entry.timestamp <= SAML_LOGIN_RESULT_TIMEOUT_MS) break;
    results.delete(token);
  }
}

export const SamlLoginResults = {
  store(token, profile, now = Date.now()) {
    if (typeof token !== "string" || token.length === 0) {
      throw new Error("SAML login result requires a nonempty token");
    }

    // Match the bounded pending-request cache. Replacing a token must also move
    // it to the end, so eviction continues to remove the oldest results first.
    results.delete(token);
    prune(now);
    if (results.size >= MAX_SAML_LOGIN_RESULTS) {
      results.delete(results.keys().next().value);
    }
    const credentialSecret = Random.secret();
    results.set(token, {
      profile,
      secretHash: hashSecret(credentialSecret),
      timestamp: now,
    });
    return credentialSecret;
  },

  take(token, credentialSecret, now = Date.now()) {
    if (typeof token !== "string" || typeof credentialSecret !== "string") {
      return null;
    }

    const entry = results.get(token);
    if (!entry) return null;

    if (now - entry.timestamp > SAML_LOGIN_RESULT_TIMEOUT_MS) {
      results.delete(token);
      return null;
    }

    const provided = hashSecret(credentialSecret);
    if (provided.length !== entry.secretHash.length ||
        !Crypto.timingSafeEqual(provided, entry.secretHash)) {
      return null;
    }

    results.delete(token);
    return entry.profile;
  },

  clear() {
    results.clear();
  },
};
