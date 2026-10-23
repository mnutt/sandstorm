import { Meteor } from "meteor/meteor";
import { Accounts } from "meteor/accounts-base";
import { Random } from "meteor/random";
import { Client as LdapClient } from "ldapts";
import { globalDb } from "/imports/db-deprecated";
import "/imports/server/accounts/ldap/ldap-server";

describe("LDAP password validation", function () {
  this.timeout(15000);
  it("checks rejected inputs and successful controls", async function () {
  const run = async (scenario) => {
    const loginHandler = (Accounts._loginHandlers || [])
        .find(handler => handler.name === "ldap");
    if (!loginHandler) {
      throw new Meteor.Error("ldap-handler-missing", "LDAP login handler is not registered.");
    }

    const originalServices = Accounts.loginServices;
    Accounts.loginServices = { ...originalServices, ldap: { isEnabled: () => true } };
    const originalBind = LdapClient.prototype.bind;
    const originalSearch = LdapClient.prototype.search;
    const originalUnbind = LdapClient.prototype.unbind;
    const dn = "uid=test-ldap-" + Random.id() + ",dc=example,dc=com";
    const db = Object.create(globalDb);
    Object.assign(db, {
      getLdapBase: async () => "dc=example,dc=com",
      getLdapUrl: async () => "ldap://directory.example",
      getLdapSearchUsername: async () => "uid",
      getLdapFilter: async () => "(objectclass=*)",
      getLdapSearchBindDn: async () => "",
      getLdapSearchBindPassword: async () => "",
      getLdapCaCert: async () => "",
    });
    let result;
    try {
      Accounts.loginServices.ldap.isEnabled = function () { return true; };
      // Stub the directory transport, leaving password checks in ldapCheck exercised.
      const password = scenario === "valid-password" ? "correct-password" :
          scenario === "wrong-password" ? "wrong-password" : "";
      let bindCalls = 0;
      LdapClient.prototype.bind = async function (bindDn, suppliedPassword) {
        if (bindDn !== dn || suppliedPassword !== password) {
          throw new Error("LDAP fixture received unexpected bind credentials.");
        }
        bindCalls++;
        if (suppliedPassword === "correct-password" ||
            (scenario === "anonymous-empty" && suppliedPassword === "")) return;
        const err = new Error("Invalid credentials (simulated directory rejection)");
        err.code = 49;
        throw err;
      };
      LdapClient.prototype.search = async function () {
        return { searchEntries: [{ dn, uid: "test-ldap-user" }] };
      };
      LdapClient.prototype.unbind = async function () {};

      try {
        result = await loginHandler.handler.call({
          userId: null,
          connection: { sandstormDb: db },
        }, {
          ldap: true,
          username: "test-ldap-user",
          ldapPass: password,
        });
      } catch (err) {
        if (!(err instanceof Meteor.Error) || ![400, 403, 49].includes(err.error)) throw err;
        result = { error: err };
      }

      if (!result || (!result.userId && !result.error)) {
        throw new Error("LDAP login handler returned no authentication result.");
      }
      if (result.error && (!(result.error instanceof Meteor.Error) ||
          ![400, 403, 49].includes(result.error.error))) {
        throw result.error;
      }

      if (scenario === "valid-password") {
        const user = result.userId && await Meteor.users.findOneAsync(result.userId);
        if (bindCalls !== 1 || !user || user.services.ldap.id !== dn) {
          throw new Error("Valid-password LDAP control did not authenticate the fixture identity.");
        }
      } else if (result.userId) {
        throw new Meteor.Error("ldap-invalid-password-accepted",
            "LDAP accepted a password that should be rejected in directory scenario: " + scenario +
            "; directory bind calls: " + bindCalls);
      }
      if (password === "" && bindCalls !== 0) {
        throw new Error("An empty password reached the directory bind.");
      }
      if (scenario === "wrong-password" && bindCalls !== 1) {
        throw new Error("Wrong-password control did not exercise directory authentication.");
      }

      return true;
    } finally {
      LdapClient.prototype.bind = originalBind;
      LdapClient.prototype.search = originalSearch;
      LdapClient.prototype.unbind = originalUnbind;
      Accounts.loginServices = originalServices;

      await Meteor.users.removeAsync({ "services.ldap.id": dn });
    }
  };
  for (const scenario of ["anonymous-empty", "reject-empty", "wrong-password", "valid-password"]) {
    await run(scenario);
  }
  return true;
  });
});
