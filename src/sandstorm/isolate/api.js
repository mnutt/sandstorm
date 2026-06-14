import { RpcTarget, newWorkersRpcResponse } from "capnweb";
import { browserClientScript } from "sandstorm:rpc";

export { RpcTarget } from "capnweb";

const OBJECT_CAPABILITY_PREFIX = "/__sandstorm/object-capabilities";
const exportedObjectTargets = new Map();
const claimedCapabilityDisposers = new Map();

function header(request, name) {
  return request.headers.get(name) || "";
}

function list(value) {
  return value ? value.split(",").filter((item) => item.length > 0) : [];
}

async function callSandstorm(env, path) {
  const response = await env.SANDSTORM_API.fetch(`http://sandstorm/${path}`);
  if (!response.ok) {
    throw new Error(`Sandstorm API ${path} failed with ${response.status}`);
  }
  return response.json();
}

async function postSandstorm(env, path) {
  const response = await env.SANDSTORM_API.fetch(`http://sandstorm/${path}`, {
    method: "POST",
  });
  const body = await response.json();
  if (!response.ok || !body.ok) {
    throw new Error(body.error || `Sandstorm API ${path} failed with ${response.status}`);
  }
  return body;
}

function powerboxFetcher(env) {
  return env.POWERBOX || env.SANDSTORM_API;
}

async function postPowerbox(env, path) {
  const response = await powerboxFetcher(env).fetch(`http://sandstorm/${path}`, {
    method: "POST",
  });
  const body = await response.json();
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

  save(options = {}) {
    return saveClaimedCapability(this.#env, this, options);
  }

  async drop() {
    const result = await postPowerbox(
      this.#env, `powerbox/drop?id=${encodeURIComponent(this.id)}`);
    const disposer = claimedCapabilityDisposers.get(this.id);
    if (disposer) {
      claimedCapabilityDisposers.delete(this.id);
      disposer();
    }
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

function displayTitle(options = {}) {
  let title = options.title ?? options.displayTitle ?? options.label ?? "Claimed Sandstorm capability";
  if (title && typeof title === "object" && typeof title.defaultText === "string") {
    title = title.defaultText;
  }
  return validate.string(title, "title", { minLength: 1, maxLength: 256 });
}

async function saveClaimedCapability(env, capability, options = {}) {
  const id = encodeURIComponent(capabilityId(capability));
  const label = encodeURIComponent(saveLabel(options));
  return wrapSavedCapability(env, await postPowerbox(env, `powerbox/save?id=${id}&label=${label}`));
}

async function sessionPowerboxAction(env, request, endpoint, capability, options = {}) {
  const sessionId = encodeURIComponent(sessionIdForPowerbox(request));
  const id = encodeURIComponent(capabilityId(capability));
  const title = encodeURIComponent(displayTitle(options));
  const permissionQuery = permissionNames(options)
    .map((name) => `&requiredPermission=${encodeURIComponent(name)}`)
    .join("");
  return postPowerbox(env,
    `powerbox/${endpoint}?sessionId=${sessionId}&id=${id}&title=${title}${permissionQuery}`);
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

function webSessionPathPrefix(options = {}) {
  const value = options.pathPrefix ?? options.prefix ?? "";
  const pathPrefix = validate.string(value, "pathPrefix", { maxLength: 1024 });
  if (pathPrefix.length > 0 && !pathPrefix.startsWith("/")) {
    throw new ValidationError("pathPrefix must be empty or start with '/'");
  }
  if (pathPrefix.includes("://")) {
    throw new ValidationError("pathPrefix must be path-relative");
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

async function createWebSessionCapability(env, options = {}) {
  const pathPrefix = encodeURIComponent(webSessionPathPrefix(options));
  const persistent = webSessionPersistent(options) ? "true" : "false";
  return wrapClaimedCapability(
    env, await postSandstorm(
      env, `capabilities/web-session?pathPrefix=${pathPrefix}&persistent=${persistent}`));
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

async function createObjectCapability(env, target) {
  if (!target || typeof target !== "object") {
    throw new ValidationError("capability target must be an object");
  }

  const id = typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  exportedObjectTargets.set(id, target);

  try {
    const capability = await createWebSessionCapability(env, {
      pathPrefix: `${OBJECT_CAPABILITY_PREFIX}/${encodeURIComponent(id)}`,
      persistent: false,
    });
    claimedCapabilityDisposers.set(capability.id, () => exportedObjectTargets.delete(id));
    return capability;
  } catch (error) {
    exportedObjectTargets.delete(id);
    throw error;
  }
}

async function callClaimedCapability(capability, method, args = []) {
  method = capabilityMethodName(method);
  args = capabilityArgs(args);
  const response = await capability.fetch("/call", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ method, args }),
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

async function serializeCapabilityValue(env, value) {
  if (value instanceof RpcTarget) {
    return createObjectCapability(env, value);
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => serializeCapabilityValue(env, item)));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (value instanceof ClaimedCapability || value instanceof SavedCapability) {
    return value.toJSON();
  }

  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = await serializeCapabilityValue(env, item);
  }
  return result;
}

function hydrateCapabilityValue(env, value) {
  if (Array.isArray(value)) {
    return value.map((item) => hydrateCapabilityValue(env, item));
  }
  return wrapCapabilityValue(env, value);
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

  if (request.method === "DELETE" && action === "") {
    exportedObjectTargets.delete(decodeURIComponent(id));
    return Response.json({ ok: true });
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
      result: await serializeCapabilityValue(env, result),
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

export function powerbox(request, env) {
  return {
    async request() {
      unsupportedPowerbox("request");
    },

    async claimRequest(token, options = {}) {
      token = validate.string(token, "token", { minLength: 1, maxLength: 4096 });
      const sessionId = encodeURIComponent(sessionIdForPowerbox(request));
      const encodedToken = encodeURIComponent(token);
      const permissionQuery = permissionNames(options)
        .map((name) => `&requiredPermission=${encodeURIComponent(name)}`)
        .join("");
      const capability = await postPowerbox(env,
        `powerbox/claim-request?sessionId=${sessionId}&token=${encodedToken}${permissionQuery}`);
      return wrapClaimedCapability(env, capability);
    },

    offeredCapability() {
      const id = header(request, "x-sandstorm-offered-capability-id");
      return id ? new ClaimedCapability(env, id) : undefined;
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

    async restore(token) {
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

  async request() {
    unsupportedPowerbox("request");
  }

  async claimRequest(token, options) {
    return powerbox(this.#request, this.#env).claimRequest(token, options);
  }

  offeredCapability() {
    return powerbox(this.#request, this.#env).offeredCapability();
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

  async restore(token) {
    return powerbox(this.#request, this.#env).restore(token);
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

  capability(target) {
    return createObjectCapability(this.#env, target);
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
    capability: (target) => createObjectCapability(env, target),
    serveObjectCapabilities: () => serveObjectCapability(request, env),
    apiTarget: () => apiTarget(request, env),
    rpcClientScript: () => rpcClientScript(),
    rpcResponse: (target, options) => rpcResponse(request, target, options),
    serveRpc: (target, options) => {
      if (isObjectCapabilityRequest(request)) {
        return serveObjectCapability(request, env);
      }
      return serveRpc(request, target, options);
    },
  };
}
