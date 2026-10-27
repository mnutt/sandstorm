import chai from "chai";
import { Meteor } from "meteor/meteor";
import { Random } from "meteor/random";

import { globalDb } from "/imports/db-deprecated";
import "/imports/server/signup-server";

const assert = chai.assert;

function getMethodHandler(name) {
  const handlers = Meteor.server && (Meteor.server.method_handlers || Meteor.server.methodHandlers);
  assert.isOk(handlers, "Meteor method handler map unavailable");
  const handler = handlers[name];
  assert.isFunction(handler, "Method handler missing: " + name);
  return handler;
}

if (Meteor.isServer) {
  describe("useSignupKey", function () {
    this.timeout(10000);

    it("allows only one concurrent redemption of a single-use key", async function () {
      const suffix = Random.id();
      const key = "signup-key-" + suffix;
      const accountA = "account-a-" + suffix;
      const accountB = "account-b-" + suffix;
      const credentialA = "credential-a-" + suffix;
      const credentialB = "credential-b-" + suffix;

      await Meteor.users.insertAsync({
        _id: credentialA,
        type: "credential",
      });
      await Meteor.users.insertAsync({
        _id: credentialB,
        type: "credential",
      });
      await Meteor.users.insertAsync({
        _id: accountA,
        type: "account",
        loginCredentials: [{ id: credentialA }],
        nonloginCredentials: [],
        profile: { name: "Account A" },
      });
      await Meteor.users.insertAsync({
        _id: accountB,
        type: "account",
        loginCredentials: [{ id: credentialB }],
        nonloginCredentials: [],
        profile: { name: "Account B" },
      });
      await globalDb.collections.signupKeys.insertAsync({
        _id: key,
        used: false,
        quota: 12345,
      });

      const collection = globalDb.collections.signupKeys;
      const originalFindOneAsync = collection.findOneAsync;
      let reads = 0;
      let release;
      const barrier = new Promise((resolve) => { release = resolve; });

      try {
        collection.findOneAsync = async function (...args) {
          const result = await originalFindOneAsync.apply(this, args);
          reads++;
          if (reads === 2) release();
          await barrier;
          return result;
        };

        const handler = getMethodHandler("useSignupKey");
        const results = await Promise.allSettled([
          handler.apply({ userId: accountA }, [key]),
          handler.apply({ userId: accountB }, [key]),
        ]);

        assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
        assert.equal(results.filter((result) => result.status === "rejected").length, 1);

        const storedKey = await globalDb.collections.signupKeys.findOneAsync(key);
        assert.isTrue(storedKey.used);

        const users = await Meteor.users.find(
          { _id: { $in: [accountA, accountB] } }).fetchAsync();
        assert.equal(users.filter((user) => user.signupKey === key).length, 1);
      } finally {
        collection.findOneAsync = originalFindOneAsync;
        await Meteor.users.removeAsync({ _id: { $in: [accountA, accountB, credentialA, credentialB] } });
        await globalDb.collections.signupKeys.removeAsync(key);
      }
    });
  });
}
