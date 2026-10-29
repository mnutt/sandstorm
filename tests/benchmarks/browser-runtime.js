// Self-contained: Nightwatch serializes this function into the grain frame.
function browserRuntimeBenchmark(options, doneBenchmark) {
  function getMeteor() {
    return window.Meteor ||
        window.Package && window.Package.meteor && window.Package.meteor.Meteor;
  }

  function frameState() {
    const meteor = getMeteor();
    return {
      meteor: typeof meteor,
      meteorCall: typeof (meteor && meteor.call),
      href: window.location.href,
      title: document.title,
      body: document.body && document.body.innerText &&
          document.body.innerText.slice(0, 200),
    };
  }

  function waitForMeteorCall() {
    const deadline = Date.now() + (options.meteorWaitMs || 30000);
    return new Promise((resolve, reject) => {
      function poll() {
        const meteor = getMeteor();
        if (meteor && typeof meteor.call === "function") {
          resolve();
        } else if (Date.now() >= deadline) {
          reject(new Error("Timed out waiting for app Meteor.call: " +
              JSON.stringify(frameState())));
        } else {
          window.setTimeout(poll, 50);
        }
      }

      poll();
    });
  }

  function summarize(samples, totalMs) {
    const sorted = samples.slice().sort((left, right) => left - right);
    const percentile = (fraction) => {
      const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
      return sorted[index];
    };

    return {
      name: "app.meteor.getServerRuntime",
      iterations: samples.length,
      totalMs: totalMs,
      opsPerSecond: samples.length / (totalMs / 1000),
      avgMs: totalMs / samples.length,
      minMs: sorted[0],
      p50Ms: percentile(0.50),
      p95Ms: percentile(0.95),
      p99Ms: percentile(0.99),
      maxMs: sorted[sorted.length - 1],
    };
  }

  function readRuntime() {
    return new Promise((resolve, reject) => {
      getMeteor().call("getServerRuntime", function (err) {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  (async function () {
    await waitForMeteorCall();

    for (let i = 0; i < options.warmup; ++i) {
      await readRuntime();
    }

    const samples = [];
    const totalStart = window.performance.now();
    for (let i = 0; i < options.iterations; ++i) {
      const start = window.performance.now();
      await readRuntime();
      samples.push(window.performance.now() - start);
    }

    doneBenchmark({ result: summarize(samples, window.performance.now() - totalStart) });
  })().catch((err) => {
    doneBenchmark({
      error: {
        message: err && (err.reason || err.message) || String(err),
      },
    });
  });
}

module.exports = browserRuntimeBenchmark;
