import {
  Conn as CapnpEsConn,
  DeferredTransport as CapnpEsDeferredTransport,
  Interface as CapnpEsInterface,
  Message as CapnpEsMessage,
} from "capnp-es/index.mjs";
import {
  NativeCapnpBridgeRequest,
  NativeCapnpBridgeResponse,
  NativeCapnpCapabilitySlotKind,
} from "sandstorm:native-capnp-bridge";
import { IsolateBridge } from "capnp:/sandstorm/isolate-bridge.capnp";

export const SANDSTORM_CAPNP_VERSION = 0;
export const SANDSTORM_CAPNP_NATIVE_BRIDGE_PROTOCOL_VERSION = 0;

const NATIVE_CAPNP_BRIDGE_FEATURES = Object.freeze([
  "nativeTransport",
  "nativeRpc",
  "nativeRpcWebSocket",
  "nativeExports",
]);

const NATIVE_CAPNP_EXPORT_SESSION_PREFIX = "/__sandstorm/native-capnp/export-sessions";
const nativeCapnpExportTargets = new Map();
const appInterfacePowerboxDescriptorCache = new Map();
const trustedNativeCapnpLocalDispatch = new WeakMap();

function cloneJsonValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
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

  if (lines[0] === "isolate-saved-capability-v2" && lines.length >= 7 &&
      lines[1] === "nativeCapnpExport") {
    return nativeCapnpBase64UrlDecode(lines[6], "saved capability token sturdy ref");
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

function nativeCapnpExportId(options = {}) {
  return normalizeNativeCapnpBridgeConnectionId(options.id);
}

function nativeCapnpExportSessionPath(id) {
  return `${NATIVE_CAPNP_EXPORT_SESSION_PREFIX}/${encodeURIComponent(id)}`;
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

function nativeCapnpSlotKind(kind) {
  switch (kind) {
    case "senderHosted":
      return NativeCapnpCapabilitySlotKind.SENDER_HOSTED;
    case "receiverHosted":
      return NativeCapnpCapabilitySlotKind.RECEIVER_HOSTED;
    case "savedToken":
      return NativeCapnpCapabilitySlotKind.SAVED_TOKEN;
    default:
      throw new TypeError(`unknown native Cap'n Proto capability slot kind: ${kind}`);
  }
}

function writeNativeCapnpCapabilitySlot(builder, slot) {
  builder.id = slot.id;
  builder.interfaceId = nativeCapnpInterfaceId(slot.interfaceId);
  builder.interfaceName = slot.interfaceName;
  builder.kind = nativeCapnpSlotKind(slot.kind);
}

function nativeCapnpSlotKindName(kind) {
  switch (kind) {
    case NativeCapnpCapabilitySlotKind.SENDER_HOSTED:
      return "senderHosted";
    case NativeCapnpCapabilitySlotKind.RECEIVER_HOSTED:
      return "receiverHosted";
    case NativeCapnpCapabilitySlotKind.SAVED_TOKEN:
      return "savedToken";
    default:
      throw new NativeCapnpBridgeProtocolError(
        `unknown native Cap'n Proto capability slot kind: ${kind}`);
  }
}

function readNativeCapnpLocalDispatch(slot) {
  if (!slot._hasLocalDispatch()) {
    return null;
  }

  const localDispatch = slot.localDispatch;
  const authorization = localDispatch.authorization;
  if (typeof localDispatch.exportId !== "string" || localDispatch.exportId.length === 0 ||
      typeof authorization !== "string" || authorization.length === 0) {
    return null;
  }

  return Object.freeze({
    exportId: localDispatch.exportId,
    interfaceId: nativeCapnpInterfaceId(localDispatch.interfaceId),
    interfaceName: typeof localDispatch.interfaceName === "string" ?
      localDispatch.interfaceName :
      "",
  });
}

function readNativeCapnpCapabilitySlot(slot, { trustedLocalDispatch = false } = {}) {
  const capability = {
    id: slot.id,
    interfaceId: slot.interfaceId,
    interfaceName: slot.interfaceName,
    kind: nativeCapnpSlotKindName(slot.kind),
  };

  if (trustedLocalDispatch) {
    const localDispatch = readNativeCapnpLocalDispatch(slot);
    if (localDispatch) {
      trustedNativeCapnpLocalDispatch.set(capability, localDispatch);
    }
  }

  return Object.freeze(capability);
}

function writeNativeCapnpBridgeException(builder, exception = {}) {
  builder.type = typeof exception.type === "string" ? exception.type : "failed";
  builder.reason = typeof exception.reason === "string" ? exception.reason : "";
  builder.trace = typeof exception.trace === "string" ? exception.trace : "";
}

function readNativeCapnpBridgeExceptionValue(exception) {
  return Object.freeze({
    type: exception.type,
    reason: exception.reason,
    trace: exception.trace,
  });
}

function makeNativeCapnpBridgeTargetRequest(kind, target) {
  if (!target || typeof target !== "object" || typeof target.id !== "string") {
    throw new NativeCapnpBridgeProtocolError(
      `native bridge ${kind} target must be a Sandstorm capability handle`);
  }

  const message = new CapnpEsMessage();
  const request = message.initRoot(NativeCapnpBridgeRequest);
  request.protocolVersion = SANDSTORM_CAPNP_NATIVE_BRIDGE_PROTOCOL_VERSION;

  if (kind === "drop") {
    writeNativeCapnpCapabilitySlot(
      request._initDrop()._initTarget(), normalizeNativeCapnpCapabilitySlot(target));
  } else if (kind === "save") {
    writeNativeCapnpCapabilitySlot(
      request._initSave()._initTarget(), normalizeNativeCapnpCapabilitySlot(target));
  } else {
    throw new NativeCapnpBridgeProtocolError(
      `unknown native Cap'n Proto bridge target request kind: ${kind}`);
  }

  return makeNativeCapnpPayload(message);
}

export function makeNativeCapnpBridgeDropRequest({ target } = {}) {
  return makeNativeCapnpBridgeTargetRequest("drop", target);
}

export function makeNativeCapnpBridgeSaveRequest({ target } = {}) {
  return makeNativeCapnpBridgeTargetRequest("save", target);
}

export function makeNativeCapnpBridgeRestoreRequest({
  token,
  expectedInterfaceId = 0n,
  expectedInterfaceName = "",
} = {}) {
  if (typeof token !== "string" || token.length === 0) {
    throw new NativeCapnpBridgeProtocolError(
      "native bridge restore request requires a non-empty token");
  }

  const message = new CapnpEsMessage();
  const request = message.initRoot(NativeCapnpBridgeRequest);
  request.protocolVersion = SANDSTORM_CAPNP_NATIVE_BRIDGE_PROTOCOL_VERSION;

  const restore = request._initRestore();
  restore.token = token;
  restore.expectedInterfaceId = nativeCapnpInterfaceId(expectedInterfaceId);
  restore.expectedInterfaceName =
      typeof expectedInterfaceName === "string" ? expectedInterfaceName : "";

  return makeNativeCapnpPayload(message);
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

export function readNativeCapnpBridgeRequest(message) {
  const bytes = nativeCapnpMessageBytes(message);
  return new CapnpEsMessage(bytes, false).getRoot(NativeCapnpBridgeRequest);
}

export function makeNativeCapnpBridgeExceptionResponse(exception = {}) {
  const message = new CapnpEsMessage();
  const response = message.initRoot(NativeCapnpBridgeResponse);
  response.protocolVersion = SANDSTORM_CAPNP_NATIVE_BRIDGE_PROTOCOL_VERSION;
  writeNativeCapnpBridgeException(response._initException(), exception);
  return makeNativeCapnpPayload(message);
}

export function makeNativeCapnpBridgeCapabilityResponse({ capability } = {}) {
  const message = new CapnpEsMessage();
  const response = message.initRoot(NativeCapnpBridgeResponse);
  response.protocolVersion = SANDSTORM_CAPNP_NATIVE_BRIDGE_PROTOCOL_VERSION;
  writeNativeCapnpCapabilitySlot(
    response._initCapability(), normalizeNativeCapnpCapabilitySlot(capability));
  return makeNativeCapnpPayload(message);
}

export function makeNativeCapnpBridgeSavedResponse({ token } = {}) {
  if (typeof token !== "string" || token.length === 0) {
    throw new NativeCapnpBridgeProtocolError(
      "native bridge saved response requires a non-empty token");
  }

  const message = new CapnpEsMessage();
  const response = message.initRoot(NativeCapnpBridgeResponse);
  response.protocolVersion = SANDSTORM_CAPNP_NATIVE_BRIDGE_PROTOCOL_VERSION;
  response._initSaved().token = token;
  return makeNativeCapnpPayload(message);
}

export function makeNativeCapnpBridgeAcknowledgedResponse() {
  const message = new CapnpEsMessage();
  const response = message.initRoot(NativeCapnpBridgeResponse);
  response.protocolVersion = SANDSTORM_CAPNP_NATIVE_BRIDGE_PROTOCOL_VERSION;
  response.acknowledged = true;
  return makeNativeCapnpPayload(message);
}

export function readNativeCapnpBridgeResponse(message) {
  const bytes = nativeCapnpMessageBytes(message);
  return new CapnpEsMessage(bytes, false).getRoot(NativeCapnpBridgeResponse);
}

function decodeNativeCapnpBridgeResponseInternal(message, { trustedLocalDispatch = false } = {}) {
  const response = readNativeCapnpBridgeResponse(message);
  if (response.protocolVersion !== SANDSTORM_CAPNP_NATIVE_BRIDGE_PROTOCOL_VERSION) {
    throw new NativeCapnpBridgeProtocolError(
      `unsupported native Cap'n Proto bridge response protocol version: ${response.protocolVersion}`);
  }

  switch (response.which()) {
    case NativeCapnpBridgeResponse.CAPABILITY:
      return Object.freeze({
        protocolVersion: response.protocolVersion,
        which: "capability",
        capability: readNativeCapnpCapabilitySlot(response.capability, { trustedLocalDispatch }),
      });
    case NativeCapnpBridgeResponse.SAVED:
      return Object.freeze({
        protocolVersion: response.protocolVersion,
        which: "saved",
        saved: Object.freeze({ token: response.saved.token }),
      });
    case NativeCapnpBridgeResponse.ACKNOWLEDGED:
      return Object.freeze({
        protocolVersion: response.protocolVersion,
        which: "acknowledged",
      });
    case NativeCapnpBridgeResponse.EXCEPTION:
      return Object.freeze({
        protocolVersion: response.protocolVersion,
        which: "exception",
        exception: readNativeCapnpBridgeExceptionValue(response.exception),
      });
    default:
      throw new NativeCapnpBridgeProtocolError(
        `unknown native Cap'n Proto bridge response discriminant: ${response.which()}`);
  }
}

export function decodeNativeCapnpBridgeResponse(message) {
  return decodeNativeCapnpBridgeResponseInternal(message);
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

async function sendNativeCapnpBridgeEnvelope(api, request, context, expectedWhich) {
  if (!api || typeof api.nativeCapnpBridgeLifecycleBytes !== "function") {
    throw new NativeCapnpBridgeProtocolError(
      "native bridge lifecycle requires api.nativeCapnpBridgeLifecycleBytes()");
  }

  const response = await api.nativeCapnpBridgeLifecycleBytes(request.message);
  if (!response || typeof response !== "object" || !(response.body instanceof Uint8Array)) {
    throw new NativeCapnpBridgeProtocolError("native bridge lifecycle returned an invalid response");
  }

  const decoded = decodeNativeCapnpBridgeResponseInternal(
    response.body, { trustedLocalDispatch: true });
  if (decoded.which === "exception") {
    throw new NativeCapnpBridgeUnavailableError(
      decoded.exception.reason || "native Cap'n Proto bridge lifecycle failed",
      { ...context, response, decoded });
  }
  if (decoded.which !== expectedWhich) {
    throw new NativeCapnpBridgeProtocolError(
      `native Cap'n Proto bridge returned unexpected ${decoded.which} response`,
      { ...context, response, decoded });
  }

  return { response, decoded };
}

export async function createNativeCapnpBridge(api, options = {}) {
  const negotiation = await negotiateNativeCapnpBridge(api, options);
  const sendRequest = async (request, context, expectedWhich) => {
    return sendNativeCapnpBridgeEnvelope(
      api, request, { negotiation, ...context }, expectedWhich);
  };

  const requireAvailable = (operation) => {
    if (!negotiation.available) {
      throw new NativeCapnpBridgeUnavailableError(
        `native Cap'n Proto bridge is unavailable for ${operation}: ` +
            `${negotiation.reason || "unavailable"}`,
        { negotiation });
    }
  };

  return Object.freeze({
    negotiation,
    available: negotiation.available,
    protocolVersion: negotiation.protocolVersion,

    async drop({ target } = {}) {
      requireAvailable("drop");
      const request = makeNativeCapnpBridgeDropRequest({ target });
      await sendRequest(request, { targetId: target.id }, "acknowledged");
      return undefined;
    },

    async save({ target } = {}) {
      requireAvailable("save");
      const request = makeNativeCapnpBridgeSaveRequest({ target });
      const { decoded } = await sendRequest(request, { targetId: target.id }, "saved");
      return decoded.saved.token;
    },

    async restore({ token, binding } = {}) {
      requireAvailable("restore");
      const schema = binding?.schema || {};
      const request = makeNativeCapnpBridgeRestoreRequest({
        token,
        expectedInterfaceId: schema.interfaceId || binding?.interfaceId || 0n,
        expectedInterfaceName: schema.interfaceName || binding?.interfaceName || "",
      });
      const { decoded } = await sendRequest(request, { token, binding }, "capability");
      return decoded.capability;
    },
  });
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

export function registerNativeCapnpExport(InterfaceClass, target, options = {}) {
  validateNativeCapnpGeneratedInterface(InterfaceClass, "registerNativeCapnpExport()");
  if (!target || typeof target !== "object") {
    throw new TypeError("registerNativeCapnpExport() requires a server target object");
  }

  const id = nativeCapnpExportId(options);
  const existing = nativeCapnpExportTargets.get(id);
  if (existing && existing.target !== target) {
    throw new NativeCapnpBridgeProtocolError(
      `native Cap'n Proto export id is already registered: ${id}`);
  }

  const entry = Object.freeze({
    id,
    InterfaceClass,
    target,
    interfaceMetadata: nativeCapnpInterfaceMetadata(InterfaceClass, options),
    path: nativeCapnpExportSessionPath(id),
  });
  nativeCapnpExportTargets.set(id, entry);
  return entry;
}

export function unregisterNativeCapnpExport(id) {
  return nativeCapnpExportTargets.delete(id);
}

export async function serveNativeCapnpExportSession(request, options = {}) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${NATIVE_CAPNP_EXPORT_SESSION_PREFIX}/`)) {
    return null;
  }
  const id = decodeURIComponent(
    url.pathname.slice(NATIVE_CAPNP_EXPORT_SESSION_PREFIX.length + 1));
  const registry = options.registry || nativeCapnpExportTargets;
  const entry = registry.get(id);
  if (!entry) {
    return Response.json(
      { ok: false, error: "unknown native Cap'n Proto export target" },
      { status: 404 });
  }

  if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
    if (request.method !== "GET") {
      return Response.json({ ok: false, error: "method not allowed" }, { status: 405 });
    }

    const pair = new WebSocketPair();
    const server = pair[0];
    server.accept();
    createNativeCapnpExportSession(entry.InterfaceClass, entry.target, {
      webSocket: server,
      finalize: options.finalize,
    });
    return new Response(null, {
      status: 101,
      webSocket: pair[1],
    });
  }

  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "method not allowed" }, { status: 405 });
  }
  if (!request.body) {
    return Response.json(
      { ok: false, error: "native Cap'n Proto export session requires a request stream" },
      { status: 400 });
  }

  const responseStream = new TransformStream();
  createNativeCapnpExportSession(entry.InterfaceClass, entry.target, {
    readable: request.body,
    writable: responseStream.writable,
    finalize: options.finalize,
  });
  return new Response(responseStream.readable, {
    headers: { "content-type": "application/octet-stream" },
  });
}

export async function exportNativeCapnp(api, InterfaceClass, target, options = {}) {
  validateNativeCapnpGeneratedInterface(InterfaceClass, "exportNativeCapnp()");
  if (!api || typeof api.capnpBridgeInfo !== "function" ||
      typeof api.nativeCapnpExport !== "function") {
    throw new TypeError("exportNativeCapnp() requires a Sandstorm API object");
  }

  const negotiation = await negotiateNativeCapnpBridge(api, { requiredFeatures: ["nativeExports"] });
  if (!negotiation.available) {
    throw new NativeCapnpBridgeUnavailableError(
      `native Cap'n Proto exports are unavailable: ${negotiation.reason || "unavailable"}`,
      { negotiation, interfaceMetadata: nativeCapnpInterfaceMetadata(InterfaceClass, options) });
  }

  const registration = registerNativeCapnpExport(InterfaceClass, target, options);
  return await api.nativeCapnpExport(registration);
}

export async function saveNativeCapnp(api, target) {
  const request = makeNativeCapnpBridgeSaveRequest({ target });
  const { decoded } = await sendNativeCapnpBridgeEnvelope(
    api, request, { targetId: target?.id }, "saved");
  return decoded.saved.token;
}

export async function dropNativeCapnp(api, target) {
  const request = makeNativeCapnpBridgeDropRequest({ target });
  await sendNativeCapnpBridgeEnvelope(api, request, { targetId: target?.id }, "acknowledged");
  return undefined;
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

function findNativeCapnpLocalDispatchEntry(target, InterfaceClass, options = {}) {
  if (typeof InterfaceClass?.Server !== "function") {
    return null;
  }

  const localDispatch = trustedNativeCapnpLocalDispatch.get(target);
  if (!localDispatch) {
    return null;
  }

  // The hidden restore metadata is not enough by itself. Direct dispatch is
  // same-isolate only, so the export must also be registered in this module's
  // local registry. Cross-isolate exports keep using WebSocket RPC framing.
  const entry = nativeCapnpExportTargets.get(localDispatch.exportId);
  if (!entry) {
    return null;
  }

  const requested = nativeCapnpInterfaceMetadata(InterfaceClass, options);
  const exported = entry.interfaceMetadata || {};
  const requestedName = requested.interfaceName || "";
  const dispatchName = localDispatch.interfaceName || "";
  const exportedName = exported.interfaceName || "";
  if ((requestedName && dispatchName && requestedName !== dispatchName) ||
      (exportedName && dispatchName && exportedName !== dispatchName)) {
    return null;
  }

  try {
    if (!nativeCapnpInterfaceIdsEqual(requested.interfaceId, localDispatch.interfaceId) ||
        !nativeCapnpInterfaceIdsEqual(exported.interfaceId, localDispatch.interfaceId)) {
      return null;
    }
  } catch (_) {
    return null;
  }

  return entry;
}

function createNativeCapnpLocalClient(api, target, InterfaceClass, entry, options = {}) {
  const client = new InterfaceClass.Server(entry.target).client();
  if (!client || typeof client !== "object") {
    throw new NativeCapnpBridgeProtocolError(
      "capnp-es generated interface did not produce a local client object");
  }

  const transport = Object.freeze({
    kind: "localDirect",
    connectionId: normalizeNativeCapnpBridgeConnectionId(options.connectionId),
    target: normalizeNativeCapnpCapabilitySlot(target),
    close() {},
  });

  return Object.assign(client, {
    capability: target,
    connection: null,
    transport,
    drop: (...args) => typeof target.drop === "function" ?
      target.drop(...args) :
      dropNativeCapnp(api, target),
    save: (...args) => typeof target.save === "function" ?
      target.save(...args) :
      saveNativeCapnp(api, target),
  });
}

export function connectNativeCapnp(api, target, InterfaceClass, options = {}) {
  if (!InterfaceClass || typeof InterfaceClass.Client !== "function") {
    throw new TypeError("connectNativeCapnp() requires a capnp-es generated interface class");
  }

  const localEntry = findNativeCapnpLocalDispatchEntry(target, InterfaceClass, options);
  if (localEntry) {
    return createNativeCapnpLocalClient(api, target, InterfaceClass, localEntry, options);
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
    drop: (...args) => typeof target.drop === "function" ?
      target.drop(...args) :
      dropNativeCapnp(api, connection.transport.target),
    save: (...args) => typeof target.save === "function" ?
      target.save(...args) :
      saveNativeCapnp(api, connection.transport.target),
  });
}

export async function restoreNativeCapnp(api, token, InterfaceClass, options = {}) {
  return await restoreNativeCapnpViaBootstrap(api, token, InterfaceClass, options);
}
