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
    short_wait = utils.short_wait,
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

module.exports["Test admin pages"] = function (browser) {
  browser
    .loginDevAccount("AdminVisualSnapshots", true)
    .disableGuidedTour()

    .url(browser.launch_url + "/admin")
    .waitForElementVisible(".admin-settings nav .nav-items", medium_wait)
    .captureVisualSnapshot(".admin-settings", "admin-root")

    .url(browser.launch_url + "/admin/users")
    .waitForElementVisible(".admin-user-table", medium_wait)
    .captureVisualSnapshot(".admin-settings", "admin-users")

    .url(browser.launch_url + "/admin/login")
    .waitForElementVisible(".login-provider-table", medium_wait)
    .captureVisualSnapshot(".admin-settings", "admin-identity-providers")

    .url(browser.launch_url + "/admin/email")
    .waitForElementVisible("form.email-form", medium_wait)
    .captureVisualSnapshot(".admin-settings", "admin-email")

    .url(browser.launch_url + "/admin/organization")
    .waitForElementVisible("form.admin-organization-management-form", medium_wait)
    .captureVisualSnapshot(".admin-settings", "admin-organization")

    .url(browser.launch_url + "/admin/app-sources")
    .waitForElementVisible("form.admin-app-sources", medium_wait)
    .captureVisualSnapshot(".admin-settings", "admin-app-sources")

    .url(browser.launch_url + "/admin/preinstalled-apps")
    .waitForElementVisible("form.admin-preinstalled-apps", medium_wait)
    .captureVisualSnapshot(".admin-settings", "admin-preinstalled-apps")

    .url(browser.launch_url + "/admin/certificates")
    .waitForElementVisible(".admin-certificates", medium_wait)
    .captureVisualSnapshot(".admin-settings", "admin-certificates")

    .url(browser.launch_url + "/admin/personalization")
    .waitForElementVisible("form.admin-personalization-form", medium_wait)
    .captureVisualSnapshot(".admin-settings", "admin-personalization")

    .url(browser.launch_url + "/admin/networking")
    .waitForElementVisible("form.admin-networking", medium_wait)
    .captureVisualSnapshot(".admin-settings", "admin-networking")

    .url(browser.launch_url + "/admin/maintenance")
    .waitForElementVisible("form.maintenance-message-form", medium_wait)
    .captureVisualSnapshot(".admin-settings", "admin-maintenance")

    .url(browser.launch_url + "/admin/network-capabilities")
    .waitForElementVisible(".admin-caps-table", medium_wait)
    .captureVisualSnapshot(".admin-settings", "admin-network-capabilities")

    .url(browser.launch_url + "/admin/stats")
    .waitForElementVisible("form.stats-json", medium_wait)
    .captureVisualSnapshot(".admin-settings", "admin-stats")

    .url(browser.launch_url + "/admin/hosting-management")
    .waitForElementVisible("form.admin-hosting-management-form", medium_wait)
    .captureVisualSnapshot(".admin-settings", "admin-hosting-management")

    .url(browser.launch_url + "/admin/status")
    .waitForElementVisible(".admin-log-box", medium_wait)
    .pause(short_wait)
    .captureVisualSnapshot(".admin-settings", "admin-status")
    .end();
};
