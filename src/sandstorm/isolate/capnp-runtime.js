// Internal Cap'n Proto bridge runtime. Application code must use sandstorm:api.
import {
  Conn as CapnpEsConn,
  DeferredTransport as CapnpEsDeferredTransport,
  Interface as CapnpEsInterface,
  Message as CapnpEsMessage,
  utils as CapnpEsUtils,
} from "capnp-es/index.mjs";
import { IsolateBridge } from "capnp:/sandstorm/isolate-bridge.capnp";
import { ByteStream } from "capnp:/sandstorm/util.capnp";

// Shared only by trusted runtime modules. This symbol is the unforgeable protocol used
// to obtain a live capnp-es reference without exposing it on the public API.
export const CAPNP_CLIENT_SYMBOL = Symbol("sandstorm.capnp.client");
export const CAPNP_EXPORT_SYMBOL = Symbol("sandstorm.capnp.export");
const DEFAULT_BYTE_STREAM_CHUNK_BYTES = 256 * 1024;

function initLocalizedText(builder, value) {
  if (value && typeof value.defaultText === "string") {
    builder.defaultText = value.defaultText;
  }
}

function initCapnpCapabilityParam(params, cap, name = "capability") {
  const client = cap?.client ?? cap;
  if (!client) {
    throw new TypeError(`${name} must be a Cap'n Proto capability`);
  }

  CapnpEsUtils.setInterfacePointer(
    params.segment.message.addCap(nativeCapnpClientReference(client, name)),
    CapnpEsUtils.getPointer(0, params));
}

function initSandstormApiSaveParams(params, cap, label) {
  initCapnpCapabilityParam(params, cap, "SandstormApi.save() capability");
  initLocalizedText(params._initLabel(), label);
}

export class CapnpUnavailableError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "CapnpUnavailableError";
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

function nativeCapnpMessageBytes(message) {
  if (message instanceof Uint8Array) {
    return message;
  } else if (message instanceof ArrayBuffer) {
    return new Uint8Array(message);
  } else if (ArrayBuffer.isView(message)) {
    return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  } else if (message && typeof message.toUint8Array === "function") {
    return message.toUint8Array();
  }
  throw new TypeError("native Cap'n Proto payload message must be capnp-es Message or bytes");
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

  throw new NativeCapnpBridgeProtocolError(`${name} is not a capnp-es client reference`);
}

function nativeCapnpBase64UrlDecode(text, name = "base64url value") {
  if (typeof text !== "string" || text.length === 0 || text.length % 4 === 1 ||
      !/^[A-Za-z0-9_-]+$/.test(text)) {
    throw new TypeError(`${name} must be non-empty base64url text`);
  }

  const base64 = text.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (text.length % 4)) % 4);
  if (typeof globalThis.atob === "function") {
    const binary = globalThis.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; ++i) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  if (typeof globalThis.Buffer === "function") {
    return new Uint8Array(globalThis.Buffer.from(base64, "base64"));
  }

  throw new NativeCapnpBridgeProtocolError("base64url decoding is unavailable");
}

function nativeCapnpBase64UrlEncode(bytes) {
  bytes = nativeCapnpMessageBytes(bytes);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  let base64;
  if (typeof globalThis.btoa === "function") {
    base64 = globalThis.btoa(binary);
  } else if (typeof globalThis.Buffer === "function") {
    base64 = globalThis.Buffer.from(bytes).toString("base64");
  } else {
    throw new NativeCapnpBridgeProtocolError("base64url encoding is unavailable");
  }

  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function nativeCapnpUtf8(bytes) {
  try {
    return new TextDecoder().decode(bytes);
  } catch (_) {
    return "";
  }
}

function byteStreamChunkBytes(chunk) {
  if (chunk instanceof Uint8Array) {
    return chunk;
  } else if (chunk instanceof ArrayBuffer) {
    return new Uint8Array(chunk);
  } else if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  } else if (chunk && typeof chunk.toUint8Array === "function") {
    return chunk.toUint8Array();
  } else if (chunk && typeof chunk.copyToUint8Array === "function") {
    return chunk.copyToUint8Array();
  } else {
    throw new TypeError("ByteStream chunks must be Uint8Array or ArrayBuffer values");
  }
}

function copyByteStreamChunk(chunk) {
  const bytes = byteStreamChunkBytes(chunk);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function normalizeByteStreamChunkSize(value) {
  const result = value === undefined ? DEFAULT_BYTE_STREAM_CHUNK_BYTES : Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new TypeError("ByteStream chunkSize must be a positive safe integer");
  }
  return result;
}

function normalizeByteStreamSize(value, name = "size") {
  if (typeof value === "bigint") {
    if (value < 0n) throw new TypeError(`ByteStream ${name} must be non-negative`);
    return value;
  }

  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new TypeError(`ByteStream ${name} must be a non-negative safe integer`);
  }
  return BigInt(result);
}

async function writeChunksToByteStream(stream, bytes, chunkSize) {
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    await stream.write({
      data: bytes.slice(offset, Math.min(offset + chunkSize, bytes.byteLength)),
    });
  }
}

function expectByteStreamClient(stream) {
  if (!stream || typeof stream.write !== "function" || typeof stream.done !== "function") {
    throw new TypeError("expected a sandstorm.util.ByteStream client");
  }
  return stream;
}

export function writableFromByteStream(stream, options = {}) {
  stream = expectByteStreamClient(stream);
  const chunkSize = normalizeByteStreamChunkSize(options.chunkSize);
  let closed = false;

  return new WritableStream({
    async start() {
      if (options.size !== undefined && typeof stream.expectSize === "function") {
        try {
          await stream.expectSize({ size: normalizeByteStreamSize(options.size) });
        } catch (_) {
          // ByteStream.expectSize() is advisory; callers ignore failures and let done()
          // report any actual write-size mismatch.
        }
      }
    },

    async write(chunk) {
      if (closed) {
        throw new TypeError("ByteStream writable is closed");
      }
      await writeChunksToByteStream(stream, byteStreamChunkBytes(chunk), chunkSize);
    },

    async close() {
      if (closed) return;
      closed = true;
      await stream.done();
    },

    async abort(reason) {
      closed = true;
      if (typeof stream.drop === "function") {
        await stream.drop(reason);
      }
    },
  });
}

export function pipeReadableToByteStream(readable, stream, options = {}) {
  if (!readable || typeof readable.pipeTo !== "function") {
    throw new TypeError("pipeReadableToByteStream() requires a ReadableStream");
  }
  return readable.pipeTo(writableFromByteStream(stream, options));
}

export function byteStreamFromWritable(writable, options = {}) {
  if (!writable || typeof writable.getWriter !== "function") {
    throw new TypeError("byteStreamFromWritable() requires a WritableStream");
  }

  const chunkSize = normalizeByteStreamChunkSize(options.chunkSize);
  const writer = writable.getWriter();
  let queue = Promise.resolve();
  let expectedBytes = null;
  let bytesWritten = 0n;
  let doneCalled = false;
  let failed = null;

  function enqueue(step) {
    const run = queue.then(async () => {
      if (failed) throw failed;
      try {
        return await step();
      } catch (error) {
        failed = error;
        try {
          await writer.abort(error);
        } catch (_) {}
        releaseWriter();
        throw error;
      }
    });
    queue = run.catch(() => {});
    return run;
  }

  function releaseWriter() {
    try {
      writer.releaseLock();
    } catch (_) {}
  }

  return new ByteStream.Server({
    async write({ data }) {
      const bytes = copyByteStreamChunk(data);
      return await enqueue(async () => {
        if (doneCalled) throw new Error("ByteStream.write() called after done()");
        for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
          const chunk = bytes.slice(offset, Math.min(offset + chunkSize, bytes.byteLength));
          await writer.write(chunk);
          bytesWritten += BigInt(chunk.byteLength);
          if (expectedBytes !== null && bytesWritten > expectedBytes) {
            throw new Error("ByteStream.write() exceeded expected size");
          }
        }
        return {};
      });
    },

    async done() {
      return await enqueue(async () => {
        if (doneCalled) throw new Error("ByteStream.done() called twice");
        doneCalled = true;
        if (expectedBytes !== null && bytesWritten !== expectedBytes) {
          throw new Error("ByteStream.done() called before expected size was written");
        }
        await writer.close();
        releaseWriter();
        return {};
      });
    },

    async expectSize({ size }) {
      return await enqueue(async () => {
        const remaining = normalizeByteStreamSize(size, "expected size");
        const nextExpectedBytes = bytesWritten + remaining;
        if (expectedBytes !== null && expectedBytes !== nextExpectedBytes) {
          throw new Error("ByteStream.expectSize() changed the expected size");
        }
        expectedBytes = nextExpectedBytes;
        if (typeof options.onExpectSize === "function") {
          await options.onExpectSize(remaining, {
            expectedSize: expectedBytes,
            bytesWritten,
          });
        }
        return {};
      });
    },
  }).client();
}

export function nativeCapnpSavedTokenData(token) {
  if (typeof token !== "string") {
    return nativeCapnpMessageBytes(token);
  }

  const decoded = nativeCapnpBase64UrlDecode(token, "saved capability token");
  const text = nativeCapnpUtf8(decoded);
  const lines = text.split("\n");
  if (lines[0] === "isolate-saved-capability-v1" && lines.length >= 4) {
    return nativeCapnpBase64UrlDecode(lines[3], "saved capability token sturdy ref");
  }

  return decoded;
}

export function nativeCapnpSavedTokenText(token) {
  if (typeof token === "string") {
    return token;
  }

  return nativeCapnpBase64UrlEncode(token);
}

function nativeCapnpBrowserHandoffSessionId(options = {}) {
  let sessionId = "";
  if (typeof Request === "function" && options.request instanceof Request) {
    sessionId = options.request.headers.get("x-sandstorm-session-id") || "";
  }
  if (!sessionId && typeof options.sessionId === "string") {
    sessionId = options.sessionId;
  }
  if (!sessionId) {
    throw new NativeCapnpBridgeProtocolError(
      "native Cap'n Proto browser handoff requires a live Sandstorm WebSession");
  }
  return sessionId;
}

function validateNativeCapnpGeneratedStruct(StructClass, operation) {
  if (!StructClass || typeof StructClass !== "function") {
    throw new TypeError(`${operation} requires a capnp-es generated struct class`);
  }
}

export function createCapnpStruct(StructClass, value = {}) {
  validateNativeCapnpGeneratedStruct(StructClass, "createCapnpStruct()");

  const message = new CapnpEsMessage();
  const root = message.initRoot(StructClass);
  if (value !== undefined && value !== null) {
    if (typeof StructClass._applyInit !== "function") {
      throw new TypeError("createCapnpStruct() requires generated _applyInit metadata");
    }
    StructClass._applyInit(root, value);
  }
  return root;
}

export function readCapnpStruct(StructClass, value) {
  validateNativeCapnpGeneratedStruct(StructClass, "readCapnpStruct()");
  return CapnpEsUtils.getAs(StructClass, value);
}

function nativeCapnpRootMessageBytes(message) {
  if (message && typeof message === "object" && message.segment?.message) {
    if (message.segment.id === 0 && message.byteOffset === 0) {
      return message.segment.message.toUint8Array();
    }

    const copy = new CapnpEsMessage();
    copy.setRoot(message);
    return copy.toUint8Array();
  }

  return nativeCapnpMessageBytes(message);
}

export function nativeCapnpInterfaceMetadata(InterfaceClass, operation = "Cap'n Proto operation") {
  const metadata = InterfaceClass?._capnp;
  if (!InterfaceClass || typeof InterfaceClass.Client !== "function" ||
      !metadata || typeof metadata.typeId !== "bigint" ||
      typeof metadata.typeIdHex !== "string" || metadata.typeIdHex.length === 0 ||
      typeof metadata.displayName !== "string" || metadata.displayName.length === 0) {
    throw new TypeError(
      `${operation} requires a capnp-es generated interface class with _capnp metadata`);
  }
  return Object.freeze({
    interfaceId: metadata.typeId,
    interfaceIdHex: metadata.typeIdHex.startsWith("0x")
      ? metadata.typeIdHex
      : `0x${metadata.typeIdHex}`,
    interfaceName: metadata.displayName,
  });
}

export class IsolateBridgeNativeTransport extends CapnpEsDeferredTransport {
  #channel;

  constructor(api) {
    super();
    if (!api || typeof api.nativeCapnpBridgeOpenChannel !== "function") {
      throw new NativeCapnpBridgeProtocolError(
        "IsolateBridgeNativeTransport requires api.nativeCapnpBridgeOpenChannel()");
    }

    this.api = api;
    this.connection = null;
    this.kind = "isolateBridgeNative";
    this.#channel = api.nativeCapnpBridgeOpenChannel();
    if (!this.#channel || typeof this.#channel.send !== "function" ||
        typeof this.#channel.receive !== "function" ||
        typeof this.#channel.close !== "function") {
      throw new NativeCapnpBridgeProtocolError(
        "native isolate bridge binding returned an invalid channel");
    }
    this.#readLoop();
  }

  sendMessage(message) {
    if (this.closed) {
      throw new CapnpUnavailableError(
        "native isolate bridge transport is closed");
    }

    const bytes = nativeCapnpRootMessageBytes(message);
    const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.slice().buffer;
    try {
      this.#channel.send(buffer);
    } catch (error) {
      this.abort(error);
      throw error;
    }
  }

  abort(error) {
    if (this.connection && !this.connection.closed) {
      this.connection.shutdown(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    this.close(error);
  }

  close(error) {
    if (this.closed) {
      return;
    }

    try {
      this.#channel.close();
    } catch (_) {}

    super.close(error);
  }

  async #readLoop() {
    try {
      while (!this.closed) {
        this.resolve(nativeCapnpMessageBytes(await this.#channel.receive()));
      }
    } catch (error) {
      this.abort(error);
    }
  }
}

export function createIsolateBridgeConnection(api, options = {}) {
  const transport = new IsolateBridgeNativeTransport(api);
  const connection = new CapnpEsConn(transport, options.finalize);
  transport.connection = connection;
  return Object.assign(connection, { transport });
}

export function connectIsolateBridge(api, options = {}) {
  const connection = createIsolateBridgeConnection(api, options);
  const bridge = connection.bootstrap(IsolateBridge);
  return Object.assign(bridge, {
    connection,
    transport: connection.transport,
    close: (...args) => connection.transport.close(...args),
  });
}

function validateNativeCapnpGeneratedInterface(InterfaceClass, operation) {
  nativeCapnpInterfaceMetadata(InterfaceClass, operation);
}

export function capnpClient(InterfaceClass, capability) {
  validateNativeCapnpGeneratedInterface(InterfaceClass, "capnpClient()");
  if (!capability || typeof capability[CAPNP_CLIENT_SYMBOL] !== "function") {
    throw new TypeError("capnpClient() requires a live Sandstorm Capability");
  }
  return new InterfaceClass.Client(nativeCapnpClientReference(
    capability[CAPNP_CLIENT_SYMBOL](), "live Sandstorm capability"));
}

export async function exportCapnp(api, InterfaceClass, target) {
  validateNativeCapnpGeneratedInterface(InterfaceClass, "exportCapnp()");
  if (typeof InterfaceClass.Server !== "function") {
    throw new TypeError("exportCapnp() requires a generated server interface class");
  }
  if (!api || typeof api.nativeCapnpBridgeOpenChannel !== "function") {
    throw new TypeError("exportCapnp() requires a Sandstorm API object");
  }

  if (!target || typeof target !== "object") {
    throw new TypeError("exportCapnp() requires a generated server target object");
  }

  const interfaceMetadata = nativeCapnpInterfaceMetadata(InterfaceClass, "exportCapnp()");

  const server = new InterfaceClass.Server(target);
  const client = server.client();
  const publicInterfaceId = interfaceMetadata.interfaceIdHex;
  const browserHandoffs = new Map();
  let dropped = false;

  async function dropLocalExport() {
    if (dropped) {
      return undefined;
    }

    dropped = true;
    let firstError;
    for (const [handoffId, bridge] of browserHandoffs) {
      try {
        await bridge.dropBrowserHandoff({ id: handoffId });
        bridge.close();
      } catch (error) {
        bridge.close(error);
        if (firstError === undefined) firstError = error;
      }
    }
    browserHandoffs.clear();
    server.close?.();
    if (firstError) {
      throw firstError;
    }

    return undefined;
  }

  async function browserHandoffLocalExport(request) {
    if (dropped) {
      throw new CapnpUnavailableError("CapnpExport has been dropped");
    }
    if (typeof Request !== "function" || !(request instanceof Request)) {
      throw new TypeError("CapnpExport.browserHandoff() requires a Request");
    }
    const sessionId = nativeCapnpBrowserHandoffSessionId({ request });
    const bridge = connectIsolateBridge(api);
    try {
      const stored = await bridge.createBrowserHandoff((params) => {
        initCapnpCapabilityParam(params, client, "local export capability");
        params.sessionId = sessionId;
      });
      if (!stored || typeof stored.id !== "string" || stored.id.length === 0) {
        throw new NativeCapnpBridgeProtocolError(
          "isolate bridge returned an invalid local export browser handoff id");
      }
      browserHandoffs.set(stored.id, bridge);
      return Object.freeze({
        type: "capability",
        id: stored.id,
        kind: "receiverHosted",
        residence: "browserHandoff",
        interfaceId: publicInterfaceId,
        interfaceName: interfaceMetadata.interfaceName,
      });
    } catch (error) {
      bridge.close(error);
      throw error;
    }
  }

  return Object.freeze({
    client,
    [CAPNP_CLIENT_SYMBOL]: () => nativeCapnpClientReference(client, "local export capability"),
    [CAPNP_EXPORT_SYMBOL]: true,
    browserHandoff: browserHandoffLocalExport,
    drop: dropLocalExport,
    save: async (saveOptions = {}) => {
      if (dropped) {
        throw new CapnpUnavailableError("CapnpExport has been dropped");
      }
      const bridge = connectIsolateBridge(api);
      try {
        const result = await bridge.getSandstormApi({});
        const sandstormApi = result.api;
        if (!sandstormApi || typeof sandstormApi.save !== "function") {
          throw new NativeCapnpBridgeProtocolError(
            "isolate bridge returned an invalid SandstormApi capability");
        }

        const saved = await sandstormApi.save((params) => {
          initSandstormApiSaveParams(params, client, nativeCapnpSaveLabel(saveOptions));
        });
        bridge.close();
        return nativeCapnpSavedTokenText(saved.token);
      } catch (error) {
        bridge.close(error);
        throw error;
      }
    },
    toJSON() {
      throw new TypeError(
        "A CapnpExport cannot be serialized as JSON because JSON cannot transfer capability authority");
    },
  });
}

function nativeCapnpSaveLabel(options = {}) {
  const label = options.label;
  if (typeof label === "string") {
    return { defaultText: label };
  } else if (label && typeof label === "object") {
    return label;
  } else {
    return { defaultText: "native Cap'n Proto capability" };
  }
}
