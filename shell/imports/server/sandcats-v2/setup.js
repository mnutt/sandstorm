// Standalone setup client, also shipped outside Meteor in the installation bundle.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { generateKeyPairSync } = require("node:crypto");
const { call, publicKey, apiHeaders } = require("./index");
const { transport } = require("./transport");
const { readWebkey, addressConfig, localAddress } = require("./config");

async function main(command, args, env = process.env) {
  const directory = env.SANDHOST_DIR;
  if (!directory) throw new Error("Missing Sandcats data directory");
  const { origin, apiToken } = readWebkey(path.join(directory, "api-webkey"));
  if (command === "validate-webkey") return;
  const address = () => addressConfig(env.SANDCATS_ADDRESS_MODE || "observed", env.SANDCATS_IP_ADDRESS || "");
  if (command === "validate-address") { address(); return; }
  const name = env.DESIRED_SANDCATS_NAME;
  const domain = env.SANDCATS_BASE_DOMAIN;
  if (!/^[a-z0-9]([a-z0-9-]{0,18}[a-z0-9])?$/.test(name || "") ||
      !/^[a-z0-9]+([.-][a-z0-9]+)*\.[a-z]{2,}$/.test(domain || "")) {
    throw new Error("Invalid Sandcats name or base domain");
  }
  const options = { apiToken, localAddress: localAddress(env.BIND_IP) };
  const active = path.join(directory, "id_rsa");
  const signed = async (endpoint, key, fields) => {
    const result = await call(origin, endpoint, { rawHostname: name, ...fields }, key, options);
    if (result.hostname !== `${name}.${domain}`) {
      throw new Error("Sandcats API returned a different hostname; check the base domain and webkey");
    }
    return result;
  };
  switch (command) {
    case "register": {
      const key = fs.readFileSync(active);
      if (!env.SANDCATS_REGISTRATION_EMAIL) throw new Error("Missing recovery email");
      await signed("/register", key, { publicKey: publicKey(key),
        email: env.SANDCATS_REGISTRATION_EMAIL, ...address() });
      break;
    }
    case "request-recovery": {
      const response = await transport(new Request(origin + "/recover", { method: "POST",
        headers: { ...apiHeaders(options), "X-Sandstorm-App-Sandhost": "cats",
          "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ rawHostname: name }).toString() }), options);
      if (!response.ok) throw new Error(`Sandcats API request failed (HTTP ${response.status})`);
      break;
    }
    case "confirm-recovery": {
      const candidate = path.join(directory, "id_rsa.recovery");
      if (!fs.existsSync(candidate)) {
        const key = generateKeyPairSync("rsa", { modulusLength: 4096,
          publicKeyEncoding: { type: "spki", format: "pem" },
          privateKeyEncoding: { type: "pkcs8", format: "pem" } }).privateKey;
        fs.writeFileSync(candidate, key, { flag: "wx", mode: 0o600 });
        if (fs.existsSync(active)) {
          const { uid, gid } = fs.statSync(active);
          fs.chownSync(candidate, uid, gid);
        }
      }
      const key = fs.readFileSync(candidate);
      const token = fs.readFileSync(args[0], "utf8").trim();
      await signed("/recover/confirm", key, { publicKey: publicKey(key), token });
      // Retain both the old active key and candidate until confirmation succeeds.
      if (fs.existsSync(active)) {
        const backup = active + ".before-recovery";
        const { uid, gid, mode } = fs.statSync(active);
        fs.copyFileSync(active, backup);
        fs.chmodSync(backup, mode & 0o777);
        fs.chownSync(backup, uid, gid);
      }
      fs.renameSync(candidate, active);
      break;
    }
    default: throw new Error("Unknown Sandcats setup command");
  }
}

if (require.main === module) {
  main(process.argv[2], process.argv.slice(3)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
module.exports = { main };
