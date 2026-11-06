// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
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

import { httpCallAsync } from "/imports/server/http-helpers";
import { PersistentImpl } from "/imports/server/persistent";
import { frontendRefRegistry } from "/imports/server/frontend-ref-registry-instance";
import {
  validateBaseUrl, buildHttpUrl, sanitizeHeaders, startHttpRequest, readHttpBody,
} from "/imports/server/http-transport";
import { REQUEST_HEADER_WHITELIST, RESPONSE_HEADER_WHITELIST, API_RESPONSE_HEADER_WHITELIST }
    from "/imports/server/header-whitelist";
import { globalDb } from "/imports/db-deprecated";

import { responseCodes } from "/imports/server/web-session";

import { httpAuthenticationHint, validateHttpConnection } from "/imports/shared/http-api-profile";

import Capnp from "/imports/server/capnp";
const ApiSession = Capnp.importSystem("sandstorm/api-session.capnp").ApiSession;
const PersistentApiSession =
    Capnp.importSystem("sandstorm/api-session-impl.capnp").PersistentApiSession;

function getOAuthServiceInfo(url) {
  // TODO(soon): Define a table somewhere (probably in a .capnp file) mapping API hosts to OAuth
  //   metadata.
  const matchesBase = (base) => {
    return url === base || url.startsWith(base + '/');
  }
  if (matchesBase("https://apidata.googleusercontent.com") ||
      matchesBase("https://www.googleapis.com")) {
    return {
      service: "google",
      endpoint: "https://www.googleapis.com/oauth2/v4/token",
    };
  } else if (matchesBase("https://api.github.com")) {
    return {
      service: "github",
      endpoint: "https://github.com/login/oauth/access_token",
    };
  } else {
    return null;
  }
}

async function refreshOAuth(url, refreshToken) {
  // TODO(perf): Cache access tokens until they expire? Currently we re-do the refresh on every
  //   restore. In particular, this means we always drop the first access token returned (which
  //   is returned together with the refresh token) and then immediately request a new one.

  const serviceInfo = getOAuthServiceInfo(url);
  if (!serviceInfo) {
    throw new Error("Don't know how to OAuth for: " + url);
  }

  const config = await ServiceConfiguration.configurations
      .findOneAsync({ service: serviceInfo.service });
  if (!config) {
    throw new Error("can't refresh OAuth token for service that isn't configured: " +
                    serviceInfo.service);
  }

  const response = await httpCallAsync("POST", serviceInfo.endpoint, {
    ssrfSafeDb: globalDb,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
    },
    content: "client_id=" + encodeURIComponent(config.clientId)
          + "&client_secret=" + encodeURIComponent(config.secret)
          + "&refresh_token=" + encodeURIComponent(refreshToken)
          + "&grant_type=refresh_token",
  });

  return response.data;
}

function newExternalHttpSession(url, auth, db, saveTemplate, connectionHeaders = []) {
  // `url` and `auth` are the corresponding members of `ApiToken.frontendRef.http`.

  const createCap = () => {
    return new Capnp.Capability(new ExternalWebSession(url,
        { headers: Object.fromEntries(connectionHeaders.map(({ name, value }) => [name, value])) },
        auth,
        db, saveTemplate), PersistentApiSession);
  };

  return createCap();
}

function registerHttpApiFrontendRef(registry) {
  registry.register({
    frontendRefField: "http",
    typeId: ApiSession.typeId,

    restore(db, saveTemplate, value) {
      return newExternalHttpSession(value.url, value.auth, db, saveTemplate, value.connectionHeaders);
    },

    validate(db, session, request) {
      check(request, {
        url: String,
        connectionHeaders: Match.Optional([{ name: String, value: String }]),
        auth: Match.OneOf(
            { none: null },
            { bearer: String },
            { basic: { username: String, password: String } },
            { oauth: { credentialToken: String, credentialSecret: String } }),
      });

      try {
        validateHttpConnection(request);
        request.url = validateBaseUrl(request.url);
      } catch (err) {
        throw new Meteor.Error(400, err.message);
      }

      if (request.auth.oauth) {
        // We did an OAuth handshake client-side.
        const oauthResult = OAuth.retrieveCredential(request.auth.oauth.credentialToken,
                                                     request.auth.oauth.credentialSecret);

        if (oauthResult instanceof Error) {
          throw oauthResult;
        }

        const serviceData = oauthResult.serviceData;
        if (serviceData.refreshToken) {
          request.auth = { refresh: serviceData.refreshToken };
        } else {
          request.auth = { bearer: serviceData.accessToken };
        }

        // TODO(security): We could maybe add a MembraneRequirement that this user account
        //   possesses credentials for this OAuth service. Conversely, perhaps if an authCode was
        //   specified, we should automatically add the associated credential to the user's
        //   account? (As a non-login credential.)
      }

      const authentication = request.auth.basic ? "basic" :
          (request.auth.bearer || request.auth.refresh ? "bearer" : "");
      const descriptor = { tags: [{ id: ApiSession.typeId,
        value: Capnp.serialize(ApiSession.PowerboxTag, { authentication }),
      }] };
      return { descriptor, requirements: [], frontendRef: request };
    },

    query(db, userAccountId, tagValue) {
      const tag = tagValue ? Capnp.parse(ApiSession.PowerboxTag, tagValue) : {};

      const options = [];
      const authentication = httpAuthenticationHint(tag.authentication);
      // Unknown hints must never fall back to an anonymous connection.
      if (authentication === null) return options;

      if (tag.canonicalUrl &&
          (tag.canonicalUrl.startsWith("https://") ||
           tag.canonicalUrl.startsWith("http://"))) {
        const serviceInfo = getOAuthServiceInfo(tag.canonicalUrl);
        if (serviceInfo && tag.oauthScopes) {
          // Note: We don't check if the service is configured, because it's useful to show the
          //   user that the option exists but inform them that it will only work if the admin
          //   configures this service.
          options.push({
            _id: "http-oauth-" + tag.canonicalUrl,
            cardTemplate: "httpOAuthPowerboxCard",
            configureTemplate: "httpOAuthPowerboxConfiguration",
            httpUrl: tag.canonicalUrl,
            oauthServiceInfo: serviceInfo,
            oauthScopes: tag.oauthScopes,
          });
        } else {
          options.push({
            _id: "http-url-" + tag.canonicalUrl,
            frontendRef: { http: { url: tag.canonicalUrl, auth: { none: null } } },
            cardTemplate: "httpUrlPowerboxCard",
            ...(authentication !== "none" ? {
              configureTemplate: "httpArbitraryPowerboxConfiguration",
              httpUrl: tag.canonicalUrl,
              authentication,
            } : {}),
          });
        }
      }

      // Always offer the user the option to connect to an arbitrary URL of their choosing, even
      // if canonicalUrl exists.
      options.push({
        _id: "http-arbitrary",
        authentication,
        cardTemplate: "httpArbitraryPowerboxCard",
        configureTemplate: "httpArbitraryPowerboxConfiguration",
      });

      return options;
    },
  });
}

Meteor.startup(() => { registerHttpApiFrontendRef(frontendRefRegistry); });

// =======================================================================================

function composeETag(etag) {
  if (etag.weak) {
    return "W/\"" + etag.value + "\"";
  } else {
    return "\"" + etag.value + "\"";
  }
}

function parseETag(input) {
  const etag = { value: "", weak: false };

  input = input.trim();
  if (input.startsWith("W/")) {
    input = input.slice(2);
    etag.weak = true;
  }

  if (!(input.startsWith("\"") && input.endsWith("\"") && input.length >= 2)) {
    // Invalid etag. Drop.
    // (It would be nice to tell the developer about this but... how?)
    return undefined;
  }

  try {
    // Since the text starts with a quote, the only way it could parse as JSON is if it is a single
    // string. This nicely handles escape sequences for us.
    etag.value = JSON.parse(input);
    return etag;
  } catch (err) {
    // Invalid etag.
    return undefined;
  }
}

class ExternalWebSession extends PersistentImpl {
  constructor(url, options, auth, db, saveTemplate) {
    super(db, saveTemplate);

    if (!options) options = {};
    this.options = options;
    this.auth = auth || { none: null };
    this._url = validateBaseUrl(url);
    this._db = db;
    this._requests = new Set();
    this._closed = false;
    this._authorizationPromise = null;
  }

  close() {
    this._closed = true;
    this._requests.forEach(request => request.cancel());
    this._requests.clear();
  }

  _ensureAuthorization() {
    if (!this._authorizationPromise) {
      this._authorizationPromise = Promise.resolve().then(async () => {
        if (this.auth.refresh) {
          const refreshed = await refreshOAuth(this._url, this.auth.refresh);
          return "Bearer " + refreshed.access_token;
        } else if (this.auth.bearer) {
          return "Bearer " + this.auth.bearer;
        } else if (this.auth.basic) {
          const userpass = [this.auth.basic.username, this.auth.basic.password].join(":");
          return "Basic " + Buffer.from(userpass, "utf8").toString("base64");
        } else {
          return undefined;
        }
      });
    }

    return this._authorizationPromise;
  }

  get(path, context) {
    return this._requestHelper("GET", path, context);
  }

  post(path, content, context) {
    return this._requestHelper("POST", path, context, content.content, content.mimeType);
  }

  put(path, content, context) {
    return this._requestHelper("PUT", path, context, content.content, content.mimeType);
  }

  delete(path, context) {
    return this._requestHelper("DELETE", path, context);
  }

  // TODO(someday): implement streaming uploads and websockets for ExternalWebSession
  //postStreaming(path, mimeType, context) {
  //}

  //putStreaming(path, mimeType, context) {
  //}

  //openWebSocket(path, context, protocol, clientStream) {
  //}

  _requestHelper(method, path, context, content, contentType) {
    // Reject paths and headers before DNS, OAuth, or credential injection.
    if (this._closed) throw new Error("HTTP session is closed.");
    const url = buildHttpUrl(this._url, path);
    const options = { headers: { ...this.options.headers } };
    if (!options.headers["user-agent"]) {
      options.headers["user-agent"] = "sandstorm app";
    }
    if (contentType) {
      options.headers["content-type"] = contentType;
    }

    // set accept header
    if ("accept" in context) {
      options.headers.accept = context.accept.map((acceptedType) => {
        return acceptedType.mimeType + "; q=" + acceptedType.qValue;
      }).join(", ");
    } else if (!("accept" in options.headers)) {
      options.headers.accept = "*/*";
    }

    // set cookies
    if (context.cookies && context.cookies.length > 0) {
      options.headers.cookies = options.headers.cookies || "";
      context.cookies.forEach((keyVal) => {
        options.headers.cookies += keyVal.key + "=" + keyVal.val + ",";
      });
      options.headers.cookies = options.headers.cookies.slice(0, -1);
    }

    // set precondition
    if (context.eTagPrecondition) {
      if (context.eTagPrecondition.none) {
        // nothing
      } else if (context.eTagPrecondition.exists) {
        options.headers["if-match"] = "*";
      } else if (context.eTagPrecondition.doesntExist) {
        options.headers["if-none-match"] = "*";
      } else if (context.eTagPrecondition.matchesOneOf) {
        options.headers["if-match"] =
            context.eTagPrecondition.matchesOneOf.map(composeETag).join(", ");
      } else if (context.eTagPrecondition.matchesNoneOf) {
        options.headers["if-none-match"] =
            context.eTagPrecondition.matchesNoneOf.map(composeETag).join(", ");
      }
    }

    // set additional headers
    const callerHeaders = sanitizeHeaders(context.additionalHeaders);
    Object.entries(callerHeaders).forEach(([name, value]) => {
      if (name === "authorization" ||
          Object.prototype.hasOwnProperty.call(this.options.headers || {}, name)) {
        throw new Error("Cannot override a connection-managed header.");
      }

      if (REQUEST_HEADER_WHITELIST.matches(name)) {
        options.headers[name] = value;
      }
    });

    let resolveResult;
    let rejectResult;
    const result = new Promise((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    let responseStream = context.responseStream;
    let pendingWrite;
    let stopped = false;
    const releaseStream = () => {
      if (stopped) return;
      stopped = true;
      // Cancel the outstanding RPC as well as releasing the capability. Otherwise a stalled
      // write can retain the receiver after the HTTP socket has already been canceled.
      if (pendingWrite && pendingWrite.cancel) pendingWrite.cancel();
      if (responseStream) {
        responseStream.close();
        responseStream = null;
      }
    };
    const operation = startHttpRequest({
      db: this._db, url, method, headers: options.headers,
      getAuthorization: () => this._ensureAuthorization(),
      onFailure: releaseStream,
      consumeResponse: async (response, lifecycle) => {
        const mimeType = (response.headers["content-type"] || "").split(";", 1)[0].trim();
        if (mimeType.toLowerCase() !== "text/event-stream" ||
            responseCodes[response.statusCode]?.type !== "content" || !responseStream) {
          return translateResponse(response, await readHttpBody(response));
        }

        // request's proxy adapter attaches a data listener after this callback returns.
        // Pause now so it cannot drain SSE bytes while the first RPC write is waiting.
        response.pause();
        lifecycle.beginStreaming();
        const translated = translateResponse(response, Buffer.alloc(0));
        translated.content.body = {
          // Return a server object, not an owned Capability: retaining a local capability
          // here would prevent the remote caller's release from invoking close().
          stream: { close: () => operation.cancel() },
        };
        resolveResult(translated);
        const write = async (method, ...args) => {
          if (stopped) throw new Error("Response stream canceled.");
          pendingWrite = responseStream[method](...args);
          await pendingWrite;
          pendingWrite = undefined;
          if (stopped) throw new Error("Response stream canceled.");
          lifecycle.progress();
        };
        // The bridge starts HTTP headers on the first write. An empty write delivers headers
        // promptly even when the provider waits before producing its first SSE event.
        await write("write", Buffer.alloc(0));
        for await (const chunk of response) {
          await write("write", chunk);
        }
        await write("done");
        return translated;
      },
    });
    this._requests.add(operation);
    operation.completion.then(value => {
      this._requests.delete(operation);
      releaseStream();
      resolveResult(value);
    }, error => {
      this._requests.delete(operation);
      releaseStream();
      rejectResult(error);
    });
    operation.started.then(req => {
      try {
        req.end(content, err => { if (err) req.destroy(err); });
      } catch (err) {
        req.destroy(err);
      }
    }, () => {});
    return result;
  }
}

function translateResponse(resp, data) {
  const statusInfo = responseCodes[resp.statusCode];

  const rpcResponse = {};

  rpcResponse.additionalHeaders = [];
  for (const headerName in resp.headers) {
    if (RESPONSE_HEADER_WHITELIST.matches(headerName) ||
        API_RESPONSE_HEADER_WHITELIST.matches(headerName)) {
      rpcResponse.additionalHeaders.push({
        name: headerName,
        value: resp.headers[headerName],
      });
    }
  }

  function fillInErrorBody(error) {
    const contentType = resp.headers["content-type"];
    if (contentType && (contentType == "text/html" ||
                        contentType.startsWith("text/html;"))) {
      // TODO(someday): Check for non-UTF-8 charset and translate?
      error.descriptionHtml = data.toString("utf8");
    } else if (contentType || data.length > 0) {
      const content = { data };
      if (contentType) content.mimeType = contentType;
      if ("content-encoding" in resp.headers) content.encoding = resp.headers["content-encoding"];
      if ("content-language" in resp.headers) content.language = resp.headers["content-language"];
      error.nonHtmlBody = content;
    }
  }

  switch (statusInfo ? statusInfo.type : resp.statusCode) {
    case "content": {
      const content = {};
      rpcResponse.content = content;

      content.statusCode = statusInfo.code;
      if ("content-encoding" in resp.headers) content.encoding = resp.headers["content-encoding"];
      if ("content-language" in resp.headers) content.language = resp.headers["content-language"];
      if ("content-type" in resp.headers) content.mimeType = resp.headers["content-type"];
      if ("content-disposition" in resp.headers) {
        const disposition = resp.headers["content-disposition"];
        const parts = disposition.split(";");
        if (parts[0].toLowerCase().trim() === "attachment") {
          parts.forEach((part) => {
            const splitPart = part.split("=");
            if (splitPart[0].toLowerCase().trim() === "filename") {
              content.disposition = { download: splitPart[1].trim() };
            }
          });
        }
      }

      if (resp.headers.etag) {
        content.eTag = parseETag(resp.headers.etag);
      }

      content.body = {};
      content.body.bytes = data;

      return rpcResponse;
    }
    case "noContent": {
      const noContent = {};
      rpcResponse.noContent = noContent;
      noContent.setShouldResetForm = statusInfo.shouldResetForm;
      if (resp.headers.etag) {
        noContent.eTag = parseETag(resp.headers.etag);
      }

      return rpcResponse;
    }
    case "redirect": {
      const redirect = {};
      rpcResponse.redirect = redirect;
      redirect.isPermanent = statusInfo.isPermanent;
      redirect.switchToGet = statusInfo.switchToGet;
      if ("location" in resp.headers) redirect.location = resp.headers.location;
      return rpcResponse;
    }
    case "clientError": {
      const clientError = {};
      rpcResponse.clientError = clientError;
      clientError.statusCode = statusInfo.clientErrorCode;

      fillInErrorBody(clientError);
      return rpcResponse;
    }
    case "serverError": {
      const serverError = { statusCode: statusInfo.serverErrorCode };
      rpcResponse.serverError = serverError;
      fillInErrorBody(serverError);
      return rpcResponse;
    }
    case "preconditionFailed": {
      const preconditionFailed = {};
      rpcResponse.preconditionFailed = preconditionFailed;
      if (resp.headers.etag) {
        preconditionFailed.matchingETag = parseETag(resp.headers.etag);
      }

      return rpcResponse;

    // TODO(soon): Handle token-expired errors by throwing DISCONNECTED -- this will
    //   force the client to reload the capability which will refresh the token.

    }
    default: {
      // ???
      const err = new Error(
          "Invalid status code " + resp.statusCode + " received in response.");
      throw err;
    }
  }
}
