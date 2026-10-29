"use strict";
const fs = require("node:fs");
const path = require("node:path");

function snapshot(label) {
  const processes = [];
  for (const pid of fs.readdirSync("/proc").filter(name => /^\d+$/.test(name))) {
    try {
      const comm = fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim();
      if (!/sandstorm-http|latency-test/.test(comm)) continue;
      const entry = { pid: Number(pid), comm };
      try {
        entry.root = fs.readlinkSync(`/proc/${pid}/root`);
        entry.limits = fs.readFileSync(`/proc/${pid}/limits`, "utf8").split("\n")
          .filter(line => line.includes("open files"));
        entry.fds = fs.readdirSync(`/proc/${pid}/fd`).map(fd => {
          try { return { fd: Number(fd), target: fs.readlinkSync(`/proc/${pid}/fd/${fd}`) }; }
          catch { return { fd: Number(fd), target: "closed-during-snapshot" }; }
        });
        entry.tcp = fs.readFileSync(`/proc/${pid}/net/tcp`, "utf8");
      } catch (error) { entry.error = String(error); }
      processes.push(entry);
    } catch { /* Process exited. */ }
  }
  return { label, at: new Date().toISOString(), processes };
}

module.exports = async function diagnose({ connection, batch, output }) {
  const snapshots = [];
  let requestFailure;
  function record(label) {
    snapshots.push(snapshot(label));
    fs.writeFileSync(path.join(output, "fd-snapshots.json"), JSON.stringify(snapshots, null, 2));
  }
  record("before-http");
  for (let i = 1; i <= 15; i++) {
    const result = await batch(connection, 100, 1, `fd-batch-${i}`);
    fs.writeFileSync(path.join(output, `fd-batch-${i}.json`), JSON.stringify(result, null, 2));
    record(`after-${i * 100}-requests`);
    if (result.summary.errors) {
      requestFailure = new Error(`Batch ${i}: ${result.summary.errors} requests failed`);
      break;
    }
  }
  await new Promise(resolve => setTimeout(resolve, 3000));
  record("after-idle-3s");
  if (requestFailure) throw requestFailure;
};
