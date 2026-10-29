// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2026 Sandstorm Development Group, Inc. and contributors
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

const fs = require("fs");
const path = require("path");
const browserRuntimeBenchmark = require("./browser-runtime");
const { medium_wait, very_long_wait } = require("../utils");

function envNumber(name, fallback) {
  const parsed = Number.parseInt(process.env[name], 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatMs(value) {
  return value.toFixed(value >= 10 ? 2 : 3);
}

function formatOps(value) {
  return value.toFixed(value >= 1000 ? 0 : 1);
}

function pad(value, width, alignRight) {
  const text = String(value);
  if (text.length >= width) return text;
  const padding = " ".repeat(width - text.length);
  return alignRight ? padding + text : text + padding;
}

function printRow(columns) {
  console.log(
    pad(columns.name, 28, false) + "  " +
    pad(columns.iterations, 6, true) + "  " +
    pad(columns.totalMs, 10, true) + "  " +
    pad(columns.avgMs, 8, true) + "  " +
    pad(columns.p50Ms, 8, true) + "  " +
    pad(columns.p95Ms, 8, true) + "  " +
    pad(columns.p99Ms, 8, true) + "  " +
    pad(columns.opsPerSecond, 8, true));
}

function printBenchmark(result) {
  console.log("\nnode-capnp baseline benchmark");
  console.log("  generated:  " + result.generatedAt);
  console.log("  packageId:  " + result.packageId);
  console.log("  grainId:    " + result.grainId);
  console.log("  default:    " + result.iterations + " iterations, " +
      result.warmup + " warmup");
  console.log("");

  printRow({
    name: "benchmark",
    iterations: "n",
    totalMs: "total ms",
    avgMs: "avg ms",
    p50Ms: "p50 ms",
    p95Ms: "p95 ms",
    p99Ms: "p99 ms",
    opsPerSecond: "ops/sec",
  });
  printRow({
    name: "-".repeat(28),
    iterations: "-".repeat(6),
    totalMs: "-".repeat(10),
    avgMs: "-".repeat(8),
    p50Ms: "-".repeat(8),
    p95Ms: "-".repeat(8),
    p99Ms: "-".repeat(8),
    opsPerSecond: "-".repeat(8),
  });

  result.results.forEach((item) => {
    if (item.skipped) {
      console.log(pad(item.name, 28, false) + "  skipped: " + item.reason);
      return;
    }

    printRow({
      name: item.name,
      iterations: item.iterations,
      totalMs: formatMs(item.totalMs),
      avgMs: formatMs(item.avgMs),
      p50Ms: formatMs(item.p50Ms),
      p95Ms: formatMs(item.p95Ms),
      p99Ms: formatMs(item.p99Ms),
      opsPerSecond: formatOps(item.opsPerSecond),
    });
  });
}


function writeBenchmarkReport(result) {
  const reportDir = path.resolve(__dirname, "../reports/benchmarks");
  const profileDir = path.join(reportDir, "profiles");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(reportDir, "node-capnp-baseline-" + stamp + ".json");
  fs.mkdirSync(reportDir, { recursive: true });

  for (const benchmark of result.results || []) {
    if (!benchmark.profile) continue;

    const baseName = benchmark.profileFileName ||
        ("node-capnp-baseline-" + benchmark.name.replace(/[^a-zA-Z0-9_.-]/g, "_") + ".cpuprofile");
    const profilePath = path.join(profileDir, stamp + "-" + baseName);
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(profilePath, JSON.stringify(benchmark.profile) + "\n");
    benchmark.profilePath = profilePath;
    delete benchmark.profile;
    delete benchmark.profileFileName;
  }

  fs.writeFileSync(reportPath, JSON.stringify(result, null, 2) + "\n");
  console.log("wrote benchmark report: " + reportPath);
}

function reloadActiveGrainFrame(client, done) {
  client.frame(null)
    .execute(function () {
      const active = window.globalGrains && window.globalGrains.getActive &&
          window.globalGrains.getActive();
      const selector = active && active.grainId ?
        "#grain-frame-" + active.grainId() :
        ".grain-container.active-grain iframe.grain-frame";
      const frame = document.querySelector(selector);
      if (!frame) return { error: "active grain frame not found", selector: selector };

      frame.src = frame.src;
      return { selector: selector, src: frame.src };
    }, [], function (result) {
      const value = result.value || {};
      client.assert.equal(value.error || null, null, "active grain frame reloaded");
      done();
    });
}

module.exports["Benchmark node-capnp through Sandstorm paths"] = function (browser) {
  let grainId = null;
  const benchmarkOptions = {
    iterations: envNumber("NODE_CAPNP_BENCH_ITERS", 200),
    warmup: envNumber("NODE_CAPNP_BENCH_WARMUP", 20),
    includeSamples: process.env.NODE_CAPNP_BENCH_SAMPLES === "true",
    profile: process.env.NODE_CAPNP_BENCH_PROFILE === "true",
    profilePrefix: process.env.NODE_CAPNP_BENCH_PROFILE_PREFIX || "node-capnp-baseline",
    profileSamplingIntervalUs: envNumber("NODE_CAPNP_BENCH_PROFILE_INTERVAL_US", 1000),
  };
  const appBenchmarkOptions = {
    iterations: envNumber("NODE_CAPNP_BENCH_APP_ITERS",
      Math.min(benchmarkOptions.iterations, 50)),
    warmup: envNumber("NODE_CAPNP_BENCH_APP_WARMUP",
      Math.min(benchmarkOptions.warmup, 5)),
  };
  let benchmarkResult = null;

  browser
    .loginDevAccount()
    .uploadMeteorTestApp()
    .timeouts("script", very_long_wait)
    .waitForElementVisible("button.action", medium_wait)
    .click("button.action")
    .grainFrame()
    .frame(null)
    .url(function (grainUrl) {
      const regex = new RegExp(browser.launch_url + "/grain/([\\w]*)");
      const match = regex.exec(grainUrl.value);
      browser.assert.ok(!!match, "opened a grain for supervisor benchmarks");
      grainId = match && match[1];
    })
    .perform(function (client, done) {
      client.executeAsync(function (options, doneBenchmark) {
        window.Meteor.call("benchmarkNodeCapnpBaseline", options, function (err, result) {
          doneBenchmark({
            error: err && {
              error: err.error,
              reason: err.reason,
              message: err.message,
            },
            result: result,
          });
        });
      }, [Object.assign({}, benchmarkOptions, { grainId: grainId })], function (result) {
        const value = result.value || {};
        client.assert.equal(value.error, null, "benchmark method completed without error");
        benchmarkResult = value.result || null;

        done();
      });
    })
    .perform(reloadActiveGrainFrame)
    .pause(1000)
    .grainFrame()
    .timeouts("script", very_long_wait)
    .perform(function (client, done) {
      client.executeAsync(browserRuntimeBenchmark, [appBenchmarkOptions], function (result) {
        const value = result.value || {};
        client.assert.equal(value.error || null, null,
            "app Meteor runtime benchmark completed without error");
        client.assert.ok(!!value.result, "app Meteor runtime benchmark returned results");
        if (!value.result) {
          done();
          return;
        }

        if (benchmarkResult && value.result) {
          benchmarkResult.results.push(value.result);
        }

        if (benchmarkResult) {
          printBenchmark(benchmarkResult);
          writeBenchmarkReport(benchmarkResult);
        }

        done();
      });
    })
    .end();
};
