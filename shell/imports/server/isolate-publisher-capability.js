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

import Capnp from "/imports/server/capnp";
import { inMeteor } from "/imports/server/async-helpers";
import { getGlobalBackend } from "/imports/server/backend-instance";
import { frontendRefRegistry } from "/imports/server/frontend-ref-registry-instance";
import { PersistentImpl } from "/imports/server/persistent";
import {
  normalizeAppMetadata,
  normalizeTarget,
  publishIsolateCandidate,
} from "/imports/server/isolate-publisher-service";

const Authoring = Capnp.importSystem("sandstorm/isolate-authoring.capnp");
const AuthoringImpl = Capnp.importSystem("sandstorm/isolate-authoring-impl.capnp");

const PUBLISHER_FRONTEND_REF = "isolatePublisher";
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

function ownKeys(value, expected, label) {
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
  ownKeys(value, ["metadata", "normalizedDigest", "target"], "Isolate publication intent");
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

function schemaIntent(intent) {
  return {
    normalizedDigest: Buffer.from(intent.normalizedDigest, "hex"),
    target: intent.target,
    metadata: {
      title: intent.metadata.title,
      nounPhrase: intent.metadata.nounPhrase,
      shortDescription: intent.metadata.shortDescription,
      marketingVersion: intent.metadata.marketingVersion || "",
    },
  };
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
  ownKeys(request, ["accountId", "metadata", "normalizedDigest", "target"],
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
  const now = new Date();
  await db.collections.isolateFactoryGrants.updateAsync({
    _id: grant._id,
    kind: "publish",
    revokedAt: { $exists: false },
    consumedAt: { $exists: false },
  }, {
    $set: {
      consumedAt: now,
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

function publicResult(result) {
  return {
    createdAppId: result.createdAppId,
    revisionId: result.revisionId,
    appId: result.appId,
    appVersion: result.appVersion,
    title: result.title,
  };
}

class IsolatePublisherImpl extends PersistentImpl {
  constructor(db, saveTemplate, grantId) {
    super(db, saveTemplate);
    this.db = db;
    this.grantId = grantId;
  }

  publish(requestId) {
    return inMeteor(async () => {
      let grant = await requirePublishGrant(this.db, this.grantId);
      const candidate = await requireCommittedCandidate(this.db, grant);
      grant = await consumePublishGrant(this.db, grant, requestId);
      if (grant.result) return { result: publicResult(grant.result) };

      const result = await publishIsolateCandidate(
        this.db,
        getGlobalBackend(),
        {
          accountId: grant.ownerId,
          requestingGrainId: grant.requestingGrainId,
          operationScope: `isolate-publish-grant:${grant._id}`,
        },
        requestId,
        candidate._id,
        grant.target,
        grant.metadata);
      await completePublishGrant(this.db, grant, result);
      return { result: publicResult(result) };
    });
  }
}

function makePublisherCapability(db, saveTemplate, grantId) {
  return new Capnp.Capability(
    new IsolatePublisherImpl(db, saveTemplate, grantId),
    AuthoringImpl.PersistentIsolatePublisher);
}

function registerIsolatePublisherFrontendRef(registry) {
  registry.register({
    frontendRefField: PUBLISHER_FRONTEND_REF,
    typeId: Authoring.IsolatePublisher.typeId,

    restore(db, saveTemplate, value) {
      ownKeys(value, ["grantId"], "Saved isolate publication grant");
      return makePublisherCapability(db, saveTemplate, value.grantId);
    },

    async validate(db, session, request) {
      const { grantId, intent, requirements } = await createPublishGrant(db, session, request);
      return {
        descriptor: {
          tags: [{
            id: Authoring.IsolatePublisher.typeId,
            value: Capnp.serialize(Authoring.IsolatePublisher.PowerboxTag, schemaIntent(intent)),
          }],
        },
        requirements,
        frontendRef: { grantId },
      };
    },

    async drop(db, value) {
      ownKeys(value, ["grantId"], "Saved isolate publication grant");
      await revokePublishGrantIfUnreferenced(db, value.grantId);
    },

    async query(db, userAccountId, tagValue) {
      if (!userAccountId || !tagValue) return [];
      let intent;
      try {
        intent = normalizeIntent(Capnp.parse(Authoring.IsolatePublisher.PowerboxTag, tagValue));
      } catch (error) {
        return [];
      }

      const account = await db.collections.users.findOneAsync(userAccountId);
      if (!await db.isAccountSignedUpOrDemoAsync(account)) return [];
      let targetApp;
      try {
        targetApp = await requireTargetOwnership(db, userAccountId, intent.target);
      } catch (error) {
        return [];
      }

      const isUpdate = Object.prototype.hasOwnProperty.call(intent.target, "existingApp");
      return [{
        _id: `frontendref-isolate-publisher-${userAccountId}`,
        frontendRef: {
          [PUBLISHER_FRONTEND_REF]: {
            accountId: userAccountId,
            normalizedDigest: intent.normalizedDigest,
            target: intent.target,
            metadata: intent.metadata,
          },
        },
        cardTemplate: "isolatePublisherPowerboxCard",
        publishIntent: {
          action: isUpdate ? "Publish an update to" : "Publish a new app",
          title: intent.metadata.title,
          targetTitle: targetApp && targetApp.title,
          digest: intent.normalizedDigest,
        },
      }];
    },
  });
}

registerIsolatePublisherFrontendRef(frontendRefRegistry);

export {
  IsolatePublisherGrantError,
  completePublishGrant,
  consumePublishGrant,
  createPublishGrant,
  normalizeIntent,
  requirePublishGrant,
  revokePublishGrantIfUnreferenced,
};
