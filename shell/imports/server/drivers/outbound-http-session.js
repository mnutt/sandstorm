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
import { validateBaseUrl, makeTransportError, makeHttpLimitError, reserveHttpBuffer,
  HTTP_MAX_BUFFERED_UPLOAD_BYTES, HTTP_MAX_UPLOAD_CHUNK_BYTES } from "/imports/server/http-transport";

const OutboundHttpSession =
    Capnp.importSystem("sandstorm/outbound-http-session.capnp").OutboundHttpSession;
const PersistentOutboundHttpSession =
    Capnp.importSystem("sandstorm/outbound-http-session-impl.capnp").PersistentOutboundHttpSession;

import { OutboundHttpSessionBase, methodName, schemaMethodName } from "/imports/server/outbound-http-session-base";
import { signS3Request, s3PayloadHash } from "/imports/server/s3-sigv4";
import { validateHttpAuthenticationMethods, validateHttpConnection } from "/imports/shared/outbound-http-profile";

class OutboundRequestStream {
  constructor(req, responsePromise, cancel) {
    this._req = req;
    this._responsePromise = responsePromise;
    this._done = false;
    this._cancel = cancel;
    this._written = 0;
    this._expected = undefined;
  }

  expectSize(size) {
    if (this._done) throw new Error("expectSize() called after done()");
    const remaining = Number(size);
    const total = this._written + remaining;
    if (!Number.isSafeInteger(remaining) || remaining < 0 || !Number.isSafeInteger(total) ||
        (this._expected !== undefined && this._expected !== total)) {
      this._cancel();
      throw new Error("Invalid or inconsistent upload size.");
    }
    this._expected = total;
    this._req.setExpectedSize(total);
  }

  close() {
    if (!this._done) this._cancel();
  }

  write(data) {
    if (this._done) throw new Error("write() called after done()");
    if (data.byteLength > HTTP_MAX_UPLOAD_CHUNK_BYTES) {
      this._cancel();
      throw makeHttpLimitError("Upload write is too large; send smaller chunks.");
    }
    if (this._expected !== undefined && this._written + data.length > this._expected) {
      this._cancel();
      throw new Error("Upload exceeds expected size.");
    }
    this._written += data.length;

    return new Promise((resolve, reject) => {
      this._req.write(data, (err) => {
        if (err) reject(makeTransportError(err));
        else resolve();
      });
    });
  }

  done() {
    if (this._done) throw new Error("done() called twice");
    this._done = true;
    if (this._expected !== undefined && this._written !== this._expected) {
      this._cancel();
      throw new Error("Upload does not match expected size.");
    }

    return new Promise((resolve, reject) => {
      this._req.end((err) => {
        if (err) reject(makeTransportError(err));
        else this._req.uploadComplete.then(resolve, reject);
      });
    });
  }

  getResponse() {
    return this._responsePromise;
  }
}

class OutboundHttpSessionImpl extends OutboundHttpSessionBase {
  constructor(baseUrl, methods, db, saveTemplate, auth) {
    super(baseUrl, methods, db, saveTemplate);
    if (auth) {
      if (!Object.keys(auth).every(kind =>
        ["none", "caller", "bearer", "basic", "apiKey", "authorization", "queryKey", "sigV4"].includes(kind))) {
        throw new Error("Unsupported outbound HTTP authentication.");
      }
      validateHttpConnection({ url: baseUrl, auth });
    }
    this._auth = auth;
  }

  _protectsAuthorization() {
    return !!this._auth && !("caller" in this._auth);
  }

  _managedRequestHeaders() {
    const key = this._auth?.apiKey;
    return key ? { [key.headerName]: key.value } : {};
  }

  _ensureAuthorization() {
    const auth = this._auth;
    if (auth?.bearer) return "Bearer " + auth.bearer;
    if (auth?.basic) {
      return "Basic " + Buffer.from(auth.basic.username + ":" + auth.basic.password).toString("base64");
    }
    if (auth?.authorization) {
      return (auth.authorization.scheme ? auth.authorization.scheme + " " : "") + auth.authorization.value;
    }
    return undefined;
  }

  _validateRequestAuthentication(url, headers, body) {
    const query = new URL(url).searchParams;
    if (this._auth?.queryKey && Array.from(query.keys()).some(name =>
      name.toLowerCase() === this._auth.queryKey.parameterName.toLowerCase())) {
      throw new Error("Cannot override a managed credential query parameter.");
    }
    if (this._auth?.sigV4) {
      if (body === undefined && !this._auth.sigV4.allowUnsignedPayload) {
        throw new Error("S3 streaming requires explicit unsigned-payload permission.");
      }
      if (["authorization", "x-amz-date", "x-amz-content-sha256", "x-amz-security-token",
        "x-amz-decoded-content-length", "x-amz-trailer"].some(name => name in headers) ||
          /aws-chunked/i.test(headers["content-encoding"] || "") ||
          Array.from(query.keys()).some(name => /^x-amz-/i.test(name))) {
        throw new Error("Cannot override managed S3 signing fields.");
      }
    }
  }

  _prepareAuthenticatedRequest(request, body) {
    if (this._auth?.queryKey) {
      const url = new URL(request.url);
      const { parameterName, value } = this._auth.queryKey;
      // Append without reserializing the caller's existing query parameters.
      url.search += (url.search ? "&" : "?") + encodeURIComponent(parameterName) + "=" + encodeURIComponent(value);
      return { ...request, url: url.toString() };
    }
    if (this._auth?.sigV4) {
      if (body === undefined && !("content-length" in request.headers)) {
        throw new Error("S3 streaming requires expectSize before the first write.");
      }
      const payloadHash = body === undefined ? "UNSIGNED-PAYLOAD" : body;
      return { ...request, headers: signS3Request({ ...request, payloadHash, credentials: this._auth.sigV4 }) };
    }
    return request;
  }

  request(method, path, headers, body, responseStream) {
    const size = body?.byteLength || 0;
    if (size > HTTP_MAX_BUFFERED_UPLOAD_BYTES) {
      throw makeHttpLimitError("Buffered upload is too large; use requestStreaming().");
    }
    const releaseBuffer = reserveHttpBuffer(size);
    try {
      // The RPC adapter supplies a Buffer. Keep it without making an additional copy.
      let bytes = body || Buffer.alloc(0);
      const payloadHash = this._auth?.sigV4 ? s3PayloadHash(bytes) : null;
      return this._startRequest(method, path, headers, responseStream, size, payloadHash)
          .then(({ req, responsePromise }) => {
        const upload = async () => {
          try {
            for (let offset = 0; offset < size; offset += HTTP_MAX_UPLOAD_CHUNK_BYTES) {
              await new Promise((resolve, reject) => {
                req.write(bytes.subarray(offset, offset + HTTP_MAX_UPLOAD_CHUNK_BYTES), error => {
                  if (error) reject(error);
                  else resolve();
                });
              });
            }
            req.end(error => { if (error) req.destroy(makeTransportError(error)); });
            await req.uploadComplete;
          } catch (error) {
            req.destroy(makeTransportError(error));
          } finally {
            bytes = undefined;
            releaseBuffer();
          }
        };
        // Response headers must remain observable while this upload is still in progress.
        upload();
        return responsePromise;
      }, error => { releaseBuffer(); throw error; });
    } catch (error) {
      releaseBuffer();
      throw error;
    }
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

function newOutboundHttpSession(baseUrl, methods, db, saveTemplate, auth) {
  return new Capnp.Capability(
      new OutboundHttpSessionImpl(baseUrl, methods, db, saveTemplate, auth),
      PersistentOutboundHttpSession);
}

function registerOutboundHttpFrontendRef(registry) {
  registry.register({
    frontendRefField: "outboundHttp",
    typeId: OutboundHttpSession.typeId,

    restore(db, saveTemplate, value) {
      return newOutboundHttpSession(value.baseUrl, value.methods, db, saveTemplate, value.auth);
    },

    validate(db, session, request) {
      check(request, {
        baseUrl: String,
        methods: Match.Optional([Match.OneOf(String, Number, Object)]),
        authenticationMethods: Match.Optional([{ kind: String, headerName: Match.Optional(String), scheme: Match.Optional(String),
          parameterName: Match.Optional(String), region: Match.Optional(String), allowUnsignedPayload: Match.Optional(Boolean) }]),
        auth: Match.Optional(Match.OneOf(
            { none: null }, { caller: null }, { bearer: String },
            { basic: { username: String, password: String } },
            { apiKey: { headerName: String, value: String } },
            { queryKey: { parameterName: String, value: String } },
            { sigV4: { region: String, accessKeyId: String, secretAccessKey: String,
              sessionToken: Match.Optional(String), allowUnsignedPayload: Match.Optional(Boolean) } },
            { authorization: { scheme: String, value: String } })),
      });

      const baseUrl = validateBaseUrl(request.baseUrl);
      const methods = request.methods ? request.methods.map(methodName) : undefined;
      const authenticationMethods = validateHttpAuthenticationMethods(request.authenticationMethods, true);
      if (authenticationMethods.length || request.auth) {
        validateHttpConnection({ url: baseUrl, auth: request.auth, authenticationMethods });
      }
      const tagValue = { baseUrl };
      if (authenticationMethods.length) tagValue.authenticationMethods = authenticationMethods;
      if (methods && methods.length > 0) tagValue.methods = methods.map(schemaMethodName);

      const descriptor = {
        tags: [{
          id: OutboundHttpSession.typeId,
          value: Capnp.serialize(OutboundHttpSession.PowerboxTag, tagValue),
        }],
      };

      const frontendRef = { baseUrl };
      if (request.auth) frontendRef.auth = request.auth;
      if (methods && methods.length > 0) frontendRef.methods = methods;

      return { descriptor, requirements: [], frontendRef };
    },

    query(db, userAccountId, tagValue) {
      const tag = tagValue ? Capnp.parse(OutboundHttpSession.PowerboxTag, tagValue) : {};
      let authenticationMethods;
      let methods;
      try {
        authenticationMethods = validateHttpAuthenticationMethods(tag.authenticationMethods, true);
        methods = tag.methods ? tag.methods.map(methodName) : undefined;
      } catch {
        return [];
      }
      // Distinct authentication alternatives must not merge their method grants. In
      // particular, POST+Bearer OR GET+Basic must not become GET/POST with either credential.
      const authId = authenticationMethods.length ? ":auth:" + encodeURIComponent(JSON.stringify(
        authenticationMethods.map(method => JSON.stringify(method)).sort())) : "";
      const options = [];

      if (tag.baseUrl) {
        try {
          const baseUrl = validateBaseUrl(tag.baseUrl);
          const outboundHttp = { baseUrl };
          if (methods && methods.length > 0) outboundHttp.methods = methods;

          options.push({
            _id: "outbound-http-url-" + baseUrl + authId,
            frontendRef: { outboundHttp },
            cardTemplate: "outboundHttpUrlPowerboxCard",
            ...(authenticationMethods.length ? {
              configureTemplate: "outboundHttpCredentialsConfiguration",
              outboundHttp: true, httpUrl: baseUrl, authenticationMethods, methods,
            } : {}),
          });
        } catch (err) {
          // Ignore invalid suggested URLs. The arbitrary URL option below still lets the user
          // choose a valid endpoint.
        }
      }

      options.push({
        _id: "outbound-http-arbitrary" + authId,
        outboundHttpArbitrary: true,
        methods,
        cardTemplate: "outboundHttpArbitraryPowerboxCard",
        configureTemplate: authenticationMethods.length ? "outboundHttpCredentialsConfiguration" :
            "outboundHttpArbitraryPowerboxConfiguration",
        outboundHttp: true,
        authenticationMethods,
      });

      return options;
    },
  });
}

Meteor.startup(() => {
  registerOutboundHttpFrontendRef(globalThis.globalFrontendRefRegistry);
});
