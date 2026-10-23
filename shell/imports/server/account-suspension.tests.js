import { assert } from "chai";
import { Random } from "meteor/random";
import { globalDb } from "/imports/db-deprecated";

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

describe("Account restoration", function () {
  async function fixture(test) {
    const id = "restore-test-" + Random.id();
    const db = Object.create(globalDb);
    db.collections = { ...globalDb.collections };
    await db.collections.users.insertAsync({
      _id: id, loginCredentials: [{ id: id + "-credential" }], nonloginCredentials: [],
      suspended: { voluntary: true, timestamp: new Date(), willDelete: true },
    });
    await db.collections.users.insertAsync({
      _id: id + "-credential", suspended: { voluntary: true, timestamp: new Date() },
    });
    await db.collections.grains.insertAsync({ _id: id, userId: id, suspended: true });
    await db.collections.apiTokens.insertAsync({
      _id: id, owner: { user: { accountId: id } }, suspended: true,
    });
    try {
      await test(db, id);
    } finally {
      await globalDb.collections.users.removeAsync({ _id: { $in: [id, id + "-credential"] } });
      await globalDb.collections.grains.removeAsync(id);
      await globalDb.collections.apiTokens.removeAsync(id);
    }
  }

  it("checks voluntary deletion at the database update even after a stale read", async function () {
    await fixture(async (db, id) => {
      const users = db.collections.users;
      db.collections.users = Object.create(users);
      db.collections.users.findOneAsync = async (...args) => {
        const user = await users.findOneAsync(...args);
        await users.updateAsync(id, { $set: { suspended: { admin: "admin" } } });
        return user;
      };
      const error = await db.unsuspendAccount(id, { voluntaryOnly: true }).then(
          () => null, error => error);
      assert.equal(error.error, 403);
      assert.isTrue((await db.collections.grains.findOneAsync(id)).suspended);
      assert.isTrue((await db.collections.apiTokens.findOneAsync(id)).suspended);
    });
  });

  for (const adminFirst of [false, true]) {
    it("orders dependent updates when " + (adminFirst ? "suspension" : "restoration") +
        " starts first", async function () {
      await fixture(async (db, id) => {
        const reached = deferred();
        const release = deferred();
        const grains = db.collections.grains;
        db.collections.grains = Object.create(grains);
        db.collections.grains.updateAsync = async (...args) => {
          reached.resolve();
          await release.promise;
          return grains.updateAsync(...args);
        };
        // Use a distinct DB instance to ensure ordering isn't confined to one connection.
        const otherDb = Object.create(globalDb);
        const restore = target => target.unsuspendAccount(id, { voluntaryOnly: true });
        const suspend = target => target.suspendAccount(id, "admin", false);
        const first = (adminFirst ? suspend : restore)(db);
        let second;
        try {
          await reached.promise;
          second = (adminFirst ? restore : suspend)(otherDb).catch(error => error);
        } finally {
          release.resolve();
        }
        await first;
        const result = await second;
        if (adminFirst) assert.equal(result.error, 403);
        assert.equal((await globalDb.collections.users.findOneAsync(id)).suspended.admin, "admin");
        assert.equal((await globalDb.collections.users.findOneAsync(id + "-credential"))
            .suspended.admin, "admin");
        assert.isTrue((await grains.findOneAsync(id)).suspended);
        assert.isTrue((await db.collections.apiTokens.findOneAsync(id)).suspended);
      });
    });
  }
});
