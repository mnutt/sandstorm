// Internal Cap'n Proto bridge runtime. Application code must use sandstorm:api.
import { AsyncLocalStorage } from "node:async_hooks";
import {
  Conn as CapnpEsConn,
  Interface as CapnpEsInterface,
  Message as CapnpEsMessage,
  utils as CapnpEsUtils,
} from "capnp-es/index.mjs";
import {
  Message as CapnpEsRpcMessage,
  Message_Which as CapnpEsRpcMessageWhich,
} from "capnp-es/capnp/rpc.mjs";
import { IsolateBridge } from "capnp:/sandstorm/isolate-bridge.capnp";
import { IsolateExportBroker } from "capnp:/sandstorm/isolate-exports.capnp";
import { ByteStream } from "capnp:/sandstorm/util.capnp";

// Shared only by trusted runtime modules. This symbol is the unforgeable protocol used
// to obtain a live capnp-es reference without exposing it on the public API.
export const CAPNP_CLIENT_SYMBOL = Symbol("sandstorm.capnp.client");
const DEFAULT_BYTE_STREAM_CHUNK_BYTES = 256 * 1024;
const workerRpcEventContext = new AsyncLocalStorage();

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

function initAppCapabilitySaveParams(params, cap, label) {
  initCapnpCapabilityParam(params, cap, "app capability");
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

function nativeCapnpCapabilityPointer(value, name = "capability") {
  if (value && value.segment && typeof value.byteOffset === "number") {
    return value;
  }

  const message = new CapnpEsMessage();
  const pointer = new CapnpEsInterface(message.getSegment(0), 0);
  CapnpEsUtils.setInterfacePointer(
    message.addCap(nativeCapnpClientReference(value, name)), pointer);
  return pointer;
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
  const maxBytes = options.maxBytes === undefined
    ? null
    : normalizeByteStreamSize(options.maxBytes, "maximum size");
  let bytesWritten = 0n;
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
      const bytes = byteStreamChunkBytes(chunk);
      bytesWritten += BigInt(bytes.byteLength);
      if (maxBytes !== null && bytesWritten > maxBytes) {
        throw new Error("ByteStream writable exceeded maximum size");
      }
      await writeChunksToByteStream(stream, bytes, chunkSize);
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
  if (lines[0] === "isolate-saved-capability-v2" && lines.length === 3) {
    return nativeCapnpBase64UrlDecode(lines[2], "saved capability token sturdy ref");
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

class EventDrivenCapnpConn extends CapnpEsConn {
  startWork() {}

  handleFinishMessage(message) {
    const answer = this.answers[message.finish.questionId];
    if (answer && !answer.done) {
      // capnp-es 0.3.0 otherwise only removes the protocol answer. Settle it first so the local
      // generated Server detaches from the wire and cannot emit a stale Return if this question ID
      // is reused after cancellation. The event transport suppresses this synthetic Return.
      answer.reject(new DOMException(
        "Cap'n Proto caller canceled the worker method", "AbortError"));
    }
    return super.handleFinishMessage(message);
  }
}

class WorkerRpcEventState {
  #change = null;
  #waits = new Set();

  constructor(send, context) {
    this.send = send;
    const executionContext = context.ctx;
    if (!executionContext || typeof executionContext.waitUntil !== "function") {
      this.context = context;
      return;
    }

    const waitUntil = promise => {
      const tracked = Promise.resolve(promise);
      this.#waits.add(tracked);
      tracked.then(
        () => this.#finishWait(tracked),
        () => this.#finishWait(tracked));
      executionContext.waitUntil(tracked);
    };
    const wrappedExecutionContext = new Proxy(executionContext, {
      get(target, property) {
        if (property === "waitUntil") return waitUntil;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    this.context = Object.freeze({ ...context, ctx: wrappedExecutionContext });
  }

  get hasWaits() {
    return this.#waits.size > 0;
  }

  waitForChange() {
    if (this.#change === null) {
      let resolve;
      const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
      this.#change = { promise, resolve };
    }
    return this.#change.promise;
  }

  #finishWait(promise) {
    if (!this.#waits.delete(promise)) return;
    if (this.#change !== null) {
      const change = this.#change;
      this.#change = null;
      change.resolve();
    }
  }
}

class CapnpRpcEventTransport {
  #answerAbortControllers = new Map();
  #canceledAnswers = new Set();
  #closed = false;
  #pendingReturns = new Map();
  #runWithContext;
  #send;

  constructor(runWithContext = (_context, callback) => callback()) {
    if (typeof runWithContext !== "function") {
      throw new TypeError("worker Cap'n Proto context dispatcher must be a function");
    }
    this.#runWithContext = runWithContext;
  }

  #handleMessage(connection, message, context) {
    return this.#runWithContext(context, () => connection.handleMessage(message));
  }

  #handleFinish(message) {
    const answerId = message.finish.questionId;
    const controller = this.#answerAbortControllers.get(answerId);
    if (controller) {
      this.#answerAbortControllers.delete(answerId);
      this.#canceledAnswers.add(answerId);
      controller.abort(new DOMException(
        "Cap'n Proto caller canceled the worker method", "AbortError"));
    }
  }

  sendMessage(message) {
    if (this.#closed) {
      throw new CapnpUnavailableError("worker Cap'n Proto RPC connection is closed");
    }

    if (message.which() === CapnpEsRpcMessageWhich.RETURN) {
      const answerId = message.return.answerId;
      if (this.#canceledAnswers.delete(answerId)) {
        this.#answerAbortControllers.delete(answerId);
        const pending = this.#pendingReturns.get(answerId);
        if (pending) {
          this.#pendingReturns.delete(answerId);
          pending.resolve(new Uint8Array(0));
        }
        return;
      }
    }

    const bytes = nativeCapnpRootMessageBytes(message).slice();
    const eventSend = workerRpcEventContext.getStore()?.send ?? this.#send;
    if (typeof eventSend !== "function") {
      throw new NativeCapnpBridgeProtocolError(
        "worker Cap'n Proto RPC connection has no native frame sink");
    }
    eventSend(bytes);
    switch (message.which()) {
      case CapnpEsRpcMessageWhich.RETURN: {
        const answerId = message.return.answerId;
        this.#answerAbortControllers.delete(answerId);
        const pending = this.#pendingReturns.get(answerId);
        if (!pending) {
          throw new NativeCapnpBridgeProtocolError(
            `worker produced a Return for unknown RPC answer ${answerId}`);
        }
        this.#pendingReturns.delete(answerId);
        pending.resolve(bytes);
        return;
      }
      case CapnpEsRpcMessageWhich.ABORT: {
        const error = new NativeCapnpBridgeProtocolError(
          `worker aborted its Cap'n Proto RPC connection: ${message.abort.reason}`);
        this.close(error);
        return;
      }
      default:
        return;
    }
  }

  async dispatch(connection, request, send, receive, context) {
    if (this.#closed) {
      throw new CapnpUnavailableError("worker Cap'n Proto RPC connection is closed");
    }
    if (typeof send !== "function") {
      throw new TypeError("worker Cap'n Proto RPC event requires a native frame sink");
    }
    if (typeof receive !== "function") {
      throw new TypeError("worker Cap'n Proto RPC event requires a native frame source");
    }
    // Every event receives an equivalent native sink. Retaining the latest one lets capnp-es
    // emit deferred Resolve/Release messages without retaining an event's ExecutionContext.
    this.#send = send;
    const eventState = new WorkerRpcEventState(send, context);

    return await workerRpcEventContext.run(eventState, async () => {
      const bytes = nativeCapnpMessageBytes(request);
      const message = new CapnpEsMessage(bytes, false).getRoot(CapnpEsRpcMessage);
      let questionId;
      switch (message.which()) {
        case CapnpEsRpcMessageWhich.BOOTSTRAP:
          questionId = message.bootstrap.questionId;
          break;
        case CapnpEsRpcMessageWhich.CALL:
          questionId = message.call.questionId;
          break;
        default:
          if (message.which() === CapnpEsRpcMessageWhich.FINISH) {
            this.#handleFinish(message);
          }
          this.#handleMessage(connection, message, eventState.context);
          return new Uint8Array(0);
      }

      if (this.#pendingReturns.has(questionId)) {
        throw new NativeCapnpBridgeProtocolError(
          `worker received duplicate concurrent RPC question ${questionId}`);
      }

      const controller = new AbortController();
      this.#answerAbortControllers.set(questionId, controller);
      let dispatchContext = eventState.context;
      if (message.which() === CapnpEsRpcMessageWhich.CALL) {
        dispatchContext = Object.freeze({ ...eventState.context, signal: controller.signal });
      }

      let resolve;
      let reject;
      const response = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      this.#pendingReturns.set(questionId, { resolve, reject });
      try {
        this.#handleMessage(connection, message, dispatchContext);
      } catch (error) {
        this.#answerAbortControllers.delete(questionId);
        this.#pendingReturns.delete(questionId);
        throw error;
      }

      // Callback Returns belong to the top-level Call that issued them. Keep receiving after its
      // Return while event-scoped waitUntil() work remains, so streaming and other background RPC
      // can finish under the IoContext where it started.
      let inboundPromise = null;
      while (this.#pendingReturns.has(questionId) || eventState.hasWaits) {
        if (inboundPromise === null) {
          inboundPromise = Promise.resolve(receive()).then(
            value => ({ value }), error => ({ error }));
        }
        const racers = [inboundPromise.then(result => ({ kind: "inbound", result }))];
        if (eventState.hasWaits) {
          racers.push(eventState.waitForChange().then(() => ({ kind: "change" })));
        }
        if (this.#pendingReturns.has(questionId)) {
          racers.push(response.then(
            () => ({ kind: "return" }), error => ({ kind: "error", error })));
        }
        const next = await Promise.race(racers);
        if (next.kind === "change" || next.kind === "return") continue;
        if (next.kind === "error") throw next.error;
        inboundPromise = null;
        if ("error" in next.result) throw next.result.error;
        const inboundBytes = nativeCapnpMessageBytes(next.result.value);
        const inbound = new CapnpEsMessage(inboundBytes, false).getRoot(CapnpEsRpcMessage);
        if (inbound.which() === CapnpEsRpcMessageWhich.FINISH) {
          this.#handleFinish(inbound);
        }
        this.#handleMessage(connection, inbound, dispatchContext);
      }
      if (inboundPromise !== null) inboundPromise.catch(() => {});
      return await response;
    });
  }

  close(error = new CapnpUnavailableError("worker Cap'n Proto RPC connection was closed")) {
    if (this.#closed) return;
    this.#closed = true;
    for (const controller of this.#answerAbortControllers.values()) {
      controller.abort(error);
    }
    this.#answerAbortControllers.clear();
    this.#canceledAnswers.clear();
    for (const pending of this.#pendingReturns.values()) {
      pending.reject(error);
    }
    this.#pendingReturns.clear();
  }
}

// Internal transport used by the native isolate host. Public worker definitions install the
// reserved sandstormRpcEvent handler through defineWorker(), so applications never handle frames.
export function createCapnpRpcEventDispatcher(InterfaceClass, target, options = {}) {
  validateNativeCapnpGeneratedInterface(InterfaceClass, "createCapnpRpcEventDispatcher()");
  if (typeof InterfaceClass.Server !== "function") {
    throw new TypeError(
      "createCapnpRpcEventDispatcher() requires a generated server interface class");
  }
  if (!target || typeof target !== "object") {
    throw new TypeError("createCapnpRpcEventDispatcher() requires a server target object");
  }

  const transport = new CapnpRpcEventTransport(options.runWithContext);
  const connection = new EventDrivenCapnpConn(transport, options.finalize);
  connection.initMain(InterfaceClass, target);
  return Object.freeze({
    connection,
    handler: (request, send, receive, env, ctx) => transport.dispatch(
      connection, request, send, receive, Object.freeze({ env, ctx })),
    close: (error) => {
      transport.close(error);
      connection.shutdown(error);
    },
  });
}

let activeWorkerCapnpCallContext = null;
let workerPlatformBridge = null;

function setWorkerPlatformBridge(platform) {
  workerPlatformBridge = new IsolateBridge.Client(nativeCapnpClientReference(
    platform, "worker platform bridge"));
}

export function connectWorkerPlatformBridge() {
  if (workerPlatformBridge === null) {
    throw new NativeCapnpBridgeProtocolError(
      "worker platform bridge is unavailable before the export broker is initialized");
  }

  const bridge = new IsolateBridge.Client(nativeCapnpClientReference(
    workerPlatformBridge, "worker platform bridge"));
  return Object.assign(bridge, {
    connection: null,
    transport: Object.freeze({ kind: "workerEventCapnp" }),
    close() {},
  });
}

function contextualizeWorkerTarget(name, target) {
  return new Proxy(target, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== "string" || typeof value !== "function") return value;
      return (params, results) => {
        if (activeWorkerCapnpCallContext === null) {
          throw new NativeCapnpBridgeProtocolError(
            `worker Cap'n Proto server ${name} was called outside an RPC event`);
        }
        const reportError = (error) => {
          const callerCanceled = error instanceof DOMException &&
              error.name === "AbortError" &&
              error.message === "Cap'n Proto caller canceled the worker method";
          if (!callerCanceled) {
            console.error(`Uncaught exception in worker Cap'n Proto server ${name}.${property}():`,
                error);
          }
          throw error;
        };
        try {
          const result =
              Reflect.apply(value, target, [params, activeWorkerCapnpCallContext, results]);
          return result !== null && result !== undefined && typeof result.then === "function"
            ? Promise.resolve(result).catch(reportError)
            : result;
        } catch (error) {
          return reportError(error);
        }
      };
    },
  });
}

// Internal building block for SDK facades which return additional worker-hosted capabilities.
// Their calls travel on the same broker connection and therefore receive the event context that
// is active while capnp-es dispatches each individual method.
export function createWorkerCapnpClient(InterfaceClass, target, name = "returned capability") {
  validateNativeCapnpGeneratedInterface(InterfaceClass, "createWorkerCapnpClient()");
  if (typeof InterfaceClass.Server !== "function" || !target || typeof target !== "object") {
    throw new TypeError("createWorkerCapnpClient() requires a generated interface and target");
  }
  return new InterfaceClass.Server(contextualizeWorkerTarget(name, target)).client();
}

// Builds the worker-global RPC bootstrap as a name/type broker. Each exported application
// capability remains typed by its own generated class; the broker is the only schema the native
// host needs in order to carry arbitrary application interfaces over the shared connection.
export function createCapnpWorkerExportDispatcher(workerExports, options = {}) {
  if (!workerExports || typeof workerExports !== "object" || Array.isArray(workerExports)) {
    throw new TypeError("createCapnpWorkerExportDispatcher() requires an export object");
  }

  const exportsByName = new Map();
  for (const [name, descriptor] of Object.entries(workerExports)) {
    if (!name || !descriptor || typeof descriptor !== "object") {
      throw new TypeError("worker Cap'n Proto exports require non-empty names and descriptors");
    }
    const InterfaceClass = descriptor.interface;
    const metadata = nativeCapnpInterfaceMetadata(
      InterfaceClass, `worker Cap'n Proto export ${name}`);
    if (typeof InterfaceClass.Server !== "function") {
      throw new TypeError(`worker Cap'n Proto export ${name} requires a server interface class`);
    }
    if (!descriptor.target || typeof descriptor.target !== "object") {
      throw new TypeError(`worker Cap'n Proto export ${name} requires a server target object`);
    }
    // Generated capnp-es server methods call their target synchronously before awaiting the
    // returned promise. Interpose only at that boundary so concurrent events cannot observe a
    // worker-global stale context. The generated results builder remains available as the third
    // argument for handlers that need it.
    const contextualTarget = contextualizeWorkerTarget(`export ${name}`, descriptor.target);
    exportsByName.set(name, Object.freeze({
      interfaceId: metadata.interfaceId,
      InterfaceClass,
      client: new InterfaceClass.Server(contextualTarget).client(),
      durable: descriptor.durable ?? null,
    }));
  }

  const runWithContext = (context, callback) => {
    const previous = activeWorkerCapnpCallContext;
    activeWorkerCapnpCallContext = context;
    try {
      return callback();
    } finally {
      activeWorkerCapnpCallContext = previous;
    }
  };
  const dispatcher = createCapnpRpcEventDispatcher(IsolateExportBroker, {
    getExport({ name: inputName, interfaceId, platform }) {
      setWorkerPlatformBridge(platform);
      const name = String(inputName);
      const resolveExport = () => {
        const workerExport = exportsByName.get(name);
        if (!workerExport || workerExport.interfaceId !== interfaceId) {
          throw new NativeCapnpBridgeProtocolError(
            `worker Cap'n Proto export ${name} was not registered with interface ` +
            `0x${interfaceId.toString(16)}`);
        }
        return {
          cap: nativeCapnpCapabilityPointer(
            workerExport.client, `worker Cap'n Proto export ${name}`),
        };
      };
      const beforeGetExport = options.beforeGetExport?.({ name, interfaceId });
      return beforeGetExport === undefined
        ? resolveExport()
        : Promise.resolve(beforeGetExport).then(resolveExport);
    },
    restoreExport({ name: inputName, interfaceId, objectId, platform }) {
      setWorkerPlatformBridge(platform);
      const name = String(inputName);
      const workerExport = exportsByName.get(name);
      if (!workerExport || workerExport.interfaceId !== interfaceId ||
          workerExport.durable === null) {
        throw new NativeCapnpBridgeProtocolError(
          `worker Cap'n Proto export ${name} has no durable registry for interface ` +
          `0x${interfaceId.toString(16)}`);
      }
      const callContext = activeWorkerCapnpCallContext;
      if (callContext === null) {
        throw new NativeCapnpBridgeProtocolError(
          `worker Cap'n Proto export ${name} restore ran outside an RPC event`);
      }
      return Promise.resolve(workerExport.durable.restore(objectId, callContext)).then(restored => {
        if (!restored || typeof restored !== "object") {
          throw new NativeCapnpBridgeProtocolError(
            `worker Cap'n Proto export ${name} restore did not return a capability or server target`);
        }
        let client;
        try {
          client = nativeCapnpClientReference(restored, `restored worker capability ${name}`);
        } catch (_) {
          client = createWorkerCapnpClient(
            workerExport.InterfaceClass, restored, `restored export ${name}`);
        }
        return {
          cap: nativeCapnpCapabilityPointer(
            client, `restored worker Cap'n Proto export ${name}`),
        };
      });
    },
    dropExport({ name: inputName, interfaceId, objectId, platform }) {
      setWorkerPlatformBridge(platform);
      const name = String(inputName);
      const workerExport = exportsByName.get(name);
      if (!workerExport || workerExport.interfaceId !== interfaceId ||
          workerExport.durable === null) {
        throw new NativeCapnpBridgeProtocolError(
          `worker Cap'n Proto export ${name} has no durable registry for interface ` +
          `0x${interfaceId.toString(16)}`);
      }
      const callContext = activeWorkerCapnpCallContext;
      if (callContext === null) {
        throw new NativeCapnpBridgeProtocolError(
          `worker Cap'n Proto export ${name} drop ran outside an RPC event`);
      }
      return workerExport.durable.drop(objectId, callContext);
    },
  }, { ...options, runWithContext });

  return Object.freeze({
    ...dispatcher,
    declarations: Object.freeze(Array.from(exportsByName, ([name, workerExport]) =>
      Object.freeze({ name, interfaceId: workerExport.interfaceId }))),
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
  if (!target || typeof target !== "object") {
    throw new TypeError("exportCapnp() requires a generated server target object");
  }

  const interfaceMetadata = nativeCapnpInterfaceMetadata(InterfaceClass, "exportCapnp()");

  const client = createWorkerCapnpClient(InterfaceClass, target, "local export capability");
  const publicInterfaceId = interfaceMetadata.interfaceIdHex;
  const browserHandoffs = new Map();
  let dropped = false;

  async function dropLocalExport() {
    if (dropped) {
      return undefined;
    }

    dropped = true;
    let firstError;
    for (const [handoffId, handoff] of browserHandoffs) {
      try {
        await handoff.bridge.dropBrowserHandoff({ id: handoffId });
        if (handoff.ownsBridge) handoff.bridge.close();
      } catch (error) {
        if (handoff.ownsBridge) handoff.bridge.close(error);
        if (firstError === undefined) firstError = error;
      }
    }
    browserHandoffs.clear();
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
    const bridge = connectWorkerPlatformBridge();
    const stored = await bridge.createBrowserHandoff((params) => {
      initCapnpCapabilityParam(params, client, "local export capability");
      params.sessionId = sessionId;
      params.interfaceId = interfaceMetadata.interfaceId;
      params.interfaceName = interfaceMetadata.interfaceName;
    });
    if (!stored || typeof stored.id !== "string" || stored.id.length === 0) {
      throw new NativeCapnpBridgeProtocolError(
        "isolate bridge returned an invalid local export browser handoff id");
    }
    browserHandoffs.set(stored.id, { bridge, ownsBridge: false });
    return Object.freeze({
      type: "capability",
      id: stored.id,
      kind: "receiverHosted",
      residence: "browserHandoff",
      interfaceId: publicInterfaceId,
      interfaceName: interfaceMetadata.interfaceName,
    });
  }

  return Object.freeze({
    client,
    [CAPNP_CLIENT_SYMBOL]: () => nativeCapnpClientReference(client, "local export capability"),
    browserHandoff: browserHandoffLocalExport,
    drop: dropLocalExport,
    save: async (saveOptions = {}) => {
      if (dropped) {
        throw new CapnpUnavailableError("CapnpExport has been dropped");
      }
      const bridge = connectWorkerPlatformBridge();
      try {
        if (typeof bridge.saveAppCapability !== "function") {
          throw new NativeCapnpBridgeProtocolError(
            "isolate bridge returned no app-capability saver");
        }

        const saved = await bridge.saveAppCapability((params) => {
          initAppCapabilitySaveParams(params, client, nativeCapnpSaveLabel(saveOptions));
        });
        return nativeCapnpSavedTokenText(saved.token);
      } catch (error) {
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
