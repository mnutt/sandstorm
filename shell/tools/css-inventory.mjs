#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const styleRoots = [
  path.join(root, "client", "styles"),
  path.join(root, "imports", "blackrock-payments"),
  path.join(root, "imports", "client"),
  path.join(root, "imports", "sandstorm-ui-powerbox"),
  path.join(root, "imports", "sandstorm-ui-topbar"),
];
const scriptRoots = [
  path.join(root, "client"),
  path.join(root, "imports"),
];
const styleLoadPaths = [
  path.join(root, "client", "styles"),
  path.join(root, "imports", "client", "accounts", "styles"),
  path.join(root, "imports", "client", "admin", "styles"),
  path.join(root, "imports", "client", "apps", "styles"),
  path.join(root, "imports", "client", "grain", "styles"),
  path.join(root, "imports", "client", "setup-wizard", "styles"),
  path.join(root, "imports", "client", "shell", "styles"),
  path.join(root, "imports", "client", "transfers", "styles"),
  path.join(root, "imports", "client", "widgets", "styles"),
  path.join(root, "imports", "blackrock-payments", "client", "styles"),
  path.join(root, "imports", "sandstorm-ui-powerbox", "styles"),
  path.join(root, "imports", "sandstorm-ui-topbar", "styles"),
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
const scriptFiles = scriptRoots
  .filter((scriptRoot) => fs.existsSync(scriptRoot))
  .flatMap((scriptRoot) => collectScriptFiles(scriptRoot))
  .sort();
const scriptStyleImports = scriptFiles
  .flatMap((fileName) => collectJsStyleImports(fileName).map((styleImport) => ({
    file: path.relative(root, fileName),
    ...styleImport,
  })));
const unreachableStyleFiles = collectUnreachableStyleFiles(styleFiles, scriptFiles);

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
    bodySelectors: selectors.filter((selector) => isBodySelector(selector.selector)).length,
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
  scriptStyleImports,
  unreachableStyleFiles,
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

function isBodySelector(selector) {
  return /(^|[\s>+~,(])body(?=$|[\s.#:[>+~,)])/.test(selector);
}

function collectImports(source) {
  return [...source.matchAll(/@(use|import|forward)\s+["']([^"']+)["']/g)]
    .map((match) => ({ type: match[1], target: match[2] }));
}

function checkOrganization(report) {
  const errors = [];
  const allowedRootFiles = new Set([
    "client/styles/_colors-app-details.scss",
    "client/styles/_colors-applist.scss",
    "client/styles/_colors-core.scss",
    "client/styles/_colors-defaults.scss",
    "client/styles/_colors-grainlist.scss",
    "client/styles/_colors-topbar.scss",
    "client/styles/_focus.scss",
    "client/styles/_fonts.scss",
    "client/styles/_icon-api.scss",
    "client/styles/_geometry-breakpoints.scss",
    "client/styles/_geometry-shell.scss",
    "client/styles/_icons.scss",
    "client/styles/_partials-buttons.scss",
    "client/styles/_partials-form.scss",
    "client/styles/_partials-login-provider.scss",
    "client/styles/_partials-media.scss",
    "client/styles/_partials-search.scss",
    "client/styles/_shell-base.scss",
    "client/styles/shell.scss",
  ]);
  const allowedShellImports = new Set([
    "_fonts.scss",
    "_icons.scss",
    "_focus.scss",
    "_shell-base.scss",
  ]);

  for (const item of report.files) {
    if (item.metrics.idSelectors > 0) {
      errors.push(`${item.file} contains ID selectors; use class hooks for styling.`);
    }

    if (item.metrics.extends > 0) {
      errors.push(`${item.file} uses Sass @extend; use mixins or local selectors instead.`);
    }

    if (item.metrics.placeholders > 0) {
      errors.push(`${item.file} defines Sass placeholders; use mixins or local selectors instead.`);
    }

    if (item.imports.some((styleImport) => styleImport.type === "import")) {
      errors.push(`${item.file} uses Sass @import; use @use or @forward instead.`);
    }

    if (item.imports.some((styleImport) => styleImport.type === "use" && styleImport.target === "partials")) {
      errors.push(`${item.file} uses the catch-all partials Sass module; use a narrower partials-* module instead.`);
    }

    if (item.imports.some((styleImport) => styleImport.type === "use" && styleImport.target === "colors")) {
      errors.push(`${item.file} uses the catch-all colors Sass module; use a narrower colors-* module instead.`);
    }

    if (item.imports.some((styleImport) => styleImport.type === "use" && styleImport.target === "geometry")) {
      errors.push(`${item.file} uses the catch-all geometry Sass module; use a narrower geometry-* module instead.`);
    }

    if (item.file.startsWith("client/styles/") && !allowedRootFiles.has(item.file)) {
      errors.push(`${item.file} lives in client/styles; colocate feature styles under imports/ instead.`);
    }

    if (item.file.startsWith("imports/") && !item.file.includes("/styles/")) {
      errors.push(`${item.file} lives outside a styles/ directory; colocate feature styles under their owner.`);
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

  for (const styleImport of report.scriptStyleImports) {
    const importedBase = path.posix.basename(styleImport.target);
    if (importedBase.startsWith("_") && importedBase.endsWith(".scss")) {
      errors.push(
        `${styleImport.file}:${styleImport.line} imports private Sass partial ${styleImport.target}; ` +
        "import a module-owned stylesheet entry instead.",
      );
    }
  }

  for (const file of report.unreachableStyleFiles) {
    errors.push(`${file} is not reachable from any JS/TS stylesheet import.`);
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

function collectScriptFiles(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectScriptFiles(fullPath));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      if (/\.[jt]sx?$/.test(entry.name)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function collectJsStyleImports(fileName) {
  const source = fs.readFileSync(fileName, "utf8");
  return [...source.matchAll(/import\s+["']([^"']+\.(?:s?css))["'];?/g)]
    .map((match) => ({
      line: source.slice(0, match.index).split(/\r?\n/).length,
      target: match[1],
    }));
}

function collectUnreachableStyleFiles(styleFiles, scriptFiles) {
  const allStyleFiles = new Set(styleFiles.map((fileName) => path.normalize(fileName)));
  const rootStyleFiles = new Set();

  for (const fileName of scriptFiles) {
    for (const styleImport of collectJsStyleImports(fileName)) {
      const resolved = resolveStyleImport(fileName, styleImport.target);
      if (resolved) {
        rootStyleFiles.add(resolved);
      }
    }
  }

  const reachable = new Set();
  for (const fileName of rootStyleFiles) {
    visitStyleFile(fileName, reachable);
  }

  return [...allStyleFiles]
    .filter((fileName) => !reachable.has(fileName))
    .map((fileName) => path.relative(root, fileName))
    .sort();
}

function visitStyleFile(fileName, reachable) {
  if (reachable.has(fileName) || !fs.existsSync(fileName)) {
    return;
  }

  reachable.add(fileName);
  const source = fs.readFileSync(fileName, "utf8");
  for (const styleImport of collectImports(source)) {
    const resolved = resolveStyleImport(fileName, styleImport.target);
    if (resolved) {
      visitStyleFile(resolved, reachable);
    }
  }
}

function resolveStyleImport(fromFile, target) {
  if (target.startsWith("sass:")) {
    return null;
  }

  const basePaths = [];
  if (target.startsWith("/")) {
    basePaths.push(path.join(root, target.slice(1)));
  } else if (target.startsWith(".")) {
    basePaths.push(path.resolve(path.dirname(fromFile), target));
  } else {
    basePaths.push(path.resolve(path.dirname(fromFile), target));
    for (const loadPath of styleLoadPaths) {
      basePaths.push(path.join(loadPath, target));
    }
  }

  for (const basePath of basePaths) {
    for (const candidate of styleImportCandidates(basePath)) {
      if (fs.existsSync(candidate)) {
        return path.normalize(candidate);
      }
    }
  }

  return null;
}

function styleImportCandidates(basePath) {
  const extension = path.extname(basePath);
  const directory = path.dirname(basePath);
  const basename = path.basename(basePath, extension);
  const candidates = extension ?
    [basePath] :
    [`${basePath}.scss`, `${basePath}.css`, path.join(basePath, "index.scss")];

  if (!basename.startsWith("_")) {
    candidates.push(path.join(directory, `_${basename}${extension || ".scss"}`));
  }

  return candidates;
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
