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
import { ISOLATE_BUNDLE_LIMITS } from "/imports/server/isolate-bundle";
import { fakeStreamedIsolatePackageUpload } from
  "/imports/server/isolate-package-test-helpers";
import { requirePublishGrant } from "/imports/server/isolate-publisher-grants";
import {
  createPreviewGrant,
  receiveIsolateBundle,
  receivePreviewBundle,
  receiveStagedIsolateBundle,
  revokePreviewGrantIfUnreferenced,
  requirePreviewGrant,
} from "/imports/server/isolate-previewer-service";

const { assert } = chai;

function streamedBundle(source) {
  const bytes = Buffer.from(source, "utf8");
  return {
    async getInfo() {
      return {
        info: {
          formatVersion: 1,
          mainModule: "worker.js",
          compatibilityDate: "2025-01-01",
          compatibilityFlags: [],
          modules: [{ name: "worker.js", type: "esModule", size: String(bytes.length) }],
        },
      };
    },

    async transfer(receiver) {
      const { stream } = await receiver.beginModule(0);
      await stream.expectSize(bytes.length);
      await stream.write(bytes.subarray(0, 7));
      await stream.write(bytes.subarray(7));
      await stream.done();
      await receiver.finish();
    },
  };
}

describe("isolate previewer capability", function () {
  let ownerId;
  let otherId;
  let grainId;

  beforeEach(async function () {
    ownerId = `preview-grant-owner-${Random.id()}`;
    otherId = `preview-grant-other-${Random.id()}`;
    grainId = `preview-grant-grain-${Random.id()}`;
    await globalDb.collections.users.insertAsync({
      _id: ownerId,
      type: "account",
      signupKey: "isolate-previewer-capability-test",
      loginCredentials: [],
      nonloginCredentials: [],
      profile: { name: "Preview grant owner" },
    });
    await globalDb.collections.users.insertAsync({
      _id: otherId,
      type: "account",
      signupKey: "isolate-previewer-capability-test",
      loginCredentials: [],
      nonloginCredentials: [],
      profile: { name: "Shared preview user" },
    });
    await globalDb.collections.grains.insertAsync({
      _id: grainId,
      userId: ownerId,
      appId: "previewgranttestapp",
      packageId: "previewgranttestpackage",
      appVersion: 1,
      title: "Preview grant authoring grain",
      private: true,
      created: new Date(),
      lastUsed: new Date(),
    });
  });

  afterEach(async function () {
    await globalDb.collections.apiTokens.removeAsync({
      "frontendRef.isolatePreviewer.grantId": { $exists: true },
    });
    await globalDb.collections.apiTokens.removeAsync({
      "frontendRef.isolateCandidate.candidateId": { $exists: true },
    });
    await globalDb.collections.isolateFactoryGrants.removeAsync({ ownerId });
    await globalDb.collections.isolateFactoryGrants.removeAsync({ ownerId: otherId });
    await globalDb.collections.grains.removeAsync(grainId);
    await globalDb.collections.users.removeAsync(ownerId);
    await globalDb.collections.users.removeAsync(otherId);
  });

  it("receives declared modules through bounded byte streams", async function () {
    const source = "export default { fetch() { return new Response('streamed'); } };";
    const result = await receiveIsolateBundle(streamedBundle(source));

    assert.deepEqual(result, {
      formatVersion: 1,
      mainModule: "worker.js",
      compatibilityDate: "2025-01-01",
      compatibilityFlags: [],
      modules: [{ name: "worker.js", type: "esModule", content: source }],
    });
  });

  it("tees a Powerbox transfer into backend-owned package staging", async function () {
    const source = "export default { fetch() { return new Response('staged'); } };";
    let savedSource;
    const backend = {
      async streamIsolatePackage(requestedAppId, metadata, info) {
        assert.strictEqual(requestedAppId, "");
        assert.strictEqual(metadata.appTitle, "Staged preview");
        return fakeStreamedIsolatePackageUpload(info, async (value) => {
          savedSource = value;
          return { packageId: "staged-package", appId: "staged-app", manifest: {} };
        });
      },
    };
    const staged = await receiveStagedIsolateBundle(streamedBundle(source), backend, {
      appTitle: "Staged preview",
    });

    assert.strictEqual(staged.receivedBundle.modules[0].content, source);
    assert.isUndefined(savedSource);
    const generated = await staged.packageUpload.save();
    assert.strictEqual(generated.packageId, "staged-package");
    assert.strictEqual(savedSource.modules[0].esModule.toString("utf8"), source);
  });

  it("receives binary modules without UTF-8 decoding", async function () {
    const image = Buffer.from([0x89, 0x50, 0x00, 0xff]);
    const wasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    const result = await receiveIsolateBundle({
      async getInfo() {
        return {
          info: {
            formatVersion: 1,
            mainModule: "worker.js",
            compatibilityDate: "2025-01-01",
            compatibilityFlags: [],
            modules: [
              { name: "worker.js", type: "esModule", size: 19 },
              { name: "image.bin", type: "data", size: image.length },
              { name: "module.wasm", type: "wasm", size: wasm.length },
            ],
          },
        };
      },
      async transfer(receiver) {
        for (const [index, content] of [
          Buffer.from("export default {};\n"), image, wasm,
        ].entries()) {
          const { stream } = await receiver.beginModule(index);
          await stream.write(content);
          await stream.done();
        }

        await receiver.finish();
      },
    });

    assert.isTrue(Buffer.isBuffer(result.modules[1].content));
    assert.deepEqual([...result.modules[1].content], [...image]);
    assert.deepEqual([...result.modules[2].content], [...wasm]);
  });

  it("rejects incomplete and over-limit streams before candidate persistence", async function () {
    const incomplete = streamedBundle("short");
    incomplete.transfer = async (receiver) => {
      const { stream } = await receiver.beginModule(0);
      await stream.write(Buffer.from("sho"));
      await receiver.finish();
    };
    const incompleteError = await receiveIsolateBundle(incomplete)
      .then(() => null, error => error);
    assert.match(incompleteError.message, /did not finish|declared size/);

    let transferred = false;
    const oversized = {
      async getInfo() {
        return {
          info: {
            formatVersion: 1,
            mainModule: "worker.js",
            compatibilityDate: "2025-01-01",
            compatibilityFlags: [],
            modules: [{ name: "worker.js", type: "esModule", size: 8 * 1024 * 1024 + 1 }],
          },
        };
      },
      async transfer() {
        transferred = true;
      },
    };
    const oversizedError = await receiveIsolateBundle(oversized)
      .then(() => null, error => error);
    assert.match(oversizedError.message, /exceeds the .*byte limit/);
    assert.isFalse(transferred);

    const aggregateOversized = {
      async getInfo() {
        return {
          info: {
            formatVersion: 1,
            mainModule: "worker.js",
            compatibilityDate: "2025-01-01",
            compatibilityFlags: [],
            modules: [{
              name: "worker.js",
              type: "esModule",
              size: ISOLATE_BUNDLE_LIMITS.maxModuleBytes,
            }, {
              name: "extra.js",
              type: "text",
              size: ISOLATE_BUNDLE_LIMITS.maxTotalModuleBytes -
                ISOLATE_BUNDLE_LIMITS.maxModuleBytes + 1,
            }],
          },
        };
      },
      async transfer() {
        transferred = true;
      },
    };
    transferred = false;
    const aggregateError = await receiveIsolateBundle(aggregateOversized)
      .then(() => null, error => error);
    assert.strictEqual(ISOLATE_BUNDLE_LIMITS.maxTotalModuleBytes, 15 * 1024 * 1024);
    assert.match(aggregateError.message, /exceeds its total byte limit/);
    assert.isFalse(transferred);
  });

  it("checks preview admission before receiving a Powerbox bundle", async function () {
    const quotaDb = Object.create(globalDb);
    quotaDb.isUserOverQuotaAsync = async () => "outOfStorage";
    let bundleInspected = false;
    const error = await receivePreviewBundle(quotaDb, {
      _id: Random.id(),
      ownerId,
      requestingGrainId: grainId,
    }, {
      async getInfo() {
        bundleInspected = true;
        throw new Error("The bundle should not be inspected.");
      },
    }).then(() => null, error => error);

    assert.strictEqual(error.code, "quota-exhausted");
    assert.isFalse(bundleInspected);
  });

  it("mints a durable owner-bound grant and rejects a shared user", async function () {
    const validated = await createPreviewGrant(globalDb, {
      userId: ownerId,
      grainId,
    }, { accountId: ownerId });
    const grantId = validated.grantId;
    const grant = await globalDb.collections.isolateFactoryGrants.findOneAsync(grantId);

    assert.strictEqual(grant.kind, "preview");
    assert.strictEqual(grant.ownerId, ownerId);
    assert.strictEqual(grant.requestingGrainId, grainId);
    assert.deepEqual(validated.requirements, [{
      permissionsHeld: { accountId: ownerId, grainId, permissions: [] },
    }]);
    const publishError = await requirePublishGrant(globalDb, grantId)
      .then(() => null, error => error);
    assert.strictEqual(publishError.code, "grant-revoked");

    const sharedError = await createPreviewGrant(globalDb, {
      userId: otherId,
      grainId,
    }, { accountId: otherId }).then(() => null, error => error);
    assert.strictEqual(sharedError.error, 403);
  });

  it("revokes durable grant state after the last saved token is dropped", async function () {
    const grantId = Random.id();
    await globalDb.collections.isolateFactoryGrants.insertAsync({
      _id: grantId,
      kind: "preview",
      ownerId,
      requestingGrainId: grainId,
      createdAt: new Date(),
    });
    const tokenIds = [Random.id(), Random.id()];
    for (const tokenId of tokenIds) {
      await globalDb.collections.apiTokens.insertAsync({
        _id: tokenId,
        frontendRef: { isolatePreviewer: { grantId } },
        owner: { frontend: null },
        created: new Date(),
      });
    }

    assert.isFalse(await revokePreviewGrantIfUnreferenced(globalDb, grantId));
    await globalDb.collections.apiTokens.removeAsync(tokenIds[0]);
    assert.isFalse(await revokePreviewGrantIfUnreferenced(globalDb, grantId));
    await globalDb.collections.apiTokens.removeAsync(tokenIds[1]);
    assert.isTrue(await revokePreviewGrantIfUnreferenced(globalDb, grantId));

    const error = await requirePreviewGrant(globalDb, grantId)
      .then(() => null, error => error);

    assert.strictEqual(error.code, "grant-revoked");
  });
});
