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

module.exports["Test notification server behavior"] = function (browser) {
  browser
    .url(browser.launch_url + "/")
    .timeouts("script", medium_wait);

  utils.callMeteorTestMethod(browser, "testRegressionNotifications");

  browser.end();
};

module.exports["Test notification names and titles display as text"] = function (browser) {
  var id = "test-notification-rendering-" + Math.random().toString(36).slice(2);
  browser.loginDevAccount()
    .executeAsync(function (id, done) {
      Meteor.call("testNotificationNameFixture", id, false, function (error) {
        done(error ? error.message : null);
      });
    }, [id], function (result) {
      browser.assert.equal(result.value, null, "notification fixture created");
    })
    .click(".topbar .notifications .show-popup")
    .waitForElementVisible(".popup.notifications .notification-item", medium_wait)
    .execute(function () {
      var title = document.querySelector(".popup.notifications .notification-title");
      return {
        executed: !!window.notificationMarkupExecuted,
        images: title.querySelectorAll("img").length,
        names: Array.from(title.querySelectorAll("strong")).map(function (node) { return node.textContent; }),
      };
    }, [], function (result) {
      var expected = '<img src=x onerror="window.notificationMarkupExecuted=true"> & \'Name\'';
      browser.assert.equal(result.value.executed, false);
      browser.assert.equal(result.value.images, 0, "notification values do not create elements");
      browser.assert.ok(result.value.names.includes(expected), "sender name remains literal");
      browser.assert.ok(result.value.names.includes(expected + " grain"), "grain title remains literal");
    })
    .executeAsync(function (id, done) {
      Meteor.call("testNotificationNameFixture", id, true, function (error) {
        done(error ? error.message : null);
      });
    }, [id], function (result) {
      browser.assert.equal(result.value, null, "notification fixture removed");
    }).end();
};
