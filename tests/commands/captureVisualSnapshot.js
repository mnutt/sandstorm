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

  function finish(result) {
    browser.execute(function() {
      if (window.__restoreVisualSnapshotDom) {
        window.__restoreVisualSnapshotDom();
      }
    }, [], function() {
      if (typeof callback === "function") {
        callback.call(browser, result);
      }
    });
  }

  function takeScreenshot() {
    return browser.screenshot(false, function(result) {
      var screenshotData = typeof result === "string" ? result : result && result.value;

      if (!screenshotData || result && result.status === -1) {
        console.warn("Skipping visual snapshot " + name + ": no screenshot data near " + selector);
        return finish({ status: -1, value: null });
      }

      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, screenshotData, "base64");
      console.log("Visual snapshot written: " + path.relative(process.cwd(), filePath));

      return finish({ status: 0, value: filePath });
    });
  }

  return browser.execute(function() {
    if (window.__restoreVisualSnapshotDom) {
      window.__restoreVisualSnapshotDom();
    }

    var restorers = [];

    function remember(node, restore) {
      restorers.push(function() {
        if (node && node.isConnected) restore();
      });
    }

    function stableText(value) {
      return String(value)
        .replace(/A[0-9a-f]{20}/g, "AVisualUser")
        .replace(/\b[0-9a-f]{20}\b/g, "VisualUser")
        .replace(/\/shared\/[A-Za-z0-9_-]+/g, "/shared/VISUALTOKEN")
        .replace(/\/grain\/[A-Za-z0-9_-]+/g, "/grain/VISUALGRAIN")
        .replace(/ui-[0-9a-f]+/g, "ui-visual");
    }

    function setText(selector, value) {
      Array.prototype.forEach.call(document.querySelectorAll(selector), function(node) {
        var oldText = node.textContent;
        var oldTitle = node.getAttribute("title");
        remember(node, function() {
          node.textContent = oldText;
          if (oldTitle === null) {
            node.removeAttribute("title");
          } else {
            node.setAttribute("title", oldTitle);
          }
        });

        node.textContent = value;
        node.setAttribute("title", value);
      });
    }

    function normalizeTextNodes(root) {
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
      var nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);

      nodes.forEach(function(node) {
        var stable = stableText(node.nodeValue);
        if (stable !== node.nodeValue) {
          var oldValue = node.nodeValue;
          remember(node, function() {
            node.nodeValue = oldValue;
          });
          node.nodeValue = stable;
        }
      });
    }

    function normalizeFormValues() {
      Array.prototype.forEach.call(document.querySelectorAll("input, textarea"), function(node) {
        if (typeof node.value === "string") {
          var stable = stableText(node.value);
          if (stable !== node.value) {
            var oldValue = node.value;
            remember(node, function() {
              node.value = oldValue;
            });
            node.value = stable;
          }
        }
      });
    }

    function normalizeProfilePictures() {
      Array.prototype.forEach.call(document.querySelectorAll(
          ".profile-picture, .profile-picture-name .profile-picture, .picture"), function(node) {
        var oldBackgroundImage = node.style.backgroundImage;
        var oldBackgroundColor = node.style.backgroundColor;
        remember(node, function() {
          node.style.backgroundImage = oldBackgroundImage;
          node.style.backgroundColor = oldBackgroundColor;
        });

        node.style.backgroundImage = "none";
        node.style.backgroundColor = "#d8dee6";
      });

      Array.prototype.forEach.call(document.querySelectorAll(
          "[data-card-id^='frontendref-identity-']"), function(node) {
        var oldBackgroundImage = node.style.backgroundImage;
        var oldBackgroundColor = node.style.backgroundColor;
        remember(node, function() {
          node.style.backgroundImage = oldBackgroundImage;
          node.style.backgroundColor = oldBackgroundColor;
        });

        node.style.backgroundImage = "none";
        node.style.backgroundColor = "#d8dee6";
      });

      Array.prototype.forEach.call(document.querySelectorAll(".picture-box img"), function(node) {
        var oldSrc = node.getAttribute("src");
        var oldBackground = node.style.background;
        var oldBackgroundColor = node.style.backgroundColor;
        remember(node, function() {
          if (oldSrc === null) {
            node.removeAttribute("src");
          } else {
            node.setAttribute("src", oldSrc);
          }
          node.style.background = oldBackground;
          node.style.backgroundColor = oldBackgroundColor;
        });

        node.setAttribute("src", "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==");
        node.style.backgroundColor = "#d8dee6";
      });
    }

    setText(".notification-timestamp", "Jan 1, 2026");
    setText(".last-used", "Jan 1, 2026");
    setText(".admin-user-table .created[role='gridcell']", "Jan 1, 2026");
    setText(".admin-user-table .last-active[role='gridcell']", "Jan 1, 2026");
    setText(".admin-caps-table .grant-time[role='gridcell']", "Jan 1, 2026");
    setText(".package-info .last-update .content", "Jan 1, 2026");
    setText(".grainlog-contents pre", "[visual snapshot log output]");

    normalizeTextNodes(document.body);
    normalizeFormValues();
    normalizeProfilePictures();

    window.__restoreVisualSnapshotDom = function() {
      for (var ii = restorers.length - 1; ii >= 0; --ii) {
        restorers[ii]();
      }

      delete window.__restoreVisualSnapshotDom;
    };
  }, [], function() {
    takeScreenshot();
  });
};
