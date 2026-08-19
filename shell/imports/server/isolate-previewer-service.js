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

import { ISOLATE_BUNDLE_LIMITS } from "/imports/server/isolate-bundle";
import { requireIsolatePreviewAdmission } from "/imports/server/isolate-preview-service";

const MODULE_TYPES = ["esModule", "json", "text"];

class IsolatePreviewGrantError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "IsolatePreviewGrantError";
    this.code = code;
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

function decodeModule(bytes, name) {
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

    if (this.receiver.receivedBytes + chunk.length >
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

    this.state.done = true;
  }
}

class IsolateBundleReceiver {
  constructor(info, wrapByteStream = value => value) {
    if (!info || typeof info !== "object") {
      fail("invalid-bundle", "IsolateBundle.getInfo() returned no bundle information.");
    }

    const modules = info.modules || [];
    if (!Array.isArray(modules) || modules.length === 0 ||
        modules.length > ISOLATE_BUNDLE_LIMITS.maxModules) {
      fail("bundle-limit-exceeded",
        `A streamed bundle must contain 1-${ISOLATE_BUNDLE_LIMITS.maxModules} modules.`);
    }

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
      if (declaredBytes > ISOLATE_BUNDLE_LIMITS.maxTotalModuleBytes) {
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
    this.wrapByteStream = wrapByteStream;
    this.receivedBytes = 0;
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

    state.opened = true;
    return { stream: this.wrapByteStream(new ModuleByteStream(this, state)) };
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
          content: decodeModule(bytes, state.info.name),
        };
      }),
    };
  }
}

async function receiveIsolateBundle(bundle, wrappers = {}) {
  if (!bundle || typeof bundle.getInfo !== "function" || typeof bundle.transfer !== "function") {
    fail("invalid-bundle", "preview() requires a live IsolateBundle capability.");
  }

  const response = await bundle.getInfo();
  const receiver = new IsolateBundleReceiver(response && response.info, wrappers.wrapByteStream);
  const receiverCap = wrappers.wrapReceiver ? wrappers.wrapReceiver(receiver) : receiver;
  try {
    await bundle.transfer(receiverCap);
    return receiver.result();
  } finally {
    if (wrappers.wrapReceiver && receiverCap.close) receiverCap.close();
  }
}

async function receivePreviewBundle(db, grant, bundle, wrappers = {}) {
  const actor = {
    accountId: grant.ownerId,
    requestingGrainId: grant.requestingGrainId,
    operationScope: `isolate-preview-grant:${grant._id}`,
  };
  await requireIsolatePreviewAdmission(db, actor);
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
  revokePreviewGrantIfUnreferenced,
  requirePreviewGrant,
};
