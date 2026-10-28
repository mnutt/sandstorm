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
import Http from "http";
import Https from "https";
import Request from "request";
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
  streamTimeoutMs = OUTBOUND_HTTP_STREAM_TIMEOUT_MS,
  streamIdleTimeoutMs = OUTBOUND_HTTP_STREAM_IDLE_TIMEOUT_MS }) {
  let req;
  let resp;
  let finished = false;
  let idleTimer;
  let streaming = false;
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
    clearTimeout(timer);
    clearTimeout(idleTimer);
    const error = makeTransportError(err);
    rejectStarted(error);
    rejectResponse(error);
    rejectCompletion(error);
    if (resp) resp.destroy();
    if (req) req.destroy();
    onFailure(error);
  };
  let timer = setTimeout(() => fail(makeTimeoutError()), timeoutMs);
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
    const parsed = new URL(safe.proxy ? url : safe.url);
    requestHeaders.host = safe.proxy ? original.host : safe.host;
    const options = safe.proxy ? {
      method, url, proxy: safe.proxy, headers: requestHeaders,
      followRedirect: false, followAllRedirects: false,
    } : {
      method, protocol: parsed.protocol,
      hostname: parsed.hostname.replace(/^\[|\]$/g, ""), port: parsed.port,
      path: parsed.pathname + parsed.search, headers: requestHeaders,
      servername: original.hostname.replace(/^\[|\]$/g, ""),
      // Each new connection must use the address which just passed policy checks.
      agent: false,
    };
    const onResponse = incoming => {
      if (finished) { incoming.destroy(); return; }
      resp = incoming;
      resp.on("error", fail);
      resp.on("aborted", () => fail(new Error("Response aborted.")));
      resp.on("close", () => {
        if (!resp.complete) fail(new Error("Incomplete HTTP response."));
      });
      // Attach the consumer synchronously: request's proxy adapter starts flowing immediately
      // after emitting "response", so deferring attachment can lose the first body chunks.
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
        clearTimeout(timer);
        clearTimeout(idleTimer);
        resolveCompletion(result);
      }, fail);
    };

    if (safe.proxy) {
      req = Request(options);
      req.on("response", onResponse);
    } else {
      req = (parsed.protocol === "https:" ? Https : Http).request(options, onResponse);
    }

    req.on("error", fail);
    req.on("close", () => {
      if (!resp) fail(new Error("Request closed without a response."));
    });
    resolveStarted(req);
  }).catch(fail);

  return { started, response, completion, cancel: () => fail(new Error("Request canceled.")) };
}

export async function readHttpBody(response) {
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
  return Buffer.concat(chunks);
}
