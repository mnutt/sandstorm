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
  IsolateCandidateError,
  findOwnedIsolateCandidate,
  removeOwnedIsolateCandidate,
  reserveIsolateCandidate,
} from "/imports/server/isolate-candidates";

const { assert } = chai;

function bundle(source = "export default { fetch() { return new Response('ok'); } };") {
  return {
    formatVersion: 1,
    mainModule: "worker.js",
    compatibilityDate: "2025-01-01",
    compatibilityFlags: [],
    modules: [{ name: "worker.js", type: "esModule", content: source }],
  };
}

async function expectCandidateError(promise, code) {
  const error = await promise.then(() => null, error => error);
  assert.instanceOf(error, IsolateCandidateError);
  assert.strictEqual(error.code, code);
}

describe("isolate candidate persistence", function () {
  let ownerId;
  let operationScope;
  let actor;

  beforeEach(function () {
    ownerId = `candidate-test-owner-${Random.id()}`;
    operationScope = `candidate-test-scope-${Random.id()}`;
    actor = { accountId: ownerId, operationScope, requestingGrainId: Random.id() };
  });

  afterEach(async function () {
    await globalDb.collections.isolateCandidates.removeAsync({ ownerId });
    await globalDb.collections.isolateCandidates.removeAsync({ operationScope });
  });

  it("stores an owner-scoped immutable snapshot without a mutable draft", async function () {
    const candidate = await reserveIsolateCandidate(globalDb, actor, "request-one", bundle());
    const stored = await globalDb.collections.isolateCandidates.findOneAsync(candidate._id);

    assert.strictEqual(candidate.ownerId, ownerId);
    assert.strictEqual(candidate.status, "preparing");
    assert.strictEqual(candidate.normalizedBundle.mainModule, "worker.js");
    assert.isTrue(Object.isFrozen(candidate));
    assert.isTrue(Object.isFrozen(candidate.normalizedBundle));
    assert.notProperty(stored, "draftSource");
    assert.notProperty(stored, "appId");
    assert.notProperty(stored, "packageId");
  });

  it("returns the original candidate when the same request is retried", async function () {
    const first = await reserveIsolateCandidate(globalDb, actor, "retry", bundle());
    const second = await reserveIsolateCandidate(globalDb, actor, "retry", bundle());

    assert.strictEqual(second._id, first._id);
    assert.deepEqual(second.createdAt, first.createdAt);
    assert.strictEqual(await globalDb.collections.isolateCandidates.find({
      operationScope,
      requestId: "retry",
    }).countAsync(), 1);
  });

  it("coalesces concurrent retries into one candidate", async function () {
    const candidates = await Promise.all(Array.from({ length: 5 }, () =>
      reserveIsolateCandidate(globalDb, actor, "concurrent", bundle())));

    assert.strictEqual(new Set(candidates.map(candidate => candidate._id)).size, 1);
  });

  it("rejects request ID reuse with different source", async function () {
    await reserveIsolateCandidate(globalDb, actor, "conflict", bundle());
    await expectCandidateError(reserveIsolateCandidate(
      globalDb,
      actor,
      "conflict",
      bundle("export default { fetch() { return new Response('different'); } };"),
    ), "idempotency-conflict");
  });

  it("rejects operation-scope reuse by different authority", async function () {
    const candidate = await reserveIsolateCandidate(globalDb, actor, "authority", bundle());
    await expectCandidateError(reserveIsolateCandidate(globalDb, {
      ...actor,
      accountId: `${ownerId}-other`,
    }, "authority", bundle()), "idempotency-conflict");

    assert.strictEqual(candidate.ownerId, ownerId);
  });

  it("does not reveal a candidate through a different owner", async function () {
    const candidate = await reserveIsolateCandidate(globalDb, actor, "owned", bundle());
    assert.isNull(await findOwnedIsolateCandidate(globalDb, `${ownerId}-other`, candidate._id));
    assert.strictEqual((await findOwnedIsolateCandidate(globalDb, ownerId, candidate._id))._id,
        candidate._id);
  });

  it("validates actor and request context before inserting", async function () {
    await expectCandidateError(
      reserveIsolateCandidate(globalDb, null, "request", bundle()), "invalid-context");
    await expectCandidateError(
      reserveIsolateCandidate(globalDb, actor, "", bundle()), "invalid-context");
    assert.strictEqual(await globalDb.collections.isolateCandidates.find({ operationScope })
        .countAsync(), 0);
  });

  it("removes an unreferenced owned candidate and requests generated-package cleanup",
      async function () {
    const packageUpdates = [];
    const candidate = {
      _id: "candidate-id",
      ownerId,
      previewPackageId: "generated-package-id",
    };
    const db = {
      collections: {
        isolateCandidates: {
          findOneAsync: async query => query.ownerId === ownerId ? candidate : null,
          removeAsync: async () => 1,
        },
        grains: { findOneAsync: async () => null },
        packages: {
          updateAsync: async (...args) => {
            packageUpdates.push(args);
            return 1;
          },
        },
      },
    };

    assert.isTrue(await removeOwnedIsolateCandidate(db, ownerId, candidate._id));
    assert.deepEqual(packageUpdates, [[{
      _id: candidate.previewPackageId,
      status: "ready",
      generatedIsolate: true,
    }, {
      $set: { shouldCleanup: true },
    }]]);
  });

  it("refuses to remove the candidate currently installed in a preview grain", async function () {
    const candidate = { _id: "current-candidate", ownerId };
    const db = {
      collections: {
        isolateCandidates: { findOneAsync: async () => candidate },
        grains: { findOneAsync: async () => ({ _id: "preview-grain" }) },
      },
    };

    await expectCandidateError(
      removeOwnedIsolateCandidate(db, ownerId, candidate._id), "candidate-in-use");
  });

  it("refuses to remove a candidate reserved by publication", async function () {
    const candidate = {
      _id: "publishing-candidate",
      ownerId,
      publishingOperationId: "publish-operation",
    };
    const db = {
      collections: {
        isolateCandidates: { findOneAsync: async () => candidate },
        grains: { findOneAsync: async () => null },
      },
    };

    await expectCandidateError(
      removeOwnedIsolateCandidate(db, ownerId, candidate._id), "candidate-in-use");
  });
});
