// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
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

'use strict';

var utils = require('../utils'),
    short_wait = utils.short_wait,
    run_xfail = utils.run_xfail;

module.exports = {
  "Test title" : function (browser) {
    browser
      .init()
      .assert.titleEquals('Sandstorm')
      .captureVisualSnapshot("body", "shell-root-logged-out")
      .end();
  },

  "Test login command" : function (browser) {
    browser
      .loginDevAccount("TestingLogin")
      .disableGuidedTour()
      .waitForElementVisible('.sandstorm-topbar .account>.show-popup', short_wait)
      .assert.textContains(".sandstorm-topbar .account>.show-popup", "TestingLogin")
      .captureVisualSnapshot("body>.sandstorm-topbar", "shell-topbar-logged-in")
      .captureVisualSnapshot(".main-content>.app-list", "apps-page-empty")
      .click(".sandstorm-topbar .account>.show-popup")
      .waitForElementVisible(".topbar-popup.account", short_wait)
      .captureVisualSnapshot(".topbar-popup.account", "account-menu")
      .end();
  },

  "Test setup session clear invalidates token": function (browser) {
    browser
      .url(browser.launch_url + "/")
      .timeouts("script", utils.medium_wait);

    utils.callMeteorTestMethod(browser, "testRegressionSetupSessionClear");

    browser.end();
  },

  "Test OIDC signin URL and index migration coverage": function (browser) {
    browser
      .url(browser.launch_url + "/")
      .timeouts("script", utils.medium_wait);

    utils.callMeteorTestMethod(browser, "testRegressionOidcSigninAndIndexMigration");

    browser.end();
  },

  "Test replica migration coordination": function (browser) {
    browser
      .url(browser.launch_url + "/")
      .timeouts("script", utils.medium_wait);

    utils.callMeteorTestMethod(browser, "testRegressionReplicaMigrationCoordination");

    browser.end();
  },

};
if (run_xfail) {
  // https://github.com/sandstorm-io/sandstorm/issues/3615
  module.exports["Test demo login command"] = function (browser) {
    browser
      .loginDemo()
      .waitForElementVisible('.sandstorm-topbar .account>.show-popup', short_wait)
      .assert.textContains(".sandstorm-topbar .account>.show-popup", "Demo")
      .end();
  };
}
