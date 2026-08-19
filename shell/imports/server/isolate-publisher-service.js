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

import { findOwnedIsolateCandidate } from "/imports/server/isolate-candidates";
import { IsolateError } from "/imports/server/isolate-error";
import { coalesceInFlightOperation } from "/imports/server/isolate-in-flight";
import {
  materializePublishedIsolateCandidate,
  normalizeGeneratedIsolateMetadata,
} from "/imports/server/isolate-package-service";

const APP_ID_ALPHABET = "0123456789acdefghjkmnpqrstuvwxyz";
const MAX_IDENTIFIER_BYTES = 512;
const MAX_REQUEST_ID_BYTES = 256;
const OPERATION_LOCK_STALE_MS = 5 * 60 * 1000;
const runningPublications = new Map();

class IsolatePublisherError extends IsolateError {
  constructor(code, message) {
    super("IsolatePublisherError", code, message);
  }
}

function fail(code, message) {
  throw new IsolatePublisherError(code, message);
}

function requireIdentifier(value, field, maximumBytes = MAX_IDENTIFIER_BYTES) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail("invalid-context", `${field} must be a non-empty string without NUL characters.`);
  }

  if (Buffer.byteLength(value, "utf8") > maximumBytes) {
    fail("invalid-context", `${field} exceeds the ${maximumBytes}-byte limit.`);
  }

  return value;
}

function normalizeActor(input) {
  if (!input || typeof input !== "object") {
    fail("invalid-context", "Isolate publication requires an explicit actor.");
  }

  const actor = {
    accountId: requireIdentifier(input.accountId, "accountId"),
    operationScope: requireIdentifier(input.operationScope, "operationScope"),
  };
  if (input.requestingGrainId !== undefined && input.requestingGrainId !== null) {
    actor.requestingGrainId = requireIdentifier(input.requestingGrainId, "requestingGrainId");
  }

  return actor;
}

function normalizeTarget(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("invalid-target", "A publication target is required.");
  }

  const keys = Object.keys(input);
  if (keys.length !== 1) fail("invalid-target", "Choose exactly one publication target.");
  if (keys[0] === "newApp" && input.newApp === null) return Object.freeze({ newApp: null });
  if (keys[0] === "existingApp") {
    return Object.freeze({
      existingApp: requireIdentifier(input.existingApp, "existingApp"),
    });
  }

  fail("invalid-target", "The publication target must be newApp or existingApp.");
}

function normalizeAppMetadata(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("invalid-metadata", "Published app metadata is required.");
  }

  const allowedFields = new Set([
    "title", "nounPhrase", "shortDescription", "marketingVersion",
  ]);
  if (Object.keys(input).some(field => !allowedFields.has(field))) {
    fail("invalid-metadata", "Published app metadata contains an unknown field.");
  }

  const hasMarketingVersion = input.marketingVersion !== undefined;

  const normalized = normalizeGeneratedIsolateMetadata({
    appTitle: input.title,
    nounPhrase: input.nounPhrase,
    shortDescription: input.shortDescription,
    appVersion: 1,
    marketingVersion: hasMarketingVersion ? input.marketingVersion : "1",
  });
  return Object.freeze({
    title: normalized.appTitle,
    nounPhrase: normalized.nounPhrase,
    shortDescription: normalized.shortDescription,
    marketingVersion: hasMarketingVersion ? normalized.marketingVersion : null,
  });
}

function encodeAppId(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) {
    fail("invalid-app-id-entropy", "A Sandstorm app ID requires exactly 32 bytes.");
  }

  let output = "";
  let buffer = 0;
  let bitsLeft = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bitsLeft += 8;
    while (bitsLeft >= 5) {
      bitsLeft -= 5;
      output += APP_ID_ALPHABET[(buffer >>> bitsLeft) & 0x1f];
      buffer &= (1 << bitsLeft) - 1;
    }
  }

  if (bitsLeft > 0) output += APP_ID_ALPHABET[(buffer << (5 - bitsLeft)) & 0x1f];
  return output;
}

function generateAppId() {
  return encodeAppId(Crypto.randomBytes(32));
}

function resultValue(result) {
  if (result && Object.prototype.hasOwnProperty.call(result, "value")) return result.value;
  return result;
}

function operationInputKey(actor, candidateId, target, metadata) {
  return JSON.stringify({
    ownerId: actor.accountId,
    requestingGrainId: actor.requestingGrainId,
    candidateId,
    target,
    metadata,
  });
}

async function reservePublishOperation(db, actor, requestId, candidateId, target, metadata) {
  const now = new Date();
  const isNew = Object.prototype.hasOwnProperty.call(target, "newApp");
  const record = {
    _id: Random.id(),
    ownerId: actor.accountId,
    operationScope: actor.operationScope,
    requestId,
    candidateId,
    target,
    metadata,
    inputKey: operationInputKey(actor, candidateId, target, metadata),
    createdAppId: isNew ? Random.id() : target.existingApp,
    revisionId: Random.id(),
    state: "authorized",
    createdAt: now,
    updatedAt: now,
  };
  if (actor.requestingGrainId) record.requestingGrainId = actor.requestingGrainId;
  if (isNew) record.appId = generateAppId();

  const inserted = await db.collections.isolatePublishOperations.rawCollection()
    .findOneAndUpdate({
      operationScope: actor.operationScope,
      requestId,
    }, {
      $setOnInsert: record,
    }, { upsert: true, returnDocument: "after" });
  const operation = resultValue(inserted) ||
    await db.collections.isolatePublishOperations.findOneAsync({
      operationScope: actor.operationScope,
      requestId,
    });
  if (!operation) fail("reservation-failed", "Publication could not reserve its operation.");
  if (operation.inputKey !== record.inputKey) {
    fail("idempotency-conflict",
        "This publication request ID is already reserved for different input or authority.");
  }

  return operation;
}

async function claimOperation(db, operation) {
  if (operation.state === "published") return null;
  const now = new Date();
  const lock = { id: Random.id(), acquiredAt: now };
  const staleBefore = new Date(now.getTime() - OPERATION_LOCK_STALE_MS);
  const claimed = await db.collections.isolatePublishOperations.updateAsync({
    _id: operation._id,
    state: { $ne: "published" },
    $or: [
      { lock: { $exists: false } },
      { "lock.acquiredAt": { $lt: staleBefore } },
    ],
  }, {
    $set: { lock, updatedAt: now },
  });
  if (claimed !== 1) fail("publish-in-progress", "This publication is already in progress.");
  return { operationId: operation._id, lockId: lock.id };
}

async function updateOperation(db, lease, fields) {
  const updated = await db.collections.isolatePublishOperations.updateAsync({
    _id: lease.operationId,
    "lock.id": lease.lockId,
  }, {
    $set: { ...fields, updatedAt: new Date() },
    $unset: { lastError: "" },
  });
  if (updated !== 1) fail("publish-lease-lost", "Publication lost its coordination lease.");
}

async function abandonOperation(db, lease, error) {
  await db.collections.isolatePublishOperations.updateAsync({
    _id: lease.operationId,
    "lock.id": lease.lockId,
  }, {
    $set: {
      lastError: {
        code: typeof error.code === "string" ? error.code : "publish-failed",
        message: typeof error.message === "string" ? error.message : "Publication failed.",
      },
      updatedAt: new Date(),
    },
    $unset: { lock: "" },
  });
}

async function requireEligibleAccount(db, accountId) {
  const account = await db.collections.users.findOneAsync(accountId);
  if (!await db.isAccountSignedUpOrDemoAsync(account)) {
    fail("account-not-eligible", "This account is not allowed to publish isolate apps.");
  }

  if (await db.isUserOverQuotaAsync(account) === "outOfStorage") {
    fail("quota-exhausted", "This account has no storage available for publication.");
  }
}

async function bindCandidate(db, operation) {
  const candidate = await findOwnedIsolateCandidate(
    db, operation.ownerId, operation.candidateId);
  if (!candidate) fail("candidate-not-found", "No such isolate candidate exists for this account.");
  if (!candidate.previewPackageId || !["ready", "published"].includes(candidate.status)) {
    fail("candidate-not-ready", "The isolate candidate must be preview-ready before publication.");
  }

  const bound = await db.collections.isolateCandidates.updateAsync({
    _id: candidate._id,
    ownerId: operation.ownerId,
    $or: [
      { publishingOperationId: { $exists: false } },
      { publishingOperationId: operation._id },
    ],
    $and: [{
      $or: [
        { publishedRevisionId: { $exists: false } },
        { publishedRevisionId: operation.revisionId },
      ],
    }],
  }, {
    $set: { publishingOperationId: operation._id },
  });
  if (bound !== 1) {
    fail("candidate-in-use", "This isolate candidate is already reserved or published.");
  }

  return candidate;
}

async function requireExistingTargetOwnership(db, operation) {
  if (!Object.prototype.hasOwnProperty.call(operation.target, "existingApp")) return;
  if (!await db.collections.createdIsolateApps.findOneAsync({
    _id: operation.createdAppId,
    ownerId: operation.ownerId,
    deletedAt: { $exists: false },
  })) {
    fail("app-not-found", "No such created isolate app exists for this account.");
  }
}

async function claimCreatedApp(db, operation) {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - OPERATION_LOCK_STALE_MS);
  const isNew = Object.prototype.hasOwnProperty.call(operation.target, "newApp");
  if (isNew) {
    await db.collections.createdIsolateApps.rawCollection().findOneAndUpdate({
      _id: operation.createdAppId,
      ownerId: operation.ownerId,
      appId: operation.appId,
    }, {
      $setOnInsert: {
        createdAt: now,
        appVersion: 0,
      },
      $set: {
        publishLock: { operationId: operation._id, acquiredAt: now },
        updatedAt: now,
      },
    }, { upsert: true, returnDocument: "after" });
  } else {
    const claimed = await db.collections.createdIsolateApps.updateAsync({
      _id: operation.createdAppId,
      ownerId: operation.ownerId,
      deletedAt: { $exists: false },
      $or: [
        { publishLock: { $exists: false } },
        { "publishLock.operationId": operation._id },
        { "publishLock.acquiredAt": { $lt: staleBefore } },
      ],
    }, {
      $set: {
        publishLock: { operationId: operation._id, acquiredAt: now },
        updatedAt: now,
      },
    });
    if (claimed !== 1) {
      const owned = await db.collections.createdIsolateApps.findOneAsync({
        _id: operation.createdAppId,
        ownerId: operation.ownerId,
        deletedAt: { $exists: false },
      });
      fail(owned ? "app-publish-in-progress" : "app-not-found",
          owned ? "Another revision is already being published for this app." :
            "No such created isolate app exists for this account.");
    }
  }

  const app = await db.collections.createdIsolateApps.findOneAsync({
    _id: operation.createdAppId,
    ownerId: operation.ownerId,
    "publishLock.operationId": operation._id,
  });
  if (!app) fail("app-not-found", "The publication target could not be reserved.");
  if (operation.appId && operation.appId !== app.appId) {
    fail("idempotency-conflict", "The publication operation resolved a different app identity.");
  }

  return app;
}

async function resolveVersion(db, lease, operation, app) {
  if (operation.appVersion) return operation;
  if (!Number.isSafeInteger(app.appVersion) || app.appVersion < 0 || app.appVersion >= 0xffffffff) {
    fail("version-exhausted", "This app cannot allocate another revision number.");
  }

  const fields = {
    appId: app.appId,
    appVersion: app.appVersion + 1,
    supersedesRevisionId: app.publishedRevisionId || null,
  };
  await updateOperation(db, lease, fields);
  return await db.collections.isolatePublishOperations.findOneAsync(operation._id);
}

function generatedMetadata(operation) {
  return {
    appTitle: operation.metadata.title,
    nounPhrase: operation.metadata.nounPhrase,
    shortDescription: operation.metadata.shortDescription,
    appVersion: operation.appVersion,
    marketingVersion: operation.metadata.marketingVersion || String(operation.appVersion),
  };
}

function publicationResult(operation) {
  return Object.freeze({
    createdAppId: operation.createdAppId,
    revisionId: operation.revisionId,
    appId: operation.appId,
    packageId: operation.packageId,
    appVersion: operation.appVersion,
    title: operation.metadata.title,
  });
}

function publicIsolatePublication(result) {
  return Object.freeze({
    createdAppId: result.createdAppId,
    revisionId: result.revisionId,
    appId: result.appId,
    appVersion: result.appVersion,
    title: result.title,
  });
}

async function releaseCreatedApp(db, operation) {
  await db.collections.createdIsolateApps.updateAsync({
    _id: operation.createdAppId,
    ownerId: operation.ownerId,
    "publishLock.operationId": operation._id,
  }, {
    $unset: { publishLock: "" },
    $set: { updatedAt: new Date() },
  });
}

async function runPublication(db, backend, initialOperation) {
  if (initialOperation.state === "published") {
    await releaseCreatedApp(db, initialOperation);
    return publicationResult(initialOperation);
  }

  const lease = await claimOperation(db, initialOperation);
  try {
    await requireEligibleAccount(db, initialOperation.ownerId);
    await requireExistingTargetOwnership(db, initialOperation);
    const candidate = await bindCandidate(db, initialOperation);
    const app = await claimCreatedApp(db, initialOperation);
    let operation = await resolveVersion(db, lease, initialOperation, app);

    if (!operation.packageId) {
      const generated = await materializePublishedIsolateCandidate(
        db, backend.cap(), operation.ownerId, operation.candidateId,
        operation.appId, generatedMetadata(operation));
      await updateOperation(db, lease, {
        state: "package-ready",
        packageId: generated.packageId,
      });
      operation = await db.collections.isolatePublishOperations.findOneAsync(operation._id);
    }

    const revision = {
      _id: operation.revisionId,
      ownerId: operation.ownerId,
      createdAppId: operation.createdAppId,
      appId: operation.appId,
      candidateId: operation.candidateId,
      normalizedDigest: candidate.normalizedDigest,
      packageId: operation.packageId,
      compatibilityDate: candidate.normalizedBundle.compatibilityDate,
      compatibilityFlags: candidate.normalizedBundle.compatibilityFlags,
      publishedAt: new Date(),
      metadataSnapshot: generatedMetadata(operation),
      publishOperationId: operation._id,
    };
    if (operation.supersedesRevisionId) {
      revision.supersedesRevisionId = operation.supersedesRevisionId;
    }

    const insertedRevision = await db.collections.createdIsolateRevisions.rawCollection()
      .findOneAndUpdate({
        _id: revision._id,
        publishOperationId: operation._id,
      }, {
        $setOnInsert: revision,
      }, { upsert: true, returnDocument: "after" });
    const storedRevision = resultValue(insertedRevision) ||
      await db.collections.createdIsolateRevisions.findOneAsync(revision._id);
    if (!storedRevision || storedRevision.ownerId !== revision.ownerId ||
        storedRevision.createdAppId !== revision.createdAppId ||
        storedRevision.candidateId !== revision.candidateId ||
        storedRevision.packageId !== revision.packageId ||
        storedRevision.normalizedDigest !== revision.normalizedDigest) {
      fail("revision-conflict", "The immutable publication revision conflicts with stored state.");
    }

    const appUpdated = await db.collections.createdIsolateApps.updateAsync({
      _id: operation.createdAppId,
      ownerId: operation.ownerId,
      "publishLock.operationId": operation._id,
    }, {
      $set: {
        publishedRevisionId: operation.revisionId,
        appVersion: operation.appVersion,
        title: operation.metadata.title,
        nounPhrase: operation.metadata.nounPhrase,
        shortDescription: operation.metadata.shortDescription,
        updatedAt: new Date(),
      },
    });
    if (appUpdated !== 1) {
      fail("app-publish-lease-lost", "Publication lost its target app reservation.");
    }

    await updateOperation(db, lease, { state: "revision-recorded" });

    await db.addUserActions(operation.ownerId, operation.packageId);
    if (!await db.collections.userActions.findOneAsync({
      userId: operation.ownerId,
      packageId: operation.packageId,
      appId: operation.appId,
    })) {
      fail("action-install-failed", "Publication did not install a new-grain action.");
    }

    await updateOperation(db, lease, { state: "user-action-installed" });

    const publishedAt = new Date();
    const candidateUpdated = await db.collections.isolateCandidates.updateAsync({
      _id: operation.candidateId,
      ownerId: operation.ownerId,
      publishingOperationId: operation._id,
    }, {
      $set: {
        status: "published",
        publishedRevisionId: operation.revisionId,
        publishedPackageId: operation.packageId,
        publishedAt,
      },
    });
    if (candidateUpdated !== 1) {
      fail("candidate-publish-lease-lost", "Publication lost its candidate reservation.");
    }

    const result = publicationResult(operation);
    await updateOperation(db, lease, { state: "published", publishedAt, result });
    operation = await db.collections.isolatePublishOperations.findOneAsync(operation._id);
    await db.collections.isolatePublishOperations.updateAsync({
      _id: operation._id,
      "lock.id": lease.lockId,
    }, { $unset: { lock: "" } });
    await releaseCreatedApp(db, operation);
    return result;
  } catch (error) {
    try {
      await releaseCreatedApp(db, initialOperation);
    } catch (releaseError) {
      error.releaseAppError = releaseError;
    }

    try {
      await abandonOperation(db, lease, error);
    } catch (abandonError) {
      error.abandonError = abandonError;
    }

    throw error;
  }
}

async function publishIsolateCandidate(
    db, backend, actorInput, requestIdInput, candidateIdInput, targetInput, metadataInput) {
  if (!backend || typeof backend.cap !== "function") {
    fail("invalid-context", "Isolate publication requires the Sandstorm backend.");
  }

  const actor = normalizeActor(actorInput);
  const requestId = requireIdentifier(requestIdInput, "requestId", MAX_REQUEST_ID_BYTES);
  const candidateId = requireIdentifier(candidateIdInput, "candidateId", MAX_REQUEST_ID_BYTES);
  const target = normalizeTarget(targetInput);
  const metadata = normalizeAppMetadata(metadataInput);
  const inputKey = operationInputKey(actor, candidateId, target, metadata);
  const key = `${actor.operationScope}\0${requestId}`;
  return await coalesceInFlightOperation(
    runningPublications,
    key,
    inputKey,
    async () => {
      const operation = await reservePublishOperation(
        db, actor, requestId, candidateId, target, metadata);
      return await runPublication(db, backend, operation);
    },
    () => new IsolatePublisherError(
      "idempotency-conflict",
      "This publication request ID is already running with different input."),
  );
}

export {
  IsolatePublisherError,
  encodeAppId,
  generateAppId,
  normalizeAppMetadata,
  normalizeTarget,
  publicIsolatePublication,
  publishIsolateCandidate,
};
