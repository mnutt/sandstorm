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
import chai from "chai";

import { globalDb } from "/imports/db-deprecated";
import { IsolateCandidateError, reserveIsolateCandidate } from
  "/imports/server/isolate-candidates";
import { normalizeIsolateBundle } from "/imports/server/isolate-bundle";
import { fakeStreamedIsolatePackageUpload } from
  "/imports/server/isolate-package-test-helpers";
import {
  materializeIsolateCandidate,
  normalizeGeneratedIsolateMetadata,
  streamNormalizedIsolatePackage,
} from "/imports/server/isolate-package-service";

const { assert } = chai;

function bundle() {
  return {
    formatVersion: 1,
    mainModule: "worker.js",
    compatibilityDate: "2025-01-01",
    compatibilityFlags: [],
    modules: [
      {
        name: "message.txt",
        type: "text",
        content: "hello",
      },
      {
        name: "worker.js",
        type: "esModule",
        content: "export default { fetch() { return new Response('ok'); } };",
      },
    ],
  };
}

function metadata(overrides = {}) {
  return {
    appTitle: "Candidate preview",
    nounPhrase: "preview",
    shortDescription: "An isolate candidate preview.",
    appVersion: 1,
    marketingVersion: "draft",
    ...overrides,
  };
}

class FakeBackend {
  constructor() {
    this.calls = [];
    this.failuresRemaining = 0;
    this.packageId = `generated-${Random.id()}`;
  }

  async streamIsolatePackage(requestedAppId, packageMetadata, info) {
    return fakeStreamedIsolatePackageUpload(info, async (source) => {
      this.calls.push({ requestedAppId, packageMetadata, source });
      if (this.failuresRemaining > 0) {
        --this.failuresRemaining;
        throw new Error("simulated backend disconnect");
      }

      return {
        packageId: this.packageId,
        appId: `preview-app-${this.packageId}`,
        manifest: {
          appTitle: { defaultText: packageMetadata.appTitle },
          appVersion: packageMetadata.appVersion,
          actions: [{
            command: {
              isolate: {
                bindings: ["SANDSTORM_API", "POWERBOX", "STORAGE"].map(name => ({ name })),
              },
            },
          }],
        },
      };
    });
  }
}

async function expectCandidateError(promise, code) {
  const error = await promise.then(() => null, error => error);
  assert.instanceOf(error, IsolateCandidateError);
  assert.strictEqual(error.code, code);
}

function expectSynchronousCandidateError(callback, code) {
  let caught;
  try {
    callback();
  } catch (error) {
    caught = error;
  }

  assert.instanceOf(caught, IsolateCandidateError);
  assert.strictEqual(caught.code, code);
}

describe("isolate candidate package materialization", function () {
  let ownerId;
  let actor;
  let backend;
  const packageIds = [];

  beforeEach(function () {
    ownerId = `materialization-owner-${Random.id()}`;
    actor = {
      accountId: ownerId,
      operationScope: `materialization-scope-${Random.id()}`,
      requestingGrainId: Random.id(),
    };
    backend = new FakeBackend();
    packageIds.push(backend.packageId);
  });

  it("hands binary data and Wasm modules to the backend unchanged", async function () {
    const image = Buffer.from([0x89, 0x50, 0x00, 0xff]);
    const wasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    const normalized = normalizeIsolateBundle({
      ...bundle(),
      modules: [
        bundle().modules[1],
        { name: "image.bin", type: "data", content: image },
        { name: "module.wasm", type: "wasm", content: wasm },
      ],
    });
    await streamNormalizedIsolatePackage(backend, "", metadata(), normalized.bundle);
    const source = backend.calls[0].source;
    const imageModule = source.modules.find(module => module.name === "image.bin");
    const wasmModule = source.modules.find(module => module.name === "module.wasm");

    assert.deepEqual([...imageModule.data], [...image]);
    assert.deepEqual([...wasmModule.wasm], [...wasm]);
  });

  afterEach(async function () {
    await globalDb.collections.isolateCandidates.removeAsync({ ownerId });
    await globalDb.collections.packages.removeAsync({ _id: { $in: packageIds.splice(0) } });
  });

  it("materializes the normalized source and records a ready package", async function () {
    const reserved = await reserveIsolateCandidate(globalDb, actor, "materialize", bundle());
    const ready = await materializeIsolateCandidate(
      globalDb, backend, ownerId, reserved._id, metadata(), bundle());
    const storedPackage = await globalDb.collections.packages.findOneAsync(backend.packageId);

    assert.strictEqual(ready.status, "ready");
    assert.strictEqual(ready.previewPackageId, backend.packageId);
    assert.strictEqual(ready.previewAppId, `preview-app-${backend.packageId}`);
    assert.deepEqual(
      ready.platformBindings, ["SANDSTORM_API", "POWERBOX", "STORAGE"]);
    assert.deepEqual(ready.validationWarnings, []);
    assert.instanceOf(ready.materializedAt, Date);
    assert.strictEqual(storedPackage.status, "ready");
    assert.isTrue(storedPackage.generatedIsolate);
    assert.include(storedPackage.generatedIsolateOwners, ownerId);
    assert.strictEqual(backend.calls.length, 1);
    assert.strictEqual(backend.calls[0].requestedAppId, "");
    assert.deepEqual(backend.calls[0].source.bindings, []);
    assert.strictEqual(backend.calls[0].source.modules[0].name, "message.txt");
    assert.instanceOf(backend.calls[0].source.modules[0].text, Buffer);
    assert.strictEqual(backend.calls[0].source.modules[1].name, "worker.js");
    assert.instanceOf(backend.calls[0].source.modules[1].esModule, Buffer);
  });

  it("coalesces concurrent package generation and makes later retries idempotent", async function () {
    const reserved = await reserveIsolateCandidate(globalDb, actor, "concurrent", bundle());
    const calls = Array.from({ length: 5 }, () => materializeIsolateCandidate(
      globalDb, backend, ownerId, reserved._id, metadata(), bundle()));
    const results = await Promise.all(calls);
    const retried = await materializeIsolateCandidate(
      globalDb, backend, ownerId, reserved._id, metadata(), bundle());

    assert.strictEqual(new Set(results.map(result => result.previewPackageId)).size, 1);
    assert.strictEqual(retried.previewPackageId, backend.packageId);
    assert.strictEqual(backend.calls.length, 1);
  });

  it("rejects metadata changes after materialization is reserved", async function () {
    const reserved = await reserveIsolateCandidate(globalDb, actor, "metadata", bundle());
    await materializeIsolateCandidate(
      globalDb, backend, ownerId, reserved._id, metadata(), bundle());
    await expectCandidateError(materializeIsolateCandidate(
      globalDb, backend, ownerId, reserved._id,
      metadata({ appTitle: "Different" }), bundle()),
    "idempotency-conflict");
    assert.strictEqual(backend.calls.length, 1);
  });

  it("rejects retry source that does not match the candidate digest", async function () {
    const reserved = await reserveIsolateCandidate(globalDb, actor, "source-mismatch", bundle());
    const changed = bundle();
    changed.modules[1].content =
      "export default { fetch() { return new Response('changed'); } };";

    await expectCandidateError(materializeIsolateCandidate(
      globalDb, backend, ownerId, reserved._id, metadata(), changed),
    "idempotency-conflict");
    assert.strictEqual(backend.calls.length, 0);
  });

  it("records a failure and safely retries deterministic generation", async function () {
    const reserved = await reserveIsolateCandidate(globalDb, actor, "retry-failure", bundle());
    backend.failuresRemaining = 1;
    const error = await materializeIsolateCandidate(
      globalDb, backend, ownerId, reserved._id, metadata(), bundle())
      .then(() => null, error => error);
    const failed = await globalDb.collections.isolateCandidates.findOneAsync(reserved._id);

    assert.match(error.message, /simulated backend disconnect/);
    assert.strictEqual(failed.status, "failed");
    assert.strictEqual(failed.error.message, "simulated backend disconnect");

    const ready = await materializeIsolateCandidate(
      globalDb, backend, ownerId, reserved._id, metadata(), bundle());
    assert.strictEqual(ready.status, "ready");
    assert.notProperty(ready, "error");
    assert.strictEqual(backend.calls.length, 2);
  });

  it("does not overwrite a conflicting package record", async function () {
    const reserved = await reserveIsolateCandidate(globalDb, actor, "package-conflict", bundle());
    await globalDb.collections.packages.insertAsync({
      _id: backend.packageId,
      appId: "different-app-id",
      status: "ready",
      marker: "keep",
    });

    await expectCandidateError(materializeIsolateCandidate(
      globalDb, backend, ownerId, reserved._id, metadata(), bundle()),
    "package-registration-failed");
    const storedPackage = await globalDb.collections.packages.findOneAsync(backend.packageId);
    const failed = await globalDb.collections.isolateCandidates.findOneAsync(reserved._id);
    assert.strictEqual(storedPackage.appId, "different-app-id");
    assert.strictEqual(storedPackage.marker, "keep");
    assert.strictEqual(failed.status, "failed");
  });

  it("does not convert an ordinary package record into a generated package", async function () {
    const reserved = await reserveIsolateCandidate(
      globalDb, actor, "ordinary-package-conflict", bundle());
    await globalDb.collections.packages.insertAsync({
      _id: backend.packageId,
      appId: `preview-app-${backend.packageId}`,
      status: "ready",
      marker: "ordinary",
    });

    await expectCandidateError(materializeIsolateCandidate(
      globalDb, backend, ownerId, reserved._id, metadata(), bundle()),
    "package-registration-failed");
    const storedPackage = await globalDb.collections.packages.findOneAsync(backend.packageId);
    assert.strictEqual(storedPackage.marker, "ordinary");
    assert.notProperty(storedPackage, "generatedIsolate");
  });

  it("does not reveal or materialize another account's candidate", async function () {
    const reserved = await reserveIsolateCandidate(globalDb, actor, "ownership", bundle());
    await expectCandidateError(materializeIsolateCandidate(
      globalDb, backend, `${ownerId}-other`, reserved._id, metadata(), bundle()),
    "candidate-not-found");
    assert.strictEqual(backend.calls.length, 0);
  });

  it("validates package metadata before reserving backend work", async function () {
    expectSynchronousCandidateError(
      () => normalizeGeneratedIsolateMetadata(metadata({ appVersion: -1 })), "invalid-metadata");
    expectSynchronousCandidateError(
      () => normalizeGeneratedIsolateMetadata(metadata({ appTitle: "" })), "invalid-metadata");
  });
});
