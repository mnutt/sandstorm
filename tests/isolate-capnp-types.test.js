// Compile-time and runtime namespace contracts for the public isolate Cap'n Proto API.
"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const REPO_DIR = path.resolve(__dirname, "..");
const CAPNP_BIN = path.join(REPO_DIR, "tmp/capnp/compiler/capnp");
const COMPILER = path.join(
  REPO_DIR, "tmp/capnp-es-npm/node_modules/@mnutt/capnp-es/dist/compiler/index.mjs");
const CAPNP_ES_TYPES = path.join(
  REPO_DIR, "tmp/capnp-es-npm/node_modules/@mnutt/capnp-es/dist/index.d.mts");
const TSC = path.join(
  REPO_DIR, "tmp/capnp-es-npm/node_modules/typescript/bin/tsc");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || REPO_DIR,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const result = {
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) resolve(result);
      else reject(new Error(
        `${command} exited ${code}\n${result.stdout.toString("utf8")}${result.stderr}`));
    });
    child.stdin.end(options.input);
  });
}

async function readable(file) {
  try {
    await fs.access(file);
    return true;
  } catch (_) {
    return false;
  }
}

test("sandstorm:api exports exactly the intended public Cap'n Proto values", async () => {
  const names = [
    "CapnpUnavailableError",
    "byteStreamFromWritable",
    "capnpClient",
    "createCapnpStruct",
    "exportCapnp",
    "pipeReadableToByteStream",
    "readCapnpStruct",
    "writableFromByteStream",
  ];
  const source = await fs.readFile(
    path.join(REPO_DIR, "src/sandstorm/isolate/api.js"), "utf8");
  const match = source.match(
    /export\s*\{([^}]*)\}\s*from\s*"sandstorm-internal:capnp-runtime";/);
  assert.ok(match, "sandstorm:api must re-export Cap'n Proto helpers from the internal runtime");
  const exportedNames = match[1].split(",").map((name) => name.trim()).filter(Boolean);
  assert.deepEqual(exportedNames.sort(), names.sort());
  assert.match(source, /export function defineWorker\s*\(/);
  assert.match(source, /export function serveCapnp\s*\(/);
  assert.match(source, /export function mainViewFromFetch\s*\(/);
});

test("generated Cap'n Proto types enforce the Sandstorm API contract", async (t) => {
  if (!await readable(CAPNP_BIN) || !await readable(COMPILER) ||
      !await readable(CAPNP_ES_TYPES) || !await readable(TSC)) {
    t.skip("Cap'n Proto and TypeScript toolchains are not built");
    return;
  }

  const temp = await fs.mkdtemp(path.join(REPO_DIR, "tmp/isolate-capnp-types-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const schemaPath = path.join(temp, "contract.capnp");
  await fs.writeFile(schemaPath, `@0xc7f3d7bb24ba84e1;
struct Profile {
  name @0 :Text;
  count @1 :UInt32;
}
interface Collision {
  save @0 (value :Text) -> (value :Text);
  drop @1 () -> (value :Text);
  info @2 () -> (value :Text);
}
`);
  const codegen = await run(CAPNP_BIN, ["compile", "-o-", schemaPath]);
  const { compileAll } = await import(pathToFileURL(COMPILER).href);
  const { files } = await compileAll(codegen.stdout, {
    dts: true,
    tsconfig: { noCheck: true },
  });
  for (const [name, content] of files) {
    const output = path.join(temp, path.basename(name));
    await fs.writeFile(output, content);
  }
  await fs.copyFile(path.join(REPO_DIR, "src/sandstorm/isolate/api.d.ts"),
    path.join(temp, "api.d.ts"));
  await fs.copyFile(path.join(REPO_DIR, "src/sandstorm/isolate/capnp.d.ts"),
    path.join(temp, "capnp.d.ts"));
  await fs.writeFile(path.join(temp, "usage.ts"), `
import { Collision, Profile } from "./contract.js";
import {
  capnpClient,
  createCapnpStruct,
  defineWorker,
  exportCapnp,
  mainViewFromFetch,
  pipeReadableToByteStream,
  serveCapnp,
} from "sandstorm:api";
import type {
  ByteStreamClient,
  Capability,
  SandstormApi,
  ServerTargetFor,
  WorkerCapnpServerTargetFor,
} from "sandstorm:api";
// @ts-expect-error internal bridge exports are not public
import { connectIsolateBridge } from "sandstorm:api";

declare const api: SandstormApi;
declare const capability: Capability;
declare const readable: ReadableStream<Uint8Array>;
declare const byteStream: ByteStreamClient;
declare const token: string;

const piped: Promise<void> = pipeReadableToByteStream(readable, byteStream, { size: 4n });

const client = capnpClient(Collision, capability);
client.save({ value: "save" });
client.drop();
client.info();
// @ts-expect-error an ID-shaped object is not live authority
capnpClient(Collision, { id: "forged" });

const target: ServerTargetFor<typeof Collision> = {
  save: async ({ value }) => ({ value }),
  drop: async () => ({ value: "drop" }),
  info: async () => ({ value: "info" }),
};
const exported = await exportCapnp(api, Collision, target);
exported.client.save({ value: "still callable" });
exported.client.drop();
exported.client.info();
const saved: string = await exported.save({ label: "Collision" });
const savedCapability: string = await capability.save({ label: "Collision" });
const restored: Promise<Capability> = api.restore(token);
const revoked: Promise<{ ok: true }> = api.revoke(saved);
const descriptor: Promise<string> = api.powerbox().appInterfaceDescriptor(Collision);
// @ts-expect-error durable tokens are strings, not byte arrays
api.restore(new Uint8Array());
void savedCapability;
void piped;
void descriptor;
void restored;
void revoked;

const workerTarget: WorkerCapnpServerTargetFor<typeof Collision> = {
  save: async ({ value }, { env, ctx, signal }) => {
    ctx.waitUntil(env.STORAGE.fetch("http://storage/capnp-call").then(() => undefined));
    const canceled: boolean = signal.aborted;
    void canceled;
    return { value };
  },
  drop: async (_params, _context, results) => {
    results.value = "drop";
  },
  info: async () => ({ value: "info" }),
};
const worker = defineWorker({
  capabilities: {
    collision: serveCapnp(Collision, workerTarget, {
      restore: async (_objectId, { signal }) => {
        const canceled: boolean = signal.aborted;
        void canceled;
        return workerTarget;
      },
      drop: async (_objectId, { env }) => {
        await env.STORAGE.fetch("http://storage/drop");
      },
    }),
    ui: mainViewFromFetch({
      viewInfo: { appTitle: { defaultText: "Typed UI" } },
      fetch: async () => new Response("ok"),
    }),
  },
  async fetch(_request, env, ctx) {
    ctx.waitUntil(env.STORAGE.fetch("http://storage/fetch").then(() => undefined));
    return new Response("ok");
  },
});
void worker;
// @ts-expect-error worker capabilities must be opaque serveCapnp() declarations
defineWorker({ capabilities: { collision: { interface: Collision, target: workerTarget } } });
// @ts-expect-error worker target context is not a generated results builder
serveCapnp(Collision, { ...workerTarget, save: async (_params, { value }) => ({ value }) });
// @ts-expect-error durable exports require both lifecycle functions
serveCapnp(Collision, workerTarget, { restore: async () => workerTarget });
// @ts-expect-error restore must produce a generated server target
serveCapnp(Collision, workerTarget, { restore: async () => ({}), drop: async () => undefined });

// @ts-expect-error generated server target requires every method
exportCapnp(api, Collision, { save: target.save });
// @ts-expect-error misspelled generated server method
exportCapnp(api, Collision, { ...target, infro: target.info, info: undefined });

createCapnpStruct(Profile, { name: "Ada", count: 1 });
// @ts-expect-error generated struct initializer rejects unknown fields
createCapnpStruct(Profile, { name: "Ada", count: 1, unknown: true });
`);
  await fs.writeFile(path.join(temp, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      lib: ["ES2022", "WebWorker"],
      module: "ESNext",
      moduleResolution: "Bundler",
      noEmit: true,
      paths: {
        "@mnutt/capnp-es": [CAPNP_ES_TYPES],
      },
      skipLibCheck: true,
      strict: true,
      target: "ES2022",
    },
    include: ["*.d.ts", "*.ts"],
  }));
  await run(TSC, ["--project", path.join(temp, "tsconfig.json")], { cwd: temp });
});
