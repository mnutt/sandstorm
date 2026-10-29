"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { makeClient, batch } = require("./latency-client");
const { phase } = require("./harness");
const { actionSelector } = require("../utils");
const output = process.env.E2E_PROFILE_OUTPUT;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = {
  "@disabled": !output || process.env.E2E_SCENARIO !== "latency",
  "Request latency through the grain stack": async function (browser) {
    const options = JSON.parse(process.env.E2E_LATENCY_OPTIONS);
    const summaries = [];
    let direct;
    let directLog;
    const clients = new Set();
    function client(origin, cookie, concurrency) {
      const result = makeClient(origin, cookie, concurrency); clients.add(result); return result;
    }
    function save(name, result) {
      summaries.push({ name, ...result.summary });
      fs.writeFileSync(path.join(output, name + ".json"), JSON.stringify(result, null, 2));
      fs.writeFileSync(path.join(output, "latency-summary.json"), JSON.stringify(summaries, null, 2));
      if (result.summary.errors) throw new Error(`${name}: ${result.summary.errors} requests failed`);
    }
    try {
      directLog = fs.openSync(path.join(output, "direct-server.log"), "w");
      direct = spawn(process.env.E2E_LATENCY_BINARY, [String(options.directPort)],
        { stdio: ["ignore", directLog, directLog] });
      let spawnError;
      direct.on("error", error => { spawnError = error; });
      const directOrigin = `http://127.0.0.1:${options.directPort}`;
      const probe = client(directOrigin, "", 1);
      let ready = false;
      for (let i = 0; i < 50; i++) {
        if (spawnError) throw spawnError;
        if (direct.exitCode !== null) throw new Error("Direct-control server exited");
        if (!(await probe.request("ready", 200)).error) { ready = true; break; }
        await wait(100);
      }
      probe.close(); clients.delete(probe);
      if (!ready) throw new Error("Direct-control server did not become ready");
      await phase("login", async () => { await browser.loginDevAccount("Latency", true); });
      await phase("install", async () => {
        await browser.url(browser.launch_url + "/upload-test").waitForElementVisible("#upload-app")
          .setValue("#upload-app", process.env.E2E_APP_SPK)
          .waitForElementVisible(".install-step-confirm", 180000).click(".confirm-install-button")
          .waitForElementVisible(actionSelector, 180000).disableGuidedTour();
      });
      let grainId, origin, cookie;
      await phase("create-grain", async () => {
        await browser.click(actionSelector).waitForElementVisible("#grainTitle", 180000);
        await browser.url(result => { grainId = new URL(result.value).pathname.split("/")[2]; });
        await browser.grainFrame().waitForElementVisible("body", 30000);
        await browser.waitUntil(async () => {
          const result = await browser.execute(() => document.body.textContent.includes("sandstorm-latency-v1"));
          return result.value === true;
        }, 30000);
        await browser.execute(() => location.origin, [], result => { origin = result.value; });
        await browser.getCookies(result => {
          const cookies = result.value || result;
          const session = cookies.find(entry => entry.name === "sandstorm-sid");
          if (!session) throw new Error("Grain session cookie was not exposed by WebDriver");
          cookie = `sandstorm-sid=${session.value}`;
        });
      });
      // Keep the shell logged in for shutdown RPCs, but remove the grain iframe to avoid background requests.
      await browser.frame(null).url(browser.launch_url + "/apps").waitForElementVisible(".app-list");
      const unauthorized = client(origin, "", 1);
      if (!(await unauthorized.request("unauthorized")).error) throw new Error("Grain accepted an unauthenticated request");
      unauthorized.close(); clients.delete(unauthorized);

      const rpcResults = [];
      for (let repeat = 1; repeat <= options.repetitions; repeat++) {
        await browser.executeAsync(function (id, done) {
          Meteor.call("benchmarkNodeCapnpBaseline", {
            grainId: id, iterations: 1000, warmup: 100, includeSamples: true, profile: false,
          }, (error, result) => done({ error: error ? error.message : null, result }));
        }, [grainId], response => {
          if (!response.value || response.value.error) throw new Error(JSON.stringify(response));
          rpcResults.push(response.value.result);
          fs.writeFileSync(path.join(output, "rpc-results.json"), JSON.stringify(rpcResults, null, 2));
        });
      }

      if (process.env.E2E_FD_DIAGNOSTIC === "true") {
        const connection = client(origin, cookie, 1);
        await require("./fd-diagnostic")({ connection, batch, output });
        await browser.end();
        return;
      }

      for (const concurrency of options.concurrency) {
        for (let repeat = 1; repeat <= options.repetitions; repeat++) {
          // Alternate control/stack order to reduce systematic warm-cache and machine-load bias.
          const order = repeat % 2 ? ["direct", "grain"] : ["grain", "direct"];
          for (const target of order) {
            const name = `${target}-c${concurrency}-r${repeat}`;
            const connection = client(target === "grain" ? origin : directOrigin,
              target === "grain" ? cookie : "", concurrency);
            try {
              const warmup = await batch(connection, options.warmup, concurrency, name + "-warmup");
              if (warmup.summary.errors) throw new Error(`${name}: warm-up failed: ${JSON.stringify(warmup.records.find(row => row.error))}`);
              let result;
              await phase(name, async () => {
                result = await batch(connection, options.requests, concurrency, name);
              });
              save(name, result);
            } finally { connection.close(); clients.delete(connection); }
          }
        }
      }
      const coldClient = client(origin, cookie, 1);
      let previous = await coldClient.request("before-cold");
      if (previous.error) throw new Error(previous.error);
      for (let i = 1; i <= options.coldRepetitions; i++) {
        await browser.executeAsync(function (id, done) {
          Meteor.call("shutdownGrain", id, error => done({ error: error ? error.message : null }));
        }, [grainId], result => {
          if (!result.value || result.value.error) throw new Error(JSON.stringify(result));
        });
        let result;
        await phase(`cold-${i}`, async () => {
          result = await batch(coldClient, 1, 1, `cold-${i}`);
        });
        save(`cold-${i}`, result);
        if (result.records[0].bootId === previous.bootId) throw new Error("Cold test did not restart the app");
        previous = result.records[0];
      }
      await browser.end();
    } finally {
      for (const connection of clients) connection.close();
      if (direct && direct.exitCode === null) {
        direct.kill();
        await new Promise(resolve => direct.once("exit", resolve));
      }
      if (directLog !== undefined) fs.closeSync(directLog);
    }
  },
};
