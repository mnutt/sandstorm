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

var path = require("path");

var utils = require("../utils"),
    actionSelector = utils.actionSelector,
    short_wait = utils.short_wait,
    medium_wait = utils.medium_wait,
    long_wait = utils.long_wait;

var isolateTestAppId = "d2jw0rpnkydeupwend6dk0ugfkz3xfkygg21awx478pzz29gdtp0";
var isolateTestAppPath = process.env.ISOLATE_TEST_SPK ||
    path.resolve(__dirname, "../../isolate-test-app.spk");

function installAndOpenIsolateTestApp(browser) {
  return browser
    .init()
    .loginDevAccount()
    .url(browser.launch_url + "/upload-test")
    .waitForElementVisible("#upload-app", short_wait)
    .setValue("#upload-app", isolateTestAppPath)
    .waitForElementVisible("#step-confirm", long_wait)
    .click("#confirmInstall")
    .waitForElementNotPresent("#confirmInstall", long_wait)
    .disableGuidedTour()
    .url(browser.launch_url + "/apps/" + isolateTestAppId)
    .waitForElementVisible(actionSelector, long_wait)
    .click(actionSelector)
    .waitForElementVisible("#grainTitle", medium_wait);
}

module.exports["Test isolate grain health and storage after restart"] = function (browser) {
  installAndOpenIsolateTestApp(browser)
    .url(function (grainUrl) {
      browser
        .grainFrame()
        .execute(function () {
          window.location.href = "/browser-storage-test";
        })
        .waitForElementVisible("#health", medium_wait)
        .click("#health")
        .waitForElementVisible("#health-result", medium_wait)
        .assert.textContains("#health-result", "health: ok")
        .click("#write")
        .waitForElementVisible("#write-result", medium_wait)
        .assert.textContains("#write-result", "write: persisted across restart")
        .frameParent()
        .click("#restartGrain")
        .pause(2000)
        .url(grainUrl.value)
        .waitForElementVisible("#grainTitle", medium_wait)
        .grainFrame()
        .execute(function () {
          window.location.href = "/browser-storage-test";
        })
        .waitForElementVisible("#read", medium_wait)
        .click("#read")
        .waitForElementVisible("#read-result", medium_wait)
        .assert.textContains("#read-result", "read: persisted across restart");
    });
};

module.exports["Test isolate browser to worker RPC"] = function (browser) {
  installAndOpenIsolateTestApp(browser)
    .grainFrame()
    .execute(function () {
      window.location.href = "/browser-rpc-test";
    })
    .waitForElementVisible("#run-rpc", medium_wait)
    .click("#run-rpc")
    .waitForElementVisible("#rpc-result", medium_wait)
    .assert.textContains("#rpc-result", "\"ok\":true")
    .assert.textContains("#rpc-result", "\"first\":{\"value\":2}")
    .assert.textContains("#rpc-result", "\"childValue\":{\"value\":5}")
    .assert.textContains("#rpc-result", "\"parentValue\":{\"value\":5}")
    .assert.textContains("#rpc-result", "\"current\":{\"value\":2}");
};
