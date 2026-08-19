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

import Crypto from "crypto";

import { Random } from "meteor/random";
import chai from "chai";

import { globalDb } from "/imports/db-deprecated";
import { reserveIsolateCandidate } from "/imports/server/isolate-candidates";
import { materializeIsolateCandidate } from "/imports/server/isolate-package-service";
import {
  IsolatePublisherError,
  encodeAppId,
  publicIsolatePublication,
  publishIsolateCandidate,
} from "/imports/server/isolate-publisher-service";

const { assert } = chai;

function bundle(message) {
  return {
    formatVersion: 1,
    mainModule: "worker.js",
    compatibilityDate: "2025-01-01",
    compatibilityFlags: [],
    modules: [{
      name: "worker.js",
      type: "esModule",
      content: `export default { fetch() { return new Response('${message}'); } };`,
    }],
  };
}

function previewMetadata(version = 0) {
  return {
    appTitle: "Publisher preview",
    nounPhrase: "publisher preview",
    shortDescription: "Candidate prepared for publisher tests.",
    appVersion: version,
    marketingVersion: `draft-${version}`,
  };
}

function publishedMetadata(title = "Published isolate") {
  return {
    title,
    nounPhrase: "published isolate",
    shortDescription: "An app produced by the isolate publisher.",
  };
}

class FakePublisherBackend {
  constructor() {
    this.calls = [];
    this.publishedFailuresRemaining = 0;
    this.beforePublishedPackage = null;
    this.previewBindings = ["SANDSTORM_API", "POWERBOX", "STORAGE"];
    this.publishedBindings = this.previewBindings;
    this.sources = new Map();
  }

  cap() {
    return this;
  }

  async generateIsolatePackage(requestedAppId, packageMetadata, source) {
    this.calls.push({ requestedAppId, packageMetadata, source });
    const hash = Crypto.createHash("sha256");
    hash.update(requestedAppId || "preview");
    hash.update(JSON.stringify(packageMetadata));
    source.modules.forEach((module) => {
      hash.update(module.name);
      hash.update(module.esModule || module.text || module.json);
    });
    const suffix = hash.digest("hex").slice(0, 24);
    const appId = requestedAppId || `preview-app-${suffix}`;
    const result = {
      packageId: `published-package-${suffix}`,
      appId,
      manifest: {
        appTitle: { defaultText: packageMetadata.appTitle },
        appMarketingVersion: { defaultText: packageMetadata.marketingVersion },
        appVersion: packageMetadata.appVersion,
        actions: [{
          input: { none: null },
          nounPhrase: { defaultText: packageMetadata.nounPhrase },
          command: {
            isolate: {
              mainModule: source.mainModule,
              phase: "new",
              bindings: (requestedAppId ? this.publishedBindings : this.previewBindings)
                .map(name => ({ name })),
            },
          },
        }],
        continueCommand: {
          isolate: { mainModule: source.mainModule, phase: "continue" },
        },
      },
    };
    this.sources.set(result.packageId, source);
    return result;
  }

  async deriveIsolatePackage(sourcePackageId, requestedAppId, packageMetadata) {
    const source = this.sources.get(sourcePackageId);
    if (!source) throw new Error("missing preview source package");
    if (this.beforePublishedPackage) await this.beforePublishedPackage();
    if (this.publishedFailuresRemaining > 0) {
      --this.publishedFailuresRemaining;
      this.calls.push({ sourcePackageId, requestedAppId, packageMetadata, source });
      throw new Error("simulated published package failure");
    }

    const result = await this.generateIsolatePackage(requestedAppId, packageMetadata, source);
    this.calls[this.calls.length - 1].sourcePackageId = sourcePackageId;
    return result;
  }
}

describe("isolate publisher", function () {
  let ownerId;
  let operationScope;
  let actor;
  let backend;

  beforeEach(async function () {
    ownerId = `publisher-owner-${Random.id()}`;
    operationScope = `publisher-scope-${Random.id()}`;
    actor = { accountId: ownerId, operationScope };
    backend = new FakePublisherBackend();
    await globalDb.collections.users.insertAsync({
      _id: ownerId,
      type: "account",
      signupKey: "isolate-publisher-test",
      loginCredentials: [],
      nonloginCredentials: [],
      profile: { name: "Isolate publisher test" },
    });
  });

  afterEach(async function () {
    await globalDb.collections.grains.removeAsync({ userId: ownerId });
    await globalDb.collections.userActions.removeAsync({ userId: ownerId });
    await globalDb.collections.createdIsolateRevisions.removeAsync({ ownerId });
    await globalDb.collections.createdIsolateApps.removeAsync({ ownerId });
    await globalDb.collections.isolatePublishOperations.removeAsync({
      $or: [{ ownerId }, { operationScope }],
    });
    await globalDb.collections.isolateCandidates.removeAsync({ ownerId });
    await globalDb.collections.packages.removeAsync({ generatedIsolateOwners: ownerId });
    await globalDb.collections.users.removeAsync(ownerId);
  });

  async function prepareCandidate(requestId, message, version = 0) {
    const candidate = await reserveIsolateCandidate(
      globalDb, actor, requestId, bundle(message));
    return await materializeIsolateCandidate(
      globalDb, backend, ownerId, candidate._id, previewMetadata(version), bundle(message));
  }

  it("encodes random bytes as canonical Sandstorm app IDs", function () {
    assert.strictEqual(encodeAppId(Buffer.alloc(32)), "0".repeat(52));
    assert.strictEqual(
      encodeAppId(Buffer.from(Array.from({ length: 32 }, (_unused, index) => index))),
      "000h40s40n30f209185hs38f1w8124hm2hajd5ss34e1q70x3sgh",
    );
    assert.match(encodeAppId(Crypto.randomBytes(32)), /^[0123456789acdefghjkmnpqrstuvwxyz]{52}$/);
  });

  it("publishes a candidate as an app action without creating a grain", async function () {
    const candidate = await prepareCandidate("candidate-one", "one");
    const result = await publishIsolateCandidate(
      globalDb, backend, actor, "publish-one", candidate._id,
      { newApp: null }, publishedMetadata());
    const app = await globalDb.collections.createdIsolateApps.findOneAsync(result.createdAppId);
    const revision = await globalDb.collections.createdIsolateRevisions.findOneAsync(
      result.revisionId);
    const action = await globalDb.collections.userActions.findOneAsync({ userId: ownerId });
    const publishedCandidate = await globalDb.collections.isolateCandidates.findOneAsync(
      candidate._id);
    const pkg = await globalDb.collections.packages.findOneAsync(result.packageId);
    const operation = await globalDb.collections.isolatePublishOperations.findOneAsync({
      operationScope,
      requestId: "publish-one",
    });

    assert.match(result.appId, /^[0123456789acdefghjkmnpqrstuvwxyz]{52}$/);
    assert.notStrictEqual(result.appId, candidate.previewAppId);
    assert.strictEqual(result.appVersion, 1);
    assert.strictEqual(app.publishedRevisionId, revision._id);
    assert.strictEqual(app.appVersion, 1);
    assert.strictEqual(revision.candidateId, candidate._id);
    assert.strictEqual(revision.normalizedDigest, candidate.normalizedDigest);
    assert.strictEqual(revision.packageId, result.packageId);
    assert.strictEqual(action.packageId, result.packageId);
    assert.strictEqual(action.appId, result.appId);
    assert.strictEqual(publishedCandidate.status, "published");
    assert.strictEqual(publishedCandidate.publishedRevisionId, revision._id);
    assert.include(pkg.generatedIsolateOwners, ownerId);
    assert.include(pkg.generatedIsolatePublishedOwners, ownerId);
    assert.strictEqual(operation.state, "published");
    assert.notProperty(operation, "lock");
    assert.notProperty(app, "publishLock");
    assert.strictEqual(await globalDb.collections.grains.find({ userId: ownerId }).countAsync(), 0);
    assert.deepEqual(publicIsolatePublication(result), {
      createdAppId: result.createdAppId,
      revisionId: result.revisionId,
      appId: result.appId,
      appVersion: result.appVersion,
      title: result.title,
    });
    assert.notProperty(publicIsolatePublication(result), "packageId");
  });

  it("coalesces concurrent calls and returns the recorded result on retry", async function () {
    const candidate = await prepareCandidate("retry-candidate", "retry");
    const publish = () => publishIsolateCandidate(
      globalDb, backend, actor, "retry-publish", candidate._id,
      { newApp: null }, publishedMetadata());
    const concurrent = await Promise.all([publish(), publish(), publish()]);
    const retried = await publish();

    assert.strictEqual(new Set(concurrent.map(result => result.revisionId)).size, 1);
    assert.strictEqual(retried.revisionId, concurrent[0].revisionId);
    assert.strictEqual(backend.calls.filter(call => call.requestedAppId).length, 1);
    assert.strictEqual(await globalDb.collections.createdIsolateRevisions.find({ ownerId })
      .countAsync(), 1);
    assert.strictEqual(await globalDb.collections.userActions.find({ userId: ownerId })
      .countAsync(), 1);
  });

  it("does not let a stale worker clear replacement publication leases", async function () {
    const candidate = await prepareCandidate("lease-candidate", "lease");
    let releasePackage;
    let packageStarted;
    const started = new Promise(resolve => { packageStarted = resolve; });
    backend.beforePublishedPackage = () => new Promise(resolve => {
      releasePackage = resolve;
      packageStarted();
    });

    const publishing = publishIsolateCandidate(
      globalDb, backend, actor, "lease-publish", candidate._id,
      { newApp: null }, publishedMetadata());
    await started;
    let operation;
    let app;
    try {
      operation = await globalDb.collections.isolatePublishOperations.findOneAsync({
        operationScope,
        requestId: "lease-publish",
      });
      app = await globalDb.collections.createdIsolateApps.findOneAsync(
        operation.createdAppId);

      assert.strictEqual(app.publishLock.operationId, operation._id);
      assert.strictEqual(app.publishLock.lockId, operation.lock.id);

      const replacementLockId = Random.id();
      const acquiredAt = new Date();
      await globalDb.collections.isolatePublishOperations.updateAsync(operation._id, {
        $set: { lock: { id: replacementLockId, acquiredAt } },
      });
      await globalDb.collections.createdIsolateApps.updateAsync(app._id, {
        $set: {
          publishLock: {
            operationId: operation._id,
            lockId: replacementLockId,
            acquiredAt,
          },
        },
      });
    } finally {
      releasePackage();
    }

    const error = await publishing.then(() => null, error => error);
    const operationAfter = await globalDb.collections.isolatePublishOperations.findOneAsync(
      operation._id);
    const appAfter = await globalDb.collections.createdIsolateApps.findOneAsync(app._id);
    assert.instanceOf(error, IsolatePublisherError);
    assert.strictEqual(error.code, "app-publish-lease-lost");
    assert.strictEqual(appAfter.publishLock.lockId, operationAfter.lock.id);
  });

  it("retries a deterministic package failure using the same app identity", async function () {
    const candidate = await prepareCandidate("failure-candidate", "failure");
    backend.publishedFailuresRemaining = 1;
    const publish = () => publishIsolateCandidate(
      globalDb, backend, actor, "failure-publish", candidate._id,
      { newApp: null }, publishedMetadata());
    const error = await publish().then(() => null, error => error);
    const failedOperation = await globalDb.collections.isolatePublishOperations.findOneAsync({
      operationScope,
      requestId: "failure-publish",
    });

    assert.match(error.message, /simulated published package failure/);
    assert.strictEqual(failedOperation.state, "authorized");
    assert.notProperty(failedOperation, "lock");
    assert.strictEqual(failedOperation.lastError.code, "publish-failed");

    const result = await publish();
    const publishedCalls = backend.calls.filter(call => call.requestedAppId);
    assert.strictEqual(publishedCalls.length, 2);
    assert.strictEqual(publishedCalls[0].requestedAppId, result.appId);
    assert.strictEqual(publishedCalls[1].requestedAppId, result.appId);
    assert.strictEqual(await globalDb.collections.createdIsolateApps.find({ ownerId })
      .countAsync(), 1);
  });

  it("rejects a published package whose bindings differ from the reviewed preview", async function () {
    const candidate = await prepareCandidate("binding-candidate", "bindings");
    backend.publishedBindings = [...backend.previewBindings, "UNREVIEWED_BINDING"];

    const error = await publishIsolateCandidate(
      globalDb, backend, actor, "binding-publish", candidate._id,
      { newApp: null }, publishedMetadata()).then(() => null, error => error);

    assert.strictEqual(error.code, "package-generation-failed");
    assert.match(error.message, /bindings differ/);
    assert.strictEqual(await globalDb.collections.createdIsolateRevisions.find({ ownerId })
      .countAsync(), 0);
    assert.strictEqual(await globalDb.collections.userActions.find({ userId: ownerId })
      .countAsync(), 0);
  });

  it("releases an app reservation after publication fails", async function () {
    const failedCandidate = await prepareCandidate(
      "released-lock-candidate", "released-lock");
    backend.publishedFailuresRemaining = 1;
    const error = await publishIsolateCandidate(
      globalDb, backend, actor, "released-lock-publish", failedCandidate._id,
      { newApp: null }, publishedMetadata()).then(() => null, error => error);
    const failedOperation = await globalDb.collections.isolatePublishOperations.findOneAsync({
      operationScope,
      requestId: "released-lock-publish",
    });
    const appAfterFailure = await globalDb.collections.createdIsolateApps.findOneAsync(
      failedOperation.createdAppId);

    assert.match(error.message, /simulated published package failure/);
    assert.notProperty(appAfterFailure, "publishLock");

    const replacementCandidate = await prepareCandidate(
      "replacement-candidate", "replacement");
    const replacement = await publishIsolateCandidate(
      globalDb, backend, actor, "replacement-publish", replacementCandidate._id,
      { existingApp: failedOperation.createdAppId }, publishedMetadata());

    assert.strictEqual(replacement.createdAppId, failedOperation.createdAppId);
    assert.strictEqual(replacement.appVersion, 1);
  });

  it("recovers a stale app publication reservation", async function () {
    const firstCandidate = await prepareCandidate("stale-lock-first", "first");
    const first = await publishIsolateCandidate(
      globalDb, backend, actor, "stale-lock-first-publish", firstCandidate._id,
      { newApp: null }, publishedMetadata());
    await globalDb.collections.createdIsolateApps.updateAsync(first.createdAppId, {
      $set: {
        publishLock: {
          operationId: "abandoned-publication",
          acquiredAt: new Date(Date.now() - 10 * 60 * 1000),
        },
      },
    });

    const secondCandidate = await prepareCandidate("stale-lock-second", "second");
    const second = await publishIsolateCandidate(
      globalDb, backend, actor, "stale-lock-second-publish", secondCandidate._id,
      { existingApp: first.createdAppId }, publishedMetadata());

    assert.strictEqual(second.createdAppId, first.createdAppId);
    assert.strictEqual(second.appVersion, 2);
    const app = await globalDb.collections.createdIsolateApps.findOneAsync(first.createdAppId);
    assert.notProperty(app, "publishLock");
  });

  it("does not steal a current app publication reservation", async function () {
    const firstCandidate = await prepareCandidate("current-lock-first", "first");
    const first = await publishIsolateCandidate(
      globalDb, backend, actor, "current-lock-first-publish", firstCandidate._id,
      { newApp: null }, publishedMetadata());
    await globalDb.collections.createdIsolateApps.updateAsync(first.createdAppId, {
      $set: {
        publishLock: {
          operationId: "active-publication",
          acquiredAt: new Date(),
        },
      },
    });

    const secondCandidate = await prepareCandidate("current-lock-second", "second");
    const error = await publishIsolateCandidate(
      globalDb, backend, actor, "current-lock-second-publish", secondCandidate._id,
      { existingApp: first.createdAppId }, publishedMetadata())
      .then(() => null, error => error);

    assert.instanceOf(error, IsolatePublisherError);
    assert.strictEqual(error.code, "app-publish-in-progress");
    const app = await globalDb.collections.createdIsolateApps.findOneAsync(first.createdAppId);
    assert.strictEqual(app.publishLock.operationId, "active-publication");
  });

  it("resumes after recording a revision but failing to install its action", async function () {
    const candidate = await prepareCandidate("action-failure-candidate", "action-failure");
    const failingDb = Object.create(globalDb);
    failingDb.collections = globalDb.collections;
    failingDb.addUserActions = async () => {
      throw new Error("simulated action installation failure");
    };
    const publishWith = db => publishIsolateCandidate(
      db, backend, actor, "action-failure-publish", candidate._id,
      { newApp: null }, publishedMetadata());
    const error = await publishWith(failingDb).then(() => null, error => error);
    const failedOperation = await globalDb.collections.isolatePublishOperations.findOneAsync({
      operationScope,
      requestId: "action-failure-publish",
    });

    assert.match(error.message, /simulated action installation failure/);
    assert.strictEqual(failedOperation.state, "revision-recorded");
    assert.isNotNull(await globalDb.collections.createdIsolateRevisions.findOneAsync(
      failedOperation.revisionId));
    assert.strictEqual(await globalDb.collections.userActions.find({ userId: ownerId })
      .countAsync(), 0);

    const result = await publishWith(globalDb);
    assert.strictEqual(result.revisionId, failedOperation.revisionId);
    assert.strictEqual(await globalDb.collections.createdIsolateRevisions.find({ ownerId })
      .countAsync(), 1);
    assert.strictEqual(await globalDb.collections.userActions.find({ userId: ownerId })
      .countAsync(), 1);
  });

  it("publishes a later candidate while leaving existing grains pinned", async function () {
    const firstCandidate = await prepareCandidate("first-candidate", "first");
    const first = await publishIsolateCandidate(
      globalDb, backend, actor, "first-publish", firstCandidate._id,
      { newApp: null }, publishedMetadata("First title"));
    const grainId = Random.id();
    await globalDb.collections.grains.insertAsync({
      _id: grainId,
      userId: ownerId,
      packageId: first.packageId,
      appId: first.appId,
      appVersion: first.appVersion,
      title: "Existing grain",
    });

    const secondCandidate = await prepareCandidate("second-candidate", "second", 1);
    const second = await publishIsolateCandidate(
      globalDb, backend, actor, "second-publish", secondCandidate._id,
      { existingApp: first.createdAppId }, publishedMetadata("Second title"));
    const action = await globalDb.collections.userActions.findOneAsync({ userId: ownerId });
    const grain = await globalDb.collections.grains.findOneAsync(grainId);
    const revision = await globalDb.collections.createdIsolateRevisions.findOneAsync(
      second.revisionId);

    assert.strictEqual(second.createdAppId, first.createdAppId);
    assert.strictEqual(second.appId, first.appId);
    assert.strictEqual(second.appVersion, 2);
    assert.notStrictEqual(second.packageId, first.packageId);
    assert.strictEqual(action.packageId, second.packageId);
    assert.strictEqual(grain.packageId, first.packageId);
    assert.strictEqual(grain.appVersion, 1);
    assert.strictEqual(revision.supersedesRevisionId, first.revisionId);
    assert.strictEqual(await globalDb.collections.createdIsolateRevisions.find({ ownerId })
      .countAsync(), 2);
  });

  it("does not allow generated package IDs to bypass publication ownership", async function () {
    const candidate = await prepareCandidate("private-candidate", "private");
    const previewError = await globalDb.addUserActions(ownerId, candidate.previewPackageId)
      .then(() => null, error => error);
    assert.match(previewError.message, /only be installed by their publisher/);

    const published = await publishIsolateCandidate(
      globalDb, backend, actor, "private-publish", candidate._id,
      { newApp: null }, publishedMetadata());
    const otherError = await globalDb.addUserActions(
      `${ownerId}-other`, published.packageId).then(() => null, error => error);
    assert.match(otherError.message, /only be installed by their publisher/);
    assert.strictEqual(await globalDb.collections.userActions.find({
      userId: `${ownerId}-other`,
    }).countAsync(), 0);
  });

  it("does not allow another account to publish an update to a created app", async function () {
    const firstCandidate = await prepareCandidate("target-owner-candidate", "target-owner");
    const first = await publishIsolateCandidate(
      globalDb, backend, actor, "target-owner-publish", firstCandidate._id,
      { newApp: null }, publishedMetadata());
    const otherOwnerId = `${ownerId}-update-attacker`;
    const otherActor = {
      accountId: otherOwnerId,
      operationScope: `${operationScope}-update-attacker`,
    };
    await globalDb.collections.users.insertAsync({
      _id: otherOwnerId,
      type: "account",
      signupKey: "isolate-publisher-update-attacker-test",
      loginCredentials: [],
      nonloginCredentials: [],
      profile: { name: "Update attacker test" },
    });
    const otherCandidate = await reserveIsolateCandidate(
      globalDb, otherActor, "attacker-candidate", bundle("attacker"));
    const readyOtherCandidate = await materializeIsolateCandidate(
      globalDb, backend, otherOwnerId, otherCandidate._id,
      previewMetadata(), bundle("attacker"));
    const error = await publishIsolateCandidate(
      globalDb, backend, otherActor, "attacker-publish", readyOtherCandidate._id,
      { existingApp: first.createdAppId }, publishedMetadata("Attacker title"))
      .then(() => null, error => error);

    assert.instanceOf(error, IsolatePublisherError);
    assert.strictEqual(error.code, "app-not-found");
    const app = await globalDb.collections.createdIsolateApps.findOneAsync(first.createdAppId);
    const storedOtherCandidate = await globalDb.collections.isolateCandidates.findOneAsync(
      readyOtherCandidate._id);
    assert.strictEqual(app.ownerId, ownerId);
    assert.strictEqual(app.publishedRevisionId, first.revisionId);
    assert.notProperty(storedOtherCandidate, "publishingOperationId");

    await globalDb.collections.isolatePublishOperations.removeAsync({ ownerId: otherOwnerId });
    await globalDb.collections.isolateCandidates.removeAsync({ ownerId: otherOwnerId });
    await globalDb.collections.packages.removeAsync({ generatedIsolateOwners: otherOwnerId });
    await globalDb.collections.users.removeAsync(otherOwnerId);
  });

  it("rejects cross-account candidates and request ID substitution", async function () {
    const candidate = await prepareCandidate("owned-candidate", "owned");
    const otherScope = `${operationScope}-other`;
    const otherOwnerId = `${ownerId}-other`;
    await globalDb.collections.users.insertAsync({
      _id: otherOwnerId,
      type: "account",
      signupKey: "isolate-publisher-other-test",
      loginCredentials: [],
      nonloginCredentials: [],
      profile: { name: "Other isolate publisher test" },
    });
    const ownershipError = await publishIsolateCandidate(globalDb, backend, {
      accountId: otherOwnerId,
      operationScope: otherScope,
    }, "cross-owner", candidate._id, { newApp: null }, publishedMetadata())
      .then(() => null, error => error);
    assert.instanceOf(ownershipError, IsolatePublisherError);
    assert.strictEqual(ownershipError.code, "candidate-not-found");

    await publishIsolateCandidate(
      globalDb, backend, actor, "fixed-request", candidate._id,
      { newApp: null }, publishedMetadata());
    const secondCandidate = await prepareCandidate("substitute-candidate", "substitute");
    const substitutionError = await publishIsolateCandidate(
      globalDb, backend, actor, "fixed-request", secondCandidate._id,
      { newApp: null }, publishedMetadata()).then(() => null, error => error);
    assert.instanceOf(substitutionError, IsolatePublisherError);
    assert.strictEqual(substitutionError.code, "idempotency-conflict");

    await globalDb.collections.isolatePublishOperations.removeAsync({ operationScope: otherScope });
    await globalDb.collections.users.removeAsync(otherOwnerId);
  });
});
