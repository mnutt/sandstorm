// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2026 Sandstorm Development Group, Inc. and contributors
// All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { Meteor } from "meteor/meteor";
import { Match, check } from "meteor/check";
import { PassThrough } from "stream";
import { isIP } from "net";
import { Client, ProxyAgent, buildConnector } from "undici";
import { ssrfSafeLookupOrProxy } from "/imports/server/networking";

const BLOCKED_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "keep-alive",
]);

export const OUTBOUND_HTTP_REQUEST_TIMEOUT_MS = 120 * 1000;
export const OUTBOUND_HTTP_STREAM_TIMEOUT_MS = 10 * 60 * 1000;
export const OUTBOUND_HTTP_STREAM_IDLE_TIMEOUT_MS = 60 * 1000;
export const OUTBOUND_HTTP_UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
export const OUTBOUND_HTTP_UPLOAD_IDLE_TIMEOUT_MS = 60 * 1000;
const MAX_ACTIVE_HTTP_REQUESTS = 256;
let activeHttpRequests = 0;
export const HTTP_MAX_BUFFERED_UPLOAD_BYTES = 8 * 1024 * 1024;
export const HTTP_MAX_BUFFERED_RESPONSE_BYTES = 16 * 1024 * 1024;
export const HTTP_MAX_UPLOAD_CHUNK_BYTES = 1024 * 1024;
export const HTTP_MAX_QUEUED_UPLOAD_BYTES = 4 * 1024 * 1024;
export const HTTP_MAX_QUEUED_UPLOAD_WRITES = 64;
export const HTTP_MAX_TRANSFER_BYTES = 8 * 1024 * 1024 * 1024;
const HTTP_MAX_RETAINED_BUFFER_BYTES = 64 * 1024 * 1024;
let retainedBufferBytes = 0;

export function makeHttpLimitError(message) {
  const error = new Error(message);
  error.kjType = "overloaded";
  return error;
}

export function reserveHttpBuffer(size) {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw makeHttpLimitError("Invalid HTTP buffer size.");
  }
  if (size > HTTP_MAX_RETAINED_BUFFER_BYTES - retainedBufferBytes) {
    throw makeHttpLimitError("Outbound HTTP buffer budget exceeded.");
  }
  retainedBufferBytes += size;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    retainedBufferBytes -= size;
  };
}
const ENCODED_PATH_SEPARATOR = /%(2f|5c)/i;
const INVALID_PERCENT_ENCODING = /%(?![0-9a-fA-F]{2})/;

export function makeTimeoutError() {
  const err = new Error("Outbound HTTP request timed out.");
  err.kjType = "overloaded";
  return err;
}

export function makeTransportError(err) {
  if (err && err.kjType) return err;

  // Transport errors may contain a URL or Authorization value. Do not expose them to the app.
  const result = new Error("Outbound HTTP request failed.");
  result.kjType = "disconnected";
  if (err && err.code) result.code = err.code;
  return result;
}

function isDotSegment(segment) {
  const lower = segment.toLowerCase();
  return lower === "." ||
      lower === ".." ||
      lower === "%2e" ||
      lower === ".%2e" ||
      lower === "%2e." ||
      lower === "%2e%2e";
}

function validatePathScope(pathname, description) {
  if (INVALID_PERCENT_ENCODING.test(pathname)) {
    throw new Meteor.Error(400, description + " must not contain malformed percent escapes.");
  }

  if (pathname.includes("\\") || ENCODED_PATH_SEPARATOR.test(pathname)) {
    throw new Meteor.Error(400, description + " must not contain encoded slashes.");
  }

  if (pathname.split("/").some(isDotSegment)) {
    throw new Meteor.Error(400, description + " must not contain dot segments.");
  }
}

function rawPathnameFromHttpUrl(url) {
  const authority = /^https?:\/\/[^/?#]*/i.exec(url);
  if (!authority) return null;

  const pathStart = authority[0].length;
  if (url[pathStart] !== "/") return "/";

  let pathEnd = url.length;
  const queryStart = url.indexOf("?", pathStart);
  const fragmentStart = url.indexOf("#", pathStart);
  if (queryStart !== -1) pathEnd = Math.min(pathEnd, queryStart);
  if (fragmentStart !== -1) pathEnd = Math.min(pathEnd, fragmentStart);

  return url.slice(pathStart, pathEnd) || "/";
}

export function validateBaseUrl(url) {
  check(url, String);

  if (/[\s\\]/.test(url)) {
    throw new Meteor.Error(400, "URL path must not contain encoded slashes.");
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Meteor.Error(400, "Invalid URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Meteor.Error(400, "URL must be HTTP or HTTPS.");
  }

  const rawPathname = rawPathnameFromHttpUrl(url);
  if (!rawPathname) {
    throw new Meteor.Error(400, "URL must be HTTP or HTTPS.");
  }

  validatePathScope(rawPathname, "URL path");

  if (!parsed.hostname) {
    throw new Meteor.Error(400, "URL must include a host.");
  }

  if (parsed.username || parsed.password) {
    throw new Meteor.Error(400, "URL must not include credentials.");
  }

  if (parsed.hash) {
    throw new Meteor.Error(400, "URL must not include a fragment.");
  }

  if (parsed.search) {
    throw new Meteor.Error(400, "URL must not include a query string.");
  }

  return parsed.toString();
}

function headerAllowed(name) {
  const lower = name.toLowerCase();
  return !BLOCKED_HEADERS.has(lower) &&
      !lower.startsWith("proxy-") &&
      !lower.startsWith("sec-") &&
      lower !== "forwarded" &&
      lower !== "via" &&
      !lower.startsWith("x-forwarded-");
}

export function sanitizeHeaders(headers) {
  check(headers, Match.Optional([{
    name: String,
    value: String,
  }]));

  const result = Object.create(null);
  const seen = new Set();

  (headers || []).forEach((header) => {
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(header.name)) {
      throw new Meteor.Error(400, "Invalid HTTP header name: " + header.name);
    }

    if (Array.from(header.value).some(char =>
      (char.charCodeAt(0) < 32 && char !== "\t") || char.charCodeAt(0) === 127 ||
      char.charCodeAt(0) > 255)) {
      throw new Meteor.Error(400, "Invalid HTTP header value for: " + header.name);
    }

    const lower = header.name.toLowerCase();
    if (!headerAllowed(lower)) {
      throw new Meteor.Error(400, "Blocked HTTP header: " + header.name);
    }

    if (seen.has(lower)) {
      throw new Meteor.Error(400, "Duplicate HTTP header: " + header.name);
    }

    seen.add(lower);
    result[lower] = header.value;
  });

  return result;
}


export function buildHttpUrl(baseUrl, path) {
  check(path, String);

  if (path.startsWith("/") || path.startsWith("//") ||
      /^[A-Za-z][A-Za-z0-9+\-.]*:/.test(path)) {
    throw new Meteor.Error(400, "Request path must be relative to the granted base URL.");
  }

  if (/[\s\\#]/.test(path) || INVALID_PERCENT_ENCODING.test(path)) {
    throw new Meteor.Error(400, "Request path contains invalid characters or escapes.");
  }

  const pathOnly = path.split(/[?#]/, 1)[0];
  validatePathScope(pathOnly, "Request path");

  if (path === "") return baseUrl;

  const base = new URL(baseUrl);
  const basePath = base.pathname || "/";
  const basePrefix = basePath.endsWith("/") ? basePath : basePath + "/";

  const requestBase = new URL(baseUrl);
  requestBase.pathname = basePrefix;

  const resolved = new URL(path || "", requestBase.toString());
  const expectedOrigin = base.origin;

  if (resolved.origin !== expectedOrigin ||
      !(resolved.pathname === basePath || resolved.pathname.startsWith(basePrefix))) {
    throw new Meteor.Error(403, "Request path escapes the granted base URL.");
  }

  return resolved.toString();
}

// Owns the lifetime from DNS/proxy resolution through the last response write. Callers supply
// response consumption, so ApiSession and the older streaming interface share
// address pinning, proxy behavior, deadlines, cancellation, and failure cleanup.
export function startHttpRequest({ db, url, method, headers, getAuthorization,
  consumeResponse, onFailure = () => {}, timeoutMs = OUTBOUND_HTTP_REQUEST_TIMEOUT_MS,
  uploadTimeoutMs = OUTBOUND_HTTP_UPLOAD_TIMEOUT_MS,
  uploadIdleTimeoutMs = OUTBOUND_HTTP_UPLOAD_IDLE_TIMEOUT_MS,
  maxUploadBytes = HTTP_MAX_TRANSFER_BYTES,
  maxResponseBytes = HTTP_MAX_TRANSFER_BYTES,
  maxQueuedUploadBytes = HTTP_MAX_QUEUED_UPLOAD_BYTES,
  maxQueuedUploadWrites = HTTP_MAX_QUEUED_UPLOAD_WRITES,
  streamTimeoutMs = OUTBOUND_HTTP_STREAM_TIMEOUT_MS,
  streamIdleTimeoutMs = OUTBOUND_HTTP_STREAM_IDLE_TIMEOUT_MS }) {
  let req;
  let uploadBytes = 0;
  let responseBytes = 0;
  let queuedUploadBytes = 0;
  const pendingWrites = new Set();
  let admitted = activeHttpRequests < MAX_ACTIVE_HTTP_REQUESTS;
  if (admitted) activeHttpRequests++;
  const releaseSlot = () => {
    if (admitted) { admitted = false; activeHttpRequests--; }
  };
  let resp;
  let dispatcher;
  let finished = false;
  let idleTimer;
  let streaming = false;
  let uploadTimer;
  let uploadIdleTimer;
  let uploadSent = false;
  let resolveUpload;
  let rejectUpload;
  const uploadComplete = new Promise((resolve, reject) => {
    resolveUpload = resolve; rejectUpload = reject;
  });
  uploadComplete.catch(() => {});
  const clearUploadTimers = () => {
    clearTimeout(uploadTimer);
    clearTimeout(uploadIdleTimer);
  };
  let resolveStarted;
  let rejectStarted;
  let resolveResponse;
  let rejectResponse;
  let resolveCompletion;
  let rejectCompletion;
  const started = new Promise((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });
  const response = new Promise((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  // Some adapters do not wait for headers separately. All three promises still reject on failure.
  started.catch(() => {});
  response.catch(() => {});
  completion.catch(() => {});

  const fail = err => {
    if (finished) return;
    finished = true;
    releaseSlot();
    clearTimeout(timer);
    clearTimeout(idleTimer);
    clearUploadTimers();
    const error = makeTransportError(err);
    rejectStarted(error);
    rejectResponse(error);
    rejectCompletion(error);
    rejectUpload(error);
    for (const complete of [...pendingWrites]) complete(error);
    if (resp) resp.destroy();
    if (req) req.destroy(error);
    if (dispatcher) dispatcher.destroy().catch(() => {});
    onFailure(error);
  };
  let timer = setTimeout(() => fail(makeTimeoutError()), timeoutMs);
  const uploadProgress = () => {
    if (finished || uploadSent) return;
    clearTimeout(uploadIdleTimer);
    uploadIdleTimer = setTimeout(() => fail(makeTimeoutError()), uploadIdleTimeoutMs);
  };
  const progress = () => {
    if (!streaming || finished) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => fail(makeTimeoutError()), streamIdleTimeoutMs);
  };
  const beginStreaming = () => {
    if (finished) return;
    streaming = true;
    clearTimeout(timer);
    timer = setTimeout(() => fail(makeTimeoutError()), streamTimeoutMs);
    progress();
  };

  if (!admitted) {
    const error = new Error("Too many active outbound HTTP requests.");
    error.kjType = "overloaded";
    fail(error);
    return { started, response, completion, cancel: () => {} };
  }

  Promise.resolve().then(async () => {
    // Resolve and check network policy on every request, never cache the address on a grant.
    const safe = await ssrfSafeLookupOrProxy(db, url);
    if (finished) return;
    const requestHeaders = { ...headers };
    if (getAuthorization) {
      const authorization = await getAuthorization();
      if (finished) return;
      if (authorization) requestHeaders.authorization = authorization;
    }

    const original = new URL(url);
    requestHeaders.host = original.host;
    if (safe.proxy) {
      // As before, the configured proxy owns destination DNS/network policy.
      // HTTP uses absolute-form forwarding; HTTPS uses a CONNECT tunnel.
      dispatcher = new ProxyAgent({ uri: safe.proxy, allowH2: false,
        requestTls: { allowH2: false }, proxyTls: { allowH2: false } });
    } else {
      const pinned = new URL(safe.url);
      const address = pinned.hostname.replace(/^\[|\]$/g, "");
      if (!isIP(address) || pinned.protocol !== original.protocol) {
        throw new Error("Network policy did not return a pinned address.");
      }
      const hostname = original.hostname.replace(/^\[|\]$/g, "");
      const connect = buildConnector({ allowH2: false });
      dispatcher = new Client(original.origin, {
        allowH2: false, pipelining: 0,
        connect(options, callback) {
          // Never let the connector resolve the original hostname again. TLS still
          // authenticates that hostname, not the IP selected by the policy lookup.
          connect({ ...options, hostname: address, port: pinned.port || options.port,
            servername: isIP(hostname) ? undefined : hostname }, callback);
        },
      });
    }

    req = new PassThrough({ highWaterMark: 64 * 1024 });
    req.uploadComplete = uploadComplete;
    req.on("error", error => { if (!resp?.complete) fail(error); });
    req.on("close", () => {
      // Undici closes an unfinished upload when the server's final response is complete.
      // That response remains valid even while our RPC consumer is still reading it.
      if (!req.writableFinished && !resp?.complete) fail(new Error("Upload closed before completion."));
    });
    const onResponse = incoming => {
      if (finished) { incoming.destroy(); return; }
      resp = incoming;
      clearTimeout(timer);
      timer = setTimeout(() => fail(makeTimeoutError()), timeoutMs);
      resp.on("error", fail);
      resp.on("aborted", () => fail(new Error("Response aborted.")));
      resp.on("close", () => {
        if (!resp.complete) fail(new Error("Incomplete HTTP response."));
      });
      // Attach before dispatch delivers any body bytes.
      let consumed;
      try {
        consumed = consumeResponse(resp, { beginStreaming, progress });
      } catch (err) {
        fail(err);
        return;
      }

      resolveResponse(resp);
      Promise.resolve(consumed).then(result => {
        if (finished) return;
        if (!resp.complete) { fail(new Error("Incomplete HTTP response.")); return; }
        finished = true;
        releaseSlot();
        clearTimeout(timer);
        clearTimeout(idleTimer);
        clearUploadTimers();
        // A server may finish its response before consuming the complete upload.
        // Release the per-request socket and stop any remaining upload in that case.
        if (!uploadSent) {
          rejectUpload(makeTransportError(new Error("Server completed before upload.")));
          req.destroy();
        }
        dispatcher.destroy().catch(() => {});
        resolveCompletion(result);
      }, fail);
    };

    // No redirect/retry interceptors. The grant lifecycle below owns deadlines,
    // including time blocked on RPC consumers (not just time waiting on the socket).
    const dispatch = () => dispatcher.dispatch({ origin: original.origin, path: original.pathname + original.search,
      method, headers: requestHeaders, body: req, idempotent: false,
      headersTimeout: 0, bodyTimeout: 0,
    }, {
      onRequestStart(controller) {
        if (finished) { controller.abort(); return; }
        clearTimeout(timer);
        uploadTimer = setTimeout(() => fail(makeTimeoutError()), uploadTimeoutMs);
        uploadProgress();
      },
      onBodySent() { uploadProgress(); },
      onRequestSent() {
        uploadSent = true;
        clearUploadTimers();
        resolveUpload();
        if (!resp && !finished) {
          clearTimeout(timer);
          timer = setTimeout(() => fail(makeTimeoutError()), timeoutMs);
        }
      },
      onResponseStart(controller, statusCode, responseHeaders, statusMessage) {
        if (statusCode < 200) return; // Informational responses are not the final response.
        if (finished) { controller.abort(); return; }
        const incoming = new PassThrough({ highWaterMark: 64 * 1024 });
        Object.assign(incoming, { statusCode, statusMessage, headers: responseHeaders, complete: false });
        onResponse(incoming);
      },
      onResponseData(controller, chunk) {
        if (finished || !resp) { controller.abort(); return; }
        if (chunk.length > maxResponseBytes - responseBytes) {
          fail(makeHttpLimitError("Outbound HTTP response byte limit exceeded."));
          return;
        }
        responseBytes += chunk.length;
        if (!resp.write(chunk)) {
          controller.pause();
          resp.once("drain", () => { if (!finished) controller.resume(); });
        }
      },
      onResponseEnd(controller, trailers) {
        if (finished || !resp) return;
        resp.complete = true;
        clearUploadTimers();
        resp.trailers = trailers;
        resp.end();
      },
      onResponseError(controller, error) { fail(error); },
    });
    // Defer HTTP headers until the first write/end so ByteStream.expectSize() can
    // supply Content-Length. A late size announcement can still be enforced by the
    // RPC stream, but cannot change headers already on the wire.
    let dispatched = false;
    const start = () => {
      if (dispatched || finished) return;
      dispatched = true;
      try { dispatch(); } catch (error) { fail(error); }
    };
    req.setExpectedSize = size => {
      if (size > maxUploadBytes) {
        const error = makeHttpLimitError("Outbound HTTP upload byte limit exceeded.");
        fail(error);
        throw error;
      }
      if (!dispatched) requestHeaders["content-length"] = String(size);
    };
    for (const method of ["write", "end"]) {
      const originalMethod = req[method];
      req[method] = function (...args) {
        const callback = typeof args[args.length - 1] === "function" ? args.pop() : undefined;
        const data = args[0];
        const size = data == null ? 0 : typeof data === "string" ?
            Buffer.byteLength(data, typeof args[1] === "string" ? args[1] : undefined) : data.byteLength;
        let releaseBuffer;
        try {
          if (finished || req.destroyed) throw makeTransportError(new Error("Upload is closed."));
          if (size > maxUploadBytes - uploadBytes) {
            throw makeHttpLimitError("Outbound HTTP upload byte limit exceeded.");
          }
          if (size > maxQueuedUploadBytes - queuedUploadBytes || pendingWrites.size >= maxQueuedUploadWrites) {
            throw makeHttpLimitError("Outbound HTTP upload queue limit exceeded.");
          }
          releaseBuffer = reserveHttpBuffer(size);
        } catch (error) {
          fail(error);
          if (callback) callback(error);
          return method === "write" ? false : req;
        }
        uploadBytes += size;
        queuedUploadBytes += size;
        const complete = error => {
          if (!pendingWrites.delete(complete)) return;
          queuedUploadBytes -= size;
          releaseBuffer();
          if (callback) callback(error);
        };
        pendingWrites.add(complete);
        start();
        if (finished) return method === "write" ? false : req;
        try { return originalMethod.apply(this, [...args, complete]); }
        catch (error) { fail(error); return method === "write" ? false : req; }
      };
    }
    resolveStarted(req);
  }).catch(fail);

  return { started, response, completion, cancel: () => fail(new Error("Request canceled.")) };
}

export async function readHttpBody(response, { maxBytes = HTTP_MAX_BUFFERED_RESPONSE_BYTES } = {}) {
  const chunks = [];
  const reservations = [];
  let bytes = 0;
  try {
    for await (const chunk of response) {
      if (chunk.length > maxBytes - bytes) {
        throw makeHttpLimitError("Buffered HTTP response is too large; use streaming.");
      }
      reservations.push(reserveHttpBuffer(chunk.length));
      bytes += chunk.length;
      chunks.push(chunk);
    }
    // Account for the contiguous result while the source chunks still exist.
    reservations.push(reserveHttpBuffer(bytes));
    return Buffer.concat(chunks, bytes);
  } finally {
    reservations.forEach(release => release());
  }
}
