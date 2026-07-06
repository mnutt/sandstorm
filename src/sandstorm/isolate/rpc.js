import capnwebSource from "sandstorm:capnweb-source";
import { newHttpBatchRpcSession } from "capnweb";

export const SANDSTORM_RPC_VERSION = 0;
export const SANDSTORM_CAPNWEB_VERSION = "0.8.0";

export {
  RpcPromise,
  RpcSession,
  RpcStub,
  RpcTarget,
  deserialize,
  newHttpBatchRpcResponse,
  newHttpBatchRpcSession,
  newMessagePortRpcSession,
  newWebSocketRpcSession,
  newWorkersRpcResponse,
  newWorkersWebSocketRpcResponse,
  serialize,
} from "capnweb";

export function newSandstormRpcSession(url = "./rpc", options) {
  return newHttpBatchRpcSession(url, options);
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

export function requestPowerbox(query, options = {}) {
  if (typeof window === "undefined" || !window.parent) {
    return Promise.reject(new Error("requestPowerbox() is only available in a browser session"));
  }

  const rpcId = typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `sandstorm-powerbox-${Date.now()}-${Math.random()}`;

  return new Promise((resolve, reject) => {
    function cleanup() {
      window.removeEventListener("message", onMessage);
    }

    function onMessage(event) {
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

    window.addEventListener("message", onMessage);
    const powerboxRequest = {
      rpcId,
    };
    if (query !== undefined && query !== null) {
      powerboxRequest.query = query;
      powerboxRequest.saveLabel = options.saveLabel;
    }

    window.parent.postMessage({
      powerboxRequest,
    }, "*");
  });
}

export async function claimPowerboxToken(token, options = {}) {
  const {
    claimUrl = "/__sandstorm/powerbox/claim",
    requiredPermissions = [],
  } = options;
  const body = { token, requiredPermissions };
  if (options.apiSession !== undefined) {
    body.apiSession = options.apiSession;
  }
  if (options.apiSessionDescriptor !== undefined) {
    body.apiSessionDescriptor = options.apiSessionDescriptor;
  }
  if (options.outboundHttp !== undefined) {
    body.outboundHttp = options.outboundHttp;
  }
  if (options.outboundHttpDescriptor !== undefined) {
    body.outboundHttpDescriptor = options.outboundHttpDescriptor;
  }
  if (options.powerboxDescriptor !== undefined) {
    body.powerboxDescriptor = options.powerboxDescriptor;
  } else if (options.descriptor !== undefined) {
    body.descriptor = options.descriptor;
  }
  if (options.nativeInterface !== undefined) {
    body.nativeInterface = options.nativeInterface;
  }
  const response = await fetch(new URL(claimUrl, window.location.href), {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const result = await readJsonResponse(response);
  if (!response.ok || !result.ok) {
    throw new Error(result.error || `Powerbox claim failed with ${response.status}`);
  }
  return result.capability;
}

export async function requestAndClaimPowerbox(query, options = {}) {
  const requested = await requestPowerbox(query, options);
  const capability = await claimPowerboxToken(requested.token, options);
  return {
    ...requested,
    capability,
  };
}

function browserCapnpMethodNames(binding) {
  const methodNames = binding?.methodNames || binding?.schema?.methodNames;
  if (!Array.isArray(methodNames)) {
    throw new TypeError("browser Cap'n Proto binding requires methodNames");
  }
  return methodNames;
}

function browserCapnpSchema(binding) {
  return binding?.schema && typeof binding.schema === "object" ? binding.schema : {};
}

function resolveBrowserResultBinding(interfaceName, methodName, caster) {
  const binding = typeof caster === "function" ? caster() : caster;
  if (!binding || typeof binding !== "object") {
    throw new TypeError(
      interfaceName + "." + methodName + " result capability caster must be a schema binding");
  }
  return binding;
}

function browserCapabilityPath(path) {
  const parts = typeof path === "string" ? path.split(".") : path;
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new TypeError("browser Cap'n Proto capability path must be non-empty");
  }
  return parts;
}

function browserCapabilityPathEntries(spec) {
  if (!spec || typeof spec !== "object") return [];
  const entries = [];
  const fields = spec.fields;
  if (Array.isArray(fields)) {
    for (const [field, caster] of fields) {
      entries.push([browserCapabilityPath([field]), caster]);
    }
  } else if (fields && typeof fields === "object") {
    for (const [field, caster] of Object.entries(fields)) {
      entries.push([browserCapabilityPath([field]), caster]);
    }
  }

  const paths = spec.paths;
  if (Array.isArray(paths)) {
    for (const [path, caster] of paths) {
      entries.push([browserCapabilityPath(path), caster]);
    }
  } else if (paths && typeof paths === "object") {
    for (const [path, caster] of Object.entries(paths)) {
      entries.push([browserCapabilityPath(path), caster]);
    }
  }
  return entries;
}

function mapBrowserCapabilityPath(value, path, mapper) {
  if (path.length === 0) return mapper(value);
  if (!value || typeof value !== "object" || value.__sandstormCapnpBrowserStub) {
    return value;
  }

  const [field, ...rest] = path;
  if (!Object.prototype.hasOwnProperty.call(value, field)) {
    return value;
  }

  const mapped = mapBrowserCapabilityPath(value[field], rest, mapper);
  if (mapped === value[field]) return value;
  const copy = Array.isArray(value) ? [...value] : { ...value };
  copy[field] = mapped;
  return copy;
}

function browserStubValue(value) {
  return value && typeof value === "object" && value.__sandstormCapnpBrowserStub
    ? value.stub
    : value;
}

function castBrowserCapnpResult(interfaceName, methodName, result, resultCapabilities) {
  const spec = resultCapabilities?.[methodName];
  if (!spec) return result;

  if (typeof spec === "function" || spec.methodNames || spec.schema) {
    return connectBrowserCapnp(
      result, resolveBrowserResultBinding(interfaceName, methodName, spec));
  }

  const paths = browserCapabilityPathEntries(spec);
  if (paths.length === 0 || !result || typeof result !== "object") {
    return result;
  }

  let casted = result;
  for (const [path, caster] of paths) {
    casted = mapBrowserCapabilityPath(casted, path, (value) => connectBrowserCapnp(
      value, resolveBrowserResultBinding(interfaceName, methodName, caster)));
  }
  return casted;
}

function browserArgumentCapabilityPathEntries(spec) {
  const entries = [];
  const fields = spec?.fields;
  if (Array.isArray(fields)) {
    for (const field of fields) entries.push([browserCapabilityPath([field])]);
  } else if (fields && typeof fields === "object") {
    for (const field of Object.keys(fields)) entries.push([browserCapabilityPath([field])]);
  }

  const paths = spec?.paths;
  if (Array.isArray(paths)) {
    for (const entry of paths) {
      entries.push([browserCapabilityPath(Array.isArray(entry) && entry.length === 2
        ? entry[0]
        : entry)]);
    }
  } else if (paths && typeof paths === "object") {
    for (const path of Object.keys(paths)) entries.push([browserCapabilityPath(path)]);
  }
  return entries;
}

function normalizeBrowserCapnpArgs(methodName, args, argumentCapabilities) {
  const spec = argumentCapabilities?.[methodName];
  if (!spec) return args;

  let normalized = args;
  for (const index of spec.indexes || spec.indices || []) {
    if (Number.isInteger(index) && index >= 0 && index < args.length) {
      const next = browserStubValue(args[index]);
      if (next !== args[index]) {
        if (normalized === args) normalized = [...args];
        normalized[index] = next;
      }
    }
  }

  const paths = browserArgumentCapabilityPathEntries(spec);
  if (paths.length > 0 && args.length === 1) {
    let first = normalized[0];
    for (const [path] of paths) {
      first = mapBrowserCapabilityPath(first, path, browserStubValue);
    }
    if (first !== normalized[0]) {
      if (normalized === args) normalized = [...args];
      normalized[0] = first;
    }
  }
  return normalized;
}

function requiredBrowserMethods(interfaceName, methodNames, methods) {
  if (!methods || typeof methods !== "object") {
    throw new TypeError(`${interfaceName}.local() requires a methods object`);
  }
  for (const methodName of methodNames) {
    if (typeof methods[methodName] !== "function") {
      throw new TypeError(`${interfaceName}.${methodName} is not implemented`);
    }
  }
  return methods;
}

function makeBrowserLocalCapnp(interfaceName, methodNames, schema, methods) {
  const source = requiredBrowserMethods(interfaceName, methodNames, methods);
  const argumentCapabilities = schema.argumentCapabilities || {};
  const resultCapabilities = schema.resultCapabilities || {};
  const client = {};
  for (const methodName of methodNames) {
    client[methodName] = async (...args) => {
      const normalizedArgs = normalizeBrowserCapnpArgs(
        methodName, args, argumentCapabilities);
      const result = await source[methodName](...normalizedArgs);
      return castBrowserCapnpResult(interfaceName, methodName, result, resultCapabilities);
    };
  }
  return Object.freeze(client);
}

export function connectBrowserCapnp(stub, binding) {
  if (!stub || typeof stub !== "object" && typeof stub !== "function") {
    throw new TypeError("connectBrowserCapnp() requires a Cap'n Web RPC stub");
  }
  const interfaceName = binding?.interfaceName || browserCapnpSchema(binding).interfaceName || "";
  const methodNames = browserCapnpMethodNames(binding);
  const schema = browserCapnpSchema(binding);
  const argumentCapabilities = schema.argumentCapabilities || {};
  const resultCapabilities = schema.resultCapabilities || {};
  const client = {
    __sandstormCapnpBrowserStub: true,
    stub,
  };
  for (const methodName of methodNames) {
    client[methodName] = async (...args) => {
      const normalizedArgs = normalizeBrowserCapnpArgs(
        methodName, args, argumentCapabilities);
      const result = await stub[methodName](...normalizedArgs);
      return castBrowserCapnpResult(interfaceName, methodName, result, resultCapabilities);
    };
  }
  if (typeof stub[Symbol.dispose] === "function") {
    client[Symbol.dispose] = () => stub[Symbol.dispose]();
  }
  return Object.freeze(client);
}

async function fetchBrowserAppInterfacePowerboxDescriptor(interfaceName, schema, options = {}) {
  const interfaceId = schema.interfaceId || "";
  if (!interfaceId) {
    throw new TypeError(`${interfaceName}.powerboxDescriptor() requires schema interfaceId`);
  }

  const descriptorUrl = options.descriptorUrl ||
    "/__sandstorm/powerbox/app-interface-descriptor";
  const url = new URL(descriptorUrl, window.location.href);
  url.searchParams.set("interfaceId", interfaceId);
  url.searchParams.set("interfaceName", schema.interfaceName || interfaceName);

  const response = await fetch(url);
  const result = await readJsonResponse(response);
  if (!response.ok || !result.ok) {
    throw new Error(result.error || `Powerbox descriptor request failed with ${response.status}`);
  }
  return result;
}

export function makeBrowserCapnpInterfaceBinding(interfaceName, methodNames, schema = {}) {
  const binding = {
    interfaceName,
    interfaceId: schema.interfaceId || "",
    methodNames: Object.freeze([...methodNames]),
    schema: Object.freeze({
      ...schema,
      interfaceName,
      methodNames: Object.freeze([...methodNames]),
      argumentCapabilities: Object.freeze({ ...(schema.argumentCapabilities || {}) }),
      resultCapabilities: Object.freeze({ ...(schema.resultCapabilities || {}) }),
    }),
  };
  return Object.freeze({
    ...binding,
    cast(stub) {
      return connectBrowserCapnp(stub, binding);
    },
    local(methods) {
      return makeBrowserLocalCapnp(interfaceName, binding.methodNames, binding.schema, methods);
    },
    async powerboxDescriptor(options = {}) {
      const result = await fetchBrowserAppInterfacePowerboxDescriptor(
        interfaceName, binding.schema, options);
      return result.descriptor;
    },
    async powerboxDescriptorInfo(options = {}) {
      return fetchBrowserAppInterfacePowerboxDescriptor(
        interfaceName, binding.schema, options);
    },
  });
}

function validatePackedDescriptor(descriptor, name = "descriptor") {
  if (typeof descriptor !== "string" || descriptor.length === 0) {
    throw new Error(`${name} must be a non-empty packed Powerbox descriptor string`);
  }
  return descriptor;
}

async function fetchApiSessionPowerboxDescriptor(options = {}) {
  const {
    canonicalUrl,
    oauthScopes = [],
    descriptorUrl = "/__sandstorm/powerbox/api-session-descriptor",
  } = options;
  if (!canonicalUrl) {
    throw new Error("apiSession Powerbox descriptor requires canonicalUrl");
  }

  const url = new URL(descriptorUrl, window.location.href);
  url.searchParams.set("canonicalUrl", canonicalUrl);
  for (const scope of oauthScopes) {
    url.searchParams.append("oauthScope", scope);
  }

  const response = await fetch(url);
  const result = await readJsonResponse(response);
  if (!response.ok || !result.ok) {
    throw new Error(result.error || `Powerbox descriptor request failed with ${response.status}`);
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
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty HTTP method string`);
  }
  const method = value.toUpperCase();
  if (!OUTBOUND_HTTP_METHODS.has(method)) {
    throw new Error(`${label} must be one of GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS`);
  }
  return method;
}

async function fetchOutboundHttpPowerboxDescriptor(options = {}) {
  const {
    baseUrl,
    methods = [],
    descriptorUrl = "/__sandstorm/powerbox/outbound-http-descriptor",
  } = options;
  if (!baseUrl) {
    throw new Error("outboundHttp Powerbox descriptor requires baseUrl");
  }
  if (!Array.isArray(methods)) {
    throw new Error("outboundHttp Powerbox descriptor methods must be an array");
  }

  const url = new URL(descriptorUrl, window.location.href);
  url.searchParams.set("baseUrl", baseUrl);
  for (let i = 0; i < methods.length; ++i) {
    url.searchParams.append("method", outboundHttpMethod(methods[i], `methods[${i}]`));
  }

  const response = await fetch(url);
  const result = await readJsonResponse(response);
  if (!response.ok || !result.ok) {
    throw new Error(result.error || `Powerbox descriptor request failed with ${response.status}`);
  }
  return result;
}

export async function apiSessionPowerboxDescriptor(options = {}) {
  const result = await fetchApiSessionPowerboxDescriptor(options);
  return validatePackedDescriptor(result.descriptor, "apiSession descriptor");
}

export async function apiSessionPowerboxDescriptorInfo(options = {}) {
  const result = await fetchApiSessionPowerboxDescriptor(options);
  validatePackedDescriptor(result.descriptor, "apiSession descriptor");
  return result;
}

export async function outboundHttpPowerboxDescriptor(options = {}) {
  const result = await fetchOutboundHttpPowerboxDescriptor(options);
  return validatePackedDescriptor(result.descriptor, "outboundHttp descriptor");
}

export async function outboundHttpPowerboxDescriptorInfo(options = {}) {
  const result = await fetchOutboundHttpPowerboxDescriptor(options);
  validatePackedDescriptor(result.descriptor, "outboundHttp descriptor");
  return result;
}

export function providerTagPowerboxDescriptor(options = {}) {
  return validatePackedDescriptor(options.descriptor, "provider tag descriptor");
}

export const powerboxDescriptors = {
  apiSession: apiSessionPowerboxDescriptor,
  apiSessionInfo: apiSessionPowerboxDescriptorInfo,
  outboundHttp: outboundHttpPowerboxDescriptor,
  outboundHttpInfo: outboundHttpPowerboxDescriptorInfo,
  providerTag: providerTagPowerboxDescriptor,
};

export async function inspectPowerboxQuery(query) {
  if (query && typeof query === "object" && !Array.isArray(query) &&
      !(query instanceof String) &&
      (query.baseUrl || query.outboundHttp || query.outboundHttpDescriptor)) {
    const descriptorInfo = await outboundHttpPowerboxDescriptorInfo(
      query.outboundHttp ?? query.outboundHttpDescriptor ?? query);
    return {
      ok: true,
      type: "powerboxQueryInspection",
      descriptorCount: 1,
      descriptors: [{
        index: 0,
        ...descriptorInfo,
      }],
    };
  }

  if (query && typeof query === "object" && !Array.isArray(query) &&
      !(query instanceof String) &&
      (query.canonicalUrl || query.apiSession || query.apiSessionDescriptor)) {
    const descriptorInfo = await apiSessionPowerboxDescriptorInfo(
      query.apiSession ?? query.apiSessionDescriptor ?? query);
    return {
      ok: true,
      type: "powerboxQueryInspection",
      descriptorCount: 1,
      descriptors: [{
        index: 0,
        ...descriptorInfo,
      }],
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

function providerQueryFromOptions(options) {
  const query = options.descriptors ?? options.descriptor;
  if (query === undefined || query === null) {
    throw new Error("requestProviderPowerbox() requires descriptor or descriptors");
  }
  if (typeof query === "string") {
    return [providerTagPowerboxDescriptor({ descriptor: query })];
  }
  if (!Array.isArray(query) || !query.every((descriptor) => typeof descriptor === "string")) {
    throw new Error("Powerbox provider descriptors must be a string or an array of strings");
  }
  return query.map((descriptor, index) =>
    validatePackedDescriptor(descriptor, `provider descriptor ${index}`));
}

export async function requestProviderPowerbox(options = {}) {
  const query = providerQueryFromOptions(options);
  return requestPowerbox(query, { saveLabel: options.saveLabel });
}

export async function requestProviderCapability(options = {}) {
  const requested = await requestProviderPowerbox(options);
  const capability = await claimPowerboxToken(requested.token, options);
  return {
    ...requested,
    capability,
  };
}

export async function requestApiPowerbox(options = {}) {
  const {
    saveLabel,
  } = options;
  const result = await fetchApiSessionPowerboxDescriptor(options);
  const descriptor = validatePackedDescriptor(result.descriptor, "apiSession descriptor");

  const requested = await requestPowerbox([descriptor], { saveLabel });
  return {
    ...requested,
    powerboxDescriptor: result,
  };
}

export async function requestApiCapability(options = {}) {
  const requested = await requestApiPowerbox(options);
  const capability = await claimPowerboxToken(requested.token, options);
  return {
    ...requested,
    capability,
  };
}

export async function requestOutboundHttpPowerbox(options = {}) {
  const {
    saveLabel,
  } = options;
  const result = await fetchOutboundHttpPowerboxDescriptor(options);
  const descriptor = validatePackedDescriptor(result.descriptor, "outboundHttp descriptor");

  const requested = await requestPowerbox([descriptor], { saveLabel });
  return {
    ...requested,
    powerboxDescriptor: result,
  };
}

export async function requestOutboundHttpCapability(options = {}) {
  const requested = await requestOutboundHttpPowerbox(options);
  const capability = await claimPowerboxToken(requested.token, options);
  return {
    ...requested,
    capability,
  };
}

export function browserClientScript() {
  return `${capnwebSource}

export const SANDSTORM_RPC_VERSION = 0;
export const SANDSTORM_CAPNWEB_VERSION = "0.8.0";

export function newSandstormRpcSession(url = "./rpc", options) {
  return newHttpBatchRpcSession(url, options);
}

async function readJsonResponse(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      error: text || \`HTTP \${response.status}\`,
    };
  }
}

export function requestPowerbox(query, options = {}) {
  if (typeof window === "undefined" || !window.parent) {
    return Promise.reject(new Error("requestPowerbox() is only available in a browser session"));
  }

  const rpcId = typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : \`sandstorm-powerbox-\${Date.now()}-\${Math.random()}\`;

  return new Promise((resolve, reject) => {
    function cleanup() {
      window.removeEventListener("message", onMessage);
    }

    function onMessage(event) {
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

    window.addEventListener("message", onMessage);
    const powerboxRequest = {
      rpcId,
    };
    if (query !== undefined && query !== null) {
      powerboxRequest.query = query;
      powerboxRequest.saveLabel = options.saveLabel;
    }

    window.parent.postMessage({
      powerboxRequest,
    }, "*");
  });
}

export async function claimPowerboxToken(token, options = {}) {
  const {
    claimUrl = "/__sandstorm/powerbox/claim",
    requiredPermissions = [],
  } = options;
  const body = { token, requiredPermissions };
  if (options.apiSession !== undefined) {
    body.apiSession = options.apiSession;
  }
  if (options.apiSessionDescriptor !== undefined) {
    body.apiSessionDescriptor = options.apiSessionDescriptor;
  }
  if (options.outboundHttp !== undefined) {
    body.outboundHttp = options.outboundHttp;
  }
  if (options.outboundHttpDescriptor !== undefined) {
    body.outboundHttpDescriptor = options.outboundHttpDescriptor;
  }
  if (options.powerboxDescriptor !== undefined) {
    body.powerboxDescriptor = options.powerboxDescriptor;
  } else if (options.descriptor !== undefined) {
    body.descriptor = options.descriptor;
  }
  if (options.nativeInterface !== undefined) {
    body.nativeInterface = options.nativeInterface;
  }
  const response = await fetch(new URL(claimUrl, window.location.href), {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const result = await readJsonResponse(response);
  if (!response.ok || !result.ok) {
    throw new Error(result.error || \`Powerbox claim failed with \${response.status}\`);
  }
  return result.capability;
}

export async function requestAndClaimPowerbox(query, options = {}) {
  const requested = await requestPowerbox(query, options);
  const capability = await claimPowerboxToken(requested.token, options);
  return {
    ...requested,
    capability,
  };
}

function browserCapnpMethodNames(binding) {
  const methodNames = binding?.methodNames || binding?.schema?.methodNames;
  if (!Array.isArray(methodNames)) {
    throw new TypeError("browser Cap'n Proto binding requires methodNames");
  }
  return methodNames;
}

function browserCapnpSchema(binding) {
  return binding?.schema && typeof binding.schema === "object" ? binding.schema : {};
}

function resolveBrowserResultBinding(interfaceName, methodName, caster) {
  const binding = typeof caster === "function" ? caster() : caster;
  if (!binding || typeof binding !== "object") {
    throw new TypeError(
      interfaceName + "." + methodName + " result capability caster must be a schema binding");
  }
  return binding;
}

function browserCapabilityPath(path) {
  const parts = typeof path === "string" ? path.split(".") : path;
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new TypeError("browser Cap'n Proto capability path must be non-empty");
  }
  return parts;
}

function browserCapabilityPathEntries(spec) {
  if (!spec || typeof spec !== "object") return [];
  const entries = [];
  const fields = spec.fields;
  if (Array.isArray(fields)) {
    for (const [field, caster] of fields) {
      entries.push([browserCapabilityPath([field]), caster]);
    }
  } else if (fields && typeof fields === "object") {
    for (const [field, caster] of Object.entries(fields)) {
      entries.push([browserCapabilityPath([field]), caster]);
    }
  }

  const paths = spec.paths;
  if (Array.isArray(paths)) {
    for (const [path, caster] of paths) {
      entries.push([browserCapabilityPath(path), caster]);
    }
  } else if (paths && typeof paths === "object") {
    for (const [path, caster] of Object.entries(paths)) {
      entries.push([browserCapabilityPath(path), caster]);
    }
  }
  return entries;
}

function mapBrowserCapabilityPath(value, path, mapper) {
  if (path.length === 0) return mapper(value);
  if (!value || typeof value !== "object" || value.__sandstormCapnpBrowserStub) {
    return value;
  }

  const [field, ...rest] = path;
  if (!Object.prototype.hasOwnProperty.call(value, field)) {
    return value;
  }

  const mapped = mapBrowserCapabilityPath(value[field], rest, mapper);
  if (mapped === value[field]) return value;
  const copy = Array.isArray(value) ? [...value] : { ...value };
  copy[field] = mapped;
  return copy;
}

function browserStubValue(value) {
  return value && typeof value === "object" && value.__sandstormCapnpBrowserStub
    ? value.stub
    : value;
}

function castBrowserCapnpResult(interfaceName, methodName, result, resultCapabilities) {
  const spec = resultCapabilities?.[methodName];
  if (!spec) return result;

  if (typeof spec === "function" || spec.methodNames || spec.schema) {
    return connectBrowserCapnp(
      result, resolveBrowserResultBinding(interfaceName, methodName, spec));
  }

  const paths = browserCapabilityPathEntries(spec);
  if (paths.length === 0 || !result || typeof result !== "object") {
    return result;
  }

  let casted = result;
  for (const [path, caster] of paths) {
    casted = mapBrowserCapabilityPath(casted, path, (value) => connectBrowserCapnp(
      value, resolveBrowserResultBinding(interfaceName, methodName, caster)));
  }
  return casted;
}

function browserArgumentCapabilityPathEntries(spec) {
  const entries = [];
  const fields = spec?.fields;
  if (Array.isArray(fields)) {
    for (const field of fields) entries.push([browserCapabilityPath([field])]);
  } else if (fields && typeof fields === "object") {
    for (const field of Object.keys(fields)) entries.push([browserCapabilityPath([field])]);
  }

  const paths = spec?.paths;
  if (Array.isArray(paths)) {
    for (const entry of paths) {
      entries.push([browserCapabilityPath(Array.isArray(entry) && entry.length === 2
        ? entry[0]
        : entry)]);
    }
  } else if (paths && typeof paths === "object") {
    for (const path of Object.keys(paths)) entries.push([browserCapabilityPath(path)]);
  }
  return entries;
}

function normalizeBrowserCapnpArgs(methodName, args, argumentCapabilities) {
  const spec = argumentCapabilities?.[methodName];
  if (!spec) return args;

  let normalized = args;
  for (const index of spec.indexes || spec.indices || []) {
    if (Number.isInteger(index) && index >= 0 && index < args.length) {
      const next = browserStubValue(args[index]);
      if (next !== args[index]) {
        if (normalized === args) normalized = [...args];
        normalized[index] = next;
      }
    }
  }

  const paths = browserArgumentCapabilityPathEntries(spec);
  if (paths.length > 0 && args.length === 1) {
    let first = normalized[0];
    for (const [path] of paths) {
      first = mapBrowserCapabilityPath(first, path, browserStubValue);
    }
    if (first !== normalized[0]) {
      if (normalized === args) normalized = [...args];
      normalized[0] = first;
    }
  }
  return normalized;
}

function requiredBrowserMethods(interfaceName, methodNames, methods) {
  if (!methods || typeof methods !== "object") {
    throw new TypeError(\`\${interfaceName}.local() requires a methods object\`);
  }
  for (const methodName of methodNames) {
    if (typeof methods[methodName] !== "function") {
      throw new TypeError(\`\${interfaceName}.\${methodName} is not implemented\`);
    }
  }
  return methods;
}

function makeBrowserLocalCapnp(interfaceName, methodNames, schema, methods) {
  const source = requiredBrowserMethods(interfaceName, methodNames, methods);
  const argumentCapabilities = schema.argumentCapabilities || {};
  const resultCapabilities = schema.resultCapabilities || {};
  const client = {};
  for (const methodName of methodNames) {
    client[methodName] = async (...args) => {
      const normalizedArgs = normalizeBrowserCapnpArgs(
        methodName, args, argumentCapabilities);
      const result = await source[methodName](...normalizedArgs);
      return castBrowserCapnpResult(interfaceName, methodName, result, resultCapabilities);
    };
  }
  return Object.freeze(client);
}

export function connectBrowserCapnp(stub, binding) {
  if (!stub || typeof stub !== "object" && typeof stub !== "function") {
    throw new TypeError("connectBrowserCapnp() requires a Cap'n Web RPC stub");
  }
  const interfaceName = binding?.interfaceName || browserCapnpSchema(binding).interfaceName || "";
  const methodNames = browserCapnpMethodNames(binding);
  const schema = browserCapnpSchema(binding);
  const argumentCapabilities = schema.argumentCapabilities || {};
  const resultCapabilities = schema.resultCapabilities || {};
  const client = {
    __sandstormCapnpBrowserStub: true,
    stub,
  };
  for (const methodName of methodNames) {
    client[methodName] = async (...args) => {
      const normalizedArgs = normalizeBrowserCapnpArgs(
        methodName, args, argumentCapabilities);
      const result = await stub[methodName](...normalizedArgs);
      return castBrowserCapnpResult(interfaceName, methodName, result, resultCapabilities);
    };
  }
  if (typeof stub[Symbol.dispose] === "function") {
    client[Symbol.dispose] = () => stub[Symbol.dispose]();
  }
  return Object.freeze(client);
}

async function fetchBrowserAppInterfacePowerboxDescriptor(interfaceName, schema, options = {}) {
  const interfaceId = schema.interfaceId || "";
  if (!interfaceId) {
    throw new TypeError(\`\${interfaceName}.powerboxDescriptor() requires schema interfaceId\`);
  }

  const descriptorUrl = options.descriptorUrl ||
    "/__sandstorm/powerbox/app-interface-descriptor";
  const url = new URL(descriptorUrl, window.location.href);
  url.searchParams.set("interfaceId", interfaceId);
  url.searchParams.set("interfaceName", schema.interfaceName || interfaceName);

  const response = await fetch(url);
  const result = await readJsonResponse(response);
  if (!response.ok || !result.ok) {
    throw new Error(result.error || \`Powerbox descriptor request failed with \${response.status}\`);
  }
  return result;
}

export function makeBrowserCapnpInterfaceBinding(interfaceName, methodNames, schema = {}) {
  const binding = {
    interfaceName,
    interfaceId: schema.interfaceId || "",
    methodNames: Object.freeze([...methodNames]),
    schema: Object.freeze({
      ...schema,
      interfaceName,
      methodNames: Object.freeze([...methodNames]),
      argumentCapabilities: Object.freeze({ ...(schema.argumentCapabilities || {}) }),
      resultCapabilities: Object.freeze({ ...(schema.resultCapabilities || {}) }),
    }),
  };
  return Object.freeze({
    ...binding,
    cast(stub) {
      return connectBrowserCapnp(stub, binding);
    },
    local(methods) {
      return makeBrowserLocalCapnp(interfaceName, binding.methodNames, binding.schema, methods);
    },
    async powerboxDescriptor(options = {}) {
      const result = await fetchBrowserAppInterfacePowerboxDescriptor(
        interfaceName, binding.schema, options);
      return result.descriptor;
    },
    async powerboxDescriptorInfo(options = {}) {
      return fetchBrowserAppInterfacePowerboxDescriptor(
        interfaceName, binding.schema, options);
    },
  });
}

function validatePackedDescriptor(descriptor, name = "descriptor") {
  if (typeof descriptor !== "string" || descriptor.length === 0) {
    throw new Error(\`\${name} must be a non-empty packed Powerbox descriptor string\`);
  }
  return descriptor;
}

async function fetchApiSessionPowerboxDescriptor(options = {}) {
  const {
    canonicalUrl,
    oauthScopes = [],
    descriptorUrl = "/__sandstorm/powerbox/api-session-descriptor",
  } = options;
  if (!canonicalUrl) {
    throw new Error("apiSession Powerbox descriptor requires canonicalUrl");
  }

  const url = new URL(descriptorUrl, window.location.href);
  url.searchParams.set("canonicalUrl", canonicalUrl);
  for (const scope of oauthScopes) {
    url.searchParams.append("oauthScope", scope);
  }

  const response = await fetch(url);
  const result = await readJsonResponse(response);
  if (!response.ok || !result.ok) {
    throw new Error(result.error || \`Powerbox descriptor request failed with \${response.status}\`);
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
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(\`\${label} must be a non-empty HTTP method string\`);
  }
  const method = value.toUpperCase();
  if (!OUTBOUND_HTTP_METHODS.has(method)) {
    throw new Error(\`\${label} must be one of GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS\`);
  }
  return method;
}

async function fetchOutboundHttpPowerboxDescriptor(options = {}) {
  const {
    baseUrl,
    methods = [],
    descriptorUrl = "/__sandstorm/powerbox/outbound-http-descriptor",
  } = options;
  if (!baseUrl) {
    throw new Error("outboundHttp Powerbox descriptor requires baseUrl");
  }
  if (!Array.isArray(methods)) {
    throw new Error("outboundHttp Powerbox descriptor methods must be an array");
  }

  const url = new URL(descriptorUrl, window.location.href);
  url.searchParams.set("baseUrl", baseUrl);
  for (let i = 0; i < methods.length; ++i) {
    url.searchParams.append("method", outboundHttpMethod(methods[i], \`methods[\${i}]\`));
  }

  const response = await fetch(url);
  const result = await readJsonResponse(response);
  if (!response.ok || !result.ok) {
    throw new Error(result.error || \`Powerbox descriptor request failed with \${response.status}\`);
  }
  return result;
}

export async function apiSessionPowerboxDescriptor(options = {}) {
  const result = await fetchApiSessionPowerboxDescriptor(options);
  return validatePackedDescriptor(result.descriptor, "apiSession descriptor");
}

export async function apiSessionPowerboxDescriptorInfo(options = {}) {
  const result = await fetchApiSessionPowerboxDescriptor(options);
  validatePackedDescriptor(result.descriptor, "apiSession descriptor");
  return result;
}

export async function outboundHttpPowerboxDescriptor(options = {}) {
  const result = await fetchOutboundHttpPowerboxDescriptor(options);
  return validatePackedDescriptor(result.descriptor, "outboundHttp descriptor");
}

export async function outboundHttpPowerboxDescriptorInfo(options = {}) {
  const result = await fetchOutboundHttpPowerboxDescriptor(options);
  validatePackedDescriptor(result.descriptor, "outboundHttp descriptor");
  return result;
}

export function providerTagPowerboxDescriptor(options = {}) {
  return validatePackedDescriptor(options.descriptor, "provider tag descriptor");
}

export const powerboxDescriptors = {
  apiSession: apiSessionPowerboxDescriptor,
  apiSessionInfo: apiSessionPowerboxDescriptorInfo,
  outboundHttp: outboundHttpPowerboxDescriptor,
  outboundHttpInfo: outboundHttpPowerboxDescriptorInfo,
  providerTag: providerTagPowerboxDescriptor,
};

export async function inspectPowerboxQuery(query) {
  if (query && typeof query === "object" && !Array.isArray(query) &&
      !(query instanceof String) &&
      (query.baseUrl || query.outboundHttp || query.outboundHttpDescriptor)) {
    const descriptorInfo = await outboundHttpPowerboxDescriptorInfo(
      query.outboundHttp ?? query.outboundHttpDescriptor ?? query);
    return {
      ok: true,
      type: "powerboxQueryInspection",
      descriptorCount: 1,
      descriptors: [{
        index: 0,
        ...descriptorInfo,
      }],
    };
  }

  if (query && typeof query === "object" && !Array.isArray(query) &&
      !(query instanceof String) &&
      (query.canonicalUrl || query.apiSession || query.apiSessionDescriptor)) {
    const descriptorInfo = await apiSessionPowerboxDescriptorInfo(
      query.apiSession ?? query.apiSessionDescriptor ?? query);
    return {
      ok: true,
      type: "powerboxQueryInspection",
      descriptorCount: 1,
      descriptors: [{
        index: 0,
        ...descriptorInfo,
      }],
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

function providerQueryFromOptions(options) {
  const query = options.descriptors ?? options.descriptor;
  if (query === undefined || query === null) {
    throw new Error("requestProviderPowerbox() requires descriptor or descriptors");
  }
  if (typeof query === "string") {
    return [providerTagPowerboxDescriptor({ descriptor: query })];
  }
  if (!Array.isArray(query) || !query.every((descriptor) => typeof descriptor === "string")) {
    throw new Error("Powerbox provider descriptors must be a string or an array of strings");
  }
  return query.map((descriptor, index) =>
    validatePackedDescriptor(descriptor, \`provider descriptor \${index}\`));
}

export async function requestProviderPowerbox(options = {}) {
  const query = providerQueryFromOptions(options);
  return requestPowerbox(query, { saveLabel: options.saveLabel });
}

export async function requestProviderCapability(options = {}) {
  const requested = await requestProviderPowerbox(options);
  const capability = await claimPowerboxToken(requested.token, options);
  return {
    ...requested,
    capability,
  };
}

export async function requestApiPowerbox(options = {}) {
  const {
    saveLabel,
  } = options;
  const result = await fetchApiSessionPowerboxDescriptor(options);
  const descriptor = validatePackedDescriptor(result.descriptor, "apiSession descriptor");

  const requested = await requestPowerbox([descriptor], { saveLabel });
  return {
    ...requested,
    powerboxDescriptor: result,
  };
}

export async function requestApiCapability(options = {}) {
  const requested = await requestApiPowerbox(options);
  const capability = await claimPowerboxToken(requested.token, options);
  return {
    ...requested,
    capability,
  };
}

export async function requestOutboundHttpPowerbox(options = {}) {
  const {
    saveLabel,
  } = options;
  const result = await fetchOutboundHttpPowerboxDescriptor(options);
  const descriptor = validatePackedDescriptor(result.descriptor, "outboundHttp descriptor");

  const requested = await requestPowerbox([descriptor], { saveLabel });
  return {
    ...requested,
    powerboxDescriptor: result,
  };
}

export async function requestOutboundHttpCapability(options = {}) {
  const requested = await requestOutboundHttpPowerbox(options);
  const capability = await claimPowerboxToken(requested.token, options);
  return {
    ...requested,
    capability,
  };
}
`;
}
