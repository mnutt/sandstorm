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
var apiPowerboxSpk = path.join(repoRoot, "tests/assets/isolate-api-powerbox-test-app.spk");
var apiProviderAppId = "mkhmn9rg2phfv3dvcnd71ud45jp70139h0e3sgqkh6rg2ydk3z00";
var apiProviderSpk = path.join(repoRoot, "tests/assets/isolate-api-provider-test-app.spk");

function ensureApiPowerboxSpk() {
  childProcess.execFileSync("make", ["tests/assets/isolate-api-powerbox-test-app.spk"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
}

function ensureApiProviderSpk() {
  childProcess.execFileSync("make", ["tests/assets/isolate-api-provider-test-app.spk"], {
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

function uploadAndOpenExample(browser, appId, spkPath) {
  return browser
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

module.exports["Test isolate API Powerbox provider flow"] = function (browser) {
  ensureApiPowerboxSpk();
  ensureApiProviderSpk();

  installAndOpenExample(browser, apiProviderAppId, apiProviderSpk)
    .grainFrame()
    .waitForElementVisible("#fulfill-api", medium_wait)
    .frameParent()
    .url(function (providerGrainUrl) {
      var providerGrainId = providerGrainUrl.value.split("/").pop();
      var providerCardSelector =
          ".powerbox-card button[data-card-id=\"grain-" + providerGrainId + "\"]";

      uploadAndOpenExample(browser, apiPowerboxAppId, apiPowerboxSpk)
        .grainFrame()
        .execute(function () {
          window.location.href = "/?providerFlow=1";
        })
        .waitForElementVisible("#provider-flow-mode", medium_wait)
        .waitForElementVisible("#connect-api", medium_wait)
        .click("#connect-api")
        .frameParent()
        .waitForElementVisible(providerCardSelector, medium_wait)
        .click(providerCardSelector)
        .waitForElementVisible(".powerbox-iframe-mount iframe", medium_wait)
        .frameSelector(".powerbox-iframe-mount iframe")
        .waitForElementVisible("#fulfill-api", medium_wait)
        .click("#fulfill-api")
        .frameParent()
        .grainFrame()
        .waitForElementVisible("pre", medium_wait)
        .assert.textContains("body", "Saved API capability token present")
        .assert.textContains("pre", "\"ok\": true")
        .assert.textContains("pre", "\"capabilityClass\": true")
        .assert.textContains("pre", "\"savedClass\": true")
        .assert.textContains("pre", "\"source\": \"isolate-capability-provider\"");
    });
};

module.exports["Test isolate app-object feed provider flow"] = function (browser) {
  ensureApiPowerboxSpk();
  ensureApiProviderSpk();

  installAndOpenExample(browser, apiProviderAppId, apiProviderSpk)
    .grainFrame()
    .waitForElementVisible("#fulfill-feed", medium_wait)
    .frameParent()
    .url(function (providerGrainUrl) {
      var providerGrainId = providerGrainUrl.value.split("/").pop();
      var providerCardSelector =
          ".powerbox-card button[data-card-id=\"grain-" + providerGrainId + "\"]";

      uploadAndOpenExample(browser, apiPowerboxAppId, apiPowerboxSpk)
        .grainFrame()
        .execute(function () {
          window.location.href = "/?feedFlow=1";
        })
        .waitForElementVisible("#feed-flow-mode", medium_wait)
        .waitForElementVisible("#connect-api", medium_wait)
        .click("#connect-api")
        .frameParent()
        .waitForElementVisible(providerCardSelector, medium_wait)
        .click(providerCardSelector)
        .waitForElementVisible(".powerbox-iframe-mount iframe", medium_wait)
        .frameSelector(".powerbox-iframe-mount iframe")
        .waitForElementVisible("#fulfill-feed", medium_wait)
        .click("#fulfill-feed")
        .frameParent()
        .grainFrame()
        .waitForElementVisible("pre", medium_wait)
        .assert.textContains("body", "Saved API capability token present")
        .assert.textContains("pre", "\"ok\": true")
        .assert.textContains("pre", "\"capabilityClass\": true")
        .assert.textContains("pre", "\"savedClass\": true")
        .assert.textContains("pre", "\"mode\": \"live\"")
        .assert.textContains("pre", "\"subject\": \"isolate-feed-live-callback\"")
        .assert.textContains("pre", "\"mode\": \"saved\"")
        .assert.textContains("pre", "\"subject\": \"isolate-feed-saved-callback\"")
        .assert.textContains("pre", "\"storageKey\": \"isolate-feed-receiver-token\"");
    });
};
