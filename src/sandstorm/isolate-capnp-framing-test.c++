// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2026 Sandstorm contributors
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

#include "isolate-capnp-framing.h"

#include <capnp/rpc.capnp.h>
#include <capnp/serialize.h>
#include <kj/debug.h>
#include <kj/io.h>
#include <kj/test.h>

namespace sandstorm {
namespace {

void parseRpcFrame(kj::ArrayPtr<const kj::byte> frame) {
  capnp::ReaderOptions options;
  options.traversalLimitInWords = 8 * 1024;
  options.nestingLimit = 64;
  auto reader = parseIsolateCapnpRpcFrame(frame, options);
  kj::str(reader->getRoot<capnp::rpc::Message>());
}

void exerciseFrame(kj::ArrayPtr<const kj::byte> frame) {
  kj::runCatchingExceptions([&]() {
    parseRpcFrame(frame);
  });
}

KJ_TEST("isolate Cap'n Proto framing parses a valid RPC message") {
  capnp::MallocMessageBuilder message;
  message.initRoot<capnp::rpc::Message>().initBootstrap().setQuestionId(7);
  kj::VectorOutputStream output;
  capnp::writeMessage(output, message);

  auto reader = parseIsolateCapnpRpcFrame(output.getArray());
  auto root = reader->getRoot<capnp::rpc::Message>();
  KJ_EXPECT(root.isBootstrap());
  KJ_EXPECT(root.getBootstrap().getQuestionId() == 7);
}

KJ_TEST("isolate Cap'n Proto framing rejects malformed deterministic cases") {
  static const kj::byte CASES[][16] = {
    {},
    {0},
    {0xff, 0xff, 0xff, 0xff},
    {0, 0, 0, 0, 1, 0, 0, 0},
    {1, 0, 0, 0, 0xff, 0xff, 0xff, 0x7f},
  };
  static const size_t SIZES[] = {0, 1, 4, 8, 8};

  for (auto i: kj::indices(SIZES)) {
    KJ_EXPECT_THROW(FAILED, parseRpcFrame(kj::arrayPtr(CASES[i], SIZES[i])));
  }
}

KJ_TEST("isolate Cap'n Proto framing survives generated malformed corpus") {
  uint64_t state = 0x6a09e667f3bcc909ull;
  kj::byte bytes[512];
  for (size_t caseNumber = 0; caseNumber < 4096; ++caseNumber) {
    state ^= state << 13;
    state ^= state >> 7;
    state ^= state << 17;
    size_t size = state % sizeof(bytes);
    for (size_t i = 0; i < size; ++i) {
      state ^= state << 13;
      state ^= state >> 7;
      state ^= state << 17;
      bytes[i] = state & 0xff;
    }
    exerciseFrame(kj::arrayPtr(bytes, size));
  }
}

}  // namespace
}  // namespace sandstorm
