import { RpcTarget } from "capnweb";
import {
  Conn as CapnpEsConn,
  DeferredTransport as CapnpEsDeferredTransport,
  Message as CapnpEsMessage,
} from "capnp-es:/capnp-es/index.mjs";
import {
  NativeCapnpBridgeRequest,
  NativeCapnpBridgeResponse,
  NativeCapnpBridgeResult,
  NativeCapnpCapabilitySlotKind,
} from "sandstorm:native-capnp-bridge";

export const SANDSTORM_CAPNP_VERSION = 0;
export const SANDSTORM_CAPNP_NATIVE_BRIDGE_PROTOCOL_VERSION = 0;

const NATIVE_CAPNP_BRIDGE_FEATURES = Object.freeze([
  "nativeTransport",
  "nativeRpc",
  "nativeCalls",
  "nativeExports",
  "capabilitySlots",
]);

const NATIVE_CAPNP_EXPORT_SESSION_PREFIX = "/__sandstorm/native-capnp/export-sessions";
const nativeCapnpExportTargets = new Map();

function invalidNativeCapnpBridgeInfo(reason, info) {
  return Object.freeze({
    available: false,
    protocolSupported: false,
    protocolVersion: SANDSTORM_CAPNP_NATIVE_BRIDGE_PROTOCOL_VERSION,
    nativeTransport: false,
    nativeRpc: false,
    nativeCalls: false,
    nativeExports: false,
    capabilitySlots: false,
    fallbackTransport: "",
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
    nativeCalls: info.nativeCalls === true,
    nativeExports: info.nativeExports === true,
    capabilitySlots: info.capabilitySlots === true,
    fallbackTransport: typeof info.fallbackTransport === "string" ? info.fallbackTransport : "",
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

function readNativeCapnpCapabilitySlot(slot) {
  return Object.freeze({
    id: slot.id,
    interfaceId: slot.interfaceId,
    interfaceName: slot.interfaceName,
    kind: nativeCapnpSlotKindName(slot.kind),
  });
}

function writeNativeCapnpPayload(builder, payload) {
  const message = builder._initMessage(payload.message.byteLength);
  message.copyBuffer(payload.message);

  const capabilities = builder._initCapabilities(payload.capabilities.length);
  for (let i = 0; i < payload.capabilities.length; ++i) {
    writeNativeCapnpCapabilitySlot(capabilities.get(i), payload.capabilities[i]);
  }
}

function readNativeCapnpPayloadValue(payload) {
  const capabilities = [];
  for (let i = 0; i < payload.capabilities.length; ++i) {
    capabilities.push(readNativeCapnpCapabilitySlot(payload.capabilities.get(i)));
  }
  return makeNativeCapnpPayload(payload.message.toUint8Array(), capabilities);
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

export function makeNativeCapnpBridgeCallRequest({ target, method, payload } = {}) {
  if (!target || typeof target !== "object" || typeof target.id !== "string") {
    throw new NativeCapnpBridgeProtocolError(
      "native bridge call target must be a Sandstorm capability handle");
  }
  if (!method || typeof method !== "object") {
    throw new NativeCapnpBridgeProtocolError("native bridge call requires method metadata");
  }

  const bridgePayload = payload || makeNativeCapnpPayload();
  const message = new CapnpEsMessage();
  const request = message.initRoot(NativeCapnpBridgeRequest);
  request.protocolVersion = SANDSTORM_CAPNP_NATIVE_BRIDGE_PROTOCOL_VERSION;

  const call = request._initCall();
  writeNativeCapnpCapabilitySlot(call._initTarget(), normalizeNativeCapnpCapabilitySlot(target));
  call.interfaceId = nativeCapnpInterfaceId(method.interfaceId);
  call.methodOrdinal = method.methodOrdinal;
  call.methodName = method.methodName;
  writeNativeCapnpPayload(call._initParams(), bridgePayload);

  return makeNativeCapnpPayload(message);
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

export function makeNativeCapnpBridgeRpcRequest({
  target,
  message,
  capabilities = [],
  connectionId,
} = {}) {
  if (!target || typeof target !== "object" || typeof target.id !== "string") {
    throw new NativeCapnpBridgeProtocolError(
      "native bridge RPC request target must be a Sandstorm capability handle");
  }
  if (!message) {
    throw new NativeCapnpBridgeProtocolError("native bridge RPC request requires a message");
  }

  const bridgePayload =
      makeNativeCapnpPayload(nativeCapnpRootMessageBytes(message), capabilities);
  const envelope = new CapnpEsMessage();
  const request = envelope.initRoot(NativeCapnpBridgeRequest);
  request.protocolVersion = SANDSTORM_CAPNP_NATIVE_BRIDGE_PROTOCOL_VERSION;

  const rpc = request._initRpc();
  writeNativeCapnpCapabilitySlot(rpc._initTarget(), normalizeNativeCapnpCapabilitySlot(target));
  writeNativeCapnpPayload(rpc._initMessage(), bridgePayload);
  rpc.connectionId = normalizeNativeCapnpBridgeConnectionId(connectionId);

  return makeNativeCapnpPayload(envelope);
}

export function readNativeCapnpBridgeRequest(message) {
  const bytes = nativeCapnpMessageBytes(message);
  return new CapnpEsMessage(bytes, false).getRoot(NativeCapnpBridgeRequest);
}

export function makeNativeCapnpBridgeResultResponse({ payload } = {}) {
  const bridgePayload = payload || makeNativeCapnpPayload();
  const message = new CapnpEsMessage();
  const response = message.initRoot(NativeCapnpBridgeResponse);
  response.protocolVersion = SANDSTORM_CAPNP_NATIVE_BRIDGE_PROTOCOL_VERSION;
  writeNativeCapnpPayload(response._initResult()._initValue(), bridgePayload);
  return makeNativeCapnpPayload(message);
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

export function decodeNativeCapnpBridgeResponse(message) {
  const response = readNativeCapnpBridgeResponse(message);
  if (response.protocolVersion !== SANDSTORM_CAPNP_NATIVE_BRIDGE_PROTOCOL_VERSION) {
    throw new NativeCapnpBridgeProtocolError(
      `unsupported native Cap'n Proto bridge response protocol version: ${response.protocolVersion}`);
  }

  switch (response.which()) {
    case NativeCapnpBridgeResponse.RESULT: {
      const result = response.result;
      switch (result.which()) {
        case NativeCapnpBridgeResult.VALUE:
          return Object.freeze({
            protocolVersion: response.protocolVersion,
            which: "result",
            result: Object.freeze({
              which: "value",
              value: readNativeCapnpPayloadValue(result.value),
            }),
          });
        case NativeCapnpBridgeResult.EXCEPTION:
          return Object.freeze({
            protocolVersion: response.protocolVersion,
            which: "result",
            result: Object.freeze({
              which: "exception",
              exception: readNativeCapnpBridgeExceptionValue(result.exception),
            }),
          });
        case NativeCapnpBridgeResult.CANCELED:
          return Object.freeze({
            protocolVersion: response.protocolVersion,
            which: "result",
            result: Object.freeze({ which: "canceled" }),
          });
        default:
          throw new NativeCapnpBridgeProtocolError(
            `unknown native Cap'n Proto bridge result discriminant: ${result.which()}`);
      }
    }
    case NativeCapnpBridgeResponse.CAPABILITY:
      return Object.freeze({
        protocolVersion: response.protocolVersion,
        which: "capability",
        capability: readNativeCapnpCapabilitySlot(response.capability),
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

function methodSchemaMetadata(binding, methodName) {
  const schema = binding?.schema;
  if (!schema || typeof schema !== "object") {
    throw new NativeCapnpBridgeProtocolError("native bridge call requires generated schema metadata");
  }
  const methodOrdinal = schema.methodIds?.[methodName];
  if (!Number.isInteger(methodOrdinal)) {
    throw new NativeCapnpBridgeProtocolError(
      `native bridge call requires a method ordinal for ${binding.interfaceName}.${methodName}`);
  }
  return {
    interfaceId: schema.interfaceId || binding.interfaceId || "",
    interfaceName: schema.interfaceName || binding.interfaceName || "",
    methodOrdinal,
    methodName,
  };
}

function nativeCapnpInterfaceMetadata(InterfaceClass, options = {}) {
  const schema = options.schema || options.binding?.schema ||
      InterfaceClass?.schema || InterfaceClass?.Client?.schema ||
      InterfaceClass?._capnp || InterfaceClass?.Client?._capnp || {};
  return Object.freeze({
    interfaceId: options.interfaceId ?? schema.interfaceId ??
        InterfaceClass?.interfaceId ?? InterfaceClass?.Client?.interfaceId ?? 0n,
    interfaceName: options.interfaceName ?? schema.interfaceName ??
        InterfaceClass?.interfaceName ?? InterfaceClass?.Client?.interfaceName ?? "",
  });
}

async function sendNativeCapnpBridgeEnvelope(api, request, context, expectedWhich) {
  if (!api || typeof api.nativeCapnpBridgeCallBytes !== "function") {
    throw new NativeCapnpBridgeProtocolError(
      "native bridge call requires api.nativeCapnpBridgeCallBytes()");
  }

  const response = await api.nativeCapnpBridgeCallBytes(request.message);
  if (!response || typeof response !== "object" || !(response.body instanceof Uint8Array)) {
    throw new NativeCapnpBridgeProtocolError("native bridge call returned an invalid response");
  }

  const decoded = decodeNativeCapnpBridgeResponse(response.body);
  if (decoded.which === "exception") {
    throw new NativeCapnpBridgeUnavailableError(
      decoded.exception.reason || "native Cap'n Proto bridge call failed",
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

    makePayload: makeNativeCapnpPayload,

    async call({ target, binding, methodName, params, capabilities = [] } = {}) {
      requireAvailable("call");
      if (!target || typeof target !== "object" || typeof target.id !== "string") {
        throw new NativeCapnpBridgeProtocolError(
          "native bridge call target must be a Sandstorm capability handle");
      }
      const method = methodSchemaMetadata(binding, methodName);
      const payload = makeNativeCapnpPayload(params, capabilities);
      const request = makeNativeCapnpBridgeCallRequest({ target, method, payload });
      const { response, decoded } =
          await sendRequest(request, { targetId: target.id, method, payload }, "result");

      switch (decoded.result.which) {
        case "value":
          return decoded.result.value;
        case "exception":
          throw new NativeCapnpBridgeUnavailableError(
            decoded.result.exception.reason || "native Cap'n Proto bridge call failed",
            { negotiation, targetId: target.id, method, payload, response, decoded });
        case "canceled":
          throw new NativeCapnpBridgeUnavailableError(
            "native Cap'n Proto bridge call was canceled",
            { negotiation, targetId: target.id, method, payload, response, decoded });
        default:
          throw new NativeCapnpBridgeProtocolError(
            "native Cap'n Proto bridge returned an unknown result response",
            { negotiation, targetId: target.id, method, payload, response, decoded });
      }
    },

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

export class NativeCapnpBridgeTransport extends CapnpEsDeferredTransport {
  #sendQueue = Promise.resolve();

  constructor(api, target, options = {}) {
    super();
    if (!api || typeof api.nativeCapnpBridgeCallBytes !== "function") {
      throw new NativeCapnpBridgeProtocolError(
        "NativeCapnpBridgeTransport requires api.nativeCapnpBridgeCallBytes()");
    }
    if (!target || typeof target !== "object" || typeof target.id !== "string") {
      throw new NativeCapnpBridgeProtocolError(
        "NativeCapnpBridgeTransport requires a Sandstorm capability target");
    }

    this.api = api;
    this.target = normalizeNativeCapnpCapabilitySlot(target);
    this.connectionId = normalizeNativeCapnpBridgeConnectionId(options.connectionId);
    this.capabilities = Object.freeze([...(options.capabilities || [])]);
    this.connection = null;
  }

  sendMessage(message) {
    if (this.closed) {
      throw new NativeCapnpBridgeUnavailableError("native Cap'n Proto transport is closed", {
        target: this.target,
      });
    }

    this.#sendQueue = this.#sendQueue
      .then(() => this.#sendMessage(message))
      .catch((error) => this.abort(error));
  }

  abort(error) {
    if (this.connection && !this.connection.closed) {
      this.connection.shutdown(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    this.close(error);
  }

  async #sendMessage(message) {
    const request = makeNativeCapnpBridgeRpcRequest({
      target: this.target,
      message,
      capabilities: this.capabilities,
      connectionId: this.connectionId,
    });
    const response = await this.api.nativeCapnpBridgeCallBytes(request.message);
    if (!response || typeof response !== "object" || !(response.body instanceof Uint8Array)) {
      throw new NativeCapnpBridgeProtocolError(
        "native Cap'n Proto transport returned an invalid response",
        { target: this.target, response });
    }

    const decoded = decodeNativeCapnpBridgeResponse(response.body);
    if (decoded.which === "exception") {
      throw nativeCapnpBridgeExceptionError(
        decoded.exception.reason || "native Cap'n Proto transport failed",
        { target: this.target, response, decoded });
    }
    if (decoded.which !== "result") {
      throw new NativeCapnpBridgeProtocolError(
        `native Cap'n Proto transport returned unexpected ${decoded.which} response`,
        { target: this.target, response, decoded });
    }

    switch (decoded.result.which) {
      case "value":
        if (decoded.result.value.message.byteLength > 0) {
          this.resolve(decoded.result.value.message);
        }
        return;
      case "exception":
        throw nativeCapnpBridgeExceptionError(
          decoded.result.exception.reason || "native Cap'n Proto transport call failed",
          { target: this.target, response, decoded });
      case "canceled":
        throw nativeCapnpBridgeExceptionError(
          "native Cap'n Proto transport call was canceled",
          { target: this.target, response, decoded });
      default:
        throw new NativeCapnpBridgeProtocolError(
          "native Cap'n Proto transport returned an unknown result response",
          { target: this.target, response, decoded });
    }
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
  const transport = new NativeCapnpBridgeTransport(api, target, options);
  const conn = new CapnpEsConn(transport, options.finalize);
  transport.connection = conn;
  return Object.assign(conn, { transport });
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
    drop: (...args) => typeof target.drop === "function" ?
      target.drop(...args) :
      dropNativeCapnp(api, connection.transport.target),
    save: (...args) => typeof target.save === "function" ?
      target.save(...args) :
      saveNativeCapnp(api, connection.transport.target),
  });
}

export async function restoreNativeCapnp(api, token, InterfaceClass, options = {}) {
  if (!InterfaceClass || typeof InterfaceClass.Client !== "function") {
    throw new TypeError("restoreNativeCapnp() requires a capnp-es generated interface class");
  }

  const negotiation = await negotiateNativeCapnpBridge(api, { requiredFeatures: ["nativeRpc"] });
  if (!negotiation.available) {
    throw new NativeCapnpBridgeUnavailableError(
      `native Cap'n Proto RPC transport is unavailable for restore: ` +
          `${negotiation.reason || "unavailable"}`,
      { negotiation });
  }

  const interfaceMetadata = nativeCapnpInterfaceMetadata(InterfaceClass, options);
  const request = makeNativeCapnpBridgeRestoreRequest({
    token,
    expectedInterfaceId: interfaceMetadata.interfaceId,
    expectedInterfaceName: interfaceMetadata.interfaceName,
  });
  const { decoded } = await sendNativeCapnpBridgeEnvelope(
    api, request, { negotiation, token, interfaceMetadata }, "capability");

  return connectNativeCapnp(api, decoded.capability, InterfaceClass, options);
}

const bindingError = (interfaceName, operation) => new Error(
  `capnp:${interfaceName}.${operation} is not implemented yet for this schema binding.`
);

function requiredMethods(interfaceName, methods) {
  if (!methods || typeof methods !== "object") {
    throw new TypeError(`${interfaceName}.implement() requires a methods object`);
  }
  return methods;
}

function makeServerTarget(interfaceName, methodNames, methods) {
  const source = requiredMethods(interfaceName, methods);
  const target = new RpcTarget();
  for (const methodName of methodNames) {
    target[methodName] = async (...args) => {
      const method = source[methodName];
      if (typeof method !== "function") {
        throw new TypeError(`${interfaceName}.${methodName} is not implemented`);
      }
      return await method.apply(source, args);
    };
  }
  return target;
}

function resolveResultBinding(interfaceName, methodName, caster) {
  const binding = typeof caster === "function" ? caster() : caster;
  if (!binding || typeof binding !== "object" || typeof binding.cast !== "function") {
    throw new TypeError(
      `${interfaceName}.${methodName} result capability caster must be a capnp interface binding`);
  }
  return binding;
}

function isNativeCapabilitySpec(caster) {
  return caster && typeof caster === "object" &&
    typeof caster.cast !== "function" &&
    typeof caster.nativeInterface === "string";
}

function nativeCapabilityValue(interfaceName, methodName, value, caster) {
  if (!value || typeof value !== "object" || typeof value.fetch !== "function") {
    throw new TypeError(
      `${interfaceName}.${methodName} result capability must be a Sandstorm ` +
      `${caster.nativeInterface} capability`);
  }
  return value;
}

function castCapabilityValue(interfaceName, methodName, caster, value, localMode) {
  if (isNativeCapabilitySpec(caster)) {
    return nativeCapabilityValue(interfaceName, methodName, value, caster);
  }

  const binding = resolveResultBinding(interfaceName, methodName, caster);
  if (value && typeof value === "object" && value.rpc) {
    return binding.cast(value);
  } else if (localMode) {
    return binding.local(value);
  } else {
    return binding.cast(value);
  }
}

function normalizeCapabilityPath(path) {
  const parts = typeof path === "string" ? path.split(".") : path;
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new TypeError("capnp capability path must be a non-empty string or array");
  }
  return parts.map((part) => {
    if (typeof part !== "string" && typeof part !== "number") {
      throw new TypeError("capnp capability path segments must be strings or numbers");
    }
    return part;
  });
}

function isCapabilityLikeValue(value) {
  return value && typeof value === "object" &&
    (value.rpc || value.call || value.capability);
}

function mapCapabilityPathValue(value, path, mapper) {
  if (path.length === 0) {
    return mapper(value);
  }
  if (!value || typeof value !== "object" || isCapabilityLikeValue(value)) {
    return value;
  }

  const [field, ...rest] = path;
  if (!Object.prototype.hasOwnProperty.call(value, field)) {
    return value;
  }

  const nextFieldValue = mapCapabilityPathValue(value[field], rest, mapper);
  if (nextFieldValue === value[field]) {
    return value;
  }

  const nextValue = Array.isArray(value) ? [...value] : { ...value };
  nextValue[field] = nextFieldValue;
  return nextValue;
}

async function mapCapabilityPathValueAsync(value, path, mapper) {
  if (path.length === 0) {
    return await mapper(value);
  }
  if (!value || typeof value !== "object" || isCapabilityLikeValue(value)) {
    return value;
  }

  const [field, ...rest] = path;
  if (!Object.prototype.hasOwnProperty.call(value, field)) {
    return value;
  }

  const nextFieldValue = await mapCapabilityPathValueAsync(value[field], rest, mapper);
  if (nextFieldValue === value[field]) {
    return value;
  }

  const nextValue = Array.isArray(value) ? [...value] : { ...value };
  nextValue[field] = nextFieldValue;
  return nextValue;
}

function resultPathEntries(spec) {
  if (!spec || typeof spec !== "object") return [];
  const entries = [];
  const fields = spec.fields;
  if (Array.isArray(spec.fields)) {
    for (const [field, caster] of fields) {
      entries.push([normalizeCapabilityPath([field]), caster]);
    }
  } else if (fields && typeof fields === "object") {
    for (const [field, caster] of Object.entries(fields)) {
      entries.push([normalizeCapabilityPath([field]), caster]);
    }
  }

  const paths = spec.paths;
  if (Array.isArray(paths)) {
    for (const [path, caster] of paths) {
      entries.push([normalizeCapabilityPath(path), caster]);
    }
  } else if (paths && typeof paths === "object") {
    for (const [path, caster] of Object.entries(paths)) {
      entries.push([normalizeCapabilityPath(path), caster]);
    }
  }

  return entries;
}

async function castResult(interfaceName, methodName, result, resultCapabilities, localMode) {
  const spec = resultCapabilities[methodName];
  if (!spec) return result;

  if (typeof spec === "function" || typeof spec.cast === "function") {
    return castCapabilityValue(interfaceName, methodName, spec, result, localMode);
  }

  if (isNativeCapabilitySpec(spec)) {
    return nativeCapabilityValue(interfaceName, methodName, result, spec);
  }

  const paths = resultPathEntries(spec);
  if (paths.length === 0 || !result || typeof result !== "object") {
    return result;
  }

  let casted = result;
  for (const [path, caster] of paths) {
    casted = mapCapabilityPathValue(casted, path, (value) => castCapabilityValue(
      interfaceName, methodName, caster, value, localMode));
  }
  return casted;
}

function unwrapCapabilityArgument(value) {
  if (value && typeof value === "object" && value.capability) {
    return value.capability;
  }
  return value;
}

function declaredNativeInterface(spec) {
  if (!spec) return undefined;
  if (isNativeCapabilitySpec(spec)) return spec.nativeInterface;
  if (typeof spec === "function" || typeof spec.cast === "function") return "appObject";
  return undefined;
}

async function validateCapabilityArgument(interfaceName, methodName, value, spec) {
  const expected = declaredNativeInterface(spec);
  if (!expected) return;

  const capability = value?.capability || value;
  if (!capability || typeof capability !== "object" || typeof capability.info !== "function") {
    return;
  }

  const info = await capability.info();
  const actual = info?.nativeInterface || "unknown";
  if (actual !== expected) {
    throw new TypeError(
      `${interfaceName}.${methodName} argument capability nativeInterface ` +
      `${actual} does not match declared ${expected}`);
  }

  if (isNativeCapabilitySpec(spec) && spec.fetch && typeof capability.fetch !== "function") {
    throw new TypeError(
      `${interfaceName}.${methodName} argument capability must be fetch-shaped`);
  }
}

async function normalizeObjectCapabilityPaths(interfaceName, methodName, value, entries) {
  if (!value || typeof value !== "object" || value.rpc || value.call || value.capability) {
    return value;
  }

  let normalized = value;
  for (const [path, spec] of entries) {
    normalized = await mapCapabilityPathValueAsync(normalized, path, async (pathValue) => {
      await validateCapabilityArgument(interfaceName, methodName, pathValue, spec);
      return unwrapCapabilityArgument(pathValue);
    });
  }
  return normalized;
}

function argumentCapabilityPathEntries(spec) {
  const entries = [];
  const fields = spec.fields || [];
  if (Array.isArray(fields)) {
    for (const field of fields) {
      entries.push([normalizeCapabilityPath([field]), undefined]);
    }
  } else if (fields && typeof fields === "object") {
    for (const [field, fieldSpec] of Object.entries(fields)) {
      entries.push([normalizeCapabilityPath([field]), fieldSpec]);
    }
  }

  const paths = spec.paths || [];
  if (Array.isArray(paths)) {
    for (const pathEntry of paths) {
      if (Array.isArray(pathEntry) && pathEntry.length === 2 &&
          (Array.isArray(pathEntry[0]) || typeof pathEntry[0] === "string") &&
          (typeof pathEntry[1] === "function" || isNativeCapabilitySpec(pathEntry[1]) ||
           (pathEntry[1] && typeof pathEntry[1] === "object" &&
            typeof pathEntry[1].cast === "function"))) {
        entries.push([normalizeCapabilityPath(pathEntry[0]), pathEntry[1]]);
      } else {
        entries.push([normalizeCapabilityPath(pathEntry), undefined]);
      }
    }
  } else if (paths && typeof paths === "object") {
    for (const [path, pathSpec] of Object.entries(paths)) {
      entries.push([normalizeCapabilityPath(path), pathSpec]);
    }
  }
  return entries;
}

async function normalizeArgs(interfaceName, methodName, args, argumentCapabilities) {
  const spec = argumentCapabilities[methodName];
  if (!spec) return args;

  let normalized = args;
  const indexes = spec.indexes || spec.indices || [];
  for (const index of indexes) {
    if (Number.isInteger(index) && index >= 0 && index < args.length) {
      const nextValue = unwrapCapabilityArgument(args[index]);
      if (nextValue !== args[index]) {
        if (normalized === args) {
          normalized = [...args];
        }
        normalized[index] = nextValue;
      }
    }
  }

  const paths = argumentCapabilityPathEntries(spec);
  if (paths.length > 0 && args.length === 1) {
    const nextValue = await normalizeObjectCapabilityPaths(
      interfaceName, methodName, normalized[0], paths);
    if (nextValue !== normalized[0]) {
      if (normalized === args) {
        normalized = [...args];
      }
      normalized[0] = nextValue;
    }
  }

  return normalized;
}

function makeClient(
    interfaceName, methodNames, argumentCapabilities, resultCapabilities, caller, options = {}) {
  const client = { ...(options.extras || {}) };
  const localMode = Boolean(options.local);
  for (const methodName of methodNames) {
    client[methodName] = async (...args) => {
      const normalizedArgs = await normalizeArgs(
        interfaceName, methodName, args, argumentCapabilities);
      const result = await caller(methodName, normalizedArgs);
      return await castResult(interfaceName, methodName, result, resultCapabilities, localMode);
    };
  }
  return Object.freeze(client);
}

export function makeCapnpInterfaceBinding(interfaceName, methodNames, schema = {}) {
  const frozenMethodNames = Object.freeze([...methodNames]);
  const argumentCapabilities = Object.freeze({ ...(schema.argumentCapabilities || {}) });
  const resultCapabilities = Object.freeze({ ...(schema.resultCapabilities || {}) });
  const methodIds = Object.freeze({ ...(schema.methodIds || {}) });
  const paramStructIds = Object.freeze({ ...(schema.paramStructIds || {}) });
  const resultStructIds = Object.freeze({ ...(schema.resultStructIds || {}) });
  const schemaMetadata = Object.freeze({
    importSpecifier: schema.importSpecifier || "",
    interfaceName,
    interfaceId: schema.interfaceId || "",
    schemaPath: schema.schemaPath || "",
    schemaText: schema.schemaText || "",
    methodNames: frozenMethodNames,
    methodIds,
    paramStructIds,
    resultStructIds,
    argumentCapabilities,
    resultCapabilities,
  });
  return Object.freeze({
    interfaceName,
    interfaceId: schemaMetadata.interfaceId,
    schemaPath: schemaMetadata.schemaPath,
    schema: schemaMetadata,
    methodNames: frozenMethodNames,
    implement(methods) {
      return makeServerTarget(interfaceName, frozenMethodNames, methods);
    },
    cast(capability) {
      if (!capability || typeof capability !== "object" || !capability.rpc) {
        throw new TypeError(`${interfaceName}.cast() requires a Sandstorm capability`);
      }
      return makeClient(
        interfaceName,
        frozenMethodNames,
        argumentCapabilities,
        resultCapabilities,
        (methodName, args) => capability.rpc[methodName](...args),
        {
          extras: {
            capability,
            drop: () => capability.drop(),
            save: (...args) => capability.save(...args),
          },
        });
    },
    local(methods) {
      const source = requiredMethods(interfaceName, methods);
      return makeClient(
        interfaceName,
        frozenMethodNames,
        argumentCapabilities,
        resultCapabilities,
        async (methodName, args) => {
          const method = source[methodName];
          if (typeof method !== "function") {
            throw new TypeError(`${interfaceName}.${methodName} is not implemented`);
          }
          return await method.apply(source, args);
        },
        { local: true });
    },
    powerboxDescriptor() {
      throw bindingError(interfaceName, "powerboxDescriptor");
    },
  });
}
