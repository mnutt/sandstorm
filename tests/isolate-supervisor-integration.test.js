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
const SPK_PATH = process.env.ISOLATE_TEST_SPK || path.join(REPO_DIR, "isolate-test-app.spk");
const WEBSESSION_CLIENT_BIN = process.env.ISOLATE_WEBSESSION_CLIENT ||
  path.join(REPO_DIR, "tmp/sandstorm/isolate-websession-client");

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

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;

  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");

  const timeout = delay(2000).then(() => "timeout");
  if (await Promise.race([exited, timeout]) === "timeout") {
    child.kill("SIGKILL");
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
  await requireFile(SPK_PATH, "Create it with: make isolate-test-app.spk.");

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
  const stdout = [];
  const stderr = [];
  let childExit = { value: null };
  let started = false;

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
    child = spawn(isolateSupervisorBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
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
      restart: async () => {
        if (child !== null) {
          await stopChild(child);
          child = null;
        }
        await unlinkSockets();
        spawnSupervisor(false);
        await waitForFixtureSockets();
      },
      cleanup: async () => {
        if (child !== null) {
          await stopChild(child);
          child = null;
        }
        await fs.rm(workdir, { recursive: true, force: true });
      },
    };
  } finally {
    if (!started && child !== null) {
      await stopChild(child);
    }
    if (!started) {
      await fs.rm(workdir, { recursive: true, force: true });
    }
  }
}

test("isolate supervisor integration suite", {
  timeout: 30000,
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
      ]);
    assert.deepEqual(
      manifest.bindings.map((binding) => [binding.name, binding.type]),
      [
        ["TEXT_BINDING", "text"],
        ["JSON_BINDING", "json"],
        ["SANDSTORM_API", "sandstormApi"],
        ["STORAGE", "storage"],
      ]);

    const workerdConfig = await fs.readFile(path.join(fixture.runtimeDir, "workerd.capnp"), "utf8");
    assert.match(workerdConfig, /name = "sandstorm"/);
    assert.match(workerdConfig, /service = "sandstorm-api"/);
    assert.match(workerdConfig, /service = "sandstorm-storage"/);
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
    await runCommand(WEBSESSION_CLIENT_BIN, [fixture.supervisorSocket]);
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
    assert.equal(body.sandstormApi.status.ok, true);
    assert.equal(body.sandstormApi.runtime.mainModule, "worker.js");
    assert.equal(body.storage.text, "stored from isolate");

    const apiPathResponse = await requestJson(fixture.workerdSocket, "/api/health?ignored=true");
    assert.equal(apiPathResponse.statusCode, 200);
    assert.equal(apiPathResponse.json.pathname, "/api/health");
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
  });

  await t.test("serves the Sandstorm API binding socket", async () => {
    const runtime = await requestJson(fixture.sandstormApiSocket, "/runtime");
    assert.equal(runtime.statusCode, 200);
    assert.equal(runtime.json.ok, true);
    assert.equal(runtime.json.mainModule, "worker.js");
    assert.equal(runtime.json.moduleCount, 3);
    assert.equal(runtime.json.bindingCount, 4);

    const modules = await requestJson(fixture.sandstormApiSocket, "/modules");
    assert.equal(modules.statusCode, 200);
    assert.deepEqual(
      modules.json.modules.map((module) => [module.name, module.type, module.main]),
      [
        ["worker.js", "esModule", true],
        ["message.txt", "text", false],
        ["metadata.json", "json", false],
      ]);

    const bindings = await requestJson(fixture.sandstormApiSocket, "/bindings");
    assert.equal(bindings.statusCode, 200);
    assert.deepEqual(
      bindings.json.bindings.map((binding) => [binding.name, binding.type, binding.workerdDirect]),
      [
        ["TEXT_BINDING", "text", true],
        ["JSON_BINDING", "json", true],
        ["SANDSTORM_API", "sandstormApi", true],
        ["STORAGE", "storage", true],
      ]);

    const missing = await requestJson(fixture.sandstormApiSocket, "/missing");
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json.ok, false);

    const wrongMethod = await requestJson(fixture.sandstormApiSocket, "/runtime", {
      method: "POST",
      body: "not allowed",
    });
    assert.equal(wrongMethod.statusCode, 405);
    assert.equal(wrongMethod.json.ok, false);
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

    const invalid = await requestJson(fixture.storageSocket, "/.hidden");
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json.ok, false);

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
