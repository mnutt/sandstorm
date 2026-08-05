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
  path.join(root, "imports", "client", "styles"),
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
const styleEntrypoints = scriptStyleImports
  .map((styleImport) => {
    const resolved = resolveStyleImport(path.join(root, styleImport.file), styleImport.target);
    return {
      ...styleImport,
      resolved: resolved ? relativeProjectPath(resolved) : null,
    };
  })
  .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.target.localeCompare(b.target));
const unreachableStyleFiles = collectUnreachableStyleFiles(styleFiles, scriptFiles);
const unresolvedStyleImports = collectUnresolvedStyleImports(styleFiles, scriptFiles);

const inventory = styleFiles.map((fileName) => {
  const source = fs.readFileSync(fileName, "utf8");
  const relativeFile = path.relative(root, fileName);
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
    file: relativeFile,
    vendor: isVendorStyle(relativeFile),
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

const rankedRisk = inventory
  .filter((item) => !item.vendor)
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
  styleEntrypoints,
  unreachableStyleFiles,
  unresolvedStyleImports,
  vendorFiles: inventory.filter((item) => item.vendor).map(({ file, metrics }) => ({ file, metrics })),
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

function isVendorStyle(fileName) {
  return fileName.startsWith("imports/client/vendor/");
}

function relativeProjectPath(fileName) {
  return path.relative(root, fileName).split(path.sep).join(path.posix.sep);
}

function collectImports(source) {
  return [...source.matchAll(/@(use|import|forward)\s+["']([^"']+)["']/g)]
    .map((match) => ({ type: match[1], target: match[2] }));
}

function checkOrganization(report) {
  const errors = [];
  const allowedRootFiles = new Set([
    "client/styles/shell.scss",
  ]);
  const allowedShellImports = new Set([
    "global/fonts",
    "global/icons",
    "global/focus",
    "global/shell-base",
  ]);
  const retiredEntryStyles = new Set([
    "imports/blackrock-payments/client/styles/payments.scss",
    "imports/blackrock-payments/client/styles/billing-prompt.scss",
    "imports/blackrock-payments/client/styles/billing-settings.scss",
    "imports/blackrock-payments/client/styles/payment-iframe.scss",
    "imports/client/accounts/styles/account-settings.scss",
    "imports/client/accounts/styles/credentials.scss",
    "imports/client/accounts/styles/login-buttons.scss",
    "imports/client/admin/styles/admin.scss",
    "imports/client/admin/styles/admin-shell.scss",
    "imports/client/admin/styles/app-sources.scss",
    "imports/client/admin/styles/certificates.scss",
    "imports/client/admin/styles/email.scss",
    "imports/client/admin/styles/hosting-management.scss",
    "imports/client/admin/styles/login.scss",
    "imports/client/admin/styles/maintenance.scss",
    "imports/client/admin/styles/network-capabilities.scss",
    "imports/client/admin/styles/networking.scss",
    "imports/client/admin/styles/organization.scss",
    "imports/client/admin/styles/personalization.scss",
    "imports/client/admin/styles/preinstalled-apps.scss",
    "imports/client/admin/styles/stats.scss",
    "imports/client/admin/styles/status.scss",
    "imports/client/admin/styles/user-details.scss",
    "imports/client/admin/styles/user-invites.scss",
    "imports/client/admin/styles/users.scss",
    "imports/client/apps/styles/app-details.scss",
    "imports/client/apps/styles/applist.scss",
    "imports/client/apps/styles/install.scss",
    "imports/client/grain/styles/grain.scss",
    "imports/client/grain/styles/grainlist.scss",
    "imports/client/grain/styles/grainlog.scss",
    "imports/client/grain/styles/settings.scss",
    "imports/client/grain/styles/sharing.scss",
    "imports/client/grain/styles/view.scss",
    "imports/client/setup-wizard/styles/setup-wizard.scss",
    "imports/client/shell/styles/about.scss",
    "imports/client/shell/styles/admin-alert.scss",
    "imports/client/shell/styles/introjs-customizations.scss",
    "imports/client/shell/styles/layout.scss",
    "imports/client/shell/styles/referrals.scss",
    "imports/client/shell/styles/root.scss",
    "imports/client/shell/styles/shell.scss",
    "imports/client/styleguide/styles/styleguide.scss",
    "imports/client/transfers/styles/transfers.scss",
    "imports/client/transfers/styles/transfers-actions-ui.scss",
    "imports/client/transfers/styles/transfers-frame-ui.scss",
    "imports/client/transfers/styles/transfers-grain-list-ui.scss",
    "imports/client/transfers/styles/transfers-state-icons-ui.scss",
    "imports/client/widgets/styles/buttons-ui.scss",
    "imports/client/widgets/styles/forms-ui.scss",
    "imports/client/widgets/styles/messages-ui.scss",
    "imports/client/widgets/styles/modals-ui.scss",
    "imports/client/widgets/styles/buttons.scss",
    "imports/client/widgets/styles/forms.scss",
    "imports/client/widgets/styles/messages.scss",
    "imports/client/widgets/styles/modals.scss",
    "imports/client/widgets/styles/widgets.scss",
    "imports/sandstorm-ui-powerbox/styles/powerbox-candidates-ui.scss",
    "imports/sandstorm-ui-powerbox/styles/powerbox-frame-ui.scss",
    "imports/sandstorm-ui-powerbox/styles/powerbox-search-ui.scss",
    "imports/sandstorm-ui-powerbox/styles/powerbox-selected-card-ui.scss",
    "imports/sandstorm-ui-powerbox/styles/powerbox.scss",
    "imports/sandstorm-ui-topbar/styles/topbar-backup-ui.scss",
    "imports/sandstorm-ui-topbar/styles/topbar-demo-ui.scss",
    "imports/sandstorm-ui-topbar/styles/topbar-frame-ui.scss",
    "imports/sandstorm-ui-topbar/styles/topbar-menubar-ui.scss",
    "imports/sandstorm-ui-topbar/styles/topbar-navbar-ui.scss",
    "imports/sandstorm-ui-topbar/styles/topbar-notification-ui.scss",
    "imports/sandstorm-ui-topbar/styles/topbar-popup-ui.scss",
    "imports/sandstorm-ui-topbar/styles/topbar-share-ui.scss",
    "imports/sandstorm-ui-topbar/styles/topbar.scss",
  ]);
  const retiredStyleImporters = new Set([
    "imports/client/shell-client.js",
  ]);
  const multiStyleImporters = new Map();

  for (const item of report.files) {
    if (retiredEntryStyles.has(item.file)) {
      errors.push(`${item.file} is a retired public stylesheet; import owner-specific style entries instead.`);
    }

    if (!item.vendor && item.metrics.bodySelectors > 0 && item.file !== "imports/client/styles/global/_shell-base.scss") {
      errors.push(`${item.file} contains body selectors; keep global document selectors in imports/client/styles/global/_shell-base.scss.`);
    }

    if (item.metrics.idSelectors > 0) {
      errors.push(`${item.file} contains ID selectors; use class hooks for styling.`);
    }

    if (!item.vendor && item.metrics.important > 0) {
      errors.push(`${item.file} uses !important; use selector ownership or cascade order instead.`);
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
      errors.push(`${item.file} uses the catch-all geometry Sass module; use a narrower geometry/* module instead.`);
    }

    const oldSharedApiImport = item.imports.find((styleImport) =>
      styleImport.type === "use" &&
      (/^(colors|geometry|partials)-/.test(styleImport.target) || styleImport.target === "icon-api")
    );
    if (oldSharedApiImport) {
      errors.push(`${item.file} imports ${oldSharedApiImport.target}; use a namespaced shared Sass API instead.`);
    }

    if (item.file.startsWith("client/styles/") && !allowedRootFiles.has(item.file)) {
      errors.push(`${item.file} lives in client/styles; colocate feature styles under imports/ instead.`);
    }

    if (/^imports\/client\/styles\/[^/]+\.scss$/.test(item.file)) {
      errors.push(`${item.file} lives directly in imports/client/styles; use a named shared API directory.`);
    }

    if (item.file.startsWith("imports/") && !item.file.includes("/styles/")) {
      errors.push(`${item.file} lives outside a styles/ directory; colocate feature styles under their owner.`);
    }

    const fileBaseName = path.posix.basename(item.file);
    if (
      !item.vendor &&
      item.file.startsWith("imports/") &&
      item.file.includes("/styles/") &&
      item.file.endsWith(".scss") &&
      !fileBaseName.startsWith("_") &&
      !fileBaseName.endsWith("-ui.scss")
    ) {
      errors.push(`${item.file} is a public stylesheet entrypoint; name it with the -ui.scss suffix.`);
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

  for (const styleImport of report.styleEntrypoints) {
    if (styleImport.file.startsWith("imports/") && styleImport.resolved) {
      const imports = multiStyleImporters.get(styleImport.file) || [];
      imports.push(styleImport);
      multiStyleImporters.set(styleImport.file, imports);
    }

    if (retiredStyleImporters.has(styleImport.file)) {
      errors.push(
        `${styleImport.file}:${styleImport.line} imports ${styleImport.resolved || styleImport.target}; ` +
        "move stylesheet imports to the owning shell page module instead.",
      );
    }

    const importedBase = path.posix.basename(styleImport.target);
    if (importedBase.startsWith("_") && importedBase.endsWith(".scss")) {
      errors.push(
        `${styleImport.file}:${styleImport.line} imports private Sass partial ${styleImport.target}; ` +
        "import a module-owned stylesheet entry instead.",
      );
    }

    if (styleImport.resolved && retiredEntryStyles.has(styleImport.resolved)) {
      errors.push(
        `${styleImport.file}:${styleImport.line} imports retired public stylesheet ${styleImport.resolved}; ` +
        "import owner-specific style entries instead.",
      );
    }
  }

  for (const [file, imports] of multiStyleImporters) {
    if (imports.length > 1) {
      errors.push(`${file} imports ${imports.length} stylesheets; import one owner-level stylesheet instead.`);
    }
  }

  for (const file of report.unreachableStyleFiles) {
    errors.push(`${file} is not reachable from any JS/TS stylesheet import.`);
  }

  for (const styleImport of report.unresolvedStyleImports) {
    errors.push(`${styleImport.file}:${styleImport.line} cannot resolve stylesheet import ${styleImport.target}.`);
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

function collectUnresolvedStyleImports(styleFiles, scriptFiles) {
  const unresolved = [];

  for (const fileName of scriptFiles) {
    for (const styleImport of collectJsStyleImports(fileName)) {
      if (!resolveStyleImport(fileName, styleImport.target)) {
        unresolved.push({
          file: path.relative(root, fileName),
          line: styleImport.line,
          target: styleImport.target,
        });
      }
    }
  }

  for (const fileName of styleFiles) {
    const source = fs.readFileSync(fileName, "utf8");
    const lineStarts = sourceLineStarts(source);
    for (const match of source.matchAll(/@(use|import|forward)\s+["']([^"']+)["']/g)) {
      const target = match[2];
      if (!target.startsWith("sass:") && !resolveStyleImport(fileName, target)) {
        unresolved.push({
          file: path.relative(root, fileName),
          line: lineNumberForIndex(lineStarts, match.index),
          target,
        });
      }
    }
  }

  return unresolved.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
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

function sourceLineStarts(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") {
      starts.push(i + 1);
    }
  }

  return starts;
}

function lineNumberForIndex(lineStarts, index) {
  let line = 0;
  while (line + 1 < lineStarts.length && lineStarts[line + 1] <= index) {
    line++;
  }

  return line + 1;
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
    "## Highest-Risk Sandstorm Files",
    "",
    "Risk is a rough migration triage score based on broad selectors, IDs, `!important`, `@extend`, and file size. Vendor files are listed separately.",
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

  if (report.vendorFiles.length) {
    lines.push(
      "",
      "## Vendor Files",
      "",
      "| File | Lines | Selectors | !important |",
      "| --- | ---: | ---: | ---: |",
    );

    for (const item of report.vendorFiles) {
      lines.push(`| ${item.file} | ${item.metrics.lines} | ${item.metrics.selectors} | ${item.metrics.important} |`);
    }
  }

  if (report.styleEntrypoints.length) {
    lines.push(
      "",
      "## Stylesheet Entrypoints",
      "",
      "| Importer | Line | Stylesheet |",
      "| --- | ---: | --- |",
    );

    for (const item of report.styleEntrypoints) {
      lines.push(`| ${item.file} | ${item.line} | ${item.resolved || item.target} |`);
    }
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
