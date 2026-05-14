#!/usr/bin/env node

import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const capnpEsDir = process.env.CAPNP_ES_DIR || path.join(process.env.HOME, "p/personal/capnp-es");
const tsCompiler = process.env.CAPNP_ES_COMPILER ||
  path.join(capnpEsDir, "dist/compiler/capnpc-ts.mjs");
const outputs = [
  {
    compiler: tsCompiler,
    cwd: repoRoot,
    extension: ".ts",
    importPath: "src",
    language: "ts",
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
  language,
  outDir,
  sources,
  srcPrefix,
  stripLocalJsExtensions,
}) {
  fs.rmSync(outDir, { force: true, recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  const result = childProcess.spawnSync(
    process.execPath,
    [
      compiler,
      `-o${language}:${outDir}`,
      `--src-prefix=${srcPrefix}`,
      `-I${importPath}`,
      ...sources,
    ],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) process.exit(result.status ?? 1);

  for (const file of walk(outDir)) {
    if (!file.endsWith(extension)) continue;
    const before = fs.readFileSync(file, "utf8");
    let normalized = before
      .replace(/from "capnp-es\/capnp\/([^"]+)"/g, 'from "capnp-es/dist/capnp/$1.mjs"');

    if (stripLocalJsExtensions) {
      normalized = normalized.replace(/from "(\.{1,2}\/[^"]+)\.js"/g, 'from "$1"');
    }

    const after = extension === ".ts" && !normalized.startsWith("// @ts-nocheck\n")
      ? `// @ts-nocheck\n${normalized}`
      : normalized;
    if (after !== before) fs.writeFileSync(file, after);
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
