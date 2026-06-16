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

var childProcess = require("child_process");
var path = require("path");

var utils = require("../utils"),
    actionSelector = utils.actionSelector,
    short_wait = utils.short_wait,
    medium_wait = utils.medium_wait,
    long_wait = utils.long_wait;

var repoRoot = path.resolve(__dirname, "../..");
var apiPowerboxAppId = "8djwvme6h49v5p2zj57gatq698pyx4nkdnwgjpzfctgunfrzh4p0";
var apiPowerboxSpk = path.join(repoRoot, "isolate-api-powerbox-test-app.spk");

function ensureApiPowerboxSpk() {
  childProcess.execFileSync("make", [
    "isolate-api-powerbox-test-app.spk",
  ], {
    cwd: repoRoot,
    stdio: "inherit",
  });
}

function installAndOpenExample(browser, appId, spkPath) {
  return browser
    .init()
    .loginDevAccount()
    .url(browser.launch_url + "/upload-test")
    .waitForElementVisible("#upload-app", short_wait)
    .setValue("#upload-app", spkPath)
    .waitForElementVisible("#step-confirm", long_wait)
    .click("#confirmInstall")
    .waitForElementNotPresent("#confirmInstall", long_wait)
    .disableGuidedTour()
    .url(browser.launch_url + "/apps/" + appId)
    .waitForElementVisible(actionSelector, long_wait)
    .click(actionSelector)
    .waitForElementVisible("#grainTitle", medium_wait);
}

module.exports["Test isolate API Powerbox example consumer flow"] = function (browser) {
  ensureApiPowerboxSpk();

  installAndOpenExample(browser, apiPowerboxAppId, apiPowerboxSpk)
    .grainFrame()
    .execute(function () {
      window.location.href = "/?skipApiCall=1";
    })
    .waitForElementVisible("#connect-api", medium_wait)
    .click("#connect-api")
    .frameParent()
    .waitForElementVisible(
      ".powerbox-card button[data-card-id=\"http-url-https://api.example.test/v1\"]",
      medium_wait)
    .click(".powerbox-card button[data-card-id=\"http-url-https://api.example.test/v1\"]")
    .grainFrame()
    .waitForElementVisible("pre", medium_wait)
    .assert.textContains("body", "Saved API capability token present")
    .assert.textContains("pre", "\"ok\": true")
    .assert.textContains("pre", "\"capabilityClass\": true")
    .assert.textContains("pre", "\"savedClass\": true")
    .assert.textContains("pre", "\"skipped\": true");
};
