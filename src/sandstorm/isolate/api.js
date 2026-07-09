import {
  connectIsolateBridge,
  createNativeCapnpServerSession,
  nativeCapnpSavedTokenData,
  nativeCapnpSavedTokenText,
} from "sandstorm:capnp";
import {
  dataBytes as CapnpEsDataBytes,
  Interface as CapnpEsInterface,
  Message as CapnpEsMessage,
  utils as CapnpEsUtils,
} from "capnp-es/index.mjs";
import { MainView } from "/sandstorm/grain.capnp";
import { OutboundHttpSession } from "/sandstorm/outbound-http-session.capnp";
import { PowerboxDescriptor, PowerboxDisplayInfo } from "/sandstorm/powerbox.capnp";
import { ByteStream } from "/sandstorm/util.capnp";
import { WebSession } from "/sandstorm/web-session.capnp";

export const SANDSTORM_API_VERSION = 0;
export const SANDSTORM_HELPER_VERSIONS = Object.freeze({
  api: SANDSTORM_API_VERSION,
});

const POWERBOX_DESCRIPTOR_PREFIX = "/__sandstorm/powerbox";
const POWERBOX_GRANTS_PREFIX = "/__sandstorm/powerbox-grants";
const POWERBOX_FULFILLMENT_PREFIX = "/__sandstorm/powerbox-fulfillment";
const MAIN_VIEW_RPC_SESSION_PATH = "/__sandstorm/main-view/rpc-session";
const CAPNP_CLIENT_SYMBOL = Symbol.for("sandstorm.capnp.client");
const capabilityMetadata = new Map();
const capabilityBridgeRefs = new WeakMap();
let nextCapabilityId = 0;

function makeLiveCapabilityId(kind = "capability") {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `${kind}-${globalThis.crypto.randomUUID()}`;
  }
  nextCapabilityId = (nextCapabilityId + 1) >>> 0;
  return `${kind}-${Date.now().toString(36)}-${nextCapabilityId.toString(36)}`;
}

function retainCapabilityBridge(bridge) {
  if (!bridge || typeof bridge.close !== "function") {
    return null;
  }
  capabilityBridgeRefs.set(bridge, (capabilityBridgeRefs.get(bridge) || 0) + 1);
  return bridge;
}

function releaseCapabilityBridge(bridge, error = undefined) {
  if (!bridge || typeof bridge.close !== "function") {
    return;
  }
  const refs = capabilityBridgeRefs.get(bridge) || 0;
  if (refs <= 1) {
    capabilityBridgeRefs.delete(bridge);
    bridge.close(error);
  } else {
    capabilityBridgeRefs.set(bridge, refs - 1);
  }
}

function capnpCapabilityPointer(capability) {
  if (capability && capability.segment && typeof capability.byteOffset === "number") {
    return capability;
  }

  const client = capability?.client ?? capability;
  if (!client) {
    throw new TypeError("mainView.restore() must return a Cap'n Proto capability");
  }

  const message = new CapnpEsMessage();
  const pointer = new CapnpEsInterface(message.getSegment(0), 0);
  CapnpEsUtils.setInterfacePointer(message.addCap(client), pointer);
  return pointer;
}

function capnpClientReference(value, name = "capability") {
  if (value && typeof value[CAPNP_CLIENT_SYMBOL] === "function") {
    const client = value[CAPNP_CLIENT_SYMBOL]();
    if (client && typeof client.call === "function") {
      return client;
    }
  }

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

  throw new Error(`${name} is not a capnp-es client reference`);
}

function initCapnpCapabilityParam(params, cap, name = "capability") {
  CapnpEsUtils.setInterfacePointer(
    params.segment.message.addCap(capnpClientReference(cap, name)),
    CapnpEsUtils.getPointer(0, params));
}

function initPermissionSetParam(params, permissions) {
  const list = params._initRequiredPermissions(permissions.length);
  permissions.forEach((permission, index) => {
    list.set(index, permission);
  });
}

function initPowerboxDescriptorParam(params, descriptor) {
  if (descriptor !== null && descriptor !== undefined) {
    PowerboxDescriptor._applyInit(params._initDescriptor(), descriptor);
  }
}

function initPowerboxDisplayInfoParam(params, displayInfo) {
  PowerboxDisplayInfo._applyInit(params._initDisplayInfo(), displayInfo);
}

function capnpCapabilityFromResult(result, name) {
  if (typeof result?.getCap === "function") {
    return result.getCap();
  }
  const pipeline = typeof result?.pipeline?.getPipeline === "function"
    ? result.pipeline.getPipeline(CapnpEsInterface, 0)
    : null;
  return typeof pipeline?.client === "function" ? pipeline.client() : null;
}

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

function base64UrlEncodeBytes(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; ++i) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecodeBytes(text, name = "base64url value") {
  try {
    const normalized = text.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; ++i) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch (error) {
    throw new ValidationError(`${name} is not valid base64url`);
  }
}

function base64UrlEncodeText(text) {
  return base64UrlEncodeBytes(new TextEncoder().encode(text));
}

function base64UrlDecodeText(text, name = "base64url value") {
  return new TextDecoder().decode(base64UrlDecodeBytes(text, name));
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

async function capabilityInfo(env, capability, options = {}) {
  const id = capabilityId(capability);
  const cached = capabilityMetadata.get(id);
  if (cached?.ok) {
    return cached;
  }
  return null;
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

async function openNativeCapnpBridgeBootstrapSession(env, connectionId) {
  if (typeof connectionId !== "string" || connectionId.length === 0) {
    throw new ValidationError("isolate bridge RPC session requires a connection id");
  }

  const params = new URLSearchParams({
    bootstrap: "worker",
    connectionId,
  });
  const response = await env.SANDSTORM_API.fetch(
    `http://sandstorm/capnp/rpc-session?${params}`, {
      headers: { Upgrade: "websocket" },
  });
  if (!response.webSocket) {
    const text = await response.text();
    let message = `isolate bridge RPC session failed with ${response.status}: ${text}`;
    try {
      const body = JSON.parse(text);
      if (body && typeof body.error === "string" && body.error.length > 0) {
        message = body.error;
      }
    } catch (_) {}

    throw new NativeCapnpBridgeUnavailableError(`${message}; connectionId=${connectionId}`);
  }

  response.webSocket.accept();
  return response.webSocket;
}

function nativeCapnpBridgeApi(env) {
  return {
    capnpBridgeInfo: () => callSandstormApi(env, "capnp/bridge-info"),
    nativeCapnpBridgeOpenBootstrapSession: (connectionId) =>
      openNativeCapnpBridgeBootstrapSession(env, connectionId),
  };
}

async function withIsolateBridgeRpc(env, operation, options = {}) {
  const bridge = connectIsolateBridge(nativeCapnpBridgeApi(env), {
    connectionId: options.connectionId,
    finalize: options.finalize,
  });

  try {
    const value = await operation(bridge);
    bridge.close();
    return value;
  } catch (error) {
    bridge.close(error);
    throw error;
  }
}

async function withSandstormApiRpc(env, operation, options = {}) {
  return withIsolateBridgeRpc(env, async (bridge) => {
    const result = await bridge.getSandstormApi({});
    const sandstormApi = result.api;
    if (!sandstormApi || typeof sandstormApi !== "object") {
      throw new Error("isolate bridge returned an invalid SandstormApi capability");
    }

    return operation(sandstormApi, bridge);
  }, options);
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

export class NativeCapnpBridgeUnavailableError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "NativeCapnpBridgeUnavailableError";
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
  if (value instanceof Capability) {
    return value.id;
  }

  if (typeof value === "string") {
    return validate.string(value, name, { minLength: 1, maxLength: 4096 });
  }

  if (value && typeof value === "object" &&
      (value.type === "capability" || value.type === "claimedCapability")) {
    return validate.string(value.id, `${name}.id`, { minLength: 1, maxLength: 4096 });
  }

  throw new ValidationError(`${name} must be a capability handle or id string`);
}

function capabilityCapnpClient(value, name = "capability") {
  if (value instanceof Capability) {
    return value._capnpClient(name);
  }

  if (value && typeof value[CAPNP_CLIENT_SYMBOL] === "function") {
    return capnpClientReference(value, name);
  }

  if (value && typeof value === "object" && typeof value.call === "function") {
    return value;
  }

  if (value && typeof value === "object" && typeof value.client?.call === "function") {
    return value.client;
  }

  throw new ValidationError(`${name} must be a live capability handle`);
}

function capabilityBridge(value) {
  if (value instanceof Capability) {
    return value._bridge();
  }
  throw new ValidationError("operation requires a live capability handle");
}

function sessionActionCapability(env, capability, name = "session action capability") {
  const cap = capabilityCapnpClient(capability, name);
  if (capability instanceof Capability) {
    return {
      cap,
      bridge: capability._bridge(),
      temporaryBridge: false,
    };
  }

  return {
    cap,
    bridge: connectIsolateBridge(nativeCapnpBridgeApi(env), {
      connectionId: makeLiveCapabilityId("session-action"),
    }),
    temporaryBridge: true,
  };
}

export class Capability {
  #env;
  #cap;
  #bridge;
  #browserSessionId = "";
  #dropped = false;

  constructor(env, capOrId, metadata = undefined) {
    this.#env = env;
    this.ok = true;
    this.type = "capability";
    if (typeof capOrId === "string") {
      this.id = validate.string(capOrId, "capability.id", { minLength: 1, maxLength: 4096 });
      this.#cap = null;
    } else {
      this.#cap = capnpClientReference(capOrId, "capability");
      this.id = validate.string(
        metadata?.id || makeLiveCapabilityId(metadata?.kind || "capability"),
        "capability.id",
        { minLength: 1, maxLength: 4096 });
    }
    if (metadata?.bridge) {
      this.#bridge = retainCapabilityBridge(metadata.bridge);
    }
    if (typeof metadata?.browserSessionId === "string" && metadata.browserSessionId.length > 0) {
      this.#browserSessionId = validate.string(
        metadata.browserSessionId, "browserSessionId", { minLength: 1, maxLength: 4096 });
    }
    if (metadata !== undefined && metadata !== null) {
      const { bridge: _bridge, browserSessionId: _browserSessionId, ...metadataWithoutBridge } =
          metadata;
      cacheCapabilityMetadata(this.id, metadataWithoutBridge);
    }
  }

  get env() {
    return this.#env;
  }

  _capnpClient(name = "capability") {
    if (!this.#cap) {
      throw new Error(`${name} is not a live RPC capability`);
    }
    return this.#cap;
  }

  [CAPNP_CLIENT_SYMBOL]() {
    return this._capnpClient("capability");
  }

  _bridge() {
    if (!this.#bridge) {
      throw new Error("capability does not own a live isolate bridge connection");
    }
    return this.#bridge;
  }

  _browserSessionId() {
    return this.#browserSessionId;
  }

  _release(error = undefined) {
    if (this.#dropped) {
      return false;
    }
    this.#dropped = true;
    releaseCapabilityBridge(this.#bridge, error);
    this.#bridge = null;
    this.#cap = null;
    forgetCapabilityHandle(this.id);
    return true;
  }

  fetch(input, init) {
    return fetchCapability(this.#env, this, input, init);
  }

  info(options = {}) {
    return capabilityInfo(this.#env, this, options);
  }

  save(options = {}) {
    return saveCapability(this.#env, this, options);
  }

  async drop() {
    return dropCapability(this.#env, this);
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

  browserHandoff(options = {}) {
    return browserHandoffCapability(this.#env, this, options);
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

function sessionDisplayInfo(options = {}) {
  const result = {
    title: { defaultText: displayTitle(options) },
  };
  const verbPhrase = displayText(
    options, ["verbPhrase", "displayVerbPhrase"], undefined, "verbPhrase");
  if (verbPhrase !== undefined) {
    result.verbPhrase = { defaultText: verbPhrase };
  }
  const description = displayText(
    options, ["description", "displayDescription"], undefined, "description");
  if (description !== undefined) {
    result.description = { defaultText: description };
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

function appInterfaceDescriptorParams(options = {}) {
  const descriptor = options.appInterface ?? options.appInterfaceDescriptor ?? null;
  if (descriptor === null || descriptor === undefined) {
    return [];
  }
  if (typeof descriptor !== "object") {
    throw new ValidationError("appInterface descriptor must be an object");
  }

  const interfaceId = validate.string(descriptor.interfaceId, "appInterface.interfaceId", {
    minLength: 1,
    maxLength: 32,
  });
  if (!/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(interfaceId)) {
    throw new ValidationError(
      "appInterface.interfaceId must be a decimal integer or 0x-prefixed hex integer");
  }

  const result = [
    ["descriptor", "appInterface"],
    ["interfaceId", interfaceId],
  ];
  if (descriptor.interfaceName !== undefined && descriptor.interfaceName !== null) {
    result.push(["interfaceName", validate.string(
      descriptor.interfaceName, "appInterface.interfaceName", {
        minLength: 1,
        maxLength: 512,
      })]);
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
]);
const powerboxDescriptorInfoCache = new Map();

function cloneDescriptorJsonValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

async function cachedPowerboxDescriptorInfo(cacheKey, loader) {
  if (powerboxDescriptorInfoCache.has(cacheKey)) {
    return cloneDescriptorJsonValue(powerboxDescriptorInfoCache.get(cacheKey));
  }

  const result = await loader();
  powerboxDescriptorInfoCache.set(cacheKey, cloneDescriptorJsonValue(result));
  return cloneDescriptorJsonValue(result);
}

function explicitClaimNativeInterface(options = {}) {
  const nativeInterface = validate.string(options.nativeInterface, "nativeInterface", {
    minLength: 1,
    maxLength: 64,
  });
  if (!CLAIM_NATIVE_INTERFACES.has(nativeInterface)) {
    throw new ValidationError(
      "nativeInterface must be one of unknown, webSession, apiSession, outboundHttpSession");
  }
  return nativeInterface;
}

function inferredClaimNativeInterface(options = {}) {
  let inferred = "unknown";
  if (options.apiSession !== undefined || options.apiSessionDescriptor !== undefined) {
    inferred = "apiSession";
  }
  if (options.outboundHttp !== undefined || options.outboundHttpDescriptor !== undefined) {
    if (inferred !== "unknown") {
      throw new ValidationError("Powerbox options must specify only one descriptor type");
    }
    inferred = "outboundHttpSession";
  }
  return inferred;
}

function claimNativeInterface(options = {}) {
  const inferred = inferredClaimNativeInterface(options);
  if (options.nativeInterface === undefined || options.nativeInterface === null) {
    return inferred;
  }

  const explicit = explicitClaimNativeInterface(options);
  if (inferred !== "unknown" && explicit !== inferred) {
    throw new ValidationError(
      `nativeInterface ${explicit} conflicts with powerbox descriptor native interface ${inferred}`);
  }
  return explicit;
}

function offerDescriptorNativeInterface(descriptor) {
  switch (descriptor?.type) {
    case "apiSession":
      return "apiSession";
    case "outboundHttp":
      return "outboundHttpSession";
    default:
      return "unknown";
  }
}

function powerboxDescriptorParams(options = {}) {
  const apiSession = apiSessionDescriptorParams(options);
  const outboundHttp = outboundHttpDescriptorParams(options);
  const appInterface = appInterfaceDescriptorParams(options);
  const packed = packedPowerboxDescriptorParams(options);
  const descriptorCount =
    (apiSession.length > 0 ? 1 : 0) +
    (outboundHttp.length > 0 ? 1 : 0) +
    (appInterface.length > 0 ? 1 : 0) +
    (packed.length > 0 ? 1 : 0);
  if (descriptorCount > 1) {
    throw new ValidationError("Powerbox options must specify only one descriptor type");
  }
  if (apiSession.length > 0) {
    return apiSession;
  } else if (outboundHttp.length > 0) {
    return outboundHttp;
  } else if (appInterface.length > 0) {
    return appInterface;
  } else {
    return packed;
  }
}

function decodePackedPowerboxDescriptor(descriptor) {
  return new CapnpEsMessage(
    base64UrlDecodeBytes(validatePackedPowerboxDescriptor(descriptor, "descriptor")))
    .getRoot(PowerboxDescriptor);
}

async function sessionActionDescriptor(env, options = {}) {
  const params = powerboxDescriptorParams(options);
  const descriptorType = params.find(([name]) => name === "descriptor")?.[1] || "";
  switch (descriptorType) {
    case "":
      return { tags: [] };
    case "packed": {
      const packed = params.find(([name]) => name === "packedPowerboxDescriptor")?.[1];
      return decodePackedPowerboxDescriptor(packed);
    }
    case "apiSession":
      return decodePackedPowerboxDescriptor(
        (await apiSessionPowerboxDescriptorInfo(env, options)).descriptor);
    case "outboundHttp":
      return decodePackedPowerboxDescriptor(
        (await outboundHttpPowerboxDescriptorInfo(env, options)).descriptor);
    case "appInterface":
      return decodePackedPowerboxDescriptor(
        (await appInterfacePowerboxDescriptorInfo(env, options)).descriptor);
    default:
      throw new ValidationError(`unsupported powerbox descriptor type: ${descriptorType}`);
  }
}

async function saveCapabilityRecord(env, capability, options = {}) {
  const rawId = capabilityId(capability);
  const label = saveLabel(options);
  const info = await capabilityInfo(env, capability);
  const bridge = capabilityBridge(capability);
  if (typeof bridge.getSandstormApi !== "function") {
    throw new Error("capability bridge returned no SandstormApi resolver");
  }

  const apiResult = await bridge.getSandstormApi({});
  const sandstormApi = apiResult.api;
  if (!sandstormApi || typeof sandstormApi.save !== "function") {
    throw new Error("isolate bridge returned a SandstormApi without save()");
  }

  const saved = await sandstormApi.save((params) => {
    initCapnpCapabilityParam(params, capabilityCapnpClient(capability, "saved capability"),
      "saved capability");
    params._initLabel().defaultText = label;
  });
  return savedCapabilityRecord({
    ok: true,
    type: "savedCapability",
    id: rawId,
    token: encodeSavedCapabilityToken(saved.token, info || {}),
    tokenEncoding: "base64url",
  });
}

async function saveCapability(env, capability, options = {}) {
  return (await saveCapabilityRecord(env, capability, options)).token;
}

async function dropCapability(env, capability) {
  const id = capabilityId(capability);
  if (capability instanceof Capability) {
    capability._release();
  } else {
    forgetCapabilityHandle(id);
  }
  return { ok: true, released: true };
}

async function sessionPowerboxAction(env, request, endpoint, capability, options = {}) {
  const requiredPermissions = permissionNames(options);
  const permissions = await requiredPermissionSet(env, requiredPermissions);
  const sessionId = sessionIdForPowerbox(request);
  const displayInfo = sessionDisplayInfo(options);
  const descriptor = endpoint === "tie-to-user"
    ? null
    : await sessionActionDescriptor(env, options);
  const actionCapability = sessionActionCapability(env, capability);
  const { bridge, cap, temporaryBridge } = actionCapability;

  try {
    if (typeof bridge.getSessionContext !== "function") {
      throw new Error("isolate bridge returned no session-context resolver");
    }

    const session = await bridge.getSessionContext({ sessionId });
    if (!session?.context) {
      throw new Error("isolate bridge returned no SessionContext capability");
    }

    switch (endpoint) {
      case "offer":
        await session.context.offer((params) => {
          initCapnpCapabilityParam(params, cap, "offered capability");
          initPermissionSetParam(params, permissions);
          initPowerboxDescriptorParam(params, descriptor);
          initPowerboxDisplayInfoParam(params, displayInfo);
        });
        if (temporaryBridge) bridge.close();
        return { ok: true };
      case "fulfill-request":
        await session.context.fulfillRequest((params) => {
          initCapnpCapabilityParam(params, cap, "fulfilled capability");
          initPermissionSetParam(params, permissions);
          initPowerboxDescriptorParam(params, descriptor);
          initPowerboxDisplayInfoParam(params, displayInfo);
        });
        if (temporaryBridge) bridge.close();
        return { ok: true };
      case "tie-to-user": {
        const tiedPromise = session.context.tieToUser((params) => {
          initCapnpCapabilityParam(params, cap, "tied capability");
          initPermissionSetParam(params, permissions);
          initPowerboxDisplayInfoParam(params, displayInfo);
        });
        const tiedCap = capnpCapabilityFromResult(tiedPromise, "tied capability");
        if (!tiedCap) {
          throw new Error("SessionContext.tieToUser() returned no capability");
        }
        await tiedPromise;
        return new Capability(env, tiedCap, {
          kind: "tied",
          bridge,
          nativeInterface: "unknown",
          pathPrefix: "",
          browserSessionId: sessionId,
        });
      }
      default:
        throw new Error(`unsupported session powerbox action: ${endpoint}`);
    }
  } catch (error) {
    if (temporaryBridge) bridge.close(error);
    throw error;
  }
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
  const path = `powerbox/api-session-descriptor?${params}`;
  return cachedPowerboxDescriptorInfo(path, () => callPowerbox(env, path));
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
  const path = `powerbox/outbound-http-descriptor?${params}`;
  return cachedPowerboxDescriptorInfo(path, () => callPowerbox(env, path));
}

function appInterfaceRequestOptions(options = {}) {
  if (options.appInterface !== undefined || options.appInterfaceDescriptor !== undefined) {
    return options;
  }

  return { ...options, appInterface: options };
}

async function appInterfacePowerboxDescriptor(env, options = {}) {
  const result = await appInterfacePowerboxDescriptorInfo(env, options);
  return result.descriptor;
}

async function appInterfacePowerboxDescriptorInfo(env, options = {}) {
  const params = new URLSearchParams();
  for (const [name, value] of appInterfaceDescriptorParams(appInterfaceRequestOptions(options))) {
    if (name !== "descriptor") {
      params.append(name, value);
    }
  }
  const path = `powerbox/app-interface-descriptor?${params}`;
  return cachedPowerboxDescriptorInfo(path, () => callPowerbox(env, path));
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

  if (url.pathname === `${POWERBOX_DESCRIPTOR_PREFIX}/app-interface-descriptor`) {
    try {
      const descriptor = await appInterfacePowerboxDescriptorInfo(env, {
        interfaceId: url.searchParams.get("interfaceId") || "",
        interfaceName: url.searchParams.get("interfaceName") || undefined,
      });
      return Response.json(descriptor);
    } catch (error) {
      return Response.json({
        ok: false,
        error: error.message || String(error),
      }, { status: 400 });
    }
  }

  if (url.pathname === `${POWERBOX_DESCRIPTOR_PREFIX}/claim` && request.method === "POST") {
    try {
      const body = await request.json();
      const claimOptions = {
        requiredPermissions: Array.isArray(body.requiredPermissions)
          ? body.requiredPermissions
          : [],
      };
      for (const name of [
        "apiSession",
        "apiSessionDescriptor",
        "outboundHttp",
        "outboundHttpDescriptor",
        "descriptor",
        "powerboxDescriptor",
        "nativeInterface",
      ]) {
        if (body[name] !== undefined) {
          claimOptions[name] = body[name];
        }
      }
      const capability = await powerbox(request, env).claim(body.token, claimOptions);
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
      ...(spec.nativeInterface === undefined ? {} : { nativeInterface: spec.nativeInterface }),
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
  const raw = value && typeof value === "object" &&
      typeof value[CAPNP_CLIENT_SYMBOL] !== "function" && value.capability
    ? value.capability
    : value;
  const capability = wrapCapability(env, raw);
  if (capability instanceof Capability ||
      (capability && typeof capability === "object" &&
        (capability.type === "capability" || capability.type === "claimedCapability"))) {
    const id = capabilityId(capability, "Powerbox fulfillment capability");
    return { capability, handle: { ok: true, type: "capability", id } };
  }

  capabilityCapnpClient(capability, "Powerbox fulfillment capability");
  return {
    capability,
    handle: capability && typeof capability.toJSON === "function"
      ? capability.toJSON()
      : { ok: true, type: "nativeCapnpCapability" },
  };
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
  return `import {
  inspectPowerboxQuery,
  requestPowerbox,
} from "/__sandstorm/native-capnp/client.js";

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

function normalizeMainViewHandlers(options = {}) {
  const mainView = options.mainView ?? options;
  if (!mainView || typeof mainView !== "object") {
    return {};
  }
  return mainView;
}

function mainViewRpcTarget(request, env, options = {}) {
  const handlers = normalizeMainViewHandlers(options);
  return {
    async restore(params) {
      if (typeof handlers.restore !== "function") {
        throw new UnsupportedCapabilityError("mainView", "restore");
      }

      const restored = await handlers.restore(params.objectId, {
        request,
        env,
        params,
      });
      const cap = restored && typeof restored === "object" && restored.cap !== undefined ?
        restored.cap :
        restored;
      return { cap: capnpCapabilityPointer(cap) };
    },

    async drop(params) {
      if (typeof handlers.drop !== "function") {
        return undefined;
      }

      return await handlers.drop(params.objectId, {
        request,
        env,
        params,
      });
    },
  };
}

async function serveMainViewRpcSession(request, env, options = {}) {
  const url = new URL(request.url);
  if (url.pathname !== MAIN_VIEW_RPC_SESSION_PATH) {
    return null;
  }

  if (request.method !== "GET" ||
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return Response.json({ ok: false, error: "main view RPC requires WebSocket" }, {
      status: 426,
    });
  }

  const pair = new WebSocketPair();
  const server = pair[0];
  server.accept();
  createNativeCapnpServerSession(MainView, mainViewRpcTarget(request, env, options), {
    webSocket: server,
  });
  return new Response(null, {
    status: 101,
    webSocket: pair[1],
  });
}

export async function serveSystemRoutes(request, env, options = {}) {
  return await serveBrowserSystemRoute(request, env) ||
    await serveMainViewRpcSession(request, env, options) ||
    await servePowerboxDescriptors(request, env);
}

async function serveBrowserSystemRoute(request, env) {
  const url = new URL(request.url);

  if (url.pathname === "/__sandstorm/native-capnp/client.js" && request.method === "GET") {
    return new Response(nativeCapnpBrowserClientScript(), {
      headers: { "content-type": "text/javascript; charset=utf-8" },
    });
  }

  if (url.pathname === "/__sandstorm/native-capnp/bridge-info" &&
      request.method === "GET") {
    const response = await env.SANDSTORM_API.fetch("http://sandstorm/capnp/bridge-info");
    return new Response(await response.text(), {
      status: response.status,
      statusText: response.statusText,
      headers: {
        "content-type": response.headers.get("content-type") ||
          "application/json; charset=utf-8",
      },
    });
  }

  if (url.pathname === "/__sandstorm/native-capnp/rpc-session" &&
      request.method === "GET") {
    const headers = {};
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      headers.Upgrade = "websocket";
    }
    const sessionId = request.headers.get("x-sandstorm-session-id");
    if (sessionId) {
      headers["X-Sandstorm-Session-Id"] = sessionId;
    }

    const response = await env.SANDSTORM_API.fetch(
      `http://sandstorm/capnp/rpc-session${url.search}`, { headers });
    if (response.webSocket) {
      return new Response(null, { status: 101, webSocket: response.webSocket });
    }

    return new Response(await response.text(), {
      status: response.status,
      statusText: response.statusText,
      headers: {
        "content-type": response.headers.get("content-type") ||
          "application/json; charset=utf-8",
      },
    });
  }

  const capnpPrefix = "/__sandstorm/capnp/";
  if (url.pathname.startsWith(capnpPrefix) && request.method === "GET") {
    const path = url.pathname.slice(capnpPrefix.length);
    const response = await env.SANDSTORM_API.fetch(
      `http://sandstorm/capnp/browser-module?path=${encodeURIComponent(path)}`);
    return new Response(await response.text(), {
      status: response.status,
      statusText: response.statusText,
      headers: {
        "content-type": response.headers.get("content-type") ||
          "text/javascript; charset=utf-8",
      },
    });
  }

  if (url.pathname.startsWith("/capnp-es/") && request.method === "GET") {
    const path = url.pathname.slice(1);
    const response = await env.SANDSTORM_API.fetch(
      `http://sandstorm/capnp/browser-module?path=${encodeURIComponent(path)}`);
    return new Response(await response.text(), {
      status: response.status,
      statusText: response.statusText,
      headers: {
        "content-type": response.headers.get("content-type") ||
          "text/javascript; charset=utf-8",
      },
    });
  }

  return null;
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

async function createRouteBackedCapability(env, nativeInterface, options = {}) {
  const pathPrefix = webSessionPathPrefix(options);
  const persistent = webSessionPersistent(options);
  const bridge = connectIsolateBridge(nativeCapnpBridgeApi(env), {
    connectionId: makeLiveCapabilityId("route-backed"),
  });
  try {
    if (typeof bridge.createRouteBackedCapability !== "function") {
      throw new Error("isolate bridge returned no route-backed capability creator");
    }

    const resultPromise = bridge.createRouteBackedCapability({
      nativeInterface,
      pathPrefix,
      persistent,
    });
    const cap = capnpCapabilityFromResult(resultPromise, "route-backed capability");
    if (!cap) {
      throw new Error("isolate bridge returned no route-backed capability");
    }
    await resultPromise;
    const kind = nativeInterface === "apiSession"
      ? "routeBackedApiSession"
      : "routeBackedWebSession";
    return new Capability(env, cap, {
      kind,
      bridge,
      residence: "localExport",
      nativeInterface,
      pathPrefix,
      persistent,
      hasNativeCapability: true,
      liveForwardable: true,
      browserSessionId: options.browserSessionId,
    });
  } catch (error) {
    bridge.close(error);
    throw error;
  }
}

function browserHandoffSessionId(capability, options = {}) {
  let sessionId = "";
  if (typeof Request === "function" && options.request instanceof Request) {
    sessionId = header(options.request, "x-sandstorm-session-id");
  }
  if (!sessionId && typeof options.sessionId === "string") {
    sessionId = options.sessionId;
  }
  if (!sessionId && capability instanceof Capability) {
    sessionId = capability._browserSessionId();
  }
  if (!sessionId) {
    throw new Error("browser handoff requires a live Sandstorm WebSession");
  }
  return validate.string(sessionId, "browser handoff sessionId", {
    minLength: 1,
    maxLength: 4096,
  });
}

async function browserHandoffCapability(env, capability, options = {}) {
  const info = await capabilityInfo(env, capability);
  const bridge = capabilityBridge(capability);
  const sessionId = browserHandoffSessionId(capability, options);
  if (typeof bridge.createBrowserHandoff !== "function") {
    throw new Error("capability bridge returned no browser handoff creator");
  }

  const stored = await bridge.createBrowserHandoff((params) => {
    initCapnpCapabilityParam(params, capabilityCapnpClient(capability, "browser handoff capability"),
      "browser handoff capability");
    params.sessionId = sessionId;
  });
  if (!stored || typeof stored.id !== "string" || stored.id.length === 0) {
    throw new Error("isolate bridge returned an invalid browser handoff id");
  }

  return {
    ok: true,
    type: "capability",
    id: stored.id,
    kind: "receiverHosted",
    residence: "browserHandoff",
    nativeInterface: info?.nativeInterface || options.nativeInterface || "unknown",
  };
}

async function createWebSessionCapability(env, options = {}) {
  return createRouteBackedCapability(env, "webSession", options);
}

async function createApiSessionCapability(env, options = {}) {
  return createRouteBackedCapability(env, "apiSession", options);
}

function forgetCapabilityHandle(capabilityId) {
  capabilityMetadata.delete(capabilityId);
}

function capabilitySupportsWebFetch(nativeInterface) {
  return nativeInterface !== "outboundHttpSession";
}

function capabilitySupportsOutboundHttpFetch(nativeInterface) {
  return nativeInterface === "unknown" || nativeInterface === "outboundHttpSession";
}

function cacheCapabilityMetadata(id, metadata = {}) {
  const nativeInterface = metadata.nativeInterface || "unknown";
  capabilityMetadata.set(id, {
    ok: true,
    type: "capabilityInfo",
    id,
    kind: metadata.kind || "unknown",
    residence: metadata.residence || "imported",
    nativeInterface,
    pathPrefix: typeof metadata.pathPrefix === "string" ? metadata.pathPrefix : "",
    persistent: metadata.persistent !== undefined ? Boolean(metadata.persistent) : true,
    supportsWebFetch: metadata.supportsWebFetch !== undefined
      ? Boolean(metadata.supportsWebFetch)
      : capabilitySupportsWebFetch(nativeInterface),
    supportsOutboundHttpFetch: metadata.supportsOutboundHttpFetch !== undefined
      ? Boolean(metadata.supportsOutboundHttpFetch)
      : capabilitySupportsOutboundHttpFetch(nativeInterface),
    hasNativeCapability: metadata.hasNativeCapability !== undefined
      ? Boolean(metadata.hasNativeCapability)
      : true,
    liveForwardable: metadata.liveForwardable !== undefined
      ? Boolean(metadata.liveForwardable)
      : true,
  });
}

function cacheImportedCapabilityMetadata(id, kind, metadata) {
  cacheCapabilityMetadata(id, {
    ...metadata,
    kind,
    residence: "imported",
    persistent: true,
    hasNativeCapability: true,
    liveForwardable: true,
  });
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

function savedCapabilityEnvelopeType(info = {}) {
  switch (info.nativeInterface) {
    case "webSession":
      return "web";
    case "apiSession":
      return "api";
    case "outboundHttpSession":
      return "outboundHttp";
    default:
      return null;
  }
}

function savedCapabilityEnvelopePathPrefix(info = {}) {
  if (info.kind === "routeBackedWebSession" || info.kind === "routeBackedApiSession") {
    return typeof info.pathPrefix === "string" ? info.pathPrefix : "";
  }
  return "";
}

function encodeSavedCapabilityToken(tokenData, info = {}) {
  const sturdyRef = nativeCapnpSavedTokenText(tokenData);
  const type = savedCapabilityEnvelopeType(info);
  if (!type) {
    return sturdyRef;
  }

  const payload = [
    "isolate-saved-capability-v1",
    type,
    base64UrlEncodeText(savedCapabilityEnvelopePathPrefix(info)),
    sturdyRef,
  ].join("\n");
  return base64UrlEncodeText(payload);
}

function savedCapabilityEnvelopeMetadata(token) {
  const fallback = {
    nativeInterface: "unknown",
    pathPrefix: "",
  };

  const text = base64UrlDecodeText(token, "saved capability token");
  const lines = text.split("\n");
  if (lines[0] !== "isolate-saved-capability-v1") {
    return fallback;
  }
  if (lines.length < 4) {
    throw new ValidationError("saved capability token envelope is incomplete");
  }

  let nativeInterface;
  switch (lines[1]) {
    case "web":
      nativeInterface = "webSession";
      break;
    case "api":
      nativeInterface = "apiSession";
      break;
    case "outboundHttp":
      nativeInterface = "outboundHttpSession";
      break;
    case "unknown":
      nativeInterface = "unknown";
      break;
    default:
      throw new ValidationError("saved capability token envelope has unknown capability type");
  }

  return {
    nativeInterface,
    pathPrefix: base64UrlDecodeText(lines[2], "saved capability token path prefix"),
  };
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

const MAX_CAPABILITY_FETCH_BODY_BYTES = 64 * 1024 * 1024;

function shouldForwardCapabilityFetchHeader(name) {
  name = String(name).toLowerCase();
  return CAPABILITY_FETCH_HEADER_NAMES.has(name) ||
    CAPABILITY_FETCH_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function isValidCapabilityFetchHeaderName(name) {
  name = String(name);
  if (name.length === 0 || name.length > 256) return false;
  return /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name);
}

function isValidCapabilityFetchHeaderValue(value) {
  value = String(value);
  if (value.length > 8192) return false;
  for (let i = 0; i < value.length; ++i) {
    const code = value.charCodeAt(i);
    if ((code >= 0 && code < 0x20 && code !== 0x09) || code === 0x7f) {
      return false;
    }
  }
  return true;
}

function capnpDataBytes(value) {
  let bytes;
  if (value instanceof Uint8Array) {
    bytes = value;
  } else if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  } else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else if (value && typeof value.toUint8Array === "function") {
    bytes = value.toUint8Array();
  } else {
    bytes = CapnpEsDataBytes(value);
  }
  return new Uint8Array(bytes);
}

async function requestBodyBytes(request) {
  if (request.method === "GET" || request.method === "HEAD" || request.body === null) {
    return new Uint8Array();
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_CAPABILITY_FETCH_BODY_BYTES) {
    throw new ValidationError(
      `claimed capability fetch request body exceeds maximum allowed size`);
  }
  return bytes;
}

function parseFetchETag(input) {
  input = String(input).trim();
  const result = { value: "", weak: false };
  if (input.startsWith("W/")) {
    input = input.slice(2);
    result.weak = true;
  }

  if (!input.startsWith("\"") || !input.endsWith("\"") || input.length <= 1) {
    throw new ValidationError(`claimed capability fetch ETag precondition is invalid`);
  }

  let escaped = false;
  let value = "";
  for (const c of input.slice(1, -1)) {
    if (escaped) {
      escaped = false;
    } else if (c === "\"") {
      throw new ValidationError(`claimed capability fetch ETag precondition is invalid`);
    } else if (c === "\\") {
      escaped = true;
      continue;
    }
    value += c;
  }
  result.value = value;
  return result;
}

function parseFetchETagList(value) {
  const parts = String(value).split(",");
  if (parts.length === 0) {
    throw new ValidationError(`claimed capability fetch ETag precondition is empty`);
  }
  return parts.map(parseFetchETag);
}

function formatWebSessionETag(eTag) {
  return `${eTag.weak ? "W/" : ""}"${eTag.value}"`;
}

function escapeHttpQuotedString(value) {
  return String(value).replace(/[\\"]/g, "\\$&").replace(/[\r\n]/g, "_");
}

function appendValidatedHeader(headers, name, value) {
  if (!isValidCapabilityFetchHeaderName(name) || !isValidCapabilityFetchHeaderValue(value)) {
    return;
  }
  headers.append(name, value);
}

function webSessionSuccessStatus(code) {
  switch (code) {
    case WebSession.Response.SuccessCode.OK: return 200;
    case WebSession.Response.SuccessCode.CREATED: return 201;
    case WebSession.Response.SuccessCode.ACCEPTED: return 202;
    case WebSession.Response.SuccessCode.NO_CONTENT: return 204;
    case WebSession.Response.SuccessCode.PARTIAL_CONTENT: return 206;
    case WebSession.Response.SuccessCode.MULTI_STATUS: return 207;
    case WebSession.Response.SuccessCode.NOT_MODIFIED: return 304;
    default: return 200;
  }
}

function webSessionClientErrorStatus(code) {
  switch (code) {
    case WebSession.Response.ClientErrorCode.BAD_REQUEST: return 400;
    case WebSession.Response.ClientErrorCode.FORBIDDEN: return 403;
    case WebSession.Response.ClientErrorCode.NOT_FOUND: return 404;
    case WebSession.Response.ClientErrorCode.METHOD_NOT_ALLOWED: return 405;
    case WebSession.Response.ClientErrorCode.NOT_ACCEPTABLE: return 406;
    case WebSession.Response.ClientErrorCode.CONFLICT: return 409;
    case WebSession.Response.ClientErrorCode.GONE: return 410;
    case WebSession.Response.ClientErrorCode.PRECONDITION_FAILED: return 412;
    case WebSession.Response.ClientErrorCode.REQUEST_ENTITY_TOO_LARGE: return 413;
    case WebSession.Response.ClientErrorCode.REQUEST_URI_TOO_LONG: return 414;
    case WebSession.Response.ClientErrorCode.UNSUPPORTED_MEDIA_TYPE: return 415;
    case WebSession.Response.ClientErrorCode.IM_ATEAPOT: return 418;
    case WebSession.Response.ClientErrorCode.UNPROCESSABLE_ENTITY: return 422;
    default: return 400;
  }
}

function createCapabilityByteStream() {
  let controller;
  let finished = false;
  let finishError;
  let expectedBytes;
  let receivedBytes = 0;
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });

  const readable = new ReadableStream({
    start(streamController) {
      controller = streamController;
    },

    cancel(reason) {
      const error = reason instanceof Error ? reason :
        new Error("capability fetch response body was canceled");
      finish(error);
    },
  });

  function finish(error) {
    if (finished) return;
    finished = true;
    finishError = error;
    try {
      if (error === undefined) {
        controller.close();
      } else {
        controller.error(error);
      }
    } catch (_) {}
    resolveClosed(error);
  }

  function fail(error) {
    finish(error);
    throw error;
  }

  const server = new ByteStream.Server({
    async write(params) {
      if (finished) {
        if (finishError) throw finishError;
        throw new Error("capability fetch response stream is closed");
      }

      const bytes = capnpDataBytes(params.data);
      if (receivedBytes + bytes.byteLength > MAX_CAPABILITY_FETCH_BODY_BYTES) {
        fail(new ValidationError(
          `claimed capability fetch response body exceeds maximum allowed size`));
      }
      receivedBytes += bytes.byteLength;
      if (expectedBytes !== undefined && receivedBytes > expectedBytes) {
        fail(new ValidationError(
          `claimed capability fetch response body exceeded the expected size`));
      }

      try {
        controller.enqueue(bytes);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
      return {};
    },

    async done() {
      if (expectedBytes !== undefined && receivedBytes !== expectedBytes) {
        fail(new ValidationError(
          `claimed capability fetch response body did not match the expected size`));
      }
      finish();
      return {};
    },

    async expectSize(params) {
      const size = typeof params.size === "bigint" ? params.size : BigInt(params.size || 0);
      const remaining = BigInt(MAX_CAPABILITY_FETCH_BODY_BYTES - receivedBytes);
      if (size > remaining) {
        fail(new ValidationError(
          `claimed capability fetch response body exceeds maximum allowed size`));
      }
      const nextExpectedBytes = receivedBytes + Number(size);
      if (expectedBytes !== undefined && expectedBytes !== nextExpectedBytes) {
        fail(new ValidationError(
          `claimed capability fetch response body expected size changed`));
      }
      expectedBytes = nextExpectedBytes;
      return {};
    },
  });

  return {
    client: server.client(),
    readable,
    closed,
    finish,
  };
}

function webSessionResponseHeaders(webResponse) {
  const headers = new Headers();
  for (const header of webResponse.additionalHeaders) {
    appendValidatedHeader(headers, header.name, header.value);
  }
  return headers;
}

function addWebSessionContentHeaders(headers, content) {
  headers.set("content-type", content.mimeType || "application/octet-stream");
  if (content.encoding) headers.append("content-encoding", content.encoding);
  if (content.language) headers.append("content-language", content.language);
  if (content._hasETag()) headers.append("etag", formatWebSessionETag(content.eTag));
  if (content.disposition._isDownload) {
    headers.append("content-disposition",
      `attachment; filename="${escapeHttpQuotedString(content.disposition.download)}"`);
  }
}

function webSessionErrorResponse(error, status) {
  const headers = new Headers();
  if (typeof error._hasNonHtmlBody === "function" && error._hasNonHtmlBody()) {
    const body = error.nonHtmlBody;
    headers.set("content-type", body.mimeType || "application/octet-stream");
    return new Response(capnpDataBytes(body.data), { status, statusText: "Error", headers });
  } else if (error.descriptionHtml) {
    headers.set("content-type", "text/html; charset=utf-8");
    return new Response(error.descriptionHtml, { status, statusText: "Error", headers });
  } else {
    return new Response(null, { status, statusText: "Error", headers });
  }
}

function responseFromWebSession(webResponse, bodyStream, fetchContext) {
  switch (webResponse.which()) {
    case WebSession.Response.CONTENT: {
      const content = webResponse.content;
      const headers = webSessionResponseHeaders(webResponse);
      addWebSessionContentHeaders(headers, content);
      const status = webSessionSuccessStatus(content.statusCode);
      if (content.body._isStream) {
        return {
          response: new Response(bodyStream.readable, { status, statusText: "OK", headers }),
          streaming: true,
        };
      }

      bodyStream.finish();
      const body = status === 204 || status === 304 ? null : capnpDataBytes(content.body.bytes);
      return {
        response: new Response(body, { status, statusText: "OK", headers }),
        streaming: false,
      };
    }

    case WebSession.Response.NO_CONTENT: {
      bodyStream.finish();
      const noContent = webResponse.noContent;
      const headers = webSessionResponseHeaders(webResponse);
      if (noContent._hasETag()) headers.append("etag", formatWebSessionETag(noContent.eTag));
      return {
        response: new Response(null, {
          status: noContent.shouldResetForm ? 205 : 204,
          statusText: "No Content",
          headers,
        }),
        streaming: false,
      };
    }

    case WebSession.Response.PRECONDITION_FAILED: {
      bodyStream.finish();
      const preconditionFailed = webResponse.preconditionFailed;
      const headers = webSessionResponseHeaders(webResponse);
      if (preconditionFailed._hasMatchingETag()) {
        headers.append("etag", formatWebSessionETag(preconditionFailed.matchingETag));
      }
      return {
        response: new Response(null, {
          status: fetchContext.sendNotModifiedForPrecondition ? 304 : 412,
          statusText: fetchContext.sendNotModifiedForPrecondition
            ? "Not Modified"
            : "Precondition Failed",
          headers,
        }),
        streaming: false,
      };
    }

    case WebSession.Response.REDIRECT: {
      bodyStream.finish();
      const redirect = webResponse.redirect;
      const headers = webSessionResponseHeaders(webResponse);
      headers.set("location", redirect.location);
      const status = redirect.isPermanent
        ? (redirect.switchToGet ? 301 : 308)
        : (redirect.switchToGet ? 303 : 307);
      return {
        response: new Response(null, { status, statusText: "Redirect", headers }),
        streaming: false,
      };
    }

    case WebSession.Response.CLIENT_ERROR:
      bodyStream.finish();
      return {
        response: webSessionErrorResponse(
          webResponse.clientError,
          webSessionClientErrorStatus(webResponse.clientError.statusCode)),
        streaming: false,
      };

    case WebSession.Response.SERVER_ERROR:
      bodyStream.finish();
      return {
        response: webSessionErrorResponse(webResponse.serverError, 500),
        streaming: false,
      };

    default:
      bodyStream.finish();
      return {
        response: Response.json({ ok: false, error: "unsupported WebSession response" }, {
          status: 502,
        }),
        streaming: false,
      };
  }
}

function webSessionFetchContext(request, responseStream) {
  let ifMatch = null;
  let ifNoneMatch = null;
  const additionalHeaders = [];

  for (const [rawName, rawValue] of request.headers) {
    const name = String(rawName).toLowerCase();
    const value = String(rawValue);
    if (name === "content-type" || !shouldForwardCapabilityFetchHeader(name)) {
      continue;
    }
    if (!isValidCapabilityFetchHeaderName(name) || !isValidCapabilityFetchHeaderValue(value)) {
      throw new ValidationError(`claimed capability fetch header is invalid`);
    }

    if (name === "if-match") {
      if (ifMatch !== null) {
        throw new ValidationError(`claimed capability fetch can only include one If-Match header`);
      }
      ifMatch = value;
    } else if (name === "if-none-match") {
      if (ifNoneMatch !== null) {
        throw new ValidationError(
          `claimed capability fetch can only include one If-None-Match header`);
      }
      ifNoneMatch = value;
    } else {
      additionalHeaders.push({ name, value });
    }
  }

  let eTagPrecondition = { none: true };
  let sendNotModifiedForPrecondition = false;
  if (ifMatch !== null) {
    const value = ifMatch.trim();
    eTagPrecondition = value === "*"
      ? { exists: true }
      : { matchesOneOf: parseFetchETagList(value) };
  } else if (ifNoneMatch !== null) {
    const value = ifNoneMatch.trim();
    sendNotModifiedForPrecondition = true;
    eTagPrecondition = value === "*"
      ? { doesntExist: true }
      : { matchesNoneOf: parseFetchETagList(value) };
  }

  return {
    context: {
      cookies: [],
      responseStream,
      accept: [],
      acceptEncoding: [],
      eTagPrecondition,
      additionalHeaders,
    },
    sendNotModifiedForPrecondition,
  };
}

function normalizeWebSessionFetchPath(path) {
  if (path.length > 8192) {
    throw new ValidationError(`claimed capability fetch path is too long`);
  }
  let start = 0;
  while (start < path.length && path[start] === "/") ++start;
  return path.slice(start);
}

function outboundHttpSessionRequestMethod(method) {
  switch (String(method).toUpperCase()) {
    case "GET": return 0;
    case "POST": return 1;
    case "PUT": return 2;
    case "PATCH": return 3;
    case "DELETE": return 4;
    case "HEAD": return 5;
    case "OPTIONS": return 6;
    default:
      throw new ValidationError(`unsupported outbound HTTP method: ${method}`);
  }
}

function shouldForwardOutboundHttpResponseHeader(name) {
  if (!isValidCapabilityFetchHeaderName(name)) return false;
  switch (String(name).toLowerCase()) {
    case "connection":
    case "content-length":
    case "keep-alive":
    case "te":
    case "trailer":
    case "transfer-encoding":
    case "upgrade":
      return false;
    default:
      return true;
  }
}

function normalizeOutboundHttpFetchPath(path) {
  if (path.length > 8192) {
    throw new ValidationError(`outbound HTTP fetch path is too long`);
  }
  if (path.startsWith("/")) {
    throw new ValidationError(
      `outbound HTTP fetch path must be relative to the granted base URL`);
  }
  if (path.includes("://")) {
    throw new ValidationError(`outbound HTTP fetch path must not be an absolute URL`);
  }

  const pathOnly = path.split("?", 1)[0];
  if (pathOnly.includes("#")) {
    throw new ValidationError(`outbound HTTP fetch path must not contain a fragment`);
  }
  for (const segment of pathOnly.split("/")) {
    if (segment === "." || segment === "..") {
      throw new ValidationError(`outbound HTTP fetch path must not contain dot segments`);
    }
  }
  for (let i = 0; i < path.length; ++i) {
    const code = path.charCodeAt(i);
    if (code === 0 || code === 0x0a || code === 0x0d) {
      throw new ValidationError(`outbound HTTP fetch path contains invalid characters`);
    }
  }

  return path;
}

function outboundHttpResponseHeaders(headersList) {
  const headers = new Headers();
  for (const header of headersList) {
    if (shouldForwardOutboundHttpResponseHeader(header.name) &&
        isValidCapabilityFetchHeaderValue(header.value)) {
      headers.append(header.name, header.value);
    }
  }
  return headers;
}

function safeOutboundHttpStatusText(statusText) {
  statusText = String(statusText || "");
  return statusText.length > 0 && statusText.length <= 128 &&
      isValidCapabilityFetchHeaderValue(statusText)
    ? statusText
    : "OK";
}

function safeOutboundHttpStatus(statusCode) {
  const status = Number(statusCode);
  return Number.isInteger(status) && status >= 200 && status <= 599 ? status : 502;
}

async function restoreCapabilityToken(env, token, options = {}) {
  const tokenText = savedCapabilityToken(token);
  const metadata = savedCapabilityEnvelopeMetadata(tokenText);
  const bridge = connectIsolateBridge(nativeCapnpBridgeApi(env), {
    connectionId: makeLiveCapabilityId("restore"),
  });
  try {
    const apiResult = await bridge.getSandstormApi({});
    const sandstormApi = apiResult.api;
    if (!sandstormApi || typeof sandstormApi.restore !== "function") {
      throw new Error("isolate bridge returned a SandstormApi without restore()");
    }

    const restoredPromise = sandstormApi.restore({
      token: nativeCapnpSavedTokenData(tokenText),
    });
    const cap = capnpCapabilityFromResult(restoredPromise, "restored capability");
    if (!cap) {
      throw new Error("SandstormApi.restore() returned no capability");
    }
    await restoredPromise;

    return new Capability(env, cap, {
      ...metadata,
      kind: metadata.kind || "restored",
      bridge,
      browserSessionId: options.browserSessionId,
    });
  } catch (error) {
    bridge.close(error);
    throw error;
  }
}

async function revokeCapabilityToken(env, token) {
  const tokenData = nativeCapnpSavedTokenData(savedCapabilityToken(token));
  await withSandstormApiRpc(env, async (sandstormApi) => {
    if (typeof sandstormApi.drop !== "function") {
      throw new Error("isolate bridge returned a SandstormApi without drop()");
    }

    await sandstormApi.drop({ token: tokenData });
  });
  return { ok: true };
}

async function useCapabilityToken(env, token, fn, options = {}) {
  if (typeof fn !== "function") {
    failValidation("capability use callback", "a function", fn);
  }

  const capability = await restoreCapabilityToken(env, token, options);
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
      `nativeInterface ${nativeInterface} cannot be fetched. Use a generated capnp: client ` +
      `for typed RPC capabilities`);
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

  try {
    const webSession = new WebSession.Client(
      capabilityCapnpClient(capability, "WebSession capability"));
    const bodyStream = createCapabilityByteStream();
    const fetchContext = webSessionFetchContext(request, bodyStream.client);
    const context = fetchContext.context;
    const method = String(request.method || "GET").toLowerCase();
    const path = normalizeWebSessionFetchPath(`${url.pathname}${url.search}`);
    const bodyBytes = await requestBodyBytes(request);
    const contentType = request.headers.get("content-type") || "";

    let result;
    if (method === "get" || method === "head") {
      result = await webSession.get({ path, context, ignoreBody: method === "head" });
    } else if (method === "post") {
      result = await webSession.post({
        path,
        content: { mimeType: contentType, content: bodyBytes },
        context,
      });
    } else if (method === "put") {
      result = await webSession.put({
        path,
        content: { mimeType: contentType, content: bodyBytes },
        context,
      });
    } else if (method === "patch") {
      result = await webSession.patch({
        path,
        content: { mimeType: contentType, content: bodyBytes },
        context,
      });
    } else if (method === "delete") {
      result = await webSession.delete({ path, context });
    } else {
      bodyStream.finish();
      return Response.json({
        ok: false,
        error: "claimed capability fetch method is not supported",
      }, { status: 405 });
    }

    const converted = responseFromWebSession(result, bodyStream, fetchContext);
    return converted.response;
  } catch (error) {
    return Response.json({
      ok: false,
      error: `claimed capability fetch failed: ${error?.message || String(error)}`,
    }, { status: 502 });
  }
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
      `${nativeInterface}; use a generated capnp: client for typed RPC capabilities`);
  }

  const { request, path } = outboundHttpSessionRequest(input, init);
  const headers = [];
  for (const [name, value] of request.headers) {
    if (!isValidCapabilityFetchHeaderName(name) || !isValidCapabilityFetchHeaderValue(value)) {
      throw new ValidationError(`outbound HTTP fetch header is invalid`);
    }
    headers.push({ name: String(name).toLowerCase(), value: String(value) });
  }

  try {
    const outbound = new OutboundHttpSession.Client(
      capabilityCapnpClient(capability, "OutboundHttpSession capability"));
    const bodyStream = createCapabilityByteStream();
    const result = await outbound.request({
      method: outboundHttpSessionRequestMethod(request.method || "GET"),
      path: normalizeOutboundHttpFetchPath(path),
      headers,
      body: await requestBodyBytes(request),
      responseStream: bodyStream.client,
    });
    const status = safeOutboundHttpStatus(result.statusCode);
    const emptyBody = status === 204 || status === 304;
    if (emptyBody) {
      bodyStream.finish();
    }
    return new Response(emptyBody ? null : bodyStream.readable, {
      status,
      statusText: safeOutboundHttpStatusText(result.statusText),
      headers: outboundHttpResponseHeaders(result.headers),
    });
  } catch (error) {
    return Response.json({
      ok: false,
      error: `outbound HTTP fetch failed: ${error?.message || String(error)}`,
    }, { status: 502 });
  }
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

async function requiredPermissionSet(env, names) {
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

  const required = new Set(names);
  return declaredNames.map((name) => required.has(name));
}

async function validateRequiredPermissions(env, names) {
  if (names.length === 0) return;

  await requiredPermissionSet(env, names);
}

export function powerbox(request, env) {
  const claimToken = async (token, options = {}) => {
    token = validate.string(token, "token", { minLength: 1, maxLength: 4096 });
    const requiredPermissions = permissionNames(options);
    const permissions = await requiredPermissionSet(env, requiredPermissions);
    powerboxDescriptorParams(options);
    const nativeInterface = claimNativeInterface(options);
    const sessionId = sessionIdForPowerbox(request);

    const bridge = connectIsolateBridge(nativeCapnpBridgeApi(env), {
      connectionId: makeLiveCapabilityId("powerbox-claim"),
    });
    try {
      if (typeof bridge.getSessionContext !== "function") {
        throw new Error("isolate bridge returned no session-context resolver");
      }

      const session = await bridge.getSessionContext({ sessionId });
      if (!session?.context) {
        throw new Error("isolate bridge returned no SessionContext capability");
      }
      const claimedPromise = session.context.claimRequest({
        requestToken: token,
        requiredPermissions: permissions,
      });
      const cap = capnpCapabilityFromResult(claimedPromise, "Powerbox claimed capability");
      if (!cap) {
        throw new Error("SessionContext.claimRequest() returned no capability");
      }
      await claimedPromise;

      return new Capability(env, cap, {
        kind: "powerboxClaim",
        bridge,
        nativeInterface,
        pathPrefix: "",
        browserSessionId: sessionId,
      });
    } catch (error) {
      bridge.close(error);
      throw error;
    }
  };

  return {
    async apiSessionDescriptor(options = {}) {
      return apiSessionPowerboxDescriptor(env, options);
    },

    async outboundHttpDescriptor(options = {}) {
      return outboundHttpPowerboxDescriptor(env, options);
    },

    async appInterfaceDescriptor(options = {}) {
      return appInterfacePowerboxDescriptor(env, options);
    },

    async claim(result, options = {}) {
      if (typeof result === "string") {
        return claimToken(result, options);
      }

      if (!result || typeof result !== "object") {
        throw new ValidationError("Powerbox claim result must be a token string or result object");
      }

      if (result.capability) {
        if (result.capability instanceof Capability) {
          return result.capability;
        }
        throw new ValidationError(
          "Powerbox claim result capability must be a live Sandstorm Capability");
      }

      if (typeof result.token === "string") {
        return claimToken(result.token, options);
      }

      throw new ValidationError("Powerbox claim result must contain token or capability");
    },

    async offered() {
      const sessionId = header(request, "x-sandstorm-session-id");
      const descriptor = jsonHeader(request, "x-sandstorm-offer-descriptor");
      if (!sessionId || !descriptor) {
        return undefined;
      }

      const bridge = connectIsolateBridge(nativeCapnpBridgeApi(env), {
        connectionId: makeLiveCapabilityId("powerbox-offer"),
      });
      let result;
      let cap;
      try {
        const resultPromise = bridge.getOfferedCapability({ sessionId });
        cap = capnpCapabilityFromResult(resultPromise, "offered capability");
        result = await resultPromise;
      } catch (error) {
        bridge.close(error);
        throw error;
      }

      if (!result?.found || !cap) {
        bridge.close();
        return undefined;
      }

      const capability = new Capability(env, cap, {
        kind: "powerboxOffer",
        bridge,
        residence: "imported",
        nativeInterface: offerDescriptorNativeInterface(descriptor),
        pathPrefix: "",
        browserSessionId: sessionId,
      });
      return {
        capability,
        id: capability.id,
        descriptor,
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
      host: header(request, "host"),
      forwardedProto: header(request, "x-forwarded-proto"),
      userAgent: header(request, "user-agent"),
      acceptableLanguages: list(header(request, "accept-language")),
    },
    offer: {
      descriptor: jsonHeader(request, "x-sandstorm-offer-descriptor"),
    },
  };
}

export function nativeCapnpBrowserClientScript() {
  return `
import {
  Conn,
  DeferredTransport,
  Interface as CapnpEsInterface,
  Message,
} from "/capnp-es/index.mjs";
import { BrowserIsolateBridge } from "/__sandstorm/capnp/sandstorm/isolate-bridge.capnp.js";

export const SANDSTORM_CAPNP_NATIVE_BRIDGE_PROTOCOL_VERSION = 0;

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

async function readJsonResponse(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      error: text || "HTTP " + response.status,
    };
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

function nativeCapnpCapabilityForInterface(capability, InterfaceClass, options = {}) {
  const metadata = nativeCapnpInterfaceMetadata(InterfaceClass, options);
  return Object.freeze({
    ...capability,
    id: capability.id,
    interfaceId: options.interfaceId ?? capability.interfaceId ?? metadata.interfaceId,
    interfaceName: options.interfaceName ?? capability.interfaceName ?? metadata.interfaceName,
    kind: capability.kind ?? "receiverHosted",
  });
}

function normalizeConnectionId(connectionId) {
  if (typeof connectionId === "string" && connectionId.length > 0) return connectionId;
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return "browser-native-capnp-" + globalThis.crypto.randomUUID();
  }
  return "browser-native-capnp-" + Date.now().toString(36) + "-" +
    Math.random().toString(36).slice(2);
}

export async function nativeCapnpBridgeInfo() {
  const response = await fetch("/__sandstorm/native-capnp/bridge-info");
  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new NativeCapnpBridgeUnavailableError(
      result.error || "native bridge info request failed", { response, result });
  }
  return result;
}

async function nativeCapnpBrowserMessageBytes(data) {
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  return nativeCapnpMessageBytes(data);
}

export function browserNativeCapnpRpcSessionUrl(connectionId) {
  const normalizedConnectionId = normalizeConnectionId(connectionId);
  const url = new URL(
    "/__sandstorm/native-capnp/rpc-session",
    globalThis.location?.href || "http://sandstorm/");
  if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else if (url.protocol === "http:") {
    url.protocol = "ws:";
  }
  url.searchParams.set("bootstrap", "browser");
  url.searchParams.set("connectionId", normalizedConnectionId);
  return url;
}

export function openBrowserNativeCapnpRpcSession(connectionId) {
  const url = browserNativeCapnpRpcSessionUrl(connectionId);
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

export const browserNativeCapnpApi = Object.freeze({
  capnpBridgeInfo: nativeCapnpBridgeInfo,
  openBrowserNativeCapnpRpcSession,
});

const nativeCapnpPowerboxDescriptorCache = new Map();

function validateNativeCapnpPowerboxDescriptor(descriptor, name = "descriptor") {
  if (typeof descriptor !== "string" || descriptor.length === 0) {
    throw new TypeError(name + " must be a non-empty packed Powerbox descriptor string");
  }
  return descriptor;
}

async function fetchNativeCapnpPowerboxDescriptorInfo(InterfaceClass, options = {}) {
  const metadata = nativeCapnpInterfaceMetadata(InterfaceClass, options);
  if (!metadata.interfaceIdText) {
    throw new TypeError("native Cap'n Proto Powerbox descriptor requires an interface id");
  }

  const descriptorUrl = options.descriptorUrl ||
    "/__sandstorm/powerbox/app-interface-descriptor";
  const url = new URL(descriptorUrl, globalThis.location?.href || "http://sandstorm/");
  url.searchParams.set("interfaceId", metadata.interfaceIdText);
  url.searchParams.set("interfaceName", metadata.interfaceName);
  const cacheKey = url.href;
  if (nativeCapnpPowerboxDescriptorCache.has(cacheKey)) {
    return cloneNativeCapnpJsonValue(nativeCapnpPowerboxDescriptorCache.get(cacheKey));
  }

  const response = await fetch(url);
  const result = await readJsonResponse(response);
  if (!response.ok || !result.ok) {
    throw new NativeCapnpBridgeUnavailableError(
      result.error || "Powerbox descriptor request failed with " + response.status,
      { response, result });
  }
  validateNativeCapnpPowerboxDescriptor(result.descriptor, "native Cap'n Proto descriptor");
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

async function fetchPowerboxDescriptorInfo(path, params) {
  const url = new URL(path, globalThis.location?.href || "http://sandstorm/");
  for (const [name, value] of params) {
    url.searchParams.append(name, value);
  }
  const response = await fetch(url);
  const result = await readJsonResponse(response);
  if (!response.ok || !result.ok) {
    throw new NativeCapnpBridgeUnavailableError(
      result.error || "Powerbox descriptor request failed with " + response.status,
      { response, result });
  }
  validatePackedPowerboxDescriptor(result.descriptor);
  return result;
}

export async function apiSessionPowerboxDescriptorInfo(options = {}) {
  const descriptor = options.apiSession ?? options.apiSessionDescriptor ?? options;
  const params = [];
  if (descriptor.canonicalUrl !== undefined) {
    params.push(["canonicalUrl", String(descriptor.canonicalUrl)]);
  }
  for (const scope of descriptor.oauthScopes || []) {
    params.push(["oauthScope", String(scope)]);
  }
  return fetchPowerboxDescriptorInfo("/__sandstorm/powerbox/api-session-descriptor", params);
}

export async function apiSessionPowerboxDescriptor(options = {}) {
  return (await apiSessionPowerboxDescriptorInfo(options)).descriptor;
}

export async function outboundHttpPowerboxDescriptorInfo(options = {}) {
  const descriptor = options.outboundHttp ?? options.outboundHttpDescriptor ?? options;
  const params = [["baseUrl", String(descriptor.baseUrl || "")]];
  for (const method of descriptor.methods || []) {
    params.push(["method", String(method)]);
  }
  return fetchPowerboxDescriptorInfo("/__sandstorm/powerbox/outbound-http-descriptor", params);
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

  const connection = createBrowserNativeCapnpConnection(options);
  const bridge = connection.bootstrap(BrowserIsolateBridge);
  try {
  const claimed = await bridge.claimPowerboxRequest({
      requestToken: token,
      requiredPermissions: browserRequiredPermissionNames(options),
    });
    const cap = capnpCapabilityFromResult(claimed, "browser Powerbox claimed capability");
    if (!cap) {
      throw new NativeCapnpBridgeProtocolError(
        "browser isolate bridge did not return a claimed Powerbox capability");
    }
    const metadata = nativeCapnpInterfaceMetadata(InterfaceClass, options);
    const client = browserNativeCapnpClient(
      cap, InterfaceClass, "browser Powerbox claimed capability");
    return Object.freeze({
      type: "browserNativeCapnpCapability",
      interfaceId: metadata.interfaceId,
      interfaceName: metadata.interfaceName,
      kind: "receiverHosted",
      cap,
      client,
      connection,
      transport: connection.transport,
    });
  } catch (error) {
    connection.transport.close();
    throw error;
  }
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
    connection: capability.connection,
    transport: capability.transport,
  });
}

export class BrowserNativeCapnpBridgeWebSocketTransport extends DeferredTransport {
  #webSocket = null;
  #openPromise = null;
  #sendQueue = Promise.resolve();

  constructor(options = {}) {
    super();
    this.connectionId = normalizeConnectionId(options.connectionId);
    this.connection = null;
    this.kind = "browserIsolateBridgeWebSocketRpc";
  }

  sendMessage(message) {
    if (this.closed) {
      throw new NativeCapnpBridgeUnavailableError(
        "native Cap'n Proto browser WebSocket RPC transport is closed");
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
    if (this.closed) return;
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
      this.#openPromise = openBrowserNativeCapnpRpcSession(this.connectionId).then((webSocket) => {
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
        return webSocket;
      });
    }

    return await this.#openPromise;
  }
}

export function createBrowserNativeCapnpConnection(options = {}) {
  if (typeof WebSocket !== "function") {
    throw new NativeCapnpBridgeUnavailableError(
      "native Cap'n Proto browser RPC requires WebSocket");
  }
  const transport = new BrowserNativeCapnpBridgeWebSocketTransport(options);
  const connection = new Conn(transport, options.finalize);
  transport.connection = connection;
  return Object.assign(connection, { transport });
}

export function connectBrowserNativeCapnp(target, InterfaceClass, options = {}) {
  if (!InterfaceClass || typeof InterfaceClass.Client !== "function") {
    throw new TypeError("connectBrowserNativeCapnp() requires a capnp-es generated interface");
  }
  const normalizedTarget = normalizeNativeCapnpCapabilitySlot(target);
  const connection = createBrowserNativeCapnpConnection(options);
  const bridge = connection.bootstrap(BrowserIsolateBridge);
  const claimed = bridge.getHandoffCapability({ id: normalizedTarget.id });
  const cap = capnpCapabilityFromResult(claimed, "browser handoff capability pipeline");
  if (!cap) {
    connection.transport.close();
    throw new NativeCapnpBridgeProtocolError(
      "browser isolate bridge did not return a handoff capability pipeline");
  }
  const client = browserNativeCapnpClient(
    cap, InterfaceClass, "browser handoff capability pipeline");
  return Object.assign(client, {
    capability: normalizedTarget,
    connection,
    transport: connection.transport,
  });
}
`;
}

export function sandstorm(request, env) {
  const browserSessionId = header(request, "x-sandstorm-session-id");
  const withBrowserSession = (options = {}) => browserSessionId
    ? { ...options, browserSessionId }
    : options;

  return {
    session: () => getSession(request),
    status: () => callSandstorm(env, "status"),
    capabilities: () => callSandstorm(env, "capabilities"),
    runtime: () => callSandstorm(env, "runtime"),
    modules: () => callSandstorm(env, "modules"),
    bindings: () => callSandstorm(env, "bindings"),
    capnpBridgeInfo: () => callSandstorm(env, "capnp/bridge-info"),
    nativeCapnpBridgeOpenBootstrapSession: (connectionId) =>
      openNativeCapnpBridgeBootstrapSession(env, connectionId),
    storage: () => storage(env),
    powerbox: () => powerbox(request, env),
    webSession: (options = {}) => createWebSessionCapability(env, withBrowserSession(options)),
    apiSession: (options = {}) => createApiSessionCapability(env, withBrowserSession(options)),
    restore: (token) => restoreCapabilityToken(env, token, { browserSessionId }),
    revoke: (token) => revokeCapabilityToken(env, token),
    use: (token, fn) => useCapabilityToken(env, token, fn, { browserSessionId }),
    powerboxFulfillment: (options = {}) => powerboxFulfillment(request, env, options),
    powerboxGrants: (options = {}) => powerboxGrants(request, env, options),
    serveSystemRoutes: async (options = {}) => await serveSystemRoutes(request, env, options),
  };
}
