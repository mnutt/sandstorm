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

"use strict";

var utils = require("../utils"),
    medium_wait = utils.medium_wait;

module.exports["Test admin methods"] = function (browser) {
  browser
    .url(browser.launch_url + "/")
    .timeouts("script", medium_wait);

  utils.callMeteorTestMethod(browser, "testRegressionAdminMethods");

  browser.end();
};

module.exports["Test admin cannot remove own admin permission"] = function (browser) {
  browser
    .loginDevAccount(null, true)
    .executeAsync(function (done) {
      Meteor.call("adminUpdateUser", undefined, {
        userId: Meteor.userId(),
        signupKey: true,
        isAdmin: false,
      }, function (err) {
        done({
          error: err && {
            error: err.error,
            reason: err.reason,
            message: err.message,
          },
        });
      });
    }, [], function (result) {
      var error = result.value && result.value.error;
      browser.assert.equal(error && error.error, 403, "self admin removal is rejected");
      browser.assert.ok(/cannot remove admin permissions from itself/i.test(error && error.message),
          "self admin removal returns expected error");
    })
    .end();
};

module.exports["Test delete dialog displays profile names as text"] = function (browser) {
  var targetId = "test-profile-rendering-" + Math.random().toString(36).slice(2);
  browser.loginDevAccount(null, true)
    .executeAsync(function (id, done) {
      Meteor.call("testAdminProfileNameFixture", id, false, function (error) {
        done(error ? error.message : null);
      });
    }, [targetId], function (result) {
      browser.assert.equal(result.value, null, "profile fixture created");
    })
    .url(browser.launch_url + "/admin/users/" + targetId)
    .waitForElementVisible("button[name=delete-account]", medium_wait)
    .click("button[name=delete-account]")
    .waitForElementVisible(".admin-user-confirm-delete", medium_wait)
    .execute(function () {
      var dialog = document.querySelector(".admin-user-confirm-delete");
      return {
        executed: !!window.profileMarkupExecuted,
        images: dialog.querySelectorAll("img").length,
        text: dialog.textContent,
        emphasized: Array.from(dialog.querySelectorAll("strong")).map(function (node) { return node.textContent; }),
      };
    }, [], function (result) {
      var expected = '<img src=x onerror="window.profileMarkupExecuted=true"> & \'Name\'';
      browser.assert.equal(result.value.executed, false);
      browser.assert.equal(result.value.images, 0, "profile markup does not create elements");
      browser.assert.ok(result.value.text.includes(expected), "dialog displays the literal name");
      browser.assert.ok(result.value.emphasized.includes("not"), "translation keeps its emphasis");
    })
    .executeAsync(function (id, done) {
      Meteor.call("testAdminProfileNameFixture", id, true, function (error) {
        done(error ? error.message : null);
      });
    }, [targetId], function (result) {
      browser.assert.equal(result.value, null, "profile fixture removed");
    }).end();
};
