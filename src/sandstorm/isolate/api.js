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
const exportedObjectTargets = new Map();
const exportedObjectCapabilityIds = new Map();
const objectCapabilityIds = new Map();
const claimedCapabilityMetadata = new Map();

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

async function queryClaimedCapabilityInfo(env, id) {
  const response = await env.SANDSTORM_API.fetch(
    `http://sandstorm/capabilities/claimed?id=${encodeURIComponent(id)}`);
  const body = await parseApiResponseBody(response);
  if (!response.ok || !body.ok) {
    return null;
  }
  const metadata = claimedCapabilityMetadata.get(id) || {};
  claimedCapabilityMetadata.set(id, { ...metadata, ...body });
  return body;
}

async function claimedCapabilityInfo(env, capability, options = {}) {
  const id = capabilityId(capability);
  if (!options.refresh) {
    const cached = claimedCapabilityMetadata.get(id);
    if (cached?.type === "claimedCapabilityInfo") {
      return cached;
    }
  }
  return queryClaimedCapabilityInfo(env, id);
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
  constructor(capability, operation) {
    super(`${capability}.${operation}() is not implemented by isolate grains yet`);
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

export function serializeNativeAppRpcValue(value, name = "value") {
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
      value: value.map((item, index) => serializeNativeAppRpcValue(item, `${name}[${index}]`)),
    };
  }
  if (value && typeof value === "object" && value.type === "nativeCapabilitySlot") {
    const slot = {
      id: validate.string(value.id, `${name}.id`, { minLength: 1, maxLength: 256 }),
    };
    if (value.nativeInterface !== undefined && value.nativeInterface !== null) {
      slot.nativeInterface = validate.string(
        value.nativeInterface, `${name}.nativeInterface`, { minLength: 1 });
    }
    return { type: "capability", value: slot };
  }
  if (value instanceof RpcTarget || value instanceof ClaimedCapability) {
    throw new ValidationError(
      `${name} must be exported to a native capability slot before native app RPC serialization`);
  }
  if (!isPlainObject(value)) {
    failValidation(name, "a native app RPC value", value);
  }

  const fields = [];
  for (const [key, item] of Object.entries(value)) {
    const fieldName = nativeAppRpcObjectFieldName(key, `${name} field name`);
    fields.push({
      name: fieldName,
      value: serializeNativeAppRpcValue(item, `${name}.${fieldName}`),
    });
  }
  return { type: "object", value: fields };
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

export function serializeNativeAppRpcException(error) {
  return {
    type: "exception",
    name: String(error?.name || "Error"),
    message: String(error?.message || error),
    stack: String(error?.stack || ""),
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
      const errorName = validate.string(result.name || "Error", `${name}.name`);
      const message = validate.string(result.message || "", `${name}.message`);
      const stack = validate.string(result.stack || "", `${name}.stack`);
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
    return serializeNativeAppRpcResult(await func.apply(target, args));
  } catch (error) {
    return serializeNativeAppRpcException(error);
  }
}

const NATIVE_APP_RPC_STUB_OWN_PROPERTIES = new Set([
  "slot",
  "call",
  "asRpc",
  "toJSON",
]);

export class NativeAppRpcStub {
  #slot;
  #transport;
  #hydrationOptions;

  constructor(slot, transport, options = {}) {
    if (typeof transport !== "function") {
      throw new ValidationError("native app RPC transport must be a function");
    }

    this.#slot = nativeCapabilitySlot(slot?.id, {
      nativeInterface: slot?.nativeInterface,
    });
    this.#transport = transport;
    this.#hydrationOptions = nativeAppRpcHydrationContext(options, "result");
  }

  get slot() {
    return this.#slot;
  }

  async call(method, ...args) {
    const result = await this.#transport(this.#slot, serializeNativeAppRpcCall(method, args));
    return hydrateNativeAppRpcResult(result, this.#hydrationOptions);
  }

  asRpc() {
    return createNativeAppRpcProxy(this);
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
        return Reflect.get(target, prop, receiver);
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
    const response = await fetcher.fetch(validate.string(url, "native app RPC route"), {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(call),
    });
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

    return result;
  };
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

  if (value && typeof value === "object" && value.type === "claimedCapability") {
    return validate.string(value.id, `${name}.id`, { minLength: 1, maxLength: 4096 });
  }

  throw new ValidationError(`${name} must be a claimed capability handle or id string`);
}

export class ClaimedCapability {
  #env;

  constructor(env, id) {
    this.#env = env;
    this.ok = true;
    this.type = "claimedCapability";
    this.id = validate.string(id, "capability.id", { minLength: 1, maxLength: 4096 });
  }

  get env() {
    return this.#env;
  }

  fetch(input, init) {
    return fetchClaimedCapability(this.#env, this, input, init);
  }

  call(method, ...args) {
    return callClaimedCapability(this, method, args);
  }

  asRpc() {
    return createCapabilityRpcStub(this);
  }

  asOutboundHttp() {
    return new OutboundHttpCapability(this);
  }

  info(options = {}) {
    return claimedCapabilityInfo(this.#env, this, options);
  }

  save(options = {}) {
    return saveClaimedCapability(this.#env, this, options);
  }

  dup() {
    return duplicateClaimedCapability(this.#env, this);
  }

  async drop() {
    const result = await postPowerbox(
      this.#env, `powerbox/drop?id=${encodeURIComponent(this.id)}`);
    forgetClaimedCapabilityHandle(this.id);
    return result;
  }

  offer(request, options = {}) {
    return offerClaimedCapability(this.#env, request, this, options);
  }

  fulfillRequest(request, options = {}) {
    return fulfillRequestWithCapability(this.#env, request, this, options);
  }

  tieToUser(request, options = {}) {
    return tieClaimedCapabilityToUser(this.#env, request, this, options);
  }

  [Symbol.dispose]() {
    this.drop().catch(() => {});
  }

  toJSON() {
    return {
      ok: true,
      type: "claimedCapability",
      id: this.id,
    };
  }
}

export class OutboundHttpCapability {
  constructor(capability) {
    this.ok = true;
    this.type = "outboundHttpCapability";
    this.capability = wrapClaimedCapability(capability.env, capability);
    this.id = this.capability.id;
  }

  fetch(input, init) {
    return fetchOutboundHttpCapability(this.capability, input, init);
  }

  toJSON() {
    return {
      ok: true,
      type: "outboundHttpCapability",
      id: this.id,
      capability: this.capability.toJSON(),
    };
  }
}

export class SavedCapability {
  #env;

  constructor(env, id, token, tokenEncoding = "base64url") {
    this.#env = env;
    this.ok = true;
    this.type = "savedCapability";
    this.id = validate.string(id, "savedCapability.id", { minLength: 1, maxLength: 4096 });
    this.token = savedCapabilityToken(token, "savedCapability.token");
    this.tokenEncoding = validate.string(tokenEncoding, "savedCapability.tokenEncoding", {
      minLength: 1,
      maxLength: 32,
    });
  }

  restore() {
    return restoreSavedCapability(this.#env, this);
  }

  drop() {
    return dropSavedCapability(this.#env, this);
  }

  toJSON() {
    return {
      ok: true,
      type: "savedCapability",
      id: this.id,
      token: this.token,
      tokenEncoding: this.tokenEncoding,
    };
  }
}

function saveLabel(options = {}) {
  let label = options.label ?? options.saveLabel ?? "Claimed Sandstorm capability";
  if (label && typeof label === "object" && typeof label.defaultText === "string") {
    label = label.defaultText;
  }
  return validate.string(label, "label", { minLength: 1, maxLength: 256 });
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

async function saveClaimedCapability(env, capability, options = {}) {
  const rawId = capabilityId(capability);
  const metadata = claimedCapabilityMetadata.get(rawId);
  if (metadata?.transientObjectCapability) {
    throw new Error(
      "JavaScript object capabilities are transient and cannot be saved yet. " +
      "Export a route-backed WebSession or ApiSession capability for persistence.");
  }

  const id = encodeURIComponent(rawId);
  const label = encodeURIComponent(saveLabel(options));
  return wrapSavedCapability(env, await postPowerbox(env, `powerbox/save?id=${id}&label=${label}`));
}

function duplicateLocalClaimedCapabilityMetadata(metadata) {
  if (!metadata?.transientObjectCapability) {
    return undefined;
  }
  return { transientObjectCapability: true };
}

async function duplicateClaimedCapability(env, capability) {
  const sourceId = capabilityId(capability);
  const duplicated = wrapClaimedCapability(
    env, await postPowerbox(env, `powerbox/dup?id=${encodeURIComponent(sourceId)}`));
  const metadata = duplicateLocalClaimedCapabilityMetadata(claimedCapabilityMetadata.get(sourceId));
  if (metadata) {
    claimedCapabilityMetadata.set(duplicated.id, metadata);
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

async function offerClaimedCapability(env, request, capability, options = {}) {
  return sessionPowerboxAction(env, request, "offer", capability, options);
}

async function fulfillRequestWithCapability(env, request, capability, options = {}) {
  return sessionPowerboxAction(env, request, "fulfill-request", capability, options);
}

async function tieClaimedCapabilityToUser(env, request, capability, options = {}) {
  return wrapClaimedCapability(
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
      const capability = await powerbox(request, env).claimRequest(body.token, {
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
  return wrapClaimedCapability(
    env, await postSandstorm(
      env, `capabilities/web-session?pathPrefix=${pathPrefix}&persistent=${persistent}` +
        notifyQuery));
}

async function createApiSessionCapability(env, options = {}) {
  const pathPrefix = encodeURIComponent(webSessionPathPrefix(options));
  const persistent = webSessionPersistent(options) ? "true" : "false";
  return wrapClaimedCapability(
    env, await postSandstorm(
      env, `capabilities/api-session?pathPrefix=${pathPrefix}&persistent=${persistent}`));
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

function unregisterObjectCapabilityTarget(options = {}) {
  const id = typeof options === "string"
    ? explicitObjectCapabilityId(options)
    : requiredObjectCapabilityId(options);
  return {
    ok: true,
    id,
    disposed: disposeExportedObjectTarget(id),
  };
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
      "already registered object capability IDs can only be minted with persistent: true");
  }

  try {
    const pathPrefix = objectCapabilityPathPrefix(id);
    const capability = await createWebSessionCapability(env, {
      pathPrefix,
      ...(persistent ? {} : { dropNotifyPath: pathPrefix }),
      persistent,
    });
    rememberObjectCapabilityHandle(id, capability.id);
    if (!persistent) {
      claimedCapabilityMetadata.set(capability.id, { transientObjectCapability: true });
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

async function callClaimedCapability(capability, method, args = []) {
  method = capabilityMethodName(method);
  args = capabilityArgs(args);
  const temporaryCapabilities = [];
  try {
    const serializedArgs = await serializeCapabilityValue(capability.env, args, {
      allowLocalCapabilityHandles: objectCapabilityIds.has(capability.id),
      temporaryCapabilities,
    });
    const response = await capability.fetch("/call", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ method, args: serializedArgs }),
    });
    const text = await response.text();
    let body;
    try {
      body = text.length > 0 ? JSON.parse(text) : {};
    } catch (error) {
      throw new CapabilityCallError(
        `capability call ${method} returned non-JSON response with status ${response.status}`,
        { status: response.status, body: text });
    }

    if (!response.ok || !body.ok) {
      throw new CapabilityCallError(body.error || `capability call ${method} failed`, {
        status: response.status,
        body,
      });
    }

    return wrapCapabilityValue(capability.env, body.result);
  } finally {
    await Promise.all(temporaryCapabilities.map((cap) => cap.drop().catch(() => {})));
  }
}

const CLAIMED_CAPABILITY_RPC_OWN_PROPERTIES = new Set([
  "ok",
  "type",
  "id",
  "env",
  "fetch",
  "call",
  "asRpc",
  "asOutboundHttp",
  "info",
  "dup",
  "save",
  "drop",
  "offer",
  "fulfillRequest",
  "tieToUser",
  "toJSON",
]);

function wrapRpcStubValue(value) {
  if (value instanceof ClaimedCapability) {
    return value.asRpc();
  }
  if (Array.isArray(value)) {
    return value.map((item) => wrapRpcStubValue(item));
  }
  if (!value || typeof value !== "object" || value instanceof SavedCapability) {
    return value;
  }

  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = wrapRpcStubValue(item);
  }
  return result;
}

function createCapabilityRpcStub(capability) {
  return new Proxy(capability, {
    get(target, prop, receiver) {
      if (typeof prop !== "string" ||
          CLAIMED_CAPABILITY_RPC_OWN_PROPERTIES.has(prop) ||
          prop in target) {
        return Reflect.get(target, prop, receiver);
      }
      if (prop === "then") {
        return undefined;
      }
      return async (...args) => wrapRpcStubValue(await target.call(prop, ...args));
    },
  });
}

function wrapCapabilityValue(env, value) {
  if (Array.isArray(value)) {
    return value.map((item) => wrapCapabilityValue(env, item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  if (value.type === "claimedCapability") {
    return wrapClaimedCapability(env, value);
  }
  if (value.type === "savedCapability") {
    return wrapSavedCapability(env, value);
  }

  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = wrapCapabilityValue(env, item);
  }
  return result;
}

async function serializeCapabilityValue(env, value, options = {}) {
  if (value instanceof RpcTarget) {
    if (!options.allowLocalCapabilityHandles) {
      throw new ValidationError(
        "RpcTarget callback arguments cannot be passed to remote app-defined RPC calls yet; " +
        "export a persistent object capability, save it, and pass the saved token instead");
    }
    const capability = await createObjectCapability(env, value);
    options.temporaryCapabilities?.push(capability);
    return capability;
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => serializeCapabilityValue(env, item, options)));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (value instanceof ClaimedCapability) {
    if (!options.allowLocalCapabilityHandles) {
      const info = await claimedCapabilityInfo(env, value);
      const nativeState = info
        ? ` supervisor reports hasNativeCapability=${info.hasNativeCapability}, ` +
          `liveForwardable=${info.liveForwardable}, ` +
          `supportsNativeAppRpcTransport=${info.supportsNativeAppRpcTransport};`
        : " supervisor has no claimed-capability metadata for this handle;";
      throw new ValidationError(
        "ClaimedCapability handles cannot be passed to remote app-defined RPC calls yet;" +
        nativeState +
        " native app-defined RPC transport is not implemented yet. " +
        "Pass a SavedCapability token or saved token string and have the receiver restore it.");
    }
    return value.toJSON();
  }
  if (value instanceof SavedCapability) {
    return value.toJSON();
  }
  if (value.type === "claimedCapability" && typeof value.id === "string") {
    if (!options.allowLocalCapabilityHandles) {
      const info = await claimedCapabilityInfo(env, value);
      const nativeState = info
        ? ` supervisor reports hasNativeCapability=${info.hasNativeCapability}, ` +
          `liveForwardable=${info.liveForwardable}, ` +
          `supportsNativeAppRpcTransport=${info.supportsNativeAppRpcTransport};`
        : " supervisor has no claimed-capability metadata for this handle;";
      throw new ValidationError(
        "claimed capability handles cannot be passed to remote app-defined RPC calls yet;" +
        nativeState +
        " native app-defined RPC transport is not implemented yet. " +
        "Pass a saved capability token instead.");
    }
    return {
      type: "claimedCapability",
      id: value.id,
    };
  }

  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = await serializeCapabilityValue(env, item, options);
  }
  return result;
}

function hydrateCapabilityValue(env, value) {
  if (Array.isArray(value)) {
    return value.map((item) => hydrateCapabilityValue(env, item));
  }
  return wrapCapabilityValue(env, value);
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

function rememberObjectCapabilityHandle(objectId, capabilityId) {
  let ids = exportedObjectCapabilityIds.get(objectId);
  if (!ids) {
    ids = new Set();
    exportedObjectCapabilityIds.set(objectId, ids);
  }
  ids.add(capabilityId);
  objectCapabilityIds.set(capabilityId, objectId);
}

function forgetClaimedCapabilityHandle(capabilityId) {
  claimedCapabilityMetadata.delete(capabilityId);
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
    claimedCapabilityMetadata.delete(capabilityId);
    objectCapabilityIds.delete(capabilityId);
  }
  exportedObjectCapabilityIds.delete(objectId);
}

async function serveObjectCapability(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${OBJECT_CAPABILITY_PREFIX}/`)) {
    return null;
  }

  const rest = url.pathname.slice(OBJECT_CAPABILITY_PREFIX.length + 1);
  const slash = rest.indexOf("/");
  const id = slash < 0 ? rest : rest.slice(0, slash);
  const action = slash < 0 ? "" : rest.slice(slash + 1);
  const target = exportedObjectTargets.get(decodeURIComponent(id));
  if (!target) {
    return Response.json({
      ok: false,
      error: "unknown exported object capability",
    }, { status: 404 });
  }

  if (request.method === "POST" && action === "__sandstorm_dispose") {
    const disposed = disposeExportedObjectTarget(decodeURIComponent(id));
    return Response.json({ ok: true, disposed });
  }

  if (request.method === "POST" && action === "native-app-rpc-call") {
    try {
      return Response.json(await dispatchNativeAppRpcCall(target, await request.json()));
    } catch (error) {
      const status = error instanceof ValidationError ? 400 : 500;
      return Response.json(serializeNativeAppRpcException(error), { status });
    }
  }

  if (request.method !== "POST" || action !== "call") {
    return Response.json({
      ok: false,
      error: "unsupported exported object capability request",
    }, { status: 405 });
  }

  let call;
  try {
    call = await request.json();
    const method = capabilityMethodName(call.method);
    const args = capabilityArgs(call.args || [])
      .map((arg) => hydrateCapabilityValue(env, arg));
    const func = target[method];
    if (typeof func !== "function") {
      return Response.json({
        ok: false,
        error: `RPC method not found: ${method}`,
      }, { status: 404 });
    }

    const result = await func.apply(target, args);
    return Response.json({
      ok: true,
      result: await serializeCapabilityValue(env, result, {
        allowLocalCapabilityHandles: true,
      }),
    });
  } catch (error) {
    const status = error instanceof ValidationError ? 400 : 500;
    return Response.json({
      ok: false,
      error: String(error?.message || error),
      name: String(error?.name || "Error"),
    }, { status });
  }
}

function savedCapabilityToken(value, name = "token") {
  if (typeof value === "string") {
    const token = validate.string(value, name, { minLength: 1, maxLength: 4096 });
    if (!/^[A-Za-z0-9_-]+$/.test(token)) {
      throw new ValidationError(`${name} must be base64url text`);
    }
    return token;
  }

  if (value instanceof Uint8Array) {
    let binary = "";
    for (let i = 0; i < value.length; i += 0x8000) {
      binary += String.fromCharCode(...value.slice(i, i + 0x8000));
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  if (value && typeof value === "object" && value.type === "savedCapability") {
    return savedCapabilityToken(value.token, `${name}.token`);
  }

  throw new ValidationError(`${name} must be a saved capability token`);
}

const CLAIMED_CAPABILITY_FETCH_HEADER_NAMES = new Set([
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

const CLAIMED_CAPABILITY_FETCH_HEADER_PREFIXES = [
  "x-sandstorm-app-",
  "x-hgarg-",
  "x-phabricator-",
];

function shouldForwardClaimedCapabilityFetchHeader(name) {
  name = String(name).toLowerCase();
  return CLAIMED_CAPABILITY_FETCH_HEADER_NAMES.has(name) ||
    CLAIMED_CAPABILITY_FETCH_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix));
}

async function restoreSavedCapability(env, token) {
  const encodedToken = encodeURIComponent(savedCapabilityToken(token));
  const capability = await postPowerbox(env, `powerbox/restore?token=${encodedToken}`);
  return wrapClaimedCapability(env, capability);
}

async function dropSavedCapability(env, token) {
  const encodedToken = encodeURIComponent(savedCapabilityToken(token));
  return postPowerbox(env, `powerbox/drop-saved?token=${encodedToken}`);
}

async function fetchClaimedCapability(env, capability, input, init = {}) {
  const info = await claimedCapabilityInfo(env, capability);
  if (info?.supportsWebFetch === false || (
      info?.supportsWebFetch === undefined &&
      info?.nativeInterface === "outboundHttpSession")) {
    const nativeInterface = info?.nativeInterface || "unknown";
    const hint = nativeInterface === "outboundHttpSession"
      ? "use asOutboundHttp().fetch() instead"
      : "use a compatible app-defined RPC transport instead";
    throw new ValidationError(
      `ClaimedCapability nativeInterface ${nativeInterface} cannot be used with fetch(); ${hint}`);
  }

  let request;
  if (input instanceof Request) {
    request = init === undefined ? input : new Request(input, init);
  } else {
    const url = new URL(String(input), "http://sandstorm-capability");
    request = new Request(url, init);
  }

  const url = new URL(request.url);
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
    if (name !== "content-type" && shouldForwardClaimedCapabilityFetchHeader(name)) {
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

function outboundHttpRequest(input, init = {}) {
  let request;
  if (input instanceof Request) {
    request = init === undefined ? input : new Request(input, init);
  } else {
    const url = new URL(String(input), "http://sandstorm-outbound/");
    request = new Request(url, init);
  }

  const url = new URL(request.url);
  if (url.origin !== "http://sandstorm-outbound") {
    throw new ValidationError("outbound HTTP fetch input must be a relative path");
  }

  let path = url.pathname;
  while (path.startsWith("/")) {
    path = path.slice(1);
  }
  return { request, path: `${path}${url.search}` };
}

async function fetchOutboundHttpCapability(capability, input, init = {}) {
  const info = await claimedCapabilityInfo(capability.env, capability);
  if (info?.supportsOutboundHttpFetch === false || (
      info?.supportsOutboundHttpFetch === undefined &&
      info?.nativeInterface !== undefined &&
      info.nativeInterface !== "unknown" &&
      info.nativeInterface !== "outboundHttpSession")) {
    throw new ValidationError(
      `ClaimedCapability nativeInterface ${info.nativeInterface} cannot be used as outbound HTTP`);
  }

  const { request, path } = outboundHttpRequest(input, init);
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

function wrapClaimedCapability(env, capability) {
  if (capability instanceof ClaimedCapability) {
    return capability;
  }
  if (!capability || typeof capability !== "object" ||
      capability.type !== "claimedCapability" || typeof capability.id !== "string") {
    return capability;
  }

  return new ClaimedCapability(env, capability.id);
}

function wrapSavedCapability(env, capability) {
  if (capability instanceof SavedCapability) {
    return capability;
  }
  if (!capability || typeof capability !== "object" ||
      capability.type !== "savedCapability" || typeof capability.token !== "string") {
    return capability;
  }

  return new SavedCapability(env, capability.id, capability.token, capability.tokenEncoding);
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

function storageKey(options = {}) {
  return validate.storageKey(options.storageKey ?? options.key ?? "powerbox-token", "storageKey");
}

async function claimAndStorePowerboxCapability(env, request, token, options = {}) {
  const capability = await powerbox(request, env).claimRequest(token, options);
  const saved = await capability.save(options);
  const key = storageKey(options);
  await storage(env).put(key, saved.token);
  return {
    ok: true,
    capability,
    saved,
    token: saved.token,
    storageKey: key,
  };
}

async function storeClaimedPowerboxCapability(env, capabilityHandle, options = {}) {
  const capability = new ClaimedCapability(env, capabilityId(capabilityHandle));
  const saved = await capability.save(options);
  const key = storageKey(options);
  await storage(env).put(key, saved.token);
  return {
    ok: true,
    capability,
    saved,
    token: saved.token,
    storageKey: key,
  };
}

async function claimAndStorePowerboxRequest(env, request, result, options = {}) {
  if (typeof result === "string") {
    return claimAndStorePowerboxCapability(env, request, result, options);
  }

  if (!result || typeof result !== "object") {
    throw new ValidationError("Powerbox request result must be a token string or result object");
  }

  if (result.capability) {
    return storeClaimedPowerboxCapability(env, result.capability, options);
  }

  if (typeof result.token === "string") {
    return claimAndStorePowerboxCapability(env, request, result.token, options);
  }

  throw new ValidationError("Powerbox request result must contain token or capability");
}

async function restoreStoredPowerboxCapability(env, options = {}) {
  const key = storageKey(options);
  const token = await storage(env).get(key);
  if (!token) {
    return {
      ok: true,
      storageKey: key,
      found: false,
      capability: undefined,
    };
  }

  return {
    ok: true,
    storageKey: key,
    found: true,
    token,
    capability: await restoreSavedCapability(env, token),
  };
}

async function fetchStoredPowerboxCapability(env, options = {}, input = "/", init = {}) {
  const restored = await restoreStoredPowerboxCapability(env, options);
  if (!restored.ok || !restored.capability) {
    throw new ValidationError(`No saved Powerbox token is available at ${restored.storageKey}`);
  }

  try {
    const response = await restored.capability.fetch(input, init);
    const body = response.body === null || [204, 205, 304].includes(response.status)
      ? null
      : await response.arrayBuffer();
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } finally {
    await restored.capability.drop();
  }
}

async function dropStoredPowerboxCapability(env, options = {}) {
  const key = storageKey(options);
  const token = await storage(env).get(key);
  if (!token) {
    return {
      ok: true,
      storageKey: key,
      dropped: false,
      deleted: await storage(env).delete(key),
    };
  }

  const dropped = await dropSavedCapability(env, token);
  const deleted = await storage(env).delete(key);
  return {
    ok: true,
    storageKey: key,
    dropped: true,
    dropSaved: dropped,
    deleted,
  };
}

function persistentCapabilityStorageKey(id, options = {}) {
  return validate.storageKey(
    options.storageKey ?? options.key ?? `object-capability-${id}`,
    "storageKey");
}

async function persistentObjectCapability(env, target, options = {}) {
  const id = requiredObjectCapabilityId(options);
  const registration = registerObjectCapabilityTarget(target, { id });
  const key = persistentCapabilityStorageKey(id, options);
  const token = await storage(env).get(key);
  if (token) {
    return {
      ok: true,
      id,
      storageKey: key,
      registered: registration.registered,
      restored: true,
      capability: await restoreSavedCapability(env, token),
      saved: new SavedCapability(env, id, token),
      token,
    };
  }

  const capability = await createObjectCapability(env, target, {
    id,
    persistent: true,
  });
  const saved = await capability.save(options);
  await storage(env).put(key, saved.token);
  return {
    ok: true,
    id,
    storageKey: key,
    registered: registration.registered,
    restored: false,
    capability,
    saved,
    token: saved.token,
  };
}

export function powerbox(request, env) {
  return {
    async apiSessionDescriptor(options = {}) {
      return apiSessionPowerboxDescriptor(env, options);
    },

    async outboundHttpDescriptor(options = {}) {
      return outboundHttpPowerboxDescriptor(env, options);
    },

    claimedCapability(capability) {
      return new ClaimedCapability(env, capabilityId(capability));
    },

    outboundHttpCapability(capability) {
      return new ClaimedCapability(env, capabilityId(capability)).asOutboundHttp();
    },

    async claimRequest(token, options = {}) {
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
      const capability = await postPowerbox(env,
        `powerbox/claim-request?${params}`);
      return wrapClaimedCapability(env, capability);
    },

    async claimAndStore(token, options = {}) {
      token = validate.string(token, "token", { minLength: 1, maxLength: 4096 });
      return claimAndStorePowerboxCapability(env, request, token, options);
    },

    async claimAndStoreRequest(result, options = {}) {
      return claimAndStorePowerboxRequest(env, request, result, options);
    },

    async restoreStored(options = {}) {
      return restoreStoredPowerboxCapability(env, options);
    },

    async fetchStored(options = {}, input = "/", init = {}) {
      return fetchStoredPowerboxCapability(env, options, input, init);
    },

    async dropStored(options = {}) {
      return dropStoredPowerboxCapability(env, options);
    },

    offeredCapability() {
      const id = header(request, "x-sandstorm-offered-capability-id");
      return id ? new ClaimedCapability(env, id) : undefined;
    },

    offeredCapabilityInfo() {
      const id = header(request, "x-sandstorm-offered-capability-id");
      const capability = id ? new ClaimedCapability(env, id) : undefined;
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
      return offerClaimedCapability(env, request, arguments[0], arguments[1] || {});
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
      return tieClaimedCapabilityToUser(env, request, arguments[0], arguments[1] || {});
    },

    async save(capability, options = {}) {
      return saveClaimedCapability(env, capability, options);
    },

    async restoreSaved(token) {
      return restoreSavedCapability(env, token);
    },

    async dropSaved(token) {
      return dropSavedCapability(env, token);
    },

    async drop(capability) {
      const id = encodeURIComponent(capabilityId(capability));
      return postPowerbox(env, `powerbox/drop?id=${id}`);
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

  claimedCapability(capability) {
    return powerbox(this.#request, this.#env).claimedCapability(capability);
  }

  outboundHttpCapability(capability) {
    return powerbox(this.#request, this.#env).outboundHttpCapability(capability);
  }

  async claimRequest(token, options) {
    return powerbox(this.#request, this.#env).claimRequest(token, options);
  }

  async claimAndStore(token, options) {
    return powerbox(this.#request, this.#env).claimAndStore(token, options || {});
  }

  async claimAndStoreRequest(result, options) {
    return powerbox(this.#request, this.#env).claimAndStoreRequest(result, options || {});
  }

  async restoreStored(options) {
    return powerbox(this.#request, this.#env).restoreStored(options || {});
  }

  async fetchStored(options, input, init) {
    return powerbox(this.#request, this.#env).fetchStored(options || {}, input || "/", init || {});
  }

  async dropStored(options) {
    return powerbox(this.#request, this.#env).dropStored(options || {});
  }

  offeredCapability() {
    return powerbox(this.#request, this.#env).offeredCapability();
  }

  offeredCapabilityInfo() {
    return powerbox(this.#request, this.#env).offeredCapabilityInfo();
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

  async save(capability, options = {}) {
    return powerbox(this.#request, this.#env).save(capability, options);
  }

  async restoreSaved(token) {
    return powerbox(this.#request, this.#env).restoreSaved(token);
  }

  async dropSaved(token) {
    return powerbox(this.#request, this.#env).dropSaved(token);
  }

  async drop(capability) {
    return powerbox(this.#request, this.#env).drop(capability);
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

  capability(target, options = {}) {
    return createObjectCapability(this.#env, target, options);
  }

  persistentCapability(target, options = {}) {
    return persistentObjectCapability(this.#env, target, options);
  }

  registerCapability(target, options = {}) {
    return registerObjectCapabilityTarget(target, options);
  }

  unregisterCapability(options = {}) {
    return unregisterObjectCapabilityTarget(options);
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

export function sandstorm(request, env) {
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
    capability: (target, options = {}) => createObjectCapability(env, target, options),
    persistentCapability: (target, options = {}) =>
      persistentObjectCapability(env, target, options),
    registerCapability: (target, options = {}) => registerObjectCapabilityTarget(target, options),
    unregisterCapability: (options = {}) => unregisterObjectCapabilityTarget(options),
    serveObjectCapabilities: () => serveObjectCapability(request, env),
    servePowerboxDescriptors: () => servePowerboxDescriptors(request, env),
    serveSystemRoutes: () => serveSystemRoutes(request, env),
    apiTarget: () => apiTarget(request, env),
    rpcClientScript: () => rpcClientScript(),
    rpcResponse: (target, options) => rpcResponse(request, target, options),
    serveRpc: (target, options) => {
      if (isPowerboxDescriptorRequest(request) || isObjectCapabilityRequest(request)) {
        return serveSystemRoutes(request, env);
      }
      return serveRpc(request, target, options);
    },
  };
}
