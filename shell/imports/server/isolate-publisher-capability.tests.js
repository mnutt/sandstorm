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
import {
  completePublishGrant,
  consumePublishGrant,
  createPublishGrant,
  requirePublishGrant,
  revokePublishGrantIfUnreferenced,
} from "/imports/server/isolate-publisher-capability";

const { assert } = chai;

function metadata(title = "Published isolate") {
  return {
    title,
    nounPhrase: "app",
    shortDescription: "A published isolate app",
    marketingVersion: "1.0",
  };
}

async function insertCandidate(ownerId, grainId, normalizedDigest) {
  const candidateId = Random.id();
  await globalDb.collections.isolateCandidates.insertAsync({
    _id: candidateId,
    ownerId,
    requestingGrainId: grainId,
    operationScope: `publisher-grant-test:${candidateId}`,
    requestId: candidateId,
    normalizedDigest,
    normalizedBundle: {
      formatVersion: 1,
      mainModule: "worker.js",
      compatibilityDate: "2026-08-17",
      compatibilityFlags: [],
      modules: [{ name: "worker.js", type: "esModule", content: "export default {};" }],
    },
    totalModuleBytes: 18,
    previewPackageId: `publisher-grant-package-${candidateId}`,
    status: "ready",
    createdAt: new Date(),
  });
  return candidateId;
}

describe("isolate publisher capability", function () {
  let ownerId;
  let otherId;
  let grainId;

  beforeEach(async function () {
    ownerId = `publisher-grant-owner-${Random.id()}`;
    otherId = `publisher-grant-other-${Random.id()}`;
    grainId = `publisher-grant-grain-${Random.id()}`;
    await globalDb.collections.users.insertAsync({
      _id: ownerId,
      type: "account",
      signupKey: "isolate-publisher-capability-test",
      loginCredentials: [],
      nonloginCredentials: [],
      profile: { name: "Publisher grant owner" },
    });
    await globalDb.collections.users.insertAsync({
      _id: otherId,
      type: "account",
      signupKey: "isolate-publisher-capability-test",
      loginCredentials: [],
      nonloginCredentials: [],
      profile: { name: "Shared publisher user" },
    });
    await globalDb.collections.grains.insertAsync({
      _id: grainId,
      userId: ownerId,
      appId: "publishergranttestapp",
      packageId: "publishergranttestpackage",
      appVersion: 1,
      title: "Publisher grant authoring grain",
      private: true,
      created: new Date(),
      lastUsed: new Date(),
    });
  });

  afterEach(async function () {
    await globalDb.collections.apiTokens.removeAsync({
      "frontendRef.isolatePublisher.grantId": { $exists: true },
    });
    await globalDb.collections.isolateFactoryGrants.removeAsync({ ownerId });
    await globalDb.collections.isolateFactoryGrants.removeAsync({ ownerId: otherId });
    await globalDb.collections.createdIsolateApps.removeAsync({ ownerId });
    await globalDb.collections.createdIsolateApps.removeAsync({ ownerId: otherId });
    await globalDb.collections.isolateCandidates.removeAsync({ ownerId });
    await globalDb.collections.isolateCandidates.removeAsync({ ownerId: otherId });
    await globalDb.collections.grains.removeAsync(grainId);
    await globalDb.collections.users.removeAsync(ownerId);
    await globalDb.collections.users.removeAsync(otherId);
  });

  it("mints a candidate- and target-specific owner grant", async function () {
    const digest = "a".repeat(64);
    const candidateId = await insertCandidate(ownerId, grainId, digest);
    const created = await createPublishGrant(globalDb, {
      userId: ownerId,
      grainId,
    }, {
      accountId: ownerId,
      normalizedDigest: digest,
      target: { newApp: null },
      metadata: metadata(),
    });
    const grant = await globalDb.collections.isolateFactoryGrants.findOneAsync(created.grantId);

    assert.strictEqual(grant.kind, "publish");
    assert.strictEqual(grant.ownerId, ownerId);
    assert.strictEqual(grant.requestingGrainId, grainId);
    assert.strictEqual(grant.candidateId, candidateId);
    assert.strictEqual(grant.candidateDigest, digest);
    assert.deepEqual(grant.target, { newApp: null });
    assert.deepEqual(grant.metadata, metadata());
    assert.deepEqual(created.requirements, [{
      permissionsHeld: { accountId: ownerId, grainId, permissions: [] },
    }]);

    const missingCandidate = await createPublishGrant(globalDb, {
      userId: ownerId,
      grainId,
    }, {
      accountId: ownerId,
      normalizedDigest: "f".repeat(64),
      target: { newApp: null },
      metadata: metadata(),
    }).then(() => null, error => error);
    assert.strictEqual(missingCandidate.code, "candidate-not-found");

    const sharedError = await createPublishGrant(globalDb, {
      userId: otherId,
      grainId,
    }, {
      accountId: otherId,
      normalizedDigest: digest,
      target: { newApp: null },
      metadata: metadata(),
    }).then(() => null, error => error);
    assert.strictEqual(sharedError.error, 403);
  });

  it("checks ownership before granting a specific app update", async function () {
    const createdAppId = Random.id();
    await globalDb.collections.createdIsolateApps.insertAsync({
      _id: createdAppId,
      ownerId,
      appId: "publishergrantcreatedapp",
      publishedRevisionId: Random.id(),
      appVersion: 1,
      title: "Existing isolate",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const candidateId = await insertCandidate(ownerId, grainId, "b".repeat(64));
    const created = await createPublishGrant(globalDb, {
      userId: ownerId,
      grainId,
    }, {
      accountId: ownerId,
      normalizedDigest: "b".repeat(64),
      target: { existingApp: createdAppId },
      metadata: metadata("Updated isolate"),
    });
    const grant = await globalDb.collections.isolateFactoryGrants.findOneAsync(created.grantId);
    assert.deepEqual(grant.target, { existingApp: createdAppId });
    assert.strictEqual(grant.candidateId, candidateId);

    await globalDb.collections.createdIsolateApps.updateAsync(createdAppId, {
      $set: { ownerId: otherId },
    });
    const error = await createPublishGrant(globalDb, {
      userId: ownerId,
      grainId,
    }, {
      accountId: ownerId,
      normalizedDigest: "c".repeat(64),
      target: { existingApp: createdAppId },
      metadata: metadata(),
    }).then(() => null, value => value);
    assert.strictEqual(error.code, "app-not-found");
  });

  it("consumes one durable request while allowing its exact retry", async function () {
    const grantId = Random.id();
    await globalDb.collections.isolateFactoryGrants.insertAsync({
      _id: grantId,
      kind: "publish",
      ownerId,
      requestingGrainId: grainId,
      candidateId: "candidate-one",
      candidateDigest: "d".repeat(64),
      target: { newApp: null },
      metadata: metadata(),
      createdAt: new Date(),
    });
    const initial = await requirePublishGrant(globalDb, grantId);
    const consumed = await consumePublishGrant(globalDb, initial, "publish-request");
    const retry = await consumePublishGrant(globalDb, consumed, "publish-request");
    assert.strictEqual(retry.consumedRequestId, "publish-request");

    const otherRequest = await consumePublishGrant(globalDb, retry, "different-request")
      .then(() => null, error => error);
    assert.strictEqual(otherRequest.code, "grant-consumed");

    const result = {
      createdAppId: Random.id(),
      revisionId: Random.id(),
      appId: "publishedapp",
      packageId: "publishedpackage",
      appVersion: 1,
      title: "Published isolate",
    };
    await completePublishGrant(globalDb, retry, result);
    assert.deepEqual((await requirePublishGrant(globalDb, grantId)).result, result);
  });

  it("revokes durable grant state after the last saved token is dropped", async function () {
    const grantId = Random.id();
    await globalDb.collections.isolateFactoryGrants.insertAsync({
      _id: grantId,
      kind: "publish",
      ownerId,
      requestingGrainId: grainId,
      candidateId: "candidate-one",
      candidateDigest: "e".repeat(64),
      target: { newApp: null },
      metadata: metadata(),
      createdAt: new Date(),
    });
    const tokenId = Random.id();
    await globalDb.collections.apiTokens.insertAsync({
      _id: tokenId,
      frontendRef: { isolatePublisher: { grantId } },
      owner: { frontend: null },
      created: new Date(),
    });

    assert.isFalse(await revokePublishGrantIfUnreferenced(globalDb, grantId));
    await globalDb.collections.apiTokens.removeAsync(tokenId);
    assert.isTrue(await revokePublishGrantIfUnreferenced(globalDb, grantId));
    const error = await requirePublishGrant(globalDb, grantId)
      .then(() => null, value => value);
    assert.strictEqual(error.code, "grant-revoked");
  });
});
