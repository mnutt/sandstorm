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

import {
  resolveIsolatePreviewForAuthoringGrain,
} from "/imports/server/isolate-preview-presentation";

const DEFAULT_PREVIEW_LOG_BACKLOG_BYTES = 8192;
const MAX_PREVIEW_LOG_BACKLOG_BYTES = 64 * 1024;

class IsolatePreviewLogError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "IsolatePreviewLogError";
    this.code = code;
    this.kjType = "failed";
  }
}

function fail(code, message) {
  throw new IsolatePreviewLogError(code, message);
}

function normalizeDigest(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    fail("invalid-preview-digest", "The isolate preview digest is invalid.");
  }

  const bytes = Buffer.from(value);
  if (bytes.length !== 32) {
    fail("invalid-preview-digest", "The isolate preview digest is invalid.");
  }

  return bytes.toString("hex");
}

function normalizeBacklogAmount(value) {
  const amount = value === undefined ? DEFAULT_PREVIEW_LOG_BACKLOG_BYTES : value;
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > MAX_PREVIEW_LOG_BACKLOG_BYTES) {
    fail("preview-log-limit-exceeded",
      `Preview log backlog must be at most ${MAX_PREVIEW_LOG_BACKLOG_BYTES} bytes.`);
  }

  return amount;
}

async function watchIsolatePreviewLog(
    db, backend, grant, normalizedDigest, backlogAmount, stream) {
  if (!grant || typeof grant.ownerId !== "string" ||
      typeof grant.requestingGrainId !== "string") {
    fail("invalid-grant", "The isolate preview grant is invalid.");
  }

  if (!stream || typeof stream.write !== "function") {
    fail("invalid-stream", "watchPreviewLog() requires a ByteStream capability.");
  }

  const digest = normalizeDigest(normalizedDigest);
  const amount = normalizeBacklogAmount(backlogAmount);
  const target = await resolveIsolatePreviewForAuthoringGrain(
    db, grant.ownerId, grant.requestingGrainId, digest);
  const result = await backend.useGrain(target.grainId, supervisor =>
    supervisor.watchLog(amount, stream));
  if (!result || !result.handle) {
    fail("preview-log-unavailable", "The isolate preview log could not be opened.");
  }

  return result;
}

export {
  DEFAULT_PREVIEW_LOG_BACKLOG_BYTES,
  IsolatePreviewLogError,
  MAX_PREVIEW_LOG_BACKLOG_BYTES,
  watchIsolatePreviewLog,
};
