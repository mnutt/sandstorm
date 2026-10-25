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

import { Writable, pipeline } from "stream";

// Keep only one RPC write outstanding. Otherwise a fast download can queue enough
// messages to exceed node-capnp's writev buffer limit (and consume unbounded memory).
export function uploadBackupStream(input, stream, onProgress = () => {}) {
  let bytes = 0;
  const output = new Writable({
    write(chunk, encoding, callback) {
      Promise.resolve().then(() => stream.write(chunk)).then(() => {
        bytes += chunk.length;
        onProgress(bytes);
      }).then(() => callback(), callback);
    },
    final(callback) {
      Promise.resolve().then(() => stream.done()).then(() => callback(), callback);
    },
  });

  return new Promise((resolve, reject) => {
    // pipeline also rejects premature close/abort and stops the input on RPC failure.
    pipeline(input, output, (error) => {
      try {
        stream.close();
      } catch (closeError) {
        if (!error) error = closeError;
      }
      if (error) reject(error);
      else resolve();
    });
  });
}
