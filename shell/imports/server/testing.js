import { open as openFile } from "node:fs/promises";
import { createNativeGrainBackup, nativeBackupDownload, restoreGrainBackup } from "/imports/server/backup";
import { manageGrainForUser } from "/imports/shared/grain-shared";
import { waitForGrainResponse } from "./rust-shell-grain-ready.mjs";
import { appInstallPermissions } from "/imports/server/install-server";
import { grainMenu } from "/imports/server/rust-shell-grains";
import { SAML } from "/imports/server/accounts/saml-utils";
import Zlib from "node:zlib";
import { handleSamlRequest, finishNativeSaml, cancelNativeSaml } from "/imports/server/accounts/saml/saml-server";
import { rustNativeAuth, loginWithSaml } from "/imports/server/rust-shell-auth";
import { fetchApiToken } from "/imports/server/persistent";
import { rustPowerbox } from "/imports/server/rust-shell-powerbox";
import { finishOAuth, cancelOAuth } from "/imports/server/rust-shell-oauth";
import { OAuth } from "meteor/oauth";
import { redeemPowerboxWebkey } from "/imports/server/powerbox-webkey";
import Capnp from "/imports/server/capnp";
import { createRustShellBridge } from "./rust-shell-bridge-core.mjs";
// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
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

/* global MailchimpSubscribers */

import { Meteor } from "meteor/meteor";
import { Accounts } from "meteor/accounts-base";
import { Random } from "meteor/random";
import { SHA256 } from "meteor/sha";
import { ServiceConfiguration } from "meteor/service-configuration";
import "/imports/oidc/oidc-server";
import { globalDb } from "/imports/db-deprecated";
import { httpCallAsync } from "/imports/server/http-helpers";
import { checkAuthAsync, clearAdminToken } from "/imports/server/auth";
import { setAccountSuspensionEmailSenderForTests } from "/imports/server/account-suspension";
import { setAdminEmailSenderForTests } from "/imports/server/admin-server";
import {
  handleWebhookEvent,
  paymentMethodsForTests,
  setPaymentsHttpCallForTests,
  stripe as testStripe,
  updateMailchimp,
} from "/imports/blackrock-payments/server/payments-server";
import { MAILING_LIST_BONUS } from "/imports/blackrock-payments/constants";
import { LDAP } from "/imports/server/accounts/ldap";
import { validateSandstormLoginAttempt } from "/imports/server/accounts/accounts-server";
import {
  emailTokenLoginHandler,
  setTokenEmailSenderForTests,
} from "/imports/server/accounts/email-token/token-server";
import { reconcileOidcUsersIndex } from "/imports/server/migrations";
import {
  waitForMigrationDocument,
  waitForReplicaMigrations,
} from "/imports/server/migration-coordination";
import { closeRustSharedGrainSession, keepRustSharedGrainSession, inspectRustSharedGrain, createRustSharedGrainSession, createRustTemplateToken, rustGrainPowerboxContext, createRustGrainSession, keepRustGrainSession, closeRustGrainSession } from "/imports/server/gateway-router";
import { SandstormPermissions } from "/imports/sandstorm-permissions/permissions";
import { rustShellBridge, rustShellSessionStore, authorizeRustShellAccount } from "/imports/server/rust-shell-bridge";
import { renameGrainForUser, restartGrainForUser } from "/imports/server/grain-server";
import { runDueJobs } from "/imports/server/scheduled-job";
import {
  Downloader,
  setTransferCreateGrainBackupForTests,
  setTransferDownloaderDisabledForTests,
  setTransferDownloaderHooksForTests,
  setTransferHttpCallForTests,
} from "/imports/server/transfers-server";
import { SandstormAutoupdateApps } from "/imports/sandstorm-autoupdate-apps/autoupdate-apps";
import { isTesting } from "/imports/shared/testing";
import Crypto from "crypto";
import { EventEmitter } from "events";

const rustGrainTestSessions = new Map();
const rustNativePowerboxTests = new Map();

async function clearUser(id) {
  await globalDb.collections.userActions.removeAsync({ userId: id });
  await globalDb.removeApiTokens({ userId: id });
  const grains = await globalDb.collections.grains.find({ userId: id }).fetchAsync();
  for (const grain of grains) {
    await globalThis.globalBackend.deleteGrain(grain._id);
  }

  await globalDb.collections.grains.removeAsync({ userId: id });
  await Meteor.users.removeAsync({ _id: id });
}

function getMethodHandler(name) {
  const handlers = Meteor.server && (Meteor.server.method_handlers || Meteor.server.methodHandlers);
  if (!handlers || !handlers[name]) {
    throw new Meteor.Error("missing-method", name + " method not registered.");
  }

  return handlers[name];
}

function getPublishHandler(name) {
  const handlers = Meteor.server && (Meteor.server.publish_handlers || Meteor.server.publishHandlers);
  if (!handlers || !handlers[name]) {
    throw new Meteor.Error("missing-publication", name + " publication not registered.");
  }

  return handlers[name];
}

function makeFakeSubscription(userId) {
  const stopCallbacks = [];
  const sub = {
    userId,
    addedDocs: {},
    changedDocs: {},
    removedDocs: {},
    readyCalled: false,
    errors: [],

    added(collection, id, fields) {
      if (!this.addedDocs[collection]) this.addedDocs[collection] = {};
      this.addedDocs[collection][id] = fields;
    },

    changed(collection, id, fields) {
      if (!this.changedDocs[collection]) this.changedDocs[collection] = {};
      this.changedDocs[collection][id] = fields;
    },

    removed(collection, id) {
      if (!this.removedDocs[collection]) this.removedDocs[collection] = {};
      this.removedDocs[collection][id] = true;
    },

    ready() {
      this.readyCalled = true;
    },

    error(err) {
      this.errors.push(err);
    },

    onStop(callback) {
      stopCallbacks.push(callback);
    },

    stop() {
      stopCallbacks.forEach((callback) => callback());
    },
  };

  return sub;
}

function makeTestTokenRecord(token) {
  return {
    digest: SHA256(token),
    algorithm: "sha-256",
    createdAt: new Date(),
  };
}

function makeOidcIndexTestDb(indexes, duplicates) {
  const calls = [];
  const rawCollection = {
    async indexes() {
      calls.push(["indexes"]);
      if (indexes instanceof Error) throw indexes;
      return indexes;
    },

    async createIndex(key, options) {
      calls.push(["createIndex", key, options]);
    },

    async dropIndex(name) {
      calls.push(["dropIndex", name]);
    },

    aggregate(pipeline) {
      calls.push(["aggregate", pipeline]);
      return {
        async toArray() {
          calls.push(["toArray"]);
          return duplicates || [];
        },
      };
    },
  };

  return {
    calls,
    db: {
      collections: {
        users: {
          rawCollection() {
            calls.push(["rawCollection"]);
            return rawCollection;
          },
        },
      },
    },
  };
}

function hasCall(calls, predicate) {
  return calls.some(predicate);
}

function makeMigrationObserverTestCollection() {
  const observers = [];
  const collection = {
    find(selector) {
      return {
        async observeAsync(callbacks) {
          const observer = {
            callbacks,
            selector,
            stopCalls: 0,
            stopped: false,
          };
          observers.push(observer);
          await new Promise((resolve) => Meteor.setTimeout(resolve, 5));
          return {
            stop() {
              observer.stopCalls += 1;
              observer.stopped = true;
            },
          };
        },
      };
    },
  };

  return {
    collection,
    observers,
    emit(callbackName, doc) {
      observers.forEach((observer) => {
        if (!observer.stopped &&
            observer.selector._id === doc._id &&
            observer.callbacks[callbackName]) {
          observer.callbacks[callbackName](doc);
        }
      });
    },
  };
}

async function waitForTestCondition(predicate, description) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Meteor.Error("test-condition-timeout", "Timed out waiting for " + description);
    }

    await new Promise((resolve) => Meteor.setTimeout(resolve, 5));
  }
}

function getLastLine(text) {
  return text.trim().split("\n").pop();
}

function makeTransferResponse(statusCode) {
  const response = new EventEmitter();
  response.statusCode = statusCode;
  response.destroyed = false;
  response.destroy = function () {
    response.destroyed = true;
  };
  return response;
}

function makeTransferRequest(statusOrError, onEnd) {
  const request = new EventEmitter();
  request.ended = false;
  request.destroyed = false;
  request.end = function () {
    request.ended = true;
    Promise.resolve(onEnd && onEnd(request)).then(() => {
      Meteor.setTimeout(() => {
        if (statusOrError instanceof Error) {
          request.emit("error", statusOrError);
        } else {
          request.emit("response", makeTransferResponse(statusOrError));
        }
      }, 0);
    }, (err) => {
      Meteor.setTimeout(() => request.emit("error", err), 0);
    });
  };
  request.destroy = function () {
    request.destroyed = true;
    request.emit("error", new Error("Request canceled."));
  };
  return request;
}

if(isTesting) {
  Meteor.methods({
    async runDueJobsAt(whenMillis) {
      await runDueJobs(new Date(whenMillis));
    },

    createMockGithubUser: async function () {
      await Meteor.users.updateAsync({ _id: "Py8fwsaryQNGBuiXb" },
                          { $set: { createdAt: new Date("2014-08-11T21:44:04.147Z"), isAdmin: true, lastActive: new Date("2014-08-19T09:58:39.676Z"), profile: { name: "Github User" }, services: { github: { accessToken: "sometoken", id: 1595880, username: "testuser" }, resume: { loginTokens: [{ when: new Date("2099-08-13T05:16:02.356Z"),     hashedToken: "GriUSDp+uN/K4HptwSl1wsdWfHEpS8c9KjjdqwKNo0k=" }] } }, signupKey: "admin" } },
                          { upsert: true });
    },

    clearMockGithubUser: async function () {
      await clearUser("Py8fwsaryQNGBuiXb");
    },

    createMockGoogleUser: async function () {
      await Meteor.users.updateAsync({ _id: "6WJcRo2gg2Ysuxsok" },
                          { $set: { createdAt: new Date("2014-08-21T07:52:55.581Z"), profile: { name: "Google User" }, services: { google: { accessToken: "sometoken", expiresAt: 4562182723000, id: "116893057283177439912", verified_email: true, name: "Google User", given_name: "Google", family_name: "User", picture: "https://lh3.googleusercontent.com/-XdUIqdMkCWA/AAAAAAAAAAI/AAAAAAAAAAA/4252rscbv5M/photo.jpg", locale: "en", gender: "male" }, resume: { loginTokens: [{ when: new Date("2099-08-21T07:52:55.592Z"),   hashedToken: "cbJGxLGKW3f0j7Ehit77hdK58W7xuPjzZhGHgKhyddo=" }] } }, signupKey: "admin" } },
                         { upsert: true });
    },

    clearMockGoogleUser: async function () {
      await clearUser("6WJcRo2gg2Ysuxsok");
    },

    fetchAppIndexTest: async function () {
      await globalDb.collections.appIndex.removeAsync({});
      await SandstormAutoupdateApps.updateAppIndex(this.connection.sandstormDb);
    },

    testRegressionSetupSessionClear: async function () {
      const token = "test-setup-session-" + Random.secret();
      const hashedSessionId = Crypto.createHash("sha256").update(token).digest("base64");

      await globalDb.collections.setupSession.upsertAsync({ _id: "current-session" }, {
        _id: "current-session",
        hashedSessionId,
        creationDate: new Date(),
      });

      await checkAuthAsync(globalDb, null, token);

      const adminPublish = Meteor.server.publish_handlers.admin;
      if (!adminPublish) {
        throw new Meteor.Error("missing-admin-publication", "admin publication not registered.");
      }

      const adminCursor = await adminPublish.apply({
        userId: null,
        ready() {},
        onStop() {},
      }, [token]);
      if (!adminCursor || typeof adminCursor.fetchAsync !== "function") {
        throw new Meteor.Error("setup-session-publication-denied",
            "Fresh setup session token did not authorize admin publication.");
      }

      await clearAdminToken(token);

      const remaining = await globalDb.collections.setupSession.findOneAsync({
        _id: "current-session",
        hashedSessionId,
      });
      if (remaining) {
        throw new Meteor.Error("setup-session-not-cleared", "Setup session was not removed.");
      }

      try {
        await checkAuthAsync(globalDb, null, token);
      } catch (err) {
        if (err && err.error === 403) return true;
        throw err;
      }

      throw new Meteor.Error("setup-session-still-valid", "Setup session token still authorized.");
    },

    testRegressionLdapQuotaReturnValue: async function () {
      const userId = "test-ldap-account-" + Random.id();
      const credentialId = "test-ldap-credential-" + Random.id();
      const previousSetting = await globalDb.collections.settings.findOneAsync({ _id: "quotaLdapAttribute" });

      await Meteor.users.insertAsync({
        _id: userId,
        type: "account",
        loginCredentials: [{ id: credentialId }],
        nonloginCredentials: [],
        profile: { name: "LDAP quota test" },
        cachedStorageQuota: 100,
      });

      await Meteor.users.insertAsync({
        _id: credentialId,
        type: "credential",
        profile: { name: "LDAP quota test credential" },
        services: { email: { email: "ldap-quota-test@example.com" } },
      });

      try {
        await globalDb.collections.settings.upsertAsync({ _id: "quotaLdapAttribute" }, {
          _id: "quotaLdapAttribute",
          value: "quotaBytes",
        });

        const ldap = new LDAP();
        ldap.ldapCheck = async function () {
          return { searchResults: { quotaBytes: "123456" } };
        };

        const user = await Meteor.users.findOneAsync({ _id: userId });
        const quota = await ldap.updateUserQuota(globalDb, user);
        if (!quota || quota.storage !== 123456) {
          throw new Meteor.Error("ldap-quota-not-returned",
              "LDAP quota lookup returned " + JSON.stringify(quota));
        }

        const updatedUser = await Meteor.users.findOneAsync({ _id: userId });
        if (!updatedUser || updatedUser.cachedStorageQuota !== 123456) {
          throw new Meteor.Error("ldap-quota-not-cached", "LDAP quota was not cached on the user.");
        }

        return true;
      } finally {
        await Meteor.users.removeAsync({ _id: { $in: [userId, credentialId] } });
        if (previousSetting) {
          await globalDb.collections.settings.upsertAsync({ _id: "quotaLdapAttribute" }, previousSetting);
        } else {
          await globalDb.collections.settings.removeAsync({ _id: "quotaLdapAttribute" });
        }
      }
    },

    testRegressionEmailCredentialLinkAwaitsFailure: async function () {
      const accountId = "test-email-link-account-" + Random.id();
      const credentialId = "test-email-link-credential-" + Random.id();
      const email = "email-link-test-" + Random.id() + "@example.com";
      const token = "email-link-token-" + Random.secret();
      const originalLinkCredentialToAccount = Accounts.linkCredentialToAccount;

      await Meteor.users.insertAsync({
        _id: accountId,
        type: "account",
        loginCredentials: [{ id: "test-login-credential-" + Random.id() }],
        nonloginCredentials: [],
        profile: { name: "Email link test account" },
      });

      await Meteor.users.insertAsync({
        _id: credentialId,
        type: "credential",
        profile: { name: "Email link test credential" },
        services: {
          email: {
            email,
            tokens: [{ digest: SHA256(token), algorithm: "sha-256", createdAt: new Date() }],
          },
        },
      });

      try {
        Accounts.linkCredentialToAccount = async function () {
          await new Promise((resolve) => Meteor.setTimeout(resolve, 25));
          throw new Meteor.Error("test-link-failed", "Synthetic link failure.");
        };

        const handler = getMethodHandler("linkEmailCredentialToAccount");

        try {
          await handler.apply({
            userId: accountId,
            connection: {
              sandstormDb: globalDb,
              sandstormBackend: globalThis.globalBackend,
            },
          }, [email, token, false]);
        } catch (err) {
          if (err && err.error === "test-link-failed") {
            let linked = 0;
            Accounts.linkCredentialToAccount = async () => { ++linked; };
            await Meteor.users.updateAsync(credentialId, {$set:{'services.email.tokens':[
              {digest:SHA256(token),algorithm:'sha-256',createdAt:new Date()},
            ]}});
            const invoke = () => handler.apply({userId:accountId,connection:{sandstormDb:globalDb,sandstormBackend:globalThis.globalBackend}},[email,token,false]);
            const outcomes = await Promise.allSettled([invoke(),invoke()]);
            if (linked !== 1 || outcomes.filter(result=>result.status==='fulfilled').length !== 1) throw new Error('Email token was consumed more than once');
            await Meteor.users.updateAsync(credentialId, {$set:{'services.email.tokens':[
              {digest:SHA256(token),algorithm:'sha-256',createdAt:new Date(Date.now()-7200000)},
            ]}});
            let expired = false;
            try { await invoke(); } catch (error) { expired = error.error === 403; }
            if (!expired || linked !== 1) throw new Error('Expired email token was accepted');
            return true;
          }
          throw err;
        }

        throw new Meteor.Error("email-link-did-not-await",
            "linkEmailCredentialToAccount returned before Accounts.linkCredentialToAccount settled.");
      } finally {
        Accounts.linkCredentialToAccount = originalLinkCredentialToAccount;
        await Meteor.users.removeAsync({ _id: { $in: [accountId, credentialId] } });
      }
    },

    testRegressionOidcSigninAndIndexMigration: async function () {
      const configurations = ServiceConfiguration.configurations;
      const indexName = "services.oidc.id_1";
      const desiredKey = { "services.oidc.id": 1 };

      await configurations.removeAsync({ service: "oidc" });

      try {
        await configurations.insertAsync({
          service: "oidc",
          issuer: {
            issuer: "https://idp.example",
            authorization_endpoint: "https://idp.example/authorize",
            token_endpoint: "https://idp.example/token",
            userinfo_endpoint: "https://idp.example/userinfo",
            jwks_uri: "https://idp.example/jwks",
          },
          clientId: "sandstorm-client",
          secret: "test-secret",
          requestPermissions: ["openid", "email", "profile", "groups"],
        });

        const url = await getMethodHandler("resolveOidcSigninUrl").apply({
          userId: null,
          connection: {},
        }, ["state-token"]);
        const parsed = new URL(url);
        if (parsed.origin + parsed.pathname !== "https://idp.example/authorize") {
          throw new Meteor.Error("oidc-authorize-url", "Unexpected authorization URL: " + url);
        }

        if (parsed.searchParams.get("client_id") !== "sandstorm-client") {
          throw new Meteor.Error("oidc-client-id", "OIDC signin URL omitted client id.");
        }

        if (parsed.searchParams.get("state") !== "state-token") {
          throw new Meteor.Error("oidc-state", "OIDC signin URL omitted state.");
        }

        if (parsed.searchParams.get("scope") !== "openid email profile groups") {
          throw new Meteor.Error("oidc-scopes", "OIDC signin URL omitted requested scopes.");
        }

        if (!/\/_oauth\/oidc$/.test(parsed.searchParams.get("redirect_uri") || "")) {
          throw new Meteor.Error("oidc-redirect-uri", "OIDC signin URL omitted redirect URI.");
        }

        await configurations.removeAsync({ service: "oidc" });
        try {
          await getMethodHandler("resolveOidcSigninUrl").apply({
            userId: null,
            connection: {},
          }, ["state-token"]);
          throw new Meteor.Error("oidc-missing-config-accepted",
              "resolveOidcSigninUrl accepted missing OIDC configuration.");
        } catch (err) {
          if (!/Service oidc not configured/i.test(err.message || "")) throw err;
        }

        const namespaceNotFound = new Error("ns does not exist: meteor.users");
        namespaceNotFound.code = 26;
        namespaceNotFound.codeName = "NamespaceNotFound";
        let testDb = makeOidcIndexTestDb(namespaceNotFound);
        await reconcileOidcUsersIndex(testDb.db, null);
        if (!hasCall(testDb.calls, (call) =>
          call[0] === "createIndex" &&
          call[1]["services.oidc.id"] === 1 &&
          call[2].name === indexName)) {
          throw new Meteor.Error("oidc-index-fresh-install",
              "Fresh install did not create the OIDC index.");
        }

        testDb = makeOidcIndexTestDb([{ name: "_id_", key: { _id: 1 } }]);
        await reconcileOidcUsersIndex(testDb.db, null);
        if (!hasCall(testDb.calls, (call) =>
          call[0] === "createIndex" &&
          call[1]["services.oidc.id"] === 1 &&
          call[2].name === indexName &&
          call[2].unique === true &&
          call[2].sparse === true)) {
          throw new Meteor.Error("oidc-index-not-created", "Missing OIDC index was not created.");
        }

        testDb = makeOidcIndexTestDb([
          { name: indexName, key: desiredKey, unique: true, sparse: true },
        ]);
        await reconcileOidcUsersIndex(testDb.db, null);
        if (hasCall(testDb.calls, (call) => call[0] === "dropIndex" || call[0] === "createIndex")) {
          throw new Meteor.Error("oidc-index-recreated", "Correct OIDC index was changed.");
        }

        testDb = makeOidcIndexTestDb([
          { name: indexName, key: desiredKey, sparse: true },
        ], []);
        await reconcileOidcUsersIndex(testDb.db, null);
        if (!hasCall(testDb.calls, (call) => call[0] === "dropIndex" && call[1] === indexName) ||
            !hasCall(testDb.calls, (call) => call[0] === "createIndex")) {
          throw new Meteor.Error("oidc-index-not-replaced", "Non-unique OIDC index was not replaced.");
        }

        testDb = makeOidcIndexTestDb([
          { name: indexName, key: desiredKey, sparse: true },
        ], [{ _id: "duplicate-id", count: 2 }]);
        try {
          await reconcileOidcUsersIndex(testDb.db, null);
          throw new Meteor.Error("oidc-duplicates-accepted",
              "Duplicate OIDC IDs did not stop index migration.");
        } catch (err) {
          if (!/duplicate OIDC IDs/i.test(err.message || "")) throw err;
        }

        if (hasCall(testDb.calls, (call) => call[0] === "dropIndex" || call[0] === "createIndex")) {
          throw new Meteor.Error("oidc-duplicate-index-changed",
              "OIDC index changed despite duplicate OIDC IDs.");
        }

        return true;
      } finally {
        await configurations.removeAsync({ service: "oidc" });
      }
    },

    testRegressionReplicaMigrationCoordination: async function () {
      let earlyStopCalls = 0;
      const earlyCollection = {
        find() {
          return {
            observeAsync(callbacks) {
              callbacks.added({ _id: "migrations_applied", value: 42 });
              return new Promise((resolve) => {
                Meteor.setTimeout(() => resolve({
                  stop() {
                    earlyStopCalls += 1;
                  },
                }), 10);
              });
            },
          };
        },
      };

      await waitForMigrationDocument(
        earlyCollection,
        { _id: "migrations_applied" },
        (doc) => doc.value >= 42,
        { label: "test-observer-ready-race" }
      );
      await waitForTestCondition(() => earlyStopCalls === 1, "early observer cleanup");

      const fake = makeMigrationObserverTestCollection();
      const db = { collections: { migrations: fake.collection } };
      let completedReplicas = 0;
      const replicas = [
        waitForReplicaMigrations(db, 42).then(() => { completedReplicas += 1; }),
        waitForReplicaMigrations(db, 42).then(() => { completedReplicas += 1; }),
      ];

      await waitForTestCondition(() => fake.observers.length === 2, "replica migration observers");
      fake.emit("added", { _id: "migrations_applied", value: 41 });
      await new Promise((resolve) => Meteor.setTimeout(resolve, 10));
      if (completedReplicas !== 0) {
        throw new Meteor.Error("replica-finished-early",
            "A replica continued before the primary completed migrations.");
      }

      fake.emit("changed", { _id: "migrations_applied", value: 42 });
      await waitForTestCondition(() => fake.observers.length === 4, "new-server observers");
      fake.emit("added", { _id: "new_server_migrations_applied", value: false });
      await new Promise((resolve) => Meteor.setTimeout(resolve, 10));
      if (completedReplicas !== 0) {
        throw new Meteor.Error("replica-new-server-finished-early",
            "A replica continued before new-server initialization completed.");
      }

      fake.emit("changed", { _id: "new_server_migrations_applied", value: true });
      await Promise.all(replicas);
      await waitForTestCondition(
        () => fake.observers.every((observer) => observer.stopCalls === 1),
        "replica observer cleanup"
      );
      if (completedReplicas !== 2 || fake.observers.length !== 4) {
        throw new Meteor.Error("replica-coordination-count",
            "Replica migration coordination did not release both replicas exactly once.");
      }

      const observerError = new Error("synthetic observer failure");
      const failingCollection = {
        find() {
          return {
            observeAsync() {
              return Promise.reject(observerError);
            },
          };
        },
      };

      try {
        await waitForMigrationDocument(
          failingCollection,
          { _id: "migrations_applied" },
          () => false,
          { label: "test-observer-failure" }
        );
        throw new Meteor.Error("observer-failure-ignored",
            "A replica observer failure did not reject startup.");
      } catch (err) {
        if (err !== observerError) throw err;
      }

      return true;
    },

    testRegressionEmailTokenCreationAndLogin: async function () {
      const settingIds = ["emailToken", "serverTitle", "smtpConfig"];
      const sentEmails = [];
      const clearState = async () => {
        await Meteor.users.removeAsync({ "services.email.email": /^email-token-test-/ });
        await globalDb.collections.standaloneDomains.removeAsync({ _id: /^email-token-test-/ });
        await globalDb.collections.settings.removeAsync({ _id: { $in: settingIds } });
      };
      const configure = async () => {
        await globalDb.collections.settings.upsertAsync({ _id: "emailToken" }, { $set: { value: true } });
        await globalDb.collections.settings.upsertAsync({ _id: "serverTitle" },
            { $set: { value: "Test Sandstorm" } });
        await globalDb.collections.settings.upsertAsync({ _id: "smtpConfig" }, {
          $set: {
            value: {
              hostname: "smtp.example",
              port: 25,
              returnAddress: "no-reply@example.com",
            },
          },
        });
      };
      const callCreateToken = async (email, options) => {
        return await getMethodHandler("createAndEmailTokenForUser").apply({
          userId: null,
          connection: {
            sandstormDb: globalDb,
            sandstormBackend: globalThis.globalBackend,
          },
        }, [email, options]);
      };
      const optionsFor = (rootUrl) => ({
        resumePath: "/grain/test",
        rootUrl,
      });

      await clearState();
      await configure();
      setTokenEmailSenderForTests(async function (message) {
        await new Promise((resolve) => Meteor.setTimeout(resolve, 5));
        sentEmails.push(message);
      });

      try {
        try {
          await callCreateToken("email-token-test-invalid@example.com", optionsFor("https://attacker.example"));
          throw new Meteor.Error("email-token-invalid-root-accepted",
              "Invalid email-token rootUrl was accepted.");
        } catch (err) {
          if (err.error !== 400 || !/rootUrl is not valid/i.test(err.message || "")) throw err;
        }

        if (sentEmails.length !== 0) {
          throw new Meteor.Error("email-token-invalid-root-sent",
              "Invalid email-token rootUrl sent email.");
        }

        const standaloneHost = "email-token-test-standalone.example";
        const standaloneEmail = "email-token-test-standalone@example.com";
        await globalDb.collections.standaloneDomains.insertAsync({ _id: standaloneHost });
        await callCreateToken(standaloneEmail, optionsFor("http://" + standaloneHost));
        if (sentEmails.length !== 1) {
          throw new Meteor.Error("email-token-email-not-sent", "Email token send was not awaited.");
        }

        const firstEmail = sentEmails[0];
        if (firstEmail.to !== standaloneEmail ||
            firstEmail.from.name !== "Test Sandstorm" ||
            firstEmail.from.address !== "no-reply@example.com" ||
            !firstEmail.text.includes("http://" + standaloneHost + "/_emailLogin/") ||
            !getLastLine(firstEmail.text)) {
          throw new Meteor.Error("email-token-email-content",
              "Email token message did not include expected async title/address/link/token.");
        }

        const standaloneUser = await Meteor.users.findOneAsync({ "services.email.email": standaloneEmail });
        if (!standaloneUser || standaloneUser.services.email.tokens.length !== 1) {
          throw new Meteor.Error("email-token-standalone-user",
              "Standalone email token did not create a token-bearing credential.");
        }

        const existingEmail = "email-token-test-existing@example.com";
        const existingUserId = "test-email-token-user-" + Random.id();
        await Meteor.users.insertAsync({
          _id: existingUserId,
          services: {
            email: {
              email: existingEmail,
              tokens: [],
            },
          },
        });
        await callCreateToken(existingEmail, optionsFor(Meteor.absoluteUrl()));
        const existingUser = await Meteor.users.findOneAsync(existingUserId);
        if (existingUser.services.email.tokens.length !== 1) {
          throw new Meteor.Error("email-token-not-appended", "Email token was not appended.");
        }

        const rateLimitEmail = "email-token-test-rate-limit@example.com";
        await Meteor.users.insertAsync({
          _id: "test-email-token-user-" + Random.id(),
          services: {
            email: {
              email: rateLimitEmail,
              tokens: [
                makeTestTokenRecord("one"),
                makeTestTokenRecord("two"),
                makeTestTokenRecord("three"),
              ],
            },
          },
        });
        const sentBeforeRateLimit = sentEmails.length;
        try {
          await callCreateToken(rateLimitEmail, optionsFor(Meteor.absoluteUrl()));
          throw new Meteor.Error("email-token-rate-limit-accepted",
              "Too many active email tokens were accepted.");
        } catch (err) {
          if (err.error !== "alreadySentEmailToken") throw err;
        }

        if (sentEmails.length !== sentBeforeRateLimit) {
          throw new Meteor.Error("email-token-rate-limit-sent",
              "Rate-limited email token request sent email.");
        }

        const loginEmail = "email-token-test-login@example.com";
        const loginToken = "valid-token";
        const loginUserId = "test-email-token-user-" + Random.id();
        await Meteor.users.insertAsync({
          _id: loginUserId,
          services: {
            email: {
              email: loginEmail,
              tokens: [makeTestTokenRecord(loginToken)],
            },
          },
        });

        const loginResult = await emailTokenLoginHandler({
          email: {
            email: loginEmail,
            token: " " + loginToken + " ",
          },
        });
        if (!loginResult || loginResult.userId !== loginUserId) {
          throw new Meteor.Error("email-token-login-user",
              "Valid email token did not return the expected user id.");
        }

        const consumedUser = await Meteor.users.findOneAsync(loginUserId);
        if ((consumedUser.services.email.tokens || []).length !== 0) {
          throw new Meteor.Error("email-token-not-consumed", "Valid email token was not consumed.");
        }

        const invalidLoginEmail = "email-token-test-invalid-login@example.com";
        const invalidLoginUserId = "test-email-token-user-" + Random.id();
        await Meteor.users.insertAsync({
          _id: invalidLoginUserId,
          services: {
            email: {
              email: invalidLoginEmail,
              tokens: [makeTestTokenRecord("still-valid")],
            },
          },
        });

        const invalidLoginResult = await emailTokenLoginHandler({
          email: {
            email: invalidLoginEmail,
            token: "wrong-token",
          },
        });
        if (!invalidLoginResult.error ||
            invalidLoginResult.error.error !== 403 ||
            !/Invalid authentication code/i.test(invalidLoginResult.error.message || "")) {
          throw new Meteor.Error("email-token-invalid-login",
              "Invalid email token did not return the expected login error.");
        }

        const invalidLoginUser = await Meteor.users.findOneAsync(invalidLoginUserId);
        if (invalidLoginUser.services.email.tokens.length !== 1) {
          throw new Meteor.Error("email-token-invalid-consumed",
              "Invalid email token consumed an active token.");
        }

        return true;
      } finally {
        setTokenEmailSenderForTests(null);
        await clearState();
      }
    },

    testRegressionAccountSuspensionAndDeletion: async function () {
      const adminId = "test-suspension-admin-" + Random.id();
      const adminCredentialId = "test-suspension-admin-credential-" + Random.id();
      const targetId = "test-suspension-target-" + Random.id();
      const targetCredentialId = "test-suspension-target-credential-" + Random.id();
      const selfDeleteId = "test-suspension-self-delete-" + Random.id();
      const selfDeleteCredentialId = "test-suspension-self-delete-credential-" + Random.id();
      const orgUserId = "test-suspension-org-user-" + Random.id();
      const orgCredentialId = "test-suspension-org-credential-" + Random.id();
      const eligibleDeleteId = "test-suspension-eligible-delete-" + Random.id();
      const eligibleDeleteCredentialId = "test-suspension-eligible-credential-" + Random.id();
      const recentDeleteId = "test-suspension-recent-delete-" + Random.id();
      const recentDeleteCredentialId = "test-suspension-recent-credential-" + Random.id();
      const grainId = "testSuspensionGrain" + Random.id().replace(/[^a-zA-Z0-9]/g, "");
      const apiTokenId = "test-suspension-token-" + Random.id();
      const sentEmails = [];
      const suspendedPaymentUsers = [];
      const backendDeletedUsers = [];
      const callbackDeletedUsers = [];
      const oldStripePublicKey = Meteor.settings.public.stripePublicKey;
      const oldPaymentsSuspend = globalThis.BlackrockPayments.suspendAccount;

      const insertAccountWithCredential = async (accountId, credentialId, email, fields) => {
        await Meteor.users.insertAsync({
          _id: credentialId,
          type: "credential",
          services: {
            email: { email },
            resume: { loginTokens: [{ token: credentialId + "-token" }] },
          },
          profile: { name: "Suspension test credential" },
        });
        await Meteor.users.insertAsync({
          _id: accountId,
          type: "account",
          signupKey: "admin",
          loginCredentials: [{ id: credentialId }],
          nonloginCredentials: [],
          primaryEmail: email,
          services: { resume: { loginTokens: [{ token: accountId + "-token" }] } },
          profile: { name: "Suspension test account" },
          ...fields,
        });
      };
      const callSuspensionMethod = async (name, userId, args) => {
        return await getMethodHandler(name).apply({
          userId,
          connection: {
            sandstormDb: globalDb,
            sandstormBackend: globalThis.globalBackend,
          },
        }, args);
      };
      const hasResumeLoginTokens = (user) =>
        !!(user.services && user.services.resume && user.services.resume.loginTokens);

      setAccountSuspensionEmailSenderForTests(async function (message) {
        sentEmails.push({ ...message });
      });
      Meteor.settings.public.stripePublicKey = "pk_test_enabled";
      globalThis.BlackrockPayments.suspendAccount = async function (_db, userId) {
        suspendedPaymentUsers.push(userId);
      };

      await globalDb.collections.settings.upsertAsync({ _id: "serverTitle" }, {
        $set: { value: "Suspension Test Server" },
      });
      await globalDb.collections.settings.upsertAsync({ _id: "smtpConfig" }, {
        $set: {
          value: {
            hostname: "smtp.example",
            port: 25,
            returnAddress: "no-reply@example.com",
          },
        },
      });
      await insertAccountWithCredential(adminId, adminCredentialId, "suspension-admin@example.com", {
        isAdmin: true,
        profile: { name: "Suspension Admin" },
      });
      await insertAccountWithCredential(targetId, targetCredentialId, "suspension-target@example.com", {});
      await insertAccountWithCredential(selfDeleteId, selfDeleteCredentialId,
          "suspension-self-delete@example.com", {});
      await insertAccountWithCredential(orgUserId, orgCredentialId, "org-user@example.com", {});
      await insertAccountWithCredential(eligibleDeleteId, eligibleDeleteCredentialId,
          "suspension-eligible-delete@example.com", {
            suspended: {
              willDelete: true,
              timestamp: new Date(Date.now() - 10000),
              voluntary: true,
            },
          });
      await insertAccountWithCredential(recentDeleteId, recentDeleteCredentialId,
          "suspension-recent-delete@example.com", {
            suspended: {
              willDelete: true,
              timestamp: new Date(),
              voluntary: true,
            },
          });
      await globalDb.collections.grains.insertAsync({
        _id: grainId,
        userId: targetId,
        appId: "suspension-app",
        packageId: "suspension-package",
        appVersion: 1,
        title: "Suspension grain",
      });
      await globalDb.collections.apiTokens.insertAsync({
        _id: apiTokenId,
        owner: { user: { accountId: targetId } },
        created: new Date(),
      });

      try {
        try {
          await callSuspensionMethod("suspendAccount", selfDeleteId, [targetId, false]);
          throw new Meteor.Error("suspension-non-admin-accepted",
              "suspendAccount accepted a non-admin caller.");
        } catch (err) {
          if (err.error !== 403) throw err;
        }

        await callSuspensionMethod("suspendAccount", adminId, [targetId, true]);
        let target = await Meteor.users.findOneAsync(targetId);
        let targetCredential = await Meteor.users.findOneAsync(targetCredentialId);
        const grain = await globalDb.collections.grains.findOneAsync(grainId);
        const apiToken = await globalDb.collections.apiTokens.findOneAsync(apiTokenId);
        const suspendFailures = [];
        if (!target.suspended) suspendFailures.push("account not suspended");
        if (target.suspended && target.suspended.willDelete !== true) suspendFailures.push("willDelete not set");
        if (target.suspended && target.suspended.admin !== adminId) suspendFailures.push("admin not recorded");
        if (hasResumeLoginTokens(target)) suspendFailures.push("account resume tokens not cleared");
        if (!targetCredential.suspended) suspendFailures.push("credential not suspended");
        if (hasResumeLoginTokens(targetCredential)) suspendFailures.push("credential resume tokens not cleared");
        if (!grain.suspended) suspendFailures.push("grain not suspended");
        if (!apiToken.suspended) suspendFailures.push("api token not suspended");
        if (!suspendedPaymentUsers.includes(targetId)) suspendFailures.push("payments suspension not called");
        if (suspendFailures.length > 0) {
          throw new Meteor.Error("suspension-admin-suspend",
              "suspendAccount did not suspend account, credential, grains, tokens, and payments: " +
              suspendFailures.join(", ") + ".");
        }

        if (!sentEmails.some((email) =>
          email.to === "suspension-admin@example.com" &&
          /Suspension Admin has requested/.test(email.text || "") &&
          /suspension-target@example.com/.test(email.text || ""))) {
          throw new Meteor.Error("suspension-admin-email",
              "suspendAccount(willDelete) did not send admin deletion email.");
        }

        await callSuspensionMethod("unsuspendAccount", adminId, [targetId]);
        target = await Meteor.users.findOneAsync(targetId);
        targetCredential = await Meteor.users.findOneAsync(targetCredentialId);
        const unsuspendedGrain = await globalDb.collections.grains.findOneAsync(grainId);
        const unsuspendedToken = await globalDb.collections.apiTokens.findOneAsync(apiTokenId);
        if (target.suspended || targetCredential.suspended ||
            unsuspendedGrain.suspended || unsuspendedToken.suspended) {
          throw new Meteor.Error("suspension-admin-unsuspend",
              "unsuspendAccount did not clear account, credential, grain, and token suspension.");
        }

        const emailsBeforeSelfDelete = sentEmails.length;
        await callSuspensionMethod("deleteOwnAccount", selfDeleteId, ["No longer needed."]);
        const selfDeleteUser = await Meteor.users.findOneAsync(selfDeleteId);
        if (!selfDeleteUser.suspended ||
            selfDeleteUser.suspended.willDelete !== true ||
            selfDeleteUser.suspended.voluntary !== true ||
            !suspendedPaymentUsers.includes(selfDeleteId)) {
          throw new Meteor.Error("suspension-delete-own",
              "deleteOwnAccount did not voluntarily suspend account for deletion.");
        }

        const selfDeleteEmails = sentEmails.slice(emailsBeforeSelfDelete);
        if (!selfDeleteEmails.some((email) => email.to === "suspension-self-delete@example.com") ||
            !selfDeleteEmails.some((email) =>
              email.to === "suspension-admin@example.com" &&
              /No longer needed/.test(email.text || ""))) {
          throw new Meteor.Error("suspension-delete-own-emails",
              "deleteOwnAccount did not send user/admin deletion emails.");
        }

        await globalDb.collections.settings.upsertAsync({ _id: "organizationMembership" }, {
          $set: {
            value: {
              emailToken: { enabled: true, domain: "example.com" },
              google: { enabled: false, domain: "" },
              ldap: { enabled: false },
              oidc: { enabled: false },
              saml: { enabled: false },
            },
          },
        });
        try {
          await callSuspensionMethod("deleteOwnAccount", orgUserId, [""]);
          throw new Meteor.Error("suspension-org-delete-accepted",
              "deleteOwnAccount accepted an organization user.");
        } catch (err) {
          if (err.error !== 403 || !/organization cannot delete/i.test(err.message || "")) throw err;
        }

        await globalDb.deletePendingAccounts(1000, {
          async deleteUser(userId) {
            backendDeletedUsers.push(userId);
          },
        }, function (_db, user) {
          callbackDeletedUsers.push(user._id);
        });
        if (await Meteor.users.findOneAsync(eligibleDeleteId) ||
            await Meteor.users.findOneAsync(eligibleDeleteCredentialId) ||
            !await Meteor.users.findOneAsync(recentDeleteId) ||
            !callbackDeletedUsers.includes(eligibleDeleteId) ||
            !backendDeletedUsers.includes(eligibleDeleteId)) {
          throw new Meteor.Error("suspension-pending-delete",
              "deletePendingAccounts did not delete only eligible accounts after cooling-off.");
        }

        return true;
      } finally {
        setAccountSuspensionEmailSenderForTests(null);
        Meteor.settings.public.stripePublicKey = oldStripePublicKey;
        globalThis.BlackrockPayments.suspendAccount = oldPaymentsSuspend;
        await globalDb.collections.settings.removeAsync({
          _id: { $in: ["serverTitle", "smtpConfig", "organizationMembership"] },
        });
        await globalDb.collections.grains.removeAsync(grainId);
        await globalDb.collections.apiTokens.removeAsync(apiTokenId);
        await Meteor.users.removeAsync({
          _id: {
            $in: [
              adminId,
              adminCredentialId,
              targetId,
              targetCredentialId,
              selfDeleteId,
              selfDeleteCredentialId,
              orgUserId,
              orgCredentialId,
              eligibleDeleteId,
              eligibleDeleteCredentialId,
              recentDeleteId,
              recentDeleteCredentialId,
            ],
          },
        });
      }
    },

    testRegressionOrganizationMembershipAndLoginValidation: async function () {
      const orgCredentialId = "test-org-credential-" + Random.id();
      const orgAccountNonOrgCredentialId = "test-org-account-non-credential-" + Random.id();
      const nonOrgCredentialId = "test-org-non-account-credential-" + Random.id();
      const orgAccountId = "test-org-account-" + Random.id();
      const nonOrgAccountId = "test-org-non-account-" + Random.id();

      await globalDb.collections.settings.upsertAsync({ _id: "organizationMembership" }, {
        $set: {
          value: {
            emailToken: { enabled: true, domain: "*.example.com,example.org" },
            google: { enabled: true, domain: "example.com" },
            ldap: { enabled: true },
            oidc: { enabled: true },
            saml: { enabled: true },
          },
        },
      });
      await globalDb.collections.settings.upsertAsync({ _id: "organizationSettings" }, {
        $set: {
          value: {
            disallowGuests: true,
            shareContacts: false,
          },
        },
      });

      try {
        const cases = [
          [{ services: { email: { email: "user@dept.example.com" } } }, true, "email wildcard"],
          [{ services: { email: { email: "user@example.org" } } }, true, "email exact"],
          [{ services: { email: { email: "user@outside.test" } } }, false, "email outside"],
          [{ services: { google: { hd: "example.com" } } }, true, "google hosted domain"],
          [{ services: { google: { hd: "outside.test" } } }, false, "google outside"],
          [{ services: { ldap: { id: "ldap-user" } } }, true, "ldap"],
          [{ services: { oidc: { id: "oidc-user" } } }, true, "oidc"],
          [{ services: { saml: { id: "saml-user" } } }, true, "saml"],
        ];

        for (const [credential, expected, label] of cases) {
          const actual = await globalDb.isCredentialInOrganizationAsync(credential);
          if (actual !== expected) {
            throw new Meteor.Error("org-credential-" + label.replace(/[^a-z0-9]+/gi, "-"),
                "Unexpected organization membership for " + label + ": " + actual);
          }
        }

        await Meteor.users.insertAsync({
          _id: orgCredentialId,
          type: "credential",
          services: { email: { email: "member@dept.example.com" } },
        });
        await Meteor.users.insertAsync({
          _id: orgAccountNonOrgCredentialId,
          type: "credential",
          services: { email: { email: "outsider@outside.test" } },
        });
        await Meteor.users.insertAsync({
          _id: nonOrgCredentialId,
          type: "credential",
          services: { email: { email: "other-outsider@outside.test" } },
        });
        await Meteor.users.insertAsync({
          _id: orgAccountId,
          type: "account",
          loginCredentials: [{ id: orgAccountNonOrgCredentialId }, { id: orgCredentialId }],
          nonloginCredentials: [],
          profile: { name: "Org account" },
        });
        await Meteor.users.insertAsync({
          _id: nonOrgAccountId,
          type: "account",
          loginCredentials: [{ id: nonOrgCredentialId }],
          nonloginCredentials: [],
          profile: { name: "Non-org account" },
        });

        const orgAccount = await Meteor.users.findOneAsync(orgAccountId);
        const nonOrgAccount = await Meteor.users.findOneAsync(nonOrgAccountId);
        if (!await globalDb.isUserInOrganizationAsync(orgAccount)) {
          throw new Meteor.Error("org-user-membership",
              "isUserInOrganizationAsync did not accept account with one organization credential.");
        }

        if (await globalDb.isUserInOrganizationAsync(nonOrgAccount)) {
          throw new Meteor.Error("org-user-non-member",
              "isUserInOrganizationAsync accepted account with no organization credentials.");
        }

        try {
          await validateSandstormLoginAttempt({
            allowed: true,
            connection: { sandstormDb: globalDb },
            user: nonOrgAccount,
          });
          throw new Meteor.Error("org-login-non-member-accepted",
              "Login validation accepted non-organization account while guests are disabled.");
        } catch (err) {
          if (err.error !== 403 || !/User not in organization/i.test(err.message || "")) throw err;
        }

        const accepted = await validateSandstormLoginAttempt({
          allowed: true,
          connection: { sandstormDb: globalDb },
          user: orgAccount,
        });
        if (accepted !== true) {
          throw new Meteor.Error("org-login-member-rejected",
              "Login validation rejected an organization member.");
        }

        const rejectedBeforeValidation = await validateSandstormLoginAttempt({
          allowed: false,
          connection: { sandstormDb: globalDb },
          user: orgAccount,
        });
        if (rejectedBeforeValidation !== false) {
          throw new Meteor.Error("org-login-disallowed",
              "Login validation did not preserve a previously disallowed attempt.");
        }

        return true;
      } finally {
        await globalDb.collections.settings.removeAsync({
          _id: { $in: ["organizationMembership", "organizationSettings"] },
        });
        await Meteor.users.removeAsync({
          _id: {
            $in: [
              orgCredentialId,
              orgAccountNonOrgCredentialId,
              nonOrgCredentialId,
              orgAccountId,
              nonOrgAccountId,
            ],
          },
        });
      }
    },

    testRegressionScheduledJobsPublication: async function () {
      const ownerId = "test-scheduled-owner-" + Random.id();
      const otherId = "test-scheduled-other-" + Random.id();
      const adminId = "test-scheduled-admin-" + Random.id();
      const ownerGrainId = "testScheduledOwnerGrain" + Random.id().replace(/[^a-zA-Z0-9]/g, "");
      const otherGrainId = "testScheduledOtherGrain" + Random.id().replace(/[^a-zA-Z0-9]/g, "");
      const ownerJobId = "test-scheduled-owner-job-" + Random.id();
      const otherJobId = "test-scheduled-other-job-" + Random.id();
      let ownerSub;
      let adminSub;
      let unrelatedSub;
      const waitForPublication = async () => {
        await new Promise((resolve) => Meteor.setTimeout(resolve, 50));
      };
      const startSub = async (userId) => {
        const sub = makeFakeSubscription(userId);
        await getPublishHandler("scheduledJobs").apply(sub, []);
        await waitForPublication();
        return sub;
      };

      await Meteor.users.insertAsync({
        _id: ownerId,
        type: "account",
        signupKey: "admin",
        loginCredentials: [],
        nonloginCredentials: [],
        profile: { name: "Scheduled owner" },
      });
      await Meteor.users.insertAsync({
        _id: otherId,
        type: "account",
        signupKey: "admin",
        loginCredentials: [],
        nonloginCredentials: [],
        profile: { name: "Scheduled other" },
      });
      await Meteor.users.insertAsync({
        _id: adminId,
        type: "account",
        signupKey: "admin",
        isAdmin: true,
        loginCredentials: [],
        nonloginCredentials: [],
        profile: { name: "Scheduled admin" },
      });
      await globalDb.collections.grains.insertAsync({
        _id: ownerGrainId,
        userId: ownerId,
        appId: "scheduled-app",
        packageId: "scheduled-package",
        appVersion: 1,
        title: "Owner scheduled grain",
      });
      await globalDb.collections.grains.insertAsync({
        _id: otherGrainId,
        userId: otherId,
        appId: "scheduled-app",
        packageId: "scheduled-package",
        appVersion: 1,
        title: "Other scheduled grain",
      });
      await globalDb.collections.scheduledJobs.insertAsync({
        _id: ownerJobId,
        grainId: ownerGrainId,
        name: "owner job",
        created: new Date(),
        nextPeriodStart: new Date(),
        period: "daily",
      });
      await globalDb.collections.scheduledJobs.insertAsync({
        _id: otherJobId,
        grainId: otherGrainId,
        name: "other job",
        created: new Date(),
        nextPeriodStart: new Date(),
        period: "daily",
      });

      try {
        ownerSub = await startSub(ownerId);
        if (!ownerSub.addedDocs.scheduledJobs ||
            !ownerSub.addedDocs.scheduledJobs[ownerJobId] ||
            ownerSub.addedDocs.scheduledJobs[otherJobId]) {
          throw new Meteor.Error("scheduled-owner-scope",
              "scheduledJobs did not publish only the owner's jobs.");
        }

        adminSub = await startSub(adminId);
        if (!adminSub.addedDocs.scheduledJobs ||
            !adminSub.addedDocs.scheduledJobs[ownerJobId] ||
            !adminSub.addedDocs.scheduledJobs[otherJobId]) {
          throw new Meteor.Error("scheduled-admin-scope",
              "scheduledJobs did not publish all jobs to admins.");
        }

        unrelatedSub = await startSub(otherId);
        if (!unrelatedSub.addedDocs.scheduledJobs ||
            unrelatedSub.addedDocs.scheduledJobs[ownerJobId]) {
          throw new Meteor.Error("scheduled-unrelated-scope",
              "scheduledJobs published another user's job to an unrelated user.");
        }

        await globalDb.collections.scheduledJobs.updateAsync(ownerJobId, {
          $set: { grainId: otherGrainId, name: "moved job" },
        });
        await waitForPublication();

        if (!ownerSub.removedDocs.scheduledJobs ||
            !ownerSub.removedDocs.scheduledJobs[ownerJobId]) {
          throw new Meteor.Error("scheduled-changed-ownership",
              "scheduledJobs did not remove a job after ownership changed away.");
        }

        return true;
      } finally {
        if (ownerSub) ownerSub.stop();
        if (adminSub) adminSub.stop();
        if (unrelatedSub) unrelatedSub.stop();
        await globalDb.collections.scheduledJobs.removeAsync({ _id: { $in: [ownerJobId, otherJobId] } });
        await globalDb.collections.grains.removeAsync({ _id: { $in: [ownerGrainId, otherGrainId] } });
        await Meteor.users.removeAsync({ _id: { $in: [ownerId, otherId, adminId] } });
      }
    },

    async testRustSaml() {
      const originalEnabled = Accounts.loginServices.saml.isEnabled;
      const originalOrigin = Meteor.settings.public.rustShellOrigin;
      const originalValidate = SAML.prototype.validateResponse;
      const settings = globalDb.collections.settings;
      const settingIds = ['samlEntryPoint','samlPublicCert','samlEntityId','samlLogout'];
      const saved = await settings.find({_id:{$in:settingIds}}).fetchAsync();
      const flow = Crypto.randomBytes(32).toString('hex');
      const identity = 'rust-saml-'+Random.id();
      let pending, linked, linkPending, accountId;
      const require = (value,message) => { if (!value) throw new Error(message); };
      const native = (operation,data={}) => rustShellBridge.handle('nativeAuth',{operation,data,flow});
      const requestId = pending => {
        const url = new URL(pending.url);
        require(url.origin === 'https://idp.example','Unexpected SAML endpoint');
        const xml = Zlib.inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest'),'base64')).toString();
        require(xml.includes('/_saml/validate/default'),'SAML callback changed');
        const id = xml.match(/ ID="([^"]+)"/)[1];
        require(id !== pending.request && !xml.includes(pending.request),'Browser polling key leaked into SAML request');
        return id;
      };
      const complete = async (id,name=identity) => {
        SAML.prototype.validateResponse = (_response,callback) => callback(null,{inResponseToId:id,nameID:name,email:name+'@example.invalid',displayName:'SAML test'});
        let status,headers,body;
        await handleSamlRequest({url:'/_saml/validate/default/unsigned-token',body:{SAMLResponse:'fixture'}},
          {writeHead(code,value){status=code;headers=value;},end(value){body=value;}},()=>{throw new Error('Callback was not handled');});
        return {status,headers,body};
      };
      try {
        Accounts.loginServices.saml.isEnabled = () => true;
        Meteor.settings.public.rustShellOrigin = 'https://rust.example.test';
        for (const [id,value] of [['samlEntryPoint','https://idp.example/sso'],['samlPublicCert','TEST_CERT'],['samlEntityId','rust-test'],['samlLogout','https://idp.example/logout']]) {
          await settings.upsertAsync({_id:id},{$set:{value}});
        }
        pending = await native('samlStart');
        const id = requestId(pending);
        let denied=false;
        try { finishNativeSaml('login:foreign',pending.request); } catch(error) {denied=error.error===403;}
        require(denied,'Foreign flow consumed SAML request');
        cancelNativeSaml('login:foreign',pending.request);
        require((await native('samlFinish',{request:pending.request})).pending,'Uncompleted SAML request was accepted');
        await Meteor.users.insertAsync({_id:identity,type:'credential',services:{saml:{id:identity,email:identity+'@example.invalid'}},profile:{name:'SAML test'}});
        const response=await complete(id);
        require(response.status===303 && response.headers.Location==='https://rust.example.test/oauth-complete','SAML completion did not return to native shell');
        for (const credentialToken of [id,pending.request,'unsigned-token']) {
          denied=false;
          try {await loginWithSaml({credentialToken});} catch (_) {denied=true;}
          require(denied,'Public SAML identifier was redeemable as a credential');
        }
        linked=await native('samlFinish',{request:pending.request});
        require(!!linked.token,'SAML login did not issue a session');
        denied=false;
        try {await native('samlFinish',{request:pending.request});} catch (_) {denied=true;}
        require(denied,'SAML request was reused');
        require((await complete(id)).status!==303,'Consumed SAML response was replayed');
        accountId=(await Meteor.users.findOneAsync({'loginCredentials.id':identity}))._id;
        const account=(operation,data={})=>rustShellBridge.handle('accountSettings',{token:linked.token,operation,data});
        linkPending=(await account('samlStart')).authorization;
        await Meteor.users.insertAsync({_id:identity+'-linked',type:'credential',services:{saml:{id:identity+'-linked',email:identity+'-linked@example.invalid'}},profile:{name:'Linked SAML test'}});
        require((await complete(requestId(linkPending),identity+'-linked')).status===303,'SAML link callback failed');
        const result=await account('samlFinish',{request:linkPending.request});
        require(result.credentials.some(item=>item.id===identity+'-linked' && item.login),'SAML credential was not linked');
        pending=await native('samlStart');
        const canceledId=requestId(pending);
        await native('samlCancel',{request:pending.request});
        require((await complete(canceledId)).status!==303,'Canceled SAML response was accepted');
        pending=await native('samlStart');
        const realNow=Date.now;
        const expiredTime=realNow()+300001;
        denied=false;
        try {
          Date.now=()=>expiredTime;
          try {finishNativeSaml('login:'+flow,pending.request);} catch (_) {denied=true;}
        } finally {Date.now=realNow;}
        require(denied,'Expired SAML request completed');
        pending=await native('samlStart');
        Accounts.loginServices.saml.isEnabled=()=>false;
        denied=false;
        try {await native('samlFinish',{request:pending.request});} catch (_) {denied=true;}
        require(denied,'Disabled SAML request completed');
        const legacyUrl=await getMethodHandler('generateSamlLogout').apply({userId:accountId},[]);
        require(new URL(legacyUrl).origin==='https://idp.example','Legacy SAML logout changed');
        const logout=await rustShellBridge.handle('logout',{token:linked.token});
        const destination=new URL(logout.redirectUrl);
        require(destination.origin==='https://idp.example' && destination.pathname==='/logout','Native logout did not target the configured IdP');
        const xml=Zlib.inflateRawSync(Buffer.from(destination.searchParams.get('SAMLRequest'),'base64')).toString();
        require(xml.includes(identity+'-linked'),'Logout used the wrong SAML credential');
        denied=false;
        try {await rustShellBridge.handle('session',{token:linked.token});} catch (_) {denied=true;}
        require(denied,'SAML logout left the local session usable');

      } finally {
        if(pending) cancelNativeSaml('login:'+flow,pending.request);
        if(linkPending) cancelNativeSaml('link:'+accountId,linkPending.request);
        SAML.prototype.validateResponse=originalValidate;
        Accounts.loginServices.saml.isEnabled=originalEnabled;
        Meteor.settings.public.rustShellOrigin=originalOrigin;
        if(linked?.token) await rustShellBridge.handle('logout',{token:linked.token});
        await Meteor.users.removeAsync({'loginCredentials.id':identity});
        await Meteor.users.removeAsync({_id:{$in:[identity,identity+'-linked']}});
        await settings.removeAsync({_id:{$in:settingIds}});
        for(const doc of saved) await settings.insertAsync(doc);
      }
      return true;
    },

    async testRustOAuth() {
      for (const provider of ['github','google','oidc']) {
        const originalEnabled = Accounts.loginServices[provider].isEnabled;
        const originalOrigin = Meteor.settings.public.rustShellOrigin;
        const configuration = await ServiceConfiguration.configurations.findOneAsync({service:provider});
        const identity = 'rust-'+provider+'-'+Random.id();
        const serviceData = id => provider === 'github' ? {id,username:id,emails:[]} : {id,email:id+'@example.invalid',verified_email:true,name:'Rust Google test'};
        const registered = Accounts.oauth.serviceNames().includes(provider);
        let pending, linked, linkPending, accountId;
        const flow = Crypto.randomBytes(32).toString("hex");
        const require = (value,message) => { if (!value) throw new Error(message); };
        try {
          Accounts.loginServices[provider].isEnabled = () => true;
          if (!registered) Accounts.oauth.registerService(provider);
          Meteor.settings.public.rustShellOrigin = 'https://rust.example.test';
          if (!configuration) await ServiceConfiguration.configurations.insertAsync({service:provider,clientId:'test-only',...(provider === 'oidc' ? {secret:'test-secret',issuer:{issuer:'https://identity.example.test',authorization_endpoint:'https://identity.example.test/authorize',token_endpoint:'https://identity.example.test/token'},requestPermissions:['openid','email','custom']} : {})});
          pending = await rustShellBridge.handle('nativeAuth',{operation:'oauthStart',data:{provider},flow});
          const url = new URL(pending.url);
          require(url.origin === (provider === 'oidc' ? 'https://identity.example.test' : provider === 'github' ? 'https://github.com' : 'https://accounts.google.com'),'Incorrect authorization origin');
          require(!JSON.stringify(pending).includes('credentialSecret'),'Secret exposed before authorization');
          let denied = false;
          try { await finishOAuth(provider,'login:foreign',pending.request); } catch (error) { denied=error.error===403; }
          require(denied,'OAuth request accepted a foreign flow');
          require(await finishOAuth(provider,'login:'+flow,pending.request) === null,'Incomplete OAuth was accepted');
          const other = provider === 'google' ? 'github' : 'google';
          denied=false;
          try { await finishOAuth(other,'login:'+flow,pending.request); } catch (error) { denied=error.error===403; }
          require(denied,'OAuth request accepted a different provider');
          await cancelOAuth(other,'login:'+flow,pending.request);
          require(await finishOAuth(provider,'login:'+flow,pending.request) === null,'A different provider canceled the request');
          if (provider === 'oidc') {
            require(url.searchParams.get('scope') === 'openid email custom','OIDC configured permissions changed');
            require(url.searchParams.get('response_type') === 'code','OIDC must use the authorization-code flow');
            require(url.searchParams.get('redirect_uri').includes('/_oauth/oidc'),'OIDC callback changed');
          }
          if (provider === 'google') {
            require(url.searchParams.get('response_type') === 'code','Google must use the authorization-code flow');
            require(url.searchParams.get('scope') === 'email profile','Unexpected Google login permissions');
            require(url.searchParams.get('redirect_uri').includes('/_oauth/google'),'Google callback changed');
          }

          // Existing synthetic credentials avoid triggering external avatar downloads.
          await Meteor.users.insertAsync({_id:identity,type:'credential',services:{[provider]:serviceData(identity)},profile:{name:'Rust OAuth test'}});
          const secret = Random.secret();
          await OAuth._storePendingCredential(pending.request,{serviceName:provider,serviceData:serviceData(identity),options:{profile:{name:'Rust OAuth test'}}},secret);
          let location;
          await OAuth._endOfLoginResponse({writeHead(status,headers){ require(status===303,'OAuth callback did not redirect'); location=headers.Location; },end(){}},
            {query:{state:url.searchParams.get('state')},loginStyle:'popup',credentials:{token:pending.request,secret}});
          require(location === 'https://rust.example.test/oauth-complete','Callback did not return to Rust');
          linked = await rustShellBridge.handle('nativeAuth',{operation:'oauthFinish',data:{provider,request:pending.request},flow});
          require(!!linked.token && !JSON.stringify(linked).includes(secret),'OAuth secret leaked or login failed');
          denied=false;
          try { await finishOAuth(provider,'login:'+flow,pending.request); } catch (_) { denied=true; }
          require(denied,'OAuth result could be reused');
          accountId = (await Meteor.users.findOneAsync({'loginCredentials.id':identity}))._id;
          const settings = (operation,data={}) => rustShellBridge.handle('accountSettings',{token:linked.token,operation,data});
          linkPending = (await settings('oauthStart',{provider})).authorization;
          await Meteor.users.insertAsync({_id:identity+'-linked',type:'credential',services:{[provider]:serviceData(identity+'-linked')},profile:{name:'Linked OAuth test'}});
          const linkSecret = Random.secret();
          await OAuth._storePendingCredential(linkPending.request,{serviceName:provider,serviceData:serviceData(identity+'-linked'),options:{}},linkSecret);
          await OAuth._endOfLoginResponse({writeHead(){},end(){}},
            {query:{state:new URL(linkPending.url).searchParams.get('state')},loginStyle:'popup',credentials:{token:linkPending.request,secret:linkSecret}});
          const settingsResult = await settings('oauthFinish',{provider,request:linkPending.request});
          require(settingsResult.credentials.some(item=>item.id===identity+'-linked' && item.login),'OAuth credential was not linked for login');
          require(!JSON.stringify(settingsResult).includes(linkSecret),'Linking exposed an OAuth secret');
          // A removed native request must never fall back to Meteor's browser
          // credential-delivery handler, even when a callback arrives late.
          for (const request of [pending,linkPending]) {
            const lateSecret=Random.secret();
            await OAuth._storePendingCredential(request.request,{serviceName:provider,serviceData:{}},lateSecret);
            let status,body;
            await OAuth._endOfLoginResponse({writeHead(code){status=code;},end(value){body=value;}},
              {query:{state:new URL(request.url).searchParams.get('state')},loginStyle:'popup',credentials:{token:request.request,secret:lateSecret}});
            require(status===410 && !String(body).includes(lateSecret),'Consumed native callback exposed credentials');
            require(!await OAuth.retrieveCredential(request.request,lateSecret),'Late native callback left credentials behind');
          }
          const canceled=await rustShellBridge.handle('nativeAuth',{operation:'oauthStart',data:{provider},flow});
          await cancelOAuth(provider,'login:'+flow,canceled.request);
          const canceledSecret=Random.secret();
          await OAuth._storePendingCredential(canceled.request,{serviceName:provider,serviceData:{}},canceledSecret);
          let canceledStatus;
          await OAuth._endOfLoginResponse({writeHead(code){canceledStatus=code;},end(){}},
            {query:{state:new URL(canceled.url).searchParams.get('state')},loginStyle:'popup',credentials:{token:canceled.request,secret:canceledSecret}});
          require(canceledStatus===410,'Canceled native callback used legacy credential delivery');
          require(!await OAuth.retrieveCredential(canceled.request,canceledSecret),'Canceled callback retained credentials');

          // A valid credential from another provider must not complete this flow.
          const otherEnabled = Accounts.loginServices[other].isEnabled;
          const otherRegistered = Accounts.oauth.serviceNames().includes(other);
          const wrongId = identity+'-wrong';
          try {
            Accounts.loginServices[other].isEnabled = () => true;
            if (!otherRegistered) Accounts.oauth.registerService(other);
            const wrongData = other === 'github' ? {id:wrongId,username:wrongId,emails:[]} :
              {id:wrongId,email:wrongId+'@example.invalid',verified_email:true,name:'Wrong provider'};
            await Meteor.users.insertAsync({_id:wrongId,type:'credential',services:{[other]:wrongData},profile:{name:'Wrong provider'}});
            pending = await rustShellBridge.handle('nativeAuth',{operation:'oauthStart',data:{provider},flow});
            const wrongSecret = Random.secret();
            await OAuth._storePendingCredential(pending.request,{serviceName:other,serviceData:wrongData,options:{}},wrongSecret);
            await OAuth._endOfLoginResponse({writeHead(){},end(){}},
              {query:{state:new URL(pending.url).searchParams.get('state')},loginStyle:'popup',credentials:{token:pending.request,secret:wrongSecret}});
            denied = false;
            try {
              await rustShellBridge.handle('nativeAuth',{operation:'oauthFinish',data:{provider,request:pending.request},flow});
            } catch (error) { denied = /Expected a .* credential/.test(error.reason || error.message); }
            require(denied,'A different provider credential completed sign-in');
            require(!await Meteor.users.findOneAsync({'loginCredentials.id':wrongId}),'Wrong-provider sign-in created an account');
            const wrongCredential = await Meteor.users.findOneAsync(wrongId);
            require(!wrongCredential.services.resume?.loginTokens?.length,'Wrong-provider credential retained a login token');
          } finally {
            Accounts.loginServices[other].isEnabled = otherEnabled;
            if (!otherRegistered) Accounts.oauth.unregisterService(other);
            await Meteor.users.removeAsync({'loginCredentials.id':wrongId});
            await Meteor.users.removeAsync(wrongId);
          }

        } finally {
          if (pending) await cancelOAuth(provider,'login:'+flow,pending.request);
          if (linkPending) await cancelOAuth(provider,'link:'+accountId,linkPending.request);
          if (!registered) Accounts.oauth.unregisterService(provider);
          Accounts.loginServices[provider].isEnabled=originalEnabled;
          Meteor.settings.public.rustShellOrigin=originalOrigin;
          if (linked?.token) await rustShellBridge.handle('logout',{token:linked.token});
          const credential = await Meteor.users.findOneAsync({['services.'+provider+'.id']:identity});
          if (credential) {
            await Meteor.users.removeAsync({'loginCredentials.id':credential._id});
            await Meteor.users.removeAsync(credential._id);
          }
          await Meteor.users.removeAsync(identity+'-linked');
          if (!configuration) await ServiceConfiguration.configurations.removeAsync({service:provider});
        }
      }
      return true;
    },


    async testRustEmailDeliveryFailure() {
      const originalEnabled = Accounts.loginServices.email.isEnabled;
      const email = 'rust-email-failure-' + Random.id() + '@example.invalid';
      const flow = Crypto.randomBytes(32).toString('hex');
      let attempts = 0;
      try {
        Accounts.loginServices.email.isEnabled = () => true;
        setTokenEmailSenderForTests(async () => {
          ++attempts;
          throw Object.assign(new Error('test transport failure'), {code:'ECONNREFUSED'});
        });
        for (let i = 0; i < 4; ++i) {
          let failure;
          try { await rustShellBridge.handle('nativeAuth',{operation:'sendEmail',data:{email},flow}); }
          catch (error) { failure = error; }
          if (failure?.error !== 503 || !failure.reason.includes('SMTP settings')) {
            throw new Error('Email transport failure did not return actionable advice');
          }
          const user = await Meteor.users.findOneAsync({'services.email.email':email});
          if (user?.services.email.tokens.length !== 0) throw new Error('Failed delivery retained a pending code');
        }
        if (attempts !== 4) throw new Error('Failed email deliveries exhausted the pending-code allowance');
        return true;
      } finally {
        Accounts.loginServices.email.isEnabled = originalEnabled;
        setTokenEmailSenderForTests(null);
        await Meteor.users.removeAsync({'services.email.email':email});
      }
    },

    async testRustDevAccountIdentity() {
      for (const [name, legacyName] of Object.entries({Alice:'Alice Dev Admin',Bob:'Bob Dev User',Carol:'Carol Dev User',Dave:'Dave Dev User'})) {
        let credential = await Meteor.users.findOneAsync({'services.dev.name':legacyName});
        let account = credential && await Meteor.users.findOneAsync({'loginCredentials.id':credential._id});
        const createdCredential = !credential;
        const createdAccount = !account;
        let login;
        try {
          if (!credential) {
            credential = {_id:Random.id(),type:'credential',services:{dev:{name:legacyName,isAdmin:name==='Alice'}},profile:{name:legacyName}};
            await Meteor.users.insertAsync(credential);
          }
          if (!account) {
            account = {_id:Random.id(),type:'account',loginCredentials:[{id:credential._id}],nonloginCredentials:[],profile:{name:'Customized display name'},hasCompletedSignup:true};
            await Meteor.users.insertAsync(account);
          }
          login = await rustNativeAuth('dev',{name},Crypto.randomBytes(32).toString('hex'));
          login.commit();
          if (login.accountId !== account._id) throw new Error(name+' did not reopen the legacy account');
        } finally {
          if (login) await Meteor.users.updateAsync(login.accountId,{$pull:{'services.resume.loginTokens':{hashedToken:login.loginHash}}});
          if (createdAccount && account) await Meteor.users.removeAsync(account._id);
          if (createdCredential && credential) await Meteor.users.removeAsync(credential._id);
        }
      }
      return true;
    },

    async testRustNativeLogin() {
      const flow = Crypto.randomBytes(32).toString('hex');
      const options = await rustShellBridge.handle('nativeAuth',{operation:'options',data:{},flow});
      if (!options.dev) throw new Error('Dev sign-in was not advertised');
      const result = await rustShellBridge.handle('nativeAuth',{operation:'dev',data:{name:'Alice'},flow});
      try {
        const session = await rustShellBridge.handle('session',{token:result.token});
        if (!session.account.name.includes('Alice')) throw new Error('Native login selected the wrong account');
        if (result.loginHash || result.accountId) throw new Error('Native login exposed credential internals');
      } finally { await rustShellBridge.handle('logout',{token:result.token}); }
      return true;
    },

    async testRustProfile() {
      const accountId = "rust_profile_" + Random.id();
      const hash = Crypto.randomBytes(32).toString("hex");
      const credentialIds = [accountId + "_email1", accountId + "_email2"];
      let token;
      const require = (condition, message) => { if (!condition) throw new Error(message); };
      try {
        await Meteor.users.insertAsync({ _id: accountId, type: "account", loginCredentials: [], nonloginCredentials: [],
          profile: { name: "Before", handle: "before", pronoun: "neutral", picture: "preserved-picture" },
          services: { resume: { loginTokens: [{ hashedToken: hash, when: new Date() }] } } });
        const state = Crypto.randomBytes(32).toString("hex");
        const code = await rustShellBridge.issue(accountId, hash, state);
        ({ token } = await rustShellBridge.handle("exchange", { code, state }));
        const profile = { name: "Rust profile", handle: "rust_profile", pronoun: "robot" };
        const saved = await rustShellBridge.handle("updateProfile", { token, accountId: this.userId, profile });
        require(saved.name === profile.name && saved.handle === profile.handle && saved.pronoun === profile.pronoun, "Profile save returned incorrect fields");
        const user = await Meteor.users.findOneAsync(accountId);
        require(user.hasCompletedSignup, "Profile update did not preserve signup completion");
        require(user.profile.picture === "preserved-picture", "Profile update changed picture");
        require(user.services.resume.loginTokens[0].hashedToken === hash, "Profile update changed login token");
        const beforeProfileEdit = await rustShellBridge.handle("snapshot",{token});
        const legacy = { name: "Legacy profile", handle: "legacy_profile", pronoun: "female" };
        await getMethodHandler("updateProfile").call({ userId: accountId }, null, legacy);
        require((await rustShellBridge.handle("getProfile", { token })).name === legacy.name, "Rust profile did not read legacy edit");
        const afterProfileEdit = await rustShellBridge.handle("watch",{token,after:beforeProfileEdit.version});
        require(afterProfileEdit.profileVersion !== beforeProfileEdit.profileVersion,"Profile change did not invalidate live snapshot");
        require(afterProfileEdit.profileVersion === (await rustShellBridge.handle("getProfile",{token})).version,"Live profile version differs from read");
        let invalid = false;
        try { await getMethodHandler("updateProfile").call({ userId: accountId }, null, { ...legacy, handle: "INVALID" }); }
        catch (_) { invalid = true; }
        require(invalid, "Legacy validation changed");
        const upload = () => rustShellBridge.handle("uploadPicture",{token,accountId:this.userId});
        const first = await upload();
        const firstKey = new URL(first.uploadUrl).pathname.slice(1);
        const second = await upload();
        require(!await globalDb.collections.assetUploadTokens.findOneAsync(firstKey),"Superseded picture upload remained valid");
        const secondKey = new URL(second.uploadUrl).pathname.slice(1);
        const uploadRecord = await globalDb.collections.assetUploadTokens.findOneAsync(secondKey);
        require(uploadRecord.purpose.profilePicture.userId === accountId,"Picture upload crossed account boundary");
        let rejected=false;
        try { await httpCallAsync('POST',second.uploadUrl,{content:'<svg/>',headers:{'Content-Type':'image/png'},timeout:5000}); }
        catch (error) { rejected=error.response?.statusCode === 400; }
        require(rejected,"Image validation trusted the supplied MIME type");
        require(!await globalDb.collections.assetUploadTokens.findOneAsync(secondKey),"Rejected upload token was reusable");
        await Meteor.users.updateAsync(accountId,{$unset:{'profile.picture':1}});
        const validUpload = await upload();
        const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
        require((await httpCallAsync('POST',validUpload.uploadUrl,{content:png,headers:{'Content-Type':'image/png'},timeout:5000})).statusCode === 204,"Picture upload failed");
        const uploadedUser = await Meteor.users.findOneAsync(accountId);
        const asset = await globalDb.getStaticAsset(uploadedUser.profile.picture);
        require(asset.mimeType === 'image/png' && asset.content.equals(png),"Picture bytes were not stored canonically");
        const refreshed = await rustShellBridge.handle('getProfile',{token});
        require(refreshed.pictureUrl.endsWith('/'+uploadedUser.profile.picture),"Picture URL not projected");
        require((await rustShellBridge.handle('snapshot',{token})).accountPictureUrl === refreshed.pictureUrl,"Topbar picture did not update");
        let reused=false;
        try { await httpCallAsync('POST',validUpload.uploadUrl,{content:png,timeout:5000}); }
        catch (error) { reused=error.response?.statusCode === 404; }
        require(reused,"Consumed picture upload token was reusable");

        for (const [index,id] of credentialIds.entries()) {
          await Meteor.users.insertAsync({_id:id,type:'credential',profile:{name:'Email '+index},
            services:{email:{email:id+'@example.test',tokens:[]}}});
        }
        await Meteor.users.updateAsync(accountId,{$set:{loginCredentials:credentialIds.map(id=>({id}))}});
        const settings = (operation,data={}) => rustShellBridge.handle('accountSettings',{token,operation,data,accountId:this.userId});
        const accountState = await settings('state');
        require(accountState.credentials.length === 2,'Own credentials were not projected');
        require(!JSON.stringify(accountState).includes('tokens'),'Credential secrets leaked in account settings');
        await settings('primary',{email:credentialIds[1]+'@example.test'});
        require((await Meteor.users.findOneAsync(accountId)).primaryEmail === credentialIds[1]+'@example.test','Primary email was not saved');
        let denied=false;
        try { await settings('primary',{email:'foreign@example.test'}); } catch (_) { denied=true; }
        require(denied,'Unverified primary email was accepted');
        denied=false;
        try { await settings('unlink',{id:this.userId}); } catch (_) { denied=true; }
        require(denied,'Foreign credential unlink was accepted');
        await settings('allowLogin',{id:credentialIds[1],allowLogin:false});
        denied=false;
        try { await settings('unlink',{id:credentialIds[0]}); } catch (_) { denied=true; }
        require(denied,'Last login credential could be removed');
        await settings('unlink',{id:credentialIds[1]});
        require((await settings('state')).credentials.length === 1,'Credential was not unlinked');

        await rustShellBridge.handle("logout", { token });
        let revoked = false;
        try { await rustShellBridge.handle("updateProfile", { token, profile }); }
        catch (error) { revoked = error.status === 401; }
        require(revoked, "Revoked login updated profile");
        revoked=false;
        try { await upload(); } catch (error) { revoked=error.status === 401; }
        require(revoked,"Revoked login issued picture upload token");
        return true;
      } finally {
        if (token) await rustShellBridge.handle("logout", { token });
        const uploadedUser = await Meteor.users.findOneAsync(accountId);
        if (uploadedUser?.profile?.picture && uploadedUser.profile.picture !== 'preserved-picture') await globalDb.unrefStaticAsset(uploadedUser.profile.picture);
        await globalDb.collections.assetUploadTokens.removeAsync({rustShellAccount:accountId});
        await Meteor.users.removeAsync({_id:{$in:[accountId,...credentialIds]}});
      }
    },

    async testRustNativePowerbox(action, grainId, input = {}) {
      check(action, String);
      check(grainId, String);
      const grain = await globalDb.collections.grains.findOneAsync({_id:grainId,userId:this.userId});
      if (!grain || !this.userId) throw new Meteor.Error(403, "Owned test grain required");
      const key = this.userId + ":" + grainId;
      let record = rustNativePowerboxTests.get(key);
      if (action === "open") {
        if (record) throw new Error("Test request already open");
        const state = Crypto.randomBytes(32).toString("hex");
        const code = await rustShellBridge.issue(this.userId, Accounts._getLoginToken(this.connection.id), state);
        const {token} = await rustShellBridge.handle("exchange",{code,state});
        record = {token,scope:Crypto.randomBytes(32).toString("hex"),request:Crypto.randomBytes(32).toString("hex"),
          previousOrigin:Meteor.settings.public.rustShellOrigin};
        rustNativePowerboxTests.set(key,record);
        Meteor.settings.public.rustShellOrigin = new URL(process.env.ROOT_URL).origin;
        const view = await rustShellBridge.handle("openGrain",{token,scope:record.scope,grainId});
        record.lease = view.lease;
        record.requesterId = new URL(view.url).searchParams.get("sessionid");
        return view;
      }
      if (!record) throw new Error("No native Powerbox test session");
      if (action === "close") {
        await rustShellBridge.handle("logout",{token:record.token});
        Meteor.settings.public.rustShellOrigin = record.previousOrigin;
        rustNativePowerboxTests.delete(key);
        return true;
      }
      if (action === 'checkNested') {
        const child=Crypto.randomBytes(32).toString('hex');
        const Powerbox=Capnp.importSystem('sandstorm/powerbox.capnp');
        const UiView=Capnp.importSystem('sandstorm/grain.capnp').UiView;
        const query=[Capnp.serializePacked(Powerbox.PowerboxDescriptor,{tags:[{id:UiView.typeId}]}).toString('base64')];
        const call = (nestedOperation,nestedInput={}) => rustShellBridge.handle('powerbox',{token:record.token,scope:record.scope,lease:record.lease,request:record.request,operation:'select',mode:'nested',nestedRequest:child,nestedOperation,nestedInput});
        let tokenId;
        try {
          const choices=await call('begin',{query});
          if (choices.status !== 'nested') throw new Error('Nested result leaked into parent lifecycle');
          const candidate=choices.view.candidates.find(item=>item.uiView);
          if (!candidate) throw new Error('Nested provider had no UiView options');
          const result=await call('select',{key:candidate.key,mode:'view',role:'all'});
          tokenId=Crypto.createHash('sha256').update(result.view.token).digest('base64');
          const token=await globalDb.collections.apiTokens.findOneAsync(tokenId);
          if (token?.owner?.clientPowerboxRequest?.sessionId !== record.providerId) throw new Error('Nested token targeted the outer requesting session');
          await call('cancel');
          const parent=await rustShellBridge.handle('powerbox',{token:record.token,scope:record.scope,lease:record.lease,request:record.request,operation:'poll'});
          if (parent.status !== 'waiting') throw new Error('Nested completion completed the parent request');
          return true;
        } finally { await call('cancel'); if (tokenId) await globalDb.removeApiTokens({_id:tokenId}); }
      }
      if (action === "checkOAuth") {
        const Powerbox = Capnp.importSystem("sandstorm/powerbox.capnp");
        const ApiSession = Capnp.importSystem("sandstorm/api-session.capnp").ApiSession;
        const call = (operation,extra={}) => rustShellBridge.handle("powerbox",{...extra,token:record.token,
          scope:record.scope,lease:record.lease,request:record.request,operation});
        const originalOrigin = Meteor.settings.public.rustShellOrigin;
        const require = (value,message) => { if (!value) throw new Error(message); };
        Meteor.settings.public.rustShellOrigin = 'https://rust.example.test';
        try {
          for (const provider of ['github','google']) {
            const enabled = Accounts.loginServices[provider].isEnabled;
            const config = await ServiceConfiguration.configurations.findOneAsync({service:provider});
            const url = provider === 'google' ? 'https://www.googleapis.com/drive/v3/' : 'https://api.github.com/';
            const scope = provider === 'google' ? 'https://www.googleapis.com/auth/drive.readonly' : 'repo';
            const tag = Capnp.serialize(ApiSession.PowerboxTag,{canonicalUrl:url,oauthScopes:[{name:scope}]});
            const query = [Capnp.serializePacked(Powerbox.PowerboxDescriptor,{tags:[{id:ApiSession.typeId,value:tag}]}).toString('base64')];
            let tokenId;
            try {
              Accounts.loginServices[provider].isEnabled = () => true;
              if (!config) await ServiceConfiguration.configurations.insertAsync({service:provider,clientId:'powerbox-test'});
              for (const mode of ['success','wrong-provider','cancel']) {
                const choices = await call('begin',{query});
                const candidate = choices.candidates.find(item=>item.oauthProvider===provider);
                require(!!candidate,'Missing native '+provider+' Powerbox candidate');
                const pending = await call('select',{key:candidate.key,mode:'oauthStart'});
                const authorize = new URL(pending.url);
                require(authorize.searchParams.get('scope') === (provider === 'google' ? 'email '+scope : scope),'Powerbox changed requested scopes');
                if (provider === 'google') require(authorize.searchParams.get('access_type') === 'offline' && authorize.searchParams.get('prompt') === 'consent','Google capability did not request offline consent');
                let denied=false;
                try {await finishOAuth(provider,'powerbox:'+record.requesterId,pending.request);} catch (_) {denied=true;}
                require(denied,'OAuth completion was not isolated to its Powerbox request');
                if (mode==='success') {
                  const adapter=rustPowerbox(globalDb);
                  const sibling=await adapter.open({accountId:this.userId,sessionId:record.requesterId,grainId},{query},async()=>{});
                  try {
                    const siblingCandidate=sibling.view.candidates.find(item=>item.oauthProvider===provider);
                    await adapter.select(sibling.handle,{key:siblingCandidate.key,mode:'oauthStart'},async()=>{});
                    require((await call('select',{key:candidate.key,mode:'oauthFinish'})).status==='waiting','Sibling authorization displaced this request');
                  } finally {await adapter.close(sibling.handle);}
                }
                require((await call('select',{key:candidate.key,mode:'oauthFinish'})).status==='waiting','Unfinished authorization completed');
                const secret=Random.secret(), access=Random.secret(), refresh=Random.secret();
                const serviceName=mode==='wrong-provider' ? (provider==='google' ? 'github' : 'google') : provider;
                await OAuth._storePendingCredential(pending.request,{serviceName,serviceData:{accessToken:OAuth.sealSecret(access),...(provider==='google' ? {refreshToken:OAuth.sealSecret(refresh)} : {})}},secret);
                await OAuth._endOfLoginResponse({writeHead(){},end(){}},{query:{state:authorize.searchParams.get('state')},loginStyle:'popup',credentials:{token:pending.request,secret}});
                if (mode==='cancel') {
                  await call('cancel');
                  require(!await OAuth.retrieveCredential(pending.request,secret),'Canceled request retained provider credentials');
                  continue;
                }
                if (mode==='wrong-provider') {
                  denied=false;
                  try {await call('select',{key:candidate.key,mode:'oauthFinish'});} catch (_) {denied=true;}
                  require(denied,'Mismatched OAuth provider issued a capability');
                  await call('cancel');
                  continue;
                }
                const result=await call('select',{key:candidate.key,mode:'oauthFinish',url:'https://attacker.invalid/'});
                require(result.status==='complete','OAuth capability was not issued');
                require(![secret,access,refresh].some(value=>JSON.stringify(result).includes(value)),'Provider credentials leaked to browser');
                tokenId=Crypto.createHash('sha256').update(result.token).digest('base64');
                const token=await globalDb.collections.apiTokens.findOneAsync(tokenId);
                require(token?.owner?.clientPowerboxRequest?.sessionId===record.requesterId,'OAuth capability targeted the wrong session');
                require(token.frontendRef?.http?.url===url,'Client changed the authorized API URL');
                require(provider==='google' ? token.frontendRef.http.auth.refresh!==refresh : token.frontendRef.http.auth.bearer!==access,'Provider token was stored unencrypted');
                const decrypted=await fetchApiToken(globalDb,result.token);
                require(provider==='google' ? decrypted.frontendRef.http.auth.refresh===refresh : decrypted.frontendRef.http.auth.bearer===access,'Provider token was not stored in the capability');
                require(!await OAuth.retrieveCredential(pending.request,secret),'OAuth credential was not consumed');
                await call('cancel');
                await globalDb.removeApiTokens({_id:tokenId});tokenId=null;
              }
            } finally {
              await call('cancel');
              if(tokenId) await globalDb.removeApiTokens({_id:tokenId});
              Accounts.loginServices[provider].isEnabled=enabled;
              if(!config) await ServiceConfiguration.configurations.removeAsync({service:provider});
            }
          }
        } finally {Meteor.settings.public.rustShellOrigin=originalOrigin;}
        return true;
      }
      if (action === "checkBuiltins") {
        const Powerbox = Capnp.importSystem("sandstorm/powerbox.capnp");
        const UiView = Capnp.importSystem("sandstorm/grain.capnp").UiView;
        const ApiSession = Capnp.importSystem("sandstorm/api-session.capnp").ApiSession;
        const call = (operation, extra = {}) => rustShellBridge.handle("powerbox", {...extra,token:record.token,
          scope:record.scope,lease:record.lease,request:record.request,operation});
        const query = type => [Capnp.serializePacked(Powerbox.PowerboxDescriptor,{tags:[{id:type.typeId}]}).toString("base64")];
        for (const kind of ["view","url","basic","bearer"]) {
          let id;
          try {
            const state = await call("begin", {query:query(kind === "view" ? UiView : ApiSession)});
            const candidate = state.candidates.find(row => kind === "view" ? row.uiView : row.urlInput);
            if (!candidate) throw new Error("Missing native " + kind + " option");
            const result = await call("select",{key:candidate.key,mode:kind === "view" ? "view" : "url",role:"all",url:kind === "basic" ? "https://user:password@example.com/" : kind === "bearer" ? "https://example.com/#bearer-secret" : "https://example.com/"});
            id = Crypto.createHash("sha256").update(result.token).digest("base64");
            const token = await globalDb.collections.apiTokens.findOneAsync(id);
            if (!token || token.owner?.clientPowerboxRequest?.sessionId !== record.requesterId ||
                token.owner.clientPowerboxRequest.grainId !== grainId) throw new Error("Powerbox result has incorrect receiving authority");
            if (kind !== "view" && token.frontendRef?.http?.url !== "https://example.com/") throw new Error("URL capability differs from selected URL");
            const decrypted = await fetchApiToken(globalDb,result.token);
            if (kind === "basic" && decrypted.frontendRef.http.auth.basic.password !== "password") throw new Error("URL basic credentials were lost");
            if (kind === "bearer" && decrypted.frontendRef.http.auth.bearer !== "bearer-secret") throw new Error("URL bearer credentials were lost");
            let replayed = false;
            try { await call("select",{key:candidate.key,mode:"view",role:"all"}); replayed = true; } catch (_) {}
            if (replayed) throw new Error("Completed Powerbox request replayed");
          } finally { await call("cancel"); if (id) await globalDb.removeApiTokens({_id:id}); }
        }
        // Identity choices use the requester's contacts and grant only the
        // selected role on the requesting grain, never a client-supplied user.
        const Identity = Capnp.importSystem("sandstorm/identity.capnp").Identity;
        const person = "rust-powerbox-person-" + Random.id();
        const session = await globalDb.collections.sessions.findOneAsync(record.requesterId);
        let contact, identityToken;
        try {
          await Meteor.users.insertAsync({_id:person,type:"account",profile:{name:"Powerbox person",handle:"powerbox-person",pronoun:"neutral"},loginCredentials:[],nonloginCredentials:[]});
          contact = await globalDb.collections.contacts.insertAsync({ownerId:this.userId,accountId:person});
          await globalDb.collections.sessions.updateAsync(record.requesterId,{$set:{viewInfo:{...session.viewInfo,roles:[
            {title:{defaultText:"Obsolete"},permissions:[true],obsolete:true},
            {title:{defaultText:"Insufficient"},permissions:[false]},
            {title:{defaultText:"Contributor"},permissions:[true]},
          ]}}});
          const identityQuery = [Capnp.serializePacked(Powerbox.PowerboxDescriptor,{tags:[{id:Identity.typeId,
            value:Capnp.serialize(Identity.PowerboxTag,{permissions:[true]})}]}).toString("base64")];
          let choices = await call("begin",{query:identityQuery});
          let candidate = choices.candidates.find(row => row.identity && row.title === "Powerbox person");
          if (!candidate || choices.legacy || JSON.stringify(candidate.roles.map(role=>role.key)) !== '["2"]') throw new Error("Identity roles were not filtered without reindexing");
          for (const role of ['0','1','99']) {
            let accepted = false;
            try { await call("select",{key:candidate.key,mode:"identity",role}); accepted = true; } catch (_) {}
            if (accepted) throw new Error("Invalid identity role accepted");
            choices = await call("begin",{query:identityQuery});
            candidate = choices.candidates.find(row => row.identity && row.title === "Powerbox person");
          }
          const result = await call("select",{key:candidate.key,mode:"identity",role:"all",id:this.userId});
          identityToken = Crypto.createHash("sha256").update(result.token).digest("base64");
          const token = await globalDb.collections.apiTokens.findOneAsync(identityToken);
          if (token?.frontendRef?.identity !== person || token.owner?.clientPowerboxRequest?.sessionId !== record.requesterId) throw new Error("Identity token has the wrong recipient or receiving session");
          if (!await globalDb.collections.apiTokens.findOneAsync({grainId,'owner.user.accountId':person})) throw new Error("Identity selection did not grant access");
        } finally {
          await call("cancel");
          await globalDb.collections.sessions.updateAsync(record.requesterId,{$set:{viewInfo:session.viewInfo}});
          if (identityToken) await globalDb.removeApiTokens({_id:identityToken});
          await globalDb.removeApiTokens({grainId,'owner.user.accountId':person});
          if (contact) await globalDb.collections.contacts.removeAsync(contact);
          await Meteor.users.removeAsync(person);
        }
        await call("begin",{query:query(UiView)});
        let forged = false;
        try { await call("select",{key:"grain-"+grainId,mode:"view",role:"all"}); forged = true; } catch (_) {}
        if (forged) throw new Error("Powerbox accepted a forged option key");
        const sourceCap = await globalThis.globalFrontendRefRegistry.create(globalDb,
          {http:{url:"https://example.com/",auth:{none:null}}}, []);
        const ids = [];
        const remember = token => { const id = Crypto.createHash("sha256").update(token).digest("base64"); ids.push(id); return id; };
        const webkeyUrl = token => new URL(process.env.ROOT_URL).protocol + "//" + globalDb.makeApiHost(token) + "/#" + token;
        try {
          const source = (await sourceCap.save({webkey:null})).sturdyRef.toString();
          const sourceId = remember(source);
          const link = webkeyUrl(source);
          await call("begin",{query:[]});
          const result = await call("select",{mode:"webkey",url:link,grainId:"must-not-own",sessionId:"must-not-own"});
          const id = remember(result.token);
          if (result.token === source) throw new Error("Powerbox returned the source webkey");
          const row = await globalDb.collections.apiTokens.findOneAsync(id);
          if (row.owner?.clientPowerboxRequest?.sessionId !== record.requesterId || row.owner.clientPowerboxRequest.grainId !== grainId) throw new Error("Pasted capability has the wrong owner");
          await call("cancel");
          const legacy = await getMethodHandler("finishPowerboxRequest").call({connection:{sandstormDb:globalDb}},record.requesterId,link,"label",null,"must-not-own");
          remember(legacy);
          const legacyRow = await globalDb.collections.apiTokens.findOneAsync(ids[ids.length-1]);
          if (legacyRow.owner.clientPowerboxRequest.grainId !== grainId) throw new Error("Legacy webkey caller chose its own receiving grain");
          const owned = (await sourceCap.save({clientPowerboxRequest:{sessionId:record.requesterId,grainId}})).sturdyRef.toString();
          remember(owned);
          const bad = ["https://example.com/#secret", link.split("#")[0],
            link.slice(0,link.indexOf("#")) + "#wrong-token", process.env.ROOT_URL + "/shared/" + source];
          bad.push(webkeyUrl(owned));
          for (const url of bad) {
            await call("begin",{query:[]});
            let accepted = false;
            try { await call("select",{mode:"webkey",url}); accepted = true; } catch (_) {}
            finally { await call("cancel"); }
            if (accepted) throw new Error("Invalid or non-webkey capability accepted");
          }
          let wrongAccount = false;
          try { await redeemPowerboxWebkey(globalDb,"another-account",record.requesterId,link); wrongAccount = true; } catch (_) {}
          if (wrongAccount) throw new Error("Webkey exchange crossed account session boundary");
          await globalDb.collections.apiTokens.updateAsync(sourceId,{$set:{revoked:true}});
          await call("begin",{query:[]});
          let revoked = false;
          try { await call("select",{mode:"webkey",url:link}); revoked = true; } catch (_) {}
          finally { await call("cancel"); }
          if (revoked) throw new Error("Revoked webkey was accepted");
        } finally {
          sourceCap.close();
          await call("cancel");
          for (const id of ids) await globalDb.removeApiTokens({_id:id});
        }

        return true;
      }
      if (action === "verifyProviderClosed") {
        if (await globalDb.collections.sessions.findOneAsync(record.providerId)) throw new Error("Provider survived request close");
        return true;
      }
      const result = await rustShellBridge.handle("powerbox",{...input,token:record.token,scope:record.scope,lease:record.lease,request:record.request,operation:action});
      if (result.status === "provider") record.providerId = new URL(result.url).searchParams.get("sessionid");
      return result;
    },

    async testRustNativeSharing(grainId) {
      check(grainId, String);
      const source = await globalDb.collections.grains.findOneAsync({ _id: grainId, userId: this.userId });
      if (!source || !this.userId) throw new Meteor.Error(403, "Owned test grain required");
      const recipient = "rust-sharing-" + Random.id();
      const otherGrain = "rust-sharing-other-" + Random.id();
      const hash = Crypto.randomBytes(32).toString("hex");
      const previousOrigin = Meteor.settings.public.rustShellOrigin;
      const tokens = [];
      const tokenIds = [];
      const require = (condition, message) => { if (!condition) throw new Error(message); };
      const denied = async (operation, message) => {
        let failed = false;
        try { await operation(); } catch (_) { failed = true; }
        require(failed, message);
      };
      const link = async (accountId, loginHash) => {
        const state = Crypto.randomBytes(32).toString("hex");
        const code = await rustShellBridge.issue(accountId, loginHash, state);
        const { token } = await rustShellBridge.handle("exchange", { code, state });
        tokens.push(token);
        const scope = Crypto.randomBytes(32).toString("hex");
        const view = await rustShellBridge.handle("openGrain", { token, scope, grainId });
        return (action, input = {}) => rustShellBridge.handle(action, { ...input, token, scope, lease: view.lease });
      };
      const remember = result => {
        tokenIds.push(Crypto.createHash("sha256").update(result.token).digest("base64"));
        return tokenIds[tokenIds.length - 1];
      };
      try {
        Meteor.settings.public.rustShellOrigin = new URL(process.env.ROOT_URL).origin;
        await Meteor.users.insertAsync({ _id: recipient, type: "account", loginCredentials: [], nonloginCredentials: [],
          profile: { name: "Native sharing recipient", handle: "recipient", pronoun: "neutral" },
          services: { resume: { loginTokens: [{ hashedToken: hash, when: new Date() }] } } });
        const owner = await link(this.userId, Accounts._getLoginToken(this.connection.id));
        const share = await owner("createShare", {label:"Native sharing",role:"all"});
        const shareId = remember(share);
        const stored = await globalDb.collections.apiTokens.findOneAsync(shareId);
        require(stored.forSharing && stored.grainId === grainId && stored.accountId === this.userId && !stored.expiresIfUnused,
          "Native sharing created incorrect authority or an expiring API token");
        await inspectRustSharedGrain(globalDb, share.token);
        for (const accountId of [null, this.userId]) {
          const session = await createRustSharedGrainSession(globalDb, share.token, accountId, process.env.ROOT_URL);
          await closeRustSharedGrainSession(globalDb, {sessionId:session._id,hashedToken:session.hashedToken});
        }
        const redeemed = await SandstormPermissions.createNewApiToken(globalDb, {rawParentToken:share.token}, grainId,
          "Recipient copy", {allAccess:null}, {user:{accountId:recipient,title:source.title}});
        tokenIds.push(redeemed.id);
        const recipientCall = await link(recipient, hash);
        const onward = await recipientCall("createShare", {label:"Onward share",role:"all"});
        const onwardId = remember(onward);
        const snapshot = await owner("getSharing");
        require(snapshot.grants.some(row => row.id === shareId && row.editable), "Own link missing");
        require(snapshot.grants.some(row => row.id === redeemed.id && row.inherited && !row.editable && row.recipient === "Native sharing recipient"), "Redeemed access was not projected safely");
        require(snapshot.grants.some(row => row.id === onwardId && !row.editable), "Downstream share incorrectly editable");
        require(!JSON.stringify(snapshot).includes(share.token), "Sharing projection exposed raw bearer token");
        await denied(() => owner("updateShare",{id:onwardId,changes:{revoked:true}}), "Owner changed another account's token");
        await denied(() => recipientCall("updateShare",{id:shareId,changes:{revoked:true}}), "Recipient changed owner's token");
        await denied(() => owner("updateShare",{id:redeemed.id,changes:{revoked:true}}), "Derived grant was edited as an independent source");
        await globalDb.collections.grains.insertAsync({_id:otherGrain,userId:this.userId,private:true,packageId:source.packageId,title:"Other grain"});
        const foreign = await SandstormPermissions.createNewApiToken(globalDb, {accountId:this.userId}, otherGrain,
          "Foreign grain", {allAccess:null}, {webkey:{forSharing:true}});
        tokenIds.push(foreign.id);
        await denied(() => owner("updateShare",{id:foreign.id,changes:{revoked:true}}), "Grain-scoped capability changed another grain");
        await globalDb.collections.apiTokens.updateAsync(shareId, {$unset:{owner:1}});
        require((await owner("getSharing")).grants.some(row => row.id === shareId && row.editable), "Legacy ownerless link was omitted");
        await globalDb.collections.apiTokens.updateAsync(shareId, {$set:{owner:{webkey:null}}});
        await denied(() => owner("createShare",{label:"Invalid",role:"999"}), "Invalid role accepted");
        await denied(() => owner("updateShare",{id:shareId,changes:{accountId:recipient}}), "Unrecognized mutation fields accepted");
        const direct = await SandstormPermissions.createNewApiToken(globalDb, {accountId:this.userId}, grainId,
          "Direct grant", {allAccess:null}, {user:{accountId:recipient,title:source.title}});
        tokenIds.push(direct.id);
        require((await owner("getSharing")).grants.some(row => row.id === direct.id && row.editable && !row.inherited), "Direct grant not editable");
        await globalDb.collections.apiTokens.updateAsync(direct.id, {$set:{roleAssignment:{allAccess:null,removePermissions:[true]}}});
        require((await owner("getSharing")).grants.find(row => row.id === direct.id).role === "custom", "Custom grant was mislabeled as a full role");
        await owner("updateShare",{id:direct.id,changes:{label:"Custom grant renamed"}});
        require((await globalDb.collections.apiTokens.findOneAsync(direct.id)).roleAssignment.removePermissions[0], "Label edit overwrote custom restrictions");
        await owner("updateShare",{id:direct.id,changes:{role:"none"}});
        await owner("updateShare",{id:direct.id,changes:{revoked:true}});
        await getMethodHandler("updateApiToken").call({userId:this.userId,connection:{sandstormDb:globalDb}}, shareId, {petname:"Legacy edit"});
        require((await owner("getSharing")).grants.find(row => row.id === shareId).label === "Legacy edit", "Legacy token updates diverged");
        await owner("updateShare",{id:shareId,changes:{label:"Edited link",role:"none"}});
        const edited = await globalDb.collections.apiTokens.findOneAsync(shareId);
        require(edited.petname === "Edited link" && Object.hasOwn(edited.roleAssignment,"none"), "Permission or label edit was not canonical");
        await owner("updateShare",{id:shareId,changes:{revoked:true}});
        require(!(await owner("getSharing")).grants.some(row => row.id === shareId), "Revoked link remains active in listing");
        await denied(() => inspectRustSharedGrain(globalDb, share.token), "Revoked webkey still opens");
        await denied(() => recipientCall("createShare",{label:"Revoked",role:"all"}), "Revoked recipient created a share");
        await denied(() => recipientCall("getSharing"), "Revoked recipient read sharing metadata");
        return true;
      } finally {
        for (const token of tokens) await rustShellBridge.handle("logout", {token});
        for (const id of tokenIds) await globalDb.removeApiTokens({_id:id});
        await Meteor.users.removeAsync(recipient);
        await globalDb.collections.grains.removeAsync(otherGrain);
        Meteor.settings.public.rustShellOrigin = previousOrigin;
      }
    },

    async testRustRenameGrain(grainId) {
      check(grainId, String);
      const source = await globalDb.collections.grains.findOneAsync({ _id: grainId, userId: this.userId });
      if (!source || !this.userId) throw new Meteor.Error(403, "Owned test grain required");
      const recipient = "rust-rename-" + Random.id();
      const hash = Crypto.randomBytes(32).toString("hex");
      const previousOrigin = Meteor.settings.public.rustShellOrigin;
      const tokens = [];
      let share;
      const require = (condition, message) => { if (!condition) throw new Error(message); };
      const link = async (accountId, loginHash) => {
        const state = Crypto.randomBytes(32).toString("hex");
        const code = await rustShellBridge.issue(accountId, loginHash, state);
        const { token } = await rustShellBridge.handle("exchange", { code, state });
        tokens.push(token);
        const scope = Crypto.randomBytes(32).toString("hex");
        const view = await rustShellBridge.handle("openGrain", { token, scope, grainId });
        return title => rustShellBridge.handle("renameGrain", { token, scope, lease: view.lease, title });
      };
      try {
        Meteor.settings.public.rustShellOrigin = new URL(process.env.ROOT_URL).origin;
        await Meteor.users.insertAsync({ _id: recipient, type: "account", loginCredentials: [], nonloginCredentials: [],
          profile: { name: "Rename recipient", handle: "recipient", pronoun: "neutral" },
          services: { resume: { loginTokens: [{ hashedToken: hash, when: new Date() }] } } });
        share = await SandstormPermissions.createNewApiToken(globalDb, { accountId: this.userId }, grainId,
          "Rename test", { allAccess: null }, { user: { accountId: recipient, title: source.title } });
        const ownerRename = await link(this.userId, Accounts._getLoginToken(this.connection.id));
        const recipientRename = await link(recipient, hash);
        await ownerRename("Owner rename");
        require((await rustShellBridge.handle("snapshot", { token: tokens[1] })).grains.find(row => row.key === grainId).title === "Owner rename", "Recipient did not follow owner rename");
        const personalRename = await recipientRename("My private name");
        require(personalRename.title === "My private name", "Rename response used the wrong title");
        require(personalRename.ownerTitle === "Owner rename", "Rename response exposed the personal alias as owner title");
        require((await globalDb.collections.grains.findOneAsync(grainId)).title === "Owner rename", "Recipient changed owner's title");
        require((await rustShellBridge.handle("snapshot", { token: tokens[1] })).grains.find(row => row.key === grainId).title === "My private name", "Recipient rename was not saved");
        await ownerRename("Later owner rename");
        require((await rustShellBridge.handle("snapshot", { token: tokens[1] })).grains.find(row => row.key === grainId).title === "My private name", "Owner overwrote recipient's personal title");
        const personalProjection = (await rustShellBridge.handle("snapshot", { token: tokens[1] })).grains.find(row => row.key === grainId);
        require(personalProjection.ownerTitle === "Later owner rename", "Projection did not preserve the distinct owner title");
        await recipientRename("Later owner rename");
        const row = await globalDb.collections.apiTokens.findOneAsync(share.id);
        require(!row.owner.user.renamed, "Matching upstream title did not reset personal rename");
        await globalDb.collections.apiTokens.updateAsync(share.id, { $set: { revoked: true } });
        let denied = false;
        try { await recipientRename("Must not change"); }
        catch (error) { denied = error.error === 403 || error.status === 410; }
        require(denied, "Revoked recipient renamed a grain");
        require((await globalDb.collections.grains.findOneAsync(grainId)).title === "Later owner rename", "Revoked rename altered owner title");
        return true;
      } finally {
        for (const token of tokens) await rustShellBridge.handle("logout", { token });
        if (share) await globalDb.removeApiTokens({ _id: share.id });
        await renameGrainForUser(this.userId, grainId, source.title);
        await Meteor.users.removeAsync(recipient);
        Meteor.settings.public.rustShellOrigin = previousOrigin;
      }
    },

    async testRustInstall(grainId) {
      const source = await globalDb.collections.grains.findOneAsync({_id:grainId,userId:this.userId});
      if (!source || !this.userId) throw new Meteor.Error(403,"Owned test grain required");
      const pkg = await globalDb.collections.packages.findOneAsync(source.packageId);
      const version = pkg.manifest.appVersion;
      const foreign = "rust-install-foreign-" + Random.id();
      const newer = "rust-install-newer-" + Random.id();
      const oldPackage = "f".repeat(32);
      let token, uploadToken;
      const originalReportSetting = await globalDb.collections.settings.findOneAsync('reportStats');
      const originalReportNotices = await globalDb.collections.notifications.find({'admin.type':'reportStats'}).fetchAsync();
      const originalUser = await Meteor.users.findOneAsync(this.userId);
      const notificationIds = Array.from({length:7}, () => "rust-notification-" + Random.id());
      const require = (ok,message) => { if (!ok) throw new Error(message); };
      try {
        const state = Crypto.randomBytes(32).toString("hex");
        const code = await rustShellBridge.issue(this.userId, Accounts._getLoginToken(this.connection.id), state);
        ({token} = await rustShellBridge.handle("exchange",{code,state}));
        const call = (operation,data={packageId:pkg._id}) => rustShellBridge.handle("install",{token,operation,data,accountId:"must-not-own"});
        const notifications = [
          {grainId,path:"folder/document?mode=read#comment"},
          {appUpdates:{[pkg.appId]:{name:"Test update",packageId:pkg._id}}},
          {admin:{action:"/admin"}},
          {grainId,userId:"another-account"},
          {admin:{action:'/admin/stats',type:'reportStats'}},
          {referral:true},
          {identityChanges:true},
        ];
        for (let i=0;i<notifications.length;i++) await globalDb.collections.notifications.insertAsync({
          _id:notificationIds[i],userId:this.userId,timestamp:new Date(),isUnread:true,...notifications[i],
        });
        const snapshot = await rustShellBridge.handle("snapshot",{token});
        const notification = index => snapshot.entries.find(row => row.key === notificationIds[index]);
        require(notification(0)?.nativePath === "/grain/"+grainId+"/folder/document?mode=read#comment","Grain notification path lost");
        require(notification(1)?.nativePath === "/install","Update notification did not target native installer");
        require(notification(2)?.nativePath === "" && notification(2).href.endsWith("/admin"),"Unsupported notification lost its legacy destination");
        require(!notification(3),"Another account's notification leaked");
        const noticeCall = (index,operation='details',enabled=false) => rustShellBridge.handle('notification',{token,key:notificationIds[index],operation,enabled,accountId:'another-account'});
        require(notification(4)?.nativeAction === 'stats' && notification(5)?.nativeAction === 'referrals' && notification(6)?.nativeAction === 'identity','Native notice actions missing');
        require((await noticeCall(6)).kind === 'identity','Identity notice missing');
        require((await noticeCall(5)).kind === 'referrals','Referral details missing');
        for (const [index,operation] of [[3,'details'],[5,'setStats'],[6,'setStats']]) {
          let denied=false; try { await noticeCall(index,operation); } catch (_) { denied=true; }
          require(denied,'Notification ownership or action boundary bypassed');
        }
        await Meteor.users.updateAsync(this.userId,{$set:{isAdmin:false}});
        for (const operation of ['details','setStats']) {
          let denied=false; try { await noticeCall(4,operation); } catch (_) { denied=true; }
          require(denied,'Non-admin accessed statistics preferences');
        }
        await Meteor.users.updateAsync(this.userId,{$set:{isAdmin:true}});
        require((await noticeCall(4)).kind === 'stats','Admin could not view statistics');
        require((await noticeCall(4,'setStats',false)).enabled === false,'Statistics setting did not update');
        require((await globalDb.collections.settings.findOneAsync('reportStats')).value === false,'Canonical reportStats setting unchanged');
        require(!await globalDb.collections.notifications.findOneAsync(notificationIds[4]),'Stats notice not dismissed');
        await rustShellBridge.handle('read',{token,key:notificationIds[6]});
        require((await globalDb.collections.notifications.findOneAsync(notificationIds[6])).isUnread === false,'Individual notification not marked read');
        require((await globalDb.collections.notifications.findOneAsync(notificationIds[5])).isUnread === true,'Other notification marked read');
        await rustShellBridge.handle('read',{token,key:notificationIds[3]});
        require((await globalDb.collections.notifications.findOneAsync(notificationIds[3])).isUnread === true,'Another account notification marked read');
        const initial = await call("status");
        require(initial.status === "ready" && initial.installed && initial.iconSrc,"Missing installation projection");
        const catalog = await call("catalog",{});
        require(/^https?:/.test(catalog.marketUrl),"Missing market URL");
        for (const [operation,data] of [["confirm",{packageId:"0".repeat(32)}],["download",{packageId:pkg._id,url:"file:///etc/passwd"}],["upgrade",{packageId:"0".repeat(32)}]]) {
          let denied = false; try { await call(operation,data); } catch (_) { denied = true; }
          require(denied,"Invalid installation request accepted");
        }
        const upload = await call("upload",{});
        uploadToken = new URL(upload.uploadUrl).pathname.split("/").pop();
        require(await globalDb.collections.spkTokens.findOneAsync(uploadToken),"Upload credential was not issued by canonical installer");
        await call("download",{packageId:pkg._id,url:""});
        await call("confirm");
        require(await globalDb.collections.userActions.findOneAsync({userId:this.userId,packageId:pkg._id}),"Confirmation did not install actions");
        require(!await globalDb.collections.userActions.findOneAsync({userId:"must-not-own",packageId:pkg._id}),"Confirmation crossed account boundary");
        await globalDb.collections.grains.insertAsync({...source,_id:foreign,userId:"another-account",packageId:oldPackage});
        await globalDb.collections.grains.insertAsync({...source,_id:newer,appVersion:version+1,packageId:oldPackage});
        await globalDb.collections.grains.updateAsync(grainId,{$set:{packageId:oldPackage,appVersion:version}});
        require((await call("status")).olderGrains >= 1,"Older grains not projected");
        await call("upgrade");
        require((await globalDb.collections.grains.findOneAsync(grainId)).packageId === pkg._id,"Owned grain not upgraded");
        require((await globalDb.collections.grains.findOneAsync(foreign)).packageId === oldPackage,"Another account's grain was upgraded");
        require((await globalDb.collections.grains.findOneAsync(newer)).packageId === oldPackage,"Newer grain was downgraded");
        await globalDb.collections.userActions.updateAsync({userId:this.userId,packageId:pkg._id},{$set:{appVersion:version+1}},{multi:true});
        let denied = false; try { await call("confirm"); } catch (_) { denied = true; }
        require(denied,"Newer installed app was downgraded");
        await rustShellBridge.handle("logout",{token});
        denied = false; try { await call("confirm"); } catch (_) { denied = true; }
        require(denied,"Revoked session installed app");
        return true;
      } finally {
        await Meteor.users.updateAsync(this.userId, originalUser.isAdmin === undefined ? {$unset:{isAdmin:1}} : {$set:{isAdmin:originalUser.isAdmin}});
        if (originalReportSetting) await globalDb.collections.settings.upsertAsync('reportStats',originalReportSetting);
        else await globalDb.collections.settings.removeAsync('reportStats');
        for (const notice of originalReportNotices) await globalDb.collections.notifications.upsertAsync(notice._id,notice);
        await globalDb.collections.notifications.removeAsync({_id:{$in:notificationIds}});
        if (token) await rustShellBridge.handle("logout",{token});
        if (uploadToken) await globalDb.collections.spkTokens.removeAsync(uploadToken);
        await globalDb.collections.grains.removeAsync({_id:{$in:[foreign,newer]}});
        await globalDb.collections.grains.updateAsync(grainId,{$set:{packageId:source.packageId,appVersion:source.appVersion}});
        await globalDb.collections.userActions.updateAsync({userId:this.userId,packageId:pkg._id},{$set:{appVersion:version}},{multi:true});
      }
    },

    async testRustInstallPermissions() {
      if (!this.userId) throw new Meteor.Error(403, "Sign in first");
      const original = Meteor.settings.public.allowUninvited;
      const account = {type:"account",loginCredentials:[],signupKey:"test"};
      const require = (value, message) => { if (!value) throw new Error(message); };
      try {
        Meteor.settings.public.allowUninvited = false;
        let policy = await appInstallPermissions(globalDb, account);
        require(policy.canInstall && policy.canUpload, "Invited account was denied");
        policy = await appInstallPermissions(globalDb, {...account, signupKey:undefined});
        require(!policy.canInstall && !policy.canUpload && policy.installReason && policy.uploadReason, "Uninvited account lacks an explanation");
        policy = await appInstallPermissions(globalDb, {...account,expires:new Date(Date.now()+60000)});
        require(policy.canInstall && !policy.canUpload, "Demo upload policy changed");
        Meteor.settings.public.allowUninvited = true;
        policy = await appInstallPermissions(globalDb, {...account,plan:"free"});
        require(policy.canInstall && !policy.canUpload && policy.uploadReason, "Free account upload policy changed");
        policy = await appInstallPermissions(globalDb, {...account,plan:"paid"});
        require(policy.canInstall && policy.canUpload, "Paid account was denied");
        return true;
      } finally { Meteor.settings.public.allowUninvited = original; }
    },

    async testRustGrainReadiness() {
      if (!this.userId) throw new Meteor.Error(403, "Sign in first");
      const sessions = globalDb.collections.sessions;
      const sessionId = "rust-ready-" + Random.id();
      const handle = {sessionId};
      const signal = new AbortController().signal;
      const require = (ok, message) => { if (!ok) throw new Error(message); };
      try {
        await sessions.insertAsync({_id:sessionId,rustShellSession:true,hasLoaded:false,timestamp:new Date()});
        const ready = waitForGrainResponse(globalDb, handle, signal);
        await sessions.updateAsync(sessionId, {$set:{hasLoaded:true}});
        require((await ready).loaded, "Gateway response did not wake readiness observer");
        require((await waitForGrainResponse(globalDb, handle, signal)).loaded, "Initial ready state was lost");
        await sessions.updateAsync(sessionId, {$set:{hasLoaded:false}});
        const controller = new AbortController();
        const aborted = waitForGrainResponse(globalDb, handle, controller.signal);
        controller.abort();
        try { await aborted; throw new Error("Disconnected observer did not stop"); }
        catch (error) { require(error.status === 410, "Incorrect cancellation result"); }
        const removed = waitForGrainResponse(globalDb, handle, signal).then(
            () => null, error => error);
        await sessions.removeAsync(sessionId);
        require((await removed)?.status === 410, "Incorrect removed-session result");
        return true;
      } finally { await sessions.removeAsync(sessionId); }
    },

    async testRustGrainManagement() {
      if (!this.userId) throw new Meteor.Error(403,"Sign in first");
      const prefix='rust-management-'+Random.id();
      const owned=prefix+'-owned', shared=prefix+'-shared';
      const mine=prefix+'-mine', other=prefix+'-other', ui=prefix+'-session';
      const require=(ok,message)=>{if(!ok)throw new Error(message);};
      const call=(id,operation)=>manageGrainForUser(this.userId,id,operation,async()=>{});
      const query=trash=>grainMenu(globalDb,this.userId,process.env.ROOT_URL,0,{search:prefix,appId:'',ownership:'all',sort:'title',trash});
      try {
        await globalDb.collections.grains.insertAsync({_id:owned,userId:this.userId,title:owned,appId:'test',packageId:prefix+'-package'});
        await globalDb.collections.grains.insertAsync({_id:shared,userId:'other-account',title:shared});
        for(const [id,accountId] of [[mine,this.userId],[other,'other-account']]) {
          await globalDb.collections.apiTokens.insertAsync({_id:id,grainId:shared,created:new Date(),owner:{user:{accountId,title:shared,
            denormalizedGrainMetadata:{appId:'test',appTitle:{defaultText:'Test'}}}}});
        }
        await globalDb.collections.sessions.insertAsync({_id:ui,grainId:shared,userId:this.userId,rustShellSession:true});
        let denied=false;
        try {await call(owned,'remove');} catch(_){denied=true;}
        require(denied,'Active grain was permanently deleted');
        require((await query(false)).grains.length===2,'Active management list is incomplete');
        for(const id of [owned,shared])await call(id,'trash');
        require((await query(true)).grains.length===2 && (await query(false)).grains.length===0,'Trash query did not move both owned and shared grains');
        require(!await globalDb.collections.sessions.findOneAsync(ui),'Trashed recipient session remained open');
        require(!(await globalDb.collections.apiTokens.findOneAsync(other)).trashed,'Trashing affected another recipient');
        require((await call(shared,'read')).state==='trashed','Shared trash state missing');
        for(const id of [owned,shared])await call(id,'restore');
        require((await query(false)).grains.length===2 && !(await query(true)).grains.length,'Restore did not update canonical lists');
        // Use the real legacy method too: both shells share the same operations.
        await getMethodHandler('moveGrainsToTrash').call({userId:this.userId,isSimulation:false,
          connection:{sandstormBackend:globalThis.globalBackend}},[owned,shared]);
        await call(shared,'remove');
        require(!!await globalDb.collections.grains.findOneAsync(shared),'Forgetting a share deleted its owner data');
        require(!!await globalDb.collections.apiTokens.findOneAsync(other) && !await globalDb.collections.apiTokens.findOneAsync(mine),'Forgetting escaped recipient scope');
        await call(owned,'remove');
        require(!await globalDb.collections.grains.findOneAsync(owned),'Owned trashed grain was not deleted');
        denied=false;
        try {await call(shared,'trash');} catch(_){denied=true;}
        require(denied,'Foreign unsaved grain was manageable');
        return true;
      } finally {
        await globalDb.collections.sessions.removeAsync(ui);
        await globalDb.removeApiTokens({_id:{$in:[mine,other]}});
        await globalDb.collections.grains.removeAsync({_id:{$in:[owned,shared]}});
      }
    },

    async testRustGrainQueries() {
      if (!this.userId) throw new Meteor.Error(403, "Sign in first");
      const accountId = "rust-query-" + Random.id();
      const grains = globalDb.collections.grains;
      const tokens = globalDb.collections.apiTokens;
      const ids = Array.from({length:105}, (_, i) => accountId + "-" + i);
      const sharedId = accountId + "-shared";
      const tokenIds = [accountId + "-token", accountId + "-duplicate"];
      const require = (ok, message) => { if (!ok) throw new Error(message); };
      const query = (changes = {}, page = 0) => grainMenu(globalDb, accountId, process.env.ROOT_URL,
        page, {search:"",appId:"",ownership:"all",sort:"title",...changes});
      try {
        await Promise.all(ids.map((_id, i) => grains.insertAsync({_id, userId:accountId,
          title:"Document " + String(i).padStart(3,"0"), appId:i === 104 ? "rare-app" : "common-app",
          created:new Date(i * 1000)})));
        await grains.insertAsync({_id:sharedId,userId:"other-account",title:"Private owner title"});
        await Promise.all(tokenIds.map((_id, i) => tokens.insertAsync({_id,grainId:sharedId,created:new Date(i),
          owner:{user:{accountId,title:"Personal [draft].*",upstreamTitle:"Upstream",renamed:true,
            denormalizedGrainMetadata:{appId:"shared-app",appTitle:{defaultText:"Shared App"}}}}})));
        let result = await query();
        require(result.grains.length === 100 && result.grainsLimited, "First query page was not bounded");
        result = await query({}, 1);
        require(result.grains.length === 6 && !result.grainsLimited, "Combined pagination duplicated or lost grains");
        require(result.grains.filter(g => g.key === sharedId).length === 1, "Shared links were not deduplicated");
        result = await query({search:"104"});
        require(result.grains.length === 1 && result.grains[0].key === ids[104], "Search applied after pagination");
        result = await query({appId:"rare-app"});
        require(result.grains.length === 1 && result.grains[0].key === ids[104], "App filter applied after pagination");
        result = await query({search:"[draft].*"});
        require(result.grains.length === 1 && result.grains[0].key === sharedId, "Search did not treat metacharacters literally");
        require((await query({search:".*"})).grains.length === 1, "Search accepted a regular expression");
        result = await query({ownership:"owned",sort:"recent"});
        require(result.grains[0].key === ids[104] && result.grains.every(g => g.owned), "Recent or ownership ordering failed");
        result = await query({ownership:"shared"});
        require(result.grains.length === 1 && result.grains[0].title === "Personal [draft].*", "Shared title override was lost");
        await tokens.updateAsync({_id:{$in:tokenIds}}, {$set:{"owner.user.renamed":false}}, {multi:true});
        require((await query({search:"Upstream"})).grains.length === 1, "Owner rename not reflected in search");
        await tokens.updateAsync({_id:{$in:tokenIds}}, {$set:{revoked:true}}, {multi:true});
        require((await query({ownership:"shared"})).grains.length === 0, "Revoked share leaked into query");
        await grains.updateAsync(ids[104], {$set:{trashed:new Date()}});
        require((await query({appId:"rare-app"})).grains.length === 0, "Trashed grain leaked into query");
        return true;
      } finally {
        await tokens.removeAsync({_id:{$in:tokenIds}});
        await grains.removeAsync({_id:{$in:[...ids,sharedId]}});
      }
    },

    async testRustCreateGrain(grainId) {
      check(grainId, String);
      const source = await globalDb.collections.grains.findOneAsync({ _id: grainId, userId: this.userId });
      if (!source || !this.userId) throw new Meteor.Error(403, "Owned test grain required");
      const action = await globalDb.collections.userActions.findOneAsync({ userId: this.userId, packageId: source.packageId });
      if (!action) throw new Error("Test app action not installed");
      const foreignId = "rust-foreign-action-" + Random.id();
      let token;
      try {
        await globalDb.collections.userActions.insertAsync({ ...action, _id: foreignId, userId: "unrelated-account" });
        const state = Crypto.randomBytes(32).toString("hex");
        const code = await rustShellBridge.issue(this.userId, Accounts._getLoginToken(this.connection.id), state);
        ({ token } = await rustShellBridge.handle("exchange", { code, state }));
        const call = (name, input = {}) => rustShellBridge.handle(name, { token, ...input });
        const list = await call("listApps");
        if (!list.actions.some(row => row.key === action._id) || list.actions.some(row => row.key === foreignId)) {
          throw new Error("Installed actions leaked or omitted account data");
        }
        const projected = list.actions.find(row => row.key === action._id);
        const sharedGrain = "rust-app-count-" + Random.id();
        const countTokens = [Random.id(),Random.id(),Random.id()];
        try {
          await globalDb.collections.grains.insertAsync({...source,_id:sharedGrain,userId:"other-account"});
          for (let i=0;i<countTokens.length;i++) await globalDb.collections.apiTokens.insertAsync({
            _id:countTokens[i],grainId:i===2 ? grainId : sharedGrain,
            owner:{user:{accountId:this.userId,denormalizedGrainMetadata:{appId:source.appId}}},
          });
          const counted = (await call("listApps")).actions.find(row => row.key === action._id);
          if (counted.grainCount !== projected.grainCount + 1) throw new Error("App grain count duplicated shared links or self-shares");
          await globalDb.collections.grains.updateAsync(sharedGrain,{$set:{trashed:new Date()}});
          const trashed = (await call("listApps")).actions.find(row => row.key === action._id);
          if (trashed.grainCount !== projected.grainCount) throw new Error("App count included trashed shared grains");
        } finally {
          await globalDb.collections.apiTokens.removeAsync({_id:{$in:countTokens}});
          await globalDb.collections.grains.removeAsync(sharedGrain);
        }

        if (projected.appId !== source.appId || !projected.iconSrc ||
            !projected.lastUsed || !Number.isFinite(Date.parse(projected.lastUsed))) {
          throw new Error("App gallery metadata is missing its icon or usage timestamp");
        }
        let denied = false;
        try { await call("createGrain", { actionId: foreignId, title: "Must not create" }); }
        catch (error) { denied = error.error === 404; }
        if (!denied) throw new Error("Foreign app action was accepted");
        const result = await call("createGrain", { actionId: action._id, title: "Created through Rust API" });
        const grain = await globalDb.collections.grains.findOneAsync(result.grainId);
        if (!grain || grain.userId !== this.userId || grain.packageId !== action.packageId || grain.title !== "Created through Rust API") {
          throw new Error("Created grain metadata differs from requested account/action");
        }
        return result.grainId;
      } finally {
        if (token) await rustShellBridge.handle("logout", { token });
        await globalDb.collections.userActions.removeAsync(foreignId);
      }
    },

    async testRustGrainSession(operation, grainId) {
      check(operation, String);
      check(grainId, String);
      const grain = await globalDb.collections.grains.findOneAsync({ _id: grainId, userId: this.userId });
      if (!grain || !this.userId) throw new Meteor.Error(403, "Owned test grain required");
      const key = this.userId + ":" + grainId;
      let record = rustGrainTestSessions.get(key);
      if (operation === "webkey-anonymous" || operation === "webkey-identity") {
        if (record) throw new Meteor.Error(409, "Close test session first");
        const share = await SandstormPermissions.createNewApiToken(globalDb, { accountId: this.userId },
            grainId, "Rust native shared viewer", { allAccess: null }, { webkey: null });
        record = { accountId: this.userId, grainId, tokenId: share.id };
        rustGrainTestSessions.set(key, record);
        await globalDb.collections.apiTokens.updateAsync(share.id, { $set: { expiresIfUnused: new Date(Date.now() + 60000) } });
        await inspectRustSharedGrain(globalDb, share.token);
        if (!(await globalDb.collections.apiTokens.findOneAsync(share.id)).expiresIfUnused) {
          throw new Error("Inspecting consumed the unused sharing link");
        }
        const accountId = operation === "webkey-identity" ? this.userId : null;
        const session = await createRustSharedGrainSession(globalDb, share.token, accountId, process.env.ROOT_URL);
        record.sessionId = session._id;
        record.hashedToken = session.hashedToken;
        await keepRustSharedGrainSession(globalDb, record);
        if (session.hashedToken !== share.id || !!session.identityId !== !!accountId ||
            !!session.userId !== !!accountId || !session.rustShellSession) throw new Error("Incorrect shared identity or authority");
        await globalDb.collections.apiTokens.updateAsync(share.id, { $set: { revoked: true } });
        for (const identity of [null, this.userId]) {
          let denied = false;
          try { await createRustSharedGrainSession(globalDb, share.token, identity, process.env.ROOT_URL); }
          catch (error) { denied = error.error === 403; }
          if (!denied) throw new Error("Account authority bypassed a revoked webkey");
        }
        await globalDb.collections.apiTokens.updateAsync(share.id, { $set: { revoked: false } });
        const origin = new URL(process.env.ROOT_URL).protocol + "//" + globalDb.makeWildcardHost("ui-" + session.hostId);
        return { url: origin + "/_sandstorm-init?sessionid=" + session._id + "&path=%2F" };
      }
      if (operation === "open" || operation === "shared") {
        if (record) throw new Meteor.Error(409, "Close test session first");
        record = { accountId: this.userId, grainId };
        rustGrainTestSessions.set(key, record);
        if (operation === "shared") {
          record.recipient = "rust-session-recipient-" + Random.id();
          await Meteor.users.insertAsync({ _id: record.recipient, type: "account", loginCredentials: [],
            nonloginCredentials: [], profile: { name: "Rust session recipient", handle: "recipient", pronoun: "neutral" } });
          // A stranger cannot obtain a UI session just by knowing a grain ID.
          let rejected = false;
          try { await createRustGrainSession(globalDb, record.recipient, grainId, process.env.ROOT_URL); }
          catch (error) { rejected = error.error === 403; }
          if (!rejected) throw new Error("Unauthorized UI session was accepted");
          const share = await SandstormPermissions.createNewApiToken(globalDb, { accountId: this.userId },
              grainId, "Rust grain session test", { allAccess: null },
              { user: { accountId: record.recipient, title: "Shared test grain" } });
          record.tokenId = share.id;
          record.accountId = record.recipient;
        }
        const session = await createRustGrainSession(globalDb, record.accountId, grainId, process.env.ROOT_URL);
        if (!session.rustShellSession || session.rustShellLeaseExpires <= Date.now() ||
            session.parentOrigin !== process.env.ROOT_URL) throw new Error("Missing lease or parent-origin contract");
        record.sessionId = session._id;
        const context = await rustGrainPowerboxContext(globalDb, record.accountId, session._id);
        if (context.grainId !== grainId) throw new Error("Wrong Powerbox grain context");
        for (const accountId of [null, "other-account"]) {
          let denied = false;
          try { await rustGrainPowerboxContext(globalDb, accountId, session._id); }
          catch (error) { denied = error.error === 403; }
          if (!denied) throw new Error("Foreign Powerbox context was accepted");
        }
        await globalDb.collections.sessions.updateAsync(session._id, { $set: { rustShellLeaseExpires: 0 } });
        let expired = false;
        try { await rustGrainPowerboxContext(globalDb, record.accountId, session._id); }
        catch (error) { expired = error.error === 403; }
        if (!expired) throw new Error("Expired Powerbox context was accepted");
        await keepRustGrainSession(globalDb, record);
        const origin = new URL(process.env.ROOT_URL).protocol + "//" + globalDb.makeWildcardHost("ui-" + session.hostId);
        return { url: origin + "/_sandstorm-init?sessionid=" + session._id + "&path=%2F" };
      }
      if (!record) throw new Meteor.Error(404, "No test session");
      if (operation === "backup") {
        for (const accountId of [null, "other-account"]) {
          let denied = false;
          try { await createNativeGrainBackup(accountId, grainId, async () => {}); }
          catch (error) { denied = error.error === 403; }
          if (!denied) throw new Error("Non-owner backup accepted");
        }
        const before = await globalDb.collections.fileTokens.find({}).countAsync();
        let checks = 0, canceled = false;
        try {
          await createNativeGrainBackup(this.userId, grainId, async () => {
            if (++checks === 2) throw new Error("Backup login revoked");
          });
        } catch (error) { canceled = error.message === "Backup login revoked"; }
        if (!canceled || checks !== 2 || await globalDb.collections.fileTokens.find({}).countAsync() !== before) {
          throw new Error("Canceled backup retained its download token");
        }
        const {id} = await createNativeGrainBackup(this.userId, grainId, async () => {});
        let foreignDenied = false;
        try { await nativeBackupDownload("other-account", id, false, async () => {}); }
        catch (error) { foreignDenied = error.error === 404; }
        const legacy = await fetch(new URL("/downloadBackup/" + id, process.env.ROOT_URL));
        const upload = await fetch(new URL("/uploadBackup/" + id, process.env.ROOT_URL), {method:"POST",body:"overwrite"});
        let restoreDenied = false;
        try { await restoreGrainBackup(id, {_id:"other-account"}); }
        catch (error) { restoreDenied = error.error === 403; }
        if (upload.status !== 403 || !restoreDenied) throw new Error("Native backup escaped account scope through a legacy operation");
        const file = await openFile("/var/sandstorm/backups/" + id, "r");
        try {
          await nativeBackupDownload(this.userId, id, false, async () => {});
          await nativeBackupDownload(this.userId, id, true, async () => {});
          const bytes = Buffer.alloc(2);
          await file.read(bytes, 0, 2, 0);
          return {zip:bytes[0]===80 && bytes[1]===75,foreignDenied,legacyStatus:legacy.status};
        } finally { await file.close(); }

      }
      if (operation === "restart") {
        for (const accountId of [null, "other-account"]) {
          let denied = false;
          try { await restartGrainForUser(accountId, grainId); }
          catch (error) { denied = error.error === 403; }
          if (!denied) throw new Error("Non-owner restart accepted");
        }
        let guarded = false;
        try { await restartGrainForUser(this.userId, grainId, async () => { throw new Error("Canceled restart"); }); }
        catch (error) { guarded = error.message === "Canceled restart"; }
        if (!guarded) throw new Error("Restart bypassed authority guard");
        await restartGrainForUser(this.userId, grainId);
        await keepRustGrainSession(globalDb, record);
        return true;
      }

      if (operation === "template") {
        const discovery = { resources: { "/status.php": { type: "text/json", language: "en",
          body: JSON.stringify({ installed: true, maintenance: false, version: "9.1.0.14", versionstring: "9.1.0 RC4", edition: "" }) } },
          options: { dav: ["1", "2", "3", "mkcol-extended"] } };
        const result = await createRustTemplateToken(globalDb, record,
            { petname: "Rust template test", roleAssignment: { allAccess: null }, forSharing: false, unauthenticated: discovery });
        try {
          const row = await globalDb.collections.apiTokens.findOneAsync(result.id);
          if (!result.token || !result.host || row.grainId !== grainId ||
              row.accountId !== record.accountId || !row.expiresIfUnused ||
              row.expiresIfUnused <= new Date() || row.expiresIfUnused > new Date(Date.now() + 300000)) {
            throw new Error("Invalid template token authority or expiry");
          }
          const response = await fetch(new URL(process.env.ROOT_URL).protocol + "//" + result.host,
              { method: "POST", headers: { Authorization: "Bearer " + result.token,
                "X-Sandstorm-Token-Keepalive": "300000" } });
          if (response.status !== 200) throw new Error("Template token keepalive failed: " + response.status);
          const base = new URL(process.env.ROOT_URL).protocol + "//" + result.host;
          const status = await fetch(base + "/status.php");
          if (status.status !== 200 || !(await status.json()).installed) throw new Error("Davros public discovery failed");
          const options = await fetch(base, { method: "OPTIONS" });
          if (!options.ok || !options.headers.get("dav")?.includes("mkcol-extended")) throw new Error("Davros DAV options missing");
          const privatePath = await fetch(base + "/not-public");
          if (privatePath.status < 400) throw new Error("Unlisted path became public");
          let rejected = false;
          try { await createRustTemplateToken(globalDb, record, { petname: "invalid", roleAssignment: { allAccess: null },
            forSharing: false, unauthenticated: { resources: { "/bad": { type: "text/plain\r\nBad: header", body: "bad" } } } }); }
          catch { rejected = true; }
          if (!rejected) throw new Error("Invalid discovery metadata was accepted");
          return true;
        } finally { await globalDb.removeApiTokens({ _id: result.id }); }
      }
      if (operation === "enablePowerbox") {
        record.previousRustOrigin = Meteor.settings.public.rustShellOrigin;
        record.powerboxTest = true;
        Meteor.settings.public.rustShellOrigin = new URL(process.env.ROOT_URL).origin;
        return true;
      }
      if (operation === "keep") { await keepRustGrainSession(globalDb, record); return true; }
      if (operation === "revoke") {
        await globalDb.collections.apiTokens.updateAsync(record.tokenId, { $set: { revoked: true } });
        let rejected = false;
        try { await keepRustGrainSession(globalDb, record); }
        catch (error) { rejected = error.error === 403; }
        if (!rejected) throw new Error("Revoked UI session renewed");
        let denied = false;
        try { await rustGrainPowerboxContext(globalDb, record.accountId, record.sessionId); }
        catch (error) { denied = error.error === 403; }
        if (!denied) throw new Error("Revoked Powerbox context was accepted");
        denied = false;
        try { await createRustTemplateToken(globalDb, record, { petname: "revoked", roleAssignment: { allAccess: null }, forSharing: false }); }
        catch (error) { denied = error.error === 403; }
        if (!denied) throw new Error("Revoked template request was accepted");
        await closeRustGrainSession(globalDb, record);
        return true;
      }
      if (operation === "close") {
        if (record.hashedToken) await closeRustSharedGrainSession(globalDb, record);
        else await closeRustGrainSession(globalDb, record);
        if (await globalDb.collections.sessions.findOneAsync(record.sessionId)) throw new Error("UI session leaked");
        if (record.tokenId) await globalDb.removeApiTokens({ _id: record.tokenId });
        if (record.recipient) await Meteor.users.removeAsync(record.recipient);
        if (record.powerboxTest) Meteor.settings.public.rustShellOrigin = record.previousRustOrigin;
        rustGrainTestSessions.delete(key);
        return true;
      }
      throw new Meteor.Error(400, "Unknown test operation");
    },

    testRegressionRustShellPersistence: async function () {
      const userId = "test-rust-persistence-" + Random.id();
      const loginHash = "test-hash-" + Random.id();
      const state = "a".repeat(64);
      const tokens = [];
      const restarted = () => createRustShellBridge({ sessionStore: rustShellSessionStore,
        authorize: authorizeRustShellAccount });
      try {
        await Meteor.users.insertAsync({ _id: userId, loginCredentials: [], profile: { name: "Restart test" },
          services: { resume: { loginTokens: [{ hashedToken: loginHash, when: new Date() }] } } });
        const link = async () => {
          const code = await rustShellBridge.issue(userId, loginHash, state);
          const value = await rustShellBridge.handle("exchange", { code, state });
          tokens.push(value.token);
          return value;
        };
        const linked = await link();
        const recovered = await restarted().handle("session", { token: linked.token });
        if (recovered.account.name !== "Restart test" || recovered.expires !== linked.expires) throw new Error("Login did not survive bridge recreation");
        await restarted().handle("logout", { token: linked.token });
        let denied = false;
        try { await restarted().handle("session", { token: linked.token }); }
        catch (error) { denied = error.status === 401; }
        if (!denied) throw new Error("Logout was not durable");
        const revoked = await link();
        await Meteor.users.updateAsync(userId, { $set: { "services.resume.loginTokens": [] } });
        denied = false;
        try { await restarted().handle("session", { token: revoked.token }); }
        catch (error) { denied = error.status === 401; }
        if (!denied) throw new Error("Source logout did not revoke persisted login");
        return true;
      } finally {
        for (const token of tokens) await rustShellBridge.handle("logout", { token });
        await Meteor.users.removeAsync(userId);
      }
    },

    testRegressionRustShellObservation: async function () {
      const userId = "test-rust-watch-" + Random.id();
      const grainId = "test-rust-grain-" + Random.id();
      const notificationId = "test-rust-notification-" + Random.id();
      const senderId = "test-rust-sender-" + Random.id();
      const sharedGrainId = "test-rust-shared-" + Random.id();
      const tokenId = "test-rust-token-" + Random.id();
      const duplicateTokenId = "test-rust-duplicate-" + Random.id();
      const selfTokenId = "test-rust-self-" + Random.id();
      const extraGrainIds = Array.from({ length: 50 }, () => "test-rust-limit-" + Random.id());
      const packageId = "test-rust-package-" + Random.id();
      const loginHash = Crypto.randomBytes(32).toString("hex");
      const state = Crypto.randomBytes(32).toString("hex");
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), 10000);
      let token;
      const call = (action, input = {}) => rustShellBridge.handle(action, { token, ...input }, controller.signal);
      const require = (condition, message) => {
        if (!condition) throw new Meteor.Error("rust-observation-regression", message);
      };
      try {
        await Meteor.users.insertAsync({ _id: userId, loginCredentials: [], profile: { name: "Observer test" },
          services: { resume: { loginTokens: [{ hashedToken: loginHash, when: new Date() }] } } });
        await globalDb.collections.packages.insertAsync({ _id: packageId,
          manifest: { appTitle: { defaultText: "Test editor" }, actions: [] } });
        await globalDb.collections.grains.insertAsync({ _id: grainId, userId, packageId, title: "Before rename" });
        const code = await rustShellBridge.issue(userId, loginHash, state);
        ({ token } = await rustShellBridge.handle("exchange", { code, state }));
        let view = await call("snapshot");
        require(view.total === 0, "New account must have an empty projection");
        require(view.grains.length === 1 && view.grains[0].key === grainId && view.grains[0].owned,
            "Grain menu must show the owned grain");
        require(view.grains[0].appTitle === "Test editor", "Owned app name must come from the package");
        const observeWrite = async (write) => {
          const pending = call("watch", { after: view.version });
          // Attach a rejection handler immediately, including if the DB write fails.
          pending.catch(() => {});
          await write();
          view = await pending;
        };
        await observeWrite(() => globalDb.collections.notifications.insertAsync({
          _id: notificationId, userId, grainId, text: { defaultText: "changed a document" },
          timestamp: new Date(), isUnread: true,
        }));
        require(view.total === 1 && view.entries[0].title === "Before rename", "Legacy insert must wake observation");
        await observeWrite(() => globalDb.collections.grains.updateAsync(grainId, { $set: { title: "After rename" } }));
        require(view.entries[0].title === "After rename", "Grain title changes must invalidate the projection");
        require(view.grains[0].title === "After rename", "Grain menu must receive title changes");
        await observeWrite(() => globalDb.collections.grains.updateAsync(grainId, { $set: { trashed: new Date() } }));
        require(view.grains.length === 0, "Trashed owned grain must disappear from the menu");
        await observeWrite(() => globalDb.collections.grains.updateAsync(grainId, { $unset: { trashed: 1 } }));
        require(view.grains.length === 1, "Restored grain must reappear");
        await observeWrite(() => globalDb.collections.grains.rawCollection().insertMany(extraGrainIds.map((_id) => ({
          _id, userId, title: "Extra grain", lastUsed: new Date(),
        }))));
        require(view.grains.length === 50 && view.grainsLimited, "Large accounts must have a bounded preview");
        await observeWrite(() => globalDb.collections.grains.removeAsync({ _id: { $in: extraGrainIds } }));
        require(view.grains.length === 1 && !view.grainsLimited, "Removing excess grains must clear the limit indicator");
        await observeWrite(() => globalDb.collections.packages.updateAsync(packageId,
            { $set: { "manifest.appTitle.defaultText": "Renamed editor" } }));
        require(view.grains[0].appTitle === "Renamed editor", "Package changes must wake the menu projection");
        await observeWrite(() => call("read"));
        require(!view.entries[0].unread, "Mark-read must update the observed record");
        await observeWrite(() => call("dismiss", { id: notificationId }));
        require(view.total === 0, "Dismiss must remove the shared record");
        await Meteor.users.insertAsync({ _id: senderId, profile: { name: "Sender name", picture: "sender-avatar" } });
        await globalDb.collections.grains.insertAsync({ _id: sharedGrainId, userId: senderId, title: "Private owner title" });
        // Another recipient's token must not reveal its title to this account.
        await globalDb.collections.apiTokens.insertAsync({ _id: tokenId, grainId: sharedGrainId, created: new Date(),
          owner: { user: { accountId: senderId, title: "Other recipient title", denormalizedGrainMetadata: {} } } });
        await observeWrite(() => globalDb.collections.notifications.insertAsync({
          _id: notificationId, userId, grainId: sharedGrainId, initiatingAccount: senderId,
          text: { defaultText: "edited a page" }, timestamp: new Date(), isUnread: true,
        }));
        require(view.entries[0].title === "Grain activity", "Must not expose another owner's grain or token title");
        require(!view.grains.some((grain) => grain.key === sharedGrainId), "Another recipient's grain must not appear");
        require(view.entries[0].senderName === "Sender name", "Referenced sender name must be projected");
        require(view.entries[0].senderPictureUrl.endsWith('/sender-avatar'),"Referenced sender avatar missing");
        await observeWrite(() => globalDb.collections.apiTokens.updateAsync(tokenId,
            { $set: { "owner.user.accountId": userId, "owner.user.title": "Saved title", "owner.user.upstreamTitle": "Shared title", "owner.user.denormalizedGrainMetadata.appTitle": { defaultText: "Shared spreadsheet" } } }));
        require(view.entries[0].title === "Shared title", "Shared grain must use the recipient's upstream title");
        require(view.grains.some((grain) => grain.key === sharedGrainId && !grain.owned && grain.title === "Shared title"),
            "Shared grain must use recipient metadata");
        require(view.grains.find((grain) => grain.key === sharedGrainId).appTitle === "Shared spreadsheet",
            "Shared app name must come from recipient metadata");
        await globalDb.collections.apiTokens.insertAsync({ _id: duplicateTokenId, grainId: sharedGrainId,
          created: new Date(Date.now() + 1000), owner: { user: { accountId: userId, title: "Later token title", denormalizedGrainMetadata: {} } } });
        await globalDb.collections.apiTokens.insertAsync({ _id: selfTokenId, grainId,
          created: new Date(), owner: { user: { accountId: userId, title: "Self share", denormalizedGrainMetadata: {} } } });
        view = await call("snapshot");
        require(view.grains.length === 2 && view.grains.find((grain) => grain.key === sharedGrainId).title === "Shared title",
            "Duplicate and self shares must not duplicate menu entries or override the oldest title");
        await globalDb.collections.apiTokens.removeAsync({ _id: duplicateTokenId });
        view = await call("snapshot");
        await observeWrite(() => globalDb.collections.apiTokens.updateAsync(tokenId, { $set: { trashed: new Date() } }));
        require(view.grains.length === 1, "Trashed share must disappear");
        await observeWrite(() => globalDb.collections.apiTokens.updateAsync(tokenId, { $unset: { trashed: 1 } }));
        require(view.grains.length === 2, "Restored share must reappear");
        await observeWrite(() => globalDb.collections.apiTokens.updateAsync(tokenId,
            { $set: { "owner.user.renamed": true, "owner.user.title": "My title" } }));
        require(view.entries[0].title === "My title", "Recipient rename must take precedence");
        await observeWrite(() => Meteor.users.updateAsync(senderId, { $set: { "profile.name": "Renamed sender" } }));
        require(view.entries[0].senderName === "Renamed sender", "Sender rename must wake observation");
        await observeWrite(() => Meteor.users.updateAsync(senderId,{$set:{'profile.picture':'updated-avatar'}}));
        require(view.entries[0].senderPictureUrl.endsWith('/updated-avatar'),"Sender picture update must wake observation");
        await observeWrite(() => globalDb.collections.apiTokens.updateAsync(tokenId, { $set: { revoked: true } }));
        require(view.entries[0].title === "Grain activity", "Revoked recipient metadata must disappear");
        require(!view.grains.some((grain) => grain.key === sharedGrainId), "Revoked share must disappear from the menu");
        await observeWrite(() => globalDb.collections.notifications.updateAsync(notificationId,
            { $unset: { initiatingAccount: 1 }, $set: { initiatorAnonymous: true } }));
        require(view.entries[0].senderName === "Anonymous user", "Anonymous activity must have a clear sender label");
        require(view.entries[0].senderPictureUrl === '',"Anonymous notification exposed a sender picture");
        const pending = call("watch", { after: view.version }).then(
            () => { throw new Meteor.Error("rust-observation-regression", "Revoked watch returned data"); },
            (error) => { require(error.status === 401, "Revoked watch must be unauthorized"); });
        pending.catch(() => {});
        await Meteor.users.updateAsync(userId, { $set: { "services.resume.loginTokens": [] } });
        await pending;
        return true;
      } finally {
        clearTimeout(deadline);
        controller.abort();
        if (token) await call("logout");
        await globalDb.collections.notifications.removeAsync({ userId });
        await globalDb.collections.apiTokens.removeAsync({ _id: { $in: [tokenId, duplicateTokenId, selfTokenId] } });
        await globalDb.collections.grains.removeAsync({ _id: { $in: [grainId, sharedGrainId, ...extraGrainIds] } });
        await globalDb.collections.packages.removeAsync({ _id: packageId });
        await Meteor.users.removeAsync({ _id: senderId });
        await Meteor.users.removeAsync({ _id: userId });
      }
    },

    testRegressionNotifications: async function () {
      const userId = "test-notification-user-" + Random.id();
      const otherUserId = "test-notification-other-" + Random.id();
      const initiatingUserId = "test-notification-initiator-" + Random.id();
      const normalNotificationId = "test-notification-normal-" + Random.id();
      const appUpdateNotificationId = "test-notification-app-update-" + Random.id();
      const otherNotificationId = "test-notification-other-doc-" + Random.id();
      const scopedNotificationId = "test-notification-scoped-" + Random.id();
      const appCleanupCalls = [];
      const originalDeleteUnusedPackages = globalDb.deleteUnusedPackages;
      const callDismiss = async (callerId, notificationId) => {
        return await getMethodHandler("dismissNotification").apply({
          userId: callerId,
          connection: {
            sandstormDb: globalDb,
            sandstormBackend: globalThis.globalBackend,
          },
        }, [notificationId]);
      };
      const callReadAll = async (callerId) => {
        return await getMethodHandler("readAllNotifications").apply({
          userId: callerId,
          connection: {
            sandstormDb: globalDb,
            sandstormBackend: globalThis.globalBackend,
          },
        }, []);
      };

      await Meteor.users.insertAsync({
        _id: userId,
        type: "account",
        signupKey: "admin",
        loginCredentials: [],
        nonloginCredentials: [],
        profile: { name: "Notification user" },
      });
      await Meteor.users.insertAsync({
        _id: otherUserId,
        type: "account",
        signupKey: "admin",
        loginCredentials: [],
        nonloginCredentials: [],
        profile: { name: "Notification other user" },
      });
      await Meteor.users.insertAsync({
        _id: initiatingUserId,
        type: "account",
        signupKey: "admin",
        loginCredentials: [],
        nonloginCredentials: [],
        profile: { name: "Notification initiating user" },
      });
      await globalDb.collections.notifications.insertAsync({
        _id: normalNotificationId,
        userId,
        timestamp: new Date(),
        isUnread: true,
        referral: true,
      });
      await globalDb.collections.notifications.insertAsync({
        _id: appUpdateNotificationId,
        userId,
        timestamp: new Date(),
        isUnread: true,
        appUpdates: {
          "test-app-a": { packageId: "package-a" },
          "test-app-b": { packageId: "package-b" },
        },
      });
      await globalDb.collections.notifications.insertAsync({
        _id: otherNotificationId,
        userId: otherUserId,
        timestamp: new Date(),
        isUnread: true,
        referral: true,
      });
      await globalDb.collections.notifications.insertAsync({
        _id: scopedNotificationId,
        userId,
        timestamp: new Date(),
        isUnread: true,
        grainId: "testNotificationGrain" + Random.id().replace(/[^a-zA-Z0-9]/g, ""),
        initiatingAccount: initiatingUserId,
      });

      globalDb.deleteUnusedPackages = async function (appId) {
        appCleanupCalls.push(appId);
      };

      try {
        try {
          await callDismiss(userId, otherNotificationId);
          throw new Meteor.Error("notification-non-owner-dismissed",
              "dismissNotification allowed a non-owner to dismiss a notification.");
        } catch (err) {
          if (err.error !== 403) throw err;
        }

        await callReadAll(userId);
        const normalAfterRead = await globalDb.collections.notifications.findOneAsync(normalNotificationId);
        const appUpdateAfterRead =
            await globalDb.collections.notifications.findOneAsync(appUpdateNotificationId);
        const otherAfterRead = await globalDb.collections.notifications.findOneAsync(otherNotificationId);
        if (normalAfterRead.isUnread ||
            appUpdateAfterRead.isUnread ||
            otherAfterRead.isUnread !== true) {
          throw new Meteor.Error("notification-read-all-scope",
              "readAllNotifications did not mark only current-user notifications as read.");
        }

        await callDismiss(userId, normalNotificationId);
        if (await globalDb.collections.notifications.findOneAsync(normalNotificationId)) {
          throw new Meteor.Error("notification-not-dismissed",
              "dismissNotification did not remove an owned notification.");
        }

        await callDismiss(userId, appUpdateNotificationId);
        await new Promise((resolve) => Meteor.setTimeout(resolve, 25));
        if (!appCleanupCalls.includes("test-app-a") || !appCleanupCalls.includes("test-app-b")) {
          throw new Meteor.Error("notification-app-update-cleanup",
              "dismissNotification did not trigger app-update package cleanup.");
        }

        const sub = makeFakeSubscription(userId);
        const cursors = await getPublishHandler("notificationGrains").apply(sub, [
          [scopedNotificationId, otherNotificationId],
        ]);
        if (!Array.isArray(cursors) || cursors.length !== 1) {
          throw new Meteor.Error("notification-grains-cursor",
              "notificationGrains did not return expected cursor list.");
        }

        const accounts = await cursors[0].fetchAsync();
        if (accounts.length !== 1 || accounts[0]._id !== initiatingUserId) {
          throw new Meteor.Error("notification-grains-scope",
              "notificationGrains did not return only accounts referenced by requesting user's notifications.");
        }

        return true;
      } finally {
        globalDb.deleteUnusedPackages = originalDeleteUnusedPackages;
        await globalDb.collections.notifications.removeAsync({
          _id: {
            $in: [
              normalNotificationId,
              appUpdateNotificationId,
              otherNotificationId,
              scopedNotificationId,
            ],
          },
        });
        await Meteor.users.removeAsync({ _id: { $in: [userId, otherUserId, initiatingUserId] } });
      }
    },

    testRegressionAdminMethods: async function () {
      const adminId = "test-admin-account-" + Random.id();
      const targetUserId = "test-admin-target-" + Random.id();
      const credentialId = "test-admin-credential-" + Random.id();
      const activityStatId = "test-admin-activity-" + Random.id();
      const apiTokenId = "test-admin-api-token-" + Random.id();
      const inviteEmail = "admin-quota-invite-" + Random.id() + "@example.com";
      const sentInviteEmail1 = "admin-invite-one-" + Random.id() + "@example.com";
      const sentInviteEmail2 = "admin-invite-two-" + Random.id() + "@example.com";
      const userEmail = "admin-quota-user-" + Random.id() + "@example.com";
      const sentAdminEmails = [];
      const settingIds = [
        "github",
        "oidc",
        "smtpConfig",
        "testAdminSetting",
        "organizationMembership",
        "organizationSettings",
        "tlsKeys",
      ];
      const originalTlsCallback = globalThis.currentTlsKeysCallback;

      const adminContext = {
        userId: adminId,
        connection: {
          sandstormDb: globalDb,
          sandstormBackend: globalThis.globalBackend,
        },
        unblock() {},
      };
      const callAdminMethod = async (name, args) => {
        return await getMethodHandler(name).apply(adminContext, args);
      };

      await globalDb.collections.settings.removeAsync({ _id: { $in: settingIds } });
      await ServiceConfiguration.configurations.removeAsync({ service: { $in: ["github", "oidc"] } });
      setAdminEmailSenderForTests(async function (message) {
        await new Promise((resolve) => Meteor.setTimeout(resolve, 5));
        sentAdminEmails.push(message);
      });

      await Meteor.users.insertAsync({
        _id: adminId,
        type: "account",
        isAdmin: true,
        loginCredentials: [],
        nonloginCredentials: [],
        services: { resume: { loginTokens: [{ token: adminId + "-token" }] } },
        profile: { name: "Admin method test admin" },
      });

      await Meteor.users.insertAsync({
        _id: targetUserId,
        type: "account",
        signupEmail: userEmail,
        loginCredentials: [{ id: credentialId }],
        nonloginCredentials: [],
        services: { resume: { loginTokens: [{ token: targetUserId + "-token" }] } },
        profile: { name: "Admin method test target" },
      });

      await Meteor.users.insertAsync({
        _id: credentialId,
        type: "credential",
        services: {
          github: { id: "github-user-id" },
          resume: { loginTokens: [{ token: credentialId + "-token" }] },
        },
        profile: { name: "Admin method test credential" },
      });

      await globalDb.collections.signupKeys.insertAsync({
        _id: "test-admin-quota-key-" + Random.id(),
        used: false,
        email: inviteEmail,
        note: "Admin quota invite",
      });

      await globalDb.collections.activityStats.insertAsync({
        _id: activityStatId,
        timestamp: new Date(),
        activeUsers: 1,
      });

      await globalDb.collections.apiTokens.insertAsync({
        _id: apiTokenId,
        frontendRef: { ipNetwork: "127.0.0.0/8" },
        owner: { user: { accountId: adminId } },
        created: new Date(),
        requirements: [],
        revoked: false,
      });

      try {
        try {
          await callAdminMethod("setAccountSetting", [null, "github", true]);
          throw new Meteor.Error("admin-github-enabled-without-config",
              "setAccountSetting enabled github without configuration.");
        } catch (err) {
          if (err.error !== 403 || !/configure the github service/i.test(err.message || "")) throw err;
        }

        await ServiceConfiguration.configurations.insertAsync({
          service: "github",
          clientId: "github-client",
          secret: "github-secret",
        });
        await callAdminMethod("setAccountSetting", [null, "github", true]);
        let setting = await globalDb.collections.settings.findOneAsync("github");
        if (!setting || setting.value !== true) {
          throw new Meteor.Error("admin-github-not-enabled", "setAccountSetting did not enable github.");
        }

        await ServiceConfiguration.configurations.insertAsync({
          service: "oidc",
          clientId: "oidc-client",
          secret: "oidc-secret",
        });
        try {
          await callAdminMethod("setAccountSetting", [null, "oidc", true]);
          throw new Meteor.Error("admin-oidc-enabled-without-server",
              "setAccountSetting enabled incomplete OIDC configuration.");
        } catch (err) {
          if (err.error !== 403 || !/full set of server parameters/i.test(err.message || "")) throw err;
        }

        await callAdminMethod("setSetting", [null, "testAdminSetting", "set-value"]);
        setting = await globalDb.collections.settings.findOneAsync("testAdminSetting");
        if (!setting || setting.value !== "set-value") {
          throw new Meteor.Error("admin-setting-not-saved", "setSetting did not persist value.");
        }

        const smtpConfig = {
          hostname: "smtp.example",
          port: 587,
          auth: { user: "smtp-user", pass: "smtp-pass" },
          returnAddress: "no-reply@example.com",
        };
        await callAdminMethod("setSmtpConfig", [null, smtpConfig]);
        setting = await globalDb.collections.settings.findOneAsync("smtpConfig");
        if (!setting || setting.value.hostname !== "smtp.example" || setting.value.port !== 587) {
          throw new Meteor.Error("admin-smtp-not-saved", "setSmtpConfig did not persist config.");
        }

        await callAdminMethod("disableEmail", [null]);
        setting = await globalDb.collections.settings.findOneAsync("smtpConfig");
        if (!setting || setting.value.hostname !== "") {
          throw new Meteor.Error("admin-email-not-disabled", "disableEmail did not clear SMTP hostname.");
        }

        const organizationParams = {
          membership: {
            emailToken: { enabled: true, domain: "example.com" },
            google: { enabled: false, domain: "" },
            ldap: { enabled: false },
            oidc: { enabled: true },
            saml: { enabled: false },
          },
          settings: {
            disallowGuests: true,
            shareContacts: false,
          },
        };
        await callAdminMethod("saveOrganizationSettings", [null, organizationParams]);
        const membership = await globalDb.collections.settings.findOneAsync("organizationMembership");
        const orgSettings = await globalDb.collections.settings.findOneAsync("organizationSettings");
        if (!membership || membership.value.oidc.enabled !== true ||
            !orgSettings || orgSettings.value.disallowGuests !== true) {
          throw new Meteor.Error("admin-org-settings-not-saved",
              "saveOrganizationSettings did not persist membership/settings.");
        }

        await callAdminMethod("clearResumeTokensForService", [null, "github"]);
        let account = await Meteor.users.findOneAsync(targetUserId);
        let credential = await Meteor.users.findOneAsync(credentialId);
        if (account.services.resume.loginTokens.length !== 0 ||
            credential.services.resume.loginTokens.length !== 0) {
          throw new Meteor.Error("admin-resume-tokens-not-cleared",
              "clearResumeTokensForService did not clear account and credential tokens.");
        }

        await callAdminMethod("updateQuotas", [null, inviteEmail + "\n" + userEmail, 1234]);
        const invite = await globalDb.collections.signupKeys.findOneAsync({ email: inviteEmail });
        account = await Meteor.users.findOneAsync(targetUserId);
        if (!invite || invite.quota !== 1234 || account.quota !== 1234) {
          throw new Meteor.Error("admin-quotas-not-updated",
              "updateQuotas did not update invite and user quotas.");
        }

        try {
          await callAdminMethod("updateQuotas", [null, "missing-" + Random.id() + "@example.com", 1234]);
          throw new Meteor.Error("admin-missing-quota-address-accepted",
              "updateQuotas accepted an address with no invite/user.");
        } catch (err) {
          if (err.error !== 404) throw err;
        }

        await callAdminMethod("sendInvites", [
          null,
          "https://sandstorm.example",
          { name: "Admin Sender", address: "admin@example.com" },
          sentInviteEmail1 + "\n\n" + sentInviteEmail2,
          "Join this Sandstorm",
          "Click $KEY to join.",
          4321,
        ]);
        if (sentAdminEmails.length !== 2) {
          throw new Meteor.Error("admin-invites-not-sent",
              "sendInvites did not send one message per non-empty address.");
        }

        for (const inviteEmailAddress of [sentInviteEmail1, sentInviteEmail2]) {
          const signupKey = await globalDb.collections.signupKeys.findOneAsync({
            email: inviteEmailAddress,
          });
          const sentEmail = sentAdminEmails.find((email) => email.to === inviteEmailAddress);
          if (!signupKey || signupKey.used !== false || signupKey.definitelySent !== true ||
              signupKey.quota !== 4321 || signupKey.note !== "E-mail invite to " + inviteEmailAddress) {
            throw new Meteor.Error("admin-invite-key-not-created",
                "sendInvites did not create expected signup key for " + inviteEmailAddress);
          }

          if (!sentEmail ||
              sentEmail.from.name !== "Admin Sender" ||
              sentEmail.from.address !== "admin@example.com" ||
              sentEmail.envelopeFrom !== "no-reply@example.com" ||
              sentEmail.subject !== "Join this Sandstorm" ||
              !sentEmail.text.includes("https://sandstorm.example/signup/" + signupKey._id)) {
            throw new Meteor.Error("admin-invite-email-content",
                "sendInvites did not send expected email for " + inviteEmailAddress);
          }
        }

        let tlsCallbackCalled = false;
        globalThis.currentTlsKeysCallback = {
          async setKeys(key, certChain) {
            tlsCallbackCalled = true;
            if (key !== "test-key" || certChain !== "test-cert") {
              throw new Meteor.Error("admin-tls-callback-values",
                  "setTlsKeys passed unexpected values to currentTlsKeysCallback.");
            }
          },
        };
        await callAdminMethod("setTlsKeys", [null, { key: "test-key", certChain: "test-cert" }]);
        setting = await globalDb.collections.settings.findOneAsync("tlsKeys");
        if (!tlsCallbackCalled || !setting ||
            setting.value.key !== "test-key" || setting.value.certChain !== "test-cert") {
          throw new Meteor.Error("admin-tls-not-saved",
              "setTlsKeys did not validate and persist TLS keys.");
        }

        globalThis.currentTlsKeysCallback = {
          async setKeys() {
            throw new Meteor.Error("synthetic-tls-failure", "Synthetic TLS validation failure.");
          },
        };
        try {
          await callAdminMethod("setTlsKeys", [null, { key: "bad-key", certChain: "bad-cert" }]);
          throw new Meteor.Error("admin-tls-failure-accepted",
              "setTlsKeys saved keys after callback failure.");
        } catch (err) {
          if (err.error !== "synthetic-tls-failure") throw err;
        }

        setting = await globalDb.collections.settings.findOneAsync("tlsKeys");
        if (setting.value.key !== "test-key" || setting.value.certChain !== "test-cert") {
          throw new Meteor.Error("admin-tls-failure-saved",
              "setTlsKeys changed persisted keys after callback failure.");
        }

        const expectUnauthorizedPublicationDenied = async (name, args) => {
          const result = await getPublishHandler(name).apply(makeFakeSubscription(null), args || []);
          if (Array.isArray(result) && result.length === 0) return;
          throw new Meteor.Error("admin-publication-unauthorized",
              name + " returned data for an unauthorized caller.");
        };
        const expectAdminCursorIncludes = async (name, args, expectedId) => {
          const result = await getPublishHandler(name).apply(makeFakeSubscription(adminId), args || []);
          if (!result || typeof result.fetchAsync !== "function") {
            throw new Meteor.Error("admin-publication-no-cursor",
                name + " did not return a cursor for an admin.");
          }

          const docs = await result.fetchAsync();
          if (!docs.some((doc) => doc._id === expectedId)) {
            throw new Meteor.Error("admin-publication-missing-doc",
                name + " did not include expected doc " + expectedId + ".");
          }
        };

        await expectUnauthorizedPublicationDenied("admin", [null]);
        await expectAdminCursorIncludes("admin", [null], "github");
        const adminSettings = await getPublishHandler("admin").apply(makeFakeSubscription(adminId), [null])
            .then((cursor) => cursor.fetchAsync());
        if (adminSettings.some((doc) => doc._id === "tlsKeys")) {
          throw new Meteor.Error("admin-publication-leaked-tls", "admin publication exposed TLS keys.");
        }

        await expectUnauthorizedPublicationDenied("allUsers", [null]);
        await expectAdminCursorIncludes("allUsers", [null], targetUserId);

        await expectUnauthorizedPublicationDenied("activityStats", [null]);
        await expectAdminCursorIncludes("activityStats", [null], activityStatId);

        await expectUnauthorizedPublicationDenied("adminApiTokens", [null]);
        await expectAdminCursorIncludes("adminApiTokens", [null], apiTokenId);

        await expectUnauthorizedPublicationDenied("adminUserDetails", [targetUserId]);
        const userDetailsSub = makeFakeSubscription(adminId);
        await getPublishHandler("adminUserDetails").apply(userDetailsSub, [targetUserId]);
        await new Promise((resolve) => Meteor.setTimeout(resolve, 25));
        userDetailsSub.stop();
        if (!userDetailsSub.readyCalled ||
            !userDetailsSub.addedDocs.users ||
            !userDetailsSub.addedDocs.users[targetUserId]) {
          throw new Meteor.Error("admin-user-details-missing-account",
              "adminUserDetails did not publish the requested account for an admin.");
        }

        return true;
      } finally {
        setAdminEmailSenderForTests(null);
        globalThis.currentTlsKeysCallback = originalTlsCallback;
        await ServiceConfiguration.configurations.removeAsync({ service: { $in: ["github", "oidc"] } });
        await globalDb.collections.settings.removeAsync({ _id: { $in: settingIds } });
        await globalDb.collections.signupKeys.removeAsync({
          email: { $in: [inviteEmail, sentInviteEmail1, sentInviteEmail2] },
        });
        await globalDb.collections.activityStats.removeAsync(activityStatId);
        await globalDb.collections.apiTokens.removeAsync(apiTokenId);
        await Meteor.users.removeAsync({ _id: { $in: [adminId, targetUserId, credentialId] } });
      }
    },

    testRegressionPaymentMethods: async function () {
      const newUserId = "test-payments-new-" + Random.id();
      const existingUserId = "test-payments-existing-" + Random.id();
      const lastCardUserId = "test-payments-last-card-" + Random.id();
      const noSubscriptionUserId = "test-payments-no-subscription-" + Random.id();
      const cancelUserId = "test-payments-cancel-" + Random.id();
      const noPaymentsUserId = "test-payments-no-customer-" + Random.id();
      const cardErrorUserId = "test-payments-card-error-" + Random.id();
      const userIds = [
        newUserId,
        existingUserId,
        lastCardUserId,
        noSubscriptionUserId,
        cancelUserId,
        noPaymentsUserId,
        cardErrorUserId,
      ];
      const planOne = "testPlan" + Random.id();
      const planTwo = "testPlan" + Random.id();
      const hiddenPlan = "testHiddenPlan" + Random.id();
      const planIds = [planOne, planTwo, hiddenPlan];
      const customers = {};
      const customerCreates = [];
      const sourceCreates = [];
      const sourceDeletes = [];
      const customerUpdates = [];
      const subscriptionCreates = [];
      const subscriptionUpdates = [];
      let failNextSubscriptionCreate = false;
      let nextSubscriptionNumber = 1;

      const originalCustomersCreate = testStripe.customers.create;
      const originalCustomersCreateSource = testStripe.customers.createSource;
      const originalCustomersDeleteSource = testStripe.customers.deleteSource;
      const originalCustomersRetrieve = testStripe.customers.retrieve;
      const originalCustomersUpdate = testStripe.customers.update;
      const originalSubscriptionsCreate = testStripe.subscriptions.create;
      const originalSubscriptionsUpdate = testStripe.subscriptions.update;
      const originalFreePlan = await globalDb.collections.plans.findOneAsync("free");

      const clone = (value) => JSON.parse(JSON.stringify(value));
      const makeSource = (id, last4) => ({
        id,
        last4,
        brand: "Visa",
        exp_year: 2035,
        exp_month: 12,
      });
      const makeSubscription = (id, plan, options = {}) => ({
        id,
        plan: { id: plan },
        cancel_at_period_end: !!options.cancelAtPeriodEnd,
        current_period_end: options.currentPeriodEnd || 2000000000,
        items: { data: [{ id: "item_" + id, plan: { id: plan } }] },
      });
      const addUser = async (id, extraFields) => {
        await Meteor.users.insertAsync({
          _id: id,
          type: "account",
          signupKey: "admin",
          loginCredentials: [],
          nonloginCredentials: [],
          profile: { name: "Payments method test account" },
          plan: "free",
          ...extraFields,
        });
      };
      const contextFor = (userId) => ({
        userId,
        connection: { sandstormDb: globalDb },
      });
      const callPaymentMethod = async (name, userId, args) =>
        await paymentMethodsForTests[name].apply(contextFor(userId), args);
      const expectMeteorError = async (expectedCode, expectedMessage, callback) => {
        let error;
        try {
          await callback();
        } catch (err) {
          error = err;
        }

        if (!error ||
            String(error.error) !== String(expectedCode) ||
            !String(error.reason || error.message).includes(expectedMessage)) {
          throw new Meteor.Error("payments-unexpected-error",
              "Expected " + expectedCode + " (" + expectedMessage + "), got: " +
              (error && (error.stack || error.message || error)));
        }
      };

      await Promise.all(planIds.map((id) => globalDb.collections.plans.upsertAsync(id, {
        $set: {
          title: id,
          storage: 10 * 1024 * 1024,
          compute: 100,
          grains: 100,
          hidden: id === hiddenPlan,
        },
      })));
      if (!originalFreePlan) {
        await globalDb.collections.plans.insertAsync({
          _id: "free",
          title: "Free",
          storage: 10 * 1024 * 1024,
          compute: 100,
          grains: 100,
        });
      }

      await addUser(newUserId);
      await addUser(existingUserId, { payments: { id: "cus_existing" }, plan: planOne });
      await addUser(lastCardUserId, { payments: { id: "cus_last_card" }, plan: planOne });
      await addUser(noSubscriptionUserId, {
        payments: { id: "cus_no_subscription" },
        plan: planOne,
      });
      await addUser(cancelUserId, { payments: { id: "cus_cancel" }, plan: planOne });
      await addUser(noPaymentsUserId);
      await addUser(cardErrorUserId, {
        payments: { id: "cus_card_error" },
        plan: planOne,
      });

      customers.cus_existing = {
        id: "cus_existing",
        email: "existing@example.com",
        account_balance: -125,
        default_source: "card_existing_a",
        sources: {
          data: [
            makeSource("card_existing_a", "1111"),
            makeSource("card_existing_b", "2222"),
          ],
        },
        subscriptions: {
          data: [makeSubscription("sub_existing", "pro-beta", {
            cancelAtPeriodEnd: true,
            currentPeriodEnd: 1900000000,
          })],
        },
      };
      customers.cus_last_card = {
        id: "cus_last_card",
        sources: { data: [makeSource("card_last", "3333")] },
        subscriptions: { data: [makeSubscription("sub_last", planOne)] },
      };
      customers.cus_no_subscription = {
        id: "cus_no_subscription",
        sources: { data: [makeSource("card_no_subscription", "4444")] },
        subscriptions: { data: [] },
      };
      customers.cus_cancel = {
        id: "cus_cancel",
        sources: { data: [makeSource("card_cancel", "5555")] },
        subscriptions: {
          data: [makeSubscription("sub_cancel", planOne, { currentPeriodEnd: 1950000000 })],
        },
      };
      customers.cus_card_error = {
        id: "cus_card_error",
        sources: { data: [makeSource("card_error", "6666")] },
        subscriptions: { data: [] },
      };

      testStripe.customers.create = async function (options) {
        customerCreates.push(clone(options));
        const customer = {
          id: "cus_created",
          email: options.email,
          account_balance: 0,
          default_source: "card_created",
          sources: { data: [makeSource("card_created", "0001")] },
          subscriptions: { data: [] },
        };
        customers[customer.id] = customer;
        return clone(customer);
      };
      testStripe.customers.createSource = async function (customerId, options) {
        sourceCreates.push({ customerId, options: clone(options) });
        const source = makeSource("card_added_" + sourceCreates.length, "700" + sourceCreates.length);
        customers[customerId].sources.data.push(source);
        return clone(source);
      };
      testStripe.customers.retrieve = async function (customerId) {
        if (!customers[customerId]) {
          throw new Error("Unexpected Stripe customer: " + customerId);
        }

        return clone(customers[customerId]);
      };
      testStripe.customers.deleteSource = async function (customerId, sourceId) {
        sourceDeletes.push({ customerId, sourceId });
        customers[customerId].sources.data =
            customers[customerId].sources.data.filter((source) => source.id !== sourceId);
        return {};
      };
      testStripe.customers.update = async function (customerId, options) {
        customerUpdates.push({ customerId, options: clone(options) });
        if (options.default_source) {
          customers[customerId].default_source = options.default_source;
        }

        return clone(customers[customerId]);
      };
      testStripe.subscriptions.create = async function (options) {
        if (failNextSubscriptionCreate) {
          failNextSubscriptionCreate = false;
          const error = new Error("Your card was declined.");
          error.raw = { type: "card_error", message: "Your card was declined." };
          throw error;
        }

        subscriptionCreates.push(clone(options));
        const subscription = makeSubscription(
            "sub_created_" + nextSubscriptionNumber++, options.items[0].plan);
        customers[options.customer].subscriptions.data.push(subscription);
        return clone(subscription);
      };
      testStripe.subscriptions.update = async function (subscriptionId, options) {
        subscriptionUpdates.push({ subscriptionId, options: clone(options) });
        for (const customer of Object.values(customers)) {
          const subscription = customer.subscriptions.data
              .find((candidate) => candidate.id === subscriptionId);
          if (subscription) {
            if (options.cancel_at_period_end) {
              subscription.cancel_at_period_end = true;
            }

            if (options.items) {
              subscription.plan.id = options.items[0].plan;
              subscription.items.data[0].plan.id = options.items[0].plan;
            }

            return clone(subscription);
          }
        }

        throw new Error("Unexpected Stripe subscription: " + subscriptionId);
      };

      try {
        await expectMeteorError(403, "Must be logged in", async () =>
          await paymentMethodsForTests.getStripeData.apply(contextFor(null), []));

        const createdSource = await callPaymentMethod(
            "createUserSubscription", newUserId, ["tok_new", "new@example.com", planOne]);
        const newUser = await Meteor.users.findOneAsync(newUserId);
        if (customerCreates.length !== 1 ||
            customerCreates[0].description !== newUserId ||
            customerCreates[0].source !== "tok_new" ||
            newUser.payments.id !== "cus_created" ||
            newUser.plan !== planOne ||
            subscriptionCreates.length !== 1 ||
            subscriptionCreates[0].customer !== "cus_created" ||
            subscriptionCreates[0].items[0].plan !== planOne ||
            !createdSource ||
            createdSource.id === "card_created" ||
            createdSource.last4 !== "0001") {
          throw new Meteor.Error("payments-create-subscription",
              "Creating a customer subscription did not persist or sanitize the expected data.");
        }

        const addedSource = await callPaymentMethod(
            "addCardForUser", existingUserId, ["tok_added", "existing@example.com"]);
        if (sourceCreates.length !== 1 ||
            sourceCreates[0].customerId !== "cus_existing" ||
            addedSource.id === "card_added_1" ||
            addedSource.last4 !== "7001" ||
            addedSource.isPrimary !== false) {
          throw new Meteor.Error("payments-add-source",
              "Adding a card did not use the existing customer and sanitize the source.");
        }

        await callPaymentMethod("makeCardPrimary", existingUserId, [addedSource.id]);
        if (customerUpdates.length !== 1 ||
            customerUpdates[0].customerId !== "cus_existing" ||
            customerUpdates[0].options.default_source !== "card_added_1") {
          throw new Meteor.Error("payments-primary-source",
              "Changing the primary card did not resolve the sanitized source ID.");
        }

        const stripeData = await callPaymentMethod("getStripeData", existingUserId, []);
        const primarySource = stripeData.sources.find((source) => source.last4 === "7001");
        const removableSource = stripeData.sources.find((source) => source.last4 === "2222");
        if (stripeData.email !== "existing@example.com" ||
            stripeData.subscription !== "pro" ||
            !(stripeData.subscriptionEnds instanceof Date) ||
            stripeData.subscriptionEnds.getTime() !== 1900000000 * 1000 ||
            stripeData.credit !== 125 ||
            !primarySource ||
            primarySource.isPrimary !== true ||
            !removableSource ||
            stripeData.sources.some((source) => source.id.startsWith("card_"))) {
          throw new Meteor.Error("payments-get-stripe-data",
              "Stripe customer data was not sanitized and normalized correctly.");
        }

        await callPaymentMethod("deleteCardForUser", existingUserId, [removableSource.id]);
        if (sourceDeletes.length !== 1 ||
            sourceDeletes[0].customerId !== "cus_existing" ||
            sourceDeletes[0].sourceId !== "card_existing_b") {
          throw new Meteor.Error("payments-delete-source",
              "Deleting a card did not resolve the sanitized source ID.");
        }

        const lastSourceData = await callPaymentMethod("getStripeData", lastCardUserId, []);
        await expectMeteorError(400, "Can't delete last card", async () =>
          await callPaymentMethod(
              "deleteCardForUser", lastCardUserId, [lastSourceData.sources[0].id]));
        if (sourceDeletes.length !== 1) {
          throw new Meteor.Error("payments-delete-last-source",
              "The final source of an active subscription was deleted.");
        }

        customers.cus_existing.subscriptions.data[0].cancel_at_period_end = false;
        await callPaymentMethod("updateUserSubscription", existingUserId, [planTwo]);
        const updatedExistingUser = await Meteor.users.findOneAsync(existingUserId);
        const existingUpdate = subscriptionUpdates.find(
            (entry) => entry.subscriptionId === "sub_existing" && entry.options.items);
        if (!existingUpdate ||
            existingUpdate.options.items[0].id !== "item_sub_existing" ||
            existingUpdate.options.items[0].plan !== planTwo ||
            updatedExistingUser.plan !== planTwo) {
          throw new Meteor.Error("payments-update-subscription",
              "Changing an existing subscription did not update Stripe and the account plan.");
        }

        const createsBeforeNewPlan = subscriptionCreates.length;
        await callPaymentMethod("updateUserSubscription", noSubscriptionUserId, [planTwo]);
        const noSubscriptionUser = await Meteor.users.findOneAsync(noSubscriptionUserId);
        if (subscriptionCreates.length !== createsBeforeNewPlan + 1 ||
            subscriptionCreates.slice(-1)[0].customer !== "cus_no_subscription" ||
            subscriptionCreates.slice(-1)[0].items[0].plan !== planTwo ||
            noSubscriptionUser.plan !== planTwo) {
          throw new Meteor.Error("payments-new-subscription",
              "Changing a customer without a subscription did not create one.");
        }

        const cancelResult = await callPaymentMethod(
            "updateUserSubscription", cancelUserId, ["free"]);
        let cancelUser = await Meteor.users.findOneAsync(cancelUserId);
        const cancelUpdates = subscriptionUpdates.filter(
            (entry) => entry.subscriptionId === "sub_cancel" &&
              entry.options.cancel_at_period_end);
        if (!(cancelResult.subscriptionEnds instanceof Date) ||
            cancelResult.subscriptionEnds.getTime() !== 1950000000 * 1000 ||
            cancelUser.plan !== planOne ||
            cancelUpdates.length !== 1) {
          throw new Meteor.Error("payments-cancel-subscription",
              "Canceling a subscription did not retain the paid plan through period end.");
        }

        const alreadyCanceledResult = await callPaymentMethod(
            "updateUserSubscription", cancelUserId, ["free"]);
        if (alreadyCanceledResult.subscriptionEnds.getTime() !== 1950000000 * 1000 ||
            subscriptionUpdates.filter((entry) =>
              entry.subscriptionId === "sub_cancel" &&
              entry.options.cancel_at_period_end).length !== 1) {
          throw new Meteor.Error("payments-repeat-cancel",
              "Canceling an already-canceled subscription performed a second Stripe update.");
        }

        customers.cus_no_subscription.subscriptions.data = [];
        await callPaymentMethod("updateUserSubscription", noSubscriptionUserId, ["free"]);
        const downgradedUser = await Meteor.users.findOneAsync(noSubscriptionUserId);
        if (downgradedUser.plan !== "free") {
          throw new Meteor.Error("payments-cancel-missing-subscription",
              "A customer without a Stripe subscription was not downgraded to free.");
        }

        await expectMeteorError(403, "Can't choose discontinued plan", async () =>
          await callPaymentMethod("updateUserSubscription", existingUserId, [hiddenPlan]));
        await expectMeteorError(403, "must have stripe data", async () =>
          await callPaymentMethod("updateUserSubscription", noPaymentsUserId, [planOne]));

        failNextSubscriptionCreate = true;
        await expectMeteorError("cardError", "Your card was declined", async () =>
          await callPaymentMethod("updateUserSubscription", cardErrorUserId, [planTwo]));
        const cardErrorUser = await Meteor.users.findOneAsync(cardErrorUserId);
        if (cardErrorUser.plan !== planOne) {
          throw new Meteor.Error("payments-card-error-plan",
              "A failed Stripe update changed the account plan.");
        }

        return true;
      } finally {
        testStripe.customers.create = originalCustomersCreate;
        testStripe.customers.createSource = originalCustomersCreateSource;
        testStripe.customers.deleteSource = originalCustomersDeleteSource;
        testStripe.customers.retrieve = originalCustomersRetrieve;
        testStripe.customers.update = originalCustomersUpdate;
        testStripe.subscriptions.create = originalSubscriptionsCreate;
        testStripe.subscriptions.update = originalSubscriptionsUpdate;
        await globalDb.collections.plans.removeAsync({ _id: { $in: planIds } });
        if (!originalFreePlan) {
          await globalDb.collections.plans.removeAsync("free");
        }

        await Meteor.users.removeAsync({ _id: { $in: userIds } });
      }
    },

    testRegressionPaymentWebhooksAndMailchimp: async function () {
      const invoiceUserId = "test-payments-invoice-" + Random.id();
      const invoiceCredentialId = "test-payments-invoice-credential-" + Random.id();
      const failureUserId = "test-payments-failure-" + Random.id();
      const failureCredentialId = "test-payments-failure-credential-" + Random.id();
      const deletedUserId = "test-payments-deleted-" + Random.id();
      const activeSubUserId = "test-payments-active-sub-" + Random.id();
      const mailchimpUserId = "test-payments-mailchimp-" + Random.id();
      const mailchimpCredentialId = "test-payments-mailchimp-credential-" + Random.id();
      const sentPaymentEmails = [];
      const deletedSubscriptions = [];
      const originalEventsRetrieve = testStripe.events.retrieve;
      const originalCustomersRetrieve = testStripe.customers.retrieve;
      const originalSubscriptionsDel = testStripe.subscriptions.del;
      const originalSandstormEmail = globalThis.SandstormEmail;
      const oldMailchimpListId = Meteor.settings.mailchimpListId;
      const oldMailchimpKey = Meteor.settings.mailchimpKey;
      const eventById = {};

      const insertAccountWithEmail = async (accountId, credentialId, email, extraFields) => {
        await Meteor.users.insertAsync({
          _id: credentialId,
          type: "credential",
          services: { email: { email } },
          profile: { name: "Payments test credential" },
        });
        await Meteor.users.insertAsync({
          _id: accountId,
          type: "account",
          signupKey: "admin",
          loginCredentials: [{ id: credentialId }],
          nonloginCredentials: [],
          primaryEmail: email,
          profile: { name: "Payments test account" },
          ...extraFields,
        });
      };

      await globalDb.collections.plans.upsertAsync("pro", {
        $set: {
          title: "Pro",
          storage: 10 * 1024 * 1024,
          compute: 100,
          grains: 100,
        },
      });
      await insertAccountWithEmail(invoiceUserId, invoiceCredentialId,
          "payments-invoice@example.com", { payments: { id: "cus_invoice" }, plan: "pro" });
      await insertAccountWithEmail(failureUserId, failureCredentialId,
          "payments-failure@example.com", { payments: { id: "cus_failure" }, plan: "pro" });
      await Meteor.users.insertAsync({
        _id: deletedUserId,
        type: "account",
        signupKey: "admin",
        loginCredentials: [],
        nonloginCredentials: [],
        profile: { name: "Payments deleted subscription account" },
        payments: { id: "cus_deleted" },
        plan: "pro",
      });
      await Meteor.users.insertAsync({
        _id: activeSubUserId,
        type: "account",
        signupKey: "admin",
        loginCredentials: [],
        nonloginCredentials: [],
        profile: { name: "Payments active subscription account" },
        payments: { id: "cus_active_sub" },
        plan: "pro",
      });
      await insertAccountWithEmail(mailchimpUserId, mailchimpCredentialId,
          "mailchimp-user@example.com", {});

      globalThis.SandstormEmail = {
        async send(message) {
          sentPaymentEmails.push(message);
        },
      };
      testStripe.events.retrieve = async function (eventId) {
        return eventById[eventId];
      };
      testStripe.customers.retrieve = async function (customerId) {
        if (customerId === "cus_failure") {
          return {
            email: "payments-failure@example.com",
            subscriptions: { data: [{ id: "sub_failure" }] },
          };
        } else if (customerId === "cus_deleted") {
          return { subscriptions: { data: [] } };
        } else if (customerId === "cus_active_sub") {
          return { subscriptions: { data: [{ id: "sub_active" }] } };
        }

        return { email: "fallback@example.com", subscriptions: { data: [] } };
      };
      testStripe.subscriptions.del = async function (subscriptionId) {
        deletedSubscriptions.push(subscriptionId);
      };

      try {
        eventById.invoice_success = {
          id: "invoice_success",
          type: "invoice.payment_succeeded",
          created: 100,
          data: {
            object: {
              customer: "cus_invoice",
              amount_due: 1000,
              total: 1000,
              lines: {
                data: [
                  { type: "subscription", plan: { id: "pro-monthly" }, amount: 1000 },
                  { type: "invoiceitem", description: "Extra storage", amount: 250 },
                ],
              },
            },
          },
        };
        await handleWebhookEvent(globalDb, { id: "invoice_success" });
        let invoiceUser = await Meteor.users.findOneAsync(invoiceUserId);
        if (invoiceUser.payments.lastInvoiceTime !== 100 ||
            sentPaymentEmails.length !== 1 ||
            sentPaymentEmails[0].to !== "payments-invoice@example.com" ||
            !/Invoice from/i.test(sentPaymentEmails[0].subject || "")) {
          throw new Meteor.Error("payments-invoice-success",
              "Successful invoice webhook did not update invoice time and send invoice email.");
        }

        eventById.invoice_duplicate = {
          ...eventById.invoice_success,
          id: "invoice_duplicate",
          created: 99,
        };
        await handleWebhookEvent(globalDb, { id: "invoice_duplicate" });
        invoiceUser = await Meteor.users.findOneAsync(invoiceUserId);
        if (invoiceUser.payments.lastInvoiceTime !== 100 || sentPaymentEmails.length !== 1) {
          throw new Meteor.Error("payments-invoice-duplicate",
              "Duplicate/old invoice webhook was not ignored.");
        }

        eventById.invoice_failure = {
          id: "invoice_failure",
          type: "invoice.payment_failed",
          created: 200,
          data: {
            object: {
              customer: "cus_failure",
              lines: { data: [] },
            },
          },
        };
        await handleWebhookEvent(globalDb, { id: "invoice_failure" });
        const failureUser = await Meteor.users.findOneAsync(failureUserId);
        if (failureUser.plan !== "free" ||
            failureUser.payments.lastInvoiceTime !== 200 ||
            !deletedSubscriptions.includes("sub_failure") ||
            sentPaymentEmails.length !== 2 ||
            !/URGENT: Payment failed/i.test(sentPaymentEmails[1].subject || "")) {
          throw new Meteor.Error("payments-invoice-failure",
              "Failed invoice webhook did not downgrade, cancel subscription, and send failure email.");
        }

        eventById.subscription_deleted = {
          id: "subscription_deleted",
          type: "customer.subscription.deleted",
          created: 300,
          data: { object: { customer: "cus_deleted" } },
        };
        await handleWebhookEvent(globalDb, { id: "subscription_deleted" });
        const deletedUser = await Meteor.users.findOneAsync(deletedUserId);
        if (deletedUser.plan !== "free") {
          throw new Meteor.Error("payments-subscription-delete",
              "Subscription deletion webhook did not downgrade customer with no active subscriptions.");
        }

        eventById.subscription_still_active = {
          id: "subscription_still_active",
          type: "customer.subscription.deleted",
          created: 301,
          data: { object: { customer: "cus_active_sub" } },
        };
        await handleWebhookEvent(globalDb, { id: "subscription_still_active" });
        const activeSubUser = await Meteor.users.findOneAsync(activeSubUserId);
        if (activeSubUser.plan !== "pro") {
          throw new Meteor.Error("payments-subscription-active",
              "Subscription deletion webhook downgraded a customer with active subscriptions.");
        }

        Meteor.settings.mailchimpListId = "mailchimp-list";
        Meteor.settings.mailchimpKey = "mailchimpkey-us1";
        setPaymentsHttpCallForTests(async function (method, url, options) {
          if (method !== "GET" ||
              !url.includes("https://us1.api.mailchimp.com/3.0/lists/mailchimp-list/members") ||
              !options ||
              options.headers.Authorization !== "apikey mailchimpkey-us1") {
            throw new Error("Unexpected Mailchimp request: " + method + " " + url);
          }

          return {
            data: {
              total_items: 1,
              members: [{
                email_address: "mailchimp-user@example.com",
                status: "subscribed",
                last_changed: "2026-05-01T12:00:00+00:00",
              }],
            },
          };
        });
        await updateMailchimp(globalDb);
        const subscriber = await MailchimpSubscribers.findOneAsync("mailchimp-user@example.com");
        const mailchimpUser = await Meteor.users.findOneAsync(mailchimpUserId);
        if (!subscriber || subscriber.canonical !== "mailchimp-user@example.com" ||
            subscriber.subscribed !== true ||
            !mailchimpUser.payments ||
            !mailchimpUser.payments.bonuses ||
            mailchimpUser.payments.bonuses.mailingList !== true ||
            mailchimpUser.planBonus.storage !== MAILING_LIST_BONUS) {
          throw new Meteor.Error("payments-mailchimp-update",
              "Mailchimp update did not refresh subscriber state and user bonuses.");
        }

        return true;
      } finally {
        testStripe.events.retrieve = originalEventsRetrieve;
        testStripe.customers.retrieve = originalCustomersRetrieve;
        testStripe.subscriptions.del = originalSubscriptionsDel;
        globalThis.SandstormEmail = originalSandstormEmail;
        Meteor.settings.mailchimpListId = oldMailchimpListId;
        Meteor.settings.mailchimpKey = oldMailchimpKey;
        setPaymentsHttpCallForTests(null);
        await MailchimpSubscribers.removeAsync({ _id: "mailchimp-user@example.com" });
        await globalDb.collections.plans.removeAsync("pro");
        await Meteor.users.removeAsync({
          _id: {
            $in: [
              invoiceUserId,
              invoiceCredentialId,
              failureUserId,
              failureCredentialId,
              deletedUserId,
              activeSubUserId,
              mailchimpUserId,
              mailchimpCredentialId,
            ],
          },
        });
      }
    },

    testRegressionTransferMethods: async function () {
      const userId = "test-transfer-account-" + Random.id();
      const unsignedUserId = "test-transfer-unsigned-" + Random.id();
      const otherUserId = "test-transfer-other-" + Random.id();
      const transferIds = [];
      const outgoingIds = [];
      const revokedUrls = [];
      const contextFor = (id) => ({
        userId: id,
        connection: {
          sandstormDb: globalDb,
          sandstormBackend: globalThis.globalBackend,
        },
      });
      const callTransferMethod = async (name, user, args) => {
        return await getMethodHandler(name).apply(contextFor(user), args);
      };

      await Meteor.users.insertAsync({
        _id: userId,
        type: "account",
        signupKey: "admin",
        loginCredentials: [],
        nonloginCredentials: [],
        profile: { name: "Transfer test account" },
      });
      await Meteor.users.insertAsync({
        _id: otherUserId,
        type: "account",
        signupKey: "admin",
        loginCredentials: [],
        nonloginCredentials: [],
        profile: { name: "Transfer other account" },
      });
      await Meteor.users.insertAsync({
        _id: unsignedUserId,
        type: "account",
        expires: new Date(Date.now() + 100000),
        loginCredentials: [],
        nonloginCredentials: [],
        profile: { name: "Transfer unsigned account" },
      });

      setTransferDownloaderDisabledForTests(true);

      setTransferHttpCallForTests(async function (method, url, options) {
        if (method === "DELETE" && url === "https://source.example/transfers/cancel") {
          revokedUrls.push(url);
          return { statusCode: 200 };
        }

        if (method !== "GET" ||
            url !== "https://source.example/transfers/list" ||
            !options ||
            options.headers.Authorization !== "Bearer " + "b".repeat(64)) {
          throw new Error("Unexpected transfer HTTP call: " + method + " " + url);
        }

        return {
          data: {
            isSansdtormTransferList: true,
            grains: [
              {
                _id: "grainA",
                appId: "app-a",
                appVersion: 1,
                packageId: "pkg-a",
                title: "Transfer Grain A",
                size: 100,
                lastUsed: 200,
              },
              {
                _id: "grainB",
                appId: "app-b",
                appVersion: 2,
                packageId: "pkg-b",
                title: "Transfer Grain B",
              },
            ],
          },
        };
      });

      try {
        try {
          await callTransferMethod("newTransfer", null, ["https://dest.example"]);
          throw new Meteor.Error("transfer-new-unauthenticated",
              "newTransfer allowed an unauthenticated caller.");
        } catch (err) {
          if (err.error !== 403) throw err;
        }

        try {
          await callTransferMethod("newTransfer", unsignedUserId, ["https://dest.example"]);
          throw new Meteor.Error("transfer-new-unsigned",
              "newTransfer allowed a non-signed-up account.");
        } catch (err) {
          if (err.error !== 403) throw err;
        }

        try {
          await callTransferMethod("newTransfer", userId, ["ftp://dest.example"]);
          throw new Meteor.Error("transfer-new-invalid-url", "newTransfer accepted invalid destination.");
        } catch (err) {
          if (err.error !== 400) throw err;
        }

        const token = await callTransferMethod("newTransfer", userId, ["https://dest.example"]);
        if (!/^[0-9a-f]{64}$/.test(token)) {
          throw new Meteor.Error("transfer-new-token-shape", "newTransfer returned malformed token.");
        }

        const hash = Crypto.createHash("sha256").update(token).digest("hex");
        outgoingIds.push(hash);
        const outgoing = await globalDb.collections.outgoingTransfers.findOneAsync(hash);
        if (!outgoing || outgoing.userId !== userId || outgoing.destination !== "https://dest.example") {
          throw new Meteor.Error("transfer-new-not-hashed",
              "newTransfer did not persist hashed outgoing transfer token.");
        }

        try {
          await callTransferMethod("acceptTransfer", userId, ["https://source.example", "bad-token"]);
          throw new Meteor.Error("transfer-accept-invalid-token",
              "acceptTransfer accepted invalid token shape.");
        } catch (err) {
          if (err.error !== 400) throw err;
        }

        await globalDb.collections.outgoingTransfers.removeAsync(hash);
        await callTransferMethod("acceptTransfer", userId, ["https://source.example", "b".repeat(64)]);
        let transfers = await globalDb.collections.incomingTransfers.find({ userId }).fetchAsync();
        if (transfers.length !== 2 ||
            !transfers.every((transfer) => transfer.selected === true &&
              transfer.source === "https://source.example" &&
              transfer.token === "b".repeat(64))) {
          throw new Meteor.Error("transfer-accept-not-inserted",
              "acceptTransfer did not insert expected incoming transfers.");
        }
        transferIds.push(...transfers.map((transfer) => transfer._id));

        const otherTransferId = await globalDb.collections.incomingTransfers.insertAsync({
          userId: otherUserId,
          source: "https://source.example",
          token: "c".repeat(64),
          grainId: "otherGrain",
          appId: "other-app",
          appVersion: 1,
          packageId: "other-package",
          title: "Other transfer",
          selected: true,
        });
        transferIds.push(otherTransferId);

        await callTransferMethod("setTransferSelected", userId, [transfers[0]._id, false]);
        let updated = await globalDb.collections.incomingTransfers.findOneAsync(transfers[0]._id);
        let otherUpdated = await globalDb.collections.incomingTransfers.findOneAsync(otherTransferId);
        if (updated.selected !== false || otherUpdated.selected !== true) {
          throw new Meteor.Error("transfer-selected-ownership",
              "setTransferSelected did not preserve ownership boundaries.");
        }

        await callTransferMethod("setTransferSelected", userId, [null, false]);
        transfers = await globalDb.collections.incomingTransfers.find({ userId }).fetchAsync();
        if (!transfers.every((transfer) => transfer.selected === false)) {
          throw new Meteor.Error("transfer-selected-all",
              "setTransferSelected(null) did not update all current-user transfers.");
        }

        await callTransferMethod("setTransferSelected", userId, [null, true]);
        await callTransferMethod("setTransferRunning", userId, [true]);
        transfers = await globalDb.collections.incomingTransfers.find({ userId }).fetchAsync();
        if (transfers.filter((transfer) => transfer.downloading).length !== 1) {
          throw new Meteor.Error("transfer-running-not-started",
              "setTransferRunning(true) did not start exactly one transfer.");
        }

        await callTransferMethod("setTransferRunning", userId, [false]);
        transfers = await globalDb.collections.incomingTransfers.find({ userId }).fetchAsync();
        if (transfers.some((transfer) => transfer.downloading)) {
          throw new Meteor.Error("transfer-running-not-stopped",
              "setTransferRunning(false) did not clear downloading state.");
        }

        await globalDb.collections.incomingTransfers.updateAsync(
            { _id: transfers[0]._id },
            { $set: { error: "boom", remoteFileToken: "remote", localFileToken: "local" } });
        await globalDb.collections.incomingTransfers.updateAsync(
            { _id: otherTransferId },
            { $set: { error: "other-boom", remoteFileToken: "other-remote", localFileToken: "other-local" } });
        await callTransferMethod("clearTransferErrors", userId, []);
        updated = await globalDb.collections.incomingTransfers.findOneAsync(transfers[0]._id);
        otherUpdated = await globalDb.collections.incomingTransfers.findOneAsync(otherTransferId);
        if (updated.error || updated.remoteFileToken || updated.localFileToken ||
            otherUpdated.error !== "other-boom") {
          throw new Meteor.Error("transfer-errors-not-cleared",
              "clearTransferErrors did not clear only current-user error fields.");
        }

        const cancelOutgoingId = await globalDb.collections.outgoingTransfers.insertAsync({
          _id: "test-transfer-outgoing-" + Random.id(),
          userId,
          destination: "https://dest.example",
        });
        outgoingIds.push(cancelOutgoingId);
        await callTransferMethod("cancelTransfers", userId, []);
        if (await globalDb.collections.outgoingTransfers.findOneAsync({ userId }) ||
            await globalDb.collections.incomingTransfers.findOneAsync({ userId })) {
          throw new Meteor.Error("transfer-cancel-current-user",
              "cancelTransfers did not remove current user's transfers.");
        }

        if (!await globalDb.collections.incomingTransfers.findOneAsync(otherTransferId)) {
          throw new Meteor.Error("transfer-cancel-other-user",
              "cancelTransfers removed another user's transfer.");
        }

        if (!revokedUrls.includes("https://source.example/transfers/cancel")) {
          throw new Meteor.Error("transfer-cancel-not-revoked",
              "cancelTransfers did not revoke the remote transfer token.");
        }

        return true;
      } finally {
        setTransferDownloaderDisabledForTests(false);
        setTransferHttpCallForTests(null);
        await globalDb.collections.incomingTransfers.removeAsync({
          _id: { $in: transferIds },
        });
        await globalDb.collections.outgoingTransfers.removeAsync({
          _id: { $in: outgoingIds },
        });
        await Meteor.users.removeAsync({ _id: { $in: [userId, unsignedUserId, otherUserId] } });
      }
    },

    testRegressionTransferRoutes: async function () {
      const userId = "test-transfer-route-account-" + Random.id();
      const otherUserId = "test-transfer-route-other-" + Random.id();
      const token = "d".repeat(64);
      const hash = Crypto.createHash("sha256").update(token).digest("hex");
      const grainId = "routeGrain" + Random.id().replace(/[^a-zA-Z0-9]/g, "");
      const otherGrainId = "otherRouteGrain" + Random.id().replace(/[^a-zA-Z0-9]/g, "");
      const authHeaders = { Authorization: "Bearer " + token };
      const captureHttpError = async (fn) => {
        try {
          const response = await fn();
          return { statusCode: response.statusCode, content: response.content, data: response.data };
        } catch (err) {
          if (err.response) {
            return {
              statusCode: err.response.statusCode,
              content: err.response.content,
              data: err.response.data,
            };
          }

          throw err;
        }
      };

      await Meteor.users.insertAsync({
        _id: userId,
        type: "account",
        signupKey: "admin",
        loginCredentials: [],
        nonloginCredentials: [],
        profile: { name: "Transfer route test account" },
      });
      await Meteor.users.insertAsync({
        _id: otherUserId,
        type: "account",
        signupKey: "admin",
        loginCredentials: [],
        nonloginCredentials: [],
        profile: { name: "Transfer route other account" },
      });
      await globalDb.collections.outgoingTransfers.insertAsync({
        _id: hash,
        userId,
        destination: "https://dest.example",
      });
      await globalDb.collections.grains.insertAsync({
        _id: grainId,
        userId,
        appId: "route-app",
        appVersion: 7,
        packageId: "route-package",
        title: "Route grain",
        size: 100,
        lastUsed: new Date("2026-01-01T00:00:00Z"),
      });
      await globalDb.collections.grains.insertAsync({
        _id: otherGrainId,
        userId: otherUserId,
        appId: "other-route-app",
        appVersion: 1,
        packageId: "other-route-package",
        title: "Other route grain",
      });

      try {
        let response = await captureHttpError(async () =>
          await httpCallAsync("GET", Meteor.absoluteUrl("transfers/list")));
        if (response.statusCode !== 403 || !/Missing token/i.test(response.content || "")) {
          throw new Meteor.Error("transfer-list-missing-token",
              "/transfers/list did not reject missing bearer token.");
        }

        response = await captureHttpError(async () =>
          await httpCallAsync("GET", Meteor.absoluteUrl("transfers/list"), {
            headers: { Authorization: "Bearer " + "e".repeat(64) },
          }));
        if (response.statusCode !== 403 || !/Invalid token/i.test(response.content || "")) {
          throw new Meteor.Error("transfer-list-invalid-token",
              "/transfers/list did not reject invalid bearer token.");
        }

        response = await httpCallAsync("GET", Meteor.absoluteUrl("transfers/list"), { headers: authHeaders });
        if (response.statusCode !== 200 ||
            !response.data ||
            response.data.isSansdtormTransferList !== true ||
            response.data.grains.length !== 1 ||
            response.data.grains[0]._id !== grainId ||
            response.data.grains[0].lastUsed !== new Date("2026-01-01T00:00:00Z").getTime()) {
          throw new Meteor.Error("transfer-list-owner-scope",
              "/transfers/list did not return only the transfer owner's grains.");
        }

        setTransferCreateGrainBackupForTests(async function (routeUserId, routeGrainId, isTransfer) {
          if (routeUserId !== userId || routeGrainId !== grainId || isTransfer !== true) {
            throw new Meteor.Error("transfer-prepare-args",
                "/transfers/prepare passed unexpected backup arguments.");
          }

          throw new Meteor.Error(425, "Backup is still pending.");
        });
        response = await captureHttpError(async () =>
          await httpCallAsync("POST", Meteor.absoluteUrl("transfers/prepare/" + grainId), {
            headers: authHeaders,
          }));
        if (response.statusCode !== 425 || !/Backup is still pending/i.test(response.content || "")) {
          throw new Meteor.Error("transfer-prepare-status",
              "/transfers/prepare did not map backup failure to expected status.");
        }

        response = await httpCallAsync("DELETE", Meteor.absoluteUrl("transfers/cancel"), { headers: authHeaders });
        if (response.statusCode !== 200) {
          throw new Meteor.Error("transfer-cancel-status",
              "/transfers/cancel did not return 200 for a valid token.");
        }

        if (await globalDb.collections.outgoingTransfers.findOneAsync(hash)) {
          throw new Meteor.Error("transfer-cancel-token-not-removed",
              "/transfers/cancel did not remove the outgoing transfer token.");
        }

        return true;
      } finally {
        setTransferCreateGrainBackupForTests(null);
        await globalDb.collections.outgoingTransfers.removeAsync(hash);
        await globalDb.collections.grains.removeAsync({ _id: { $in: [grainId, otherGrainId] } });
        await Meteor.users.removeAsync({ _id: { $in: [userId, otherUserId] } });
      }
    },

    testRegressionTransferDownloader: async function () {
      const userId = "test-transfer-downloader-account-" + Random.id();
      const transferIds = [];
      const prepareCalls = [];
      const requestCalls = [];
      const storedTokens = [];
      const restoredTokens = [];
      const insertTransfer = async (fields) => {
        fields = fields || {};
        const transfer = {
          userId,
          source: "https://source.example",
          token: "f".repeat(64),
          grainId: "downloadGrain" + Random.id().replace(/[^a-zA-Z0-9]/g, ""),
          appId: "download-app",
          appVersion: 1,
          packageId: "download-package",
          title: "Downloader test grain",
          selected: true,
        };
        if (!Object.prototype.hasOwnProperty.call(fields, "downloading")) {
          transfer.downloading = true;
        }

        Object.assign(transfer, fields);
        if (transfer.downloading === undefined) delete transfer.downloading;

        const id = await globalDb.collections.incomingTransfers.insertAsync(transfer);
        transferIds.push(id);
        return id;
      };
      const runDownloader = async (transferId) => {
        const transfer = await globalDb.collections.incomingTransfers.findOneAsync(transferId);
        const downloader = new Downloader(transfer);
        await downloader.promise;
        return downloader;
      };

      await Meteor.users.insertAsync({
        _id: userId,
        type: "account",
        signupKey: "admin",
        loginCredentials: [],
        nonloginCredentials: [],
        profile: { name: "Transfer downloader account" },
      });

      setTransferDownloaderDisabledForTests(true);
      setTransferHttpCallForTests(async function (method, url, options) {
        prepareCalls.push({ method, url, options });
        return { data: { fileToken: "remote-token-" + prepareCalls.length } };
      });

      try {
        let requestStatuses = [425, 200];
        setTransferDownloaderHooksForTests({
          request(source, remoteFileToken) {
            requestCalls.push({ source, remoteFileToken });
            return makeTransferRequest(requestStatuses.shift());
          },
          async createBackupToken() {
            return "local-file-token";
          },
          async storeGrainBackup(localFileToken, response) {
            storedTokens.push({ localFileToken, statusCode: response.statusCode });
          },
          async restoreGrainBackup(localFileToken, user, transfer) {
            restoredTokens.push({ localFileToken, userId: user._id, transferId: transfer._id });
            return "local-grain-id";
          },
        });

        const retryTransferId = await insertTransfer({});
        const nextTransferId = await insertTransfer({
          grainId: "nextDownloadGrain" + Random.id().replace(/[^a-zA-Z0-9]/g, ""),
          downloading: undefined,
          lastUsed: 1000,
        });
        await runDownloader(retryTransferId);

        let retryTransfer = await globalDb.collections.incomingTransfers.findOneAsync(retryTransferId);
        let nextTransfer = await globalDb.collections.incomingTransfers.findOneAsync(nextTransferId);
        if (requestCalls.length !== 2 ||
            requestCalls[0].remoteFileToken !== "remote-token-1" ||
            requestCalls[1].remoteFileToken !== "remote-token-1") {
          throw new Meteor.Error("transfer-downloader-no-425-retry",
              "Downloader did not retry a 425 response with the same remote token.");
        }

        if (storedTokens.length !== 1 ||
            restoredTokens.length !== 1 ||
            retryTransfer.localGrainId !== "local-grain-id" ||
            retryTransfer.downloading ||
            nextTransfer.downloading !== true) {
          throw new Meteor.Error("transfer-downloader-success",
              "Downloader did not store, restore, finish, and start the next transfer.");
        }

        requestCalls.length = 0;
        prepareCalls.length = 0;
        setTransferDownloaderHooksForTests({
          request(source, remoteFileToken) {
            requestCalls.push({ source, remoteFileToken });
            return makeTransferRequest(403);
          },
        });
        const invalidRemoteTransferId = await insertTransfer({
          remoteFileToken: "stale-remote-token",
        });
        await runDownloader(invalidRemoteTransferId);

        const invalidRemoteTransfer =
            await globalDb.collections.incomingTransfers.findOneAsync(invalidRemoteTransferId);
        if (invalidRemoteTransfer.remoteFileToken ||
            !/HTTP error: 403/i.test(invalidRemoteTransfer.error || "") ||
            invalidRemoteTransfer.downloading) {
          throw new Meteor.Error("transfer-downloader-token-not-invalidated",
              "Downloader did not invalidate stale remote token after 403.");
        }

        const canceledTransferId = await insertTransfer({});
        setTransferDownloaderHooksForTests({
          request(_source, _remoteFileToken) {
            return makeTransferRequest(new Error("Synthetic download failure."), () => {
              return globalDb.collections.incomingTransfers.updateAsync(
                  { _id: canceledTransferId }, { $unset: { downloading: 1 } });
            });
          },
        });
        await runDownloader(canceledTransferId);

        const canceledTransfer = await globalDb.collections.incomingTransfers.findOneAsync(canceledTransferId);
        if (canceledTransfer.downloading || canceledTransfer.error) {
          throw new Meteor.Error("transfer-downloader-cancel-error",
              "Downloader cancellation did not clear downloading without recording an error.");
        }

        return true;
      } finally {
        setTransferDownloaderHooksForTests(null);
        setTransferHttpCallForTests(null);
        setTransferDownloaderDisabledForTests(false);
        await globalDb.collections.incomingTransfers.removeAsync({ _id: { $in: transferIds } });
        await Meteor.users.removeAsync(userId);
      }
    },
  });
}
