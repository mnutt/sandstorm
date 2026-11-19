import { createSharedLeases } from "./rust-shell-shared-leases.mjs";
import { memorySessionStore } from "./rust-shell-session-store.mjs";
import { createGrainLeases } from "./rust-shell-grain-leases.mjs";
import { createHash, randomBytes } from "node:crypto";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const secret = () => randomBytes(32).toString("hex");
const validSecret = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const unauthorized = () => Object.assign(new Error("Sign in again through the main shell."), { status: 401 });

// A deliberately narrow adapter. Grants and grain leases remain ephemeral. No browser account IDs, Mongo query
// selectors, Meteor resume tokens or privileged backend capabilities cross it.
export function createRustShellBridge({ authorize, snapshot, dismiss, markRead, observe, install, listApps, createGrain, getProfile, updateProfile, grains = {}, shared = {}, sessionStore = memorySessionStore(), now = Date.now }) {
  let watches = 0;
  const creating = new Set();
  const installing = new Set();
  const updatingProfiles = new Set();
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
  const sharedLeases = createSharedLeases({ ...shared, now, account: async token => {
    const value = await session(token);
    return {id:value.record.accountId, name:value.account.name};
  } });
  return {
    sweepGrains: () => Promise.all([leases.sweep(), sharedLeases.sweep()]),
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
      if (action === "inspectSharedGrain") return sharedLeases.inspect(input);
      if (action === "openSharedGrain") return sharedLeases.open(input, signal);
      if (action === "keepSharedGrain") return sharedLeases.keep(input);
      if (action === "closeSharedGrain") return sharedLeases.close(input);
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
          return { token, account: { name: account.name, key: hash(record.accountId) }, expires: linked.expires };
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
      if (action === "install") {
        const {operation, data} = input;
        if (!install || !["catalog", "status", "download", "retry", "confirm", "upgrade", "upload"].includes(operation) ||
            !data || typeof data !== "object" || Array.isArray(data) ||
            Object.keys(data).some(key => !["packageId", "url"].includes(key)) ||
            Object.values(data).some(value => typeof value !== "string" || value.length > 2048)) {
          throw Object.assign(new Error("Invalid installation request."), {status:400});
        }
        const mutating = !["catalog", "status"].includes(operation);
        if (mutating && (installing.has(record.accountId) || installing.size >= 8)) {
          throw Object.assign(new Error("An installation operation is in progress."), {status:409});
        }
        if (mutating) installing.add(record.accountId);
        try {
          const beforeWrite = async () => {
            await session(input.token);
            if (signal.aborted) throw Object.assign(new Error("Installation request disconnected."), {status:409});
          };
          await beforeWrite();
          const result = await install(record.accountId, operation, data, beforeWrite);
          await session(input.token);
          return result;
        } finally { if (mutating) installing.delete(record.accountId); }
      }
      if (action === "getProfile" || action === "updateProfile") {
        if (!getProfile) throw Object.assign(new Error("Profile unavailable."), { status: 503 });
        if (action === "updateProfile") {
          const profile = input.profile;
          if (!updateProfile || !profile || typeof profile !== "object" || Array.isArray(profile) ||
              Object.keys(profile).some(key => !["name", "handle", "pronoun"].includes(key)) ||
              typeof profile.name !== "string" || !profile.name.trim() || profile.name.length > 160 ||
              typeof profile.handle !== "string" || profile.handle.length > 64 || !/^[a-z_][a-z0-9_]*$/.test(profile.handle) ||
              !["male", "female", "neutral", "robot"].includes(profile.pronoun)) {
            throw Object.assign(new Error("Invalid profile."), { status: 400 });
          }
          if (updatingProfiles.has(record.accountId) || updatingProfiles.size >= 8) {
            throw Object.assign(new Error("A profile update is already in progress."), { status: 409 });
          }
          updatingProfiles.add(record.accountId);
          try {
            const beforeWrite = async () => {
              await session(input.token);
              if (signal.aborted) throw Object.assign(new Error("Profile request disconnected."), { status: 409 });
            };
            await beforeWrite();
            await updateProfile(record.accountId, profile, beforeWrite);
          } finally { updatingProfiles.delete(record.accountId); }
        }
        const result = await getProfile(record.accountId);
        await session(input.token);
        return result;
      }
      if (action === "listApps") {
        if (!listApps) throw Object.assign(new Error("Apps unavailable."), { status: 503 });
        const result = await listApps(record.accountId);
        await session(input.token);
        return result;
      }
      if (action === "createGrain") {
        if (!createGrain || typeof input.actionId !== "string" || !input.actionId || input.actionId.length > 128 ||
            typeof input.title !== "string" || !input.title.trim() || input.title.length > 160) {
          throw Object.assign(new Error("Invalid grain creation request."), { status: 400 });
        }
        if (creating.has(record.accountId) || creating.size >= 8) {
          throw Object.assign(new Error("A grain creation is already in progress. Check your grains before trying again."), { status: 409 });
        }
        creating.add(record.accountId);
        try {
          const beforeCreate = async () => {
            await session(input.token);
            if (signal.aborted) throw Object.assign(new Error("Creation request disconnected."), { status: 409 });
          };
          const grainId = await createGrain(record.accountId, input.actionId, input.title.trim(), beforeCreate);
          await session(input.token);
          return { grainId };
        } finally { creating.delete(record.accountId); }
      }
      if (action === "openGrain") return leases.open(input.token, record.accountId, input, signal);
      if (action === "powerbox") return leases.powerbox(input.token, input, signal);
      if (action === "renderTemplate") return leases.template(input.token, input, signal);
      if (["getSharing", "createShare", "updateShare"].includes(action)) return leases.sharing(input.token, input, signal, action);
      if (action === "renameGrain") return leases.rename(input.token, input, signal);
      if (action === "keepGrain") return leases.keep(input.token, input);
      if (action === "session") return { account: { name: account.name, key: hash(record.accountId) }, expires: record.expires };
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
      if (req.method !== "POST" || !/^\/(inspectSharedGrain|openSharedGrain|keepSharedGrain|closeSharedGrain|exchange|session|snapshot|watch|dismiss|read|logout|openGrain|keepGrain|closeGrain|renderTemplate|powerbox|renameGrain|getSharing|createShare|updateShare|listApps|createGrain|getProfile|updateProfile|install)$/.test(req.url)) {
        throw Object.assign(new Error("Not found."), { status: 404 });
      }
      const parts = [];
      let bytes = 0;
      for await (const part of req) {
        bytes += part.length;
        if (bytes > (req.url === "/powerbox" ? 69632 : req.url === "/renderTemplate" ? 8192 : 4096)) throw Object.assign(new Error("Request too large."), { status: 413 });
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
