import { confirmMutation } from "./rust-shell-mutations.mjs";
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
export function createRustShellBridge({ authorize, nativeAuth, logoutDestination, snapshot, dismiss, markRead, observe, notification, accountSettings, install, listApps, createGrain, manageGrain, getProfile, updateProfile, uploadPicture, grains = {}, shared = {}, sessionStore = memorySessionStore(), now = Date.now }) {
  const creating = new Set();
  const installing = new Set();
  const notificationWrites = new Set();
  const updatingProfiles = new Set();
  const accountWrites = new Set();
  const grants = new Map();
  const sessions = sessionStore;
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
    return {id:value.record.accountId, name:value.account.name, pictureUrl:value.account.pictureUrl || ""};
  } });
  return {
    sweepGrains: () => Promise.all([leases.sweep(), sharedLeases.sweep()]),
    pruneSessions: () => sessions.prune(now()),
    async issue(accountId, loginHash, state) {
      prune();
      if (!validSecret(state) || !accountId || !loginHash) throw unauthorized();
      const record = { accountId, loginHash, state, expires: now() + 60000 };
      await validate(record);
      const code = secret();
      grants.set(hash(code), record);
      return code;
    },
    async handle(action, input, signal = new AbortController().signal) {
      prune();
      if (action === "inspectSharedGrain") return sharedLeases.inspect(input);
      if (action === "openSharedGrain") return sharedLeases.open(input, signal);
      if (action === "waitSharedGrainResponse") return sharedLeases.waitForResponse(input, signal);
      if (action === "keepSharedGrain") return sharedLeases.keep(input);
      if (action === "closeSharedGrain") return sharedLeases.close(input);
      if (action === "exchange") {
        if (!validSecret(input.code) || !validSecret(input.state)) throw unauthorized();
        const key = hash(input.code);
        const record = grants.get(key);
        grants.delete(key); // Consume before any await: concurrent exchanges cannot both win.
        if (!record || record.state !== input.state) throw unauthorized();
        const account = await validate(record);
        await sessions.prune(now());
        if (validSecret(input.previous)) {
          await sessions.remove(hash(input.previous));
          await leases.revoke(input.previous);
        }
        const token = secret();
        const linked = { accountId: record.accountId, loginHash: record.loginHash,
          expires: Math.min(account.expires, now() + 12 * 60 * 60 * 1000) };
        await sessions.put(hash(token), linked);
        return { token, account: { name: account.name, pictureUrl: account.pictureUrl || "", key: hash(record.accountId) }, expires: linked.expires };
      }
      if (action === "nativeAuth") {
        if (!nativeAuth || !validSecret(input.flow) || !["options","sendEmail","email","dev","ldap","oauthStart","oauthFinish","oauthCancel","samlStart","samlFinish","samlCancel"].includes(input.operation)) throw Object.assign(new Error("Invalid sign-in request."), {status:400});
        const result = await nativeAuth(input.operation,input.data,input.flow,signal);
        if (result.accountId && result.loginHash) {
          try {
            if (signal.aborted) throw Object.assign(new Error("Sign-in disconnected."), {status:409});
            const code = await this.issue(result.accountId,result.loginHash,input.flow);
            const linked = await this.handle("exchange",{code,state:input.flow,previous:input.previous},signal);
            if (signal.aborted) {
              await sessions.remove(hash(linked.token));
              await leases.revoke(linked.token);
              throw Object.assign(new Error("Sign-in disconnected."), {status:409});
            }
            result.commit?.();
            return linked;
          } finally { await result.dispose?.(); }
        }
        return result;
      }
      if (action === "logout") {
        let accountId;
        if (validSecret(input.token)) {
          if (logoutDestination) {
            try { accountId = (await session(input.token)).record.accountId; }
            catch (error) { if (error.status !== 401) throw error; }
          }
          await sessions.remove(hash(input.token));
          await leases.revoke(input.token);
        }
        // Local revocation must succeed before directing the browser to an IdP.
        // A broken or missing provider endpoint must never prevent local logout.
        if (accountId) {
          try { return {redirectUrl:await logoutDestination(accountId)}; }
          catch { return {warning:"Signed out of Sandstorm, but identity-provider logout could not start."}; }
        }
        return {};
      }
      // Cleanup remains possible after expiration; scope ownership is still checked.
      if (action === "closeGrain") return leases.close(input.token, input);
      const { record, account } = await session(input.token);
      if (action === "notification") {
        if (!notification || typeof input.key !== "string" || !input.key ||
            !["details", "setStats"].includes(input.operation) ||
            (input.operation === "setStats" && typeof input.enabled !== "boolean")) {
          throw Object.assign(new Error("Invalid notification operation."), {status:400});
        }
        const writing = input.operation === "setStats";
        if (writing && notificationWrites.size) throw Object.assign(new Error("A reporting preference is being saved."), {status:409});
        if (writing) notificationWrites.add(record.accountId);
        try {
          const beforeWrite = async () => {
            await session(input.token);
            if (signal.aborted) throw Object.assign(new Error("Notification request disconnected."), {status:409});
          };
          await beforeWrite();
          const result = await notification(record.accountId,input.key,input.operation,input.enabled,beforeWrite);
          if (writing) await confirmMutation(() => session(input.token));
          else await session(input.token);
          return result;
        } finally { if (writing) notificationWrites.delete(record.accountId); }
      }
      if (action === "accountSettings") {
        const {operation, data} = input;
        const fields = {samlStart:[],samlFinish:["request"],samlCancel:["request"],oauthStart:["provider"],oauthFinish:["provider","request"],oauthCancel:["provider","request"],state:[], primary:["email"], sendEmail:["email","allowLogin"],
          verifyEmail:["email","code","allowLogin"], unlink:["id"], allowLogin:["id","allowLogin"]};
        if (!accountSettings || !Object.hasOwn(fields, operation) || !data || typeof data !== "object" || Array.isArray(data) ||
            Object.keys(data).some(key => !fields[operation].includes(key)) || fields[operation].some(key =>
              key === "allowLogin" ? typeof data[key] !== "boolean" : typeof data[key] !== "string" || !data[key])) {
          throw Object.assign(new Error("Invalid account settings request."), {status:400});
        }
        const writing = operation !== "state";
        if (writing && (accountWrites.has(record.accountId))) {
          throw Object.assign(new Error("An account update is in progress."), {status:409});
        }
        if (writing) accountWrites.add(record.accountId);
        try {
          const beforeWrite = async () => {
            await session(input.token);
            if (signal.aborted) throw Object.assign(new Error("Account request disconnected."), {status:409});
          };
          await beforeWrite();
          const result = await accountSettings(record.accountId, operation, data, beforeWrite);
          if (writing) await confirmMutation(beforeWrite);
          else await beforeWrite();
          return result;
        } finally { if (writing) accountWrites.delete(record.accountId); }
      }
      if (action === "install") {
        const {operation, data} = input;
        if (!install || !["catalog", "status", "download", "retry", "confirm", "upgrade", "upload"].includes(operation) ||
            !data || typeof data !== "object" || Array.isArray(data) ||
            Object.keys(data).some(key => !["packageId", "url"].includes(key)) ||
            Object.values(data).some(value => typeof value !== "string")) {
          throw Object.assign(new Error("Invalid installation request."), {status:400});
        }
        const mutating = !["catalog", "status"].includes(operation);
        if (mutating && (installing.has(record.accountId))) {
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
          if (mutating) await confirmMutation(() => session(input.token));
          else await session(input.token);
          return result;
        } finally { if (mutating) installing.delete(record.accountId); }
      }
      if (action === "uploadPicture") {
        if (!uploadPicture) throw Object.assign(new Error("Picture upload unavailable."), {status:503});
        if (updatingProfiles.has(record.accountId)) throw Object.assign(new Error("A profile update is already in progress."), {status:409});
        updatingProfiles.add(record.accountId);
        try {
          const beforeWrite = async () => {
            await session(input.token);
            if (signal.aborted) throw Object.assign(new Error("Picture upload request disconnected."), {status:409});
          };
          const result = await uploadPicture(record.accountId,beforeWrite);
          await confirmMutation(beforeWrite);
          return result;
        } finally { updatingProfiles.delete(record.accountId); }
      }
      if (action === "getProfile" || action === "updateProfile") {
        if (!getProfile) throw Object.assign(new Error("Profile unavailable."), { status: 503 });
        if (action === "updateProfile") {
          const profile = input.profile;
          if (!updateProfile || !profile || typeof profile !== "object" || Array.isArray(profile) ||
              Object.keys(profile).some(key => !["name", "handle", "pronoun"].includes(key)) ||
              typeof profile.name !== "string" || !profile.name.trim() ||
              typeof profile.handle !== "string" || !/^[a-z_][a-z0-9_]*$/.test(profile.handle) ||
              !["male", "female", "neutral", "robot"].includes(profile.pronoun)) {
            throw Object.assign(new Error("Invalid profile."), { status: 400 });
          }
          if (updatingProfiles.has(record.accountId)) {
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
        const read = async () => {
          const result = await getProfile(record.accountId);
          await session(input.token);
          return result;
        };
        return action === "updateProfile" ? confirmMutation(read) : read();
      }
      if (action === "manageGrain") {
        if (!manageGrain || typeof input.grainId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(input.grainId) ||
            !['read','trash','restore','remove'].includes(input.operation)) throw Object.assign(new Error('Invalid grain action.'),{status:400});
        const beforeWrite = async () => {
          await session(input.token);
          if (signal.aborted) throw Object.assign(new Error('Grain action disconnected.'),{status:409});
        };
        const result = await manageGrain(record.accountId,input.grainId,input.operation,beforeWrite);
        if (input.operation === 'read') await session(input.token);
        else await confirmMutation(beforeWrite);
        return result;
      }
      if (action === "listApps") {
        if (!listApps) throw Object.assign(new Error("Apps unavailable."), { status: 503 });
        const page = input.page ?? 0;
        const appId = input.appId ?? "";
        if (!Number.isSafeInteger(page) || page < 0 || typeof appId !== "string") throw Object.assign(new Error("Invalid app page."), {status:400});
        const result = await listApps(record.accountId, page, appId);
        await session(input.token);
        return result;
      }
      if (action === "createGrain") {
        if (!createGrain || typeof input.actionId !== "string" || !input.actionId ||
            typeof input.title !== "string" || !input.title.trim()) {
          throw Object.assign(new Error("Invalid grain creation request."), { status: 400 });
        }
        if (creating.has(record.accountId)) {
          throw Object.assign(new Error("A grain creation is already in progress. Check your grains before trying again."), { status: 409 });
        }
        creating.add(record.accountId);
        try {
          const beforeCreate = async () => {
            await session(input.token);
            if (signal.aborted) throw Object.assign(new Error("Creation request disconnected."), { status: 409 });
          };
          const grainId = await createGrain(record.accountId, input.actionId, input.title.trim(), beforeCreate);
          await confirmMutation(() => session(input.token));
          return { grainId };
        } finally { creating.delete(record.accountId); }
      }
      if (action === "openGrain") return leases.open(input.token, record.accountId, input, signal);
      if (action === "powerbox") return leases.powerbox(input.token, input, signal);
      if (action === "renderTemplate") return leases.template(input.token, input, signal);
      if (["getSharing", "createShare", "updateShare"].includes(action)) return leases.sharing(input.token, input, signal, action);
      if (action === "renameGrain") return leases.rename(input.token, input, signal);
      if (action === "waitGrainResponse") return leases.waitForResponse(input.token, input, signal);
      if (action === "keepGrain") return leases.keep(input.token, input);
      if (action === "session") return { account: { name: account.name, pictureUrl: account.pictureUrl || "", key: hash(record.accountId) }, expires: record.expires };
      const query = input.query;
      if (query !== undefined && (!query || typeof query !== 'object' || Array.isArray(query) ||
          Object.keys(query).some(key=>!['search','appId','sort','ownership','trash'].includes(key)) ||
          (query.trash !== undefined && typeof query.trash !== 'boolean') || typeof query.search !== 'string' || typeof query.appId !== 'string' ||
          !['recent','title'].includes(query.sort) || !['all','owned','shared'].includes(query.ownership))) {
        throw Object.assign(new Error('Invalid grain query.'),{status:400});
      }
      const pages = input.pages ?? {};
      if ((action === "snapshot" || action === "watch") &&
          (typeof pages !== "object" || Array.isArray(pages) || Object.keys(pages).some(key =>
            !["grains", "notifications"].includes(key) || !Number.isSafeInteger(pages[key]) || pages[key] < 0))) {
        throw Object.assign(new Error("Invalid list page."), {status:400});
      }
      if (action === "snapshot") {
        const result = await snapshot(record.accountId, pages, query);
        await session(input.token); // Do not return data after revocation during DB reads.
        return { ...result, version: hash(JSON.stringify(result)) };
      }
      if (action === "watch") {
        if (!observe || !validSecret(input.after)) {
          throw Object.assign(new Error("Invalid watch request."), { status: 400 });
        }
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
          stop = await observe(record.accountId, changed, pages, query);
          let result;
          while (true) {
            aborted();
            await session(input.token);
            if (dirty) {
              dirty = false;
              const projection = await snapshot(record.accountId, pages, query);
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
          await stop?.();
        }
      }
      if (action === "dismiss") {
        if (typeof input.id !== "string" || !input.id) {
          throw Object.assign(new Error("Invalid notification ID."), { status: 400 });
        }
        await dismiss(record.accountId, input.id);
        return {};
      }
      if (action === "read") {
        if (input.key !== undefined && (typeof input.key !== "string" || !input.key)) {
          throw Object.assign(new Error("Invalid notification ID."), {status:400});
        }
        await markRead(record.accountId, input.key);
        return {};
      }
      throw Object.assign(new Error("Unknown bridge operation."), { status: 404 });
    },
  };
}

// Private Unix-socket adapter: fixed operations, no CORS or public network listener.
// The browser transport enforces the envelope size before JSON serialization.
export function bridgeHandler(bridge) {
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    const controller = new AbortController();
    const disconnected = () => controller.abort();
    res.once("close", disconnected);
    try {
      if (req.method !== "POST" || !/^\/(inspectSharedGrain|openSharedGrain|keepSharedGrain|waitSharedGrainResponse|closeSharedGrain|exchange|session|snapshot|watch|dismiss|read|logout|openGrain|keepGrain|waitGrainResponse|closeGrain|renderTemplate|powerbox|renameGrain|getSharing|createShare|updateShare|listApps|createGrain|manageGrain|getProfile|updateProfile|uploadPicture|install|notification|accountSettings|nativeAuth)$/.test(req.url)) {
        throw Object.assign(new Error("Not found."), { status: 404 });
      }
      const parts = [];
      for await (const part of req) {
        parts.push(part);
      }
      let input;
      try { input = JSON.parse(Buffer.concat(parts).toString()); }
      catch { throw Object.assign(new Error("Invalid JSON."), { status: 400 }); }
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw Object.assign(new Error("Invalid request."), { status: 400 });
      }
      const output = JSON.stringify(await bridge.handle(req.url.slice(1), input, controller.signal));
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
