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
import { packageHasReferences } from "/imports/server/package-references";

const { assert } = chai;

describe("package references", function () {
  let packageId;
  let appId;
  let ownerId;
  let candidateId;
  let grainId;
  let pkg;

  beforeEach(function () {
    packageId = `package-reference-${Random.id()}`;
    appId = `package-reference-app-${Random.id()}`;
    ownerId = `package-reference-owner-${Random.id()}`;
    candidateId = Random.id();
    grainId = Random.id();
    pkg = { _id: packageId, appId };
  });

  afterEach(async function () {
    await globalDb.collections.grains.removeAsync(grainId);
    await globalDb.collections.isolateCandidates.removeAsync(candidateId);
    await globalDb.collections.isolatePublishOperations.removeAsync({ packageId });
  });

  it("retains a generated package while an immutable candidate references it", async function () {
    assert.isFalse(await packageHasReferences(globalDb, pkg));
    await globalDb.collections.isolateCandidates.insertAsync({
      _id: candidateId,
      ownerId,
      operationScope: Random.id(),
      requestId: Random.id(),
      previewPackageId: packageId,
      createdAt: new Date(),
      status: "ready",
    });

    assert.isTrue(await packageHasReferences(globalDb, pkg));
    await globalDb.collections.isolateCandidates.removeAsync(candidateId);
    assert.isFalse(await packageHasReferences(globalDb, pkg));
  });

  it("retains a package used by a grain after its candidate is removed", async function () {
    await globalDb.collections.grains.insertAsync({
      _id: grainId,
      userId: ownerId,
      packageId,
      appId,
      title: "Referenced preview",
    });

    assert.isTrue(await packageHasReferences(globalDb, pkg));
  });

  it("retains a package while its publication operation is incomplete", async function () {
    await globalDb.collections.isolatePublishOperations.insertAsync({
      _id: Random.id(),
      ownerId,
      operationScope: Random.id(),
      requestId: Random.id(),
      packageId,
      state: "package-ready",
      createdAt: new Date(),
    });

    assert.isTrue(await packageHasReferences(globalDb, pkg));
    await globalDb.collections.isolatePublishOperations.removeAsync({ packageId });
    assert.isFalse(await packageHasReferences(globalDb, pkg));
  });
});
