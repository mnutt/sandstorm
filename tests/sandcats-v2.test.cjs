"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const http = require("node:http");
const { execFile, execFileSync } = require("node:child_process");
const { promisify } = require("node:util");
const run = promisify(execFile);
const client = require("../shell/imports/server/sandcats-v2/index");
const config = require("../shell/imports/server/sandcats-v2/config");
const { transport } = require("../shell/imports/server/sandcats-v2/transport");
const { Updater, startUpdater } = require("../shell/imports/server/sandcats-v2/updater");
const acme = require("../shell/imports/server/sandcats-v2/acme");

const privateKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
  .export({ format: "pem", type: "pkcs8" });
const keyObject = crypto.createPublicKey(privateKey);
let dir, tlsServer, plainServer, origin, plainOrigin;
const requests = [];
const nonces = new Set();
let owner = keyObject;
let state;
let rejectRecovery = false;

function verify(headers, body, url, apiOrigin, key = owner) {
  assert.equal(headers["authorization"], "Bearer test-webkey");
  assert.equal(headers["x-sandstorm-passthrough"], "address");
  assert.equal(headers["x-sandstorm-app-sandhost"], "cats");
  const timestamp = headers["x-sandstorm-app-sandhost-timestamp"];
  assert.match(timestamp, /^\d{13}$/);
  assert.ok(Math.abs(Date.now() - Number(timestamp)) < 300000);
  const nonce = headers["x-sandstorm-app-sandhost-nonce"];
  assert.match(nonce, /^[\w-]{22,64}$/);
  assert.ok(!nonces.has(nonce), "nonce replay rejected");
  const message = ["sandhost-v1", apiOrigin, "POST", url, timestamp, nonce,
    crypto.createHash("sha256").update(body).digest("base64url")].join("\n");
  assert.ok(crypto.verify("RSA-SHA256", Buffer.from(message), key,
    Buffer.from(headers["x-sandstorm-app-sandhost-signature"], "base64url")));
  nonces.add(nonce);
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sandcats-test-"));
  fs.writeFileSync(path.join(dir, "id_rsa"), privateKey, { mode: 0o600 });
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost",
    "-keyout", path.join(dir, "tls.key"), "-out", path.join(dir, "tls.crt")], { stdio: "ignore" });
  const handler = async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, body, headers: req.headers });
    res.setHeader("Content-Type", "application/json");
    try {
      if (req.url === "/large") { res.end("x".repeat(70000)); return; }
      if (req.url === "/redirect") { res.writeHead(302, { location: "/status" }); res.end("{}"); return; }
      if (req.url === "/recover") {
        assert.equal(req.headers.authorization, "Bearer test-webkey");
        res.end("{}"); return;
      }
      const fields = Object.fromEntries(new URLSearchParams(body));
      const requestKey = ["/register", "/recover/confirm"].includes(req.url)
        ? crypto.createPublicKey({ key: Buffer.from(fields.publicKey, "base64url"), type: "spki", format: "der" })
        : owner;
      verify(req.headers, body, req.url, req.socket.encrypted ? origin : plainOrigin, requestKey);
      if (req.url === "/recover/confirm") {
        if (rejectRecovery || fields.token !== "recovery-secret") throw new Error("invalid token");
        owner = requestKey;
      }
      if (req.url === "/register") {
        assert.equal(fields.email, "a+b &ü@example.com");
        if (fields.rawHostname === "taken") { res.writeHead(409); res.end('{"error":"taken"}'); return; }
        owner = requestKey;
        state = { rawHostname: fields.rawHostname, hostname: fields.rawHostname + ".sandhost.org",
          addressMode: fields.addressMode, ipAddress: fields.ipAddress || "8.8.8.8", publication: "synced" };
      }
      res.end(JSON.stringify(state || {}));
    } catch (_) {
      res.writeHead(403); res.end('{"error":"invalid_request"}');
    }
  };
  tlsServer = https.createServer({ key: fs.readFileSync(path.join(dir, "tls.key")),
    cert: fs.readFileSync(path.join(dir, "tls.crt")) }, handler);
  plainServer = http.createServer(handler);
  await Promise.all([new Promise(resolve => tlsServer.listen(0, "127.0.0.1", resolve)),
    new Promise(resolve => plainServer.listen(0, "127.0.0.1", resolve))]);
  origin = "https://localhost:" + tlsServer.address().port;
  plainOrigin = "http://127.0.0.1:" + plainServer.address().port;
  fs.writeFileSync(path.join(dir, "api-webkey"), origin + "/#test-webkey\n", { mode: 0o600 });
});

after(async () => {
  if (tlsServer) await new Promise(resolve => tlsServer.close(resolve));
  if (plainServer) await new Promise(resolve => plainServer.close(resolve));
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function bash(script, env = {}) {
  return run("bash", ["-c", 'set -euo pipefail; source ./sandcats-v2.sh; ' + script], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, SANDHOST_DIR: dir, CURL_CA_BUNDLE: path.join(dir, "tls.crt"),
      DESIRED_SANDCATS_NAME: "alice", SANDCATS_REGISTRATION_EMAIL: "a+b &ü@example.com", ...env },
  });
}

test("webkey separates origin/token and rejects unsafe URLs without exposing input", () => {
  assert.deepEqual(config.parseWebkey("https://API.EXAMPLE/#secret\n"), {
    origin: "https://api.example", apiToken: "secret",
  });
  for (const url of ["no-secret", "http://api.example/#secret", "https://api.example/grain/id#secret",
    "https://user:secret@api.example/#secret", "https://api.example/?secret#secret", "https://api.example/"]) {
    assert.throws(() => config.parseWebkey(url), error => !error.message.includes("secret"));
  }
  assert.equal(config.readWebkey(path.join(dir, "api-webkey")).origin, origin);
  fs.chmodSync(path.join(dir, "api-webkey"), 0o644);
  assert.equal(config.readWebkey(path.join(dir, "api-webkey")).origin, origin);
  assert.equal(config.localAddress("127.0.0.1"), undefined);
  assert.equal(config.localAddress("192.168.1.5"), "192.168.1.5");
});

test("Bash signs actual HTTPS registration; form encoding, explicit mode, auth failures and privacy", async () => {
  const result = await bash("sandhost_register", { SANDCATS_ADDRESS_MODE: "explicit", SANDCATS_IP_ADDRESS: "100.64.1.2" });
  assert.equal(state.addressMode, "explicit");
  assert.equal(state.ipAddress, "100.64.1.2");
  assert.equal(result.stdout + result.stderr, "");
  await assert.rejects(bash("sandhost_register", { DESIRED_SANDCATS_NAME: "taken" }), /HTTP 409/);
  await assert.rejects(bash("sandhost_register", { SANDCATS_ADDRESS_MODE: "explicit", SANDCATS_IP_ADDRESS: "8.8.8.8" }), /Invalid Sandcats address/);
  await assert.rejects(bash("sandhost_request /status missing-key rawHostname alice"));
  const webkeyPath = path.join(dir, "api-webkey");
  fs.writeFileSync(webkeyPath, origin + "/#invalid-secret");
  await assert.rejects(bash('sandhost_request /status "$SANDHOST_DIR/id_rsa" rawHostname alice'),
    error => error.stderr.includes("HTTP 403") && !error.stderr.includes("invalid-secret"));
  fs.writeFileSync(webkeyPath, origin + "/#test-webkey");
  assert.ok(!fs.readdirSync(dir).some(name => name.startsWith("request.")));
});

test("JavaScript signatures verify; wrong origin, replay and bearer fail; redirects are not followed", async () => {
  const options = { apiToken: "test-webkey", allowLocalHttp: true, localAddress: "127.0.0.1" };
  const req = client.signedRequest(plainOrigin, "/status", { rawHostname: "alice" }, privateKey, options);
  assert.equal((await transport(req.clone(), options)).status, 200);
  assert.equal((await transport(req.clone(), options)).status, 403);
  const wrongOrigin = client.signedRequest("https://wrong.example", "/status", { rawHostname: "alice" }, privateKey, options);
  const moved = new Request(plainOrigin + "/status", { method: "POST", headers: wrongOrigin.headers, body: await wrongOrigin.text() });
  assert.equal((await transport(moved, options)).status, 403);
  await assert.rejects(client.call(plainOrigin, "/status", { rawHostname: "alice" }, privateKey,
    { ...options, apiToken: "bad-secret" }), error => error.status === 403 && !error.message.includes("bad-secret"));
  const count = requests.length;
  assert.equal((await transport(new Request(plainOrigin + "/redirect"), options)).status, 302);
  assert.equal(requests.length, count + 1);
  await assert.rejects(transport(new Request(plainOrigin + "/large"), options), /too large/);
  await assert.rejects(client.call("https://api.example", "/status", {}, privateKey,
    { transport: async () => new Response("invalid-secret-not-json") }),
    error => !error.message.includes("invalid-secret"));
});

test("Bash recovery preserves active key on rejection, commits on success and invalidates old key", async () => {
  fs.writeFileSync(path.join(dir, "token"), "recovery-secret", { mode: 0o600 });
  rejectRecovery = true;
  await assert.rejects(bash('if ! sandhost_confirm_recovery "$SANDHOST_DIR/token"; then exit 7; fi'));
  assert.equal(fs.readFileSync(path.join(dir, "id_rsa"), "utf8"), privateKey);
  assert.ok(fs.existsSync(path.join(dir, "id_rsa.recovery")));
  rejectRecovery = false;
  await bash('sandhost_confirm_recovery "$SANDHOST_DIR/token"');
  assert.notEqual(fs.readFileSync(path.join(dir, "id_rsa"), "utf8"), privateKey);
  assert.equal(fs.statSync(path.join(dir, "id_rsa")).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(dir, "id_rsa.before-recovery"), "utf8"), privateKey);
  await assert.rejects(client.call(plainOrigin, "/status", { rawHostname: "alice" }, privateKey,
    { allowLocalHttp: true, apiToken: "test-webkey" }), /HTTP 403/);
  await bash('sandhost_request /status "$SANDHOST_DIR/id_rsa" rawHostname alice');
});

function mockUpdater(addressMode, ipAddress, remote, observed = "8.8.8.8") {
  const paths = [];
  const updater = new Updater({ origin: "https://api.example", rawHostname: "alice", privateKey,
    apiToken: "test-webkey", addressMode, ipAddress, localAddress: "192.168.1.5",
    request: async (req, options) => {
      assert.equal(options.localAddress, "192.168.1.5");
      const p = new URL(req.url).pathname;
      paths.push(p);
      if (p === "/check-ip") return Response.json({ ipAddress: observed });
      const fields = Object.fromEntries(new URLSearchParams(await req.text()));
      if (p === "/set-address-mode") remote = { ...remote, addressMode: fields.addressMode };
      if (p === "/update-address") remote = { ...remote, ipAddress: fields.ipAddress };
      if (p === "/update") remote = { ...remote, ipAddress: observed };
      return Response.json(remote);
    } });
  return { updater, paths };
}

test("updater refreshes on startup, skips unchanged IP, updates changes and never discovers in explicit mode", async () => {
  let { updater, paths } = mockUpdater("observed", "", { addressMode: "observed", ipAddress: "8.8.8.8", publication: "synced" });
  await updater.check(); await updater.check();
  assert.deepEqual(paths, ["/status", "/check-ip", "/check-ip"]);
  ({ updater, paths } = mockUpdater("observed", "", { addressMode: "observed", ipAddress: "1.1.1.1", publication: "synced" }));
  await updater.check(); assert.deepEqual(paths, ["/status", "/check-ip", "/update"]);
  ({ updater, paths } = mockUpdater("explicit", "100.64.1.2", { addressMode: "explicit", ipAddress: "100.64.1.1", publication: "synced" }));
  await updater.check(); await updater.check(); assert.deepEqual(paths, ["/status", "/update-address"]);
  ({ updater, paths } = mockUpdater("explicit", "100.64.1.2", { addressMode: "observed", publication: "synced" }));
  await updater.check(); await updater.check(); assert.deepEqual(paths, ["/status", "/set-address-mode", "/update-address"]);
  ({ updater, paths } = mockUpdater("observed", "", { publication: "pending" }));
  await updater.check(); assert.deepEqual(paths, ["/status", "/status"]);
  const wrongDomain = new Updater({ origin: "https://api.example", rawHostname: "alice", privateKey,
    baseDomain: "sandcats.org", request: async () => Response.json({ hostname: "alice.sandhost.org" }) });
  await assert.rejects(wrongDomain.check(), /does not match/);
});

test("polling waits for completion, backs off after errors, and stops cleanly", async () => {
  const scheduled = [];
  let reject;
  const updater = { check: () => new Promise((_, r) => { reject = r; }) };
  let cancelled;
  const stop = startUpdater(updater, { random: () => 0.5, schedule: (fn, delay) => {
    scheduled.push({ fn, delay }); return scheduled.length;
  }, cancel: id => { cancelled = id; } });
  assert.equal(scheduled[0].delay, 0);
  const pending = scheduled[0].fn();
  assert.equal(scheduled.length, 1);
  reject(new Error("offline")); await pending;
  assert.equal(scheduled[1].delay, 120000);
  updater.check = async () => {};
  await scheduled[1].fn();
  assert.equal(scheduled[2].delay, 60000);
  stop(); assert.equal(cancelled, 3);
});

test("ACME preserves concurrent TXT values, restricts hostname, waits for publication", async () => {
  const values = new Set();
  const paths = [];
  let pending = false;
  const adapter = acme.create({ hostname: "alice", baseDomain: "sandhost.org", origin: "https://api.example", key: privateKey,
    publicationTimeout: 0, request: async req => {
      paths.push(new URL(req.url).pathname);
      const fields = Object.fromEntries(new URLSearchParams(await req.text()));
      if (fields.action === "remove") values.delete(fields.value);
      else if (fields.value) values.add(fields.value);
      return Response.json({ publication: pending ? "pending" : "synced" });
    } });
  const one = { dnsHost: "_acme-challenge.alice.sandhost.org", dnsAuthorization: "one" };
  const two = { ...one, dnsAuthorization: "two" };
  await Promise.all([adapter.set({ challenge: one }), adapter.set({ challenge: two })]);
  assert.deepEqual([...values].sort(), ["one", "two"]);
  await adapter.remove({ challenge: one }); assert.deepEqual([...values], ["two"]);
  await assert.rejects(adapter.set({ challenge: { ...one, dnsHost: "_acme-challenge.other.sandhost.org" } }), /hostname/);
  assert.equal(paths.length, 3);
  pending = true;
  await assert.rejects(adapter.set({ challenge: one }), /pending/);
  let polls = 0;
  const delayed = acme.create({ hostname: "alice", baseDomain: "sandhost.org", origin: "https://api.example", key: privateKey,
    request: async req => {
      polls++;
      return Response.json({ publication: new URL(req.url).pathname === "/status" ? "synced" : "pending" });
    } });
  await delayed.set({ challenge: one });
  assert.equal(polls, 2);
});

test("installer configures new backend in Bash, persists only public settings, and rejects bad unattended input", async () => {
  const root = path.resolve(__dirname, "..");
  const installer = fs.readFileSync(path.join(root, "install.sh"), "utf8");
  const configure = installer.slice(installer.indexOf("\nsandhost_configure() {"),
    installer.indexOf("\n# BEGIN EMBEDDED SANDHOST CLIENT"));
  const save = installer.slice(installer.indexOf("\nsave_config() {"),
    installer.indexOf("\ndownload_latest_bundle_and_extract_if_needed() {"));
  const installation = path.join(dir, "installation");
  fs.mkdirSync(path.join(installation, "var/sandcats"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(installation, "var/sandcats/id_rsa"), privateKey, { mode: 0o600 });
  const harness = path.join(dir, "installer-harness.sh");
  fs.writeFileSync(harness, `set -euo pipefail
source "$TEST_ROOT/sandcats-v2.sh"
prompt() { printf '%s' "$2"; }
fail() { echo "$1" >&2; exit 1; }
sandcats_generate_keys() { :; }
writeConfig() { for name in "$@"; do printf '%s=%s\\n' "$name" "${"${!name}"}"; done; }
${configure}
${save}
SANDCATS_BACKEND=sandhost
USE_DEFAULTS=yes
CURRENTLY_UID_ZERO=no
SANDCATS_ADDRESS_MODE="${"${SANDCATS_ADDRESS_MODE:-}"}"
SANDCATS_IP_ADDRESS="${"${SANDCATS_IP_ADDRESS:-}"}"
sandhost_configure
SERVER_USER=sandstorm PORT=80 MONGO_PORT=6081 BIND_IP=0.0.0.0
BASE_URL="https://$SS_HOSTNAME" WILDCARD_HOST="*.$SS_HOSTNAME"
UPDATE_CHANNEL=none ALLOW_DEV_ACCOUNTS=false SMTP_LISTEN_PORT=30025 HTTPS_PORT=443
save_config
`);
  const env = { ...process.env, TEST_ROOT: root, CURL_CA_BUNDLE: path.join(dir, "tls.crt"),
    SANDCATS_API_WEBKEY: origin + "/#test-webkey", DESIRED_SANDCATS_NAME: "alice",
    SANDCATS_BASE_DOMAIN: "sandhost.org", SANDCATS_REGISTRATION_EMAIL: "a+b &ü@example.com" };
  const result = await run("bash", [harness], { cwd: installation, env });
  assert.ok(!result.stdout.includes("test-webkey"));
  const conf = fs.readFileSync(path.join(installation, "sandstorm.conf"), "utf8");
  assert.match(conf, /SANDCATS_BACKEND=sandhost/);
  assert.match(conf, /SANDCATS_ADDRESS_MODE=observed/);
  assert.match(conf, /BASE_URL=https:\/\/alice.sandhost.org/);
  assert.ok(!conf.includes("test-webkey") && !conf.includes(origin));
  const directEnv = { ...env, SANDCATS_API_WEBKEY: origin + "#test-webkey" };
  const direct = await run("bash", [harness], { cwd: installation, env: directEnv });
  assert.ok(!(direct.stdout + direct.stderr).includes("test-webkey"));
  assert.equal(fs.readFileSync(path.join(installation, "var/sandcats/api-webkey"), "utf8"), origin + "#test-webkey\n");
  assert.ok(!fs.readFileSync(path.join(installation, "sandstorm.conf"), "utf8").includes("test-webkey"));
  for (const name of ["invalid.name", "taken"]) {
    await assert.rejects(run("bash", [harness], { cwd: installation, env: { ...env, DESIRED_SANDCATS_NAME: name } }), /E_SANDCATS_REGISTER/);
  }
  await assert.rejects(run("bash", [harness], { cwd: installation, env: { ...env, SANDCATS_BASE_DOMAIN: "sandcats.org" } }),
    /different hostname/);
  execFileSync("python3", ["tests/sync-sandcats-installer.py", "--check"], { cwd: root });
});

test("installer sudo handoff preserves the API webkey", async () => {
  const root = path.resolve(__dirname, "..");
  const installer = fs.readFileSync(path.join(root, "install.sh"), "utf8");
  const rerun = installer.slice(installer.indexOf("\nrerun_script_as_root() {"), installer.indexOf("\nset_umask() {"));
  const bin = path.join(dir, "fake-sudo-bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "sudo"), `#!/bin/bash
set -eu
[[ "$SANDCATS_API_WEBKEY" == https://api.example#test-token ]]
[[ "$1" == --preserve-env=SANDCATS_API_WEBKEY ]]
echo preserved
`, { mode: 0o700 });
  const result = await run("bash", ["-c", `${rerun}
SCRIPT_NAME="$0"
ORIGINAL_ARGS=()
CURL_USER_AGENT=testing
rerun_script_as_root CHOSEN_INSTALL_MODE=production
`, path.join(root, "install.sh")], { cwd: root,
    env: { ...process.env, PATH: bin + ":" + process.env.PATH, SANDCATS_API_WEBKEY: "https://api.example#test-token" } });
  assert.match(result.stdout, /preserved/);
});

test("installer passes an explicit ACME directory and preserves the production default", async () => {
  const root = path.resolve(__dirname, "..");
  const installer = fs.readFileSync(path.join(root, "install.sh"), "utf8");
  const configure = installer.slice(installer.indexOf("\nconfigure_https() {"),
    installer.indexOf("\n# Now that the steps exist"));
  const fixture = path.join(dir, "acme-installer");
  fs.mkdirSync(fixture);
  const calls = path.join(fixture, "calls");
  fs.writeFileSync(path.join(fixture, "sandstorm"), '#!/bin/bash\nprintf "%s\\n" "$@" >> "$CALLS"\n', { mode: 0o700 });
  const script = configure + '\nUSE_HTTPS=yes\nACME_EMAIL=test@example.com\nconfigure_https\n';
  for (const directory of ["", "https://acme-staging-v02.api.letsencrypt.org/directory"]) {
    fs.writeFileSync(calls, "");
    await run("bash", ["-eu", "-c", script], { env: { ...process.env, DIR: fixture, CALLS: calls, ACME_DIRECTORY: directory } });
    assert.deepEqual(fs.readFileSync(calls, "utf8").trim().split("\n"), [
      "create-acme-account", "test@example.com", "--accept-terms",
      ...(directory ? ["--directory", directory] : []), "renew-certificate",
    ]);
  }
});
