import capnwebSource from "sandstorm:capnweb-source";
import { RpcTarget, newWorkersRpcResponse } from "capnweb";

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

function storageUrl(key = "") {
  if (key.includes("/")) {
    throw new Error("storage keys must be single path segments");
  }
  return `http://storage/${encodeURIComponent(key)}`;
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
}

export function apiTarget(request, env) {
  return new SandstormRpcTarget(request, env);
}

export function rpcClientScript() {
  return capnwebSource;
}

export function rpcResponse(request, target, options) {
  return newWorkersRpcResponse(request, target, options);
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
    apiTarget: () => apiTarget(request, env),
    rpcClientScript: () => rpcClientScript(),
    rpcResponse: (target, options) => rpcResponse(request, target, options),
  };
}
