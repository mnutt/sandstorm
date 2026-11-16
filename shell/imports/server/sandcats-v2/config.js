"use strict";

const fs = require("node:fs");
const { isIP } = require("node:net");

function parseWebkey(value) {
  if (typeof value !== "string" || !URL.canParse(value.trim())) {
    throw new Error("Invalid Sandcats API webkey URL");
  }
  const url = new URL(value.trim());
  if (url.protocol !== "https:" || url.username || url.password ||
      url.pathname !== "/" || url.search || !/^#[A-Za-z0-9_-]+$/.test(url.hash)) {
    throw new Error("Sandcats API webkey must be https://API-HOST/#TOKEN");
  }
  return { origin: url.origin, apiToken: url.hash.slice(1) };
}

function readWebkey(path) {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 8192) {
      throw new Error("Sandcats API webkey must be a regular file");
    }
    return parseWebkey(fs.readFileSync(fd, "utf8"));
  } finally {
    fs.closeSync(fd);
  }
}

function explicitAddress(value) {
  if (isIP(value) !== 4 || !value.startsWith("100.") ||
      Number(value.split(".")[1]) < 64 || Number(value.split(".")[1]) > 127) {
    throw new Error("Explicit Sandcats address must be a Tailscale IPv4 in 100.64.0.0/10");
  }
  return value;
}

function addressConfig(mode = "observed", ipAddress = "") {
  if (mode === "explicit") return { addressMode: mode, ipAddress: explicitAddress(ipAddress) };
  if (mode !== "observed" || ipAddress) throw new Error("Invalid Sandcats address mode/configuration");
  return { addressMode: mode };
}

function localAddress(bindIp) {
  return !bindIp || bindIp.startsWith("127.") || bindIp === "::1" || bindIp === "0.0.0.0"
    ? undefined : bindIp;
}

module.exports = { parseWebkey, readWebkey, explicitAddress, addressConfig, localAddress };
