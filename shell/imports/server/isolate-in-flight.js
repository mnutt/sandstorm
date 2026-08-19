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

async function coalesceInFlightOperation(
    operations, key, inputKey, callback, makeConflictError) {
  const running = operations.get(key);
  if (running) {
    if (running.inputKey !== inputKey) throw makeConflictError();
    return await running.promise;
  }

  const promise = Promise.resolve().then(callback);
  operations.set(key, { inputKey, promise });
  try {
    return await promise;
  } finally {
    if (operations.get(key)?.promise === promise) operations.delete(key);
  }
}

export { coalesceInFlightOperation };
