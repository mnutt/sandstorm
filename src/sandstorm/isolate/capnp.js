import {
  Conn as CapnpEsConn,
  DeferredTransport as CapnpEsDeferredTransport,
  Interface as CapnpEsInterface,
  Message as CapnpEsMessage,
  utils as CapnpEsUtils,
} from "capnp-es/index.mjs";
import { IsolateBridge } from "capnp:/sandstorm/isolate-bridge.capnp";

export const SANDSTORM_CAPNP_VERSION = 0;
export const SANDSTORM_CAPNP_NATIVE_BRIDGE_PROTOCOL_VERSION = 0;

const NATIVE_CAPNP_BRIDGE_FEATURES = Object.freeze([
  "nativeTransport",
  "nativeRpc",
  "nativeRpcWebSocket",
  "nativeExports",
]);

const appInterfacePowerboxDescriptorCache = new Map();

function cloneJsonValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function initLocalizedText(builder, value) {
  if (value && typeof value.defaultText === "string") {
    builder.defaultText = value.defaultText;
  }
}

function initSandstormApiSaveParams(params, cap, label) {
  const client = cap?.client ?? cap;
  if (!client) {
    throw new TypeError("SandstormApi.save() requires a Cap'n Proto capability");
  }

  CapnpEsUtils.setInterfacePointer(
    params.segment.message.addCap(client),
    CapnpEsUtils.getPointer(0, params));
  initLocalizedText(params._initLabel(), label);
}

async function readJsonResponse(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      error: text || `HTTP ${response.status}`,
    };
  }
}

function appInterfaceDescriptorParams(interfaceName, schema, options = {}) {
  const interfaceId = schema.interfaceId || "";
  if (!interfaceId) {
    throw new TypeError(`${interfaceName}.powerboxDescriptor() requires schema interfaceId`);
  }

  const params = new URLSearchParams();
  params.set("interfaceId", interfaceId);
  params.set("interfaceName", schema.interfaceName || interfaceName);
  return params;
}

async function fetchAppInterfacePowerboxDescriptor(env, interfaceName, schema, options = {}) {
  if (!env?.SANDSTORM_API || typeof env.SANDSTORM_API.fetch !== "function") {
    throw new TypeError(`${interfaceName}.powerboxDescriptor() requires env.SANDSTORM_API`);
  }

  const params = appInterfaceDescriptorParams(interfaceName, schema, options);
  const cacheKey = params.toString();
  if (appInterfacePowerboxDescriptorCache.has(cacheKey)) {
    return cloneJsonValue(appInterfacePowerboxDescriptorCache.get(cacheKey));
  }

  const response = await env.SANDSTORM_API.fetch(
    `http://sandstorm/powerbox/app-interface-descriptor?${params}`);
  const result = await readJsonResponse(response);
  if (!response.ok || !result.ok) {
    throw new Error(result.error || `Powerbox descriptor request failed with ${response.status}`);
  }
  appInterfacePowerboxDescriptorCache.set(cacheKey, cloneJsonValue(result));
  return cloneJsonValue(result);
}

function invalidNativeCapnpBridgeInfo(reason, info) {
  return Object.freeze({
    available: false,
    protocolSupported: false,
    protocolVersion: SANDSTORM_CAPNP_NATIVE_BRIDGE_PROTOCOL_VERSION,
    nativeTransport: false,
    nativeRpc: false,
    nativeRpcWebSocket: false,
    nativeExports: false,
    missingFeatures: Object.freeze([]),
    reason,
    info,
  });
}

export function negotiateNativeCapnpBridgeInfo(info, options = {}) {
  if (!info || typeof info !== "object" || info.type !== "capnpBridgeInfo") {
    return invalidNativeCapnpBridgeInfo("invalid bridge info", info);
  }

  const requiredFeatures = options.requiredFeatures || [];
  for (const feature of requiredFeatures) {
    if (!NATIVE_CAPNP_BRIDGE_FEATURES.includes(feature)) {
      throw new TypeError(`unknown native Cap'n Proto bridge feature: ${feature}`);
    }
  }

  const minProtocolVersion = Number(info.minProtocolVersion);
  const maxProtocolVersion = Number(info.maxProtocolVersion);
  const protocolSupported = Number.isInteger(minProtocolVersion) &&
    Number.isInteger(maxProtocolVersion) &&
    minProtocolVersion <= SANDSTORM_CAPNP_NATIVE_BRIDGE_PROTOCOL_VERSION &&
    SANDSTORM_CAPNP_NATIVE_BRIDGE_PROTOCOL_VERSION <= maxProtocolVersion;
  const missingFeatures = requiredFeatures.filter((feature) => info[feature] !== true);
  const nativeTransport = info.nativeTransport === true;
  const available = protocolSupported && nativeTransport && missingFeatures.length === 0;
  let reason = "";
  if (!protocolSupported) {
    reason = "unsupported protocol";
  } else if (!nativeTransport) {
    reason = "native transport unavailable";
  } else if (missingFeatures.length > 0) {
    reason = "missing features";
  }

  return Object.freeze({
    available,
    protocolSupported,
    protocolVersion: SANDSTORM_CAPNP_NATIVE_BRIDGE_PROTOCOL_VERSION,
    nativeTransport,
    nativeRpc: info.nativeRpc === true,
    nativeRpcWebSocket: info.nativeRpcWebSocket === true,
    nativeExports: info.nativeExports === true,
    missingFeatures: Object.freeze(missingFeatures),
    reason,
    info,
  });
}

export async function negotiateNativeCapnpBridge(api, options = {}) {
  if (!api || typeof api.capnpBridgeInfo !== "function") {
    throw new TypeError("negotiateNativeCapnpBridge() requires a Sandstorm API object");
  }
  return negotiateNativeCapnpBridgeInfo(await api.capnpBridgeInfo(), options);
}

export class NativeCapnpBridgeUnavailableError extends Error {
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

function nativeCapnpMessageBytes(message) {
  if (message instanceof Uint8Array) {
    return message;
  } else if (message instanceof ArrayBuffer) {
    return new Uint8Array(message);
  } else if (ArrayBuffer.isView(message)) {
    return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  } else if (message && typeof message.toUint8Array === "function") {
    return message.toUint8Array();
  }
  throw new TypeError("native Cap'n Proto payload message must be capnp-es Message or bytes");
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

  throw new NativeCapnpBridgeProtocolError(`${name} is not a capnp-es client reference`);
}

function nativeCapnpBase64UrlDecode(text, name = "base64url value") {
  if (typeof text !== "string" || text.length === 0 || text.length % 4 === 1 ||
      !/^[A-Za-z0-9_-]+$/.test(text)) {
    throw new TypeError(`${name} must be non-empty base64url text`);
  }

  const base64 = text.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (text.length % 4)) % 4);
  if (typeof globalThis.atob === "function") {
    const binary = globalThis.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; ++i) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  if (typeof globalThis.Buffer === "function") {
    return new Uint8Array(globalThis.Buffer.from(base64, "base64"));
  }

  throw new NativeCapnpBridgeProtocolError("base64url decoding is unavailable");
}

function nativeCapnpBase64UrlEncode(bytes) {
  bytes = nativeCapnpMessageBytes(bytes);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  let base64;
  if (typeof globalThis.btoa === "function") {
    base64 = globalThis.btoa(binary);
  } else if (typeof globalThis.Buffer === "function") {
    base64 = globalThis.Buffer.from(bytes).toString("base64");
  } else {
    throw new NativeCapnpBridgeProtocolError("base64url encoding is unavailable");
  }

  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function nativeCapnpUtf8(bytes) {
  try {
    return new TextDecoder().decode(bytes);
  } catch (_) {
    return "";
  }
}

export function nativeCapnpSavedTokenData(token) {
  if (typeof token !== "string") {
    return nativeCapnpMessageBytes(token);
  }

  const decoded = nativeCapnpBase64UrlDecode(token, "saved capability token");
  const text = nativeCapnpUtf8(decoded);
  const lines = text.split("\n");
  if (lines[0] === "isolate-saved-capability-v1" && lines.length >= 4) {
    return nativeCapnpBase64UrlDecode(lines[3], "saved capability token sturdy ref");
  }

  return decoded;
}

export function nativeCapnpSavedTokenText(token) {
  if (typeof token === "string") {
    return token;
  }

  return nativeCapnpBase64UrlEncode(token);
}

function normalizeNativeCapnpCapabilitySlot(slot) {
  if (!slot || typeof slot !== "object") {
    throw new TypeError("native Cap'n Proto capability slot must be an object");
  }
  if (typeof slot.id !== "string" || slot.id.length === 0) {
    throw new TypeError("native Cap'n Proto capability slot requires a non-empty id");
  }
  return Object.freeze({
    id: slot.id,
    interfaceId: nativeCapnpInterfaceId(slot.interfaceId ?? 0n),
    interfaceName: typeof slot.interfaceName === "string" ? slot.interfaceName : "",
    kind: typeof slot.kind === "string" ? slot.kind : "receiverHosted",
  });
}

function makeNativeCapnpBridgeConnectionId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `native-capnp-${globalThis.crypto.randomUUID()}`;
  }

  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
    return "native-capnp-" + Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0")).join("");
  }

  return `native-capnp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function normalizeNativeCapnpBridgeConnectionId(connectionId = makeNativeCapnpBridgeConnectionId()) {
  if (typeof connectionId !== "string" || connectionId.length === 0) {
    throw new TypeError("native Cap'n Proto bridge connection id must be a non-empty string");
  }
  return connectionId;
}

export function makeNativeCapnpPayload(message = new CapnpEsMessage(), capabilities = []) {
  if (!Array.isArray(capabilities)) {
    throw new TypeError("native Cap'n Proto payload capabilities must be an array");
  }
  return Object.freeze({
    message: nativeCapnpMessageBytes(message),
    capabilities: Object.freeze(capabilities.map(normalizeNativeCapnpCapabilitySlot)),
  });
}

function nativeCapnpInterfaceId(value) {
  if (typeof value === "bigint") {
    return value;
  } else if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  } else if (typeof value === "string") {
    const text = value.startsWith("0x") ? value : `0x${value}`;
    return BigInt(text);
  }
  throw new TypeError("native Cap'n Proto interface ID must be a bigint, safe integer, or hex string");
}

function nativeCapnpInterfaceIdsEqual(a, b) {
  return nativeCapnpInterfaceId(a) === nativeCapnpInterfaceId(b);
}

function nativeCapnpRootMessageBytes(message) {
  if (message && typeof message === "object" && message.segment?.message) {
    if (message.segment.id === 0 && message.byteOffset === 0) {
      return message.segment.message.toUint8Array();
    }

    const copy = new CapnpEsMessage();
    copy.setRoot(message);
    return copy.toUint8Array();
  }

  return nativeCapnpMessageBytes(message);
}

const NATIVE_CAPNP_MAX_STREAM_FRAME_BYTES = 16 * 1024 * 1024;
const NATIVE_CAPNP_MAX_STREAM_SEGMENTS = 4096;

function copyUint8Array(value) {
  const bytes = nativeCapnpMessageBytes(value);
  return new Uint8Array(bytes);
}

function concatNativeCapnpChunks(left, right) {
  if (left.byteLength === 0) {
    return copyUint8Array(right);
  }

  const bytes = copyUint8Array(right);
  const result = new Uint8Array(left.byteLength + bytes.byteLength);
  result.set(left);
  result.set(bytes, left.byteLength);
  return result;
}

class NativeCapnpStreamFrameDecoder {
  #pending = new Uint8Array(0);

  push(chunk) {
    this.#pending = concatNativeCapnpChunks(this.#pending, chunk);
    const frames = [];

    while (this.#pending.byteLength >= 8) {
      const view = new DataView(
        this.#pending.buffer, this.#pending.byteOffset, this.#pending.byteLength);
      const segmentCount = view.getUint32(0, true) + 1;
      if (segmentCount <= 0 || segmentCount > NATIVE_CAPNP_MAX_STREAM_SEGMENTS) {
        throw new NativeCapnpBridgeProtocolError(
          `invalid native Cap'n Proto stream segment count: ${segmentCount}`);
      }

      const tableInts = 1 + segmentCount;
      const headerBytes = Math.ceil(tableInts / 2) * 8;
      if (this.#pending.byteLength < headerBytes) {
        break;
      }

      let payloadWords = 0;
      for (let i = 0; i < segmentCount; ++i) {
        payloadWords += view.getUint32(4 + i * 4, true);
      }

      const frameBytes = headerBytes + payloadWords * 8;
      if (frameBytes > NATIVE_CAPNP_MAX_STREAM_FRAME_BYTES) {
        throw new NativeCapnpBridgeProtocolError(
          `native Cap'n Proto stream frame exceeds ${NATIVE_CAPNP_MAX_STREAM_FRAME_BYTES} bytes`);
      }
      if (this.#pending.byteLength < frameBytes) {
        break;
      }

      frames.push(this.#pending.slice(0, frameBytes));
      this.#pending = this.#pending.slice(frameBytes);
    }

    return frames;
  }
}

function nativeCapnpInterfaceMetadata(InterfaceClass, options = {}) {
  const schema = options.schema || options.binding?.schema ||
      InterfaceClass?.schema || InterfaceClass?.Client?.schema ||
      InterfaceClass?._capnp || InterfaceClass?.Client?._capnp || {};
  return Object.freeze({
    interfaceId: options.interfaceId ?? schema.interfaceId ??
        InterfaceClass?.interfaceId ?? InterfaceClass?.Client?.interfaceId ??
        schema.typeId ?? 0n,
    interfaceName: options.interfaceName ?? schema.interfaceName ??
        InterfaceClass?.interfaceName ?? InterfaceClass?.Client?.interfaceName ?? "",
  });
}

function nativeCapnpInterfaceIdHex(interfaceId) {
  if (typeof interfaceId === "bigint") {
    return `0x${interfaceId.toString(16)}`;
  } else if (typeof interfaceId === "number" && Number.isSafeInteger(interfaceId)) {
    return `0x${BigInt(interfaceId).toString(16)}`;
  } else if (typeof interfaceId === "string" && interfaceId.length > 0) {
    return interfaceId.startsWith("0x") ? interfaceId : `0x${interfaceId}`;
  }
  return "";
}

function nativeCapnpDescriptorSchema(InterfaceClass, options = {}) {
  const metadata = nativeCapnpInterfaceMetadata(InterfaceClass, options);
  const interfaceId = nativeCapnpInterfaceIdHex(metadata.interfaceId);
  if (!interfaceId || interfaceId === "0x0") {
    throw new TypeError("native Cap'n Proto Powerbox descriptor requires an interface id");
  }
  return Object.freeze({
    interfaceId,
    interfaceName: metadata.interfaceName || InterfaceClass?._capnp?.displayName || "",
  });
}

export async function nativeCapnpPowerboxDescriptorInfo(env, InterfaceClass, options = {}) {
  const schema = nativeCapnpDescriptorSchema(InterfaceClass, options);
  return fetchAppInterfacePowerboxDescriptor(
    env, schema.interfaceName || "native Cap'n Proto interface", schema, options);
}

export async function nativeCapnpPowerboxDescriptor(env, InterfaceClass, options = {}) {
  const result = await nativeCapnpPowerboxDescriptorInfo(env, InterfaceClass, options);
  return result.descriptor;
}

function nativeCapnpBridgeExceptionError(message, context) {
  return new NativeCapnpBridgeUnavailableError(message, context);
}

export class NativeCapnpBridgeWebSocketRpcTransport extends CapnpEsDeferredTransport {
  #webSocket = null;
  #openPromise = null;
  #sendQueue = Promise.resolve();

  constructor(api, target, options = {}) {
    super();
    if (!api || typeof api.nativeCapnpBridgeOpenRpcSession !== "function") {
      throw new NativeCapnpBridgeProtocolError(
        "NativeCapnpBridgeWebSocketRpcTransport requires api.nativeCapnpBridgeOpenRpcSession()");
    }
    if (!target || typeof target !== "object" || typeof target.id !== "string") {
      throw new NativeCapnpBridgeProtocolError(
        "NativeCapnpBridgeWebSocketRpcTransport requires a Sandstorm capability target");
    }

    this.api = api;
    this.target = normalizeNativeCapnpCapabilitySlot(target);
    this.connectionId = normalizeNativeCapnpBridgeConnectionId(options.connectionId);
    this.connection = null;
    this.kind = "webSocketRpc";
  }

  sendMessage(message) {
    if (this.closed) {
      throw new NativeCapnpBridgeUnavailableError(
        "native Cap'n Proto WebSocket RPC transport is closed", { target: this.target });
    }

    const bytes = nativeCapnpRootMessageBytes(message);
    this.#sendQueue = this.#sendQueue
      .then(async () => {
        const webSocket = await this.#open();
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
    if (this.closed) {
      return;
    }

    try {
      this.#webSocket?.close(error === undefined ? 1000 : 1011);
    } catch (_) {}

    super.close(error);
  }

  async #open() {
    if (this.#webSocket) {
      return this.#webSocket;
    }

    if (!this.#openPromise) {
      this.#openPromise = this.api.nativeCapnpBridgeOpenRpcSession(
        this.target, this.connectionId).then((webSocket) => {
        if (!webSocket || typeof webSocket.send !== "function" ||
            typeof webSocket.addEventListener !== "function") {
          throw new NativeCapnpBridgeProtocolError(
            "native Cap'n Proto RPC session returned an invalid WebSocket");
        }

        webSocket.binaryType = "arraybuffer";
        webSocket.addEventListener("message", (event) => {
          try {
            this.resolve(nativeCapnpMessageBytes(event.data));
          } catch (error) {
            this.abort(error);
          }
        });
        webSocket.addEventListener("close", () => this.close());
        webSocket.addEventListener("error", (event) => this.abort(event.error || event));
        this.#webSocket = webSocket;
        return webSocket;
      });
    }

    return await this.#openPromise;
  }
}

export class NativeCapnpStreamTransport extends CapnpEsDeferredTransport {
  #decoder = new NativeCapnpStreamFrameDecoder();
  #reader;
  #writer;
  #writeQueue = Promise.resolve();
  #connection;

  constructor(readable, writable, options = {}) {
    super();
    if (!readable || typeof readable.getReader !== "function") {
      throw new TypeError("NativeCapnpStreamTransport requires a ReadableStream");
    }
    if (!writable || typeof writable.getWriter !== "function") {
      throw new TypeError("NativeCapnpStreamTransport requires a WritableStream");
    }

    this.#reader = readable.getReader();
    this.#writer = writable.getWriter();
    this.#connection = options.connection || null;
    this.#readLoop();
  }

  attachConnection(connection) {
    this.#connection = connection;
  }

  sendMessage(message) {
    if (this.closed) {
      throw new NativeCapnpBridgeUnavailableError("native Cap'n Proto stream transport is closed");
    }

    const bytes = nativeCapnpRootMessageBytes(message);
    this.#writeQueue = this.#writeQueue
      .then(() => this.#writer.write(bytes))
      .catch((error) => this.abort(error));
  }

  abort(error) {
    if (this.closed) {
      return;
    }

    if (this.#connection && !this.#connection.closed) {
      this.#connection.shutdown(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    this.close(error);
  }

  close(error) {
    if (this.closed) {
      return;
    }

    try {
      this.#reader.cancel(error);
    } catch (_) {}
    try {
      if (error === undefined) {
        this.#writer.close();
      } else {
        this.#writer.abort(error);
      }
    } catch (_) {}

    super.close(error);
  }

  async #readLoop() {
    try {
      while (!this.closed) {
        const { done, value } = await this.#reader.read();
        if (done) {
          this.close();
          return;
        }

        for (const frame of this.#decoder.push(value)) {
          this.resolve(frame);
        }
      }
    } catch (error) {
      this.abort(error);
    }
  }
}

export class NativeCapnpWebSocketTransport extends CapnpEsDeferredTransport {
  #webSocket;
  #sendQueue = Promise.resolve();
  #connection;

  constructor(webSocket, options = {}) {
    super();
    if (!webSocket || typeof webSocket.send !== "function" ||
        typeof webSocket.addEventListener !== "function") {
      throw new TypeError("NativeCapnpWebSocketTransport requires a WebSocket");
    }

    this.#webSocket = webSocket;
    this.#connection = options.connection || null;
    this.#webSocket.binaryType = "arraybuffer";
    this.#webSocket.addEventListener("message", (event) => {
      try {
        this.resolve(nativeCapnpMessageBytes(event.data));
      } catch (error) {
        this.abort(error);
      }
    });
    this.#webSocket.addEventListener("close", () => this.close());
    this.#webSocket.addEventListener("error", (event) => this.abort(event.error || event));
  }

  attachConnection(connection) {
    this.#connection = connection;
  }

  sendMessage(message) {
    if (this.closed) {
      throw new NativeCapnpBridgeUnavailableError(
        "native Cap'n Proto WebSocket transport is closed");
    }

    const bytes = nativeCapnpRootMessageBytes(message);
    this.#sendQueue = this.#sendQueue
      .then(() => this.#webSocket.send(bytes))
      .catch((error) => this.abort(error));
  }

  abort(error) {
    if (this.closed) {
      return;
    }

    if (this.#connection && !this.#connection.closed) {
      this.#connection.shutdown(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    this.close(error);
  }

  close(error) {
    if (this.closed) {
      return;
    }

    try {
      this.#webSocket.close(error === undefined ? 1000 : 1011);
    } catch (_) {}

    super.close(error);
  }
}

export function createNativeCapnpBridgeConnection(api, target, options = {}) {
  if (typeof api?.nativeCapnpBridgeOpenRpcSession !== "function") {
    throw new NativeCapnpBridgeUnavailableError(
      "native Cap'n Proto RPC requires api.nativeCapnpBridgeOpenRpcSession()");
  }
  const transport = new NativeCapnpBridgeWebSocketRpcTransport(api, target, options);
  const conn = new CapnpEsConn(transport, options.finalize);
  transport.connection = conn;
  return Object.assign(conn, { transport });
}

export class IsolateBridgeWebSocketRpcTransport extends CapnpEsDeferredTransport {
  #webSocket = null;
  #openPromise = null;
  #sendQueue = Promise.resolve();

  constructor(api, options = {}) {
    super();
    if (!api || typeof api.nativeCapnpBridgeOpenBootstrapSession !== "function") {
      throw new NativeCapnpBridgeProtocolError(
        "IsolateBridgeWebSocketRpcTransport requires " +
        "api.nativeCapnpBridgeOpenBootstrapSession()");
    }

    this.api = api;
    this.connectionId = normalizeNativeCapnpBridgeConnectionId(options.connectionId);
    this.connection = null;
    this.kind = "isolateBridgeWebSocketRpc";
  }

  sendMessage(message) {
    if (this.closed) {
      throw new NativeCapnpBridgeUnavailableError(
        "isolate bridge WebSocket RPC transport is closed");
    }

    const bytes = nativeCapnpRootMessageBytes(message);
    this.#sendQueue = this.#sendQueue
      .then(async () => {
        const webSocket = await this.#open();
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
    if (this.closed) {
      return;
    }

    try {
      this.#webSocket?.close(error === undefined ? 1000 : 1011);
    } catch (_) {}

    super.close(error);
  }

  async #open() {
    if (this.#webSocket) {
      return this.#webSocket;
    }

    if (!this.#openPromise) {
      this.#openPromise = this.api.nativeCapnpBridgeOpenBootstrapSession(
        this.connectionId).then((webSocket) => {
        if (!webSocket || typeof webSocket.send !== "function" ||
            typeof webSocket.addEventListener !== "function") {
          throw new NativeCapnpBridgeProtocolError(
            "isolate bridge RPC session returned an invalid WebSocket");
        }

        webSocket.binaryType = "arraybuffer";
        webSocket.addEventListener("message", (event) => {
          try {
            this.resolve(nativeCapnpMessageBytes(event.data));
          } catch (error) {
            this.abort(error);
          }
        });
        webSocket.addEventListener("close", () => this.close());
        webSocket.addEventListener("error", (event) => this.abort(event.error || event));
        this.#webSocket = webSocket;
        return webSocket;
      });
    }

    return await this.#openPromise;
  }
}

export function createIsolateBridgeConnection(api, options = {}) {
  const transport = new IsolateBridgeWebSocketRpcTransport(api, options);
  const connection = new CapnpEsConn(transport, options.finalize);
  transport.connection = connection;
  return Object.assign(connection, { transport });
}

export function connectIsolateBridge(api, options = {}) {
  const connection = createIsolateBridgeConnection(api, options);
  const bridge = connection.bootstrap(IsolateBridge);
  return Object.assign(bridge, {
    connection,
    transport: connection.transport,
    close: (...args) => connection.transport.close(...args),
  });
}

function validateNativeCapnpGeneratedInterface(InterfaceClass, operation) {
  if (!InterfaceClass || typeof InterfaceClass.Client !== "function" ||
      typeof InterfaceClass.Server !== "function") {
    throw new TypeError(`${operation} requires a capnp-es generated interface class`);
  }
}

export function createNativeCapnpExportSession(
    InterfaceClass, target, { readable, writable, webSocket, finalize } = {}) {
  validateNativeCapnpGeneratedInterface(InterfaceClass, "createNativeCapnpExportSession()");
  if (!target || typeof target !== "object") {
    throw new TypeError("createNativeCapnpExportSession() requires a server target object");
  }

  const transport = webSocket
    ? new NativeCapnpWebSocketTransport(webSocket)
    : new NativeCapnpStreamTransport(readable, writable);
  const connection = new CapnpEsConn(transport, finalize);
  transport.attachConnection(connection);
  connection.initMain(InterfaceClass, target);
  return Object.assign(connection, {
    transport,
    interfaceMetadata: nativeCapnpInterfaceMetadata(InterfaceClass),
  });
}

export async function exportNativeCapnp(api, InterfaceClass, target, options = {}) {
  validateNativeCapnpGeneratedInterface(InterfaceClass, "exportNativeCapnp()");
  if (!api || typeof api.capnpBridgeInfo !== "function") {
    throw new TypeError("exportNativeCapnp() requires a Sandstorm API object");
  }

  if (!target || typeof target !== "object") {
    throw new TypeError("exportNativeCapnp() requires a server target object");
  }

  const interfaceMetadata = nativeCapnpInterfaceMetadata(InterfaceClass, options);
  const negotiation = await negotiateNativeCapnpBridge(api, {
    requiredFeatures: ["nativeRpc", "nativeRpcWebSocket"],
  });
  if (!negotiation.available) {
    throw new NativeCapnpBridgeUnavailableError(
      `native Cap'n Proto exports are unavailable: ${negotiation.reason || "unavailable"}`,
      { negotiation, interfaceMetadata });
  }

  const server = new InterfaceClass.Server(target);
  const client = server.client();
  const capability = Object.freeze({
    kind: "localExport",
    interfaceId: interfaceMetadata.interfaceId,
    interfaceName: interfaceMetadata.interfaceName,
  });
  const publicInterfaceId = nativeCapnpInterfaceIdHex(interfaceMetadata.interfaceId);

  return Object.assign(client, {
    capability,
    connection: null,
    transport: null,
    drop: () => {
      server.close?.();
      return undefined;
    },
    info: async () => ({
      ok: true,
      type: "nativeCapnpCapability",
      kind: "localExport",
      interfaceId: publicInterfaceId,
      interfaceName: interfaceMetadata.interfaceName,
    }),
    save: async (saveOptions = {}) => {
      const bridge = connectIsolateBridge(api, {
        connectionId: saveOptions.connectionId,
        finalize: saveOptions.finalize,
      });
      try {
        const result = await bridge.getSandstormApi({});
        const sandstormApi = result.api;
        if (!sandstormApi || typeof sandstormApi.save !== "function") {
          throw new NativeCapnpBridgeProtocolError(
            "isolate bridge returned an invalid SandstormApi capability");
        }

        const saved = await sandstormApi.save((params) => {
          initSandstormApiSaveParams(params, client, nativeCapnpSaveLabel(saveOptions));
        });
        bridge.close();
        return nativeCapnpSavedTokenText(saved.token);
      } catch (error) {
        bridge.close(error);
        throw error;
      }
    },
    toJSON: () => ({
      ok: true,
      type: "nativeCapnpCapability",
      kind: "localExport",
      interfaceId: publicInterfaceId,
      interfaceName: interfaceMetadata.interfaceName,
    }),
  });
}

function nativeCapnpSaveLabel(options = {}) {
  const label = options.saveLabel ?? options.label;
  if (typeof label === "string") {
    return { defaultText: label };
  } else if (label && typeof label === "object") {
    return label;
  } else {
    return { defaultText: "native Cap'n Proto capability" };
  }
}

export async function restoreNativeCapnpViaBootstrap(api, token, InterfaceClass, options = {}) {
  if (!InterfaceClass || typeof InterfaceClass.Client !== "function") {
    throw new TypeError(
      "restoreNativeCapnpViaBootstrap() requires a capnp-es generated interface class");
  }

  const negotiation = await negotiateNativeCapnpBridge(api, {
    requiredFeatures: ["nativeRpc", "nativeRpcWebSocket"],
  });
  if (!negotiation.available) {
    throw new NativeCapnpBridgeUnavailableError(
      `native Cap'n Proto RPC transport is unavailable for restore: ` +
          `${negotiation.reason || "unavailable"}`,
      { negotiation });
  }

  const interfaceMetadata = nativeCapnpInterfaceMetadata(InterfaceClass, options);
  const bridge = connectIsolateBridge(api, {
    connectionId: options.connectionId,
    finalize: options.finalize,
  });
  let sandstormApi;
  let restored;
  try {
    const result = await bridge.getSandstormApi({});
    sandstormApi = result.api;
    if (!sandstormApi || typeof sandstormApi.restore !== "function" ||
        typeof sandstormApi.save !== "function") {
      throw new NativeCapnpBridgeProtocolError(
        "isolate bridge returned an invalid SandstormApi capability");
    }

    restored = await sandstormApi.restore({
      token: nativeCapnpSavedTokenData(token),
    });
  } catch (error) {
    bridge.close(error);
    throw error;
  }

  const cap = restored?.cap;
  if (!cap) {
    const error = new NativeCapnpBridgeProtocolError(
      "SandstormApi.restore() returned no capability");
    bridge.close(error);
    throw error;
  }

  let client;
  try {
    client = new InterfaceClass.Client(
      nativeCapnpClientReference(cap, "SandstormApi.restore() capability"));
  } catch (error) {
    bridge.close(error);
    throw error;
  }
  if (!client || typeof client !== "object") {
    const error = new NativeCapnpBridgeProtocolError(
      "capnp-es generated interface did not produce a client object");
    bridge.close(error);
    throw error;
  }

  const capability = Object.freeze({
    kind: "rpcImport",
    interfaceId: interfaceMetadata.interfaceId,
    interfaceName: interfaceMetadata.interfaceName,
  });
  return Object.assign(client, {
    capability,
    connection: bridge.connection,
    transport: bridge.transport,
    drop: () => {
      bridge.close();
      return undefined;
    },
    save: async (saveOptions = {}) => {
      const result = await sandstormApi.save({
        cap,
        label: nativeCapnpSaveLabel(saveOptions),
      });
      return nativeCapnpSavedTokenText(result.token);
    },
  });
}

export function connectNativeCapnp(api, target, InterfaceClass, options = {}) {
  if (!InterfaceClass || typeof InterfaceClass.Client !== "function") {
    throw new TypeError("connectNativeCapnp() requires a capnp-es generated interface class");
  }

  const connection = createNativeCapnpBridgeConnection(api, target, options);
  const client = connection.bootstrap(InterfaceClass);
  if (!client || typeof client !== "object") {
    throw new NativeCapnpBridgeProtocolError(
      "capnp-es generated interface did not produce a client object");
  }

  return Object.assign(client, {
    capability: target,
    connection,
    transport: connection.transport,
    drop: async (...args) => {
      connection.transport.close();
      return typeof target.drop === "function" ? await target.drop(...args) : undefined;
    },
    save: (...args) => {
      if (typeof target.save !== "function") {
        throw new NativeCapnpBridgeProtocolError(
          "connectNativeCapnp().save() requires a Sandstorm capability handle with save()");
      }
      return target.save(...args);
    },
  });
}

export async function restoreNativeCapnp(api, token, InterfaceClass, options = {}) {
  return await restoreNativeCapnpViaBootstrap(api, token, InterfaceClass, options);
}
