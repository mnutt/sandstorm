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

import { mongoFindOneAndUpdateValue } from "/imports/server/isolate-mongo";

const { assert } = chai;

describe("isolate Mongo compatibility", function () {
  it("accepts direct and wrapped findOneAndUpdate results", function () {
    const document = { _id: "document" };
    assert.strictEqual(mongoFindOneAndUpdateValue(document), document);
    assert.strictEqual(mongoFindOneAndUpdateValue({ value: document }), document);
    assert.isNull(mongoFindOneAndUpdateValue({ value: null }));
    assert.isNull(mongoFindOneAndUpdateValue(null));
  });
});
