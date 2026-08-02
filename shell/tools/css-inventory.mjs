#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const styleRoots = [
  path.join(root, "client", "styles"),
  path.join(root, "imports", "client"),
  path.join(root, "imports", "sandstorm-ui-powerbox"),
  path.join(root, "imports", "sandstorm-ui-topbar"),
];

const options = new Map();
let check = false;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "--json") {
    options.set("format", "json");
  } else if (arg === "--markdown") {
    options.set("format", "markdown");
  } else if (arg === "--check") {
    check = true;
  } else if (arg === "--help" || arg === "-h") {
    printHelp();
    process.exit(0);
  } else {
    console.error(`Unknown option: ${arg}`);
    printHelp();
    process.exit(1);
  }
}

const format = options.get("format") || "markdown";

for (const styleRoot of styleRoots) {
  if (!fs.existsSync(styleRoot)) {
    console.error(`Expected styles directory at ${styleRoot}`);
    process.exit(1);
  }
}

const styleFiles = styleRoots
  .flatMap((styleRoot) => collectStyleFiles(styleRoot))
  .sort();

const inventory = styleFiles.map((fileName) => {
  const source = fs.readFileSync(fileName, "utf8");
  const lines = source.split(/\r?\n/);
  const selectors = collectSelectors(lines);
  const imports = collectImports(source);
  const metrics = {
    lines: lines.length,
    bytes: Buffer.byteLength(source),
    selectors: selectors.length,
    topLevelSelectors: selectors.filter((selector) => selector.indent === 0).length,
    bodySelectors: selectors.filter((selector) => selector.selector.includes("body")).length,
    idSelectors: selectors.filter((selector) => /(^|[\s>+~,])#[A-Za-z0-9_-]+/.test(selector.selector)).length,
    important: countMatches(source, /!important/g),
    extends: countMatches(source, /@extend\b/g),
    mixins: countMatches(source, /@mixin\b/g),
    placeholders: countMatches(source, /(^|\s)%[A-Za-z0-9_-]+\s*\{/gm),
    mediaQueries: countMatches(source, /@media\b/g),
  };

  return {
    file: path.relative(root, fileName),
    imports,
    metrics,
    topLevelSelectors: selectors
      .filter((selector) => selector.indent === 0)
      .slice(0, 12)
      .map((selector) => selector.selector),
  };
});

const totals = inventory.reduce((acc, item) => {
  for (const [key, value] of Object.entries(item.metrics)) {
    acc[key] = (acc[key] || 0) + value;
  }

  return acc;
}, {});

const rankedRisk = [...inventory]
  .map((item) => ({
    ...item,
    risk: item.metrics.bodySelectors * 4 +
      item.metrics.idSelectors * 3 +
      item.metrics.important * 3 +
      item.metrics.extends * 2 +
      Math.ceil(item.metrics.lines / 250),
  }))
  .sort((a, b) => b.risk - a.risk || b.metrics.lines - a.metrics.lines);

const report = {
  generatedAt: new Date().toISOString(),
  styleRoots: styleRoots.map((styleRoot) => path.relative(root, styleRoot)),
  totals,
  files: inventory,
  rankedRisk: rankedRisk.map(({ file, risk, metrics }) => ({ file, risk, metrics })),
};

if (check) {
  const errors = checkOrganization(report);
  if (errors.length > 0) {
    console.error("CSS organization check failed:");
    for (const error of errors) {
      console.error(`- ${error}`);
    }

    process.exit(1);
  }

  console.log("CSS organization check passed.");
} else if (format === "json") {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(renderMarkdown(report));
}

function printHelp() {
  console.log("Usage: npm run css:inventory [-- --markdown|--json|--check]");
}

function countMatches(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

function collectImports(source) {
  return [...source.matchAll(/@(use|import|forward)\s+["']([^"']+)["']/g)]
    .map((match) => ({ type: match[1], target: match[2] }));
}

function checkOrganization(report) {
  const errors = [];
  const allowedRootFiles = new Set([
    "client/styles/_colors.scss",
    "client/styles/_focus.scss",
    "client/styles/_fonts.scss",
    "client/styles/_icon-api.scss",
    "client/styles/_geometry.scss",
    "client/styles/_icons.scss",
    "client/styles/_partials.scss",
    "client/styles/_shell-base.scss",
    "client/styles/introjs-customizations.scss",
    "client/styles/introjs.css",
    "client/styles/shell.scss",
  ]);
  const allowedShellImports = new Set([
    "_fonts.scss",
    "_icons.scss",
    "_geometry.scss",
    "_colors.scss",
    "_partials.scss",
    "_focus.scss",
    "_shell-base.scss",
  ]);

  for (const item of report.files) {
    if (item.imports.some((styleImport) => styleImport.type === "import")) {
      errors.push(`${item.file} uses Sass @import; use @use or @forward instead.`);
    }

    if (item.file.startsWith("client/styles/") && !allowedRootFiles.has(item.file)) {
      errors.push(`${item.file} lives in client/styles; colocate feature styles under imports/ instead.`);
    }

    if (item.file === "client/styles/shell.scss") {
      for (const styleImport of item.imports) {
        if (!allowedShellImports.has(styleImport.target)) {
          errors.push(
            `${item.file} imports ${styleImport.target}; import feature styles from their owning module instead.`,
          );
        }
      }
    }
  }

  return errors;
}

function collectStyleFiles(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectStyleFiles(fullPath));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      if (entry.name.endsWith(".scss") || entry.name.endsWith(".css")) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function collectSelectors(lines) {
  const selectors = [];
  let inBlockComment = false;
  let pendingSelector = "";
  let pendingLine = 0;
  let braceDepth = 0;

  for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
    let line = lines[lineNumber];

    if (inBlockComment) {
      if (line.includes("*/")) {
        line = line.slice(line.indexOf("*/") + 2);
        inBlockComment = false;
      } else {
        continue;
      }
    }

    while (line.includes("/*")) {
      const start = line.indexOf("/*");
      const end = line.indexOf("*/", start + 2);
      if (end === -1) {
        line = line.slice(0, start);
        inBlockComment = true;
        break;
      }

      line = `${line.slice(0, start)} ${line.slice(end + 2)}`;
    }

    const commentStart = line.indexOf("//");
    if (commentStart !== -1) {
      line = line.slice(0, commentStart);
    }

    if (!line.trim()) {
      continue;
    }

    const openBrace = line.indexOf("{");
    if (openBrace === -1) {
      if (pendingSelector || looksLikeSelectorFragment(line, braceDepth)) {
        pendingSelector += ` ${line.trim()}`;
        if (!pendingLine) pendingLine = lineNumber + 1;
      }

      braceDepth += countChar(line, "{") - countChar(line, "}");
      if (braceDepth < 0) braceDepth = 0;
      continue;
    }

    const beforeBrace = line.slice(0, openBrace).trim();
    const selector = `${pendingSelector} ${beforeBrace}`.trim();
    pendingSelector = "";
    const startsAt = pendingLine || lineNumber + 1;
    pendingLine = 0;

    if (!selector ||
        selector.startsWith("@") ||
        selector.startsWith("$") ||
        looksLikeDeclaration(selector)) {
      braceDepth += countChar(line, "{") - countChar(line, "}");
      if (braceDepth < 0) braceDepth = 0;
      continue;
    }

    selectors.push({
      line: startsAt,
      indent: line.search(/\S/),
      selector: selector.replace(/\s+/g, " "),
    });

    braceDepth += countChar(line, "{") - countChar(line, "}");
    if (braceDepth < 0) braceDepth = 0;
  }

  return selectors;
}

function countChar(line, char) {
  return [...line].filter((candidate) => candidate === char).length;
}

function looksLikeSelectorFragment(line, braceDepth) {
  const trimmed = line.trim();
  return braceDepth === 0 &&
    /^[.#%&:[A-Za-z0-9_*>,+~\[\]-]/.test(trimmed) &&
    !looksLikeDeclaration(trimmed) &&
    !trimmed.startsWith("@") &&
    !trimmed.startsWith("$");
}

function looksLikeDeclaration(text) {
  return /^[A-Za-z-]+\s*:/.test(text);
}

function renderMarkdown(report) {
  const lines = [
    "# Sandstorm CSS Inventory",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Totals",
    "",
    "| Metric | Count |",
    "| --- | ---: |",
  ];

  for (const [key, value] of Object.entries(report.totals)) {
    lines.push(`| ${key} | ${value} |`);
  }

  lines.push(
    "",
    "## Highest-Risk Files",
    "",
    "Risk is a rough migration triage score based on broad selectors, IDs, `!important`, `@extend`, and file size.",
    "",
    "| File | Risk | Lines | Selectors | Body Selectors | ID Selectors | !important | @extend |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  );

  for (const item of report.rankedRisk.slice(0, 15)) {
    lines.push(
      `| ${item.file} | ${item.risk} | ${item.metrics.lines} | ${item.metrics.selectors} | ` +
      `${item.metrics.bodySelectors} | ${item.metrics.idSelectors} | ${item.metrics.important} | ${item.metrics.extends} |`,
    );
  }

  lines.push("", "## Files", "");

  for (const item of report.files) {
    lines.push(
      `### ${item.file}`,
      "",
      `Lines: ${item.metrics.lines}; selectors: ${item.metrics.selectors}; top-level selectors: ${item.metrics.topLevelSelectors}; ` +
      `imports: ${item.imports.length}; @extend: ${item.metrics.extends}; !important: ${item.metrics.important}.`,
    );

    if (item.imports.length) {
      lines.push("", "Imports:");
      for (const imported of item.imports) {
        lines.push(`- @${imported.type} "${imported.target}"`);
      }
    }

    if (item.topLevelSelectors.length) {
      lines.push("", "Representative top-level selectors:");
      for (const selector of item.topLevelSelectors) {
        lines.push(`- \`${selector}\``);
      }
    }

    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}
