// Opt-in, test-instance-only server profiling. No TCP debugger or Meteor method is exposed.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const inspector = require("node:inspector");
const { monitorEventLoopDelay, performance } = require("node:perf_hooks");

exports.start = function (directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const socket = path.join(directory, "control.sock");
  // A restarted shell may leave a stale socket behind.
  try { fs.unlinkSync(socket); } catch (e) { if (e.code !== "ENOENT") throw e; }
  const session = new inspector.Session();
  session.connect();
  const post = (method) => new Promise((resolve, reject) => {
    session.post(method, (error, result) => error ? reject(error) : resolve(result));
  });
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  let active;
  let sequence = 0;
  async function begin(name) {
    if (active) throw new Error("A phase is already active");
    if (!/^[a-z0-9-]{1,64}$/.test(name)) throw new Error("Invalid phase name");
    await post("Profiler.start");
    delay.reset();
    active = { name, sequence: sequence++, startedAt: new Date().toISOString(),
      start: performance.now(), cpu: process.cpuUsage(), elu: performance.eventLoopUtilization() };
    return { name };
  }
  async function end() {
    if (!active) throw new Error("No active phase");
    const phase = active;
    const durationMs = performance.now() - phase.start;
    const cpu = process.cpuUsage(phase.cpu);
    const elu = performance.eventLoopUtilization(phase.elu);
    const { profile } = await post("Profiler.stop");
    const stem = `${process.pid}-${String(phase.sequence).padStart(3, "0")}-${phase.name}`;
    fs.writeFileSync(path.join(directory, stem + ".cpuprofile"), JSON.stringify(profile));
    const result = { name: phase.name, startedAt: phase.startedAt, durationMs,
      cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000,
      eventLoopUtilization: elu.utilization, eventLoopDelayMaxMs: delay.max / 1e6,
      memory: process.memoryUsage(), resourceUsage: process.resourceUsage(), profile: stem + ".cpuprofile" };
    fs.writeFileSync(path.join(directory, stem + ".json"), JSON.stringify(result, null, 2));
    active = null;
    return result;
  }
  // Serialize commands, including startup initialization, and report failures to the controller.
  let queue = post("Profiler.enable").then(() => begin("startup"));
  const server = http.createServer((req, res) => {
    const operation = async () => {
      try {
        if (req.method !== "POST") throw new Error("Use POST");
        const url = new URL(req.url, "http://localhost");
        let result;
        if (url.pathname === "/stop") result = await end();
        else if (url.pathname === "/start") result = await begin(url.searchParams.get("name") || "");
        else throw new Error("Unknown operation");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(400); res.end(JSON.stringify({ error: error.message }));
      }
    };
    queue = queue.then(operation);
  });
  queue.then(() => server.listen(socket, () => fs.chmodSync(socket, 0o600)))
    .catch(error => { console.error("Server profiler failed", error); process.exitCode = 1; });
  server.unref();
  return { server, session, delay, ready: queue };
};
