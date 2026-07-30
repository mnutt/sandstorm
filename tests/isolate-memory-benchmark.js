// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2026 Sandstorm contributors
// Licensed under the Apache License, Version 2.0.

"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");

const REPO_DIR = path.resolve(__dirname, "..");
const TMP_DIR = path.join(REPO_DIR, "tmp");
const HOST_BIN = process.env.ISOLATE_HOST_BIN || path.join(REPO_DIR, "bin/isolate-host");
const CLIENT_BIN = process.env.ISOLATE_MEMORY_CLIENT ||
  path.join(REPO_DIR, "tmp/sandstorm/isolate-host-memory-client");

function parsePositiveInteger(value, option) {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`invalid ${option}: ${value}`);
  return Number(value);
}

function parseArgs(argv) {
  const options = {
    counts: [0, 1, 2, 4, 8, 16, 32],
    repeats: 5,
    samples: 5,
    sampleIntervalMs: 100,
    settleMs: 500,
  };
  for (let i = 0; i < argv.length; ++i) {
    const option = argv[i];
    const value = argv[++i];
    if (value === undefined) throw new Error(`missing value for ${option}`);
    if (option === "--counts") {
      options.counts = value.split(",").map((part) => {
        if (!/^(0|[1-9][0-9]*)$/.test(part)) throw new Error(`invalid worker count: ${part}`);
        return Number(part);
      });
      if (options.counts.length === 0 || options.counts.some((count) => count > 256)) {
        throw new Error("worker counts must be between 0 and 256");
      }
    } else if (option === "--repeats") {
      options.repeats = parsePositiveInteger(value, option);
    } else if (option === "--samples") {
      options.samples = parsePositiveInteger(value, option);
    } else if (option === "--sample-interval-ms") {
      options.sampleIntervalMs = parsePositiveInteger(value, option);
    } else if (option === "--settle-ms") {
      options.settleMs = parsePositiveInteger(value, option);
    } else {
      throw new Error(`unknown option: ${option}`);
    }
  }
  return options;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForSocket(socketPath, child) {
  for (let attempt = 0; attempt < 800; ++attempt) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`host exited before listening (${child.exitCode || child.signalCode}): ` +
        child.diagnostics);
    }
    try {
      if ((await fs.stat(socketPath)).isSocket()) return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await sleep(25);
  }
  throw new Error(`timed out waiting for host socket: ${socketPath}`);
}

function spawnHost(socketPath) {
  const child = spawn(HOST_BIN, [socketPath], { stdio: ["ignore", "ignore", "pipe"] });
  child.diagnostics = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    child.diagnostics = (child.diagnostics + chunk).slice(-16384);
  });
  return child;
}

async function spawnClient(socketPath, workerCount) {
  const child = spawn(CLIENT_BIN, [socketPath, String(workerCount)],
      { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let diagnostics = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { diagnostics = (diagnostics + chunk).slice(-16384); });

  await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      stdout += chunk;
      if (stdout.includes("READY\n")) {
        child.stdout.off("data", onData);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.once("exit", (code, signal) => {
      reject(new Error(`benchmark client exited before ready (${code || signal}): ${diagnostics}`));
    });
    child.once("error", reject);
  });
  child.diagnostics = () => diagnostics;
  return child;
}

async function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(timeoutMs).then(() => { throw new Error("child process did not exit"); }),
  ]);
}

async function stopClient(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin.end();
  try {
    await waitForExit(child);
  } catch (error) {
    child.kill("SIGKILL");
    await waitForExit(child);
    throw new Error(`${error.message}: ${child.diagnostics()}`);
  }
  if (child.exitCode !== 0) {
    throw new Error(`benchmark client failed (${child.exitCode}): ${child.diagnostics()}`);
  }
}

async function stopHost(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  try {
    await waitForExit(child);
  } catch (_) {
    child.kill("SIGKILL");
    await waitForExit(child);
  }
}

async function readPssKib(pid) {
  const smaps = await fs.readFile(`/proc/${pid}/smaps_rollup`, "utf8");
  const match = /^Pss:\s+([0-9]+) kB$/m.exec(smaps);
  if (match === null) throw new Error(`Pss missing from /proc/${pid}/smaps_rollup`);
  return Number(match[1]);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

async function samplePss(hosts, options) {
  await sleep(options.settleMs);
  const samples = [];
  for (let sample = 0; sample < options.samples; ++sample) {
    samples.push((await Promise.all(hosts.map((host) => readPssKib(host.pid))))
        .reduce((sum, value) => sum + value, 0));
    if (sample + 1 < options.samples) await sleep(options.sampleIntervalMs);
  }
  return median(samples);
}

async function measureShared(root, workerCount, options) {
  const socketPath = path.join(root, "shared.sock");
  const host = spawnHost(socketPath);
  let client;
  try {
    await waitForSocket(socketPath, host);
    if (workerCount > 0) client = await spawnClient(socketPath, workerCount);
    return await samplePss([host], options);
  } finally {
    if (client !== undefined) await stopClient(client);
    await stopHost(host);
    await fs.rm(socketPath, { force: true });
  }
}

async function measureIsolated(root, workerCount, options) {
  if (workerCount === 0) return 0;
  const sockets = Array.from({ length: workerCount }, (_, index) =>
    path.join(root, `isolated-${index}.sock`));
  const hosts = sockets.map(spawnHost);
  const clients = [];
  try {
    await Promise.all(sockets.map((socket, index) => waitForSocket(socket, hosts[index])));
    clients.push(...await Promise.all(sockets.map((socket) => spawnClient(socket, 1))));
    return await samplePss(hosts, options);
  } finally {
    await Promise.all(clients.map(stopClient));
    await Promise.all(hosts.map(stopHost));
    await Promise.all(sockets.map((socket) => fs.rm(socket, { force: true })));
  }
}

function regress(points) {
  const xMean = points.reduce((sum, point) => sum + point.workers, 0) / points.length;
  const yMean = points.reduce((sum, point) => sum + point.pssKib, 0) / points.length;
  const numerator = points.reduce((sum, point) =>
    sum + (point.workers - xMean) * (point.pssKib - yMean), 0);
  const denominator = points.reduce((sum, point) =>
    sum + (point.workers - xMean) ** 2, 0);
  const slope = numerator / denominator;
  const intercept = yMean - slope * xMean;
  const residual = points.reduce((sum, point) =>
    sum + (point.pssKib - intercept - slope * point.workers) ** 2, 0);
  const total = points.reduce((sum, point) => sum + (point.pssKib - yMean) ** 2, 0);
  return { slope, intercept, rSquared: total === 0 ? 1 : 1 - residual / total };
}

async function main() {
  if (process.platform !== "linux") throw new Error("PSS benchmark requires Linux /proc");
  const options = parseArgs(process.argv.slice(2));
  const root = path.join(TMP_DIR, `isolate-memory-benchmark-${process.pid}`);
  const rows = [];
  await fs.mkdir(root, { recursive: true });
  try {
    for (let repeat = 1; repeat <= options.repeats; ++repeat) {
      for (const workerCount of options.counts) {
        const shared = await measureShared(root, workerCount, options);
        rows.push({ topology: "shared", workers: workerCount, repeat, pssKib: shared });
        process.stderr.write(`shared workers=${workerCount} repeat=${repeat}: ${shared} KiB PSS\n`);

        const isolated = await measureIsolated(root, workerCount, options);
        rows.push({ topology: "one-worker-processes", workers: workerCount,
          repeat, pssKib: isolated });
        process.stderr.write(
            `one-worker-processes workers=${workerCount} repeat=${repeat}: ${isolated} KiB PSS\n`);
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }

  process.stdout.write("topology,workers,repeat,pss_kib\n");
  for (const row of rows) {
    process.stdout.write(`${row.topology},${row.workers},${row.repeat},${row.pssKib}\n`);
  }

  for (const topology of ["shared", "one-worker-processes"]) {
    const points = options.counts.map((workers) => ({
      workers,
      pssKib: median(rows.filter((row) => row.topology === topology && row.workers === workers)
          .map((row) => row.pssKib)),
    }));
    const fit = regress(points);
    process.stderr.write(`# ${topology}: slope_kib=${fit.slope.toFixed(2)},` +
      ` intercept_kib=${fit.intercept.toFixed(2)},r_squared=${fit.rSquared.toFixed(6)}\n`);
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
