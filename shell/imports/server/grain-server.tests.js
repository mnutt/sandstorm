import chai from "chai";
import { Meteor } from "meteor/meteor";
import { Random } from "meteor/random";

import { globalDb } from "/imports/db-deprecated";
import { SandstormPermissions } from "/imports/sandstorm-permissions/permissions";
import "/imports/server/grain-server";

const assert = chai.assert;

function getMethodHandler(name) {
  const handlers = Meteor.server && (Meteor.server.method_handlers || Meteor.server.methodHandlers);
  assert.isOk(handlers, "Meteor method handler map unavailable");
  const handler = handlers[name];
  assert.isFunction(handler, "Method handler missing: " + name);
  return handler;
}

if (Meteor.isServer) {
  describe("inviteUsersToGrain", function () {
    this.timeout(10000);

    let suffix;
    let ownerId;
    let attackerId;
    let credentialId;
    let recipientId;
    let grainId;
    let originalGetReturnAddress;
    let originalGetPrimaryEmail;

    beforeEach(async function () {
      suffix = Random.id();
      ownerId = "owner-" + suffix;
      attackerId = "attacker-" + suffix;
      credentialId = "credential-" + suffix;
      recipientId = "recipient-" + suffix;
      grainId = "grain-" + suffix;

      await Meteor.users.insertAsync({
        _id: ownerId,
        type: "account",
        loginCredentials: [],
        nonloginCredentials: [],
        profile: { name: "Owner" },
      });
      await Meteor.users.insertAsync({
        _id: attackerId,
        type: "account",
        loginCredentials: [],
        nonloginCredentials: [],
        profile: { name: "Attacker" },
      });
      await Meteor.users.insertAsync({
        _id: credentialId,
        type: "credential",
      });
      await Meteor.users.insertAsync({
        _id: recipientId,
        type: "account",
        loginCredentials: [],
        nonloginCredentials: [],
        profile: { name: "Recipient" },
      });
      await globalDb.collections.grains.insertAsync({
        _id: grainId,
        userId: ownerId,
        appId: "app-" + suffix,
        appVersion: 1,
        title: "Invite test",
        private: true,
        identityId: "owner-identity-" + suffix,
      });

      originalGetReturnAddress = globalDb.getReturnAddressWithDisplayName;
      originalGetPrimaryEmail = globalDb.getPrimaryEmail;
      globalDb.getReturnAddressWithDisplayName = async () => "from@example.com";
      globalDb.getPrimaryEmail = async () => "reply@example.com";
    });

    afterEach(async function () {
      globalDb.getReturnAddressWithDisplayName = originalGetReturnAddress;
      globalDb.getPrimaryEmail = originalGetPrimaryEmail;
      await Meteor.users.removeAsync({
        _id: { $in: [ownerId, attackerId, credentialId, recipientId] },
      });
      await globalDb.collections.grains.removeAsync({ _id: grainId });
      await globalDb.collections.apiTokens.removeAsync({ grainId });
    });

    it("rejects a caller without sharing access", async function () {
      const handler = getMethodHandler("inviteUsersToGrain");

      try {
        await handler.apply({ userId: attackerId, isSimulation: false }, [
          "http://localhost", null, grainId, "Invite test", { allAccess: null },
          [{ _id: credentialId, profile: { name: "Credential" } }], "message",
        ]);
        assert.fail("Expected inviteUsersToGrain to reject the non-owner");
      } catch (err) {
        assert.equal(err.error, 403);
      }

      assert.equal(await globalDb.collections.apiTokens.find({ grainId }).countAsync(), 0);
    });

    it("allows a directly invited collaborator to invite another account", async function () {
      const share = await SandstormPermissions.createNewApiToken(
        globalDb, { accountId: ownerId }, grainId, "direct share", { allAccess: null },
        { user: { accountId: attackerId, title: "Invite test" } });
      const token = await globalDb.collections.apiTokens.findOneAsync(share.id);
      assert.isUndefined(token.forSharing);

      await getMethodHandler("inviteUsersToGrain").apply(
        { userId: attackerId, isSimulation: false }, [
          "http://localhost", null, grainId, "Invite test", { allAccess: null },
          [{ _id: recipientId, profile: { name: "Recipient" } }], "message",
        ]);

      const invitation = await globalDb.collections.apiTokens.findOneAsync({
        grainId, accountId: attackerId, "owner.user.accountId": recipientId,
      });
      assert.isOk(invitation);
      assert.isTrue(await SandstormPermissions.mayOpenGrainAsync(globalDb, {
        grain: { _id: grainId, accountId: recipientId },
      }));
    });

    it("rejects a collaborator whose upstream share was revoked", async function () {
      const parent = await SandstormPermissions.createNewApiToken(
        globalDb, { accountId: ownerId }, grainId, "share link", { allAccess: null },
        { webkey: { forSharing: true } });
      await SandstormPermissions.createNewApiToken(
        globalDb, { rawParentToken: parent.token }, grainId, "redeemed share",
        { allAccess: null }, { user: { accountId: attackerId, title: "Invite test" } });
      assert.isTrue(await SandstormPermissions.mayOpenGrainAsync(globalDb, {
        grain: { _id: grainId, accountId: attackerId },
      }));
      await globalDb.collections.apiTokens.updateAsync(parent.id, { $set: { revoked: true } });

      try {
        await getMethodHandler("inviteUsersToGrain").apply(
          { userId: attackerId, isSimulation: false }, [
            "http://localhost", null, grainId, "Invite test", { allAccess: null },
            [{ _id: recipientId, profile: { name: "Recipient" } }], "message",
          ]);
        assert.fail("Expected revoked upstream access to reject the invitation");
      } catch (err) {
        assert.equal(err.error, 403);
      }

      assert.equal(await globalDb.collections.apiTokens.find({
        grainId, "owner.user.accountId": recipientId,
      }).countAsync(), 0);
    });

    it("limits downstream invitations to the inviter's permissions and revokes them upstream", async function () {
      const viewInfo = {
        permissions: [{ name: "read" }, { name: "write" }],
        roles: [{ permissions: [true, false] }],
      };
      await globalDb.collections.grains.updateAsync(grainId, { $set: { cachedViewInfo: viewInfo } });
      const share = await SandstormPermissions.createNewApiToken(
        globalDb, { accountId: ownerId }, grainId, "read-only share", { roleId: 0 },
        { user: { accountId: attackerId, title: "Invite test" } });

      await getMethodHandler("inviteUsersToGrain").apply(
        { userId: attackerId, isSimulation: false }, [
          "http://localhost", null, grainId, "Invite test", { allAccess: null },
          [{ _id: recipientId, profile: { name: "Recipient" } }], "message",
        ]);

      const vertex = { grain: { _id: grainId, accountId: recipientId } };
      const before = await SandstormPermissions.grainPermissionsAsync(globalDb, vertex, viewInfo);
      try {
        assert.deepEqual(before.permissions, [true, false]);
      } finally {
        before.observeHandle.stop();
      }

      await globalDb.collections.apiTokens.updateAsync(share.id, { $set: { revoked: true } });
      const after = await SandstormPermissions.grainPermissionsAsync(globalDb, vertex, viewInfo);
      try {
        assert.isNull(after.permissions);
        assert.isFalse(await SandstormPermissions.mayOpenGrainAsync(globalDb, vertex));
      } finally {
        after.observeHandle.stop();
      }
    });

    it("rejects a credential user as an invite recipient", async function () {
      const handler = getMethodHandler("inviteUsersToGrain");

      const result = await handler.apply({ userId: ownerId, isSimulation: false }, [
        "http://localhost", null, grainId, "Invite test", { allAccess: null },
        [{ _id: credentialId, profile: { name: "Credential" } }], "message",
      ]);

      assert.equal(result.failures.length, 1);
      assert.match(result.failures[0].error, /not an account/i);
      assert.equal(await globalDb.collections.apiTokens.find({ grainId }).countAsync(), 0);
    });
  });
}
