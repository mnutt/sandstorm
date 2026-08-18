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

import { Random } from "meteor/random";
import chai from "chai";

import { globalDb } from "/imports/db-deprecated";
import { resolveIsolatePreviewForAuthoringGrain } from
  "/imports/server/isolate-preview-presentation";

const { assert } = chai;

describe("isolate preview presentation", function () {
  let ownerId;
  let otherId;
  let authoringGrainId;
  let otherAuthoringGrainId;
  let previewGrainId;
  let grantId;
  let candidateId;
  let digest;
  let scope;
  let packageId;

  beforeEach(async function () {
    ownerId = `preview-presentation-owner-${Random.id()}`;
    otherId = `preview-presentation-other-${Random.id()}`;
    authoringGrainId = `preview-presentation-author-${Random.id()}`;
    otherAuthoringGrainId = `preview-presentation-other-author-${Random.id()}`;
    previewGrainId = `preview-presentation-preview-${Random.id()}`;
    grantId = Random.id();
    candidateId = Random.id();
    digest = "a".repeat(64);
    scope = `isolate-preview-grant:${grantId}`;
    packageId = `preview-presentation-package-${Random.id()}`;

    await globalDb.collections.users.insertAsync({
      _id: ownerId,
      type: "account",
      signupKey: "isolate-preview-presentation-test",
      loginCredentials: [],
      nonloginCredentials: [],
      profile: { name: "Preview presentation owner" },
    });
    await globalDb.collections.users.insertAsync({
      _id: otherId,
      type: "account",
      signupKey: "isolate-preview-presentation-test",
      loginCredentials: [],
      nonloginCredentials: [],
      profile: { name: "Other preview user" },
    });
    await globalDb.collections.grains.insertAsync({
      _id: authoringGrainId,
      userId: ownerId,
      appId: "previewpresentationauthor",
      packageId: "previewpresentationauthorpackage",
      appVersion: 1,
      title: "Authoring grain",
      private: true,
      created: new Date(),
      lastUsed: new Date(),
    });
    await globalDb.collections.grains.insertAsync({
      _id: otherAuthoringGrainId,
      userId: ownerId,
      appId: "previewpresentationauthor",
      packageId: "previewpresentationauthorpackage",
      appVersion: 1,
      title: "Other authoring grain",
      private: true,
      created: new Date(),
      lastUsed: new Date(),
    });
    await globalDb.collections.isolateFactoryGrants.insertAsync({
      _id: grantId,
      kind: "preview",
      ownerId,
      requestingGrainId: authoringGrainId,
      createdAt: new Date(),
    });
    await globalDb.collections.isolateCandidates.insertAsync({
      _id: candidateId,
      ownerId,
      requestingGrainId: authoringGrainId,
      operationScope: scope,
      requestId: Random.id(),
      normalizedDigest: digest,
      normalizedBundle: {},
      previewMetadata: { appTitle: "Presented preview" },
      previewPackageId: packageId,
      previewGrainId,
      status: "ready",
      createdAt: new Date(),
    });
    await globalDb.collections.grains.insertAsync({
      _id: previewGrainId,
      userId: ownerId,
      appId: "previewpresentationpreview",
      packageId,
      appVersion: 0,
      title: "Presented preview",
      private: true,
      isolatePreview: { scope, candidateId },
      created: new Date(),
      lastUsed: new Date(),
    });
  });

  afterEach(async function () {
    await globalDb.collections.isolateCandidates.removeAsync({
      ownerId: { $in: [ownerId, otherId] },
    });
    await globalDb.collections.isolateFactoryGrants.removeAsync({
      ownerId: { $in: [ownerId, otherId] },
    });
    await globalDb.collections.grains.removeAsync({
      _id: { $in: [authoringGrainId, otherAuthoringGrainId, previewGrainId] },
    });
    await globalDb.collections.users.removeAsync({ _id: { $in: [ownerId, otherId] } });
  });

  it("resolves only the exact current preview for its owning authoring grain", async function () {
    assert.deepEqual(await resolveIsolatePreviewForAuthoringGrain(
      globalDb, ownerId, authoringGrainId, digest), {
      grainId: previewGrainId,
      normalizedDigest: digest,
      title: "Presented preview",
    });

    const otherGrainError = await resolveIsolatePreviewForAuthoringGrain(
      globalDb, ownerId, otherAuthoringGrainId, digest).then(() => null, error => error);
    assert.strictEqual(otherGrainError.code, "preview-not-current");

    const otherOwnerError = await resolveIsolatePreviewForAuthoringGrain(
      globalDb, otherId, authoringGrainId, digest).then(() => null, error => error);
    assert.strictEqual(otherOwnerError.code, "preview-not-authorized");
  });

  it("rejects malformed digests before looking up preview state", async function () {
    for (const invalid of ["", "A".repeat(64), "a".repeat(63), `${"a".repeat(63)}z`]) {
      const error = await resolveIsolatePreviewForAuthoringGrain(
        globalDb, ownerId, authoringGrainId, invalid).then(() => null, value => value);
      assert.strictEqual(error.code, "invalid-preview-digest");
    }
  });

  it("rejects revoked grants and expired grants", async function () {
    await globalDb.collections.isolateFactoryGrants.updateAsync(grantId, {
      $set: { revokedAt: new Date() },
    });
    let error = await resolveIsolatePreviewForAuthoringGrain(
      globalDb, ownerId, authoringGrainId, digest).then(() => null, value => value);
    assert.strictEqual(error.code, "preview-not-current");

    await globalDb.collections.isolateFactoryGrants.updateAsync(grantId, {
      $unset: { revokedAt: "" },
      $set: { expiresAt: new Date(Date.now() - 1000) },
    });
    error = await resolveIsolatePreviewForAuthoringGrain(
      globalDb, ownerId, authoringGrainId, digest).then(() => null, value => value);
    assert.strictEqual(error.code, "preview-not-current");
  });

  it("rejects a stale candidate after the preview grain moves", async function () {
    await globalDb.collections.grains.updateAsync(previewGrainId, {
      $set: { "isolatePreview.candidateId": Random.id() },
    });
    let error = await resolveIsolatePreviewForAuthoringGrain(
      globalDb, ownerId, authoringGrainId, digest).then(() => null, value => value);
    assert.strictEqual(error.code, "preview-not-current");

    await globalDb.collections.grains.updateAsync(previewGrainId, {
      $set: { "isolatePreview.candidateId": candidateId, trashed: true },
    });
    error = await resolveIsolatePreviewForAuthoringGrain(
      globalDb, ownerId, authoringGrainId, digest).then(() => null, value => value);
    assert.strictEqual(error.code, "preview-not-current");
  });
});
