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

import { Meteor } from "meteor/meteor";
import { Random } from "meteor/random";

import {
  normalizeAppMetadata,
  normalizeTarget,
} from "/imports/server/isolate-publisher-service";

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MAX_REQUEST_ID_BYTES = 256;

class IsolatePublisherGrantError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "IsolatePublisherGrantError";
    this.code = code;
    this.kjType = "failed";
  }
}

function fail(code, message) {
  throw new IsolatePublisherGrantError(code, message);
}

function requireOwnKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid-request", `${label} must be an object.`);
  }

  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length ||
      keys.some((key, index) => key !== expected[index])) {
    fail("invalid-request", `${label} has unexpected fields.`);
  }
}

function normalizeDigest(value) {
  if (typeof value === "string" && DIGEST_PATTERN.test(value)) return value;
  if (value instanceof Uint8Array && value.length === 32) {
    return Buffer.from(value).toString("hex");
  }

  fail("invalid-candidate", "An isolate publisher requires a 32-byte candidate digest.");
}

function normalizeRequestId(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") ||
      Buffer.byteLength(value, "utf8") > MAX_REQUEST_ID_BYTES) {
    fail("invalid-request", "The publication request ID is invalid.");
  }

  return value;
}

function normalizeIntent(value) {
  requireOwnKeys(value, ["metadata", "normalizedDigest", "target"],
    "Isolate publication intent");
  try {
    const metadata = { ...value.metadata };
    if (metadata.marketingVersion === "" || metadata.marketingVersion === null) {
      delete metadata.marketingVersion;
    }

    return Object.freeze({
      normalizedDigest: normalizeDigest(value.normalizedDigest),
      target: normalizeTarget(value.target),
      metadata: normalizeAppMetadata(metadata),
    });
  } catch (error) {
    if (error instanceof IsolatePublisherGrantError) throw error;
    fail(error.code || "invalid-request", error.message || "The publication intent is invalid.");
  }
}

async function requireAuthoringOwner(db, session, accountId) {
  if (!session.userId || accountId !== session.userId) {
    throw new Meteor.Error(403, "An isolate publication must be authorized by its user.");
  }

  const account = await db.collections.users.findOneAsync(session.userId);
  if (!await db.isAccountSignedUpOrDemoAsync(account)) {
    throw new Meteor.Error(403, "This account cannot publish isolate apps.");
  }

  const grain = await db.collections.grains.findOneAsync(session.grainId);
  if (!grain || grain.userId !== session.userId || grain.trashed) {
    throw new Meteor.Error(403,
      "Only the owner of an active authoring grain can grant isolate publication authority.");
  }
}

async function requireTargetOwnership(db, ownerId, target) {
  if (!Object.prototype.hasOwnProperty.call(target, "existingApp")) return null;
  const app = await db.collections.createdIsolateApps.findOneAsync({
    _id: target.existingApp,
    ownerId,
    deletedAt: { $exists: false },
    publishedRevisionId: { $exists: true },
  });
  if (!app) fail("app-not-found", "The requested isolate app update target does not exist.");
  return app;
}

async function requireGrantCandidate(db, ownerId, requestingGrainId, normalizedDigest) {
  const candidate = await db.collections.isolateCandidates.findOneAsync({
    ownerId,
    requestingGrainId,
    normalizedDigest,
    status: "ready",
    previewPackageId: { $exists: true },
  }, {
    sort: { createdAt: -1 },
  });
  if (!candidate) {
    fail("candidate-not-found",
      "No preview-ready isolate candidate matches this publication request.");
  }

  return candidate;
}

async function createPublishGrant(db, session, request) {
  requireOwnKeys(request, ["accountId", "metadata", "normalizedDigest", "target"],
    "Isolate publication grant request");
  if (typeof request.accountId !== "string") {
    fail("invalid-request", "The publication account ID is invalid.");
  }

  await requireAuthoringOwner(db, session, request.accountId);
  const intent = normalizeIntent({
    normalizedDigest: request.normalizedDigest,
    target: request.target,
    metadata: request.metadata,
  });
  await requireTargetOwnership(db, session.userId, intent.target);
  const candidate = await requireGrantCandidate(
    db, session.userId, session.grainId, intent.normalizedDigest);
  const grantId = Random.id();
  await db.collections.isolateFactoryGrants.insertAsync({
    _id: grantId,
    kind: "publish",
    ownerId: session.userId,
    requestingGrainId: session.grainId,
    candidateId: candidate._id,
    candidateDigest: intent.normalizedDigest,
    target: intent.target,
    metadata: intent.metadata,
    createdAt: new Date(),
  });

  return {
    grantId,
    intent,
    requirements: [{
      permissionsHeld: {
        accountId: session.userId,
        grainId: session.grainId,
        permissions: [],
      },
    }],
  };
}

async function requirePublishGrant(db, grantId) {
  if (typeof grantId !== "string" || grantId.length === 0) {
    fail("invalid-grant", "The isolate publication grant is invalid.");
  }

  const grant = await db.collections.isolateFactoryGrants.findOneAsync({
    _id: grantId,
    kind: "publish",
    revokedAt: { $exists: false },
  });
  if (!grant) fail("grant-revoked", "The isolate publication grant has been revoked.");
  if (grant.expiresAt && grant.expiresAt <= new Date()) {
    fail("grant-expired", "The isolate publication grant has expired.");
  }

  const grain = await db.collections.grains.findOneAsync({
    _id: grant.requestingGrainId,
    userId: grant.ownerId,
    trashed: { $ne: true },
  });
  if (!grain) {
    fail("grant-revoked", "The authoring grain for this publication grant is unavailable.");
  }

  return grant;
}

async function consumePublishGrant(db, grant, requestIdInput) {
  const requestId = normalizeRequestId(requestIdInput);
  await db.collections.isolateFactoryGrants.updateAsync({
    _id: grant._id,
    kind: "publish",
    revokedAt: { $exists: false },
    consumedAt: { $exists: false },
  }, {
    $set: {
      consumedAt: new Date(),
      consumedRequestId: requestId,
    },
  });

  const consumed = await requirePublishGrant(db, grant._id);
  if (consumed.consumedRequestId !== requestId) {
    fail("grant-consumed", "This one-shot isolate publication grant has already been used.");
  }

  return consumed;
}

async function completePublishGrant(db, grant, result) {
  const updated = await db.collections.isolateFactoryGrants.updateAsync({
    _id: grant._id,
    kind: "publish",
    consumedRequestId: grant.consumedRequestId,
  }, {
    $set: { result, completedAt: new Date() },
  });
  if (updated !== 1) fail("grant-state-lost", "The publication grant lost its durable state.");
}

async function revokePublishGrantIfUnreferenced(db, grantId) {
  const savedCopy = await db.collections.apiTokens.findOneAsync({
    "frontendRef.isolatePublisher.grantId": grantId,
    revoked: { $ne: true },
  });
  if (savedCopy) return false;

  const result = await db.collections.isolateFactoryGrants.updateAsync({
    _id: grantId,
    kind: "publish",
    revokedAt: { $exists: false },
  }, {
    $set: { revokedAt: new Date() },
  });
  return result > 0;
}

async function requireCommittedCandidate(db, grant) {
  const candidate = await db.collections.isolateCandidates.findOneAsync({
    _id: grant.candidateId,
    ownerId: grant.ownerId,
    requestingGrainId: grant.requestingGrainId,
    normalizedDigest: grant.candidateDigest,
    status: { $in: ["ready", "published"] },
  });
  if (!candidate) {
    fail("candidate-mismatch",
      "The candidate bound to this isolate publication grant is unavailable.");
  }

  return candidate;
}

export {
  IsolatePublisherGrantError,
  completePublishGrant,
  consumePublishGrant,
  createPublishGrant,
  normalizeIntent,
  requireCommittedCandidate,
  requireOwnKeys,
  requirePublishGrant,
  requireTargetOwnership,
  revokePublishGrantIfUnreferenced,
};
