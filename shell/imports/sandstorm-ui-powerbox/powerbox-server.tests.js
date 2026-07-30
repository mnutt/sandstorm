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

/* eslint-env mocha */

import chai from "chai";
import { Mongo } from "meteor/mongo";

import { SandstormDb } from "/imports/sandstorm-db/db";
import {
  powerboxRequestMatchesProvision,
  provisionCapabilityAction,
} from "/imports/sandstorm-ui-powerbox/powerbox-server";

const assert = chai.assert;

describe("capability-output actions", function () {
  it("keeps capability providers out of ordinary launch actions", async function () {
    const db = new SandstormDb();
    db.collections.userActions = new Mongo.Collection(null);
    await db.collections.userActions.insertAsync({
      userId: "alice",
      title: { defaultText: "Browser app" },
      output: { mainView: null },
    });
    await db.collections.userActions.insertAsync({
      userId: "alice",
      title: { defaultText: "Typed service" },
      output: { capability: { exportName: "greeter" } },
    });

    const actions = db.userActions("alice").fetch();
    assert.lengthOf(actions, 1);
    assert.equal(actions[0].title.defaultText, "Browser app");
  });

  it("keeps service grains out of browser grain queries", async function () {
    const db = new SandstormDb();
    db.collections.grains = new Mongo.Collection(null);
    await db.collections.grains.insertAsync({ _id: "browser", userId: "alice" });
    await db.collections.grains.insertAsync({
      _id: "service",
      userId: "alice",
      isService: true,
    });

    assert.deepEqual(db.userGrains("alice").fetch().map(grain => grain._id), ["browser"]);
    assert.sameMembers(
        db.userGrains("alice", { includeServices: true }).fetch().map(grain => grain._id),
        ["browser", "service"]);
  });

  it("applies unacceptable Powerbox clauses to direct fulfillment", function () {
    const provision = [{ id: "1234" }];
    assert.isTrue(powerboxRequestMatchesProvision([
      { quality: "acceptable", tags: [{ id: "1234" }] },
    ], provision));
    assert.isFalse(powerboxRequestMatchesProvision([
      { quality: "acceptable", tags: [{ id: "1234" }] },
      { quality: "unacceptable", tags: [{ id: "1234" }] },
    ], provision));
    assert.isFalse(powerboxRequestMatchesProvision([
      { quality: "acceptable", tags: [{ id: "5678" }] },
    ], provision));
  });

  it("creates a headless grain and saves its declared export", async function () {
    const calls = {};
    const capability = {
      exportName: "greeter",
      interfaceId: "1234",
      descriptor: { tags: [{ id: "1234" }] },
      displayInfo: {
        title: { defaultText: "Typed greeter" },
        verbPhrase: { defaultText: "can greet" },
      },
    };
    const action = {
      _id: "action-id",
      userId: "alice",
      packageId: "package-id",
      appId: "app-id",
      appVersion: 7,
      nounPhrase: { defaultText: "greeter" },
      command: { isolate: { mainModule: "service-worker.js" } },
      output: { capability },
    };
    const exported = {
      castAs(type) {
        calls.castAs = type;
        return this;
      },
      async save(owner) {
        calls.owner = owner;
        return { sturdyRef: Buffer.from("test-sturdy-ref") };
      },
      close() {
        calls.exportClosed = true;
      },
    };
    const supervisor = {
      async getExport(name, interfaceId) {
        calls.getExport = { name, interfaceId };
        return { cap: exported };
      },
      getMainView() {
        assert.fail("capability action must not resolve MainView");
      },
      close() {
        calls.supervisorClosed = true;
      },
    };
    const db = {
      collections: {
        sessions: {
          async findOneAsync(query) {
            calls.sessionQuery = query;
            return { _id: "session-id", grainId: "requester-grain", userId: "alice" };
          },
        },
        userActions: {
          async findOneAsync(query) {
            calls.actionQuery = query;
            return action;
          },
        },
        packages: {
          async findOneAsync(query) {
            calls.packageQuery = query;
            return { _id: "package-id", status: "ready" };
          },
        },
        grains: {
          async insertAsync(grain) {
            calls.grain = grain;
          },
          async removeAsync() {
            assert.fail("successful fulfillment must retain the provider grain");
          },
        },
        apiTokens: {
          async updateAsync(query, update) {
            calls.tokenUpdate = { query, update };
            return 1;
          },
          async removeAsync() {
            assert.fail("successful fulfillment must retain its capability token");
          },
        },
      },
      async isAccountSignedUpOrDemoAsync() {
        return true;
      },
      async isUserOverQuotaAsync() {
        return false;
      },
    };
    const backend = {
      async startGrainInternal(...args) {
        calls.startGrain = args;
        return { supervisor };
      },
      async deleteGrain() {
        assert.fail("successful fulfillment must not delete the provider grain");
      },
    };
    const users = {
      async findOneAsync(query) {
        calls.userQuery = query;
        return { _id: "alice" };
      },
    };

    const result = await provisionCapabilityAction({
      userId: "alice",
      connection: { sandstormDb: db },
    }, "session-id", "action-id", "requester-grain", [
      { quality: "acceptable", tags: [{ id: "1234" }] },
    ], {
      backend,
      users,
      grainId: "provider-grain",
      generateIdentityId: () => "provider-identity",
    });

    assert.equal(result.sturdyRef, "test-sturdy-ref");
    assert.isNotEmpty(result.descriptor);
    assert.deepEqual(calls.getExport, { name: "greeter", interfaceId: "1234" });
    assert.deepEqual(calls.owner, {
      clientPowerboxRequest: {
        grainId: "requester-grain",
        sessionId: "session-id",
      },
    });
    assert.deepEqual(calls.startGrain, [
      "package-id", "provider-grain", "alice", action.command, true, false, false,
    ]);
    assert.deepInclude(calls.grain, {
      _id: "provider-grain",
      title: "Typed greeter",
      private: true,
      isService: true,
      size: 0,
    });
    assert.deepEqual(calls.tokenUpdate.update.$set.powerbox, {
      descriptor: capability.descriptor,
      displayInfo: capability.displayInfo,
    });
    assert.isTrue(calls.exportClosed);
    assert.isTrue(calls.supervisorClosed);
  });
});
