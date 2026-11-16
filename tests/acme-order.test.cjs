"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const acme = require("../shell/node_modules/@root/acme");
const utils = require("../shell/node_modules/@root/acme/utils");

// Exercise the pinned upstream implementation; no production polling override.
function fixture(t, responses) {
  const requests = [];
  t.mock.method(acme, "_wait", async () => {});
  t.mock.method(acme, "_csrToUrlBase64", () => "encoded-csr");
  t.mock.method(acme, "_notify", () => {});
  t.mock.method(utils, "_jwsRequest", async (_me, request) => {
    requests.push(request);
    assert.ok(responses.length, "unexpected extra ACME request");
    return responses.shift();
  });
  return { requests, run: () => acme._pollOrderStatus({}, {
    csr: "csr", accountKey: "key", domains: ["*.example.org", "example.org"],
  }, "account", { _finalizeUrl: "https://ca.example/finalize/1", _orderUrl: "https://ca.example/order/1" }, []) };
}

test("upstream finalizes once, then POST-as-GET polls the order", async t => {
  const f = fixture(t, [
    { body: { status: "processing" } },
    { body: { status: "processing" } },
    { body: { status: "valid", certificate: "https://ca.example/cert/1" } },
  ]);
  assert.equal((await f.run())._certificateUrl, "https://ca.example/cert/1");
  assert.deepEqual(f.requests.map(r => r.url), ["https://ca.example/finalize/1", "https://ca.example/order/1", "https://ca.example/order/1"]);
  assert.equal(Buffer.from(f.requests[0].payload).toString(), '{"csr":"encoded-csr"}');
  assert.equal(f.requests[1].payload.length, 0);
  assert.equal(f.requests[2].payload.length, 0);
});

test("upstream accepts immediate issuance", async t => {
  const f = fixture(t, [{ body: { status: "valid", certificate: "https://ca.example/cert/1" } }]);
  assert.equal((await f.run())._certificateUrl, "https://ca.example/cert/1");
  assert.equal(f.requests.length, 1);
});

test("upstream rejects invalid orders", async t => {
  const f = fixture(t, [{ body: { status: "invalid" } }]);
  await assert.rejects(f.run());
  assert.equal(f.requests.length, 1);
});
