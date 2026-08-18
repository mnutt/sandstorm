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
    medium_wait = utils.medium_wait,
    long_wait = utils.long_wait;

var appTitle = "Isolate authoring browser test";
var workerSource = [
  "export default {",
  "  fetch() {",
  "    console.log('isolate authoring browser log marker');",
  "    console.log('<img id=\"isolate-log-injection-probe\" src=\"x\">');",
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
var workerSourceRevisionThree = workerSource.replace(
  "isolate authoring browser test preview",
  "isolate authoring browser test revision three",
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
    .click(".edit-app-details")
    .waitForElementVisible(".edit-app-details-form", short_wait)
    .clearValue(".edit-app-details-form input[name=title]")
    .setValue(".edit-app-details-form input[name=title]", appTitle)
    .click(".save-app-details")
    .waitForElementNotPresent(".edit-app-details-form", short_wait)
    .assert.textContains(".isolate-authoring-app-title", appTitle)
    .clearValue("textarea[name=source]")
    .setValue("textarea[name=source]", workerSource)
    .click(".preview-draft")
    .waitForElementVisible(".isolate-inline-preview iframe.grain-frame", long_wait)
    .grainFrame()
    .waitForElementVisible("body", medium_wait)
    .assert.textContains("body", "isolate authoring browser test preview")
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
    .click(".toggle-isolate-preview-log")
    .assert.attributeEquals(".toggle-isolate-preview-log", "aria-expanded", "true")
    .clearValue("textarea[name=source]")
    .setValue("textarea[name=source]", workerSourceRevisionTwo)
    .click(".preview-draft")
    .waitForElementNotPresent(".operation-status.working", long_wait)
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
    .click(".open-publish-modal")
    .waitForElementVisible(".publish-isolate-form", short_wait)
    .assert.textContains(".publish-destination", "Publishing as a new app")
    .assert.not.elementPresent(".publish-target")
    .assert.not.textContains(".publish-destination code", "…")
    .click(".confirm-publish")
    .waitForElementNotPresent(".publish-isolate-form", long_wait)
    .assert.textContains(".operation-status.success", "version 1")
    .clearValue("textarea[name=source]")
    .setValue("textarea[name=source]", workerSourceRevisionThree)
    .click(".preview-draft")
    .waitForElementVisible(".open-publish-modal:not([disabled])", long_wait)
    .grainFrame()
    .waitForElementVisible("body", long_wait)
    .assert.textContains("body", "isolate authoring browser test revision three")
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
