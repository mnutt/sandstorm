import message from "message.txt";
import metadata from "metadata.json";
import { Message as CapnpEsMessage } from "@mnutt/capnp-es";
import { Message as CapnpRpcMessage } from "@mnutt/capnp/rpc.mjs";
import {
  AppRpcTarget,
  Capability,
  RpcTarget,
  SANDSTORM_API_VERSION,
  SANDSTORM_CAPNWEB_VERSION,
  SANDSTORM_HELPER_VERSIONS,
  SANDSTORM_RPC_VERSION,
  createCapabilityNativeAppRpcStub,
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
import {
  SANDSTORM_CAPNP_NATIVE_BRIDGE_PROTOCOL_VERSION,
  SANDSTORM_CAPNP_VERSION,
  NativeCapnpBridgeTransport,
  createNativeCapnpBridge,
  decodeNativeCapnpBridgeResponse,
  makeCapnpInterfaceBinding,
  makeNativeCapnpBridgeAcknowledgedResponse,
  makeNativeCapnpBridgeCallRequest,
  makeNativeCapnpBridgeCapabilityResponse,
  makeNativeCapnpBridgeDropRequest,
  makeNativeCapnpBridgeExceptionResponse,
  makeNativeCapnpBridgeResultResponse,
  makeNativeCapnpBridgeRestoreRequest,
  makeNativeCapnpBridgeRpcRequest,
  makeNativeCapnpBridgeSaveRequest,
  makeNativeCapnpBridgeSavedResponse,
  makeNativeCapnpPayload,
  negotiateNativeCapnpBridge,
  readNativeCapnpBridgeRequest,
} from "sandstorm:capnp";

let disposedCounterCapabilities = 0;
const MAX_TEST_DOWNLOAD_BYTES = 70 * 1024 * 1024;
const TEST_PROVIDER_DESCRIPTOR = "EAlQAQEAABEBF1EEAQH_y9-dR8kYld8AUAEBAXsRASIHZm9v";
const retainedMailFeedCallbacks = new Map();
const retainedEventReceivers = new Map();
let powerboxFulfillmentDurableSerial = 0;

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

  children() {
    return {
      left: new CounterCapability(),
      right: new CounterCapability(),
    };
  }

  async readOther(other) {
    if (typeof other.call === "function") {
      return other.call("get");
    }
    return other.get();
  }

  async readOtherRpc(other) {
    return other.get();
  }

  async readNested(input) {
    return this.readOther(input?.wrapper?.other);
  }

  nestedChildren() {
    return {
      group: this.children(),
    };
  }

  mirrorSession(input) {
    return {
      session: input.session,
    };
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

const GeneratedCounter = makeCapnpInterfaceBinding("GeneratedCounter", [
  "increment",
  "get",
  "child",
  "children",
  "readOther",
  "readNested",
  "nestedChildren",
  "mirrorSession",
  "fail",
], {
  importSpecifier: "capnp:test/generated-counter.capnp",
  schemaPath: "test/generated-counter.capnp",
  schemaText: [
    "@0xd8c883d5220f7e53;",
    "using WebSession = import \"/sandstorm/web-session.capnp\".WebSession;",
    "interface GeneratedCounter {",
    "  increment @0 (amount :Float64) -> (value :Float64);",
    "  get @1 () -> (value :Float64);",
    "  child @2 () -> (counter :GeneratedCounter);",
    "  children @3 () -> (left :GeneratedCounter, right :GeneratedCounter);",
    "  readOther @4 (other :GeneratedCounter) -> (value :Float64);",
    "  readNested @5 (wrapper :AnyPointer) -> (value :Float64);",
    "  nestedChildren @6 () -> (group :AnyPointer);",
    "  mirrorSession @7 (session :WebSession) -> (session :WebSession);",
    "  fail @8 (message :Text) -> ();",
    "}",
  ].join("\n"),
  argumentCapabilities: {
    readOther: { indexes: [0] },
    readNested: { paths: [[["wrapper", "other"], () => GeneratedCounter]] },
    mirrorSession: {
      fields: {
        session: {
          nativeInterface: "webSession",
          fetch: true,
        },
      },
    },
  },
  resultCapabilities: {
    child: () => GeneratedCounter,
    children: {
      fields: {
        left: () => GeneratedCounter,
        right: () => GeneratedCounter,
      },
    },
    nestedChildren: {
      paths: {
        "group.left": () => GeneratedCounter,
        "group.right": () => GeneratedCounter,
      },
    },
    mirrorSession: {
      fields: {
        session: {
          nativeInterface: "webSession",
          fetch: true,
        },
      },
    },
  },
});

class AppRpcTargetSelfTest extends AppRpcTarget {
  summary() {
    const session = this.api.session();
    const storage = this.api.storage();
    return {
      targetClass: this instanceof RpcTarget,
      pathname: new URL(this.request.url).pathname,
      hasStorage: Boolean(storage),
      sessionType: session.sessionType,
      permissions: session.permissions,
    };
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

class ThrowingEventReceiver extends RpcTarget {
  onMailEvent(event) {
    throw new Error(`throwing receiver saw ${event.subject}`);
  }

  [Symbol.dispose]() {
    disposedCounterCapabilities += 1;
  }
}

class MailFeedCapability extends RpcTarget {
  async subscribe(receiver) {
    const result = await receiver.call("onMailEvent", {
      subject: "phase-3-live-callback",
      unread: 2,
    });
    return {
      ok: true,
      receiverType: receiver.type,
      result,
    };
  }

  async useCounter(counter) {
    const incremented = await counter.call("increment", 6);
    const current = await counter.call("get");
    return {
      ok: true,
      counterType: counter.type,
      incremented,
      current,
    };
  }

  async subscribeRetained(id, receiver) {
    const retainedId = String(id);
    const existing = retainedMailFeedCallbacks.get(retainedId);
    if (existing) {
      await existing.drop();
    }

    const retained = await receiver.dup();
    retainedMailFeedCallbacks.set(retainedId, retained);
    return {
      ok: true,
      id: retainedId,
      receiverType: receiver.type,
    };
  }

  async saveReceiver(receiver) {
    const token = await receiver.save({ label: "Saved live receiver fixture" });
    return {
      ok: true,
      receiverType: receiver.type,
      tokenType: typeof token,
      token,
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
    const systemResponse = await api.serveSystemRoutes();
    if (systemResponse) return systemResponse;

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
      const capability = new Capability(env, body.capability?.id || "");
      const saved = await capability.save({ label: "Isolate browser Powerbox test" });
      const dropOriginal = await capability.drop();
      const restored = await api.restore(saved);
      const restoredResponse = await restored.fetch("/value?source=browser-powerbox");
      const restoredBody = await restoredResponse.json();
      const dropRestored = await restored.drop();
      const dropSaved = await api.revoke(saved);
      return Response.json({
        ok: true,
        saved,
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
      const offered = powerbox.offered();
      const capability = offered?.capability;
      let fetched = null;
      let drop = null;
      let claimedInfo = null;
      if (capability) {
        claimedInfo = await capability.info();
        const fetchedResponse = await capability.fetch("/capability-echo?source=offer-session");
        fetched = {
          status: fetchedResponse.status,
          body: await fetchedResponse.json(),
        };
        drop = await capability.drop();
      }
      return Response.json({
        ok: Boolean(capability),
        sessionType: request.headers.get("x-sandstorm-session-type"),
        offeredCapabilityId: request.headers.get("x-sandstorm-offered-capability-id"),
        offeredClass: capability instanceof Capability,
        sessionOffer: api.session().offer,
        offeredInfo: offered ? {
          ...offered,
          capabilityClass: offered.capability instanceof Capability,
          capability: offered.capability
              ? JSON.parse(JSON.stringify(offered.capability))
              : null,
        } : null,
        offered: capability ? JSON.parse(JSON.stringify(capability)) : null,
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
        capabilityClass: capability instanceof Capability,
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
        capabilityClass: capability instanceof Capability,
        capability: JSON.parse(JSON.stringify(capability)),
      });
    }

    if (url.pathname === "/web-session-save-restore-self-test") {
      const capability = await sandstorm(request, env).webSession({
        pathPrefix: "/exported",
      });
      let wrongOutboundError;
      try {
        await capability.fetch("https://api.example.test/v1/test");
      } catch (error) {
        wrongOutboundError = {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
        };
      }
      const saved = await capability.save({ label: "Route-backed WebSession fixture" });
      const dropOriginal = await capability.drop();
      const restored = await sandstorm(request, env).restore(saved);
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
        body: "hello through capability fetch",
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
      const dropSaved = await sandstorm(request, env).revoke(saved);
      return Response.json({
        ok: true,
        capabilityClass: capability instanceof Capability,
        savedToken: typeof saved === "string",
        restoredClass: restored instanceof Capability,
        capability: JSON.parse(JSON.stringify(capability)),
        saved,
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
        await capability.fetch("https://api.example.test/v1/test");
      } catch (error) {
        wrongOutboundError = {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
        };
      }
      const saved = await capability.save({ label: "Route-backed ApiSession fixture" });
      const dropOriginal = await capability.drop();
      const restored = await sandstorm(request, env).restore(saved);
      const fetchedResponse = await restored.fetch("/capability-echo?source=api-js-restore");
      const fetched = {
        status: fetchedResponse.status,
        body: await fetchedResponse.json(),
      };
      const dropRestored = await restored.drop();
      const dropSaved = await sandstorm(request, env).revoke(saved);
      return Response.json({
        ok: true,
        capabilityClass: capability instanceof Capability,
        savedToken: typeof saved === "string",
        restoredClass: restored instanceof Capability,
        capability: JSON.parse(JSON.stringify(capability)),
        saved,
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
        await sandstorm(request, env).powerbox().claim("dummy-token", {
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
      const capability = await api.powerbox().claim("outbound-http/test-token", {
        requiredPermissions: ["view"],
        outboundHttp: {
          baseUrl: "https://api.example.test/v1",
          methods: ["POST"],
        },
      });
      const capabilityInfo = await capability.info();
      let fetchError = null;
      try {
        await capability.fetch("https://api.example.test/v1/should-not-fetch");
      } catch (error) {
        fetchError = {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
        };
      }
      const response = await capability.fetch("v1/chat/completions?model=test", {
        method: "POST",
        headers: {
          authorization: "Bearer isolate-test",
          "content-type": "text/plain; charset=utf-8",
        },
        body: "hello",
      });
      const saved = await capability.save({ label: "Outbound HTTP saved capability" });
      const restored = await api.restore(saved);
      const restoredInfo = await restored.info();
      const restoredResponse = await restored.fetch("v1/chat/completions?model=test", {
        method: "POST",
        headers: {
          authorization: "Bearer isolate-test",
          "content-type": "text/plain; charset=utf-8",
        },
        body: "hello",
      });
      const restoredBody = await restoredResponse.json();
      const dropRestored = await restored.drop();
      const dropSaved = await api.revoke(saved);

      return Response.json({
        ok: true,
        capabilityInfo,
        fetchError,
        unifiedFetch: true,
        status: response.status,
        statusText: response.statusText,
        contentType: response.headers.get("content-type"),
        outboundHeader: response.headers.get("x-outbound-test"),
        body: await response.json(),
        restored: {
          capabilityClass: restored instanceof Capability,
          info: restoredInfo,
          status: restoredResponse.status,
          statusText: restoredResponse.statusText,
          outboundHeader: restoredResponse.headers.get("x-outbound-test"),
          body: restoredBody,
        },
        dropRestored,
        dropSaved,
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
                type: "capabilityInfo",
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
                hasNativeCapability: true,
                liveForwardable: true,
              });
            }
            if (parsed.pathname === "/powerbox/native-app-rpc-call") {
              return Response.json(await dispatchNativeAppRpcCall(
                nativeRpcTarget, JSON.parse(String(init?.body || "{}"))));
            }
            if (parsed.pathname === "/powerbox/outbound-http-fetch") {
              return Response.json({
                ok: true,
                id: parsed.searchParams.get("id"),
                method: parsed.searchParams.get("method"),
                path: parsed.searchParams.get("path"),
              }, {
                status: 202,
                headers: {
                  "x-mock-outbound": "present",
                },
              });
            }
            return Response.json({ ok: false, error: "unexpected mock fetch" }, { status: 500 });
          },
        },
      };
      const capability = new Capability(mockEnv, "mock-outbound");
      let fetchError = null;
      try {
        await capability.fetch("https://api.example.test/v1/should-not-fetch");
      } catch (error) {
        fetchError = {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
        };
      }
      const outboundFetchResponse = await capability.fetch("v1/mock-fetch?case=native-interface");
      const outboundFetch = {
        status: outboundFetchResponse.status,
        header: outboundFetchResponse.headers.get("x-mock-outbound"),
        body: await outboundFetchResponse.json(),
      };
      const appObjectCapability = new Capability(mockEnv, "mock-app-object");
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
        await appObjectCapability.fetch("v1/test");
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
      const appObjectNativeRpc = createCapabilityNativeAppRpcStub(appObjectCapability, {
        transport: async (transportSlot, call) => {
          nativeRpcTransportCalls.push({ slot: transportSlot, call });
          return dispatchNativeAppRpcCall(nativeRpcTarget, call);
        },
      }).rpc;
      const appObjectNativeValue = await appObjectNativeRpc.deliver(
        "native-subject",
        nativeCapabilitySlot("native-callback", { nativeInterface: "appObject" }),
        { urgent: true });
      const defaultNativeRpc = appObjectCapability.rpc;
      const defaultNativeRpcValue = await defaultNativeRpc.deliver(
        "default-subject", { urgent: false });
      const defaultCallValue = await appObjectCapability.call(
        "deliver", "call-subject", { urgent: true });
      const nonAppObjectResultSlot = await createCapabilityNativeAppRpcStub(appObjectCapability, {
        transport: async () => ({
          type: "value",
          value: {
            type: "capability",
            value: { id: "web-session-slot", nativeInterface: "webSession" },
          },
        }),
      }).rpc.deliver("non-app-object-result-slot");

      const helperNativeRpcStub = createCapabilityNativeAppRpcStub(appObjectCapability, {
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
        await createCapabilityNativeAppRpcStub(capability, {
          transport: async (transportSlot, call) => {
            wrongNativeRpcTransportCalls.push({ slot: transportSlot, call });
            return dispatchNativeAppRpcCall(nativeRpcTarget, call);
          },
        }).rpc.deliver("wrong-interface");
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
        outboundFetch,
        appObjectFetchError,
        appObjectOutboundError,
        nativeRpcTransportCalls,
        appObjectNativeSlot: appObjectNativeRpc.slot,
        appObjectNativeValue,
        defaultNativeRpcValue,
        defaultCallValue,
        nonAppObjectResultSlot,
        helperNativeSlot,
        helperNativeDrop,
        wrongNativeRpcTransportCalls,
        wrongNativeRpcError,
      });
    }

    if (url.pathname === "/native-app-rpc-codec-self-test") {
      const bytes = makeBytes(5);
      const slot = nativeCapabilitySlot("slot-1", { nativeInterface: "appObject" });
      const savedCapability = "c2F2ZWQtdG9rZW4";
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
      const stubRpcValue = await stub.rpc.deliver("rpc-subject", slot, {
        urgent: true,
        saved: savedCapability,
      });
      const stubRpcStable = stub.rpc === stub.rpc;

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
      const dropViaProxy = await droppableStub.rpc.drop();
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
          capabilityClass: capability instanceof Capability,
          capabilityId: capability instanceof Capability ? capability.id : undefined,
          id,
        });
        return nativeCapabilitySlot(id, { nativeInterface: "appObject" });
      };
      let exportedTargetValueError = null;
      try {
        await serializeNativeAppRpcValueAsync(new CounterCapability(), {
          name: "callback",
          exportCapabilitySlot,
        });
      } catch (error) {
        exportedTargetValueError = {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
        };
      }
      const exportedCapabilityValue = await serializeNativeAppRpcValueAsync(
        new Capability(env, "mock-app-object"),
        {
          name: "authority",
          exportCapabilitySlot,
        });
      let exportedCallRawTargetError = null;
      try {
        await serializeNativeAppRpcCallAsync("deliver", [
          new CounterCapability(),
          { authority: new Capability(env, "mock-app-object") },
        ], { exportCapabilitySlot });
      } catch (error) {
        exportedCallRawTargetError = {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
        };
      }
      const exportedCallEnvelope = await serializeNativeAppRpcCallAsync("deliver", [
        new Capability(env, "mock-exported-callback"),
        { authority: new Capability(env, "mock-app-object") },
      ], { exportCapabilitySlot });
      const exportingStubTransportCalls = [];
      const exportingStub = createNativeAppRpcStub(
        slot,
        async (transportSlot, call) => {
          exportingStubTransportCalls.push({ slot: transportSlot, call });
          return dispatchNativeAppRpcCall(dispatchTarget, call);
        },
        { exportCapabilitySlot });
      let exportingStubRawTargetError = null;
      try {
        await exportingStub.call(
          "deliver", "export-stub-subject", new CounterCapability(), { urgent: false });
      } catch (error) {
        exportingStubRawTargetError = {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
        };
      }
      const exportingStubValue = await exportingStub.call(
        "deliver", "export-stub-subject",
        new Capability(env, "mock-exported-stub-callback"), { urgent: false });
      const exportedResultEnvelope = await serializeNativeAppRpcResultAsync({
        child: new CounterCapability(),
        authority: new Capability(env, "mock-app-object"),
      }, { exportCapabilitySlot });
      const exportDispatchTarget = {
        makeChild() {
          return new CounterCapability();
        },

        forwardAuthority() {
          return {
            authority: new Capability(env, "mock-app-object"),
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
        stubRpcStable,
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
          targetValueError: exportedTargetValueError,
          capabilityValue: exportedCapabilityValue,
          callEnvelope: exportedCallEnvelope,
          callRawTargetError: exportedCallRawTargetError,
          stubValue: exportingStubValue,
          stubRawTargetError: exportingStubRawTargetError,
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
      const routeCapability = await sandstorm(request, env).export({
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
        const missingDurableResponse = await serveSystemRoutes(new Request(
          "http://worker/__sandstorm/object-capabilities/missing-durable-route"), env);
        const missingDurableRpcResponse = await serveSystemRoutes(new Request(
          "http://worker/__sandstorm/object-capabilities/missing-durable-route/" +
          "native-app-rpc-call", {
            method: "POST",
            body: JSON.stringify(serializeNativeAppRpcCall("deliver", [])),
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
        const routeStubRpcValue = await routeStub.rpc.deliver("stub-rpc-subject", {
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
        async function captureDisconnectedTransportError() {
          const testStub = createNativeAppRpcStub(
            nativeCapabilitySlot("transport-disconnected", { nativeInterface: "appObject" }),
            createNativeAppRpcFetchTransport({
              async fetch() {
                throw new TypeError("simulated bridge disconnect");
              },
            }, "http://worker/native-app-rpc-transport-test"));
          try {
            await testStub.call("deliver");
          } catch (error) {
            transportErrorCases.disconnected = {
              name: String(error?.name || "Error"),
              message: String(error?.message || error),
              details: {
                causeName: String(error?.details?.cause?.name || ""),
                causeMessage: String(error?.details?.cause?.message || ""),
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
        await captureDisconnectedTransportError();

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
          missingDurable: {
            status: missingDurableResponse.status,
            body: await missingDurableResponse.json(),
          },
          missingDurableRpc: {
            status: missingDurableRpcResponse.status,
            body: await missingDurableRpcResponse.json(),
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
        await routeCapability.drop();
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

    if (url.pathname === "/powerbox-grants-helper-self-test") {
      const grantApi = sandstorm(request, env);
      const grants = grantApi.powerboxGrants({
        routePrefix: "/grant-ui-test",
        grants: {
          shared: {
            title: "Shared test capability",
            description: "Exercises generated Powerbox grant routes.",
            storageKey: "powerbox-grants-helper-token",
            descriptor: TEST_PROVIDER_DESCRIPTOR,
            requiredPermissions: ["view"],
            saveLabel: "Shared test capability",
            save: { label: "Shared test capability" },
            async test(capability) {
              const response = await capability.fetch("/value?source=grant-test");
              return {
                status: response.status,
                body: await response.json(),
              };
            },
          },
        },
      });

      const page = await grants.serve(new Request("http://app/grant-ui-test"));
      const client = await grants.serve(new Request("http://app/grant-ui-test/client.js"));
      const rpcClient = await grants.serve(new Request("http://app/grant-ui-test/rpc-client.js"));
      const configBefore = await (await grants.serve(
        new Request("http://app/grant-ui-test/config"))).json();
      const statusBefore = await (await grants.serve(
        new Request("http://app/grant-ui-test/status?id=shared"))).json();

      const capability = await grantApi.webSession({
        pathPrefix: "/browser-powerbox-shared",
      });
      const claim = await (await grants.serve(new Request(
        "http://app/grant-ui-test/grants/shared/claim", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ capability }),
        }))).json();

      const token = await grants.token("shared");
      const used = await grants.use("shared", async (restored) => {
        const response = await restored.fetch("/value?source=grant-use");
        return {
          capabilityClass: restored instanceof Capability,
          status: response.status,
          body: await response.json(),
        };
      });
      const statusAfterClaim = await grants.status("shared");
      const revoke = await (await grants.serve(new Request(
        "http://app/grant-ui-test/grants/shared/revoke", { method: "POST" }))).json();
      const statusAfterRevoke = await grants.status("shared");

      return Response.json({
        ok: true,
        page: {
          status: page.status,
          contentType: page.headers.get("content-type"),
          hasElement: (await page.text()).includes("sandstorm-powerbox-grant"),
        },
        client: {
          status: client.status,
          contentType: client.headers.get("content-type"),
          hasRequestGrant: (await client.text()).includes("requestGrant"),
        },
        rpcClient: {
          status: rpcClient.status,
          contentType: rpcClient.headers.get("content-type"),
          hasRequestPowerbox: (await rpcClient.text()).includes("requestPowerbox"),
        },
        configBefore,
        statusBefore,
        claim,
        tokenType: typeof token,
        used,
        statusAfterClaim,
        revoke,
        statusAfterRevoke,
      });
    }

    if (url.pathname === "/powerbox-fulfillment-helper-self-test") {
      const fulfillmentApi = sandstorm(request, env);
      const runFulfill = url.searchParams.get("fulfill") === "true";
      const helperRequest = (path, init = {}) => {
        const headers = new Headers(request.headers);
        for (const [name, value] of new Headers(init.headers || {})) {
          headers.set(name, value);
        }
        return new Request(new URL(path, "http://app"), {
          ...init,
          headers,
        });
      };
      const fulfillOptions = () => ({
        title: "WebSession fulfilled capability",
        verbPhrase: "can use fulfilled capability",
        description: "Fulfilled capability description",
        requiredPermissions: ["view"],
        descriptor: TEST_PROVIDER_DESCRIPTOR,
      });
      const web = fulfillmentApi.powerboxFulfillment({
        title: "Powerbox fulfillment WebSession",
        description: "Exercises the default generated fulfillment page.",
        buttonLabel: "Use helper WebSession",
        capability: () => fulfillmentApi.webSession({ pathPrefix: "/browser-powerbox-shared" }),
        fulfill: fulfillOptions(),
      });
      const object = fulfillmentApi.powerboxFulfillment({
        routePrefix: "/fulfillment-object-test",
        title: "Powerbox fulfillment app object",
        buttonLabel: "Use helper app object",
        capability: () => fulfillmentApi.export(new CounterCapability()),
        fulfill: fulfillOptions(),
      });
      const durable = fulfillmentApi.powerboxFulfillment({
        routePrefix: "/fulfillment-durable-test",
        title: "Powerbox fulfillment durable app object",
        buttonLabel: "Use helper durable app object",
        capability: () => fulfillmentApi.exportDurable(new CounterCapability(), {
          id: `powerbox-fulfillment-durable-${++powerboxFulfillmentDurableSerial}`,
          label: "Powerbox fulfillment durable app object",
        }),
        fulfill: fulfillOptions(),
      });
      const throwing = fulfillmentApi.powerboxFulfillment({
        routePrefix: "/fulfillment-error-test",
        title: "Powerbox fulfillment error",
        buttonLabel: "Use helper error",
        capability: () => {
          throw new Error("powerbox fulfillment factory failed");
        },
        fulfill: fulfillOptions(),
      });

      const page = await web.serve(helperRequest("/__sandstorm/powerbox-fulfillment"));
      const client = await web.serve(helperRequest("/__sandstorm/powerbox-fulfillment/client.js"));
      const unknown = await web.serve(helperRequest("/__sandstorm/powerbox-fulfillment/unknown"));
      const outside = await web.serve(helperRequest("/outside-fulfillment-helper"));
      const webFulfill = runFulfill
        ? await web.serve(helperRequest(
          "/__sandstorm/powerbox-fulfillment/fulfill", { method: "POST" }))
        : null;
      const objectFulfill = runFulfill
        ? await object.serve(helperRequest(
          "/fulfillment-object-test/fulfill", { method: "POST" }))
        : null;
      const durableFulfill = runFulfill
        ? await durable.serve(helperRequest(
          "/fulfillment-durable-test/fulfill", { method: "POST" }))
        : null;
      const errorFulfill = await throwing.serve(helperRequest(
        "/fulfillment-error-test/fulfill", { method: "POST" }));
      const pageText = await page.text();

      return Response.json({
        ok: true,
        page: {
          status: page.status,
          contentType: page.headers.get("content-type"),
          hasButton: pageText.includes("Use helper WebSession"),
          hasTitle: pageText.includes("Powerbox fulfillment WebSession"),
          hasInlineScript: pageText.includes("/fulfill"),
        },
        client: {
          status: client.status,
        },
        unknown: {
          status: unknown.status,
          body: await unknown.text(),
        },
        outsideIsNull: outside === null,
        webFulfill: webFulfill && {
          status: webFulfill.status,
          body: await webFulfill.json(),
        },
        objectFulfill: objectFulfill && {
          status: objectFulfill.status,
          body: await objectFulfill.json(),
        },
        durableFulfill: durableFulfill && {
          status: durableFulfill.status,
          body: await durableFulfill.json(),
        },
        errorFulfill: {
          status: errorFulfill.status,
          body: await errorFulfill.json(),
        },
      });
    }

    if (url.pathname === "/export-object-capability") {
      const capability = await sandstorm(request, env).export(new CounterCapability());
      return Response.json({
        ok: true,
        capabilityClass: capability instanceof Capability,
        capability: JSON.parse(JSON.stringify(capability)),
      });
    }

    if (url.pathname === "/export-mail-feed-capability") {
      const persistent = url.searchParams.get("persistent") === "true";
      const capability = persistent
        ? (await sandstorm(request, env).exportDurable(new MailFeedCapability(), {
            id: url.searchParams.get("id") || "mail-feed",
            label: "Mail feed fixture",
          })).capability
        : await sandstorm(request, env).export(new MailFeedCapability());
      return Response.json({
        ok: true,
        capabilityClass: capability instanceof Capability,
        capability: JSON.parse(JSON.stringify(capability)),
      });
    }

    if (url.pathname === "/cross-grain-live-callback-self-test") {
      const token = url.searchParams.get("token");
      if (!token) {
        return Response.json({ ok: false, error: "missing token" }, { status: 400 });
      }

      try {
        const feedCapability = await sandstorm(request, env).restore(token);
        const feedInfo = await feedCapability.info();
        const feed = feedCapability.rpc;
        const receiver = new EventReceiver();
        const disposeBefore = disposedCounterCapabilities;
        const subscription = await sandstorm(request, env).withExport(
          receiver, (exported) => feed.subscribe(exported));
        const disposeAfterSubscribe = disposedCounterCapabilities;
        const events = receiver.events();
        const disposeBeforeThrowingCallback = disposedCounterCapabilities;
        let throwingCallbackFailure = null;
        try {
          await sandstorm(request, env).withExport(
            new ThrowingEventReceiver(), (exported) => feed.subscribe(exported));
        } catch (error) {
          throwingCallbackFailure = {
            name: String(error?.name || "Error"),
            message: String(error?.message || error),
            details: {
              name: String(error?.details?.name || ""),
            },
          };
        }
        const disposeAfterThrowingCallback = disposedCounterCapabilities;
        let missingMethodFailure = null;
        try {
          await feed.missingPhase3Method();
        } catch (error) {
          missingMethodFailure = {
            name: String(error?.name || "Error"),
            message: String(error?.message || error),
            details: {
              name: String(error?.details?.name || ""),
            },
          };
        }
        const session = await feed.startSession();
        const sessionInfo = await session.info();
        const sessionFirst = await session.rpc.increment(7);
        const sessionSecond = await session.call("increment", 4);
        const forwardedSession = await feed.useCounter(session);
        const sessionCurrent = await session.rpc.get();
        let sessionFailure = null;
        try {
          await session.rpc.fail("phase-3 returned capability failure");
        } catch (error) {
          sessionFailure = {
            name: String(error?.name || "Error"),
            message: String(error?.message || error),
            details: {
              name: String(error?.details?.name || ""),
            },
          };
        }
        const webSessionCapability = await sandstorm(request, env).webSession({
          pathPrefix: "/exported",
        });
        let wrongForwardedCapabilityFailure = null;
        try {
          await feed.useCounter(webSessionCapability);
        } catch (error) {
          wrongForwardedCapabilityFailure = {
            name: String(error?.name || "Error"),
            message: String(error?.message || error),
            details: {
              status: error?.details?.status ?? null,
              body: error?.details?.body ?? null,
            },
          };
        }
        const webSessionDrop = await webSessionCapability.drop();
        const sessionDrop = await session.drop();
        const durableReceiverId = `live-save-receiver-${crypto.randomUUID()}`;
        const durableReceiver = await sandstorm(request, env).exportDurable(
          new EventReceiver(),
          {
            id: durableReceiverId,
            label: "Live receiver save fixture",
          });
        const savedLiveReceiver = await feed.saveReceiver(durableReceiver.capability);
        const restoredLiveReceiver = await sandstorm(request, env).restore(
          savedLiveReceiver.token);
        const restoredLiveReceiverEvent = await restoredLiveReceiver.rpc.onMailEvent({
          subject: "phase-3-saved-live-receiver",
          unread: 13,
        });
        const restoredLiveReceiverDrop = await restoredLiveReceiver.drop();
        const liveReceiverDropSaved = await sandstorm(request, env).revoke(
          savedLiveReceiver.token);
        const durableReceiverDrop = await durableReceiver.capability.drop();
        const drop = await feedCapability.drop();
        return Response.json({
          ok: true,
          feedCapability: JSON.parse(JSON.stringify(feedCapability)),
          feedInfo,
          subscription,
          events,
          disposeBefore,
          disposeAfterSubscribe,
          throwingCallbackFailure,
          disposeBeforeThrowingCallback,
          disposeAfterThrowingCallback,
          missingMethodFailure,
          session: JSON.parse(JSON.stringify(session)),
          sessionInfo,
          sessionFirst,
          sessionSecond,
          forwardedSession,
          sessionCurrent,
          sessionFailure,
          wrongForwardedCapabilityFailure,
          webSessionDrop,
          sessionDrop,
          savedLiveReceiver: {
            ok: savedLiveReceiver.ok,
            receiverType: savedLiveReceiver.receiverType,
            tokenType: savedLiveReceiver.tokenType,
          },
          restoredLiveReceiver: JSON.parse(JSON.stringify(restoredLiveReceiver)),
          restoredLiveReceiverEvent,
          restoredLiveReceiverDrop,
          liveReceiverDropSaved,
          durableReceiverDrop,
          drop,
        });
      } catch (error) {
        return Response.json({
          ok: false,
          error: {
            name: error.name,
            message: error.message,
            stack: error.stack,
          },
        }, { status: 500 });
      }
    }

    if (url.pathname === "/cross-grain-retained-callback-subscribe-self-test") {
      const token = url.searchParams.get("token");
      const id = url.searchParams.get("id");
      if (!token || !id) {
        return Response.json({ ok: false, error: "missing token or id" }, { status: 400 });
      }

      try {
        const feedCapability = await sandstorm(request, env).restore(token);
        const feed = feedCapability.rpc;
        const receiver = new EventReceiver();
        const receiverCapability = await sandstorm(request, env).export(receiver);
        const disposeBeforeSubscribe = disposedCounterCapabilities;
        const subscription = await feed.subscribeRetained(id, receiverCapability);
        const disposeAfterSubscribe = disposedCounterCapabilities;
        const dropFeed = await feedCapability.drop();
        retainedEventReceivers.set(id, { receiver, receiverCapability });
        return Response.json({
          ok: true,
          id,
          receiverCapability: JSON.parse(JSON.stringify(receiverCapability)),
          subscription,
          disposeBeforeSubscribe,
          disposeAfterSubscribe,
          dropFeed,
        });
      } catch (error) {
        return Response.json({
          ok: false,
          error: {
            name: error.name,
            message: error.message,
            stack: error.stack,
          },
        }, { status: 500 });
      }
    }

    if (url.pathname === "/trigger-retained-mail-feed-callback") {
      const id = url.searchParams.get("id");
      const retained = retainedMailFeedCallbacks.get(id);
      if (!id || !retained) {
        return Response.json({ ok: false, error: "missing retained callback" }, { status: 404 });
      }

      try {
        const result = await retained.call("onMailEvent", {
          subject: url.searchParams.get("subject") || "phase-3-retained-callback",
          unread: Number(url.searchParams.get("unread") || 3),
        });
        return Response.json({ ok: true, id, result });
      } catch (error) {
        return Response.json({
          ok: false,
          error: {
            name: error.name,
            message: error.message,
            stack: error.stack,
          },
        }, { status: 500 });
      }
    }

    if (url.pathname === "/retained-callback-events") {
      const id = url.searchParams.get("id");
      const retained = retainedEventReceivers.get(id);
      if (!id || !retained) {
        return Response.json({ ok: false, error: "missing retained receiver" }, { status: 404 });
      }

      return Response.json({
        ok: true,
        id,
        events: retained.receiver.events(),
        disposed: disposedCounterCapabilities,
      });
    }

    if (url.pathname === "/drop-retained-mail-feed-callback") {
      const id = url.searchParams.get("id");
      const retained = retainedMailFeedCallbacks.get(id);
      if (!id || !retained) {
        return Response.json({ ok: true, id, dropped: false });
      }

      retainedMailFeedCallbacks.delete(id);
      return Response.json({
        ok: true,
        id,
        dropped: true,
        drop: await retained.drop(),
      });
    }

    if (url.pathname === "/drop-retained-callback-receiver") {
      const id = url.searchParams.get("id");
      const retained = retainedEventReceivers.get(id);
      if (!id || !retained) {
        return Response.json({ ok: true, id, dropped: false });
      }

      retainedEventReceivers.delete(id);
      const disposeBeforeDrop = disposedCounterCapabilities;
      const drop = await retained.receiverCapability.drop();
      const disposeAfterDrop = disposedCounterCapabilities;
      return Response.json({
        ok: true,
        id,
        dropped: true,
        drop,
        disposeBeforeDrop,
        disposeAfterDrop,
      });
    }

    if (url.pathname === "/object-capability-dispose-count") {
      return Response.json({
        ok: true,
        disposed: disposedCounterCapabilities,
      });
    }

    if (url.pathname === "/object-capability-self-test") {
      const capability = await sandstorm(request, env).export(new CounterCapability());
      const first = await capability.call("increment", 3);
      const second = await capability.call("increment", 4);
      const current = await capability.call("get");
      const child = await capability.call("child");
      const capabilityInfo = await capability.info();
      const childInfo = await child.info();
      const childFirst = await child.call("increment", 11);
      const readChild = await capability.call("readOther", child);
      const stub = capability.rpc;
      const rpc = capability.rpc;
      const rpcStable = capability.rpc === capability.rpc;
      const rpcCurrent = await rpc.get();
      const stubFirst = await stub.increment(2);
      const stubCurrent = await stub.get();
      const stubChild = await stub.child();
      const stubChildFirst = await stubChild.rpc.increment(13);
      const stubReadChild = await stub.readOther(stubChild);
      const argumentTarget = new CounterCapability();
      argumentTarget.increment(21);
      let rawArgumentTargetError;
      try {
        await capability.call("readOther", argumentTarget);
      } catch (error) {
        rawArgumentTargetError = {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
        };
      }
      const exportedArgumentTarget = await sandstorm(request, env).export(argumentTarget);
      const disposeBeforeArgumentTarget = disposedCounterCapabilities;
      const readArgumentTarget = await capability.call("readOther", exportedArgumentTarget);
      const dropArgumentTarget = await exportedArgumentTarget.drop();
      const disposeAfterArgumentTarget = disposedCounterCapabilities;
      const stubArgumentTarget = new CounterCapability();
      stubArgumentTarget.increment(23);
      let rawStubArgumentTargetError;
      try {
        await stub.readOther(stubArgumentTarget);
      } catch (error) {
        rawStubArgumentTargetError = {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
        };
      }
      const stubReadArgumentTarget = await sandstorm(request, env).withExport(
        stubArgumentTarget,
        async (exported) => {
          const disposeBefore = disposedCounterCapabilities;
          const read = await stub.readOther(exported);
          return {
            read,
            disposeBefore,
          };
        });
      const disposeAfterStubArgumentTarget = disposedCounterCapabilities;
      const retainedArgumentTarget = new CounterCapability();
      retainedArgumentTarget.increment(31);
      const disposeBeforeRetainedArgumentTarget = disposedCounterCapabilities;
      let rawRetainedArgumentTargetError;
      try {
        await capability.call("retainOther", retainedArgumentTarget);
      } catch (error) {
        rawRetainedArgumentTargetError = {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
        };
      }
      const retainedArgumentExport = await sandstorm(request, env).withExport(
        retainedArgumentTarget,
        async (exported) => ({
          retain: await capability.call("retainOther", exported),
          disposeAfterRetainCall: disposedCounterCapabilities,
        }));
      const readRetainedArgumentTarget = await capability.call("readRetained");
      const dropRetainedArgumentTarget = await capability.call("dropRetained");
      const disposeAfterDropRetainedArgumentTarget = disposedCounterCapabilities;
      const feedCapability = await sandstorm(request, env).export(new MailFeedCapability());
      const feed = feedCapability.rpc;
      const receiver = new EventReceiver();
      const disposeBeforeLiveCallback = disposedCounterCapabilities;
      const subscription = await sandstorm(request, env).withExport(
        receiver, (exported) => feed.subscribe(exported));
      const disposeAfterLiveCallback = disposedCounterCapabilities;
      const session = await feed.startSession();
      const sessionFirst = await session.rpc.increment(7);
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
            capabilityClass: tied instanceof Capability,
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
      const remoteTarget = new Capability(env, "remote-like-capability");
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
      let remoteCapabilityArgumentError;
      try {
        await remoteTarget.call("readOther", child);
      } catch (error) {
        remoteCapabilityArgumentError = {
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
      const stableCapability = await sandstorm(request, env).export(new CounterCapability(), {
        id: "stable-counter",
      });
      const stableFirst = await stableCapability.call("increment", 17);
      let stableDuplicateError;
      try {
        await sandstorm(request, env).export(new CounterCapability(), {
          id: "stable-counter",
        });
      } catch (error) {
        stableDuplicateError = {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
        };
      }
      const stableDrop = await stableCapability.drop();
      const stableRecreated = await sandstorm(request, env).export(new CounterCapability(), {
        id: "stable-counter",
      });
      const stableRecreatedFirst = await stableRecreated.call("increment", 19);
      const stableRecreatedDrop = await stableRecreated.drop();
      let persistentWithoutIdError;
      try {
        await sandstorm(request, env).export(new CounterCapability(), {
          persistent: true,
        });
      } catch (error) {
        persistentWithoutIdError = {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
        };
      }
      const persistentId = `persistent-counter-${crypto.randomUUID()}`;
      const persistentTarget = new CounterCapability();
      const persistentExport = await sandstorm(request, env).exportDurable(
        persistentTarget, {
          id: persistentId,
          label: "Persistent object capability fixture",
        });
      const persistentCapability = persistentExport.capability;
      const persistentFirst = await persistentCapability.call("increment", 29);
      const persistentSaved = persistentExport.token;
      const persistentRestored = await sandstorm(request, env).restore(persistentSaved);
      const persistentRestoredGet = await persistentRestored.call("get");
      const persistentRestoredIncrement = await persistentRestored.call("increment", 3);
      const persistentDropOriginal = await persistentCapability.drop();
      const persistentDropRestored = await persistentRestored.drop();
      let persistentDuplicateExportError;
      try {
        await sandstorm(request, env).exportDurable(new CounterCapability(), {
          id: persistentId,
          label: "Persistent object capability fixture",
        });
      } catch (error) {
        persistentDuplicateExportError = {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
        };
      }
      let persistentTransientMintError;
      try {
        await sandstorm(request, env).export(persistentTarget, {
          id: persistentId,
        });
      } catch (error) {
        persistentTransientMintError = {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
        };
      }
      const persistentMintedAfterRegister = await sandstorm(request, env).exportDurable(
        persistentTarget, {
          id: persistentId,
          label: "Persistent object capability fixture",
        });
      const persistentMintedAfterRegisterGet =
        await persistentMintedAfterRegister.capability.call("get");
      const persistentDropMintedAfterRegister =
        await persistentMintedAfterRegister.capability.drop();
      const persistentRestoredAfterRegister = await sandstorm(request, env).restore(persistentSaved);
      const persistentRestoredAfterRegisterGet =
        await persistentRestoredAfterRegister.call("get");
      const persistentDropRestoredAfterRegister = await persistentRestoredAfterRegister.drop();
      let persistentTopLevelRestored = null;
      let persistentTopLevelRestoreGet = null;
      let persistentDropTopLevelRestored = null;
      let persistentUseGet = null;
      if (url.searchParams.get("persistentHelper") === "true") {
        persistentTopLevelRestored = await sandstorm(request, env).restore(persistentSaved);
        persistentTopLevelRestoreGet = await persistentTopLevelRestored.rpc.get();
        persistentDropTopLevelRestored = await persistentTopLevelRestored.drop();
        persistentUseGet = await sandstorm(request, env).use(
          persistentSaved,
          (restored) => restored.rpc.get());
      }
      const persistentDropSaved = await sandstorm(request, env).revoke(persistentSaved);
      let persistentHelper = null;
      if (url.searchParams.get("persistentHelper") === "true") {
        const exportedTarget = new CounterCapability();
        const exported = await sandstorm(request, env).export(exportedTarget);
        const exportedIncrement = await exported.rpc.increment(61);
        const exportedDrop = await exported.drop();
        const withExportRead = await sandstorm(request, env).withExport(
          new CounterCapability(),
          async (other) => {
            await other.rpc.increment(62);
            return other.rpc.get();
          });
        const durableExportId = `durable-export-${crypto.randomUUID()}`;
        const durableExportStorageKey = `durable-export-${crypto.randomUUID()}`;
        const durableExportTarget = new CounterCapability();
        durableExportTarget.increment(71);
        let durableExportMissingLabelError;
        let durableExportMissingRegistryError;
        try {
          await sandstorm(request, env).exportDurable(new CounterCapability(), {
            id: `durable-export-missing-label-${crypto.randomUUID()}`,
          });
        } catch (error) {
          durableExportMissingLabelError = {
            name: String(error?.name || "Error"),
            message: String(error?.message || error),
          };
        }
        try {
          await sandstorm(request, env).exportDurable(
            `durable-export-missing-registry-${crypto.randomUUID()}`, {
              label: "Missing registry durable export fixture",
            });
        } catch (error) {
          durableExportMissingRegistryError = {
            name: String(error?.name || "Error"),
            message: String(error?.message || error),
          };
        }
        const durableExport = await sandstorm(request, env).exportDurable(durableExportTarget, {
          id: durableExportId,
          storageKey: durableExportStorageKey,
          label: "Durable export fixture",
        });
        const durableExportGet = await durableExport.capability.rpc.get();
        const durableExportTokenType = typeof durableExport.token;
        const durableExportSavedType = typeof durableExport.saved;
        const durableExportDrop = await durableExport.capability.drop();
        const durableExportRevoke = await sandstorm(request, env).revoke(durableExport.token);
        const durableExportDeleteStorage =
          await sandstorm(request, env).storage().delete(durableExportStorageKey);
        const unstoredDurableExportId = `durable-export-unstored-${crypto.randomUUID()}`;
        const unstoredDurableExportTarget = new CounterCapability();
        unstoredDurableExportTarget.increment(73);
        const unstoredDurableExport = await sandstorm(request, env).exportDurable(
          unstoredDurableExportTarget, {
            id: unstoredDurableExportId,
            label: "Unstored durable export fixture",
          });
        const unstoredDurableExportGet = await unstoredDurableExport.capability.rpc.get();
        const unstoredDefaultToken = await sandstorm(request, env).storage().get(
          `object-capability-${unstoredDurableExportId}`);
        const unstoredDurableExportDrop = await unstoredDurableExport.capability.drop();
        const unstoredDurableExportRevoke =
          await sandstorm(request, env).revoke(unstoredDurableExport.token);
        let registryFactoryCalls = 0;
        const registryRouteId = `durable-registry-route-${crypto.randomUUID()}`;
        const registryRouteRequest = new Request(
          `http://worker/__sandstorm/object-capabilities/${registryRouteId}/native-app-rpc-call`, {
            method: "POST",
            body: JSON.stringify(serializeNativeAppRpcCall("get", [])),
          });
        const registryRouteApi = sandstorm(registryRouteRequest, env, {
          capabilities: {
            [registryRouteId]: async () => {
              registryFactoryCalls += 1;
              const target = new CounterCapability();
              target.increment(83);
              return target;
            },
          },
        });
        const registryFactoryCallsAfterCreate = registryFactoryCalls;
        const registryRouteResponse = await registryRouteApi.serveSystemRoutes();
        const registryRouteBody = await registryRouteResponse.json();
        const registryFactoryCallsAfterRoute = registryFactoryCalls;
        const registryExportId = `durable-registry-export-${crypto.randomUUID()}`;
        const registryExportApi = sandstorm(request, env, {
          capabilities: {
            [registryExportId]: () => {
              registryFactoryCalls += 1;
              const target = new CounterCapability();
              target.increment(89);
              return target;
            },
          },
        });
        const registryFactoryCallsBeforeExport = registryFactoryCalls;
        const registryExport = await registryExportApi.exportDurable(registryExportId, {
          label: "Registry durable export fixture",
        });
        const registryFactoryCallsAfterExport = registryFactoryCalls;
        const registryExportGet = await registryExport.capability.rpc.get();
        const registryExportDrop = await registryExport.capability.drop();
        const registryExportRevoke = await registryExportApi.revoke(registryExport.token);
        const helperId = `persistent-helper-${crypto.randomUUID()}`;
        const helperStorageKey = `persistent-helper-${crypto.randomUUID()}`;
        const helperTarget = new CounterCapability();
        helperTarget.increment(53);
        const helperFirst = await sandstorm(request, env).exportDurable(helperTarget, {
          id: helperId,
          storageKey: helperStorageKey,
          label: "Persistent helper fixture",
        });
        const helperFirstGet = await helperFirst.capability.call("get");
        const helperFirstTokenType = typeof helperFirst.token;
        const helperFirstDrop = await helperFirst.capability.drop();
        const helperSecond = await sandstorm(request, env).exportDurable(helperTarget, {
          id: helperId,
          storageKey: helperStorageKey,
          label: "Persistent helper fixture",
        });
        const helperSecondGet = await helperSecond.capability.call("get");
        const helperSecondTokenType = typeof helperSecond.token;
        const helperSecondDrop = await helperSecond.capability.drop();
        const helperDropSaved = await sandstorm(request, env).revoke(helperSecond.token);
        const helperDeleteStorage = await sandstorm(request, env).storage().delete(helperStorageKey);
        const callbackId = `persistent-callback-${crypto.randomUUID()}`;
        const callbackStorageKey = `callback-capability-${callbackId}`;
        const callbackTarget = new EventReceiver();
        const callbackFirst = await sandstorm(request, env).exportDurable(callbackTarget, {
          id: callbackId,
          storageKey: callbackStorageKey,
          label: "Persistent callback fixture",
        });
        const callbackFirstTokenType = typeof callbackFirst.token;
        const callbackFirstEvent = await callbackFirst.capability.rpc.onMailEvent({
          subject: "phase-6-durable-callback-first",
          unread: 7,
        });
        const callbackFirstDrop = await callbackFirst.capability.drop();
        const callbackSecond = await sandstorm(request, env).exportDurable(callbackTarget, {
          id: callbackId,
          storageKey: callbackStorageKey,
          label: "Persistent callback fixture",
        });
        const callbackSecondTokenType = typeof callbackSecond.token;
        const callbackSecondEvent = await callbackSecond.capability.rpc.onMailEvent({
          subject: "phase-6-durable-callback-restored",
          unread: 9,
        });
        const callbackSecondDrop = await callbackSecond.capability.drop();
        const callbackDropSaved = await sandstorm(request, env).revoke(callbackSecond.token);
        const callbackDeleteStorage =
          await sandstorm(request, env).storage().delete(callbackSecond.storageKey);
        persistentHelper = {
          export: {
            capability: JSON.parse(JSON.stringify(exported)),
            increment: exportedIncrement,
            drop: exportedDrop,
          },
          withExport: {
            read: withExportRead,
          },
          durableExport: {
            id: durableExport.id,
            restored: durableExport.restored,
            registered: durableExport.registered,
            capability: JSON.parse(JSON.stringify(durableExport.capability)),
            tokenType: durableExportTokenType,
            savedType: durableExportSavedType,
            missingLabelError: durableExportMissingLabelError,
            missingRegistryError: durableExportMissingRegistryError,
            get: durableExportGet,
            drop: durableExportDrop,
            revoke: durableExportRevoke,
            deleteStorage: durableExportDeleteStorage,
          },
          unstoredDurableExport: {
            id: unstoredDurableExport.id,
            restored: unstoredDurableExport.restored,
            registered: unstoredDurableExport.registered,
            storageKeyType: typeof unstoredDurableExport.storageKey,
            tokenType: typeof unstoredDurableExport.token,
            defaultStoredType: typeof unstoredDefaultToken,
            get: unstoredDurableExportGet,
            drop: unstoredDurableExportDrop,
            revoke: unstoredDurableExportRevoke,
          },
          registry: {
            factoryCallsAfterCreate: registryFactoryCallsAfterCreate,
            route: {
              status: registryRouteResponse.status,
              body: registryRouteBody,
              factoryCallsAfterRoute: registryFactoryCallsAfterRoute,
            },
            export: {
              id: registryExport.id,
              restored: registryExport.restored,
              registered: registryExport.registered,
              tokenType: typeof registryExport.token,
              get: registryExportGet,
              drop: registryExportDrop,
              revoke: registryExportRevoke,
              factoryCallsBeforeExport: registryFactoryCallsBeforeExport,
              factoryCallsAfterExport: registryFactoryCallsAfterExport,
            },
          },
          id: helperId,
          storageKey: helperStorageKey,
          first: {
            restored: helperFirst.restored,
            registered: helperFirst.registered,
            capability: JSON.parse(JSON.stringify(helperFirst.capability)),
            tokenType: helperFirstTokenType,
            get: helperFirstGet,
            drop: helperFirstDrop,
          },
          second: {
            restored: helperSecond.restored,
            registered: helperSecond.registered,
            capability: JSON.parse(JSON.stringify(helperSecond.capability)),
            tokenType: helperSecondTokenType,
            get: helperSecondGet,
            drop: helperSecondDrop,
          },
          dropSaved: helperDropSaved,
          deleteStorage: helperDeleteStorage,
          callback: {
            id: callbackId,
            storageKey: callbackFirst.storageKey,
            expectedStorageKey: callbackStorageKey,
            first: {
              restored: callbackFirst.restored,
              registered: callbackFirst.registered,
              capability: JSON.parse(JSON.stringify(callbackFirst.capability)),
              tokenType: callbackFirstTokenType,
              event: callbackFirstEvent,
              drop: callbackFirstDrop,
            },
            second: {
              restored: callbackSecond.restored,
              registered: callbackSecond.registered,
              capability: JSON.parse(JSON.stringify(callbackSecond.capability)),
              tokenType: callbackSecondTokenType,
              event: callbackSecondEvent,
              drop: callbackSecondDrop,
            },
            events: callbackTarget.events(),
            dropSaved: callbackDropSaved,
            deleteStorage: callbackDeleteStorage,
          },
        };
      }
      return Response.json({
        ok: true,
        first,
        second,
        current,
        childClass: child instanceof Capability,
        childCapabilityAliasClass: child instanceof Capability,
        child: JSON.parse(JSON.stringify(child)),
        capabilityInfo,
        childInfo,
        childFirst,
        readChild,
        rpcStable,
        rpcCurrent,
        stubFirst,
        stubCurrent,
        stubChildClass: stubChild instanceof Capability,
        stubChild: JSON.parse(JSON.stringify(stubChild)),
        stubChildFirst,
        stubReadChild,
        argumentTarget: {
          rawError: rawArgumentTargetError,
          read: readArgumentTarget,
          drop: dropArgumentTarget,
          disposeBefore: disposeBeforeArgumentTarget,
          disposeAfter: disposeAfterArgumentTarget,
        },
        stubArgumentTarget: {
          rawError: rawStubArgumentTargetError,
          read: stubReadArgumentTarget.read,
          disposeBefore: stubReadArgumentTarget.disposeBefore,
          disposeAfter: disposeAfterStubArgumentTarget,
        },
        retainedArgumentTarget: {
          rawError: rawRetainedArgumentTargetError,
          retain: retainedArgumentExport.retain,
          disposeBefore: disposeBeforeRetainedArgumentTarget,
          disposeAfterRetainCall: retainedArgumentExport.disposeAfterRetainCall,
          read: readRetainedArgumentTarget,
          drop: dropRetainedArgumentTarget,
          disposeAfterDrop: disposeAfterDropRetainedArgumentTarget,
        },
        liveCallback: {
          subscription,
          events: receiver.events(),
          disposeBefore: disposeBeforeLiveCallback,
          disposeAfter: disposeAfterLiveCallback,
          sessionClass: session instanceof Capability,
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
          capabilityError: remoteCapabilityArgumentError,
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
          duplicateExportError: persistentDuplicateExportError,
          transientMintError: persistentTransientMintError,
          mintedAfterRegister: JSON.parse(JSON.stringify(persistentMintedAfterRegister.capability)),
          mintedAfterRegisterGet: persistentMintedAfterRegisterGet,
          dropMintedAfterRegister: persistentDropMintedAfterRegister,
          restoredAfterRegister: JSON.parse(JSON.stringify(persistentRestoredAfterRegister)),
          restoredAfterRegisterGet: persistentRestoredAfterRegisterGet,
          dropRestoredAfterRegister: persistentDropRestoredAfterRegister,
          topLevelRestored: JSON.parse(JSON.stringify(persistentTopLevelRestored)),
          topLevelRestoreGet: persistentTopLevelRestoreGet,
          dropTopLevelRestored: persistentDropTopLevelRestored,
          useGet: persistentUseGet,
          dropSaved: persistentDropSaved,
          helper: persistentHelper,
        },
      });
    }

    if (url.pathname === "/capnp-binding-object-self-test") {
      const api = sandstorm(request, env);
      const local = GeneratedCounter.local(new CounterCapability());
      const localFirst = await local.increment(2);
      const localCurrent = await local.get();
      const localChild = await local.child();
      const localChildFirst = await localChild.increment(3);
      const localChildCurrent = await localChild.get();
      const localReadChild = await local.readOther(localChild);
      const localChildren = await local.children();
      const localLeftFirst = await localChildren.left.increment(19);
      const localRightFirst = await localChildren.right.increment(23);
      const localNestedRead = await local.readNested({ wrapper: { other: localChild } });
      const localNestedChildren = await local.nestedChildren();
      const localNestedLeftFirst = await localNestedChildren.group.left.increment(37);
      const localNestedRightFirst = await localNestedChildren.group.right.increment(41);

      const transient = await api.export(GeneratedCounter.implement(new CounterCapability()));
      const transientClient = GeneratedCounter.cast(transient);
      const transientFirst = await transientClient.increment(5);
      const transientCurrent = await transientClient.get();
      const childClient = await transientClient.child();
      const childFirst = await childClient.increment(7);
      const readChild = await transientClient.readOther(childClient);
      const children = await transientClient.children();
      const leftFirst = await children.left.increment(29);
      const rightFirst = await children.right.increment(31);
      const nestedRead = await transientClient.readNested({ wrapper: { other: childClient } });
      const nestedChildren = await transientClient.nestedChildren();
      const nestedLeftFirst = await nestedChildren.group.left.increment(43);
      const nestedRightFirst = await nestedChildren.group.right.increment(47);
      const webSession = await api.webSession({ pathPrefix: "/exported" });
      const mirroredSession = await transientClient.mirrorSession({ session: webSession });
      let wrongMirrorSessionError = null;
      try {
        await transientClient.mirrorSession({ session: childClient });
      } catch (error) {
        wrongMirrorSessionError = {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
        };
      }
      const mirroredSessionInfo = await mirroredSession.session.info();
      const mirroredSessionFetchResponse =
        await mirroredSession.session.fetch("/capability-echo?source=capnp-mirror");
      const mirroredSessionFetch = {
        status: mirroredSessionFetchResponse.status,
        body: await mirroredSessionFetchResponse.json(),
      };

      const durableTarget = new CounterCapability();
      durableTarget.increment(11);
      const durableId = `generated-counter-${crypto.randomUUID()}`;
      const durableStorageKey = `generated-counter-token-${crypto.randomUUID()}`;
      const durable = await api.exportDurable(GeneratedCounter.implement(durableTarget), {
        id: durableId,
        storageKey: durableStorageKey,
        label: "Generated counter binding fixture",
      });
      const durableClient = GeneratedCounter.cast(durable.capability);
      const durableGet = await durableClient.get();
      const durableIncrement = await durableClient.increment(13);
      const castSaved = await durableClient.save({
        label: "Generated counter binding saved through cast client",
      });
      const durableDrop = await durableClient.drop();

      const restored = await api.restore(castSaved);
      const restoredClient = GeneratedCounter.cast(restored);
      const restoredGet = await restoredClient.get();
      const restoredIncrement = await restoredClient.increment(17);
      let restoredFailure;
      try {
        await restoredClient.fail("generated binding failure");
      } catch (error) {
        restoredFailure = {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
          details: {
            name: String(error?.details?.name || ""),
          },
        };
      }

      const restoredDrop = await restoredClient.drop();
      const dropChild = await childClient.drop();
      const dropChildrenLeft = await children.left.drop();
      const dropChildrenRight = await children.right.drop();
      const dropNestedChildrenLeft = await nestedChildren.group.left.drop();
      const dropNestedChildrenRight = await nestedChildren.group.right.drop();
      const dropMirroredSession = await mirroredSession.session.drop();
      const dropTransient = await transientClient.drop();
      const revokeCastSaved = await api.revoke(castSaved);
      const revokeDurableToken = castSaved === durable.token
        ? { ok: true, sameToken: true }
        : await api.revoke(durable.token);
      const deleteStorage = await api.storage().delete(durableStorageKey);

      return Response.json({
        ok: true,
        helperVersion: SANDSTORM_CAPNP_VERSION,
        interfaceName: GeneratedCounter.interfaceName,
        interfaceId: GeneratedCounter.interfaceId,
        schemaPath: GeneratedCounter.schemaPath,
        methodNames: GeneratedCounter.methodNames,
        schema: {
          importSpecifier: GeneratedCounter.schema.importSpecifier,
          interfaceName: GeneratedCounter.schema.interfaceName,
          interfaceId: GeneratedCounter.schema.interfaceId,
          schemaPath: GeneratedCounter.schema.schemaPath,
          schemaText: GeneratedCounter.schema.schemaText,
          methodNames: GeneratedCounter.schema.methodNames,
          methodIds: GeneratedCounter.schema.methodIds,
          paramStructIds: GeneratedCounter.schema.paramStructIds,
          resultStructIds: GeneratedCounter.schema.resultStructIds,
          argumentCapabilities: GeneratedCounter.schema.argumentCapabilities,
          resultCapabilityNames: Object.keys(GeneratedCounter.schema.resultCapabilities),
        },
        local: {
          first: localFirst,
          current: localCurrent,
          child: {
            first: localChildFirst,
            current: localChildCurrent,
            read: localReadChild,
          },
          children: {
            left: localLeftFirst,
            right: localRightFirst,
          },
          nested: {
            read: localNestedRead,
            left: localNestedLeftFirst,
            right: localNestedRightFirst,
          },
        },
        transient: {
          capability: JSON.parse(JSON.stringify(transient)),
          first: transientFirst,
          current: transientCurrent,
        },
        child: {
          capability: JSON.parse(JSON.stringify(childClient.capability)),
          first: childFirst,
          read: readChild,
          drop: dropChild,
        },
        children: {
          leftCapability: JSON.parse(JSON.stringify(children.left.capability)),
          rightCapability: JSON.parse(JSON.stringify(children.right.capability)),
          left: leftFirst,
          right: rightFirst,
          leftDrop: dropChildrenLeft,
          rightDrop: dropChildrenRight,
        },
        nested: {
          read: nestedRead,
          leftCapability: JSON.parse(JSON.stringify(nestedChildren.group.left.capability)),
          rightCapability: JSON.parse(JSON.stringify(nestedChildren.group.right.capability)),
          left: nestedLeftFirst,
          right: nestedRightFirst,
          leftDrop: dropNestedChildrenLeft,
          rightDrop: dropNestedChildrenRight,
        },
        mirroredSession: {
          capability: JSON.parse(JSON.stringify(mirroredSession.session)),
          info: mirroredSessionInfo,
          fetch: mirroredSessionFetch,
          drop: dropMirroredSession,
          wrongSessionError: wrongMirrorSessionError,
        },
        durable: {
          id: durable.id,
          registered: durable.registered,
          restored: durable.restored,
          tokenType: typeof durable.token,
          castSavedType: typeof castSaved,
          get: durableGet,
          increment: durableIncrement,
          drop: durableDrop,
          restoredCapability: JSON.parse(JSON.stringify(restored)),
          restoredGet,
          restoredIncrement,
          restoredFailure,
          restoredDrop,
          revokeCastSaved,
          revokeDurableToken,
          deleteStorage,
        },
        dropTransient,
      });
    }

    if (url.pathname === "/claim-powerbox") {
      const sessionId = request.headers.get("x-sandstorm-session-id") || "";
      const token = url.searchParams.get("token") || "";
      const requiredPermissions = url.searchParams.getAll("requiredPermission");
      const permissionQuery = requiredPermissions
        .map((permission) => `&requiredPermission=${encodeURIComponent(permission)}`)
        .join("");
      const nativeInterface = url.searchParams.get("nativeInterface");
      const nativeInterfaceQuery = nativeInterface === null
        ? ""
        : `&nativeInterface=${encodeURIComponent(nativeInterface)}`;
      let claimResponseOk = false;
      let claimResponseStatus = 500;
      let claim;
      if (url.searchParams.get("fetch") === "true" ||
          url.searchParams.get("helperClaim") === "true") {
        const claimOptions = {
          requiredPermissions,
        };
        if (nativeInterface !== null) {
          claimOptions.nativeInterface = nativeInterface;
        }
        claim = await sandstormPowerbox(request, env).claim(token, claimOptions);
        claimResponseOk = true;
        claimResponseStatus = 200;
      } else {
        const claimResponse = await env.SANDSTORM_API.fetch(
          `http://sandstorm/powerbox/claim-request?` +
          `sessionId=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(token)}` +
          permissionQuery + nativeInterfaceQuery,
          { method: "POST" });
        claimResponseOk = claimResponse.ok;
        claimResponseStatus = claimResponse.status;
        claim = await claimResponse.json();
      }
      const claimType = {
        capabilityClass: claim instanceof Capability,
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
      let savedToken = null;
      if (claim.ok && claim.id && url.searchParams.get("save") === "true") {
        const label = url.searchParams.get("label") || "Isolate test saved capability";
        if (typeof claim.save === "function") {
          savedToken = await claim.save({ label });
          save = {
            status: 200,
            body: {
              ok: true,
              token: savedToken,
            },
            typed: {
              savedToken: typeof savedToken === "string",
              json: savedToken,
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
        if (savedToken) {
          restoredCapability = await sandstorm(request, env).restore(restoreToken);
          restore = {
            status: 200,
            body: restoredCapability,
            typed: {
              restoredClass: restoredCapability instanceof Capability,
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
          if (restoredCapability) {
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
          capabilityClass: tiedCapability instanceof Capability,
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
        if (savedToken) {
          dropSaved = {
            status: 200,
            body: await sandstorm(request, env).revoke(restoreToken),
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
      const api = sandstorm(request, env);
      const helper = api.powerbox();
      const store = api.storage();

      async function claimSaveStore(result, { storageKey, label, ...claimOptions }) {
        const capability = await helper.claim(result, claimOptions);
        let token;
        try {
          token = await capability.save({ label });
          await store.put(storageKey, token);
          return {
            ok: true,
            capability,
            token,
            storageKey,
          };
        } catch (error) {
          await capability.drop().catch(() => {});
          if (token) await api.revoke(token).catch(() => {});
          throw error;
        }
      }

      async function restoreTokenFromStorage(storageKey) {
        const token = await store.get(storageKey);
        if (!token) {
          return {
            ok: true,
            storageKey,
            found: false,
            capability: undefined,
          };
        }
        return {
          ok: true,
          storageKey,
          found: true,
          token,
          capability: await api.restore(token),
        };
      }

      async function fetchViaStoredToken(storageKey, input) {
        const token = await store.get(storageKey);
        if (!token) {
          throw new Error(`missing saved token: ${storageKey}`);
        }
        return await api.use(token, async (capability) => {
          const response = await capability.fetch(input);
          return {
            status: response.status,
            body: await response.json(),
          };
        });
      }

      async function revokeTokenFromStorage(storageKey) {
        const token = await store.get(storageKey);
        if (!token) {
          return {
            ok: true,
            storageKey,
            dropped: false,
            deleted: await store.delete(storageKey),
          };
        }
        const dropped = await api.revoke(token);
        const deleted = await store.delete(storageKey);
        return {
          ok: true,
          storageKey,
          dropped: true,
          dropSaved: dropped,
          deleted,
        };
      }

      const storageKey = "powerbox-storage-helper-token";
      const claimed = await claimSaveStore("websession/test+token==", {
        label: "WebSession saved capability",
        storageKey,
        requiredPermissions: ["view"],
      });
      const originalFetch = await claimed.capability.fetch("/capability-echo?source=helper-original");
      const dropOriginal = await claimed.capability.drop();
      const fetchViaStoredTokenResult =
        await fetchViaStoredToken(storageKey, "/capability-echo?source=helper-fetch-saved");
      const restored = await restoreTokenFromStorage(storageKey);
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
      const handleClaimed = await claimSaveStore({
        capability: handleSource,
      }, {
        label: "WebSession saved from claimed handle",
        storageKey: handleStorageKey,
      });
      const aliasSource = await sandstorm(request, env).webSession({
        pathPrefix: "/exported",
      });
      const claimAlias = await helper.claim({ capability: aliasSource });
      const dropHandleClaimed = await handleClaimed.capability.drop();
      const dropClaimAlias = await claimAlias.drop();
      const handleFetchSaved =
        await fetchViaStoredToken(handleStorageKey, "/capability-echo?source=helper-handle-fetch");
      const dropHandleSaved = await revokeTokenFromStorage(handleStorageKey);

      const dropSaved = await revokeTokenFromStorage(storageKey);
      const afterDrop = await restoreTokenFromStorage(storageKey);
      return Response.json({
        ok: true,
        claimed: {
          ok: claimed.ok,
          capabilityClass: claimed.capability instanceof Capability,
          tokenType: typeof claimed.token,
          storageKey: claimed.storageKey,
          token: claimed.token,
        },
        originalFetch: {
          status: originalFetch.status,
          body: await originalFetch.json(),
        },
        dropOriginal,
        fetchViaStoredToken: fetchViaStoredTokenResult,
        restored: {
          ok: restored.ok,
          found: restored.found,
          capabilityClass: restored.capability instanceof Capability,
          storageKey: restored.storageKey,
          token: restored.token,
        },
        restoredFetch,
        dropRestored,
        handleClaimed: {
          ok: handleClaimed.ok,
          capabilityClass: handleClaimed.capability instanceof Capability,
          tokenType: typeof handleClaimed.token,
          storageKey: handleClaimed.storageKey,
          token: handleClaimed.token,
        },
        claimAlias: {
          capabilityClass: claimAlias instanceof Capability,
          capabilityAliasClass: claimAlias instanceof Capability,
          id: claimAlias.id,
        },
        dropHandleClaimed,
        dropClaimAlias,
        handleFetchSaved,
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
    const apiCapnpBridgeInfo =
        await (await env.SANDSTORM_API.fetch("http://sandstorm/capnp/bridge-info")).json();
    const apiHelper = sandstorm(request, env);
    const helperCapnpBridgeInfo = await apiHelper.capnpBridgeInfo();
    const capnpBridgeNegotiation = await negotiateNativeCapnpBridge(apiHelper, {
      requiredFeatures: ["nativeCalls", "capabilitySlots"],
    });
    const nativeCapnpTarget = await apiHelper.webSession({
      pathPrefix: "/native-capnp-bridge-target",
    });
    const nativeCapnpPayload = makeNativeCapnpPayload(new CapnpEsMessage(), [
      {
        id: "argument-capability",
        interfaceId: "0xd7a322498a996313",
        interfaceName: "sandstorm.IsolateObjectCapability",
        kind: "senderHosted",
      },
    ]);
    const nativeCapnpBridgeRequest = makeNativeCapnpBridgeCallRequest({
      target: {
        id: nativeCapnpTarget.id,
        interfaceId: "0xa8e9655582dcde6f",
        interfaceName: "sandstorm.WebSession",
        kind: "receiverHosted",
      },
      method: {
        interfaceId: "0xa8e9655582dcde6f",
        interfaceName: "sandstorm.WebSession",
        methodOrdinal: 2,
        methodName: "get",
      },
      payload: nativeCapnpPayload,
    });
    const unknownNativeCapnpBridgeRequest = makeNativeCapnpBridgeCallRequest({
      target: {
        id: "unknown-target-capability",
        interfaceId: "0xa8e9655582dcde6f",
        interfaceName: "sandstorm.WebSession",
        kind: "receiverHosted",
      },
      method: {
        interfaceId: "0xa8e9655582dcde6f",
        interfaceName: "sandstorm.WebSession",
        methodOrdinal: 2,
        methodName: "get",
      },
      payload: nativeCapnpPayload,
    });
    const nativeCapnpBridgeDropRequest = makeNativeCapnpBridgeDropRequest({
      target: {
        id: nativeCapnpTarget.id,
        interfaceId: "0xa8e9655582dcde6f",
        interfaceName: "sandstorm.WebSession",
        kind: "receiverHosted",
      },
    });
    const nativeCapnpBridgeSaveRequest = makeNativeCapnpBridgeSaveRequest({
      target: {
        id: nativeCapnpTarget.id,
        interfaceId: "0xa8e9655582dcde6f",
        interfaceName: "sandstorm.WebSession",
        kind: "receiverHosted",
      },
    });
    const nativeCapnpBridgeRestoreRequest = makeNativeCapnpBridgeRestoreRequest({
      token: "native-bridge-saved-token",
      expectedInterfaceId: "0xa8e9655582dcde6f",
      expectedInterfaceName: "sandstorm.WebSession",
    });
    const nativeCapnpRpcMessage = new CapnpEsMessage();
    nativeCapnpRpcMessage.initRoot(CapnpRpcMessage);
    const nativeCapnpBridgeRpcRequest = makeNativeCapnpBridgeRpcRequest({
      target: {
        id: nativeCapnpTarget.id,
        interfaceId: "0xa8e9655582dcde6f",
        interfaceName: "sandstorm.WebSession",
        kind: "receiverHosted",
      },
      message: nativeCapnpRpcMessage,
      connectionId: "native-capnp-fixture-rpc",
      capabilities: [
        {
          id: "rpc-argument-capability",
          interfaceId: "0xd7a322498a996313",
          interfaceName: "sandstorm.IsolateObjectCapability",
          kind: "senderHosted",
        },
      ],
    });
    const nativeCapnpBridgeRequestRoot =
        readNativeCapnpBridgeRequest(nativeCapnpBridgeRequest.message);
    const nativeCapnpBridgeRequestCall = nativeCapnpBridgeRequestRoot.call;
    const nativeCapnpBridgeRequestParams = nativeCapnpBridgeRequestCall.params;
    const nativeCapnpBridgeDropRequestRoot =
        readNativeCapnpBridgeRequest(nativeCapnpBridgeDropRequest.message);
    const nativeCapnpBridgeSaveRequestRoot =
        readNativeCapnpBridgeRequest(nativeCapnpBridgeSaveRequest.message);
    const nativeCapnpBridgeRestoreRequestRoot =
        readNativeCapnpBridgeRequest(nativeCapnpBridgeRestoreRequest.message);
    const nativeCapnpBridgeRpcRequestRoot =
        readNativeCapnpBridgeRequest(nativeCapnpBridgeRpcRequest.message);
    const nativeCapnpBridgeRpc = nativeCapnpBridgeRpcRequestRoot.rpc;
    const nativeCapnpBridgeRpcMessage = nativeCapnpBridgeRpc.message;
    const nativeCapnpBridgeResultResponse = makeNativeCapnpBridgeResultResponse({
      payload: nativeCapnpPayload,
    });
    const decodedNativeCapnpBridgeResultResponse =
        decodeNativeCapnpBridgeResponse(nativeCapnpBridgeResultResponse.message);
    const nativeCapnpBridgeResultValue = decodedNativeCapnpBridgeResultResponse.result.value;
    const nativeCapnpBridgeResultCapability = nativeCapnpBridgeResultValue.capabilities[0];
    const nativeCapnpBridgeExceptionResponse = makeNativeCapnpBridgeExceptionResponse({
      type: "unimplemented",
      reason: "fixture exception",
      trace: "fixture trace",
    });
    const decodedNativeCapnpBridgeExceptionResponse =
        decodeNativeCapnpBridgeResponse(nativeCapnpBridgeExceptionResponse.message);
    const nativeCapnpBridgeAcknowledgedResponse =
        makeNativeCapnpBridgeAcknowledgedResponse();
    const decodedNativeCapnpBridgeAcknowledgedResponse =
        decodeNativeCapnpBridgeResponse(nativeCapnpBridgeAcknowledgedResponse.message);
    const nativeCapnpBridgeSavedResponse = makeNativeCapnpBridgeSavedResponse({
      token: "native-bridge-saved-token",
    });
    const decodedNativeCapnpBridgeSavedResponse =
        decodeNativeCapnpBridgeResponse(nativeCapnpBridgeSavedResponse.message);
    const nativeCapnpBridgeCapabilityResponse = makeNativeCapnpBridgeCapabilityResponse({
      capability: {
        id: nativeCapnpTarget.id,
        interfaceId: "0xa8e9655582dcde6f",
        interfaceName: "sandstorm.WebSession",
        kind: "receiverHosted",
      },
    });
    const decodedNativeCapnpBridgeCapabilityResponse =
        decodeNativeCapnpBridgeResponse(nativeCapnpBridgeCapabilityResponse.message);
    const nativeCapnpBridge = await createNativeCapnpBridge(apiHelper, {
      requiredFeatures: ["nativeCalls", "capabilitySlots"],
    });
    const nativeCapnpBridgeClientResponses = [
      nativeCapnpBridgeResultResponse,
      nativeCapnpBridgeAcknowledgedResponse,
      nativeCapnpBridgeSavedResponse,
      nativeCapnpBridgeCapabilityResponse,
    ];
    const nativeCapnpBridgeClient = await createNativeCapnpBridge({
      capnpBridgeInfo: async () => ({
        ok: true,
        type: "capnpBridgeInfo",
        protocolVersion: 0,
        minProtocolVersion: 0,
        maxProtocolVersion: 0,
        nativeTransport: true,
        nativeCalls: true,
        nativeExports: false,
        capabilitySlots: true,
        fallbackTransport: "appObjectRpc",
      }),
      nativeCapnpBridgeCallBytes: async () => ({
        ok: true,
        status: 200,
        contentType: "application/octet-stream",
        body: nativeCapnpBridgeClientResponses.shift().message,
      }),
    }, {
      requiredFeatures: ["nativeCalls", "capabilitySlots"],
    });
    const nativeCapnpBridgeClientCallResult = await nativeCapnpBridgeClient.call({
      target: nativeCapnpTarget,
      binding: {
        interfaceName: "sandstorm.WebSession",
        schema: {
          interfaceId: "0xa8e9655582dcde6f",
          interfaceName: "sandstorm.WebSession",
          methodIds: { get: 2 },
        },
      },
      methodName: "get",
      params: new CapnpEsMessage(),
    });
    const nativeCapnpBridgeClientCallCapability =
        nativeCapnpBridgeClientCallResult.capabilities[0];
    const nativeCapnpBridgeClientDropResult = await nativeCapnpBridgeClient.drop({
      target: nativeCapnpTarget,
    });
    const nativeCapnpBridgeClientSaveResult = await nativeCapnpBridgeClient.save({
      target: nativeCapnpTarget,
    });
    const nativeCapnpBridgeClientRestoreResult = await nativeCapnpBridgeClient.restore({
      token: nativeCapnpBridgeClientSaveResult,
      binding: {
        interfaceName: "sandstorm.WebSession",
        schema: {
          interfaceId: "0xa8e9655582dcde6f",
          interfaceName: "sandstorm.WebSession",
          methodIds: { get: 2 },
        },
      },
    });
    const nativeCapnpBridgeCall =
        await apiHelper.nativeCapnpBridgeCall(nativeCapnpBridgeRequest.message);
    const nativeCapnpBridgeDrop =
        await apiHelper.nativeCapnpBridgeCall(nativeCapnpBridgeDropRequest.message);
    const nativeCapnpBridgeSave =
        await apiHelper.nativeCapnpBridgeCall(nativeCapnpBridgeSaveRequest.message);
    const nativeCapnpBridgeRestore =
        await apiHelper.nativeCapnpBridgeCall(nativeCapnpBridgeRestoreRequest.message);
    const nativeCapnpBridgeBinaryCall =
        await apiHelper.nativeCapnpBridgeCallBytes(nativeCapnpBridgeRequest.message);
    const decodedNativeCapnpBridgeBinaryCall =
        decodeNativeCapnpBridgeResponse(nativeCapnpBridgeBinaryCall.body);
    const nativeCapnpBridgeRpcRoute =
        await apiHelper.nativeCapnpBridgeCall(nativeCapnpBridgeRpcRequest.message);
    const nativeCapnpBridgeBinaryRpc =
        await apiHelper.nativeCapnpBridgeCallBytes(nativeCapnpBridgeRpcRequest.message);
    const decodedNativeCapnpBridgeBinaryRpc =
        decodeNativeCapnpBridgeResponse(nativeCapnpBridgeBinaryRpc.body);
    const nativeCapnpBridgeTransport =
        new NativeCapnpBridgeTransport(apiHelper, nativeCapnpTarget, {
          connectionId: "native-capnp-fixture-transport",
        });
    let nativeCapnpBridgeTransportError = "";
    nativeCapnpBridgeTransport.sendMessage(nativeCapnpRpcMessage.getRoot(CapnpRpcMessage));
    try {
      await nativeCapnpBridgeTransport.recvMessage();
    } catch (error) {
      nativeCapnpBridgeTransportError = error.name;
    }
    let nativeCapnpLifecycleBinary = null;
    if (url.searchParams.has("nativeLifecycle")) {
      const nativeCapnpLifecycleTarget = await apiHelper.webSession({
        pathPrefix: "/native-capnp-bridge-lifecycle-target",
      });
      const nativeCapnpLifecycleSave =
          await apiHelper.nativeCapnpBridgeCallBytes(makeNativeCapnpBridgeSaveRequest({
            target: {
              id: nativeCapnpLifecycleTarget.id,
              interfaceId: "0xa8e9655582dcde6f",
              interfaceName: "sandstorm.WebSession",
              kind: "receiverHosted",
            },
          }).message);
      const decodedNativeCapnpLifecycleSave =
          decodeNativeCapnpBridgeResponse(nativeCapnpLifecycleSave.body);
      const nativeCapnpLifecycleRestore =
          await apiHelper.nativeCapnpBridgeCallBytes(makeNativeCapnpBridgeRestoreRequest({
            token: decodedNativeCapnpLifecycleSave.saved.token,
            expectedInterfaceId: "0xa8e9655582dcde6f",
            expectedInterfaceName: "sandstorm.WebSession",
          }).message);
      const decodedNativeCapnpLifecycleRestore =
          decodeNativeCapnpBridgeResponse(nativeCapnpLifecycleRestore.body);
      const nativeCapnpLifecycleDrop =
          await apiHelper.nativeCapnpBridgeCallBytes(makeNativeCapnpBridgeDropRequest({
            target: decodedNativeCapnpLifecycleRestore.capability,
          }).message);
      const decodedNativeCapnpLifecycleDrop =
          decodeNativeCapnpBridgeResponse(nativeCapnpLifecycleDrop.body);
      nativeCapnpLifecycleBinary = {
        save: {
          ok: nativeCapnpLifecycleSave.ok,
          status: nativeCapnpLifecycleSave.status,
          contentType: nativeCapnpLifecycleSave.contentType,
          bytes: nativeCapnpLifecycleSave.body.byteLength,
          which: decodedNativeCapnpLifecycleSave.which,
          token: decodedNativeCapnpLifecycleSave.saved.token,
        },
        restore: {
          ok: nativeCapnpLifecycleRestore.ok,
          status: nativeCapnpLifecycleRestore.status,
          contentType: nativeCapnpLifecycleRestore.contentType,
          bytes: nativeCapnpLifecycleRestore.body.byteLength,
          which: decodedNativeCapnpLifecycleRestore.which,
          capability: {
            id: decodedNativeCapnpLifecycleRestore.capability.id,
            interfaceId: decodedNativeCapnpLifecycleRestore.capability.interfaceId
                .toString(16),
            interfaceName: decodedNativeCapnpLifecycleRestore.capability.interfaceName,
            kind: decodedNativeCapnpLifecycleRestore.capability.kind,
          },
        },
        drop: {
          ok: nativeCapnpLifecycleDrop.ok,
          status: nativeCapnpLifecycleDrop.status,
          contentType: nativeCapnpLifecycleDrop.contentType,
          bytes: nativeCapnpLifecycleDrop.body.byteLength,
          which: decodedNativeCapnpLifecycleDrop.which,
        },
      };
    }
    const unknownNativeCapnpBridgeCall =
        await apiHelper.nativeCapnpBridgeCall(unknownNativeCapnpBridgeRequest.message);
    let nativeCapnpBridgeCallError = "";
    try {
      await nativeCapnpBridge.call();
    } catch (error) {
      nativeCapnpBridgeCallError = error.name;
    }

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
      capnpEs: {
        messageBytes: new CapnpEsMessage().toUint8Array().byteLength,
        payloadBytes: nativeCapnpPayload.message.byteLength,
        bridgeRequestBytes: nativeCapnpBridgeRequest.message.byteLength,
        bridgeRequest: {
          protocolVersion: nativeCapnpBridgeRequestRoot.protocolVersion,
          which: nativeCapnpBridgeRequestRoot.which(),
          target: {
            id: nativeCapnpBridgeRequestCall.target.id,
            interfaceId: nativeCapnpBridgeRequestCall.target.interfaceId.toString(16),
            interfaceName: nativeCapnpBridgeRequestCall.target.interfaceName,
            kind: nativeCapnpBridgeRequestCall.target.kind,
          },
          interfaceId: nativeCapnpBridgeRequestCall.interfaceId.toString(16),
          methodOrdinal: nativeCapnpBridgeRequestCall.methodOrdinal,
          methodName: nativeCapnpBridgeRequestCall.methodName,
          paramsBytes: nativeCapnpBridgeRequestParams.message.toUint8Array().byteLength,
          capabilityCount: nativeCapnpBridgeRequestParams.capabilities.length,
          firstCapability: {
            id: nativeCapnpBridgeRequestParams.capabilities.get(0).id,
            interfaceId: nativeCapnpBridgeRequestParams.capabilities.get(0)
                .interfaceId.toString(16),
            interfaceName: nativeCapnpBridgeRequestParams.capabilities.get(0).interfaceName,
            kind: nativeCapnpBridgeRequestParams.capabilities.get(0).kind,
          },
        },
        bridgeResultResponse: {
          bytes: nativeCapnpBridgeResultResponse.message.byteLength,
          protocolVersion: decodedNativeCapnpBridgeResultResponse.protocolVersion,
          which: decodedNativeCapnpBridgeResultResponse.which,
          resultWhich: decodedNativeCapnpBridgeResultResponse.result.which,
          valueBytes: nativeCapnpBridgeResultValue.message.byteLength,
          capabilityCount: nativeCapnpBridgeResultValue.capabilities.length,
          firstCapability: {
            id: nativeCapnpBridgeResultCapability.id,
            interfaceId: nativeCapnpBridgeResultCapability.interfaceId.toString(16),
            interfaceName: nativeCapnpBridgeResultCapability.interfaceName,
            kind: nativeCapnpBridgeResultCapability.kind,
          },
        },
        bridgeExceptionResponse: {
          bytes: nativeCapnpBridgeExceptionResponse.message.byteLength,
          protocolVersion: decodedNativeCapnpBridgeExceptionResponse.protocolVersion,
          which: decodedNativeCapnpBridgeExceptionResponse.which,
          exception: decodedNativeCapnpBridgeExceptionResponse.exception,
        },
        bridgeLifecycle: {
          dropRequest: {
            protocolVersion: nativeCapnpBridgeDropRequestRoot.protocolVersion,
            which: nativeCapnpBridgeDropRequestRoot.which(),
            targetId: nativeCapnpBridgeDropRequestRoot.drop.target.id,
          },
          saveRequest: {
            protocolVersion: nativeCapnpBridgeSaveRequestRoot.protocolVersion,
            which: nativeCapnpBridgeSaveRequestRoot.which(),
            targetId: nativeCapnpBridgeSaveRequestRoot.save.target.id,
          },
          restoreRequest: {
            protocolVersion: nativeCapnpBridgeRestoreRequestRoot.protocolVersion,
            which: nativeCapnpBridgeRestoreRequestRoot.which(),
            token: nativeCapnpBridgeRestoreRequestRoot.restore.token,
            expectedInterfaceId: nativeCapnpBridgeRestoreRequestRoot.restore.expectedInterfaceId
                .toString(16),
            expectedInterfaceName:
                nativeCapnpBridgeRestoreRequestRoot.restore.expectedInterfaceName,
          },
          rpcRequest: {
            protocolVersion: nativeCapnpBridgeRpcRequestRoot.protocolVersion,
            which: nativeCapnpBridgeRpcRequestRoot.which(),
            targetId: nativeCapnpBridgeRpc.target.id,
            targetInterfaceId: nativeCapnpBridgeRpc.target.interfaceId.toString(16),
            targetInterfaceName: nativeCapnpBridgeRpc.target.interfaceName,
            connectionId: nativeCapnpBridgeRpc.connectionId,
            messageBytes: nativeCapnpBridgeRpcMessage.message.toUint8Array().byteLength,
            capabilityCount: nativeCapnpBridgeRpcMessage.capabilities.length,
            firstCapability: {
              id: nativeCapnpBridgeRpcMessage.capabilities.get(0).id,
              interfaceId: nativeCapnpBridgeRpcMessage.capabilities.get(0)
                  .interfaceId.toString(16),
              interfaceName: nativeCapnpBridgeRpcMessage.capabilities.get(0).interfaceName,
              kind: nativeCapnpBridgeRpcMessage.capabilities.get(0).kind,
            },
          },
          acknowledgedResponse: {
            bytes: nativeCapnpBridgeAcknowledgedResponse.message.byteLength,
            which: decodedNativeCapnpBridgeAcknowledgedResponse.which,
          },
          savedResponse: {
            bytes: nativeCapnpBridgeSavedResponse.message.byteLength,
            which: decodedNativeCapnpBridgeSavedResponse.which,
            token: decodedNativeCapnpBridgeSavedResponse.saved.token,
          },
          capabilityResponse: {
            bytes: nativeCapnpBridgeCapabilityResponse.message.byteLength,
            which: decodedNativeCapnpBridgeCapabilityResponse.which,
            capability: {
              id: decodedNativeCapnpBridgeCapabilityResponse.capability.id,
              interfaceId: decodedNativeCapnpBridgeCapabilityResponse.capability
                  .interfaceId.toString(16),
              interfaceName: decodedNativeCapnpBridgeCapabilityResponse.capability.interfaceName,
              kind: decodedNativeCapnpBridgeCapabilityResponse.capability.kind,
            },
          },
        },
        bridgeClientCall: {
          available: nativeCapnpBridgeClient.available,
          resultBytes: nativeCapnpBridgeClientCallResult.message.byteLength,
          capabilityCount: nativeCapnpBridgeClientCallResult.capabilities.length,
          firstCapability: {
            id: nativeCapnpBridgeClientCallCapability.id,
            interfaceId: nativeCapnpBridgeClientCallCapability.interfaceId.toString(16),
            interfaceName: nativeCapnpBridgeClientCallCapability.interfaceName,
            kind: nativeCapnpBridgeClientCallCapability.kind,
          },
          dropResult: nativeCapnpBridgeClientDropResult ?? null,
          savedToken: nativeCapnpBridgeClientSaveResult,
          restoredCapability: {
            id: nativeCapnpBridgeClientRestoreResult.id,
            interfaceId: nativeCapnpBridgeClientRestoreResult.interfaceId.toString(16),
            interfaceName: nativeCapnpBridgeClientRestoreResult.interfaceName,
            kind: nativeCapnpBridgeClientRestoreResult.kind,
          },
        },
      },
      helperVersions: {
        api: SANDSTORM_API_VERSION,
        rpc: SANDSTORM_RPC_VERSION,
        capnweb: SANDSTORM_CAPNWEB_VERSION,
        capnp: SANDSTORM_CAPNP_VERSION,
        capnpNativeBridge: SANDSTORM_CAPNP_NATIVE_BRIDGE_PROTOCOL_VERSION,
        aggregate: SANDSTORM_HELPER_VERSIONS,
      },
      appRpcTarget: new AppRpcTargetSelfTest(request, env).summary(),
      sandstormApi: {
        status: apiStatus,
        capabilities: apiCapabilities,
        runtime: apiRuntime,
        modules: apiModules,
        bindings: apiBindings,
        capnpBridgeInfo: apiCapnpBridgeInfo,
        helperCapnpBridgeInfo,
        capnpBridgeNegotiation,
        nativeCapnpBridge: {
          available: nativeCapnpBridge.available,
          protocolVersion: nativeCapnpBridge.protocolVersion,
          targetId: nativeCapnpTarget.id,
          callError: nativeCapnpBridgeCallError,
          routeError: nativeCapnpBridgeCall.error,
          routeRequest: nativeCapnpBridgeCall.request,
          dropRequest: nativeCapnpBridgeDrop.request,
          saveRequest: nativeCapnpBridgeSave.request,
          restoreRequest: nativeCapnpBridgeRestore.request,
          rpcRequest: nativeCapnpBridgeRpcRoute.request,
          binaryRoute: {
            ok: nativeCapnpBridgeBinaryCall.ok,
            status: nativeCapnpBridgeBinaryCall.status,
            contentType: nativeCapnpBridgeBinaryCall.contentType,
            bytes: nativeCapnpBridgeBinaryCall.body.byteLength,
            which: decodedNativeCapnpBridgeBinaryCall.which,
            exception: decodedNativeCapnpBridgeBinaryCall.exception,
          },
          rpcBinaryRoute: {
            ok: nativeCapnpBridgeBinaryRpc.ok,
            status: nativeCapnpBridgeBinaryRpc.status,
            contentType: nativeCapnpBridgeBinaryRpc.contentType,
            bytes: nativeCapnpBridgeBinaryRpc.body.byteLength,
            which: decodedNativeCapnpBridgeBinaryRpc.which,
            exception: decodedNativeCapnpBridgeBinaryRpc.exception,
          },
          transportError: nativeCapnpBridgeTransportError,
          lifecycleBinary: nativeCapnpLifecycleBinary,
          unknownTargetError: unknownNativeCapnpBridgeCall.error,
        },
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
