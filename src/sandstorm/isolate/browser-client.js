import {
  Conn,
  DeferredTransport,
  Interface as CapnpEsInterface,
  Message,
} from "/capnp-es/index.mjs";
import {
  IsolateApiSessionPowerboxTag,
} from "/__sandstorm/capnp/sandstorm/isolate-api-session-tag.capnp.js";
import { BrowserIsolateBridge } from "/__sandstorm/capnp/sandstorm/isolate-bridge.capnp.js";
import {
  OutboundHttpSession,
} from "/__sandstorm/capnp/sandstorm/outbound-http-session.capnp.js";
import { PowerboxDescriptor } from "/__sandstorm/capnp/sandstorm/powerbox.capnp.js";

class NativeCapnpBridgeUnavailableError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "NativeCapnpBridgeUnavailableError";
    this.details = details;
  }
}

export class NativeCapnpBridgeProtocolError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "NativeCapnpBridgeProtocolError";
    this.details = details;
  }
}

function cloneNativeCapnpJsonValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function nativeCapnpMessageBytes(message) {
  if (message instanceof Uint8Array) return message;
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  if (ArrayBuffer.isView(message)) {
    return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  }
  if (message && typeof message.toUint8Array === "function") {
    return message.toUint8Array();
  }
  throw new TypeError("native Cap'n Proto message must be bytes or a capnp-es Message");
}

function nativeCapnpRootMessageBytes(message) {
  if (message && typeof message === "object" && message.segment?.message) {
    if (message.segment.id === 0 && message.byteOffset === 0) {
      return message.segment.message.toUint8Array();
    }
    const copy = new Message();
    copy.setRoot(message);
    return copy.toUint8Array();
  }
  return nativeCapnpMessageBytes(message);
}

function nativeCapnpClientReference(value, name = "capability") {
  if (value && typeof value.call === "function") {
    return value;
  }

  if (value && typeof value.client?.call === "function") {
    return value.client;
  }

  if (value && typeof value.getClient === "function") {
    const client = value.getClient();
    if (client && typeof client.call === "function") {
      return client;
    }
  }

  if (value && typeof CapnpEsInterface?.fromPointer === "function") {
    const client = CapnpEsInterface.fromPointer(value)?.getClient();
    if (client && typeof client.call === "function") {
      return client;
    }
  }

  throw new Error(name + " is not a capnp-es client reference");
}

function nativeCapnpInterfaceId(value = 0n) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === "string" && value.length > 0) {
    return BigInt(value.startsWith("0x") ? value : "0x" + value);
  }
  return 0n;
}

function nativeCapnpInterfaceIdText(value = 0n) {
  const interfaceId = nativeCapnpInterfaceId(value);
  return interfaceId === 0n ? "" : "0x" + interfaceId.toString(16);
}

function nativeCapnpInterfaceMetadata(InterfaceClass, options = {}) {
  if (!InterfaceClass || typeof InterfaceClass.Client !== "function") {
    throw new TypeError("expected a capnp-es generated interface class");
  }
  const schema = InterfaceClass.schema || InterfaceClass.Client.schema ||
    InterfaceClass._capnp || InterfaceClass.Client._capnp || {};
  const firstMethod = Array.isArray(InterfaceClass.Client.methods) ?
    InterfaceClass.Client.methods[0] : undefined;
  const interfaceId = nativeCapnpInterfaceId(
    options.interfaceId ??
    schema.interfaceId ??
    schema.typeId ??
    InterfaceClass.interfaceId ??
    InterfaceClass.Client.interfaceId ??
    firstMethod?.interfaceId ??
    0n);
  const interfaceName = options.interfaceName ??
    schema.interfaceName ??
    firstMethod?.interfaceName ??
    schema.displayName ??
    InterfaceClass.interfaceName ??
    InterfaceClass.name ??
    "";
  return Object.freeze({
    interfaceId,
    interfaceIdText: nativeCapnpInterfaceIdText(interfaceId),
    interfaceName,
  });
}

function nativeCapnpSlotKind(kind = "receiverHosted") {
  switch (kind) {
    case "senderHosted":
    case "receiverHosted":
    case "savedToken":
      return kind;
    default:
      throw new TypeError("unknown native capability slot kind: " + kind);
  }
}

function normalizeNativeCapnpCapabilitySlot(slot) {
  if (!slot || typeof slot !== "object" || typeof slot.id !== "string" || slot.id.length === 0) {
    throw new NativeCapnpBridgeProtocolError(
      "native bridge target must be a Sandstorm capability handle");
  }
  return Object.freeze({
    id: slot.id,
    interfaceId: nativeCapnpInterfaceId(slot.interfaceId),
    interfaceName: typeof slot.interfaceName === "string" ? slot.interfaceName : "",
    kind: nativeCapnpSlotKind(slot.kind),
  });
}

async function nativeCapnpBrowserMessageBytes(data) {
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  return nativeCapnpMessageBytes(data);
}

function browserNativeCapnpRpcSessionUrl() {
  const url = new URL(
    "/__sandstorm/native-capnp/rpc-session",
    globalThis.location?.href || "http://sandstorm/");
  if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else if (url.protocol === "http:") {
    url.protocol = "ws:";
  }
  return url;
}

function openBrowserNativeCapnpRpcSession() {
  const url = browserNativeCapnpRpcSessionUrl();
  return new Promise((resolve, reject) => {
    const webSocket = new WebSocket(url.href);
    let settled = false;
    webSocket.binaryType = "arraybuffer";

    function cleanup() {
      webSocket.removeEventListener("open", onOpen);
      webSocket.removeEventListener("error", onError);
      webSocket.removeEventListener("close", onClose);
    }

    function fail(error) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }

    function onOpen() {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(webSocket);
    }

    function onError() {
      fail(new NativeCapnpBridgeUnavailableError(
        "native Cap'n Proto browser WebSocket RPC session failed"));
    }

    function onClose(event) {
      fail(new NativeCapnpBridgeUnavailableError(
        "native Cap'n Proto browser WebSocket RPC session closed before opening" +
        (event?.code ? " with code " + event.code : "")));
    }

    webSocket.addEventListener("open", onOpen);
    webSocket.addEventListener("error", onError);
    webSocket.addEventListener("close", onClose);
  });
}

const nativeCapnpPowerboxDescriptorCache = new Map();
const API_SESSION_INTERFACE_ID = 0xc879e379c625cdc7n;
const OUTBOUND_HTTP_METHOD_ENUMS = new Map([
  ["GET", OutboundHttpSession.Method.GET],
  ["POST", OutboundHttpSession.Method.POST],
  ["PUT", OutboundHttpSession.Method.PUT],
  ["PATCH", OutboundHttpSession.Method.PATCH],
  ["DELETE", OutboundHttpSession.Method.DELETE],
  ["HEAD", OutboundHttpSession.Method.HEAD],
  ["OPTIONS", OutboundHttpSession.Method.OPTIONS],
]);

function base64UrlEncodeBytes(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; ++i) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function createCapnpStructValue(StructClass, initializer) {
  const message = new Message();
  const value = message.initRoot(StructClass);
  StructClass._applyInit(value, initializer);
  return value;
}

function packedPowerboxDescriptorInfo(tagId, tagValue, decoded) {
  const message = new Message();
  const descriptor = message.initRoot(PowerboxDescriptor);
  const tag = descriptor._initTags(1).get(0);
  tag.id = tagId;
  if (tagValue !== null) tag.value = tagValue;
  return {
    ok: true,
    type: "packedPowerboxDescriptor",
    descriptor: base64UrlEncodeBytes(message.toPackedUint8Array()),
    decoded,
  };
}

async function fetchNativeCapnpPowerboxDescriptorInfo(InterfaceClass, options = {}) {
  const metadata = nativeCapnpInterfaceMetadata(InterfaceClass, options);
  if (!metadata.interfaceIdText) {
    throw new TypeError("native Cap'n Proto Powerbox descriptor requires an interface id");
  }

  const cacheKey = `${metadata.interfaceIdText}\n${metadata.interfaceName}`;
  if (nativeCapnpPowerboxDescriptorCache.has(cacheKey)) {
    return cloneNativeCapnpJsonValue(nativeCapnpPowerboxDescriptorCache.get(cacheKey));
  }

  const decoded = {
    kind: "appInterface",
    interfaceId: metadata.interfaceIdText,
  };
  if (metadata.interfaceName) decoded.interfaceName = metadata.interfaceName;
  const result = packedPowerboxDescriptorInfo(metadata.interfaceId, null, decoded);
  nativeCapnpPowerboxDescriptorCache.set(cacheKey, cloneNativeCapnpJsonValue(result));
  return cloneNativeCapnpJsonValue(result);
}

export async function nativeCapnpPowerboxDescriptor(InterfaceClass, options = {}) {
  const result = await fetchNativeCapnpPowerboxDescriptorInfo(InterfaceClass, options);
  return result.descriptor;
}

export async function nativeCapnpPowerboxDescriptorInfo(InterfaceClass, options = {}) {
  return fetchNativeCapnpPowerboxDescriptorInfo(InterfaceClass, options);
}

function validatePackedPowerboxDescriptor(descriptor, label = "descriptor") {
  if (typeof descriptor !== "string" || descriptor.length === 0) {
    throw new TypeError(label + " must be a non-empty packed Powerbox descriptor string");
  }
  if (descriptor.length % 4 === 1 || !/^[A-Za-z0-9_-]+$/.test(descriptor)) {
    throw new TypeError(label + " must be base64url packed Powerbox descriptor text");
  }
  return descriptor;
}

export async function apiSessionPowerboxDescriptorInfo(options = {}) {
  const input = options.apiSession ?? options.apiSessionDescriptor ?? options;
  const canonicalUrl = String(input.canonicalUrl || "");
  if (!canonicalUrl || canonicalUrl.length > 2048 || canonicalUrl.endsWith("/")) {
    throw new TypeError(
      "API session canonicalUrl must be non-empty, at most 2048 characters, and not end in '/'");
  }
  const oauthScopes = Array.from(input.oauthScopes || [], String);
  if (oauthScopes.some((scope) => scope.length === 0 || scope.length > 256)) {
    throw new TypeError("API session OAuth scopes must be 1-256 characters");
  }
  const tagValue = createCapnpStructValue(IsolateApiSessionPowerboxTag, {
    canonicalUrl,
    oauthScopes: oauthScopes.map((name) => ({ name })),
  });
  return packedPowerboxDescriptorInfo(API_SESSION_INTERFACE_ID, tagValue, {
    type: "apiSession",
    canonicalUrl,
    oauthScopes,
  });
}

export async function apiSessionPowerboxDescriptor(options = {}) {
  return (await apiSessionPowerboxDescriptorInfo(options)).descriptor;
}

export async function outboundHttpPowerboxDescriptorInfo(options = {}) {
  const input = options.outboundHttp ?? options.outboundHttpDescriptor ?? options;
  const baseUrl = String(input.baseUrl || "");
  if (!baseUrl || baseUrl.length > 2048) {
    throw new TypeError("outbound HTTP baseUrl must be non-empty and at most 2048 characters");
  }
  const methods = Array.from(input.methods || [], (method) => String(method).toUpperCase());
  const methodValues = methods.map((method) => {
    if (!OUTBOUND_HTTP_METHOD_ENUMS.has(method)) {
      throw new TypeError("unsupported outbound HTTP method: " + method);
    }
    return OUTBOUND_HTTP_METHOD_ENUMS.get(method);
  });
  const tagValue = createCapnpStructValue(OutboundHttpSession.PowerboxTag, {
    baseUrl,
    methods: methodValues,
  });
  return packedPowerboxDescriptorInfo(OutboundHttpSession._capnp.typeId, tagValue, {
    type: "outboundHttp",
    baseUrl,
    methods,
  });
}

export async function outboundHttpPowerboxDescriptor(options = {}) {
  return (await outboundHttpPowerboxDescriptorInfo(options)).descriptor;
}

function providerQueryFromOptions(options = {}) {
  const query = options.descriptors ?? options.descriptor;
  if (query === undefined || query === null) {
    throw new Error("Powerbox provider query requires descriptor or descriptors");
  }
  if (typeof query === "string") {
    return [validatePackedPowerboxDescriptor(query)];
  }
  if (!Array.isArray(query)) {
    throw new Error("Powerbox provider descriptors must be a string or an array");
  }
  return query.map((descriptor, index) =>
    validatePackedPowerboxDescriptor(descriptor, "provider descriptor " + index));
}

export async function inspectPowerboxQuery(query) {
  if (query && typeof query === "object" && !Array.isArray(query) &&
      (query.baseUrl || query.outboundHttp || query.outboundHttpDescriptor)) {
    const descriptorInfo = await outboundHttpPowerboxDescriptorInfo(
      query.outboundHttp ?? query.outboundHttpDescriptor ?? query);
    return {
      ok: true,
      type: "powerboxQueryInspection",
      descriptorCount: 1,
      descriptors: [{ index: 0, ...descriptorInfo }],
    };
  }

  if (query && typeof query === "object" && !Array.isArray(query) &&
      (query.canonicalUrl || query.apiSession || query.apiSessionDescriptor)) {
    const descriptorInfo = await apiSessionPowerboxDescriptorInfo(
      query.apiSession ?? query.apiSessionDescriptor ?? query);
    return {
      ok: true,
      type: "powerboxQueryInspection",
      descriptorCount: 1,
      descriptors: [{ index: 0, ...descriptorInfo }],
    };
  }

  const descriptors = typeof query === "string" || Array.isArray(query)
    ? providerQueryFromOptions({ descriptor: query })
    : providerQueryFromOptions(query || {});
  return {
    ok: true,
    type: "powerboxQueryInspection",
    descriptorCount: descriptors.length,
    descriptors: descriptors.map((descriptor, index) => ({
      index,
      type: "packedPowerboxDescriptor",
      descriptor,
    })),
  };
}

export function requestPowerbox(query, options = {}) {
  const browserWindow = globalThis.window;
  if (!browserWindow || !browserWindow.parent) {
    return Promise.reject(new Error("requestPowerbox() is only available in a browser session"));
  }

  const rpcId = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : "sandstorm-powerbox-" + Date.now().toString(36) + "-" +
      Math.random().toString(36).slice(2);
  const targetOrigin = options.targetOrigin || "*";
  const expectedOrigin = options.expectedOrigin || (
    targetOrigin === "*" ? undefined : targetOrigin);

  return new Promise((resolve, reject) => {
    function cleanup() {
      browserWindow.removeEventListener("message", onMessage);
    }

    function onMessage(event) {
      if (event.source !== browserWindow.parent) return;
      if (expectedOrigin !== undefined && event.origin !== expectedOrigin) return;
      const data = event.data || {};
      if (data.rpcId !== rpcId) return;

      cleanup();
      if (data.error) {
        reject(new Error(data.error));
      } else if (data.canceled) {
        reject(new Error("Powerbox request canceled"));
      } else {
        resolve({
          token: data.token,
          descriptor: data.descriptor,
        });
      }
    }

    browserWindow.addEventListener("message", onMessage);
    const powerboxRequest = { rpcId };
    if (query !== undefined && query !== null) {
      powerboxRequest.query = query;
      powerboxRequest.saveLabel = options.saveLabel;
    }

    browserWindow.parent.postMessage({ powerboxRequest }, targetOrigin);
  });
}

function browserRequiredPermissionNames(options = {}) {
  const permissions = options.requiredPermissions ?? [];
  if (!Array.isArray(permissions)) {
    throw new TypeError("requiredPermissions must be an array");
  }
  return permissions.map((permission, index) => {
    if (typeof permission !== "string" || permission.length === 0) {
      throw new TypeError("requiredPermissions[" + index + "] must be a non-empty string");
    }
    return permission;
  });
}

function capnpCapabilityFromResult(result, name) {
  if (typeof result?.getCap === "function") {
    return result.getCap();
  }
  if (result?.cap !== undefined) {
    return result.cap;
  }
  const pipeline = typeof result?.pipeline?.getPipeline === "function"
    ? result.pipeline.getPipeline(CapnpEsInterface, 0)
    : null;
  return typeof pipeline?.client === "function" ? pipeline.client() : null;
}

function browserNativeCapnpClient(cap, InterfaceClass, name) {
  return new InterfaceClass.Client(nativeCapnpClientReference(cap, name));
}

export async function claimBrowserNativeCapnpToken(token, InterfaceClass, options = {}) {
  if (typeof token !== "string" || token.length === 0) {
    throw new TypeError("claimBrowserNativeCapnpToken() requires a non-empty token");
  }
  if (!InterfaceClass || typeof InterfaceClass.Client !== "function") {
    throw new TypeError("claimBrowserNativeCapnpToken() requires a capnp-es generated interface");
  }
  if (options.powerboxDescriptor !== undefined) {
    validatePackedPowerboxDescriptor(options.powerboxDescriptor, "powerboxDescriptor");
  } else if (options.descriptor !== undefined) {
    validatePackedPowerboxDescriptor(options.descriptor, "descriptor");
  }

  const session = options.session ?? defaultBrowserNativeCapnpSession;
  return session.claimPowerboxToken(token, InterfaceClass, options);
}

export async function requestBrowserNativeCapnpPowerbox(InterfaceClass, options = {}) {
  const info = await nativeCapnpPowerboxDescriptorInfo(InterfaceClass, options);
  const requested = await requestPowerbox([info.descriptor], options);
  return Object.freeze({
    ...requested,
    powerboxDescriptor: info,
  });
}

export async function requestBrowserNativeCapnp(InterfaceClass, options = {}) {
  const requested = await requestBrowserNativeCapnpPowerbox(InterfaceClass, options);
  const capability = await claimBrowserNativeCapnpToken(requested.token, InterfaceClass, {
    ...options,
    powerboxDescriptor: requested.powerboxDescriptor.descriptor,
  });
  return Object.freeze({
    ...requested,
    capability,
    client: capability.client,
  });
}

const DEFAULT_MAX_BROWSER_CAPNP_MESSAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_BROWSER_CAPNP_BUFFERED_BYTES = 2 * 1024 * 1024;

class BrowserNativeCapnpBridgeWebSocketTransport extends DeferredTransport {
  #webSocket = null;
  #openPromise = null;
  #sendQueue = Promise.resolve();
  #closedResolve;
  #onStateChange;

  constructor(options = {}) {
    super();
    this.connection = null;
    this.kind = "browserIsolateBridgeWebSocketRpc";
    this.maxMessageBytes = DEFAULT_MAX_BROWSER_CAPNP_MESSAGE_BYTES;
    this.maxBufferedBytes = DEFAULT_MAX_BROWSER_CAPNP_BUFFERED_BYTES;
    this.#onStateChange = options.onStateChange;
    this.closedPromise = new Promise(resolve => {
      this.#closedResolve = resolve;
    });
  }

  sendMessage(message) {
    if (this.closed) {
      throw new NativeCapnpBridgeUnavailableError(
        "native Cap'n Proto browser WebSocket RPC transport is closed");
    }

    const bytes = nativeCapnpRootMessageBytes(message);
    if (bytes.byteLength > this.maxMessageBytes) {
      throw new RangeError(
        "native Cap'n Proto browser message exceeds " + this.maxMessageBytes + " bytes");
    }
    this.#sendQueue = this.#sendQueue
      .then(async () => {
        const webSocket = await this.#open();
        while (webSocket.bufferedAmount > this.maxBufferedBytes) {
          await new Promise(resolve => setTimeout(resolve, 10));
          if (this.closed || webSocket.readyState !== WebSocket.OPEN) {
            throw new NativeCapnpBridgeUnavailableError(
              "native Cap'n Proto browser WebSocket RPC transport closed while buffering");
          }
        }
        webSocket.send(bytes);
      })
      .catch((error) => this.abort(error));
  }

  abort(error) {
    if (this.connection && !this.connection.closed) {
      this.connection.shutdown(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    this.close(error);
  }

  close(error) {
    if (this.closed) return;
    try {
      this.#webSocket?.close(error === undefined ? 1000 : 1011);
    } catch (_) {}
    super.close(error);
    this.#closedResolve?.(error);
    this.#closedResolve = null;
    this.#onStateChange?.(error === undefined ? "closed" : "failed", error);
  }

  async #open() {
    if (this.#webSocket) {
      return this.#webSocket;
    }

    if (!this.#openPromise) {
      this.#onStateChange?.("connecting");
      this.#openPromise = openBrowserNativeCapnpRpcSession().then((webSocket) => {
        webSocket.addEventListener("message", async (event) => {
          try {
            this.resolve(await nativeCapnpBrowserMessageBytes(event.data));
          } catch (error) {
            this.abort(error);
          }
        });
        webSocket.addEventListener("close", () => this.close());
        webSocket.addEventListener("error", (event) => this.abort(event.error || event));
        this.#webSocket = webSocket;
        this.#onStateChange?.("open");
        return webSocket;
      });
    }

    return await this.#openPromise;
  }
}

function createBrowserNativeCapnpConnection(options = {}) {
  if (typeof WebSocket !== "function") {
    throw new NativeCapnpBridgeUnavailableError(
      "native Cap'n Proto browser RPC requires WebSocket");
  }
  const transport = new BrowserNativeCapnpBridgeWebSocketTransport(options);
  const connection = new Conn(transport, options.finalize);
  transport.connection = connection;
  return Object.assign(connection, { transport });
}

export class BrowserNativeCapnpSession {
  #options;
  #connection = null;
  #bridge = null;
  #state = "idle";
  #generation = 0;
  #closed = false;
  #listeners = new Set();

  constructor(options = {}) {
    this.#options = { ...options };
  }

  get state() {
    return this.#state;
  }

  get generation() {
    return this.#generation;
  }

  get closed() {
    return this.#closed;
  }

  onStateChange(listener) {
    if (typeof listener !== "function") {
      throw new TypeError("onStateChange() requires a function");
    }
    this.#listeners.add(listener);
    listener(Object.freeze({
      state: this.#state,
      generation: this.#generation,
      error: null,
    }));
    return () => this.#listeners.delete(listener);
  }

  async application(InterfaceClass, options = {}) {
    const metadata = nativeCapnpInterfaceMetadata(InterfaceClass, options);
    if (metadata.interfaceId === 0n) {
      throw new TypeError("application() requires a generated interface with a type ID");
    }
    const { bridge } = this.#current();
    const result = await bridge.getApplicationBootstrap({});
    if (!result?.found) {
      throw new NativeCapnpBridgeProtocolError(
        "this worker did not declare a browser application capability");
    }
    const actualId = nativeCapnpInterfaceId(result.interfaceId);
    if (actualId !== metadata.interfaceId) {
      throw new NativeCapnpBridgeProtocolError(
        "browser application interface mismatch: expected " +
        metadata.interfaceIdText + ", received " + nativeCapnpInterfaceIdText(actualId));
    }
    const cap = capnpCapabilityFromResult(result, "browser application capability");
    if (!cap) {
      throw new NativeCapnpBridgeProtocolError(
        "browser isolate bridge returned no application capability");
    }
    return browserNativeCapnpClient(cap, InterfaceClass, "browser application capability");
  }

  async handoff(target, InterfaceClass, options = {}) {
    const metadata = nativeCapnpInterfaceMetadata(InterfaceClass, options);
    const normalizedTarget = normalizeNativeCapnpCapabilitySlot(target);
    if (metadata.interfaceId === 0n || normalizedTarget.interfaceId === 0n) {
      throw new NativeCapnpBridgeProtocolError(
        "browser handoff requires typed interface metadata");
    }
    if (normalizedTarget.interfaceId !== metadata.interfaceId) {
      throw new NativeCapnpBridgeProtocolError(
        "browser handoff interface mismatch: expected " + metadata.interfaceIdText +
        ", received " + nativeCapnpInterfaceIdText(normalizedTarget.interfaceId));
    }
    const { bridge } = this.#current();
    const claimed = await bridge.takeHandoffCapability({
      id: normalizedTarget.id,
      interfaceId: metadata.interfaceId,
    });
    const cap = capnpCapabilityFromResult(claimed, "browser handoff capability pipeline");
    if (!cap) {
      throw new NativeCapnpBridgeProtocolError(
        "browser isolate bridge did not return a handoff capability pipeline");
    }
    return browserNativeCapnpClient(
      cap, InterfaceClass, "browser handoff capability pipeline");
  }

  async claimPowerboxToken(token, InterfaceClass, options = {}) {
    const metadata = nativeCapnpInterfaceMetadata(InterfaceClass, options);
    const { bridge } = this.#current();
    const claimed = await bridge.claimPowerboxRequest({
      requestToken: token,
      requiredPermissions: browserRequiredPermissionNames(options),
    });
    const cap = capnpCapabilityFromResult(claimed, "browser Powerbox claimed capability");
    if (!cap) {
      throw new NativeCapnpBridgeProtocolError(
        "browser isolate bridge did not return a claimed Powerbox capability");
    }
    return Object.freeze({
      type: "browserNativeCapnpCapability",
      interfaceId: metadata.interfaceId,
      interfaceName: metadata.interfaceName,
      kind: "receiverHosted",
      cap,
      client: browserNativeCapnpClient(
        cap, InterfaceClass, "browser Powerbox claimed capability"),
    });
  }

  whenDisconnected() {
    const { transport } = this.#current();
    return transport.closedPromise;
  }

  reconnect() {
    if (this.#closed) {
      throw new NativeCapnpBridgeUnavailableError(
        "native Cap'n Proto browser session has been closed");
    }
    this.#connection?.transport.close();
    this.#connection = null;
    this.#bridge = null;
    this.#setState("idle");
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#connection?.transport.close();
    this.#connection = null;
    this.#bridge = null;
    this.#setState("closed");
  }

  #current() {
    if (this.#closed) {
      throw new NativeCapnpBridgeUnavailableError(
        "native Cap'n Proto browser session has been closed");
    }
    if (!this.#connection || this.#connection.transport.closed) {
      this.#generation += 1;
      this.#connection = createBrowserNativeCapnpConnection({
        ...this.#options,
        onStateChange: (state, error) => this.#setState(state, error),
      });
      this.#bridge = this.#connection.bootstrap(BrowserIsolateBridge);
      this.#setState("idle");
    }
    return {
      connection: this.#connection,
      transport: this.#connection.transport,
      bridge: this.#bridge,
    };
  }

  #setState(state, error = null) {
    if (this.#closed && state !== "closed") return;
    this.#state = state;
    const event = Object.freeze({ state, generation: this.#generation, error });
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (listenerError) {
        queueMicrotask(() => { throw listenerError; });
      }
    }
  }
}

const defaultBrowserNativeCapnpSession = new BrowserNativeCapnpSession();

export function getBrowserNativeCapnpSession() {
  return defaultBrowserNativeCapnpSession;
}

export function observeBrowserNativeCapnpApplication(
    InterfaceClass, listener, options = {}) {
  if (typeof listener !== "function") {
    throw new TypeError("observeBrowserNativeCapnpApplication() requires a listener");
  }
  const session = options.session ?? defaultBrowserNativeCapnpSession;
  const initialRetryDelay = Number(options.retryDelayMs ?? 250);
  const maximumRetryDelay = Number(options.maxRetryDelayMs ?? 5000);
  if (!Number.isFinite(initialRetryDelay) || initialRetryDelay <= 0 ||
      !Number.isFinite(maximumRetryDelay) || maximumRetryDelay < initialRetryDelay) {
    throw new RangeError(
      "browser application retry delays must be finite, positive, and ordered");
  }
  let stopped = false;
  let retryDelay = initialRetryDelay;
  let current = null;
  let stopWaiting;
  const stoppedPromise = new Promise(resolve => {
    stopWaiting = resolve;
  });
  const reportError = (error) => {
    try {
      options.onError?.(error);
    } catch (callbackError) {
      queueMicrotask(() => { throw callbackError; });
    }
  };

  const done = (async () => {
    while (!stopped) {
      try {
        current = await session.application(InterfaceClass, options);
        retryDelay = initialRetryDelay;
        await listener(current, Object.freeze({
          generation: session.generation,
          state: session.state,
        }));
        await Promise.race([session.whenDisconnected(), stoppedPromise]);
      } catch (error) {
        if (stopped) break;
        reportError(error);
      } finally {
        if (current !== null) {
          current = null;
          try {
            await listener(null, Object.freeze({
              generation: session.generation,
              state: session.state,
            }));
          } catch (error) {
            reportError(error);
          }
        }
      }
      if (stopped) break;
      await Promise.race([
        new Promise(resolve => setTimeout(resolve, retryDelay)),
        stoppedPromise,
      ]);
      if (stopped) break;
      retryDelay = Math.min(retryDelay * 2, maximumRetryDelay);
      session.reconnect();
    }
  })();

  return Object.freeze({
    get client() {
      return current;
    },
    done,
    close() {
      stopped = true;
      stopWaiting();
    },
  });
}

export async function connectBrowserNativeCapnp(target, InterfaceClass, options = {}) {
  if (!InterfaceClass || typeof InterfaceClass.Client !== "function") {
    throw new TypeError("connectBrowserNativeCapnp() requires a capnp-es generated interface");
  }
  const session = options.session ?? defaultBrowserNativeCapnpSession;
  return session.handoff(target, InterfaceClass, options);
}

export async function connectBrowserNativeCapnpApplication(InterfaceClass, options = {}) {
  const session = options.session ?? defaultBrowserNativeCapnpSession;
  return session.application(InterfaceClass, options);
}

if (typeof globalThis.addEventListener === "function") {
  globalThis.addEventListener("pagehide", () => defaultBrowserNativeCapnpSession.close(), {
    once: true,
  });
}
