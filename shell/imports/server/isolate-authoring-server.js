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
import { getGlobalBackend } from "/imports/server/backend-instance";
import { IsolateBundleError } from "/imports/server/isolate-bundle";
import {
  IsolateCandidateError,
  findOwnedIsolateCandidate,
} from "/imports/server/isolate-candidates";
import {
  IsolatePreviewError,
  previewIsolateBundle,
  resetIsolatePreview,
} from "/imports/server/isolate-preview-service";
import {
  IsolatePublisherError,
  publishIsolateCandidate,
} from "/imports/server/isolate-publisher-service";

const AUTHORING_SESSION_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

function invalidSession() {
  throw new Meteor.Error(400, "The isolate authoring session ID is invalid.");
}

function makeShellIsolateActor(accountId, authoringSessionId) {
  if (typeof accountId !== "string" || accountId.length === 0) {
    throw new Meteor.Error(403, "You must be logged in to author an isolate app.");
  }

  if (typeof authoringSessionId !== "string" ||
      !AUTHORING_SESSION_PATTERN.test(authoringSessionId)) {
    invalidSession();
  }

  return Object.freeze({
    accountId,
    // The browser-local session ID is retained for wire compatibility but is
    // not allowed to multiply hidden preview grains. The built-in authoring
    // surface has one stable preview scope per account.
    operationScope: `shell-isolate-authoring:${accountId}`,
  });
}

function candidateSummary(candidate) {
  return Object.freeze({
    candidateId: candidate._id,
    normalizedDigest: candidate.normalizedDigest,
    compatibilityDate: candidate.normalizedBundle.compatibilityDate,
    compatibilityFlags: candidate.normalizedBundle.compatibilityFlags,
    createdAt: candidate.createdAt,
    previewedAt: candidate.previewedAt,
    publishedRevisionId: candidate.publishedRevisionId,
    status: candidate.status,
  });
}

function publicationSummary(result) {
  return Object.freeze({
    createdAppId: result.createdAppId,
    revisionId: result.revisionId,
    appId: result.appId,
    appVersion: result.appVersion,
    title: result.title,
  });
}

async function previewIsolateFromShell(
    db, backend, accountId, authoringSessionId, requestId, bundle, metadata) {
  const actor = makeShellIsolateActor(accountId, authoringSessionId);
  const result = await previewIsolateBundle(db, backend, actor, requestId, bundle, metadata);
  return Object.freeze({
    candidate: candidateSummary(result.candidate),
    grainId: result.grainId,
  });
}

async function resetIsolatePreviewFromShell(
    db, backend, accountId, authoringSessionId) {
  const actor = makeShellIsolateActor(accountId, authoringSessionId);
  const result = await resetIsolatePreview(db, backend, actor);
  return Object.freeze({ grainId: result.grainId });
}

async function publishIsolateFromShell(
    db, backend, accountId, authoringSessionId, requestId, candidateId, target, metadata) {
  const actor = makeShellIsolateActor(accountId, authoringSessionId);
  const candidate = await findOwnedIsolateCandidate(db, accountId, candidateId);
  if (!candidate || candidate.operationScope !== actor.operationScope) {
    throw new IsolatePublisherError(
      "candidate-not-found", "No such isolate candidate exists in this authoring session.");
  }

  const result = await publishIsolateCandidate(
    db, backend, actor, requestId, candidateId, target, metadata);
  return publicationSummary(result);
}

function errorStatus(error) {
  if ([
    "account-not-eligible", "quota-exhausted", "candidate-in-use",
  ].includes(error.code)) return 403;
  if (["candidate-not-found", "app-not-found", "preview-not-found"].includes(error.code)) {
    return 404;
  }

  if ([
    "idempotency-conflict", "preview-in-progress", "publish-in-progress",
    "app-publish-in-progress", "preview-changed", "preview-grain-trashed",
  ].includes(error.code)) return 409;
  return 400;
}

async function runAuthoringMethod(callback) {
  try {
    return await callback();
  } catch (error) {
    if (error instanceof Meteor.Error) throw error;
    if (error instanceof IsolateBundleError || error instanceof IsolateCandidateError ||
        error instanceof IsolatePreviewError || error instanceof IsolatePublisherError) {
      throw new Meteor.Error(errorStatus(error), error.message, error.code);
    }

    console.error("Unexpected isolate authoring failure:", error);
    throw new Meteor.Error(500, "The isolate authoring operation failed unexpectedly.");
  }
}

Meteor.methods({
  async isolateAuthoringPreview(authoringSessionId, requestId, bundle, metadata) {
    check(authoringSessionId, String);
    check(requestId, String);
    return await runAuthoringMethod(() => previewIsolateFromShell(
      globalDb, getGlobalBackend(), this.userId,
      authoringSessionId, requestId, bundle, metadata));
  },

  async isolateAuthoringResetPreview(authoringSessionId) {
    check(authoringSessionId, String);
    return await runAuthoringMethod(() => resetIsolatePreviewFromShell(
      globalDb, getGlobalBackend(), this.userId, authoringSessionId));
  },

  async isolateAuthoringPublish(
      authoringSessionId, requestId, candidateId, target, metadata) {
    check(authoringSessionId, String);
    check(requestId, String);
    check(candidateId, String);
    return await runAuthoringMethod(() => publishIsolateFromShell(
      globalDb, getGlobalBackend(), this.userId,
      authoringSessionId, requestId, candidateId, target, metadata));
  },
});

Meteor.publish("isolateAuthoringState", function (authoringSessionId) {
  check(authoringSessionId, String);
  if (!this.userId) return [];

  let actor;
  try {
    actor = makeShellIsolateActor(this.userId, authoringSessionId);
  } catch (error) {
    this.error(error);
    return [];
  }

  return [
    globalDb.collections.isolateCandidates.find({
      ownerId: actor.accountId,
      operationScope: actor.operationScope,
    }, {
      fields: {
        normalizedDigest: 1,
        "normalizedBundle.compatibilityDate": 1,
        "normalizedBundle.compatibilityFlags": 1,
        createdAt: 1,
        status: 1,
        previewGrainId: 1,
        previewedAt: 1,
        publishedRevisionId: 1,
        publishedAt: 1,
      },
    }),
    globalDb.collections.isolatePreviewSlots.find({
      ownerId: actor.accountId,
      operationScope: actor.operationScope,
    }, {
      fields: { grainId: 1, candidateId: 1, updatedAt: 1 },
    }),
    globalDb.collections.createdIsolateApps.find({
      ownerId: actor.accountId,
      deletedAt: { $exists: false },
      publishedRevisionId: { $exists: true },
    }, {
      fields: {
        appId: 1,
        publishedRevisionId: 1,
        appVersion: 1,
        title: 1,
        nounPhrase: 1,
        shortDescription: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    }),
    globalDb.collections.createdIsolateRevisions.find({ ownerId: actor.accountId }, {
      fields: {
        createdAppId: 1,
        appId: 1,
        candidateId: 1,
        normalizedDigest: 1,
        compatibilityDate: 1,
        compatibilityFlags: 1,
        publishedAt: 1,
        supersedesRevisionId: 1,
        metadataSnapshot: 1,
      },
    }),
  ];
});

export {
  candidateSummary,
  makeShellIsolateActor,
  previewIsolateFromShell,
  publicationSummary,
  publishIsolateFromShell,
  resetIsolatePreviewFromShell,
};
