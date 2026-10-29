import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { test } from "node:test";
const benchmark = createRequire(import.meta.url)("../../tests/benchmarks/browser-runtime.js");

for (const fail of [false, true]) {
  test(`serialized browser benchmark ${fail ? "reports errors" : "calls the current fixture"}`, async () => {
    const fixture = readFileSync(new URL("../../meteor-testapp/server/main.js", import.meta.url), "utf8");
    let methods;
    vm.runInNewContext(fixture.replace('import { Meteor } from "meteor/meteor";', ''), {
      Meteor: { methods: value => { methods = value; } },
      process: { env: { SERVER_RUNTIME: "node" } },
    });
    let calls = 0;
    let ticks = 0;
    const result = await new Promise(resolve => {
      vm.runInNewContext(`(${benchmark.toString()})({warmup: 2, iterations: 3}, done)`, {
        done: resolve,
        window: {
          Meteor: { call(name, callback) {
            calls++;
            assert.equal(name, "getServerRuntime");
            assert.equal(typeof methods[name], "function");
            callback(fail ? new Error("fixture failed") : null, methods[name]());
          } },
          performance: { now: () => ++ticks },
        },
      });
    });
    if (fail) {
      assert.equal(result.error.message, "fixture failed");
      assert.equal(calls, 1);
    } else {
      assert.equal(calls, 5);
      assert.equal(result.result.name, "app.meteor.getServerRuntime");
      assert.equal(result.result.iterations, 3);
      assert.equal(result.result.p50Ms, 1);
    }
  });
}
