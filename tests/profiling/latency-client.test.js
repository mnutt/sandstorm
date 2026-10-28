"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { makeClient, batch, distribution } = require("./latency-client");

test("percentiles use nearest rank, with a real mean and an empty result", () => {
  assert.deepEqual(distribution([4, 1, 2, 3]), { min: 1, mean: 2.5, p50: 2, p95: 4, p99: 4, max: 4 });
  assert.equal(distribution([]), null);
});

test("validates every response, bounds concurrency, reuses sockets, and measures all latency segments", async () => {
  let active = 0, peak = 0, count = 0, bad = false;
  const server = http.createServer((req, res) => {
    active++; count++; peak = Math.max(peak, active);
    const received = process.hrtime.bigint();
    const id = new URL(req.url, "http://localhost").searchParams.get("id");
    setTimeout(() => {
      res.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "text/plain" });
      const sending = process.hrtime.bigint();
      res.end(`sandstorm-latency-v1\n${bad ? "wrong" : id}\n1\n${received}\n${sending}\n42\n`);
      active--;
    }, 3);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const client = makeClient(`http://127.0.0.1:${server.address().port}`, "", 5);
  try {
    const warm = await batch(client, 10, 5, "warm");
    assert.equal(warm.summary.errors, 0);
    const measured = await batch(client, 100, 5, "measured");
    assert.equal(measured.summary.errors, 0);
    assert.equal(count, 110);
    assert.equal(peak, 5);
    assert.equal(measured.summary.reusedConnections, 100);
    assert.equal(new Set(measured.records.map(row => row.id)).size, 100);
    for (const row of measured.records) {
      assert.ok(row.handlerMs >= 1);
      assert.ok(Math.abs(row.totalMs - row.toAppMs - row.handlerMs - row.fromAppMs) < 1e-6);
    }
    bad = true;
    assert.equal((await batch(client, 1, 1, "invalid")).summary.errors, 1);
    bad = false;
    assert.match((await client.request("timeout", 1)).error, /deadline/);
  } finally {
    client.close();
    await new Promise(resolve => server.close(resolve));
  }
});
