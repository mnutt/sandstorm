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

import { parse } from "acorn";
import { simple as walkSimple } from "acorn-walk";
import Crypto from "crypto";
import Path from "path";

import { IsolateError } from "/imports/server/isolate-error";

const ISOLATE_BUNDLE_FORMAT_VERSION = 1;

// These are admission guardrails, not product quotas. The aggregate limit
// bounds callers that submit an in-memory JavaScript object; capability-based
// bundles are validated and staged one module at a time instead. Leave
// module-count room for injected helpers as well.
const ISOLATE_BUNDLE_LIMITS = Object.freeze({
  maxModules: 512,
  maxModuleBytes: 8 * 1024 * 1024,
  maxTotalModuleBytes: 15 * 1024 * 1024,
  maxNameBytes: 256,
  maxCompatibilityFlags: 64,
  maxCompatibilityFlagBytes: 128,
  maxJsonDepth: 100,
});

const SUPPORTED_MODULE_TYPES = new Set(["esModule", "json", "text", "data", "wasm"]);
const BINARY_MODULE_TYPES = new Set(["data", "wasm"]);
const SUPPORTED_PLATFORM_IMPORTS = new Set(["sandstorm:api"]);
const DEFAULT_COMPATIBILITY_FLAGS = new Set();
const BUNDLE_FIELDS = new Set([
  "formatVersion",
  "mainModule",
  "compatibilityDate",
  "compatibilityFlags",
  "modules",
]);
const MODULE_FIELDS = new Set(["name", "type", "content"]);

class IsolateBundleError extends IsolateError {
  constructor(code, message, field) {
    super("IsolateBundleError", code, message);
    if (field !== undefined) this.field = field;
  }
}

function fail(code, message, field) {
  throw new IsolateBundleError(code, message, field);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requirePlainObject(value, field) {
  if (!isPlainObject(value)) {
    fail("invalid-type", `${field} must be an object.`, field);
  }
}

function rejectUnknownFields(value, allowed, field) {
  Object.keys(value).forEach((key) => {
    if (!allowed.has(key)) {
      fail("unknown-field", `${field} contains unknown field ${key}.`, `${field}.${key}`);
    }
  });
}

function hasUnpairedSurrogate(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (i + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }

  return false;
}

function requireString(value, field, { nonempty = false } = {}) {
  if (typeof value !== "string") {
    fail("invalid-type", `${field} must be a string.`, field);
  }

  if (nonempty && value.length === 0) {
    fail("empty-value", `${field} must not be empty.`, field);
  }

  if (hasUnpairedSurrogate(value)) {
    fail("invalid-unicode", `${field} contains invalid Unicode.`, field);
  }

  return value;
}

function requireArray(value, field) {
  if (!Array.isArray(value)) {
    fail("invalid-type", `${field} must be an array.`, field);
  }

  return value;
}

function requireByteLimit(value, maxBytes, field) {
  const size = Buffer.byteLength(value, "utf8");
  if (size > maxBytes) {
    fail("limit-exceeded", `${field} exceeds the ${maxBytes}-byte limit.`, field);
  }

  return size;
}

function validateModuleName(value, field, limits) {
  const name = requireString(value, field, { nonempty: true });
  requireByteLimit(name, limits.maxNameBytes, field);

  if (name.includes(":") || name.includes("\\") || name.includes("\0") ||
      name.startsWith("/") ||
      name.endsWith("/") || name.split("/").some(part => part === "" || part === "." ||
        part === "..") || Path.posix.normalize(name) !== name) {
    fail("invalid-module-name",
        `${field} must be a canonical package-relative module name.`, field);
  }

  return name;
}

function validateCompatibilityDate(value) {
  const field = "compatibilityDate";
  const date = requireString(value, field, { nonempty: true });
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) {
    fail("invalid-compatibility-date", `${field} must use YYYY-MM-DD format.`, field);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 ||
      parsed.getUTCDate() !== day) {
    fail("invalid-compatibility-date", `${field} must be a real calendar date.`, field);
  }

  return date;
}

function normalizeCompatibilityFlags(value, limits, supportedFlags) {
  const flags = requireArray(value, "compatibilityFlags");
  if (flags.length > limits.maxCompatibilityFlags) {
    fail("limit-exceeded",
        `compatibilityFlags exceeds the ${limits.maxCompatibilityFlags}-flag limit.`,
        "compatibilityFlags");
  }

  const seen = new Set();
  const result = flags.map((value, index) => {
    const field = `compatibilityFlags[${index}]`;
    const flag = requireString(value, field, { nonempty: true });
    requireByteLimit(flag, limits.maxCompatibilityFlagBytes, field);
    if (seen.has(flag)) {
      fail("duplicate-compatibility-flag", `Duplicate compatibility flag ${flag}.`, field);
    }

    if (!supportedFlags.has(flag)) {
      fail("unsupported-compatibility-flag", `Unsupported compatibility flag ${flag}.`, field);
    }

    seen.add(flag);
    return flag;
  });

  return result.sort();
}

function stableJson(value, depth, maxDepth, field) {
  if (depth > maxDepth) {
    fail("limit-exceeded", `${field} exceeds the JSON nesting-depth limit.`, field);
  }

  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(item => stableJson(item, depth + 1, maxDepth, field)).join(",")}]`;
  }

  return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${stableJson(value[key], depth + 1, maxDepth, field)}`).join(",")}}`;
}

function normalizeModuleContent(type, source, field, limits) {
  if (type !== "json") return source;

  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    fail("invalid-json", `${field} is not valid JSON: ${error.message}`, field);
  }

  return stableJson(parsed, 0, limits.maxJsonDepth, field);
}

function normalizeBinaryContent(value, field, limits) {
  let content;
  if (Buffer.isBuffer(value)) {
    content = Buffer.from(value);
  } else if (value instanceof ArrayBuffer) {
    content = Buffer.from(value.slice(0));
  } else if (ArrayBuffer.isView(value)) {
    content = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    content = Buffer.from(content);
  } else {
    fail("invalid-type", `${field} must contain bytes for a binary module.`, field);
  }

  if (content.length > limits.maxModuleBytes) {
    fail("limit-exceeded", `${field} exceeds the ${limits.maxModuleBytes}-byte limit.`, field);
  }

  return content;
}

function moduleContentSize(module) {
  return BINARY_MODULE_TYPES.has(module.type)
    ? module.content.length
    : Buffer.byteLength(module.content, "utf8");
}

function moduleContentBytes(module) {
  return BINARY_MODULE_TYPES.has(module.type)
    ? Buffer.from(module.content)
    : Buffer.from(module.content, "utf8");
}

function resolveRelativeImport(moduleName, specifier, moduleNames, field) {
  if (specifier.includes("?") || specifier.includes("#")) {
    fail("unsupported-import", `${field} may not contain a query or fragment.`, field);
  }

  const resolved = Path.posix.normalize(Path.posix.join(Path.posix.dirname(moduleName), specifier));
  if (resolved === ".." || resolved.startsWith("../") || Path.posix.isAbsolute(resolved)) {
    fail("import-outside-bundle", `${field} resolves outside the candidate bundle.`, field);
  }

  if (!moduleNames.has(resolved)) {
    fail("unresolved-import", `${field} does not resolve to a submitted module.`, field);
  }
}

function validateImport(moduleName, specifier, moduleNames, platformImports, field) {
  requireString(specifier, field, { nonempty: true });
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    resolveRelativeImport(moduleName, specifier, moduleNames, field);
  } else if (!platformImports.has(specifier)) {
    fail("unsupported-import", `${field} is not an allowed platform import.`, field);
  }
}

function validateEsModuleImports(module, moduleNames, platformImports) {
  let syntaxTree;
  try {
    syntaxTree = parse(module.content, {
      allowHashBang: true,
      ecmaVersion: "latest",
      sourceType: "module",
    });
  } catch (error) {
    fail("invalid-javascript", `${module.name} is not valid JavaScript: ${error.message}`,
        `modules.${module.name}.content`);
  }

  syntaxTree.body.forEach((node) => {
    if ((node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration" ||
        node.type === "ExportNamedDeclaration") && node.source) {
      validateImport(module.name, node.source.value, moduleNames, platformImports,
          `import in ${module.name}`);
    }
  });

  walkSimple(syntaxTree, {
    ImportExpression(node) {
      if (node.source.type !== "Literal" || typeof node.source.value !== "string") {
        fail("dynamic-import", `Dynamic imports in ${module.name} must use a string literal.`,
            `modules.${module.name}.content`);
      }

      validateImport(module.name, node.source.value, moduleNames, platformImports,
          `import in ${module.name}`);
    },
  });
}

function validateIsolateModuleContent(name, type, content, moduleNames, options = {}) {
  const limits = Object.freeze({ ...ISOLATE_BUNDLE_LIMITS, ...(options.limits || {}) });
  const platformImports = options.platformImports || SUPPORTED_PLATFORM_IMPORTS;
  const field = `modules.${name}.content`;
  if (!SUPPORTED_MODULE_TYPES.has(type)) {
    fail("unsupported-module-type", `Unsupported module type ${type}.`, field);
  }

  if (BINARY_MODULE_TYPES.has(type)) {
    const bytes = normalizeBinaryContent(content, field, limits);
    if (type === "wasm" && !WebAssembly.validate(bytes)) {
      fail("invalid-wasm", `${field} is not a valid WebAssembly module.`, field);
    }

    return;
  }

  const source = requireString(content, field);
  requireByteLimit(source, limits.maxModuleBytes, field);
  if (type === "json") {
    const canonical = normalizeModuleContent(type, source, field, limits);
    requireByteLimit(canonical, limits.maxModuleBytes, field);
  } else if (type === "esModule") {
    validateEsModuleImports({ name, content: source }, moduleNames, platformImports);
  }
}

function freezeNormalizedBundle(bundle) {
  Object.freeze(bundle.compatibilityFlags);
  bundle.modules.forEach(Object.freeze);
  Object.freeze(bundle.modules);
  return Object.freeze(bundle);
}

function normalizeIsolateBundle(input, options = {}) {
  requirePlainObject(input, "bundle");
  rejectUnknownFields(input, BUNDLE_FIELDS, "bundle");

  const limits = Object.freeze({ ...ISOLATE_BUNDLE_LIMITS, ...(options.limits || {}) });
  const supportedFlags = options.supportedCompatibilityFlags || DEFAULT_COMPATIBILITY_FLAGS;
  const platformImports = options.platformImports || SUPPORTED_PLATFORM_IMPORTS;

  if (input.formatVersion !== ISOLATE_BUNDLE_FORMAT_VERSION) {
    fail("unsupported-format-version",
        `formatVersion must be ${ISOLATE_BUNDLE_FORMAT_VERSION}.`, "formatVersion");
  }

  const modulesInput = requireArray(input.modules, "modules");
  if (modulesInput.length === 0 || modulesInput.length > limits.maxModules) {
    fail("limit-exceeded", `modules must contain between 1 and ${limits.maxModules} entries.`,
        "modules");
  }

  const moduleNames = new Set();
  let totalModuleBytes = 0;
  const modules = modulesInput.map((value, index) => {
    const field = `modules[${index}]`;
    requirePlainObject(value, field);
    rejectUnknownFields(value, MODULE_FIELDS, field);

    const name = validateModuleName(value.name, `${field}.name`, limits);
    if (moduleNames.has(name)) {
      fail("duplicate-module", `Duplicate module name ${name}.`, `${field}.name`);
    }

    moduleNames.add(name);
    const type = requireString(value.type, `${field}.type`, { nonempty: true });
    if (!SUPPORTED_MODULE_TYPES.has(type)) {
      fail("unsupported-module-type", `Unsupported module type ${type}.`, `${field}.type`);
    }

    const contentField = `${field}.content`;
    let content;
    let contentBytes;
    if (BINARY_MODULE_TYPES.has(type)) {
      content = normalizeBinaryContent(value.content, contentField, limits);
      if (type === "wasm" && !WebAssembly.validate(content)) {
        fail("invalid-wasm", `${contentField} is not a valid WebAssembly module.`, contentField);
      }

      contentBytes = content.length;
    } else {
      const inputContent = requireString(value.content, contentField);
      const inputBytes = requireByteLimit(inputContent, limits.maxModuleBytes, contentField);
      content = normalizeModuleContent(type, inputContent, contentField, limits);
      const normalizedBytes = requireByteLimit(content, limits.maxModuleBytes, contentField);
      contentBytes = Math.max(inputBytes, normalizedBytes);
    }
    totalModuleBytes += contentBytes;
    if (totalModuleBytes > limits.maxTotalModuleBytes) {
      fail("limit-exceeded",
          `Module contents exceed the ${limits.maxTotalModuleBytes}-byte aggregate limit.`,
          "modules");
    }

    return { name, type, content };
  }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

  const mainModule = validateModuleName(input.mainModule, "mainModule", limits);
  const main = modules.find(module => module.name === mainModule);
  if (!main) {
    fail("missing-main-module", "mainModule does not name a submitted module.", "mainModule");
  }

  if (main.type !== "esModule") {
    fail("invalid-main-module", "mainModule must name an ES module.", "mainModule");
  }

  modules.filter(module => module.type === "esModule").forEach(module => {
    validateEsModuleImports(module, moduleNames, platformImports);
  });

  const bundle = freezeNormalizedBundle({
    formatVersion: ISOLATE_BUNDLE_FORMAT_VERSION,
    mainModule,
    compatibilityDate: validateCompatibilityDate(input.compatibilityDate),
    compatibilityFlags: normalizeCompatibilityFlags(
      input.compatibilityFlags, limits, supportedFlags),
    modules,
  });
  const canonicalText = JSON.stringify({
    ...bundle,
    modules: bundle.modules.map(module => ({
      ...module,
      content: BINARY_MODULE_TYPES.has(module.type)
        ? { base64: module.content.toString("base64") }
        : module.content,
    })),
  });
  const digest = Crypto.createHash("sha256")
      .update("sandstorm-isolate-candidate-v1\0")
      .update(canonicalText, "utf8")
      .digest("hex");

  return Object.freeze({ bundle, canonicalText, digest, totalModuleBytes });
}

export {
  ISOLATE_BUNDLE_FORMAT_VERSION,
  ISOLATE_BUNDLE_LIMITS,
  IsolateBundleError,
  moduleContentBytes,
  moduleContentSize,
  normalizeIsolateBundle,
  validateIsolateModuleContent,
};
