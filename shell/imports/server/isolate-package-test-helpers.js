// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2026 Sandstorm Development Group, Inc. and contributors
// All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

function fakeStreamedIsolatePackageUpload(info, savePackage) {
  const states = info.modules.map(module => ({
    info: module,
    opened: false,
    done: false,
    chunks: [],
    received: 0,
  }));
  let finished = false;
  return {
    upload: {
      async beginModule(index) {
        const state = states[index];
        if (!state || state.opened || finished) throw new Error("invalid fake module stream");
        state.opened = true;
        return {
          stream: {
            async expectSize(size) {
              if (state.received + size !== state.info.size) {
                throw new Error("fake module size mismatch");
              }
            },
            async write(data) {
              const chunk = Buffer.from(data);
              state.received += chunk.length;
              if (state.received > state.info.size) throw new Error("fake module overflow");
              state.chunks.push(chunk);
            },
            async done() {
              if (state.done || state.received !== state.info.size) {
                throw new Error("incomplete fake module stream");
              }

              state.done = true;
            },
            close() {},
          },
        };
      },
      async finish() {
        if (finished || states.some(state => !state.done)) {
          throw new Error("incomplete fake isolate upload");
        }

        finished = true;
      },
      async save() {
        if (!finished) throw new Error("fake isolate upload saved before finish");
        return await savePackage({
          formatVersion: info.formatVersion,
          mainModule: info.mainModule,
          compatibilityDate: info.compatibilityDate,
          compatibilityFlags: info.compatibilityFlags,
          modules: states.map((state) => ({
            name: state.info.name,
            [state.info.type]: Buffer.concat(state.chunks, state.received),
          })),
          bindings: [],
        });
      },
      close() {},
    },
  };
}

export { fakeStreamedIsolatePackageUpload };
