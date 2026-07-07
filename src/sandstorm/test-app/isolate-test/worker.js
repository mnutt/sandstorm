import message from "message.txt";
import metadata from "metadata.json";
import { Message as CapnpEsMessage } from "@mnutt/capnp-es";
import { NativeGreeter } from "capnp:./native-greeter.capnp";
import { Message as CapnpRpcMessage } from "@mnutt/capnp/rpc.mjs";
import { WebSession } from "capnp:/sandstorm/web-session.capnp";
import {
  Capability,
  SANDSTORM_API_VERSION,
  SANDSTORM_HELPER_VERSIONS,
  sandstorm,
  serveSystemRoutes,
  powerbox as sandstormPowerbox,
} from "sandstorm:api";
import {
  SANDSTORM_CAPNP_NATIVE_BRIDGE_PROTOCOL_VERSION,
  SANDSTORM_CAPNP_VERSION,
  NativeCapnpStreamTransport,
  connectNativeCapnp,
  createNativeCapnpBridge,
  decodeNativeCapnpBridgeResponse,
  exportNativeCapnp,
  makeNativeCapnpBridgeAcknowledgedResponse,
  makeNativeCapnpBridgeCallRequest,
  makeNativeCapnpBridgeCapabilityResponse,
  makeNativeCapnpBridgeDropRequest,
  makeNativeCapnpBridgeExceptionResponse,
  makeNativeCapnpBridgeResultResponse,
  makeNativeCapnpBridgeRestoreRequest,
  makeNativeCapnpBridgeSaveRequest,
  makeNativeCapnpBridgeSavedResponse,
  makeNativeCapnpPayload,
  negotiateNativeCapnpBridge,
  nativeCapnpPowerboxDescriptor,
  nativeCapnpPowerboxDescriptorInfo,
  readNativeCapnpBridgeRequest,
  restoreNativeCapnp,
  saveNativeCapnp,
} from "sandstorm:capnp";

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

async function runNativeGreeterConformance(client, {
  helloName,
  childPrefix,
  pipelinedName,
  resolvedName,
  greetName,
} = {}) {
  const hello = await client.hello({
    name: helloName || "conformance",
  });
  const pending = client.makeGreeter({
    prefix: childPrefix || "conformance child",
  });
  const pipelinedHello = await pending.getGreeter().hello({
    name: pipelinedName || "before parent resolves",
  });
  const resolved = await pending;
  const resolvedHello = await resolved.greeter.hello({
    name: resolvedName || "after parent resolves",
  });
  const greeted = await client.greetWith({
    greeter: resolved.greeter,
    name: greetName || "argument",
  });

  return {
    hello: {
      message: hello.message,
    },
    pipelined: {
      message: pipelinedHello.message,
    },
    resolved: {
      hasClient: typeof resolved.greeter?.hello === "function",
      message: resolvedHello.message,
    },
    argument: {
      message: greeted.message,
    },
  };
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
      import { requestPowerbox } from "/__sandstorm/native-capnp/client.js";

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
          const requested = await requestPowerbox(null);
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

export default {
  async fetch(request, env, ctx) {
    const api = sandstorm(request, env);
    const url = new URL(request.url);
    const systemResponse = await api.serveSystemRoutes();
    if (systemResponse) return systemResponse;
    if (url.pathname.startsWith("/__sandstorm/")) {
      return new Response("not found", { status: 404 });
    }

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

    if (url.pathname === "/native-capnp-bridge-target/generated-client") {
      return Response.json({
        ok: true,
        source: "native-capnp-generated-websession",
        method: request.method,
        pathname: url.pathname,
        search: url.search,
      });
    }

    if (url.pathname === "/native-capnp-bridge-target/generated-client-stream") {
      const body = makeBytes(70 * 1024);
      return new Response(body, {
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(body.byteLength),
        },
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
      const capability = await api.powerbox().claim(body);
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

    if (url.pathname === "/export-native-greeter-capability") {
      const api = sandstorm(request, env);
      const id = url.searchParams.get("id") || undefined;
      const target = {
        async hello(params) {
          return {
            message: `cross supervisor native hello ${params.name}`,
          };
        },
        async makeGreeter(params) {
          const greeter = new NativeGreeter.Server({
            async hello(helloParams) {
              return {
                message: `${params.prefix} ${helloParams.name}`,
              };
            },
          }).client();
          return {
            greeter,
          };
        },
        async greetWith(params) {
          const hello = await params.greeter.hello({
            name: `${params.name} from isolate export`,
          });
          return {
            message: `isolate called ${hello.message}`,
          };
        },
      };
      const capability = await exportNativeCapnp(api, NativeGreeter, target, {
        id,
        interfaceName: "NativeGreeter",
      });
      return Response.json({
        ok: true,
        capabilityClass: capability instanceof Capability,
        capability: JSON.parse(JSON.stringify(capability)),
        info: await capability.info(),
      });
    }

    if (url.pathname === "/cross-grain-native-greeter-self-test") {
      const token = url.searchParams.get("token");
      if (!token) {
        return Response.json({ ok: false, error: "missing token" }, { status: 400 });
      }

      const api = sandstorm(request, env);
      if (url.searchParams.get("expectRestoreFailure") === "true") {
        try {
          const unexpectedClient = await restoreNativeCapnp(api, token, NativeGreeter, {
            connectionId: `cross-grain-native-greeter-revoked-${token.slice(0, 16)}`,
            interfaceName: "NativeGreeter",
          });
          const unexpectedHello = await unexpectedClient.hello({
            name: "revoked token",
          });
          return Response.json({
            ok: false,
            restoreFailed: false,
            unexpectedHello: {
              message: unexpectedHello.message,
            },
          }, { status: 500 });
        } catch (error) {
          return Response.json({
            ok: true,
            restoreFailed: true,
            error: {
              name: String(error?.name || "Error"),
              message: String(error?.message || error),
            },
          });
        }
      }

      const client = await restoreNativeCapnp(api, token, NativeGreeter, {
        connectionId: `cross-grain-native-greeter-${token.slice(0, 16)}`,
        interfaceName: "NativeGreeter",
      });
      const hello = await client.hello({
        name: url.searchParams.get("name") || "client isolate",
      });
      const returned = await client.makeGreeter({
        prefix: "isolate returned",
      });
      const returnedHello = await returned.greeter.hello({
        name: "isolate client",
      });
      const greeted = await client.greetWith({
        greeter: returned.greeter,
        name: "client",
      });
      const drop = await client.drop();
      const { id, interfaceId, interfaceName, kind } = client.capability;
      return Response.json({
        ok: true,
        capability: {
          id,
          kind,
          interfaceId: interfaceId.toString(16),
          interfaceName,
        },
        savedToken: token,
        hello: {
          message: hello.message,
        },
        returnedHello: {
          message: returnedHello.message,
        },
        greeted: {
          message: greeted.message,
        },
        dropResult: drop ?? null,
      });
    }

    if (url.pathname === "/legacy-native-greeter-self-test") {
      const token = url.searchParams.get("token");
      if (!token) {
        return Response.json({ ok: false, error: "missing token" }, { status: 400 });
      }

      const api = sandstorm(request, env);
      const client = await restoreNativeCapnp(api, token, NativeGreeter, {
        connectionId: `legacy-native-greeter-${token.slice(0, 16)}`,
        interfaceName: "NativeGreeter",
      });
      const hello = await client.hello({
        name: url.searchParams.get("name") || "client isolate",
      });
      const returned = await client.makeGreeter({
        prefix: "legacy returned",
      });
      const returnedHello = await returned.greeter.hello({
        name: "isolate client",
      });
      const greeted = await client.greetWith({
        greeter: returned.greeter,
        name: "isolate client",
      });
      const drop = await client.drop();
      const { id, interfaceId, interfaceName, kind } = client.capability;
      return Response.json({
        ok: true,
        capability: {
          id,
          kind,
          interfaceId: interfaceId.toString(16),
          interfaceName,
        },
        hello: {
          message: hello.message,
        },
        returnedHello: {
          message: returnedHello.message,
        },
        greeted: {
          message: greeted.message,
        },
        dropResult: drop ?? null,
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
              return Response.json({
                ok: true,
                type: "capabilityInfo",
                id,
                kind: "powerboxClaim",
                residence: "imported",
                nativeInterface: "outboundHttpSession",
                pathPrefix: "",
                persistent: true,
                hasDropNotify: false,
                dropNotifyRefCount: 0,
                supportsWebFetch: false,
                supportsOutboundHttpFetch: true,
                hasNativeCapability: true,
                liveForwardable: true,
              });
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

      return Response.json({
        ok: true,
        calls,
        fetchError,
        outboundFetch,
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
      const grantClient = await grants.serve(new Request("http://app/grant-ui-test/client.js"));
      const grantClientText = await grantClient.clone().text();
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
          status: grantClient.status,
          contentType: grantClient.headers.get("content-type"),
          hasRequestPowerbox: grantClientText.includes("requestPowerbox"),
          importsNativeClient: grantClientText.includes("/__sandstorm/native-capnp/client.js"),
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
        objectFulfill: null,
        durableFulfill: null,
        errorFulfill: {
          status: errorFulfill.status,
          body: await errorFulfill.json(),
        },
      });
    }

    if (url.pathname === "/native-capnp-descriptor-self-test") {
      const powerboxDescriptorInfo = await nativeCapnpPowerboxDescriptorInfo(
        env, NativeGreeter, { interfaceName: "NativeGreeter" });
      const powerboxDescriptor = await nativeCapnpPowerboxDescriptor(
        env, NativeGreeter, { interfaceName: "NativeGreeter" });
      const cachedPowerboxDescriptorInfo = await nativeCapnpPowerboxDescriptorInfo(
        env, NativeGreeter, { interfaceName: "NativeGreeter" });
      cachedPowerboxDescriptorInfo.decoded.interfaceName = "mutated cached descriptor";
      const cachedPowerboxDescriptorInfoAfterMutation =
        await nativeCapnpPowerboxDescriptorInfo(
          env, NativeGreeter, { interfaceName: "NativeGreeter" });

      return Response.json({
        ok: true,
        helperVersion: SANDSTORM_CAPNP_VERSION,
        powerboxDescriptor: {
          interfaceName: "NativeGreeter",
          interfaceId: `0x${NativeGreeter._capnp.typeIdHex}`,
          descriptor: powerboxDescriptor,
          info: powerboxDescriptorInfo,
          cachedInfo: cachedPowerboxDescriptorInfoAfterMutation,
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
    const capnpBridgeRpcNegotiation = await negotiateNativeCapnpBridge(apiHelper, {
      requiredFeatures: ["nativeRpc", "nativeRpcWebSocket"],
    });
    const nativeExportClientToServer = new TransformStream();
    const nativeExportServerToClient = new TransformStream();
    const nativeExportClientTransport = new NativeCapnpStreamTransport(
      nativeExportServerToClient.readable,
      nativeExportClientToServer.writable);
    const nativeExportServerTransport = new NativeCapnpStreamTransport(
      nativeExportClientToServer.readable,
      nativeExportServerToClient.writable);
    const nativeExportRpcMessage = new CapnpEsMessage();
    nativeExportRpcMessage.initRoot(CapnpRpcMessage)._initBootstrap().questionId = 77;
    nativeExportClientTransport.sendMessage(nativeExportRpcMessage.getRoot(CapnpRpcMessage));
    const nativeExportServerMessage = await nativeExportServerTransport.recvMessage();
    nativeExportServerTransport.sendMessage(nativeExportServerMessage);
    const nativeExportEchoMessage = await nativeExportClientTransport.recvMessage();
    nativeExportClientTransport.close();
    nativeExportServerTransport.close();
    class NativeExportFixtureClient {}
    class NativeExportFixtureServer {}
    const nativeExportInterface = {
      Client: NativeExportFixtureClient,
      Server: NativeExportFixtureServer,
      interfaceId: 0x9ea3c98729c78d51n,
      interfaceName: "NativeExportFixture",
    };
    const nativeExportCapability = await exportNativeCapnp(apiHelper, nativeExportInterface, {});
    const nativeExportCapabilityInfo = await nativeExportCapability.info();
    const nativeExportCapabilityDrop = await nativeExportCapability.drop();
    const nativeExportWebSessionTarget = {
      async get(params) {
        const path = typeof params?.path === "string" ? params.path : "";
        const text = `native export websession get ${path}`;
        return {
          content: {
            statusCode: WebSession.Response.SuccessCode.OK,
            mimeType: "text/plain; charset=utf-8",
            body: { bytes: new TextEncoder().encode(text) },
          },
        };
      },
    };
    let nativeExportWebSessionResult;
    try {
      const nativeExportWebSession = await exportNativeCapnp(
        apiHelper,
        WebSession,
        nativeExportWebSessionTarget,
        {
          interfaceId: WebSession.interfaceId ?? WebSession.Client?.interfaceId,
          interfaceName: "sandstorm.WebSession",
        });
      const nativeExportWebSessionFetch =
          await nativeExportWebSession.fetch("/native-export-websession?from=fetch");
      const nativeExportWebSessionInfo = await nativeExportWebSession.info();
      const nativeExportWebSessionDrop = await nativeExportWebSession.drop();
      nativeExportWebSessionResult = {
        ok: true,
        status: nativeExportWebSessionFetch.status,
        contentType: nativeExportWebSessionFetch.headers.get("content-type"),
        text: await nativeExportWebSessionFetch.text(),
        info: nativeExportWebSessionInfo,
        drop: nativeExportWebSessionDrop,
      };
    } catch (error) {
      nativeExportWebSessionResult = {
        ok: false,
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    }
    const nativeExportGreeterTarget = {
      async hello(params) {
        return {
          message: `native export greeter hello ${params.name}`,
        };
      },
      async makeGreeter(params) {
        if (params.prefix === "native export pipelined greeter") {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const greeter = new NativeGreeter.Server({
          async hello(helloParams) {
            return {
              message: `${params.prefix} ${helloParams.name}`,
            };
          },
        }).client();
        return {
          greeter,
        };
      },
      async greetWith(params) {
        const hello = await params.greeter.hello({
          name: `${params.name} from native export self-test`,
        });
        return {
          message: `native export greeter called ${hello.message}`,
        };
      },
    };
    let nativeExportGreeterResult;
    try {
      const nativeExportGreeter = await exportNativeCapnp(
        apiHelper,
        NativeGreeter,
        nativeExportGreeterTarget,
        { interfaceName: "NativeGreeter" });
      const nativeExportGreeterClient = connectNativeCapnp(
        apiHelper,
        nativeExportGreeter,
        NativeGreeter,
        { connectionId: `native-capnp-export-greeter-${nativeExportGreeter.id}` });
      const nativeExportGreeterDirect = new NativeGreeter.Server(
        nativeExportGreeterTarget).client();
      const nativeExportGreeterDirectConformance = await runNativeGreeterConformance(
        nativeExportGreeterDirect, {
          helloName: "direct schema",
          childPrefix: "native export direct greeter",
          pipelinedName: "before direct makeGreeter resolves",
          resolvedName: "after direct makeGreeter resolves",
          greetName: "direct client",
        });
      const nativeExportGreeterBridgeConformance = await runNativeGreeterConformance(
        nativeExportGreeterClient, {
          helloName: "isolate schema",
          childPrefix: "native export pipelined greeter",
          pipelinedName: "before makeGreeter resolves",
          resolvedName: "after makeGreeter resolves",
          greetName: "bridge client",
        });
      const nativeExportGreeterHello = {
        message: nativeExportGreeterBridgeConformance.hello.message,
      };
      const nativeExportGreeterPipelinedHello = {
        message: nativeExportGreeterBridgeConformance.pipelined.message,
      };
      const nativeExportGreeterInfo = await nativeExportGreeter.info();
      const nativeExportGreeterDrop = await nativeExportGreeter.drop();
      nativeExportGreeterResult = {
        ok: true,
        message: nativeExportGreeterHello.message,
        pipelinedMessage: nativeExportGreeterPipelinedHello.message,
        resolvedGreeter: nativeExportGreeterBridgeConformance.resolved.hasClient,
        argumentMessage: nativeExportGreeterBridgeConformance.argument.message,
        conformance: {
          direct: nativeExportGreeterDirectConformance,
          bridge: nativeExportGreeterBridgeConformance,
        },
        info: nativeExportGreeterInfo,
        drop: nativeExportGreeterDrop,
      };
    } catch (error) {
      nativeExportGreeterResult = {
        ok: false,
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    }
    const nativeExportUnknownRouteResponse = await serveSystemRoutes(new Request(
      "http://sandstorm/__sandstorm/native-capnp/export-sessions/missing-export", {
        method: "POST",
        body: new Uint8Array(0),
      }), env);
    const nativeExportUnknownRoute = {
      status: nativeExportUnknownRouteResponse.status,
      body: await nativeExportUnknownRouteResponse.json(),
    };
    const nativeCapnpTarget = await apiHelper.webSession({
      pathPrefix: "/native-capnp-bridge-target",
    });
    const nativeCapnpPayload = makeNativeCapnpPayload(new CapnpEsMessage(), [
      {
        id: "argument-capability",
        interfaceId: "0xb66316217ceedb1b",
        interfaceName: "NativeGreeter",
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
    class NativeCapnpBridgeFixtureClient {
      constructor(client) {
        this.client = client;
      }
    }
    const nativeCapnpConnectedClient = connectNativeCapnp(
      apiHelper,
      nativeCapnpTarget,
      { Client: NativeCapnpBridgeFixtureClient },
      { connectionId: `native-capnp-fixture-connect-${nativeCapnpTarget.id}` });
    const nativeCapnpGeneratedWebSession = connectNativeCapnp(
      apiHelper,
      nativeCapnpTarget,
      WebSession,
      { connectionId: `native-capnp-fixture-generated-${nativeCapnpTarget.id}` });
    let nativeCapnpGeneratedClientResult = null;
    let nativeCapnpGeneratedClientError = "";
    let nativeCapnpGeneratedStreamResult = null;
    let nativeCapnpGeneratedStreamError = "";
    let nativeCapnpGeneratedDropResult = null;
    let nativeCapnpGeneratedDropError = "";
    try {
      const generatedResponse = await nativeCapnpGeneratedWebSession.get({
        path: "/generated-client",
        context: {},
        ignoreBody: false,
      });
      const content = generatedResponse.content;
      const body = content.body;
      const bodyBytes = typeof body.bytes.toUint8Array === "function" ?
          body.bytes.toUint8Array() : body.bytes;
      nativeCapnpGeneratedClientResult = {
        responseWhich: generatedResponse.which(),
        content: generatedResponse._isContent,
        statusCode: content.statusCode,
        mimeType: content.mimeType,
        bodyWhich: body.which(),
        bodyBytes: bodyBytes.byteLength,
        bodyText: new TextDecoder().decode(bodyBytes),
      };
    } catch (error) {
      nativeCapnpGeneratedClientError = `${error.name}: ${error.message}`;
    }

    try {
      const generatedStreamResponse = await nativeCapnpGeneratedWebSession.get({
        path: "/generated-client-stream",
        context: {},
        ignoreBody: false,
      });
      const streamBody = generatedStreamResponse.content.body;
      const streamHandle = streamBody.stream;
      await streamHandle.ping();
      nativeCapnpGeneratedStreamResult = {
        responseWhich: generatedStreamResponse.which(),
        content: generatedStreamResponse._isContent,
        statusCode: generatedStreamResponse.content.statusCode,
        mimeType: generatedStreamResponse.content.mimeType,
        bodyWhich: streamBody.which(),
        handleClient: typeof streamHandle.ping === "function",
        pinged: true,
      };
    } catch (error) {
      nativeCapnpGeneratedStreamError = `${error.name}: ${error.message}`;
    }

    try {
      const nativeCapnpDropTarget = await apiHelper.webSession({
        pathPrefix: "/native-capnp-bridge-target",
      });
      const nativeCapnpDropWebSession = connectNativeCapnp(
        apiHelper,
        nativeCapnpDropTarget,
        WebSession,
        { connectionId: `native-capnp-fixture-drop-${nativeCapnpDropTarget.id}` });
      await nativeCapnpDropWebSession.get({
        path: "/generated-client",
        context: {},
        ignoreBody: false,
      });
      const dropResult = await nativeCapnpDropWebSession.drop();
      let generatedCallAfterDropError = "";
      try {
        const nativeCapnpDroppedWebSession = connectNativeCapnp(
          apiHelper,
          nativeCapnpDropTarget,
          WebSession,
          { connectionId: `native-capnp-fixture-drop-after-${nativeCapnpDropTarget.id}` });
        await Promise.race([
          nativeCapnpDroppedWebSession.get({
            path: "/generated-client",
            context: {},
            ignoreBody: false,
          }),
          new Promise((resolve, reject) => setTimeout(
            () => reject(new Error("generated call after drop timed out")),
            2000)),
        ]);
      } catch (error) {
        generatedCallAfterDropError = `${error.name}: ${error.message}`;
      }
      nativeCapnpGeneratedDropResult = {
        targetId: nativeCapnpDropTarget.id,
        connectionId: nativeCapnpDropWebSession.transport.connectionId,
        dropResult: dropResult ?? null,
        generatedCallAfterDropError,
      };
    } catch (error) {
      nativeCapnpGeneratedDropError = `${error.name}: ${error.message}`;
    }
    let nativeCapnpLifecycleBinary = null;
    if (url.searchParams.has("nativeLifecycle")) {
      const nativeCapnpLifecycleTarget = await apiHelper.webSession({
        pathPrefix: "/native-capnp-bridge-lifecycle-target",
      });
      const nativeCapnpLifecycleTargetSlot = {
        id: nativeCapnpLifecycleTarget.id,
        interfaceId: "0xa8e9655582dcde6f",
        interfaceName: "sandstorm.WebSession",
        kind: "receiverHosted",
      };
      const nativeCapnpLifecycleHelperSavedToken =
          await saveNativeCapnp(apiHelper, nativeCapnpLifecycleTargetSlot);
      const nativeCapnpLifecycleRestoredClient = await restoreNativeCapnp(
        apiHelper,
        nativeCapnpLifecycleHelperSavedToken,
        { Client: NativeCapnpBridgeFixtureClient },
        {
          interfaceId: "0xa8e9655582dcde6f",
          interfaceName: "sandstorm.WebSession",
          connectionId: `native-capnp-fixture-restore-${nativeCapnpLifecycleTarget.id}`,
        });
      const nativeCapnpLifecycleRestoredMessage =
          await nativeCapnpLifecycleRestoredClient.transport.recvMessage();
      const nativeCapnpLifecycleRestoredSavedToken =
          await nativeCapnpLifecycleRestoredClient.save();
      const nativeCapnpLifecycleRestoredDropResult =
          await nativeCapnpLifecycleRestoredClient.drop();
      const nativeCapnpLifecycleSave =
          await apiHelper.nativeCapnpBridgeCallBytes(makeNativeCapnpBridgeSaveRequest({
            target: nativeCapnpLifecycleTargetSlot,
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
          helperToken: nativeCapnpLifecycleHelperSavedToken,
        },
        restoredClient: {
          isFixtureClient: nativeCapnpLifecycleRestoredClient instanceof
              NativeCapnpBridgeFixtureClient,
          hasBootstrapClient: !!nativeCapnpLifecycleRestoredClient.client,
          targetId: nativeCapnpLifecycleRestoredClient.capability.id,
          connectionId: nativeCapnpLifecycleRestoredClient.transport.connectionId,
          bootstrap: {
            which: nativeCapnpLifecycleRestoredMessage.which(),
            answerId: nativeCapnpLifecycleRestoredMessage.return.answerId,
          },
          savedToken: nativeCapnpLifecycleRestoredSavedToken,
          dropResult: nativeCapnpLifecycleRestoredDropResult ?? null,
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
        capnp: SANDSTORM_CAPNP_VERSION,
        capnpNativeBridge: SANDSTORM_CAPNP_NATIVE_BRIDGE_PROTOCOL_VERSION,
        aggregate: SANDSTORM_HELPER_VERSIONS,
      },
      sandstormApi: {
        status: apiStatus,
        capabilities: apiCapabilities,
        runtime: apiRuntime,
        modules: apiModules,
        bindings: apiBindings,
        capnpBridgeInfo: apiCapnpBridgeInfo,
        helperCapnpBridgeInfo,
        capnpBridgeNegotiation,
        capnpBridgeRpcNegotiation,
        nativeCapnpExport: {
          stream: {
            serverBootstrap: nativeExportServerMessage.which() === CapnpRpcMessage.BOOTSTRAP,
            serverQuestionId: nativeExportServerMessage.bootstrap.questionId,
            echoBootstrap: nativeExportEchoMessage.which() === CapnpRpcMessage.BOOTSTRAP,
            echoQuestionId: nativeExportEchoMessage.bootstrap.questionId,
          },
          capability: {
            ok: nativeExportCapability.ok,
            idType: typeof nativeExportCapability.id,
            info: nativeExportCapabilityInfo,
            drop: nativeExportCapabilityDrop,
          },
          webSession: nativeExportWebSessionResult,
          greeter: nativeExportGreeterResult,
          unknownRoute: nativeExportUnknownRoute,
        },
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
          binaryRoute: {
            ok: nativeCapnpBridgeBinaryCall.ok,
            status: nativeCapnpBridgeBinaryCall.status,
            contentType: nativeCapnpBridgeBinaryCall.contentType,
            bytes: nativeCapnpBridgeBinaryCall.body.byteLength,
            which: decodedNativeCapnpBridgeBinaryCall.which,
            exception: decodedNativeCapnpBridgeBinaryCall.exception,
          },
          connectedClient: {
            isFixtureClient: nativeCapnpConnectedClient instanceof NativeCapnpBridgeFixtureClient,
            hasBootstrapClient: Boolean(nativeCapnpConnectedClient.client),
            targetId: nativeCapnpConnectedClient.capability.id,
            connectionId: nativeCapnpConnectedClient.transport.connectionId,
            hasDrop: typeof nativeCapnpConnectedClient.drop === "function",
            hasSave: typeof nativeCapnpConnectedClient.save === "function",
          },
          generatedClient: {
            ok: nativeCapnpGeneratedClientError === "",
            error: nativeCapnpGeneratedClientError,
            streamOk: nativeCapnpGeneratedStreamError === "",
            streamError: nativeCapnpGeneratedStreamError,
            dropOk: nativeCapnpGeneratedDropError === "",
            dropError: nativeCapnpGeneratedDropError,
            targetId: nativeCapnpGeneratedWebSession.capability.id,
            connectionId: nativeCapnpGeneratedWebSession.transport.connectionId,
            response: nativeCapnpGeneratedClientResult,
            stream: nativeCapnpGeneratedStreamResult,
            drop: nativeCapnpGeneratedDropResult,
          },
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
