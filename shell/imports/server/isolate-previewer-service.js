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

import { Meteor } from "meteor/meteor";
import { check } from "meteor/check";
import { Random } from "meteor/random";
import Crypto from "crypto";

import {
  ISOLATE_BUNDLE_LIMITS,
  validateIsolateModuleContent,
} from "/imports/server/isolate-bundle";
import { IsolateError } from "/imports/server/isolate-error";
import { requireIsolatePreviewAdmission } from "/imports/server/isolate-preview-service";

const MODULE_TYPES = ["esModule", "json", "text", "data", "wasm"];

class IsolatePreviewGrantError extends IsolateError {
  constructor(code, message) {
    super("IsolatePreviewGrantError", code, message);
    this.kjType = "failed";
  }
}

function fail(code, message) {
  throw new IsolatePreviewGrantError(code, message);
}

function ownKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid-request", `${label} must be an object.`);
  }

  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length ||
      keys.some((key, index) => key !== expected[index])) {
    fail("invalid-request", `${label} has unexpected fields.`);
  }
}

function moduleType(value) {
  if (typeof value === "number" && Number.isInteger(value) && MODULE_TYPES[value]) {
    return MODULE_TYPES[value];
  }

  if (typeof value === "string" && MODULE_TYPES.includes(value)) return value;
  if (value && typeof value === "object") {
    const key = Object.keys(value)[0];
    if (key && MODULE_TYPES.includes(key)) return key;
  }

  fail("invalid-bundle", "A streamed module has an unsupported type.");
}

function boundedSize(value, maximum, label) {
  let size = value;
  if (typeof value === "bigint") {
    size = Number(value);
  } else if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) {
    const parsed = BigInt(value);
    size = parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : NaN;
  }

  if (!Number.isSafeInteger(size) || size < 0 || size > maximum) {
    fail("bundle-limit-exceeded", `${label} exceeds the ${maximum}-byte limit.`);
  }

  return size;
}

function decodeTextModule(bytes, name) {
  const content = bytes.toString("utf8");
  if (!Buffer.from(content, "utf8").equals(bytes)) {
    fail("invalid-bundle", `Module ${name} is not valid UTF-8.`);
  }

  return content;
}

class ModuleByteStream {
  constructor(receiver, state) {
    this.receiver = receiver;
    this.state = state;
  }

  write(data) {
    if (this.state.done) fail("invalid-bundle", "Module data was written after done().");
    const chunk = Buffer.from(data || []);
    const nextSize = this.state.received + chunk.length;
    if (nextSize > this.state.info.size) {
      fail("invalid-bundle", `Module ${this.state.info.name} exceeded its declared size.`);
    }

    if (this.receiver.enforceAggregateLimit &&
        this.receiver.receivedBytes + chunk.length >
        ISOLATE_BUNDLE_LIMITS.maxTotalModuleBytes) {
      fail("bundle-limit-exceeded", "The streamed bundle exceeded its total byte limit.");
    }

    if (chunk.length > 0) this.state.chunks.push(chunk);
    this.state.received = nextSize;
    this.receiver.receivedBytes += chunk.length;
  }

  expectSize(size) {
    if (this.state.done) fail("invalid-bundle", "expectSize() was called after done().");
    const remaining = boundedSize(
      size, ISOLATE_BUNDLE_LIMITS.maxModuleBytes, "A streamed module");
    if (this.state.received + remaining !== this.state.info.size) {
      fail("invalid-bundle", `Module ${this.state.info.name} declared an inconsistent size.`);
    }
  }

  done() {
    if (this.state.done) fail("invalid-bundle", "Module done() was called more than once.");
    if (this.state.received !== this.state.info.size) {
      fail("invalid-bundle", `Module ${this.state.info.name} ended before its declared size.`);
    }

    this.receiver.finishModule(this.state);
    this.state.done = true;
  }
}

class StagedModuleByteStream {
  constructor(local, remote) {
    this.local = local;
    this.remote = remote;
  }

  async write(data) {
    this.local.write(data);
    await this.remote.write(data);
  }

  async expectSize(size) {
    this.local.expectSize(size);
    if (typeof this.remote.expectSize === "function") await this.remote.expectSize(size);
  }

  async done() {
    try {
      this.local.done();
      await this.remote.done();
    } finally {
      if (typeof this.remote.close === "function") this.remote.close();
    }
  }
}

class IsolateBundleReceiver {
  constructor(info, options = {}) {
    if (!info || typeof info !== "object") {
      fail("invalid-bundle", "IsolateBundle.getInfo() returned no bundle information.");
    }

    const modules = info.modules || [];
    if (!Array.isArray(modules) || modules.length === 0 ||
        modules.length > ISOLATE_BUNDLE_LIMITS.maxModules) {
      fail("bundle-limit-exceeded",
        `A streamed bundle must contain 1-${ISOLATE_BUNDLE_LIMITS.maxModules} modules.`);
    }

    this.retainContent = options.retainContent !== false;
    this.enforceAggregateLimit = options.enforceAggregateLimit !== false;
    this.validateContent = options.validateContent === true;
    let declaredBytes = 0;
    this.states = modules.map((module, index) => {
      if (!module || typeof module.name !== "string") {
        fail("invalid-bundle", `Module ${index} has invalid metadata.`);
      }

      if (Buffer.byteLength(module.name, "utf8") > ISOLATE_BUNDLE_LIMITS.maxNameBytes) {
        fail("bundle-limit-exceeded", `Module ${index} has an overlong name.`);
      }

      const size = boundedSize(
        module.size, ISOLATE_BUNDLE_LIMITS.maxModuleBytes, `Module ${module.name}`);
      declaredBytes += size;
      if (this.enforceAggregateLimit &&
          declaredBytes > ISOLATE_BUNDLE_LIMITS.maxTotalModuleBytes) {
        fail("bundle-limit-exceeded", "The streamed bundle exceeds its total byte limit.");
      }

      return {
        info: { name: module.name, type: moduleType(module.type), size },
        opened: false,
        done: false,
        received: 0,
        chunks: [],
      };
    });
    this.info = info;
    this.moduleNames = new Set(this.states.map(state => state.info.name));
    this.totalModuleBytes = declaredBytes;
    this.receivedBytes = 0;
    this.activeState = null;
    this.finished = false;
  }

  beginModule(index) {
    if (this.finished) fail("invalid-bundle", "A module was opened after finish().");
    if (!Number.isInteger(index) || index < 0 || index >= this.states.length) {
      fail("invalid-bundle", "The bundle opened an undeclared module index.");
    }

    const state = this.states[index];
    if (state.opened) {
      fail("invalid-bundle", `Module ${state.info.name} was opened more than once.`);
    }

    if (!this.retainContent && this.activeState) {
      fail("invalid-bundle",
        `Module ${this.activeState.info.name} must finish before another module is opened.`);
    }

    state.opened = true;
    if (!this.retainContent) this.activeState = state;
    return { stream: new ModuleByteStream(this, state) };
  }

  finishModule(state) {
    if (!this.validateContent) return;
    const bytes = Buffer.concat(state.chunks, state.received);
    const content = state.info.type === "data" || state.info.type === "wasm"
      ? bytes
      : decodeTextModule(bytes, state.info.name);
    validateIsolateModuleContent(
      state.info.name, state.info.type, content, this.moduleNames);
    state.digest = Crypto.createHash("sha256").update(bytes).digest("hex");
    if (!this.retainContent) state.chunks = [];
    if (this.activeState === state) this.activeState = null;
  }

  bundleInfo() {
    return {
      formatVersion: this.info.formatVersion,
      mainModule: this.info.mainModule,
      compatibilityDate: this.info.compatibilityDate,
      compatibilityFlags: [...(this.info.compatibilityFlags || [])],
      modules: this.states.map(state => ({ ...state.info })),
    };
  }

  finish() {
    if (this.finished) fail("invalid-bundle", "Bundle finish() was called more than once.");
    this.states.forEach((state) => {
      if (!state.opened || !state.done) {
        fail("invalid-bundle", `Module ${state.info.name} did not finish streaming.`);
      }
    });
    this.finished = true;
  }

  result() {
    if (!this.finished) fail("invalid-bundle", "The bundle did not call finish().");
    return {
      formatVersion: this.info.formatVersion,
      mainModule: this.info.mainModule,
      compatibilityDate: this.info.compatibilityDate,
      compatibilityFlags: this.info.compatibilityFlags || [],
      modules: this.states.map((state) => {
        const bytes = Buffer.concat(state.chunks, state.received);
        return {
          name: state.info.name,
          type: state.info.type,
          content: state.info.type === "data" || state.info.type === "wasm"
            ? bytes
            : decodeTextModule(bytes, state.info.name),
        };
      }),
    };
  }

  snapshot() {
    if (!this.finished || this.retainContent ||
        this.states.some(state => !/^[0-9a-f]{64}$/.test(state.digest || ""))) {
      fail("invalid-bundle", "The streamed isolate snapshot is incomplete.");
    }

    const bundleInfo = this.bundleInfo();
    bundleInfo.modules.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    const digests = new Map(this.states.map(state => [state.info.name, state.digest]));
    const canonicalText = JSON.stringify({
      ...bundleInfo,
      modules: bundleInfo.modules.map(module => ({
        ...module,
        digest: digests.get(module.name),
      })),
    });
    const digest = Crypto.createHash("sha256")
      .update("sandstorm-isolate-streamed-candidate-v1\0")
      .update(canonicalText, "utf8")
      .digest("hex");
    bundleInfo.modules.forEach(Object.freeze);
    Object.freeze(bundleInfo.modules);
    Object.freeze(bundleInfo.compatibilityFlags);
    Object.freeze(bundleInfo);
    return Object.freeze({
      digest,
      bundleInfo,
      totalModuleBytes: this.totalModuleBytes,
      validationWarnings: [],
    });
  }
}

class StagedIsolateBundleReceiver {
  constructor(receiver, upload, wrapByteStream = value => value) {
    this.receiver = receiver;
    this.upload = upload;
    this.wrapByteStream = wrapByteStream;
  }

  async beginModule(index) {
    const local = this.receiver.beginModule(index).stream;
    const response = await this.upload.beginModule(index);
    const remote = response && response.stream;
    if (!remote || typeof remote.write !== "function" || typeof remote.done !== "function") {
      fail("package-generation-failed", "The backend returned an invalid module upload stream.");
    }

    return { stream: this.wrapByteStream(new StagedModuleByteStream(local, remote)) };
  }

  async finish() {
    this.receiver.finish();
    await this.upload.finish();
  }
}

async function transferIsolateBundle(bundle, receiver, wrappers) {
  const receiverCap = wrappers.wrapReceiver ? wrappers.wrapReceiver(receiver) : receiver;
  try {
    await bundle.transfer(receiverCap);
  } finally {
    if (wrappers.wrapReceiver && receiverCap.close) receiverCap.close();
  }
}

async function receiveIsolateBundle(bundle, wrappers = {}) {
  if (!bundle || typeof bundle.getInfo !== "function" || typeof bundle.transfer !== "function") {
    fail("invalid-bundle", "preview() requires a live IsolateBundle capability.");
  }

  const response = await bundle.getInfo();
  const receiver = new IsolateBundleReceiver(response && response.info);
  const wrapped = {
    beginModule(index) {
      const result = receiver.beginModule(index);
      return { stream: wrappers.wrapByteStream
        ? wrappers.wrapByteStream(result.stream)
        : result.stream };
    },
    finish() {
      return receiver.finish();
    },
  };
  await transferIsolateBundle(bundle, wrapped, wrappers);
  return receiver.result();
}

async function receiveStagedIsolateBundle(bundle, backendCap, metadata, wrappers = {}) {
  if (!backendCap || typeof backendCap.streamIsolatePackage !== "function") {
    fail("invalid-context", "Streaming an isolate bundle requires a backend capability.");
  }

  if (!bundle || typeof bundle.getInfo !== "function" || typeof bundle.transfer !== "function") {
    fail("invalid-bundle", "preview() requires a live IsolateBundle capability.");
  }

  const response = await bundle.getInfo();
  const receiver = new IsolateBundleReceiver(response && response.info, {
    retainContent: false,
    enforceAggregateLimit: false,
    validateContent: true,
  });
  const uploadResponse = await backendCap.streamIsolatePackage(
    "", metadata, receiver.bundleInfo());
  const upload = uploadResponse && uploadResponse.upload;
  if (!upload || typeof upload.beginModule !== "function" ||
      typeof upload.finish !== "function" || typeof upload.save !== "function") {
    fail("package-generation-failed", "The backend returned an invalid isolate upload.");
  }

  try {
    const stagedReceiver = new StagedIsolateBundleReceiver(
      receiver, upload, wrappers.wrapByteStream);
    await transferIsolateBundle(bundle, stagedReceiver, wrappers);
    return { snapshot: receiver.snapshot(), packageUpload: upload };
  } catch (error) {
    if (typeof upload.close === "function") upload.close();
    throw error;
  }
}

async function receivePreviewBundle(db, grant, bundle, wrappers = {}, packageRequest) {
  const actor = {
    accountId: grant.ownerId,
    requestingGrainId: grant.requestingGrainId,
    operationScope: `isolate-preview-grant:${grant._id}`,
  };
  await requireIsolatePreviewAdmission(db, actor);
  if (packageRequest) {
    const staged = await receiveStagedIsolateBundle(
      bundle, packageRequest.backendCap, packageRequest.metadata, wrappers);
    return { actor, ...staged };
  }

  return { actor, receivedBundle: await receiveIsolateBundle(bundle, wrappers) };
}

async function requirePreviewGrant(db, grantId) {
  if (typeof grantId !== "string" || grantId.length === 0) {
    fail("invalid-grant", "The isolate preview grant is invalid.");
  }

  const grant = await db.collections.isolateFactoryGrants.findOneAsync({
    _id: grantId,
    kind: "preview",
    revokedAt: { $exists: false },
  });
  if (!grant) fail("grant-revoked", "The isolate preview grant has been revoked.");
  if (grant.expiresAt && grant.expiresAt <= new Date()) {
    fail("grant-expired", "The isolate preview grant has expired.");
  }

  const grain = await db.collections.grains.findOneAsync({
    _id: grant.requestingGrainId,
    userId: grant.ownerId,
    trashed: { $ne: true },
  });
  if (!grain) {
    fail("grant-revoked", "The authoring grain for this preview grant is unavailable.");
  }

  return grant;
}

async function createPreviewGrant(db, session, request) {
  ownKeys(request, ["accountId"], "Isolate preview grant request");
  check(request.accountId, String);
  if (!session.userId || request.accountId !== session.userId) {
    throw new Meteor.Error(403, "An isolate preview grant must be charged to its user.");
  }

  const account = await db.collections.users.findOneAsync(session.userId);
  if (!await db.isAccountSignedUpOrDemoAsync(account)) {
    throw new Meteor.Error(403, "This account cannot create isolate previews.");
  }

  const grain = await db.collections.grains.findOneAsync(session.grainId);
  if (!grain || grain.userId !== session.userId || grain.trashed) {
    throw new Meteor.Error(403,
      "Only the owner of an active authoring grain can grant isolate preview authority.");
  }

  const grantId = Random.id();
  await db.collections.isolateFactoryGrants.insertAsync({
    _id: grantId,
    kind: "preview",
    ownerId: session.userId,
    requestingGrainId: session.grainId,
    createdAt: new Date(),
  });

  return {
    grantId,
    requirements: [{
      permissionsHeld: {
        accountId: session.userId,
        grainId: session.grainId,
        permissions: [],
      },
    }],
  };
}

async function revokePreviewGrantIfUnreferenced(db, grantId) {
  const savedCopy = await db.collections.apiTokens.findOneAsync({
    "frontendRef.isolatePreviewer.grantId": grantId,
    revoked: { $ne: true },
  });
  if (savedCopy) return false;

  const result = await db.collections.isolateFactoryGrants.updateAsync({
    _id: grantId,
    kind: "preview",
    revokedAt: { $exists: false },
  }, {
    $set: { revokedAt: new Date() },
  });
  return result > 0;
}

export {
  IsolateBundleReceiver,
  createPreviewGrant,
  fail,
  ownKeys,
  receiveIsolateBundle,
  receivePreviewBundle,
  receiveStagedIsolateBundle,
  revokePreviewGrantIfUnreferenced,
  requirePreviewGrant,
};
