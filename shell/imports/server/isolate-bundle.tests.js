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

import {
  IsolateBundleError,
  normalizeIsolateBundle,
} from "/imports/server/isolate-bundle";

const { assert } = chai;

function bundle(overrides = {}) {
  return {
    formatVersion: 1,
    mainModule: "worker.js",
    compatibilityDate: "2025-01-01",
    compatibilityFlags: [],
    modules: [{
      name: "worker.js",
      type: "esModule",
      content: "export default { fetch() { return new Response('ok'); } };",
    }],
    ...overrides,
  };
}

function expectBundleError(fn, code, field) {
  let thrown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }

  assert.instanceOf(thrown, IsolateBundleError);
  assert.strictEqual(thrown.code, code);
  if (field !== undefined) assert.strictEqual(thrown.field, field);
}

describe("isolate candidate bundle normalization", function () {
  it("produces a deterministic immutable snapshot", function () {
    const options = { supportedCompatibilityFlags: new Set(["flag-a", "flag-b"]) };
    const first = normalizeIsolateBundle(bundle({
      compatibilityFlags: ["flag-b", "flag-a"],
      modules: [
        { name: "data.json", type: "json", content: "{ \"z\": 1, \"a\": [true] }" },
        {
          name: "worker.js",
          type: "esModule",
          content: "import data from './data.json'; export default { fetch() { return data; } };",
        },
      ],
    }), options);
    const second = normalizeIsolateBundle(bundle({
      compatibilityFlags: ["flag-a", "flag-b"],
      modules: [
        {
          name: "worker.js",
          type: "esModule",
          content: "import data from './data.json'; export default { fetch() { return data; } };",
        },
        { name: "data.json", type: "json", content: "{\"a\":[true],\"z\":1}" },
      ],
    }), options);

    assert.strictEqual(first.digest, second.digest);
    assert.deepEqual(first.bundle, second.bundle);
    assert.strictEqual(first.bundle.modules[0].content, "{\"a\":[true],\"z\":1}");
    assert.isTrue(Object.isFrozen(first.bundle));
    assert.isTrue(Object.isFrozen(first.bundle.modules));
    assert.isTrue(Object.isFrozen(first.bundle.modules[0]));
  });

  it("accepts relative, re-export, dynamic, and platform imports", function () {
    const result = normalizeIsolateBundle(bundle({
      modules: [
        {
          name: "worker.js",
          type: "esModule",
          content: [
            "import { sandstorm } from 'sandstorm:api';",
            "export { value } from './lib/value.js';",
            "export * from './lib/other.js';",
            "export default { async fetch() { return import('./lib/lazy.js'); } };",
          ].join("\n"),
        },
        { name: "lib/value.js", type: "esModule", content: "export const value = 1;" },
        { name: "lib/other.js", type: "esModule", content: "export const other = 2;" },
        { name: "lib/lazy.js", type: "esModule", content: "export default 3;" },
      ],
    }));

    assert.strictEqual(result.bundle.modules.length, 4);
  });

  it("rejects unsupported format versions and unknown fields", function () {
    expectBundleError(() => normalizeIsolateBundle(bundle({ formatVersion: 2 })),
        "unsupported-format-version", "formatVersion");
    expectBundleError(() => normalizeIsolateBundle({ ...bundle(), appId: "chosen-by-caller" }),
        "unknown-field", "bundle.appId");
    expectBundleError(() => normalizeIsolateBundle(bundle({
      modules: [{ name: "worker.js", type: "esModule", content: "", path: "/tmp/worker.js" }],
    })), "unknown-field", "modules[0].path");
  });

  it("rejects non-canonical and duplicate module names", function () {
    [
      "/worker.js",
      "../worker.js",
      "lib/../worker.js",
      "lib//worker.js",
      "lib\\worker.js",
      "sandstorm:api",
    ]
        .forEach((name) => {
          expectBundleError(() => normalizeIsolateBundle(bundle({
            mainModule: name,
            modules: [{ name, type: "esModule", content: "export default {};" }],
          })), "invalid-module-name");
        });

    expectBundleError(() => normalizeIsolateBundle(bundle({
      modules: [
        { name: "worker.js", type: "esModule", content: "export default {};" },
        { name: "worker.js", type: "esModule", content: "export const other = true;" },
      ],
    })), "duplicate-module", "modules[1].name");
  });

  it("requires a submitted ES main module", function () {
    expectBundleError(() => normalizeIsolateBundle(bundle({ mainModule: "missing.js" })),
        "missing-main-module", "mainModule");
    expectBundleError(() => normalizeIsolateBundle(bundle({
      mainModule: "data.json",
      modules: [{ name: "data.json", type: "json", content: "{}" }],
    })), "invalid-main-module", "mainModule");
  });

  it("rejects invalid JavaScript and JSON", function () {
    expectBundleError(() => normalizeIsolateBundle(bundle({
      modules: [{ name: "worker.js", type: "esModule", content: "export {" }],
    })), "invalid-javascript", "modules.worker.js.content");
    expectBundleError(() => normalizeIsolateBundle(bundle({
      modules: [
        { name: "worker.js", type: "esModule", content: "import './bad.json';" },
        { name: "bad.json", type: "json", content: "{ nope" },
      ],
    })), "invalid-json", "modules[1].content");
  });

  it("rejects imports that cannot be fixed inside the snapshot", function () {
    expectBundleError(() => normalizeIsolateBundle(bundle({
      modules: [{ name: "worker.js", type: "esModule", content: "import './missing.js';" }],
    })), "unresolved-import", "import in worker.js");
    expectBundleError(() => normalizeIsolateBundle(bundle({
      modules: [{ name: "worker.js", type: "esModule", content: "import '../outside.js';" }],
    })), "import-outside-bundle", "import in worker.js");
    expectBundleError(() => normalizeIsolateBundle(bundle({
      modules: [{ name: "worker.js", type: "esModule", content: "import 'node:fs';" }],
    })), "unsupported-import", "import in worker.js");
    expectBundleError(() => normalizeIsolateBundle(bundle({
      modules: [{ name: "worker.js", type: "esModule", content: "import('./worker.js?x');" }],
    })), "unsupported-import", "import in worker.js");
    expectBundleError(() => normalizeIsolateBundle(bundle({
      modules: [{
        name: "worker.js",
        type: "esModule",
        content: "const name = './other.js'; export default import(name);",
      }],
    })), "dynamic-import", "modules.worker.js.content");
  });

  it("validates compatibility dates and flags", function () {
    expectBundleError(() => normalizeIsolateBundle(bundle({
      compatibilityDate: "2025-02-29",
    })), "invalid-compatibility-date", "compatibilityDate");
    expectBundleError(() => normalizeIsolateBundle(bundle({
      compatibilityFlags: ["not-enabled"],
    })), "unsupported-compatibility-flag", "compatibilityFlags[0]");
    expectBundleError(() => normalizeIsolateBundle(bundle({
      compatibilityFlags: ["same", "same"],
    }), { supportedCompatibilityFlags: new Set(["same"]) }),
    "duplicate-compatibility-flag", "compatibilityFlags[1]");
  });

  it("enforces per-module and aggregate byte limits", function () {
    expectBundleError(() => normalizeIsolateBundle(bundle({
      modules: [{ name: "worker.js", type: "esModule", content: "12345" }],
    }), { limits: { maxModuleBytes: 4 } }), "limit-exceeded", "modules[0].content");

    expectBundleError(() => normalizeIsolateBundle(bundle({
      modules: [
        { name: "worker.js", type: "esModule", content: "export default {};" },
        { name: "text.txt", type: "text", content: "hello" },
      ],
    }), { limits: { maxTotalModuleBytes: 20 } }), "limit-exceeded", "modules");

    expectBundleError(() => normalizeIsolateBundle(bundle({
      modules: [{
        name: "worker.js",
        type: "esModule",
        content: "export default {};",
      }, {
        name: "nested.json",
        type: "json",
        content: "[[[[0]]]]",
      }],
    }), { limits: { maxJsonDepth: 3 } }), "limit-exceeded", "modules[1].content");
  });

  it("rejects strings that cannot be encoded without replacement", function () {
    expectBundleError(() => normalizeIsolateBundle(bundle({
      modules: [{
        name: "worker.js",
        type: "esModule",
        content: String.fromCharCode(0xd800),
      }],
    })), "invalid-unicode", "modules[0].content");
  });
});
