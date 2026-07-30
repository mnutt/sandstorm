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

import Capnp from "/imports/server/capnp";
import { PersistentImpl } from "/imports/server/persistent";
import { ssrfSafeLookupOrProxy } from "/imports/server/networking";

const OutboundHttpSession =
    Capnp.importSystem("sandstorm/outbound-http-session.capnp").OutboundHttpSession;
const PersistentOutboundHttpSession =
    Capnp.importSystem("sandstorm/outbound-http-session-impl.capnp").PersistentOutboundHttpSession;

const METHOD_NAMES = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
];

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

const OUTBOUND_HTTP_REQUEST_TIMEOUT_MS = 120 * 1000;
const ENCODED_PATH_SEPARATOR = /%(2f|5c)/i;
const INVALID_PERCENT_ENCODING = /%(?![0-9a-fA-F]{2})/;

function makeTimeoutError() {
  const err = new Error("Outbound HTTP request timed out.");
  err.kjType = "overloaded";
  return err;
}

function makeTransportError(err) {
  if (err && err.kjType) return err;

  const message = err && err.message ? err.message : String(err);
  const result = new Error("Outbound HTTP request failed: " + message);
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

function validateBaseUrl(url) {
  check(url, String);

  if (url.includes("\\")) {
    throw new Meteor.Error(400, "URL path must not contain encoded slashes.");
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
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

function methodName(method) {
  if (typeof method === "number") {
    if (!METHOD_NAMES[method]) throw new Meteor.Error(400, "Unsupported HTTP method.");
    return METHOD_NAMES[method];
  }

  if (typeof method === "string") {
    const normalized = method.toUpperCase();
    if (METHOD_NAMES.indexOf(normalized) === -1) {
      throw new Meteor.Error(400, "Unsupported HTTP method.");
    }

    return normalized;
  }

  if (method && typeof method === "object") {
    const key = Object.keys(method)[0];
    if (key) return methodName(key);
  }

  throw new Meteor.Error(400, "Unsupported HTTP method.");
}

function schemaMethodName(method) {
  return methodName(method).toLowerCase();
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

function sanitizeHeaders(headers) {
  check(headers, Match.Optional([{
    name: String,
    value: String,
  }]));

  const result = {};
  const seen = new Set();

  (headers || []).forEach((header) => {
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(header.name)) {
      throw new Meteor.Error(400, "Invalid HTTP header name: " + header.name);
    }

    if (/[\r\n]/.test(header.value)) {
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
    result[header.name] = header.value;
  });

  return result;
}

function responseHeaders(resp) {
  const headers = [];

  Object.keys(resp.headers).forEach((name) => {
    const value = resp.headers[name];
    if (Array.isArray(value)) {
      value.forEach((item) => headers.push({ name, value: item }));
    } else if (value !== undefined) {
      headers.push({ name, value: String(value) });
    }
  });

  return headers;
}

function writeResponseBody(resp, responseStream) {
  let chain = Promise.resolve();

  return new Promise((resolve, reject) => {
    resp.on("data", (chunk) => {
      resp.pause();
      chain = chain.then(() => responseStream.write(chunk))
          .then(() => resp.resume(), (err) => reject(makeTransportError(err)));
    });

    resp.on("end", () => {
      chain.then(() => responseStream.done())
          .then(resolve, (err) => reject(makeTransportError(err)));
    });

    resp.on("error", (err) => reject(makeTransportError(err)));
  });
}

class OutboundRequestStream {
  constructor(req, responsePromise) {
    this._req = req;
    this._responsePromise = responsePromise;
    this._done = false;
  }

  write(data) {
    if (this._done) throw new Error("write() called after done()");

    return new Promise((resolve, reject) => {
      this._req.write(Buffer.from(data), (err) => {
        if (err) reject(makeTransportError(err));
        else resolve();
      });
    });
  }

  done() {
    if (this._done) throw new Error("done() called twice");
    this._done = true;

    return new Promise((resolve, reject) => {
      this._req.end((err) => {
        if (err) reject(makeTransportError(err));
        else resolve();
      });
    });
  }

  getResponse() {
    return this._responsePromise;
  }
}

class OutboundHttpSessionImpl extends PersistentImpl {
  constructor(baseUrl, methods, db, saveTemplate) {
    super(db, saveTemplate);

    this._baseUrl = validateBaseUrl(baseUrl);
    this._methods = methods && methods.length > 0 ? methods.map(methodName) : null;
    this._db = db;
  }

  _buildUrl(path) {
    check(path, String);

    if (path.startsWith("/") || path.startsWith("//") ||
        /^[A-Za-z][A-Za-z0-9+\-.]*:/.test(path)) {
      throw new Meteor.Error(400, "Request path must be relative to the granted base URL.");
    }

    const pathOnly = path.split(/[?#]/, 1)[0];
    validatePathScope(pathOnly, "Request path");

    if (path === "") return this._baseUrl;

    const base = new URL(this._baseUrl);
    const basePath = base.pathname || "/";
    const basePrefix = basePath.endsWith("/") ? basePath : basePath + "/";

    const requestBase = new URL(this._baseUrl);
    requestBase.pathname = basePrefix;

    const resolved = new URL(path || "", requestBase.toString());
    const expectedOrigin = base.origin;

    if (resolved.origin !== expectedOrigin ||
        !(resolved.pathname === basePath || resolved.pathname.startsWith(basePrefix))) {
      throw new Meteor.Error(403, "Request path escapes the granted base URL.");
    }

    return resolved.toString();
  }

  _startRequest(method, path, headers, responseStream, contentLength) {
    const fullUrl = this._buildUrl(path);
    const httpMethod = methodName(method);
    if (this._methods && this._methods.indexOf(httpMethod) === -1) {
      throw new Meteor.Error(403, "HTTP method is not allowed by this capability.");
    }

    const requestHeaders = sanitizeHeaders(headers);
    if (contentLength !== undefined && contentLength > 0) {
      requestHeaders["content-length"] = String(contentLength);
    }

    return new Promise((resolve, reject) => {
      let req;
      let timeoutHandle;
      let timedOut = false;
      let timeoutError;

      const clearRequestTimeout = () => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = undefined;
        }
      };

      timeoutHandle = setTimeout(() => {
        timedOut = true;
        timeoutError = makeTimeoutError();
        if (req) req.destroy(timeoutError);
        reject(timeoutError);
      }, OUTBOUND_HTTP_REQUEST_TIMEOUT_MS);

      ssrfSafeLookupOrProxy(this._db, fullUrl).then((safe) => {
        if (timedOut) return;

        try {
          const parsed = new URL(safe.proxy ? fullUrl : safe.url);
          requestHeaders.host = safe.proxy ? parsed.host : safe.host;

          const options = safe.proxy ? {
            method: httpMethod,
            url: fullUrl,
            proxy: safe.proxy,
            followRedirect: false,
            headers: requestHeaders,
          } : {
            method: httpMethod,
            protocol: parsed.protocol,
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname + parsed.search,
            headers: requestHeaders,
            servername: safe.host.split(":")[0],
          };

          const requestMethod = safe.proxy ? Request :
              parsed.protocol === "https:" ? Https.request : Http.request;

          const responsePromise = new Promise((resolveResponse, rejectResponse) => {
            const handleResponse = (resp) => {
              let response;
              try {
                response = {
                  statusCode: resp.statusCode,
                  statusText: resp.statusMessage || "",
                  headers: responseHeaders(resp),
                };
              } catch (err) {
                clearRequestTimeout();
                const transportError = makeTransportError(err);
                rejectResponse(transportError);
                req.destroy(transportError);
                return;
              }

              resolveResponse(response);
              writeResponseBody(resp, responseStream).then(clearRequestTimeout, (err) => {
                clearRequestTimeout();
                console.error("OutboundHttpSession response stream failed:", err.stack || err);
                req.destroy(err);
              });
            };

            req = safe.proxy ? requestMethod(options) : requestMethod(options, handleResponse);
            if (safe.proxy) req.on("response", handleResponse);

            req.on("error", (err) => {
              clearRequestTimeout();
              rejectResponse(makeTransportError(err));
            });
          });

          resolve({ req, responsePromise });
        } catch (err) {
          const transportError = makeTransportError(err);
          if (req) req.destroy(transportError);
          else {
            clearRequestTimeout();
          }
          reject(transportError);
        }
      }, (err) => {
        clearRequestTimeout();
        reject(makeTransportError(err));
      });
    });
  }

  request(method, path, headers, body, responseStream) {
    const bodyBuffer = body ? Buffer.from(body) : Buffer.alloc(0);

    return this._startRequest(
        method, path, headers, responseStream, bodyBuffer.length).then(({ req, responsePromise }) => {
      try {
        if (bodyBuffer.length > 0) {
          req.write(bodyBuffer, (err) => {
            if (err) req.destroy(makeTransportError(err));
          });
        }

        req.end((err) => {
          if (err) req.destroy(makeTransportError(err));
        });
      } catch (err) {
        const transportError = makeTransportError(err);
        req.destroy(transportError);
      }

      return responsePromise;
    });
  }

  requestStreaming(method, path, headers, responseStream) {
    return this._startRequest(method, path, headers, responseStream).then(({ req, responsePromise }) => {
      return {
        requestStream: new Capnp.Capability(
            new OutboundRequestStream(req, responsePromise),
            OutboundHttpSession.RequestStream),
      };
    });
  }
}

function newOutboundHttpSession(baseUrl, methods, db, saveTemplate) {
  return new Capnp.Capability(
      new OutboundHttpSessionImpl(baseUrl, methods, db, saveTemplate),
      PersistentOutboundHttpSession);
}

function registerOutboundHttpFrontendRef(registry) {
  registry.register({
    frontendRefField: "outboundHttp",
    typeId: OutboundHttpSession.typeId,

    restore(db, saveTemplate, value) {
      return newOutboundHttpSession(value.baseUrl, value.methods, db, saveTemplate);
    },

    validate(db, session, request) {
      check(request, {
        baseUrl: String,
        methods: Match.Optional([Match.OneOf(String, Number, Object)]),
      });

      const baseUrl = validateBaseUrl(request.baseUrl);
      const methods = request.methods ? request.methods.map(methodName) : undefined;
      const tagValue = { baseUrl };
      if (methods && methods.length > 0) tagValue.methods = methods.map(schemaMethodName);

      const descriptor = {
        tags: [{
          id: OutboundHttpSession.typeId,
          value: Capnp.serialize(OutboundHttpSession.PowerboxTag, tagValue),
        }],
      };

      const frontendRef = { baseUrl };
      if (methods && methods.length > 0) frontendRef.methods = methods;

      return { descriptor, requirements: [], frontendRef };
    },

    query(db, userAccountId, tagValue) {
      const tag = tagValue ? Capnp.parse(OutboundHttpSession.PowerboxTag, tagValue) : {};
      const methods = tag.methods ? tag.methods.map(methodName) : undefined;
      const options = [];

      if (tag.baseUrl) {
        try {
          const baseUrl = validateBaseUrl(tag.baseUrl);
          const outboundHttp = { baseUrl };
          if (methods && methods.length > 0) outboundHttp.methods = methods;

          options.push({
            _id: "outbound-http-url-" + baseUrl,
            frontendRef: { outboundHttp },
            cardTemplate: "outboundHttpUrlPowerboxCard",
          });
        } catch (err) {
          // Ignore invalid suggested URLs. The arbitrary URL option below still lets the user
          // choose a valid endpoint.
        }
      }

      options.push({
        _id: "outbound-http-arbitrary",
        outboundHttpArbitrary: true,
        methods,
        cardTemplate: "outboundHttpArbitraryPowerboxCard",
        configureTemplate: "outboundHttpArbitraryPowerboxConfiguration",
      });

      return options;
    },
  });
}

Meteor.startup(() => {
  registerOutboundHttpFrontendRef(globalThis.globalFrontendRefRegistry);
});
