"use strict";
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { execFileSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const output = process.env.E2E_PROFILE_OUTPUT;
const socketPath = process.env.E2E_PROFILE_SOCKET;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function control(url) {
  if (!socketPath) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: url, method: "POST", timeout: 30000 }, res => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => res.statusCode === 200 ? resolve(JSON.parse(body)) : reject(new Error(body)));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Profiler control timeout")));
    req.end();
  });
}
async function phase(name, task) {
  await control("/start?name=" + name);
  const monotonicStartNs = process.hrtime.bigint().toString();
  const startedAt = new Date().toISOString();
  const start = performance.now();
  let status = "failed";
  try {
    await task();
    status = "passed";
  } finally {
    const durationMs = performance.now() - start;
    const server = await control("/stop");
    fs.appendFileSync(path.join(output, "phases.jsonl"), JSON.stringify({ name, status, startedAt, monotonicStartNs, durationMs,
      bytes: ["upload", "download"].includes(name) ? 50000000 : undefined,
      megabytesPerSecond: ["upload", "download"].includes(name) ? 50000 / durationMs : undefined,
      server }) + "\n");
    fs.appendFileSync(path.join(output, "processes.txt"), `\n${name}\n` +
      execFileSync("ps", ["-eo", "pid,ppid,lstart,comm,args"], { encoding: "utf8" }));
  }
}

module.exports = { phase, control };
