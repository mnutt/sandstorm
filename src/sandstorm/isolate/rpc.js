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
  const targetOrigin = options.targetOrigin || "*";
  const expectedOrigin = options.expectedOrigin || (
    targetOrigin === "*" ? undefined : targetOrigin);

  return new Promise((resolve, reject) => {
    function cleanup() {
      window.removeEventListener("message", onMessage);
    }

    function onMessage(event) {
      if (event.source !== window.parent) return;
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
    }, targetOrigin);
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
  const targetOrigin = options.targetOrigin || "*";
  const expectedOrigin = options.expectedOrigin || (
    targetOrigin === "*" ? undefined : targetOrigin);

  return new Promise((resolve, reject) => {
    function cleanup() {
      window.removeEventListener("message", onMessage);
    }

    function onMessage(event) {
      if (event.source !== window.parent) return;
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
    }, targetOrigin);
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
