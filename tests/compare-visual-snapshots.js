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
var Jimp = require("jimp");

var baselineDir = path.resolve(process.argv[2] || "visual-snapshots/master");
var currentDir = path.resolve(process.argv[3] || "visual-snapshots/current");
var reportDir = path.resolve(process.argv[4] || "visual-report");
var diffDir = path.join(reportDir, "diff");
var inlineImages = process.env.VISUAL_REPORT_INLINE_IMAGES === "true";

function walkPngs(root) {
  var result = [];
  if (!fs.existsSync(root)) return result;

  function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function(entry) {
      var fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".png")) {
        result.push(path.relative(root, fullPath));
      }
    });
  }

  walk(root);
  return result.sort();
}

function resolveSnapshotRoot(root) {
  if (walkPngs(root).length > 0) return root;

  var candidates = [
    path.join(root, "current"),
    path.join(root, "visual-snapshots", "current"),
    path.join(root, "tests", "visual-snapshots", "current")
  ];

  for (var ii = 0; ii < candidates.length; ++ii) {
    if (walkPngs(candidates[ii]).length > 0) return candidates[ii];
  }

  return root;
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, function(ch) {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;"
    }[ch];
  });
}

function relToReport(filePath) {
  return path.relative(reportDir, filePath).split(path.sep).join("/");
}

function imageUrl(filePath) {
  if (!inlineImages) return relToReport(filePath);

  return "data:image/png;base64," + fs.readFileSync(filePath).toString("base64");
}

async function compareOne(relativePath) {
  var baselinePath = path.join(baselineDir, relativePath);
  var currentPath = path.join(currentDir, relativePath);
  var hasBaseline = fs.existsSync(baselinePath);
  var hasCurrent = fs.existsSync(currentPath);

  if (!hasBaseline) return { status: "added", relativePath: relativePath, currentPath: currentPath };
  if (!hasCurrent) return { status: "removed", relativePath: relativePath, baselinePath: baselinePath };

  var baseline = await Jimp.read(baselinePath);
  var current = await Jimp.read(currentPath);
  var sameSize = baseline.bitmap.width === current.bitmap.width &&
      baseline.bitmap.height === current.bitmap.height;

  if (!sameSize) {
    return {
      status: "changed",
      relativePath: relativePath,
      baselinePath: baselinePath,
      currentPath: currentPath,
      percent: 1,
      detail: "dimensions differ: " + baseline.bitmap.width + "x" + baseline.bitmap.height +
          " vs " + current.bitmap.width + "x" + current.bitmap.height
    };
  }

  var diff = Jimp.diff(baseline, current);
  if (diff.percent === 0) {
    return {
      status: "unchanged",
      relativePath: relativePath,
      baselinePath: baselinePath,
      currentPath: currentPath,
      percent: 0
    };
  }

  var diffPath = path.join(diffDir, relativePath);
  fs.mkdirSync(path.dirname(diffPath), { recursive: true });
  await diff.image.writeAsync(diffPath);

  return {
    status: "changed",
    relativePath: relativePath,
    baselinePath: baselinePath,
    currentPath: currentPath,
    diffPath: diffPath,
    percent: diff.percent
  };
}

function renderReport(rows) {
  var counts = rows.reduce(function(acc, row) {
    acc[row.status] = (acc[row.status] || 0) + 1;
    return acc;
  }, {});
  var title = "Visual Snapshot Report";

  var body = rows.map(function(row) {
    var cells = [
      "<td><code>" + htmlEscape(row.relativePath) + "</code></td>",
      "<td>" + htmlEscape(row.status) + "</td>",
      "<td>" + (row.percent === undefined ? "" : (row.percent * 100).toFixed(3) + "%") + "</td>",
      "<td>" + htmlEscape(row.detail || "") + "</td>"
    ];
    ["baselinePath", "currentPath", "diffPath"].forEach(function(key) {
      if (row[key]) {
        var url = imageUrl(row[key]);
        cells.push("<td><button class=\"thumbnail-button\" type=\"button\"><img src=\"" +
            htmlEscape(url) + "\"></button></td>");
      } else {
        cells.push("<td></td>");
      }
    });
    return "<tr class=\"" + htmlEscape(row.status) + "\">" + cells.join("") + "</tr>";
  }).join("\n");

  return "<!doctype html>\n" +
    "<meta charset=\"utf-8\">\n" +
    "<title>" + title + "</title>\n" +
    "<style>\n" +
    "body{font-family:system-ui,sans-serif;margin:24px;color:#222}table{border-collapse:collapse;width:100%}" +
    "th,td{border:1px solid #ddd;padding:8px;vertical-align:top}th{background:#f5f5f5;text-align:left}" +
    ".thumbnail-button{appearance:none;background:transparent;border:0;padding:0;cursor:zoom-in;text-align:left}" +
    ".thumbnail-button img{display:block;max-width:320px;max-height:240px;border:1px solid #ccc}" +
    ".changed{background:#fff7e6}.added{background:#eef9ee}.removed{background:#fbeeee}" +
    ".modal{position:fixed;inset:0;z-index:1000;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.82);padding:32px}" +
    ".modal.open{display:flex}.modal img{max-width:96vw;max-height:92vh;background:white;border:1px solid #444;box-shadow:0 12px 48px rgba(0,0,0,.5)}" +
    ".modal-close{position:fixed;top:16px;right:16px;width:40px;height:40px;border:1px solid rgba(255,255,255,.45);border-radius:4px;background:rgba(0,0,0,.55);color:white;font-size:28px;line-height:34px;cursor:pointer}" +
    "code{white-space:nowrap}\n" +
    "</style>\n" +
    "<h1>" + title + "</h1>\n" +
    "<p>Changed: " + (counts.changed || 0) +
    " | Added: " + (counts.added || 0) +
    " | Removed: " + (counts.removed || 0) +
    " | Unchanged: " + (counts.unchanged || 0) + "</p>\n" +
    "<table><thead><tr><th>Snapshot</th><th>Status</th><th>Diff</th><th>Detail</th>" +
    "<th>Baseline</th><th>Current</th><th>Diff image</th></tr></thead><tbody>\n" +
    body + "\n</tbody></table>\n" +
    "<div class=\"modal\" id=\"image-modal\" aria-hidden=\"true\"><button class=\"modal-close\" type=\"button\" aria-label=\"Close\">&times;</button><img alt=\"Expanded visual snapshot\"></div>\n" +
    "<script>\n" +
    "(function(){\n" +
    "  var modal = document.getElementById('image-modal');\n" +
    "  var image = modal.querySelector('img');\n" +
    "  function close(){ modal.classList.remove('open'); modal.setAttribute('aria-hidden','true'); image.removeAttribute('src'); }\n" +
    "  document.addEventListener('click', function(event){\n" +
    "    var target = event.target && event.target.nodeType === 1 ? event.target : event.target.parentElement;\n" +
    "    var button = target && target.closest('.thumbnail-button');\n" +
    "    if (button) { image.src = button.querySelector('img').src; modal.classList.add('open'); modal.setAttribute('aria-hidden','false'); return; }\n" +
    "    if (event.target === modal || event.target.classList.contains('modal-close')) close();\n" +
    "  });\n" +
    "  document.addEventListener('keydown', function(event){ if (event.key === 'Escape') close(); });\n" +
    "}());\n" +
    "</script>\n";
}

async function main() {
  baselineDir = resolveSnapshotRoot(baselineDir);
  currentDir = resolveSnapshotRoot(currentDir);

  fs.mkdirSync(reportDir, { recursive: true });
  fs.mkdirSync(diffDir, { recursive: true });

  var names = Array.from(new Set(walkPngs(baselineDir).concat(walkPngs(currentDir)))).sort();
  var rows = [];
  for (var ii = 0; ii < names.length; ++ii) {
    rows.push(await compareOne(names[ii]));
  }

  fs.writeFileSync(path.join(reportDir, "index.html"), renderReport(rows));
  fs.writeFileSync(path.join(reportDir, "summary.json"), JSON.stringify(rows, null, 2) + "\n");
  console.log("Visual snapshot report written to " + path.relative(process.cwd(), path.join(reportDir, "index.html")));
}

main().catch(function(error) {
  console.error(error && error.stack || error);
  process.exit(1);
});
