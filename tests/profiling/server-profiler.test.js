"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { start } = require("../../server-profiler");

test("captures startup and named phases, rejects overlap and traversal, closes profiles explicitly", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sandstorm-profiler-test-"));
  const profiler = start(directory);
  try {
    await profiler.ready;
    if (!profiler.server.listening) {
      await new Promise(resolve => profiler.server.once("listening", resolve));
    }
    const call = endpoint => new Promise((resolve, reject) => {
      const req = http.request({ socketPath: path.join(directory, "control.sock"),
        method: "POST", path: endpoint }, res => {
        let data = "";
        res.on("data", chunk => data += chunk);
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      });
      req.on("error", reject); req.end();
    });
    assert.equal((await call("/start?name=overlap")).status, 400);
    const startup = await call("/stop");
    assert.equal(startup.body.name, "startup");
    assert.equal((await call("/start?name=../bad")).status, 400);
    assert.equal((await call("/start?name=upload")).status, 200);
    for (let i = 0; i < 100000; i++) Math.sqrt(i);
    const upload = await call("/stop");
    assert.equal(upload.status, 200);
    assert.equal(upload.body.name, "upload");
    assert.ok(upload.body.durationMs > 0);
    assert.ok(upload.body.memory.rss > 0);
    for (const result of [startup, upload]) {
      const profile = JSON.parse(fs.readFileSync(path.join(directory, result.body.profile)));
      assert.ok(profile.nodes.length > 0);
      assert.ok(profile.endTime >= profile.startTime);
    }
    assert.equal((await call("/stop")).status, 400);
    assert.equal(fs.statSync(path.join(directory, "control.sock")).mode & 0o777, 0o600);
  } finally {
    profiler.delay.disable(); profiler.session.disconnect();
    await new Promise(resolve => profiler.server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("bundle bootstrap waits for profiling before loading Meteor", async () => {
  const vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "../../meteor-bundle-main.js"), "utf8");
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  let loaded = false;
  function Server() {}
  Server.prototype.listen = function () {};
  const completion = vm.runInNewContext(source, {
    process: { argv: ["node", "sandstorm-main.js"], env: { SANDSTORM_PROFILE_SERVER: "1" } },
    console,
    require(name) {
      if (name === "http") return { Server };
      if (name === "net") return {};
      if (name === "./server-profiler.js") return { start: () => ({ ready }) };
      assert.equal(name, "./main.js"); loaded = true;
    },
  });
  assert.equal(loaded, false);
  release();
  await completion;
  assert.equal(loaded, true);
});
