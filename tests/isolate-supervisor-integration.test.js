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
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");

const REPO_DIR = path.resolve(__dirname, "..");
const REPO_TMP_DIR = path.join(REPO_DIR, "tmp");
const SANDSTORM_BIN = process.env.SANDSTORM_BIN || path.join(REPO_DIR, "bin/sandstorm");
const SPK_BIN = process.env.SPK_BIN || path.join(REPO_DIR, "bin/spk");
const SPK_PATH = process.env.ISOLATE_TEST_SPK ||
    path.join(REPO_DIR, "tests/assets/isolate-test-app.spk");
const WEBSESSION_CLIENT_BIN = process.env.ISOLATE_WEBSESSION_CLIENT ||
  path.join(REPO_DIR, "tmp/sandstorm/isolate-websession-client");
const STRACE_BIN = process.env.STRACE_BIN || "strace";
const SYSCALL_TRACE_DIR = process.env.ISOLATE_SYSCALL_TRACE_DIR || "";
const SYSCALL_TRACE_PROFILE = process.env.ISOLATE_SYSCALL_TRACE_PROFILE || "";
const REPRESENTATIVE_SYSCALL_TRACE = SYSCALL_TRACE_PROFILE === "representative";
const STRESS_64M = process.env.ISOLATE_STRESS_64M === "1";
const TEST_TIMEOUT_MS = SYSCALL_TRACE_DIR || STRESS_64M ? 180000 : 30000;
const CAPNP_ES_RUNTIME_MODULES = [
  ["@mnutt/capnp-es", "__sandstorm_isolate_runtime/capnp-es/index.mjs"],
  ["@mnutt/capnp/rpc.mjs", "__sandstorm_isolate_runtime/capnp-es/capnp/rpc.mjs"],
  [
    "@mnutt/shared/capnp-es.-PjN5D7P.mjs",
    "__sandstorm_isolate_runtime/capnp-es/shared/capnp-es.-PjN5D7P.mjs",
  ],
  [
    "@mnutt/shared/capnp-es.2t3WiX8T.mjs",
    "__sandstorm_isolate_runtime/capnp-es/shared/capnp-es.2t3WiX8T.mjs",
  ],
  [
    "@mnutt/shared/capnp-es.BC_cLggu.mjs",
    "__sandstorm_isolate_runtime/capnp-es/shared/capnp-es.BC_cLggu.mjs",
  ],
  [
    "@mnutt/shared/capnp-es.BylpbGNO.mjs",
    "__sandstorm_isolate_runtime/capnp-es/shared/capnp-es.BylpbGNO.mjs",
  ],
  [
    "@mnutt/shared/capnp-es.D7Alb_lP.mjs",
    "__sandstorm_isolate_runtime/capnp-es/shared/capnp-es.D7Alb_lP.mjs",
  ],
  [
    "@mnutt/shared/capnp-es.FsZL20ID.mjs",
    "__sandstorm_isolate_runtime/capnp-es/shared/capnp-es.FsZL20ID.mjs",
  ],
  [
    "@mnutt/shared/capnp-es.QN5nOfqw.mjs",
    "__sandstorm_isolate_runtime/capnp-es/shared/capnp-es.QN5nOfqw.mjs",
  ],
];

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
    const stdout = [];
    const stderr = [];
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });

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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function checksum(buffer) {
  let sum = 0;
  for (const byte of buffer) {
    sum = (sum + byte) >>> 0;
  }
  return sum;
}

function deterministicBytes(size) {
  const result = Buffer.alloc(size);
  for (let i = 0; i < size; ++i) {
    result[i] = i & 0xff;
  }
  return result;
}

async function isSocket(socketPath) {
  try {
    const stat = await fs.stat(socketPath);
    return stat.isSocket();
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

async function waitForSockets(paths, childExit, stdout, stderr) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (childExit.value !== null) {
      throw new Error(
        `isolate supervisor exited before sockets were ready: ` +
        JSON.stringify(childExit.value) +
        formatOutput(stdout, stderr));
    }

    const ready = await Promise.all(paths.map(isSocket));
    if (ready.every(Boolean)) return;

    await delay(50);
  }

  throw new Error(
    `timed out waiting for sockets: ${paths.join(", ")}` + formatOutput(stdout, stderr));
}

function requestUnixSocket(socketPath, requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : Buffer.from(options.body);
    const req = http.request({
      socketPath,
      path: requestPath,
      method: options.method || "GET",
      headers: {
        Host: "sandstorm",
        ...(body === null ? {} : { "Content-Length": body.length }),
        ...(options.headers || {}),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const bodyBuffer = Buffer.concat(chunks);
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: bodyBuffer.toString("utf8"),
          bodyBuffer,
        });
      });
    });

    req.on("error", reject);
    if (body !== null) {
      req.write(body);
    }
    req.end();
  });
}

async function requestJson(socketPath, requestPath, options = {}) {
  const response = await requestUnixSocket(socketPath, requestPath, options);
  assert.match(
    String(response.headers["content-type"] || ""),
    /application\/json/,
    response.body);
  return {
    ...response,
    json: JSON.parse(response.body),
  };
}

async function stopChild(child, options = {}) {
  const killProcessGroup = options.killProcessGroup || false;
  const target = killProcessGroup ? -child.pid : child.pid;
  const sendSignal = (signal) => {
    try {
      process.kill(target, signal);
    } catch (err) {
      if (err.code !== "ESRCH") throw err;
    }
  };

  if (child.exitCode !== null || child.signalCode !== null) {
    if (killProcessGroup) sendSignal("SIGTERM");
    return;
  }

  const exited = new Promise((resolve) => child.once("exit", resolve));
  sendSignal("SIGTERM");

  const timeout = delay(2000).then(() => "timeout");
  if (await Promise.race([exited, timeout]) === "timeout") {
    sendSignal("SIGKILL");
    await exited;
  }
}

function spawnCollectingOutput(command, args) {
  const stdout = [];
  const stderr = [];
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (data) => stdout.push(data));
  child.stderr.on("data", (data) => stderr.push(data));

  return { child, stdout, stderr };
}

function waitForExit(child, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("timed out waiting for process exit"));
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function waitForLog(stderr, pattern, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const log = stderr.join("");
    if (pattern.test(log)) return log;
    await delay(50);
  }

  throw new Error(`timed out waiting for log pattern ${pattern}\n${stderr.join("")}`);
}

async function prepareIsolateWorkdir(prefix) {
  await requireExecutable(SANDSTORM_BIN, "Build the project first, e.g. make fast.");
  await requireExecutable(SPK_BIN, "Build the project first, e.g. make fast.");
  await requireFile(SPK_PATH, "Create it with: make tests/assets/isolate-test-app.spk.");

  await fs.mkdir(REPO_TMP_DIR, { recursive: true });
  const workdir = await fs.mkdtemp(path.join(REPO_TMP_DIR, prefix));
  const pkgDir = path.join(workdir, "pkg");
  const varDir = path.join(workdir, "grain");
  const isolateSupervisorBin = path.join(workdir, "isolate-supervisor");
  const localSpkPath = path.join(workdir, "pkg.spk");

  try {
    await fs.symlink(SPK_PATH, localSpkPath);
    await runCommand(SPK_BIN, ["unpack", "pkg.spk"], { cwd: workdir });
    await fs.symlink(SANDSTORM_BIN, isolateSupervisorBin);
    return { workdir, pkgDir, varDir, isolateSupervisorBin };
  } catch (err) {
    await fs.rm(workdir, { recursive: true, force: true });
    throw err;
  }
}

async function startIsolateFixture(options = {}) {
  const { workdir, pkgDir, varDir, isolateSupervisorBin } =
    await prepareIsolateWorkdir("iso-int-");
  const supervisorSocket = path.join(varDir, "socket");
  const runtimeDir = path.join(varDir, "isolate-runtime");
  const workerdSocket = path.join(runtimeDir, "workerd.sock");
  const sandstormApiSocket = path.join(runtimeDir, "sandstorm-api.sock");
  const storageSocket = path.join(runtimeDir, "sandstorm-storage.sock");

  let child = null;
  let coreChild = null;
  const stdout = [];
  const stderr = [];
  let childExit = { value: null };
  let started = false;

  if (SYSCALL_TRACE_DIR) {
    await fs.mkdir(SYSCALL_TRACE_DIR, { recursive: true });
  }

  function spawnSupervisor(isNew) {
    const args = [
      "--stdio",
      "--pkg", pkgDir,
      "--var", varDir,
    ];

    if (isNew) {
      args.push("--new");
    }

    args.push(
      "isolate-test-app",
      "isolate-integration",
      "workerd",
      "serve",
      "${SANDSTORM_ISOLATE_WORKERD_CONFIG}",
      "sandstormConfig");

    childExit = { value: null };
    const spawnCommand = SYSCALL_TRACE_DIR ? STRACE_BIN : isolateSupervisorBin;
    const spawnArgs = SYSCALL_TRACE_DIR
      ? [
        "-ff",
        "-yy",
        "-s", "256",
        "-o", path.join(
          SYSCALL_TRACE_DIR,
          `isolate-supervisor-${isNew ? "new" : "restart"}-${Date.now()}`),
        isolateSupervisorBin,
        ...args,
      ]
      : args;

    child = spawn(spawnCommand, spawnArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: SYSCALL_TRACE_DIR !== "",
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data) => stdout.push(data));
    child.stderr.on("data", (data) => stderr.push(data));
    child.on("exit", (code, signal) => {
      childExit.value = { code, signal };
    });
    child.on("error", (err) => {
      childExit.value = { error: err.message };
    });
  }

  async function startCoreServer() {
    await requireExecutable(
      WEBSESSION_CLIENT_BIN,
      "Build the project first, e.g. make tmp/.ekam-run.");

    const coreArgs = ["--core-server"];
    if (options.tokenStorePath) {
      coreArgs.push("--token-store", options.tokenStorePath);
    }
    coreArgs.push(supervisorSocket);

    const core = spawnCollectingOutput(WEBSESSION_CLIENT_BIN, coreArgs);
    coreChild = core.child;
    core.child.on("exit", (code, signal) => {
      if (code !== 0 && signal !== "SIGTERM") {
        stderr.push(`fake core exited with ${signal || `exit code ${code}`}\n`);
      }
    });
    core.child.stdout.on("data", (data) => stdout.push(data));
    core.child.stderr.on("data", (data) => stderr.push(data));
    await waitForLog(core.stderr, /Core ready\./);
  }

  async function stopCoreServer() {
    if (coreChild !== null) {
      await stopChild(coreChild);
      coreChild = null;
    }
  }

  async function restartCoreServer() {
    await stopCoreServer();
    await startCoreServer();
  }

  async function waitForFixtureSockets() {
    await waitForSockets([
      supervisorSocket,
      workerdSocket,
      sandstormApiSocket,
      storageSocket,
    ], childExit, stdout, stderr);
  }

  async function unlinkSockets() {
    await Promise.all([
      supervisorSocket,
      workerdSocket,
      sandstormApiSocket,
      storageSocket,
    ].map((socketPath) => fs.rm(socketPath, { force: true })));
  }

  try {
    spawnSupervisor(true);
    await waitForFixtureSockets();
    await fs.appendFile(path.join(varDir, "log"), "isolate integration watchLog fixture\n");
    await startCoreServer();

    started = true;
    return {
      workdir,
      pkgDir,
      varDir,
      runtimeDir,
      supervisorSocket,
      workerdSocket,
      sandstormApiSocket,
      storageSocket,
      child,
      stdout,
      stderr,
      restartCore: restartCoreServer,
      restart: async () => {
        await stopCoreServer();
        if (child !== null) {
          await stopChild(child, { killProcessGroup: SYSCALL_TRACE_DIR !== "" });
          child = null;
        }
        await unlinkSockets();
        spawnSupervisor(false);
        await waitForFixtureSockets();
        await startCoreServer();
      },
      cleanup: async () => {
        await stopCoreServer();
        if (child !== null) {
          await stopChild(child, { killProcessGroup: SYSCALL_TRACE_DIR !== "" });
          child = null;
        }
        await fs.rm(workdir, { recursive: true, force: true });
      },
    };
  } finally {
    if (!started) {
      await stopCoreServer();
    }
    if (!started && child !== null) {
      await stopChild(child, { killProcessGroup: SYSCALL_TRACE_DIR !== "" });
    }
    if (!started) {
      await fs.rm(workdir, { recursive: true, force: true });
    }
  }
}

test("spk dev-isolate prints manifests and generated capnp modules", async () => {
  await requireExecutable(SPK_BIN, "Build the project first, e.g. make fast.");

  const workerPath = path.join(REPO_DIR, "examples/isolate-capnp-rpc/worker.js");
  const { stdout } = await runCommand(SPK_BIN, [
    "dev-isolate",
    "--print-manifest-json",
    "--title", "Capnp Manifest Test",
    workerPath,
  ]);
  const manifest = JSON.parse(stdout);
  const isolate = manifest.continueCommand.isolate;
  const modules = new Map(isolate.modules.map((module) => [module.name, module]));
  const bindings = new Map(isolate.bindings.map((binding) => [binding.name, binding]));

  assert.equal(manifest.appTitle.defaultText, "Capnp Manifest Test");
  assert.equal(isolate.mainModule, "worker.js");
  assert.equal(modules.get("worker.js").esModulePath, "__sandstorm_dev_isolate_app/worker.js");
  assert.match(
    modules.get("capnp:./greeter.capnp").esModulePath,
    /^__sandstorm_isolate_runtime\/capnp\/[0-9a-f]+\.js$/);
  assert.match(
    modules.get("capnp:./greeting.capnp").esModulePath,
    /^__sandstorm_isolate_runtime\/capnp\/[0-9a-f]+\.js$/);
  assert.equal(modules.get("sandstorm:api").esModulePath, "__sandstorm_isolate_runtime/api.js");
  assert.equal(modules.get("sandstorm:rpc").esModulePath, "__sandstorm_isolate_runtime/rpc.js");
  assert.equal(
    modules.get("sandstorm:capnp").esModulePath,
    "__sandstorm_isolate_runtime/capnp.js");
  assert.equal(modules.get("capnweb").esModulePath, "__sandstorm_isolate_runtime/capnweb.js");
  for (const [name, esModulePath] of CAPNP_ES_RUNTIME_MODULES) {
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
  ]);
  assert.match(
    generated.stdout,
    /import \{ Greeting as _capnpImport0_Greeting \} from "capnp:\.\/greeting\.capnp";/);
  assert.match(generated.stdout, /export const Greeter = makeInterface\("Greeter"/);
  assert.match(generated.stdout, /interfaceId: "0x[0-9a-f]{16}"/);
  assert.match(generated.stdout, /methodIds: \{\n    "hello": 0,\n    "greeting": 1,\n    "greetingPair": 2,\n    "useGreeting": 3\n  \}/);
  assert.match(generated.stdout, /paramStructIds: \{\n    "hello": "0x[0-9a-f]{16}"/);
  assert.match(generated.stdout, /resultStructIds: \{\n    "hello": "0x[0-9a-f]{16}"/);
  assert.match(generated.stdout, /"hello", "greeting", "greetingPair", "useGreeting"/);
  assert.match(
    generated.stdout,
    /"useGreeting": \{ indexes: \[0\], fields: \{"greeting": _capnpImport0_Greeting\} \}/);
  assert.match(generated.stdout, /"greeting": \(\) => _capnpImport0_Greeting/);
  assert.match(
    generated.stdout,
    /"greetingPair": \{ fields: \{\n      "formal": \(\) => _capnpImport0_Greeting,\n      "casual": \(\) => _capnpImport0_Greeting\n    \} \}/);
  assert.doesNotMatch(generated.stdout, /"hello": \(\) =>/);

  const generatedGreeting = await runCommand(SPK_BIN, [
    "dev-isolate",
    "--print-generated-module", "capnp:./greeting.capnp",
    workerPath,
  ]);
  assert.match(generatedGreeting.stdout, /export const Greeting = makeInterface\("Greeting"/);
  assert.match(generatedGreeting.stdout, /interfaceId: "0x[0-9a-f]{16}"/);
  assert.match(generatedGreeting.stdout, /methodIds: \{\n    "read": 0\n  \}/);
  assert.match(generatedGreeting.stdout, /"read"/);

  const objectStorePath = path.join(REPO_DIR, "examples/isolate-object-store/worker.js");
  const generatedObjectStore = await runCommand(SPK_BIN, [
    "dev-isolate",
    "--print-generated-module", "capnp:./object-store.capnp",
    objectStorePath,
  ]);
  assert.match(generatedObjectStore.stdout, /export const ObjectStore = makeInterface\("ObjectStore"/);
  assert.match(
    generatedObjectStore.stdout,
    /"openObject": \{ nativeInterface: "webSession", fetch: true \}/);
  assert.doesNotMatch(generatedObjectStore.stdout, /from "capnp:.*web-session/);
});

test("isolate supervisor integration suite", {
  timeout: TEST_TIMEOUT_MS,
}, async (t) => {
  const fixture = await startIsolateFixture();
  t.after(() => fixture.cleanup());

  await t.test("generates the workerd runtime bundle", async () => {
    const manifest = JSON.parse(
      await fs.readFile(path.join(fixture.runtimeDir, "runtime-manifest.json"), "utf8"));
    assert.equal(manifest.mainModule, "worker.js");
    assert.equal(manifest.compatibilityDate, "2025-01-01");
    assert.deepEqual(
      manifest.modules.map((module) => [module.name, module.type]),
      [
        ["worker.js", "esModule"],
        ["message.txt", "text"],
        ["metadata.json", "json"],
        ["capnweb", "esModule"],
        ["sandstorm:capnweb-source", "text"],
        ["sandstorm:rpc", "esModule"],
        ["sandstorm:api", "esModule"],
        ["sandstorm:capnp", "esModule"],
        ...CAPNP_ES_RUNTIME_MODULES.map(([name]) => [name, "esModule"]),
      ]);
    assert.deepEqual(
      manifest.bindings.map((binding) => [binding.name, binding.type]),
      [
        ["TEXT_BINDING", "text"],
        ["JSON_BINDING", "json"],
        ["SANDSTORM_API", "sandstormApi"],
        ["POWERBOX", "powerbox"],
        ["STORAGE", "storage"],
        ["LOOPBACK_SERVICE", "service"],
      ]);

    const workerdConfig = await fs.readFile(path.join(fixture.runtimeDir, "workerd.capnp"), "utf8");
    assert.match(workerdConfig, /name = "sandstorm"/);
    assert.match(workerdConfig, /service = "sandstorm-api"/);
    assert.match(workerdConfig, /service = "sandstorm-powerbox"/);
    assert.match(workerdConfig, /service = "sandstorm-storage"/);
    assert.match(workerdConfig, /name = "POWERBOX", service = "sandstorm-powerbox"/);
    assert.match(workerdConfig, /name = "LOOPBACK_SERVICE", service = "main"/);
  });

  await t.test("runs the workerd sidecar in isolated namespaces and mount root", async () => {
    const log = await waitForLog(
      fixture.stderr, /Isolate sidecar entered .*namespaces\./);
    assert.match(log, /Isolate sidecar entered minimal mount root\./);
    assert.match(log, /Started isolate sidecar process\./);
  });

  await t.test("serves requests through the supervisor WebSession interface", async () => {
    await requireExecutable(
      WEBSESSION_CLIENT_BIN,
      "Build the project first, e.g. make tmp/.ekam-run.");
    try {
      await runCommand(WEBSESSION_CLIENT_BIN, [fixture.supervisorSocket]);
    } catch (err) {
      throw new Error(`${err.message}${formatOutput(fixture.stdout, fixture.stderr)}`, {
        cause: err,
      });
    }
    await fixture.restartCore();
  });

  await t.test("serves worker fetch requests through workerd", async () => {
    const response = await requestJson(fixture.workerdSocket, "/");
    assert.equal(response.statusCode, 200, response.body + formatOutput(
      fixture.stdout, fixture.stderr));

    const body = response.json;
    assert.equal(body.ok, true);
    assert.equal(body.method, "GET");
    assert.equal(body.pathname, "/");
    assert.equal(body.message, "hello from a text module\n");
    assert.equal(body.metadata.fixture, "isolate-test-app");
    assert.equal(body.textBinding, "hello from a text binding");
    assert.deepEqual(body.jsonBinding, { binding: "json" });
    assert.equal(body.capnpEs.messageBytes, 16);
    assert.equal(body.capnpEs.payloadBytes, 16);
    assert.deepEqual(body.helperVersions, {
      api: 0,
      rpc: 0,
      capnweb: "0.8.0",
      capnp: 0,
      capnpNativeBridge: 0,
      aggregate: {
        api: 0,
        rpc: 0,
        capnweb: "0.8.0",
      },
    });
    assert.equal(body.sandstormApi.status.ok, true);
    assert.equal(body.sandstormApi.runtime.mainModule, "worker.js");
    assert.deepEqual(body.sandstormApi.capnpBridgeInfo, {
      ok: true,
      type: "capnpBridgeInfo",
      protocolVersion: 0,
      minProtocolVersion: 0,
      maxProtocolVersion: 0,
      nativeTransport: false,
      nativeCalls: false,
      nativeExports: false,
      capabilitySlots: false,
      fallbackTransport: "appObjectRpc",
    });
    assert.deepEqual(
      body.sandstormApi.helperCapnpBridgeInfo,
      body.sandstormApi.capnpBridgeInfo);
    assert.equal(body.sandstormApi.capnpBridgeNegotiation.available, false);
    assert.equal(body.sandstormApi.capnpBridgeNegotiation.protocolSupported, true);
    assert.equal(body.sandstormApi.capnpBridgeNegotiation.protocolVersion, 0);
    assert.equal(body.sandstormApi.capnpBridgeNegotiation.nativeTransport, false);
    assert.equal(body.sandstormApi.capnpBridgeNegotiation.reason, "native transport unavailable");
    assert.deepEqual(body.sandstormApi.capnpBridgeNegotiation.missingFeatures, [
      "nativeCalls",
      "capabilitySlots",
    ]);
    assert.deepEqual(
      body.sandstormApi.capnpBridgeNegotiation.info,
      body.sandstormApi.capnpBridgeInfo);
    assert.deepEqual(body.sandstormApi.nativeCapnpBridge, {
      available: false,
      protocolVersion: 0,
      callError: "NativeCapnpBridgeUnavailableError",
      routeError: "native Cap'n Proto bridge transport is not enabled",
    });
    assert.equal(body.storage.text, "stored from isolate");
    assert.deepEqual(body.appRpcTarget, {
      targetClass: true,
      pathname: "/",
      hasStorage: true,
      sessionType: "",
      permissions: [],
    });

    const apiPathResponse = await requestJson(fixture.workerdSocket, "/api/health?ignored=true");
    assert.equal(apiPathResponse.statusCode, 200);
    assert.equal(apiPathResponse.json.pathname, "/api/health");

    const loopback = await requestJson(fixture.workerdSocket, "/service-loopback");
    assert.equal(loopback.statusCode, 200, loopback.body);
    assert.equal(loopback.json.ok, true);
    assert.equal(loopback.json.status, 200);
    assert.equal(loopback.json.body.ok, true);
    assert.equal(loopback.json.body.source, "loopback-service-target");
    assert.equal(loopback.json.body.method, "POST");
    assert.equal(loopback.json.body.pathname, "/service-target");
    assert.equal(loopback.json.body.search, "?source=service-binding");
    assert.equal(loopback.json.body.body, "hello through service binding");
    assert.equal(loopback.json.body.customHeader, "present");

    const powerboxProbe = await requestJson(fixture.workerdSocket, "/powerbox-binding-probe");
    assert.equal(powerboxProbe.statusCode, 200, powerboxProbe.body);
    assert.equal(powerboxProbe.json.ok, true);
    assert.equal(powerboxProbe.json.statusEndpoint.status, 404);
    assert.equal(powerboxProbe.json.statusEndpoint.body.ok, false);
    assert.match(powerboxProbe.json.statusEndpoint.body.error, /Powerbox binding/);
    assert.equal(powerboxProbe.json.powerboxEndpoint.status, 404);
    assert.equal(powerboxProbe.json.powerboxEndpoint.body.ok, false);
    assert.equal(powerboxProbe.json.powerboxEndpoint.body.error, "unknown claimed capability");

    const permissionValidation = await requestJson(
      fixture.workerdSocket, "/required-permission-validation-self-test");
    assert.equal(permissionValidation.statusCode, 200, permissionValidation.body);
    assert.equal(permissionValidation.json.ok, true);
    assert.match(permissionValidation.json.error,
      /unknown required permission: not-a-permission; this app defines permissions: view/);
    assert.match(permissionValidation.json.error,
      /requiredPermissions must use names from this app's viewInfo.permissions/);

    const storageHelper = await requestJson(fixture.workerdSocket, "/storage-helper-self-test");
    assert.equal(storageHelper.statusCode, 200, storageHelper.body);
    assert.equal(storageHelper.json.ok, true);
    assert.deepEqual(storageHelper.json.putBytes, { ok: true, bytes: 257 });
    assert.deepEqual(storageHelper.json.readBytes, {
      bytes: 257,
      checksum: checksum(Buffer.from(Array.from({ length: 257 }, (_, i) => i & 0xff))),
    });
    assert.equal(storageHelper.json.putJson.ok, true);
    assert.deepEqual(storageHelper.json.readJson, {
      fixture: "storage-helper",
      count: 3,
      nested: { ok: true },
    });
    assert.equal(storageHelper.json.missingBytes, undefined);
    assert.equal(storageHelper.json.deletedBytes.ok, true);
    assert.equal(storageHelper.json.deletedJson.ok, true);

    const powerboxGrants = await requestJson(
      fixture.workerdSocket, "/powerbox-grants-helper-self-test");
    assert.equal(powerboxGrants.statusCode, 200, powerboxGrants.body);
    assert.equal(powerboxGrants.json.ok, true);
    assert.equal(powerboxGrants.json.page.status, 200);
    assert.match(powerboxGrants.json.page.contentType, /text\/html/);
    assert.equal(powerboxGrants.json.page.hasElement, true);
    assert.equal(powerboxGrants.json.client.status, 200);
    assert.match(powerboxGrants.json.client.contentType, /text\/javascript/);
    assert.equal(powerboxGrants.json.client.hasRequestGrant, true);
    assert.equal(powerboxGrants.json.rpcClient.status, 200);
    assert.match(powerboxGrants.json.rpcClient.contentType, /text\/javascript/);
    assert.equal(powerboxGrants.json.rpcClient.hasRequestPowerbox, true);
    assert.equal(powerboxGrants.json.configBefore.ok, true);
    assert.equal(powerboxGrants.json.configBefore.routePrefix, "/grant-ui-test");
    assert.equal(powerboxGrants.json.configBefore.grants.length, 1);
    assert.equal(powerboxGrants.json.configBefore.grants[0].id, "shared");
    assert.equal(powerboxGrants.json.configBefore.grants[0].connected, false);
    assert.equal(powerboxGrants.json.configBefore.grants[0].saveLabel.defaultText,
      "Shared test capability");
    assert.deepEqual(powerboxGrants.json.configBefore.grants[0].requiredPermissions, ["view"]);
    assert.equal(powerboxGrants.json.statusBefore.ok, true);
    assert.equal(powerboxGrants.json.statusBefore.status.connected, false);
    assert.equal(powerboxGrants.json.claim.ok, true);
    assert.equal(powerboxGrants.json.claim.status.connected, true);
    assert.equal(powerboxGrants.json.claim.test.status, 200);
    assert.equal(powerboxGrants.json.claim.test.body.source, "isolate-browser-powerbox");
    assert.equal(powerboxGrants.json.claim.test.body.search, "?source=grant-test");
    assert.equal(powerboxGrants.json.tokenType, "string");
    assert.equal(powerboxGrants.json.used.capabilityClass, true);
    assert.equal(powerboxGrants.json.used.status, 200);
    assert.equal(powerboxGrants.json.used.body.source, "isolate-browser-powerbox");
    assert.equal(powerboxGrants.json.used.body.search, "?source=grant-use");
    assert.equal(powerboxGrants.json.statusAfterClaim.ok, true);
    assert.equal(powerboxGrants.json.statusAfterClaim.status.connected, true);
    assert.equal(powerboxGrants.json.revoke.ok, true);
    assert.equal(powerboxGrants.json.revoke.revoked, true);
    assert.equal(powerboxGrants.json.revoke.status.connected, false);
    assert.equal(powerboxGrants.json.statusAfterRevoke.ok, true);
    assert.equal(powerboxGrants.json.statusAfterRevoke.status.connected, false);

    const powerboxFulfillment = await requestJson(
      fixture.workerdSocket, "/powerbox-fulfillment-helper-self-test");
    assert.equal(powerboxFulfillment.statusCode, 200, powerboxFulfillment.body);
    assert.equal(powerboxFulfillment.json.ok, true);
    assert.equal(powerboxFulfillment.json.page.status, 200);
    assert.match(powerboxFulfillment.json.page.contentType, /text\/html/);
    assert.equal(powerboxFulfillment.json.page.hasButton, true);
    assert.equal(powerboxFulfillment.json.page.hasTitle, true);
    assert.equal(powerboxFulfillment.json.page.hasInlineScript, true);
    assert.equal(powerboxFulfillment.json.client.status, 404);
    assert.equal(powerboxFulfillment.json.unknown.status, 404);
    assert.equal(powerboxFulfillment.json.outsideIsNull, true);
    assert.equal(powerboxFulfillment.json.webFulfill, null);
    assert.equal(powerboxFulfillment.json.objectFulfill, null);
    assert.equal(powerboxFulfillment.json.durableFulfill, null);
    assert.equal(powerboxFulfillment.json.errorFulfill.status, 400);
    assert.equal(powerboxFulfillment.json.errorFulfill.body.ok, false);
    assert.match(powerboxFulfillment.json.errorFulfill.body.error,
      /powerbox fulfillment factory failed/);

  });

  if (REPRESENTATIVE_SYSCALL_TRACE) {
    return;
  }

  await t.test("exports route-backed WebSession capabilities", async () => {
    const exported = await requestJson(fixture.workerdSocket, "/export-web-session");
    assert.equal(exported.statusCode, 200, exported.body + formatOutput(
      fixture.stdout, fixture.stderr));
    assert.equal(exported.json.ok, true);
    assert.equal(exported.json.capabilityClass, true);
    assert.equal(exported.json.capability.type, "capability");
    assert.equal(typeof exported.json.capability.id, "string");

    const capabilityId = exported.json.capability.id;
    const capabilityInfo = await requestJson(
      fixture.sandstormApiSocket,
      `/capabilities/claimed?id=${encodeURIComponent(capabilityId)}`);
    assert.equal(capabilityInfo.statusCode, 200, capabilityInfo.body);
    assert.deepEqual(capabilityInfo.json, {
      ok: true,
      type: "claimedCapabilityInfo",
      id: capabilityId,
      kind: "routeBackedWebSession",
      residence: "localExport",
      nativeInterface: "webSession",
      pathPrefix: "/exported",
      persistent: true,
      hasDropNotify: false,
      dropNotifyRefCount: 0,
      supportsWebFetch: true,
      supportsOutboundHttpFetch: false,
      hasNativeCapability: true,
      liveForwardable: true,
    });

    const webSessionWithObjectPath = await requestJson(
      fixture.sandstormApiSocket,
      `/capabilities/web-session?pathPrefix=${
        encodeURIComponent("/__sandstorm/object-capabilities/web-session-stays-web")
      }&persistent=false`,
      { method: "POST" });
    assert.equal(webSessionWithObjectPath.statusCode, 200, webSessionWithObjectPath.body);
    assert.equal(webSessionWithObjectPath.json.ok, true);
    assert.equal(webSessionWithObjectPath.json.type, "claimedCapability");

    const webSessionWithObjectPathInfo = await requestJson(
      fixture.sandstormApiSocket,
      `/capabilities/claimed?id=${encodeURIComponent(webSessionWithObjectPath.json.id)}`);
    assert.equal(webSessionWithObjectPathInfo.statusCode, 200, webSessionWithObjectPathInfo.body);
    assert.equal(webSessionWithObjectPathInfo.json.kind, "routeBackedWebSession");
    assert.equal(webSessionWithObjectPathInfo.json.nativeInterface, "webSession");
    assert.equal(webSessionWithObjectPathInfo.json.supportsWebFetch, true);

    const objectCallOnWebSession = await requestJson(
      fixture.sandstormApiSocket,
      `/powerbox/native-app-rpc-call?id=${encodeURIComponent(webSessionWithObjectPath.json.id)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ method: "value", args: [] }),
      });
    assert.equal(objectCallOnWebSession.statusCode, 400, objectCallOnWebSession.body);
    assert.equal(objectCallOnWebSession.json.ok, false);
    assert.match(objectCallOnWebSession.json.error, /native interface webSession/);

    const dropWebSessionWithObjectPath = await requestJson(
      fixture.sandstormApiSocket,
      `/powerbox/drop?id=${encodeURIComponent(webSessionWithObjectPath.json.id)}`,
      { method: "POST" });
    assert.equal(dropWebSessionWithObjectPath.statusCode, 200, dropWebSessionWithObjectPath.body);
    assert.equal(dropWebSessionWithObjectPath.json.ok, true);

    const wrongNativeFetch = await requestJson(
      fixture.sandstormApiSocket,
      `/powerbox/outbound-http-fetch?id=${encodeURIComponent(capabilityId)}` +
      `&method=GET&path=${encodeURIComponent("v1/test")}`,
      { method: "POST" });
    assert.equal(wrongNativeFetch.statusCode, 400, wrongNativeFetch.body);
    assert.equal(wrongNativeFetch.json.ok, false);
    assert.match(wrongNativeFetch.json.error, /native interface webSession/);
    assert.match(wrongNativeFetch.json.error, /powerbox\.outboundHttpFetch/);

    const fetched = await requestJson(
      fixture.sandstormApiSocket,
      `/powerbox/fetch?id=${encodeURIComponent(capabilityId)}` +
      `&method=GET&path=${encodeURIComponent("/capability-echo?source=external")}`,
      { method: "POST" });
    assert.equal(fetched.statusCode, 200, fetched.body);
    assert.equal(fetched.json.ok, true);
    assert.equal(fetched.json.source, "exported-web-session");
    assert.equal(fetched.json.method, "GET");
    assert.equal(fetched.json.pathname, "/exported/capability-echo");
    assert.equal(fetched.json.search, "?source=external");
    assert.equal(fetched.json.body, "");
    assert.equal(fetched.json.bodyBytes, 0);
    assert.equal(fetched.headers.etag, "\"capability-echo-etag\"");
    assert.equal(fetched.headers["content-disposition"],
      "attachment; filename=\"capability-echo.json\"");
    assert.equal(fetched.headers["x-sandstorm-app-capability-response"], "present");

    const posted = await requestJson(
      fixture.sandstormApiSocket,
      `/powerbox/fetch?id=${encodeURIComponent(capabilityId)}` +
      `&method=POST&path=${encodeURIComponent("/capability-echo?source=external-post")}`,
      {
        method: "POST",
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: "hello through supervisor capability fetch",
      });
    assert.equal(posted.statusCode, 200, posted.body);
    assert.equal(posted.json.ok, true);
    assert.equal(posted.json.source, "exported-web-session");
    assert.equal(posted.json.method, "POST");
    assert.equal(posted.json.pathname, "/exported/capability-echo");
    assert.equal(posted.json.search, "?source=external-post");
    assert.equal(posted.json.body, "hello through supervisor capability fetch");
    assert.equal(posted.json.bodyBytes, "hello through supervisor capability fetch".length);
    assert.equal(posted.json.contentType, "text/plain; charset=utf-8");

    const prefixValidation = await requestJson(
      fixture.workerdSocket, "/route-prefix-validation-self-test");
    assert.equal(prefixValidation.statusCode, 200, prefixValidation.body);
    assert.equal(prefixValidation.json.ok, true);
    assert.equal(prefixValidation.json.results.dotSegmentPrefix.ok, false);
    assert.match(
      prefixValidation.json.results.dotSegmentPrefix.error,
      /pathPrefix|canonical|500/);
    assert.equal(prefixValidation.json.results.siblingDropNotifyPath.ok, false);
    assert.match(
      prefixValidation.json.results.siblingDropNotifyPath.error,
      /dropNotifyPath|400/);

    const streamed = await requestUnixSocket(
      fixture.sandstormApiSocket,
      `/powerbox/fetch?id=${encodeURIComponent(capabilityId)}` +
      `&method=GET&path=${encodeURIComponent("/download?bytes=131072")}`,
      { method: "POST" });
    assert.equal(streamed.statusCode, 200, streamed.body);
    assert.equal(streamed.headers["content-type"], "application/octet-stream");
    assert.equal(streamed.headers["x-sandstorm-app-download-bytes"], "131072");
    assert.equal(streamed.bodyBuffer.length, 131072);
    assert.equal(streamed.headers["x-isolate-test-checksum"], undefined);
    assert.equal(checksum(streamed.bodyBuffer), checksum(deterministicBytes(131072)));

    const notModified = await requestUnixSocket(
      fixture.sandstormApiSocket,
      `/powerbox/fetch?id=${encodeURIComponent(capabilityId)}` +
      `&method=GET&path=${encodeURIComponent("/capability-echo?source=not-modified")}` +
      `&headerName=${encodeURIComponent("if-none-match")}` +
      `&headerValue=${encodeURIComponent("\"capability-echo-etag\"")}`,
      { method: "POST" });
    assert.equal(notModified.statusCode, 304, notModified.body);
    assert.equal(notModified.headers.etag, "\"capability-echo-etag\"");
    assert.equal(notModified.bodyBuffer.length, 0);

    const preconditionFailed = await requestUnixSocket(
      fixture.sandstormApiSocket,
      `/powerbox/fetch?id=${encodeURIComponent(capabilityId)}` +
      `&method=GET&path=${encodeURIComponent("/capability-echo?source=precondition")}` +
      `&headerName=${encodeURIComponent("if-match")}` +
      `&headerValue=${encodeURIComponent("\"wrong-etag\"")}`,
      { method: "POST" });
    assert.equal(preconditionFailed.statusCode, 412, preconditionFailed.body);
    assert.equal(preconditionFailed.headers.etag, "\"capability-echo-etag\"");
    assert.equal(preconditionFailed.bodyBuffer.length, 0);

    const saved = await requestJson(
      fixture.sandstormApiSocket,
      `/powerbox/save?id=${encodeURIComponent(capabilityId)}` +
      `&label=${encodeURIComponent("Route-backed WebSession")}`,
      { method: "POST" });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json.ok, true);
    assert.equal(saved.json.type, "savedCapability");
    assert.equal(saved.json.id, capabilityId);
    assert.equal(saved.json.tokenEncoding, "base64url");
    assert.equal(typeof saved.json.token, "string");

    const drop = await requestJson(
      fixture.sandstormApiSocket,
      `/powerbox/drop?id=${encodeURIComponent(capabilityId)}`,
      { method: "POST" });
    assert.equal(drop.statusCode, 200, drop.body);
    assert.equal(drop.json.ok, true);

    await fixture.restart();

    const restored = await requestJson(
      fixture.sandstormApiSocket,
      `/powerbox/restore?token=${encodeURIComponent(saved.json.token)}`,
      { method: "POST" });
    assert.equal(restored.statusCode, 200, restored.body);
    assert.equal(restored.json.ok, true);
    assert.equal(restored.json.type, "claimedCapability");
    assert.equal(typeof restored.json.id, "string");

    const restoredInfo = await requestJson(
      fixture.sandstormApiSocket,
      `/capabilities/claimed?id=${encodeURIComponent(restored.json.id)}`);
    assert.equal(restoredInfo.statusCode, 200, restoredInfo.body);
    assert.deepEqual(restoredInfo.json, {
      ok: true,
      type: "claimedCapabilityInfo",
      id: restored.json.id,
      kind: "restored",
      residence: "imported",
      nativeInterface: "webSession",
      pathPrefix: "/exported",
      persistent: true,
      hasDropNotify: false,
      dropNotifyRefCount: 0,
      supportsWebFetch: true,
      supportsOutboundHttpFetch: false,
      hasNativeCapability: true,
      liveForwardable: true,
    });

    const restoredFetch = await requestJson(
      fixture.sandstormApiSocket,
      `/powerbox/fetch?id=${encodeURIComponent(restored.json.id)}` +
      `&method=GET&path=${encodeURIComponent("/capability-echo?source=restored")}`,
      { method: "POST" });
    assert.equal(restoredFetch.statusCode, 200, restoredFetch.body);
    assert.equal(restoredFetch.json.ok, true);
    assert.equal(restoredFetch.json.pathname, "/exported/capability-echo");
    assert.equal(restoredFetch.json.search, "?source=restored");
    assert.equal(restoredFetch.headers.etag, "\"capability-echo-etag\"");
    assert.equal(restoredFetch.headers["content-disposition"],
      "attachment; filename=\"capability-echo.json\"");
    assert.equal(restoredFetch.headers["x-sandstorm-app-capability-response"], "present");

    const dropRestored = await requestJson(
      fixture.sandstormApiSocket,
      `/powerbox/drop?id=${encodeURIComponent(restored.json.id)}`,
      { method: "POST" });
    assert.equal(dropRestored.statusCode, 200, dropRestored.body);
    assert.equal(dropRestored.json.ok, true);

    const dropSaved = await requestJson(
      fixture.sandstormApiSocket,
      `/powerbox/drop-saved?token=${encodeURIComponent(saved.json.token)}`,
      { method: "POST" });
    assert.equal(dropSaved.statusCode, 200, dropSaved.body);
    assert.equal(dropSaved.json.ok, true);
  });

  await t.test("saves and restores route-backed WebSession capabilities from isolate JS", async () => {
    const selfTest = await requestJson(
      fixture.workerdSocket, "/web-session-save-restore-self-test");
    assert.equal(selfTest.statusCode, 200, selfTest.body + formatOutput(
      fixture.stdout, fixture.stderr));
    assert.equal(selfTest.json.ok, true);
    assert.equal(selfTest.json.capabilityClass, true);
    assert.equal(selfTest.json.savedToken, true);
    assert.equal(selfTest.json.restoredClass, true);
    assert.equal(selfTest.json.capability.type, "capability");
    assert.equal(typeof selfTest.json.saved, "string");
    assert.equal(selfTest.json.restored.type, "capability");
    assert.equal(selfTest.json.wrongOutboundError.name, "ValidationError");
    assert.match(selfTest.json.wrongOutboundError.message, /WebSession and ApiSession/);
    assert.match(selfTest.json.wrongOutboundError.message, /absolute URLs are rejected/);
    assert.equal(selfTest.json.dropOriginal.ok, true);
    assert.equal(selfTest.json.fetched.status, 200);
    assert.equal(selfTest.json.fetched.headers.etag, "\"capability-echo-etag\"");
    assert.equal(selfTest.json.fetched.headers.contentDisposition,
      "attachment; filename=\"capability-echo.json\"");
    assert.equal(selfTest.json.fetched.headers.appResponseHeader, "present");
    assert.equal(selfTest.json.fetched.body.ok, true);
    assert.equal(selfTest.json.fetched.body.pathname, "/exported/capability-echo");
    assert.equal(selfTest.json.fetched.body.search, "?source=js-restore");
    assert.equal(selfTest.json.fetched.body.method, "GET");
    assert.equal(selfTest.json.fetched.body.body, "");
    assert.equal(selfTest.json.fetched.body.appHeader, "present");
    assert.equal(selfTest.json.fetched.body.blockedHeader, null);
    assert.equal(selfTest.json.posted.status, 200);
    assert.equal(selfTest.json.posted.body.ok, true);
    assert.equal(selfTest.json.posted.body.method, "POST");
    assert.equal(selfTest.json.posted.body.pathname, "/exported/capability-echo");
    assert.equal(selfTest.json.posted.body.search, "?source=js-post");
    assert.equal(selfTest.json.posted.body.body, "hello through capability fetch");
    assert.equal(selfTest.json.posted.body.bodyBytes,
      "hello through capability fetch".length);
    assert.equal(selfTest.json.posted.body.checksum,
      checksum(Buffer.from("hello through capability fetch")));
    assert.equal(selfTest.json.posted.body.contentType, "text/plain; charset=utf-8");
    assert.equal(selfTest.json.largePost.status, 200);
    assert.equal(selfTest.json.largePost.body.ok, true);
    assert.equal(selfTest.json.largePost.body.method, "POST");
    assert.equal(selfTest.json.largePost.body.pathname, "/exported/capability-echo");
    assert.equal(selfTest.json.largePost.body.search, "?source=js-large-post");
    assert.equal(selfTest.json.largePost.body.bodyBytes, 2 * 1024 * 1024);
    assert.equal(selfTest.json.largePost.body.checksum,
      checksum(deterministicBytes(2 * 1024 * 1024)));
    assert.equal(selfTest.json.largePost.body.contentType, "application/octet-stream");
    assert.equal(selfTest.json.notModified.status, 304);
    assert.equal(selfTest.json.notModified.etag, "\"capability-echo-etag\"");
    assert.equal(selfTest.json.notModified.bodyBytes, 0);
    assert.equal(selfTest.json.preconditionFailed.status, 412);
    assert.equal(selfTest.json.preconditionFailed.etag, "\"capability-echo-etag\"");
    assert.equal(selfTest.json.preconditionFailed.bodyBytes, 0);
    assert.equal(selfTest.json.dropRestored.ok, true);
    assert.equal(selfTest.json.dropSaved.ok, true);
  });

  await t.test("exports route-backed ApiSession capabilities", async () => {
    const exported = await requestJson(fixture.workerdSocket, "/export-api-session");
    assert.equal(exported.statusCode, 200, exported.body + formatOutput(
      fixture.stdout, fixture.stderr));
    assert.equal(exported.json.ok, true);
    assert.equal(exported.json.capabilityClass, true);
    assert.equal(exported.json.capability.type, "capability");
    assert.equal(typeof exported.json.capability.id, "string");

    const capabilityId = exported.json.capability.id;
    const capabilityInfo = await requestJson(
      fixture.sandstormApiSocket,
      `/capabilities/claimed?id=${encodeURIComponent(capabilityId)}`);
    assert.equal(capabilityInfo.statusCode, 200, capabilityInfo.body);
    assert.deepEqual(capabilityInfo.json, {
      ok: true,
      type: "claimedCapabilityInfo",
      id: capabilityId,
      kind: "routeBackedApiSession",
      residence: "localExport",
      nativeInterface: "apiSession",
      pathPrefix: "/api-exported",
      persistent: true,
      hasDropNotify: false,
      dropNotifyRefCount: 0,
      supportsWebFetch: true,
      supportsOutboundHttpFetch: false,
      hasNativeCapability: true,
      liveForwardable: true,
    });

    const wrongNativeFetch = await requestJson(
      fixture.sandstormApiSocket,
      `/powerbox/outbound-http-fetch?id=${encodeURIComponent(capabilityId)}` +
      `&method=GET&path=${encodeURIComponent("v1/test")}`,
      { method: "POST" });
    assert.equal(wrongNativeFetch.statusCode, 400, wrongNativeFetch.body);
    assert.equal(wrongNativeFetch.json.ok, false);
    assert.match(wrongNativeFetch.json.error, /native interface apiSession/);
    assert.match(wrongNativeFetch.json.error, /powerbox\.outboundHttpFetch/);

    const fetched = await requestJson(
      fixture.sandstormApiSocket,
      `/powerbox/fetch?id=${encodeURIComponent(capabilityId)}` +
      `&method=GET&path=${encodeURIComponent("/capability-echo?source=api-external")}`,
      { method: "POST" });
    assert.equal(fetched.statusCode, 200, fetched.body);
    assert.equal(fetched.json.ok, true);
    assert.equal(fetched.json.source, "exported-api-session");
    assert.equal(fetched.json.pathname, "/api-exported/capability-echo");
    assert.equal(fetched.json.search, "?source=api-external");

    const saved = await requestJson(
      fixture.sandstormApiSocket,
      `/powerbox/save?id=${encodeURIComponent(capabilityId)}` +
      `&label=${encodeURIComponent("Route-backed ApiSession")}`,
      { method: "POST" });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json.ok, true);
    assert.equal(saved.json.type, "savedCapability");
    assert.equal(saved.json.id, capabilityId);
    assert.equal(saved.json.tokenEncoding, "base64url");
    assert.equal(typeof saved.json.token, "string");

    const drop = await requestJson(
      fixture.sandstormApiSocket,
      `/powerbox/drop?id=${encodeURIComponent(capabilityId)}`,
      { method: "POST" });
    assert.equal(drop.statusCode, 200, drop.body);
    assert.equal(drop.json.ok, true);

    const restored = await requestJson(
      fixture.sandstormApiSocket,
      `/powerbox/restore?token=${encodeURIComponent(saved.json.token)}`,
      { method: "POST" });
    assert.equal(restored.statusCode, 200, restored.body);
    assert.equal(restored.json.ok, true);
    assert.equal(restored.json.type, "claimedCapability");
    assert.equal(typeof restored.json.id, "string");

    const restoredInfo = await requestJson(
      fixture.sandstormApiSocket,
      `/capabilities/claimed?id=${encodeURIComponent(restored.json.id)}`);
    assert.equal(restoredInfo.statusCode, 200, restoredInfo.body);
    assert.deepEqual(restoredInfo.json, {
      ok: true,
      type: "claimedCapabilityInfo",
      id: restored.json.id,
      kind: "restored",
      residence: "imported",
      nativeInterface: "apiSession",
      pathPrefix: "/api-exported",
      persistent: true,
      hasDropNotify: false,
      dropNotifyRefCount: 0,
      supportsWebFetch: true,
      supportsOutboundHttpFetch: false,
      hasNativeCapability: true,
      liveForwardable: true,
    });

    const restoredFetch = await requestJson(
      fixture.sandstormApiSocket,
      `/powerbox/fetch?id=${encodeURIComponent(restored.json.id)}` +
      `&method=GET&path=${encodeURIComponent("/capability-echo?source=api-restored")}`,
      { method: "POST" });
    assert.equal(restoredFetch.statusCode, 200, restoredFetch.body);
    assert.equal(restoredFetch.json.ok, true);
    assert.equal(restoredFetch.json.source, "exported-api-session");
    assert.equal(restoredFetch.json.pathname, "/api-exported/capability-echo");
    assert.equal(restoredFetch.json.search, "?source=api-restored");

    const dropRestored = await requestJson(
      fixture.sandstormApiSocket,
      `/powerbox/drop?id=${encodeURIComponent(restored.json.id)}`,
      { method: "POST" });
    assert.equal(dropRestored.statusCode, 200, dropRestored.body);
    assert.equal(dropRestored.json.ok, true);

    const dropSaved = await requestJson(
      fixture.sandstormApiSocket,
      `/powerbox/drop-saved?token=${encodeURIComponent(saved.json.token)}`,
      { method: "POST" });
    assert.equal(dropSaved.statusCode, 200, dropSaved.body);
    assert.equal(dropSaved.json.ok, true);
  });

  await t.test("saves and restores route-backed ApiSession capabilities from isolate JS", async () => {
    const selfTest = await requestJson(
      fixture.workerdSocket, "/api-session-save-restore-self-test");
    assert.equal(selfTest.statusCode, 200, selfTest.body + formatOutput(
      fixture.stdout, fixture.stderr));
    assert.equal(selfTest.json.ok, true);
    assert.equal(selfTest.json.capabilityClass, true);
    assert.equal(selfTest.json.savedToken, true);
    assert.equal(selfTest.json.restoredClass, true);
    assert.equal(selfTest.json.capability.type, "capability");
    assert.equal(typeof selfTest.json.saved, "string");
    assert.equal(selfTest.json.restored.type, "capability");
    assert.equal(selfTest.json.wrongOutboundError.name, "ValidationError");
    assert.match(selfTest.json.wrongOutboundError.message, /WebSession and ApiSession/);
    assert.match(selfTest.json.wrongOutboundError.message, /absolute URLs are rejected/);
    assert.equal(selfTest.json.dropOriginal.ok, true);
    assert.equal(selfTest.json.fetched.status, 200);
    assert.equal(selfTest.json.fetched.body.ok, true);
    assert.equal(selfTest.json.fetched.body.source, "exported-api-session");
    assert.equal(selfTest.json.fetched.body.pathname, "/api-exported/capability-echo");
    assert.equal(selfTest.json.fetched.body.search, "?source=api-js-restore");
    assert.equal(selfTest.json.dropRestored.ok, true);
    assert.equal(selfTest.json.dropSaved.ok, true);
  });

  await t.test("exports JavaScript object capabilities", async () => {
    const statsBeforeExport = await requestJson(
      fixture.sandstormApiSocket, "/capabilities/claimed-stats");
    assert.equal(statsBeforeExport.statusCode, 200, statsBeforeExport.body);

    const exported = await requestJson(fixture.workerdSocket, "/export-object-capability");
    assert.equal(exported.statusCode, 200, exported.body + formatOutput(
      fixture.stdout, fixture.stderr));
    assert.equal(exported.json.ok, true);
    assert.equal(exported.json.capabilityClass, true);
    assert.equal(exported.json.capability.type, "capability");
    assert.equal(typeof exported.json.capability.id, "string");

    const statsAfterParentExport = await requestJson(
      fixture.sandstormApiSocket, "/capabilities/claimed-stats");
    assert.equal(statsAfterParentExport.statusCode, 200, statsAfterParentExport.body);
    assert.equal(statsAfterParentExport.json.claimedCapabilityCount,
      statsBeforeExport.json.claimedCapabilityCount + 1);
    assert.equal(statsAfterParentExport.json.dropNotifyGroupCount,
      statsBeforeExport.json.dropNotifyGroupCount + 1);
    assert.equal(statsAfterParentExport.json.localExportCount,
      statsBeforeExport.json.localExportCount + 1);
    assert.equal(statsAfterParentExport.json.appObjectNativeCount,
      statsBeforeExport.json.appObjectNativeCount + 1);
    assert.equal(statsAfterParentExport.json.routeBackedAppObjectCount,
      statsBeforeExport.json.routeBackedAppObjectCount + 1);
    assert.equal(statsAfterParentExport.json.importedCount,
      statsBeforeExport.json.importedCount);

    const capabilityInfo = await requestJson(
      fixture.sandstormApiSocket,
      `/capabilities/claimed?id=${encodeURIComponent(exported.json.capability.id)}`);
    assert.equal(capabilityInfo.statusCode, 200, capabilityInfo.body);
    assert.equal(capabilityInfo.json.ok, true);
    assert.equal(capabilityInfo.json.type, "claimedCapabilityInfo");
    assert.equal(capabilityInfo.json.id, exported.json.capability.id);
    assert.equal(capabilityInfo.json.kind, "routeBackedAppObject");
    assert.equal(capabilityInfo.json.residence, "localExport");
    assert.equal(capabilityInfo.json.nativeInterface, "appObject");
    assert.match(capabilityInfo.json.pathPrefix, /^\/__sandstorm\/object-capabilities\//);
    assert.equal(capabilityInfo.json.persistent, false);
    assert.equal(capabilityInfo.json.hasDropNotify, true);
    assert.equal(capabilityInfo.json.dropNotifyRefCount, 1);
    assert.equal(capabilityInfo.json.supportsWebFetch, false);
    assert.equal(capabilityInfo.json.supportsOutboundHttpFetch, false);
    assert.equal(capabilityInfo.json.hasNativeCapability, true);
    assert.equal(capabilityInfo.json.liveForwardable, true);

    function nativeNumber(value) {
      return { type: "number", value };
    }

    function nativeCapability(id) {
      return { type: "capability", value: { id, nativeInterface: "appObject" } };
    }

    function nativeCounterValue(value) {
      return {
        type: "value",
        value: {
          type: "object",
          value: [{ name: "value", value: nativeNumber(value) }],
        },
      };
    }

    async function callObjectCapability(id, method, args = []) {
      return requestJson(
        fixture.sandstormApiSocket,
        `/powerbox/native-app-rpc-call?id=${encodeURIComponent(id)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({ method, args }),
        });
    }

    const first = await callObjectCapability(
      exported.json.capability.id, "increment", [nativeNumber(5)]);
    assert.equal(first.statusCode, 200, first.body);
    assert.deepEqual(first.json, nativeCounterValue(5));

    const second = await callObjectCapability(
      exported.json.capability.id, "increment", [nativeNumber(2)]);
    assert.equal(second.statusCode, 200, second.body);
    assert.deepEqual(second.json, nativeCounterValue(7));

    const current = await callObjectCapability(exported.json.capability.id, "get");
    assert.equal(current.statusCode, 200, current.body);
    assert.deepEqual(current.json, nativeCounterValue(7));

    const child = await callObjectCapability(exported.json.capability.id, "child");
    assert.equal(child.statusCode, 200, child.body);
    assert.equal(child.json.type, "value");
    assert.equal(child.json.value.type, "capability");
    assert.equal(typeof child.json.value.value.id, "string");
    assert.equal(child.json.value.value.nativeInterface, "appObject");
    const childId = child.json.value.value.id;

    const statsAfterChildExport = await requestJson(
      fixture.sandstormApiSocket, "/capabilities/claimed-stats");
    assert.equal(statsAfterChildExport.statusCode, 200, statsAfterChildExport.body);
    assert.equal(statsAfterChildExport.json.claimedCapabilityCount,
      statsAfterParentExport.json.claimedCapabilityCount + 2);
    assert.equal(statsAfterChildExport.json.dropNotifyGroupCount,
      statsAfterParentExport.json.dropNotifyGroupCount + 1);
    assert.equal(statsAfterChildExport.json.localExportCount,
      statsAfterParentExport.json.localExportCount + 1);
    assert.equal(statsAfterChildExport.json.appObjectNativeCount,
      statsAfterParentExport.json.appObjectNativeCount + 2);
    assert.equal(statsAfterChildExport.json.routeBackedAppObjectCount,
      statsAfterParentExport.json.routeBackedAppObjectCount + 1);
    assert.equal(statsAfterChildExport.json.importedCount,
      statsAfterParentExport.json.importedCount + 1);

    const childIncrement = await callObjectCapability(childId, "increment", [nativeNumber(9)]);
    assert.equal(childIncrement.statusCode, 200, childIncrement.body);
    assert.deepEqual(childIncrement.json, nativeCounterValue(9));

    const parentReadsChild = await callObjectCapability(
      exported.json.capability.id, "readOther", [nativeCapability(childId)]);
    assert.equal(parentReadsChild.statusCode, 200, parentReadsChild.body);
    assert.deepEqual(parentReadsChild.json, nativeCounterValue(9));

    const missing = await callObjectCapability(exported.json.capability.id, "missingMethod");
    assert.equal(missing.statusCode, 200, missing.body);
    assert.equal(missing.json.type, "exception");
    assert.match(missing.json.value.message, /RPC method not found/);

    const disposeBefore = await requestJson(
      fixture.workerdSocket, "/object-capability-dispose-count");
    assert.equal(disposeBefore.statusCode, 200, disposeBefore.body);
    assert.equal(disposeBefore.json.ok, true);

    const dropChild = await requestJson(
      fixture.sandstormApiSocket,
      `/powerbox/drop?id=${encodeURIComponent(childId)}`,
      { method: "POST" });
    assert.equal(dropChild.statusCode, 200, dropChild.body);
    assert.equal(dropChild.json.ok, true);

    const statsAfterChildDrop = await requestJson(
      fixture.sandstormApiSocket, "/capabilities/claimed-stats");
    assert.equal(statsAfterChildDrop.statusCode, 200, statsAfterChildDrop.body);
    assert.equal(statsAfterChildDrop.json.claimedCapabilityCount,
      statsAfterParentExport.json.claimedCapabilityCount + 1);
    assert.equal(statsAfterChildDrop.json.dropNotifyGroupCount,
      statsAfterParentExport.json.dropNotifyGroupCount);
    assert.equal(statsAfterChildDrop.json.localExportCount,
      statsAfterParentExport.json.localExportCount);
    assert.equal(statsAfterChildDrop.json.appObjectNativeCount,
      statsAfterParentExport.json.appObjectNativeCount + 1);
    assert.equal(statsAfterChildDrop.json.routeBackedAppObjectCount,
      statsAfterParentExport.json.routeBackedAppObjectCount);
    assert.equal(statsAfterChildDrop.json.importedCount,
      statsAfterParentExport.json.importedCount + 1);

    const disposeAfterChild = await requestJson(
      fixture.workerdSocket, "/object-capability-dispose-count");
    assert.equal(disposeAfterChild.statusCode, 200, disposeAfterChild.body);
    assert.equal(disposeAfterChild.json.disposed, disposeBefore.json.disposed + 1,
      formatOutput(fixture.stdout, fixture.stderr));

    const drop = await requestJson(
      fixture.sandstormApiSocket,
      `/powerbox/drop?id=${encodeURIComponent(exported.json.capability.id)}`,
      { method: "POST" });
    assert.equal(drop.statusCode, 200, drop.body);
    assert.equal(drop.json.ok, true);

    const statsAfterParentDrop = await requestJson(
      fixture.sandstormApiSocket, "/capabilities/claimed-stats");
    assert.equal(statsAfterParentDrop.statusCode, 200, statsAfterParentDrop.body);
    assert.equal(statsAfterParentDrop.json.claimedCapabilityCount,
      statsBeforeExport.json.claimedCapabilityCount + 1);
    assert.equal(statsAfterParentDrop.json.dropNotifyGroupCount,
      statsBeforeExport.json.dropNotifyGroupCount);
    assert.equal(statsAfterParentDrop.json.localExportCount,
      statsBeforeExport.json.localExportCount);
    assert.equal(statsAfterParentDrop.json.appObjectNativeCount,
      statsBeforeExport.json.appObjectNativeCount + 1);
    assert.equal(statsAfterParentDrop.json.routeBackedAppObjectCount,
      statsBeforeExport.json.routeBackedAppObjectCount);
    assert.equal(statsAfterParentDrop.json.importedCount,
      statsBeforeExport.json.importedCount + 1);

    const disposeAfterParent = await requestJson(
      fixture.workerdSocket, "/object-capability-dispose-count");
    assert.equal(disposeAfterParent.statusCode, 200, disposeAfterParent.body);
    assert.equal(disposeAfterParent.json.disposed, disposeBefore.json.disposed + 2,
      formatOutput(fixture.stdout, fixture.stderr));

    const selfTest = await requestJson(
      fixture.workerdSocket, "/object-capability-self-test?persistentHelper=true");
    assert.equal(selfTest.statusCode, 200, selfTest.body);
    assert.deepEqual(selfTest.json.first, { value: 3 });
    assert.deepEqual(selfTest.json.second, { value: 7 });
    assert.deepEqual(selfTest.json.current, { value: 7 });
    assert.equal(selfTest.json.childClass, true);
    assert.equal(selfTest.json.childCapabilityAliasClass, true);
    assert.equal(selfTest.json.child.type, "capability");
    assert.equal(selfTest.json.capabilityInfo.ok, true);
    assert.equal(selfTest.json.capabilityInfo.type, "capabilityInfo");
    assert.equal(selfTest.json.capabilityInfo.id, selfTest.json.duplicate.sourceId);
    assert.equal(selfTest.json.capabilityInfo.kind, "routeBackedAppObject");
    assert.equal(selfTest.json.capabilityInfo.residence, "localExport");
    assert.equal(selfTest.json.capabilityInfo.nativeInterface, "appObject");
    assert.match(
      selfTest.json.capabilityInfo.pathPrefix, /^\/__sandstorm\/object-capabilities\//);
    assert.equal(selfTest.json.capabilityInfo.persistent, false);
    assert.equal(selfTest.json.capabilityInfo.hasDropNotify, true);
    assert.equal(selfTest.json.capabilityInfo.dropNotifyRefCount, 1);
    assert.equal(selfTest.json.capabilityInfo.supportsWebFetch, false);
    assert.equal(selfTest.json.capabilityInfo.supportsOutboundHttpFetch, false);
    assert.equal(selfTest.json.capabilityInfo.hasNativeCapability, true);
    assert.equal(selfTest.json.capabilityInfo.liveForwardable, true);
    assert.equal(typeof selfTest.json.childInfo.id, "string");
    assert.equal(selfTest.json.childInfo.ok, true);
    assert.equal(selfTest.json.childInfo.type, "capabilityInfo");
    assert.equal(selfTest.json.childInfo.kind, "routeBackedAppObject");
    assert.equal(selfTest.json.childInfo.residence, "localExport");
    assert.equal(selfTest.json.childInfo.nativeInterface, "appObject");
    assert.match(
      selfTest.json.childInfo.pathPrefix, /^\/__sandstorm\/object-capabilities\//);
    assert.equal(selfTest.json.childInfo.persistent, false);
    assert.equal(selfTest.json.childInfo.hasDropNotify, true);
    assert.equal(selfTest.json.childInfo.dropNotifyRefCount, 1);
    assert.equal(selfTest.json.childInfo.supportsWebFetch, false);
    assert.equal(selfTest.json.childInfo.supportsOutboundHttpFetch, false);
    assert.equal(selfTest.json.childInfo.hasNativeCapability, true);
    assert.equal(selfTest.json.childInfo.liveForwardable, true);
    assert.deepEqual(selfTest.json.childFirst, { value: 11 });
    assert.deepEqual(selfTest.json.readChild, { value: 11 });
    assert.equal(selfTest.json.rpcStable, true);
    assert.deepEqual(selfTest.json.rpcCurrent, { value: 7 });
    assert.deepEqual(selfTest.json.stubFirst, { value: 9 });
    assert.deepEqual(selfTest.json.stubCurrent, { value: 9 });
    assert.equal(selfTest.json.stubChildClass, true);
    assert.equal(selfTest.json.stubChild.type, "capability");
    assert.deepEqual(selfTest.json.stubChildFirst, { value: 13 });
    assert.deepEqual(selfTest.json.stubReadChild, { value: 13 });
    assert.equal(selfTest.json.argumentTarget.rawError.name, "ValidationError");
    assert.match(selfTest.json.argumentTarget.rawError.message, /api\.export\(\)/);
    assert.deepEqual(selfTest.json.argumentTarget.read, { value: 21 });
    assert.equal(selfTest.json.argumentTarget.drop.ok, true);
    assert.equal(selfTest.json.argumentTarget.disposeAfter,
      selfTest.json.argumentTarget.disposeBefore + 1);
    assert.equal(selfTest.json.stubArgumentTarget.rawError.name, "ValidationError");
    assert.match(selfTest.json.stubArgumentTarget.rawError.message, /api\.export\(\)/);
    assert.deepEqual(selfTest.json.stubArgumentTarget.read, { value: 23 });
    assert.equal(selfTest.json.stubArgumentTarget.disposeAfter,
      selfTest.json.stubArgumentTarget.disposeBefore + 1);
    assert.equal(selfTest.json.retainedArgumentTarget.rawError.name, "ValidationError");
    assert.match(selfTest.json.retainedArgumentTarget.rawError.message, /api\.export\(\)/);
    assert.deepEqual(selfTest.json.retainedArgumentTarget.retain, { value: 31 });
    assert.equal(selfTest.json.retainedArgumentTarget.disposeAfterRetainCall,
      selfTest.json.retainedArgumentTarget.disposeBefore);
    assert.deepEqual(selfTest.json.retainedArgumentTarget.read, { value: 31 });
    assert.equal(selfTest.json.retainedArgumentTarget.drop.ok, true);
    assert.equal(selfTest.json.retainedArgumentTarget.disposeAfterDrop,
      selfTest.json.retainedArgumentTarget.disposeBefore + 1);
    assert.deepEqual(selfTest.json.liveCallback.subscription, {
      ok: true,
      receiverType: "capability",
      result: {
        ok: true,
        count: 1,
        subject: "phase-3-live-callback",
      },
    });
    assert.deepEqual(selfTest.json.liveCallback.events, [
      {
        subject: "phase-3-live-callback",
        unread: 2,
      },
    ]);
    assert.equal(selfTest.json.liveCallback.disposeAfter,
      selfTest.json.liveCallback.disposeBefore + 1);
    assert.equal(selfTest.json.liveCallback.sessionClass, true);
    assert.equal(selfTest.json.liveCallback.session.type, "capability");
    assert.deepEqual(selfTest.json.liveCallback.sessionFirst, { value: 7 });
    assert.equal(selfTest.json.liveCallback.sessionDrop.ok, true);
    assert.equal(selfTest.json.liveCallback.feedDrop.ok, true);
    assert.equal(selfTest.json.stubThenType, "undefined");
    assert.equal(selfTest.json.missing.name, "CapabilityCallError");
    assert.match(selfTest.json.missing.message, /RPC method not found: missingMethod/);
    assert.equal(selfTest.json.missing.status, undefined);
    assert.equal(selfTest.json.saveError.name, "Error");
    assert.match(selfTest.json.saveError.message, /transient and cannot be saved/);
    assert.match(selfTest.json.saveError.message, /exportDurable/);
    assert.equal(selfTest.json.remoteArguments.rpcTargetError.name, "UnsupportedCapabilityError");
    assert.match(selfTest.json.remoteArguments.rpcTargetError.message,
      /nativeInterface unknown cannot be used with app-defined RPC/);
    assert.equal(selfTest.json.remoteArguments.capabilityError.name, "UnsupportedCapabilityError");
    assert.match(selfTest.json.remoteArguments.capabilityError.message,
      /nativeInterface unknown cannot be used with app-defined RPC/);
    assert.equal(typeof selfTest.json.duplicate.id, "string");
    assert.notEqual(selfTest.json.duplicate.id, selfTest.json.duplicate.sourceId);
    assert.equal(selfTest.json.duplicate.originalInfoWithDuplicateLive.id,
      selfTest.json.duplicate.sourceId);
    assert.equal(selfTest.json.duplicate.originalInfoWithDuplicateLive.dropNotifyRefCount, 2);
    assert.equal(selfTest.json.duplicate.duplicateInfoBeforeDrop.id,
      selfTest.json.duplicate.id);
    assert.equal(selfTest.json.duplicate.duplicateInfoBeforeDrop.residence, "imported");
    assert.equal(selfTest.json.duplicate.duplicateInfoBeforeDrop.nativeInterface, "appObject");
    assert.equal(selfTest.json.duplicate.duplicateInfoBeforeDrop.dropNotifyRefCount, 0);
    assert.deepEqual(selfTest.json.duplicate.increment, { value: 14 });
    assert.equal(selfTest.json.duplicate.dropOriginal.ok, true);
    assert.equal(selfTest.json.duplicate.disposeAfterOriginalDrop,
      selfTest.json.duplicate.disposeBeforeDrop);
    assert.equal(selfTest.json.duplicate.duplicateInfoAfterOriginalDrop.id,
      selfTest.json.duplicate.id);
    assert.equal(selfTest.json.duplicate.duplicateInfoAfterOriginalDrop.dropNotifyRefCount, 0);
    assert.deepEqual(selfTest.json.duplicate.afterOriginalDrop, { value: 14 });
    assert.equal(selfTest.json.duplicate.dropDuplicate.ok, true);
    assert.equal(selfTest.json.duplicate.dropDuplicate.released, true);
    assert.equal(selfTest.json.duplicate.duplicateInfoAfterDrop, null);
    assert.equal(selfTest.json.duplicate.disposeAfterDuplicateDrop,
      selfTest.json.duplicate.disposeBeforeDrop + 1);
    assert.deepEqual(selfTest.json.stable.first, { value: 17 });
    assert.equal(selfTest.json.stable.duplicateError.name, "ValidationError");
    assert.match(selfTest.json.stable.duplicateError.message, /already registered/);
    assert.equal(selfTest.json.stable.drop.ok, true);
    assert.deepEqual(selfTest.json.stable.recreatedFirst, { value: 19 });
    assert.equal(selfTest.json.stable.recreatedDrop.ok, true);
    assert.equal(selfTest.json.persistent.withoutIdError.name, "ValidationError");
    assert.match(selfTest.json.persistent.withoutIdError.message, /api\.exportDurable/);
    assert.deepEqual(selfTest.json.persistent.first, { value: 29 });
    assert.equal(typeof selfTest.json.persistent.saved, "string");
    assert.equal(selfTest.json.persistent.restored.type, "capability");
    assert.deepEqual(selfTest.json.persistent.restoredGet, { value: 29 });
    assert.deepEqual(selfTest.json.persistent.restoredIncrement, { value: 32 });
    assert.equal(selfTest.json.persistent.dropOriginal.ok, true);
    assert.equal(selfTest.json.persistent.dropRestored.ok, true);
    assert.equal(selfTest.json.persistent.duplicateExportError.name, "ValidationError");
    assert.match(selfTest.json.persistent.duplicateExportError.message, /already registered/);
    assert.equal(selfTest.json.persistent.transientMintError.name, "ValidationError");
    assert.match(selfTest.json.persistent.transientMintError.message, /api\.exportDurable/);
    assert.equal(selfTest.json.persistent.mintedAfterRegister.type, "capability");
    assert.deepEqual(selfTest.json.persistent.mintedAfterRegisterGet, { value: 32 });
    assert.equal(selfTest.json.persistent.dropMintedAfterRegister.ok, true);
    assert.equal(selfTest.json.persistent.restoredAfterRegister.type, "capability");
    assert.deepEqual(selfTest.json.persistent.restoredAfterRegisterGet, { value: 32 });
    assert.equal(selfTest.json.persistent.dropRestoredAfterRegister.ok, true);
    assert.equal(selfTest.json.persistent.topLevelRestored.type, "capability");
    assert.deepEqual(selfTest.json.persistent.topLevelRestoreGet, { value: 32 });
    assert.equal(selfTest.json.persistent.dropTopLevelRestored.ok, true);
    assert.deepEqual(selfTest.json.persistent.useGet, { value: 32 });
    assert.equal(selfTest.json.persistent.dropSaved.ok, true);
    assert.equal(selfTest.json.persistent.helper.export.capability.type, "capability");
    assert.deepEqual(selfTest.json.persistent.helper.export.increment, { value: 61 });
    assert.equal(selfTest.json.persistent.helper.export.drop.ok, true);
    assert.deepEqual(selfTest.json.persistent.helper.withExport.read, { value: 62 });
    assert.equal(selfTest.json.persistent.helper.durableExport.restored, false);
    assert.equal(selfTest.json.persistent.helper.durableExport.registered, true);
    assert.equal(
      selfTest.json.persistent.helper.durableExport.capability.type, "capability");
    assert.equal(selfTest.json.persistent.helper.durableExport.tokenType, "string");
    assert.equal(selfTest.json.persistent.helper.durableExport.savedType, "undefined");
    assert.equal(selfTest.json.persistent.helper.durableExport.missingLabelError.name,
      "ValidationError");
    assert.match(selfTest.json.persistent.helper.durableExport.missingLabelError.message,
      /exportDurable label is required/);
    assert.equal(selfTest.json.persistent.helper.durableExport.missingRegistryError.name,
      "ValidationError");
    assert.match(selfTest.json.persistent.helper.durableExport.missingRegistryError.message,
      /durable capability id is not registered/);
    assert.match(selfTest.json.persistent.helper.durableExport.missingRegistryError.message,
      /Restore the capabilities registry entry, migrate the saved token, or revoke it/);
    assert.deepEqual(selfTest.json.persistent.helper.durableExport.get, { value: 71 });
    assert.equal(selfTest.json.persistent.helper.durableExport.drop.ok, true);
    assert.equal(selfTest.json.persistent.helper.durableExport.revoke.ok, true);
    assert.equal(selfTest.json.persistent.helper.durableExport.deleteStorage.ok, true);
    assert.equal(selfTest.json.persistent.helper.unstoredDurableExport.restored, false);
    assert.equal(selfTest.json.persistent.helper.unstoredDurableExport.registered, true);
    assert.equal(selfTest.json.persistent.helper.unstoredDurableExport.storageKeyType,
      "undefined");
    assert.equal(selfTest.json.persistent.helper.unstoredDurableExport.tokenType, "string");
    assert.equal(selfTest.json.persistent.helper.unstoredDurableExport.defaultStoredType,
      "undefined");
    assert.deepEqual(selfTest.json.persistent.helper.unstoredDurableExport.get, { value: 73 });
    assert.equal(selfTest.json.persistent.helper.unstoredDurableExport.drop.ok, true);
    assert.equal(selfTest.json.persistent.helper.unstoredDurableExport.revoke.ok, true);
    assert.equal(selfTest.json.persistent.helper.registry.factoryCallsAfterCreate, 0);
    assert.equal(selfTest.json.persistent.helper.registry.route.status, 200);
    assert.deepEqual(selfTest.json.persistent.helper.registry.route.body, {
      type: "value",
      value: {
        type: "object",
        value: [
          { name: "value", value: { type: "number", value: 83 } },
        ],
      },
    });
    assert.equal(selfTest.json.persistent.helper.registry.route.factoryCallsAfterRoute, 1);
    assert.equal(selfTest.json.persistent.helper.registry.export.factoryCallsBeforeExport, 1);
    assert.equal(selfTest.json.persistent.helper.registry.export.factoryCallsAfterExport, 2);
    assert.equal(selfTest.json.persistent.helper.registry.export.restored, false);
    assert.equal(selfTest.json.persistent.helper.registry.export.registered, true);
    assert.equal(selfTest.json.persistent.helper.registry.export.tokenType, "string");
    assert.deepEqual(selfTest.json.persistent.helper.registry.export.get, { value: 89 });
    assert.equal(selfTest.json.persistent.helper.registry.export.drop.ok, true);
    assert.equal(selfTest.json.persistent.helper.registry.export.revoke.ok, true);
    assert.equal(selfTest.json.persistent.helper.first.restored, false);
    assert.equal(selfTest.json.persistent.helper.first.registered, true);
    assert.equal(selfTest.json.persistent.helper.first.capability.type, "capability");
    assert.equal(selfTest.json.persistent.helper.first.tokenType, "string");
    assert.deepEqual(selfTest.json.persistent.helper.first.get, { value: 53 });
    assert.equal(selfTest.json.persistent.helper.first.drop.ok, true);
    assert.equal(selfTest.json.persistent.helper.second.restored, true);
    assert.equal(selfTest.json.persistent.helper.second.registered, false);
    assert.equal(selfTest.json.persistent.helper.second.capability.type, "capability");
    assert.equal(selfTest.json.persistent.helper.second.tokenType, "string");
    assert.deepEqual(selfTest.json.persistent.helper.second.get, { value: 53 });
    assert.equal(selfTest.json.persistent.helper.second.drop.ok, true);
    assert.equal(selfTest.json.persistent.helper.dropSaved.ok, true);
    assert.equal(selfTest.json.persistent.helper.deleteStorage.ok, true);
    assert.equal(
      selfTest.json.persistent.helper.callback.storageKey,
      selfTest.json.persistent.helper.callback.expectedStorageKey);
    assert.equal(selfTest.json.persistent.helper.callback.first.restored, false);
    assert.equal(selfTest.json.persistent.helper.callback.first.registered, true);
    assert.equal(
      selfTest.json.persistent.helper.callback.first.capability.type, "capability");
    assert.equal(selfTest.json.persistent.helper.callback.first.tokenType, "string");
    assert.deepEqual(selfTest.json.persistent.helper.callback.first.event, {
      ok: true,
      count: 1,
      subject: "phase-6-durable-callback-first",
    });
    assert.equal(selfTest.json.persistent.helper.callback.first.drop.ok, true);
    assert.equal(selfTest.json.persistent.helper.callback.second.restored, true);
    assert.equal(selfTest.json.persistent.helper.callback.second.registered, false);
    assert.equal(
      selfTest.json.persistent.helper.callback.second.capability.type, "capability");
    assert.equal(selfTest.json.persistent.helper.callback.second.tokenType, "string");
    assert.deepEqual(selfTest.json.persistent.helper.callback.second.event, {
      ok: true,
      count: 2,
      subject: "phase-6-durable-callback-restored",
    });
    assert.equal(selfTest.json.persistent.helper.callback.second.drop.ok, true);
    assert.deepEqual(selfTest.json.persistent.helper.callback.events, [
      {
        subject: "phase-6-durable-callback-first",
        unread: 7,
      },
      {
        subject: "phase-6-durable-callback-restored",
        unread: 9,
      },
    ]);
    assert.equal(selfTest.json.persistent.helper.callback.dropSaved.ok, true);
    assert.equal(selfTest.json.persistent.helper.callback.deleteStorage.ok, true);
  });

  await t.test("round trips generated capnp bindings over object capabilities", async () => {
    const selfTest = await requestJson(
      fixture.workerdSocket, "/capnp-binding-object-self-test");
    assert.equal(selfTest.statusCode, 200, selfTest.body + formatOutput(
      fixture.stdout, fixture.stderr));
    assert.equal(selfTest.json.ok, true);
    assert.equal(selfTest.json.helperVersion, 0);
    assert.equal(selfTest.json.interfaceName, "GeneratedCounter");
    assert.equal(selfTest.json.interfaceId, "");
    assert.equal(selfTest.json.schemaPath, "test/generated-counter.capnp");
    assert.deepEqual(selfTest.json.methodNames, [
      "increment",
      "get",
      "child",
      "children",
      "readOther",
      "readNested",
      "nestedChildren",
      "mirrorSession",
      "fail",
    ]);
    assert.deepEqual(selfTest.json.schema, {
      importSpecifier: "capnp:test/generated-counter.capnp",
      interfaceName: "GeneratedCounter",
      interfaceId: "",
      schemaPath: "test/generated-counter.capnp",
      schemaText: [
        "@0xd8c883d5220f7e53;",
        "using WebSession = import \"/sandstorm/web-session.capnp\".WebSession;",
        "interface GeneratedCounter {",
        "  increment @0 (amount :Float64) -> (value :Float64);",
        "  get @1 () -> (value :Float64);",
        "  child @2 () -> (counter :GeneratedCounter);",
        "  children @3 () -> (left :GeneratedCounter, right :GeneratedCounter);",
        "  readOther @4 (other :GeneratedCounter) -> (value :Float64);",
        "  readNested @5 (wrapper :AnyPointer) -> (value :Float64);",
        "  nestedChildren @6 () -> (group :AnyPointer);",
        "  mirrorSession @7 (session :WebSession) -> (session :WebSession);",
        "  fail @8 (message :Text) -> ();",
        "}",
      ].join("\n"),
      methodNames: [
        "increment",
        "get",
        "child",
        "children",
        "readOther",
        "readNested",
        "nestedChildren",
        "mirrorSession",
        "fail",
      ],
      methodIds: {},
      paramStructIds: {},
      resultStructIds: {},
      argumentCapabilities: {
        readOther: { indexes: [0] },
        readNested: { paths: [[["wrapper", "other"], null]] },
        mirrorSession: {
          fields: {
            session: {
              nativeInterface: "webSession",
              fetch: true,
            },
          },
        },
      },
      resultCapabilityNames: ["child", "children", "nestedChildren", "mirrorSession"],
    });
    assert.deepEqual(selfTest.json.local.first, { value: 2 });
    assert.deepEqual(selfTest.json.local.current, { value: 2 });
    assert.deepEqual(selfTest.json.local.child.first, { value: 3 });
    assert.deepEqual(selfTest.json.local.child.current, { value: 3 });
    assert.deepEqual(selfTest.json.local.child.read, { value: 3 });
    assert.deepEqual(selfTest.json.local.children.left, { value: 19 });
    assert.deepEqual(selfTest.json.local.children.right, { value: 23 });
    assert.deepEqual(selfTest.json.local.nested.read, { value: 3 });
    assert.deepEqual(selfTest.json.local.nested.left, { value: 37 });
    assert.deepEqual(selfTest.json.local.nested.right, { value: 41 });
    assert.equal(selfTest.json.transient.capability.type, "capability");
    assert.deepEqual(selfTest.json.transient.first, { value: 5 });
    assert.deepEqual(selfTest.json.transient.current, { value: 5 });
    assert.equal(selfTest.json.child.capability.type, "capability");
    assert.deepEqual(selfTest.json.child.first, { value: 7 });
    assert.deepEqual(selfTest.json.child.read, { value: 7 });
    assert.equal(selfTest.json.child.drop.ok, true);
    assert.equal(selfTest.json.children.leftCapability.type, "capability");
    assert.equal(selfTest.json.children.rightCapability.type, "capability");
    assert.deepEqual(selfTest.json.children.left, { value: 29 });
    assert.deepEqual(selfTest.json.children.right, { value: 31 });
    assert.equal(selfTest.json.children.leftDrop.ok, true);
    assert.equal(selfTest.json.children.rightDrop.ok, true);
    assert.deepEqual(selfTest.json.nested.read, { value: 7 });
    assert.equal(selfTest.json.nested.leftCapability.type, "capability");
    assert.equal(selfTest.json.nested.rightCapability.type, "capability");
    assert.deepEqual(selfTest.json.nested.left, { value: 43 });
    assert.deepEqual(selfTest.json.nested.right, { value: 47 });
    assert.equal(selfTest.json.nested.leftDrop.ok, true);
    assert.equal(selfTest.json.nested.rightDrop.ok, true);
    assert.equal(selfTest.json.mirroredSession.capability.type, "capability");
    assert.equal(selfTest.json.mirroredSession.info.nativeInterface, "webSession");
    assert.equal(selfTest.json.mirroredSession.fetch.status, 200);
    assert.equal(selfTest.json.mirroredSession.fetch.body.pathname, "/exported/capability-echo");
    assert.equal(selfTest.json.mirroredSession.fetch.body.search, "?source=capnp-mirror");
    assert.equal(selfTest.json.mirroredSession.drop.ok, true);
    assert.equal(selfTest.json.mirroredSession.wrongSessionError.name, "TypeError");
    assert.match(
      selfTest.json.mirroredSession.wrongSessionError.message,
      /argument capability nativeInterface appObject does not match declared webSession/);
    assert.equal(selfTest.json.durable.registered, true);
    assert.equal(selfTest.json.durable.restored, false);
    assert.equal(selfTest.json.durable.tokenType, "string");
    assert.equal(selfTest.json.durable.castSavedType, "string");
    assert.deepEqual(selfTest.json.durable.get, { value: 11 });
    assert.deepEqual(selfTest.json.durable.increment, { value: 24 });
    assert.equal(selfTest.json.durable.drop.ok, true);
    assert.equal(selfTest.json.durable.restoredCapability.type, "capability");
    assert.deepEqual(selfTest.json.durable.restoredGet, { value: 24 });
    assert.deepEqual(selfTest.json.durable.restoredIncrement, { value: 41 });
    assert.deepEqual(selfTest.json.durable.restoredFailure, {
      name: "CapabilityCallError",
      message: "generated binding failure",
      details: {
        name: "Error",
      },
    });
    assert.equal(selfTest.json.durable.restoredDrop.ok, true);
    assert.equal(selfTest.json.durable.revokeCastSaved.ok, true);
    assert.equal(selfTest.json.durable.revokeDurableToken.ok, true);
    assert.equal(selfTest.json.durable.deleteStorage.ok, true);
    assert.equal(selfTest.json.dropTransient.ok, true);
  });

  await t.test("calls saved app-object capabilities across supervisors", async (t) => {
    const sharedDir = await fs.mkdtemp(path.join(REPO_TMP_DIR, "iso-cross-"));
    const tokenStorePath = path.join(sharedDir, "fake-core-route-backed-tokens");
    let provider = null;
    let client = null;

    t.after(async () => {
      await Promise.allSettled([
        provider?.cleanup(),
        client?.cleanup(),
      ]);
      await fs.rm(sharedDir, { recursive: true, force: true });
    });

    provider = await startIsolateFixture({ tokenStorePath });
    client = await startIsolateFixture({ tokenStorePath });

    const capabilityName = `cross-grain-feed-${Date.now()}`;
    const exported = await requestJson(
      provider.workerdSocket,
      `/export-mail-feed-capability?persistent=true&id=${encodeURIComponent(capabilityName)}`);
    assert.equal(exported.statusCode, 200, exported.body + formatOutput(
      provider.stdout, provider.stderr));
    assert.equal(exported.json.ok, true);
    assert.equal(exported.json.capabilityClass, true);
    assert.equal(exported.json.capability.type, "capability");
    assert.equal(typeof exported.json.capability.id, "string");

    const capabilityInfo = await requestJson(
      provider.sandstormApiSocket,
      `/capabilities/claimed?id=${encodeURIComponent(exported.json.capability.id)}`);
    assert.equal(capabilityInfo.statusCode, 200, capabilityInfo.body);
    assert.equal(capabilityInfo.json.ok, true);
    assert.equal(capabilityInfo.json.residence, "localExport");
    assert.equal(capabilityInfo.json.nativeInterface, "appObject");
    assert.equal(capabilityInfo.json.persistent, true);
    assert.equal(capabilityInfo.json.liveForwardable, true);

    const saved = await requestJson(
      provider.sandstormApiSocket,
      `/powerbox/save?id=${encodeURIComponent(exported.json.capability.id)}` +
      `&label=${encodeURIComponent("Cross grain mail feed")}`,
      { method: "POST" });
    assert.equal(saved.statusCode, 200, saved.body + formatOutput(
      provider.stdout, provider.stderr));
    assert.equal(saved.json.ok, true);
    assert.equal(saved.json.type, "savedCapability");
    assert.equal(saved.json.tokenEncoding, "base64url");
    assert.equal(typeof saved.json.token, "string");

    const callback = await requestJson(
      client.workerdSocket,
      `/cross-grain-live-callback-self-test?token=${encodeURIComponent(saved.json.token)}`);
    assert.equal(callback.statusCode, 200, callback.body + formatOutput(
      client.stdout, client.stderr) + formatOutput(provider.stdout, provider.stderr));
    assert.equal(callback.json.ok, true);
    assert.equal(callback.json.feedCapability.type, "capability");
    assert.equal(callback.json.feedInfo.kind, "restored");
    assert.equal(callback.json.feedInfo.residence, "imported");
    assert.equal(callback.json.feedInfo.nativeInterface, "appObject");
    assert.equal(callback.json.feedInfo.hasNativeCapability, true);
    assert.deepEqual(callback.json.subscription, {
      ok: true,
      receiverType: "capability",
      result: {
        ok: true,
        count: 1,
        subject: "phase-3-live-callback",
      },
    });
    assert.deepEqual(callback.json.events, [
      {
        subject: "phase-3-live-callback",
        unread: 2,
      },
    ]);
    assert.equal(callback.json.disposeAfterSubscribe, callback.json.disposeBefore + 1);
    assert.deepEqual(callback.json.throwingCallbackFailure, {
      name: "CapabilityCallError",
      message: "throwing receiver saw phase-3-live-callback",
      details: {
        name: "CapabilityCallError",
      },
    });
    assert.equal(
      callback.json.disposeAfterThrowingCallback,
      callback.json.disposeBeforeThrowingCallback + 1);
    assert.deepEqual(callback.json.missingMethodFailure, {
      name: "CapabilityCallError",
      message: "RPC method not found: missingPhase3Method",
      details: {
        name: "NoSuchMethod",
      },
    });
    assert.equal(callback.json.session.type, "capability");
    assert.equal(callback.json.sessionInfo.kind, "unknown");
    assert.equal(callback.json.sessionInfo.residence, "imported");
    assert.equal(callback.json.sessionInfo.nativeInterface, "appObject");
    assert.equal(callback.json.sessionInfo.hasNativeCapability, true);
    assert.deepEqual(callback.json.sessionFirst, { value: 7 });
    assert.deepEqual(callback.json.sessionSecond, { value: 11 });
    assert.deepEqual(callback.json.forwardedSession, {
      ok: true,
      counterType: "capability",
      incremented: { value: 17 },
      current: { value: 17 },
    });
    assert.deepEqual(callback.json.sessionCurrent, { value: 17 });
    assert.deepEqual(callback.json.sessionFailure, {
      name: "CapabilityCallError",
      message: "phase-3 returned capability failure",
      details: {
        name: "Error",
      },
    });
    assert.equal(callback.json.wrongForwardedCapabilityFailure.name, "CapabilityCallError");
    assert.match(
      callback.json.wrongForwardedCapabilityFailure.message,
      /native app RPC transport returned invalid response with status 400/);
    assert.equal(callback.json.wrongForwardedCapabilityFailure.details.status, 400);
    assert.match(
      callback.json.wrongForwardedCapabilityFailure.details.body.error,
      /claimed capability cannot be used as native app RPC argument/);
    assert.match(
      callback.json.wrongForwardedCapabilityFailure.details.body.error,
      /webSession/);
    assert.equal(callback.json.webSessionDrop.ok, true);
    assert.equal(callback.json.sessionDrop.ok, true);
    assert.deepEqual(callback.json.savedLiveReceiver, {
      ok: true,
      receiverType: "capability",
      tokenType: "string",
    });
    assert.equal(callback.json.restoredLiveReceiver.type, "capability");
    assert.deepEqual(callback.json.restoredLiveReceiverEvent, {
      ok: true,
      count: 1,
      subject: "phase-3-saved-live-receiver",
    });
    assert.equal(callback.json.restoredLiveReceiverDrop.ok, true);
    assert.equal(callback.json.liveReceiverDropSaved.ok, true);
    assert.equal(callback.json.durableReceiverDrop.ok, true);
    assert.equal(callback.json.drop.ok, true);

    const retainedId = `retained-callback-${Date.now()}`;
    const retainedSubscribe = await requestJson(
      client.workerdSocket,
      `/cross-grain-retained-callback-subscribe-self-test` +
      `?token=${encodeURIComponent(saved.json.token)}` +
      `&id=${encodeURIComponent(retainedId)}`);
    assert.equal(retainedSubscribe.statusCode, 200, retainedSubscribe.body + formatOutput(
      client.stdout, client.stderr) + formatOutput(provider.stdout, provider.stderr));
    assert.equal(retainedSubscribe.json.ok, true);
    assert.equal(retainedSubscribe.json.receiverCapability.type, "capability");
    assert.deepEqual(retainedSubscribe.json.subscription, {
      ok: true,
      id: retainedId,
      receiverType: "capability",
    });
    assert.equal(
      retainedSubscribe.json.disposeAfterSubscribe,
      retainedSubscribe.json.disposeBeforeSubscribe);
    assert.equal(retainedSubscribe.json.dropFeed.ok, true);

    const retainedTrigger = await requestJson(
      provider.workerdSocket,
      `/trigger-retained-mail-feed-callback?id=${encodeURIComponent(retainedId)}` +
      `&subject=${encodeURIComponent("phase-3-retained-callback")}&unread=5`);
    assert.equal(retainedTrigger.statusCode, 200, retainedTrigger.body + formatOutput(
      client.stdout, client.stderr) + formatOutput(provider.stdout, provider.stderr));
    assert.deepEqual(retainedTrigger.json, {
      ok: true,
      id: retainedId,
      result: {
        ok: true,
        count: 1,
        subject: "phase-3-retained-callback",
      },
    });

    const retainedEvents = await requestJson(
      client.workerdSocket,
      `/retained-callback-events?id=${encodeURIComponent(retainedId)}`);
    assert.equal(retainedEvents.statusCode, 200, retainedEvents.body);
    assert.deepEqual(retainedEvents.json.events, [
      {
        subject: "phase-3-retained-callback",
        unread: 5,
      },
    ]);
    assert.equal(
      retainedEvents.json.disposed,
      retainedSubscribe.json.disposeBeforeSubscribe);

    const dropRetainedProvider = await requestJson(
      provider.workerdSocket,
      `/drop-retained-mail-feed-callback?id=${encodeURIComponent(retainedId)}`);
    assert.equal(dropRetainedProvider.statusCode, 200, dropRetainedProvider.body);
    assert.equal(dropRetainedProvider.json.ok, true);
    assert.equal(dropRetainedProvider.json.dropped, true);
    assert.equal(dropRetainedProvider.json.drop.ok, true);

    const dropRetainedClient = await requestJson(
      client.workerdSocket,
      `/drop-retained-callback-receiver?id=${encodeURIComponent(retainedId)}`);
    assert.equal(dropRetainedClient.statusCode, 200, dropRetainedClient.body);
    assert.equal(dropRetainedClient.json.ok, true);
    assert.equal(dropRetainedClient.json.dropped, true);
    assert.equal(dropRetainedClient.json.drop.ok, true);
    assert.equal(
      dropRetainedClient.json.disposeAfterDrop,
      dropRetainedClient.json.disposeBeforeDrop + 1);

    const dropOriginal = await requestJson(
      provider.sandstormApiSocket,
      `/powerbox/drop?id=${encodeURIComponent(exported.json.capability.id)}`,
      { method: "POST" });
    assert.equal(dropOriginal.statusCode, 200, dropOriginal.body);
    assert.equal(dropOriginal.json.ok, true);

    const dropSaved = await requestJson(
      client.sandstormApiSocket,
      `/powerbox/drop-saved?token=${encodeURIComponent(saved.json.token)}`,
      { method: "POST" });
    assert.equal(dropSaved.statusCode, 200, dropSaved.body);
    assert.equal(dropSaved.json.ok, true);
  });

  await t.test("forwards request bodies and custom headers through workerd", async () => {
    const body = Buffer.alloc(64 * 1024);
    for (let i = 0; i < body.length; ++i) {
      body[i] = (i * 17) & 0xff;
    }

    const response = await requestJson(fixture.workerdSocket, "/echo", {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Isolate-Test": "echo-header",
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json.ok, true);
    assert.equal(response.json.method, "POST");
    assert.equal(response.json.bodyBytes, body.length);
    assert.equal(response.json.checksum, checksum(body));
    assert.equal(response.json.contentType, "application/octet-stream");
    assert.equal(response.json.customHeader, "echo-header");
  });

  await t.test("serves deterministic binary responses and response headers", async () => {
    const download = await requestUnixSocket(fixture.workerdSocket, "/download?bytes=65536");
    assert.equal(download.statusCode, 200);
    assert.equal(download.headers["content-type"], "application/octet-stream");
    assert.equal(download.headers["x-isolate-test-bytes"], "65536");
    assert.equal(download.bodyBuffer.length, 65536);
    assert.equal(Number(download.headers["x-isolate-test-checksum"]), checksum(download.bodyBuffer));
    assert.equal(download.bodyBuffer[0], 0);
    assert.equal(download.bodyBuffer[255], 255);
    assert.equal(download.bodyBuffer[256], 0);

    const range = await requestUnixSocket(fixture.workerdSocket, "/range", {
      headers: { Range: "bytes=10-19" },
    });
    assert.equal(range.statusCode, 206);
    assert.equal(range.headers["content-range"], "bytes 10-19/256");
    assert.equal(range.headers["accept-ranges"], "bytes");
    assert.equal(range.headers["x-sandstorm-app-range-response"], "present");
    assert.equal(range.bodyBuffer.length, 10);
    assert.equal(range.bodyBuffer[0], 10);
    assert.equal(range.bodyBuffer[9], 19);

    const headers = await requestUnixSocket(fixture.workerdSocket, "/headers");
    assert.equal(headers.statusCode, 200);
    assert.equal(headers.body, "header response");
    assert.equal(headers.headers["cache-control"], "no-store");
    assert.equal(headers.headers["x-isolate-test"], "present");

    const attachment = await requestUnixSocket(fixture.workerdSocket, "/attachment");
    assert.equal(attachment.statusCode, 200);
    assert.equal(attachment.body, "attachment body");
    assert.equal(attachment.headers["content-disposition"], "attachment; filename=\"fixture.txt\"");
    assert.equal(attachment.headers.etag, "\"fixture-etag\"");

    const redirect = await requestUnixSocket(fixture.workerdSocket, "/redirect");
    assert.equal(redirect.statusCode, 303);
    assert.equal(redirect.headers.location, "https://example.invalid/next");

    const empty = await requestUnixSocket(fixture.workerdSocket, "/empty");
    assert.equal(empty.statusCode, 204);
    assert.equal(empty.headers.etag, "W/\"empty-etag\"");
    assert.equal(empty.bodyBuffer.length, 0);

    const notModified = await requestUnixSocket(fixture.workerdSocket, "/not-modified");
    assert.equal(notModified.statusCode, 304);
    assert.equal(notModified.headers.etag, "\"not-modified-etag\"");
    assert.equal(notModified.bodyBuffer.length, 0);

    const error = await requestUnixSocket(fixture.workerdSocket, "/error");
    assert.equal(error.statusCode, 418);
    assert.equal(error.body, "fixture failure");
    assert.match(String(error.headers["content-type"] || ""), /text\/plain/);

    const htmlError = await requestUnixSocket(fixture.workerdSocket, "/error-html");
    assert.equal(htmlError.statusCode, 404);
    assert.equal(htmlError.body, "<p>fixture html failure</p>");
    assert.match(String(htmlError.headers["content-type"] || ""), /text\/html/);

    const binaryError = await requestUnixSocket(fixture.workerdSocket, "/error-binary");
    assert.equal(binaryError.statusCode, 500);
    assert.equal(binaryError.headers["content-type"], "application/octet-stream");
    assert.equal(binaryError.bodyBuffer.length, 1024);
    assert.equal(checksum(binaryError.bodyBuffer), checksum(deterministicBytes(1024)));
  });

  await t.test("serves the Sandstorm API binding socket", async () => {
    const runtime = await requestJson(fixture.sandstormApiSocket, "/runtime");
    assert.equal(runtime.statusCode, 200);
    assert.equal(runtime.json.ok, true);
    assert.equal(runtime.json.mainModule, "worker.js");
    assert.equal(runtime.json.moduleCount, 17);
    assert.equal(runtime.json.bindingCount, 6);

    const capabilities = await requestJson(fixture.sandstormApiSocket, "/capabilities");
    assert.equal(capabilities.statusCode, 200);
    assert.ok(capabilities.json.capabilities.includes("powerbox.claim"));
    assert.ok(!capabilities.json.capabilities.includes("powerbox.claimRequest"));
    assert.ok(!capabilities.json.capabilities.includes("powerbox.save"));
    assert.ok(!capabilities.json.capabilities.includes("powerbox.restore"));
    assert.ok(!capabilities.json.capabilities.includes("powerbox.dropSaved"));
    assert.ok(!capabilities.json.capabilities.includes("powerbox.drop"));
    assert.ok(capabilities.json.capabilities.includes("powerbox.fetch"));
    assert.ok(capabilities.json.capabilities.includes("powerbox.outboundHttpFetch"));
    assert.ok(capabilities.json.capabilities.includes("powerbox.apiSessionDescriptor"));
    assert.ok(capabilities.json.capabilities.includes("powerbox.outboundHttpDescriptor"));
    assert.ok(capabilities.json.capabilities.includes("powerbox.offer"));
    assert.ok(capabilities.json.capabilities.includes("powerbox.fulfillRequest"));
    assert.ok(capabilities.json.capabilities.includes("powerbox.tieToUser"));
    assert.ok(capabilities.json.capabilities.includes("permissions"));
    assert.ok(capabilities.json.capabilities.includes("capabilities.webSession"));
    assert.ok(capabilities.json.capabilities.includes("capabilities.apiSession"));
    assert.ok(capabilities.json.capabilities.includes("capabilities.claimed"));
    assert.ok(capabilities.json.capabilities.includes("capabilities.claimedStats"));
    assert.ok(capabilities.json.capabilities.includes("capnp.bridgeInfo"));
    assert.ok(capabilities.json.capabilities.includes("capnp.call"));

    const capnpBridgeInfo = await requestJson(fixture.sandstormApiSocket, "/capnp/bridge-info");
    assert.equal(capnpBridgeInfo.statusCode, 200, capnpBridgeInfo.body);
    assert.deepEqual(capnpBridgeInfo.json, {
      ok: true,
      type: "capnpBridgeInfo",
      protocolVersion: 0,
      minProtocolVersion: 0,
      maxProtocolVersion: 0,
      nativeTransport: false,
      nativeCalls: false,
      nativeExports: false,
      capabilitySlots: false,
      fallbackTransport: "appObjectRpc",
    });

    const capnpCall = await requestJson(fixture.sandstormApiSocket, "/capnp/call", {
      method: "POST",
      body: "",
    });
    assert.equal(capnpCall.statusCode, 501, capnpCall.body);
    assert.deepEqual(capnpCall.json, {
      ok: false,
      type: "nativeCapnpBridgeResponse",
      protocolVersion: 0,
      error: "native Cap'n Proto bridge transport is not enabled",
      exception: {
        type: "unimplemented",
        reason: "native Cap'n Proto bridge transport is not enabled",
        trace: "",
      },
    });

    const claimedStats = await requestJson(
      fixture.sandstormApiSocket, "/capabilities/claimed-stats");
    assert.equal(claimedStats.statusCode, 200, claimedStats.body);
    assert.equal(claimedStats.json.ok, true);
    assert.equal(claimedStats.json.type, "claimedCapabilityStats");
    assert.equal(typeof claimedStats.json.claimedCapabilityCount, "number");
    assert.equal(typeof claimedStats.json.dropNotifyGroupCount, "number");
    assert.equal(typeof claimedStats.json.localExportCount, "number");
    assert.equal(typeof claimedStats.json.importedCount, "number");
    assert.equal(typeof claimedStats.json.webSessionNativeCount, "number");
    assert.equal(typeof claimedStats.json.apiSessionNativeCount, "number");
    assert.equal(typeof claimedStats.json.outboundHttpNativeCount, "number");
    assert.equal(typeof claimedStats.json.appObjectNativeCount, "number");
    assert.equal(typeof claimedStats.json.unknownNativeCount, "number");
    assert.equal(typeof claimedStats.json.routeBackedWebSessionCount, "number");
    assert.equal(typeof claimedStats.json.routeBackedApiSessionCount, "number");
    assert.equal(typeof claimedStats.json.routeBackedAppObjectCount, "number");
    assert.equal(typeof claimedStats.json.powerboxClaimCount, "number");
    assert.equal(typeof claimedStats.json.powerboxOfferCount, "number");
    assert.equal(typeof claimedStats.json.restoredCount, "number");
    assert.equal(typeof claimedStats.json.tiedCount, "number");

    const permissions = await requestJson(fixture.sandstormApiSocket, "/permissions");
    assert.equal(permissions.statusCode, 200);
    assert.equal(permissions.json.ok, true);
    assert.deepEqual(permissions.json.permissions.map((permission) => permission.name), ["view"]);
    assert.equal(permissions.json.permissions[0].title, "view");
    assert.equal(permissions.json.permissions[0].description, "allows opening the isolate test app");

    const modules = await requestJson(fixture.sandstormApiSocket, "/modules");
    assert.equal(modules.statusCode, 200);
    assert.deepEqual(
      modules.json.modules.map((module) => [module.name, module.type, module.main]),
      [
        ["worker.js", "esModule", true],
        ["message.txt", "text", false],
        ["metadata.json", "json", false],
        ["capnweb", "esModule", false],
        ["sandstorm:capnweb-source", "text", false],
        ["sandstorm:rpc", "esModule", false],
        ["sandstorm:api", "esModule", false],
        ["sandstorm:capnp", "esModule", false],
        ...CAPNP_ES_RUNTIME_MODULES.map(([name]) => [name, "esModule", false]),
      ]);

    const bindings = await requestJson(fixture.sandstormApiSocket, "/bindings");
    assert.equal(bindings.statusCode, 200);
    assert.deepEqual(
      bindings.json.bindings.map((binding) => [binding.name, binding.type, binding.workerdDirect]),
      [
        ["TEXT_BINDING", "text", true],
        ["JSON_BINDING", "json", true],
        ["SANDSTORM_API", "sandstormApi", true],
        ["POWERBOX", "powerbox", true],
        ["STORAGE", "storage", true],
        ["LOOPBACK_SERVICE", "service", true],
      ]);
    assert.equal(bindings.json.bindings[5].serviceName, "main");

    const nativeInterfaceValidation = await requestJson(
      fixture.workerdSocket, "/native-interface-validation-self-test");
    assert.equal(nativeInterfaceValidation.statusCode, 200, nativeInterfaceValidation.body);
    assert.equal(nativeInterfaceValidation.json.ok, true);
    assert.deepEqual(nativeInterfaceValidation.json.calls, [
      "http://sandstorm/capabilities/claimed?id=mock-outbound",
      "http://sandstorm/powerbox/outbound-http-fetch?id=mock-outbound&method=GET&path=v1%2Fmock-fetch%3Fcase%3Dnative-interface",
      "http://sandstorm/capabilities/claimed?id=mock-app-object",
      "http://sandstorm/powerbox/native-app-rpc-call?id=mock-app-object",
      "http://sandstorm/powerbox/native-app-rpc-call?id=mock-app-object",
    ]);
    assert.equal(nativeInterfaceValidation.json.fetchError.name, "ValidationError");
    assert.match(nativeInterfaceValidation.json.fetchError.message, /OutboundHttpSession/);
    assert.match(nativeInterfaceValidation.json.fetchError.message, /capability descriptor supplies the origin/);
    assert.deepEqual(nativeInterfaceValidation.json.outboundFetch, {
      status: 202,
      header: "present",
      body: {
        ok: true,
        id: "mock-outbound",
        method: "GET",
        path: "v1/mock-fetch?case=native-interface",
      },
    });
    assert.equal(nativeInterfaceValidation.json.appObjectFetchError.name, "UnsupportedCapabilityError");
    assert.match(nativeInterfaceValidation.json.appObjectFetchError.message,
      /nativeInterface appObject/);
    assert.match(nativeInterfaceValidation.json.appObjectFetchError.message,
      /only for WebSession, ApiSession, and OutboundHttpSession/);
    assert.equal(nativeInterfaceValidation.json.appObjectOutboundError.name,
      "UnsupportedCapabilityError");
    assert.match(nativeInterfaceValidation.json.appObjectOutboundError.message,
      /nativeInterface appObject/);
    assert.match(nativeInterfaceValidation.json.appObjectOutboundError.message,
      /Use cap\.rpc or cap\.call\(\) for app-defined RPC/);
    assert.deepEqual(nativeInterfaceValidation.json.appObjectNativeSlot, {
      type: "nativeCapabilitySlot",
      id: "mock-app-object",
      nativeInterface: "appObject",
    });
    assert.deepEqual(nativeInterfaceValidation.json.nativeRpcTransportCalls, [
      {
        slot: nativeInterfaceValidation.json.appObjectNativeSlot,
        call: {
          method: "deliver",
          args: [
            { type: "text", value: "native-subject" },
            {
              type: "capability",
              value: { id: "native-callback", nativeInterface: "appObject" },
            },
            {
              type: "object",
              value: [{ name: "urgent", value: { type: "bool", value: true } }],
            },
          ],
        },
      },
    ]);
    assert.deepEqual(nativeInterfaceValidation.json.appObjectNativeValue, {
      subject: "native-subject",
      callback: {
        ok: true,
        type: "capability",
        id: "native-callback",
      },
      options: { urgent: true },
    });
    assert.deepEqual(nativeInterfaceValidation.json.defaultNativeRpcValue, {
      subject: "default-subject",
      callback: { urgent: false },
      options: null,
    });
    assert.deepEqual(nativeInterfaceValidation.json.defaultCallValue, {
      subject: "call-subject",
      callback: { urgent: true },
      options: null,
    });
    assert.deepEqual(nativeInterfaceValidation.json.nonAppObjectResultSlot, {
      ok: true,
      type: "capability",
      id: "web-session-slot",
    });
    assert.deepEqual(nativeInterfaceValidation.json.helperNativeSlot,
      nativeInterfaceValidation.json.appObjectNativeSlot);
    assert.deepEqual(nativeInterfaceValidation.json.helperNativeDrop, {
      ok: true,
      released: "mock-app-object",
    });
    assert.deepEqual(nativeInterfaceValidation.json.wrongNativeRpcTransportCalls, []);
    assert.equal(nativeInterfaceValidation.json.wrongNativeRpcError.name,
      "UnsupportedCapabilityError");
    assert.match(nativeInterfaceValidation.json.wrongNativeRpcError.message,
      /nativeInterface outboundHttpSession/);
    assert.match(nativeInterfaceValidation.json.wrongNativeRpcError.message,
      /app-defined RPC/);

    const nativeAppRpcCodec = await requestJson(
      fixture.workerdSocket, "/native-app-rpc-codec-self-test");
    assert.equal(nativeAppRpcCodec.statusCode, 200, nativeAppRpcCodec.body);
    assert.equal(nativeAppRpcCodec.json.ok, true);
    const savedCapabilityToken = "c2F2ZWQtdG9rZW4";
    const savedCapabilityEnvelope = { type: "text", value: savedCapabilityToken };
    assert.deepEqual(nativeAppRpcCodec.json.serialized, {
      type: "object",
      value: [
        { name: "none", value: { type: "null" } },
        { name: "truthy", value: { type: "bool", value: true } },
        { name: "count", value: { type: "number", value: 42.5 } },
        { name: "text", value: { type: "text", value: "hello" } },
        { name: "bytes", value: { type: "data", value: "AAECAwQ" } },
        {
          name: "items",
          value: {
            type: "list",
            value: [
              { type: "text", value: "first" },
              { type: "number", value: 2 },
              { type: "bool", value: false },
            ],
          },
        },
        {
          name: "callback",
          value: {
            type: "capability",
            value: { id: "slot-1", nativeInterface: "appObject" },
          },
        },
        {
          name: "saved",
          value: savedCapabilityEnvelope,
        },
      ],
    });
    assert.deepEqual(nativeAppRpcCodec.json.hydrated, {
      none: null,
      truthy: true,
      count: 42.5,
      text: "hello",
      bytes: [0, 1, 2, 3, 4],
      items: ["first", 2, false],
      callback: { type: "nativeCapabilitySlot", id: "slot-1", nativeInterface: "appObject" },
      saved: savedCapabilityToken,
    });
    assert.deepEqual(nativeAppRpcCodec.json.callEnvelope, {
      method: "deliver",
      args: [
        { type: "text", value: "subject" },
        { type: "capability", value: { id: "slot-1", nativeInterface: "appObject" } },
        {
          type: "object",
          value: [
            { name: "urgent", value: { type: "bool", value: true } },
            {
              name: "saved",
              value: savedCapabilityEnvelope,
            },
          ],
        },
      ],
    });
    assert.deepEqual(nativeAppRpcCodec.json.hydratedCall, {
      method: "deliver",
      args: [
        "subject",
        { type: "nativeCapabilitySlot", id: "slot-1", nativeInterface: "appObject" },
        { urgent: true, saved: savedCapabilityToken },
      ],
    });
    assert.deepEqual(nativeAppRpcCodec.json.resultEnvelope, {
      type: "value",
      value: {
        type: "object",
        value: [
          { name: "accepted", value: { type: "bool", value: true } },
          {
            name: "receipt",
            value: { type: "capability", value: { id: "slot-1", nativeInterface: "appObject" } },
          },
          {
            name: "saved",
            value: savedCapabilityEnvelope,
          },
        ],
      },
    });
    assert.deepEqual(nativeAppRpcCodec.json.resultValue, {
      accepted: true,
      receipt: { type: "nativeCapabilitySlot", id: "slot-1", nativeInterface: "appObject" },
      saved: savedCapabilityToken,
    });
    assert.deepEqual(nativeAppRpcCodec.json.exceptionEnvelope, {
      type: "exception",
      value: {
        name: "RemoteAppError",
        message: "remote failure",
        stack: "remote stack",
      },
    });
    assert.equal(nativeAppRpcCodec.json.exceptionError.name, "CapabilityCallError");
    assert.equal(nativeAppRpcCodec.json.exceptionError.message, "remote failure");
    assert.deepEqual(nativeAppRpcCodec.json.exceptionError.details, {
      name: "RemoteAppError",
      stack: "remote stack",
    });
    assert.deepEqual(nativeAppRpcCodec.json.dispatchResult, {
      type: "value",
      value: {
        type: "object",
        value: [
          { name: "subject", value: { type: "text", value: "subject" } },
          {
            name: "callback",
            value: { type: "capability", value: { id: "slot-1", nativeInterface: "appObject" } },
          },
          { name: "urgent", value: { type: "bool", value: true } },
          {
            name: "saved",
            value: savedCapabilityEnvelope,
          },
        ],
      },
    });
    assert.deepEqual(nativeAppRpcCodec.json.dispatchValue, {
      subject: "subject",
      callback: { type: "nativeCapabilitySlot", id: "slot-1", nativeInterface: "appObject" },
      urgent: true,
      saved: savedCapabilityToken,
    });
    assert.deepEqual(nativeAppRpcCodec.json.missingDispatchResult, {
      type: "exception",
      value: {
        name: "NoSuchMethod",
        message: "RPC method not found: missing",
        stack: "",
      },
    });
    assert.equal(nativeAppRpcCodec.json.failedDispatchResult.type, "exception");
    assert.equal(nativeAppRpcCodec.json.failedDispatchResult.value.name, "TypeError");
    assert.equal(nativeAppRpcCodec.json.failedDispatchResult.value.message, "native dispatch failure");
    assert.match(nativeAppRpcCodec.json.failedDispatchResult.value.stack, /native dispatch failure/);
    assert.deepEqual(nativeAppRpcCodec.json.stubSlot, {
      type: "nativeCapabilitySlot",
      id: "slot-1",
      nativeInterface: "appObject",
    });
    assert.deepEqual(nativeAppRpcCodec.json.stubJson, nativeAppRpcCodec.json.stubSlot);
    assert.deepEqual(nativeAppRpcCodec.json.stubTransportCalls, [
      {
        slot: nativeAppRpcCodec.json.stubSlot,
        call: {
          method: "deliver",
          args: [
            { type: "text", value: "stub-subject" },
            { type: "capability", value: { id: "slot-1", nativeInterface: "appObject" } },
            {
              type: "object",
              value: [
                { name: "urgent", value: { type: "bool", value: false } },
                {
                  name: "saved",
                  value: savedCapabilityEnvelope,
                },
              ],
            },
          ],
        },
      },
      {
        slot: nativeAppRpcCodec.json.stubSlot,
        call: {
          method: "deliver",
          args: [
            { type: "text", value: "rpc-subject" },
            { type: "capability", value: { id: "slot-1", nativeInterface: "appObject" } },
            {
              type: "object",
              value: [
                { name: "urgent", value: { type: "bool", value: true } },
                {
                  name: "saved",
                  value: savedCapabilityEnvelope,
                },
              ],
            },
          ],
        },
      },
      {
        slot: nativeAppRpcCodec.json.stubSlot,
        call: { method: "missing", args: [] },
      },
    ]);
    assert.deepEqual(nativeAppRpcCodec.json.stubCallValue, {
      subject: "stub-subject",
      callback: nativeAppRpcCodec.json.stubSlot,
      urgent: false,
      saved: savedCapabilityToken,
    });
    assert.deepEqual(nativeAppRpcCodec.json.stubRpcValue, {
      subject: "rpc-subject",
      callback: nativeAppRpcCodec.json.stubSlot,
      urgent: true,
      saved: savedCapabilityToken,
    });
    assert.equal(nativeAppRpcCodec.json.stubRpcStable, true);
    assert.equal(nativeAppRpcCodec.json.stubMissingError.name, "CapabilityCallError");
    assert.equal(nativeAppRpcCodec.json.stubMissingError.message, "RPC method not found: missing");
    assert.deepEqual(nativeAppRpcCodec.json.stubMissingError.details, {
      name: "NoSuchMethod",
    });
    assert.deepEqual(nativeAppRpcCodec.json.droppable.value, {
      subject: "droppable-subject",
      callback: nativeAppRpcCodec.json.stubSlot,
      urgent: false,
    });
    assert.deepEqual(nativeAppRpcCodec.json.droppable.dropFirst, {
      ok: true,
      released: "slot-1",
    });
    assert.deepEqual(nativeAppRpcCodec.json.droppable.dropSecond,
      nativeAppRpcCodec.json.droppable.dropFirst);
    assert.deepEqual(nativeAppRpcCodec.json.droppable.dropViaProxy,
      nativeAppRpcCodec.json.droppable.dropFirst);
    assert.equal(nativeAppRpcCodec.json.droppable.callAfterDropError.name,
      "CapabilityCallError");
    assert.equal(nativeAppRpcCodec.json.droppable.callAfterDropError.message,
      "native app RPC stub has been dropped");
    assert.deepEqual(nativeAppRpcCodec.json.droppable.transportCalls, [
      {
        slot: nativeAppRpcCodec.json.stubSlot,
        call: {
          method: "deliver",
          args: [
            { type: "text", value: "droppable-subject" },
            { type: "capability", value: { id: "slot-1", nativeInterface: "appObject" } },
            {
              type: "object",
              value: [{ name: "urgent", value: { type: "bool", value: false } }],
            },
          ],
        },
      },
    ]);
    assert.deepEqual(nativeAppRpcCodec.json.droppable.releaseCalls, [
      nativeAppRpcCodec.json.stubSlot,
    ]);
    assert.deepEqual(nativeAppRpcCodec.json.resolved.valueCallbackSlot,
      nativeAppRpcCodec.json.stubSlot);
    assert.deepEqual(nativeAppRpcCodec.json.resolved.callCallbackSlot,
      nativeAppRpcCodec.json.stubSlot);
    assert.deepEqual(nativeAppRpcCodec.json.resolved.resultReceiptSlot,
      nativeAppRpcCodec.json.stubSlot);
    assert.deepEqual(nativeAppRpcCodec.json.resolved.callbackValue, {
      subject: "resolved-subject",
      callback: nativeAppRpcCodec.json.stubSlot,
      urgent: true,
    });
    assert.deepEqual(nativeAppRpcCodec.json.resolved.transportCalls, [
      {
        slot: nativeAppRpcCodec.json.stubSlot,
        call: {
          method: "deliver",
          args: [
            { type: "text", value: "resolved-subject" },
            { type: "capability", value: { id: "slot-1", nativeInterface: "appObject" } },
            {
              type: "object",
              value: [{ name: "urgent", value: { type: "bool", value: true } }],
            },
          ],
        },
      },
    ]);
    assert.deepEqual(nativeAppRpcCodec.json.resolved.resolverCalls, [
      {
        slot: nativeAppRpcCodec.json.stubSlot,
        name: "value.callback",
      },
      {
        slot: nativeAppRpcCodec.json.stubSlot,
        name: "call.args[1]",
      },
      {
        slot: nativeAppRpcCodec.json.stubSlot,
        name: "result.value.receipt",
      },
    ]);
    assert.equal(nativeAppRpcCodec.json.exported.targetValueError.name, "ValidationError");
    assert.match(nativeAppRpcCodec.json.exported.targetValueError.message, /api\.export\(\)/);
    assert.deepEqual(nativeAppRpcCodec.json.exported.capabilityValue, {
      type: "capability",
      value: { id: "exported-slot-0", nativeInterface: "appObject" },
    });
    assert.deepEqual(nativeAppRpcCodec.json.exported.callEnvelope, {
      method: "deliver",
      args: [
        { type: "capability", value: { id: "exported-slot-2", nativeInterface: "appObject" } },
        {
          type: "object",
          value: [
            {
              name: "authority",
              value: {
                type: "capability",
                value: { id: "exported-slot-3", nativeInterface: "appObject" },
              },
            },
          ],
        },
      ],
    });
    assert.equal(nativeAppRpcCodec.json.exported.callRawTargetError.name, "ValidationError");
    assert.match(nativeAppRpcCodec.json.exported.callRawTargetError.message, /api\.export\(\)/);
    assert.deepEqual(nativeAppRpcCodec.json.exported.stubValue, {
      subject: "export-stub-subject",
      callback: {
        type: "nativeCapabilitySlot",
        id: "exported-slot-4",
        nativeInterface: "appObject",
      },
      urgent: false,
    });
    assert.equal(nativeAppRpcCodec.json.exported.stubRawTargetError.name, "ValidationError");
    assert.match(nativeAppRpcCodec.json.exported.stubRawTargetError.message, /api\.export\(\)/);
    assert.deepEqual(nativeAppRpcCodec.json.exported.stubTransportCalls, [
      {
        slot: nativeAppRpcCodec.json.stubSlot,
        call: {
          method: "deliver",
          args: [
            { type: "text", value: "export-stub-subject" },
            {
              type: "capability",
              value: { id: "exported-slot-4", nativeInterface: "appObject" },
            },
            {
              type: "object",
              value: [{ name: "urgent", value: { type: "bool", value: false } }],
            },
          ],
        },
      },
    ]);
    assert.deepEqual(nativeAppRpcCodec.json.exported.resultEnvelope, {
      type: "value",
      value: {
        type: "object",
        value: [
          {
            name: "child",
            value: {
              type: "capability",
              value: { id: "exported-slot-5", nativeInterface: "appObject" },
            },
          },
          {
            name: "authority",
            value: {
              type: "capability",
              value: { id: "exported-slot-6", nativeInterface: "appObject" },
            },
          },
        ],
      },
    });
    assert.deepEqual(nativeAppRpcCodec.json.exported.dispatchChild, {
      type: "value",
      value: {
        type: "capability",
        value: { id: "exported-slot-7", nativeInterface: "appObject" },
      },
    });
    assert.deepEqual(nativeAppRpcCodec.json.exported.dispatchAuthority, {
      type: "value",
      value: {
        type: "object",
        value: [
          {
            name: "authority",
            value: {
              type: "capability",
              value: { id: "exported-slot-8", nativeInterface: "appObject" },
            },
          },
        ],
      },
    });
    assert.deepEqual(nativeAppRpcCodec.json.exported.exportCalls, [
      {
        name: "authority",
        rpcTargetClass: false,
        capabilityClass: true,
        capabilityId: "mock-app-object",
        id: "exported-slot-0",
      },
      {
        name: "call.args[1].authority",
        rpcTargetClass: false,
        capabilityClass: true,
        capabilityId: "mock-app-object",
        id: "exported-slot-1",
      },
      {
        name: "call.args[0]",
        rpcTargetClass: false,
        capabilityClass: true,
        capabilityId: "mock-exported-callback",
        id: "exported-slot-2",
      },
      {
        name: "call.args[1].authority",
        rpcTargetClass: false,
        capabilityClass: true,
        capabilityId: "mock-app-object",
        id: "exported-slot-3",
      },
      {
        name: "call.args[1]",
        rpcTargetClass: false,
        capabilityClass: true,
        capabilityId: "mock-exported-stub-callback",
        id: "exported-slot-4",
      },
      {
        name: "result.child",
        rpcTargetClass: true,
        capabilityClass: false,
        id: "exported-slot-5",
      },
      {
        name: "result.authority",
        rpcTargetClass: false,
        capabilityClass: true,
        capabilityId: "mock-app-object",
        id: "exported-slot-6",
      },
      {
        name: "result",
        rpcTargetClass: true,
        capabilityClass: false,
        id: "exported-slot-7",
      },
      {
        name: "result.authority",
        rpcTargetClass: false,
        capabilityClass: true,
        capabilityId: "mock-app-object",
        id: "exported-slot-8",
      },
    ]);
    assert.equal(nativeAppRpcCodec.json.slotFrozen, true);
    assert.equal(nativeAppRpcCodec.json.rawTargetError.name, "ValidationError");
    assert.match(nativeAppRpcCodec.json.rawTargetError.message, /api\.export\(\)/);
    assert.equal(nativeAppRpcCodec.json.invalidCapabilityError.name, "ValidationError");
    assert.match(nativeAppRpcCodec.json.invalidCapabilityError.message, /at least 1 characters/);
    assert.equal(nativeAppRpcCodec.json.reservedMethodError.name, "ValidationError");
    assert.match(nativeAppRpcCodec.json.reservedMethodError.message, /reserved/);
    assert.equal(nativeAppRpcCodec.json.duplicateFieldError.name, "ValidationError");
    assert.match(nativeAppRpcCodec.json.duplicateFieldError.message, /duplicate field: same/);
    assert.equal(nativeAppRpcCodec.json.reservedFieldError.name, "ValidationError");
    assert.match(nativeAppRpcCodec.json.reservedFieldError.message, /reserved/);
    assert.equal(nativeAppRpcCodec.json.reservedSerializeFieldError.name, "ValidationError");
    assert.match(nativeAppRpcCodec.json.reservedSerializeFieldError.message, /reserved/);

    const nativeAppRpcRoute = await requestJson(
      fixture.workerdSocket, "/native-app-rpc-route-self-test");
    assert.equal(nativeAppRpcRoute.statusCode, 200, nativeAppRpcRoute.body);
    assert.equal(nativeAppRpcRoute.json.ok, true);
    assert.equal(nativeAppRpcRoute.json.value.status, 200);
    assert.deepEqual(nativeAppRpcRoute.json.value.body, {
      type: "value",
      value: {
        type: "object",
        value: [
          { name: "subject", value: { type: "text", value: "route-subject" } },
          { name: "urgent", value: { type: "bool", value: true } },
        ],
      },
    });
    assert.equal(nativeAppRpcRoute.json.missing.status, 200);
    assert.deepEqual(nativeAppRpcRoute.json.missing.body, {
      type: "exception",
      value: {
        name: "NoSuchMethod",
        message: "RPC method not found: missing",
        stack: "",
      },
    });
    assert.equal(nativeAppRpcRoute.json.failed.status, 200);
    assert.equal(nativeAppRpcRoute.json.failed.body.type, "exception");
    assert.equal(nativeAppRpcRoute.json.failed.body.value.name, "RangeError");
    assert.equal(nativeAppRpcRoute.json.failed.body.value.message, "route dispatch failure");
    assert.match(nativeAppRpcRoute.json.failed.body.value.stack, /route dispatch failure/);
    assert.equal(nativeAppRpcRoute.json.invalid.status, 400);
    assert.equal(nativeAppRpcRoute.json.invalid.body.type, "exception");
    assert.equal(nativeAppRpcRoute.json.invalid.body.value.name, "ValidationError");
    assert.match(nativeAppRpcRoute.json.invalid.body.value.message, /reserved/);
    assert.equal(nativeAppRpcRoute.json.missingDurable.status, 404);
    assert.equal(nativeAppRpcRoute.json.missingDurable.body.ok, false);
    assert.equal(nativeAppRpcRoute.json.missingDurable.body.type, "missingDurableCapability");
    assert.equal(nativeAppRpcRoute.json.missingDurable.body.id, "missing-durable-route");
    assert.match(nativeAppRpcRoute.json.missingDurable.body.error,
      /durable capability id is not registered: missing-durable-route/);
    assert.match(nativeAppRpcRoute.json.missingDurable.body.error,
      /Restore the capabilities registry entry, migrate the saved token, or revoke it/);
    assert.equal(nativeAppRpcRoute.json.missingDurableRpc.status, 404);
    assert.equal(nativeAppRpcRoute.json.missingDurableRpc.body.type, "exception");
    assert.equal(nativeAppRpcRoute.json.missingDurableRpc.body.value.name,
      "MissingDurableCapability");
    assert.match(nativeAppRpcRoute.json.missingDurableRpc.body.value.message,
      /durable capability id is not registered: missing-durable-route/);
    assert.match(nativeAppRpcRoute.json.missingDurableRpc.body.value.message,
      /Restore the capabilities registry entry, migrate the saved token, or revoke it/);
    assert.deepEqual(nativeAppRpcRoute.json.routeStub.slot, {
      type: "nativeCapabilitySlot",
      id: "native-route-target",
      nativeInterface: "appObject",
    });
    assert.deepEqual(nativeAppRpcRoute.json.routeStub.transportCalls, [
      {
        input: "http://worker/__sandstorm/object-capabilities/native-route-target/" +
          "native-app-rpc-call",
        method: "POST",
      },
      {
        input: "http://worker/__sandstorm/object-capabilities/native-route-target/" +
          "native-app-rpc-call",
        method: "POST",
      },
      {
        input: "http://worker/__sandstorm/object-capabilities/native-route-target/" +
          "native-app-rpc-call",
        method: "POST",
      },
    ]);
    assert.deepEqual(nativeAppRpcRoute.json.routeStub.value, {
      subject: "stub-route-subject",
      urgent: false,
    });
    assert.deepEqual(nativeAppRpcRoute.json.routeStub.rpcValue, {
      subject: "stub-rpc-subject",
      urgent: true,
    });
    assert.equal(nativeAppRpcRoute.json.routeStub.missingError.name, "CapabilityCallError");
    assert.equal(nativeAppRpcRoute.json.routeStub.missingError.message,
      "RPC method not found: missing");
    assert.deepEqual(nativeAppRpcRoute.json.routeStub.missingError.details, {
      name: "NoSuchMethod",
    });
    assert.equal(nativeAppRpcRoute.json.routeStub.transportErrors.nonJson.name,
      "CapabilityCallError");
    assert.equal(nativeAppRpcRoute.json.routeStub.transportErrors.nonJson.message,
      "native app RPC transport returned non-JSON response with status 502");
    assert.deepEqual(nativeAppRpcRoute.json.routeStub.transportErrors.nonJson.details, {
      status: 502,
      body: "not-json",
    });
    assert.equal(nativeAppRpcRoute.json.routeStub.transportErrors.invalidEnvelope.name,
      "CapabilityCallError");
    assert.equal(nativeAppRpcRoute.json.routeStub.transportErrors.invalidEnvelope.message,
      "native app RPC transport returned invalid response with status 200");
    assert.deepEqual(nativeAppRpcRoute.json.routeStub.transportErrors.invalidEnvelope.details, {
      status: 200,
      body: { ok: false },
    });
    assert.equal(nativeAppRpcRoute.json.routeStub.transportErrors.failedStatus.name,
      "CapabilityCallError");
    assert.equal(nativeAppRpcRoute.json.routeStub.transportErrors.failedStatus.message,
      "native app RPC transport failed with status 503");
    assert.deepEqual(nativeAppRpcRoute.json.routeStub.transportErrors.failedStatus.details, {
      status: 503,
      body: {
        type: "exception",
        name: "RouteFailure",
        message: "route failed before dispatch",
        stack: "",
      },
    });
    assert.equal(nativeAppRpcRoute.json.routeStub.transportErrors.disconnected.name,
      "DisconnectedCapabilityError");
    assert.equal(nativeAppRpcRoute.json.routeStub.transportErrors.disconnected.message,
      "native app RPC transport disconnected");
    assert.deepEqual(nativeAppRpcRoute.json.routeStub.transportErrors.disconnected.details, {
      causeName: "TypeError",
      causeMessage: "simulated bridge disconnect",
    });

    const missing = await requestJson(fixture.sandstormApiSocket, "/missing");
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json.ok, false);

    const wrongMethod = await requestJson(fixture.sandstormApiSocket, "/runtime", {
      method: "POST",
      body: "not allowed",
    });
    assert.equal(wrongMethod.statusCode, 405);
    assert.equal(wrongMethod.json.ok, false);

    const missingSessionClaim = await requestJson(
      fixture.sandstormApiSocket,
      "/powerbox/claim-request?sessionId=missing&token=missing",
      { method: "POST" });
    assert.equal(missingSessionClaim.statusCode, 404);
    assert.equal(missingSessionClaim.json.ok, false);

    const duplicateClaimToken = await requestJson(
      fixture.sandstormApiSocket,
      "/powerbox/claim-request?sessionId=missing&token=one&token=two",
      { method: "POST" });
    assert.equal(duplicateClaimToken.statusCode, 400);
    assert.equal(duplicateClaimToken.json.ok, false);

    const emptyClaimPermission = await requestJson(
      fixture.sandstormApiSocket,
      "/powerbox/claim-request?sessionId=missing&token=missing&requiredPermission=",
      { method: "POST" });
    assert.equal(emptyClaimPermission.statusCode, 400);
    assert.equal(emptyClaimPermission.json.ok, false);

    const missingDrop = await requestJson(
      fixture.sandstormApiSocket,
      "/powerbox/drop?id=missing",
      { method: "POST" });
    assert.equal(missingDrop.statusCode, 404);
    assert.equal(missingDrop.json.ok, false);

    const missingSave = await requestJson(
      fixture.sandstormApiSocket,
      "/powerbox/save?id=missing",
      { method: "POST" });
    assert.equal(missingSave.statusCode, 404);
    assert.equal(missingSave.json.ok, false);

    const duplicateSaveId = await requestJson(
      fixture.sandstormApiSocket,
      "/powerbox/save?id=one&id=two",
      { method: "POST" });
    assert.equal(duplicateSaveId.statusCode, 400);
    assert.equal(duplicateSaveId.json.ok, false);

    const emptySaveLabel = await requestJson(
      fixture.sandstormApiSocket,
      "/powerbox/save?id=missing&label=",
      { method: "POST" });
    assert.equal(emptySaveLabel.statusCode, 400);
    assert.equal(emptySaveLabel.json.ok, false);

    const missingRestore = await requestJson(
      fixture.sandstormApiSocket,
      "/powerbox/restore",
      { method: "POST" });
    assert.equal(missingRestore.statusCode, 400);
    assert.equal(missingRestore.json.ok, false);

    const duplicateRestoreToken = await requestJson(
      fixture.sandstormApiSocket,
      "/powerbox/restore?token=one&token=two",
      { method: "POST" });
    assert.equal(duplicateRestoreToken.statusCode, 400);
    assert.equal(duplicateRestoreToken.json.ok, false);

    const invalidRestoreToken = await requestJson(
      fixture.sandstormApiSocket,
      "/powerbox/restore?token=not%40base64url",
      { method: "POST" });
    assert.equal(invalidRestoreToken.statusCode, 400);
    assert.equal(invalidRestoreToken.json.ok, false);

    const missingDropSaved = await requestJson(
      fixture.sandstormApiSocket,
      "/powerbox/drop-saved",
      { method: "POST" });
    assert.equal(missingDropSaved.statusCode, 400);
    assert.equal(missingDropSaved.json.ok, false);

    const duplicateDropSavedToken = await requestJson(
      fixture.sandstormApiSocket,
      "/powerbox/drop-saved?token=one&token=two",
      { method: "POST" });
    assert.equal(duplicateDropSavedToken.statusCode, 400);
    assert.equal(duplicateDropSavedToken.json.ok, false);

    const invalidDropSavedToken = await requestJson(
      fixture.sandstormApiSocket,
      "/powerbox/drop-saved?token=not%40base64url",
      { method: "POST" });
    assert.equal(invalidDropSavedToken.statusCode, 400);
    assert.equal(invalidDropSavedToken.json.ok, false);

    const duplicateDropId = await requestJson(
      fixture.sandstormApiSocket,
      "/powerbox/drop?id=one&id=two",
      { method: "POST" });
    assert.equal(duplicateDropId.statusCode, 400);
    assert.equal(duplicateDropId.json.ok, false);

    const apiDescriptor = await requestJson(
      fixture.sandstormApiSocket,
      "/powerbox/api-session-descriptor" +
      `?apiCanonicalUrl=${encodeURIComponent("https://api.example.test/v1")}` +
      `&apiOauthScope=${encodeURIComponent("read")}`);
    assert.equal(apiDescriptor.statusCode, 200);
    assert.equal(apiDescriptor.json.ok, true);
    assert.equal(apiDescriptor.json.type, "packedPowerboxDescriptor");
    assert.equal(apiDescriptor.json.descriptor,
      "EBBQAQEAABEBF1EEAQH_x80lxnnjecgAQAMRCeIRFQ8AAP9odHRwczovLwJhcGkuZXhhbXBsZS50ZXN0By92MUEEAREBKg9yZWFk");
    assert.deepEqual(apiDescriptor.json.decoded, {
      type: "apiSession",
      canonicalUrl: "https://api.example.test/v1",
      oauthScopes: ["read"],
    });

    const outboundHttpDescriptor = await requestJson(
      fixture.sandstormApiSocket,
      "/powerbox/outbound-http-descriptor" +
      `?outboundHttpBaseUrl=${encodeURIComponent("https://api.example.test/v1")}` +
      `&outboundHttpMethod=${encodeURIComponent("GET")}` +
      `&outboundHttpMethod=${encodeURIComponent("POST")}`);
    assert.equal(outboundHttpDescriptor.statusCode, 200);
    assert.equal(outboundHttpDescriptor.json.ok, true);
    assert.equal(outboundHttpDescriptor.json.type, "packedPowerboxDescriptor");
    assert.equal(typeof outboundHttpDescriptor.json.descriptor, "string");
    assert.deepEqual(outboundHttpDescriptor.json.decoded, {
      type: "outboundHttp",
      baseUrl: "https://api.example.test/v1",
      methods: ["GET", "POST"],
    });
  });

  await t.test("serves the storage binding socket", async () => {
    const put = await requestJson(fixture.storageSocket, "/integration-key", {
      method: "PUT",
      body: "integration value",
    });
    assert.equal(put.statusCode, 200);
    assert.deepEqual(put.json, { ok: true, bytes: 17 });

    const head = await requestUnixSocket(
      fixture.storageSocket, "/integration-key", { method: "HEAD" });
    assert.equal(head.statusCode, 200);
    assert.equal(head.headers["x-sandstorm-storage-bytes"], "17");

    const get = await requestUnixSocket(fixture.storageSocket, "/integration-key");
    assert.equal(get.statusCode, 200);
    assert.equal(get.body, "integration value");

    const index = await requestJson(fixture.storageSocket, "/");
    assert.equal(index.statusCode, 200);
    assert.ok(index.json.keys.some(
      (entry) => entry.name === "integration-key" && entry.bytes === 17));
    assert.ok(index.json.totalBytes >= 17);

    const usageEntries = [];
    let usageTotalBytes = 0;
    for (let i = 0; i < 32; ++i) {
      const key = `usage-${String(i).padStart(2, "0")}`;
      const body = deterministicBytes(257 + i * 31);
      usageEntries.push({ key, bytes: body.length });
      usageTotalBytes += body.length;
      const usagePut = await requestJson(fixture.storageSocket, `/${key}`, {
        method: "PUT",
        body,
      });
      assert.equal(usagePut.statusCode, 200, key);
      assert.deepEqual(usagePut.json, { ok: true, bytes: body.length }, key);
    }

    const usageIndex = await requestJson(fixture.storageSocket, "/");
    assert.equal(usageIndex.statusCode, 200);
    const usageMap = new Map(usageIndex.json.keys.map((entry) => [entry.name, entry.bytes]));
    for (const entry of usageEntries) {
      assert.equal(usageMap.get(entry.key), entry.bytes, entry.key);
    }
    assert.ok(usageIndex.json.totalBytes >= usageTotalBytes + 17);

    for (const entry of usageEntries) {
      const usageDeleted = await requestJson(fixture.storageSocket, `/${entry.key}`, {
        method: "DELETE",
      });
      assert.equal(usageDeleted.statusCode, 200, entry.key);
      assert.equal(usageDeleted.json.ok, true, entry.key);
    }

    for (const key of ["/.hidden", "/bad/key", "/a..b", "/bad%20key"]) {
      const invalid = await requestJson(fixture.storageSocket, key);
      assert.equal(invalid.statusCode, 400, key);
      assert.equal(invalid.json.ok, false, key);
    }

    const unsupported = await requestJson(fixture.storageSocket, "/integration-key", {
      method: "PATCH",
      body: "ignored",
    });
    assert.equal(unsupported.statusCode, 405);
    assert.equal(unsupported.json.ok, false);

    const storageRoot = path.join(fixture.varDir, "isolate-storage");
    const blockedKey = path.join(storageRoot, "blocked-link");
    await fs.symlink("/etc/passwd", blockedKey);

    const blockedGet = await requestJson(fixture.storageSocket, "/blocked-link");
    assert.equal(blockedGet.statusCode, 404);
    assert.equal(blockedGet.json.ok, false);

    const blockedPut = await requestJson(fixture.storageSocket, "/blocked-link", {
      method: "PUT",
      body: "replacement",
    });
    assert.equal(blockedPut.statusCode, 409);
    assert.equal(blockedPut.json.ok, false);

    const blockedDelete = await requestJson(fixture.storageSocket, "/blocked-link", {
      method: "DELETE",
    });
    assert.equal(blockedDelete.statusCode, 409);
    assert.equal(blockedDelete.json.ok, false);

    const indexWithBlockedKey = await requestJson(fixture.storageSocket, "/");
    assert.equal(indexWithBlockedKey.statusCode, 200);
    assert.ok(!indexWithBlockedKey.json.keys.some((entry) => entry.name === "blocked-link"));

    const deleted = await requestJson(
      fixture.storageSocket, "/integration-key", { method: "DELETE" });
    assert.equal(deleted.statusCode, 200);
    assert.equal(deleted.json.ok, true);

    const missing = await requestJson(fixture.storageSocket, "/integration-key");
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json.ok, false);
  });

  await t.test("preserves storage across supervisor restart", async () => {
    const put = await requestJson(fixture.storageSocket, "/persist-key", {
      method: "PUT",
      body: "persistent value",
    });
    assert.equal(put.statusCode, 200);
    assert.deepEqual(put.json, { ok: true, bytes: 16 });

    await fixture.restart();

    const get = await requestUnixSocket(fixture.storageSocket, "/persist-key");
    assert.equal(get.statusCode, 200);
    assert.equal(get.body, "persistent value");

    const index = await requestJson(fixture.storageSocket, "/");
    assert.equal(index.statusCode, 200);
    assert.ok(index.json.keys.some(
      (entry) => entry.name === "persist-key" && entry.bytes === 16));
  });

  await t.test("rejects non-allowlisted sidecar commands", async () => {
    const { workdir, pkgDir, varDir, isolateSupervisorBin } =
      await prepareIsolateWorkdir("iso-bad-cmd-");
    try {
      const supervisorSocket = path.join(varDir, "socket");
      const workerdSocket = path.join(varDir, "isolate-runtime/workerd.sock");
      const { child, stdout, stderr } = spawnCollectingOutput(isolateSupervisorBin, [
        "--stdio",
        "--pkg", pkgDir,
        "--var", varDir,
        "--new",
        "isolate-test-app",
        "isolate-bad-command",
        "workerd",
        "serve",
        "${SANDSTORM_ISOLATE_RUNTIME_MANIFEST}",
        "sandstormConfig",
      ]);

      const exit = await waitForExit(child);
      assert.notEqual(exit.code, 0, formatOutput(stdout, stderr));
      assert.match(
        stderr.join(""),
        /Isolate sidecar command is not allowlisted/,
        formatOutput(stdout, stderr));
      assert.equal(await isSocket(supervisorSocket), false);
      assert.equal(await isSocket(workerdSocket), false);
    } finally {
      await fs.rm(workdir, { recursive: true, force: true });
    }
  });
});
