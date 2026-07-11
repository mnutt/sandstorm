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

#include <capnp/serialize.h>
#include <kj/io.h>

namespace sandstorm {

kj::Own<capnp::MessageReader> parseIsolateCapnpRpcFrame(
    kj::ArrayPtr<const kj::byte> frame, capnp::ReaderOptions options,
    kj::ArrayPtr<capnp::word> scratchSpace) {
  kj::ArrayInputStream input(frame);
  return kj::heap<capnp::InputStreamMessageReader>(input, options, scratchSpace);
}

}  // namespace sandstorm
