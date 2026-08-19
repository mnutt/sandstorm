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

import { Meteor } from "meteor/meteor";
import { Random } from "meteor/random";
import chai from "chai";

import { globalDb } from "/imports/db-deprecated";
import {
  makeShellIsolateActor,
  previewIsolateFromShell,
  publishIsolateFromShell,
  resetIsolatePreviewFromShell,
} from "/imports/server/isolate-authoring-server";

const { assert } = chai;

function bundle(source = "export default { fetch() { return new Response('shell'); } };") {
  return {
    formatVersion: 1,
    mainModule: "worker.js",
    compatibilityDate: "2025-01-01",
    compatibilityFlags: [],
    modules: [{ name: "worker.js", type: "esModule", content: source }],
  };
}

function previewMetadata() {
  return {
    appTitle: "Shell authoring preview",
    nounPhrase: "shell preview",
    shortDescription: "A candidate created through the trusted shell boundary.",
    appVersion: 0,
    marketingVersion: "draft",
  };
}

function publishedMetadata() {
  return {
    title: "Shell authored app",
    nounPhrase: "shell app",
    shortDescription: "An app published through the trusted shell boundary.",
  };
}

class FakeAuthoringBackend {
  constructor() {
    this.generateCalls = [];
    this.startCalls = [];
    this.deleteCalls = [];
  }

  cap() {
    return this;
  }

  async generateIsolatePackage(requestedAppId, packageMetadata, source) {
    this.generateCalls.push({ requestedAppId, packageMetadata, source });
    const hash = Crypto.createHash("sha256");
    hash.update(requestedAppId || "preview");
    hash.update(JSON.stringify(packageMetadata));
    source.modules.forEach((module) => {
      hash.update(module.name);
      hash.update(module.esModule || module.text || module.json);
    });
    const suffix = hash.digest("hex").slice(0, 24);
    const appId = requestedAppId || `shell-preview-app-${suffix}`;
    return {
      packageId: `shell-authoring-package-${suffix}`,
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
              phase: "new",
              mainModule: source.mainModule,
              bindings: ["SANDSTORM_API", "POWERBOX", "STORAGE"].map(name => ({ name })),
            },
          },
        }],
        continueCommand: { isolate: { phase: "continue", mainModule: source.mainModule } },
      },
    };
  }

  async startGrainInternal(packageId, grainId, ownerId, command, isNew) {
    this.startCalls.push({ packageId, grainId, ownerId, command, isNew });
    return { supervisor: {} };
  }

  async shutdownGrain() {}

  async deleteGrain(grainId, ownerId) {
    this.deleteCalls.push({ grainId, ownerId });
  }
}

describe("trusted shell isolate authoring boundary", function () {
  let ownerId;
  let authoringSessionId;
  let backend;

  beforeEach(async function () {
    ownerId = `shell-authoring-owner-${Random.id()}`;
    authoringSessionId = `authoring_${Random.id()}`;
    backend = new FakeAuthoringBackend();
    await globalDb.collections.users.insertAsync({
      _id: ownerId,
      type: "account",
      signupKey: "isolate-authoring-server-test",
      loginCredentials: [],
      nonloginCredentials: [],
      profile: { name: "Shell isolate authoring test" },
    });
  });

  afterEach(async function () {
    await globalDb.collections.grains.removeAsync({ userId: ownerId });
    await globalDb.collections.userActions.removeAsync({ userId: ownerId });
    await globalDb.collections.createdIsolateRevisions.removeAsync({ ownerId });
    await globalDb.collections.createdIsolateApps.removeAsync({ ownerId });
    await globalDb.collections.isolatePublishOperations.removeAsync({ ownerId });
    await globalDb.collections.isolatePreviewSlots.removeAsync({ ownerId });
    await globalDb.collections.isolateCandidates.removeAsync({ ownerId });
    await globalDb.collections.packages.removeAsync({ generatedIsolateOwners: ownerId });
    await globalDb.collections.users.removeAsync(ownerId);
  });

  it("derives one stable built-in authoring scope per account", function () {
    const actor = makeShellIsolateActor(ownerId, authoringSessionId);
    const otherSessionActor = makeShellIsolateActor(ownerId, `other_${Random.id()}`);
    const otherActor = makeShellIsolateActor(`${ownerId}-other`, authoringSessionId);

    assert.strictEqual(actor.accountId, ownerId);
    assert.include(actor.operationScope, ownerId);
    assert.strictEqual(actor.operationScope, otherSessionActor.operationScope);
    assert.notStrictEqual(actor.operationScope, otherActor.operationScope);
    assert.throws(
      () => makeShellIsolateActor(ownerId, "bad session"), Meteor.Error);
    assert.throws(
      () => makeShellIsolateActor(null, authoringSessionId), Meteor.Error);
  });

  it("returns a sanitized candidate summary while retaining source server-side", async function () {
    const result = await previewIsolateFromShell(
      globalDb, backend, ownerId, authoringSessionId,
      "shell-preview", bundle(), previewMetadata());
    const stored = await globalDb.collections.isolateCandidates.findOneAsync(
      result.candidate.candidateId);

    assert.isString(result.grainId);
    assert.strictEqual(result.candidate.normalizedDigest, stored.normalizedDigest);
    assert.strictEqual(result.candidate.compatibilityDate, "2025-01-01");
    assert.deepEqual(
      result.candidate.platformBindings, ["SANDSTORM_API", "POWERBOX", "STORAGE"]);
    assert.deepEqual(result.candidate.validationWarnings, []);
    assert.notProperty(result.candidate, "normalizedBundle");
    assert.notProperty(result.candidate, "previewPackageId");
    assert.notProperty(result.candidate, "ownerId");
    assert.strictEqual(stored.normalizedBundle.modules[0].content,
      bundle().modules[0].content);
    assert.strictEqual(stored.operationScope,
      makeShellIsolateActor(ownerId, authoringSessionId).operationScope);
  });

  it("replaces preview data through the same account-bound authoring scope", async function () {
    const preview = await previewIsolateFromShell(
      globalDb, backend, ownerId, authoringSessionId,
      "shell-reset-preview", bundle(), previewMetadata());
    const reset = await resetIsolatePreviewFromShell(
      globalDb, backend, ownerId, authoringSessionId);

    assert.notStrictEqual(reset.grainId, preview.grainId);
    assert.notExists(await globalDb.collections.grains.findOneAsync(preview.grainId));
    assert.isNotNull(await globalDb.collections.grains.findOneAsync(reset.grainId));
  });

  it("publishes a candidate through the stable account authoring scope", async function () {
    const preview = await previewIsolateFromShell(
      globalDb, backend, ownerId, authoringSessionId,
      "shell-publish-preview", bundle(), previewMetadata());
    const published = await publishIsolateFromShell(
      globalDb, backend, ownerId, `different_${Random.id()}`,
      "shell-publish", preview.candidate.candidateId,
      { newApp: null }, publishedMetadata());
    assert.isString(published.createdAppId);
    assert.isString(published.revisionId);
    assert.isString(published.appId);
    assert.strictEqual(published.appVersion, 1);
    assert.notProperty(published, "packageId");
    assert.strictEqual(await globalDb.collections.userActions.find({ userId: ownerId })
      .countAsync(), 1);
  });
});
