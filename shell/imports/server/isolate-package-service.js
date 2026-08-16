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

import { IsolateCandidateError, findOwnedIsolateCandidate } from
  "/imports/server/isolate-candidates";

const METADATA_LIMITS = Object.freeze({
  appTitle: 256,
  nounPhrase: 128,
  shortDescription: 1024,
  marketingVersion: 64,
});

const runningMaterializations = new Map();

function fail(code, message) {
  throw new IsolateCandidateError(code, message);
}

function normalizeText(value, field, maximumBytes, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    fail("invalid-metadata", `${field} must be ${allowEmpty ? "a string" : "a non-empty string"}.`);
  }

  if (value.includes("\0")) {
    fail("invalid-metadata", `${field} must not contain a NUL character.`);
  }

  if (Buffer.byteLength(value, "utf8") > maximumBytes) {
    fail("invalid-metadata", `${field} exceeds the ${maximumBytes}-byte limit.`);
  }

  return value;
}

function normalizeGeneratedIsolateMetadata(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("invalid-metadata", "Generated isolate package metadata must be an object.");
  }

  if (!Number.isSafeInteger(input.appVersion) || input.appVersion < 0 ||
      input.appVersion > 0xffffffff) {
    fail("invalid-metadata", "appVersion must be an unsigned 32-bit integer.");
  }

  return Object.freeze({
    appTitle: normalizeText(input.appTitle, "appTitle", METADATA_LIMITS.appTitle),
    nounPhrase: normalizeText(input.nounPhrase, "nounPhrase", METADATA_LIMITS.nounPhrase),
    shortDescription: normalizeText(
      input.shortDescription, "shortDescription", METADATA_LIMITS.shortDescription, true),
    appVersion: input.appVersion,
    marketingVersion: normalizeText(
      input.marketingVersion, "marketingVersion", METADATA_LIMITS.marketingVersion),
  });
}

function metadataKey(metadata) {
  return JSON.stringify(metadata);
}

function bundleToWorkerSource(bundle) {
  return {
    formatVersion: bundle.formatVersion,
    mainModule: bundle.mainModule,
    compatibilityDate: bundle.compatibilityDate,
    compatibilityFlags: bundle.compatibilityFlags,
    modules: bundle.modules.map((module) => {
      const result = { name: module.name };
      result[module.type] = Buffer.from(module.content, "utf8");
      return result;
    }),
    bindings: [],
  };
}

function packageResult(result) {
  if (!result || typeof result.packageId !== "string" || result.packageId.length === 0 ||
      typeof result.appId !== "string" || result.appId.length === 0 ||
      !result.manifest || typeof result.manifest !== "object") {
    fail("package-generation-failed", "The backend returned an invalid generated package.");
  }

  return result;
}

function storedError(error) {
  return {
    code: typeof error.code === "string" ? error.code : "package-generation-failed",
    message: typeof error.message === "string" ? error.message : "Package generation failed.",
  };
}

async function claimMetadata(db, accountId, candidateId, metadata) {
  await db.collections.isolateCandidates.updateAsync({
    _id: candidateId,
    ownerId: accountId,
    previewMetadata: { $exists: false },
  }, {
    $set: { previewMetadata: metadata },
  });

  const candidate = await findOwnedIsolateCandidate(db, accountId, candidateId);
  if (!candidate) {
    fail("candidate-not-found", "No such isolate candidate exists for this account.");
  }

  if (metadataKey(candidate.previewMetadata) !== metadataKey(metadata)) {
    fail("idempotency-conflict",
        "This candidate is already being prepared with different package metadata.");
  }

  return candidate;
}

async function registerGeneratedPackage(db, generated, accountId, published) {
  const update = {
    $setOnInsert: {
      manifest: generated.manifest,
      status: "ready",
      progress: 1,
      error: null,
    },
    $addToSet: { generatedIsolateOwners: accountId },
  };
  if (published) {
    update.$addToSet.generatedIsolatePublishedOwners = accountId;
  }

  try {
    await db.collections.packages.rawCollection().findOneAndUpdate({
      _id: generated.packageId,
      appId: generated.appId,
      generatedIsolate: true,
    }, update, { upsert: true, returnDocument: "after" });
  } catch (error) {
    const conflicting = await db.collections.packages.findOneAsync(generated.packageId);
    if (conflicting &&
        (conflicting.appId !== generated.appId || !conflicting.generatedIsolate)) {
      fail("package-registration-failed",
          "The generated package conflicts with an existing package record.");
    }

    throw error;
  }

  const stored = await db.collections.packages.findOneAsync(generated.packageId);
  if (!stored || stored.appId !== generated.appId || stored.status !== "ready" ||
      !stored.generatedIsolate) {
    fail("package-registration-failed",
        "The generated package conflicts with an existing package record.");
  }
}

async function materializeInternal(db, backendCap, accountId, candidateId, metadata) {
  let candidate = await claimMetadata(db, accountId, candidateId, metadata);
  if (candidate.previewPackageId) return candidate;

  if (candidate.status === "failed") {
    await db.collections.isolateCandidates.updateAsync({
      _id: candidateId,
      ownerId: accountId,
      status: "failed",
    }, {
      $set: { status: "preparing" },
      $unset: { error: "" },
    });
    candidate = await findOwnedIsolateCandidate(db, accountId, candidateId);
  }

  if (!candidate || candidate.status !== "preparing") {
    fail("invalid-candidate-state", "The isolate candidate cannot be prepared in its current state.");
  }

  try {
    const generated = packageResult(await backendCap.generateIsolatePackage(
      "", metadata, bundleToWorkerSource(candidate.normalizedBundle)));
    await registerGeneratedPackage(db, generated, accountId, false);
    const materializedAt = new Date();
    await db.collections.isolateCandidates.updateAsync({
      _id: candidateId,
      ownerId: accountId,
      previewMetadata: metadata,
    }, {
      $set: {
        status: "ready",
        previewAppId: generated.appId,
        previewPackageId: generated.packageId,
        materializedAt,
      },
      $unset: { error: "" },
    });

    return await findOwnedIsolateCandidate(db, accountId, candidateId);
  } catch (error) {
    await db.collections.isolateCandidates.updateAsync({
      _id: candidateId,
      ownerId: accountId,
      status: "preparing",
    }, {
      $set: { status: "failed", error: storedError(error) },
    });
    throw error;
  }
}

async function materializePublishedIsolateCandidate(
    db, backendCap, accountId, candidateId, appId, metadataInput) {
  if (!backendCap || typeof backendCap.generateIsolatePackage !== "function") {
    fail("invalid-context", "Published candidate materialization requires a backend capability.");
  }

  if (typeof appId !== "string" || appId.length === 0) {
    fail("invalid-context", "Published candidate materialization requires a stable app ID.");
  }

  const metadata = normalizeGeneratedIsolateMetadata(metadataInput);
  const candidate = await findOwnedIsolateCandidate(db, accountId, candidateId);
  if (!candidate) fail("candidate-not-found", "No such isolate candidate exists for this account.");
  if (!candidate.previewPackageId || !["ready", "published"].includes(candidate.status)) {
    fail("candidate-not-ready", "The isolate candidate must be preview-ready before publication.");
  }

  const generated = packageResult(await backendCap.generateIsolatePackage(
    appId, metadata, bundleToWorkerSource(candidate.normalizedBundle)));
  if (generated.appId !== appId) {
    fail("package-generation-failed", "The backend did not use the requested published app ID.");
  }

  await registerGeneratedPackage(db, generated, accountId, true);
  return Object.freeze({
    packageId: generated.packageId,
    appId: generated.appId,
    manifest: generated.manifest,
    metadata,
  });
}

function materializeIsolateCandidate(db, backendCap, accountId, candidateId, metadataInput) {
  if (!backendCap || typeof backendCap.generateIsolatePackage !== "function") {
    return Promise.reject(new IsolateCandidateError(
      "invalid-context", "Candidate materialization requires a backend capability."));
  }

  let metadata;
  try {
    metadata = normalizeGeneratedIsolateMetadata(metadataInput);
  } catch (error) {
    return Promise.reject(error);
  }

  const key = `${accountId}\0${candidateId}`;
  const canonicalMetadata = metadataKey(metadata);
  const running = runningMaterializations.get(key);
  if (running) {
    if (running.metadata !== canonicalMetadata) {
      return Promise.reject(new IsolateCandidateError(
        "idempotency-conflict",
        "This candidate is already being prepared with different package metadata."));
    }

    return running.promise;
  }

  const promise = materializeInternal(db, backendCap, accountId, candidateId, metadata);
  runningMaterializations.set(key, { metadata: canonicalMetadata, promise });
  promise.finally(() => {
    if (runningMaterializations.get(key)?.promise === promise) {
      runningMaterializations.delete(key);
    }
  }).catch(() => {});
  return promise;
}

export {
  bundleToWorkerSource,
  materializeIsolateCandidate,
  materializePublishedIsolateCandidate,
  normalizeGeneratedIsolateMetadata,
  registerGeneratedPackage,
};
