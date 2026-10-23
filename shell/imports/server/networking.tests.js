import Http from "http";
import { globalDb } from "/imports/db-deprecated";
import { ssrfSafeLookup } from "/imports/server/networking";
import {
  Downloader, defaultTransferBackupRequest, setTransferDownloaderDisabledForTests,
  setTransferDownloaderHooksForTests,
} from "/imports/server/transfers-server";

import chai from "chai";
import Url from "url";

import {
  makePinnedLookup,
  parseCidr,
  redirectedRequest,
  selectSafeAddress,
} from "/imports/server/networking";

const { assert } = chai;

describe("Fetch networking security", function () {
  it("matches IPv4 and IPv6 CIDRs", function () {
    assert.isTrue(parseCidr("10.0.0.0/8")("10.2.3.4"));
    assert.isFalse(parseCidr("10.0.0.0/8")("11.2.3.4"));
    assert.isTrue(parseCidr("2001:db8::/32")("2001:db8::42"));
    assert.isFalse(parseCidr("2001:db8::/32")("2001:db9::42"));
  });

  it("returns pinned DNS results in the form requested by Node", function () {
    const lookup = makePinnedLookup("203.0.113.4", 4);

    lookup("ignored.example", { all: false }, (error, address, family) => {
      assert.isNull(error);
      assert.strictEqual(address, "203.0.113.4");
      assert.strictEqual(family, 4);
    });

    lookup("ignored.example", { all: true }, (error, addresses) => {
      assert.isNull(error);
      assert.deepEqual(addresses, [{ address: "203.0.113.4", family: 4 }]);
    });
  });

  it("rejects reserved addresses even when the administrator blacklist is empty", async function () {
    const db = { getSettingAsync: async () => "" };
    const parsed = Url.parse("https://example.test/path");
    const error = await selectSafeAddress(db, parsed, [
      { address: "203.0.113.4", family: 4 },
    ]).then(() => null, error => error);

    assert.instanceOf(error, Error);
    assert.match(error.message, /blacklisted private network address/);
  });

  it("rejects addresses from the administrator blacklist", async function () {
    const db = { getSettingAsync: async () => "8.8.8.0/24" };
    const parsed = Url.parse("https://example.test/path");
    const error = await selectSafeAddress(db, parsed, [
      { address: "8.8.8.8", family: 4 },
    ]).then(() => null, error => error);

    assert.instanceOf(error, Error);
    assert.match(error.message, /blacklisted private network address/);
  });

  it("applies Fetch redirect methods and strips cross-origin credentials", function () {
    const headers = new Headers({
      Authorization: "Bearer secret",
      Cookie: "session=secret",
      "Content-Type": "application/json",
    });
    const response = new Response(null, {
      status: 302,
      headers: { Location: "https://other.example/next" },
    });
    const redirect = redirectedRequest(
      response,
      "https://origin.example/start",
      "POST",
      headers,
      "{}",
    );

    assert.strictEqual(redirect.method, "GET");
    assert.isUndefined(redirect.body);
    assert.isFalse(redirect.headers.has("authorization"));
    assert.isFalse(redirect.headers.has("cookie"));
    assert.isFalse(redirect.headers.has("content-type"));
  });

  it("preserves methods and bodies across 307 redirects", function () {
    const response = new Response(null, {
      status: 307,
      headers: { Location: "/next" },
    });
    const redirect = redirectedRequest(
      response,
      "https://origin.example/start",
      "PUT",
      new Headers(),
      "body",
    );

    assert.strictEqual(redirect.url, "https://origin.example/next");
    assert.strictEqual(redirect.method, "PUT");
    assert.strictEqual(redirect.body, "body");
  });
});

describe("Transfer download addresses", function () {
  this.timeout(15000);
  it("checks rejected inputs and successful controls", async function () {
  const previousBlacklist = await globalDb.collections.settings.findOneAsync("ipBlacklist");
  const hits = [];
  const server = Http.createServer((request, response) => {
    hits.push({ path: request.url, host: request.headers.host });
    response.end("backup fixture");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const source = "http://transfer-test.invalid:" + server.address().port;
  const lookup = address => (hostname, options, callback) => {
    if (hostname !== "transfer-test.invalid") throw new Error("Unexpected lookup hostname");
    callback(null, [{ address, family: 4 }]);
  };
  let downloader;
  let transferId;
  setTransferDownloaderDisabledForTests(true);
  try {
    await globalDb.collections.settings.upsertAsync("ipBlacklist", { value: "127.0.0.0/8" });
    // Earlier transfer phases can see a different answer from the eventual download.
    for (const phase of ["list", "prepare"]) {
      const safe = await ssrfSafeLookup(globalDb, source + "/transfers/" + phase, lookup("93.184.216.34"));
      if (safe.address !== "93.184.216.34") throw new Error("Public-address control failed");
    }
    transferId = await globalDb.collections.incomingTransfers.insertAsync({
      userId: "test-transfer-address", grainId: "test-transfer-address-grain", source,
      downloading: true, remoteFileToken: "test-token",
    });
    setTransferDownloaderHooksForTests({
      request: (source, token) => defaultTransferBackupRequest(source, token, lookup("127.0.0.1")),
    });
    downloader = new Downloader(await globalDb.collections.incomingTransfers.findOneAsync(transferId));
    await downloader.promise;
    if (hits.length !== 0 || !downloader.error || !/blacklisted/.test(downloader.error)) {
      throw new Error("Transfer did not reject the changed destination address: " + downloader.error);
    }

    await globalDb.collections.settings.upsertAsync("ipBlacklist", { value: "" });
    // A successful connection to this otherwise-unresolvable hostname proves the checked
    // address is used by the socket, while the original Host header is retained.
    const request = await defaultTransferBackupRequest(source, "test-token", lookup("127.0.0.1"));
    await new Promise((resolve, reject) => {
      request.once("error", reject);
      request.setTimeout(5000, () => request.destroy(new Error("Transfer control timed out")));
      request.once("response", response => {
        response.once("error", reject);
        response.once("end", resolve);
        response.resume();
      });
      request.end();
    });
    if (hits.length !== 1 || hits[0].path !== "/downloadBackup/test-token" ||
        hits[0].host !== "transfer-test.invalid:" + server.address().port) {
      throw new Error("Allowed download did not retain the original host and path");
    }
    return true;
  } finally {
    if (downloader) { downloader.cancel(); await downloader.promise; }
    setTransferDownloaderHooksForTests(null);
    if (transferId) await globalDb.collections.incomingTransfers.removeAsync(transferId);
    setTransferDownloaderDisabledForTests(false);
    if (previousBlacklist) {
      await globalDb.collections.settings.upsertAsync("ipBlacklist", previousBlacklist);
    } else {
      await globalDb.collections.settings.removeAsync("ipBlacklist");
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  });
});
