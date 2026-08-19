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
    very_short_wait = utils.very_short_wait,
    short_wait = utils.short_wait,
    medium_wait = utils.medium_wait,
    long_wait = utils.long_wait;

var appTitle = "Isolate authoring browser test";
var workerSource = [
  "import { sandstorm } from 'sandstorm:api';",
  "export default {",
  "  async fetch(request, env) {",
  "    const systemResponse = await sandstorm(request, env).serveSystemRoutes();",
  "    if (systemResponse) return systemResponse;",
  "    console.log('isolate authoring browser log marker');",
  "    console.log('<img id=\"isolate-log-injection-probe\" src=\"x\">');",
  "    return new Response(`",
  "      <h1>isolate authoring browser test preview</h1>",
  "      <button id=\"request-preview-powerbox\">Request preview capability</button>",
  "      <pre id=\"preview-powerbox-result\"></pre>",
  "      <script type=\"module\">",
  "        import { apiSessionPowerboxDescriptor, requestPowerbox } from",
  "          '/__sandstorm/native-capnp/client.js';",
  "        const button = document.querySelector('#request-preview-powerbox');",
  "        const output = document.querySelector('#preview-powerbox-result');",
  "        button.addEventListener('click', async () => {",
  "          try {",
  "            const descriptor = await apiSessionPowerboxDescriptor({",
  "              canonicalUrl: 'https://api.example.test/v1',",
  "            });",
  "            const result = await requestPowerbox([descriptor], {",
  "              saveLabel: { defaultText: 'Preview API capability' },",
  "            });",
  "            output.textContent = result.token ? 'preview powerbox granted' : 'missing token';",
  "          } catch (error) {",
  "            output.textContent = error.message || String(error);",
  "          }",
  "        });",
  "        button.dataset.powerboxReady = 'true';",
  "      </script>",
  "    `, {",
  "      headers: { 'content-type': 'text/html; charset=UTF-8' },",
  "    });",
  "  },",
  "};",
].join("\n");
var workerSourceRevisionTwo = workerSource.replace(
  "<h1>isolate authoring browser test preview</h1>",
  "<h1 id=\"isolate-revision-two\">isolate authoring browser test revision two</h1>",
);
var workerSourceRevisionThree = workerSource.replace(
  "<h1>isolate authoring browser test preview</h1>",
  "<h1 id=\"isolate-revision-three\">isolate authoring browser test revision three</h1>",
);
var previewFrameSelector = ".isolate-inline-preview iframe.grain-frame";

function waitForStableReplacementFrame(previousSrc) {
  var observedSrc;
  var observedAt;
  return async function () {
    var currentSrc = await this.getAttribute(previewFrameSelector, "src");
    if (!currentSrc || currentSrc === previousSrc()) {
      observedSrc = null;
      observedAt = null;
      return false;
    }

    if (currentSrc !== observedSrc) {
      observedSrc = currentSrc;
      observedAt = Date.now();
      return false;
    }

    return Date.now() - observedAt >= 500;
  };
}

module.exports["Test built-in isolate authoring flow"] = function (browser) {
  var previousPreviewDigest;
  var previousPreviewFrameSrc;

  browser
    .init()
    .loginDevAccount()
    .disableGuidedTour()
    .url(browser.launch_url + "/apps")
    .waitForElementVisible(".create-isolate-app", short_wait)
    .click(".create-isolate-app")
    .waitForElementVisible(".isolate-authoring-page", short_wait)
    .click(".edit-app-details")
    .waitForElementVisible(".edit-app-details-form", short_wait)
    .clearValue(".edit-app-details-form input[name=title]")
    .setValue(".edit-app-details-form input[name=title]", appTitle)
    .click(".save-app-details")
    .waitForElementNotPresent(".edit-app-details-form", short_wait)
    .assert.textContains(".isolate-authoring-app-title", appTitle)
    .clearValue("textarea[name=source]")
    .setValue("textarea[name=source]", "export default {")
    .click(".preview-draft")
    .waitForElementVisible(".isolate-source-error", long_wait)
    .assert.textContains(".isolate-source-error", "worker.js is not valid JavaScript")
    .clearValue("textarea[name=source]")
    .setValue("textarea[name=source]", workerSource)
    .waitForElementPresent(".source-highlight .sh__token--keyword", short_wait)
    .execute(function () {
      var highlight = document.querySelector(".source-highlight");
      var line = highlight.querySelector(".sh__line");
      var textarea = document.querySelector(".source-editor textarea");
      var highlightStyle = getComputedStyle(highlight);
      var lineStyle = getComputedStyle(line);
      var numberStyle = getComputedStyle(line, "::before");
      var textareaStyle = getComputedStyle(textarea);
      var highlightedCodeInset = parseFloat(highlightStyle.paddingLeft) +
        parseFloat(lineStyle.paddingLeft);
      return {
        numberWidth: parseFloat(numberStyle.width),
        aligned: Math.abs(highlightedCodeInset - parseFloat(textareaStyle.paddingLeft)) < 0.1,
      };
    }, [], function (response) {
      browser.assert.ok(response.value.numberWidth > 0, "source editor displays a line-number gutter");
      browser.assert.ok(response.value.aligned, "line-number gutter preserves editor alignment");
    })
    .assert.not.elementPresent("#isolate-log-injection-probe")
    .click(".preview-draft")
    .waitForElementVisible(".isolate-inline-preview iframe.grain-frame", long_wait)
    .assert.not.elementPresent(".isolate-source-error")
    .frameSelector(previewFrameSelector)
    .waitForElementVisible("h1", medium_wait)
    .assert.textContains("h1", "isolate authoring browser test preview")
    .waitForElementVisible("#request-preview-powerbox[data-powerbox-ready=true]", medium_wait)
    .click("#request-preview-powerbox")
    .frameParent()
    .waitForElementVisible(
      ".powerbox-card button[data-card-id=\"http-url-https://api.example.test/v1\"]",
      medium_wait)
    .click(".powerbox-card button[data-card-id=\"http-url-https://api.example.test/v1\"]")
    .frameSelector(previewFrameSelector)
    .waitForElementVisible("#preview-powerbox-result", medium_wait)
    .assert.textContains("#preview-powerbox-result", "preview powerbox granted")
    .frameParent()
    .waitForElementVisible(".isolate-preview-log-contents > pre", medium_wait)
    .assert.textContains(
      ".isolate-preview-log-contents > pre", "isolate authoring browser log marker")
    .assert.textContains(
      ".isolate-preview-log-contents > pre", "isolate-log-injection-probe")
    .assert.not.elementPresent("#isolate-log-injection-probe")
    .assert.attributeEquals(".toggle-isolate-preview-log", "aria-expanded", "true")
    .click(".toggle-isolate-preview-log")
    .assert.attributeContains(".isolate-preview-log-mount", "class", "collapsed")
    .assert.attributeEquals(".toggle-isolate-preview-log", "aria-expanded", "false")
    // The toggle moves while its 120ms height transition runs. Let it settle before clicking again.
    .pause(150)
    .click(".toggle-isolate-preview-log")
    .assert.attributeEquals(".toggle-isolate-preview-log", "aria-expanded", "true")
    .getAttribute(".isolate-preview-title code", "title", function (result) {
      previousPreviewDigest = result.value;
    })
    .getAttribute(previewFrameSelector, "src", function (result) {
      previousPreviewFrameSrc = result.value;
    })
    .clearValue("textarea[name=source]")
    .setValue("textarea[name=source]", workerSourceRevisionTwo)
    .click(".preview-draft")
    .waitUntil(async function () {
      var currentDigest = await this.getAttribute(".isolate-preview-title code", "title");
      return currentDigest && currentDigest !== previousPreviewDigest;
    }, long_wait, short_wait, "Preview revision did not produce a new candidate")
    .waitUntil(waitForStableReplacementFrame(() => previousPreviewFrameSrc),
      long_wait, very_short_wait, "Preview revision did not settle on a replacement frame session")
    .frameSelector(previewFrameSelector)
    .waitForElementVisible("#isolate-revision-two", medium_wait)
    .assert.textContains("#isolate-revision-two", "isolate authoring browser test revision two")
    .frameParent()
    .getAttribute(previewFrameSelector, "src", function (result) {
      previousPreviewFrameSrc = result.value;
    })
    .click(".reload-inline-preview")
    .waitUntil(waitForStableReplacementFrame(() => previousPreviewFrameSrc),
      long_wait, very_short_wait, "Preview reload did not settle on a replacement frame session")
    .frameSelector(previewFrameSelector)
    .waitForElementVisible("#isolate-revision-two", medium_wait)
    .assert.textContains("#isolate-revision-two", "isolate authoring browser test revision two")
    .frameParent()
    .click(".reset-preview")
    .waitForElementNotPresent(".operation-status.working", long_wait)
    .assert.textContains(".operation-status.success", "Preview data was reset")
    .waitForElementVisible(".isolate-inline-preview iframe.grain-frame", long_wait)
    .click(".open-publish-modal")
    .waitForElementVisible(".publish-isolate-form", short_wait)
    .assert.textContains(".publish-destination", "Publishing as a new app")
    .assert.not.elementPresent(".publish-target")
    .assert.not.textContains(".publish-destination code", "…")
    .assert.textContains(".publish-candidate-review", "Compatibility date")
    .assert.textContains(".publish-candidate-review", "2025-01-01")
    .assert.textContains(".publish-candidate-review", "Compatibility flags")
    .assert.textContains(".publish-candidate-review", "Platform bindings")
    .assert.textContains(".publish-candidate-review", "SANDSTORM_API")
    .assert.textContains(".publish-candidate-review", "POWERBOX")
    .assert.textContains(".publish-candidate-review", "STORAGE")
    .assert.textContains(".publish-candidate-review", "Validation warnings")
    .click(".confirm-publish")
    .waitForElementNotPresent(".publish-isolate-form", long_wait)
    .assert.textContains(".operation-status.success", "version 1")
    .getAttribute(".isolate-preview-title code", "title", function (result) {
      previousPreviewDigest = result.value;
    })
    .getAttribute(previewFrameSelector, "src", function (result) {
      previousPreviewFrameSrc = result.value;
    })
    .clearValue("textarea[name=source]")
    .setValue("textarea[name=source]", workerSourceRevisionThree)
    .click(".preview-draft")
    .waitUntil(async function () {
      var currentDigest = await this.getAttribute(".isolate-preview-title code", "title");
      return currentDigest && currentDigest !== previousPreviewDigest;
    }, long_wait, short_wait, "Third preview did not produce a new candidate")
    .waitUntil(waitForStableReplacementFrame(() => previousPreviewFrameSrc),
      long_wait, very_short_wait, "Third preview did not settle on a replacement frame session")
    .waitForElementVisible(".open-publish-modal:not([disabled])", long_wait)
    .frameSelector(previewFrameSelector)
    .waitForElementVisible("#isolate-revision-three", long_wait)
    .assert.textContains("#isolate-revision-three", "isolate authoring browser test revision three")
    .frameParent()
    .click(".open-publish-modal")
    .waitForElementVisible(".revision-history", short_wait)
    .assert.textContains(
      ".publish-destination", "Publishing version 2 of " + appTitle)
    .assert.textContains(".revision-history", "Version 1")
    .assert.not.textContains(".revision-history code", "…")
    .click(".confirm-publish")
    .waitForElementNotPresent(".publish-isolate-form", long_wait)
    .assert.textContains(".operation-status.success", "version 2")
    .url(browser.launch_url + "/apps")
    .waitForElementVisible(".app-list .app-button[data-app-id]", long_wait)
    .assert.textContains(".app-list", appTitle)
    .url(browser.launch_url + "/grain")
    .waitForElementVisible(".grain-list", short_wait)
    .waitForElementVisible(".no-grains", short_wait)
    .assert.not.textContains(".grain-list", appTitle);
};
