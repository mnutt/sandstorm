import chai from "chai";
import { Meteor } from "meteor/meteor";

import { assertGrainIsPublishable } from "/imports/server/grain-lifecycle";

const assert = chai.assert;

if (Meteor.isServer) {
  describe("grain publishing lifecycle", function () {
    it("rejects trashed grains", function () {
      assert.throws(() => assertGrainIsPublishable({ _id: "g", trashed: new Date() }),
                    /trash/i);
    });

    it("rejects suspended grains", function () {
      assert.throws(() => assertGrainIsPublishable({ _id: "g", suspended: true }),
                    /suspended/i);
    });

    it("accepts an active grain", function () {
      assert.doesNotThrow(() => assertGrainIsPublishable({ _id: "g" }));
    });

    it("rejects a missing grain", function () {
      assert.throws(() => assertGrainIsPublishable(null), /No such grain/);
    });
  });
}
