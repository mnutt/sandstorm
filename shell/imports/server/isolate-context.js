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

const MAX_CONTEXT_IDENTIFIER_BYTES = 512;

function makeIsolateContextValidator(ErrorType, actorAction) {
  function fail(message) {
    throw new ErrorType("invalid-context", message);
  }

  function requireIdentifier(
      value, field, maximumBytes = MAX_CONTEXT_IDENTIFIER_BYTES) {
    if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
      fail(`${field} must be a non-empty string without NUL characters.`);
    }

    if (Buffer.byteLength(value, "utf8") > maximumBytes) {
      fail(`${field} exceeds the ${maximumBytes}-byte limit.`);
    }

    return value;
  }

  function normalizeActor(input) {
    if (!input || typeof input !== "object") {
      fail(`${actorAction} requires an explicit actor.`);
    }

    const actor = {
      accountId: requireIdentifier(input.accountId, "accountId"),
      operationScope: requireIdentifier(input.operationScope, "operationScope"),
    };
    if (input.requestingGrainId !== undefined && input.requestingGrainId !== null) {
      actor.requestingGrainId = requireIdentifier(input.requestingGrainId, "requestingGrainId");
    }

    return actor;
  }

  return Object.freeze({ normalizeActor, requireIdentifier });
}

export { makeIsolateContextValidator };
