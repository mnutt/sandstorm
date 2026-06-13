import { RpcTarget, newWorkersRpcResponse } from "capnweb";
import { browserClientScript } from "sandstorm:rpc";

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

    async get(key) {
      const response = await env.STORAGE.fetch(storageUrl(key));
      if (response.status === 404) return undefined;
      if (!response.ok) {
        throw new Error(`storage get ${key} failed with ${response.status}`);
      }
      return response.text();
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

function saveLabel(options = {}) {
  let label = options.label ?? options.saveLabel ?? "Claimed Sandstorm capability";
  if (label && typeof label === "object" && typeof label.defaultText === "string") {
    label = label.defaultText;
  }
  return validate.string(label, "label", { minLength: 1, maxLength: 256 });
}

async function saveClaimedCapability(env, capability, options = {}) {
  const id = encodeURIComponent(capabilityId(capability));
  const label = encodeURIComponent(saveLabel(options));
  return postSandstorm(env, `powerbox/save?id=${id}&label=${label}`);
}

function attachClaimedCapabilityMethods(env, capability) {
  if (!capability || typeof capability !== "object" ||
      capability.type !== "claimedCapability" || typeof capability.id !== "string") {
    return capability;
  }

  Object.defineProperties(capability, {
    save: {
      enumerable: false,
      value: (options = {}) => saveClaimedCapability(env, capability, options),
    },
    drop: {
      enumerable: false,
      value: () => postSandstorm(
        env, `powerbox/drop?id=${encodeURIComponent(capabilityId(capability))}`),
    },
    [Symbol.dispose]: {
      enumerable: false,
      value: () => {
        postSandstorm(env, `powerbox/drop?id=${encodeURIComponent(capabilityId(capability))}`)
          .catch(() => {});
      },
    },
  });
  return capability;
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
      const capability = await postSandstorm(env,
        `powerbox/claim-request?sessionId=${sessionId}&token=${encodedToken}${permissionQuery}`);
      return attachClaimedCapabilityMethods(env, capability);
    },

    async offer() {
      unsupportedPowerbox("offer");
    },

    async fulfillRequest() {
      unsupportedPowerbox("fulfillRequest");
    },

    async save(capability, options = {}) {
      return saveClaimedCapability(env, capability, options);
    },

    async restore() {
      unsupportedPowerbox("restore");
    },

    async drop(capability) {
      const id = encodeURIComponent(capabilityId(capability));
      return postSandstorm(env, `powerbox/drop?id=${id}`);
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

  get(key) {
    return storage(this.#env).get(key);
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

  async offer() {
    unsupportedPowerbox("offer");
  }

  async fulfillRequest() {
    unsupportedPowerbox("fulfillRequest");
  }

  async save(capability, options = {}) {
    return powerbox(this.#request, this.#env).save(capability, options);
  }

  async restore() {
    unsupportedPowerbox("restore");
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
    apiTarget: () => apiTarget(request, env),
    rpcClientScript: () => rpcClientScript(),
    rpcResponse: (target, options) => rpcResponse(request, target, options),
    serveRpc: (target, options) => serveRpc(request, target, options),
  };
}
