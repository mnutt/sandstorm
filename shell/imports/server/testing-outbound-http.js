// Local-only integration fixture, registered exclusively in IS_TESTING mode.
/* global Assets */
import { Meteor } from "meteor/meteor";
import { check } from "meteor/check";
import { Random } from "meteor/random";
import Https from "https";
import Tls from "tls";
import assert from "assert/strict";
import Capnp from "/imports/server/capnp";
import { globalDb } from "/imports/db-deprecated";
import { frontendRefRegistry } from "/imports/server/frontend-ref-registry-instance";
import { restoreInternal } from "/imports/server/core";
import { hashSturdyRef } from "/imports/server/persistent";
import { isTesting } from "/imports/shared/testing";

const Outbound = Capnp.importSystem("sandstorm/outbound-http-session.capnp").OutboundHttpSession;
const ByteStream = Capnp.importSystem("sandstorm/util.capnp").ByteStream;
const Persistent = Capnp.importSystem("sandstorm/supervisor.capnp").SystemPersistent;

export function registerOutboundHttpTests() {
  if (!isTesting) throw new Error("Outbound integration fixtures require test mode.");
  let fixture;
  const cleanup = async () => {
    if (!fixture) return;
    const old = fixture;
    fixture = undefined;
    clearTimeout(old.timer);
    old.server.closeAllConnections();
    old.server.close();
    Tls.setDefaultCACertificates(old.cas);
    for (const [name, value] of Object.entries(old.proxy)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await globalDb.collections.apiTokens.removeAsync({
      $or: [{ "owner.clientPowerboxRequest.sessionId": old.id }, { _id: { $in: old.tokens } }],
    });
    await globalDb.collections.sessions.removeAsync(old.id);
  };
  Meteor.methods({
    async testPrepareManagedOutboundHttp(kind = "bearer") {
      check(kind, String);
      assert.ok(["bearer", "queryKey", "sigV4"].includes(kind));
      await cleanup();
      const cert = await Assets.getTextAsync("testing/outbound-http.crt");
      const key = await Assets.getTextAsync("testing/outbound-http.key");
      const server = Https.createServer({ key, cert }, (req, res) => {
        const authenticated = kind === "bearer" ? req.headers.authorization === "Bearer browser-test-key" :
          kind === "queryKey" ? new URL(req.url, "https://localhost").searchParams.get("api_key") === "browser-test-key" :
          req.headers.authorization?.startsWith("AWS4-HMAC-SHA256 Credential=browser-test-key/") &&
            req.headers["x-amz-security-token"] === "browser-test-key" &&
            req.headers["x-amz-content-sha256"] === "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
        if (!authenticated || req.method !== "POST") {
          res.writeHead(403); res.end("unexpected request"); return;
        }
        req.resume();
        req.on("end", () => { res.writeHead(201); res.end("managed response"); });
      });
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      const id = "outbound-review-" + Random.id();
      const proxy = {};
      for (const name of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"]) {
        proxy[name] = process.env[name];
        delete process.env[name];
      }
      fixture = { id, server, proxy, cas: Tls.getCACertificates("default"), tokens: [],
        connection: this.connection.id };
      Tls.setDefaultCACertificates([...fixture.cas, cert]);
      fixture.timer = setTimeout(() => { cleanup().catch(() => {}); }, 60000);
      const record = { _id: id, grainId: id };
      if (this.userId) record.userId = this.userId;
      await globalDb.collections.sessions.insertAsync(record);
      const baseUrl = `https://127.0.0.1:${server.address().port}/api`;
      const declaration = kind === "queryKey" ? { kind, parameterName: "api_key" } :
        kind === "sigV4" ? { kind, region: "auto" } : { kind };
      const options = await frontendRefRegistry.query(globalDb, this.userId, {
        id: Outbound.typeId,
        value: Capnp.serialize(Outbound.PowerboxTag, { baseUrl, methods: ["post"],
          authenticationMethods: [declaration] }),
      });
      return { sessionId: id, option: options[0] };
    },

    async testVerifyManagedOutboundHttp(sessionId, sturdyRef) {
      check(sessionId, String); check(sturdyRef, String);
      assert.ok(fixture && fixture.id === sessionId && fixture.connection === this.connection.id);
      let cap;
      let saved;
      let sink;
      try {
        const id = hashSturdyRef(sturdyRef);
        const stored = await globalDb.collections.apiTokens.findOneAsync(id);
        assert.equal(stored.owner.clientPowerboxRequest.sessionId, sessionId);
        assert.equal(stored.frontendRef.outboundHttp.auth, undefined);
        assert.equal(stored.frontendRef.outboundHttp.encryptedCredentials.version, 1);
        assert.ok(!JSON.stringify(stored).includes("browser-test-key"));
        cap = (await restoreInternal(globalDb, sturdyRef,
          { clientPowerboxRequest: { grainId: sessionId, sessionId } }, [])).cap.castAs(Outbound);
        // Claiming a temporary Powerbox handoff copies it into a durable root grant.
        // Revocation must be tested against that claimed root, not the disposable handoff.
        saved = cap.castAs(Persistent);
        const claimedKey = (await saved.save({ frontend: null })).sturdyRef.toString();
        const claimedId = hashSturdyRef(claimedKey);
        fixture.tokens.push(claimedId);
        saved.close(); saved = undefined;
        cap.close();
        await globalDb.collections.apiTokens.updateAsync(id, { $set: { revoked: true } });
        cap = (await restoreInternal(globalDb, claimedKey, { frontend: null }, [])).cap.castAs(Outbound);
        let complete;
        const body = new Promise(resolve => { complete = resolve; });
        const chunks = [];
        sink = new Capnp.Capability({ write(data) { chunks.push(Buffer.from(data)); },
          done() { complete(Buffer.concat(chunks).toString()); } }, ByteStream);
        const response = await cap.request("post", "echo", [], Buffer.from("hello"), sink);
        assert.equal(response.statusCode, 201);
        assert.equal(await body, "managed response");
        await assert.rejects(cap.request("get", "echo", [], Buffer.alloc(0), sink));
        await assert.rejects(cap.request("post", "echo",
          [{ name: "Authorization", value: "override" }], Buffer.alloc(0), sink));
        saved = cap.castAs(Persistent);
        const childKey = (await saved.save({ frontend: null })).sturdyRef.toString();
        fixture.tokens.push(hashSturdyRef(childKey));
        await globalDb.collections.apiTokens.updateAsync(claimedId, { $set: { revoked: true } });
        await assert.rejects(cap.request("post", "echo", [], Buffer.alloc(0), sink));
        await assert.rejects(saved.save({ frontend: null }));
        await assert.rejects(restoreInternal(globalDb, childKey, { frontend: null }, []));
        return { encrypted: true, restored: true, requested: true, revoked: true };
      } finally {
        sink?.close(); saved?.close(); cap?.close();
        await cleanup();
      }
    },
  });
}
