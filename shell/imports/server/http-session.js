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


import { PersistentImpl } from "/imports/server/persistent";
import {
  validateBaseUrl, buildHttpUrl, sanitizeHeaders, startHttpRequest,
} from "/imports/server/http-transport";

const METHOD_NAMES = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
];

const MAX_ACTIVE_SESSION_REQUESTS = 16;
const MAX_ACTIVE_GRANT_REQUESTS = 16;
const grantRequests = new Map();

function reserveGrantRequest(root) {
  if (!root) return () => {}; // Unsaved capabilities still have the session/process limits.
  const count = grantRequests.get(root) || 0;
  if (count >= MAX_ACTIVE_GRANT_REQUESTS) {
    const error = new Error("Too many active HTTP requests for this grant.");
    error.kjType = "overloaded";
    throw error;
  }
  grantRequests.set(root, count + 1);
  return () => {
    const remaining = grantRequests.get(root) - 1;
    if (remaining) grantRequests.set(root, remaining);
    else grantRequests.delete(root);
  };
}

export function methodName(method) {
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

export function schemaMethodName(method) {
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

export class HttpSessionImpl extends PersistentImpl {
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
    clearInterval(this._revocationTimer);
  }

  async _checkAuthorization() {
    if (this._closed) throw new Error("HTTP session is closed.");
    try {
      const root = await this.checkLiveRequirements();
      if (this._closed) throw new Error("HTTP session is closed.");
      return root;
    } catch (err) { this.close(); throw err; }
  }

  async save(params) {
    await this._checkAuthorization();
    return super.save(params);
  }

  _managedRequestHeaders() { return {}; }
  _ensureAuthorization() { return undefined; }
  _protectsAuthorization() { return false; }

  _trackRequest(operation) {
    this._requests.add(operation);
    if (!this._revocationTimer) {
      let checking = false;
      this._revocationTimer = setInterval(async () => {
        if (checking) return;
        checking = true;
        try { await this._checkAuthorization(); } catch { /* closes active requests */ }
        finally { checking = false; }
      }, 1000);
    }
    const finish = () => {
      this._requests.delete(operation);
      if (!this._requests.size) {
        clearInterval(this._revocationTimer);
        this._revocationTimer = null;
      }
    };
    operation.completion.then(finish, finish);
  }

  _startRequest(method, path, headers, responseStream, contentLength) {
    if (this._closed) throw new Error("HTTP session is closed.");
    if (this._requests.size >= MAX_ACTIVE_SESSION_REQUESTS) {
      const error = new Error("Too many active HTTP requests for this session.");
      error.kjType = "overloaded";
      throw error;
    }
    const fullUrl = buildHttpUrl(this._baseUrl, path);
    const httpMethod = methodName(method);
    if (this._methods && this._methods.indexOf(httpMethod) === -1) {
      throw new Meteor.Error(403, "HTTP method is not allowed by this capability.");
    }

    const requestHeaders = sanitizeHeaders(headers);
    const managed = this._managedRequestHeaders();
    Object.keys(requestHeaders).forEach(name => {
      if ((name === "authorization" && this._protectsAuthorization()) ||
          Object.prototype.hasOwnProperty.call(managed, name)) {
        throw new Error("Cannot override a connection-managed header.");
      }
    });
    Object.assign(requestHeaders, managed);
    if (contentLength !== undefined && contentLength > 0) {
      requestHeaders["content-length"] = String(contentLength);
    }

    let pendingWrite;
    let stopped = false;
    let releaseGrant = () => {};
    const release = () => {
      if (stopped) return;
      stopped = true;
      if (pendingWrite?.cancel) pendingWrite.cancel();
      releaseGrant();
      if (responseStream.close) responseStream.close();
    };
    const operation = startHttpRequest({
      db: this._db, url: fullUrl, method: httpMethod, headers: requestHeaders,
      getAuthorization: async () => {
        const root = await this._checkAuthorization();
        // DNS/auth checks can finish after a deadline. Never reserve a slot for
        // an operation whose receiver has already been released.
        if (stopped) throw new Error("HTTP request canceled.");
        releaseGrant = reserveGrantRequest(root);
        return this._ensureAuthorization();
      },
      onFailure: release,
      consumeResponse: async (resp, lifecycle) => {
        resp.pause();
        lifecycle.beginStreaming();
        const write = async (method, ...args) => {
          if (stopped) throw new Error("Response stream canceled.");
          pendingWrite = responseStream[method](...args);
          await pendingWrite;
          pendingWrite = undefined;
          if (stopped) throw new Error("Response stream canceled.");
          lifecycle.progress();
        };
        await write("write", Buffer.alloc(0));
        for await (const chunk of resp) await write("write", chunk);
        await write("done");
      },
    });
    this._trackRequest(operation);
    operation.completion.then(release, release);
    const responsePromise = operation.response.then(resp => ({
      statusCode: resp.statusCode,
      statusText: resp.statusMessage || "",
      headers: responseHeaders(resp),
    }));
    responsePromise.catch(() => {});
    return operation.started.then(req => ({ req, responsePromise, cancel: operation.cancel }));
  }


}


