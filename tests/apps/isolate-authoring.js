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
    actionSelector = utils.actionSelector,
    short_wait = utils.short_wait,
    medium_wait = utils.medium_wait,
    long_wait = utils.long_wait;

var appTitle = "Isolate authoring browser test";
var workerSource = [
  "export default {",
  "  fetch() {",
  "    console.log('isolate authoring browser log marker');",
  "    return new Response('<h1>isolate authoring browser test preview</h1>', {",
  "      headers: { 'content-type': 'text/html; charset=UTF-8' },",
  "    });",
  "  },",
  "};",
].join("\n");
var workerSourceRevisionTwo = workerSource.replace(
  "isolate authoring browser test preview",
  "isolate authoring browser test revision two",
);

module.exports["Test built-in isolate authoring flow"] = function (browser) {
  browser
    .init()
    .loginDevAccount()
    .disableGuidedTour()
    .url(browser.launch_url + "/apps")
    .waitForElementVisible(".create-isolate-app", short_wait)
    .click(".create-isolate-app")
    .waitForElementVisible(".isolate-authoring-page", short_wait)
    .clearValue("input[name=title]")
    .setValue("input[name=title]", appTitle)
    .clearValue("textarea[name=source]")
    .setValue("textarea[name=source]", workerSource)
    .click(".authoring-actions button[type=submit]")
    .waitForElementVisible(".operation-status.success", long_wait)
    .assert.textContains(".operation-status.success", "Preview is ready")
    .waitForElementVisible(".candidate-review dd code", short_wait)
    .waitForElementVisible(".isolate-inline-preview iframe.grain-frame", long_wait)
    .grainFrame()
    .waitForElementVisible("body", medium_wait)
    .assert.textContains("body", "isolate authoring browser test preview")
    .frameParent()
    .click(".isolate-preview-actions a[href^='/grainlog/']")
    .windowHandles(function (logWindows) {
      browser
        .switchWindow(logWindows.value[1])
        .waitForElementVisible(".grainlog-contents > pre", medium_wait)
        .assert.textContains(
          ".grainlog-contents > pre", "isolate authoring browser log marker")
        .closeWindow()
        .switchWindow(logWindows.value[0])
        .clearValue("textarea[name=source]")
        .setValue("textarea[name=source]", workerSourceRevisionTwo)
        .click(".authoring-actions button[type=submit]")
        .waitForElementVisible(".operation-status.success", long_wait)
        .grainFrame()
        .waitForElementVisible("body", medium_wait)
        .assert.textContains("body", "isolate authoring browser test revision two")
        .frameParent()
        .click(".reload-inline-preview")
        .grainFrame()
        .waitForElementVisible("body", medium_wait)
        .assert.textContains("body", "isolate authoring browser test revision two")
        .frameParent()
        .click(".reset-preview")
        .waitForElementNotPresent(".operation-status.working", long_wait)
        .assert.textContains(".operation-status.success", "Preview data was reset")
        .waitForElementVisible(".isolate-inline-preview iframe.grain-frame", long_wait)
        .click(".publish-new")
        .waitForElementVisible(".published-result", long_wait)
        .assert.textContains(".published-result", appTitle)
        .click(".published-result a")
        .waitForElementVisible(actionSelector, long_wait)
        .url(browser.launch_url + "/grain")
        .waitForElementVisible(".grain-list", short_wait)
        .waitForElementVisible(".no-grains", short_wait)
        .assert.not.textContains(".grain-list", appTitle);
    });
};
