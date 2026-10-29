#!/usr/bin/env node

import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const capnpEsDir = process.env.CAPNP_ES_DIR || path.join(repoRoot, "shell/node_modules/capnp-es");
const tsCompiler = process.env.CAPNP_ES_COMPILER ||
  path.join(capnpEsDir, "dist/compiler/capnpc-ts.mjs");
const outputs = [
  {
    compiler: tsCompiler,
    cwd: repoRoot,
    extension: ".ts",
    importPath: "src",
    outDir: path.join(repoRoot, "shell/imports/server/capnp-es/generated"),
    sources: [
      ...findCapnpFiles(path.join(repoRoot, "src/sandstorm")),
    ],
    srcPrefix: "src",
    stripLocalJsExtensions: true,
  },
];

for (const output of outputs) {
  generate(output);
}

function generate({
  compiler,
  cwd,
  extension,
  importPath,
  outDir,
  sources,
  srcPrefix,
  stripLocalJsExtensions,
}) {
  const parent = path.dirname(outDir);
  fs.mkdirSync(parent, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(parent, ".capnp-es-"));
  const staged = path.join(temporary, "generated");
  const previous = path.join(temporary, "previous");
  fs.mkdirSync(staged);
  try {
    const result = childProcess.spawnSync(
      process.env.CAPNP || "capnp",
      [
        "compile",
        `-o${compiler}:${staged}`,
        `--src-prefix=${srcPrefix}`,
        `-I${importPath}`,
        ...sources,
      ],
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ""}` },
      },
    );

    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`capnp-es compiler failed (${result.signal || result.status})`);
    }

    for (const file of walk(staged)) {
      if (!file.endsWith(extension)) continue;
      const before = fs.readFileSync(file, "utf8");
      let normalized = before;

      if (stripLocalJsExtensions) {
        normalized = normalized.replace(/from "(\.{1,2}\/[^"]+)\.js"/g, 'from "$1"');
      }

      const after = extension === ".ts" && !normalized.startsWith("// @ts-nocheck\n")
        ? `// @ts-nocheck\n${normalized}`
        : normalized;
      if (after !== before) fs.writeFileSync(file, after);
    }

    const hadPrevious = fs.existsSync(outDir);
    if (hadPrevious) fs.renameSync(outDir, previous);
    try {
      fs.renameSync(staged, outDir);
    } catch (error) {
      if (hadPrevious) fs.renameSync(previous, outDir);
      throw error;
    }
  } finally {
    // Preserve the backup if restoring it failed, rather than deleting the
    // caller's last successful bindings along with temporary output.
    if (!fs.existsSync(previous) || fs.existsSync(outDir)) {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
}

function findCapnpFiles(dir) {
  return walk(dir).filter((file) => file.endsWith(".capnp")).sort();
}

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}
