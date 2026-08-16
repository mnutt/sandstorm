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
import { SandstormPermissions } from "/imports/sandstorm-permissions/permissions";
import { grainsMenuSelector } from "/imports/server/grain-visibility";
import { IsolatePreviewError, previewIsolateBundle } from
  "/imports/server/isolate-preview-service";

const { assert } = chai;

function bundle(source = "export default { fetch() { return new Response('first'); } };") {
  return {
    formatVersion: 1,
    mainModule: "worker.js",
    compatibilityDate: "2025-01-01",
    compatibilityFlags: [],
    modules: [{ name: "worker.js", type: "esModule", content: source }],
  };
}

function metadata(version = 1) {
  return {
    appTitle: "Preview test",
    nounPhrase: "preview",
    shortDescription: "A preview lifecycle test.",
    appVersion: version,
    marketingVersion: `draft-${version}`,
  };
}

class FakePreviewBackend {
  constructor() {
    this.generateCalls = [];
    this.startCalls = [];
    this.shutdownCalls = [];
    this.deleteCalls = [];
    this.failStartsRemaining = 0;
  }

  cap() {
    return this;
  }

  async generateIsolatePackage(requestedAppId, packageMetadata, source) {
    this.generateCalls.push({ requestedAppId, packageMetadata, source });
    const hash = Crypto.createHash("sha256");
    hash.update(JSON.stringify(packageMetadata));
    source.modules.forEach((module) => {
      hash.update(module.name);
      hash.update(module.esModule || module.text || module.json);
    });
    const suffix = hash.digest("hex").slice(0, 20);
    const actionCommand = { isolate: { mainModule: source.mainModule, phase: "new" } };
    const continueCommand = { isolate: { mainModule: source.mainModule, phase: "continue" } };
    return {
      packageId: `preview-package-${suffix}`,
      appId: `preview-app-${suffix}`,
      manifest: {
        appTitle: { defaultText: packageMetadata.appTitle },
        appVersion: packageMetadata.appVersion,
        actions: [{ command: actionCommand }],
        continueCommand,
      },
    };
  }

  async startGrainInternal(packageId, grainId, ownerId, command, isNew, isDev, mountProc) {
    this.startCalls.push({ packageId, grainId, ownerId, command, isNew, isDev, mountProc });
    if (this.failStartsRemaining > 0) {
      --this.failStartsRemaining;
      throw new Error("simulated preview start failure");
    }

    return { supervisor: {} };
  }

  async shutdownGrain(grainId, ownerId, keepSessions) {
    this.shutdownCalls.push({ grainId, ownerId, keepSessions });
  }

  async deleteGrain(grainId, ownerId) {
    this.deleteCalls.push({ grainId, ownerId });
  }
}

describe("isolate preview grain lifecycle", function () {
  let ownerId;
  let operationScope;
  let actor;
  let backend;

  beforeEach(async function () {
    ownerId = `preview-owner-${Random.id()}`;
    operationScope = `preview-scope-${Random.id()}`;
    actor = { accountId: ownerId, operationScope, requestingGrainId: Random.id() };
    backend = new FakePreviewBackend();
    await globalDb.collections.users.insertAsync({
      _id: ownerId,
      type: "account",
      signupKey: "isolate-preview-test",
      loginCredentials: [],
      nonloginCredentials: [],
      profile: { name: "Isolate preview test" },
    });
  });

  afterEach(async function () {
    const candidates = await globalDb.collections.isolateCandidates.find({ ownerId }).fetchAsync();
    const packageIds = candidates.map(candidate => candidate.previewPackageId).filter(Boolean);
    await globalDb.collections.grains.removeAsync({ userId: ownerId });
    await globalDb.collections.isolateCandidates.removeAsync({ ownerId });
    await globalDb.collections.isolatePreviewSlots.removeAsync({ ownerId });
    if (packageIds.length > 0) {
      await globalDb.collections.packages.removeAsync({ _id: { $in: packageIds } });
    }

    await globalDb.collections.users.removeAsync(ownerId);
  });

  it("creates and starts an ordinary grain marked as a hidden preview", async function () {
    const result = await previewIsolateBundle(
      globalDb, backend, actor, "first", bundle(), metadata());
    const grain = await globalDb.collections.grains.findOneAsync(result.grainId);
    const menuGrains = await globalDb.collections.grains.find(
      grainsMenuSelector(ownerId)).fetchAsync();

    assert.strictEqual(grain.userId, ownerId);
    assert.strictEqual(grain.private, true);
    assert.strictEqual(grain.isolatePreview.scope, operationScope);
    assert.strictEqual(grain.isolatePreview.candidateId, result.candidate._id);
    assert.notProperty(grain.isolatePreview, "initializing");
    assert.strictEqual(result.candidate.previewGrainId, grain._id);
    assert.instanceOf(result.candidate.previewedAt, Date);
    assert.deepEqual(menuGrains, []);
    assert.strictEqual(backend.startCalls.length, 1);
    assert.strictEqual(backend.startCalls[0].isNew, true);
    assert.strictEqual(backend.startCalls[0].command.isolate.phase, "new");
  });

  it("keeps ordinary grains in the menu while excluding previews", async function () {
    const result = await previewIsolateBundle(
      globalDb, backend, actor, "hidden", bundle(), metadata());
    const ordinaryId = Random.id();
    await globalDb.collections.grains.insertAsync({
      _id: ordinaryId,
      userId: ownerId,
      packageId: "ordinary-package",
      appId: "ordinary-app",
      title: "Ordinary grain",
    });

    const visible = await globalDb.collections.grains.find(
      grainsMenuSelector(ownerId)).fetchAsync();
    assert.deepEqual(visible.map(grain => grain._id), [ordinaryId]);
    assert.isNotNull(await globalDb.collections.grains.findOneAsync(result.grainId));
  });

  it("blocks ordinary UiView sharing for preview grains", async function () {
    const result = await previewIsolateBundle(
      globalDb, backend, actor, "unshareable", bundle(), metadata());
    const error = await SandstormPermissions.createNewApiToken(
      globalDb,
      { accountId: ownerId },
      result.grainId,
      "preview share",
      { allAccess: null },
      { webkey: { forSharing: true } },
    ).then(() => null, error => error);

    assert.strictEqual(error.error, 403);
    assert.match(error.reason, /Preview grains cannot be shared/);
    assert.strictEqual(await globalDb.collections.apiTokens.find({
      grainId: result.grainId,
    }).countAsync(), 0);
  });

  it("moves the same preview grain to a new candidate while preserving its identity", async function () {
    const first = await previewIsolateBundle(
      globalDb, backend, actor, "revision-one", bundle(), metadata(1));
    const firstGrain = await globalDb.collections.grains.findOneAsync(first.grainId);
    const second = await previewIsolateBundle(globalDb, backend, actor, "revision-two", bundle(
      "export default { fetch() { return new Response('second'); } };"), metadata(2));
    const secondGrain = await globalDb.collections.grains.findOneAsync(second.grainId);

    assert.strictEqual(second.grainId, first.grainId);
    assert.strictEqual(secondGrain.identityId, firstGrain.identityId);
    assert.notStrictEqual(secondGrain.packageId, firstGrain.packageId);
    assert.strictEqual(secondGrain.isolatePreview.candidateId, second.candidate._id);
    assert.isString(secondGrain.packageSalt);
    assert.strictEqual(backend.shutdownCalls.length, 1);
    assert.strictEqual(backend.shutdownCalls[0].grainId, first.grainId);
    assert.strictEqual(backend.startCalls.length, 2);
    assert.strictEqual(backend.startCalls[1].isNew, false);
    assert.strictEqual(backend.startCalls[1].command.isolate.phase, "continue");
    const firstCandidate = await globalDb.collections.isolateCandidates.findOneAsync(
      first.candidate._id);
    assert.strictEqual(firstCandidate.previewGrainId, first.grainId);
  });

  it("uses a separate preview grain for a separate authoring scope", async function () {
    const first = await previewIsolateBundle(
      globalDb, backend, actor, "scope-one", bundle(), metadata());
    const second = await previewIsolateBundle(globalDb, backend, {
      ...actor,
      operationScope: `${operationScope}-other`,
    }, "scope-two", bundle(), metadata());

    assert.notStrictEqual(second.grainId, first.grainId);
    assert.strictEqual(await globalDb.collections.grains.find({ userId: ownerId }).countAsync(), 2);
  });

  it("cleans up a failed first start and can retry the same request", async function () {
    backend.failStartsRemaining = 1;
    const failure = await previewIsolateBundle(
      globalDb, backend, actor, "start-retry", bundle(), metadata())
      .then(() => null, error => error);
    assert.match(failure.message, /simulated preview start failure/);
    assert.strictEqual(await globalDb.collections.grains.find({ userId: ownerId }).countAsync(), 0);
    assert.strictEqual(backend.deleteCalls.length, 1);

    const retried = await previewIsolateBundle(
      globalDb, backend, actor, "start-retry", bundle(), metadata());
    assert.isNotNull(await globalDb.collections.grains.findOneAsync(retried.grainId));
    assert.strictEqual(backend.generateCalls.length, 1);
    assert.strictEqual(backend.startCalls.length, 2);
  });

  it("reports a recent cross-replica preview operation without starting another", async function () {
    await globalDb.collections.isolatePreviewSlots.insertAsync({
      _id: Random.id(),
      ownerId,
      operationScope,
      createdAt: new Date(),
      lock: {
        id: Random.id(),
        candidateId: Random.id(),
        acquiredAt: new Date(),
      },
    });
    const error = await previewIsolateBundle(
      globalDb, backend, actor, "concurrent-replica", bundle(), metadata())
      .then(() => null, error => error);

    assert.instanceOf(error, IsolatePreviewError);
    assert.strictEqual(error.code, "preview-in-progress");
    assert.strictEqual(backend.generateCalls.length, 0);
    assert.strictEqual(backend.startCalls.length, 0);
  });

  it("recovers a stale cross-replica preview lease", async function () {
    await globalDb.collections.isolatePreviewSlots.insertAsync({
      _id: Random.id(),
      ownerId,
      operationScope,
      createdAt: new Date(Date.now() - 10 * 60 * 1000),
      lock: {
        id: Random.id(),
        candidateId: Random.id(),
        acquiredAt: new Date(Date.now() - 10 * 60 * 1000),
      },
    });
    const result = await previewIsolateBundle(
      globalDb, backend, actor, "stale-replica", bundle(), metadata());
    const slot = await globalDb.collections.isolatePreviewSlots.findOneAsync({
      ownerId,
      operationScope,
    });

    assert.isNotNull(await globalDb.collections.grains.findOneAsync(result.grainId));
    assert.strictEqual(slot.grainId, result.grainId);
    assert.notProperty(slot, "lock");
  });

  it("checks account eligibility before materializing a package", async function () {
    await globalDb.collections.users.updateAsync(ownerId, {
      $unset: { signupKey: "" },
    });
    const error = await previewIsolateBundle(
      globalDb, backend, actor, "ineligible", bundle(), metadata())
      .then(() => null, error => error);

    assert.instanceOf(error, IsolatePreviewError);
    assert.strictEqual(error.code, "account-not-eligible");
    assert.strictEqual(backend.generateCalls.length, 0);
    assert.strictEqual(await globalDb.collections.grains.find({ userId: ownerId }).countAsync(), 0);
  });
});
