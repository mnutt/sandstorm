import { RpcTarget, sandstorm, validate } from "sandstorm:api";
import { renderRpcDemo } from "./ui.js";

class CounterApi extends RpcTarget {
  constructor(request, env, key) {
    super();
    this.request = request;
    this.env = env;
    this.key = key;
  }

  async get() {
    const store = sandstorm(this.request, this.env).storage();
    return { value: Number(await store.get(this.key) || "0") };
  }

  async increment() {
    const store = sandstorm(this.request, this.env).storage();
    const current = Number(await store.get(this.key) || "0");
    const next = current + 1;
    await store.put(this.key, String(next));
    return { value: next };
  }

  [Symbol.dispose]() {
    console.log(`disposed RPC counter target ${this.key}`);
  }
}

class DemoApi extends RpcTarget {
  constructor(request, env) {
    super();
    this.request = request;
    this.env = env;
  }

  hello(name) {
    name = validate.optional(name, "there", validate.string, "name", { maxLength: 80 });
    const session = sandstorm(this.request, this.env).session();
    return {
      greeting: `Hello, ${name}!`,
      user: session.user.displayName || "anonymous user",
      permissions: session.permissions,
      sessionId: session.request.sessionId,
    };
  }

  async increment() {
    const store = sandstorm(this.request, this.env).storage();
    const current = Number(await store.get("rpc-counter") || "0");
    const next = current + 1;
    await store.put("rpc-counter", String(next));
    return { value: next };
  }

  add(a, b) {
    return validate.number(a, "a", { coerce: true }) +
      validate.number(b, "b", { coerce: true });
  }

  counter(name = "default") {
    name = validate.optional(name, "default", validate.storageKey, "name");
    return new CounterApi(this.request, this.env, `rpc-counter-${name}`);
  }

  savePowerboxCapability(capability, label = "Isolate RPC saved capability") {
    return sandstorm(this.request, this.env).powerbox().save(capability, { label });
  }

  restorePowerboxCapability(token) {
    return sandstorm(this.request, this.env).powerbox().restore(token);
  }

  dropSavedPowerboxCapability(token) {
    return sandstorm(this.request, this.env).powerbox().dropSaved(token);
  }

  async storeSavedPowerboxCapability(saved, key = "rpc-saved-capability") {
    key = validate.optional(key, "rpc-saved-capability", validate.storageKey, "key");
    const token = validate.string(saved?.token, "saved.token", { minLength: 1, maxLength: 4096 });
    const store = sandstorm(this.request, this.env).storage();
    const write = await store.put(key, token);
    const storedToken = await store.get(key);
    return { key, write, token: storedToken };
  }

  dropPowerboxCapability(capability) {
    return sandstorm(this.request, this.env).powerbox().drop(capability);
  }

  sandstorm() {
    return sandstorm(this.request, this.env).apiTarget();
  }
}

export default {
  async fetch(request, env) {
    const api = sandstorm(request, env);
    const rpc = api.serveRpc(() => new DemoApi(request, env));
    if (rpc) return rpc;

    return new Response(renderRpcDemo(), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};
