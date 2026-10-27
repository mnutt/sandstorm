import chai from "chai";
import { Meteor } from "meteor/meteor";

import {
  SamlLoginResults,
  SAML_LOGIN_RESULT_TIMEOUT_MS,
  MAX_SAML_LOGIN_RESULTS,
} from "/imports/server/accounts/saml/saml-login-results";

const assert = chai.assert;

if (Meteor.isServer) {
  describe("SAML login results", function () {
    beforeEach(function () {
      SamlLoginResults.clear();
    });

    it("does not treat prototype names as login results", function () {
      for (const token of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
        assert.isNull(SamlLoginResults.take(token, "secret"));
      }
    });

    it("requires the credential secret and consumes the result once", function () {
      const now = Date.now();
      const profile = { email: "victim@example.com", nameID: "victim" };
      const secret = SamlLoginResults.store("login-token", profile, now);

      assert.isString(secret);
      assert.isNull(SamlLoginResults.take("login-token", "wrong-secret", now));
      assert.deepEqual(SamlLoginResults.take("login-token", secret, now), profile);
      assert.isNull(SamlLoginResults.take("login-token", secret, now));
    });

    it("stores a token literally named __proto__ and consumes it once", function () {
      const now = Date.now();
      const profile = { email: "victim@example.com", nameID: "victim" };
      const secret = SamlLoginResults.store("__proto__", profile, now);

      assert.deepEqual(SamlLoginResults.take("__proto__", secret, now), profile);
      assert.isNull(SamlLoginResults.take("__proto__", secret, now));
    });

    it("rejects an expired login result", function () {
      const now = Date.now();
      const profile = { email: "victim@example.com", nameID: "victim" };
      const secret = SamlLoginResults.store("expired-token", profile, now);

      assert.isNull(SamlLoginResults.take(
        "expired-token", secret, now + SAML_LOGIN_RESULT_TIMEOUT_MS + 1));
      assert.isNull(SamlLoginResults.take("expired-token", secret, now));
    });

    it("evicts the oldest result when the cache reaches its limit", function () {
      const now = Date.now();
      const profile = { email: "user@example.com" };
      const oldest = SamlLoginResults.store("oldest", profile, now);
      for (let i = 1; i < MAX_SAML_LOGIN_RESULTS; i++) {
        SamlLoginResults.store("token-" + i, profile, now);
      }

      const newest = SamlLoginResults.store("newest", profile, now);
      assert.isNull(SamlLoginResults.take("oldest", oldest, now));
      assert.deepEqual(SamlLoginResults.take("newest", newest, now), profile);
    });

    it("treats a replacement as new without evicting an unrelated result", function () {
      const now = Date.now();
      const profile = { email: "user@example.com" };
      const oldSecret = SamlLoginResults.store("replaced", profile, now);
      const nextOldest = SamlLoginResults.store("next-oldest", profile, now);
      for (let i = 2; i < MAX_SAML_LOGIN_RESULTS; i++) {
        SamlLoginResults.store("token-" + i, profile, now);
      }

      const newSecret = SamlLoginResults.store("replaced", profile, now);
      assert.isNull(SamlLoginResults.take("replaced", oldSecret, now));
      assert.deepEqual(SamlLoginResults.take("next-oldest", nextOldest, now), profile);
      SamlLoginResults.store("fill-slot", profile, now);
      SamlLoginResults.store("overflow", profile, now);
      assert.deepEqual(SamlLoginResults.take("replaced", newSecret, now), profile);
    });
  });
}
