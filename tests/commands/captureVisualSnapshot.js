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

var fs = require("fs");
var path = require("path");

function safePathSegment(value) {
  return String(value || "unknown")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

exports.command = function(selector, name, callback) {
  var browser = this;
  var moduleName = browser.currentTest && browser.currentTest.module || "unknown";
  var browserName = browser.capabilities && browser.capabilities.browserName || "browser";
  var platformName = browser.capabilities && (
    browser.capabilities.platformName ||
    browser.capabilities.platform ||
    browser.capabilities.os);
  var snapshotRoot = process.env.VISUAL_SNAPSHOT_DIR ||
      path.join(process.cwd(), "visual-snapshots", "current");
  var filePath = path.join(
    snapshotRoot,
    safePathSegment(browserName + "_" + (platformName || "unknown")),
    safePathSegment(moduleName),
    safePathSegment(name) + ".png");

  return browser.takeElementScreenshot(selector, function(result) {
    var screenshotData = typeof result === "string" ? result : result && result.value;

    if (!screenshotData || result && result.status === -1) {
      console.warn("Skipping visual snapshot " + name + ": no screenshot data for " + selector);
      if (typeof callback === "function") {
        callback.call(browser, { status: -1, value: null });
      }

      return;
    }

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, screenshotData, "base64");
    console.log("Visual snapshot written: " + path.relative(process.cwd(), filePath));

    if (typeof callback === "function") {
      callback.call(browser, { status: 0, value: filePath });
    }
  });
};
