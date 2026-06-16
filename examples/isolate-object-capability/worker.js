import {
  CapabilityCallError,
  ClaimedCapability,
  RpcTarget,
  sandstorm,
  validate,
} from "sandstorm:api";
import { renderObjectCapabilityDemo } from "./ui.js";

class CounterCapability extends RpcTarget {
  #value = 0;

  increment(amount = 1) {
    amount = validate.number(amount, "amount", { coerce: true });
    this.#value += amount;
    return {
      value: this.#value,
      changedBy: amount,
    };
  }

  get() {
    return { value: this.#value };
  }

  child() {
    return new CounterCapability();
  }

  async readOther(other) {
    return other.call("get");
  }
}

let activeCapability = null;
let activeCapabilityId = null;
let activeCapabilityPersistent = false;

async function ensureCapability(request, env, options = {}) {
  const id = options.id || "demo-counter";
  const persistent = options.persistent === true;

  if (
    activeCapability instanceof ClaimedCapability &&
    activeCapabilityId === id &&
    activeCapabilityPersistent === persistent
  ) {
    return activeCapability;
  }

  if (activeCapability instanceof ClaimedCapability) {
    await activeCapability.drop();
  }

  activeCapability = await sandstorm(request, env).capability(new CounterCapability(), {
    id,
    ...(persistent ? { persistent: true } : {}),
  });
  activeCapabilityId = id;
  activeCapabilityPersistent = persistent;
  return activeCapability;
}

async function json(handler) {
  try {
    return Response.json(await handler());
  } catch (error) {
    return Response.json({
      ok: false,
      name: String(error?.name || "Error"),
      message: String(error?.message || error),
      details: error instanceof CapabilityCallError ? error.details : undefined,
    }, { status: error instanceof CapabilityCallError ? error.details?.status || 500 : 500 });
  }
}

export default {
  async fetch(request, env) {
    const api = sandstorm(request, env);
    const internalResponse = api.serveRpc(() => new CounterCapability(), {
      clientScriptPath: "/__sandstorm/object-capability-rpc-client.js",
      rpcPath: "/__sandstorm/object-capability-rpc",
    });
    if (internalResponse) return internalResponse;

    const url = new URL(request.url);

    if (url.pathname === "/api/create" && request.method === "POST") {
      return json(async () => {
        const body = await request.json().catch(() => ({}));
        const capability = await ensureCapability(request, env, {
          id: body.id || "demo-counter",
          persistent: body.persistent === true,
        });
        return {
          ok: true,
          capability: JSON.parse(JSON.stringify(capability)),
          persistent: activeCapabilityPersistent,
        };
      });
    }

    if (url.pathname === "/api/increment" && request.method === "POST") {
      return json(async () => {
        const body = await request.json();
        const capability = await ensureCapability(request, env, {
          persistent: activeCapabilityPersistent,
        });
        const counter = capability.asRpc();
        return {
          ok: true,
          result: await counter.increment(body.amount),
          capability: JSON.parse(JSON.stringify(capability)),
        };
      });
    }

    if (url.pathname === "/api/get" && request.method === "POST") {
      return json(async () => {
        const capability = await ensureCapability(request, env, {
          persistent: activeCapabilityPersistent,
        });
        const counter = capability.asRpc();
        return {
          ok: true,
          result: await counter.get(),
          capability: JSON.parse(JSON.stringify(capability)),
        };
      });
    }

    if (url.pathname === "/api/child" && request.method === "POST") {
      return json(async () => {
        const capability = await ensureCapability(request, env, {
          persistent: activeCapabilityPersistent,
        });
        const counter = capability.asRpc();
        const child = await counter.child();
        const childCounter = child.asRpc();
        const childIncrement = await childCounter.increment(10);
        const readChild = await counter.readOther(child);
        const childDrop = await child.drop();
        return {
          ok: true,
          child: JSON.parse(JSON.stringify(child)),
          childIncrement,
          readChild,
          childDrop,
          capability: JSON.parse(JSON.stringify(capability)),
        };
      });
    }

    if (url.pathname === "/api/missing" && request.method === "POST") {
      return json(async () => {
        const capability = await ensureCapability(request, env, {
          persistent: activeCapabilityPersistent,
        });
        return {
          ok: true,
          result: await capability.call("methodThatDoesNotExist"),
          capability: JSON.parse(JSON.stringify(capability)),
        };
      });
    }

    if (url.pathname === "/api/save" && request.method === "POST") {
      return json(async () => {
        const capability = await ensureCapability(request, env, {
          persistent: activeCapabilityPersistent,
        });
        return {
          ok: true,
          saved: await capability.save({ label: "Object capability" }),
          capability: JSON.parse(JSON.stringify(capability)),
          persistent: activeCapabilityPersistent,
        };
      });
    }

    if (url.pathname === "/api/save-restore" && request.method === "POST") {
      return json(async () => {
        if (activeCapability instanceof ClaimedCapability) {
          await activeCapability.drop();
          activeCapability = null;
          activeCapabilityId = null;
          activeCapabilityPersistent = false;
        }
        sandstorm(request, env).unregisterCapability("demo-counter");
        const target = new CounterCapability();
        const helper = await sandstorm(request, env).persistentCapability(target, {
          id: "demo-counter",
          storageKey: "demo-counter-capability",
          label: "Persistent JS counter",
        });
        activeCapability = helper.capability;
        activeCapabilityId = "demo-counter";
        activeCapabilityPersistent = true;

        const counter = helper.capability.asRpc();
        const before = await counter.increment(7);
        const dropOriginal = await helper.capability.drop();
        activeCapability = null;
        activeCapabilityId = null;
        activeCapabilityPersistent = false;

        const restoredHelper = await sandstorm(request, env).persistentCapability(target, {
          id: "demo-counter",
          storageKey: "demo-counter-capability",
          label: "Persistent JS counter",
        });
        const restored = restoredHelper.capability;
        activeCapability = restored;
        activeCapabilityId = "demo-counter";
        activeCapabilityPersistent = true;
        const restoredCounter = restored.asRpc();
        const afterRestore = await restoredCounter.get();
        const afterIncrement = await restoredCounter.increment(3);

        return {
          ok: true,
          helper: {
            restored: helper.restored,
            storageKey: helper.storageKey,
          },
          before,
          saved: JSON.parse(JSON.stringify(helper.saved)),
          dropOriginal,
          restoredHelper: {
            restored: restoredHelper.restored,
            storageKey: restoredHelper.storageKey,
          },
          restored: JSON.parse(JSON.stringify(restored)),
          afterRestore,
          afterIncrement,
          capability: JSON.parse(JSON.stringify(restored)),
          persistent: activeCapabilityPersistent,
        };
      });
    }

    if (url.pathname === "/api/drop" && request.method === "POST") {
      return json(async () => {
        if (!activeCapability) return { ok: true, dropped: false };
        const dropped = await activeCapability.drop();
        activeCapability = null;
        activeCapabilityId = null;
        activeCapabilityPersistent = false;
        return { ok: true, dropped };
      });
    }

    return new Response(renderObjectCapabilityDemo({
      capability: activeCapability ? JSON.parse(JSON.stringify(activeCapability)) : null,
      persistent: activeCapabilityPersistent,
    }), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};
