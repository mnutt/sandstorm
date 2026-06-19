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

async function startIsolateFixture() {
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

    const core = spawnCollectingOutput(
      WEBSESSION_CLIENT_BIN, ["--core-server", supervisorSocket]);
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
    assert.deepEqual(body.helperVersions, {
      api: 0,
      rpc: 0,
      capnweb: "0.8.0",
      aggregate: {
        api: 0,
        rpc: 0,
        capnweb: "0.8.0",
      },
    });
    assert.equal(body.sandstormApi.status.ok, true);
    assert.equal(body.sandstormApi.runtime.mainModule, "worker.js");
    assert.equal(body.storage.text, "stored from isolate");

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
    assert.equal(exported.json.capability.type, "claimedCapability");
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
      supportsNativeAppRpcTransport: false,
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
      nativeInterface: "unknown",
      pathPrefix: "",
      persistent: true,
      hasDropNotify: false,
      dropNotifyRefCount: 0,
      supportsWebFetch: true,
      supportsOutboundHttpFetch: true,
      supportsNativeAppRpcTransport: false,
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
    assert.equal(selfTest.json.savedClass, true);
    assert.equal(selfTest.json.restoredClass, true);
    assert.equal(selfTest.json.capability.type, "claimedCapability");
    assert.equal(selfTest.json.saved.type, "savedCapability");
    assert.equal(selfTest.json.saved.tokenEncoding, "base64url");
    assert.equal(typeof selfTest.json.saved.token, "string");
    assert.equal(selfTest.json.restored.type, "claimedCapability");
    assert.equal(selfTest.json.wrongOutboundError.name, "ValidationError");
    assert.match(selfTest.json.wrongOutboundError.message, /nativeInterface webSession/);
    assert.match(selfTest.json.wrongOutboundError.message, /outbound HTTP/);
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
    assert.equal(selfTest.json.posted.body.body, "hello through claimed capability fetch");
    assert.equal(selfTest.json.posted.body.bodyBytes,
      "hello through claimed capability fetch".length);
    assert.equal(selfTest.json.posted.body.checksum,
      checksum(Buffer.from("hello through claimed capability fetch")));
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
    assert.equal(exported.json.capability.type, "claimedCapability");
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
      supportsNativeAppRpcTransport: false,
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
      nativeInterface: "unknown",
      pathPrefix: "",
      persistent: true,
      hasDropNotify: false,
      dropNotifyRefCount: 0,
      supportsWebFetch: true,
      supportsOutboundHttpFetch: true,
      supportsNativeAppRpcTransport: false,
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
    assert.equal(selfTest.json.savedClass, true);
    assert.equal(selfTest.json.restoredClass, true);
    assert.equal(selfTest.json.capability.type, "claimedCapability");
    assert.equal(selfTest.json.saved.type, "savedCapability");
    assert.equal(selfTest.json.saved.tokenEncoding, "base64url");
    assert.equal(typeof selfTest.json.saved.token, "string");
    assert.equal(selfTest.json.restored.type, "claimedCapability");
    assert.equal(selfTest.json.wrongOutboundError.name, "ValidationError");
    assert.match(selfTest.json.wrongOutboundError.message, /nativeInterface apiSession/);
    assert.match(selfTest.json.wrongOutboundError.message, /outbound HTTP/);
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
    assert.equal(exported.json.capability.type, "claimedCapability");
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
    assert.equal(statsAfterParentExport.json.webSessionNativeCount,
      statsBeforeExport.json.webSessionNativeCount + 1);
    assert.equal(statsAfterParentExport.json.routeBackedWebSessionCount,
      statsBeforeExport.json.routeBackedWebSessionCount + 1);
    assert.equal(statsAfterParentExport.json.importedCount,
      statsBeforeExport.json.importedCount);

    const capabilityInfo = await requestJson(
      fixture.sandstormApiSocket,
      `/capabilities/claimed?id=${encodeURIComponent(exported.json.capability.id)}`);
    assert.equal(capabilityInfo.statusCode, 200, capabilityInfo.body);
    assert.equal(capabilityInfo.json.ok, true);
    assert.equal(capabilityInfo.json.type, "claimedCapabilityInfo");
    assert.equal(capabilityInfo.json.id, exported.json.capability.id);
    assert.equal(capabilityInfo.json.kind, "routeBackedWebSession");
    assert.equal(capabilityInfo.json.residence, "localExport");
    assert.equal(capabilityInfo.json.nativeInterface, "webSession");
    assert.match(capabilityInfo.json.pathPrefix, /^\/__sandstorm\/object-capabilities\//);
    assert.equal(capabilityInfo.json.persistent, false);
    assert.equal(capabilityInfo.json.hasDropNotify, true);
    assert.equal(capabilityInfo.json.dropNotifyRefCount, 1);
    assert.equal(capabilityInfo.json.supportsWebFetch, true);
    assert.equal(capabilityInfo.json.supportsOutboundHttpFetch, false);
    assert.equal(capabilityInfo.json.supportsNativeAppRpcTransport, false);
    assert.equal(capabilityInfo.json.hasNativeCapability, true);
    assert.equal(capabilityInfo.json.liveForwardable, true);

    async function callObjectCapability(method, args = []) {
      return requestJson(
        fixture.sandstormApiSocket,
        `/powerbox/fetch?id=${encodeURIComponent(exported.json.capability.id)}` +
        `&method=POST&path=${encodeURIComponent("/call")}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({ method, args }),
        });
    }

    const first = await callObjectCapability("increment", [5]);
    assert.equal(first.statusCode, 200, first.body);
    assert.deepEqual(first.json, { ok: true, result: { value: 5 } });

    const second = await callObjectCapability("increment", [2]);
    assert.equal(second.statusCode, 200, second.body);
    assert.deepEqual(second.json, { ok: true, result: { value: 7 } });

    const current = await callObjectCapability("get");
    assert.equal(current.statusCode, 200, current.body);
    assert.deepEqual(current.json, { ok: true, result: { value: 7 } });

    const child = await callObjectCapability("child");
    assert.equal(child.statusCode, 200, child.body);
    assert.equal(child.json.ok, true);
    assert.equal(child.json.result.type, "claimedCapability");
    assert.equal(typeof child.json.result.id, "string");

    const statsAfterChildExport = await requestJson(
      fixture.sandstormApiSocket, "/capabilities/claimed-stats");
    assert.equal(statsAfterChildExport.statusCode, 200, statsAfterChildExport.body);
    assert.equal(statsAfterChildExport.json.claimedCapabilityCount,
      statsAfterParentExport.json.claimedCapabilityCount + 1);
    assert.equal(statsAfterChildExport.json.dropNotifyGroupCount,
      statsAfterParentExport.json.dropNotifyGroupCount + 1);
    assert.equal(statsAfterChildExport.json.localExportCount,
      statsAfterParentExport.json.localExportCount + 1);
    assert.equal(statsAfterChildExport.json.webSessionNativeCount,
      statsAfterParentExport.json.webSessionNativeCount + 1);
    assert.equal(statsAfterChildExport.json.routeBackedWebSessionCount,
      statsAfterParentExport.json.routeBackedWebSessionCount + 1);
    assert.equal(statsAfterChildExport.json.importedCount,
      statsAfterParentExport.json.importedCount);

    async function callChild(method, args = []) {
      return requestJson(
        fixture.sandstormApiSocket,
        `/powerbox/fetch?id=${encodeURIComponent(child.json.result.id)}` +
        `&method=POST&path=${encodeURIComponent("/call")}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({ method, args }),
        });
    }

    const childIncrement = await callChild("increment", [9]);
    assert.equal(childIncrement.statusCode, 200, childIncrement.body);
    assert.deepEqual(childIncrement.json, { ok: true, result: { value: 9 } });

    const parentReadsChild = await callObjectCapability("readOther", [child.json.result]);
    assert.equal(parentReadsChild.statusCode, 200, parentReadsChild.body);
    assert.deepEqual(parentReadsChild.json, { ok: true, result: { value: 9 } });

    const missing = await callObjectCapability("missingMethod");
    assert.equal(missing.statusCode, 404, missing.body);
    assert.equal(missing.json.ok, false);
    assert.match(missing.json.error, /RPC method not found/);

    const disposeBefore = await requestJson(
      fixture.workerdSocket, "/object-capability-dispose-count");
    assert.equal(disposeBefore.statusCode, 200, disposeBefore.body);
    assert.equal(disposeBefore.json.ok, true);

    const dropChild = await requestJson(
      fixture.sandstormApiSocket,
      `/powerbox/drop?id=${encodeURIComponent(child.json.result.id)}`,
      { method: "POST" });
    assert.equal(dropChild.statusCode, 200, dropChild.body);
    assert.equal(dropChild.json.ok, true);

    const statsAfterChildDrop = await requestJson(
      fixture.sandstormApiSocket, "/capabilities/claimed-stats");
    assert.equal(statsAfterChildDrop.statusCode, 200, statsAfterChildDrop.body);
    assert.equal(statsAfterChildDrop.json.claimedCapabilityCount,
      statsAfterParentExport.json.claimedCapabilityCount);
    assert.equal(statsAfterChildDrop.json.dropNotifyGroupCount,
      statsAfterParentExport.json.dropNotifyGroupCount);
    assert.equal(statsAfterChildDrop.json.localExportCount,
      statsAfterParentExport.json.localExportCount);
    assert.equal(statsAfterChildDrop.json.webSessionNativeCount,
      statsAfterParentExport.json.webSessionNativeCount);
    assert.equal(statsAfterChildDrop.json.routeBackedWebSessionCount,
      statsAfterParentExport.json.routeBackedWebSessionCount);
    assert.equal(statsAfterChildDrop.json.importedCount,
      statsAfterParentExport.json.importedCount);

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
      statsBeforeExport.json.claimedCapabilityCount);
    assert.equal(statsAfterParentDrop.json.dropNotifyGroupCount,
      statsBeforeExport.json.dropNotifyGroupCount);
    assert.equal(statsAfterParentDrop.json.localExportCount,
      statsBeforeExport.json.localExportCount);
    assert.equal(statsAfterParentDrop.json.webSessionNativeCount,
      statsBeforeExport.json.webSessionNativeCount);
    assert.equal(statsAfterParentDrop.json.routeBackedWebSessionCount,
      statsBeforeExport.json.routeBackedWebSessionCount);
    assert.equal(statsAfterParentDrop.json.importedCount,
      statsBeforeExport.json.importedCount);

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
    assert.equal(selfTest.json.child.type, "claimedCapability");
    assert.equal(selfTest.json.capabilityInfo.ok, true);
    assert.equal(selfTest.json.capabilityInfo.type, "claimedCapabilityInfo");
    assert.equal(selfTest.json.capabilityInfo.id, selfTest.json.duplicate.sourceId);
    assert.equal(selfTest.json.capabilityInfo.kind, "routeBackedWebSession");
    assert.equal(selfTest.json.capabilityInfo.residence, "localExport");
    assert.equal(selfTest.json.capabilityInfo.nativeInterface, "webSession");
    assert.match(
      selfTest.json.capabilityInfo.pathPrefix, /^\/__sandstorm\/object-capabilities\//);
    assert.equal(selfTest.json.capabilityInfo.persistent, false);
    assert.equal(selfTest.json.capabilityInfo.hasDropNotify, true);
    assert.equal(selfTest.json.capabilityInfo.dropNotifyRefCount, 1);
    assert.equal(selfTest.json.capabilityInfo.supportsWebFetch, true);
    assert.equal(selfTest.json.capabilityInfo.supportsOutboundHttpFetch, false);
    assert.equal(selfTest.json.capabilityInfo.supportsNativeAppRpcTransport, false);
    assert.equal(selfTest.json.capabilityInfo.hasNativeCapability, true);
    assert.equal(selfTest.json.capabilityInfo.liveForwardable, true);
    assert.equal(typeof selfTest.json.childInfo.id, "string");
    assert.equal(selfTest.json.childInfo.ok, true);
    assert.equal(selfTest.json.childInfo.type, "claimedCapabilityInfo");
    assert.equal(selfTest.json.childInfo.kind, "routeBackedWebSession");
    assert.equal(selfTest.json.childInfo.residence, "localExport");
    assert.equal(selfTest.json.childInfo.nativeInterface, "webSession");
    assert.match(selfTest.json.childInfo.pathPrefix, /^\/__sandstorm\/object-capabilities\//);
    assert.equal(selfTest.json.childInfo.persistent, false);
    assert.equal(selfTest.json.childInfo.hasDropNotify, true);
    assert.equal(selfTest.json.childInfo.dropNotifyRefCount, 1);
    assert.equal(selfTest.json.childInfo.supportsWebFetch, true);
    assert.equal(selfTest.json.childInfo.supportsOutboundHttpFetch, false);
    assert.equal(selfTest.json.childInfo.supportsNativeAppRpcTransport, false);
    assert.equal(selfTest.json.childInfo.hasNativeCapability, true);
    assert.equal(selfTest.json.childInfo.liveForwardable, true);
    assert.deepEqual(selfTest.json.childFirst, { value: 11 });
    assert.deepEqual(selfTest.json.readChild, { value: 11 });
    assert.deepEqual(selfTest.json.stubFirst, { value: 9 });
    assert.deepEqual(selfTest.json.stubCurrent, { value: 9 });
    assert.equal(selfTest.json.stubChildClass, true);
    assert.equal(selfTest.json.stubChild.type, "claimedCapability");
    assert.deepEqual(selfTest.json.stubChildFirst, { value: 13 });
    assert.deepEqual(selfTest.json.stubReadChild, { value: 13 });
    assert.deepEqual(selfTest.json.argumentTarget.read, { value: 21 });
    assert.equal(selfTest.json.argumentTarget.disposeAfter,
      selfTest.json.argumentTarget.disposeBefore + 1);
    assert.deepEqual(selfTest.json.stubArgumentTarget.read, { value: 23 });
    assert.equal(selfTest.json.stubArgumentTarget.disposeAfter,
      selfTest.json.stubArgumentTarget.disposeBefore + 1);
    assert.deepEqual(selfTest.json.retainedArgumentTarget.retain, { value: 31 });
    assert.equal(selfTest.json.retainedArgumentTarget.disposeAfterRetainCall,
      selfTest.json.retainedArgumentTarget.disposeBefore);
    assert.deepEqual(selfTest.json.retainedArgumentTarget.read, { value: 31 });
    assert.equal(selfTest.json.retainedArgumentTarget.drop.ok, true);
    assert.equal(selfTest.json.retainedArgumentTarget.disposeAfterDrop,
      selfTest.json.retainedArgumentTarget.disposeBefore + 1);
    assert.equal(selfTest.json.stubThenType, "undefined");
    assert.equal(selfTest.json.missing.name, "CapabilityCallError");
    assert.equal(selfTest.json.missing.status, 404);
    assert.equal(selfTest.json.saveError.name, "Error");
    assert.match(selfTest.json.saveError.message, /transient and cannot be saved/);
    assert.equal(selfTest.json.remoteArguments.rpcTargetError.name, "ValidationError");
    assert.match(selfTest.json.remoteArguments.rpcTargetError.message,
      /RpcTarget callback arguments cannot be passed to remote app-defined RPC calls/);
    assert.equal(selfTest.json.remoteArguments.claimedCapabilityError.name, "ValidationError");
    assert.match(selfTest.json.remoteArguments.claimedCapabilityError.message,
      /ClaimedCapability handles cannot be passed to remote app-defined RPC calls/);
    assert.match(selfTest.json.remoteArguments.claimedCapabilityError.message,
      /hasNativeCapability=true/);
    assert.match(selfTest.json.remoteArguments.claimedCapabilityError.message,
      /liveForwardable=true/);
    assert.match(selfTest.json.remoteArguments.claimedCapabilityError.message,
      /supportsNativeAppRpcTransport=false/);
    assert.match(selfTest.json.remoteArguments.claimedCapabilityError.message,
      /native app-defined RPC transport is not implemented yet/);
    assert.equal(typeof selfTest.json.duplicate.id, "string");
    assert.notEqual(selfTest.json.duplicate.id, selfTest.json.duplicate.sourceId);
    assert.equal(selfTest.json.duplicate.originalInfoWithDuplicateLive.id,
      selfTest.json.duplicate.sourceId);
    assert.equal(selfTest.json.duplicate.originalInfoWithDuplicateLive.dropNotifyRefCount, 2);
    assert.equal(selfTest.json.duplicate.duplicateInfoBeforeDrop.id,
      selfTest.json.duplicate.id);
    assert.equal(selfTest.json.duplicate.duplicateInfoBeforeDrop.dropNotifyRefCount, 2);
    assert.deepEqual(selfTest.json.duplicate.increment, { value: 14 });
    assert.equal(selfTest.json.duplicate.dropOriginal.ok, true);
    assert.equal(selfTest.json.duplicate.disposeAfterOriginalDrop,
      selfTest.json.duplicate.disposeBeforeDrop);
    assert.equal(selfTest.json.duplicate.duplicateInfoAfterOriginalDrop.id,
      selfTest.json.duplicate.id);
    assert.equal(selfTest.json.duplicate.duplicateInfoAfterOriginalDrop.dropNotifyRefCount, 1);
    assert.deepEqual(selfTest.json.duplicate.afterOriginalDrop, { value: 14 });
    assert.equal(selfTest.json.duplicate.dropDuplicate.ok, true);
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
    assert.match(selfTest.json.persistent.withoutIdError.message, /explicit id/);
    assert.deepEqual(selfTest.json.persistent.first, { value: 29 });
    assert.equal(selfTest.json.persistent.saved.type, "savedCapability");
    assert.equal(selfTest.json.persistent.saved.tokenEncoding, "base64url");
    assert.equal(selfTest.json.persistent.restored.type, "claimedCapability");
    assert.deepEqual(selfTest.json.persistent.restoredGet, { value: 29 });
    assert.deepEqual(selfTest.json.persistent.restoredIncrement, { value: 32 });
    assert.equal(selfTest.json.persistent.dropOriginal.ok, true);
    assert.equal(selfTest.json.persistent.dropRestored.ok, true);
    assert.equal(selfTest.json.persistent.unregisterOriginal.ok, true);
    assert.equal(selfTest.json.persistent.unregisterOriginal.disposed, true);
    assert.equal(selfTest.json.persistent.registerReplacement.ok, true);
    assert.equal(selfTest.json.persistent.registerReplacement.registered, true);
    assert.equal(selfTest.json.persistent.registerAgain.ok, true);
    assert.equal(selfTest.json.persistent.registerAgain.registered, false);
    assert.equal(selfTest.json.persistent.registerDuplicateError.name, "ValidationError");
    assert.match(selfTest.json.persistent.registerDuplicateError.message, /already registered/);
    assert.equal(selfTest.json.persistent.transientMintError.name, "ValidationError");
    assert.match(selfTest.json.persistent.transientMintError.message, /persistent: true/);
    assert.equal(selfTest.json.persistent.mintedAfterRegister.type, "claimedCapability");
    assert.deepEqual(selfTest.json.persistent.mintedAfterRegisterGet, { value: 41 });
    assert.equal(selfTest.json.persistent.dropMintedAfterRegister.ok, true);
    assert.equal(selfTest.json.persistent.restoredAfterRegister.type, "claimedCapability");
    assert.deepEqual(selfTest.json.persistent.restoredAfterRegisterGet, { value: 41 });
    assert.equal(selfTest.json.persistent.dropRestoredAfterRegister.ok, true);
    assert.equal(selfTest.json.persistent.dropSaved.ok, true);
    assert.equal(selfTest.json.persistent.unregisterReplacement.ok, true);
    assert.equal(selfTest.json.persistent.unregisterReplacement.disposed, true);
    assert.equal(selfTest.json.persistent.helper.first.restored, false);
    assert.equal(selfTest.json.persistent.helper.first.registered, true);
    assert.equal(selfTest.json.persistent.helper.first.capability.type, "claimedCapability");
    assert.equal(selfTest.json.persistent.helper.first.saved.type, "savedCapability");
    assert.deepEqual(selfTest.json.persistent.helper.first.get, { value: 53 });
    assert.equal(selfTest.json.persistent.helper.first.drop.ok, true);
    assert.equal(selfTest.json.persistent.helper.second.restored, true);
    assert.equal(selfTest.json.persistent.helper.second.registered, false);
    assert.equal(selfTest.json.persistent.helper.second.capability.type, "claimedCapability");
    assert.equal(selfTest.json.persistent.helper.second.saved.type, "savedCapability");
    assert.deepEqual(selfTest.json.persistent.helper.second.get, { value: 53 });
    assert.equal(selfTest.json.persistent.helper.second.drop.ok, true);
    assert.equal(selfTest.json.persistent.helper.dropSaved.ok, true);
    assert.equal(selfTest.json.persistent.helper.deleteStorage.ok, true);
    assert.equal(selfTest.json.persistent.helper.unregister.ok, true);
    assert.equal(selfTest.json.persistent.helper.unregister.disposed, true);
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
    assert.equal(runtime.json.moduleCount, 7);
    assert.equal(runtime.json.bindingCount, 6);

    const capabilities = await requestJson(fixture.sandstormApiSocket, "/capabilities");
    assert.equal(capabilities.statusCode, 200);
    assert.ok(capabilities.json.capabilities.includes("powerbox.claimRequest"));
    assert.ok(capabilities.json.capabilities.includes("powerbox.save"));
    assert.ok(capabilities.json.capabilities.includes("powerbox.restore"));
    assert.ok(capabilities.json.capabilities.includes("powerbox.dropSaved"));
    assert.ok(capabilities.json.capabilities.includes("powerbox.drop"));
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
      "http://sandstorm/capabilities/claimed?id=mock-app-object",
    ]);
    assert.equal(nativeInterfaceValidation.json.fetchError.name, "ValidationError");
    assert.match(nativeInterfaceValidation.json.fetchError.message,
      /nativeInterface outboundHttpSession/);
    assert.match(nativeInterfaceValidation.json.fetchError.message, /asOutboundHttp\(\)\.fetch/);
    assert.equal(nativeInterfaceValidation.json.appObjectFetchError.name, "ValidationError");
    assert.match(nativeInterfaceValidation.json.appObjectFetchError.message,
      /nativeInterface appObject/);
    assert.match(nativeInterfaceValidation.json.appObjectFetchError.message,
      /app-defined RPC transport/);
    assert.equal(nativeInterfaceValidation.json.appObjectOutboundError.name, "ValidationError");
    assert.match(nativeInterfaceValidation.json.appObjectOutboundError.message,
      /nativeInterface appObject/);

    const nativeAppRpcCodec = await requestJson(
      fixture.workerdSocket, "/native-app-rpc-codec-self-test");
    assert.equal(nativeAppRpcCodec.statusCode, 200, nativeAppRpcCodec.body);
    assert.equal(nativeAppRpcCodec.json.ok, true);
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
    });
    assert.deepEqual(nativeAppRpcCodec.json.callEnvelope, {
      method: "deliver",
      args: [
        { type: "text", value: "subject" },
        { type: "capability", value: { id: "slot-1", nativeInterface: "appObject" } },
        {
          type: "object",
          value: [{ name: "urgent", value: { type: "bool", value: true } }],
        },
      ],
    });
    assert.deepEqual(nativeAppRpcCodec.json.hydratedCall, {
      method: "deliver",
      args: [
        "subject",
        { type: "nativeCapabilitySlot", id: "slot-1", nativeInterface: "appObject" },
        { urgent: true },
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
        ],
      },
    });
    assert.deepEqual(nativeAppRpcCodec.json.resultValue, {
      accepted: true,
      receipt: { type: "nativeCapabilitySlot", id: "slot-1", nativeInterface: "appObject" },
    });
    assert.deepEqual(nativeAppRpcCodec.json.exceptionEnvelope, {
      type: "exception",
      name: "RemoteAppError",
      message: "remote failure",
      stack: "remote stack",
    });
    assert.equal(nativeAppRpcCodec.json.exceptionError.name, "CapabilityCallError");
    assert.equal(nativeAppRpcCodec.json.exceptionError.message, "remote failure");
    assert.deepEqual(nativeAppRpcCodec.json.exceptionError.details, {
      name: "RemoteAppError",
      stack: "remote stack",
    });
    assert.equal(nativeAppRpcCodec.json.slotFrozen, true);
    assert.equal(nativeAppRpcCodec.json.rawTargetError.name, "ValidationError");
    assert.match(nativeAppRpcCodec.json.rawTargetError.message, /native capability slot/);
    assert.equal(nativeAppRpcCodec.json.invalidCapabilityError.name, "ValidationError");
    assert.match(nativeAppRpcCodec.json.invalidCapabilityError.message, /at least 1 characters/);
    assert.equal(nativeAppRpcCodec.json.reservedMethodError.name, "ValidationError");
    assert.match(nativeAppRpcCodec.json.reservedMethodError.message, /reserved/);

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
