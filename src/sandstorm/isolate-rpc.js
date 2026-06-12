const MAX_RPC_BATCH_CALLS = 64;

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

async function callTarget(target, method, args) {
  if (!isSafePropertyName(method)) {
    throw new Error(`invalid RPC method: ${method}`);
  }

  return await findRpcMethod(target, method).apply(target, args);
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
  for (const call of calls) {
    const id = call && Object.prototype.hasOwnProperty.call(call, "id") ? call.id : null;
    try {
      const args = Array.isArray(call.args) ? call.args : [];
      const value = await callTarget(target, call.method, args);
      results.push({ id, ok: true, value });
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
        body: JSON.stringify({ calls: batch.map(({ id, method, args }) => ({ id, method, args })) }),
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
        call.resolve(result.value);
      }
    }
  }

  function scheduleFlush() {
    if (!scheduled) {
      scheduled = true;
      setTimeout(flush, 0);
    }
  }

  return new Proxy({}, {
    get(_target, property) {
      if (property === Symbol.dispose) {
        return () => {};
      }
      if (typeof property === "symbol") {
        return undefined;
      }

      return (...args) => new Promise((resolve, reject) => {
        const id = nextId++;
        queue.push({ id, method: String(property), args, resolve, reject });
        scheduleFlush();
      });
    },
  });
}

export function browserClientScript() {
  return `
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
        body: JSON.stringify({ calls: batch.map(({ id, method, args }) => ({ id, method, args })) }),
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
        call.resolve(result.value);
      }
    }
  }

  function scheduleFlush() {
    if (!scheduled) {
      scheduled = true;
      setTimeout(flush, 0);
    }
  }

  return new Proxy({}, {
    get(_target, property) {
      if (typeof property === "symbol") {
        return undefined;
      }

      return (...args) => new Promise((resolve, reject) => {
        const id = nextId++;
        queue.push({ id, method: String(property), args, resolve, reject });
        scheduleFlush();
      });
    },
  });
}
`;
}
