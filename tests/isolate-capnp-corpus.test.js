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
const { pathToFileURL } = require("node:url");

const REPO_DIR = path.resolve(__dirname, "..");
const REPO_TMP_DIR = path.join(REPO_DIR, "tmp");
const CAPNP_BIN = process.env.CAPNP_BIN || path.join(REPO_DIR, "tmp/capnp/compiler/capnp");
const CAPNP_ES_COMPILER_MODULE = process.env.CAPNP_ES_COMPILER_MODULE ||
  path.join(REPO_DIR,
    "tmp/capnp-es-npm/node_modules/@mnutt/capnp-es/dist/compiler/index.mjs");
const CAPNP_ES_DIST_DIR = path.dirname(path.dirname(CAPNP_ES_COMPILER_MODULE));
const CORPUS_SCHEMA = "tests/capnp-corpus/corpus.capnp";

async function requireFile(filePath, message) {
  try {
    await fs.access(filePath, constants.R_OK);
  } catch (_) {
    throw new Error(message);
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || REPO_DIR,
      stdio: ["pipe", "pipe", "pipe"],
      env: options.env || process.env,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) {
        resolve(result);
      } else {
        const renderedArgs = args.map((arg) => JSON.stringify(arg)).join(" ");
        reject(new Error(
          `${command} ${renderedArgs} failed with ${signal || code}\n${result.stderr}`));
      }
    });
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

function capnpEsRuntimeSpecifier(originalSpecifier) {
  if (originalSpecifier === "@mnutt/capnp-es") {
    return pathToFileURL(path.join(CAPNP_ES_DIST_DIR, "index.mjs")).href;
  }

  const prefix = "@mnutt/capnp-es/";
  if (originalSpecifier.startsWith(prefix)) {
    const relative = originalSpecifier.slice(prefix.length);
    return pathToFileURL(path.join(
      CAPNP_ES_DIST_DIR, relative + (relative.endsWith(".mjs") ? "" : ".mjs"))).href;
  }

  return originalSpecifier;
}

async function compileCorpusModule(t) {
  await requireFile(CAPNP_BIN, "Build capnp first, e.g. make tmp/.ekam-run.");
  await requireFile(
    CAPNP_ES_COMPILER_MODULE,
    "Install capnp-es first, e.g. make tmp/.capnp-es-npm.");

  const outputDir = await fs.mkdtemp(path.join(REPO_TMP_DIR, "isolate-capnp-corpus-"));
  t.after(async () => {
    await fs.rm(outputDir, { recursive: true, force: true });
  });

  const codegen = await runCommand(CAPNP_BIN, [
    "compile",
    "-o-",
    "-Itests",
    CORPUS_SCHEMA,
  ]);
  const { compileAll } = await import(pathToFileURL(CAPNP_ES_COMPILER_MODULE).href);
  const { files } = await compileAll(codegen.stdout, {
    js: true,
    dts: true,
    tsconfig: { noCheck: true },
    moduleSpecifier(context) {
      if (context.kind === "runtime") {
        return capnpEsRuntimeSpecifier(context.originalSpecifier);
      }
      return context.originalSpecifier;
    },
  });

  for (const [name, content] of files) {
    const outputPath = path.join(outputDir, name);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, content);
  }

  const declaration = await fs.readFile(
    path.join(outputDir, CORPUS_SCHEMA.replace(/\.capnp$/, ".d.ts")), "utf8");
  assert.match(declaration, /static _applyInit\(/);

  const generated = await import(pathToFileURL(
    path.join(outputDir, CORPUS_SCHEMA.replace(/\.capnp$/, ".js"))).href);
  const runtime = await import(pathToFileURL(path.join(CAPNP_ES_DIST_DIR, "index.mjs")).href);
  return { ...generated, CapnpEsMessage: runtime.Message };
}

function bytesOf(value) {
  if (!value) return [];
  if (typeof value.toUint8Array === "function") {
    return Array.from(value.toUint8Array());
  }
  return Array.from(value);
}

function listOf(value) {
  if (!value) return [];
  if (typeof value.get === "function" && Number.isInteger(value.length)) {
    return Array.from({ length: value.length }, (_, index) => value.get(index));
  }
  return Array.from(value);
}

function normalizeCapnpEsRecord(record) {
  return {
    title: record.title,
    payload: bytesOf(record.payload),
    count: record.count.toString(),
    offset: record.offset,
    enabled: record.enabled,
    numbers: listOf(record.numbers),
    child: {
      label: record.child.label,
      score: record.child.score,
    },
    flavor: ["alpha", "beta", "gamma"][record.flavor],
  };
}

function normalizeFixture(fixture) {
  return {
    ...fixture,
    count: BigInt(fixture.count).toString(),
  };
}

function initCorpusRecord(CorpusRecord, CapnpEsMessage, fixture) {
  const message = new CapnpEsMessage();
  const record = message.initRoot(CorpusRecord);
  CorpusRecord._applyInit(record, {
    ...fixture,
    count: BigInt(fixture.count),
    flavor: CorpusRecord.Flavor[fixture.flavor.toUpperCase()],
  });
  return message.toUint8Array();
}

function readCorpusRecord(CorpusRecord, CapnpEsMessage, bytes) {
  return new CapnpEsMessage(bytes, false).getRoot(CorpusRecord);
}

async function kjDecode(bytes) {
  const result = await runCommand(CAPNP_BIN, [
    "convert",
    "-Itests",
    "binary:json",
    CORPUS_SCHEMA,
    "CorpusRecord",
  ], { input: Buffer.from(bytes) });
  return JSON.parse(result.stdout.toString("utf8"));
}

async function kjEncode(json) {
  const result = await runCommand(CAPNP_BIN, [
    "convert",
    "-Itests",
    "json:binary",
    CORPUS_SCHEMA,
    "CorpusRecord",
  ], { input: Buffer.from(`${JSON.stringify(json)}\n`, "utf8") });
  return result.stdout;
}

const BASE_CORPUS = Object.freeze([
  {
    title: "empty-ish",
    payload: [],
    count: "0",
    offset: 0,
    enabled: false,
    numbers: [],
    child: { label: "", score: 0 },
    flavor: "alpha",
  },
  {
    title: "small",
    payload: [1, 2, 3, 255],
    count: "42",
    offset: -7,
    enabled: true,
    numbers: [1, 2, 3, 65535],
    child: { label: "child", score: 9 },
    flavor: "beta",
  },
  {
    title: "large-ish",
    payload: Array.from({ length: 257 }, (_, index) => (index * 17) & 0xff),
    count: "9007199254740991",
    offset: -2147483648,
    enabled: true,
    numbers: Array.from({ length: 64 }, (_, index) => (index * 8191) >>> 0),
    child: { label: "nested value", score: 65535 },
    flavor: "gamma",
  },
]);

function generatedCorpusCases() {
  const count = Number.parseInt(process.env.ISOLATE_CAPNP_CORPUS_EXTRA_CASES || "0", 10);
  if (!Number.isInteger(count) || count <= 0) return [];

  let state = 0x12345678;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };

  return Array.from({ length: count }, (_, index) => {
    const payloadLength = next() % 1024;
    const numbersLength = next() % 128;
    return {
      title: `generated-${index}`,
      payload: Array.from({ length: payloadLength }, () => next() & 0xff),
      count: String(next()),
      offset: (next() | 0),
      enabled: (next() & 1) === 1,
      numbers: Array.from({ length: numbersLength }, () => next()),
      child: {
        label: `child-${next().toString(16)}`,
        score: next() & 0xffff,
      },
      flavor: ["alpha", "beta", "gamma"][next() % 3],
    };
  });
}

test("capnp-es corpus encodes bytes that KJ decodes", async (t) => {
  const { CorpusRecord, CapnpEsMessage } = await compileCorpusModule(t);
  for (const fixture of [...BASE_CORPUS, ...generatedCorpusCases()]) {
    const bytes = initCorpusRecord(CorpusRecord, CapnpEsMessage, fixture);
    const decoded = await kjDecode(bytes);
    assert.deepEqual(decoded, normalizeFixture(fixture));
  }
});

test("KJ corpus bytes decode through capnp-es", async (t) => {
  const { CorpusRecord, CapnpEsMessage } = await compileCorpusModule(t);
  for (const fixture of [...BASE_CORPUS, ...generatedCorpusCases()]) {
    const bytes = await kjEncode(normalizeFixture(fixture));
    const decoded = normalizeCapnpEsRecord(readCorpusRecord(CorpusRecord, CapnpEsMessage, bytes));
    assert.deepEqual(decoded, normalizeFixture(fixture));
  }
});
