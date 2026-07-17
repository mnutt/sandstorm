// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2026 Sandstorm contributors
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

"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { constants } = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");

const REPO_DIR = path.resolve(__dirname, "..");
const REPO_TMP_DIR = path.join(REPO_DIR, "tmp");
const SPK_BIN = process.env.SPK_BIN || path.join(REPO_DIR, "bin/spk");
const CAPNP_BIN = process.env.CAPNP_BIN || path.join(REPO_DIR, "tmp/capnp/compiler/capnp");
const CAPNP_ES_COMPILER_MODULE = process.env.CAPNP_ES_COMPILER_MODULE ||
  path.join(REPO_DIR,
    "tmp/capnp-es-npm/node_modules/@mnutt/capnp-es/dist/compiler/index.mjs");
const CAPNP_ES_RUNTIME_MODULES = [
  ["@mnutt/capnp-es", "__sandstorm_isolate_runtime/capnp-es/index.mjs"],
  [
    "@mnutt/capnp-es/capnp/persistent",
    "__sandstorm_isolate_runtime/capnp-es/capnp/persistent.mjs",
  ],
  [
    "@mnutt/capnp-es/capnp/rpc",
    "__sandstorm_isolate_runtime/capnp-es/capnp/rpc.mjs",
  ],
  [
    "@mnutt/capnp-es/capnp/rpc-twoparty",
    "__sandstorm_isolate_runtime/capnp-es/capnp/rpc-twoparty.mjs",
  ],
  [
    "@mnutt/capnp-es/capnp/schema",
    "__sandstorm_isolate_runtime/capnp-es/capnp/schema.mjs",
  ],
  [
    "@mnutt/capnp-es/capnp/stream",
    "__sandstorm_isolate_runtime/capnp-es/capnp/stream.mjs",
  ],
  [
    "@mnutt/capnp-es/capnp/ts",
    "__sandstorm_isolate_runtime/capnp-es/capnp/ts.mjs",
  ],
  [
    "@mnutt/shared/capnp-es.-eBPt7Ee.mjs",
    "__sandstorm_isolate_runtime/capnp-es/shared/capnp-es.-eBPt7Ee.mjs",
  ],
  [
    "@mnutt/shared/capnp-es.ujbiBnSV.mjs",
    "__sandstorm_isolate_runtime/capnp-es/shared/capnp-es.ujbiBnSV.mjs",
  ],
  [
    "@mnutt/shared/capnp-es.Bh8zPymV.mjs",
    "__sandstorm_isolate_runtime/capnp-es/shared/capnp-es.Bh8zPymV.mjs",
  ],
  [
    "@mnutt/shared/capnp-es.iq9U7f6E.mjs",
    "__sandstorm_isolate_runtime/capnp-es/shared/capnp-es.iq9U7f6E.mjs",
  ],
  [
    "@mnutt/shared/capnp-es.DlrkfTBx.mjs",
    "__sandstorm_isolate_runtime/capnp-es/shared/capnp-es.DlrkfTBx.mjs",
  ],
  [
    "@mnutt/shared/capnp-es.S5efx5db.mjs",
    "__sandstorm_isolate_runtime/capnp-es/shared/capnp-es.S5efx5db.mjs",
  ],
  [
    "@mnutt/shared/capnp-es.HHDlMVVz.mjs",
    "__sandstorm_isolate_runtime/capnp-es/shared/capnp-es.HHDlMVVz.mjs",
  ],
  [
    "@mnutt/shared/capnp-es.B14jf117.mjs",
    "__sandstorm_isolate_runtime/capnp-es/shared/capnp-es.B14jf117.mjs",
  ],
];
const CAPNP_ES_SCHEME_RUNTIME_MODULES = Array.from(new Map(CAPNP_ES_RUNTIME_MODULES.map(
  ([, sourcePath]) => [
    `capnp:/${sourcePath.replace("__sandstorm_isolate_runtime/", "")}`,
    sourcePath,
  ])));
const CAPNP_ES_PATH_RUNTIME_MODULES = Array.from(new Map(CAPNP_ES_RUNTIME_MODULES.map(
  ([, sourcePath]) => [
    sourcePath.replace("__sandstorm_isolate_runtime/", ""),
    sourcePath,
  ])));
const CAPNP_ES_SCHEME_RELATIVE_RUNTIME_MODULES = Array.from(new Map(CAPNP_ES_RUNTIME_MODULES.map(
  ([, sourcePath]) => [
    `capnp:./${sourcePath.replace("__sandstorm_isolate_runtime/", "")}`,
    sourcePath,
  ])));
function formatOutput(stdout, stderr) {
  const out = stdout.join("");
  const err = stderr.join("");
  return [
    out.length === 0 ? "" : `\n--- stdout ---\n${out}`,
    err.length === 0 ? "" : `\n--- stderr ---\n${err}`,
  ].join("");
}

async function requireExecutable(file, hint) {
  try {
    await fs.access(file, constants.X_OK);
  } catch (err) {
    throw new Error(`Missing executable: ${file}\n${hint}`, { cause: err });
  }
}

async function requireFile(file, hint) {
  try {
    await fs.access(file);
  } catch (err) {
    throw new Error(`Missing file: ${file}\n${hint}`, { cause: err });
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { input, ...spawnOptions } = options;
    const stdout = [];
    const stderr = [];
    const child = spawn(command, args, {
      ...spawnOptions,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });

    if (input !== undefined) {
      child.stdin.end(input);
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data) => stdout.push(data));
    child.stderr.on("data", (data) => stderr.push(data));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve({ stdout: stdout.join(""), stderr: stderr.join("") });
      } else {
        reject(new Error(
          `${command} ${args.join(" ")} failed with ${signal || `exit code ${code}`}` +
          formatOutput(stdout, stderr)));
      }
    });
  });
}

test("spk dev-isolate prints manifests and native generated capnp modules", async (t) => {
  await requireExecutable(SPK_BIN, "Build the project first, e.g. make fast.");
  try {
    await requireFile(
      CAPNP_ES_COMPILER_MODULE,
      "Set CAPNP_ES_COMPILER_MODULE to the @mnutt/capnp-es compiler module.");
  } catch (err) {
    t.skip(err.message);
    return;
  }

  const workerPath = path.join(REPO_DIR, "examples/isolate-capnp-rpc/worker.js");
  const { stdout } = await runCommand(SPK_BIN, [
    "dev-isolate",
    "--print-manifest-json",
    "--title", "Capnp Manifest Test",
    "--app-interface", "capnp:./greeter.capnp#Greeter",
    workerPath,
  ], {
    env: {
      ...process.env,
      SANDSTORM_CAPNP_ES_COMPILER_MODULE: CAPNP_ES_COMPILER_MODULE,
    },
  });
  const manifest = JSON.parse(stdout);
  const isolate = manifest.continueCommand.isolate;
  const modules = new Map(isolate.modules.map((module) => [module.name, module]));
  const bindings = new Map(isolate.bindings.map((binding) => [binding.name, binding]));

  assert.equal(manifest.appTitle.defaultText, "Capnp Manifest Test");
  assert.equal(isolate.mainModule, "worker.js");
  assert.equal(
    String(isolate.bridgeConfig.viewInfo.matchRequests[0].tags[0].id),
    BigInt("0x85d0f155d6c54b6d").toString());
  assert.equal(modules.get("worker.js").esModulePath, "__sandstorm_dev_isolate_app/worker.js");
  assert.equal(
    modules.get("capnp:./greeter.capnp").esModulePath,
    "__sandstorm_isolate_runtime/capnp-es-generated/greeter.js");
  assert.equal(
    modules.get("capnp:./greeting.capnp").esModulePath,
    "__sandstorm_isolate_runtime/capnp-es-generated/greeting.js");
  assert.equal(modules.has("capnp-es:./greeter.capnp"), false);
  assert.equal(modules.has("capnp-es:./greeting.capnp"), false);
  assert.equal(modules.get("sandstorm:api").esModulePath, "__sandstorm_isolate_runtime/api.js");
  assert.equal(modules.has("sandstorm:capnp"), false);
  assert.equal(
    modules.get("sandstorm-internal:capnp-runtime").esModulePath,
    "__sandstorm_isolate_runtime/capnp-runtime.js");
  assert.equal(
    modules.get("sandstorm-internal:validation").esModulePath,
    "__sandstorm_isolate_runtime/validation.js");
  assert.equal(
    modules.get("capnp:/sandstorm/web-session.capnp").esModulePath,
    "__sandstorm_isolate_runtime/capnp-es-generated/sandstorm/web-session.js");
  assert.equal(modules.has("sandstorm:rpc"), false);
  assert.equal(modules.has("sandstorm:capnweb-source"), false);
  assert.equal(modules.has("capnweb"), false);
  assert.equal(modules.has("capnp:/capnweb.js"), false);
  assert.equal(modules.has("capnp:/sandstorm/capnp.js"), false);
  assert.equal(modules.has("capnp:/sandstorm/native-capnp-bridge.js"), false);
  for (const [name] of CAPNP_ES_RUNTIME_MODULES) {
    assert.equal(modules.has(name), false);
  }
  for (const [name, esModulePath] of CAPNP_ES_SCHEME_RUNTIME_MODULES) {
    assert.equal(modules.get(name).esModulePath, esModulePath);
  }
  for (const [name, esModulePath] of CAPNP_ES_PATH_RUNTIME_MODULES) {
    assert.equal(modules.get(name).esModulePath, esModulePath);
  }
  for (const [name, esModulePath] of CAPNP_ES_SCHEME_RELATIVE_RUNTIME_MODULES) {
    assert.equal(modules.get(name).esModulePath, esModulePath);
  }

  assert.deepEqual([...bindings.keys()], ["SANDSTORM_API", "POWERBOX", "STORAGE"]);
  assert.deepEqual(bindings.get("SANDSTORM_API"), {
    name: "SANDSTORM_API",
    sandstormApi: null,
  });
  assert.deepEqual(bindings.get("POWERBOX"), {
    name: "POWERBOX",
    powerbox: null,
  });
  assert.deepEqual(bindings.get("STORAGE"), {
    name: "STORAGE",
    storage: null,
  });

  const generated = await runCommand(SPK_BIN, [
    "dev-isolate",
    "--print-generated-module", "capnp:./greeter.capnp",
    workerPath,
  ], {
    env: {
      ...process.env,
      SANDSTORM_CAPNP_ES_COMPILER_MODULE: CAPNP_ES_COMPILER_MODULE,
    },
  });
  assert.match(generated.stdout, /export class Greeter extends/);
  assert.match(generated.stdout, /static interfaceId = 0x85d0f155d6c54b6dn/);
  assert.match(generated.stdout, /methodName: "hello"/);
  assert.match(generated.stdout, /methodName: "useGreeting"/);
  assert.doesNotMatch(generated.stdout, /makeCapnpInterfaceBinding/);

  await assert.rejects(
    runCommand(SPK_BIN, [
      "dev-isolate",
      "--print-generated-module", "capnp-es:./greeter.capnp",
      workerPath,
    ], {
      env: {
        ...process.env,
        SANDSTORM_CAPNP_ES_COMPILER_MODULE: CAPNP_ES_COMPILER_MODULE,
      },
    }),
    /`capnp-es:` isolate schema imports have been renamed; use `capnp:`/);
});

test("spk dev-isolate rejects service targets outside the worker", async () => {
  await requireExecutable(SPK_BIN, "Build the project first, e.g. make fast.");
  const workerPath = path.join(REPO_DIR, "examples/isolate-capnp-rpc/worker.js");
  await assert.rejects(
    runCommand(SPK_BIN, [
      "dev-isolate",
      "--print-manifest-json",
      "--service-binding", "REMOTE=another-service",
      workerPath,
    ]),
    /service binding target must be the worker-local main service/);
});

test("spk dev-isolate resolves app-interface schemas outside the repo", async (t) => {
  await requireExecutable(SPK_BIN, "Build the project first, e.g. make fast.");
  try {
    await requireFile(
      CAPNP_ES_COMPILER_MODULE,
      "Set CAPNP_ES_COMPILER_MODULE to the @mnutt/capnp-es compiler module.");
  } catch (err) {
    t.skip(err.message);
    return;
  }

  await fs.mkdir(REPO_TMP_DIR, { recursive: true });
  const fixtureRoot = await fs.mkdtemp(path.join(REPO_TMP_DIR, "dev-isolate-app-interface-"));
  t.after(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  await fs.writeFile(path.join(fixtureRoot, "object-store.capnp"), [
    "@0x91bd68a6d056c2a1;",
    "using Grain = import \"/sandstorm/grain.capnp\";",
    "",
    "struct UploadTargetObjectId {",
    "  type @0 :Text;",
    "}",
    "",
    "interface UploadTarget extends(Grain.AppPersistent(UploadTargetObjectId)) {",
    "  put @0 (key :Text) -> (etag :Text);",
    "}",
    "",
  ].join("\n"));
  await fs.writeFile(path.join(fixtureRoot, "worker.js"), [
    "import { UploadTarget } from \"capnp:./object-store.capnp\";",
    "export default { fetch() { return Response.json({ id: String(UploadTarget.interfaceId) }); } };",
    "",
  ].join("\n"));

  const options = {
    cwd: fixtureRoot,
    env: {
      ...process.env,
      SANDSTORM_CAPNP_ES_COMPILER_MODULE: CAPNP_ES_COMPILER_MODULE,
    },
  };
  const { stdout } = await runCommand(SPK_BIN, [
    "dev-isolate",
    "--print-manifest-json",
    "--title", "Object Store",
    "--app-interface", "capnp:./object-store.capnp#UploadTarget",
    "worker.js",
  ], options);
  const manifest = JSON.parse(stdout);
  const modules = new Map(
    manifest.continueCommand.isolate.modules.map((module) => [module.name, module]));

  assert.equal(manifest.continueCommand.isolate.mainModule, "worker.js");
  assert.equal(
    modules.get("capnp:./object-store.capnp").esModulePath,
    "__sandstorm_isolate_runtime/capnp-es-generated/object-store.js");
  assert.equal(
    modules.get("capnp:/sandstorm/grain.capnp").esModulePath,
    "__sandstorm_isolate_runtime/capnp-es-generated/sandstorm/grain.js");
  assert.equal(
    String(manifest.continueCommand.isolate.bridgeConfig.viewInfo.matchRequests[0].tags[0].id),
    BigInt("0x970c38b4ce585d56").toString());

  const generated = await runCommand(SPK_BIN, [
    "dev-isolate",
    "--print-generated-module", "capnp:./object-store.capnp",
    "worker.js",
  ], options);
  assert.match(
    generated.stdout,
    /from "\/sandstorm\/grain\.capnp";/);
  assert.doesNotMatch(
    generated.stdout,
    /from "\.\/sandstorm\/grain\.capnp";/);

  await assert.rejects(
    runCommand(SPK_BIN, [
      "dev-isolate",
      "--print-manifest-json",
      "--app-interface", "capnp:./missing/object-store.capnp#UploadTarget",
      "worker.js",
    ], options),
    (err) => {
      assert.match(err.message, /Could not resolve isolate import/);
      assert.doesNotMatch(err.message, /Received signal #11|Segmentation fault/);
      return true;
    });
});

test("spk powerbox-descriptor emits schema interface descriptors", async () => {
  await requireExecutable(SPK_BIN, "Build the project first, e.g. make fast.");

  const options = { cwd: path.join(REPO_DIR, "examples/isolate-capnp-rpc") };
  const base64 = (await runCommand(SPK_BIN, [
    "powerbox-descriptor",
    "./greeter.capnp#Greeter",
  ], options)).stdout.trim();
  assert.match(base64, /^[A-Za-z0-9_-]+$/);

  const json = JSON.parse((await runCommand(SPK_BIN, [
    "powerbox-descriptor",
    "--format", "json",
    "capnp:./greeter.capnp#Greeter",
  ], options)).stdout);
  assert.equal(json.type, "packedPowerboxDescriptor");
  assert.equal(json.descriptor, base64);
  assert.equal(json.interfaceId, "0x85d0f155d6c54b6d");
  assert.equal(json.interfaceName, "Greeter");
  assert.equal(json.schema, "capnp:./greeter.capnp");

  const capnp = (await runCommand(SPK_BIN, [
    "powerbox-descriptor",
    "--format", "capnp",
    "capnp:./greeter.capnp#Greeter",
  ], options)).stdout.trim();
  assert.equal(capnp, "(tags = [(id = 0x85d0f155d6c54b6d)])");
});

test("spk capnp-abi dumps schema interface metadata", async () => {
  await requireExecutable(SPK_BIN, "Build the project first, e.g. make fast.");
  await fs.mkdir(REPO_TMP_DIR, { recursive: true });

  const options = { cwd: path.join(REPO_DIR, "examples/isolate-capnp-rpc") };
  const dumped = await runCommand(SPK_BIN, [
    "capnp-abi",
    "--interface", "Greeter",
    "capnp:./greeter.capnp",
  ], options);
  const abi = JSON.parse(dumped.stdout);

  assert.equal(abi.format, "sandstorm-capnp-abi-v1");
  assert.equal(abi.schema, "capnp:./greeter.capnp");
  assert.equal(abi.interfaces.length, 1);
  assert.equal(abi.interfaces[0].name, "Greeter");
  assert.equal(abi.interfaces[0].interfaceId, "0x85d0f155d6c54b6d");

  const methods = new Map(abi.interfaces[0].methods.map((method) => [method.name, method]));
  assert.deepEqual([...methods.keys()], ["hello", "greeting", "greetingPair", "useGreeting"]);
  assert.equal(methods.get("hello").ordinal, 0);
  assert.deepEqual(methods.get("hello").params, [{ name: "name", type: "Text" }]);
  assert.deepEqual(methods.get("hello").results, [{ name: "message", type: "Text" }]);
  assert.equal(methods.get("useGreeting").ordinal, 3);
  assert.deepEqual(methods.get("useGreeting").params, [
    { name: "greeting", type: "GreetingSchema.Greeting" },
  ]);

  const fixtureRoot = await fs.mkdtemp(path.join(REPO_TMP_DIR, "capnp-abi-"));
  const baselinePath = path.join(fixtureRoot, "greeter.capnp-abi.json");
  await fs.writeFile(baselinePath, dumped.stdout);

  const check = await runCommand(SPK_BIN, [
    "capnp-abi",
    "--interface", "Greeter",
    "--check", baselinePath,
    "capnp:./greeter.capnp",
  ], options);
  assert.match(check.stdout, /Cap'n Proto ABI compatible/);

  abi.interfaces[0].interfaceId = "0x0000000000000001";
  const incompatiblePath = path.join(fixtureRoot, "incompatible.capnp-abi.json");
  await fs.writeFile(incompatiblePath, `${JSON.stringify(abi, null, 2)}\n`);
  await assert.rejects(
    runCommand(SPK_BIN, [
      "capnp-abi",
      "--interface", "Greeter",
      "--check", incompatiblePath,
      "capnp:./greeter.capnp",
    ], options),
    /changed ID/);

  const structSchemaPath = path.join(fixtureRoot, "record.capnp");
  await fs.writeFile(structSchemaPath, `@0xd9df9f07d2dc3e2d;

struct Record {
  name @0 :Text;
  union {
    text @1 :Text;
    data @2 :Data;
  }
}

struct Ignored {
  value @0 :UInt32;
}
`);
  const structOptions = { cwd: fixtureRoot };
  const structDumped = await runCommand(SPK_BIN, [
    "capnp-abi",
    "capnp:./record.capnp",
  ], structOptions);
  const structAbi = JSON.parse(structDumped.stdout);
  assert.deepEqual(structAbi.structs, [
    {
      name: "Record",
      structId: structAbi.structs[0].structId,
      fields: [
        { name: "name", ordinal: 0, type: "Text" },
        { name: "text", ordinal: 1, type: "Text", discriminant: 0 },
        { name: "data", ordinal: 2, type: "Data", discriminant: 1 },
      ],
    },
    {
      name: "Ignored",
      structId: structAbi.structs[1].structId,
      fields: [{ name: "value", ordinal: 0, type: "UInt32" }],
    },
  ]);

  const filteredStructDumped = await runCommand(SPK_BIN, [
    "capnp-abi",
    "--struct", "Record",
    "capnp:./record.capnp",
  ], structOptions);
  assert.deepEqual(JSON.parse(filteredStructDumped.stdout).structs, [structAbi.structs[0]]);

  await assert.rejects(
    runCommand(SPK_BIN, [
      "capnp-abi",
      "--struct", "Missing",
      "capnp:./record.capnp",
    ], structOptions),
    /does not define the requested struct/);

  const structBaselinePath = path.join(fixtureRoot, "record.capnp-abi.json");
  await fs.writeFile(structBaselinePath, structDumped.stdout);
  await runCommand(SPK_BIN, [
    "capnp-abi",
    "--check", structBaselinePath,
    "capnp:./record.capnp",
  ], structOptions);

  structAbi.structs[0].fields[0].type = "Data";
  const incompatibleStructTypePath = path.join(
    fixtureRoot, "incompatible-struct-type.capnp-abi.json");
  await fs.writeFile(incompatibleStructTypePath, `${JSON.stringify(structAbi, null, 2)}\n`);
  await assert.rejects(
    runCommand(SPK_BIN, [
      "capnp-abi",
      "--check", incompatibleStructTypePath,
      "capnp:./record.capnp",
    ], structOptions),
    /changed type/);

  structAbi.structs[0].fields[0].type = "Text";
  structAbi.structs[0].fields[1].discriminant = 42;
  const incompatibleStructPath = path.join(
    fixtureRoot, "incompatible-struct.capnp-abi.json");
  await fs.writeFile(incompatibleStructPath, `${JSON.stringify(structAbi, null, 2)}\n`);
  await assert.rejects(
    runCommand(SPK_BIN, [
      "capnp-abi",
      "--check", incompatibleStructPath,
      "capnp:./record.capnp",
    ], structOptions),
    /changed union discriminant/);

  await assert.rejects(
    runCommand(SPK_BIN, [
      "capnp-abi",
      "capnp-es:./greeter.capnp",
    ], options),
    /`capnp-es:` ABI schema specifiers have been renamed; use `capnp:`/);
});

test("spk dev-isolate prints generated capnp modules", async (t) => {
  await requireExecutable(SPK_BIN, "Build the project first, e.g. make fast.");
  try {
    await requireFile(
      CAPNP_ES_COMPILER_MODULE,
      "Set CAPNP_ES_COMPILER_MODULE to the @mnutt/capnp-es compiler module.");
  } catch (err) {
    t.skip(err.message);
    return;
  }

  await fs.mkdir(REPO_TMP_DIR, { recursive: true });
  const fixtureRoot = await fs.mkdtemp(path.join(REPO_TMP_DIR, "capnp-es-dev-isolate-"));
  t.after(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  await fs.copyFile(
    path.join(REPO_DIR, "examples/isolate-capnp-rpc/greeter.capnp"),
    path.join(fixtureRoot, "greeter.capnp"));
  await fs.copyFile(
    path.join(REPO_DIR, "examples/isolate-capnp-rpc/greeting.capnp"),
    path.join(fixtureRoot, "greeting.capnp"));
  await fs.writeFile(path.join(fixtureRoot, "uses-standard.capnp"), [
    "@0xfcc5bd8efeaebe01;",
    "using Stream = import \"/capnp/stream.capnp\";",
    "struct UsesStream { result @0 :Stream.StreamResult; }",
    "",
  ].join("\n"));
  await fs.writeFile(path.join(fixtureRoot, "uses-web.capnp"), [
    "@0xbdeca847b5bef001;",
    "using Web = import \"/sandstorm/web-session.capnp\";",
    "interface UsesWeb { get @0 () -> (session :Web.WebSession); }",
    "",
  ].join("\n"));
  await fs.writeFile(path.join(fixtureRoot, "complex.capnp"), [
    "@0xecc5bd8efeaebe02;",
    "using GreeterSchema = import \"./greeter.capnp\";",
    "using Web = import \"/sandstorm/web-session.capnp\";",
    "",
    "struct Item {",
    "  enum Color {",
    "    red @0;",
    "    green @1;",
    "    blue @2;",
    "  }",
    "  struct Detail {",
    "    count @0 :UInt32;",
    "    labels @1 :List(Text);",
    "  }",
    "  name @0 :Text;",
    "  color @1 :Color;",
    "  detail @2 :Detail;",
    "  scores @3 :List(UInt64);",
    "}",
    "",
    "interface Complex {",
    "  inspect @0 (",
    "      items :List(Item),",
    "      greeter :GreeterSchema.Greeter,",
    "      session :Web.WebSession",
    "  ) -> (",
    "      selected :GreeterSchema.Greeter,",
    "      echoed :List(Item),",
    "      stream :Web.WebSession",
    "  );",
    "}",
    "",
  ].join("\n"));
  const workerPath = path.join(fixtureRoot, "worker.js");
  await fs.writeFile(workerPath, [
    "import * as greeter from \"capnp:./greeter.capnp\";",
    "import * as standard from \"capnp:./uses-standard.capnp\";",
    "import * as web from \"capnp:./uses-web.capnp\";",
    "import * as complex from \"capnp:./complex.capnp\";",
    "void standard;",
    "void web;",
    "void complex;",
    "export default { fetch() { return Response.json(Object.keys(greeter)); } };",
    "",
  ].join("\n"));

  const options = {
    env: {
      ...process.env,
      SANDSTORM_CAPNP_ES_COMPILER_MODULE: CAPNP_ES_COMPILER_MODULE,
    },
  };
  const { stdout } = await runCommand(SPK_BIN, [
    "dev-isolate",
    "--print-manifest-json",
    workerPath,
  ], options);
  const manifest = JSON.parse(stdout);
  const modules = new Map(
    manifest.continueCommand.isolate.modules.map((module) => [module.name, module]));

  assert.equal(
    modules.get("capnp:./greeter.capnp").esModulePath,
    "__sandstorm_isolate_runtime/capnp-es-generated/greeter.js");
  assert.equal(
    modules.get("capnp:./greeting.capnp").esModulePath,
    "__sandstorm_isolate_runtime/capnp-es-generated/greeting.js");
  assert.equal(
    modules.get("capnp:./uses-standard.capnp").esModulePath,
    "__sandstorm_isolate_runtime/capnp-es-generated/uses-standard.js");
  assert.equal(
    modules.get("capnp:./uses-web.capnp").esModulePath,
    "__sandstorm_isolate_runtime/capnp-es-generated/uses-web.js");
  assert.equal(
    modules.get("capnp:./complex.capnp").esModulePath,
    "__sandstorm_isolate_runtime/capnp-es-generated/complex.js");
  assert.equal(
    modules.get("capnp:/sandstorm/web-session.capnp").esModulePath,
    "__sandstorm_isolate_runtime/capnp-es-generated/sandstorm/web-session.js");
  assert.equal(
    modules.get("capnp:/sandstorm/grain.capnp").esModulePath,
    "__sandstorm_isolate_runtime/capnp-es-generated/sandstorm/grain.js");
  assert.equal(
    modules.get("capnp:/sandstorm/util.capnp").esModulePath,
    "__sandstorm_isolate_runtime/capnp-es-generated/sandstorm/util.js");
  assert.equal(modules.has("capnp:/capnp/stream.capnp"), false);

  const generated = await runCommand(SPK_BIN, [
    "dev-isolate",
    "--print-generated-module", "capnp:./greeter.capnp",
    workerPath,
  ], options);
  assert.match(
    generated.stdout,
    /import \{ Greeting, Greeting\$Client \} from "\.\/greeting\.capnp";/);
  assert.match(generated.stdout, /export class Greeter\$Client \{/);
  assert.match(generated.stdout, /export class Greeter\$Server extends \$\.Server/);
  assert.match(generated.stdout, /export class Greeter extends \$\.Interface/);

  const generatedStandard = await runCommand(SPK_BIN, [
    "dev-isolate",
    "--print-generated-module", "capnp:./uses-standard.capnp",
    workerPath,
  ], options);
  assert.match(
    generatedStandard.stdout,
    /from "\/capnp-es\/capnp\/stream\.mjs";/);

  const generatedWeb = await runCommand(SPK_BIN, [
    "dev-isolate",
    "--print-generated-module", "capnp:./uses-web.capnp",
    workerPath,
  ], options);
  assert.match(
    generatedWeb.stdout,
    /from "\/sandstorm\/web-session\.capnp";/);

  const generatedComplex = await runCommand(SPK_BIN, [
    "dev-isolate",
    "--print-generated-module", "capnp:./complex.capnp",
    workerPath,
  ], options);
  assert.match(
    generatedComplex.stdout,
    /from "\.\/greeter\.capnp";/);
  assert.match(
    generatedComplex.stdout,
    /from "\/sandstorm\/web-session\.capnp";/);
  assert.match(generatedComplex.stdout, /export class Item extends/);
  assert.match(generatedComplex.stdout, /export class Complex\$Client \{/);
  assert.match(generatedComplex.stdout, /export class Complex\$Server extends \$\.Server/);
  assert.match(generatedComplex.stdout, /export class Complex extends \$\.Interface/);

  const generatedComplexDeclaration = await runCommand(SPK_BIN, [
    "dev-isolate",
    "--print-generated-declaration", "capnp:./complex.capnp",
    workerPath,
  ], options);
  assert.match(
    generatedComplexDeclaration.stdout,
    /from "\.\/greeter\.capnp";/);
  assert.match(
    generatedComplexDeclaration.stdout,
    /from "\/sandstorm\/web-session\.capnp";/);
  assert.match(generatedComplexDeclaration.stdout, /export declare class Item extends/);
  assert.match(generatedComplexDeclaration.stdout, /export declare class Complex\$Client \{/);
  assert.match(
    generatedComplexDeclaration.stdout,
    /export declare class Complex\$Server extends \$\.Server/);
  assert.match(generatedComplexDeclaration.stdout, /export declare class Complex extends/);

  const generatedSandstormWeb = await runCommand(SPK_BIN, [
    "dev-isolate",
    "--print-generated-module", "capnp:/sandstorm/web-session.capnp",
    workerPath,
  ], options);
  assert.match(
    generatedSandstormWeb.stdout,
    /from "\.\/grain\.capnp";/);
  assert.match(
    generatedSandstormWeb.stdout,
    /from "\.\/util\.capnp";/);
  assert.match(generatedSandstormWeb.stdout, /from "\/capnp-es\/index\.mjs";/);
});

test("spk pack materializes generated capnp modules for packaged isolates", async (t) => {
  await requireExecutable(SPK_BIN, "Build the project first, e.g. make fast.");
  await requireExecutable(CAPNP_BIN, "Build the project first, e.g. make fast.");
  try {
    await requireFile(
      CAPNP_ES_COMPILER_MODULE,
      "Set CAPNP_ES_COMPILER_MODULE to the @mnutt/capnp-es compiler module.");
  } catch (err) {
    t.skip(err.message);
    return;
  }

  await fs.mkdir(REPO_TMP_DIR, { recursive: true });
  const fixtureRoot = await fs.mkdtemp(path.join(REPO_TMP_DIR, "capnp-es-pack-"));
  t.after(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  const appDir = path.join(fixtureRoot, "app");
  const appSrcDir = path.join(appDir, "src");
  const appSchemaDir = path.join(appDir, "schemas");
  await fs.mkdir(appSrcDir, { recursive: true });
  await fs.mkdir(appSchemaDir, { recursive: true });
  await fs.copyFile(
    path.join(REPO_DIR, "examples/isolate-capnp-rpc/greeter.capnp"),
    path.join(appSchemaDir, "greeter.capnp"));
  await fs.copyFile(
    path.join(REPO_DIR, "examples/isolate-capnp-rpc/greeting.capnp"),
    path.join(appSchemaDir, "greeting.capnp"));
  await fs.writeFile(path.join(appSrcDir, "worker.js"), [
    "import { Greeter } from \"capnp:../schemas/greeter.capnp\";",
    "export default { fetch() { return Response.json({ name: Greeter.name, interfaceId: Greeter._capnp.typeIdHex }); } };",
    "",
  ].join("\n"));

  const pkgdefPath = path.join(fixtureRoot, "sandstorm-pkgdef.capnp");
  const pkgdefSource = [
    "@0xbeba1a4a7a55e001;",
    "",
    "using Grain = import \"/sandstorm/grain.capnp\";",
    "using Spk = import \"/sandstorm/package.capnp\";",
    "",
    "const viewInfo :Grain.UiView.ViewInfo = (",
    "  appTitle = (defaultText = \"Pack Capnp Es Test\"),",
    "  matchRequests = [ (tags = [(id = 0x85d0f155d6c54b6d)]) ]",
    ");",
    "",
    "const command :Spk.Manifest.Command = (",
    "  isolate = (",
    "    mainModule = \"worker.js\",",
    "    compatibilityDate = \"2025-01-01\",",
    "    compatibilityFlags = [],",
    "    modules = [",
    "      ( name = \"worker.js\", esModulePath = \"app/src/worker.js\" )",
    "    ],",
    "    bindings = [],",
    "    bridgeConfig = ( viewInfo = .viewInfo )",
    "  )",
    ");",
    "",
    "const pkgdef :Spk.PackageDefinition = (",
    "  id = \"d2jw0rpnkydeupwend6dk0ugfkz3xfkygg21awx478pzz29gdtp0\",",
    "  manifest = (",
    "    appTitle = (defaultText = \"Pack Capnp Es Test\"),",
    "    appVersion = 0,",
    "    appMarketingVersion = (defaultText = \"0.0.0\"),",
    "    actions = [",
    "      ( title = (defaultText = \"New Pack Capnp Es Test\"),",
    "        nounPhrase = (defaultText = \"instance\"),",
    "        command = .command )",
    "    ],",
    "    continueCommand = .command",
    "  ),",
    "  sourceMap = (",
    "    searchPath = [ ( packagePath = \"app\", sourcePath = \"app\" ) ]",
    "  ),",
    "  alwaysInclude = [ \"sandstorm-manifest\", \"app/src/worker.js\" ]",
    ");",
    "",
  ].join("\n");
  await fs.writeFile(pkgdefPath, pkgdefSource);

  const unsupportedPkgdefPath = path.join(fixtureRoot, "unsupported-service-pkgdef.capnp");
  await fs.writeFile(unsupportedPkgdefPath, pkgdefSource.replace(
    "    bindings = [],",
    "    bindings = [ (name = \"REMOTE\", service = \"another-service\") ],"));
  await assert.rejects(
    runCommand(SPK_BIN, [
      "pack",
      `-k${path.join(REPO_DIR, "src/sandstorm/test-app/isolate-test-app.key")}`,
      "-Isrc",
      "-p", `${unsupportedPkgdefPath}:pkgdef`,
      path.join(fixtureRoot, "unsupported-service.spk"),
    ], {
      cwd: REPO_DIR,
      env: {
        ...process.env,
        SANDSTORM_CAPNP_ES_COMPILER_MODULE: CAPNP_ES_COMPILER_MODULE,
      },
    }),
    /Isolate service bindings may only target the worker-local main service/);

  const spkPath = path.join(fixtureRoot, "pkg.spk");
  await runCommand(SPK_BIN, [
    "pack",
    `-k${path.join(REPO_DIR, "src/sandstorm/test-app/isolate-test-app.key")}`,
    "-Isrc",
    "-p", `${pkgdefPath}:pkgdef`,
    spkPath,
  ], {
    cwd: REPO_DIR,
    env: {
      ...process.env,
      SANDSTORM_CAPNP_ES_COMPILER_MODULE: CAPNP_ES_COMPILER_MODULE,
    },
  });

  const unpackDir = path.join(fixtureRoot, "unpacked");
  await runCommand(SPK_BIN, ["unpack", spkPath, unpackDir], { cwd: REPO_DIR });

  const greeterPath = path.join(
    unpackDir, "__sandstorm_isolate_runtime/capnp-es-generated/app/schemas/greeter.js");
  const greetingPath = path.join(
    unpackDir, "__sandstorm_isolate_runtime/capnp-es-generated/app/schemas/greeting.js");
  await requireFile(greeterPath, "spk pack should generate the imported schema module.");
  await requireFile(greetingPath, "spk pack should generate transitive schema imports.");
  const greeterSource = await fs.readFile(greeterPath, "utf8");
  assert.match(greeterSource, /from "\/capnp-es\/index\.mjs";/);
  assert.match(greeterSource, /from "\.\/greeting\.capnp";/);
  assert.match(greeterSource, /export class Greeter extends/);

  const manifestBytes = await fs.readFile(path.join(unpackDir, "sandstorm-manifest"));
  const { stdout } = await runCommand(CAPNP_BIN, [
    "convert",
    "-Isrc",
    "binary:json",
    "src/sandstorm/package.capnp",
    "Manifest",
  ], {
    cwd: REPO_DIR,
    input: manifestBytes,
  });
  const manifest = JSON.parse(stdout);
  const modules = new Map(
    manifest.continueCommand.isolate.modules.map((module) => [module.name, module]));

  assert.equal(modules.get("worker.js").esModulePath, "app/src/worker.js");
  assert.equal(
    modules.get("capnp:../schemas/greeter.capnp").esModulePath,
    "__sandstorm_isolate_runtime/capnp-es-generated/app/schemas/greeter.js");
  assert.equal(
    modules.get("capnp:../schemas/greeting.capnp").esModulePath,
    "__sandstorm_isolate_runtime/capnp-es-generated/app/schemas/greeting.js");
  assert.equal(modules.has("capnp-es:../schemas/greeter.capnp"), false);
  assert.equal(modules.has("capnp-es:../schemas/greeting.capnp"), false);
  assert.equal(modules.has("sandstorm:browser-capnp:../schemas/greeter.capnp"), false);
  assert.equal(modules.has("sandstorm:browser-capnp:../schemas/greeting.capnp"), false);
  assert.equal(
    String(manifest.continueCommand.isolate.bridgeConfig.viewInfo.matchRequests[0].tags[0].id),
    BigInt("0x85d0f155d6c54b6d").toString());

});
