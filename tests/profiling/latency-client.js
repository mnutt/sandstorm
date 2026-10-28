"use strict";
const http = require("node:http");
const { performance } = require("node:perf_hooks");

function distribution(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = p => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
  return { min: sorted[0], mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: sorted.at(-1) };
}

function makeClient(origin, cookie = "", concurrency = 1) {
  const url = new URL(origin);
  if (url.protocol !== "http:") throw new Error("The local benchmark requires plain HTTP");
  const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency, maxFreeSockets: concurrency });
  return {
    close: () => agent.destroy(),
    request(id, timeoutMs = 5000) {
      return new Promise(resolve => {
        const start = process.hrtime.bigint();
        let headerTime;
        let settled = false;
        const finish = result => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          resolve({ id, startNs: start.toString(), ...result });
        };
        const request = http.get({ hostname: "127.0.0.1", port: url.port || 80,
          path: "/ping?id=" + id, agent, headers: {
            Host: url.host, Cookie: cookie, "Cache-Control": "no-cache",
          } }, response => {
          headerTime = process.hrtime.bigint();
          let body = "";
          response.on("data", chunk => {
            body += chunk;
            if (body.length > 4096) request.destroy(new Error("Unexpectedly large response"));
          });
          response.on("error", error => finish({ error: error.message }));
          response.on("end", () => {
            const end = process.hrtime.bigint();
            try {
              const [magic, echoed, pid, received, sending, bootId, appConnectionId] = body.trim().split("\n");
              if (response.statusCode !== 200 || magic !== "sandstorm-latency-v1" || echoed !== id ||
                  !/^\d+$/.test(pid) || !/^\d+$/.test(received) || !/^\d+$/.test(sending) || !/^\d+$/.test(bootId) ||
                  (appConnectionId !== undefined && !/^\d+$/.test(appConnectionId))) {
                throw new Error(`Invalid response: status=${response.statusCode}, body=${body.slice(0, 100)}`);
              }
              const appReceive = BigInt(received), appSend = BigInt(sending);
              if (appReceive < start || appSend < appReceive || appSend > end) {
                throw new Error("Application and client monotonic clocks do not agree");
              }
              finish({ totalMs: Number(end - start) / 1e6, ttfbMs: Number(headerTime - start) / 1e6,
                toAppMs: Number(appReceive - start) / 1e6, handlerMs: Number(appSend - appReceive) / 1e6,
                fromAppMs: Number(end - appSend) / 1e6, reusedSocket: request.reusedSocket, appPid: +pid, bootId, appConnectionId });
            } catch (error) { finish({ error: error.message }); }
          });
        });
        const deadline = setTimeout(() => request.destroy(new Error("Request deadline exceeded")), timeoutMs);
        request.on("error", error => finish({ error: error.message }));
      });
    },
  };
}

async function batch(client, count, concurrency, prefix) {
  const records = new Array(count);
  let next = 0;
  const cpuStart = process.cpuUsage();
  const startedAt = new Date().toISOString();
  const startNs = process.hrtime.bigint().toString();
  const start = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < count) {
      const i = next++;
      records[i] = await client.request(`${prefix}-${i}`);
    }
  }));
  const durationMs = performance.now() - start;
  const cpu = process.cpuUsage(cpuStart);
  const good = records.filter(row => !row.error);
  const summary = { startedAt, monotonicStartNs: startNs, count, concurrency, durationMs,
    errors: count - good.length, successfulRequestsPerSecond: good.length * 1000 / durationMs,
    clientCpuMs: (cpu.user + cpu.system) / 1000,
    appConnections: good.every(row => row.appConnectionId) ?
      new Set(good.map(row => `${row.bootId}:${row.appConnectionId}`)).size : null,
    reusedConnections: good.filter(row => row.reusedSocket).length };
  for (const name of ["totalMs", "ttfbMs", "toAppMs", "handlerMs", "fromAppMs"]) {
    summary[name] = distribution(good.map(row => row[name]));
  }
  return { summary, records };
}
module.exports = { makeClient, batch, distribution };
