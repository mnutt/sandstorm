import { RpcTarget } from "sandstorm:api";
import { Message as CapnpEsMessage } from "@mnutt/capnp-es";
import {
  NativeCapnpBridgeRequest,
  NativeCapnpCapabilitySlotKind,
} from "sandstorm:native-capnp-bridge";

export const SANDSTORM_CAPNP_VERSION = 0;
export const SANDSTORM_CAPNP_NATIVE_BRIDGE_PROTOCOL_VERSION = 0;

const NATIVE_CAPNP_BRIDGE_FEATURES = Object.freeze([
  "nativeTransport",
  "nativeCalls",
  "nativeExports",
  "capabilitySlots",
]);

function invalidNativeCapnpBridgeInfo(reason, info) {
  return Object.freeze({
    available: false,
    protocolSupported: false,
    protocolVersion: SANDSTORM_CAPNP_NATIVE_BRIDGE_PROTOCOL_VERSION,
    nativeTransport: false,
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

function writeNativeCapnpPayload(builder, payload) {
  const message = builder._initMessage(payload.message.byteLength);
  message.copyBuffer(payload.message);

  const capabilities = builder._initCapabilities(payload.capabilities.length);
  for (let i = 0; i < payload.capabilities.length; ++i) {
    writeNativeCapnpCapabilitySlot(capabilities.get(i), payload.capabilities[i]);
  }
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

export function readNativeCapnpBridgeRequest(message) {
  const bytes = nativeCapnpMessageBytes(message);
  return new CapnpEsMessage(bytes, false).getRoot(NativeCapnpBridgeRequest);
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

export async function createNativeCapnpBridge(api, options = {}) {
  const negotiation = await negotiateNativeCapnpBridge(api, options);
  return Object.freeze({
    negotiation,
    available: negotiation.available,
    protocolVersion: negotiation.protocolVersion,

    makePayload: makeNativeCapnpPayload,

    async call({ target, binding, methodName, params, capabilities = [] } = {}) {
      if (!negotiation.available) {
        throw new NativeCapnpBridgeUnavailableError(
          `native Cap'n Proto bridge is unavailable: ${negotiation.reason || "unavailable"}`,
          { negotiation });
      }
      if (!target || typeof target !== "object" || typeof target.id !== "string") {
        throw new NativeCapnpBridgeProtocolError(
          "native bridge call target must be a Sandstorm capability handle");
      }
      const method = methodSchemaMetadata(binding, methodName);
      const payload = makeNativeCapnpPayload(params, capabilities);
      if (typeof api.nativeCapnpBridgeCall !== "function") {
        throw new NativeCapnpBridgeProtocolError(
          "native bridge call requires api.nativeCapnpBridgeCall()");
      }
      const request = makeNativeCapnpBridgeCallRequest({ target, method, payload });
      const result = await api.nativeCapnpBridgeCall(request.message);
      if (!result || typeof result !== "object") {
        throw new NativeCapnpBridgeProtocolError("native bridge call returned an invalid response");
      }
      if (result.ok === false) {
        throw new NativeCapnpBridgeUnavailableError(
          result.exception?.reason || result.error || "native Cap'n Proto bridge call failed",
          { negotiation, targetId: target.id, method, payload, response: result });
      }
      throw new NativeCapnpBridgeProtocolError(
        "native Cap'n Proto bridge result decoding is not implemented yet",
        { negotiation, targetId: target.id, method, payload, response: result });
    },
  });
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
