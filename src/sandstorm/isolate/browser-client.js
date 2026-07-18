import {
  Conn,
  DeferredTransport,
  Interface as CapnpEsInterface,
  Message,
} from "/capnp-es/index.mjs";
import { BrowserIsolateBridge } from "/__sandstorm/capnp/sandstorm/isolate-bridge.capnp.js";

export const SANDSTORM_CAPNP_NATIVE_BRIDGE_PROTOCOL_VERSION = 0;

class NativeCapnpBridgeUnavailableError extends Error {
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
