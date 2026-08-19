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

import { moduleContentSize, normalizeIsolateBundle } from "/imports/server/isolate-bundle";
import { makeIsolateContextValidator } from "/imports/server/isolate-context";
import { IsolateError } from "/imports/server/isolate-error";
import { mongoFindOneAndUpdateValue } from "/imports/server/isolate-mongo";

const MAX_REQUEST_ID_BYTES = 256;
const CANDIDATE_CLEANUP_RETRY_MS = 60 * 60 * 1000;
const CANDIDATE_CLEANUP_BATCH_SIZE = 100;

class IsolateCandidateError extends IsolateError {
  constructor(code, message) {
    super("IsolateCandidateError", code, message);
  }
}

function fail(code, message) {
  throw new IsolateCandidateError(code, message);
}

const { normalizeActor, requireIdentifier } = makeIsolateContextValidator(
  IsolateCandidateError, "Candidate creation");

function freezeCandidate(candidate) {
  if (!candidate) return candidate;

  const info = candidate.bundleInfo;
  if (info) {
    if (info.compatibilityFlags) Object.freeze(info.compatibilityFlags);
    if (info.modules) {
      info.modules.forEach(Object.freeze);
      Object.freeze(info.modules);
    }

    Object.freeze(info);
  }

  return Object.freeze(candidate);
}

function bundleInfo(normalized) {
  return {
    formatVersion: normalized.bundle.formatVersion,
    mainModule: normalized.bundle.mainModule,
    compatibilityDate: normalized.bundle.compatibilityDate,
    compatibilityFlags: normalized.bundle.compatibilityFlags,
    modules: normalized.bundle.modules.map(module => ({
      name: module.name,
      type: module.type,
      size: moduleContentSize(module),
    })),
  };
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
    bundleInfo: bundleInfo(normalized),
    totalModuleBytes: normalized.totalModuleBytes,
    validationWarnings: [],
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
  const candidate = mongoFindOneAndUpdateValue(result);
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
  const accountId = requireIdentifier(accountIdInput, "accountId");
  const candidateId = requireIdentifier(candidateIdInput, "candidateId", MAX_REQUEST_ID_BYTES);
  const candidate = await db.collections.isolateCandidates.findOneAsync({
    _id: candidateId,
    ownerId: accountId,
  });
  return freezeCandidate(candidate || null);
}

async function markOwnedIsolateCandidateForCleanup(
    db, accountIdInput, candidateIdInput, cleanupAfter = new Date()) {
  const accountId = requireIdentifier(accountIdInput, "accountId");
  const candidateId = requireIdentifier(candidateIdInput, "candidateId", MAX_REQUEST_ID_BYTES);
  if (!(cleanupAfter instanceof Date) || !Number.isFinite(cleanupAfter.getTime())) {
    fail("invalid-context", "Candidate cleanup requires a valid cleanup time.");
  }

  return await db.collections.isolateCandidates.updateAsync({
    _id: candidateId,
    ownerId: accountId,
    publishedRevisionId: { $exists: false },
  }, {
    $set: { cleanupAfter },
  }) === 1;
}

async function removeOwnedIsolateCandidate(db, accountIdInput, candidateIdInput) {
  const accountId = requireIdentifier(accountIdInput, "accountId");
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

  if (db.collections.isolatePreviewSlots &&
      await db.collections.isolatePreviewSlots.findOneAsync({
        ownerId: accountId,
        $or: [
          { candidateId },
          { "lock.candidateId": candidateId },
        ],
      })) {
    fail("candidate-in-use", "This isolate candidate is retained by its preview slot.");
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

  if (db.collections.apiTokens && await db.collections.apiTokens.findOneAsync({
    "frontendRef.isolateCandidate.candidateId": candidateId,
    revoked: { $ne: true },
  })) {
    fail("candidate-in-use", "This isolate candidate is retained by a saved capability.");
  }

  // References live in several collections, so they cannot be checked and
  // removed in one Mongo operation. Preview replacement is serialized by its
  // slot lease; other consumers revalidate the candidate and fail closed if a
  // grant or saved token races this final removal.
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

async function attemptOwnedIsolateCandidateCleanup(db, accountId, candidateId) {
  try {
    return await removeOwnedIsolateCandidate(db, accountId, candidateId) ? "removed" : "missing";
  } catch (error) {
    if (error instanceof IsolateCandidateError && error.code === "candidate-in-use") {
      return "referenced";
    }

    throw error;
  }
}

async function requestIsolateCandidateCleanup(
    db, candidateIdInput, cleanupAfter = new Date(), attemptNow = true) {
  const candidateId = requireIdentifier(candidateIdInput, "candidateId", MAX_REQUEST_ID_BYTES);
  const candidate = await db.collections.isolateCandidates.findOneAsync(candidateId);
  if (!candidate) return false;

  const marked = await markOwnedIsolateCandidateForCleanup(
    db, candidate.ownerId, candidateId, cleanupAfter);
  if (!marked || !attemptNow || cleanupAfter > new Date()) return false;
  return await attemptOwnedIsolateCandidateCleanup(db, candidate.ownerId, candidateId) === "removed";
}

async function cleanupMarkedIsolateCandidates(
    db, now = new Date(), limit = CANDIDATE_CLEANUP_BATCH_SIZE) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      !Number.isSafeInteger(limit) || limit <= 0) {
    fail("invalid-context", "Candidate cleanup requires a valid time and batch size.");
  }

  const candidates = await db.collections.isolateCandidates.find({
    cleanupAfter: { $lte: now },
    publishedRevisionId: { $exists: false },
  }, {
    sort: { cleanupAfter: 1 },
    limit,
    fields: { ownerId: 1 },
  }).fetchAsync();
  const result = { removed: 0, missing: 0, referenced: 0 };
  for (const candidate of candidates) {
    const disposition = await attemptOwnedIsolateCandidateCleanup(
      db, candidate.ownerId, candidate._id);
    ++result[disposition];
    if (disposition === "referenced") {
      await db.collections.isolateCandidates.updateAsync({
        _id: candidate._id,
        ownerId: candidate.ownerId,
        cleanupAfter: { $lte: now },
      }, {
        $set: { cleanupAfter: new Date(now.getTime() + CANDIDATE_CLEANUP_RETRY_MS) },
      });
    }
  }

  return result;
}

export {
  IsolateCandidateError,
  cleanupMarkedIsolateCandidates,
  findOwnedIsolateCandidate,
  markOwnedIsolateCandidateForCleanup,
  removeOwnedIsolateCandidate,
  requestIsolateCandidateCleanup,
  reserveIsolateCandidate,
};
