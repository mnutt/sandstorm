import chai from "chai";
import { Meteor } from "meteor/meteor";
import { Random } from "meteor/random";

import { globalDb } from "/imports/db-deprecated";
import { createGrainBackup } from "/imports/server/backup";

const assert = chai.assert;

if (Meteor.isServer) {
  describe("createGrainBackup", function () {
    this.timeout(10000);

    it("ignores non-account token owners instead of failing", async function () {
      const suffix = Random.id();
      const grainId = "grain-" + suffix;
      const ownerId = "owner-" + suffix;
      const credentialId = "credential-" + suffix;
      const tokenId = "token-" + suffix;
      const title = "backup-test-" + suffix;
      const originalBackend = globalThis.globalBackend;
      let capturedGrainInfo;

      await Meteor.users.insertAsync({
        _id: ownerId,
        type: "account",
        loginCredentials: [],
        nonloginCredentials: [],
        profile: { name: "Owner" },
      });
      await Meteor.users.insertAsync({
        _id: credentialId,
        type: "credential",
      });
      await globalDb.collections.grains.insertAsync({
        _id: grainId,
        userId: ownerId,
        appId: "app-" + suffix,
        appVersion: 1,
        title,
        identityId: "owner-identity-" + suffix,
      });
      await globalDb.collections.apiTokens.insertAsync({
        _id: tokenId,
        grainId,
        owner: {
          user: {
            accountId: credentialId,
            identityId: "credential-identity-" + suffix,
          },
        },
      });
      await globalDb.collections.apiTokens.insertAsync({
        _id: "owner-token-" + suffix,
        grainId,
        owner: {
          user: {
            accountId: ownerId,
            identityId: "owner-identity-" + suffix,
          },
        },
      });

      try {
        globalThis.globalBackend = {
          cap: () => ({
            backupGrain: async (fileTokenId, userId, requestedGrainId, grainInfo) => {
              assert.equal(userId, ownerId);
              assert.equal(requestedGrainId, grainId);
              capturedGrainInfo = grainInfo;
            },
          }),
        };

        await createGrainBackup(ownerId, grainId, false);

        assert.isOk(capturedGrainInfo);
        assert.equal(capturedGrainInfo.users.length, 1);
        assert.equal(capturedGrainInfo.users[0].identityId, "owner-identity-" + suffix);
        assert.deepEqual(capturedGrainInfo.users[0].credentialIds, []);
      } finally {
        globalThis.globalBackend = originalBackend;
        await Meteor.users.removeAsync({ _id: { $in: [ownerId, credentialId] } });
        await globalDb.collections.grains.removeAsync(grainId);
        await globalDb.collections.apiTokens.removeAsync({ grainId });
        await globalDb.collections.fileTokens.removeAsync({ name: title });
      }
    });
  });
}
