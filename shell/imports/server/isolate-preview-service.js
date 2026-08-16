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

import {
  createGrainFromResolvedAction,
  recoverInitializingPreviewGrain,
  updatePreviewGrainPackage,
} from "/imports/server/grain-creation";
import { reserveIsolateCandidate } from "/imports/server/isolate-candidates";
import { materializeIsolateCandidate } from "/imports/server/isolate-package-service";

class IsolatePreviewError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "IsolatePreviewError";
    this.code = code;
  }
}

const previewQueues = new Map();
const PREVIEW_LOCK_STALE_MS = 5 * 60 * 1000;

function fail(code, message) {
  throw new IsolatePreviewError(code, message);
}

async function requireEligibleAccount(db, accountId, creatingGrain) {
  const account = await db.collections.users.findOneAsync(accountId);
  if (!await db.isAccountSignedUpOrDemoAsync(account)) {
    fail("account-not-eligible", "This account is not allowed to create preview grains.");
  }

  const quotaReason = await db.isUserOverQuotaAsync(account);
  if (quotaReason && (creatingGrain || quotaReason === "outOfStorage")) {
    fail("quota-exhausted", "This account cannot create another preview grain.");
  }
}

async function findPreviewGrain(db, accountId, operationScope) {
  return await db.collections.grains.findOneAsync({
    userId: accountId,
    "isolatePreview.scope": operationScope,
  });
}

function resultValue(result) {
  if (result && Object.prototype.hasOwnProperty.call(result, "value")) return result.value;
  return result;
}

async function claimPreviewSlot(db, candidate) {
  const now = new Date();
  const inserted = await db.collections.isolatePreviewSlots.rawCollection().findOneAndUpdate({
    ownerId: candidate.ownerId,
    operationScope: candidate.operationScope,
  }, {
    $setOnInsert: {
      _id: Random.id(),
      ownerId: candidate.ownerId,
      operationScope: candidate.operationScope,
      createdAt: now,
    },
  }, { upsert: true, returnDocument: "after" });
  const slot = resultValue(inserted) || await db.collections.isolatePreviewSlots.findOneAsync({
    ownerId: candidate.ownerId,
    operationScope: candidate.operationScope,
  });
  if (!slot) fail("preview-slot-failed", "Could not reserve the isolate preview slot.");

  const lock = {
    id: Random.id(),
    candidateId: candidate._id,
    acquiredAt: now,
  };
  const staleBefore = new Date(now.getTime() - PREVIEW_LOCK_STALE_MS);
  const claimed = await db.collections.isolatePreviewSlots.updateAsync({
    _id: slot._id,
    $or: [
      { lock: { $exists: false } },
      { "lock.acquiredAt": { $lt: staleBefore } },
    ],
  }, {
    $set: { lock, updatedAt: now },
  });
  if (claimed !== 1) {
    fail("preview-in-progress", "Another request is currently updating this preview.");
  }

  return { slotId: slot._id, lockId: lock.id };
}

async function releasePreviewSlot(db, lease, grainId) {
  const update = { $unset: { lock: "" }, $set: { updatedAt: new Date() } };
  if (grainId) update.$set.grainId = grainId;
  const released = await db.collections.isolatePreviewSlots.updateAsync({
    _id: lease.slotId,
    "lock.id": lease.lockId,
  }, update);
  if (released !== 1) {
    fail("preview-lease-lost", "The isolate preview operation lost its coordination lease.");
  }
}

async function abandonPreviewSlot(db, lease) {
  await db.collections.isolatePreviewSlots.updateAsync({
    _id: lease.slotId,
    "lock.id": lease.lockId,
  }, {
    $unset: { lock: "" },
    $set: { updatedAt: new Date() },
  });
}

async function refreshPreviewSlot(db, lease) {
  const refreshed = await db.collections.isolatePreviewSlots.updateAsync({
    _id: lease.slotId,
    "lock.id": lease.lockId,
  }, {
    $set: { "lock.acquiredAt": new Date(), updatedAt: new Date() },
  });
  if (refreshed !== 1) {
    fail("preview-lease-lost", "The isolate preview operation lost its coordination lease.");
  }
}

async function withPreviewSlot(db, candidate, callback) {
  const lease = await claimPreviewSlot(db, candidate);
  try {
    const result = await callback(lease);
    await releasePreviewSlot(db, lease, result.grainId);
    return result;
  } catch (error) {
    try {
      await abandonPreviewSlot(db, lease);
    } catch (abandonError) {
      error.abandonError = abandonError;
    }

    throw error;
  }
}

async function installCandidateInPreviewGrainLocked(db, backend, candidate) {
  let grain = await findPreviewGrain(db, candidate.ownerId, candidate.operationScope);
  await requireEligibleAccount(db, candidate.ownerId, !grain);

  if (grain && grain.trashed) {
    fail("preview-grain-trashed", "The preview grain is in the trash.");
  }

  if (grain && await recoverInitializingPreviewGrain(db, backend, grain)) {
    grain = null;
  }

  const title = `${candidate.previewMetadata.appTitle} preview`;
  if (!grain) {
    try {
      grain = await createGrainFromResolvedAction(db, backend, {
        ownerId: candidate.ownerId,
        packageId: candidate.previewPackageId,
        actionIndex: 0,
        title,
        isolatePreview: {
          scope: candidate.operationScope,
          candidateId: candidate._id,
        },
      });
    } catch (error) {
      if (error.code !== "preview-grain-exists") throw error;
      grain = await findPreviewGrain(db, candidate.ownerId, candidate.operationScope);
      if (!grain) throw error;
    }
  }

  if (grain.isolatePreview.candidateId !== candidate._id ||
      grain.packageId !== candidate.previewPackageId) {
    grain = await updatePreviewGrainPackage(db, backend, grain, {
      ownerId: candidate.ownerId,
      packageId: candidate.previewPackageId,
      actionIndex: 0,
      candidateId: candidate._id,
      title,
    });
  }

  const previewedAt = new Date();
  await db.collections.isolateCandidates.updateAsync({
    _id: candidate._id,
    ownerId: candidate.ownerId,
    previewPackageId: candidate.previewPackageId,
  }, {
    $set: {
      previewGrainId: grain._id,
      previewedAt,
    },
  });
  return grain;
}

async function installCandidateInPreviewGrain(db, backend, candidate) {
  return (await withPreviewSlot(db, candidate, async () => {
    const grain = await installCandidateInPreviewGrainLocked(db, backend, candidate);
    return { grain, grainId: grain._id };
  })).grain;
}

function enqueuePreview(accountId, operationScope, callback) {
  const key = `${accountId}\0${operationScope}`;
  const previous = previewQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(callback);
  previewQueues.set(key, current);
  current.finally(() => {
    if (previewQueues.get(key) === current) previewQueues.delete(key);
  }).catch(() => {});
  return current;
}

async function previewIsolateBundle(db, backend, actor, requestId, bundle, metadata) {
  if (!backend || typeof backend.cap !== "function") {
    fail("invalid-context", "Isolate preview requires the Sandstorm backend.");
  }

  const candidate = await reserveIsolateCandidate(db, actor, requestId, bundle);
  return await enqueuePreview(candidate.ownerId, candidate.operationScope, async () => {
    const existingGrain = await findPreviewGrain(
      db, candidate.ownerId, candidate.operationScope);
    await requireEligibleAccount(db, candidate.ownerId, !existingGrain);
    return await withPreviewSlot(db, candidate, async (lease) => {
      const materialized = await materializeIsolateCandidate(
        db, backend.cap(), candidate.ownerId, candidate._id, metadata);
      await refreshPreviewSlot(db, lease);
      const grain = await installCandidateInPreviewGrainLocked(db, backend, materialized);
      const readyCandidate = await db.collections.isolateCandidates.findOneAsync(candidate._id);
      return { candidate: readyCandidate, grainId: grain._id };
    });
  });
}

export {
  IsolatePreviewError,
  findPreviewGrain,
  installCandidateInPreviewGrain,
  previewIsolateBundle,
};
