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
var apiPowerboxSpk = process.env.ISOLATE_API_POWERBOX_TEST_SPK ||
    path.join(repoRoot, "tests/assets/isolate-api-powerbox-test-app.spk");
var apiProviderAppId = "mkhmn9rg2phfv3dvcnd71ud45jp70139h0e3sgqkh6rg2ydk3z00";
var apiProviderSpk = process.env.ISOLATE_API_PROVIDER_TEST_SPK ||
    path.join(repoRoot, "tests/assets/isolate-api-provider-test-app.spk");

function ensureApiPowerboxSpk() {
  if (process.env.ISOLATE_API_POWERBOX_TEST_SPK) return;

  childProcess.execFileSync("make", ["tests/assets/isolate-api-powerbox-test-app.spk"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
}

function ensureApiProviderSpk() {
  if (process.env.ISOLATE_API_PROVIDER_TEST_SPK) return;

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
    .waitForElementVisible(".install-step-confirm", long_wait)
    .click(".confirm-install-button")
    .waitForElementNotPresent(".confirm-install-button", long_wait)
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
    .waitForElementVisible(".install-step-confirm", long_wait)
    .click(".confirm-install-button")
    .waitForElementNotPresent(".confirm-install-button", long_wait)
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

module.exports["Test isolate previewer Powerbox flow"] = function (browser) {
  ensureApiPowerboxSpk();

  installAndOpenExample(browser, apiPowerboxAppId, apiPowerboxSpk)
    .grainFrame()
    .execute(function () {
      window.location.href = "/?isolatePreviewer=1";
    })
    .waitForElementVisible("#isolate-previewer-flow-mode", medium_wait)
    .waitForElementVisible("#connect-api", medium_wait)
    .click("#connect-api")
    .frameParent()
    .waitForElementVisible(
      ".powerbox-card button[data-card-id^=\"frontendref-isolate-previewer-\"]",
      medium_wait)
    .click(".powerbox-card button[data-card-id^=\"frontendref-isolate-previewer-\"]")
    .grainFrame()
    .waitForElementVisible("pre", long_wait)
    .assert.textContains("body", "Saved API capability token present")
    .assert.textContains("pre", "\"ok\": true")
    .assert.textContains("pre", "\"digestBytes\": 32")
    .assert.textContains("pre", "\"compatibilityDate\": \"2025-01-01\"")
    .assert.textContains("pre", "\"worker.js\"")
    .assert.textContains("pre", "\"permissionCount\":")
    .assert.textContains("pre", "\"roleCount\":")
    .waitForElementVisible("#open-isolate-preview", medium_wait)
    .frameParent()
    .url(function (authoringUrl) {
      const authoringGrainId = new URL(authoringUrl.value).pathname.split("/")[2];
      const previewFrame = ".isolate-preview-drawer iframe.grain-frame";
      browser
        .waitForElementVisible(previewFrame, long_wait)
        .frameSelector(previewFrame)
        .waitForElementVisible("body", long_wait)
        .assert.textContains("body", "Powerbox isolate preview")
        .frameParent()
        .waitForElementVisible(".isolate-preview-log-contents > pre", medium_wait)
        .assert.textContains(
          ".isolate-preview-log-contents > pre",
          "Powerbox preview log: Powerbox isolate preview")
        .grainFrame(authoringGrainId)
        .executeAsync(function (done) {
          fetch("/preview-log")
            .then(response => response.json())
            .then(result => {
              const output = document.createElement("pre");
              output.id = "programmatic-preview-log";
              output.textContent = result.text || JSON.stringify(result);
              document.body.append(output);
              done(result.ok === true);
            })
            .catch(error => {
              const output = document.createElement("pre");
              output.id = "programmatic-preview-log";
              output.textContent = error.message || String(error);
              document.body.append(output);
              done(false);
            });
        }, [])
        .waitForElementVisible("#programmatic-preview-log", long_wait)
        .assert.textContains(
          "#programmatic-preview-log",
          "Powerbox preview log: Powerbox isolate preview")
        .executeAsync(function (path, done) {
          fetch(path, { method: "POST" })
            .then(response => response.json())
            .then(result => window.showIsolatePreview(result.call.candidate.normalizedDigest))
            .then(() => done(true))
            .catch(() => done(false));
        }, ["/offer-preview?updated=1"])
        .frameParent()
        .waitForElementVisible(previewFrame, long_wait)
        .frameSelector(previewFrame)
        .waitForElementVisible("body", long_wait)
        .assert.textContains("body", "Powerbox isolate preview updated")
        .frameParent()
        .waitForElementVisible(".isolate-preview-log-contents > pre", medium_wait)
        .assert.textContains(
          ".isolate-preview-log-contents > pre",
          "Powerbox preview log: Powerbox isolate preview updated")
        .grainFrame(authoringGrainId)
        .execute(function () {
          window.location.href = "/";
        })
        .waitForElementVisible("#publish-isolate", medium_wait)
        .click("#publish-isolate")
        .frameParent()
        .waitForElementVisible(
          ".powerbox-card button[data-card-id^=\"frontendref-isolate-publisher-\"]",
          medium_wait)
        .assert.textContains(
          ".powerbox-card button[data-card-id^=\"frontendref-isolate-publisher-\"]",
          "Publish a new app")
        .assert.textContains(
          ".powerbox-card button[data-card-id^=\"frontendref-isolate-publisher-\"]",
          "Powerbox Published Isolate")
        .click(
          ".powerbox-card button[data-card-id^=\"frontendref-isolate-publisher-\"]")
        .grainFrame(authoringGrainId)
        .waitForElementVisible("pre", long_wait)
        .assert.textContains("pre", "\"published\": true")
        .assert.textContains("pre", "\"appVersion\": 1")
        .assert.textContains("pre", "\"title\": \"Powerbox Published Isolate\"")
        .executeAsync(function (path, done) {
          fetch(path, { method: "POST" })
            .then(response => response.json())
            .then(result => window.showIsolatePreview(result.call.candidate.normalizedDigest))
            .then(() => done(true))
            .catch(() => done(false));
        }, ["/offer-preview?updated=2"])
        .frameParent()
        .waitForElementVisible(previewFrame, long_wait)
        .frameSelector(previewFrame)
        .waitForElementVisible("body", long_wait)
        .assert.textContains("body", "Powerbox isolate preview revision two")
        .frameParent()
        .waitForElementVisible(".isolate-preview-log-contents > pre", medium_wait)
        .assert.textContains(
          ".isolate-preview-log-contents > pre",
          "Powerbox preview log: Powerbox isolate preview revision two")
        .grainFrame(authoringGrainId)
        .execute(function () {
          window.location.href = "/";
        })
        .waitForElementVisible("#publish-isolate", medium_wait)
        .click("#publish-isolate")
        .frameParent()
        .waitForElementVisible(
          ".powerbox-card button[data-card-id^=\"frontendref-isolate-publisher-\"]",
          medium_wait)
        .assert.textContains(
          ".powerbox-card button[data-card-id^=\"frontendref-isolate-publisher-\"]",
          "Publish an update to")
        .assert.textContains(
          ".powerbox-card button[data-card-id^=\"frontendref-isolate-publisher-\"]",
          "Current app: Powerbox Published Isolate")
        .click(
          ".powerbox-card button[data-card-id^=\"frontendref-isolate-publisher-\"]")
        .grainFrame(authoringGrainId)
        .waitForElementVisible("pre", long_wait)
        .assert.textContains("pre", "\"published\": true")
        .assert.textContains("pre", "\"appVersion\": 2")
        .assert.textContains("pre", "\"title\": \"Powerbox Published Isolate\"");
    });
};
