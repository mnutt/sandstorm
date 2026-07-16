// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2026 Sandstorm contributors
// Licensed under the Apache License, Version 2.0.

"use strict";

function parseMinimum(argv) {
  if (argv.length === 0) return 0;
  if (argv.length !== 2 || argv[0] !== "--min-speedup") {
    throw new Error("usage: isolate-local-capnp-benchmark.js <local-json> <fallback-json> " +
      "[--min-speedup <ratio>]");
  }
  const value = Number(argv[1]);
  if (!Number.isFinite(value) || value <= 0) throw new Error("invalid minimum speedup");
  return value;
}

const local = JSON.parse(process.argv[2]);
const fallback = JSON.parse(process.argv[3]);
const minimum = parseMinimum(process.argv.slice(4));
if (local.residence !== "sameAccountLocal" || fallback.residence !== "imported") {
  throw new Error("benchmark did not force the requested transports");
}
function compareMetric(name, rateKey, rateLabel) {
  const localMetric = local[name];
  const fallbackMetric = fallback[name];
  if (!localMetric || !fallbackMetric ||
      localMetric.iterations !== fallbackMetric.iterations ||
      localMetric.elapsedMs <= 0 || fallbackMetric.elapsedMs <= 0) {
    throw new Error(`benchmark returned invalid ${name} measurements`);
  }
  if (name === "large" &&
      (localMetric.bytesPerCall !== fallbackMetric.bytesPerCall ||
       localMetric.bytesPerCall <= 0)) {
    throw new Error("benchmark returned mismatched large payload sizes");
  }
  const result = {
    iterations: localMetric.iterations,
    ...(name === "large" ? { bytesPerCall: localMetric.bytesPerCall } : {}),
    localElapsedMs: localMetric.elapsedMs,
    fallbackElapsedMs: fallbackMetric.elapsedMs,
    speedup: fallbackMetric.elapsedMs / localMetric.elapsedMs,
  };
  result[`local${rateLabel}`] = localMetric[rateKey];
  result[`fallback${rateLabel}`] = fallbackMetric[rateKey];
  return result;
}

const result = {
  sequential: compareMetric("sequential", "callsPerSecond", "CallsPerSecond"),
  pipeline: compareMetric("pipeline", "callsPerSecond", "CallsPerSecond"),
  large: compareMetric("large", "mebibytesPerSecond", "MebibytesPerSecond"),
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (minimum > 0 && result.pipeline.speedup < minimum) {
  throw new Error(
    `pipelined local RPC speedup ${result.pipeline.speedup.toFixed(2)}x is below ${minimum}x`);
}
