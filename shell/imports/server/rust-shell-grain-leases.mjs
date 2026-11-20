import { confirmMutation } from "./rust-shell-mutations.mjs";
import { randomBytes } from "node:crypto";

const valid = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const failure = (status, message) => Object.assign(new Error(message), { status });

// UI-session lifetime only. Closing a lease never shuts down the grain.
export function createGrainLeases({ open, keep, close, waitForResponse, template, rename, powerbox, sharing, createShare, updateShare, revokeTemplate, validate, now = Date.now }) {
  const leases = new Map();
  const closePowerbox = async record => {
    const request = record.powerbox;
    if (!request) return;
    request.closed = true;
    record.powerbox = null;
    if (request.handle) await powerbox.close(request.handle);
  };
  const dispose = async (record) => {
    record.closed = true;
    record.ended.abort();
    await closePowerbox(record);
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
          !input.grainId) throw failure(400, "Invalid grain request.");
      if (leases.has(input.scope)) throw failure(409, "Close the current grain first.");
      const record = { token, scope: input.scope, lease: randomBytes(32).toString("hex"),
        expires: now() + 45000, handle: null, closed: false, rendering: false, ended: new AbortController() };
      leases.set(input.scope, record);
      try {
        const result = await open(accountId, input.grainId);
        record.handle = result.handle;
        await validate(token);
        if (record.closed || signal.aborted || now() >= record.expires) throw failure(410, "Grain opening was canceled.");
        return { ...result.view, lease: record.lease };
      } catch (error) { await dispose(record); throw error; }
    },
    async waitForResponse(token, input, signal) {
      const record = get(token, input.scope, input.lease);
      if (!record?.handle || record.closed || record.expires <= now()) throw failure(410, 'Grain session expired.');
      await validate(token);
      const result = await waitForResponse(record.handle, AbortSignal.any([signal, record.ended.signal]));
      await validate(token);
      if (record.closed || record.expires <= now()) throw failure(410, 'Grain session expired.');
      return result;
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
        if (record.powerbox?.expires <= now()) await closePowerbox(record);
        record.expires = now() + 45000;
        return {};
      } catch (error) { await dispose(record); throw error; }
    },
    async rename(token, input, signal) {
      const record = get(token, input.scope, input.lease);
      if (!rename || !record?.handle || record.closed || record.expires <= now()) throw failure(410, "Grain session expired.");
      if (typeof input.title !== "string" || !input.title.trim()) throw failure(400, "Invalid grain title.");
      if (record.renaming) throw failure(409, "A rename is already in progress.");
      record.renaming = true;
      const handle = record.handle;
      const beforeWrite = async () => {
        await validate(token);
        await keep(handle);
        if (record.closed || signal.aborted || record.expires <= now()) throw failure(410, "Grain session closed.");
      };
      try {
        await beforeWrite();
        const result = await rename(handle, input.title.trim(), beforeWrite);
        await confirmMutation(beforeWrite);
        return result;
      } finally { record.renaming = false; }
    },
    async powerbox(token, input, signal) {
      const record = get(token, input.scope, input.lease);
      if (!powerbox || !valid(input.lease) || !valid(input.request) || !record?.handle || record.closed || record.expires <= now()) throw failure(410, "Grain session expired.");
      if (!["begin", "select", "poll", "cancel"].includes(input.operation)) throw failure(400, "Invalid Powerbox operation.");
      if (input.operation === "cancel") {
        if (record.powerbox?.id === input.request) await closePowerbox(record);
        return {};
      }
      let request = record.powerbox;
      if (input.operation === "begin") {
        if (request) throw failure(409, "A Powerbox request is already open.");
        request = {id:input.request,expires:now()+300000,closed:false,handle:null,busy:false,complete:false};
        record.powerbox = request;
      }
      if (!request || request.id !== input.request || request.closed || request.complete) throw failure(410, "Powerbox request ended.");
      if (request.busy) throw failure(409, "A Powerbox operation is already pending.");
      request.busy = true;
      const handle = record.handle;
      const checkLive = async () => {
        await validate(token);
        await keep(handle);
        if (record.closed || request.closed || signal.aborted || record.expires <= now() || request.expires <= now()) throw failure(410, "Powerbox request ended.");
      };
      try {
        await checkLive();
        let result;
        if (input.operation === "begin") {
          const opened = await powerbox.open(handle, input, checkLive);
          request.handle = opened.handle;
          result = opened.view;
        } else result = await powerbox[input.operation](request.handle, input, checkLive);
        await checkLive();
        if (result.status === "complete") {
          request.complete = true;
          request.handle.delivered = true;
        }
        return result;
      } catch (error) {
        request.closed = true;
        if (record.powerbox === request) record.powerbox = null;
        if (request.handle) await powerbox.close(request.handle);
        throw error;
      } finally { request.busy = false; }
    },
    async sharing(token, input, signal, operation) {
      const record = get(token, input.scope, input.lease);
      if (!valid(input.lease) || !record?.handle || record.closed || record.expires <= now()) throw failure(410, "Grain session expired.");
      const callback = { getSharing: sharing, createShare, updateShare }[operation];
      if (!callback) throw failure(503, "Sharing is unavailable.");
      if (record.sharing) throw failure(409, "A sharing operation is already pending.");
      record.sharing = true;
      const handle = record.handle;
      const beforeWrite = async () => {
        await validate(token);
        await keep(handle);
        if (record.closed || signal.aborted || record.expires <= now()) throw failure(410, "Grain session closed.");
      };
      let result;
      try {
        await beforeWrite();
        result = await callback(handle, input, beforeWrite);
        if (operation === "updateShare") await confirmMutation(beforeWrite);
        else await beforeWrite();
        return operation === "createShare" ? { token: result.token } : result;
      } catch (error) {
        // A canceled issuance must not leave an undisclosed working bearer token.
        if (operation === "createShare" && result) await revokeTemplate(result);
        throw error;
      } finally { record.sharing = false; }
    },
    async template(token, input, signal) {
      const record = get(token, input.scope, input.lease);
      if (!template || !record?.handle || record.closed || signal.aborted || record.expires <= now()) throw failure(410, "Grain session expired.");
      if (record.rendering) throw failure(409, "A template request is already pending.");
      record.rendering = true;
      let result;
      try {
        await validate(token);
        await keep(record.handle);
        result = await template(record.handle, input.options);
        if (record.closed || signal.aborted) throw failure(410, "Grain session closed.");
        await keep(record.handle);
        await validate(token);
        if (record.closed || signal.aborted || record.expires <= now()) throw failure(410, "Grain session closed.");
        return { token: result.token, host: result.host };
      } catch (error) {
        if (result) await revokeTemplate(result);
        throw error;
      } finally { record.rendering = false; }
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
