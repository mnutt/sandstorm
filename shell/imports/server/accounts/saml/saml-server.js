import { AuthorizationAttempts } from "/imports/server/rust-shell-auth-attempts.mjs";
import Url from "url";
import zlib from "zlib";
import Crypto from "node:crypto";

import { Meteor } from "meteor/meteor";
import { check } from "meteor/check";
import { pick } from "/imports/shared/collection-utils";
import { Accounts } from "meteor/accounts-base";

import { SAML } from "/imports/server/accounts/saml-utils";
import { SandstormDb } from "/imports/sandstorm-db/db";

import BodyParser from "body-parser";

if (!Accounts.saml) {
  Accounts.saml = {};
}

RoutePolicy.declare("/_saml/", "network");

const HOSTNAME = Url.parse(process.env.ROOT_URL).hostname;

// TODO(soon): This may need to be a Mongo collection in order to work when the frontend is
//   replicated (but currently SAML is not used on any Blackrock servers).
const _loginResultForCredentialToken = {};

const retrieveCredential = function (credentialToken) {
  const result = _loginResultForCredentialToken[credentialToken];
  delete _loginResultForCredentialToken[credentialToken];
  return result;
};

Accounts.registerLoginHandler(function (loginRequest) {
  if (!loginRequest.saml || !loginRequest.credentialToken) {
    return undefined;
  }

  if (!Accounts.loginServices.saml.isEnabled()) {
    throw new Meteor.Error(403, "SAML service is disabled.");
  }

  const loginResult = retrieveCredential(loginRequest.credentialToken);
  if (!loginResult) {
    throw new Meteor.Error(500, "SAML login did not complete.");
  } else if (loginResult.profile && loginResult.profile.email) {
    let user = pick(loginResult.profile, "displayName", "email", "nameIDFormat");
    user.id = loginResult.profile.nameID;
    return Accounts.updateOrCreateUserFromExternalService("saml", user, {});
  } else {
    throw new Meteor.Error(500, "SAML profile did not contain an email address");
  }
});

const samlUrlToObject = function (url) {
  // req.url will be "/_saml/<action>/<service name>/<credentialToken>"
  if (!url)
    return null;

  const splitPath = url.split("/");

  // Any non-saml request will continue down the default
  // middlewares.
  if (splitPath[1] !== "_saml")
    return null;

  return {
    actionName: splitPath[2],
    serviceName: splitPath[3],
    credentialToken: splitPath[4],
  };
};

const closePopup = function (res, err) {
  res.writeHead(200, { "Content-Type": "text/html" });
  let content =
        "<html><head><script>window.close()</script></head></html>";
  if (err)
    content = "<html><body><h2>Sorry, an error occured</h2><div>" + err + '</div><a onclick="window.close();">Close Window</a> <a href="/admin/status" target="_blank">View system log (admin only)</a></body></html>';
  res.end(content, "utf-8");
};

const generateService = async function () {
  // TODO(cleanup): Inject the db.
  const db = new SandstormDb();
  const [entityId, entryPoint, logoutUrl, publicCert] = await Promise.all([
    db.getSamlEntityId(),
    db.getSamlEntryPoint(),
    db.getSamlLogout(),
    db.getSamlPublicCert(),
  ]);

  const service = {
    "provider": "default",
    "entryPoint": entryPoint,
    "logoutUrl": logoutUrl,
    // TODO(someday): find a better way to inject the DB
    "issuer": entityId || HOSTNAME,
    // If the certificate has "-----BEGIN CERTIFICATE-----" markers, automatically remove those.
    "cert": publicCert.replace(/-[^\n]*-/g, "").trim(),
  };
  return service;
};

// Native flows keep the browser request key, AuthnRequest ID, and DDP
// login credential separate. Knowing the ID sent to the IdP cannot redeem login.
const nativeIds = new Map();
const nativeRequests = new AuthorizationAttempts({onRemove: (_key, request) => nativeIds.delete(request.id)});
const nativePrefix = "_rust_";
export const samlEnabled = () => !!Accounts.loginServices.saml?.isEnabled();
export async function startNativeSaml(binding) {
  if (!samlEnabled()) throw new Meteor.Error(403, "SAML service is disabled.");
  const origin = Meteor.settings.public.rustShellOrigin;
  if (!origin || new URL(origin).protocol !== "https:") throw new Meteor.Error(503, "Rust shell is unavailable.");
  const key = Crypto.randomBytes(32).toString("hex");
  const id = nativePrefix + Crypto.randomBytes(32).toString("hex");
  const service = await generateService();
  service.callbackUrl = Meteor.absoluteUrl("_saml/validate/default");
  service.id = id;
  const url = new URL(await new Promise((resolve, reject) => {
    new SAML(service).getAuthorizeUrl({}, (error, value) => error ? reject(error) : resolve(value));
  }));
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Meteor.Error(400, "Invalid SAML authorization endpoint.");
  }
  nativeRequests.set(key, {id, binding, origin});
  nativeIds.set(id, key);
  return {request:key, url:url.href};
}
export function cancelNativeSaml(binding, key) {
  if (nativeRequests.get(key)?.binding === binding) void nativeRequests.discard(key);
}
export function finishNativeSaml(binding, key) {
  const request = nativeRequests.get(key);
  if (!request || request.binding !== binding) throw new Meteor.Error(403, "Authorization does not belong to this session.");
  if (request.expires <= Date.now() || !samlEnabled()) {
    void nativeRequests.discard(key);
    throw new Meteor.Error(403, "SAML authorization expired.");
  }
  if (!request.profile) return null;
  const credentialToken = Crypto.randomBytes(32).toString("hex");
  _loginResultForCredentialToken[credentialToken] = {profile:request.profile};
  nativeRequests.take(key);
  return {credentialToken};
}
export function discardNativeSamlCredential(credentialToken) {
  retrieveCredential(credentialToken);
}
function completeNativeSaml(profile, res) {
  const id = profile.inResponseToId || profile.InResponseTo;
  if (typeof id !== "string" || !id.startsWith(nativePrefix)) return false;
  const request = nativeRequests.get(nativeIds.get(id));
  if (!request || request.expires <= Date.now() || !samlEnabled()) {
    throw new Meteor.Error(403, "SAML authorization expired.");
  }
  if (request.profile) throw new Meteor.Error(403, "SAML response was already received.");
  request.profile = profile;
  res.writeHead(303, {Location:request.origin + "/oauth-complete", "Cache-Control":"no-store", "Referrer-Policy":"no-referrer"});
  res.end();
  return true;
}

export const handleSamlRequest = async function (req, res, next) {
  // Make sure to catch any exceptions because otherwise we'd crash
  // the runner
  try {
    const samlObject = samlUrlToObject(req.url);
    if (!samlObject || !samlObject.serviceName) {
      next();
      return;
    }

    if (samlObject.actionName === "config") {
      const _saml = new SAML(await generateService());
      res.writeHead(200, { "Content-Type": "text/xml" });
      res.end(_saml.generateServiceProviderMetadata());
      return;
    }

    if (!Accounts.loginServices.saml.isEnabled()) {
      next();
      return;
    }

    if (!samlObject.actionName)
      throw new Error("Missing SAML action");

    const service = await generateService();

    // Skip everything if there's no service set by the saml middleware
    if (!service || samlObject.serviceName !== service.provider)
      throw new Error("Unexpected SAML service " + samlObject.serviceName);

    if (samlObject.actionName === "authorize") {
      service.callbackUrl = Meteor.absoluteUrl("_saml/validate/" + service.provider);
      service.id = samlObject.credentialToken;
      const _saml = new SAML(service);
      const url = await new Promise((resolve, reject) => {
        _saml.getAuthorizeUrl(req, (err, nextUrl) => {
          if (err) {
            reject(new Error("Unable to generate authorize url"));
          } else {
            resolve(nextUrl);
          }
        });
      });

      res.writeHead(302, { "Location": url });
      res.end();
    } else if (samlObject.actionName === "validate") {
      const _saml = new SAML(service);
      const profile = await new Promise((resolve, reject) => {
        _saml.validateResponse(req.body.SAMLResponse, (err, nextProfile, _loggedOut, responseText) => {
          if (err) {
            console.error("Error validating SAML response:", err.toString(),
                          "\nFull SAML response XML:\n", responseText);
            reject(new Error("Unable to validate SAML response."));
          } else {
            resolve(nextProfile);
          }
        });
      });

      // Do NOT use samlObject.credentialToken; it isn't signed!
      const credentialToken = profile.inResponseToId || profile.InResponseTo;
      if (!credentialToken) {
        throw new Error(
            "SAML response missing InResponseTo attribute. Sandstorm does not support " +
            "IdP-initiated authentication; authentication requests must start " +
            "from the user choosing SAML login in the Sandstorm UI.");
      }

      if (completeNativeSaml(profile, res)) return;

      _loginResultForCredentialToken[credentialToken] = {
        profile: profile,
      };

      closePopup(res);
    } else {
      throw new Error("Unexpected SAML action " + samlObject.actionName);
    }
  } catch (err) {
    console.error(err.stack);
    closePopup(res, err);
  }
};

// Listen to incoming OAuth http requests
WebApp.connectHandlers.use(BodyParser.urlencoded({ extended: false })).use(function (req, res, next) {
  handleSamlRequest(req, res, next);
});

export async function samlLogoutUrl(accountId, {optional = false} = {}) {
  const user = await Meteor.users.findOneAsync({ _id: accountId });
  if (!user) {
    throw new Meteor.Error(403, "Not logged in.");
  }

  let credential;
  const credentials = await Meteor.users.find({
    _id: { $in: (user.loginCredentials || []).map((_credential) => _credential.id) },
  }).fetchAsync();
  credentials.forEach((currCredential) => {
    if (currCredential.services.saml) {
      credential = currCredential;
    }
  });
  if (!credential && optional) return null;
  if (!credential) {
    throw new Meteor.Error(400, "No SAML credential found for current user.");
  }
  // TODO(someday): handle user having more than one SAML credential

  const service = await generateService();
  if (!service.logoutUrl) throw new Meteor.Error(500, "No SAML logout url specified");
  const _saml = new SAML(service);
  const url = await new Promise((resolve, reject) => {
    _saml.getLogoutUrl({
      user: {
        nameID: credential.services.saml.id,
        nameIDFormat: credential.services.saml.nameIDFormat ||
          "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
      },
    }, (err, url) => {
      if (err) {
        reject(err);
      } else {
        resolve(url);
      }
    });
  });
  const parsed = new URL(url);
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
    throw new Meteor.Error(400, "Invalid SAML logout URL.");
  }
  return parsed.href;
}

Meteor.methods({
  async generateSamlLogout() {
    return samlLogoutUrl(this.userId);
  },

  validateSamlLogout: async function (samlRequest) {
    check(samlRequest, String);

    const db = this.connection.sandstormDb;
    const userId = this.userId;
    if (!userId) {
      return new Meteor.Error(403, "Non-logged in users can't logout.");
    }

    const service = await generateService();
    const _saml = new SAML(service);
    if (samlRequest) {
      const buf = Buffer.from(samlRequest, "base64");
      const xml = zlib.inflateRawSync(buf).toString();
      const nameId = await new Promise((resolve, reject) => {
        _saml.parseLogoutRequest(xml, function (err, parsedNameId) {
          if (err) {
            console.error("Error validating SAML logout response:", err.toString());
            reject(new Error("Unable to validate SAML logout response."));
          } else {
            resolve(parsedNameId);
          }
        });
      });
      check(nameId, String);

      const credential = await db.collections.users.findOneAsync({ "services.saml.id": nameId, },
        { fields: { _id: 1, }, });
      if (!credential) {
        return new Meteor.Error(400, "No credential found matching SAML nameID.");
      }

      const user = await db.collections.users.findOneAsync({ "loginCredentials.id": credential._id, },
        { fields: { _id: 1, }, });
      if (!user) {
        return new Meteor.Error(403, "No user found for expected SAML credential.");
      }

      if (user._id !== userId) {
        const txt = "SAML logout requested for wrong user: " + nameId + ", " + userId;
        console.error(txt);
        throw new Error(txt);
      }
    }
  },
});
