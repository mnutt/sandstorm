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
const crypto = require("node:crypto");
const { constants } = require("node:fs");
const fs = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const REPO_DIR = path.resolve(__dirname, "..");
const REPO_TMP_DIR = path.join(REPO_DIR, "tmp");
const SANDSTORM_BIN = process.env.SANDSTORM_BIN || path.join(REPO_DIR, "bin/sandstorm");
const SPK_BIN = process.env.SPK_BIN || path.join(REPO_DIR, "bin/spk");
const CAPNP_BIN = process.env.CAPNP_BIN || path.join(REPO_DIR, "tmp/capnp/compiler/capnp");
const SPK_PATH = process.env.ISOLATE_TEST_SPK ||
    path.join(REPO_DIR, "tests/assets/isolate-test-app.spk");
const WEBSESSION_CLIENT_BIN = process.env.ISOLATE_WEBSESSION_CLIENT ||
  path.join(REPO_DIR, "tmp/sandstorm/isolate-websession-client");
const CAPNP_ES_COMPILER_MODULE = process.env.CAPNP_ES_COMPILER_MODULE ||
  path.join(REPO_DIR,
    "tmp/capnp-es-npm/node_modules/@mnutt/capnp-es/dist/compiler/index.mjs");
const STRACE_BIN = process.env.STRACE_BIN || "strace";
const SYSCALL_TRACE_DIR = process.env.ISOLATE_SYSCALL_TRACE_DIR || "";
const SYSCALL_TRACE_PROFILE = process.env.ISOLATE_SYSCALL_TRACE_PROFILE || "";
const REPRESENTATIVE_SYSCALL_TRACE = SYSCALL_TRACE_PROFILE === "representative";
const STRESS_64M = process.env.ISOLATE_STRESS_64M === "1";
const TEST_SCOPE = process.env.ISOLATE_SUPERVISOR_TEST_SCOPE || "all";
if (!["all", "toolchain", "runtime"].includes(TEST_SCOPE)) {
  throw new Error(`invalid ISOLATE_SUPERVISOR_TEST_SCOPE: ${TEST_SCOPE}`);
}
const RUN_TOOLCHAIN_TESTS = TEST_SCOPE === "all" || TEST_SCOPE === "toolchain";
const RUN_RUNTIME_TESTS = TEST_SCOPE === "all" || TEST_SCOPE === "runtime";
const toolchainTest = RUN_TOOLCHAIN_TESTS ? test : test.skip;
const runtimeTest = RUN_RUNTIME_TESTS ? test : test.skip;
const TEST_TIMEOUT_MS = SYSCALL_TRACE_DIR || STRESS_64M ? 180000 : 30000;
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
const CAPNP_ES_GENERATED_SCHEMA_MODULES = [
  [
    "capnp:/sandstorm/activity.capnp",
    "__sandstorm_isolate_runtime/capnp-es-generated/sandstorm/activity.js",
  ],
  [
    "capnp:/sandstorm/grain.capnp",
    "__sandstorm_isolate_runtime/capnp-es-generated/sandstorm/grain.js",
  ],
  [
    "capnp:/sandstorm/identity.capnp",
    "__sandstorm_isolate_runtime/capnp-es-generated/sandstorm/identity.js",
  ],
  [
    "capnp:/sandstorm/isolate-bridge.capnp",
    "__sandstorm_isolate_runtime/capnp-es-generated/sandstorm/isolate-bridge.js",
  ],
  [
    "capnp:/sandstorm/outbound-http-session.capnp",
    "__sandstorm_isolate_runtime/capnp-es-generated/sandstorm/outbound-http-session.js",
  ],
  [
    "capnp:/sandstorm/powerbox.capnp",
    "__sandstorm_isolate_runtime/capnp-es-generated/sandstorm/powerbox.js",
  ],
  [
    "capnp:/sandstorm/util.capnp",
    "__sandstorm_isolate_runtime/capnp-es-generated/sandstorm/util.js",
  ],
  [
    "capnp:/sandstorm/web-session.capnp",
    "__sandstorm_isolate_runtime/capnp-es-generated/sandstorm/web-session.js",
  ],
];
const FIXTURE_GENERATED_SCHEMA_MODULES = [
  [
    "capnp:./native-greeter.capnp",
    "__sandstorm_isolate_runtime/capnp-es-generated/native-greeter.js",
  ],
  ...CAPNP_ES_GENERATED_SCHEMA_MODULES,
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

const NATIVE_GREETER_DATA_EXPECTATION = {
  byteCount: 16,
  checksum: checksum(Buffer.from([
    0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
  ])),
  firstEightHex: "0000001466747970",
};

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

function withTimeout(promise, timeoutMs, message) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timeout));
}

async function startUnixSocketHttpProxy(socketPath) {
  const server = http.createServer((clientReq, clientRes) => {
    const upstream = http.request({
      socketPath,
      path: clientReq.url,
      method: clientReq.method,
      headers: clientReq.headers,
    }, (res) => {
      clientRes.writeHead(res.statusCode, res.statusMessage, res.headers);
      res.pipe(clientRes);
    });
    upstream.on("error", (err) => {
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      }
      clientRes.end(err.message);
    });
    clientReq.pipe(upstream);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    }),
  };
}

function makeUnixSocketWebSocket(socketPath, options = {}) {
  return class UnixSocketWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static _instances = new Set();

    static terminateAllForTest() {
      for (const webSocket of this._instances) {
        webSocket._terminateForTest();
      }
      this._instances.clear();
    }

    constructor(url) {
      this.url = String(url);
      this.binaryType = "blob";
      this.readyState = UnixSocketWebSocket.CONNECTING;
      this._listeners = new Map();
      this._buffer = Buffer.alloc(0);
      this._handshakeComplete = false;
      this._socket = net.createConnection(socketPath);
      this.constructor._instances.add(this);
      this._socket.on("connect", () => this._writeHandshake());
      this._socket.on("data", (chunk) => this._receive(chunk));
      this._socket.on("error", (error) => this._fail(error));
      this._socket.on("close", () => this._closeFromSocket());
    }

    addEventListener(type, callback) {
      if (typeof callback !== "function") return;
      const listeners = this._listeners.get(type) || new Set();
      listeners.add(callback);
      this._listeners.set(type, listeners);
    }

    removeEventListener(type, callback) {
      this._listeners.get(type)?.delete(callback);
    }

    send(data) {
      if (this.readyState !== UnixSocketWebSocket.OPEN) {
        throw new Error("WebSocket is not open");
      }
      const payload = Buffer.isBuffer(data)
        ? data
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : ArrayBuffer.isView(data)
            ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
            : Buffer.from(String(data));
      this._socket.write(this._frame(payload, 0x2));
    }

    sendTextForTest(data) {
      if (this.readyState !== UnixSocketWebSocket.OPEN) {
        throw new Error("WebSocket is not open");
      }
      this._socket.write(this._frame(Buffer.from(String(data)), 0x1));
    }

    close() {
      if (this.readyState === UnixSocketWebSocket.CLOSED ||
          this.readyState === UnixSocketWebSocket.CLOSING) {
        return;
      }
      this.readyState = UnixSocketWebSocket.CLOSING;
      if (this._handshakeComplete) {
        try {
          this._socket.write(this._frame(Buffer.alloc(0), 0x8));
        } catch (_) {}
      }
      this._socket.end();
    }

    _dispatch(type, event = {}) {
      const fullEvent = { type, target: this, currentTarget: this, ...event };
      const propertyHandler = this[`on${type}`];
      if (typeof propertyHandler === "function") {
        propertyHandler.call(this, fullEvent);
      }
      for (const listener of this._listeners.get(type) || []) {
        listener.call(this, fullEvent);
      }
    }

    _writeHandshake() {
      const url = new URL(this.url);
      const key = crypto.randomBytes(16).toString("base64");
      const pathAndQuery = options.rewritePath
        ? options.rewritePath(`${url.pathname}${url.search}`)
        : `${url.pathname}${url.search}`;
      this._socket.write([
        `GET ${pathAndQuery} HTTP/1.1`,
        "Host: sandstorm",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        ...Object.entries(options.headers || {}).map(
          ([name, value]) => `${name}: ${value}`),
        "",
        "",
      ].join("\r\n"));
    }

    _receive(chunk) {
      this._buffer = Buffer.concat([this._buffer, chunk]);
      if (!this._handshakeComplete) {
        const headerEnd = this._buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const header = this._buffer.slice(0, headerEnd).toString("latin1");
        this._buffer = this._buffer.slice(headerEnd + 4);
        if (!/^HTTP\/1\.[01] 101\b/.test(header)) {
          this._fail(new Error(header.split("\r\n")[0] || "WebSocket upgrade failed"));
          return;
        }
        this._handshakeComplete = true;
        this.readyState = UnixSocketWebSocket.OPEN;
        this._dispatch("open");
      }
      this._readFrames();
    }

    _readFrames() {
      for (;;) {
        if (this._buffer.length < 2) return;
        const opcode = this._buffer[0] & 0x0f;
        let payloadLength = this._buffer[1] & 0x7f;
        let headerLength = 2;
        if (payloadLength === 126) {
          if (this._buffer.length < 4) return;
          payloadLength = this._buffer.readUInt16BE(2);
          headerLength = 4;
        } else if (payloadLength === 127) {
          if (this._buffer.length < 10) return;
          const high = this._buffer.readUInt32BE(2);
          const low = this._buffer.readUInt32BE(6);
          payloadLength = high * 0x100000000 + low;
          headerLength = 10;
        }
        if (this._buffer.length < headerLength + payloadLength) return;
        const payload = this._buffer.slice(headerLength, headerLength + payloadLength);
        this._buffer = this._buffer.slice(headerLength + payloadLength);

        if (opcode === 0x8) {
          this.close();
          return;
        } else if (opcode === 0x9) {
          this._socket.write(this._frame(payload, 0xa));
        } else if (opcode === 0x2) {
          const data = this.binaryType === "arraybuffer"
            ? payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength)
            : new Uint8Array(payload);
          this._dispatch("message", { data });
        }
      }
    }

    _frame(payload, opcode) {
      const mask = crypto.randomBytes(4);
      let header;
      if (payload.length < 126) {
        header = Buffer.alloc(2);
        header[1] = 0x80 | payload.length;
      } else if (payload.length <= 0xffff) {
        header = Buffer.alloc(4);
        header[1] = 0x80 | 126;
        header.writeUInt16BE(payload.length, 2);
      } else {
        header = Buffer.alloc(10);
        header[1] = 0x80 | 127;
        header.writeUInt32BE(Math.floor(payload.length / 0x100000000), 2);
        header.writeUInt32BE(payload.length >>> 0, 6);
      }
      header[0] = 0x80 | opcode;
      const masked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; ++i) {
        masked[i] = payload[i] ^ mask[i % 4];
      }
      return Buffer.concat([header, mask, masked]);
    }

    _fail(error) {
      this._dispatch("error", { error });
      this.close();
    }

    _closeFromSocket() {
      this.constructor._instances.delete(this);
      if (this.readyState === UnixSocketWebSocket.CLOSED) return;
      this.readyState = UnixSocketWebSocket.CLOSED;
      this._dispatch("close", { code: 1000 });
    }

    _terminateForTest() {
      this.readyState = UnixSocketWebSocket.CLOSED;
      this._socket.removeAllListeners();
      this._socket.unref();
    }
  };
}

function waitForWebSocketOpen(webSocket, message = "WebSocket open timed out") {
  if (webSocket.readyState === webSocket.constructor.OPEN) {
    return Promise.resolve();
  }

  return withTimeout(new Promise((resolve, reject) => {
    const cleanup = () => {
      webSocket.removeEventListener("open", onOpen);
      webSocket.removeEventListener("error", onError);
      webSocket.removeEventListener("close", onClose);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (event) => {
      cleanup();
      reject(event.error || new Error("WebSocket failed before opening"));
    };
    const onClose = () => {
      cleanup();
      reject(new Error("WebSocket closed before opening"));
    };
    webSocket.addEventListener("open", onOpen);
    webSocket.addEventListener("error", onError);
    webSocket.addEventListener("close", onClose);
  }), 5000, message);
}

function waitForWebSocketClose(webSocket, message = "WebSocket close timed out") {
  if (webSocket.readyState === webSocket.constructor.CLOSED) {
    return Promise.resolve();
  }

  return withTimeout(new Promise((resolve) => {
    const cleanup = () => {
      webSocket.removeEventListener("close", onClose);
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    webSocket.addEventListener("close", onClose);
  }), 5000, message);
}

const STATIC_IMPORT_SPECIFIER =
    /\b(from\s*["']|import\s*["'])(\/[^"']+|\.{1,2}\/[^"']+)(["'])/g;

async function importServedBrowserModule(baseUrl, outputDir, entryPath) {
  const materialized = new Map();

  function normalizeServedPath(servedPath, importerPath = "/") {
    const resolved = servedPath.startsWith("/")
      ? new URL(servedPath, baseUrl)
      : new URL(servedPath, new URL(importerPath, baseUrl));
    if (resolved.origin !== baseUrl) {
      throw new Error(`refusing to import external browser module ${resolved.href}`);
    }
    return resolved.pathname;
  }

  function localPathForServedPath(servedPath) {
    let relativePath = servedPath.slice(1);
    if (!relativePath.endsWith(".js") && !relativePath.endsWith(".mjs")) {
      relativePath += ".mjs";
    }
    return path.join(outputDir, relativePath);
  }

  async function materialize(servedPath) {
    const normalized = normalizeServedPath(servedPath);
    if (materialized.has(normalized)) {
      return materialized.get(normalized);
    }

    const promise = (async () => {
      const response = await fetch(new URL(normalized, baseUrl));
      if (!response.ok) {
        throw new Error(
          `browser module ${normalized} failed with ${response.status}: ` +
          await response.text());
      }

      const source = await response.text();
      const imports = [...source.matchAll(STATIC_IMPORT_SPECIFIER)].map((match) => match[2]);
      const replacements = new Map();
      for (const specifier of imports) {
        const dependencyPath = normalizeServedPath(specifier, normalized);
        replacements.set(
          specifier,
          pathToFileURL(localPathForServedPath(dependencyPath)).href);
        materialize(dependencyPath).catch(() => {});
      }

      const rewritten = source.replace(
        STATIC_IMPORT_SPECIFIER,
        (match, prefix, specifier, suffix) =>
          `${prefix}${replacements.get(specifier) || specifier}${suffix}`);
      const localPath = localPathForServedPath(normalized);
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await fs.writeFile(localPath, rewritten);
      return pathToFileURL(localPath).href;
    })();

    materialized.set(normalized, promise);
    return promise;
  }

  const entryModule = await materialize(entryPath);
  for (;;) {
    const pending = [...materialized.values()];
    await Promise.all(pending);
    if (pending.length === materialized.size) break;
  }
  return import(entryModule);
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
      "--isolate-trust-domain", "isolate-test-account",
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
      isolateSupervisorBin,
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

toolchainTest("spk dev-isolate prints manifests and native generated capnp modules", async (t) => {
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

toolchainTest("spk dev-isolate resolves app-interface schemas outside the repo", async (t) => {
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

toolchainTest("spk powerbox-descriptor emits schema interface descriptors", async () => {
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

toolchainTest("spk capnp-abi dumps schema interface metadata", async () => {
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
`);
  const structOptions = { cwd: fixtureRoot };
  const structDumped = await runCommand(SPK_BIN, [
    "capnp-abi",
    "capnp:./record.capnp",
  ], structOptions);
  const structAbi = JSON.parse(structDumped.stdout);
  assert.deepEqual(structAbi.structs, [{
    name: "Record",
    structId: structAbi.structs[0].structId,
    fields: [
      { name: "name", ordinal: 0, type: "Text" },
      { name: "text", ordinal: 1, type: "Text", discriminant: 0 },
      { name: "data", ordinal: 2, type: "Data", discriminant: 1 },
    ],
  }]);

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

toolchainTest("spk dev-isolate prints generated capnp modules", async (t) => {
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

toolchainTest("spk pack materializes generated capnp modules for packaged isolates", async (t) => {
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
  await fs.writeFile(pkgdefPath, [
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
    "  argv = [",
    "    \"workerd\",",
    "    \"serve\",",
    "    \"${SANDSTORM_ISOLATE_WORKERD_CONFIG}\",",
    "    \"sandstormConfig\"",
    "  ],",
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
  ].join("\n"));

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

runtimeTest("isolate supervisor integration suite", {
  timeout: TEST_TIMEOUT_MS,
}, async (t) => {
  const fixture = await startIsolateFixture();
  t.after(() => fixture.cleanup());

  await t.test("generates the workerd runtime bundle", async () => {
    const manifest = JSON.parse(
      await fs.readFile(path.join(fixture.runtimeDir, "runtime-manifest.json"), "utf8"));
    assert.equal(manifest.mainModule, "worker.js");
    assert.equal(manifest.compatibilityDate, "2025-01-01");
    assert.equal(manifest.topology, "perGrainSidecar");
    assert.deepEqual(
      manifest.modules.map((module) => [module.name, module.type]),
      [
        ["worker.js", "esModule"],
        ["message.txt", "text"],
        ["metadata.json", "json"],
        ...FIXTURE_GENERATED_SCHEMA_MODULES.map(([name]) => [name, "esModule"]),
        ["sandstorm:api", "esModule"],
        ["sandstorm-internal:capnp-runtime", "esModule"],
        ...CAPNP_ES_SCHEME_RUNTIME_MODULES.map(([name]) => [name, "esModule"]),
        ...CAPNP_ES_PATH_RUNTIME_MODULES.map(([name]) => [name, "esModule"]),
        ...CAPNP_ES_SCHEME_RELATIVE_RUNTIME_MODULES.map(([name]) => [name, "esModule"]),
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

  await t.test("reuses an already-running isolate supervisor", async () => {
    const existingStartCount = (fixture.stderr.join("")
        .match(/Started isolate sidecar process\./g) || []).length;
    const result = await runCommand(fixture.isolateSupervisorBin, [
      "--stdio",
      "--pkg", fixture.pkgDir,
      "--var", fixture.varDir,
      "--isolate-trust-domain", "isolate-test-account",
      "isolate-test-app",
      "isolate-integration",
      "workerd",
      "serve",
      "${SANDSTORM_ISOLATE_WORKERD_CONFIG}",
      "sandstormConfig",
    ]);

    assert.match(result.stdout, /Already running\.\.\./);
    assert.equal(
      (fixture.stderr.join("").match(/Started isolate sidecar process\./g) || []).length,
      existingStartCount);
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
    assert.equal(typeof body.sandstormApi.nativeCapnpBridge.targetId, "string");
    assert.ok(body.sandstormApi.nativeCapnpBridge.targetId.length > 0);
    assert.equal(body.sandstormApi.nativeCapnpBridge.generatedClient.error, "");
    assert.equal(body.sandstormApi.nativeCapnpBridge.generatedClient.streamError, "");
    assert.equal(body.sandstormApi.nativeCapnpBridge.generatedClient.dropError, "");
    assert.equal(
      body.sandstormApi.nativeCapnpBridge.isolateBridgeBootstrap.transportKind,
      "isolateBridgeWebSocketRpc");
    assert.equal(
      body.sandstormApi.nativeCapnpBridge.isolateBridgeBootstrap.connectionId,
      `isolate-bridge-bootstrap-${body.sandstormApi.nativeCapnpBridge.targetId}`);
    assert.deepEqual(body.sandstormApi.nativeCapnpBridge.isolateBridgeBootstrap.sandstormApi, {
      hasSave: true,
      hasRestore: true,
      hasDrop: true,
    });
    assert.match(
      body.sandstormApi.nativeCapnpBridge.isolateBridgeBootstrap.missingSessionError,
      /session ID not found/);
    assert.equal(
      typeof body.sandstormApi.nativeCapnpBridge.generatedClient.response.bodyText,
      "string");
    assert.equal(
      typeof body.sandstormApi.nativeCapnpBridge.generatedClient.response.bodyBytes,
      "number");
    assert.deepEqual(
      JSON.parse(body.sandstormApi.nativeCapnpBridge.generatedClient.response.bodyText),
      {
        ok: true,
        source: "native-capnp-generated-websession",
        method: "GET",
        pathname: "/native-capnp-bridge-target/generated-client",
        search: "",
      });
    assert.deepEqual(body.sandstormApi.nativeCapnpBridge.generatedClient.stream, {
      responseWhich: 1,
      content: true,
      statusCode: 0,
      mimeType: "application/octet-stream",
      bodyWhich: 1,
      handleClient: true,
      pinged: true,
    });
    assert.match(
      body.sandstormApi.nativeCapnpBridge.generatedClient.drop.generatedCallAfterDropError,
      /not a live RPC capability|live Sandstorm capability/);
    assert.deepEqual(body.capnpEs.payload, {
      bytes: body.capnpEs.messageBytes,
      capabilities: [
        {
          id: body.sandstormApi.nativeCapnpBridge.targetId,
          interfaceId: "a50711a14d35a8ce",
          interfaceName: "sandstorm.WebSession",
          kind: "receiverHosted",
        },
      ],
    });
    assert.deepEqual(body.helperVersions, {
      api: 0,
      capnp: 0,
      capnpNativeBridge: 0,
      aggregate: {
        api: 0,
      },
    });
    assert.equal(body.sandstormApi.status.ok, true);
    assert.equal(body.sandstormApi.runtime.mainModule, "worker.js");
    assert.equal(body.sandstormApi.runtime.topology, "perGrainSidecar");
    assert.deepEqual(body.sandstormApi.capnpBridgeInfo, {
      ok: true,
      type: "capnpBridgeInfo",
      protocolVersion: 0,
      minProtocolVersion: 0,
      maxProtocolVersion: 0,
      nativeTransport: true,
      nativeRpc: true,
      nativeRpcWebSocket: true,
    });
    assert.deepEqual(
      body.sandstormApi.helperCapnpBridgeInfo,
      body.sandstormApi.capnpBridgeInfo);
    assert.equal(body.sandstormApi.capnpBridgeNegotiation.available, true);
    assert.equal(body.sandstormApi.capnpBridgeNegotiation.protocolSupported, true);
    assert.equal(body.sandstormApi.capnpBridgeNegotiation.protocolVersion, 0);
    assert.equal(body.sandstormApi.capnpBridgeNegotiation.nativeTransport, true);
    assert.equal(body.sandstormApi.capnpBridgeNegotiation.nativeRpc, true);
    assert.equal(body.sandstormApi.capnpBridgeNegotiation.reason, "");
    assert.deepEqual(body.sandstormApi.capnpBridgeNegotiation.missingFeatures, []);
    assert.deepEqual(
      body.sandstormApi.capnpBridgeNegotiation.info,
      body.sandstormApi.capnpBridgeInfo);
    assert.equal(body.sandstormApi.capnpBridgeRpcNegotiation.available, true);
    assert.equal(body.sandstormApi.capnpBridgeRpcNegotiation.protocolSupported, true);
    assert.equal(body.sandstormApi.capnpBridgeRpcNegotiation.protocolVersion, 0);
    assert.equal(body.sandstormApi.capnpBridgeRpcNegotiation.nativeTransport, true);
    assert.equal(body.sandstormApi.capnpBridgeRpcNegotiation.nativeRpc, true);
    assert.equal(body.sandstormApi.capnpBridgeRpcNegotiation.nativeRpcWebSocket, true);
    assert.equal(body.sandstormApi.capnpBridgeRpcNegotiation.reason, "");
    assert.deepEqual(body.sandstormApi.capnpBridgeRpcNegotiation.missingFeatures, []);
    assert.deepEqual(
      body.sandstormApi.capnpBridgeRpcNegotiation.info,
      body.sandstormApi.capnpBridgeInfo);
    assert.equal(body.sandstormApi.nativeCapnpLocalExport.webSession.ok, true,
      JSON.stringify(body.sandstormApi.nativeCapnpLocalExport.webSession, null, 2));
    assert.equal(body.sandstormApi.nativeCapnpLocalExport.greeter.ok, true,
      JSON.stringify(body.sandstormApi.nativeCapnpLocalExport.greeter, null, 2));
    assert.equal(
      body.sandstormApi.nativeCapnpLocalExport.greeter.browserHandoff.hasMethod,
      true);
    assert.ok(
      body.sandstormApi.nativeCapnpLocalExport.greeter.bootstrapRestored.savedTokenLength > 0);
    assert.equal(
      body.sandstormApi.nativeCapnpLocalExport.webSession.capability.id,
      body.sandstormApi.nativeCapnpLocalExport.webSession.info.id);
    assert.equal(
      body.sandstormApi.nativeCapnpLocalExport.greeter.capability.id,
      body.sandstormApi.nativeCapnpLocalExport.greeter.info.id);
    assert.equal(
      body.sandstormApi.nativeCapnpLocalExport.greeter.handoff.id,
      body.sandstormApi.nativeCapnpLocalExport.greeter.capability.id);
    assert.deepEqual(body.sandstormApi.nativeCapnpLocalExport, {
      stream: {
        serverBootstrap: true,
        serverQuestionId: 77,
        echoBootstrap: true,
        echoQuestionId: 77,
        adapters: {
          pipeReadableToByteStream: {
            bytes: 12,
            checksum: 31,
          },
          writableFromByteStream: {
            bytes: 6,
            checksum: 15,
          },
          byteStreamFromWritable: {
            expectedRemaining: "9",
            closed: true,
            chunks: 3,
            bytes: 9,
            checksum: 36,
          },
        },
      },
      webSession: {
        ok: true,
        status: 200,
        contentType: "text/plain; charset=utf-8",
        text: "native export websession get native-export-websession?from=rpc",
        capability: {
          ok: true,
          type: "nativeCapnpCapability",
          id: body.sandstormApi.nativeCapnpLocalExport.webSession.capability.id,
          kind: "localExport",
          interfaceId: "0xa50711a14d35a8ce",
          interfaceName: "WebSession",
        },
        info: {
          ok: true,
          type: "nativeCapnpCapability",
          kind: "localExport",
          id: body.sandstormApi.nativeCapnpLocalExport.webSession.info.id,
          interfaceId: "0xa50711a14d35a8ce",
          interfaceName: "WebSession",
        },
        drop: null,
      },
      greeter: {
        ok: true,
        message: "native export greeter hello isolate schema",
        pipelinedMessage:
            "native export pipelined greeter before makeGreeter resolves",
        resolvedGreeter: true,
        argumentMessage:
            "native export greeter called native export pipelined greeter " +
            "bridge client from native export self-test",
        conformance: {
          direct: {
            hello: {
              message: "native export greeter hello direct schema",
            },
            pipelined: {
              message:
                  "native export direct greeter before direct makeGreeter resolves",
            },
            resolved: {
              hasClient: true,
              message:
                  "native export direct greeter after direct makeGreeter resolves",
            },
            argument: {
              message:
                  "native export greeter called native export direct greeter " +
                  "direct client from native export self-test",
            },
            data: NATIVE_GREETER_DATA_EXPECTATION,
          },
          bridge: {
            hello: {
              message: "native export greeter hello isolate schema",
            },
            pipelined: {
              message:
                  "native export pipelined greeter before makeGreeter resolves",
            },
            resolved: {
              hasClient: true,
              message:
                  "native export pipelined greeter after makeGreeter resolves",
            },
            argument: {
              message:
                  "native export greeter called native export pipelined greeter " +
                  "bridge client from native export self-test",
            },
            data: NATIVE_GREETER_DATA_EXPECTATION,
          },
          handoff: {
            hello: {
              message: "native export greeter hello handoff schema",
            },
            pipelined: {
              message:
                  "native export handoff greeter before handoff makeGreeter resolves",
            },
            resolved: {
              hasClient: true,
              message:
                  "native export handoff greeter after handoff makeGreeter resolves",
            },
            argument: {
              message:
                  "native export greeter called native export handoff greeter " +
                  "handoff client from native export self-test",
            },
            data: NATIVE_GREETER_DATA_EXPECTATION,
          },
          restored: {
            hello: {
              message: "classic native greeter native-export-greeter hello restored schema",
            },
            pipelined: {
              message:
                  "native export restored greeter before restored makeGreeter resolves",
            },
            resolved: {
              hasClient: true,
              message:
                  "native export restored greeter after restored makeGreeter resolves",
            },
            argument: {
              message:
                  "classic native greeter native-export-greeter called " +
                  "native export restored greeter restored client from " +
                  "classic native greeter native-export-greeter",
            },
            data: NATIVE_GREETER_DATA_EXPECTATION,
          },
          bootstrapRestored: {
            hello: {
              message:
                  "classic native greeter native-export-greeter hello bootstrap restored schema",
            },
            pipelined: {
              message:
                  "native export bootstrap restored greeter " +
                  "before bootstrap restored makeGreeter resolves",
            },
            resolved: {
              hasClient: true,
              message:
                  "native export bootstrap restored greeter " +
                  "after bootstrap restored makeGreeter resolves",
            },
            argument: {
              message:
                  "classic native greeter native-export-greeter called " +
                  "native export bootstrap restored greeter bootstrap restored client from " +
                  "classic native greeter native-export-greeter",
            },
            data: NATIVE_GREETER_DATA_EXPECTATION,
          },
        },
        capability: {
          ok: true,
          type: "nativeCapnpCapability",
          id: body.sandstormApi.nativeCapnpLocalExport.greeter.capability.id,
          kind: "localExport",
          interfaceId: "0xb66316217ceedb1b",
          interfaceName: "NativeGreeter",
        },
        browserHandoff: {
          hasMethod: true,
        },
        handoff: {
          kind: "localExport",
          interfaceId: "b66316217ceedb1b",
          interfaceName: "NativeGreeter",
          connectionIsNull: true,
          id: body.sandstormApi.nativeCapnpLocalExport.greeter.handoff.id,
          dropResult: null,
        },
        restored: {
          savedTokenType: "string",
          kind: "rpcImport",
          interfaceId: "b66316217ceedb1b",
          interfaceName: "NativeGreeter",
          connectionIsNull: true,
          id: body.sandstormApi.nativeCapnpLocalExport.greeter.restored.id,
          dropResult: null,
        },
        bootstrapRestored: {
          savedTokenType: "string",
          savedTokenLength:
              body.sandstormApi.nativeCapnpLocalExport.greeter.bootstrapRestored.savedTokenLength,
          connectionId: body.sandstormApi.nativeCapnpLocalExport.greeter.bootstrapRestored.connectionId,
          transportKind: null,
          capabilityKind: "rpcImport",
          interfaceId: "b66316217ceedb1b",
          interfaceName: "NativeGreeter",
          connectionIsNull: true,
          dropResult: null,
        },
        info: {
          ok: true,
          type: "nativeCapnpCapability",
          kind: "localExport",
          id: body.sandstormApi.nativeCapnpLocalExport.greeter.info.id,
          interfaceId: "0xb66316217ceedb1b",
          interfaceName: "NativeGreeter",
        },
        drop: null,
      },
      classicGreeter: {
        ok: true,
        savedTokenType: "string",
        savedTokenLength:
            body.sandstormApi.nativeCapnpLocalExport.classicGreeter.savedTokenLength,
        resavedTokenType: "string",
        resavedTokenLength:
            body.sandstormApi.nativeCapnpLocalExport.classicGreeter.resavedTokenLength,
        conformance: {
          hello: {
            message:
                "classic native greeter fixture-classic-native-greeter hello restored schema",
          },
          pipelined: {
            message:
                "classic restored greeter before classic restored makeGreeter resolves",
          },
          resolved: {
            hasClient: true,
            message:
                "classic restored greeter after classic restored makeGreeter resolves",
          },
          argument: {
            message:
                "classic native greeter fixture-classic-native-greeter called " +
                "classic restored greeter restored client from classic native greeter " +
                "fixture-classic-native-greeter",
          },
          data: NATIVE_GREETER_DATA_EXPECTATION,
        },
        restored: {
          kind: "rpcImport",
          interfaceId: "b66316217ceedb1b",
          interfaceName: "NativeGreeter",
          connectionIsNull: true,
          id: body.sandstormApi.nativeCapnpLocalExport.classicGreeter.restored.id,
        },
        drop: null,
      },
    });
    assert.deepEqual(body.sandstormApi.nativeCapnpBridge, {
      available: true,
      protocolVersion: 0,
      isolateBridgeBootstrap: {
        transportKind: "isolateBridgeWebSocketRpc",
        connectionId: `isolate-bridge-bootstrap-${body.sandstormApi.nativeCapnpBridge.targetId}`,
        sandstormApi: {
          hasSave: true,
          hasRestore: true,
          hasDrop: true,
        },
        missingSessionError:
            body.sandstormApi.nativeCapnpBridge.isolateBridgeBootstrap.missingSessionError,
      },
      targetId: body.sandstormApi.nativeCapnpBridge.targetId,
      connectedClient: {
        isFixtureClient: true,
        hasBootstrapClient: true,
        targetId: body.sandstormApi.nativeCapnpBridge.targetId,
        connectionIsNull: true,
        hasDrop: true,
        hasSave: true,
      },
      generatedClient: {
        ok: true,
        error: "",
        streamOk: true,
        streamError: "",
        dropOk: true,
        dropError: "",
        targetId: body.sandstormApi.nativeCapnpBridge.targetId,
        connectionIsNull: true,
        response: {
          responseWhich: 1,
          content: true,
          statusCode: 0,
          mimeType: "application/json",
          bodyWhich: 0,
          bodyBytes: body.sandstormApi.nativeCapnpBridge.generatedClient.response.bodyBytes,
          bodyText: body.sandstormApi.nativeCapnpBridge.generatedClient.response.bodyText,
        },
        stream: {
          responseWhich: 1,
          content: true,
          statusCode: 0,
          mimeType: "application/octet-stream",
          bodyWhich: 1,
          handleClient: true,
          pinged: true,
        },
        drop: {
          targetId: body.sandstormApi.nativeCapnpBridge.generatedClient.drop.targetId,
          connectionId: null,
          dropResult: null,
          generatedCallAfterDropError:
              body.sandstormApi.nativeCapnpBridge.generatedClient.drop
                  .generatedCallAfterDropError,
        },
      },
    });
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
    assert.equal(powerboxProbe.json.powerboxEndpoint.status, 200);
    assert.equal(powerboxProbe.json.powerboxEndpoint.body.ok, true);
    assert.equal(powerboxProbe.json.powerboxEndpoint.body.type, "packedPowerboxDescriptor");

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
    assert.match(storageHelper.json.invalidKeyError, /key is not a valid storage key/);
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
    assert.equal(powerboxGrants.json.client.hasRequestPowerbox, true);
    assert.equal(powerboxGrants.json.client.importsNativeClient, true);
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
    assert.equal(powerboxFulfillment.json.nativeFulfill, null);
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

  await t.test("rejects malformed native capnp WebSocket frames", async () => {
    const DirectWebSocket = makeUnixSocketWebSocket(fixture.sandstormApiSocket, {
      headers: {
        "X-Sandstorm-Session-Id": "malformed-native-capnp-session",
      },
    });
    const malformedCases = [
      {
        name: "empty-binary",
        send: (webSocket) => webSocket.send(Buffer.alloc(0)),
      },
      {
        name: "short-segment-table",
        send: (webSocket) => webSocket.send(Buffer.from([0, 0, 0, 0])),
      },
      {
        name: "huge-segment-count",
        send: (webSocket) => webSocket.send(Buffer.from([
          0xff, 0xff, 0xff, 0xff,
          0, 0, 0, 0,
        ])),
      },
      {
        name: "text-frame",
        send: (webSocket) => webSocket.sendTextForTest("not a capnp message"),
      },
    ];

    try {
      for (const testCase of malformedCases) {
        const webSocket = new DirectWebSocket(
          `ws://sandstorm/capnp/rpc-session?bootstrap=browser&` +
          `connectionId=malformed-${testCase.name}`);
        await waitForWebSocketOpen(
          webSocket,
          `malformed native capnp WebSocket ${testCase.name} did not open`);
        testCase.send(webSocket);
        await waitForWebSocketClose(
          webSocket,
          `malformed native capnp WebSocket ${testCase.name} did not close`);
      }
    } finally {
      DirectWebSocket.terminateAllForTest();
    }

    const runtime = await requestJson(fixture.sandstormApiSocket, "/runtime");
    assert.equal(runtime.statusCode, 200, runtime.body);
    assert.equal(runtime.json.ok, true);
  });

  await t.test("exports route-backed WebSession capabilities", async () => {
    const exported = await requestJson(fixture.workerdSocket, "/export-web-session");
    assert.equal(exported.statusCode, 200, exported.body + formatOutput(
      fixture.stdout, fixture.stderr));
    assert.equal(exported.json.ok, true);
    assert.equal(exported.json.capabilityClass, true);
    assert.equal(exported.json.capability.type, "capability");
    assert.equal(typeof exported.json.capability.id, "string");
    assert.deepEqual(exported.json.info, {
      ok: true,
      type: "capabilityInfo",
      id: exported.json.capability.id,
      kind: "routeBackedWebSession",
      residence: "localExport",
      nativeInterface: "webSession",
      pathPrefix: "/exported",
      persistent: true,
      supportsWebFetch: true,
      supportsOutboundHttpFetch: false,
      hasNativeCapability: true,
      liveForwardable: true,
    });

    const prefixValidation = await requestJson(
      fixture.workerdSocket, "/route-prefix-validation-self-test");
    assert.equal(prefixValidation.statusCode, 200, prefixValidation.body);
    assert.equal(prefixValidation.json.ok, true);
    assert.equal(prefixValidation.json.results.dotSegmentPrefix.ok, false);
    assert.match(
      prefixValidation.json.results.dotSegmentPrefix.error,
      /pathPrefix|canonical|500/);
    assert.equal(prefixValidation.json.results.invalidPersistent.ok, false);
    assert.match(
      prefixValidation.json.results.invalidPersistent.error,
      /persistent|boolean|500/);

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
    assert.equal(selfTest.json.dropOriginal, null);
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
    assert.equal(selfTest.json.streamed.status, 200);
    assert.equal(selfTest.json.streamed.contentType, "application/octet-stream");
    assert.equal(selfTest.json.streamed.downloadBytes, "131072");
    assert.equal(selfTest.json.streamed.bytes, 131072);
    assert.equal(selfTest.json.streamed.checksum, checksum(deterministicBytes(131072)));
    assert.equal(selfTest.json.dropRestored, null);
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
    assert.deepEqual(exported.json.info, {
      ok: true,
      type: "capabilityInfo",
      id: exported.json.capability.id,
      kind: "routeBackedApiSession",
      residence: "localExport",
      nativeInterface: "apiSession",
      pathPrefix: "/api-exported",
      persistent: true,
      supportsWebFetch: true,
      supportsOutboundHttpFetch: false,
      hasNativeCapability: true,
      liveForwardable: true,
    });

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
    assert.equal(selfTest.json.dropOriginal, null);
    assert.equal(selfTest.json.fetched.status, 200);
    assert.equal(selfTest.json.fetched.body.ok, true);
    assert.equal(selfTest.json.fetched.body.source, "exported-api-session");
    assert.equal(selfTest.json.fetched.body.pathname, "/api-exported/capability-echo");
    assert.equal(selfTest.json.fetched.body.search, "?source=api-js-restore");
    assert.equal(selfTest.json.dropRestored, null);
    assert.equal(selfTest.json.dropSaved.ok, true);
  });

  await t.test("fetches restored OutboundHttpSession capabilities from isolate JS", async () => {
    const selfTest = await requestJson(
      fixture.workerdSocket, "/outbound-http-restore-self-test");
    assert.equal(selfTest.statusCode, 200, selfTest.body + formatOutput(
      fixture.stdout, fixture.stderr));
    assert.equal(selfTest.json.ok, true);
    assert.equal(selfTest.json.restoredClass, true);
    assert.equal(selfTest.json.restored.type, "capability");
    assert.equal(selfTest.json.restoredInfo.ok, true);
    assert.equal(selfTest.json.restoredInfo.kind, "restored");
    assert.equal(selfTest.json.restoredInfo.nativeInterface, "outboundHttpSession");
    assert.equal(selfTest.json.restoredInfo.supportsWebFetch, false);
    assert.equal(selfTest.json.restoredInfo.supportsOutboundHttpFetch, true);
    assert.equal(selfTest.json.fetchError.name, "ValidationError");
    assert.match(selfTest.json.fetchError.message, /OutboundHttpSession/);
    assert.match(selfTest.json.fetchError.message, /capability descriptor supplies the origin/);
    assert.equal(selfTest.json.unifiedFetch, true);
    assert.equal(selfTest.json.status, 201);
    assert.equal(selfTest.json.statusText, "Created");
    assert.equal(selfTest.json.contentType, "application/json; charset=utf-8");
    assert.equal(selfTest.json.outboundHeader, "yes");
    assert.equal(selfTest.json.body.ok, true);
    assert.equal(selfTest.json.body.source, "fake-outbound-http");
    assert.equal(selfTest.json.body.path, "v1/chat/completions?model=test");
    assert.equal(selfTest.json.body.authorization, "Bearer isolate-test");
    assert.equal(selfTest.json.body.body, "hello");
    assert.equal(selfTest.json.dropRestored, null);
    assert.equal(selfTest.json.dropSaved.ok, true);
  });

  await t.test("generates native capnp powerbox descriptors from worker bindings", async () => {
    const selfTest = await requestJson(
      fixture.workerdSocket, "/native-capnp-descriptor-self-test");
    assert.equal(selfTest.statusCode, 200, selfTest.body + formatOutput(
      fixture.stdout, fixture.stderr));
    assert.equal(selfTest.json.ok, true);
    assert.equal(selfTest.json.helperVersion, 0);
    assert.equal(selfTest.json.powerboxDescriptor.interfaceName, "NativeGreeter");
    assert.equal(selfTest.json.powerboxDescriptor.interfaceId, "0xb66316217ceedb1b");
    assert.equal(typeof selfTest.json.powerboxDescriptor.descriptor, "string");
    assert.match(selfTest.json.powerboxDescriptor.descriptor, /^[A-Za-z0-9_-]+$/);
    assert.equal(selfTest.json.powerboxDescriptor.descriptor,
      selfTest.json.powerboxDescriptor.info.descriptor);
    assert.deepEqual(selfTest.json.powerboxDescriptor.info.decoded, {
      kind: "appInterface",
      interfaceId: "0xb66316217ceedb1b",
      interfaceName: "NativeGreeter",
    });
    assert.equal(selfTest.json.powerboxDescriptor.cachedInfo.descriptor,
      selfTest.json.powerboxDescriptor.info.descriptor);
    assert.deepEqual(selfTest.json.powerboxDescriptor.cachedInfo.decoded, {
      kind: "appInterface",
      interfaceId: "0xb66316217ceedb1b",
      interfaceName: "NativeGreeter",
    });
  });

  await t.test("calls legacy native capnp capabilities from isolate JS", async () => {
    const savedToken = Buffer.from("native-greeter-saved-token", "utf8").toString("base64url");
    const selfTest = await requestJson(
      fixture.workerdSocket,
      `/legacy-native-greeter-self-test?token=${encodeURIComponent(savedToken)}` +
      `&name=${encodeURIComponent("isolate client")}`);
    assert.equal(selfTest.statusCode, 200, selfTest.body + formatOutput(
      fixture.stdout, fixture.stderr));
    assert.deepEqual(selfTest.json, {
      ok: true,
      capability: {
        kind: "rpcImport",
        interfaceId: "b66316217ceedb1b",
        interfaceName: "NativeGreeter",
        connectionIsNull: true,
        id: selfTest.json.capability.id,
      },
      hello: {
        message: "legacy native hello isolate client",
      },
      returnedHello: {
        message: "legacy returned isolate client",
      },
      greeted: {
        message: "legacy called legacy returned isolate client from legacy",
      },
      dropResult: null,
    });
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
    assert.equal(runtime.json.topology, "perGrainSidecar");
    assert.equal(
      runtime.json.moduleCount,
      5 + FIXTURE_GENERATED_SCHEMA_MODULES.length +
          CAPNP_ES_SCHEME_RUNTIME_MODULES.length + CAPNP_ES_PATH_RUNTIME_MODULES.length +
          CAPNP_ES_SCHEME_RELATIVE_RUNTIME_MODULES.length);
    assert.equal(runtime.json.bindingCount, 6);

    const capabilities = await requestJson(fixture.sandstormApiSocket, "/capabilities");
    assert.equal(capabilities.statusCode, 200);
    assert.ok(capabilities.json.capabilities.includes("powerbox.claim"));
    assert.ok(!capabilities.json.capabilities.includes("powerbox.claimRequest"));
    assert.ok(!capabilities.json.capabilities.includes("powerbox.save"));
    assert.ok(!capabilities.json.capabilities.includes("powerbox.restore"));
    assert.ok(!capabilities.json.capabilities.includes("powerbox.dropSaved"));
    assert.ok(!capabilities.json.capabilities.includes("powerbox.fetch"));
    assert.ok(!capabilities.json.capabilities.includes("powerbox.outboundHttpFetch"));
    assert.ok(!capabilities.json.capabilities.includes("powerbox.drop"));
    assert.ok(capabilities.json.capabilities.includes("powerbox.apiSessionDescriptor"));
    assert.ok(capabilities.json.capabilities.includes("powerbox.outboundHttpDescriptor"));
    assert.ok(capabilities.json.capabilities.includes("powerbox.offer"));
    assert.ok(capabilities.json.capabilities.includes("powerbox.fulfillRequest"));
    assert.ok(capabilities.json.capabilities.includes("powerbox.tieToUser"));
    assert.ok(capabilities.json.capabilities.includes("permissions"));
    assert.ok(!capabilities.json.capabilities.includes("capabilities.webSession"));
    assert.ok(!capabilities.json.capabilities.includes("capabilities.apiSession"));
    assert.ok(!capabilities.json.capabilities.includes("capabilities.nativeCapnpExport"));
    assert.ok(!capabilities.json.capabilities.includes("capabilities.claimed"));
    assert.ok(!capabilities.json.capabilities.includes("capabilities.claimedStats"));
    assert.ok(capabilities.json.capabilities.includes("capnp.bridgeInfo"));
    assert.ok(!capabilities.json.capabilities.includes("capnp.lifecycle"));

    const capnpBridgeInfo = await requestJson(fixture.sandstormApiSocket, "/capnp/bridge-info");
    assert.equal(capnpBridgeInfo.statusCode, 200, capnpBridgeInfo.body);
    assert.deepEqual(capnpBridgeInfo.json, {
      ok: true,
      type: "capnpBridgeInfo",
      protocolVersion: 0,
      minProtocolVersion: 0,
      maxProtocolVersion: 0,
      nativeTransport: true,
      nativeRpc: true,
      nativeRpcWebSocket: true,
    });

    const capnpLifecycle = await requestJson(fixture.sandstormApiSocket, "/capnp/lifecycle", {
      method: "POST",
      body: "",
    });
    assert.equal(capnpLifecycle.statusCode, 405, capnpLifecycle.body);
    assert.equal(capnpLifecycle.json.ok, false);
    assert.match(capnpLifecycle.json.error, /method not allowed/);

    const browserCapnpBridgeInfo = await requestJson(
      fixture.workerdSocket, "/__sandstorm/native-capnp/bridge-info");
    assert.equal(browserCapnpBridgeInfo.statusCode, 200, browserCapnpBridgeInfo.body);
    assert.deepEqual(browserCapnpBridgeInfo.json, capnpBridgeInfo.json);

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
        ...FIXTURE_GENERATED_SCHEMA_MODULES.map(([name]) => [name, "esModule", false]),
        ["sandstorm:api", "esModule", false],
        ["sandstorm-internal:capnp-runtime", "esModule", false],
        ...CAPNP_ES_SCHEME_RUNTIME_MODULES.map(([name]) => [name, "esModule", false]),
        ...CAPNP_ES_PATH_RUNTIME_MODULES.map(([name]) => [name, "esModule", false]),
        ...CAPNP_ES_SCHEME_RELATIVE_RUNTIME_MODULES.map(([name]) => [name, "esModule", false]),
      ]);

    const removedBrowserCapnpEsModule = await requestUnixSocket(
      fixture.sandstormApiSocket,
      "/capnp-es/browser-module?path=native-greeter.capnp.js");
    assert.equal(removedBrowserCapnpEsModule.statusCode, 404);

    const nativeBrowserCapnpModule = await requestUnixSocket(
      fixture.sandstormApiSocket,
      "/capnp/browser-module?path=native-greeter.capnp.js");
    assert.equal(nativeBrowserCapnpModule.statusCode, 200);
    assert.match(
      String(nativeBrowserCapnpModule.headers["content-type"] || ""),
      /text\/javascript/);
    assert.match(nativeBrowserCapnpModule.body, /export class NativeGreeter/);
    assert.match(nativeBrowserCapnpModule.body, /from "\/capnp-es\/index\.mjs"/);

    const nativeBrowserCapnpRuntime = await requestUnixSocket(
      fixture.sandstormApiSocket,
      "/capnp/browser-module?path=capnp-es%2Findex.mjs");
    assert.equal(nativeBrowserCapnpRuntime.statusCode, 200);
    assert.match(
      String(nativeBrowserCapnpRuntime.headers["content-type"] || ""),
      /text\/javascript/);
    assert.match(nativeBrowserCapnpRuntime.body, /\bMessage\b/);

    const servedNativeBrowserCapnpModule = await requestUnixSocket(
      fixture.workerdSocket, "/__sandstorm/capnp/native-greeter.capnp.js");
    assert.equal(servedNativeBrowserCapnpModule.statusCode, 200);
    assert.match(servedNativeBrowserCapnpModule.body, /export class NativeGreeter/);
    assert.match(
      servedNativeBrowserCapnpModule.body,
      /from "\/__sandstorm\/capnp\/sandstorm\/grain\.capnp"/);
    assert.doesNotMatch(servedNativeBrowserCapnpModule.body, /from "\/sandstorm\//);

    const servedNativeBridgeSchemaModule = await requestUnixSocket(
      fixture.workerdSocket,
      "/__sandstorm/capnp/sandstorm/isolate-native-capnp-bridge.capnp.js");
    assert.equal(servedNativeBridgeSchemaModule.statusCode, 404);

    const servedNativeSchemaDependency = await requestUnixSocket(
      fixture.workerdSocket, "/__sandstorm/capnp/sandstorm/grain.capnp");
    assert.equal(servedNativeSchemaDependency.statusCode, 200);
    assert.match(servedNativeSchemaDependency.body, /export class UiView/);

    const servedNativeBrowserCapnpRuntime = await requestUnixSocket(
      fixture.workerdSocket, "/capnp-es/index.mjs");
    assert.equal(servedNativeBrowserCapnpRuntime.statusCode, 200);
    assert.match(servedNativeBrowserCapnpRuntime.body, /\bMessage\b/);

    const browserRpcClient = await requestUnixSocket(
      fixture.workerdSocket, "/__sandstorm/rpc-client.js");
    assert.equal(browserRpcClient.statusCode, 404);

    const browserNativeCapnpClient = await requestUnixSocket(
      fixture.workerdSocket, "/__sandstorm/native-capnp/client.js");
    assert.equal(browserNativeCapnpClient.statusCode, 200);
    assert.match(browserNativeCapnpClient.body, /connectBrowserNativeCapnp/);
    assert.match(browserNativeCapnpClient.body, /BrowserIsolateBridge/);
    assert.match(browserNativeCapnpClient.body, /getHandoffCapability/);
    assert.match(browserNativeCapnpClient.body, /claimPowerboxRequest/);
    assert.match(browserNativeCapnpClient.body, /BrowserNativeCapnpBridgeWebSocketTransport/);
    assert.match(browserNativeCapnpClient.body, /__sandstorm\/native-capnp\/rpc-session/);
    assert.match(browserNativeCapnpClient.body, /searchParams\.set\("bootstrap", "browser"\)/);
    assert.match(browserNativeCapnpClient.body, /nativeCapnpPowerboxDescriptor/);
    assert.match(browserNativeCapnpClient.body, /inspectPowerboxQuery/);
    assert.match(browserNativeCapnpClient.body, /requestBrowserNativeCapnp/);
    assert.match(browserNativeCapnpClient.body, /claimBrowserNativeCapnpToken/);
    assert.match(browserNativeCapnpClient.body, /from "\/capnp-es\/index\.mjs"/);
    assert.doesNotMatch(browserNativeCapnpClient.body, /isolate-native-capnp-bridge/);
    assert.doesNotMatch(browserNativeCapnpClient.body, /nativeCapnpBridgeLifecycle/);
    assert.doesNotMatch(browserNativeCapnpClient.body, /\/__sandstorm\/powerbox\/claim/);

    const browserNativeCapnpRpcSession = await requestJson(
      fixture.workerdSocket,
      "/__sandstorm/native-capnp/rpc-session?bootstrap=browser&connectionId=test");
    assert.equal(browserNativeCapnpRpcSession.statusCode, 426);
    assert.equal(browserNativeCapnpRpcSession.json.ok, false);
    assert.match(browserNativeCapnpRpcSession.json.error, /WebSocket upgrade/);

    const browserProxy = await startUnixSocketHttpProxy(fixture.workerdSocket);
    const browserModuleDir =
      await fs.mkdtemp(path.join(fixture.workdir, "browser-native-capnp-"));
    const hadLocation = Object.hasOwn(globalThis, "location");
    const previousLocation = globalThis.location;
    const hadWebSocket = Object.hasOwn(globalThis, "WebSocket");
    const previousWebSocket = globalThis.WebSocket;
    const BrowserWebSocket = makeUnixSocketWebSocket(fixture.sandstormApiSocket, {
      rewritePath(pathAndQuery) {
        return pathAndQuery.replace(
          /^\/__sandstorm\/native-capnp\/rpc-session\b/,
          "/capnp/rpc-session");
      },
      headers: {
        "X-Sandstorm-Session-Id": "missing-browser-native-capnp-session",
      },
    });
    try {
      Object.defineProperty(globalThis, "location", {
        value: new URL(`${browserProxy.baseUrl}/`),
        configurable: true,
      });
      Object.defineProperty(globalThis, "WebSocket", {
        value: BrowserWebSocket,
        configurable: true,
      });
      const browserNativeCapnp = await withTimeout(importServedBrowserModule(
        browserProxy.baseUrl,
        browserModuleDir,
        "/__sandstorm/native-capnp/client.js"), 5000,
        "browser native Cap'n Proto client module import timed out");
      const browserRpcUrl =
        browserNativeCapnp.browserNativeCapnpRpcSessionUrl("browser-native-capnp-url-test");
      assert.equal(browserRpcUrl.searchParams.get("bootstrap"), "browser");
      assert.equal(browserRpcUrl.searchParams.get("connectionId"), "browser-native-capnp-url-test");
      assert.equal(browserRpcUrl.searchParams.has("id"), false);
      assert.equal(browserRpcUrl.searchParams.has("interfaceId"), false);
      assert.equal(browserRpcUrl.searchParams.has("interfaceName"), false);
      const browserWebSessionSchema = await withTimeout(importServedBrowserModule(
        browserProxy.baseUrl,
        browserModuleDir,
        "/__sandstorm/capnp/sandstorm/web-session.capnp.js"), 5000,
        "browser WebSession schema module import timed out");
      const browserNativeGreeterSchema = await withTimeout(importServedBrowserModule(
        browserProxy.baseUrl,
        browserModuleDir,
        "/__sandstorm/capnp/native-greeter.capnp.js"), 5000,
        "browser NativeGreeter schema module import timed out");
      await assert.rejects(
        browserNativeCapnp.claimBrowserNativeCapnpToken(
          "websession/test+token==",
          browserWebSessionSchema.WebSession,
          {
            connectionId: "browser-native-capnp-claim-missing-session",
            requiredPermissions: ["view"],
          }),
        /browser isolate bridge session ID not found/);
      const browserWebSessionCapability = await requestJson(
        fixture.workerdSocket,
        "/browser-native-web-session-capability", {
          headers: {
            "X-Sandstorm-Session-Id": "missing-browser-native-capnp-session",
          },
        });
      assert.equal(browserWebSessionCapability.statusCode, 200, browserWebSessionCapability.body);
      assert.equal(browserWebSessionCapability.json.ok, true);
      assert.equal(browserWebSessionCapability.json.capabilityClass, true);
      assert.equal(browserWebSessionCapability.json.capability.type, "capability");
      const browserLocalExportCapability = await requestJson(
        fixture.workerdSocket,
        "/browser-native-local-export-capability", {
          headers: {
            "X-Sandstorm-Session-Id": "missing-browser-native-capnp-session",
          },
        });
      assert.equal(browserLocalExportCapability.statusCode, 200,
        browserLocalExportCapability.body);
      assert.equal(browserLocalExportCapability.json.ok, true,
        browserLocalExportCapability.body);
      assert.equal(browserLocalExportCapability.json.hasBrowserHandoff, true);
      assert.equal(browserLocalExportCapability.json.capability.type, "capability");
      assert.equal(browserLocalExportCapability.json.capability.residence, "browserHandoff");
      const browserLocalExportGreeter = browserNativeCapnp.connectBrowserNativeCapnp(
        browserLocalExportCapability.json.capability,
        browserNativeGreeterSchema.NativeGreeter,
        {
          connectionId: `browser-native-capnp-${browserLocalExportCapability.json.capability.id}`,
        });
      const browserLocalExportHello = await withTimeout(browserLocalExportGreeter.hello({
        name: "browser",
      }), 5000, "browser native Cap'n Proto local export hello() timed out");
      assert.equal(
        browserLocalExportHello.message,
        "browser native local export hello browser");
      const browserWebSession = browserNativeCapnp.connectBrowserNativeCapnp({
        id: browserWebSessionCapability.json.capability.id,
        interfaceId: "0xa50711a14d35a8ce",
        interfaceName: "sandstorm.WebSession",
        kind: "receiverHosted",
      }, browserWebSessionSchema.WebSession, {
        connectionId: `browser-native-capnp-${browserWebSessionCapability.json.capability.id}`,
      });
      const browserGeneratedResponse = await withTimeout(browserWebSession.get({
        path: "/generated-client?from=browser",
        context: {},
        ignoreBody: false,
      }), 5000, "browser native Cap'n Proto WebSession.get() timed out");
      const browserGeneratedBody = browserGeneratedResponse.content.body;
      const browserGeneratedBytes =
        typeof browserGeneratedBody.bytes.toUint8Array === "function"
          ? browserGeneratedBody.bytes.toUint8Array()
          : browserGeneratedBody.bytes;
      assert.deepEqual(JSON.parse(new TextDecoder().decode(browserGeneratedBytes)), {
        ok: true,
        source: "native-capnp-generated-websession",
        method: "GET",
        pathname: "/native-capnp-bridge-target/generated-client",
        search: "?from=browser",
      });
    } finally {
      BrowserWebSocket.terminateAllForTest();
      if (hadLocation) {
        Object.defineProperty(globalThis, "location", {
          value: previousLocation,
          configurable: true,
        });
      } else {
        delete globalThis.location;
      }
      if (hadWebSocket) {
        Object.defineProperty(globalThis, "WebSocket", {
          value: previousWebSocket,
          configurable: true,
        });
      } else {
        delete globalThis.WebSocket;
      }
      await browserProxy.close();
    }

    const appInterfaceDescriptor = await requestJson(
      fixture.sandstormApiSocket,
      "/powerbox/app-interface-descriptor" +
        "?interfaceId=0xb66316217ceedb1b&interfaceName=NativeGreeter");
    assert.equal(appInterfaceDescriptor.statusCode, 200, appInterfaceDescriptor.body);
    assert.equal(appInterfaceDescriptor.json.type, "packedPowerboxDescriptor");
    assert.equal(typeof appInterfaceDescriptor.json.descriptor, "string");
    assert.match(appInterfaceDescriptor.json.descriptor, /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(appInterfaceDescriptor.json.decoded, {
      kind: "appInterface",
      interfaceId: "0xb66316217ceedb1b",
      interfaceName: "NativeGreeter",
    });

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
    assert.deepEqual(nativeInterfaceValidation.json.calls, []);
    assert.equal(nativeInterfaceValidation.json.fetchError.name, "ValidationError");
    assert.match(nativeInterfaceValidation.json.fetchError.message, /OutboundHttpSession/);
    assert.match(nativeInterfaceValidation.json.fetchError.message, /capability descriptor supplies the origin/);

    const missing = await requestJson(fixture.sandstormApiSocket, "/missing");
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json.ok, false);

    const wrongMethod = await requestJson(fixture.sandstormApiSocket, "/runtime", {
      method: "POST",
      body: "not allowed",
    });
    assert.equal(wrongMethod.statusCode, 405);
    assert.equal(wrongMethod.json.ok, false);

    const removedFetch = await requestJson(
      fixture.sandstormApiSocket,
      "/powerbox/fetch?id=missing&method=GET&path=%2F",
      { method: "POST" });
    assert.equal(removedFetch.statusCode, 405);
    assert.equal(removedFetch.json.ok, false);

    const removedOutboundFetch = await requestJson(
      fixture.sandstormApiSocket,
      "/powerbox/outbound-http-fetch?id=missing&method=GET&path=v1%2Ftest",
      { method: "POST" });
    assert.equal(removedOutboundFetch.statusCode, 405);
    assert.equal(removedOutboundFetch.json.ok, false);

    const removedWebSessionCreate = await requestJson(
      fixture.sandstormApiSocket,
      "/capabilities/web-session?pathPrefix=/removed",
      { method: "POST" });
    assert.equal(removedWebSessionCreate.statusCode, 405);
    assert.equal(removedWebSessionCreate.json.ok, false);

    const removedApiSessionCreate = await requestJson(
      fixture.sandstormApiSocket,
      "/capabilities/api-session?pathPrefix=/removed",
      { method: "POST" });
    assert.equal(removedApiSessionCreate.statusCode, 405);
    assert.equal(removedApiSessionCreate.json.ok, false);

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

    const tooLarge = await requestJson(fixture.storageSocket, "/too-large", {
      method: "PUT",
      body: Buffer.alloc(1024 * 1024 + 1),
    });
    assert.equal(tooLarge.statusCode, 413);
    assert.deepEqual(tooLarge.json, {
      ok: false,
      error: "isolate storage value exceeds maximum allowed size",
      maxBytes: 1024 * 1024,
    });

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

  await t.test("keeps storage isolated across isolate instances", async () => {
    const secondary = await startIsolateFixture();
    try {
      const primaryStorageRoot = path.join(fixture.varDir, "isolate-storage");
      const secondaryStorageRoot = path.join(secondary.varDir, "isolate-storage");
      assert.notEqual(primaryStorageRoot, secondaryStorageRoot);

      const primaryPut = await requestJson(fixture.storageSocket, "/shared-key", {
        method: "PUT",
        body: "primary grain value",
      });
      assert.equal(primaryPut.statusCode, 200, primaryPut.body);
      assert.deepEqual(primaryPut.json, { ok: true, bytes: 19 });

      const secondaryPut = await requestJson(secondary.storageSocket, "/shared-key", {
        method: "PUT",
        body: "secondary grain value",
      });
      assert.equal(secondaryPut.statusCode, 200, secondaryPut.body);
      assert.deepEqual(secondaryPut.json, { ok: true, bytes: 21 });

      const primaryGet = await requestUnixSocket(fixture.storageSocket, "/shared-key");
      assert.equal(primaryGet.statusCode, 200, primaryGet.body);
      assert.equal(primaryGet.body, "primary grain value");

      const secondaryGet = await requestUnixSocket(secondary.storageSocket, "/shared-key");
      assert.equal(secondaryGet.statusCode, 200, secondaryGet.body);
      assert.equal(secondaryGet.body, "secondary grain value");

      assert.equal(
        await fs.readFile(path.join(primaryStorageRoot, "shared-key"), "utf8"),
        "primary grain value");
      assert.equal(
        await fs.readFile(path.join(secondaryStorageRoot, "shared-key"), "utf8"),
        "secondary grain value");
    } finally {
      await secondary.cleanup();
    }
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
        "--isolate-trust-domain", "isolate-test-account",
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
