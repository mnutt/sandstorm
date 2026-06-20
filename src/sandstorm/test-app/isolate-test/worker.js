import message from "message.txt";
import metadata from "metadata.json";
import {
  ClaimedCapability,
  RpcTarget,
  SANDSTORM_API_VERSION,
  SANDSTORM_CAPNWEB_VERSION,
  SANDSTORM_HELPER_VERSIONS,
  SANDSTORM_RPC_VERSION,
  SavedCapability,
  createClaimedCapabilityNativeAppRpcStub,
  createNativeAppRpcFetchTransport,
  createNativeAppRpcStub,
  dispatchNativeAppRpcCall,
  hydrateNativeAppRpcCall,
  hydrateNativeAppRpcResult,
  hydrateNativeAppRpcValue,
  nativeCapabilitySlot,
  sandstorm,
  serveSystemRoutes,
  serializeNativeAppRpcCall,
  serializeNativeAppRpcCallAsync,
  serializeNativeAppRpcException,
  serializeNativeAppRpcResult,
  serializeNativeAppRpcResultAsync,
  serializeNativeAppRpcValueAsync,
  serializeNativeAppRpcValue,
  powerbox as sandstormPowerbox,
} from "sandstorm:api";

let disposedCounterCapabilities = 0;
const MAX_TEST_DOWNLOAD_BYTES = 70 * 1024 * 1024;
const TEST_PROVIDER_DESCRIPTOR = "EAlQAQEAABEBF1EEAQH_y9-dR8kYld8AUAEBAXsRASIHZm9v";

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

  async readOtherRpc(other) {
    return other.get();
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

class EventReceiver extends RpcTarget {
  #events = [];

  onMailEvent(event) {
    this.#events.push(event);
    return {
      ok: true,
      count: this.#events.length,
      subject: event.subject,
    };
  }

  events() {
    return this.#events.slice();
  }

  [Symbol.dispose]() {
    disposedCounterCapabilities += 1;
  }
}

class MailFeedCapability extends RpcTarget {
  async subscribe(receiver) {
    const result = await receiver.asRpc().onMailEvent({
      subject: "phase-3-live-callback",
      unread: 2,
    });
    return {
      ok: true,
      receiverType: receiver.type,
      result,
    };
  }

  startSession() {
    return new CounterCapability();
  }
}

function renderBrowserPowerboxPage() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Isolate Browser Powerbox</title>
  </head>
  <body>
    <button id="offer" type="button">offer capability</button>
    <button id="request" type="button">request capability</button>
    <pre id="offer-result">not offered</pre>
    <pre id="request-result">not requested</pre>

    <script type="module">
      import { requestAndClaimPowerbox } from "/__sandstorm/test-rpc-client.js";

      const offerResult = document.querySelector("#offer-result");
      const requestResult = document.querySelector("#request-result");

      document.querySelector("#offer").addEventListener("click", async () => {
        offerResult.textContent = "offering";
        try {
          const response = await fetch("/browser-powerbox-offer", { method: "POST" });
          const body = await response.json();
          offerResult.textContent = body.ok ? "offer: success" : JSON.stringify(body);
        } catch (error) {
          offerResult.textContent = (error.message || String(error)) + "\\n" + (error.stack || "");
        }
      });

      document.querySelector("#request").addEventListener("click", async () => {
        requestResult.textContent = "requesting";
        try {
          const requested = await requestAndClaimPowerbox(null, {
            requiredPermissions: ["view"],
          });
          const response = await fetch("/browser-powerbox-finish", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(requested),
          });
          const body = await response.json();
          requestResult.textContent = body.ok ? "request: success " + body.restored.body.source :
            JSON.stringify(body);
        } catch (error) {
          requestResult.textContent = (error.message || String(error)) + "\\n" + (error.stack || "");
        }
      });
    </script>
  </body>
</html>`;
}

function renderBrowserStoragePage() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Isolate Browser Storage</title>
  </head>
  <body>
    <button id="health" type="button">health</button>
    <button id="write" type="button">write storage</button>
    <button id="read" type="button">read storage</button>
    <pre id="health-result">not checked</pre>
    <pre id="write-result">not written</pre>
    <pre id="read-result">not read</pre>

    <script type="module">
      const healthResult = document.querySelector("#health-result");
      const writeResult = document.querySelector("#write-result");
      const readResult = document.querySelector("#read-result");

      async function jsonFetch(path, options) {
        const response = await fetch(path, options);
        const body = await response.json();
        if (!response.ok || !body.ok) {
          throw new Error(JSON.stringify(body));
        }
        return body;
      }

      document.querySelector("#health").addEventListener("click", async () => {
        try {
          const body = await jsonFetch("/browser-storage-health");
          healthResult.textContent = "health: " + body.status;
        } catch (error) {
          healthResult.textContent = error.message || String(error);
        }
      });

      document.querySelector("#write").addEventListener("click", async () => {
        try {
          const body = await jsonFetch("/browser-storage-write", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ value: "persisted across restart" }),
          });
          writeResult.textContent = "write: " + body.value;
        } catch (error) {
          writeResult.textContent = error.message || String(error);
        }
      });

      document.querySelector("#read").addEventListener("click", async () => {
        try {
          const body = await jsonFetch("/browser-storage-read");
          readResult.textContent = "read: " + body.value;
        } catch (error) {
          readResult.textContent = error.message || String(error);
        }
      });
    </script>
  </body>
</html>`;
}

function renderBrowserRpcPage() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Isolate Browser RPC</title>
  </head>
  <body>
    <button id="run-rpc" type="button">run rpc</button>
    <pre id="rpc-result">not run</pre>

    <script type="module">
      import { newSandstormRpcSession } from "/__sandstorm/test-rpc-client.js";

      const result = document.querySelector("#rpc-result");

      document.querySelector("#run-rpc").addEventListener("click", async () => {
        result.textContent = "running";
        try {
          const rpc = newSandstormRpcSession("/__sandstorm/test-rpc");
          const firstPromise = rpc.increment(2);
          const child = rpc.child();
          const childValuePromise = child.increment(5);
          const parentValuePromise = rpc.readOtherRpc(child);
          const currentPromise = rpc.get();
          const [first, childValue, parentValue, current] = await Promise.all([
            firstPromise,
            childValuePromise,
            parentValuePromise,
            currentPromise,
          ]);
          rpc[Symbol.dispose]();
          result.textContent = JSON.stringify({
            ok: true,
            first,
            childValue,
            parentValue,
            current,
          });
        } catch (error) {
          result.textContent = (error.message || String(error)) + "\\n" + (error.stack || "");
        }
      });
    </script>
  </body>
</html>`;
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
    const powerboxResponse = await api.servePowerboxDescriptors();
    if (powerboxResponse) return powerboxResponse;

    const headers = {};
    for (const [name, value] of request.headers) {
      if (name.startsWith("x-sandstorm-") || name === "host" ||
          name === "if-match" || name === "if-none-match" || name === "cookie") {
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

    if (url.pathname === "/browser-powerbox") {
      return new Response(renderBrowserPowerboxPage(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/browser-powerbox-shared/value") {
      return Response.json({
        ok: true,
        source: "isolate-browser-powerbox",
        pathname: url.pathname,
        search: url.search,
      });
    }

    if (url.pathname === "/browser-powerbox-offer" && request.method === "POST") {
      const capability = await api.webSession({
        pathPrefix: "/browser-powerbox-shared",
      });
      const offer = await capability.offer(request, {
        title: "Isolate browser Powerbox capability",
        verbPhrase: "can use isolate browser Powerbox capability",
        description: "Capability offered by the isolate browser Powerbox test route",
        requiredPermissions: ["view"],
      });
      return Response.json({ ok: true, offer });
    }

    if (url.pathname === "/browser-powerbox-finish" && request.method === "POST") {
      const body = await request.json();
      const capability = new ClaimedCapability(env, body.capability?.id || "");
      const saved = await capability.save({ label: "Isolate browser Powerbox test" });
      const dropOriginal = await capability.drop();
      const restored = await saved.restore();
      const restoredResponse = await restored.fetch("/value?source=browser-powerbox");
      const restoredBody = await restoredResponse.json();
      const dropRestored = await restored.drop();
      const dropSaved = await saved.drop();
      return Response.json({
        ok: true,
        saved: JSON.parse(JSON.stringify(saved)),
        dropOriginal,
        restored: {
          status: restoredResponse.status,
          body: restoredBody,
        },
        dropRestored,
        dropSaved,
      });
    }

    if (url.pathname === "/browser-storage-test") {
      return new Response(renderBrowserStoragePage(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/browser-storage-health") {
      return Response.json({
        ok: true,
        status: "ok",
        mainModule: metadata.fixture,
      });
    }

    if (url.pathname === "/browser-storage-write" && request.method === "POST") {
      const body = await request.json();
      const value = String(body.value || "");
      const put = await env.STORAGE.fetch("http://storage/browser-storage-test", {
        method: "PUT",
        body: value,
      });
      const putBody = await put.json();
      return Response.json({
        ok: put.ok && putBody.ok,
        value,
        put: putBody,
      }, { status: put.ok ? 200 : 500 });
    }

    if (url.pathname === "/browser-storage-read") {
      const get = await env.STORAGE.fetch("http://storage/browser-storage-test");
      if (get.status === 404) {
        return Response.json({
          ok: false,
          error: "missing storage value",
        }, { status: 404 });
      }
      const value = await get.text();
      return Response.json({
        ok: get.ok,
        value,
      }, { status: get.ok ? 200 : 500 });
    }

    if (url.pathname === "/browser-rpc-test") {
      return new Response(renderBrowserRpcPage(), {
        headers: { "content-type": "text/html; charset=utf-8" },
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
      const size = Math.min(Number(url.searchParams.get("bytes") || "0"), MAX_TEST_DOWNLOAD_BYTES);
      const bytes = makeBytes(size);
      return new Response(bytes, {
        headers: {
          "content-type": "application/octet-stream",
          "x-isolate-test-bytes": String(size),
          "x-isolate-test-checksum": String(checksum(bytes)),
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

    if (url.pathname === "/set-cookie") {
      return new Response("set-cookie response", {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "set-cookie": "isolate=blocked; Path=/; HttpOnly",
          "x-sandstorm-app-cookie-test": "present",
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

    if (url.pathname === "/error-html") {
      return new Response("<p>fixture html failure</p>", {
        status: 404,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/error-binary") {
      return new Response(makeBytes(1024), {
        status: 500,
        headers: { "content-type": "application/octet-stream" },
      });
    }

    if (url.pathname === "/offer-session") {
      const api = sandstorm(request, env);
      const powerbox = sandstormPowerbox(request, env);
      const offered = powerbox.offeredCapability();
      const offeredInfo = powerbox.offeredCapabilityInfo();
      let fetched = null;
      let drop = null;
      let claimedInfo = null;
      if (offered) {
        claimedInfo = await offered.info();
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
        claimedInfo,
        fetched,
        drop,
      });
    }

    if (url.pathname === "/exported/capability-echo") {
      const requestBytes = new Uint8Array(await request.arrayBuffer());
      const includeBody = url.searchParams.get("source") !== "js-large-post";
      const body = includeBody ? new TextDecoder().decode(requestBytes) : undefined;
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
        method: request.method,
        pathname: url.pathname,
        search: url.search,
        ...(includeBody ? { body } : {}),
        bodyBytes: requestBytes.length,
        checksum: checksum(requestBytes),
        contentType: request.headers.get("content-type"),
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

    if (url.pathname === "/route-prefix-validation-self-test") {
      const results = {};
      try {
        await sandstorm(request, env).webSession({
          pathPrefix: "/exported/..",
        });
        results.dotSegmentPrefix = { ok: true };
      } catch (error) {
        results.dotSegmentPrefix = {
          ok: false,
          error: String(error?.message || error),
        };
      }

      try {
        await sandstorm(request, env).webSession({
          pathPrefix: "/exported",
          dropNotifyPath: "/exported-sibling",
        });
        results.siblingDropNotifyPath = { ok: true };
      } catch (error) {
        results.siblingDropNotifyPath = {
          ok: false,
          error: String(error?.message || error),
        };
      }

      return Response.json({
        ok: true,
        results,
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
      let wrongOutboundError;
      try {
        await capability.asOutboundHttp().fetch("v1/test");
      } catch (error) {
        wrongOutboundError = {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
        };
      }
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
      const postedResponse = await restored.fetch("/capability-echo?source=js-post", {
        method: "POST",
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: "hello through claimed capability fetch",
      });
      const posted = {
        status: postedResponse.status,
        body: await postedResponse.json(),
      };
      const largeBody = makeBytes(2 * 1024 * 1024);
      const largePostResponse = await restored.fetch("/capability-echo?source=js-large-post", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: largeBody,
      });
      const largePost = {
        status: largePostResponse.status,
        body: await largePostResponse.json(),
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
        wrongOutboundError,
        dropOriginal,
        fetched,
        posted,
        largePost,
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
      let wrongOutboundError;
      try {
        await capability.asOutboundHttp().fetch("v1/test");
      } catch (error) {
        wrongOutboundError = {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
        };
      }
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
        wrongOutboundError,
        dropOriginal,
        fetched,
        dropRestored,
        dropSaved,
      });
    }

    if (url.pathname === "/required-permission-validation-self-test") {
      let error = null;
      try {
        await sandstorm(request, env).powerbox().claimRequest("dummy-token", {
          requiredPermissions: ["not-a-permission"],
        });
      } catch (err) {
        error = String(err?.message || err);
      }

      return Response.json({
        ok: Boolean(error),
        error,
      });
    }

    if (url.pathname === "/outbound-http-helper-self-test") {
      const api = sandstorm(request, env);
      const capability = await api.powerbox().claimRequest("outbound-http/test-token", {
        requiredPermissions: ["view"],
        outboundHttp: {
          baseUrl: "https://api.example.test/v1",
          methods: ["POST"],
        },
      });
      const capabilityInfo = await capability.info();
      let fetchError = null;
      try {
        await capability.fetch("/should-not-fetch");
      } catch (error) {
        fetchError = {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
        };
      }
      const outbound = api.powerbox().outboundHttpCapability(capability);
      const response = await outbound.fetch("v1/chat/completions?model=test", {
        method: "POST",
        headers: {
          authorization: "Bearer isolate-test",
          "content-type": "text/plain; charset=utf-8",
        },
        body: "hello",
      });

      return Response.json({
        ok: true,
        capabilityInfo,
        fetchError,
        outboundClass: outbound.constructor.name === "OutboundHttpCapability",
        status: response.status,
        statusText: response.statusText,
        contentType: response.headers.get("content-type"),
        outboundHeader: response.headers.get("x-outbound-test"),
        body: await response.json(),
        drop: await capability.drop(),
      });
    }

    if (url.pathname === "/native-interface-validation-self-test") {
      const calls = [];
      const mockEnv = {
        SANDSTORM_API: {
          async fetch(input, init) {
            calls.push(String(input));
            const parsed = new URL(String(input));
            if (parsed.pathname === "/capabilities/claimed") {
              const id = parsed.searchParams.get("id");
              const appObject = id === "mock-app-object";
              return Response.json({
                ok: true,
                type: "claimedCapabilityInfo",
                id,
                kind: "powerboxClaim",
                residence: "imported",
                nativeInterface: appObject ? "appObject" : "outboundHttpSession",
                pathPrefix: "",
                persistent: true,
                hasDropNotify: false,
                dropNotifyRefCount: 0,
                supportsWebFetch: false,
                supportsOutboundHttpFetch: !appObject,
                supportsNativeAppRpcTransport: appObject,
                hasNativeCapability: true,
                liveForwardable: true,
              });
            }
            if (parsed.pathname === "/powerbox/native-app-rpc-call") {
              return Response.json(await dispatchNativeAppRpcCall(
                nativeRpcTarget, JSON.parse(String(init?.body || "{}"))));
            }
            return Response.json({ ok: false, error: "unexpected mock fetch" }, { status: 500 });
          },
        },
      };
      const capability = new ClaimedCapability(mockEnv, "mock-outbound");
      let fetchError = null;
      try {
        await capability.fetch("/should-not-fetch");
      } catch (error) {
        fetchError = {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
        };
      }
      const appObjectCapability = new ClaimedCapability(mockEnv, "mock-app-object");
      let appObjectFetchError = null;
      try {
        await appObjectCapability.fetch("/should-not-fetch");
      } catch (error) {
        appObjectFetchError = {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
        };
      }
      let appObjectOutboundError = null;
      try {
        await appObjectCapability.asOutboundHttp().fetch("v1/test");
      } catch (error) {
        appObjectOutboundError = {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
        };
      }

      const nativeRpcTransportCalls = [];
      const nativeRpcTarget = {
        deliver(subject, callback, options) {
          return { subject, callback, options };
        },
      };
      const appObjectNativeRpc = appObjectCapability.asRpc({
        transport: async (transportSlot, call) => {
          nativeRpcTransportCalls.push({ slot: transportSlot, call });
          return dispatchNativeAppRpcCall(nativeRpcTarget, call);
        },
      });
      const appObjectNativeValue = await appObjectNativeRpc.deliver(
        "native-subject",
        nativeCapabilitySlot("native-callback", { nativeInterface: "appObject" }),
        { urgent: true });
      const defaultNativeRpc = appObjectCapability.asRpc();
      const defaultNativeRpcValue = await defaultNativeRpc.deliver(
        "default-subject", { urgent: false });
      const defaultCallValue = await appObjectCapability.call(
        "deliver", "call-subject", { urgent: true });

      const helperNativeRpcStub = createClaimedCapabilityNativeAppRpcStub(appObjectCapability, {
        checkInfo: false,
        transport: async (transportSlot, call) => {
          nativeRpcTransportCalls.push({ slot: transportSlot, call });
          return dispatchNativeAppRpcCall(nativeRpcTarget, call);
        },
        release() {
          return { ok: true, released: "mock-app-object" };
        },
      });
      const helperNativeSlot = helperNativeRpcStub.slot;
      const helperNativeDrop = await helperNativeRpcStub.drop();

      const wrongNativeRpcTransportCalls = [];
      let wrongNativeRpcError = null;
      try {
        await capability.asRpc({
          transport: async (transportSlot, call) => {
            wrongNativeRpcTransportCalls.push({ slot: transportSlot, call });
            return dispatchNativeAppRpcCall(nativeRpcTarget, call);
          },
        }).deliver("wrong-interface");
      } catch (error) {
        wrongNativeRpcError = {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
        };
      }

      return Response.json({
        ok: true,
        calls,
        fetchError,
        appObjectFetchError,
        appObjectOutboundError,
        nativeRpcTransportCalls,
        appObjectNativeSlot: appObjectNativeRpc.slot,
        appObjectNativeValue,
        defaultNativeRpcValue,
        defaultCallValue,
        helperNativeSlot,
        helperNativeDrop,
        wrongNativeRpcTransportCalls,
        wrongNativeRpcError,
      });
    }

    if (url.pathname === "/native-app-rpc-codec-self-test") {
      const bytes = makeBytes(5);
      const slot = nativeCapabilitySlot("slot-1", { nativeInterface: "appObject" });
      const savedCapability = new SavedCapability(env, "saved-fixture", "c2F2ZWQtdG9rZW4");
      const value = {
        none: null,
        truthy: true,
        count: 42.5,
        text: "hello",
        bytes,
        items: ["first", 2, false],
        callback: slot,
        saved: savedCapability,
      };
      const serialized = serializeNativeAppRpcValue(value);
      const hydrated = hydrateNativeAppRpcValue(serialized);
      const callEnvelope = serializeNativeAppRpcCall("deliver", [
        "subject",
        slot,
        { urgent: true, saved: savedCapability },
      ]);
      const hydratedCall = hydrateNativeAppRpcCall(callEnvelope);
      const resultEnvelope = serializeNativeAppRpcResult({
        accepted: true,
        receipt: slot,
        saved: savedCapability,
      });
      const resultValue = hydrateNativeAppRpcResult(resultEnvelope);
      const exceptionEnvelope = serializeNativeAppRpcException({
        name: "RemoteAppError",
        message: "remote failure",
        stack: "remote stack",
      });
      const dispatchTarget = {
        async deliver(subject, callback, options) {
          const result = {
            subject,
            callback,
            urgent: options.urgent,
          };
          if (Object.hasOwn(options, "saved")) {
            result.saved = options.saved;
          }
          return result;
        },

        fail() {
          throw new TypeError("native dispatch failure");
        },
      };
      const dispatchResult = await dispatchNativeAppRpcCall(dispatchTarget, callEnvelope);
      const dispatchValue = hydrateNativeAppRpcResult(dispatchResult);
      const missingDispatchResult = await dispatchNativeAppRpcCall(
        dispatchTarget, serializeNativeAppRpcCall("missing", []));
      const failedDispatchResult = await dispatchNativeAppRpcCall(
        dispatchTarget, serializeNativeAppRpcCall("fail", []));
      const stubTransportCalls = [];
      const stub = createNativeAppRpcStub(slot, async (transportSlot, call) => {
        stubTransportCalls.push({ slot: transportSlot, call });
        return dispatchNativeAppRpcCall(dispatchTarget, call);
      });
      const stubCallValue = await stub.call("deliver", "stub-subject", slot, {
        urgent: false,
        saved: savedCapability,
      });
      const stubRpcValue = await stub.asRpc().deliver("rpc-subject", slot, {
        urgent: true,
        saved: savedCapability,
      });

      let stubMissingError = null;
      try {
        await stub.call("missing");
      } catch (error) {
        stubMissingError = {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
          details: {
            name: String(error?.details?.name || ""),
          },
        };
      }

      const droppableTransportCalls = [];
      const droppableReleaseCalls = [];
      const droppableStub = createNativeAppRpcStub(
        slot,
        async (transportSlot, call) => {
          droppableTransportCalls.push({ slot: transportSlot, call });
          return dispatchNativeAppRpcCall(dispatchTarget, call);
        },
        {
          release(releasedSlot) {
            droppableReleaseCalls.push(releasedSlot);
            return { ok: true, released: releasedSlot.id };
          },
        });
      const droppableValue = await droppableStub.call("deliver", "droppable-subject", slot, {
        urgent: false,
      });
      const dropFirst = await droppableStub.drop();
      const dropSecond = await droppableStub.drop();
      const dropViaProxy = await droppableStub.asRpc().drop();
      let callAfterDropError = null;
      try {
        await droppableStub.call("deliver", "after-drop", slot, { urgent: true });
      } catch (error) {
        callAfterDropError = {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
        };
      }

      const resolvedTransportCalls = [];
      const resolverCalls = [];
      const resolveCapabilitySlot = (resolvedSlot, context) => {
        resolverCalls.push({ slot: resolvedSlot, name: context.name });
        return createNativeAppRpcStub(resolvedSlot, async (transportSlot, call) => {
          resolvedTransportCalls.push({ slot: transportSlot, call });
          return dispatchNativeAppRpcCall(dispatchTarget, call);
        });
      };
      const resolvedValue = hydrateNativeAppRpcValue(serialized, { resolveCapabilitySlot });
      const resolvedCall = hydrateNativeAppRpcCall(callEnvelope, { resolveCapabilitySlot });
      const resolvedResult = hydrateNativeAppRpcResult(resultEnvelope, { resolveCapabilitySlot });
      const resolvedCallbackValue = await resolvedValue.callback.call(
        "deliver", "resolved-subject", slot, { urgent: true });

      const exportCapabilitySlotCalls = [];
      const exportCapabilitySlot = async (capability, context) => {
        const id = `exported-slot-${exportCapabilitySlotCalls.length}`;
        exportCapabilitySlotCalls.push({
          name: context.name,
          rpcTargetClass: capability instanceof RpcTarget,
          claimedClass: capability instanceof ClaimedCapability,
          capabilityId: capability instanceof ClaimedCapability ? capability.id : undefined,
          id,
        });
        return nativeCapabilitySlot(id, { nativeInterface: "appObject" });
      };
      const exportedTargetValue = await serializeNativeAppRpcValueAsync(new CounterCapability(), {
        name: "callback",
        exportCapabilitySlot,
      });
      const exportedClaimedValue = await serializeNativeAppRpcValueAsync(
        new ClaimedCapability(env, "mock-app-object"),
        {
          name: "authority",
          exportCapabilitySlot,
        });
      const exportedCallEnvelope = await serializeNativeAppRpcCallAsync("deliver", [
        new CounterCapability(),
        { authority: new ClaimedCapability(env, "mock-app-object") },
      ], { exportCapabilitySlot });
      const exportingStubTransportCalls = [];
      const exportingStub = createNativeAppRpcStub(
        slot,
        async (transportSlot, call) => {
          exportingStubTransportCalls.push({ slot: transportSlot, call });
          return dispatchNativeAppRpcCall(dispatchTarget, call);
        },
        { exportCapabilitySlot });
      const exportingStubValue = await exportingStub.call(
        "deliver", "export-stub-subject", new CounterCapability(), { urgent: false });
      const exportedResultEnvelope = await serializeNativeAppRpcResultAsync({
        child: new CounterCapability(),
        authority: new ClaimedCapability(env, "mock-app-object"),
      }, { exportCapabilitySlot });
      const exportDispatchTarget = {
        makeChild() {
          return new CounterCapability();
        },

        forwardAuthority() {
          return {
            authority: new ClaimedCapability(env, "mock-app-object"),
          };
        },
      };
      const exportedDispatchChild = await dispatchNativeAppRpcCall(
        exportDispatchTarget,
        serializeNativeAppRpcCall("makeChild", []),
        { exportCapabilitySlot });
      const exportedDispatchAuthority = await dispatchNativeAppRpcCall(
        exportDispatchTarget,
        serializeNativeAppRpcCall("forwardAuthority", []),
        { exportCapabilitySlot });

      let rawTargetError = null;
      try {
        serializeNativeAppRpcValue(new CounterCapability(), "callback");
      } catch (error) {
        rawTargetError = {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
        };
      }

      let invalidCapabilityError = null;
      try {
        hydrateNativeAppRpcValue({ type: "capability", value: { id: "" } });
      } catch (error) {
        invalidCapabilityError = {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
        };
      }

      let reservedMethodError = null;
      try {
        serializeNativeAppRpcCall("then", []);
      } catch (error) {
        reservedMethodError = {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
        };
      }

      let duplicateFieldError = null;
      try {
        hydrateNativeAppRpcValue({
          type: "object",
          value: [
            { name: "same", value: { type: "number", value: 1 } },
            { name: "same", value: { type: "number", value: 2 } },
          ],
        });
      } catch (error) {
        duplicateFieldError = {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
        };
      }

      let reservedFieldError = null;
      try {
        hydrateNativeAppRpcValue({
          type: "object",
          value: [
            { name: "__proto__", value: { type: "text", value: "polluted" } },
          ],
        });
      } catch (error) {
        reservedFieldError = {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
        };
      }

      let reservedSerializeFieldError = null;
      try {
        serializeNativeAppRpcValue(Object.create(null, {
          constructor: {
            value: "reserved",
            enumerable: true,
          },
        }));
      } catch (error) {
        reservedSerializeFieldError = {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
        };
      }

      let exceptionError = null;
      try {
        hydrateNativeAppRpcResult(exceptionEnvelope);
      } catch (error) {
        exceptionError = {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
          details: {
            name: String(error?.details?.name || ""),
            stack: String(error?.details?.stack || ""),
          },
        };
      }

      return Response.json({
        ok: true,
        serialized,
        hydrated: {
          ...hydrated,
          bytes: Array.from(hydrated.bytes),
        },
        callEnvelope,
        hydratedCall,
        resultEnvelope,
        resultValue,
        exceptionEnvelope,
        exceptionError,
        dispatchResult,
        dispatchValue,
        missingDispatchResult,
        failedDispatchResult,
        stubSlot: stub.slot,
        stubJson: JSON.parse(JSON.stringify(stub)),
        stubTransportCalls,
        stubCallValue,
        stubRpcValue,
        stubMissingError,
        droppable: {
          value: droppableValue,
          dropFirst,
          dropSecond,
          dropViaProxy,
          callAfterDropError,
          transportCalls: droppableTransportCalls,
          releaseCalls: droppableReleaseCalls,
        },
        resolved: {
          valueCallbackSlot: resolvedValue.callback.slot,
          callCallbackSlot: resolvedCall.args[1].slot,
          resultReceiptSlot: resolvedResult.receipt.slot,
          callbackValue: resolvedCallbackValue,
          transportCalls: resolvedTransportCalls,
          resolverCalls,
        },
        exported: {
          targetValue: exportedTargetValue,
          claimedValue: exportedClaimedValue,
          callEnvelope: exportedCallEnvelope,
          stubValue: exportingStubValue,
          stubTransportCalls: exportingStubTransportCalls,
          resultEnvelope: exportedResultEnvelope,
          dispatchChild: exportedDispatchChild,
          dispatchAuthority: exportedDispatchAuthority,
          exportCalls: exportCapabilitySlotCalls,
        },
        slotFrozen: Object.isFrozen(slot),
        rawTargetError,
        invalidCapabilityError,
        reservedMethodError,
        duplicateFieldError,
        reservedFieldError,
        reservedSerializeFieldError,
      });
    }

    if (url.pathname === "/native-app-rpc-route-self-test") {
      sandstorm(request, env).registerCapability({
        async deliver(subject, options) {
          return {
            subject,
            urgent: options.urgent,
          };
        },

        fail() {
          throw new RangeError("route dispatch failure");
        },
      }, { id: "native-route-target" });

      try {
        const route = "http://worker/__sandstorm/object-capabilities/" +
          "native-route-target/native-app-rpc-call";
        const valueResponse = await serveSystemRoutes(new Request(route, {
          method: "POST",
          body: JSON.stringify(serializeNativeAppRpcCall("deliver", [
            "route-subject",
            { urgent: true },
          ])),
        }), env);
        const missingResponse = await serveSystemRoutes(new Request(route, {
          method: "POST",
          body: JSON.stringify(serializeNativeAppRpcCall("missing", [])),
        }), env);
        const failedResponse = await serveSystemRoutes(new Request(route, {
          method: "POST",
          body: JSON.stringify(serializeNativeAppRpcCall("fail", [])),
        }), env);
        const invalidResponse = await serveSystemRoutes(new Request(route, {
          method: "POST",
          body: JSON.stringify({ method: "then", args: [] }),
        }), env);
        const transportCalls = [];
        const routeStub = createNativeAppRpcStub(
          nativeCapabilitySlot("native-route-target", { nativeInterface: "appObject" }),
          createNativeAppRpcFetchTransport({
            async fetch(input, init) {
              transportCalls.push({ input: String(input), method: init?.method || "GET" });
              return serveSystemRoutes(new Request(input, init), env);
            },
          }, (slot) => `http://worker/__sandstorm/object-capabilities/${slot.id}/` +
            "native-app-rpc-call"));
        const routeStubValue = await routeStub.call("deliver", "stub-route-subject", {
          urgent: false,
        });
        const routeStubRpcValue = await routeStub.asRpc().deliver("stub-rpc-subject", {
          urgent: true,
        });
        let routeStubMissingError = null;
        try {
          await routeStub.call("missing");
        } catch (error) {
          routeStubMissingError = {
            name: String(error?.name || "Error"),
            message: String(error?.message || error),
            details: {
              name: String(error?.details?.name || ""),
            },
          };
        }

        const transportErrorCases = {};
        async function captureTransportError(name, response) {
          const testStub = createNativeAppRpcStub(
            nativeCapabilitySlot(`transport-${name}`, { nativeInterface: "appObject" }),
            createNativeAppRpcFetchTransport({
              async fetch() {
                return response;
              },
            }, "http://worker/native-app-rpc-transport-test"));
          try {
            await testStub.call("deliver");
          } catch (error) {
            transportErrorCases[name] = {
              name: String(error?.name || "Error"),
              message: String(error?.message || error),
              details: {
                status: error?.details?.status,
                body: error?.details?.body,
              },
            };
          }
        }
        await captureTransportError("nonJson", new Response("not-json", { status: 502 }));
        await captureTransportError("invalidEnvelope", Response.json({ ok: false }));
        await captureTransportError("failedStatus", Response.json({
          type: "exception",
          name: "RouteFailure",
          message: "route failed before dispatch",
          stack: "",
        }, { status: 503 }));

        return Response.json({
          ok: true,
          value: {
            status: valueResponse.status,
            body: await valueResponse.json(),
          },
          missing: {
            status: missingResponse.status,
            body: await missingResponse.json(),
          },
          failed: {
            status: failedResponse.status,
            body: await failedResponse.json(),
          },
          invalid: {
            status: invalidResponse.status,
            body: await invalidResponse.json(),
          },
          routeStub: {
            slot: routeStub.slot,
            transportCalls,
            value: routeStubValue,
            rpcValue: routeStubRpcValue,
            missingError: routeStubMissingError,
            transportErrors: transportErrorCases,
          },
        });
      } finally {
        sandstorm(request, env).unregisterCapability({ id: "native-route-target" });
      }
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
      const capabilityInfo = await capability.info();
      const childInfo = await child.info();
      const childFirst = await child.call("increment", 11);
      const readChild = await capability.call("readOther", child);
      const stub = capability.asRpc();
      const stubFirst = await stub.increment(2);
      const stubCurrent = await stub.get();
      const stubChild = await stub.child();
      const stubChildFirst = await stubChild.asRpc().increment(13);
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
      const feedCapability = await sandstorm(request, env).capability(new MailFeedCapability());
      const feed = feedCapability.asRpc();
      const receiver = new EventReceiver();
      const disposeBeforeLiveCallback = disposedCounterCapabilities;
      const subscription = await feed.subscribe(receiver);
      const disposeAfterLiveCallback = disposedCounterCapabilities;
      const session = await feed.startSession();
      const sessionFirst = await session.asRpc().increment(7);
      const sessionDrop = await session.drop();
      const feedDrop = await feedCapability.drop();
      let sessionActions = null;
      if (url.searchParams.get("sessionActions") === "true") {
        let descriptorOptions = {};
        if (url.searchParams.get("apiDescriptor") === "true") {
          descriptorOptions = {
            apiSession: {
              canonicalUrl: "https://api.example.test/v1",
              oauthScopes: ["read", "write"],
            },
          };
        } else if (url.searchParams.get("providerDescriptor") === "true") {
          descriptorOptions = {
            descriptor: TEST_PROVIDER_DESCRIPTOR,
          };
        }
        const offer = await capability.offer(request, {
          title: "WebSession offered capability",
          verbPhrase: "can use offered capability",
          description: "Offered capability description",
          requiredPermissions: ["view"],
          ...descriptorOptions,
        });
        const fulfill = await capability.fulfillRequest(request, {
          title: "WebSession fulfilled capability",
          verbPhrase: "can use fulfilled capability",
          description: "Fulfilled capability description",
          requiredPermissions: ["view"],
          ...descriptorOptions,
        });
        const tied = await capability.tieToUser(request, {
          title: "WebSession tied capability",
          verbPhrase: "can use tied capability",
          description: "Tied capability description",
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
      const remoteTarget = sandstorm(request, env).powerbox().claimedCapability({
        type: "claimedCapability",
        id: "remote-like-capability",
      });
      const remoteArgumentTarget = new CounterCapability();
      remoteArgumentTarget.increment(37);
      let remoteRpcTargetArgumentError;
      try {
        await remoteTarget.call("readOther", remoteArgumentTarget);
      } catch (error) {
        remoteRpcTargetArgumentError = {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
        };
      }
      let remoteClaimedCapabilityArgumentError;
      try {
        await remoteTarget.call("readOther", child);
      } catch (error) {
        remoteClaimedCapabilityArgumentError = {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
        };
      }
      const duplicate = await capability.dup();
      const originalInfoWithDuplicateLive = await capability.info({ refresh: true });
      const duplicateInfoBeforeDrop = await duplicate.info();
      const duplicateIncrement = await duplicate.call("increment", 5);
      const disposeBeforeDuplicateDrop = disposedCounterCapabilities;
      const dropOriginalWithDuplicateLive = await capability.drop();
      const disposeAfterOriginalDrop = disposedCounterCapabilities;
      const duplicateInfoAfterOriginalDrop = await duplicate.info({ refresh: true });
      const duplicateAfterOriginalDrop = await duplicate.call("get");
      const dropDuplicate = await duplicate.drop();
      const duplicateInfoAfterDrop = await duplicate.info({ refresh: true });
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
      let persistentWithoutIdError;
      try {
        await sandstorm(request, env).capability(new CounterCapability(), {
          persistent: true,
        });
      } catch (error) {
        persistentWithoutIdError = {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
        };
      }
      const persistentId = `persistent-counter-${crypto.randomUUID()}`;
      const persistentCapability = await sandstorm(request, env).capability(
        new CounterCapability(), {
          id: persistentId,
          persistent: true,
        });
      const persistentFirst = await persistentCapability.call("increment", 29);
      const persistentSaved = await persistentCapability.save({
        label: "Persistent object capability fixture",
      });
      const persistentRestored = await persistentSaved.restore();
      const persistentRestoredGet = await persistentRestored.call("get");
      const persistentRestoredIncrement = await persistentRestored.call("increment", 3);
      const persistentDropOriginal = await persistentCapability.drop();
      const persistentDropRestored = await persistentRestored.drop();
      const persistentUnregisterOriginal = sandstorm(request, env).unregisterCapability({
        id: persistentId,
      });
      const persistentReplacementTarget = new CounterCapability();
      persistentReplacementTarget.increment(41);
      const persistentRegisterReplacement = sandstorm(request, env).registerCapability(
        persistentReplacementTarget, { id: persistentId });
      const persistentRegisterAgain = sandstorm(request, env).registerCapability(
        persistentReplacementTarget, { id: persistentId });
      let persistentRegisterDuplicateError;
      try {
        sandstorm(request, env).registerCapability(new CounterCapability(), {
          id: persistentId,
        });
      } catch (error) {
        persistentRegisterDuplicateError = {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
        };
      }
      let persistentTransientMintError;
      try {
        await sandstorm(request, env).capability(persistentReplacementTarget, {
          id: persistentId,
        });
      } catch (error) {
        persistentTransientMintError = {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
        };
      }
      const persistentMintedAfterRegister = await sandstorm(request, env).capability(
        persistentReplacementTarget, {
          id: persistentId,
          persistent: true,
        });
      const persistentMintedAfterRegisterGet = await persistentMintedAfterRegister.call("get");
      const persistentDropMintedAfterRegister = await persistentMintedAfterRegister.drop();
      const persistentRestoredAfterRegister = await persistentSaved.restore();
      const persistentRestoredAfterRegisterGet =
        await persistentRestoredAfterRegister.call("get");
      const persistentDropRestoredAfterRegister = await persistentRestoredAfterRegister.drop();
      const persistentDropSaved = await persistentSaved.drop();
      const persistentUnregisterReplacement = sandstorm(request, env).unregisterCapability(
        persistentId);
      let persistentHelper = null;
      if (url.searchParams.get("persistentHelper") === "true") {
        const helperId = `persistent-helper-${crypto.randomUUID()}`;
        const helperStorageKey = `persistent-helper-${crypto.randomUUID()}`;
        const helperTarget = new CounterCapability();
        helperTarget.increment(53);
        const helperFirst = await sandstorm(request, env).persistentCapability(helperTarget, {
          id: helperId,
          storageKey: helperStorageKey,
          label: "Persistent helper fixture",
        });
        const helperFirstGet = await helperFirst.capability.call("get");
        const helperFirstDrop = await helperFirst.capability.drop();
        const helperSecond = await sandstorm(request, env).persistentCapability(helperTarget, {
          id: helperId,
          storageKey: helperStorageKey,
          label: "Persistent helper fixture",
        });
        const helperSecondGet = await helperSecond.capability.call("get");
        const helperSecondDrop = await helperSecond.capability.drop();
        const helperDropSaved = await helperSecond.saved.drop();
        const helperDeleteStorage = await sandstorm(request, env).storage().delete(helperStorageKey);
        const helperUnregister = sandstorm(request, env).unregisterCapability(helperId);
        persistentHelper = {
          id: helperId,
          storageKey: helperStorageKey,
          first: {
            restored: helperFirst.restored,
            registered: helperFirst.registered,
            capability: JSON.parse(JSON.stringify(helperFirst.capability)),
            saved: JSON.parse(JSON.stringify(helperFirst.saved)),
            get: helperFirstGet,
            drop: helperFirstDrop,
          },
          second: {
            restored: helperSecond.restored,
            registered: helperSecond.registered,
            capability: JSON.parse(JSON.stringify(helperSecond.capability)),
            saved: JSON.parse(JSON.stringify(helperSecond.saved)),
            get: helperSecondGet,
            drop: helperSecondDrop,
          },
          dropSaved: helperDropSaved,
          deleteStorage: helperDeleteStorage,
          unregister: helperUnregister,
        };
      }
      return Response.json({
        ok: true,
        first,
        second,
        current,
        childClass: child instanceof ClaimedCapability,
        child: JSON.parse(JSON.stringify(child)),
        capabilityInfo,
        childInfo,
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
        liveCallback: {
          subscription,
          events: receiver.events(),
          disposeBefore: disposeBeforeLiveCallback,
          disposeAfter: disposeAfterLiveCallback,
          sessionClass: session instanceof ClaimedCapability,
          session: JSON.parse(JSON.stringify(session)),
          sessionFirst,
          sessionDrop,
          feedDrop,
        },
        stubThenType: typeof stub.then,
        sessionActions,
        missing,
        saveError,
        remoteArguments: {
          rpcTargetError: remoteRpcTargetArgumentError,
          claimedCapabilityError: remoteClaimedCapabilityArgumentError,
        },
        duplicate: {
          sourceId: capability.id,
          id: duplicate.id,
          originalInfoWithDuplicateLive,
          duplicateInfoBeforeDrop,
          increment: duplicateIncrement,
          dropOriginal: dropOriginalWithDuplicateLive,
          disposeBeforeDrop: disposeBeforeDuplicateDrop,
          disposeAfterOriginalDrop,
          duplicateInfoAfterOriginalDrop,
          afterOriginalDrop: duplicateAfterOriginalDrop,
          dropDuplicate,
          duplicateInfoAfterDrop,
          disposeAfterDuplicateDrop,
        },
        stable: {
          first: stableFirst,
          duplicateError: stableDuplicateError,
          drop: stableDrop,
          recreatedFirst: stableRecreatedFirst,
          recreatedDrop: stableRecreatedDrop,
        },
        persistent: {
          id: persistentId,
          withoutIdError: persistentWithoutIdError,
          first: persistentFirst,
          saved: JSON.parse(JSON.stringify(persistentSaved)),
          restored: JSON.parse(JSON.stringify(persistentRestored)),
          restoredGet: persistentRestoredGet,
          restoredIncrement: persistentRestoredIncrement,
          dropOriginal: persistentDropOriginal,
          dropRestored: persistentDropRestored,
          unregisterOriginal: persistentUnregisterOriginal,
          registerReplacement: persistentRegisterReplacement,
          registerAgain: persistentRegisterAgain,
          registerDuplicateError: persistentRegisterDuplicateError,
          transientMintError: persistentTransientMintError,
          mintedAfterRegister: JSON.parse(JSON.stringify(persistentMintedAfterRegister)),
          mintedAfterRegisterGet: persistentMintedAfterRegisterGet,
          dropMintedAfterRegister: persistentDropMintedAfterRegister,
          restoredAfterRegister: JSON.parse(JSON.stringify(persistentRestoredAfterRegister)),
          restoredAfterRegisterGet: persistentRestoredAfterRegisterGet,
          dropRestoredAfterRegister: persistentDropRestoredAfterRegister,
          dropSaved: persistentDropSaved,
          unregisterReplacement: persistentUnregisterReplacement,
          helper: persistentHelper,
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
      async function claimedInfo(capability) {
        if (!capability?.ok || !capability?.id) return null;
        const response = await env.SANDSTORM_API.fetch(
          `http://sandstorm/capabilities/claimed?id=${encodeURIComponent(capability.id)}`);
        return {
          status: response.status,
          body: await response.json(),
        };
      }
      const claimInfo = await claimedInfo(claim);
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
          restore.info = await claimedInfo(restore.body);
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
          verbPhrase: "can use offered capability",
          description: "Offered capability description",
          requiredPermissions,
        });
        fulfill = await claim.fulfillRequest(request, {
          title: "WebSession fulfilled capability",
          verbPhrase: "can use fulfilled capability",
          description: "Fulfilled capability description",
          requiredPermissions,
        });
        const tiedCapability = await claim.tieToUser(request, {
          title: "WebSession tied capability",
          verbPhrase: "can use tied capability",
          description: "Tied capability description",
          requiredPermissions,
        });
        tie = {
          ok: tiedCapability.ok,
          claimedClass: tiedCapability instanceof ClaimedCapability,
          json: JSON.parse(JSON.stringify(tiedCapability)),
          info: await claimedInfo(tiedCapability),
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
        claimInfo,
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
      const claimed = await helper.claimAndStoreRequest("websession/test+token==", {
        label: "WebSession saved capability",
        storageKey,
        requiredPermissions: ["view"],
      });
      const originalFetch = await claimed.capability.fetch("/capability-echo?source=helper-original");
      const dropOriginal = await claimed.capability.drop();
      const fetchStoredResponse =
        await helper.fetchStored({ storageKey }, "/capability-echo?source=helper-fetch-saved");
      const restored = await helper.restoreStored({ storageKey });
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

      const handleStorageKey = "powerbox-storage-helper-handle-token";
      const handleSource = await sandstorm(request, env).webSession({
        pathPrefix: "/exported",
      });
      const handleClaimed = await helper.claimAndStoreRequest({
        capability: handleSource,
      }, {
        label: "WebSession saved from claimed handle",
        storageKey: handleStorageKey,
      });
      const dropHandleClaimed = await handleClaimed.capability.drop();
      const handleFetchSavedResponse =
        await helper.fetchStored(
          { storageKey: handleStorageKey },
          "/capability-echo?source=helper-handle-fetch");
      const dropHandleSaved = await helper.dropStored({ storageKey: handleStorageKey });

      const dropSaved = await helper.dropStored({ storageKey });
      const afterDrop = await helper.restoreStored({ storageKey });
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
        fetchStored: {
          status: fetchStoredResponse.status,
          body: await fetchStoredResponse.json(),
        },
        restored: {
          ok: restored.ok,
          found: restored.found,
          capabilityClass: restored.capability instanceof ClaimedCapability,
          storageKey: restored.storageKey,
          token: restored.token,
        },
        restoredFetch,
        dropRestored,
        handleClaimed: {
          ok: handleClaimed.ok,
          capabilityClass: handleClaimed.capability instanceof ClaimedCapability,
          savedClass: handleClaimed.saved instanceof SavedCapability,
          storageKey: handleClaimed.storageKey,
          token: handleClaimed.token,
        },
        dropHandleClaimed,
        handleFetchSaved: {
          status: handleFetchSavedResponse.status,
          body: await handleFetchSavedResponse.json(),
        },
        dropHandleSaved,
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
      helperVersions: {
        api: SANDSTORM_API_VERSION,
        rpc: SANDSTORM_RPC_VERSION,
        capnweb: SANDSTORM_CAPNWEB_VERSION,
        aggregate: SANDSTORM_HELPER_VERSIONS,
      },
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
