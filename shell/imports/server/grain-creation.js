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

import { SandstormDb } from "/imports/sandstorm-db/db";

class GrainCreationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GrainCreationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new GrainCreationError(code, message);
}

function requireText(value, field) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail("invalid-grain-parameter", `${field} must be a non-empty string without NUL characters.`);
  }

  return value;
}

async function resolvePackageAction(db, packageId, actionIndex = 0) {
  requireText(packageId, "packageId");
  if (!Number.isSafeInteger(actionIndex) || actionIndex < 0) {
    fail("invalid-grain-parameter", "actionIndex must be a non-negative integer.");
  }

  const pkg = await db.collections.packages.findOneAsync({
    _id: packageId,
    status: "ready",
  });
  if (!pkg) {
    fail("package-not-ready", "The resolved package is not installed and ready.");
  }

  const actions = pkg.manifest && pkg.manifest.actions;
  const action = Array.isArray(actions) && actions[actionIndex];
  if (!action || !action.command || typeof action.command !== "object") {
    fail("missing-package-action", "The resolved package does not contain the requested action.");
  }

  if (!pkg.manifest.continueCommand || typeof pkg.manifest.continueCommand !== "object") {
    fail("missing-continue-command", "The resolved package does not contain a continue command.");
  }

  return { pkg, action };
}

async function cleanupFailedNewGrain(db, backend, grain) {
  await backend.deleteGrain(grain._id, grain.userId);
  await db.collections.grains.removeAsync({
    _id: grain._id,
    userId: grain.userId,
    "isolatePreview.initializing": true,
  });
}

async function createGrainFromResolvedAction(db, backend, options) {
  if (!backend || typeof backend.startGrainInternal !== "function" ||
      typeof backend.deleteGrain !== "function") {
    fail("invalid-grain-context", "Grain creation requires the Sandstorm backend.");
  }

  const ownerId = requireText(options && options.ownerId, "ownerId");
  const title = requireText(options && options.title, "title");
  const preview = options && options.isolatePreview;
  if (!preview || typeof preview !== "object") {
    fail("invalid-grain-parameter", "Isolate preview grain metadata is required.");
  }

  const scope = requireText(preview.scope, "isolatePreview.scope");
  const candidateId = requireText(preview.candidateId, "isolatePreview.candidateId");
  const { pkg, action } = await resolvePackageAction(
    db, options.packageId, options.actionIndex || 0);
  const grain = {
    _id: Random.id(22),
    packageId: pkg._id,
    appId: pkg.appId,
    appVersion: pkg.manifest.appVersion,
    userId: ownerId,
    identityId: SandstormDb.generateIdentityId(),
    title,
    private: true,
    size: 0,
    isolatePreview: {
      scope,
      candidateId,
      initializing: true,
    },
  };

  try {
    await db.collections.grains.insertAsync(grain);
  } catch (error) {
    if (await db.collections.grains.findOneAsync({
      userId: ownerId,
      "isolatePreview.scope": scope,
    })) {
      fail("preview-grain-exists", "This preview slot already has a grain.");
    }

    throw error;
  }

  try {
    await backend.startGrainInternal(
      pkg._id, grain._id, ownerId, action.command, true, false, false);
    await db.collections.grains.updateAsync({
      _id: grain._id,
      userId: ownerId,
      "isolatePreview.initializing": true,
    }, {
      $unset: { "isolatePreview.initializing": "" },
    });
    return await db.collections.grains.findOneAsync(grain._id);
  } catch (error) {
    try {
      await cleanupFailedNewGrain(db, backend, grain);
    } catch (cleanupError) {
      error.cleanupError = cleanupError;
    }

    throw error;
  }
}

async function recoverInitializingPreviewGrain(db, backend, grain) {
  if (!grain.isolatePreview || !grain.isolatePreview.initializing) return false;
  await cleanupFailedNewGrain(db, backend, grain);
  return true;
}

async function updatePreviewGrainPackage(db, backend, grain, options) {
  if (!backend || typeof backend.startGrainInternal !== "function" ||
      typeof backend.shutdownGrain !== "function") {
    fail("invalid-grain-context", "Preview updates require the Sandstorm backend.");
  }

  const ownerId = requireText(options && options.ownerId, "ownerId");
  const title = requireText(options && options.title, "title");
  const candidateId = requireText(options && options.candidateId, "candidateId");
  if (!grain || grain.userId !== ownerId || !grain.isolatePreview) {
    fail("invalid-preview-grain", "The target is not an isolate preview owned by this account.");
  }

  const { pkg } = await resolvePackageAction(db, options.packageId, options.actionIndex || 0);
  if (grain.packageId !== pkg._id) {
    await backend.shutdownGrain(grain._id, ownerId, true);
  }

  const selector = {
    _id: grain._id,
    userId: ownerId,
    "isolatePreview.scope": grain.isolatePreview.scope,
  };
  const changed = await db.collections.grains.updateAsync(selector, {
    $set: {
      packageId: pkg._id,
      appId: pkg.appId,
      appVersion: pkg.manifest.appVersion,
      packageSalt: Random.secret(),
      title,
      "isolatePreview.candidateId": candidateId,
    },
    $unset: {
      cachedViewInfo: "",
      "isolatePreview.initializing": "",
    },
  });
  if (changed !== 1) {
    fail("preview-grain-changed", "The preview grain changed while its package was being updated.");
  }

  await backend.startGrainInternal(
    pkg._id, grain._id, ownerId, pkg.manifest.continueCommand, false, false, false);
  return await db.collections.grains.findOneAsync(grain._id);
}

export {
  GrainCreationError,
  createGrainFromResolvedAction,
  recoverInitializingPreviewGrain,
  resolvePackageAction,
  updatePreviewGrainPackage,
};
