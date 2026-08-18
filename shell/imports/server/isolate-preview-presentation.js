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
import { check } from "meteor/check";

import { globalDb } from "/imports/db-deprecated";

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const PREVIEW_SCOPE_PREFIX = "isolate-preview-grant:";

class IsolatePreviewPresentationError extends Error {
  constructor(code, message, status = 404) {
    super(message);
    this.name = "IsolatePreviewPresentationError";
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status) {
  throw new IsolatePreviewPresentationError(code, message, status);
}

function grantIdForCandidate(candidate) {
  if (typeof candidate.operationScope !== "string" ||
      !candidate.operationScope.startsWith(PREVIEW_SCOPE_PREFIX)) {
    return null;
  }

  const grantId = candidate.operationScope.slice(PREVIEW_SCOPE_PREFIX.length);
  return grantId || null;
}

async function resolveIsolatePreviewForAuthoringGrain(
    db, accountId, requestingGrainId, normalizedDigest) {
  if (typeof normalizedDigest !== "string" || !DIGEST_PATTERN.test(normalizedDigest)) {
    fail("invalid-preview-digest", "The isolate preview digest is invalid.", 400);
  }

  if (typeof accountId !== "string" || accountId.length === 0) {
    fail("preview-not-authorized", "You must be signed in to open an isolate preview.", 403);
  }

  if (typeof requestingGrainId !== "string" || requestingGrainId.length === 0) {
    fail("preview-not-authorized", "The isolate authoring grain is invalid.", 403);
  }

  const account = await db.collections.users.findOneAsync(accountId);
  if (!await db.isAccountSignedUpOrDemoAsync(account)) {
    fail("preview-not-authorized", "This account cannot open isolate previews.", 403);
  }

  const authoringGrain = await db.collections.grains.findOneAsync({
    _id: requestingGrainId,
    userId: accountId,
    trashed: { $ne: true },
  });
  if (!authoringGrain) {
    fail("preview-not-authorized", "The isolate authoring grain is unavailable.", 403);
  }

  const candidates = await db.collections.isolateCandidates.find({
    ownerId: accountId,
    requestingGrainId,
    normalizedDigest,
    status: { $in: ["ready", "published"] },
    previewGrainId: { $exists: true },
  }, {
    sort: { createdAt: -1 },
  }).fetchAsync();

  const now = new Date();
  for (const candidate of candidates) {
    const grantId = grantIdForCandidate(candidate);
    if (!grantId) continue;

    const grant = await db.collections.isolateFactoryGrants.findOneAsync({
      _id: grantId,
      kind: "preview",
      ownerId: accountId,
      requestingGrainId,
      revokedAt: { $exists: false },
    });
    if (!grant || (grant.expiresAt && grant.expiresAt <= now)) continue;

    const previewGrain = await db.collections.grains.findOneAsync({
      _id: candidate.previewGrainId,
      userId: accountId,
      packageId: candidate.previewPackageId,
      trashed: { $ne: true },
      "isolatePreview.scope": candidate.operationScope,
      "isolatePreview.candidateId": candidate._id,
    });
    if (!previewGrain) continue;

    return Object.freeze({
      grainId: previewGrain._id,
      normalizedDigest: candidate.normalizedDigest,
      title: candidate.previewMetadata && candidate.previewMetadata.appTitle || "Isolate preview",
    });
  }

  fail("preview-not-current",
    "No current isolate preview matches this authoring grain and candidate.", 404);
}

Meteor.methods({
  async resolveIsolatePreviewForAuthoring(requestingGrainId, normalizedDigest) {
    check(requestingGrainId, String);
    check(normalizedDigest, String);
    try {
      return await resolveIsolatePreviewForAuthoringGrain(
        globalDb, this.userId, requestingGrainId, normalizedDigest);
    } catch (error) {
      if (error instanceof IsolatePreviewPresentationError) {
        throw new Meteor.Error(error.status, error.message, error.code);
      }

      console.error("Unexpected isolate preview presentation failure:", error);
      throw new Meteor.Error(500, "The isolate preview could not be opened.");
    }
  },
});

export {
  IsolatePreviewPresentationError,
  resolveIsolatePreviewForAuthoringGrain,
};
