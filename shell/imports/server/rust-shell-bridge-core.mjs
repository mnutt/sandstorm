import { createHash, randomBytes } from "node:crypto";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const secret = () => randomBytes(32).toString("hex");
const validSecret = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const unauthorized = () => Object.assign(new Error("Sign in again through the main shell."), { status: 401 });

// A deliberately narrow, ephemeral adapter. No browser account IDs, Mongo query
// selectors, Meteor resume tokens or privileged backend capabilities cross it.
export function createRustShellBridge({ authorize, snapshot, dismiss, markRead, now = Date.now }) {
  const grants = new Map();
  const sessions = new Map();
  const prune = () => {
    for (const map of [grants, sessions]) {
      for (const [key, value] of map) if (value.expires <= now()) map.delete(key);
    }
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
    const record = sessions.get(key);
    try { return { record, account: await validate(record) }; }
    catch (error) { sessions.delete(key); throw error; }
  };
  return {
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
    async handle(action, input) {
      prune();
      if (action === "exchange") {
        if (!validSecret(input.code) || !validSecret(input.state)) throw unauthorized();
        const key = hash(input.code);
        const record = grants.get(key);
        grants.delete(key); // Consume before any await: concurrent exchanges cannot both win.
        if (!record || record.state !== input.state) throw unauthorized();
        const account = await validate(record);
        if (sessions.size >= 1024) throw Object.assign(new Error("Too many linked sessions."), { status: 503 });
        if (validSecret(input.previous)) sessions.delete(hash(input.previous));
        const token = secret();
        record.expires = Math.min(account.expires, now() + 12 * 60 * 60 * 1000);
        sessions.set(hash(token), record);
        return { token, account: { name: account.name }, expires: record.expires };
      }
      if (action === "logout") {
        if (validSecret(input.token)) sessions.delete(hash(input.token));
        return {};
      }
      const { record, account } = await session(input.token);
      if (action === "session") return { account: { name: account.name }, expires: record.expires };
      if (action === "snapshot") {
        const result = await snapshot(record.accountId);
        await session(input.token); // Do not return data after revocation during DB reads.
        return result;
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
    try {
      if (req.method !== "POST" || !/^\/(exchange|session|snapshot|dismiss|read|logout)$/.test(req.url)) {
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
      const output = JSON.stringify(await bridge.handle(req.url.slice(1), input));
      if (Buffer.byteLength(output) > 220000) throw new Error("Projection too large");
      res.end(output);
    } catch (error) {
      const status = error.status || (Number.isInteger(error.error) ? error.error : 500);
      res.statusCode = status >= 400 && status < 600 ? status : 500;
      res.end(JSON.stringify({ error: res.statusCode === 500 ? "Bridge operation failed." : error.reason || error.message }));
    }
  };
}
