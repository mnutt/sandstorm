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

async function callTarget(target, method, args) {
  if (!isSafePropertyName(method)) {
    throw new Error(`invalid RPC method: ${method}`);
  }

  const value = target[method];
  if (typeof value !== "function") {
    throw new Error(`RPC method not found: ${method}`);
  }

  return await value.apply(target, args);
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

  return new Proxy({}, {
    get(_target, property) {
      if (property === Symbol.dispose) {
        return () => {};
      }

      return async (...args) => {
        const id = nextId++;
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ calls: [{ id, method: String(property), args }] }),
        });

        if (!response.ok) {
          throw new Error(`RPC request failed with HTTP ${response.status}`);
        }

        const payload = await response.json();
        const result = payload.results && payload.results[0];
        if (!result) {
          throw new Error("RPC response did not contain a result");
        }
        if (!result.ok) {
          const error = new Error(result.error && result.error.message || "RPC failed");
          error.name = result.error && result.error.name || "Error";
          throw error;
        }
        return result.value;
      };
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
  return new Proxy({}, {
    get(_target, property) {
      return async (...args) => {
        const id = nextId++;
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ calls: [{ id, method: String(property), args }] }),
        });
        if (!response.ok) throw new Error(\`RPC request failed with HTTP \${response.status}\`);
        const payload = await response.json();
        const result = payload.results && payload.results[0];
        if (!result) throw new Error("RPC response did not contain a result");
        if (!result.ok) throw new SandstormRpcError(result.error);
        return result.value;
      };
    },
  });
}
`;
}
