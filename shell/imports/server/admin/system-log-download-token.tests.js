import chai from "chai";
import { Meteor } from "meteor/meteor";

import {
  SystemLogDownloadTokens,
  SYSTEM_LOG_DOWNLOAD_TOKEN_VALIDITY_DURATION,
} from "/imports/server/admin/system-log-download-token";

const assert = chai.assert;

if (Meteor.isServer) {
  describe("system log download tokens", function () {
    beforeEach(function () {
      SystemLogDownloadTokens.clear();
    });

    it("rejects inherited Object.prototype names", function () {
      for (const token of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
        assert.isNull(SystemLogDownloadTokens.take(token));
      }
    });

    it("accepts an issued token exactly once", function () {
      const now = Date.now();
      const token = SystemLogDownloadTokens.issue("valid-token", now);

      assert.equal(token, "valid-token");
      assert.equal(SystemLogDownloadTokens.take(token, now), now);
      assert.isNull(SystemLogDownloadTokens.take(token, now));
    });

    it("rejects an expired token", function () {
      const now = Date.now();
      const token = SystemLogDownloadTokens.issue("expired-token", now);

      assert.isNull(SystemLogDownloadTokens.take(
        token, now + SYSTEM_LOG_DOWNLOAD_TOKEN_VALIDITY_DURATION + 1));
      assert.isNull(SystemLogDownloadTokens.take(token, now));
    });

    it("removes a token explicitly", function () {
      const now = Date.now();
      const token = SystemLogDownloadTokens.issue("removed-token", now);

      SystemLogDownloadTokens.remove(token);
      assert.isNull(SystemLogDownloadTokens.take(token, now));
    });
  });
}
