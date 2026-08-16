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

import { normalizeIsolateBundle } from "/imports/server/isolate-bundle";

const MAX_OPERATION_SCOPE_BYTES = 512;
const MAX_REQUEST_ID_BYTES = 256;

class IsolateCandidateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "IsolateCandidateError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new IsolateCandidateError(code, message);
}

function requireIdentifier(value, name, maxBytes) {
  if (typeof value !== "string" || value.length === 0) {
    fail("invalid-context", `${name} must be a non-empty string.`);
  }

  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    fail("invalid-context", `${name} exceeds the ${maxBytes}-byte limit.`);
  }

  return value;
}

function normalizeActor(actor) {
  if (!actor || typeof actor !== "object") {
    fail("invalid-context", "Candidate creation requires an explicit actor.");
  }

  const accountId = requireIdentifier(actor.accountId, "accountId", MAX_OPERATION_SCOPE_BYTES);
  const operationScope = requireIdentifier(
    actor.operationScope, "operationScope", MAX_OPERATION_SCOPE_BYTES);
  let requestingGrainId;
  if (actor.requestingGrainId !== undefined && actor.requestingGrainId !== null) {
    requestingGrainId = requireIdentifier(
      actor.requestingGrainId, "requestingGrainId", MAX_OPERATION_SCOPE_BYTES);
  }

  return { accountId, operationScope, requestingGrainId };
}

function resultValue(result) {
  if (result && Object.prototype.hasOwnProperty.call(result, "value")) {
    return result.value;
  }

  return result;
}

function freezeCandidate(candidate) {
  if (!candidate) return candidate;

  const bundle = candidate.normalizedBundle;
  if (bundle) {
    if (bundle.compatibilityFlags) Object.freeze(bundle.compatibilityFlags);
    if (bundle.modules) {
      bundle.modules.forEach(Object.freeze);
      Object.freeze(bundle.modules);
    }

    Object.freeze(bundle);
  }

  return Object.freeze(candidate);
}

async function reserveIsolateCandidate(db, actorInput, requestIdInput, bundleInput) {
  if (!db || !db.collections || !db.collections.isolateCandidates) {
    fail("invalid-context", "Candidate creation requires the isolateCandidates collection.");
  }

  const actor = normalizeActor(actorInput);
  const requestId = requireIdentifier(requestIdInput, "requestId", MAX_REQUEST_ID_BYTES);
  const normalized = normalizeIsolateBundle(bundleInput);
  const candidateId = Random.id();
  const createdAt = new Date();
  const record = {
    _id: candidateId,
    ownerId: actor.accountId,
    operationScope: actor.operationScope,
    requestId,
    normalizedDigest: normalized.digest,
    normalizedBundle: normalized.bundle,
    totalModuleBytes: normalized.totalModuleBytes,
    createdAt,
    status: "preparing",
  };
  if (actor.requestingGrainId !== undefined) {
    record.requestingGrainId = actor.requestingGrainId;
  }

  const result = await db.collections.isolateCandidates.rawCollection().findOneAndUpdate(
    { operationScope: actor.operationScope, requestId },
    { $setOnInsert: record },
    { upsert: true, returnDocument: "after" },
  );
  const candidate = resultValue(result);
  if (!candidate) {
    fail("reservation-failed", "Candidate reservation did not return a record.");
  }

  const sameRequest = candidate.ownerId === actor.accountId &&
    candidate.requestingGrainId === actor.requestingGrainId &&
    candidate.normalizedDigest === normalized.digest;
  if (!sameRequest) {
    fail("idempotency-conflict",
        "This candidate request ID is already reserved for different input or authority.");
  }

  return freezeCandidate(candidate);
}

async function findOwnedIsolateCandidate(db, accountIdInput, candidateIdInput) {
  const accountId = requireIdentifier(accountIdInput, "accountId", MAX_OPERATION_SCOPE_BYTES);
  const candidateId = requireIdentifier(candidateIdInput, "candidateId", MAX_REQUEST_ID_BYTES);
  const candidate = await db.collections.isolateCandidates.findOneAsync({
    _id: candidateId,
    ownerId: accountId,
  });
  return freezeCandidate(candidate || null);
}

async function removeOwnedIsolateCandidate(db, accountIdInput, candidateIdInput) {
  const accountId = requireIdentifier(accountIdInput, "accountId", MAX_OPERATION_SCOPE_BYTES);
  const candidateId = requireIdentifier(candidateIdInput, "candidateId", MAX_REQUEST_ID_BYTES);
  const candidate = await db.collections.isolateCandidates.findOneAsync({
    _id: candidateId,
    ownerId: accountId,
  });
  if (!candidate) return false;

  if (await db.collections.grains.findOneAsync({
    userId: accountId,
    "isolatePreview.candidateId": candidateId,
  })) {
    fail("candidate-in-use", "This isolate candidate is installed in its preview grain.");
  }

  if (candidate.publishedRevisionId ||
      (db.collections.createdIsolateRevisions &&
       await db.collections.createdIsolateRevisions.findOneAsync({ candidateId }))) {
    fail("candidate-in-use", "This isolate candidate belongs to a published revision.");
  }

  if (candidate.publishingOperationId ||
      (db.collections.isolatePublishOperations &&
       await db.collections.isolatePublishOperations.findOneAsync({
         candidateId,
         state: { $ne: "published" },
       }))) {
    fail("candidate-in-use", "This isolate candidate is reserved by a publication operation.");
  }

  if (db.collections.isolateFactoryGrants &&
      await db.collections.isolateFactoryGrants.findOneAsync({
        candidateId,
        revokedAt: { $exists: false },
      })) {
    fail("candidate-in-use", "This isolate candidate is retained by a capability grant.");
  }

  const removed = await db.collections.isolateCandidates.removeAsync({
    _id: candidateId,
    ownerId: accountId,
    publishedRevisionId: { $exists: false },
    publishingOperationId: { $exists: false },
  });
  if (removed !== 1) {
    fail("candidate-in-use", "This isolate candidate became referenced while it was removed.");
  }

  if (candidate.previewPackageId) {
    await db.collections.packages.updateAsync({
      _id: candidate.previewPackageId,
      status: "ready",
      generatedIsolate: true,
    }, {
      $set: { shouldCleanup: true },
    });
  }

  return true;
}

export {
  IsolateCandidateError,
  findOwnedIsolateCandidate,
  removeOwnedIsolateCandidate,
  reserveIsolateCandidate,
};
