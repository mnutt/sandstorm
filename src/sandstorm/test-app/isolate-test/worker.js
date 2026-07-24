import metadata from "metadata.json";
import {
  NativeGreeter,
  NativeGreeterObjectId,
} from "capnp:./native-greeter.capnp";
import {
  Capability,
  capnpClient,
  createCapnpStruct,
  defineWorker,
  exportCapnp,
  mainViewFromFetch,
  readCapnpStruct,
  sandstorm,
  serveCapnp,
} from "sandstorm:api";
import {
  CAPNP_CLIENT_SYMBOL,
  connectIsolateBridge,
} from "sandstorm-internal:capnp-runtime";

const MAX_TEST_DOWNLOAD_BYTES = 70 * 1024 * 1024;

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

function makeNativeGreeterObjectId(id) {
  return createCapnpStruct(NativeGreeterObjectId, { id });
}

function readNativeGreeterObjectId(objectId) {
  return readCapnpStruct(NativeGreeterObjectId, objectId).id;
}

function makePersistentNativeGreeterTarget(id) {
  let blockedCallContext = null;
  let cancellationObserved = false;

  return {
    async save() {
      return {
        objectId: makeNativeGreeterObjectId(id),
        label: { defaultText: `native greeter ${id}` },
      };
    },

    async hello(params, callContext) {
      if (id === "supervisor-export" &&
          (!callContext?.env?.SANDSTORM_API ||
           typeof callContext?.ctx?.waitUntil !== "function" ||
           typeof callContext?.signal?.addEventListener !== "function" ||
           callContext.signal.aborted)) {
        throw new Error("named Cap'n Proto export did not receive its workerd call context");
      }
      if (id === "supervisor-export" && params.name === "concurrent second") {
        if (blockedCallContext === null) {
          throw new Error("concurrent worker call did not overlap the blocked call");
        }
        if (blockedCallContext === callContext.ctx) {
          throw new Error("concurrent worker calls shared a workerd execution context");
        }
      }
      if (id === "supervisor-export" && params.name === "cancel cooperative") {
        if (blockedCallContext !== null) {
          throw new Error("worker cancellation probe already had a blocked call");
        }
        blockedCallContext = callContext.ctx;
        try {
          await new Promise((_, reject) => {
            callContext.signal.addEventListener("abort", () => {
              cancellationObserved = true;
              reject(callContext.signal.reason);
            }, { once: true });
          });
        } finally {
          blockedCallContext = null;
        }
      }
      if (id === "supervisor-export" && params.name === "cancellation started") {
        if (blockedCallContext === null || blockedCallContext === callContext.ctx) {
          throw new Error("worker cancellation probe did not start in an independent event");
        }
      }
      if (id === "supervisor-export" && params.name === "cancellation status") {
        return { message: cancellationObserved ? "cancellation observed" : "cancellation pending" };
      }
      if (id === "supervisor-export" && params.name === "after cancellation") {
        if (!cancellationObserved) {
          throw new Error("canceled worker call did not abort its call signal");
        }
        if (blockedCallContext !== null) {
          throw new Error("canceled worker call did not release its event context");
        }
      }
      return {
        message: `classic native greeter ${id} hello ${params.name}`,
      };
    },

    async makeGreeter(params) {
      const greeter = new NativeGreeter.Server(
        makeReturnedNativeGreeterTarget(params.prefix)).client();
      return { greeter };
    },

    async greetWith(params, callContext) {
      const isConcurrencyProbe = id === "supervisor-export" &&
          (params.name === "concurrent first" || params.name === "shutdown pending");
      if (isConcurrencyProbe) {
        if (blockedCallContext !== null) {
          throw new Error("worker concurrency probe already had a blocked call");
        }
        blockedCallContext = callContext.ctx;
      }
      try {
        const hello = await params.greeter.hello({
          name: `${params.name} from classic native greeter ${id}`,
        });
        return {
          message: `classic native greeter ${id} called ${hello.message}`,
        };
      } finally {
        if (isConcurrencyProbe) blockedCallContext = null;
      }
    },

    async inspectData(params) {
      const bytes = capnpDataBytes(params.content);
      return {
        byteCount: BigInt(bytes.byteLength),
        checksum: checksum(bytes),
        firstEightHex: firstEightHex(bytes),
      };
    },

    async ping(params) {
      return { payload: capnpDataBytes(params.payload) };
    },
  };
}

function makeReturnedNativeGreeterTarget(prefix) {
  return {
    async save() {
      return {
        objectId: makeNativeGreeterObjectId(`returned:${prefix}`),
        label: { defaultText: `returned native greeter ${prefix}` },
      };
    },
    async hello(params) {
      return { message: `${prefix} ${params.name}` };
    },
  };
}

function restoreNativeGreeterTarget(objectId) {
  const id = readNativeGreeterObjectId(objectId);
  return id.startsWith("returned:")
    ? makeReturnedNativeGreeterTarget(id.slice("returned:".length))
    : makePersistentNativeGreeterTarget(id);
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

function benchmarkInteger(searchParams, name, defaultValue, { min, max }) {
  const text = searchParams.get(name);
  if (text === null) return defaultValue;
  if (!/^[0-9]+$/.test(text)) {
    throw new TypeError(`${name} must be an integer`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

function rounded(value) {
  return Number(value.toFixed(3));
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function roundedMedian(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length > 0 ? rounded(median(finite)) : null;
}

async function benchmarkNativeGreeterSample(client, payload, { iterations, concurrency }) {
  let nextCall = 0;
  const started = performance.now();

  async function runCalls() {
    while (true) {
      const call = nextCall++;
      if (call >= iterations) return;
      const result = await client.ping({ payload });
      const echoed = capnpDataBytes(result.payload);
      if (echoed.byteLength !== payload.byteLength) {
        throw new Error(
          `benchmark ping returned ${echoed.byteLength} bytes; expected ${payload.byteLength}`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, runCalls));
  const elapsedMs = performance.now() - started;
  const requestBytes = iterations * payload.byteLength;
  const roundTripBytes = requestBytes * 2;
  const seconds = elapsedMs / 1000;
  return {
    elapsedMs: rounded(elapsedMs),
    callsPerSecond: elapsedMs > 0 ? rounded(iterations / seconds) : null,
    wallTimeUsPerCall: rounded(elapsedMs * 1000 / iterations),
    requestMiBPerSecond: elapsedMs > 0
      ? rounded(requestBytes / (1024 * 1024) / seconds)
      : null,
    roundTripMiBPerSecond: elapsedMs > 0
      ? rounded(roundTripBytes / (1024 * 1024) / seconds)
      : null,
  };
}

async function benchmarkNativeGreeter(client, payload, options) {
  for (let i = 0; i < options.warmup; ++i) {
    const result = await client.ping({ payload });
    if (capnpDataBytes(result.payload).byteLength !== payload.byteLength) {
      throw new Error("benchmark warmup returned the wrong payload length");
    }
  }

  const samples = [];
  for (let i = 0; i < options.samples; ++i) {
    samples.push(await benchmarkNativeGreeterSample(client, payload, options));
  }
  return {
    samples,
    median: {
      callsPerSecond: roundedMedian(samples.map((sample) => sample.callsPerSecond)),
      wallTimeUsPerCall: roundedMedian(samples.map((sample) => sample.wallTimeUsPerCall)),
      requestMiBPerSecond: roundedMedian(
        samples.map((sample) => sample.requestMiBPerSecond)),
      roundTripMiBPerSecond: roundedMedian(
        samples.map((sample) => sample.roundTripMiBPerSecond)),
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
    <button id="request-service" type="button">request service capability</button>
    <pre id="offer-result">not offered</pre>
    <pre id="request-result">not requested</pre>
    <pre id="service-result">service not requested</pre>

    <script type="module">
      import { requestPowerbox } from "/__sandstorm/native-capnp/client.js";

      const offerResult = document.querySelector("#offer-result");
      const requestResult = document.querySelector("#request-result");
      const serviceResult = document.querySelector("#service-result");

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

      document.querySelector("#request-service").addEventListener("click", async () => {
        serviceResult.textContent = "requesting service";
        try {
          const descriptorResponse = await fetch(
            "/__sandstorm/powerbox/app-interface-descriptor" +
            "?interfaceId=0xb66316217ceedb1b&interfaceName=NativeGreeter");
          const descriptor = await descriptorResponse.json();
          if (!descriptorResponse.ok || !descriptor.ok) {
            throw new Error(descriptor.error || "failed to build NativeGreeter descriptor");
          }
          const requested = await requestPowerbox([descriptor.descriptor], {
            saveLabel: { defaultText: "Service-only greeter" },
          });
          const response = await fetch("/browser-service-powerbox-finish", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(requested),
          });
          const body = await response.json();
          serviceResult.textContent = body.ok
            ? "service: success " + body.hello + " / " + body.restoredHello +
              " / revoked=" + body.revoked
            : JSON.stringify(body);
        } catch (error) {
          serviceResult.textContent = (error.message || String(error)) +
            "\\n" + (error.stack || "");
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

function renderDirectMainViewPage() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Direct MainView Browser Conformance</title>
  </head>
  <body>
    <button id="fetch" type="button">test direct fetch</button>
    <button id="websocket" type="button">test direct websocket</button>
    <pre id="fetch-result">fetch not tested</pre>
    <pre id="websocket-result">websocket not tested</pre>

    <script type="module">
      document.querySelector("#fetch").addEventListener("click", async () => {
        const result = document.querySelector("#fetch-result");
        result.textContent = "fetching";
        try {
          const response = await fetch("/browser-storage-health");
          const body = await response.json();
          result.textContent = response.ok && body.ok
            ? "fetch: direct MainView success " + body.status
            : JSON.stringify(body);
        } catch (error) {
          result.textContent = (error.message || String(error)) +
            "\\n" + (error.stack || "");
        }
      });

      document.querySelector("#websocket").addEventListener("click", () => {
        const result = document.querySelector("#websocket-result");
        result.textContent = "websocket: connecting";
        const protocol = location.protocol === "https:" ? "wss:" : "ws:";
        const socket = new WebSocket(protocol + "//" + location.host + "/websocket-echo");
        socket.binaryType = "arraybuffer";
        let textSeen = false;
        let binarySeen = false;
        let closing = false;

        function maybeClose() {
          if (textSeen && binarySeen && !closing) {
            closing = true;
            socket.close(4000, "browser conformance complete");
          }
        }

        socket.addEventListener("open", () => {
          socket.send("browser-text");
          socket.send(new Uint8Array([1, 2, 3, 255]));
        });
        socket.addEventListener("message", (event) => {
          if (typeof event.data === "string") {
            textSeen = event.data === "capnp:browser-text";
          } else {
            const bytes = new Uint8Array(event.data);
            binarySeen = bytes.length === 4 && bytes[0] === 1 && bytes[1] === 2 &&
              bytes[2] === 3 && bytes[3] === 255;
          }
          maybeClose();
        });
        socket.addEventListener("close", (event) => {
          result.textContent = textSeen && binarySeen && event.code === 4000
            ? "websocket: direct MainView success text binary close"
            : "websocket failed: text=" + textSeen + " binary=" + binarySeen +
              " close=" + event.code + " reason=" + event.reason;
        });
        socket.addEventListener("error", () => {
          result.textContent = "websocket failed: browser error";
        });
      });
    </script>
  </body>
</html>`;
}

async function isolateTestFetch(request, env, ctx) {
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

    if (url.pathname === "/websocket-echo") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      server.addEventListener("message", (event) => {
        server.send(`shared:${event.data}`);
      });
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/native-capnp-direct-probe") {
      const bridge = connectIsolateBridge(api);
      try {
        const result = await bridge.getSandstormApi({});
        return Response.json({
          ok: true,
          transportKind: bridge.transport.kind,
          hasSave: typeof result.api?.save === "function",
          hasRestore: typeof result.api?.restore === "function",
          hasDrop: typeof result.api?.drop === "function",
        });
      } finally {
        bridge.close();
      }
    }

    if (url.pathname === "/app-persistent-save-restore-self-test") {
      const greeter = await exportFixtureCapnp(api, NativeGreeter, {
        async save() {
          return {
            objectId: makeNativeGreeterObjectId("account-host-app-persistent"),
            label: { defaultText: "account host app persistent fixture" },
          };
        },
        async hello(params) {
          return { message: `account-host persistent hello ${params.name}` };
        },
      }, { interfaceName: "NativeGreeter" });
      const saved = await greeter.save({ label: "account host app persistent fixture" });
      const restored = await restoreFixtureCapability(api, saved, NativeGreeter, {
        interfaceName: "NativeGreeter",
        connectionId: "account-host-app-persistent-restored",
      });
      const hello = await restored.hello({ name: "parity" });
      const dropRestored = (await restored.drop()) ?? null;
      const dropOriginal = (await greeter.drop()) ?? null;
      await api.revoke(saved);
      return Response.json({
        ok: true,
        savedTokenType: typeof saved,
        message: hello.message,
        dropRestored,
        dropOriginal,
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

    if (url.pathname === "/direct-session-context-offer") {
      const capability = await api.webSession({ pathPrefix: "/browser-powerbox-shared" });
      await capability.offer(request, {
        title: "Direct worker SessionContext probe",
        requiredPermissions: [],
      });
      await capability.drop();
      return Response.json({ ok: true, directSessionContext: true });
    }

    if (url.pathname === "/direct-browser-handoff") {
      const capability = await sandstorm(request, env).webSession({
        pathPrefix: "/browser-powerbox-shared",
      });
      const handoff = await capability.browserHandoff({ request });
      return Response.json({
        ok: true,
        handoffId: handoff.id,
        residence: handoff.residence,
      });
    }

    if (url.pathname === "/direct-ui-metadata") {
      const headers = new Headers({
        "cache-control": "public, immutable, max-age=31536000",
        "content-disposition": "attachment; filename=\"worker-report.txt\"",
        "content-language": "en-CA",
        "etag": "W/\"worker-ui-metadata\"",
        "vary": "Cookie, Accept",
        "x-sandstorm-app-metadata": "present",
      });
      headers.append("set-cookie", "workerSession=alpha; Max-Age=120; Path=/scope; HttpOnly; Secure");
      return new Response("worker UI metadata", { headers });
    }

    if (url.pathname === "/direct-ui-webdav") {
      return new Response("worker UI WebDAV", {
        headers: {
          "x-sandstorm-app-dav-depth": request.headers.get("depth") || "",
          "x-sandstorm-app-dav-destination": request.headers.get("destination") || "",
          "x-sandstorm-app-dav-lock-token": request.headers.get("lock-token") || "",
          "x-sandstorm-app-dav-method": request.method,
          "x-sandstorm-app-dav-overwrite": request.headers.get("overwrite") || "",
          "x-sandstorm-app-dav-type": request.headers.get("content-type") || "",
        },
      });
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

    if (url.pathname === "/browser-service-powerbox-finish" && request.method === "POST") {
      const body = await request.json();
      const capability = await api.powerbox().claim(body);
      const client = viewFixtureCapability(api, capability, NativeGreeter);
      const hello = await client.hello({ name: "from Powerbox" });
      const saved = await capability.save({ label: "Service-only greeter from Powerbox" });
      await capability.drop();

      const restoredCapability = await api.restore(saved);
      const restored = viewFixtureCapability(api, restoredCapability, NativeGreeter);
      const restoredHello = await restored.hello({ name: "after Powerbox restore" });
      await restoredCapability.drop();
      await api.revoke(saved);

      let revoked = false;
      try {
        const unexpected = await api.restore(saved);
        await unexpected.drop();
      } catch (error) {
        revoked = true;
      }
      return Response.json({
        ok: revoked,
        hello: hello.message,
        restoredHello: restoredHello.message,
        revoked,
      }, { status: revoked ? 200 : 500 });
    }

    if (url.pathname === "/browser-storage-test") {
      return new Response(renderBrowserStoragePage(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/browser-direct-main-view") {
      return new Response(renderDirectMainViewPage(), {
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

    if (url.pathname === "/binding-values-probe") {
      return Response.json({
        ok: true,
        text: env.TEXT_BINDING,
        json: env.JSON_BINDING,
      });
    }

    if (url.pathname === "/data-binding-probe") {
      const bytes = new Uint8Array(env.DATA_BINDING);
      return Response.json({
        ok: true,
        isArrayBuffer: env.DATA_BINDING instanceof ArrayBuffer,
        byteCount: bytes.byteLength,
        checksum: checksum(bytes),
        firstEightHex: firstEightHex(bytes),
      });
    }

    if (url.pathname === "/upload-stream") {
      let bodyBytes = 0;
      const reader = request.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bodyBytes += value.byteLength;
      }
      return Response.json({
        ok: true,
        method: request.method,
        bodyBytes,
        contentType: request.headers.get("content-type"),
      });
    }

    if (url.pathname === "/upload-duplex") {
      const reader = request.body.getReader();
      const { done, value } = await reader.read();
      if (done) throw new Error("duplex upload ended before its first chunk");
      await reader.cancel("response completed before upload EOF");
      return Response.json({
        ok: true,
        method: request.method,
        firstChunkBytes: value.byteLength,
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

    if (url.pathname === "/download-stream") {
      const size = Math.min(Number(url.searchParams.get("bytes") || "0"), MAX_TEST_DOWNLOAD_BYTES);
      let sent = 0;
      const body = new ReadableStream({
        pull(controller) {
          const count = Math.min(1024 * 1024, size - sent);
          if (count === 0) {
            controller.close();
            return;
          }
          controller.enqueue(new Uint8Array(count));
          sent += count;
        },
      });
      return new Response(body, {
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(size),
        },
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

    if (url.pathname === "/cross-grain-capnp-benchmark-token") {
      const api = sandstorm(request, env);
      const capability = await exportFixtureCapnp(
        api,
        NativeGreeter,
        makePersistentNativeGreeterTarget("cross-grain-capnp-benchmark"));
      const token = await capability.save({ label: "Cross-grain Cap'n Proto benchmark" });
      return new Response(token, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (url.pathname === "/cross-grain-capnp-benchmark") {
      const token = url.searchParams.get("token");
      if (!token) {
        return Response.json({ ok: false, error: "missing token" }, { status: 400 });
      }

      let config;
      try {
        config = {
          samples: benchmarkInteger(
            url.searchParams, "samples", 5, { min: 1, max: 25 }),
          concurrency: benchmarkInteger(
            url.searchParams, "concurrency", 1, { min: 1, max: 64 }),
          smallIterations: benchmarkInteger(
            url.searchParams, "smallIterations", 500, { min: 1, max: 100000 }),
          smallWarmup: benchmarkInteger(
            url.searchParams, "smallWarmup", 50, { min: 0, max: 10000 }),
          largeIterations: benchmarkInteger(
            url.searchParams, "largeIterations", 16, { min: 1, max: 10000 }),
          largeWarmup: benchmarkInteger(
            url.searchParams, "largeWarmup", 2, { min: 0, max: 1000 }),
          largePayloadBytes: benchmarkInteger(
            url.searchParams, "largePayloadBytes", 1024 * 1024,
            { min: 1, max: 16 * 1024 * 1024 }),
        };
      } catch (error) {
        return Response.json({ ok: false, error: String(error.message || error) }, { status: 400 });
      }

      const api = sandstorm(request, env);
      // Grant and restoration happen before either timer starts. The benchmark is specifically
      // measuring calls on an already-connected capability, not persistence or HTTP setup.
      const crossGrain = await restoreFixtureCapability(api, token, NativeGreeter);
      const local = new NativeGreeter.Server(
        makePersistentNativeGreeterTarget("cross-grain-capnp-benchmark-local")).client();
      const emptyPayload = new Uint8Array();
      const largePayload = new Uint8Array(config.largePayloadBytes);
      for (let i = 0; i < largePayload.length; ++i) {
        largePayload[i] = (i * 37 + 11) & 0xff;
      }

      const smallOptions = {
        iterations: config.smallIterations,
        warmup: config.smallWarmup,
        samples: config.samples,
        concurrency: config.concurrency,
      };
      const largeOptions = {
        iterations: config.largeIterations,
        warmup: config.largeWarmup,
        samples: config.samples,
        concurrency: config.concurrency,
      };
      const fixedCrossGrain = await benchmarkNativeGreeter(
        crossGrain, emptyPayload, smallOptions);
      const fixedLocal = await benchmarkNativeGreeter(local, emptyPayload, smallOptions);
      const dataCrossGrain = await benchmarkNativeGreeter(
        crossGrain, largePayload, largeOptions);
      const dataLocal = await benchmarkNativeGreeter(local, largePayload, largeOptions);

      const result = {
        ok: true,
        topology: "two grains in one account-shared native workerd host",
        measuredPath:
          "consumer native channel -> account-host Cap'n Proto proxy -> provider native channel",
        setupExcluded: [
          "HTTP benchmark orchestration",
          "capability save/grant",
          "capability restore and connection establishment",
        ],
        config,
        cases: {
          fixedCall: {
            description: "zero-byte request and response at concurrency 1 by default",
            payloadBytesEachDirection: 0,
            crossGrain: fixedCrossGrain,
            inIsolateCapnpBaseline: fixedLocal,
            overhead: {
              addedWallTimeUsPerCall: rounded(
                fixedCrossGrain.median.wallTimeUsPerCall -
                  fixedLocal.median.wallTimeUsPerCall),
              wallTimeRatio: fixedLocal.median.wallTimeUsPerCall > 0
                ? rounded(
                  fixedCrossGrain.median.wallTimeUsPerCall /
                    fixedLocal.median.wallTimeUsPerCall)
                : null,
            },
          },
          dataEcho: {
            description: "large Data payload echoed once in each direction",
            payloadBytesEachDirection: config.largePayloadBytes,
            applicationBytesPerCall: config.largePayloadBytes * 2,
            crossGrain: dataCrossGrain,
            inIsolateCapnpBaseline: dataLocal,
            overhead: {
              addedWallTimeUsPerCall: rounded(
                dataCrossGrain.median.wallTimeUsPerCall -
                  dataLocal.median.wallTimeUsPerCall),
              wallTimeRatio: dataLocal.median.wallTimeUsPerCall > 0
                ? rounded(
                  dataCrossGrain.median.wallTimeUsPerCall /
                    dataLocal.median.wallTimeUsPerCall)
                : null,
              roundTripThroughputRatio: dataLocal.median.roundTripMiBPerSecond > 0
                ? rounded(
                  dataCrossGrain.median.roundTripMiBPerSecond /
                    dataLocal.median.roundTripMiBPerSecond)
                : null,
            },
          },
        },
      };
      return new Response(JSON.stringify(result, null, 2), {
        headers: { "content-type": "application/json; charset=utf-8" },
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

    if (url.pathname === "/sandstorm-api-binding-probe") {
      const statusResponse = await env.SANDSTORM_API.fetch("http://sandstorm/status");
      const statusBody = await statusResponse.json();
      const ok = statusResponse.status === 200 &&
        statusBody.ok === true &&
        statusBody.binding === "sandstormApi" &&
        statusBody.mainModule === "worker.js";
      return Response.json({
        ok,
        status: statusResponse.status,
        body: statusBody,
      }, { status: ok ? 200 : 500 });
    }

    if (url.pathname === "/powerbox-binding-probe") {
      const statusResponse = await env.POWERBOX.fetch("http://sandstorm/status");
      const descriptorResponse = await env.POWERBOX.fetch(
        "http://sandstorm/powerbox/api-session-descriptor" +
        "?apiCanonicalUrl=https%3A%2F%2Fapi.example.test");
      const statusBody = await statusResponse.json();
      const descriptorBody = await descriptorResponse.json();
      const ok = statusResponse.status === 404 &&
        statusBody.ok === false &&
        descriptorResponse.status === 200 &&
        descriptorBody.ok === true &&
        descriptorBody.type === "packedPowerboxDescriptor";
      return Response.json({
        ok,
        statusEndpoint: {
          status: statusResponse.status,
          body: statusBody,
        },
        powerboxEndpoint: {
          status: descriptorResponse.status,
          body: descriptorBody,
        },
      }, { status: ok ? 200 : 500 });
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

    if (url.pathname === "/shared-storage-isolation") {
      const key = "shared-host-isolation";
      if (url.searchParams.has("value")) {
        const put = await env.STORAGE.fetch(`http://storage/${key}`, {
          method: "PUT",
          body: url.searchParams.get("value"),
        });
        if (!put.ok) {
          return Response.json({ ok: false, status: put.status }, { status: 500 });
        }
      }

      const read = await env.STORAGE.fetch(`http://storage/${key}`);
      return Response.json({
        ok: read.ok,
        value: read.ok ? await read.text() : null,
      }, { status: read.ok ? 200 : 500 });
    }


    return Response.json({ ok: false, error: "not found" }, { status: 404 });
}

const isolateTestViewInfo = {
  appTitle: { defaultText: "Sandstorm Isolate Test App" },
  permissions: [{
    name: "view",
    title: { defaultText: "view" },
    description: { defaultText: "allows opening the isolate test app" },
  }],
  roles: [{
    title: { defaultText: "viewer" },
    permissions: [true],
    verbPhrase: { defaultText: "can view" },
    default: true,
  }],
};

const restoreNativeGreeter = async (objectId) => new NativeGreeter.Server(
  restoreNativeGreeterTarget(objectId)).client();
const dropNativeGreeter = async (objectId) => {
  readNativeGreeterObjectId(objectId);
};

export default defineWorker({
  capabilities: {
    greeter: serveCapnp(
      NativeGreeter,
      makePersistentNativeGreeterTarget("supervisor-export"),
      {
        async restore(objectId) {
          return restoreNativeGreeterTarget(objectId);
        },
        drop: dropNativeGreeter,
      }),
    ui: mainViewFromFetch({
      fetch: isolateTestFetch,
      async webSocket(request) {
        const url = new URL(request.url);
        if (url.pathname !== "/websocket-echo") {
          throw new Error(`unknown direct WebSocket path: ${url.pathname}`);
        }
        return {
          async message(event, socket) {
            if (event.type === "text") {
              await socket.send(`capnp:${event.data}`);
            } else {
              await socket.send(event.data);
            }
          },
          async close(event, socket) {
            await socket.close(event.code, event.reason);
          },
        };
      },
      viewInfo: isolateTestViewInfo,
      restore: restoreNativeGreeter,
      drop: dropNativeGreeter,
    }),
  },
  fetch: isolateTestFetch,
});
