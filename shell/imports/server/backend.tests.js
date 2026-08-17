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

import { assert } from "chai";
import { Random } from "meteor/random";

import { SandstormBackend } from "/imports/server/backend";

function makeBackend(shutdown) {
  const supervisor = {
    closeCalls: 0,
    shutdown,
    close() {
      ++this.closeCalls;
    },
  };
  const cap = {
    getGrain() {
      return { supervisor };
    },
  };
  return { backend: new SandstormBackend({}, cap), supervisor };
}

describe("SandstormBackend shutdownGrain", function () {
  it("accepts a successful account-hosted isolate shutdown", async function () {
    const { backend, supervisor } = makeBackend(async () => {});
    await backend.shutdownGrain(Random.id(), Random.id(), true);
    assert.strictEqual(supervisor.closeCalls, 1);
  });

  it("accepts a disconnected legacy supervisor shutdown", async function () {
    const disconnected = Object.assign(new Error("supervisor exited"), {
      kjType: "disconnected",
    });
    const { backend, supervisor } = makeBackend(async () => { throw disconnected; });
    await backend.shutdownGrain(Random.id(), Random.id(), true);
    assert.strictEqual(supervisor.closeCalls, 1);
  });

  it("propagates other shutdown errors", async function () {
    const failure = Object.assign(new Error("shutdown failed"), { kjType: "failed" });
    const { backend, supervisor } = makeBackend(async () => { throw failure; });
    const { message, kjType } = await backend.shutdownGrain(
      Random.id(), Random.id(), true).then(() => ({}), error => error);
    assert.strictEqual(message, failure.message);
    assert.strictEqual(kjType, failure.kjType);
    assert.strictEqual(supervisor.closeCalls, 1);
  });
});
