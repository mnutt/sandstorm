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

function requestUnixSocket(socketPath, requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath,
      path: requestPath,
      method: "GET",
      headers: { Host: "sandstorm" },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });

    req.on("error", reject);
    req.end();
  });
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

test("isolate supervisor launches workerd and serves the isolate test app", {
  timeout: 30000,
}, async () => {
  await requireExecutable(SANDSTORM_BIN, "Build the project first, e.g. make fast.");
  await requireExecutable(SPK_BIN, "Build the project first, e.g. make fast.");
  await requireFile(SPK_PATH, "Create it with: make isolate-test-app.spk.");

  await fs.mkdir(REPO_TMP_DIR, { recursive: true });
  const workdir = await fs.mkdtemp(path.join(REPO_TMP_DIR, "sandstorm-isolate-smoke-"));
  const pkgDir = path.join(workdir, "pkg");
  const varDir = path.join(workdir, "grain");
  const isolateSupervisorBin = path.join(workdir, "isolate-supervisor");
  const supervisorSocket = path.join(varDir, "socket");
  const workerdSocket = path.join(varDir, "isolate-runtime/workerd.sock");

  let child = null;
  const stdout = [];
  const stderr = [];
  const childExit = { value: null };

  try {
    await runCommand(SPK_BIN, ["unpack", SPK_PATH, pkgDir]);
    await fs.symlink(SANDSTORM_BIN, isolateSupervisorBin);

    child = spawn(isolateSupervisorBin, [
      "--stdio",
      "--pkg", pkgDir,
      "--var", varDir,
      "--new",
      "isolate-test-app",
      "isolate-smoke",
      "workerd",
      "serve",
      "${SANDSTORM_ISOLATE_WORKERD_CONFIG}",
      "sandstormConfig",
    ], {
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

    await waitForSockets([supervisorSocket, workerdSocket], childExit, stdout, stderr);

    const response = await requestUnixSocket(workerdSocket, "/");
    assert.equal(response.statusCode, 200, response.body + formatOutput(stdout, stderr));

    const body = JSON.parse(response.body);
    assert.equal(body.ok, true);
    assert.equal(body.message, "hello from a text module\n");
    assert.equal(body.metadata.fixture, "isolate-test-app");
    assert.equal(body.textBinding, "hello from a text binding");
    assert.deepEqual(body.jsonBinding, { binding: "json" });
    assert.equal(body.sandstormApi.status.ok, true);
    assert.equal(body.sandstormApi.runtime.mainModule, "worker.js");
    assert.equal(body.storage.text, "stored from isolate");
  } finally {
    if (child !== null) {
      await stopChild(child);
    }
    await fs.rm(workdir, { recursive: true, force: true });
  }
});
