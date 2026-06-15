import message from "message.txt";
import metadata from "metadata.json";
import {
  ClaimedCapability,
  RpcTarget,
  SavedCapability,
  sandstorm,
  powerbox as sandstormPowerbox,
} from "sandstorm:api";

let disposedCounterCapabilities = 0;

function makeBytes(size) {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < bytes.length; ++i) {
    bytes[i] = i & 0xff;
  }
  return bytes;
}

function checksum(bytes) {
  let sum = 0;
  for (const byte of bytes) {
    sum = (sum + byte) >>> 0;
  }
  return sum;
}

class CounterCapability extends RpcTarget {
  #value = 0;
  #retained = null;

  increment(amount = 1) {
    this.#value += Number(amount);
    return { value: this.#value };
  }

  get() {
    return { value: this.#value };
  }

  child() {
    return new CounterCapability();
  }

  async readOther(other) {
    return other.call("get");
  }

  async retainOther(other) {
    if (this.#retained) {
      await this.#retained.drop();
    }
    this.#retained = await other.dup();
    return this.#retained.call("get");
  }

  async readRetained() {
    if (!this.#retained) {
      throw new Error("no retained capability");
    }
    return this.#retained.call("get");
  }

  async dropRetained() {
    if (!this.#retained) {
      return { ok: true, dropped: false };
    }
    const dropped = await this.#retained.drop();
    this.#retained = null;
    return dropped;
  }

  fail(message = "counter failure") {
    throw new Error(String(message));
  }

  [Symbol.dispose]() {
    disposedCounterCapabilities += 1;
  }
}

export default {
  async fetch(request, env, ctx) {
    const api = sandstorm(request, env);
    const internalResponse = api.serveRpc(() => new CounterCapability(), {
      clientScriptPath: "/__sandstorm/test-rpc-client.js",
      rpcPath: "/__sandstorm/test-rpc",
    });
    if (internalResponse) return internalResponse;

    const url = new URL(request.url);
    const headers = {};
    for (const [name, value] of request.headers) {
      if (name.startsWith("x-sandstorm-") || name === "host" ||
          name === "if-match" || name === "if-none-match") {
        headers[name] = value;
      }
    }

    if (url.pathname === "/echo") {
      const body = new Uint8Array(await request.arrayBuffer());
      return Response.json({
        ok: true,
        method: request.method,
        bodyBytes: body.length,
        checksum: checksum(body),
        contentType: request.headers.get("content-type"),
        customHeader: request.headers.get("x-isolate-test"),
      });
    }

    if (url.pathname === "/service-target") {
      const body = await request.text();
      return Response.json({
        ok: true,
        source: "loopback-service-target",
        method: request.method,
        pathname: url.pathname,
        search: url.search,
        body,
        customHeader: request.headers.get("x-isolate-service-test"),
      });
    }

    if (url.pathname === "/service-loopback") {
      const targetResponse = await env.LOOPBACK_SERVICE.fetch(
        "http://loopback/service-target?source=service-binding",
        {
          method: "POST",
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "x-isolate-service-test": "present",
          },
          body: "hello through service binding",
        });
      return Response.json({
        ok: true,
        status: targetResponse.status,
        body: await targetResponse.json(),
      });
    }

    if (url.pathname === "/upload") {
      const body = new Uint8Array(await request.arrayBuffer());
      return Response.json({
        ok: true,
        method: request.method,
        bodyBytes: body.length,
        checksum: checksum(body),
        contentType: request.headers.get("content-type"),
      });
    }

    if (url.pathname === "/download" || url.pathname === "/exported/download") {
      const size = Math.min(Number(url.searchParams.get("bytes") || "0"), 1024 * 1024);
      return new Response(makeBytes(size), {
        headers: {
          "content-type": "application/octet-stream",
          "x-isolate-test-bytes": String(size),
          "x-isolate-test-checksum": String(checksum(makeBytes(size))),
          "x-sandstorm-app-download-bytes": String(size),
        },
      });
    }

    if (url.pathname === "/range") {
      const bytes = makeBytes(256);
      const range = request.headers.get("range");
      if (range !== "bytes=10-19") {
        return Response.json({ ok: false, range }, { status: 400 });
      }

      return new Response(bytes.slice(10, 20), {
        status: 206,
        headers: {
          "content-type": "application/octet-stream",
          "accept-ranges": "bytes",
          "content-range": "bytes 10-19/256",
          "x-sandstorm-app-range-response": "present",
        },
      });
    }

    if (url.pathname === "/headers") {
      return new Response("header response", {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
          "x-isolate-test": "present",
          "x-sandstorm-app-test-response": "present",
        },
      });
    }

    if (url.pathname === "/cache-revalidate") {
      return new Response("cache revalidate", {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "private, max-age=0",
        },
      });
    }

    if (url.pathname === "/cache-immutable") {
      return new Response("cache immutable", {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    }

    if (url.pathname === "/attachment") {
      return new Response("attachment body", {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "content-disposition": "attachment; filename=\"fixture.txt\"",
          "etag": "\"fixture-etag\"",
        },
      });
    }

    if (url.pathname === "/redirect") {
      return Response.redirect("https://example.invalid/next", 303);
    }

    if (url.pathname === "/empty") {
      return new Response(null, {
        status: 204,
        headers: { "etag": "W/\"empty-etag\"" },
      });
    }

    if (url.pathname === "/not-modified") {
      return new Response(null, {
        status: 304,
        headers: { "etag": "\"not-modified-etag\"" },
      });
    }

    if (url.pathname === "/error") {
      return new Response("fixture failure", {
        status: 418,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (url.pathname === "/offer-session") {
      const api = sandstorm(request, env);
      const powerbox = sandstormPowerbox(request, env);
      const offered = powerbox.offeredCapability();
      const offeredInfo = powerbox.offeredCapabilityInfo();
      let fetched = null;
      let drop = null;
      if (offered) {
        const fetchedResponse = await offered.fetch("/capability-echo?source=offer-session");
        fetched = {
          status: fetchedResponse.status,
          body: await fetchedResponse.json(),
        };
        drop = await offered.drop();
      }
      return Response.json({
        ok: Boolean(offered),
        sessionType: request.headers.get("x-sandstorm-session-type"),
        offeredCapabilityId: request.headers.get("x-sandstorm-offered-capability-id"),
        offeredClass: offered instanceof ClaimedCapability,
        sessionOffer: api.session().offer,
        offeredInfo: offeredInfo ? {
          ...offeredInfo,
          capabilityClass: offeredInfo.capability instanceof ClaimedCapability,
          capability: offeredInfo.capability
              ? JSON.parse(JSON.stringify(offeredInfo.capability))
              : null,
        } : null,
        offered: offered ? JSON.parse(JSON.stringify(offered)) : null,
        fetched,
        drop,
      });
    }

    if (url.pathname === "/exported/capability-echo") {
      const capabilityEchoEtag = "\"capability-echo-etag\"";
      const ifNoneMatch = request.headers.get("if-none-match");
      if (ifNoneMatch === "*" || ifNoneMatch === capabilityEchoEtag) {
        return new Response(null, {
          status: 304,
          headers: { "etag": capabilityEchoEtag },
        });
      }

      const ifMatch = request.headers.get("if-match");
      if (ifMatch !== null && ifMatch !== "*" && ifMatch !== capabilityEchoEtag) {
        return Response.json({
          ok: false,
          source: "exported-web-session",
          pathname: url.pathname,
          search: url.search,
          ifMatch,
        }, {
          status: 412,
          headers: { "etag": capabilityEchoEtag },
        });
      }

      return Response.json({
        ok: true,
        source: "exported-web-session",
        pathname: url.pathname,
        search: url.search,
        sessionType: request.headers.get("x-sandstorm-session-type"),
        appHeader: request.headers.get("x-sandstorm-app-claimed-fetch"),
        blockedHeader: request.headers.get("x-not-forwarded"),
      }, {
        headers: {
          "content-disposition": "attachment; filename=\"capability-echo.json\"",
          "etag": capabilityEchoEtag,
          "x-sandstorm-app-capability-response": "present",
        },
      });
    }

    if (url.pathname === "/export-web-session") {
      const capability = await sandstorm(request, env).webSession({
        pathPrefix: "/exported",
      });
      return Response.json({
        ok: true,
        capabilityClass: capability instanceof ClaimedCapability,
        capability: JSON.parse(JSON.stringify(capability)),
      });
    }

    if (url.pathname === "/api-exported/capability-echo") {
      return Response.json({
        ok: true,
        source: "exported-api-session",
        pathname: url.pathname,
        search: url.search,
        sessionType: request.headers.get("x-sandstorm-session-type"),
      });
    }

    if (url.pathname === "/export-api-session") {
      const capability = await sandstorm(request, env).apiSession({
        pathPrefix: "/api-exported",
      });
      return Response.json({
        ok: true,
        capabilityClass: capability instanceof ClaimedCapability,
        capability: JSON.parse(JSON.stringify(capability)),
      });
    }

    if (url.pathname === "/web-session-save-restore-self-test") {
      const capability = await sandstorm(request, env).webSession({
        pathPrefix: "/exported",
      });
      const saved = await capability.save({ label: "Route-backed WebSession fixture" });
      const dropOriginal = await capability.drop();
      const restored = await saved.restore();
      const fetchedResponse = await restored.fetch("/capability-echo?source=js-restore", {
        headers: {
          "x-sandstorm-app-claimed-fetch": "present",
          "x-not-forwarded": "blocked",
        },
      });
      const fetched = {
        status: fetchedResponse.status,
        headers: {
          contentDisposition: fetchedResponse.headers.get("content-disposition"),
          etag: fetchedResponse.headers.get("etag"),
          appResponseHeader: fetchedResponse.headers.get("x-sandstorm-app-capability-response"),
        },
        body: await fetchedResponse.json(),
      };
      const notModifiedResponse = await restored.fetch("/capability-echo?source=js-not-modified", {
        headers: { "if-none-match": "\"capability-echo-etag\"" },
      });
      const preconditionFailedResponse = await restored.fetch(
          "/capability-echo?source=js-precondition", {
        headers: { "if-match": "\"wrong-etag\"" },
      });
      const dropRestored = await restored.drop();
      const dropSaved = await saved.drop();
      return Response.json({
        ok: true,
        capabilityClass: capability instanceof ClaimedCapability,
        savedClass: saved instanceof SavedCapability,
        restoredClass: restored instanceof ClaimedCapability,
        capability: JSON.parse(JSON.stringify(capability)),
        saved: JSON.parse(JSON.stringify(saved)),
        restored: JSON.parse(JSON.stringify(restored)),
        dropOriginal,
        fetched,
        notModified: {
          status: notModifiedResponse.status,
          etag: notModifiedResponse.headers.get("etag"),
          bodyBytes: (await notModifiedResponse.arrayBuffer()).byteLength,
        },
        preconditionFailed: {
          status: preconditionFailedResponse.status,
          etag: preconditionFailedResponse.headers.get("etag"),
          bodyBytes: (await preconditionFailedResponse.arrayBuffer()).byteLength,
        },
        dropRestored,
        dropSaved,
      });
    }

    if (url.pathname === "/api-session-save-restore-self-test") {
      const capability = await sandstorm(request, env).apiSession({
        pathPrefix: "/api-exported",
      });
      const saved = await capability.save({ label: "Route-backed ApiSession fixture" });
      const dropOriginal = await capability.drop();
      const restored = await saved.restore();
      const fetchedResponse = await restored.fetch("/capability-echo?source=api-js-restore");
      const fetched = {
        status: fetchedResponse.status,
        body: await fetchedResponse.json(),
      };
      const dropRestored = await restored.drop();
      const dropSaved = await saved.drop();
      return Response.json({
        ok: true,
        capabilityClass: capability instanceof ClaimedCapability,
        savedClass: saved instanceof SavedCapability,
        restoredClass: restored instanceof ClaimedCapability,
        capability: JSON.parse(JSON.stringify(capability)),
        saved: JSON.parse(JSON.stringify(saved)),
        restored: JSON.parse(JSON.stringify(restored)),
        dropOriginal,
        fetched,
        dropRestored,
        dropSaved,
      });
    }

    if (url.pathname === "/request-api-session-self-test") {
      const capability = await sandstorm(request, env).powerbox().requestApi({
        canonicalUrl: "https://api.example.test/v1",
        oauthScopes: ["read", "write"],
        requiredPermissions: ["view"],
      });
      const fetchedResponse = await capability.fetch("/capability-echo?source=request-api");
      const fetched = {
        status: fetchedResponse.status,
        body: await fetchedResponse.json(),
      };
      const drop = await capability.drop();
      return Response.json({
        ok: true,
        capabilityClass: capability instanceof ClaimedCapability,
        capability: JSON.parse(JSON.stringify(capability)),
        fetched,
        drop,
      });
    }

    if (url.pathname === "/powerbox-binding-probe") {
      const statusResponse = await env.POWERBOX.fetch("http://sandstorm/status");
      const dropResponse = await env.POWERBOX.fetch(
        "http://sandstorm/powerbox/drop?id=missing", { method: "POST" });
      return Response.json({
        ok: true,
        statusEndpoint: {
          status: statusResponse.status,
          body: await statusResponse.json(),
        },
        powerboxEndpoint: {
          status: dropResponse.status,
          body: await dropResponse.json(),
        },
      });
    }

    if (url.pathname === "/storage-helper-self-test") {
      const store = sandstorm(request, env).storage();
      const bytes = makeBytes(257);
      const putBytes = await store.put("helper-bytes", bytes);
      const readBytes = await store.getBytes("helper-bytes");
      const putJson = await store.putJson("helper-json", {
        fixture: "storage-helper",
        count: 3,
        nested: { ok: true },
      });
      const readJson = await store.getJson("helper-json");
      const missingBytes = await store.getBytes("helper-missing");
      const deletedBytes = await store.delete("helper-bytes");
      const deletedJson = await store.delete("helper-json");

      return Response.json({
        ok: true,
        putBytes,
        readBytes: {
          bytes: readBytes.byteLength,
          checksum: checksum(readBytes),
        },
        putJson,
        readJson,
        missingBytes,
        deletedBytes,
        deletedJson,
      });
    }

    if (url.pathname === "/export-object-capability") {
      const capability = await sandstorm(request, env).capability(new CounterCapability());
      return Response.json({
        ok: true,
        capabilityClass: capability instanceof ClaimedCapability,
        capability: JSON.parse(JSON.stringify(capability)),
      });
    }

    if (url.pathname === "/object-capability-dispose-count") {
      return Response.json({
        ok: true,
        disposed: disposedCounterCapabilities,
      });
    }

    if (url.pathname === "/object-capability-self-test") {
      const capability = await sandstorm(request, env).capability(new CounterCapability());
      const first = await capability.call("increment", 3);
      const second = await capability.call("increment", 4);
      const current = await capability.call("get");
      const child = await capability.call("child");
      const childFirst = await child.call("increment", 11);
      const readChild = await capability.call("readOther", child);
      const stub = capability.asRpc();
      const stubFirst = await stub.increment(2);
      const stubCurrent = await stub.get();
      const stubChild = await stub.child();
      const stubChildFirst = await stubChild.increment(13);
      const stubReadChild = await stub.readOther(stubChild);
      const argumentTarget = new CounterCapability();
      argumentTarget.increment(21);
      const disposeBeforeArgumentTarget = disposedCounterCapabilities;
      const readArgumentTarget = await capability.call("readOther", argumentTarget);
      const disposeAfterArgumentTarget = disposedCounterCapabilities;
      const stubArgumentTarget = new CounterCapability();
      stubArgumentTarget.increment(23);
      const disposeBeforeStubArgumentTarget = disposedCounterCapabilities;
      const stubReadArgumentTarget = await stub.readOther(stubArgumentTarget);
      const disposeAfterStubArgumentTarget = disposedCounterCapabilities;
      const retainedArgumentTarget = new CounterCapability();
      retainedArgumentTarget.increment(31);
      const disposeBeforeRetainedArgumentTarget = disposedCounterCapabilities;
      const retainArgumentTarget = await capability.call("retainOther", retainedArgumentTarget);
      const disposeAfterRetainCall = disposedCounterCapabilities;
      const readRetainedArgumentTarget = await capability.call("readRetained");
      const dropRetainedArgumentTarget = await capability.call("dropRetained");
      const disposeAfterDropRetainedArgumentTarget = disposedCounterCapabilities;
      let sessionActions = null;
      if (url.searchParams.get("sessionActions") === "true") {
        const descriptorOptions = url.searchParams.get("apiDescriptor") === "true"
          ? {
              apiSession: {
                canonicalUrl: "https://api.example.test/v1",
                oauthScopes: ["read", "write"],
              },
            }
          : {};
        const offer = await capability.offer(request, {
          title: "WebSession offered capability",
          requiredPermissions: ["view"],
          ...descriptorOptions,
        });
        const fulfill = await capability.fulfillRequest(request, {
          title: "WebSession fulfilled capability",
          requiredPermissions: ["view"],
          ...descriptorOptions,
        });
        const tied = await capability.tieToUser(request, {
          title: "WebSession tied capability",
          requiredPermissions: ["view"],
        });
        sessionActions = {
          offer,
          fulfill,
          tie: {
            ok: tied.ok,
            claimedClass: tied instanceof ClaimedCapability,
            json: JSON.parse(JSON.stringify(tied)),
          },
          dropTied: await tied.drop(),
        };
      }
      let missing;
      try {
        await capability.call("missingMethod");
      } catch (error) {
        missing = {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
          status: error?.details?.status,
        };
      }
      let saveError;
      try {
        await capability.save({ label: "Transient object capability" });
      } catch (error) {
        saveError = {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
        };
      }
      const duplicate = await capability.dup();
      const duplicateIncrement = await duplicate.call("increment", 5);
      const disposeBeforeDuplicateDrop = disposedCounterCapabilities;
      const dropOriginalWithDuplicateLive = await capability.drop();
      const disposeAfterOriginalDrop = disposedCounterCapabilities;
      const duplicateAfterOriginalDrop = await duplicate.call("get");
      const dropDuplicate = await duplicate.drop();
      const disposeAfterDuplicateDrop = disposedCounterCapabilities;
      const stableCapability = await sandstorm(request, env).capability(new CounterCapability(), {
        id: "stable-counter",
      });
      const stableFirst = await stableCapability.call("increment", 17);
      let stableDuplicateError;
      try {
        await sandstorm(request, env).capability(new CounterCapability(), {
          id: "stable-counter",
        });
      } catch (error) {
        stableDuplicateError = {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
        };
      }
      const stableDrop = await stableCapability.drop();
      const stableRecreated = await sandstorm(request, env).capability(new CounterCapability(), {
        id: "stable-counter",
      });
      const stableRecreatedFirst = await stableRecreated.call("increment", 19);
      const stableRecreatedDrop = await stableRecreated.drop();
      return Response.json({
        ok: true,
        first,
        second,
        current,
        childClass: child instanceof ClaimedCapability,
        child: JSON.parse(JSON.stringify(child)),
        childFirst,
        readChild,
        stubFirst,
        stubCurrent,
        stubChildClass: stubChild instanceof ClaimedCapability,
        stubChild: JSON.parse(JSON.stringify(stubChild)),
        stubChildFirst,
        stubReadChild,
        argumentTarget: {
          read: readArgumentTarget,
          disposeBefore: disposeBeforeArgumentTarget,
          disposeAfter: disposeAfterArgumentTarget,
        },
        stubArgumentTarget: {
          read: stubReadArgumentTarget,
          disposeBefore: disposeBeforeStubArgumentTarget,
          disposeAfter: disposeAfterStubArgumentTarget,
        },
        retainedArgumentTarget: {
          retain: retainArgumentTarget,
          disposeBefore: disposeBeforeRetainedArgumentTarget,
          disposeAfterRetainCall,
          read: readRetainedArgumentTarget,
          drop: dropRetainedArgumentTarget,
          disposeAfterDrop: disposeAfterDropRetainedArgumentTarget,
        },
        stubThenType: typeof stub.then,
        sessionActions,
        missing,
        saveError,
        duplicate: {
          sourceId: capability.id,
          id: duplicate.id,
          increment: duplicateIncrement,
          dropOriginal: dropOriginalWithDuplicateLive,
          disposeBeforeDrop: disposeBeforeDuplicateDrop,
          disposeAfterOriginalDrop,
          afterOriginalDrop: duplicateAfterOriginalDrop,
          dropDuplicate,
          disposeAfterDuplicateDrop,
        },
        stable: {
          first: stableFirst,
          duplicateError: stableDuplicateError,
          drop: stableDrop,
          recreatedFirst: stableRecreatedFirst,
          recreatedDrop: stableRecreatedDrop,
        },
      });
    }

    if (url.pathname === "/claim-powerbox") {
      const sessionId = request.headers.get("x-sandstorm-session-id") || "";
      const token = url.searchParams.get("token") || "";
      const requiredPermissions = url.searchParams.getAll("requiredPermission");
      const permissionQuery = requiredPermissions
        .map((permission) => `&requiredPermission=${encodeURIComponent(permission)}`)
        .join("");
      let claimResponseOk = false;
      let claimResponseStatus = 500;
      let claim;
      if (url.searchParams.get("fetch") === "true") {
        claim = await sandstormPowerbox(request, env).claimRequest(token, {
          requiredPermissions,
        });
        claimResponseOk = true;
        claimResponseStatus = 200;
      } else {
        const claimResponse = await env.SANDSTORM_API.fetch(
          `http://sandstorm/powerbox/claim-request?` +
          `sessionId=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(token)}` +
          permissionQuery,
          { method: "POST" });
        claimResponseOk = claimResponse.ok;
        claimResponseStatus = claimResponse.status;
        claim = await claimResponse.json();
      }
      const claimType = {
        claimedClass: claim instanceof ClaimedCapability,
        json: JSON.parse(JSON.stringify(claim)),
      };
      let save = null;
      let savedCapability = null;
      if (claim.ok && claim.id && url.searchParams.get("save") === "true") {
        const label = url.searchParams.get("label") || "Isolate test saved capability";
        if (typeof claim.save === "function") {
          savedCapability = await claim.save({ label });
          save = {
            status: 200,
            body: savedCapability,
            typed: {
              savedClass: savedCapability instanceof SavedCapability,
              json: JSON.parse(JSON.stringify(savedCapability)),
            },
          };
        } else {
          const saveResponse = await env.SANDSTORM_API.fetch(
            `http://sandstorm/powerbox/save?id=${encodeURIComponent(claim.id)}` +
            `&label=${encodeURIComponent(label)}`,
            { method: "POST" });
          save = {
            status: saveResponse.status,
            body: await saveResponse.json(),
          };
        }
      }
      let stored = null;
      if (save?.body?.ok && save.body.token && url.searchParams.get("store") === "true") {
        const key = url.searchParams.get("storageKey") || "saved-capability-token";
        const putResponse = await env.STORAGE.fetch(`http://storage/${encodeURIComponent(key)}`, {
          method: "PUT",
          body: save.body.token,
        });
        const getResponse = await env.STORAGE.fetch(`http://storage/${encodeURIComponent(key)}`);
        stored = {
          key,
          put: {
            status: putResponse.status,
            body: await putResponse.json(),
          },
          token: await getResponse.text(),
        };
      }
      let restore = null;
      let dropRestored = null;
      let restoredCapability = null;
      const restoreToken = stored?.token || save?.body?.token;
      if (restoreToken && url.searchParams.get("restore") === "true") {
        if (savedCapability && typeof savedCapability.restore === "function") {
          restoredCapability = await savedCapability.restore();
          restore = {
            status: 200,
            body: restoredCapability,
            typed: {
              restoredClass: restoredCapability instanceof ClaimedCapability,
              json: JSON.parse(JSON.stringify(restoredCapability)),
            },
          };
        } else {
          const restoreResponse = await env.SANDSTORM_API.fetch(
            `http://sandstorm/powerbox/restore?token=${encodeURIComponent(restoreToken)}`,
            { method: "POST" });
          restore = {
            status: restoreResponse.status,
            body: await restoreResponse.json(),
          };
        }
        if (restore.body.ok && restore.body.id) {
          if (restoredCapability && typeof restoredCapability.drop === "function") {
            dropRestored = {
              status: 200,
              body: await restoredCapability.drop(),
            };
          } else {
            const dropRestoredResponse = await env.SANDSTORM_API.fetch(
              `http://sandstorm/powerbox/drop?id=${encodeURIComponent(restore.body.id)}`,
              { method: "POST" });
            dropRestored = {
              status: dropRestoredResponse.status,
              body: await dropRestoredResponse.json(),
            };
          }
        }
      }
      let fetched = null;
      if (claim.ok && typeof claim.fetch === "function" && url.searchParams.get("fetch") === "true") {
        const fetchedResponse = await claim.fetch("/capability-echo?source=claim");
        fetched = {
          status: fetchedResponse.status,
          body: await fetchedResponse.json(),
        };
      }
      let offer = null;
      let fulfill = null;
      let tie = null;
      let dropTied = null;
      if (claim.ok && typeof claim.offer === "function" &&
          url.searchParams.get("sessionActions") === "true") {
        offer = await claim.offer(request, {
          title: "WebSession offered capability",
          requiredPermissions,
        });
        fulfill = await claim.fulfillRequest(request, {
          title: "WebSession fulfilled capability",
          requiredPermissions,
        });
        const tiedCapability = await claim.tieToUser(request, {
          title: "WebSession tied capability",
          requiredPermissions,
        });
        tie = {
          ok: tiedCapability.ok,
          claimedClass: tiedCapability instanceof ClaimedCapability,
          json: JSON.parse(JSON.stringify(tiedCapability)),
        };
        dropTied = await tiedCapability.drop();
      }
      let drop = null;
      if (claim.ok && claim.id) {
        if (typeof claim.drop === "function") {
          drop = {
            status: 200,
            body: await claim.drop(),
          };
        } else {
          const dropResponse = await env.SANDSTORM_API.fetch(
            `http://sandstorm/powerbox/drop?id=${encodeURIComponent(claim.id)}`,
            { method: "POST" });
          drop = {
            status: dropResponse.status,
            body: await dropResponse.json(),
          };
        }
      }
      let dropSaved = null;
      if (restoreToken && url.searchParams.get("dropSaved") === "true") {
        if (savedCapability && typeof savedCapability.drop === "function") {
          dropSaved = {
            status: 200,
            body: await savedCapability.drop(),
          };
        } else {
          const dropSavedResponse = await env.SANDSTORM_API.fetch(
            `http://sandstorm/powerbox/drop-saved?token=${encodeURIComponent(restoreToken)}`,
            { method: "POST" });
          dropSaved = {
            status: dropSavedResponse.status,
            body: await dropSavedResponse.json(),
          };
        }
      }
      return Response.json({
        ok: claimResponseOk,
        status: claimResponseStatus,
        sessionId,
        claim,
        claimType,
        save,
        stored,
        restore,
        fetched,
        offer,
        fulfill,
        tie,
        dropTied,
        dropRestored,
        drop,
        dropSaved,
      }, { status: claimResponseStatus });
    }

    if (url.pathname === "/powerbox-storage-helper-self-test") {
      const helper = sandstormPowerbox(request, env);
      const storageKey = "powerbox-storage-helper-token";
      const claimed = await helper.claimAndSave("websession/test+token==", {
        label: "WebSession saved capability",
        storageKey,
        requiredPermissions: ["view"],
      });
      const originalFetch = await claimed.capability.fetch("/capability-echo?source=helper-original");
      const dropOriginal = await claimed.capability.drop();
      const restored = await helper.restoreSaved({ storageKey });
      let restoredFetch = null;
      let dropRestored = null;
      if (restored.capability) {
        const restoredResponse =
          await restored.capability.fetch("/capability-echo?source=helper-restored");
        restoredFetch = {
          status: restoredResponse.status,
          body: await restoredResponse.json(),
        };
        dropRestored = await restored.capability.drop();
      }
      const dropSaved = await helper.dropSavedFromStorage({ storageKey });
      const afterDrop = await helper.restoreSaved({ storageKey });
      return Response.json({
        ok: true,
        claimed: {
          ok: claimed.ok,
          capabilityClass: claimed.capability instanceof ClaimedCapability,
          savedClass: claimed.saved instanceof SavedCapability,
          storageKey: claimed.storageKey,
          token: claimed.token,
        },
        originalFetch: {
          status: originalFetch.status,
          body: await originalFetch.json(),
        },
        dropOriginal,
        restored: {
          ok: restored.ok,
          capabilityClass: restored.capability instanceof ClaimedCapability,
          storageKey: restored.storageKey,
          token: restored.token,
        },
        restoredFetch,
        dropRestored,
        dropSaved,
        afterDrop,
      });
    }

    const apiStatus = await (await env.SANDSTORM_API.fetch("http://sandstorm/status")).json();
    const apiCapabilities =
        await (await env.SANDSTORM_API.fetch("http://sandstorm/capabilities")).json();
    const apiRuntime = await (await env.SANDSTORM_API.fetch("http://sandstorm/runtime")).json();
    const apiModules = await (await env.SANDSTORM_API.fetch("http://sandstorm/modules")).json();
    const apiBindings = await (await env.SANDSTORM_API.fetch("http://sandstorm/bindings")).json();

    const storagePut = await (await env.STORAGE.fetch("http://storage/fixture", {
      method: "PUT",
      body: "stored from isolate",
    })).json();
    const storageHead = await env.STORAGE.fetch("http://storage/fixture", { method: "HEAD" });
    const storageText = await (await env.STORAGE.fetch("http://storage/fixture")).text();
    const storageIndex = await (await env.STORAGE.fetch("http://storage/")).json();
    const storageDelete =
        await (await env.STORAGE.fetch("http://storage/fixture", { method: "DELETE" })).json();
    const storageMissing = await env.STORAGE.fetch("http://storage/fixture");
    const storageIndexAfterDelete = await (await env.STORAGE.fetch("http://storage/")).json();

    return Response.json({
      ok: true,
      method: request.method,
      pathname: url.pathname,
      message,
      metadata,
      textBinding: env.TEXT_BINDING,
      jsonBinding: env.JSON_BINDING,
      sandstormApi: {
        status: apiStatus,
        capabilities: apiCapabilities,
        runtime: apiRuntime,
        modules: apiModules,
        bindings: apiBindings,
      },
      storage: {
        put: storagePut,
        head: {
          status: storageHead.status,
          bytes: storageHead.headers.get("x-sandstorm-storage-bytes"),
        },
        text: storageText,
        index: storageIndex,
        delete: storageDelete,
        missingStatus: storageMissing.status,
        indexAfterDelete: storageIndexAfterDelete,
      },
      headers,
    });
  },
};
