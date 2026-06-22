import { RpcTarget, newWorkersRpcResponse } from "capnweb";
import {
  SANDSTORM_CAPNWEB_VERSION,
  SANDSTORM_RPC_VERSION,
  browserClientScript,
} from "sandstorm:rpc";

export { RpcTarget } from "capnweb";
export { SANDSTORM_CAPNWEB_VERSION, SANDSTORM_RPC_VERSION } from "sandstorm:rpc";

export const SANDSTORM_API_VERSION = 0;
export const SANDSTORM_HELPER_VERSIONS = Object.freeze({
  api: SANDSTORM_API_VERSION,
  rpc: SANDSTORM_RPC_VERSION,
  capnweb: SANDSTORM_CAPNWEB_VERSION,
});

const OBJECT_CAPABILITY_PREFIX = "/__sandstorm/object-capabilities";
const POWERBOX_DESCRIPTOR_PREFIX = "/__sandstorm/powerbox";
const POWERBOX_GRANTS_PREFIX = "/__sandstorm/powerbox-grants";
const POWERBOX_FULFILLMENT_PREFIX = "/__sandstorm/powerbox-fulfillment";
const exportedObjectTargets = new Map();
const exportedObjectCapabilityIds = new Map();
const objectCapabilityIds = new Map();
const capabilityMetadata = new Map();

function header(request, name) {
  return request.headers.get(name) || "";
}

function list(value) {
  return value ? value.split(",").filter((item) => item.length > 0) : [];
}

function jsonHeader(request, name) {
  const value = header(request, name);
  if (!value) {
    return undefined;
  }
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    return JSON.parse(atob(padded));
  } catch (error) {
    throw new ValidationError(`${name} contained invalid JSON`);
  }
}

async function callSandstorm(env, path) {
  const response = await env.SANDSTORM_API.fetch(`http://sandstorm/${path}`);
  if (!response.ok) {
    throw new Error(`Sandstorm API ${path} failed with ${response.status}`);
  }
  return response.json();
}

async function parseApiResponseBody(response) {
  const text = await response.text();
  if (text.length === 0) {
    return { ok: response.ok };
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      error: text,
    };
  }
}

async function postSandstorm(env, path) {
  const response = await env.SANDSTORM_API.fetch(`http://sandstorm/${path}`, {
    method: "POST",
  });
  const body = await parseApiResponseBody(response);
  if (!response.ok || !body.ok) {
    throw new Error(body.error || `Sandstorm API ${path} failed with ${response.status}`);
  }
  return body;
}

async function queryCapabilityInfo(env, id) {
  const response = await env.SANDSTORM_API.fetch(
    `http://sandstorm/capabilities/claimed?id=${encodeURIComponent(id)}`);
  const body = await parseApiResponseBody(response);
  if (!response.ok || !body.ok) {
    return null;
  }
  body.type = "capabilityInfo";
  const metadata = capabilityMetadata.get(id) || {};
  capabilityMetadata.set(id, { ...metadata, ...body });
  return body;
}

async function capabilityInfo(env, capability, options = {}) {
  const id = capabilityId(capability);
  if (!options.refresh) {
    const cached = capabilityMetadata.get(id);
    if (cached?.type === "capabilityInfo") {
      return cached;
    }
  }
  return queryCapabilityInfo(env, id);
}

function powerboxFetcher(env) {
  return env.POWERBOX || env.SANDSTORM_API;
}

async function callPowerbox(env, path) {
  const response = await powerboxFetcher(env).fetch(`http://sandstorm/${path}`);
  const body = await parseApiResponseBody(response);
  if (!response.ok || !body.ok) {
    throw new Error(body.error || `Powerbox API ${path} failed with ${response.status}`);
  }
  return body;
}

async function callSandstormApi(env, path) {
  const response = await env.SANDSTORM_API.fetch(`http://sandstorm/${path}`);
  const body = await parseApiResponseBody(response);
  if (!response.ok || !body.ok) {
    throw new Error(body.error || `Sandstorm API ${path} failed with ${response.status}`);
  }
  return body;
}

async function postPowerbox(env, path) {
  const response = await powerboxFetcher(env).fetch(`http://sandstorm/${path}`, {
    method: "POST",
  });
  const body = await parseApiResponseBody(response);
  if (!response.ok || !body.ok) {
    throw new Error(body.error || `Powerbox API ${path} failed with ${response.status}`);
  }
  return body;
}

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

export class UnsupportedCapabilityError extends Error {
  constructor(capability, operation, message = undefined) {
    super(message || `${capability}.${operation}() is not implemented by isolate grains yet`);
    this.name = "UnsupportedCapabilityError";
    this.capability = capability;
    this.operation = operation;
  }
}

export class CapabilityCallError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "CapabilityCallError";
    this.details = details;
  }
}

export class DisconnectedCapabilityError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "DisconnectedCapabilityError";
    this.details = details;
  }
}

function failValidation(name, expected, value) {
  const actual = Object.prototype.toString.call(value);
  throw new ValidationError(`${name} must be ${expected}; got ${actual}`);
}

export const validate = {
  string(value, name = "value", options = {}) {
    if (typeof value !== "string") {
      failValidation(name, "a string", value);
    }
    if (options.minLength !== undefined && value.length < options.minLength) {
      throw new ValidationError(`${name} must be at least ${options.minLength} characters`);
    }
    if (options.maxLength !== undefined && value.length > options.maxLength) {
      throw new ValidationError(`${name} must be at most ${options.maxLength} characters`);
    }
    return value;
  },

  number(value, name = "value", options = {}) {
    const result = options.coerce ? Number(value) : value;
    if (typeof result !== "number" || !Number.isFinite(result)) {
      failValidation(name, "a finite number", value);
    }
    if (options.min !== undefined && result < options.min) {
      throw new ValidationError(`${name} must be at least ${options.min}`);
    }
    if (options.max !== undefined && result > options.max) {
      throw new ValidationError(`${name} must be at most ${options.max}`);
    }
    return result;
  },

  integer(value, name = "value", options = {}) {
    const result = this.number(value, name, options);
    if (!Number.isInteger(result)) {
      throw new ValidationError(`${name} must be an integer`);
    }
    return result;
  },

  optional(value, fallback, validator, name = "value", options = {}) {
    return value === undefined || value === null ? fallback :
      validator.call(this, value, name, options);
  },

  storageKey(value, name = "key") {
    const key = this.string(value, name, { minLength: 1, maxLength: 128 });
    if (key.startsWith(".") || key.includes("/") || key.includes("..")) {
      throw new ValidationError(`${name} is not a valid storage key`);
    }
    return key;
  },
};

function isPlainObject(value) {
  if (!value || typeof value !== "object") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.slice(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value, name = "data") {
  const text = validate.string(value, name, { minLength: 0 });
  if (!/^[A-Za-z0-9_-]*$/.test(text)) {
    throw new ValidationError(`${name} must be base64url text`);
  }

  const normalized = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; ++i) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function nativeCapabilitySlot(id, options = {}) {
  const slot = {
    type: "nativeCapabilitySlot",
    id: validate.string(id, "native capability slot id", { minLength: 1, maxLength: 256 }),
  };
  if (options.nativeInterface !== undefined && options.nativeInterface !== null) {
    slot.nativeInterface = validate.string(
      options.nativeInterface, "native capability slot nativeInterface", { minLength: 1 });
  }
  return Object.freeze(slot);
}

function nativeAppRpcObjectFieldName(value, name = "field name") {
  const fieldName = validate.string(value, name, { maxLength: 1024 });
  if (fieldName === "__proto__" || fieldName === "constructor" || fieldName === "prototype") {
    throw new ValidationError(`${name} is reserved`);
  }
  return fieldName;
}

function nativeAppRpcSerializationContext(options = "value", defaultName = "value") {
  if (typeof options === "string") {
    return { name: options };
  }
  if (options === undefined || options === null) {
    return { name: defaultName };
  }
  if (!isPlainObject(options)) {
    failValidation("native app RPC serialization options", "an object", options);
  }
  const context = {
    name: options.name === undefined
      ? defaultName
      : validate.string(options.name, "native app RPC serialization options name"),
    exportReturnedRpcTargets: options.exportReturnedRpcTargets === true,
  };
  if (options.exportCapabilitySlot !== undefined && options.exportCapabilitySlot !== null) {
    if (typeof options.exportCapabilitySlot !== "function") {
      failValidation(
        "native app RPC serialization options exportCapabilitySlot", "a function",
        options.exportCapabilitySlot);
    }
    context.exportCapabilitySlot = options.exportCapabilitySlot;
  }
  return context;
}

function nativeAppRpcSerializationChild(context, name) {
  return {
    name,
    exportCapabilitySlot: context.exportCapabilitySlot,
    exportReturnedRpcTargets: context.exportReturnedRpcTargets === true,
  };
}

function validateNativeCapabilitySlotEnvelope(value, name) {
  const slot = {
    id: validate.string(value.id, `${name}.id`, { minLength: 1, maxLength: 256 }),
  };
  if (value.nativeInterface !== undefined && value.nativeInterface !== null) {
    slot.nativeInterface = validate.string(
      value.nativeInterface, `${name}.nativeInterface`, { minLength: 1 });
  }
  return { type: "capability", value: slot };
}

export function serializeNativeAppRpcValue(value, options = "value") {
  const context = nativeAppRpcSerializationContext(options);
  const name = context.name;
  if (value === null || value === undefined) {
    return { type: "null" };
  }
  if (typeof value === "boolean") {
    return { type: "bool", value };
  }
  if (typeof value === "number") {
    return { type: "number", value: validate.number(value, name) };
  }
  if (typeof value === "string") {
    return { type: "text", value };
  }
  if (value instanceof ArrayBuffer) {
    return { type: "data", value: bytesToBase64Url(new Uint8Array(value)) };
  }
  if (ArrayBuffer.isView(value)) {
    return {
      type: "data",
      value: bytesToBase64Url(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
    };
  }
  if (Array.isArray(value)) {
    return {
      type: "list",
      value: value.map((item, index) =>
        serializeNativeAppRpcValue(item, nativeAppRpcSerializationChild(context, `${name}[${index}]`))),
    };
  }
  if (value && typeof value === "object" && value.type === "nativeCapabilitySlot") {
    return validateNativeCapabilitySlotEnvelope(value, name);
  }
  if (value instanceof RpcTarget || value instanceof Capability) {
    throw new ValidationError(
      `${name} must be explicitly exported with api.export() before native app RPC serialization`);
  }
  if (!isPlainObject(value)) {
    failValidation(name, "a native app RPC value", value);
  }

  const fields = [];
  for (const [key, item] of Object.entries(value)) {
    const fieldName = nativeAppRpcObjectFieldName(key, `${name} field name`);
    fields.push({
      name: fieldName,
      value: serializeNativeAppRpcValue(
        item, nativeAppRpcSerializationChild(context, `${name}.${fieldName}`)),
    });
  }
  return { type: "object", value: fields };
}

export async function serializeNativeAppRpcValueAsync(value, options = "value") {
  const context = nativeAppRpcSerializationContext(options);
  const name = context.name;
  if (value instanceof RpcTarget) {
    if (!context.exportReturnedRpcTargets || !context.exportCapabilitySlot) {
      throw new ValidationError(
        `${name} must be explicitly exported with api.export() before native app RPC serialization`);
    }
    const slot = await context.exportCapabilitySlot(value, { name });
    return validateNativeCapabilitySlotEnvelope(
      nativeCapabilitySlot(slot?.id, { nativeInterface: slot?.nativeInterface }), name);
  }
  if (value instanceof Capability) {
    if (!context.exportCapabilitySlot) {
      throw new ValidationError(
        `${name} must be exported to a native capability slot before native app RPC serialization`);
    }
    const slot = await context.exportCapabilitySlot(value, { name });
    return validateNativeCapabilitySlotEnvelope(
      nativeCapabilitySlot(slot?.id, { nativeInterface: slot?.nativeInterface }), name);
  }
  if (Array.isArray(value)) {
    return {
      type: "list",
      value: await Promise.all(value.map((item, index) =>
        serializeNativeAppRpcValueAsync(
          item, nativeAppRpcSerializationChild(context, `${name}[${index}]`)))),
    };
  }
  if (value && typeof value === "object" &&
      value.type !== "nativeCapabilitySlot" &&
      !(value instanceof ArrayBuffer) &&
      !ArrayBuffer.isView(value)) {
    if (!isPlainObject(value)) {
      return serializeNativeAppRpcValue(value, context);
    }

    const fields = [];
    for (const [key, item] of Object.entries(value)) {
      const fieldName = nativeAppRpcObjectFieldName(key, `${name} field name`);
      fields.push({
        name: fieldName,
        value: await serializeNativeAppRpcValueAsync(
          item, nativeAppRpcSerializationChild(context, `${name}.${fieldName}`)),
      });
    }
    return { type: "object", value: fields };
  }
  return serializeNativeAppRpcValue(value, context);
}

function nativeAppRpcHydrationContext(options = "value", defaultName = "value") {
  if (typeof options === "string") {
    return { name: options };
  }
  if (options === undefined || options === null) {
    return { name: defaultName };
  }
  if (!isPlainObject(options)) {
    failValidation("native app RPC hydration options", "an object", options);
  }
  const context = {
    name: options.name === undefined
      ? defaultName
      : validate.string(options.name, "native app RPC hydration options name"),
  };
  if (options.resolveCapabilitySlot !== undefined && options.resolveCapabilitySlot !== null) {
    if (typeof options.resolveCapabilitySlot !== "function") {
      failValidation(
        "native app RPC hydration options resolveCapabilitySlot", "a function",
        options.resolveCapabilitySlot);
    }
    context.resolveCapabilitySlot = options.resolveCapabilitySlot;
  }
  return context;
}

function nativeAppRpcHydrationChild(context, name) {
  return {
    name,
    resolveCapabilitySlot: context.resolveCapabilitySlot,
  };
}

export function hydrateNativeAppRpcValue(value, options = "value") {
  const context = nativeAppRpcHydrationContext(options);
  const name = context.name;
  if (!value || typeof value !== "object" || typeof value.type !== "string") {
    throw new ValidationError(`${name} must be a native app RPC value envelope`);
  }

  switch (value.type) {
    case "null":
      return null;
    case "bool":
      if (typeof value.value !== "boolean") {
        failValidation(`${name}.value`, "a boolean", value.value);
      }
      return value.value;
    case "number":
      return validate.number(value.value, `${name}.value`);
    case "text":
      return validate.string(value.value, `${name}.value`);
    case "data":
      return base64UrlToBytes(value.value, `${name}.value`);
    case "list": {
      if (!Array.isArray(value.value)) {
        failValidation(`${name}.value`, "an array", value.value);
      }
      return value.value.map((item, index) =>
        hydrateNativeAppRpcValue(item, nativeAppRpcHydrationChild(context, `${name}[${index}]`)));
    }
    case "object": {
      if (!Array.isArray(value.value)) {
        failValidation(`${name}.value`, "an array of fields", value.value);
      }
      const result = {};
      const seen = new Set();
      for (const [index, field] of value.value.entries()) {
        if (!field || typeof field !== "object") {
          failValidation(`${name}.value[${index}]`, "a field object", field);
        }
        const key = nativeAppRpcObjectFieldName(field.name, `${name}.value[${index}].name`);
        if (seen.has(key)) {
          throw new ValidationError(`${name}.value contains duplicate field: ${key}`);
        }
        seen.add(key);
        result[key] = hydrateNativeAppRpcValue(
          field.value, nativeAppRpcHydrationChild(context, `${name}.${key}`));
      }
      return result;
    }
    case "capability": {
      if (!value.value || typeof value.value !== "object") {
        failValidation(`${name}.value`, "a native capability slot", value.value);
      }
      const slot = nativeCapabilitySlot(value.value.id, {
        nativeInterface: value.value.nativeInterface,
      });
      if (context.resolveCapabilitySlot) {
        return context.resolveCapabilitySlot(slot, { name });
      }
      return slot;
    }
    default:
      throw new ValidationError(`${name}.type is unsupported: ${value.type}`);
  }
}

export function serializeNativeAppRpcCall(method, args = []) {
  method = capabilityMethodName(method);
  args = capabilityArgs(args).map((arg, index) =>
    serializeNativeAppRpcValue(arg, `args[${index}]`));
  return { method, args };
}

export async function serializeNativeAppRpcCallAsync(method, args = [], options = {}) {
  method = capabilityMethodName(method);
  const context = nativeAppRpcSerializationContext(options, "call");
  args = await Promise.all(capabilityArgs(args).map((arg, index) =>
    serializeNativeAppRpcValueAsync(
      arg, nativeAppRpcSerializationChild(context, `${context.name}.args[${index}]`))));
  return { method, args };
}

export function hydrateNativeAppRpcCall(call, options = "call") {
  const context = nativeAppRpcHydrationContext(options, "call");
  const name = context.name;
  if (!call || typeof call !== "object") {
    failValidation(name, "a native app RPC call envelope", call);
  }

  return {
    method: capabilityMethodName(call.method, `${name}.method`),
    args: capabilityArgs(call.args || [], `${name}.args`)
      .map((arg, index) => hydrateNativeAppRpcValue(
        arg, nativeAppRpcHydrationChild(context, `${name}.args[${index}]`))),
  };
}

export function serializeNativeAppRpcResult(value) {
  return {
    type: "value",
    value: serializeNativeAppRpcValue(value, "result"),
  };
}

export async function serializeNativeAppRpcResultAsync(value, options = {}) {
  return {
    type: "value",
    value: await serializeNativeAppRpcValueAsync(value, {
      ...nativeAppRpcSerializationContext(options, "result"),
      name: "result",
      exportReturnedRpcTargets: true,
    }),
  };
}

export function serializeNativeAppRpcException(error) {
  return {
    type: "exception",
    value: {
      name: String(error?.name || "Error"),
      message: String(error?.message || error),
      stack: String(error?.stack || ""),
    },
  };
}

export function hydrateNativeAppRpcResult(result, options = "result") {
  const context = nativeAppRpcHydrationContext(options, "result");
  const name = context.name;
  if (!result || typeof result !== "object" || typeof result.type !== "string") {
    throw new ValidationError(`${name} must be a native app RPC result envelope`);
  }

  switch (result.type) {
    case "value":
      return hydrateNativeAppRpcValue(
        result.value, nativeAppRpcHydrationChild(context, `${name}.value`));
    case "exception": {
      const exception = result.value || {};
      const errorName = validate.string(exception.name || "Error", `${name}.value.name`);
      const message = validate.string(exception.message || "", `${name}.value.message`);
      const stack = validate.string(exception.stack || "", `${name}.value.stack`);
      throw new CapabilityCallError(message, {
        name: errorName,
        stack,
        nativeAppRpcResult: result,
      });
    }
    default:
      throw new ValidationError(`${name}.type is unsupported: ${result.type}`);
  }
}

export async function dispatchNativeAppRpcCall(target, call, options = {}) {
  if (!target || typeof target !== "object") {
    throw new ValidationError("native app RPC target must be an object");
  }

  const { method, args } = hydrateNativeAppRpcCall(call, options);
  const func = target[method];
  if (typeof func !== "function") {
    return serializeNativeAppRpcException({
      name: "NoSuchMethod",
      message: `RPC method not found: ${method}`,
    });
  }

  try {
    return serializeNativeAppRpcResultAsync(await func.apply(target, args), options);
  } catch (error) {
    return serializeNativeAppRpcException(error);
  }
}

const NATIVE_APP_RPC_STUB_OWN_PROPERTIES = new Set([
  "slot",
  "call",
  "drop",
  "rpc",
  "toJSON",
]);

export class NativeAppRpcStub {
  #slot;
  #transport;
  #serializationOptions;
  #hydrationOptions;
  #release;
  #beginCall;
  #dropPromise;
  #rpc;

  constructor(slot, transport, options = {}) {
    if (typeof transport !== "function") {
      throw new ValidationError("native app RPC transport must be a function");
    }

    this.#slot = nativeCapabilitySlot(slot?.id, {
      nativeInterface: slot?.nativeInterface,
    });
    this.#transport = transport;
    this.#serializationOptions = nativeAppRpcSerializationContext(options, "call");
    this.#hydrationOptions = nativeAppRpcHydrationContext(options, "result");
    if (options?.beginCall !== undefined && options.beginCall !== null) {
      if (typeof options.beginCall !== "function") {
        failValidation("native app RPC stub beginCall", "a function", options.beginCall);
      }
      this.#beginCall = options.beginCall;
    }
    if (options?.release !== undefined && options.release !== null) {
      if (typeof options.release !== "function") {
        failValidation("native app RPC stub release", "a function", options.release);
      }
      this.#release = options.release;
    }
  }

  get slot() {
    return this.#slot;
  }

  async call(method, ...args) {
    if (this.#dropPromise) {
      throw new CapabilityCallError("native app RPC stub has been dropped");
    }
    const callState = this.#beginCall?.();
    const serializationOptions = callState?.serializationOptions ?? this.#serializationOptions;
    try {
      const call = await serializeNativeAppRpcCallAsync(method, args, serializationOptions);
      const result = await this.#transport(this.#slot, call);
      return hydrateNativeAppRpcResult(result, this.#hydrationOptions);
    } finally {
      await callState?.finish?.();
    }
  }

  drop() {
    if (!this.#dropPromise) {
      this.#dropPromise = Promise.resolve(this.#release?.(this.#slot))
        .then((result) => result ?? { ok: true });
    }
    return this.#dropPromise;
  }

  get rpc() {
    if (!this.#rpc) {
      this.#rpc = createNativeAppRpcProxy(this);
    }
    return this.#rpc;
  }

  toJSON() {
    return this.#slot;
  }
}

function createNativeAppRpcProxy(stub) {
  return new Proxy(stub, {
    get(target, prop, receiver) {
      if (typeof prop !== "string" ||
          NATIVE_APP_RPC_STUB_OWN_PROPERTIES.has(prop) ||
          prop in target) {
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      if (prop === "then") {
        return undefined;
      }
      return async (...args) => target.call(prop, ...args);
    },
  });
}

export function createNativeAppRpcStub(slot, transport, options) {
  return new NativeAppRpcStub(slot, transport, options);
}

export function createNativeAppRpcFetchTransport(fetcher, route) {
  if (!fetcher || typeof fetcher.fetch !== "function") {
    throw new ValidationError("native app RPC fetch transport requires a fetcher");
  }
  if (typeof route !== "string" && typeof route !== "function") {
    throw new ValidationError("native app RPC fetch transport route must be a string or function");
  }

  return async (slot, call) => {
    const url = typeof route === "function" ? route(slot) : route;
    let response;
    try {
      response = await fetcher.fetch(validate.string(url, "native app RPC route"), {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(call),
      });
    } catch (error) {
      throw new DisconnectedCapabilityError("native app RPC transport disconnected", {
        cause: error,
      });
    }
    const text = await response.text();
    let result;
    try {
      result = text.length > 0 ? JSON.parse(text) : {};
    } catch (error) {
      throw new CapabilityCallError(
        `native app RPC transport returned non-JSON response with status ${response.status}`,
        { status: response.status, body: text });
    }

    if (!result || typeof result !== "object" || typeof result.type !== "string") {
      throw new CapabilityCallError(
        `native app RPC transport returned invalid response with status ${response.status}`,
        { status: response.status, body: result });
    }

    if (!response.ok) {
      throw new CapabilityCallError(
        `native app RPC transport failed with status ${response.status}`,
        { status: response.status, body: result });
    }

    return result;
  };
}

async function requireNativeAppRpcCapability(capability) {
  const info = await capabilityInfo(capability.env, capability);
  if (!capabilitySupportsAppObjectCall(info)) {
    const nativeInterface = info?.nativeInterface || "unknown";
    throw new UnsupportedCapabilityError(
      nativeInterface,
      "rpc",
      `Capability nativeInterface ${nativeInterface} cannot be used with app-defined RPC`);
  }
}

function capabilitySupportsAppObjectCall(info) {
  return info?.nativeInterface === "appObject";
}

function localObjectCapabilityId(info) {
  const prefix = `${OBJECT_CAPABILITY_PREFIX}/`;
  const pathPrefix = info?.pathPrefix;
  if (typeof pathPrefix !== "string" || !pathPrefix.startsWith(prefix)) {
    return undefined;
  }

  const rest = pathPrefix.slice(prefix.length);
  if (rest.length === 0 || rest.includes("/")) {
    return undefined;
  }
  return decodeURIComponent(rest);
}

async function dispatchLocalObjectCapabilityNativeAppRpc(capability, info, call) {
  const objectId = localObjectCapabilityId(info);
  if (!objectId) {
    return undefined;
  }

  const target = exportedObjectTargets.get(objectId);
  if (!target) {
    return undefined;
  }

  return dispatchNativeAppRpcCall(target, call, {
    exportCapabilitySlot: (value, context) =>
      exportCapabilityNativeAppRpcSlot(capability.env, value, context),
    resolveCapabilitySlot: (slot) => new Capability(capability.env, slot.id),
  });
}

async function exportCapabilityNativeAppRpcSlot(
    env, value, context, temporaryCapabilities) {
  if (value instanceof RpcTarget) {
    const capability = await createObjectCapability(env, value, { persistent: false });
    temporaryCapabilities?.push(capability);
    return nativeCapabilitySlot(capability.id, { nativeInterface: "appObject" });
  }

  if (value instanceof Capability) {
    const info = await capabilityInfo(env, value);
    if (!capabilitySupportsAppObjectCall(info)) {
      const nativeInterface = info?.nativeInterface || "unknown";
      throw new UnsupportedCapabilityError(
        nativeInterface,
        "rpc",
        `${context.name} nativeInterface ${nativeInterface} cannot be used with app-defined RPC`);
    }
    return nativeCapabilitySlot(value.id, { nativeInterface: "appObject" });
  }

  failValidation(context.name, "an app-defined RPC capability", value);
}

async function releaseTemporaryNativeAppRpcCapabilities(temporaryCapabilities) {
  const errors = [];
  for (const capability of temporaryCapabilities.splice(0).reverse()) {
    try {
      await capability.drop();
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length > 0) {
    throw new CapabilityCallError("failed to release temporary app-defined RPC capabilities", {
      errors,
    });
  }
}

function capabilityNativeAppRpcSlotValue(env, slot) {
  if (slot?.nativeInterface !== "appObject") {
    const nativeInterface = slot?.nativeInterface || "unknown";
    throw new UnsupportedCapabilityError(
      nativeInterface,
      "rpc",
      `native capability slot nativeInterface ${nativeInterface} cannot be used with app-defined RPC`);
  }
  return new Capability(env, slot.id);
}

async function callCapabilityWithNativeAppRpc(capability, method, args) {
  const stub = createCapabilityNativeAppRpcStub(capability, {
    checkInfo: false,
    resolveCapabilitySlot: (slot) =>
      capabilityNativeAppRpcSlotValue(capability.env, slot),
  });
  return await stub.call(method, ...args);
}

export function createCapabilityNativeAppRpcStub(capability, options = {}) {
  if (!(capability instanceof Capability)) {
    failValidation("native app RPC capability", "a Capability", capability);
  }
  if (!isPlainObject(options)) {
    failValidation("native app RPC capability options", "an object", options);
  }

  let transport = options.transport;
  if (transport !== undefined && transport !== null && typeof transport !== "function") {
    failValidation("native app RPC capability transport", "a function", transport);
  }
  const useLocalObjectRoute = transport === undefined && options.fetcher === undefined;
  if (transport === undefined && options.fetcher !== undefined) {
    transport = createNativeAppRpcFetchTransport(options.fetcher, options.route);
  } else if (transport === undefined && capability.env?.SANDSTORM_API) {
    transport = createNativeAppRpcFetchTransport(
      capability.env.SANDSTORM_API,
      (slot) => `http://sandstorm/powerbox/native-app-rpc-call?id=${encodeURIComponent(slot.id)}`);
  }

  const checkedTransport = async (slot, call) => {
    let info;
    if (options.checkInfo !== false) {
      info = await capabilityInfo(capability.env, capability);
      if (!capabilitySupportsAppObjectCall(info)) {
        const nativeInterface = info?.nativeInterface || "unknown";
        throw new UnsupportedCapabilityError(
          nativeInterface,
          "rpc",
          `Capability nativeInterface ${nativeInterface} cannot be used with app-defined RPC`);
      }
    } else if (useLocalObjectRoute) {
      info = await capabilityInfo(capability.env, capability);
    }

    if (useLocalObjectRoute) {
      const localResult =
        await dispatchLocalObjectCapabilityNativeAppRpc(capability, info, call);
      if (localResult !== undefined) {
        return localResult;
      }
    }

    if (!transport) {
      throw new CapabilityCallError(
        "app-defined RPC transport for capabilities is not connected");
    }
    return transport(slot, call);
  };

  const resolveCapabilitySlot = options.resolveCapabilitySlot ??
    ((slot) => capabilityNativeAppRpcSlotValue(capability.env, slot));

  return createNativeAppRpcStub(
    nativeCapabilitySlot(capability.id, { nativeInterface: "appObject" }),
    checkedTransport,
    {
      ...options,
      resolveCapabilitySlot,
      beginCall: () => {
        const temporaryCapabilities = [];
        return {
          serializationOptions: {
            ...options,
            exportCapabilitySlot: options.exportCapabilitySlot ??
              ((value, context) => exportCapabilityNativeAppRpcSlot(
                capability.env, value, context, temporaryCapabilities)),
          },
          finish: async () => {
            await releaseTemporaryNativeAppRpcCapabilities(temporaryCapabilities);
          },
        };
      },
      release: options.release ?? (() => capability.drop()),
    });
}

function storageUrl(key = "") {
  return `http://storage/${encodeURIComponent(key === "" ? "" : validate.storageKey(key))}`;
}

async function readStorageJson(response) {
  if (!response.ok) {
    return { ok: false, status: response.status, body: await response.text() };
  }
  return response.json();
}

export function storage(env) {
  return {
    async put(key, value) {
      const response = await env.STORAGE.fetch(storageUrl(key), {
        method: "PUT",
        body: typeof value === "string" || value instanceof Uint8Array
          ? value
          : JSON.stringify(value),
      });
      return readStorageJson(response);
    },

    async putJson(key, value) {
      const response = await env.STORAGE.fetch(storageUrl(key), {
        method: "PUT",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(value),
      });
      return readStorageJson(response);
    },

    async get(key) {
      const response = await env.STORAGE.fetch(storageUrl(key));
      if (response.status === 404) return undefined;
      if (!response.ok) {
        throw new Error(`storage get ${key} failed with ${response.status}`);
      }
      return response.text();
    },

    async getBytes(key) {
      const response = await env.STORAGE.fetch(storageUrl(key));
      if (response.status === 404) return undefined;
      if (!response.ok) {
        throw new Error(`storage getBytes ${key} failed with ${response.status}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    },

    async getJson(key) {
      const text = await this.get(key);
      return text === undefined ? undefined : JSON.parse(text);
    },

    async head(key) {
      const response = await env.STORAGE.fetch(storageUrl(key), { method: "HEAD" });
      return {
        ok: response.ok,
        status: response.status,
        bytes: response.headers.get("x-sandstorm-storage-bytes"),
      };
    },

    async delete(key) {
      return readStorageJson(await env.STORAGE.fetch(storageUrl(key), { method: "DELETE" }));
    },

    async list() {
      return readStorageJson(await env.STORAGE.fetch(storageUrl()));
    },
  };
}

function unsupportedPowerbox(operation, details = "") {
  throw new UnsupportedCapabilityError("powerbox", operation);
}

function sessionIdForPowerbox(request) {
  const sessionId = header(request, "x-sandstorm-session-id");
  if (!sessionId) {
    throw new Error("Powerbox operations require a live Sandstorm WebSession");
  }
  return sessionId;
}

function capabilityId(value, name = "capability") {
  if (typeof value === "string") {
    return validate.string(value, name, { minLength: 1, maxLength: 4096 });
  }

  if (value && typeof value === "object" &&
      (value.type === "capability" || value.type === "claimedCapability")) {
    return validate.string(value.id, `${name}.id`, { minLength: 1, maxLength: 4096 });
  }

  throw new ValidationError(`${name} must be a capability handle or id string`);
}

export class Capability {
  #env;
  #rpc;

  constructor(env, id) {
    this.#env = env;
    this.ok = true;
    this.type = "capability";
    this.id = validate.string(id, "capability.id", { minLength: 1, maxLength: 4096 });
  }

  get env() {
    return this.#env;
  }

  fetch(input, init) {
    return fetchCapability(this.#env, this, input, init);
  }

  call(method, ...args) {
    return callCapability(this, method, args);
  }

  get rpc() {
    if (!this.#rpc) {
      this.#rpc = createCapabilityNativeAppRpcStub(this).rpc;
    }
    return this.#rpc;
  }

  info(options = {}) {
    return capabilityInfo(this.#env, this, options);
  }

  save(options = {}) {
    return saveCapability(this.#env, this, options);
  }

  dup() {
    return duplicateCapability(this.#env, this);
  }

  async drop() {
    const metadata = capabilityMetadata.get(this.id);
    const objectId = objectCapabilityIds.get(this.id);
    const result = await postPowerbox(
      this.#env, `powerbox/drop?id=${encodeURIComponent(this.id)}`);
    forgetCapabilityHandle(this.id);
    if (metadata?.transientObjectCapability && result?.released === true && objectId) {
      const ids = exportedObjectCapabilityIds.get(objectId);
      if (!ids || ids.size === 0) {
        disposeExportedObjectTarget(objectId);
      }
    }
    return result;
  }

  offer(request, options = {}) {
    return offerCapability(this.#env, request, this, options);
  }

  fulfillRequest(request, options = {}) {
    return fulfillRequestWithCapability(this.#env, request, this, options);
  }

  tieToUser(request, options = {}) {
    return tieCapabilityToUser(this.#env, request, this, options);
  }

  [Symbol.dispose]() {
    this.drop().catch(() => {});
  }

  toJSON() {
    return {
      ok: true,
      type: "capability",
      id: this.id,
    };
  }
}

function saveLabel(options = {}) {
  let label = options.label ?? options.saveLabel ?? "Sandstorm capability";
  if (label && typeof label === "object" && typeof label.defaultText === "string") {
    label = label.defaultText;
  }
  return validate.string(label, "label", { minLength: 1, maxLength: 256 });
}

function requiredSaveLabel(options = {}, context = "label") {
  let label = options.label ?? options.saveLabel;
  if (label && typeof label === "object" && typeof label.defaultText === "string") {
    label = label.defaultText;
  }
  if (label === undefined || label === null) {
    throw new ValidationError(`${context} is required`);
  }
  return validate.string(label, context, { minLength: 1, maxLength: 256 });
}

function displayText(options, names, fallback, label, maxLength = 1024) {
  for (const name of names) {
    let value = options[name];
    if (value === undefined || value === null) {
      continue;
    }
    if (value && typeof value === "object" && typeof value.defaultText === "string") {
      value = value.defaultText;
    }
    return validate.string(value, label, { minLength: 1, maxLength });
  }

  if (fallback === undefined || fallback === null) {
    return undefined;
  }
  return validate.string(fallback, label, { minLength: 1, maxLength });
}

function displayTitle(options = {}) {
  return displayText(
    options,
    ["title", "displayTitle", "label"],
    "Claimed Sandstorm capability",
    "title",
    256);
}

function sessionDisplayInfoParams(options = {}) {
  const result = [["title", displayTitle(options)]];
  const verbPhrase = displayText(
    options, ["verbPhrase", "displayVerbPhrase"], undefined, "verbPhrase");
  if (verbPhrase !== undefined) {
    result.push(["verbPhrase", verbPhrase]);
  }
  const description = displayText(
    options, ["description", "displayDescription"], undefined, "description");
  if (description !== undefined) {
    result.push(["description", description]);
  }
  return result;
}

function apiSessionDescriptorParams(options = {}) {
  const descriptor = options.apiSession ?? options.apiSessionDescriptor ?? null;
  if (descriptor === null || descriptor === undefined) {
    return [];
  }
  if (typeof descriptor !== "object") {
    throw new ValidationError("apiSession descriptor must be an object");
  }

  const canonicalUrl = validate.string(descriptor.canonicalUrl, "apiSession.canonicalUrl", {
    minLength: 1,
    maxLength: 2048,
  });
  if (canonicalUrl.endsWith("/")) {
    throw new ValidationError("apiSession.canonicalUrl must not end with '/'");
  }

  const result = [
    ["descriptor", "apiSession"],
    ["apiCanonicalUrl", canonicalUrl],
  ];

  const scopes = descriptor.oauthScopes ?? [];
  if (!Array.isArray(scopes)) {
    throw new ValidationError("apiSession.oauthScopes must be an array");
  }
  for (let i = 0; i < scopes.length; ++i) {
    result.push(["apiOauthScope", validate.string(scopes[i], `apiSession.oauthScopes[${i}]`, {
      minLength: 1,
      maxLength: 256,
    })]);
  }

  return result;
}

const OUTBOUND_HTTP_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

function outboundHttpMethod(value, label) {
  const method = validate.string(value, label, { minLength: 1, maxLength: 16 }).toUpperCase();
  if (!OUTBOUND_HTTP_METHODS.has(method)) {
    throw new ValidationError(`${label} must be one of GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS`);
  }
  return method;
}

function outboundHttpDescriptorParams(options = {}) {
  const descriptor = options.outboundHttp ?? options.outboundHttpDescriptor ?? null;
  if (descriptor === null || descriptor === undefined) {
    return [];
  }
  if (typeof descriptor !== "object") {
    throw new ValidationError("outboundHttp descriptor must be an object");
  }

  const baseUrl = validate.string(descriptor.baseUrl, "outboundHttp.baseUrl", {
    minLength: 1,
    maxLength: 2048,
  });

  const result = [
    ["descriptor", "outboundHttp"],
    ["outboundHttpBaseUrl", baseUrl],
  ];

  const methods = descriptor.methods ?? [];
  if (!Array.isArray(methods)) {
    throw new ValidationError("outboundHttp.methods must be an array");
  }
  for (let i = 0; i < methods.length; ++i) {
    result.push(["outboundHttpMethod", outboundHttpMethod(
      methods[i], `outboundHttp.methods[${i}]`)]);
  }

  return result;
}

function validatePackedPowerboxDescriptor(descriptor, label = "descriptor") {
  const value = validate.string(descriptor, label, {
    minLength: 1,
    maxLength: 65536,
  });
  if (value.length % 4 === 1 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ValidationError(`${label} must be a base64url packed Powerbox descriptor`);
  }
  return value;
}

function packedPowerboxDescriptorParams(options = {}) {
  const descriptor = options.powerboxDescriptor ?? options.descriptor ?? null;
  if (descriptor === null || descriptor === undefined) {
    return [];
  }
  return [
    ["descriptor", "packed"],
    ["packedPowerboxDescriptor", validatePackedPowerboxDescriptor(
      descriptor, options.powerboxDescriptor === undefined ? "descriptor" : "powerboxDescriptor")],
  ];
}

const CLAIM_NATIVE_INTERFACES = new Set([
  "unknown",
  "webSession",
  "apiSession",
  "outboundHttpSession",
  "appObject",
]);

function claimNativeInterfaceParams(options = {}) {
  if (options.nativeInterface === undefined || options.nativeInterface === null) {
    return [];
  }
  const nativeInterface = validate.string(options.nativeInterface, "nativeInterface", {
    minLength: 1,
    maxLength: 64,
  });
  if (!CLAIM_NATIVE_INTERFACES.has(nativeInterface)) {
    throw new ValidationError(
      "nativeInterface must be one of unknown, webSession, apiSession, outboundHttpSession, appObject");
  }
  return [["nativeInterface", nativeInterface]];
}

function powerboxDescriptorParams(options = {}) {
  const apiSession = apiSessionDescriptorParams(options);
  const outboundHttp = outboundHttpDescriptorParams(options);
  const packed = packedPowerboxDescriptorParams(options);
  const descriptorCount =
    (apiSession.length > 0 ? 1 : 0) +
    (outboundHttp.length > 0 ? 1 : 0) +
    (packed.length > 0 ? 1 : 0);
  if (descriptorCount > 1) {
    throw new ValidationError("Powerbox options must specify only one descriptor type");
  }
  if (apiSession.length > 0) {
    return apiSession;
  } else if (outboundHttp.length > 0) {
    return outboundHttp;
  } else {
    return packed;
  }
}

async function saveCapabilityRecord(env, capability, options = {}) {
  const rawId = capabilityId(capability);
  const metadata = capabilityMetadata.get(rawId);
  if (metadata?.transientObjectCapability) {
    throw new Error(
      "JavaScript object capabilities are transient and cannot be saved yet. " +
      "Use api.exportDurable() when an exported object needs a durable token.");
  }

  const id = encodeURIComponent(rawId);
  const label = encodeURIComponent(saveLabel(options));
  return savedCapabilityRecord(await postPowerbox(env, `powerbox/save?id=${id}&label=${label}`));
}

async function saveCapability(env, capability, options = {}) {
  return (await saveCapabilityRecord(env, capability, options)).token;
}

function duplicateLocalCapabilityMetadata(metadata) {
  if (!metadata?.transientObjectCapability) {
    return undefined;
  }
  return { transientObjectCapability: true };
}

async function duplicateCapability(env, capability) {
  const sourceId = capabilityId(capability);
  const duplicated = wrapCapability(
    env, await postPowerbox(env, `powerbox/dup?id=${encodeURIComponent(sourceId)}`));
  const metadata = duplicateLocalCapabilityMetadata(capabilityMetadata.get(sourceId));
  if (metadata) {
    capabilityMetadata.set(duplicated.id, metadata);
  }
  const objectId = objectCapabilityIds.get(sourceId);
  if (objectId) {
    rememberObjectCapabilityHandle(objectId, duplicated.id);
  }
  return duplicated;
}

async function sessionPowerboxAction(env, request, endpoint, capability, options = {}) {
  const requiredPermissions = permissionNames(options);
  await validateRequiredPermissions(env, requiredPermissions);

  const params = new URLSearchParams({
    sessionId: sessionIdForPowerbox(request),
    id: capabilityId(capability),
  });
  for (const [name, value] of sessionDisplayInfoParams(options)) {
    params.append(name, value);
  }
  for (const name of requiredPermissions) {
    params.append("requiredPermission", name);
  }
  for (const [name, value] of powerboxDescriptorParams(options)) {
    params.append(name, value);
  }
  return postPowerbox(env, `powerbox/${endpoint}?${params}`);
}

async function offerCapability(env, request, capability, options = {}) {
  return sessionPowerboxAction(env, request, "offer", capability, options);
}

async function fulfillRequestWithCapability(env, request, capability, options = {}) {
  return sessionPowerboxAction(env, request, "fulfill-request", capability, options);
}

async function tieCapabilityToUser(env, request, capability, options = {}) {
  return wrapCapability(
    env, await sessionPowerboxAction(env, request, "tie-to-user", capability, options));
}

function apiSessionRequestOptions(options = {}) {
  if (options.apiSession !== undefined || options.apiSessionDescriptor !== undefined) {
    return options;
  }

  return { ...options, apiSession: options };
}

function outboundHttpRequestOptions(options = {}) {
  if (options.outboundHttp !== undefined || options.outboundHttpDescriptor !== undefined) {
    return options;
  }

  return { ...options, outboundHttp: options };
}

async function apiSessionPowerboxDescriptor(env, options = {}) {
  const result = await apiSessionPowerboxDescriptorInfo(env, options);
  return result.descriptor;
}

async function apiSessionPowerboxDescriptorInfo(env, options = {}) {
  const params = new URLSearchParams();
  for (const [name, value] of apiSessionDescriptorParams(apiSessionRequestOptions(options))) {
    if (name !== "descriptor") {
      params.append(name, value);
    }
  }
  return callPowerbox(env, `powerbox/api-session-descriptor?${params}`);
}

async function outboundHttpPowerboxDescriptor(env, options = {}) {
  const result = await outboundHttpPowerboxDescriptorInfo(env, options);
  return result.descriptor;
}

async function outboundHttpPowerboxDescriptorInfo(env, options = {}) {
  const params = new URLSearchParams();
  for (const [name, value] of outboundHttpDescriptorParams(outboundHttpRequestOptions(options))) {
    if (name !== "descriptor") {
      params.append(name, value);
    }
  }
  return callPowerbox(env, `powerbox/outbound-http-descriptor?${params}`);
}

export async function servePowerboxDescriptors(request, env) {
  const url = new URL(request.url);

  if (url.pathname === `${POWERBOX_DESCRIPTOR_PREFIX}/api-session-descriptor`) {
    try {
      const scopes = url.searchParams.getAll("oauthScope");
      const scopeList = scopes.length > 0
        ? scopes
        : String(url.searchParams.get("oauthScopes") || "")
            .split(/[,\s]+/)
            .map((scope) => scope.trim())
            .filter(Boolean);
      const descriptor = await apiSessionPowerboxDescriptorInfo(env, {
        canonicalUrl: url.searchParams.get("canonicalUrl") || "",
        oauthScopes: scopeList,
      });
      return Response.json(descriptor);
    } catch (error) {
      return Response.json({
        ok: false,
        error: String(error?.message || error),
      }, { status: 400 });
    }
  }

  if (url.pathname === `${POWERBOX_DESCRIPTOR_PREFIX}/outbound-http-descriptor`) {
    try {
      const methods = url.searchParams.getAll("method");
      const methodList = methods.length > 0
        ? methods
        : String(url.searchParams.get("methods") || "")
            .split(/[,\s]+/)
            .map((method) => method.trim())
            .filter(Boolean);
      const descriptor = await outboundHttpPowerboxDescriptorInfo(env, {
        baseUrl: url.searchParams.get("baseUrl") || "",
        methods: methodList,
      });
      return Response.json(descriptor);
    } catch (error) {
      return Response.json({
        ok: false,
        error: String(error?.message || error),
      }, { status: 400 });
    }
  }

  if (url.pathname === `${POWERBOX_DESCRIPTOR_PREFIX}/claim` && request.method === "POST") {
    try {
      const body = await request.json();
      const capability = await powerbox(request, env).claim(body.token, {
        requiredPermissions: Array.isArray(body.requiredPermissions)
          ? body.requiredPermissions
          : [],
      });
      return Response.json({
        ok: true,
        capability: JSON.parse(JSON.stringify(capability)),
      });
    } catch (error) {
      return Response.json({
        ok: false,
        error: String(error?.message || error),
      }, { status: 400 });
    }
  }

  return null;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[char]));
}

function routePrefix(options = {}, fallback, name) {
  const value = options.routePrefix ?? options.prefix ?? fallback;
  const prefix = validate.string(value, name, { minLength: 1, maxLength: 1024 });
  if (!prefix.startsWith("/")) {
    throw new ValidationError(`${name} must start with '/'`);
  }
  if (prefix.length > 1 && prefix.endsWith("/")) {
    throw new ValidationError(`${name} must not end with '/'`);
  }
  if (prefix.includes("://") || prefix.includes("?") || prefix.includes("#")) {
    throw new ValidationError(`${name} must be a path prefix`);
  }
  return prefix;
}

function normalizePowerboxGrantId(id, name = "grant id") {
  const value = validate.string(id, name, { minLength: 1, maxLength: 128 });
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new ValidationError(`${name} must contain only letters, numbers, '.', '_', and '-'`);
  }
  return value;
}

function normalizePowerboxGrantText(value, fallback, name, maxLength = 256) {
  let text = value ?? fallback;
  if (text && typeof text === "object" && typeof text.defaultText === "string") {
    text = text.defaultText;
  }
  return validate.string(text, name, { minLength: 1, maxLength });
}

function normalizePowerboxGrantSaveLabel(value, fallback, name) {
  if (value === undefined || value === null) {
    return { defaultText: fallback };
  }
  if (typeof value === "string") {
    return { defaultText: validate.string(value, name, { minLength: 1, maxLength: 256 }) };
  }
  if (value && typeof value === "object" && typeof value.defaultText === "string") {
    return {
      defaultText: validate.string(value.defaultText, `${name}.defaultText`, {
        minLength: 1,
        maxLength: 256,
      }),
    };
  }
  throw new ValidationError(`${name} must be a string or { defaultText }`);
}

function cloneJsonValue(value, name) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    throw new ValidationError(`${name} must be JSON-serializable`);
  }
}

function publicPowerboxGrantQuery(spec) {
  if (spec.query !== undefined) {
    return cloneJsonValue(spec.query, "grant.query");
  }
  if (spec.descriptors !== undefined) {
    if (!Array.isArray(spec.descriptors)) {
      throw new ValidationError("grant.descriptors must be an array");
    }
    return spec.descriptors.map((descriptor, index) =>
      validatePackedPowerboxDescriptor(descriptor, `grant.descriptors[${index}]`));
  }
  if (spec.descriptor !== undefined || spec.powerboxDescriptor !== undefined) {
    return [validatePackedPowerboxDescriptor(
      spec.powerboxDescriptor ?? spec.descriptor,
      spec.powerboxDescriptor === undefined ? "grant.descriptor" : "grant.powerboxDescriptor")];
  }
  if (spec.apiSession !== undefined || spec.apiSessionDescriptor !== undefined) {
    const descriptor = spec.apiSession ?? spec.apiSessionDescriptor;
    return { apiSession: cloneJsonValue(descriptor, "grant.apiSession") };
  }
  if (spec.outboundHttp !== undefined || spec.outboundHttpDescriptor !== undefined) {
    const descriptor = spec.outboundHttp ?? spec.outboundHttpDescriptor;
    return { outboundHttp: cloneJsonValue(descriptor, "grant.outboundHttp") };
  }
  if (spec.query === null) {
    return null;
  }
  throw new ValidationError("Powerbox grant must specify query, descriptor, descriptors, apiSession, or outboundHttp");
}

function powerboxGrantClaimDescriptorOptions(spec) {
  if (spec.claimOptions) {
    const claimOptions = { ...spec.claimOptions };
    if (spec.nativeInterface !== undefined && claimOptions.nativeInterface === undefined) {
      claimOptions.nativeInterface = spec.nativeInterface;
    }
    return claimOptions;
  }
  if (spec.descriptor !== undefined || spec.powerboxDescriptor !== undefined) {
    return {
      descriptor: spec.powerboxDescriptor ?? spec.descriptor,
      nativeInterface: spec.nativeInterface ?? "appObject",
    };
  }
  if (spec.apiSession !== undefined || spec.apiSessionDescriptor !== undefined) {
    return { apiSession: spec.apiSession ?? spec.apiSessionDescriptor };
  }
  if (spec.outboundHttp !== undefined || spec.outboundHttpDescriptor !== undefined) {
    return { outboundHttp: spec.outboundHttp ?? spec.outboundHttpDescriptor };
  }
  return {};
}

function normalizePowerboxGrant(id, spec) {
  if (!spec || typeof spec !== "object") {
    throw new ValidationError(`Powerbox grant ${id} must be an object`);
  }

  const grantId = normalizePowerboxGrantId(spec.id ?? id);
  const title = normalizePowerboxGrantText(spec.title ?? spec.label, grantId, `grants.${grantId}.title`);
  const description = spec.description === undefined || spec.description === null
    ? ""
    : normalizePowerboxGrantText(spec.description, "", `grants.${grantId}.description`, 1024);
  const storageKey = validate.storageKey(spec.storageKey ?? spec.key ?? grantId, `grants.${grantId}.storageKey`);
  const requiredPermissions = permissionNames({
    requiredPermissions: spec.requiredPermissions ?? spec.claimOptions?.requiredPermissions,
  });
  const saveOptions = {
    ...(spec.save || {}),
    label: (spec.save && (spec.save.label ?? spec.save.saveLabel)) ?? spec.saveLabel ?? spec.label ?? title,
  };
  requiredSaveLabel(saveOptions, `grants.${grantId}.save.label`);

  return {
    id: grantId,
    title,
    description,
    storageKey,
    query: publicPowerboxGrantQuery(spec),
    saveLabel: normalizePowerboxGrantSaveLabel(
      spec.saveLabel, title, `grants.${grantId}.saveLabel`),
    requiredPermissions,
    saveOptions,
    claimOptions: {
      ...powerboxGrantClaimDescriptorOptions(spec),
      requiredPermissions,
    },
    test: spec.test,
  };
}

function normalizePowerboxGrantList(options = {}) {
  const source = options.grants ?? options;
  const entries = Array.isArray(source)
    ? source.map((spec) => [spec && spec.id, spec])
    : Object.entries(source || {});
  const grants = new Map();

  for (const [id, spec] of entries) {
    const grant = normalizePowerboxGrant(id, spec);
    if (grants.has(grant.id)) {
      throw new ValidationError(`duplicate Powerbox grant id: ${grant.id}`);
    }
    grants.set(grant.id, grant);
  }

  return grants;
}

function publicPowerboxGrant(grant, connected = false) {
  return {
    id: grant.id,
    title: grant.title,
    description: grant.description,
    storageKey: grant.storageKey,
    query: grant.query,
    saveLabel: grant.saveLabel,
    requiredPermissions: grant.requiredPermissions,
    connected,
  };
}

async function powerboxGrantStatus(env, grant) {
  const token = await storage(env).get(grant.storageKey);
  return {
    ok: true,
    id: grant.id,
    title: grant.title,
    description: grant.description,
    storageKey: grant.storageKey,
    connected: Boolean(token),
  };
}

async function powerboxGrantConfig(env, grants, prefix = POWERBOX_GRANTS_PREFIX) {
  const publicGrants = [];
  for (const grant of grants.values()) {
    const status = await powerboxGrantStatus(env, grant);
    publicGrants.push(publicPowerboxGrant(grant, status.connected));
  }
  return {
    ok: true,
    routePrefix: prefix,
    grants: publicGrants,
  };
}

function powerboxGrantErrorResponse(error, status = 400) {
  return Response.json({
    ok: false,
    error: String(error?.message || error),
  }, { status });
}

function normalizePowerboxFulfillmentOptions(options = {}) {
  if (!options || typeof options !== "object") {
    throw new ValidationError("Powerbox fulfillment options must be an object");
  }
  if (typeof options.capability !== "function") {
    throw new ValidationError("Powerbox fulfillment capability must be a function");
  }
  if (!options.fulfill || typeof options.fulfill !== "object") {
    throw new ValidationError("Powerbox fulfillment fulfill options must be an object");
  }

  return {
    title: normalizePowerboxGrantText(
      options.title, undefined, "Powerbox fulfillment title"),
    description: options.description === undefined || options.description === null
      ? ""
      : normalizePowerboxGrantText(
        options.description, "", "Powerbox fulfillment description", 1024),
    buttonLabel: normalizePowerboxGrantText(
      options.buttonLabel, "Use this provider", "Powerbox fulfillment buttonLabel"),
    capability: options.capability,
    fulfill: options.fulfill,
  };
}

function powerboxFulfillmentPage(options, prefix) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml(options.title)}</title>
    <style>
      body {
        color: #1f2933;
        font: 15px/1.5 system-ui, sans-serif;
        margin: 2rem;
        max-width: 42rem;
      }
      h1 {
        font-size: 1.5rem;
        margin: 0 0 0.75rem;
      }
      p {
        color: #52616f;
        margin: 0 0 1.25rem;
      }
      button {
        background: #174ea6;
        border: 1px solid #174ea6;
        color: white;
        cursor: pointer;
        font: inherit;
        padding: 0.5rem 0.8rem;
      }
      button:disabled {
        cursor: default;
        opacity: 0.55;
      }
      pre {
        background: #f5f7fa;
        border: 1px solid #d8e0e8;
        margin-top: 1.25rem;
        overflow: auto;
        padding: 0.75rem;
        white-space: pre-wrap;
      }
    </style>
  </head>
  <body>
    <h1>${escapeHtml(options.title)}</h1>
    ${options.description ? `<p>${escapeHtml(options.description)}</p>` : ""}
    <button id="fulfill" type="button">${escapeHtml(options.buttonLabel)}</button>
    <pre id="result"></pre>
    <script>
      const button = document.querySelector("#fulfill");
      const result = document.querySelector("#result");
      async function readBody(response) {
        const text = await response.text();
        try {
          return JSON.parse(text);
        } catch (error) {
          return { ok: false, error: text || "HTTP " + response.status };
        }
      }
      button.addEventListener("click", async () => {
        button.disabled = true;
        result.textContent = "fulfilling";
        try {
          const response = await fetch(${JSON.stringify(`${prefix}/fulfill`)}, {
            method: "POST",
          });
          result.textContent = JSON.stringify(await readBody(response), null, 2);
        } catch (error) {
          result.textContent = (error.message || String(error)) + "\\n" + (error.stack || "");
          button.disabled = false;
        }
      });
    </script>
  </body>
</html>`;
}

function normalizePowerboxFulfillmentCapability(env, value) {
  const capability = wrapCapability(env, value && typeof value === "object" && value.capability
    ? value.capability
    : value);
  const id = capabilityId(capability, "Powerbox fulfillment capability");
  return { capability, handle: { ok: true, type: "capability", id } };
}

export function powerboxFulfillment(request, env, options = {}) {
  const prefix = routePrefix(
    options, POWERBOX_FULFILLMENT_PREFIX, "Powerbox fulfillment routePrefix");
  const config = normalizePowerboxFulfillmentOptions(options);

  async function fulfill(routeRequest = request) {
    const produced = await config.capability();
    const { capability, handle } = normalizePowerboxFulfillmentCapability(env, produced);
    const fulfilled = await fulfillRequestWithCapability(
      env, routeRequest, capability, config.fulfill);
    return {
      ok: true,
      fulfill: fulfilled,
      capability: handle,
    };
  }

  return {
    fulfill,
    async serve(routeRequest = request) {
      const url = new URL(routeRequest.url);
      if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
        return null;
      }

      try {
        if ((url.pathname === prefix || url.pathname === `${prefix}/`) &&
            routeRequest.method === "GET") {
          return new Response(powerboxFulfillmentPage(config, prefix), {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }

        if (url.pathname === `${prefix}/fulfill` && routeRequest.method === "POST") {
          return Response.json(await fulfill(routeRequest));
        }

        return new Response("Not Found", { status: 404 });
      } catch (error) {
        return powerboxGrantErrorResponse(error);
      }
    },
  };
}

function powerboxGrantClientScript(prefix) {
  const rpcClientPath = `${prefix}/rpc-client.js`;
  return `import { inspectPowerboxQuery, requestPowerbox } from ${JSON.stringify(rpcClientPath)};

const ROUTE_PREFIX = ${JSON.stringify(prefix)};

async function readJsonResponse(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (error) {
    return { ok: false, error: text || "HTTP " + response.status };
  }
}

async function jsonFetch(path, options = {}) {
  const response = await fetch(new URL(path, window.location.href), options);
  const body = await readJsonResponse(response);
  if (!response.ok || !body.ok) {
    throw new Error(body.error || "Powerbox grant request failed with " + response.status);
  }
  return body;
}

export async function grantConfig() {
  return jsonFetch(ROUTE_PREFIX + "/config");
}

export async function grantStatus(id = undefined) {
  const suffix = id === undefined ? "" : "?id=" + encodeURIComponent(id);
  return jsonFetch(ROUTE_PREFIX + "/status" + suffix);
}

async function grantById(id) {
  const config = await grantConfig();
  const grant = config.grants.find((candidate) => candidate.id === id);
  if (!grant) {
    throw new Error("Unknown Powerbox grant: " + id);
  }
  return grant;
}

export async function requestGrant(id) {
  const grant = await grantById(id);
  let query = null;
  if (grant.query !== null && grant.query !== undefined) {
    const inspection = await inspectPowerboxQuery(grant.query);
    query = inspection.descriptors.map((descriptor) => descriptor.descriptor);
  }
  const requested = await requestPowerbox(query, { saveLabel: grant.saveLabel });
  return jsonFetch(ROUTE_PREFIX + "/grants/" + encodeURIComponent(id) + "/claim", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(requested),
  });
}

export async function revokeGrant(id) {
  return jsonFetch(ROUTE_PREFIX + "/grants/" + encodeURIComponent(id) + "/revoke", {
    method: "POST",
  });
}

function renderGrant(element, state) {
  element.textContent = "";
  const root = document.createElement("span");
  root.className = "sandstorm-powerbox-grant";

  const status = document.createElement("span");
  status.className = "sandstorm-powerbox-grant-status";
  status.textContent = state.connected ? "connected" : "not connected";
  root.append(status);

  const connect = document.createElement("button");
  connect.type = "button";
  connect.textContent = state.connected ? "Reconnect" : "Connect";
  connect.addEventListener("click", async () => {
    connect.disabled = true;
    revoke.disabled = true;
    try {
      const result = await requestGrant(state.id);
      renderGrant(element, result.status);
      element.dispatchEvent(new CustomEvent("sandstorm-powerbox-grant", { detail: result }));
    } catch (error) {
      renderError(element, state, error);
    }
  });
  root.append(connect);

  const revoke = document.createElement("button");
  revoke.type = "button";
  revoke.textContent = "Disconnect";
  revoke.disabled = !state.connected;
  revoke.addEventListener("click", async () => {
    connect.disabled = true;
    revoke.disabled = true;
    try {
      const result = await revokeGrant(state.id);
      renderGrant(element, result.status);
      element.dispatchEvent(new CustomEvent("sandstorm-powerbox-revoke", { detail: result }));
    } catch (error) {
      renderError(element, state, error);
    }
  });
  root.append(revoke);

  element.append(root);
}

function renderError(element, state, error) {
  renderGrant(element, state);
  const message = document.createElement("span");
  message.className = "sandstorm-powerbox-grant-error";
  message.textContent = error.message || String(error);
  element.append(message);
}

class SandstormPowerboxGrantElement extends HTMLElement {
  connectedCallback() {
    this.refresh();
  }

  async refresh() {
    const id = this.getAttribute("grant") || this.getAttribute("grant-id");
    if (!id) {
      this.textContent = "missing grant";
      return;
    }
    try {
      const result = await grantStatus(id);
      renderGrant(this, result.status);
    } catch (error) {
      this.textContent = error.message || String(error);
    }
  }
}

if (typeof customElements !== "undefined" &&
    !customElements.get("sandstorm-powerbox-grant")) {
  customElements.define("sandstorm-powerbox-grant", SandstormPowerboxGrantElement);
}
`;
}

function powerboxGrantPage(grants, prefix) {
  const rows = Array.from(grants.values()).map((grant) => `
        <section>
          <div>
            <h2>${escapeHtml(grant.title)}</h2>
            ${grant.description ? `<p>${escapeHtml(grant.description)}</p>` : ""}
          </div>
          <sandstorm-powerbox-grant grant="${escapeHtml(grant.id)}"></sandstorm-powerbox-grant>
        </section>`).join("");

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Powerbox Grants</title>
    <style>
      body {
        color: #1f2933;
        font: 15px/1.5 system-ui, sans-serif;
        margin: 2rem;
        max-width: 52rem;
      }
      h1 {
        font-size: 1.5rem;
        margin: 0 0 1.25rem;
      }
      section {
        align-items: center;
        border-top: 1px solid #d8e0e8;
        display: grid;
        gap: 1rem;
        grid-template-columns: minmax(0, 1fr) auto;
        padding: 1rem 0;
      }
      h2 {
        font-size: 1rem;
        margin: 0;
      }
      p {
        color: #52616f;
        margin: 0.25rem 0 0;
      }
      .sandstorm-powerbox-grant {
        align-items: center;
        display: inline-flex;
        gap: 0.5rem;
      }
      .sandstorm-powerbox-grant-status {
        color: #52616f;
        min-width: 7rem;
      }
      .sandstorm-powerbox-grant-error {
        color: #8a1f11;
        display: block;
        margin-top: 0.35rem;
      }
      button {
        background: #174ea6;
        border: 1px solid #174ea6;
        color: white;
        cursor: pointer;
        font: inherit;
        padding: 0.45rem 0.7rem;
      }
      button:disabled {
        cursor: default;
        opacity: 0.55;
      }
      button + button {
        background: white;
        color: #174ea6;
      }
      @media (max-width: 640px) {
        body {
          margin: 1rem;
        }
        section {
          grid-template-columns: 1fr;
        }
      }
    </style>
    <script type="module" src="${escapeHtml(prefix)}/client.js"></script>
  </head>
  <body>
    <h1>Powerbox Grants</h1>
    <main>${rows}</main>
  </body>
</html>`;
}

function powerboxGrantFromRoute(grants, encodedId) {
  const id = normalizePowerboxGrantId(decodeURIComponent(encodedId || ""), "grant id");
  const grant = grants.get(id);
  if (!grant) {
    throw new ValidationError(`unknown Powerbox grant: ${id}`);
  }
  return grant;
}

export function powerboxGrants(request, env, options = {}) {
  const prefix = routePrefix(options, POWERBOX_GRANTS_PREFIX, "Powerbox grants routePrefix");
  const grants = normalizePowerboxGrantList(options);
  const store = storage(env);

  async function status(id = undefined) {
    if (id !== undefined && id !== null) {
      const grant = powerboxGrantFromRoute(grants, encodeURIComponent(String(id)));
      return {
        ok: true,
        status: await powerboxGrantStatus(env, grant),
      };
    }

    const statuses = [];
    for (const grant of grants.values()) {
      statuses.push(await powerboxGrantStatus(env, grant));
    }
    return {
      ok: true,
      statuses,
    };
  }

  async function claim(id, result) {
    const grant = powerboxGrantFromRoute(grants, encodeURIComponent(String(id)));
    const cap = await powerbox(request, env).claim(result, grant.claimOptions);
    let token;
    try {
      token = await cap.save(grant.saveOptions);
      await store.put(grant.storageKey, token);
      let testResult;
      if (grant.test !== undefined) {
        if (typeof grant.test !== "function") {
          throw new ValidationError(`Powerbox grant ${grant.id} test must be a function`);
        }
        testResult = await grant.test(cap);
      }
      return {
        ok: true,
        id: grant.id,
        storageKey: grant.storageKey,
        status: await powerboxGrantStatus(env, grant),
        test: testResult,
      };
    } catch (error) {
      if (token) {
        await revokeCapabilityToken(env, token).catch(() => {});
        await store.delete(grant.storageKey).catch(() => {});
      }
      throw error;
    } finally {
      await cap.drop();
    }
  }

  async function revoke(id) {
    const grant = powerboxGrantFromRoute(grants, encodeURIComponent(String(id)));
    const token = await store.get(grant.storageKey);
    if (!token) {
      return {
        ok: true,
        id: grant.id,
        storageKey: grant.storageKey,
        revoked: false,
        deleted: await store.delete(grant.storageKey),
        status: await powerboxGrantStatus(env, grant),
      };
    }

    const revoked = await revokeCapabilityToken(env, token);
    const deleted = await store.delete(grant.storageKey);
    return {
      ok: true,
      id: grant.id,
      storageKey: grant.storageKey,
      revoked: true,
      revoke: revoked,
      deleted,
      status: await powerboxGrantStatus(env, grant),
    };
  }

  return {
    config: () => powerboxGrantConfig(env, grants, prefix),
    status,
    claim,
    revoke,
    async use(id, fn) {
      const grant = powerboxGrantFromRoute(grants, encodeURIComponent(String(id)));
      const token = await store.get(grant.storageKey);
      if (!token) {
        throw new Error(`missing saved token for Powerbox grant: ${grant.id}`);
      }
      return useCapabilityToken(env, token, fn);
    },
    token(id) {
      const grant = powerboxGrantFromRoute(grants, encodeURIComponent(String(id)));
      return store.get(grant.storageKey);
    },
    async serve(routeRequest = request) {
      const url = new URL(routeRequest.url);
      if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
        return null;
      }

      try {
        if ((url.pathname === prefix || url.pathname === `${prefix}/`) &&
            routeRequest.method === "GET") {
          return new Response(powerboxGrantPage(grants, prefix), {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }

        if (url.pathname === `${prefix}/client.js` && routeRequest.method === "GET") {
          return new Response(powerboxGrantClientScript(prefix), {
            headers: { "content-type": "text/javascript; charset=utf-8" },
          });
        }

        if (url.pathname === `${prefix}/rpc-client.js` && routeRequest.method === "GET") {
          return new Response(rpcClientScript(), {
            headers: { "content-type": "text/javascript; charset=utf-8" },
          });
        }

        if (url.pathname === `${prefix}/config` && routeRequest.method === "GET") {
          return Response.json(await powerboxGrantConfig(env, grants, prefix));
        }

        if (url.pathname === `${prefix}/status` && routeRequest.method === "GET") {
          return Response.json(await status(url.searchParams.get("id") ?? undefined));
        }

        const match = url.pathname.match(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/grants/([^/]+)/(claim|revoke)$`));
        if (match && routeRequest.method === "POST") {
          const grant = powerboxGrantFromRoute(grants, match[1]);
          if (match[2] === "claim") {
            return Response.json(await claim(grant.id, await routeRequest.json()));
          }
          return Response.json(await revoke(grant.id));
        }

        return new Response("Not Found", { status: 404 });
      } catch (error) {
        return powerboxGrantErrorResponse(error);
      }
    },
  };
}

export async function serveSystemRoutes(request, env) {
  return await servePowerboxDescriptors(request, env) ||
    await serveObjectCapability(request, env);
}

function webSessionPathPrefix(options = {}) {
  const value = options.pathPrefix ?? options.prefix ?? "";
  const pathPrefix = validate.string(value, "pathPrefix", { maxLength: 1024 });
  if (pathPrefix.length > 0 && !pathPrefix.startsWith("/")) {
    throw new ValidationError("pathPrefix must be empty or start with '/'");
  }
  if (pathPrefix.includes("://")) {
    throw new ValidationError("pathPrefix must be path-relative");
  }
  if (pathPrefix.includes("?") || pathPrefix.includes("#")) {
    throw new ValidationError("pathPrefix must not contain query strings or fragments");
  }
  for (const segment of pathPrefix.split("/")) {
    if (segment === "." || segment === "..") {
      throw new ValidationError("pathPrefix must not contain dot segments");
    }
  }
  return pathPrefix;
}

function webSessionPersistent(options = {}) {
  if (options.persistent === undefined || options.persistent === null) {
    return true;
  }
  if (typeof options.persistent !== "boolean") {
    throw new ValidationError("persistent must be a boolean");
  }
  return options.persistent;
}

function webSessionDropNotifyPath(options = {}) {
  if (options.dropNotifyPath === undefined || options.dropNotifyPath === null) {
    return undefined;
  }

  return webSessionPathPrefix({ pathPrefix: options.dropNotifyPath });
}

async function createWebSessionCapability(env, options = {}) {
  const pathPrefix = encodeURIComponent(webSessionPathPrefix(options));
  const persistent = webSessionPersistent(options) ? "true" : "false";
  const dropNotifyPath = webSessionDropNotifyPath(options);
  const notifyQuery = dropNotifyPath === undefined
    ? ""
    : `&dropNotifyPath=${encodeURIComponent(dropNotifyPath)}`;
  return wrapCapability(
    env, await postSandstorm(
      env, `capabilities/web-session?pathPrefix=${pathPrefix}&persistent=${persistent}` +
        notifyQuery));
}

async function createApiSessionCapability(env, options = {}) {
  const pathPrefix = encodeURIComponent(webSessionPathPrefix(options));
  const persistent = webSessionPersistent(options) ? "true" : "false";
  return wrapCapability(
    env, await postSandstorm(
      env, `capabilities/api-session?pathPrefix=${pathPrefix}&persistent=${persistent}`));
}

async function createAppObjectCapability(env, options = {}) {
  const pathPrefix = encodeURIComponent(webSessionPathPrefix(options));
  const persistent = webSessionPersistent(options) ? "true" : "false";
  const dropNotifyPath = webSessionDropNotifyPath(options);
  const notifyQuery = dropNotifyPath === undefined
    ? ""
    : `&dropNotifyPath=${encodeURIComponent(dropNotifyPath)}`;
  return wrapCapability(
    env, await postSandstorm(
      env, `capabilities/app-object?pathPrefix=${pathPrefix}&persistent=${persistent}` +
        notifyQuery));
}

function capabilityMethodName(value, name = "method") {
  const method = validate.string(value, name, { minLength: 1, maxLength: 256 });
  if (method === "constructor" || method === "prototype" || method === "__proto__") {
    throw new ValidationError(`${name} is not callable`);
  }
  if (method === "then") {
    throw new ValidationError(`${name} is reserved`);
  }
  return method;
}

function capabilityArgs(value, name = "args") {
  if (!Array.isArray(value)) {
    throw new ValidationError(`${name} must be an array`);
  }
  return value;
}

function objectCapabilityId(options = {}) {
  if (options.id === undefined || options.id === null) {
    return typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  return explicitObjectCapabilityId(options.id);
}

function explicitObjectCapabilityId(value, name = "object capability id") {
  const id = validate.string(value, name, {
    minLength: 1,
    maxLength: 256,
  });
  if (!/^[A-Za-z0-9._~-]+$/.test(id)) {
    throw new ValidationError(
      "object capability id may only contain URL-safe letters, digits, '.', '_', '~', and '-'");
  }
  return id;
}

function requiredObjectCapabilityId(options = {}) {
  if (options.id === undefined || options.id === null) {
    throw new ValidationError("registered object capabilities require an explicit id");
  }
  return explicitObjectCapabilityId(options.id);
}

function objectCapabilityPersistent(options = {}) {
  if (options.persistent === undefined || options.persistent === null) {
    return false;
  }
  if (typeof options.persistent !== "boolean") {
    throw new ValidationError("persistent must be a boolean");
  }
  if (options.persistent && (options.id === undefined || options.id === null)) {
    throw new ValidationError("persistent object capabilities require an explicit id");
  }
  return options.persistent;
}

function objectCapabilityPathPrefix(id) {
  return `${OBJECT_CAPABILITY_PREFIX}/${encodeURIComponent(id)}`;
}

function registerObjectCapabilityTarget(target, options = {}) {
  if (!target || typeof target !== "object") {
    throw new ValidationError("capability target must be an object");
  }

  const id = requiredObjectCapabilityId(options);
  const existing = exportedObjectTargets.get(id);
  if (existing === target) {
    return {
      ok: true,
      id,
      pathPrefix: objectCapabilityPathPrefix(id),
      registered: false,
    };
  }
  if (existing) {
    throw new ValidationError(`object capability id is already registered: ${id}`);
  }

  exportedObjectTargets.set(id, target);
  return {
    ok: true,
    id,
    pathPrefix: objectCapabilityPathPrefix(id),
    registered: true,
  };
}

function durableCapabilityRegistry(registry = {}) {
  if (registry === undefined || registry === null) {
    return new Map();
  }
  if (!isPlainObject(registry)) {
    failValidation("durable capability registry", "an object", registry);
  }

  const result = new Map();
  for (const [rawId, source] of Object.entries(registry)) {
    const id = explicitObjectCapabilityId(rawId, "durable capability registry id");
    result.set(id, source);
  }
  return result;
}

async function durableCapabilityRegistryTarget(request, env, registry, id) {
  if (!registry?.has(id)) {
    return undefined;
  }

  const source = registry.get(id);
  return typeof source === "function" ? await source(request, env) : source;
}

async function ensureDurableCapabilityRegistryTarget(request, env, registry, id) {
  const target = exportedObjectTargets.get(id) ||
    await durableCapabilityRegistryTarget(request, env, registry, id);
  if (!target) {
    return undefined;
  }

  registerObjectCapabilityTarget(target, { id });
  return target;
}

async function createObjectCapability(env, target, options = {}) {
  if (!target || typeof target !== "object") {
    throw new ValidationError("capability target must be an object");
  }

  const persistent = objectCapabilityPersistent(options);
  const id = objectCapabilityId(options);
  const registration = registerObjectCapabilityTarget(target, { id });
  if (!persistent && !registration.registered) {
    throw new ValidationError(
      "already registered object capability IDs can only be minted with api.exportDurable()");
  }

  try {
    const pathPrefix = objectCapabilityPathPrefix(id);
    const capability = await createAppObjectCapability(env, {
      pathPrefix,
      ...(persistent ? {} : { dropNotifyPath: pathPrefix }),
      persistent,
    });
    rememberObjectCapabilityHandle(id, capability.id);
    if (!persistent) {
      capabilityMetadata.set(capability.id, { transientObjectCapability: true });
    }
    return capability;
  } catch (error) {
    if (registration.registered) {
      exportedObjectTargets.delete(id);
      forgetObjectCapabilityHandles(id);
    }
    throw error;
  }
}

function publicObjectCapabilityOptions(options = {}) {
  const normalized = options ?? {};
  if (normalized.persistent !== undefined && normalized.persistent !== null) {
    throw new ValidationError(
      "api.export() always creates transient object capabilities; use api.exportDurable() " +
      "when an exported object needs a durable token.");
  }
  return { ...normalized, persistent: false };
}

async function exportObjectCapability(env, target, options = {}) {
  return createObjectCapability(env, target, publicObjectCapabilityOptions(options));
}

async function callCapability(capability, method, args = []) {
  method = capabilityMethodName(method);
  args = capabilityArgs(args);
  const info = await capabilityInfo(capability.env, capability);
  if (capabilitySupportsAppObjectCall(info)) {
    return callCapabilityWithNativeAppRpc(capability, method, args);
  }

  const nativeInterface = info?.nativeInterface || "unknown";
  throw new UnsupportedCapabilityError(
    nativeInterface,
    "rpc",
    `Capability nativeInterface ${nativeInterface} cannot be used with app-defined RPC`);
}

function disposeExportedObjectTarget(id) {
  const target = exportedObjectTargets.get(id);
  if (!target) {
    return false;
  }

  exportedObjectTargets.delete(id);
  forgetObjectCapabilityHandles(id);

  const disposer = target[Symbol.dispose];
  if (typeof disposer === "function") {
    disposer.call(target);
  }

  return true;
}

function missingDurableCapabilityMessage(id) {
  return `durable capability id is not registered: ${id}. ` +
    "Restore the capabilities registry entry, migrate the saved token, or revoke it.";
}

function missingDurableCapabilityError(id) {
  return {
    name: "MissingDurableCapability",
    message: missingDurableCapabilityMessage(id),
  };
}

function rememberObjectCapabilityHandle(objectId, capabilityId) {
  let ids = exportedObjectCapabilityIds.get(objectId);
  if (!ids) {
    ids = new Set();
    exportedObjectCapabilityIds.set(objectId, ids);
  }
  ids.add(capabilityId);
  objectCapabilityIds.set(capabilityId, objectId);
}

function forgetCapabilityHandle(capabilityId) {
  capabilityMetadata.delete(capabilityId);
  const objectId = objectCapabilityIds.get(capabilityId);
  if (!objectId) {
    return;
  }

  objectCapabilityIds.delete(capabilityId);
  const ids = exportedObjectCapabilityIds.get(objectId);
  if (ids) {
    ids.delete(capabilityId);
    if (ids.size === 0) {
      exportedObjectCapabilityIds.delete(objectId);
    }
  }
}

function forgetObjectCapabilityHandles(objectId) {
  const ids = exportedObjectCapabilityIds.get(objectId);
  if (!ids) {
    return;
  }

  for (const capabilityId of ids) {
    capabilityMetadata.delete(capabilityId);
    objectCapabilityIds.delete(capabilityId);
  }
  exportedObjectCapabilityIds.delete(objectId);
}

async function serveObjectCapability(request, env, registry = undefined) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${OBJECT_CAPABILITY_PREFIX}/`)) {
    return null;
  }

  const rest = url.pathname.slice(OBJECT_CAPABILITY_PREFIX.length + 1);
  const slash = rest.indexOf("/");
  const id = slash < 0 ? rest : rest.slice(0, slash);
  const action = slash < 0 ? "" : rest.slice(slash + 1);
  const objectId = decodeURIComponent(id);
  const target = await ensureDurableCapabilityRegistryTarget(request, env, registry, objectId);
  if (!target) {
    const error = missingDurableCapabilityError(objectId);
    if (request.method === "POST" && action === "native-app-rpc-call") {
      return Response.json(serializeNativeAppRpcException(error), { status: 404 });
    }
    return Response.json({
      ok: false,
      type: "missingDurableCapability",
      id: objectId,
      error: error.message,
    }, { status: 404 });
  }

  if (request.method === "POST" && action === "__sandstorm_dispose") {
    const disposed = disposeExportedObjectTarget(objectId);
    return Response.json({ ok: true, disposed });
  }

  if (request.method === "POST" && action === "native-app-rpc-call") {
    try {
      return Response.json(await dispatchNativeAppRpcCall(target, await request.json(), {
        exportCapabilitySlot: (value, context) =>
          exportCapabilityNativeAppRpcSlot(env, value, context),
        resolveCapabilitySlot: (slot) => new Capability(env, slot.id),
      }));
    } catch (error) {
      const status = error instanceof ValidationError ? 400 : 500;
      return Response.json(serializeNativeAppRpcException(error), { status });
    }
  }

  return Response.json({
    ok: false,
    error: "unsupported exported object capability request",
  }, { status: 405 });
}

function savedCapabilityToken(value, name = "token") {
  if (typeof value === "string") {
    const token = validate.string(value, name, { minLength: 1, maxLength: 4096 });
    if (!/^[A-Za-z0-9_-]+$/.test(token)) {
      throw new ValidationError(`${name} does not look like a saved capability token`);
    }
    return token;
  }

  throw new ValidationError(`${name} must be a saved capability token string`);
}

function savedCapabilityRecord(value, name = "saved capability") {
  if (!value || typeof value !== "object" || value.type !== "savedCapability") {
    failValidation(name, "a saved capability record", value);
  }

  return {
    ok: true,
    type: "savedCapability",
    id: validate.string(value.id, `${name}.id`, { minLength: 1, maxLength: 4096 }),
    token: savedCapabilityToken(value.token, `${name}.token`),
    tokenEncoding: validate.string(value.tokenEncoding || "base64url", `${name}.tokenEncoding`, {
      minLength: 1,
      maxLength: 32,
    }),
  };
}

const CAPABILITY_FETCH_HEADER_NAMES = new Set([
  "if-match",
  "if-none-match",
  "oc-total-length",
  "oc-chunk-size",
  "x-oc-mtime",
  "oc-fileid",
  "oc-chunked",
  "oc-checksum",
  "oc-chunk-offset",
  "oc-lazyops",
  "x-requested-with",
  "x-csrftoken",
  "x-csrf-token",
]);

const CAPABILITY_FETCH_HEADER_PREFIXES = [
  "x-sandstorm-app-",
  "x-hgarg-",
  "x-phabricator-",
];

function shouldForwardCapabilityFetchHeader(name) {
  name = String(name).toLowerCase();
  return CAPABILITY_FETCH_HEADER_NAMES.has(name) ||
    CAPABILITY_FETCH_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix));
}

async function restoreCapabilityToken(env, token) {
  const encodedToken = encodeURIComponent(savedCapabilityToken(token));
  const capability = await postPowerbox(env, `powerbox/restore?token=${encodedToken}`);
  return wrapCapability(env, capability);
}

async function revokeCapabilityToken(env, token) {
  const encodedToken = encodeURIComponent(savedCapabilityToken(token));
  return postPowerbox(env, `powerbox/drop-saved?token=${encodedToken}`);
}

async function useCapabilityToken(env, token, fn) {
  if (typeof fn !== "function") {
    failValidation("capability use callback", "a function", fn);
  }

  const capability = await restoreCapabilityToken(env, token);
  try {
    return await fn(capability);
  } finally {
    await capability.drop();
  }
}

async function fetchCapability(env, capability, input, init = {}) {
  const info = await capabilityInfo(env, capability);
  if (info?.nativeInterface === "outboundHttpSession" ||
      (info?.supportsOutboundHttpFetch === true && info?.supportsWebFetch === false)) {
    return fetchOutboundHttpSession(capability, input, init, info);
  }

  if (info?.supportsWebFetch === false || (
      info?.supportsWebFetch === undefined &&
      info?.nativeInterface === "outboundHttpSession")) {
    const nativeInterface = info?.nativeInterface || "unknown";
    throw new UnsupportedCapabilityError(
      nativeInterface,
      "fetch",
      `cap.fetch() is only for WebSession, ApiSession, and OutboundHttpSession capabilities; ` +
      `nativeInterface ${nativeInterface} cannot be fetched. Use cap.rpc or cap.call() ` +
      `for app-defined RPC capabilities`);
  }

  let request;
  if (input instanceof Request) {
    request = init === undefined ? input : new Request(input, init);
  } else {
    const url = new URL(String(input), "http://sandstorm-capability");
    request = new Request(url, init);
  }

  const url = new URL(request.url);
  if (url.origin !== "http://sandstorm-capability") {
    throw new ValidationError(
      `cap.fetch() on WebSession and ApiSession capabilities accepts only a relative path ` +
      `such as "/path?query"; absolute URLs are rejected`);
  }

  const params = new URLSearchParams({
    id: capabilityId(capability),
    method: request.method || "GET",
    path: `${url.pathname}${url.search}`,
  });
  const headers = {};
  const contentType = request.headers.get("content-type");
  if (contentType !== null) {
    headers["content-type"] = contentType;
  }
  for (const [name, value] of request.headers) {
    if (name !== "content-type" && shouldForwardCapabilityFetchHeader(name)) {
      params.append("headerName", name);
      params.append("headerValue", value);
    }
  }

  let body;
  if (request.method !== "GET" && request.method !== "HEAD" && request.body !== null) {
    body = await request.arrayBuffer();
  }

  return powerboxFetcher(env).fetch(
    `http://sandstorm/powerbox/fetch?${params}`,
    {
      method: "POST",
      headers,
      body,
    });
}

function outboundHttpSessionRequest(input, init = {}) {
  let request;
  if (input instanceof Request) {
    request = init === undefined ? input : new Request(input, init);
  } else {
    const url = new URL(String(input), "http://sandstorm-outbound/");
    request = new Request(url, init);
  }

  const url = new URL(request.url);
  if (url.origin !== "http://sandstorm-outbound") {
    throw new ValidationError(
      `cap.fetch() on OutboundHttpSession capabilities accepts only a relative path ` +
      `such as "v1/resource" or "/v1/resource"; absolute URLs are rejected because ` +
      `the capability descriptor supplies the origin`);
  }

  let path = url.pathname;
  while (path.startsWith("/")) {
    path = path.slice(1);
  }
  return { request, path: `${path}${url.search}` };
}

async function fetchOutboundHttpSession(capability, input, init = {}, info = undefined) {
  if (info === undefined) {
    info = await capabilityInfo(capability.env, capability);
  }
  if (info?.supportsOutboundHttpFetch === false || (
      info?.supportsOutboundHttpFetch === undefined &&
      info?.nativeInterface !== undefined &&
      info.nativeInterface !== "unknown" &&
      info.nativeInterface !== "outboundHttpSession")) {
    const nativeInterface = info?.nativeInterface || "unknown";
    throw new UnsupportedCapabilityError(
      nativeInterface,
      "fetch",
      `cap.fetch() on OutboundHttpSession capabilities cannot use nativeInterface ` +
      `${nativeInterface}; use app-defined RPC for appObject capabilities`);
  }

  const { request, path } = outboundHttpSessionRequest(input, init);
  const params = new URLSearchParams({
    id: capabilityId(capability),
    method: request.method || "GET",
    path,
  });
  const headers = {};
  let headerIndex = 0;
  for (const [name, value] of request.headers) {
    params.append("headerName", name);
    headers[`x-sandstorm-outbound-header-${headerIndex++}`] = value;
  }

  let body;
  if (request.method !== "GET" && request.method !== "HEAD" && request.body !== null) {
    body = await request.arrayBuffer();
  }

  return powerboxFetcher(capability.env).fetch(
    `http://sandstorm/powerbox/outbound-http-fetch?${params}`,
    {
      method: "POST",
      headers,
      body,
    });
}

function wrapCapability(env, capability) {
  if (capability instanceof Capability) {
    return capability;
  }
  if (!capability || typeof capability !== "object" ||
      (capability.type !== "capability" && capability.type !== "claimedCapability") ||
      typeof capability.id !== "string") {
    return capability;
  }

  return new Capability(env, capability.id);
}

function permissionNames(options = {}) {
  if (options.requiredPermissions === undefined || options.requiredPermissions === null) {
    return [];
  }

  if (!Array.isArray(options.requiredPermissions)) {
    throw new ValidationError("requiredPermissions must be an array of permission names");
  }

  return options.requiredPermissions.map((permission, index) => {
    const name = validate.string(permission, `requiredPermissions[${index}]`, {
      minLength: 1,
      maxLength: 128,
    });
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
      throw new ValidationError(`requiredPermissions[${index}] is not a valid permission name`);
    }
    return name;
  });
}

async function validateRequiredPermissions(env, names) {
  if (names.length === 0) return;

  const declared = await callSandstormApi(env, "permissions");
  const declaredNames = Array.isArray(declared.permissions)
    ? declared.permissions.map((permission) => permission.name).filter((name) => typeof name === "string")
    : [];
  const declaredSet = new Set(declaredNames);
  const unknown = names.filter((name) => !declaredSet.has(name));
  if (unknown.length > 0) {
    throw new ValidationError(
      `unknown required permission: ${unknown[0]}; this app defines permissions: ` +
      `${declaredNames.length > 0 ? declaredNames.join(", ") : "(none)"}. ` +
      "requiredPermissions must use names from this app's viewInfo.permissions.");
  }
}

function durableObjectCapabilityStorageKey(options = {}) {
  const key = options.storageKey ?? options.key;
  return key === undefined || key === null ? undefined : validate.storageKey(key, "storageKey");
}

async function durableObjectCapability(env, target, options = {}) {
  const id = requiredObjectCapabilityId(options);
  const registration = registerObjectCapabilityTarget(target, { id });
  const key = durableObjectCapabilityStorageKey(options);
  if (key !== undefined) {
    const storedToken = await storage(env).get(key);
    if (storedToken) {
      return {
        ok: true,
        id,
        storageKey: key,
        registered: registration.registered,
        restored: true,
        capability: await restoreCapabilityToken(env, storedToken),
        token: storedToken,
      };
    }
  }

  const capability = await createObjectCapability(env, target, {
    id,
    persistent: true,
  });
  const token = await saveCapability(env, capability, options);
  if (key !== undefined) {
    await storage(env).put(key, token);
    return {
      ok: true,
      id,
      storageKey: key,
      registered: registration.registered,
      restored: false,
      capability,
      token,
    };
  }

  return {
    ok: true,
    id,
    registered: registration.registered,
    restored: false,
    capability,
    token,
  };
}

function publicDurableCapabilityResult(result) {
  return result;
}

async function exportDurableCapability(env, target, options = {}) {
  requiredSaveLabel(options, "exportDurable label");
  return publicDurableCapabilityResult(await durableObjectCapability(env, target, options));
}

async function withExportedCapability(env, target, fn, options = {}) {
  if (typeof fn !== "function") {
    failValidation("withExport callback", "a function", fn);
  }

  const capability = await exportObjectCapability(env, target, options);
  try {
    return await fn(capability);
  } finally {
    await capability.drop();
  }
}

export function powerbox(request, env) {
  const claimToken = async (token, options = {}) => {
    token = validate.string(token, "token", { minLength: 1, maxLength: 4096 });
    const requiredPermissions = permissionNames(options);
    await validateRequiredPermissions(env, requiredPermissions);
    const params = new URLSearchParams({
      sessionId: sessionIdForPowerbox(request),
      token,
    });
    for (const name of requiredPermissions) {
      params.append("requiredPermission", name);
    }
    for (const [name, value] of powerboxDescriptorParams(options)) {
      params.append(name, value);
    }
    for (const [name, value] of claimNativeInterfaceParams(options)) {
      params.append(name, value);
    }
    const capability = await postPowerbox(env,
      `powerbox/claim-request?${params}`);
    return wrapCapability(env, capability);
  };

  return {
    async apiSessionDescriptor(options = {}) {
      return apiSessionPowerboxDescriptor(env, options);
    },

    async outboundHttpDescriptor(options = {}) {
      return outboundHttpPowerboxDescriptor(env, options);
    },

    async claim(result, options = {}) {
      if (typeof result === "string") {
        return claimToken(result, options);
      }

      if (!result || typeof result !== "object") {
        throw new ValidationError("Powerbox claim result must be a token string or result object");
      }

      if (result.capability) {
        return new Capability(env, capabilityId(result.capability));
      }

      if (typeof result.token === "string") {
        return claimToken(result.token, options);
      }

      throw new ValidationError("Powerbox claim result must contain token or capability");
    },

    offered() {
      const id = header(request, "x-sandstorm-offered-capability-id");
      const capability = id ? new Capability(env, id) : undefined;
      if (!capability) {
        return undefined;
      }
      return {
        capability,
        id: capability.id,
        descriptor: jsonHeader(request, "x-sandstorm-offer-descriptor"),
      };
    },

    async offer() {
      if (arguments.length < 1) {
        unsupportedPowerbox("offer");
      }
      return offerCapability(env, request, arguments[0], arguments[1] || {});
    },

    async fulfillRequest() {
      if (arguments.length < 1) {
        unsupportedPowerbox("fulfillRequest");
      }
      return fulfillRequestWithCapability(env, request, arguments[0], arguments[1] || {});
    },

    async tieToUser() {
      if (arguments.length < 1) {
        unsupportedPowerbox("tieToUser");
      }
      return tieCapabilityToUser(env, request, arguments[0], arguments[1] || {});
    },

  };
}

export function getSession(request) {
  return {
    sessionType: header(request, "x-sandstorm-session-type"),
    user: {
      displayName: header(request, "x-sandstorm-username"),
      id: header(request, "x-sandstorm-user-id"),
      preferredHandle: header(request, "x-sandstorm-preferred-handle"),
      pictureUrl: header(request, "x-sandstorm-user-picture"),
      pronouns: header(request, "x-sandstorm-user-pronouns"),
    },
    permissions: list(header(request, "x-sandstorm-permissions")),
    request: {
      sessionId: header(request, "x-sandstorm-session-id"),
      tabId: header(request, "x-sandstorm-tab-id"),
      basePath: header(request, "x-sandstorm-base-path"),
      offeredCapabilityId: header(request, "x-sandstorm-offered-capability-id"),
      host: header(request, "host"),
      forwardedProto: header(request, "x-forwarded-proto"),
      userAgent: header(request, "user-agent"),
      acceptableLanguages: list(header(request, "accept-language")),
    },
    offer: {
      id: header(request, "x-sandstorm-offered-capability-id"),
      descriptor: jsonHeader(request, "x-sandstorm-offer-descriptor"),
    },
  };
}

class StorageRpcTarget extends RpcTarget {
  #env;

  constructor(env) {
    super();
    this.#env = env;
  }

  put(key, value) {
    return storage(this.#env).put(key, value);
  }

  putJson(key, value) {
    return storage(this.#env).putJson(key, value);
  }

  get(key) {
    return storage(this.#env).get(key);
  }

  getBytes(key) {
    return storage(this.#env).getBytes(key);
  }

  getJson(key) {
    return storage(this.#env).getJson(key);
  }

  head(key) {
    return storage(this.#env).head(key);
  }

  delete(key) {
    return storage(this.#env).delete(key);
  }

  list() {
    return storage(this.#env).list();
  }
}

class PowerboxRpcTarget extends RpcTarget {
  #request;
  #env;

  constructor(request, env) {
    super();
    this.#request = request;
    this.#env = env;
  }

  async apiSessionDescriptor(options) {
    return powerbox(this.#request, this.#env).apiSessionDescriptor(options || {});
  }

  async outboundHttpDescriptor(options) {
    return powerbox(this.#request, this.#env).outboundHttpDescriptor(options || {});
  }

  async claim(result, options) {
    return powerbox(this.#request, this.#env).claim(result, options || {});
  }

  offered() {
    return powerbox(this.#request, this.#env).offered();
  }

  async offer() {
    if (arguments.length < 1) {
      unsupportedPowerbox("offer");
    }
    return powerbox(this.#request, this.#env).offer(arguments[0], arguments[1] || {});
  }

  async fulfillRequest() {
    if (arguments.length < 1) {
      unsupportedPowerbox("fulfillRequest");
    }
    return powerbox(this.#request, this.#env).fulfillRequest(arguments[0], arguments[1] || {});
  }

  async tieToUser() {
    if (arguments.length < 1) {
      unsupportedPowerbox("tieToUser");
    }
    return powerbox(this.#request, this.#env).tieToUser(arguments[0], arguments[1] || {});
  }

}

class SandstormRpcTarget extends RpcTarget {
  #request;
  #env;

  constructor(request, env) {
    super();
    this.#request = request;
    this.#env = env;
  }

  session() {
    return getSession(this.#request);
  }

  status() {
    return callSandstorm(this.#env, "status");
  }

  capabilities() {
    return callSandstorm(this.#env, "capabilities");
  }

  runtime() {
    return callSandstorm(this.#env, "runtime");
  }

  modules() {
    return callSandstorm(this.#env, "modules");
  }

  bindings() {
    return callSandstorm(this.#env, "bindings");
  }

  storage() {
    return new StorageRpcTarget(this.#env);
  }

  powerbox() {
    return new PowerboxRpcTarget(this.#request, this.#env);
  }

  webSession(options = {}) {
    return createWebSessionCapability(this.#env, options);
  }

  apiSession(options = {}) {
    return createApiSessionCapability(this.#env, options);
  }

  restore(token) {
    return restoreCapabilityToken(this.#env, token);
  }

  revoke(token) {
    return revokeCapabilityToken(this.#env, token);
  }

  use(token, fn) {
    return useCapabilityToken(this.#env, token, fn);
  }

  ["export"](target, options = {}) {
    return exportObjectCapability(this.#env, target, options);
  }

  withExport(target, fn, options = {}) {
    return withExportedCapability(this.#env, target, fn, options);
  }

  exportDurable(target, options = {}) {
    return exportDurableCapability(this.#env, target, options);
  }

}

export function apiTarget(request, env) {
  return new SandstormRpcTarget(request, env);
}

export function rpcClientScript() {
  return browserClientScript();
}

export function rpcResponse(request, target, options) {
  return newWorkersRpcResponse(request, target, options);
}

function resolveRpcTarget(target) {
  return typeof target === "function" ? target() : target;
}

export function serveRpc(request, target, options = {}) {
  const url = new URL(request.url);
  const {
    clientScriptPath = "/rpc-client.js",
    rpcPath = "/rpc",
    ...rpcOptions
  } = options;
  if (url.pathname === clientScriptPath) {
    return new Response(rpcClientScript(), {
      headers: { "content-type": "text/javascript; charset=utf-8" },
    });
  }

  if (url.pathname === rpcPath) {
    return Promise.resolve(resolveRpcTarget(target))
      .then((resolvedTarget) => rpcResponse(request, resolvedTarget, rpcOptions));
  }

  return null;
}

function isObjectCapabilityRequest(request) {
  return new URL(request.url).pathname.startsWith(`${OBJECT_CAPABILITY_PREFIX}/`);
}

function isPowerboxDescriptorRequest(request) {
  return new URL(request.url).pathname.startsWith(`${POWERBOX_DESCRIPTOR_PREFIX}/`);
}

export function sandstorm(request, env, options = {}) {
  const durableRegistry = durableCapabilityRegistry(options.capabilities);

  const exportDurable = async (targetOrId, durableOptions = {}) => {
    if (typeof targetOrId === "string") {
      const id = explicitObjectCapabilityId(targetOrId);
      const target = exportedObjectTargets.get(id) ||
        await durableCapabilityRegistryTarget(request, env, durableRegistry, id);
      if (!target) {
        throw new ValidationError(missingDurableCapabilityMessage(id));
      }
      return exportDurableCapability(env, target, { ...durableOptions, id });
    }

    return exportDurableCapability(env, targetOrId, durableOptions);
  };

  return {
    session: () => getSession(request),
    status: () => callSandstorm(env, "status"),
    capabilities: () => callSandstorm(env, "capabilities"),
    runtime: () => callSandstorm(env, "runtime"),
    modules: () => callSandstorm(env, "modules"),
    bindings: () => callSandstorm(env, "bindings"),
    storage: () => storage(env),
    powerbox: () => powerbox(request, env),
    webSession: (options = {}) => createWebSessionCapability(env, options),
    apiSession: (options = {}) => createApiSessionCapability(env, options),
    restore: (token) => restoreCapabilityToken(env, token),
    revoke: (token) => revokeCapabilityToken(env, token),
    use: (token, fn) => useCapabilityToken(env, token, fn),
    export: (target, options = {}) => exportObjectCapability(env, target, options),
    withExport: (target, fn, options = {}) => withExportedCapability(env, target, fn, options),
    exportDurable,
    powerboxFulfillment: (options = {}) => powerboxFulfillment(request, env, options),
    powerboxGrants: (options = {}) => powerboxGrants(request, env, options),
    serveSystemRoutes: async () => await servePowerboxDescriptors(request, env) ||
      await serveObjectCapability(request, env, durableRegistry),
    apiTarget: () => apiTarget(request, env),
    rpcClientScript: () => rpcClientScript(),
    rpcResponse: (target, options) => rpcResponse(request, target, options),
    serveRpc: (target, options) => {
      if (isPowerboxDescriptorRequest(request) || isObjectCapabilityRequest(request)) {
        return (async () => await servePowerboxDescriptors(request, env) ||
          await serveObjectCapability(request, env, durableRegistry))();
      }
      return serveRpc(request, target, options);
    },
  };
}
