import { randomBytes } from "node:crypto";

const valid = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const failure = (status, message) => Object.assign(new Error(message), { status });

// UI-session lifetime only. Closing a lease never shuts down the grain.
export function createGrainLeases({ open, keep, close, validate, now = Date.now }) {
  const leases = new Map();
  const dispose = async (record) => {
    record.closed = true;
    if (leases.get(record.scope) === record) leases.delete(record.scope);
    if (record.handle) {
      const handle = record.handle;
      record.handle = null;
      await close(handle);
    }
  };
  const get = (token, scope, lease) => {
    if (!valid(scope)) throw failure(400, "Invalid grain scope.");
    const record = leases.get(scope);
    if (record && (record.token !== token || (lease && record.lease !== lease))) {
      throw failure(403, "This grain session belongs to another scope.");
    }
    return record;
  };
  return {
    async open(token, accountId, input, signal) {
      if (!open || !valid(input.scope) || typeof input.grainId !== "string" ||
          !input.grainId || input.grainId.length > 128) throw failure(400, "Invalid grain request.");
      if (leases.has(input.scope)) throw failure(409, "Close the current grain first.");
      if (leases.size >= 32 || [...leases.values()].filter((r) => r.token === token).length >= 8) {
        throw failure(503, "Too many open grain sessions.");
      }
      const record = { token, scope: input.scope, lease: randomBytes(32).toString("hex"),
        expires: now() + 45000, handle: null, closed: false };
      leases.set(input.scope, record);
      try {
        const result = await open(accountId, input.grainId);
        record.handle = result.handle;
        await validate(token);
        if (record.closed || signal.aborted || now() >= record.expires) throw failure(410, "Grain opening was canceled.");
        return { ...result.view, lease: record.lease };
      } catch (error) { await dispose(record); throw error; }
    },
    async keep(token, input) {
      const record = get(token, input.scope, input.lease);
      if (!record?.handle || record.expires <= now()) {
        if (record) await dispose(record);
        throw failure(410, "Grain session expired.");
      }
      try {
        await validate(token);
        await keep(record.handle);
        if (record.closed) throw failure(410, "Grain session closed.");
        record.expires = now() + 45000;
        return {};
      } catch (error) { await dispose(record); throw error; }
    },
    async close(token, input) {
      const record = get(token, input.scope, input.lease);
      if (record) await dispose(record);
      return {};
    },
    async revoke(token) {
      await Promise.all([...leases.values()].filter((r) => r.token === token).map(dispose));
    },
    async sweep() {
      await Promise.all([...leases.values()].map(async (record) => {
        try {
          if (record.expires <= now()) await dispose(record);
          else await validate(record.token);
        } catch { await dispose(record); }
      }));
    },
  };
}
