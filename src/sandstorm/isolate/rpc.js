import capnwebSource from "sandstorm:capnweb-source";
import { newHttpBatchRpcSession } from "capnweb";

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
  const response = await fetch(new URL(claimUrl, window.location.href), {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ token, requiredPermissions }),
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

function providerQueryFromOptions(options) {
  const query = options.descriptors ?? options.descriptor;
  if (query === undefined || query === null) {
    throw new Error("requestProviderPowerbox() requires descriptor or descriptors");
  }
  if (typeof query === "string") {
    return [query];
  }
  if (!Array.isArray(query) || !query.every((descriptor) => typeof descriptor === "string")) {
    throw new Error("Powerbox provider descriptors must be a string or an array of strings");
  }
  return query;
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
    canonicalUrl,
    oauthScopes = [],
    saveLabel,
    descriptorUrl = "/__sandstorm/powerbox/api-session-descriptor",
  } = options;
  if (!canonicalUrl) {
    throw new Error("requestApiPowerbox() requires canonicalUrl");
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

  const requested = await requestPowerbox([result.descriptor], { saveLabel });
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

export function browserClientScript() {
  return `${capnwebSource}

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
  const response = await fetch(new URL(claimUrl, window.location.href), {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ token, requiredPermissions }),
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

function providerQueryFromOptions(options) {
  const query = options.descriptors ?? options.descriptor;
  if (query === undefined || query === null) {
    throw new Error("requestProviderPowerbox() requires descriptor or descriptors");
  }
  if (typeof query === "string") {
    return [query];
  }
  if (!Array.isArray(query) || !query.every((descriptor) => typeof descriptor === "string")) {
    throw new Error("Powerbox provider descriptors must be a string or an array of strings");
  }
  return query;
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
    canonicalUrl,
    oauthScopes = [],
    saveLabel,
    descriptorUrl = "/__sandstorm/powerbox/api-session-descriptor",
  } = options;
  if (!canonicalUrl) {
    throw new Error("requestApiPowerbox() requires canonicalUrl");
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

  const requested = await requestPowerbox([result.descriptor], { saveLabel });
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
`;
}
