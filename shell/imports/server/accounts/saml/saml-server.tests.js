// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2026 Sandstorm Development Group, Inc. and contributors
// All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.


import zlib from "zlib";

import chai from "chai";

import { Accounts } from "meteor/accounts-base";
import { httpCallAsync } from "/imports/server/http-helpers";
import { Meteor } from "meteor/meteor";
import { Random } from "meteor/random";

import { SandstormDb } from "/imports/sandstorm-db/db";
import { SamlLoginCache } from "/imports/server/accounts/saml/saml-server";
import { SAML } from "/imports/server/accounts/saml-utils";
import samlFixtures from "/imports/server/saml-test-fixtures.json";

const assert = chai.assert;
const settings = new SandstormDb().collections.settings;

const SAML_SETTING_IDS = [
  "saml",
  "samlEntryPoint",
  "samlLogout",
  "samlPublicCert",
  "samlEntityId",
];

async function setSamlSettingsForTests() {
  await settings.upsertAsync({ _id: "samlEntryPoint" }, { $set: { value: "https://idp.example/sso" } });
  await settings.upsertAsync({ _id: "samlLogout" }, { $set: { value: "https://idp.example/logout" } });
  await settings.upsertAsync({ _id: "samlPublicCert" }, { $set: { value: "MIIB_FAKE_CERT_FOR_TESTS" } });
  await settings.upsertAsync({ _id: "samlEntityId" }, { $set: { value: "https://sp.example/entity" } });
}

async function clearSamlSettingsForTests() {
  await settings.removeAsync({ _id: { $in: SAML_SETTING_IDS } });
}

function makeId(prefix) {
  return prefix + "-" + Random.id();
}

function getMethodHandler(name) {
  const handlers = Meteor.server && (Meteor.server.method_handlers || Meteor.server.methodHandlers);
  assert.isOk(handlers, "Meteor method handler map unavailable");
  const handler = handlers[name];
  assert.isFunction(handler, "Method handler missing: " + name);
  return handler;
}

if (Meteor.isServer) {
  describe("SAML server methods", function () {
    this.timeout(10000);

    it("generateSamlLogout resolves logout URL from a linked SAML credential", async function () {
      await setSamlSettingsForTests();

      const accountId = makeId("saml-account");
      const credentialId = makeId("saml-credential");
      const captured = {};
      const originalGetLogoutUrl = SAML.prototype.getLogoutUrl;

      await Meteor.users.insertAsync({
        _id: credentialId,
        type: "credential",
        services: {
          saml: {
            id: "test-nameid",
            nameIDFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
          },
        },
      });

      await Meteor.users.insertAsync({
        _id: accountId,
        type: "account",
        loginCredentials: [{ id: credentialId }],
        nonloginCredentials: [],
      });

      try {
        SAML.prototype.getLogoutUrl = function (req, callback) {
          captured.req = req;
          callback(null, "https://idp.example/logout?SAMLRequest=test");
        };

        const result = await getMethodHandler("generateSamlLogout").apply({
          userId: accountId,
          connection: {},
        }, []);

        assert.equal(result, "https://idp.example/logout?SAMLRequest=test");
        assert.isOk(captured.req);
        assert.equal(captured.req.user.nameID, "test-nameid");
        assert.equal(captured.req.user.nameIDFormat,
            "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent");
      } finally {
        SAML.prototype.getLogoutUrl = originalGetLogoutUrl;
        await Meteor.users.removeAsync({ _id: { $in: [accountId, credentialId] } });
        await clearSamlSettingsForTests();
      }
    });

    it("generateSamlLogout rejects unauthenticated callers", async function () {
      await setSamlSettingsForTests();
      try {
        await getMethodHandler("generateSamlLogout").apply({
          userId: null,
          connection: {},
        }, []);
        assert.fail("Expected generateSamlLogout to reject unauthenticated user");
      } catch (err) {
        assert.equal(err.error, 403);
        assert.match(err.message || "", /Not logged in/i);
      } finally {
        await clearSamlSettingsForTests();
      }
    });

    it("validateSamlLogout accepts a request matching the logged-in account", async function () {
      await setSamlSettingsForTests();

      const accountId = makeId("saml-account");
      const credentialId = makeId("saml-credential");
      const originalParseLogoutRequest = SAML.prototype.parseLogoutRequest;
      const logoutNameId = "nameid-" + Random.id();

      await Meteor.users.insertAsync({
        _id: credentialId,
        type: "credential",
        services: {
          saml: { id: logoutNameId },
        },
      });

      await Meteor.users.insertAsync({
        _id: accountId,
        type: "account",
        loginCredentials: [{ id: credentialId }],
        nonloginCredentials: [],
      });

      const dbContext = {
        collections: {
          users: Meteor.users,
        },
      };

      const encodedLogoutRequest = zlib.deflateRawSync(
          Buffer.from("<samlp:LogoutRequest/>", "utf8")).toString("base64");

      try {
        SAML.prototype.parseLogoutRequest = function (_xml, callback) {
          callback(null, logoutNameId);
        };

        const result = await getMethodHandler("validateSamlLogout").apply({
          userId: accountId,
          connection: { sandstormDb: dbContext },
        }, [encodedLogoutRequest]);

        assert.isUndefined(result);
      } finally {
        SAML.prototype.parseLogoutRequest = originalParseLogoutRequest;
        await Meteor.users.removeAsync({ _id: { $in: [accountId, credentialId] } });
        await clearSamlSettingsForTests();
      }
    });

    it("validateSamlLogout rejects cross-account logout requests", async function () {
      await setSamlSettingsForTests();

      const accountId = makeId("saml-account");
      const attackerAccountId = makeId("attacker-account");
      const credentialId = makeId("saml-credential");
      const originalParseLogoutRequest = SAML.prototype.parseLogoutRequest;
      const originalConsoleError = console.error;
      const logoutNameId = "nameid-" + Random.id();

      await Meteor.users.insertAsync({
        _id: credentialId,
        type: "credential",
        services: {
          saml: { id: logoutNameId },
        },
      });

      await Meteor.users.insertAsync({
        _id: accountId,
        type: "account",
        loginCredentials: [{ id: credentialId }],
        nonloginCredentials: [],
      });

      await Meteor.users.insertAsync({
        _id: attackerAccountId,
        type: "account",
        loginCredentials: [],
        nonloginCredentials: [],
      });

      const dbContext = {
        collections: {
          users: Meteor.users,
        },
      };

      const encodedLogoutRequest = zlib.deflateRawSync(
          Buffer.from("<samlp:LogoutRequest/>", "utf8")).toString("base64");

      try {
        console.error = function () {};
        SAML.prototype.parseLogoutRequest = function (_xml, callback) {
          callback(null, logoutNameId);
        };

        await getMethodHandler("validateSamlLogout").apply({
          userId: attackerAccountId,
          connection: { sandstormDb: dbContext },
        }, [encodedLogoutRequest]);
        assert.fail("Expected cross-account logout validation to fail");
      } catch (err) {
        assert.match(err.message || "", /wrong user/i);
      } finally {
        console.error = originalConsoleError;
        SAML.prototype.parseLogoutRequest = originalParseLogoutRequest;
        await Meteor.users.removeAsync({ _id: { $in: [accountId, attackerAccountId, credentialId] } });
        await clearSamlSettingsForTests();
      }
    });
  });

  describe("Pending SAML requests", function () {
    it("keeps the newest 10000 requests and consumes each once", function () {
      const pending = new SamlLoginCache();
      for (let i = 0; i <= 10000; i++) pending.remember("request-" + i, "credential-" + i);
      assert.isUndefined(pending.consume("request-0"));
      for (let i = 1; i <= 10000; i++) {
        assert.equal(pending.consume("request-" + i), "credential-" + i);
        assert.isUndefined(pending.consume("request-" + i));
      }
      assert.isUndefined(pending.consume("unknown-request"));
    });

    it("expires completed profiles and consumes them once", function () {
      const cache = new SamlLoginCache();
      const profile = { email: "user@example.com" };
      cache.remember("credential", { profile });
      assert.deepEqual(cache.consume("credential"), { profile });
      assert.isUndefined(cache.consume("credential"));
    });

    it("expires old requests without evicting fresh or renewed requests", function () {
      const originalNow = Date.now;
      let now = originalNow();
      try {
        Date.now = () => now;
        const pending = new SamlLoginCache();
        pending.remember("renewed", "old-credential");
        pending.remember("expired", "expired-credential");
        now += 1;
        pending.remember("renewed", "new-credential");
        now += 10 * 60 * 1000 - 1;
        for (let i = 0; i < 9999; i++) pending.remember("fresh-" + i, "credential-" + i);
        assert.isUndefined(pending.consume("expired"));
        assert.equal(pending.consume("renewed"), "new-credential");
        for (let i = 0; i < 9999; i++) {
          assert.equal(pending.consume("fresh-" + i), "credential-" + i);
        }
        pending.remember("timeout", "credential");
        now += 10 * 60 * 1000;
        assert.isUndefined(pending.consume("timeout"));
      } finally {
        Date.now = originalNow;
      }
    });
  });

  describe("SAML response request matching", function () {
    const validate = xml => new Promise(resolve => {
      new SAML({ cert: samlFixtures.cert }).validateResponse(
          Buffer.from(xml).toString("base64"), (error, profile) => resolve({ error, profile }));
    });

    it("takes the request ID from signed content for either signature placement", async function () {
      for (const xml of [samlFixtures.valid, samlFixtures.signedResponse,
        samlFixtures.valid.replace(' InResponseTo="security-audit-token"', "")]) {
        const result = await validate(xml);
        assert.isNull(result.error);
        assert.equal(result.profile.inResponseToId, "security-audit-token");
      }
    });

    it("keeps ordinary attributes separate from verified protocol fields", async function () {
      const result = await validate(samlFixtures.attributeCollisions);
      assert.isNull(result.error);
      assert.equal(result.profile.inResponseToId, "security-audit-token");
      assert.equal(result.profile.nameID, "attacker@example.com");
      assert.equal(result.profile.email, "attribute@example.com");
      assert.equal(result.profile.displayName, "Attribute Name");
    });

    it("rejects missing signed confirmation and changed unsigned routing fields", async function () {
      for (const xml of [samlFixtures.missingConfirmation,
        samlFixtures.valid.replace('InResponseTo="security-audit-token"',
          'InResponseTo="other-request"'),
        samlFixtures.valid.replace("<samlp:Response ",
          '<samlp:Response Destination="https://other.example/" ')]) {
        const result = await validate(xml);
        assert.instanceOf(result.error, Error);
        assert.isNull(result.profile);
      }
    });
  });

  describe("SAML config endpoint", function () {
    this.timeout(10000);

    it("serves SAML metadata at /_saml/config/default", async function () {
      await setSamlSettingsForTests();

      try {
        const response = await httpCallAsync("GET", Meteor.absoluteUrl("_saml/config/default"));
        assert.equal(response.statusCode, 200);
        assert.match(response.headers["content-type"] || "", /text\/xml/i);
        assert.include(response.content, "EntityDescriptor");
        assert.include(response.content, "_saml/validate/default");
        assert.include(response.content, "SingleLogoutService");
      } finally {
        await clearSamlSettingsForTests();
      }
    });

    it("rejects validate responses that omit signed InResponseTo", async function () {
      await setSamlSettingsForTests();

      const hadLoginServices = !!Accounts.loginServices;
      if (!Accounts.loginServices) {
        Accounts.loginServices = {};
      }

      const hadSamlLoginService = !!Accounts.loginServices.saml;
      if (!Accounts.loginServices.saml) {
        Accounts.loginServices.saml = {};
      }

      const originalIsEnabled = Accounts.loginServices.saml.isEnabled;
      const originalValidateResponse = SAML.prototype.validateResponse;
      const originalConsoleError = console.error;

      try {
        console.error = function () {};
        Accounts.loginServices.saml.isEnabled = function () {
          return true;
        };

        SAML.prototype.validateResponse = function (_samlResponse, callback) {
          callback(null, { email: "user@example.com" }, false, "<xml/>");
        };

        const response = await httpCallAsync("POST",
            Meteor.absoluteUrl("_saml/validate/default/forged-credential-token"), {
              content: "SAMLResponse=dummy",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
              },
            });

        assert.equal(response.statusCode, 200);
        assert.include(response.content, "SAML response missing InResponseTo");
      } finally {
        console.error = originalConsoleError;
        if (hadSamlLoginService) {
          Accounts.loginServices.saml.isEnabled = originalIsEnabled;
        } else {
          delete Accounts.loginServices.saml;
        }

        if (!hadLoginServices) {
          delete Accounts.loginServices;
        }

        SAML.prototype.validateResponse = originalValidateResponse;
        await clearSamlSettingsForTests();
      }
    });

    it("accepts each pending request once and rejects expired requests", async function () {
      await setSamlSettingsForTests();
      const previousServices = Accounts.loginServices;
      const previousSaml = previousServices && previousServices.saml;
      const originalGetAuthorizeUrl = SAML.prototype.getAuthorizeUrl;
      const originalValidateResponse = SAML.prototype.validateResponse;
      const originalConsoleError = console.error;
      const originalNow = Date.now;
      let requestId;
      let responseId;
      const token = makeId("credential");
      try {
        Accounts.loginServices = { ...previousServices, saml: { isEnabled: () => true } };
        console.error = function () {};
        SAML.prototype.getAuthorizeUrl = function (_req, callback) {
          requestId = this.options.id;
          callback(null, Meteor.absoluteUrl("_saml/config/default"));
        };
        SAML.prototype.validateResponse = function (_xml, callback) {
          callback(null, { email: "user@example.com", inResponseToId: responseId });
        };
        const authorize = () => httpCallAsync("GET",
            Meteor.absoluteUrl("_saml/authorize/default/" + token));
        const validate = () => httpCallAsync("POST", Meteor.absoluteUrl("_saml/validate/default"), {
          content: "SAMLResponse=dummy",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        });
        await authorize();
        assert.notEqual(requestId, token);
        responseId = requestId;
        assert.notInclude((await validate()).content, "error occured");
        assert.include((await validate()).content, "pending login request");

        // Reusing the browser token must not revive the old request ID.
        const oldRequestId = requestId;
        await authorize();
        assert.notEqual(requestId, oldRequestId);
        assert.include((await validate()).content, "pending login request");
        responseId = requestId;
        assert.notInclude((await validate()).content, "error occured");

        Date.now = () => originalNow() - 11 * 60 * 1000;
        await authorize();
        Date.now = originalNow;
        responseId = requestId;
        assert.include((await validate()).content, "pending login request");
      } finally {
        Date.now = originalNow;
        console.error = originalConsoleError;
        SAML.prototype.getAuthorizeUrl = originalGetAuthorizeUrl;
        SAML.prototype.validateResponse = originalValidateResponse;
        Accounts.loginServices = previousServices;
        if (previousServices) Accounts.loginServices.saml = previousSaml;
        await clearSamlSettingsForTests();
      }
    });

    it("rejects validate responses for login requests this server did not initiate", async function () {
      await setSamlSettingsForTests();

      const hadLoginServices = !!Accounts.loginServices;
      if (!Accounts.loginServices) {
        Accounts.loginServices = {};
      }

      const hadSamlLoginService = !!Accounts.loginServices.saml;
      if (!Accounts.loginServices.saml) {
        Accounts.loginServices.saml = {};
      }

      const originalIsEnabled = Accounts.loginServices.saml.isEnabled;
      const originalValidateResponse = SAML.prototype.validateResponse;
      const originalConsoleError = console.error;

      try {
        console.error = function () {};
        Accounts.loginServices.saml.isEnabled = function () {
          return true;
        };

        SAML.prototype.validateResponse = function (_samlResponse, callback) {
          callback(null, {
            email: "user@example.com",
            inResponseToId: "forged-credential-token",
          }, false, "<xml/>");
        };

        const response = await httpCallAsync("POST",
            Meteor.absoluteUrl("_saml/validate/default/forged-credential-token"), {
              content: "SAMLResponse=dummy",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
              },
            });

        assert.equal(response.statusCode, 200);
        assert.include(response.content, "pending login request");
      } finally {
        console.error = originalConsoleError;
        if (hadSamlLoginService) {
          Accounts.loginServices.saml.isEnabled = originalIsEnabled;
        } else {
          delete Accounts.loginServices.saml;
        }

        if (!hadLoginServices) {
          delete Accounts.loginServices;
        }

        SAML.prototype.validateResponse = originalValidateResponse;
        await clearSamlSettingsForTests();
      }
    });
  });
}

describe("SAML signed content", function () {
  this.timeout(15000);
  it("checks rejected inputs and successful controls", async function () {
  const validate = (xml, cert) => new Promise((resolve) => {
    const saml = new SAML({ cert, entryPoint: "https://idp.example", issuer: "test-saml" });
    saml.validateResponse(Buffer.from(xml).toString("base64"), (error, profile) => {
      resolve({ error, profile });
    });
  });
  for (const cert of [samlFixtures.cert, samlFixtures.cert.replace(/-----[^\n]+-----/g, "").replace(/\s/g, "")]) {
    const valid = await validate(samlFixtures.valid, cert);
    if (valid.error || !valid.profile || valid.profile.nameID !== "attacker@example.com" ||
        valid.profile.inResponseToId !== "security-audit-token") {
      throw new Error("Signed SAML control failed: " + valid.error);
    }
  }
  const signedResponse = await validate(samlFixtures.signedResponse, samlFixtures.cert);
  if (signedResponse.error || !signedResponse.profile || signedResponse.profile.nameID !== "victim@example.com") {
    throw new Error("Signed response control failed: " + signedResponse.error);
  }
  for (const [name, xml, cert] of [
    ["missing certificate", samlFixtures.unsigned, ""],
    ["missing signed confirmation", samlFixtures.missingConfirmation, samlFixtures.cert],
    ["changed outer request ID", samlFixtures.valid.replace('InResponseTo="security-audit-token"',
      'InResponseTo="other-request"'), samlFixtures.cert],
    ["added outer destination", samlFixtures.valid.replace("<samlp:Response ",
      '<samlp:Response Destination="https://other.example/" '), samlFixtures.cert],
    ["unsigned assertion", samlFixtures.unsigned, samlFixtures.cert],
    ["extra assertion", samlFixtures.wrapped, samlFixtures.cert],
    ["modified identity", samlFixtures.valid.replace("attacker@example.com", "other@example.com"), samlFixtures.cert],
    ["modified signed response", samlFixtures.signedResponse.replace("victim@example.com", "other@example.com"), samlFixtures.cert],
    ["malformed response", "<invalid>", samlFixtures.cert],
  ]) {
    const result = await validate(xml, cert);
    if (!result.error || result.profile) throw new Error("Accepted " + name);
  }
  return true;
  });
});
