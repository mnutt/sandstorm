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


import Capnp from "/imports/server/capnp";
import { PersistentImpl } from "/imports/server/persistent";
import {
  validateBaseUrl, buildHttpUrl, sanitizeHeaders, makeTransportError, startHttpRequest,
} from "/imports/server/http-transport";

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

async function writeResponseBody(resp, responseStream) {
  for await (const chunk of resp) await responseStream.write(chunk);
  await responseStream.done();
}

class OutboundRequestStream {
  constructor(req, responsePromise, cancel) {
    this._req = req;
    this._responsePromise = responsePromise;
    this._done = false;
    this._cancel = cancel;
  }

  close() {
    if (!this._done) this._cancel();
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
    this._requests = new Set();
    this._closed = false;
  }

  close() {
    this._closed = true;
    this._requests.forEach(request => request.cancel());
    this._requests.clear();
  }

  _startRequest(method, path, headers, responseStream, contentLength) {
    if (this._closed) throw new Error("HTTP session is closed.");
    const fullUrl = buildHttpUrl(this._baseUrl, path);
    const httpMethod = methodName(method);
    if (this._methods && this._methods.indexOf(httpMethod) === -1) {
      throw new Meteor.Error(403, "HTTP method is not allowed by this capability.");
    }

    const requestHeaders = sanitizeHeaders(headers);
    if (contentLength !== undefined && contentLength > 0) {
      requestHeaders["content-length"] = String(contentLength);
    }

    const operation = startHttpRequest({
      db: this._db, url: fullUrl, method: httpMethod, headers: requestHeaders,
      consumeResponse: resp => writeResponseBody(resp, responseStream),
    });
    this._requests.add(operation);
    const release = () => {
      this._requests.delete(operation);
      // Dropping without done() communicates an incomplete transfer to the receiver.
      if (responseStream.close) responseStream.close();
    };
    operation.completion.then(release, release);
    const responsePromise = operation.response.then(resp => ({
      statusCode: resp.statusCode,
      statusText: resp.statusMessage || "",
      headers: responseHeaders(resp),
    }));
    responsePromise.catch(() => {});
    return operation.started.then(req => ({ req, responsePromise, cancel: operation.cancel }));
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
    return this._startRequest(method, path, headers, responseStream).then(({ req, responsePromise, cancel }) => {
      return {
        requestStream: new Capnp.Capability(
            new OutboundRequestStream(req, responsePromise, cancel),
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
