import message from "message.txt";
import metadata from "metadata.json";
import {
  Message as CapnpEsMessage,
  utils as CapnpEsUtils,
} from "capnp-es/index.mjs";
import {
  NativeGreeter,
  NativeGreeterObjectId,
} from "capnp:./native-greeter.capnp";
import { Message as CapnpRpcMessage } from "capnp-es/capnp/rpc.mjs";
import { ByteStream } from "capnp:/sandstorm/util.capnp";
import { WebSession } from "capnp:/sandstorm/web-session.capnp";
import {
  Capability,
  SANDSTORM_API_VERSION,
  SANDSTORM_HELPER_VERSIONS,
  byteStreamFromWritable,
  capnpClient,
  createCapnpStruct,
  exportCapnp,
  pipeReadableToByteStream,
  powerbox as sandstormPowerbox,
  readCapnpStruct,
  sandstorm,
  serveSystemRoutes,
  writableFromByteStream,
} from "sandstorm:api";
import {
  CAPNP_CLIENT_SYMBOL,
  SANDSTORM_CAPNP_NATIVE_BRIDGE_PROTOCOL_VERSION,
  SANDSTORM_CAPNP_VERSION,
  NativeCapnpStreamTransport,
  makeNativeCapnpPayload,
  negotiateNativeCapnpBridge,
  nativeCapnpSavedTokenText,
  connectIsolateBridge,
} from "sandstorm-internal:capnp-runtime";

const MAX_TEST_DOWNLOAD_BYTES = 70 * 1024 * 1024;
const TEST_PROVIDER_DESCRIPTOR = "EAlQAQEAABEBF1EEAQH_y9-dR8kYld8AUAEBAXsRASIHZm9v";
let browserNativeLocalExportGreeter = null;

function fixtureExportInfo(InterfaceClass, id = undefined) {
  return {
    ok: true,
    type: "nativeCapnpCapability",
    kind: "localExport",
    ...(id === undefined ? {} : { id }),
    interfaceId: `0x${InterfaceClass._capnp.typeIdHex}`,
    interfaceName: InterfaceClass._capnp.displayName,
  };
}

async function exportFixtureCapnp(api, InterfaceClass, target) {
  const exported = await exportCapnp(api, InterfaceClass, target);
  const id = `fixture-export-${crypto.randomUUID()}`;
  const capability = Object.freeze({
    id,
    kind: "localExport",
    interfaceId: InterfaceClass._capnp.typeId,
    interfaceName: InterfaceClass._capnp.displayName,
    [CAPNP_CLIENT_SYMBOL]: exported[CAPNP_CLIENT_SYMBOL],
    save: exported.save.bind(exported),
    drop: async () => undefined,
    toJSON: () => fixtureExportInfo(InterfaceClass, id),
  });
  return new Proxy(exported.client, {
    get(client, property) {
      if (property === CAPNP_CLIENT_SYMBOL) return exported[property];
      if (property === "capability") return capability;
      if (property === "connection" || property === "transport") return null;
      if (property === "browserHandoff") {
        return (options) => exported.browserHandoff(options?.request ?? options);
      }
      if (property === "drop" || property === "save") return exported[property].bind(exported);
      if (property === "info") return async () => fixtureExportInfo(InterfaceClass, id);
      if (property === "toJSON") return () => fixtureExportInfo(InterfaceClass, id);
      return Reflect.get(client, property, client);
    },
  });
}

function viewFixtureCapability(_api, capability, InterfaceClass) {
  const client = InterfaceClass?._capnp
    ? capnpClient(InterfaceClass, capability)
    : new InterfaceClass.Client(capability[CAPNP_CLIENT_SYMBOL]());
  const metadata = InterfaceClass?._capnp
    ? Object.freeze({
        id: capability.id,
        kind: capability.kind ?? "rpcImport",
        interfaceId: InterfaceClass._capnp.typeId,
        interfaceName: InterfaceClass._capnp.displayName,
      })
    : capability;
  return new Proxy(client, {
    get(target, property) {
      if (property === "capability") return metadata;
      if (property === "connection" || property === "transport") return null;
      if (property === "drop" || property === "save") {
        return capability[property]?.bind(capability);
      }
      return Reflect.get(target, property, target);
    },
  });
}

async function restoreFixtureCapability(api, token, InterfaceClass) {
  return viewFixtureCapability(api, await api.restore(token), InterfaceClass);
}

async function fixturePowerboxDescriptorInfo(env, InterfaceClass) {
  const params = new URLSearchParams({
    interfaceId: `0x${InterfaceClass._capnp.typeIdHex}`,
    interfaceName: InterfaceClass._capnp.displayName,
  });
  const response = await env.SANDSTORM_API.fetch(
    `http://sandstorm/powerbox/app-interface-descriptor?${params}`);
  return response.json();
}

async function fixturePowerboxDescriptor(env, InterfaceClass) {
  return (await fixturePowerboxDescriptorInfo(env, InterfaceClass)).descriptor;
}

function makeNativeGreeterObjectId(id) {
  return createCapnpStruct(NativeGreeterObjectId, { id });
}

function readNativeGreeterObjectId(objectId) {
  return readCapnpStruct(NativeGreeterObjectId, objectId).id;
}

function interfaceIdHex(interfaceId) {
  if (typeof interfaceId === "bigint") {
    return `0x${interfaceId.toString(16)}`;
  } else if (typeof interfaceId === "number") {
    return `0x${interfaceId.toString(16)}`;
  } else if (typeof interfaceId === "string" && interfaceId.length > 0) {
    return interfaceId.startsWith("0x") ? interfaceId : `0x${interfaceId}`;
  } else {
    return "0x0";
  }
}

function makePersistentNativeGreeterTarget(id) {
  return {
    async save() {
      return {
        objectId: makeNativeGreeterObjectId(id),
        label: { defaultText: `native greeter ${id}` },
      };
    },

    async hello(params) {
      return {
        message: `classic native greeter ${id} hello ${params.name}`,
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
      return { greeter };
    },

    async greetWith(params) {
      const hello = await params.greeter.hello({
        name: `${params.name} from classic native greeter ${id}`,
      });
      return {
        message: `classic native greeter ${id} called ${hello.message}`,
      };
    },

    async inspectData(params) {
      const bytes = capnpDataBytes(params.content);
      return {
        byteCount: BigInt(bytes.byteLength),
        checksum: checksum(bytes),
        firstEightHex: firstEightHex(bytes),
      };
    },
  };
}

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

function firstEightHex(bytes) {
  return Array.from(bytes.slice(0, 8), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
}

function capnpDataBytes(value) {
  if (!value) return new Uint8Array();
  if (value instanceof Uint8Array) return value;
  if (typeof value.toUint8Array === "function") return value.toUint8Array();
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value);
}

function concatByteChunks(chunks) {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function makeCollectingByteStream() {
  const chunks = [];
  let expectedSize = null;
  let resolveDone;
  let rejectDone;
  let queue = Promise.resolve();
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  function finish() {
    let total = 0;
    for (const chunk of chunks) total += chunk.byteLength;
    if (expectedSize !== null && total !== expectedSize) {
      throw new Error(`ByteStream size mismatch: expected ${expectedSize}, got ${total}`);
    }

    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    resolveDone(body);
  }

  const client = new ByteStream.Server({
    async write(params) {
      const bytes = capnpDataBytes(params.data);
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      queue = queue.then(() => {
        chunks.push(copy);
      });
      await queue;
      return {};
    },

    async done() {
      queue = queue.then(finish, (error) => {
        rejectDone(error);
        throw error;
      });
      await queue;
      return {};
    },

    async expectSize(params) {
      expectedSize = Number(params.size);
      return {};
    },
  }).client();

  return { client, done };
}

async function runByteStreamAdapterSelfTest() {
  const pipeSink = makeCollectingByteStream();
  await pipeReadableToByteStream(new ReadableStream({
    start(controller) {
      controller.enqueue(makeBytes(7));
      controller.enqueue(makeBytes(5));
      controller.close();
    },
  }), pipeSink.client, { size: 12n, chunkSize: 5 });
  const pipedBytes = await pipeSink.done;

  const writableSink = makeCollectingByteStream();
  const writer = writableFromByteStream(writableSink.client, {
    size: 6n,
    chunkSize: 4,
  }).getWriter();
  await writer.write(makeBytes(6));
  await writer.close();
  const writableBytes = await writableSink.done;

  const writableChunks = [];
  let expectedRemaining = null;
  let closed = false;
  const byteStream = byteStreamFromWritable(new WritableStream({
    write(chunk) {
      const copy = new Uint8Array(chunk.byteLength);
      copy.set(chunk);
      writableChunks.push(copy);
    },

    close() {
      closed = true;
    },
  }), {
    chunkSize: 4,
    onExpectSize(remaining) {
      expectedRemaining = remaining;
    },
  });
  await byteStream.expectSize({ size: 9n });
  await byteStream.write({ data: makeBytes(9) });
  await byteStream.done();
  const byteStreamBytes = concatByteChunks(writableChunks);

  return {
    pipeReadableToByteStream: {
      bytes: pipedBytes.byteLength,
      checksum: checksum(pipedBytes),
    },
    writableFromByteStream: {
      bytes: writableBytes.byteLength,
      checksum: checksum(writableBytes),
    },
    byteStreamFromWritable: {
      expectedRemaining: expectedRemaining?.toString() ?? null,
      closed,
      chunks: writableChunks.length,
      bytes: byteStreamBytes.byteLength,
      checksum: checksum(byteStreamBytes),
    },
  };
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
  const dataBytes = new Uint8Array([
    0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
  ]);
  const data = await client.inspectData({
    content: dataBytes,
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
    data: {
      byteCount: Number(data.byteCount),
      checksum: data.checksum,
      firstEightHex: data.firstEightHex,
    },
  };
}

function nativeConnectedClientInfo(client) {
  const capability = client.capability || {};
  const info = {
    kind: capability.kind,
    interfaceId: capability.interfaceId?.toString(16),
    interfaceName: capability.interfaceName,
    connectionId: client.transport?.connectionId,
    transportKind: client.transport?.kind,
    connectionIsNull: client.connection === null,
  };
  if (capability.id !== undefined) {
    info.id = capability.id;
  }
  return info;
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
    const systemResponse = await api.serveSystemRoutes({
      mainView: {
        async restore(objectId) {
          return new NativeGreeter.Server(
            makePersistentNativeGreeterTarget(readNativeGreeterObjectId(objectId))).client();
        },
        async drop(objectId) {
          readNativeGreeterObjectId(objectId);
        },
      },
    });
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

    if (url.pathname === "/browser-native-web-session-capability") {
      const capability = await api.webSession({
        pathPrefix: "/native-capnp-bridge-target",
      });
      const browserHandoff = await capability.browserHandoff({
        nativeInterface: "webSession",
      });
      return Response.json({
        ok: true,
        capabilityClass: capability instanceof Capability,
        capability: browserHandoff,
        info: await capability.info(),
      });
    }

    if (url.pathname === "/browser-native-local-export-capability") {
      if (!browserNativeLocalExportGreeter) {
        browserNativeLocalExportGreeter = await exportFixtureCapnp(api, NativeGreeter, {
          async save() {
            return {
              objectId: makeNativeGreeterObjectId("browser-native-local-export-greeter"),
              label: { defaultText: "browser native local export greeter" },
            };
          },
          async hello(params) {
            return {
              message: `browser native local export hello ${params.name}`,
            };
          },
        }, {
          interfaceName: "NativeGreeter",
        });
      }
      const greeter = browserNativeLocalExportGreeter;
      const browserHandoff = await greeter.browserHandoff({ request });
      const info = await greeter.info();
      return Response.json({
        ok: true,
        hasBrowserHandoff: typeof greeter.browserHandoff === "function",
        capability: browserHandoff,
        info,
        drop: null,
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
      const dropOriginal = (await capability.drop()) ?? null;
      const restored = await api.restore(saved);
      const restoredResponse = await restored.fetch("/value?source=browser-powerbox");
      const restoredBody = await restoredResponse.json();
      const dropRestored = (await restored.drop()) ?? null;
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
      const offered = await powerbox.offered();
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
        drop = (await capability.drop()) ?? null;
      }
      return Response.json({
        ok: Boolean(capability),
        sessionType: request.headers.get("x-sandstorm-session-type"),
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
        info: await capability.info(),
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
          persistent: "yes",
        });
        results.invalidPersistent = { ok: true };
      } catch (error) {
        results.invalidPersistent = {
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
        info: await capability.info(),
      });
    }

    if (url.pathname === "/export-native-greeter-capability") {
      const api = sandstorm(request, env);
      const id = url.searchParams.get("id") || undefined;
      const target = {
        async save() {
          return {
            objectId: makeNativeGreeterObjectId(id || "cross-supervisor-native-greeter"),
            label: { defaultText: "cross supervisor native greeter" },
          };
        },
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
        async inspectData(params) {
          const bytes = capnpDataBytes(params.content);
          return {
            byteCount: BigInt(bytes.byteLength),
            checksum: checksum(bytes),
            firstEightHex: firstEightHex(bytes),
          };
        },
      };
      const capability = await exportFixtureCapnp(api, NativeGreeter, target, {
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
          const unexpectedClient = await restoreFixtureCapability(api, token, NativeGreeter, {
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

      const client = await restoreFixtureCapability(api, token, NativeGreeter, {
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
      const dataBytes = new Uint8Array([
        0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70,
        0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
      ]);
      const data = await client.inspectData({
        content: dataBytes,
      });
      const drop = await client.drop();
      return Response.json({
        ok: true,
        capability: nativeConnectedClientInfo(client),
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
        data: {
          byteCount: Number(data.byteCount),
          checksum: data.checksum,
          firstEightHex: data.firstEightHex,
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
      const client = await restoreFixtureCapability(api, token, NativeGreeter, {
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
      return Response.json({
        ok: true,
        capability: nativeConnectedClientInfo(client),
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
      const dropOriginal = (await capability.drop()) ?? null;
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
      const streamedResponse = await restored.fetch("/download?bytes=131072");
      const streamedBytes = new Uint8Array(await streamedResponse.arrayBuffer());
      const dropRestored = (await restored.drop()) ?? null;
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
        streamed: {
          status: streamedResponse.status,
          contentType: streamedResponse.headers.get("content-type"),
          bytes: streamedBytes.byteLength,
          downloadBytes: streamedResponse.headers.get("x-sandstorm-app-download-bytes"),
          checksum: checksum(streamedBytes),
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
      const dropOriginal = (await capability.drop()) ?? null;
      const restored = await sandstorm(request, env).restore(saved);
      const fetchedResponse = await restored.fetch("/capability-echo?source=api-js-restore");
      const fetched = {
        status: fetchedResponse.status,
        body: await fetchedResponse.json(),
      };
      const dropRestored = (await restored.drop()) ?? null;
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
      const dropRestored = (await restored.drop()) ?? null;
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
        drop: (await capability.drop()) ?? null,
      });
    }

    if (url.pathname === "/outbound-http-restore-self-test") {
      const api = sandstorm(request, env);
      // isolate-saved-capability-v1 envelope for the fake core token "outbound-http-saved-token".
      const saved = "aXNvbGF0ZS1zYXZlZC1jYXBhYmlsaXR5LXYxCm91dGJvdW5kSHR0cAoKYjNWMF" +
        "ltOTFibVF0YUhSMGNDMXpZWFpsWkMxMGIydGxiZw";
      const restored = await api.restore(saved);
      const restoredInfo = await restored.info();
      let fetchError = null;
      try {
        await restored.fetch("https://api.example.test/v1/should-not-fetch");
      } catch (error) {
        fetchError = {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
        };
      }
      const response = await restored.fetch("v1/chat/completions?model=test", {
        method: "POST",
        headers: {
          authorization: "Bearer isolate-test",
          "content-type": "text/plain; charset=utf-8",
        },
        body: "hello",
      });
      const body = await response.json();
      const dropRestored = (await restored.drop()) ?? null;
      const dropSaved = await api.revoke(saved);

      return Response.json({
        ok: true,
        restoredClass: restored instanceof Capability,
        restored: JSON.parse(JSON.stringify(restored)),
        restoredInfo,
        fetchError,
        unifiedFetch: true,
        status: response.status,
        statusText: response.statusText,
        contentType: response.headers.get("content-type"),
        outboundHeader: response.headers.get("x-outbound-test"),
        body,
        dropRestored,
        dropSaved,
      });
    }

    if (url.pathname === "/native-interface-validation-self-test") {
      const calls = [];
      const mockEnv = {
        SANDSTORM_API: {
          async fetch(input, init) {
            calls.push(String(input));
            return Response.json({ ok: false, error: "unexpected mock fetch" }, { status: 500 });
          },
        },
      };
      const capability = new Capability(mockEnv, "mock-outbound", {
        kind: "powerboxClaim",
        residence: "imported",
        nativeInterface: "outboundHttpSession",
        pathPrefix: "",
      });
      let fetchError = null;
      try {
        await capability.fetch("https://api.example.test/v1/should-not-fetch");
      } catch (error) {
        fetchError = {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
        };
      }

      return Response.json({
        ok: true,
        calls,
        fetchError,
      });
    }

    if (url.pathname === "/powerbox-binding-probe") {
      const statusResponse = await env.POWERBOX.fetch("http://sandstorm/status");
      const descriptorResponse = await env.POWERBOX.fetch(
        "http://sandstorm/powerbox/api-session-descriptor" +
        "?apiCanonicalUrl=https%3A%2F%2Fapi.example.test");
      return Response.json({
        ok: true,
        statusEndpoint: {
          status: statusResponse.status,
          body: await statusResponse.json(),
        },
        powerboxEndpoint: {
          status: descriptorResponse.status,
          body: await descriptorResponse.json(),
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
      let invalidKeyError = "";
      try {
        await store.get("helper:invalid");
      } catch (error) {
        invalidKeyError = error.message || String(error);
      }
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
        invalidKeyError,
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
      const claim = await grants.claim("shared", { capability });

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
      const nativeDescriptor = await fixturePowerboxDescriptor(
        env, NativeGreeter, { interfaceName: "NativeGreeter" });
      const native = fulfillmentApi.powerboxFulfillment({
        routePrefix: "/native-fulfillment-test",
        title: "Powerbox fulfillment NativeGreeter",
        buttonLabel: "Use native greeter",
        capability: () => exportFixtureCapnp(
          fulfillmentApi,
          NativeGreeter,
          makePersistentNativeGreeterTarget("native-powerbox-helper-greeter"),
          { interfaceName: "NativeGreeter" }),
        fulfill: {
          title: "NativeGreeter fulfilled capability",
          verbPhrase: "can use native fulfilled capability",
          description: "Native fulfilled capability description",
          requiredPermissions: ["view"],
          descriptor: nativeDescriptor,
        },
      });

      const page = await web.serve(helperRequest("/__sandstorm/powerbox-fulfillment"));
      const client = await web.serve(helperRequest("/__sandstorm/powerbox-fulfillment/client.js"));
      const unknown = await web.serve(helperRequest("/__sandstorm/powerbox-fulfillment/unknown"));
      const outside = await web.serve(helperRequest("/outside-fulfillment-helper"));
      const webFulfill = runFulfill
        ? await web.serve(helperRequest(
          "/__sandstorm/powerbox-fulfillment/fulfill", { method: "POST" }))
        : null;
      const nativeFulfill = runFulfill
        ? await native.serve(helperRequest(
          "/native-fulfillment-test/fulfill", { method: "POST" }))
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
        nativeFulfill: nativeFulfill && {
          status: nativeFulfill.status,
          body: await nativeFulfill.json(),
        },
        objectFulfill: null,
        durableFulfill: null,
        errorFulfill: {
          status: errorFulfill.status,
          body: await errorFulfill.json(),
        },
      });
    }

    if (url.pathname === "/native-powerbox-session-action-self-test") {
      const api = sandstorm(request, env);
      try {
        const descriptor = await fixturePowerboxDescriptor(
          env, NativeGreeter, { interfaceName: "NativeGreeter" });
        const greeter = await exportFixtureCapnp(
          api,
          NativeGreeter,
          makePersistentNativeGreeterTarget("native-powerbox-session-action-greeter"),
          { interfaceName: "NativeGreeter" });

        const hello = await greeter.hello({ name: "session-action" });
        try {
          const fulfill = await api.powerbox().fulfillRequest(greeter, {
            title: "NativeGreeter fulfilled capability",
            verbPhrase: "can use native fulfilled capability",
            description: "Native fulfilled capability description",
            requiredPermissions: ["view"],
            descriptor,
          });
          const offer = await api.powerbox().offer(greeter, {
            title: "NativeGreeter offered capability",
            verbPhrase: "can use native offered capability",
            description: "Native offered capability description",
            requiredPermissions: ["view"],
            descriptor,
          });

          return Response.json({
            ok: true,
            hello: { message: hello.message },
            fulfill,
            offer,
            info: await greeter.info(),
          });
        } finally {
          await greeter.drop();
        }
      } catch (error) {
        return Response.json({
          ok: false,
          error: error?.message || String(error),
          stack: error?.stack || "",
        }, { status: 500 });
      }
    }

    if (url.pathname === "/native-capnp-descriptor-self-test") {
      const powerboxDescriptorInfo = await fixturePowerboxDescriptorInfo(
        env, NativeGreeter, { interfaceName: "NativeGreeter" });
      const powerboxDescriptor = await fixturePowerboxDescriptor(
        env, NativeGreeter, { interfaceName: "NativeGreeter" });
      const cachedPowerboxDescriptorInfo = await fixturePowerboxDescriptorInfo(
        env, NativeGreeter, { interfaceName: "NativeGreeter" });
      cachedPowerboxDescriptorInfo.decoded.interfaceName = "mutated cached descriptor";
      const cachedPowerboxDescriptorInfoAfterMutation =
        await fixturePowerboxDescriptorInfo(
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
      const nativeInterface = url.searchParams.get("nativeInterface");
      const claimOptions = {
        requiredPermissions,
      };
      if (nativeInterface !== null) {
        claimOptions.nativeInterface = nativeInterface;
      }
      let claim;
      try {
        claim = await sandstormPowerbox(request, env).claim(token, claimOptions);
      } catch (error) {
        return Response.json({
          ok: false,
          status: 400,
          sessionId,
          error: String(error?.message || error),
        }, { status: 400 });
      }
      const claimResponseOk = true;
      const claimResponseStatus = 200;
      const claimType = {
        capabilityClass: claim instanceof Capability,
        json: JSON.parse(JSON.stringify(claim)),
      };
      const actionCapability = claim instanceof Capability ? claim :
        (claim?.ok && claim?.id ? new Capability(env, claim.id) : null);
      async function claimedInfo(capability) {
        if (!(capability instanceof Capability)) return null;
        return {
          status: 200,
          body: await capability.info(),
        };
      }
      const claimInfo = await claimedInfo(claim);
      let save = null;
      let savedToken = null;
      if (actionCapability && url.searchParams.get("save") === "true") {
        const label = url.searchParams.get("label") || "Isolate test saved capability";
        savedToken = await actionCapability.save({ label });
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
        restoredCapability = await sandstorm(request, env).restore(restoreToken);
        restore = {
          status: 200,
          body: restoredCapability,
          typed: {
            restoredClass: restoredCapability instanceof Capability,
            json: JSON.parse(JSON.stringify(restoredCapability)),
          },
        };
        if (restore.body.ok && restore.body.id) {
          restore.info = await claimedInfo(restore.body);
          dropRestored = {
            status: 200,
            body: (await restoredCapability.drop()) ?? null,
          };
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
        dropTied = (await tiedCapability.drop()) ?? null;
      }
      let drop = null;
      if (claim.ok && claim.id) {
        drop = {
          status: 200,
          body: (await claim.drop()) ?? null,
        };
      }
      let dropSaved = null;
      if (restoreToken && url.searchParams.get("dropSaved") === "true") {
        dropSaved = {
          status: 200,
          body: await sandstorm(request, env).revoke(restoreToken),
        };
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
      const dropOriginal = (await claimed.capability.drop()) ?? null;
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
        dropRestored = (await restored.capability.drop()) ?? null;
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
      const dropHandleClaimed = (await handleClaimed.capability.drop()) ?? null;
      const dropClaimAlias = (await claimAlias.drop()) ?? null;
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
      requiredFeatures: ["nativeRpc", "nativeRpcWebSocket"],
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
      const nativeExportWebSession = await exportFixtureCapnp(
        apiHelper,
        WebSession,
        nativeExportWebSessionTarget,
        {
          interfaceId: WebSession.interfaceId ?? WebSession.Client?.interfaceId,
          interfaceName: "sandstorm.WebSession",
        });
      const nativeExportWebSessionGet =
          await nativeExportWebSession.get({ path: "native-export-websession?from=rpc" });
      const nativeExportWebSessionBody = nativeExportWebSessionGet.content.body.bytes;
      const nativeExportWebSessionBytes =
          typeof nativeExportWebSessionBody.toUint8Array === "function" ?
            nativeExportWebSessionBody.toUint8Array() : nativeExportWebSessionBody;
      const nativeExportWebSessionInfo = await nativeExportWebSession.info();
      const nativeExportWebSessionDrop = await nativeExportWebSession.drop();
      nativeExportWebSessionResult = {
        ok: true,
        status: nativeExportWebSessionGet.content.statusCode === WebSession.Response.SuccessCode.OK
          ? 200
          : String(nativeExportWebSessionGet.content.statusCode),
        contentType: nativeExportWebSessionGet.content.mimeType,
        text: new TextDecoder().decode(nativeExportWebSessionBytes),
        capability: nativeExportWebSession.capability,
        info: nativeExportWebSessionInfo,
        drop: nativeExportWebSessionDrop ?? null,
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
      async save() {
        return {
          objectId: makeNativeGreeterObjectId("native-export-greeter"),
          label: { defaultText: "native export greeter" },
        };
      },
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
      async inspectData(params) {
        const bytes = capnpDataBytes(params.content);
        return {
          byteCount: BigInt(bytes.byteLength),
          checksum: checksum(bytes),
          firstEightHex: firstEightHex(bytes),
        };
      },
    };
    let nativeExportGreeterResult;
    try {
      const nativeExportGreeter = await exportFixtureCapnp(
        apiHelper,
        NativeGreeter,
        nativeExportGreeterTarget,
        { interfaceName: "NativeGreeter" });
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
        nativeExportGreeter, {
          helloName: "isolate schema",
          childPrefix: "native export pipelined greeter",
          pipelinedName: "before makeGreeter resolves",
          resolvedName: "after makeGreeter resolves",
          greetName: "bridge client",
        });
      const nativeExportGreeterHandoff = viewFixtureCapability(
        apiHelper,
        nativeExportGreeter.capability,
        NativeGreeter,
        {
          interfaceName: "NativeGreeter",
          connectionId: "native-capnp-local-export-greeter-handoff",
        });
      const nativeExportGreeterHandoffConformance = await runNativeGreeterConformance(
        nativeExportGreeterHandoff, {
          helloName: "handoff schema",
          childPrefix: "native export handoff greeter",
          pipelinedName: "before handoff makeGreeter resolves",
          resolvedName: "after handoff makeGreeter resolves",
          greetName: "handoff client",
        });
      const nativeExportGreeterHandoffInfo =
          nativeConnectedClientInfo(nativeExportGreeterHandoff);
      const nativeExportGreeterHandoffDrop = await nativeExportGreeterHandoff.drop();
      const nativeExportGreeterSavedToken = await nativeExportGreeter.save({
        label: "native export greeter",
      });
      const nativeExportGreeterRestored = await restoreFixtureCapability(
        apiHelper,
        nativeExportGreeterSavedToken,
        NativeGreeter,
        {
          interfaceName: "NativeGreeter",
          connectionId: "native-capnp-local-export-greeter-restored",
        });
      const nativeExportGreeterRestoredConformance = await runNativeGreeterConformance(
        nativeExportGreeterRestored, {
          helloName: "restored schema",
          childPrefix: "native export restored greeter",
          pipelinedName: "before restored makeGreeter resolves",
          resolvedName: "after restored makeGreeter resolves",
          greetName: "restored client",
        });
      const nativeExportGreeterRestoredInfo =
          nativeConnectedClientInfo(nativeExportGreeterRestored);
      const nativeExportGreeterRestoredDrop = await nativeExportGreeterRestored.drop();
      const nativeExportGreeterBootstrapRestored = await restoreFixtureCapability(
        apiHelper,
        nativeExportGreeterSavedToken,
        NativeGreeter,
        {
          interfaceName: "NativeGreeter",
          connectionId: `native-capnp-local-export-greeter-bootstrap-${crypto.randomUUID()}`,
        });
      const nativeExportGreeterBootstrapRestoredConformance =
          await runNativeGreeterConformance(nativeExportGreeterBootstrapRestored, {
            helloName: "bootstrap restored schema",
            childPrefix: "native export bootstrap restored greeter",
            pipelinedName: "before bootstrap restored makeGreeter resolves",
            resolvedName: "after bootstrap restored makeGreeter resolves",
            greetName: "bootstrap restored client",
          });
      const nativeExportGreeterBootstrapSavedToken =
          await nativeExportGreeterBootstrapRestored.save({
            label: "bootstrap-restored native export greeter",
          });
      const nativeExportGreeterBootstrapDrop =
          await nativeExportGreeterBootstrapRestored.drop();
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
          handoff: nativeExportGreeterHandoffConformance,
          restored: nativeExportGreeterRestoredConformance,
          bootstrapRestored: nativeExportGreeterBootstrapRestoredConformance,
        },
        capability: nativeExportGreeter.capability,
        browserHandoff: {
          hasMethod: typeof nativeExportGreeter.browserHandoff === "function",
        },
        handoff: {
          ...nativeExportGreeterHandoffInfo,
          dropResult: nativeExportGreeterHandoffDrop ?? null,
        },
        restored: {
          savedTokenType: typeof nativeExportGreeterSavedToken,
          ...nativeExportGreeterRestoredInfo,
          dropResult: nativeExportGreeterRestoredDrop ?? null,
        },
        bootstrapRestored: {
          savedTokenType: typeof nativeExportGreeterBootstrapSavedToken,
          savedTokenLength: nativeExportGreeterBootstrapSavedToken.length,
          connectionId: nativeExportGreeterBootstrapRestored.transport?.connectionId ?? null,
          transportKind: nativeExportGreeterBootstrapRestored.transport?.kind ?? null,
          capabilityKind: nativeExportGreeterBootstrapRestored.capability.kind,
          interfaceId:
              nativeExportGreeterBootstrapRestored.capability.interfaceId.toString(16),
          interfaceName: nativeExportGreeterBootstrapRestored.capability.interfaceName,
          connectionIsNull: nativeExportGreeterBootstrapRestored.connection === null,
          dropResult: nativeExportGreeterBootstrapDrop ?? null,
        },
        info: nativeExportGreeterInfo,
        drop: nativeExportGreeterDrop ?? null,
      };
    } catch (error) {
      nativeExportGreeterResult = {
        ok: false,
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    }

    let classicNativeGreeterResult;
    try {
      const classicId = "fixture-classic-native-greeter";
      const classicLocalClient = new NativeGreeter.Server(
        makePersistentNativeGreeterTarget(classicId)).client();
      const classicBridge = connectIsolateBridge(apiHelper, {
        connectionId: "classic-native-greeter-save",
      });
      let classicSavedToken;
      try {
        const sandstormApiResult = await classicBridge.getSandstormApi({});
        const saved = await sandstormApiResult.api.save((params) => {
          CapnpEsUtils.setInterfacePointer(
            params.segment.message.addCap(classicLocalClient.client),
            CapnpEsUtils.getPointer(0, params));
          params._initLabel().defaultText = "classic native greeter";
        });
        classicSavedToken = nativeCapnpSavedTokenText(saved.token);
      } finally {
        classicBridge.close();
      }

      const classicRestored = await restoreFixtureCapability(
        apiHelper,
        classicSavedToken,
        NativeGreeter,
        {
          interfaceName: "NativeGreeter",
          connectionId: "classic-native-greeter-restored",
        });
      const classicConformance = await runNativeGreeterConformance(classicRestored, {
        helloName: "restored schema",
        childPrefix: "classic restored greeter",
        pipelinedName: "before classic restored makeGreeter resolves",
        resolvedName: "after classic restored makeGreeter resolves",
        greetName: "restored client",
      });
      const classicResavedToken = await classicRestored.save({
        label: "resaved classic native greeter",
      });
      const classicDrop = await classicRestored.drop();
      classicNativeGreeterResult = {
        ok: true,
        savedTokenType: typeof classicSavedToken,
        savedTokenLength: classicSavedToken.length,
        resavedTokenType: typeof classicResavedToken,
        resavedTokenLength: classicResavedToken.length,
        conformance: classicConformance,
        restored: nativeConnectedClientInfo(classicRestored),
        drop: classicDrop ?? null,
      };
    } catch (error) {
      classicNativeGreeterResult = {
        ok: false,
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    }

    const nativeCapnpTarget = await apiHelper.webSession({
      pathPrefix: "/native-capnp-bridge-target",
    });
    const nativeCapnpPayload = makeNativeCapnpPayload(new CapnpEsMessage(), [{
      id: nativeCapnpTarget.id,
      interfaceId: interfaceIdHex(WebSession.interfaceId ?? WebSession.Client?.interfaceId),
      interfaceName: "sandstorm.WebSession",
      kind: "receiverHosted",
    }]);
    const isolateBridgeConnectionId = `isolate-bridge-bootstrap-${nativeCapnpTarget.id}`;
    const isolateBridge = connectIsolateBridge(apiHelper, {
      connectionId: isolateBridgeConnectionId,
    });
    let isolateBridgeBootstrap;
    try {
      const sandstormApiResult = await isolateBridge.getSandstormApi({});
      let missingSessionError = "";
      try {
        await isolateBridge.getSessionContext({
          sessionId: "missing-isolate-bridge-session",
        });
      } catch (error) {
        missingSessionError = `${error?.name || ""}: ${error?.message || error}`;
      }

      isolateBridgeBootstrap = {
        transportKind: isolateBridge.transport.kind,
        connectionId: isolateBridge.transport.connectionId,
        sandstormApi: {
          hasSave: typeof sandstormApiResult.api?.save === "function",
          hasRestore: typeof sandstormApiResult.api?.restore === "function",
          hasDrop: typeof sandstormApiResult.api?.drop === "function",
        },
        missingSessionError,
      };
    } finally {
      isolateBridge.close();
    }
    class NativeCapnpBridgeFixtureClient {
      constructor(client) {
        this.client = client;
      }
    }
    const nativeCapnpConnectedClient = viewFixtureCapability(
      apiHelper,
      nativeCapnpTarget,
      { Client: NativeCapnpBridgeFixtureClient },
      { connectionId: `native-capnp-fixture-connect-${nativeCapnpTarget.id}` });
    const nativeCapnpGeneratedWebSession = viewFixtureCapability(
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
      const streamSink = makeCollectingByteStream();
      const generatedStreamResponse = await nativeCapnpGeneratedWebSession.get({
        path: "/generated-client-stream",
        context: {
          responseStream: streamSink.client,
        },
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
      const nativeCapnpDropWebSession = viewFixtureCapability(
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
        const nativeCapnpDroppedWebSession = viewFixtureCapability(
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
        connectionId: nativeCapnpDropWebSession.transport?.connectionId ?? null,
        dropResult: dropResult ?? null,
        generatedCallAfterDropError,
      };
    } catch (error) {
      nativeCapnpGeneratedDropError = `${error.name}: ${error.message}`;
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
    const byteStreamAdapterResult = await runByteStreamAdapterSelfTest();
    const nativeCapnpStructHelperObjectId =
        makeNativeGreeterObjectId("native-capnp-struct-helper");
    const nativeCapnpStructHelperResult = {
      id: readNativeGreeterObjectId(nativeCapnpStructHelperObjectId),
      hasSegment: Boolean(nativeCapnpStructHelperObjectId.segment),
    };

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
        structHelper: nativeCapnpStructHelperResult,
        payload: {
          bytes: nativeCapnpPayload.message.byteLength,
          capabilities: nativeCapnpPayload.capabilities.map((capability) => ({
            id: capability.id,
            interfaceId: capability.interfaceId.toString(16),
            interfaceName: capability.interfaceName,
            kind: capability.kind,
          })),
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
        nativeCapnpLocalExport: {
          stream: {
            serverBootstrap: nativeExportServerMessage.which() === CapnpRpcMessage.BOOTSTRAP,
            serverQuestionId: nativeExportServerMessage.bootstrap.questionId,
            echoBootstrap: nativeExportEchoMessage.which() === CapnpRpcMessage.BOOTSTRAP,
            echoQuestionId: nativeExportEchoMessage.bootstrap.questionId,
            adapters: byteStreamAdapterResult,
          },
          webSession: nativeExportWebSessionResult,
          greeter: nativeExportGreeterResult,
          classicGreeter: classicNativeGreeterResult,
        },
        nativeCapnpBridge: {
          available: capnpBridgeNegotiation.available,
          protocolVersion: capnpBridgeNegotiation.protocolVersion,
          isolateBridgeBootstrap,
          targetId: nativeCapnpTarget.id,
          connectedClient: {
            isFixtureClient: nativeCapnpConnectedClient instanceof NativeCapnpBridgeFixtureClient,
            hasBootstrapClient: Boolean(nativeCapnpConnectedClient.client),
            targetId: nativeCapnpConnectedClient.capability.id,
            connectionId: nativeCapnpConnectedClient.transport?.connectionId,
            transportKind: nativeCapnpConnectedClient.transport?.kind,
            connectionIsNull: nativeCapnpConnectedClient.connection === null,
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
            connectionId: nativeCapnpGeneratedWebSession.transport?.connectionId,
            transportKind: nativeCapnpGeneratedWebSession.transport?.kind,
            connectionIsNull: nativeCapnpGeneratedWebSession.connection === null,
            response: nativeCapnpGeneratedClientResult,
            stream: nativeCapnpGeneratedStreamResult,
            drop: nativeCapnpGeneratedDropResult,
          },
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
