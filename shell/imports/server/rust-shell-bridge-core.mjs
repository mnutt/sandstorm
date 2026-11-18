import { memorySessionStore } from "./rust-shell-session-store.mjs";
import { createGrainLeases } from "./rust-shell-grain-leases.mjs";
import { createHash, randomBytes } from "node:crypto";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const secret = () => randomBytes(32).toString("hex");
const validSecret = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const unauthorized = () => Object.assign(new Error("Sign in again through the main shell."), { status: 401 });

// A deliberately narrow adapter. Grants and grain leases remain ephemeral. No browser account IDs, Mongo query
// selectors, Meteor resume tokens or privileged backend capabilities cross it.
export function createRustShellBridge({ authorize, snapshot, dismiss, markRead, observe, grains = {}, sessionStore = memorySessionStore(), now = Date.now }) {
  let watches = 0;
  const grants = new Map();
  const sessions = sessionStore;
  // One authoritative bridge process admits exchanges serially, including DB
  // writes, so async persistence cannot race the linked-session bound.
  let exchanging = Promise.resolve();
  const prune = () => {
    for (const [key, value] of grants) if (value.expires <= now()) grants.delete(key);
  };
  const validate = async (record) => {
    if (!record || record.expires <= now()) throw unauthorized();
    const account = await authorize(record.accountId, record.loginHash);
    if (!account || account.expires <= now()) throw unauthorized();
    return account;
  };
  const session = async (token) => {
    if (!validSecret(token)) throw unauthorized();
    const key = hash(token);
    const record = await sessions.get(key);
    try { return { record, account: await validate(record) }; }
    catch (error) {
      // A database outage is not revocation. Keep the durable link for recovery.
      if (error.status === 401) { await sessions.remove(key); await leases.revoke(token); }
      throw error;
    }
  };
  const leases = createGrainLeases({ ...grains, validate: session, now });
  return {
    sweepGrains: () => leases.sweep(),
    pruneSessions: () => sessions.prune(now()),
    async issue(accountId, loginHash, state) {
      prune();
      if (!validSecret(state) || !accountId || !loginHash) throw unauthorized();
      const record = { accountId, loginHash, state, expires: now() + 60000 };
      await validate(record);
      if (grants.size >= 1024) throw Object.assign(new Error("Too many pending sign-ins."), { status: 503 });
      const code = secret();
      grants.set(hash(code), record);
      return code;
    },
    async handle(action, input, signal = new AbortController().signal) {
      prune();
      if (action === "exchange") {
        if (!validSecret(input.code) || !validSecret(input.state)) throw unauthorized();
        const key = hash(input.code);
        const record = grants.get(key);
        grants.delete(key); // Consume before any await: concurrent exchanges cannot both win.
        if (!record || record.state !== input.state) throw unauthorized();
        const exchange = exchanging.then(async () => {
          const account = await validate(record);
          await sessions.prune(now());
          if (validSecret(input.previous)) {
            await sessions.remove(hash(input.previous));
            await leases.revoke(input.previous);
          }
          if (await sessions.count() >= 1024) throw Object.assign(new Error("Too many linked sessions."), { status: 503 });
          const token = secret();
          const linked = { accountId: record.accountId, loginHash: record.loginHash,
            expires: Math.min(account.expires, now() + 12 * 60 * 60 * 1000) };
          await sessions.put(hash(token), linked);
          return { token, account: { name: account.name }, expires: linked.expires };
        });
        exchanging = exchange.catch(() => {});
        return exchange;
      }
      if (action === "logout") {
        if (validSecret(input.token)) {
          await sessions.remove(hash(input.token));
          await leases.revoke(input.token);
        }
        return {};
      }
      // Cleanup remains possible after expiration; scope ownership is still checked.
      if (action === "closeGrain") return leases.close(input.token, input);
      const { record, account } = await session(input.token);
      if (action === "openGrain") return leases.open(input.token, record.accountId, input, signal);
      if (action === "renderTemplate") return leases.template(input.token, input, signal);
      if (action === "keepGrain") return leases.keep(input.token, input);
      if (action === "session") return { account: { name: account.name }, expires: record.expires };
      if (action === "snapshot") {
        const result = await snapshot(record.accountId);
        await session(input.token); // Do not return data after revocation during DB reads.
        return { ...result, version: hash(JSON.stringify(result)) };
      }
      if (action === "watch") {
        if (!observe || !validSecret(input.after)) {
          throw Object.assign(new Error("Invalid watch request."), { status: 400 });
        }
        if (watches >= 32) throw Object.assign(new Error("Too many notification watches."), { status: 503 });
        ++watches;
        let stop;
        let wake;
        let dirty = true;
        const changed = () => { dirty = true; wake?.(); };
        const deadline = Date.now() + 20000;
        const aborted = () => { if (signal.aborted) throw new Error("Watch disconnected"); };
        try {
          // Observe before reading: writes during the read or between requests
          // cannot fall through a snapshot/subscription gap.
          aborted();
          stop = await observe(record.accountId, changed);
          let result;
          while (true) {
            aborted();
            await session(input.token);
            if (dirty) {
              dirty = false;
              const projection = await snapshot(record.accountId);
              result = { ...projection, version: hash(JSON.stringify(projection)) };
            }
            await session(input.token);
            aborted();
            if (result.version !== input.after || Date.now() >= deadline) return result;
            if (dirty) continue;
            await new Promise((resolve) => {
              const done = () => {
                clearTimeout(timer);
                signal.removeEventListener("abort", done);
                wake = undefined;
                resolve();
              };
              const timer = setTimeout(done, Math.min(1000, Math.max(1, deadline - Date.now())));
              wake = done;
              signal.addEventListener("abort", done, { once: true });
              if (dirty || signal.aborted) done();
            });
          }
        } finally {
          --watches;
          await stop?.();
        }
      }
      if (action === "dismiss") {
        if (typeof input.id !== "string" || !input.id || input.id.length > 256) {
          throw Object.assign(new Error("Invalid notification ID."), { status: 400 });
        }
        await dismiss(record.accountId, input.id);
        return {};
      }
      if (action === "read") { await markRead(record.accountId); return {}; }
      throw Object.assign(new Error("Unknown bridge operation."), { status: 404 });
    },
  };
}

// Only fixed operations, bounded request/response bodies, no CORS or network listener.
export function bridgeHandler(bridge) {
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    const controller = new AbortController();
    const disconnected = () => controller.abort();
    res.once("close", disconnected);
    try {
      if (req.method !== "POST" || !/^\/(exchange|session|snapshot|watch|dismiss|read|logout|openGrain|keepGrain|closeGrain|renderTemplate)$/.test(req.url)) {
        throw Object.assign(new Error("Not found."), { status: 404 });
      }
      const parts = [];
      let bytes = 0;
      for await (const part of req) {
        bytes += part.length;
        if (bytes > 4096) throw Object.assign(new Error("Request too large."), { status: 413 });
        parts.push(part);
      }
      let input;
      try { input = JSON.parse(Buffer.concat(parts).toString()); }
      catch { throw Object.assign(new Error("Invalid JSON."), { status: 400 }); }
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw Object.assign(new Error("Invalid request."), { status: 400 });
      }
      const output = JSON.stringify(await bridge.handle(req.url.slice(1), input, controller.signal));
      if (Buffer.byteLength(output) > 220000) throw new Error("Projection too large");
      res.end(output);
    } catch (error) {
      if (res.destroyed) return;
      const status = error.status || (Number.isInteger(error.error) ? error.error : 500);
      res.statusCode = status >= 400 && status < 600 ? status : 500;
      res.end(JSON.stringify({ error: res.statusCode === 500 ? "Bridge operation failed." : error.reason || error.message }));
    } finally {
      res.removeListener("close", disconnected);
    }
  };
}
