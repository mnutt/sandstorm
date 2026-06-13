const MAX_RPC_BATCH_CALLS = 64;
const MAX_RPC_LIVE_TARGETS = 1024;
const RPC_TARGET_MARKER = "__sandstormRpcTarget";
const RPC_PIPELINE_MARKER = "__sandstormRpcPipeline";

const targets = new Map();
const targetIds = new WeakMap();
const targetRefcounts = new Map();

export class RpcTarget {}

function isSafePropertyName(name) {
  return typeof name === "string" &&
      name.length > 0 &&
      name !== "constructor" &&
      name !== "prototype" &&
      !name.startsWith("__") &&
      !name.startsWith("#");
}

function encodeError(error) {
  return {
    name: error && error.name || "Error",
    message: error && error.message || String(error),
  };
}

class RpcError extends Error {
  constructor(error) {
    super(error && error.message || "RPC failed");
    this.name = error && error.name || "Error";
  }
}

function randomTargetId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  throw new Error("secure random target IDs are unavailable");
}

function findRpcMethod(target, method) {
  if (!(target instanceof RpcTarget)) {
    throw new Error("RPC target must extend RpcTarget");
  }

  for (let proto = Object.getPrototypeOf(target);
       proto && proto !== RpcTarget.prototype;
       proto = Object.getPrototypeOf(proto)) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, method);
    if (descriptor && typeof descriptor.value === "function") {
      return descriptor.value;
    }
  }

  throw new Error(`RPC method not found: ${method}`);
}

function registerTarget(target) {
  let id = targetIds.get(target);
  if (!id) {
    if (targets.size >= MAX_RPC_LIVE_TARGETS) {
      throw new RangeError(`RPC live target limit exceeded (${MAX_RPC_LIVE_TARGETS})`);
    }
    id = randomTargetId();
    targetIds.set(target, id);
    targets.set(id, target);
    targetRefcounts.set(id, 0);
  }
  targetRefcounts.set(id, (targetRefcounts.get(id) || 0) + 1);
  return id;
}

function releaseTarget(id) {
  id = String(id);
  const target = targets.get(id);
  if (!target) return;

  const remaining = (targetRefcounts.get(id) || 1) - 1;
  if (remaining > 0) {
    targetRefcounts.set(id, remaining);
    return;
  }

  targets.delete(id);
  targetRefcounts.delete(id);
  if (typeof target[Symbol.dispose] === "function") {
    target[Symbol.dispose]();
  }
}

function lookupTarget(id) {
  const target = targets.get(String(id));
  if (!target) {
    throw new Error(`RPC target not found: ${id}`);
  }
  return target;
}

function encodeRpcValue(value) {
  if (value instanceof RpcTarget) {
    return { [RPC_TARGET_MARKER]: registerTarget(value) };
  }
  if (Array.isArray(value)) {
    return value.map(encodeRpcValue);
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = encodeRpcValue(item);
    }
    return result;
  }
  return value;
}

function decodeRpcValue(value, pipelineResults = new Map()) {
  if (Array.isArray(value)) {
    return value.map((item) => decodeRpcValue(item, pipelineResults));
  }
  if (value && typeof value === "object") {
    if (typeof value[RPC_TARGET_MARKER] === "string") {
      return lookupTarget(value[RPC_TARGET_MARKER]);
    }
    if (typeof value[RPC_PIPELINE_MARKER] === "number") {
      if (!pipelineResults.has(value[RPC_PIPELINE_MARKER])) {
        throw new Error(`RPC pipeline result not found: ${value[RPC_PIPELINE_MARKER]}`);
      }
      return pipelineResults.get(value[RPC_PIPELINE_MARKER]);
    }
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = decodeRpcValue(item, pipelineResults);
    }
    return result;
  }
  return value;
}

async function callTarget(target, method, args, pipelineResults = new Map()) {
  if (!isSafePropertyName(method)) {
    throw new Error(`invalid RPC method: ${method}`);
  }

  return await findRpcMethod(target, method)
      .apply(target, args.map((arg) => decodeRpcValue(arg, pipelineResults)));
}

export async function newWorkersRpcResponse(request, target, options = {}) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: options.headers || {},
    });
  }

  if (request.method !== "POST") {
    return new Response("RPC endpoint requires POST\n", {
      status: 405,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  let payload;
  try {
    payload = await request.json();
  } catch (error) {
    return Response.json({ ok: false, error: encodeError(error) }, { status: 400 });
  }

  const calls = Array.isArray(payload.calls) ? payload.calls : [payload];
  if (calls.length > MAX_RPC_BATCH_CALLS) {
    return Response.json({
      ok: false,
      error: {
        name: "RangeError",
        message: `RPC batch exceeds ${MAX_RPC_BATCH_CALLS} calls`,
      },
    }, { status: 413 });
  }

  const results = [];
  const pipelineResults = new Map();
  for (const call of calls) {
    const id = call && Object.prototype.hasOwnProperty.call(call, "id") ? call.id : null;
    try {
      if (call.dispose) {
        releaseTarget(call.targetId);
        results.push({ id, ok: true, value: null });
      } else {
        let callTargetObject = target;
        if (call && call.targetId) {
          callTargetObject = lookupTarget(call.targetId);
        } else if (call && Object.prototype.hasOwnProperty.call(call, "targetFrom")) {
          callTargetObject = pipelineResults.get(call.targetFrom);
          if (!(callTargetObject instanceof RpcTarget)) {
            throw new Error(`RPC pipeline target not found: ${call.targetFrom}`);
          }
        }
        const args = Array.isArray(call.args) ? call.args : [];
        const value = await callTarget(callTargetObject, call.method, args, pipelineResults);
        pipelineResults.set(id, value);
        results.push({ id, ok: true, value: encodeRpcValue(value) });
      }
    } catch (error) {
      results.push({ id, ok: false, error: encodeError(error) });
    }
  }

  return Response.json({ ok: true, results }, {
    headers: options.headers || {},
  });
}

export function newHttpBatchRpcSession(endpoint, fetchImpl = fetch) {
  let nextId = 1;
  let queue = [];
  let scheduled = false;
  const stubTargetIds = new WeakMap();
  const rpcPromiseIds = new WeakMap();

  function encodeArg(value) {
    if (stubTargetIds.has(value)) {
      return { [RPC_TARGET_MARKER]: stubTargetIds.get(value) };
    }
    if (rpcPromiseIds.has(value)) {
      return { [RPC_PIPELINE_MARKER]: rpcPromiseIds.get(value) };
    }
    if (Array.isArray(value)) {
      return value.map(encodeArg);
    }
    if (value && typeof value === "object") {
      const result = {};
      for (const [key, item] of Object.entries(value)) {
        result[key] = encodeArg(item);
      }
      return result;
    }
    return value;
  }

  function decodeResult(value) {
    if (Array.isArray(value)) {
      return value.map(decodeResult);
    }
    if (value && typeof value === "object") {
      if (typeof value[RPC_TARGET_MARKER] === "string") {
        return makeStub(value[RPC_TARGET_MARKER]);
      }
      const result = {};
      for (const [key, item] of Object.entries(value)) {
        result[key] = decodeResult(item);
      }
      return result;
    }
    return value;
  }

  function makeStub(targetId = null) {
    let disposed = false;
    const stub = new Proxy({}, {
      get(_target, property) {
        if (property === Symbol.dispose) {
          return () => {
            if (disposed) return;
            disposed = true;
            if (targetId !== null) {
              enqueue({ targetId, dispose: true });
            }
          };
        }
        if (property === "then") {
          return undefined;
        }
        if (disposed) {
          throw new Error("RPC stub is disposed");
        }
        if (typeof property === "symbol") {
          return undefined;
        }

        return (...args) => enqueue({
          targetId,
          method: String(property),
          args: args.map(encodeArg),
        });
      },
    });

    if (targetId !== null) {
      stubTargetIds.set(stub, targetId);
    }
    return stub;
  }

  function makeRpcPromise(promise, callId) {
    const rpcPromise = new Proxy({}, {
      get(_target, property) {
        if (property === "then") {
          return promise.then.bind(promise);
        }
        if (property === "catch") {
          return promise.catch.bind(promise);
        }
        if (property === "finally") {
          return promise.finally.bind(promise);
        }
        if (property === Symbol.dispose) {
          return () => {
            promise.then((value) => {
              if (value && typeof value[Symbol.dispose] === "function") {
                value[Symbol.dispose]();
              }
            }, () => {});
          };
        }
        if (typeof property === "symbol") {
          return undefined;
        }

        return (...args) => enqueue({
          targetFrom: callId,
          method: String(property),
          args: args.map(encodeArg),
        });
      },
    });
    rpcPromiseIds.set(rpcPromise, callId);
    return rpcPromise;
  }

  function enqueue(call) {
    let callId;
    const promise = new Promise((resolve, reject) => {
      const id = nextId++;
      callId = id;
      queue.push({ id, ...call, resolve, reject });
      scheduleFlush();
    });
    return makeRpcPromise(promise, callId);
  }

  async function flush() {
    scheduled = false;
    const batch = queue;
    queue = [];
    if (batch.length === 0) return;

    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          calls: batch.map(({ id, targetId, targetFrom, method, args, dispose }) => ({
            id, targetId, targetFrom, method, args, dispose,
          })),
        }),
      });
    } catch (error) {
      for (const call of batch) call.reject(error);
      return;
    }

    if (!response.ok) {
      const error = new Error(`RPC request failed with HTTP ${response.status}`);
      for (const call of batch) call.reject(error);
      return;
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      for (const call of batch) call.reject(error);
      return;
    }

    const results = new Map((payload.results || []).map((result) => [result.id, result]));
    for (const call of batch) {
      const result = results.get(call.id);
      if (!result) {
        call.reject(new Error(`RPC response did not contain result ${call.id}`));
      } else if (!result.ok) {
        call.reject(new RpcError(result.error));
      } else {
        call.resolve(decodeResult(result.value));
      }
    }
  }

  function scheduleFlush() {
    if (!scheduled) {
      scheduled = true;
      setTimeout(flush, 0);
    }
  }

  return makeStub();
}

export function browserClientScript() {
  return `
const RPC_TARGET_MARKER = "__sandstormRpcTarget";
const RPC_PIPELINE_MARKER = "__sandstormRpcPipeline";

class SandstormRpcError extends Error {
  constructor(error) {
    super(error && error.message || "RPC failed");
    this.name = error && error.name || "Error";
  }
}

export function newHttpBatchRpcSession(endpoint) {
  let nextId = 1;
  let queue = [];
  let scheduled = false;
  const stubTargetIds = new WeakMap();
  const rpcPromiseIds = new WeakMap();

  function encodeArg(value) {
    if (stubTargetIds.has(value)) {
      return { [RPC_TARGET_MARKER]: stubTargetIds.get(value) };
    }
    if (rpcPromiseIds.has(value)) {
      return { [RPC_PIPELINE_MARKER]: rpcPromiseIds.get(value) };
    }
    if (Array.isArray(value)) {
      return value.map(encodeArg);
    }
    if (value && typeof value === "object") {
      const result = {};
      for (const [key, item] of Object.entries(value)) {
        result[key] = encodeArg(item);
      }
      return result;
    }
    return value;
  }

  function decodeResult(value) {
    if (Array.isArray(value)) {
      return value.map(decodeResult);
    }
    if (value && typeof value === "object") {
      if (typeof value[RPC_TARGET_MARKER] === "string") {
        return makeStub(value[RPC_TARGET_MARKER]);
      }
      const result = {};
      for (const [key, item] of Object.entries(value)) {
        result[key] = decodeResult(item);
      }
      return result;
    }
    return value;
  }

  function makeStub(targetId = null) {
    let disposed = false;
    const stub = new Proxy({}, {
      get(_target, property) {
        if (property === Symbol.dispose) {
          return () => {
            if (disposed) return;
            disposed = true;
            if (targetId !== null) {
              enqueue({ targetId, dispose: true });
            }
          };
        }
        if (property === "then") {
          return undefined;
        }
        if (disposed) {
          throw new Error("RPC stub is disposed");
        }
        if (typeof property === "symbol") {
          return undefined;
        }

        return (...args) => enqueue({
          targetId,
          method: String(property),
          args: args.map(encodeArg),
        });
      },
    });

    if (targetId !== null) {
      stubTargetIds.set(stub, targetId);
    }
    return stub;
  }

  function makeRpcPromise(promise, callId) {
    const rpcPromise = new Proxy({}, {
      get(_target, property) {
        if (property === "then") {
          return promise.then.bind(promise);
        }
        if (property === "catch") {
          return promise.catch.bind(promise);
        }
        if (property === "finally") {
          return promise.finally.bind(promise);
        }
        if (property === Symbol.dispose) {
          return () => {
            promise.then((value) => {
              if (value && typeof value[Symbol.dispose] === "function") {
                value[Symbol.dispose]();
              }
            }, () => {});
          };
        }
        if (typeof property === "symbol") {
          return undefined;
        }

        return (...args) => enqueue({
          targetFrom: callId,
          method: String(property),
          args: args.map(encodeArg),
        });
      },
    });
    rpcPromiseIds.set(rpcPromise, callId);
    return rpcPromise;
  }

  function enqueue(call) {
    let callId;
    const promise = new Promise((resolve, reject) => {
      const id = nextId++;
      callId = id;
      queue.push({ id, ...call, resolve, reject });
      scheduleFlush();
    });
    return makeRpcPromise(promise, callId);
  }

  async function flush() {
    scheduled = false;
    const batch = queue;
    queue = [];
    if (batch.length === 0) return;

    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          calls: batch.map(({ id, targetId, targetFrom, method, args, dispose }) => ({
            id, targetId, targetFrom, method, args, dispose,
          })),
        }),
      });
    } catch (error) {
      for (const call of batch) call.reject(error);
      return;
    }

    if (!response.ok) {
      const error = new Error(\`RPC request failed with HTTP \${response.status}\`);
      for (const call of batch) call.reject(error);
      return;
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      for (const call of batch) call.reject(error);
      return;
    }

    const results = new Map((payload.results || []).map((result) => [result.id, result]));
    for (const call of batch) {
      const result = results.get(call.id);
      if (!result) {
        call.reject(new Error(\`RPC response did not contain result \${call.id}\`));
      } else if (!result.ok) {
        call.reject(new SandstormRpcError(result.error));
      } else {
        call.resolve(decodeResult(result.value));
      }
    }
  }

  function scheduleFlush() {
    if (!scheduled) {
      scheduled = true;
      setTimeout(flush, 0);
    }
  }

  return makeStub();
}
`;
}
