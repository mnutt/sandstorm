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

import chai from "chai";

import { coalesceInFlightOperation } from "/imports/server/isolate-in-flight";

const { assert } = chai;

describe("isolate in-flight operation coalescing", function () {
  it("joins identical input, rejects conflicting input, and releases completed work",
      async function () {
    const operations = new Map();
    let finish;
    let starts = 0;
    const callback = () => {
      ++starts;
      return new Promise(resolve => { finish = resolve; });
    };
    const conflict = () => new Error("conflicting input");

    const first = coalesceInFlightOperation(operations, "key", "input", callback, conflict);
    const joined = coalesceInFlightOperation(operations, "key", "input", callback, conflict);
    const error = await coalesceInFlightOperation(
      operations, "key", "other", callback, conflict).then(() => null, error => error);
    await Promise.resolve();

    assert.strictEqual(starts, 1);
    assert.strictEqual(error.message, "conflicting input");
    finish("result");
    assert.deepEqual(await Promise.all([first, joined]), ["result", "result"]);
    assert.strictEqual(operations.size, 0);

    const retried = await coalesceInFlightOperation(
      operations, "key", "input", () => "retry", conflict);
    assert.strictEqual(retried, "retry");
  });
});
