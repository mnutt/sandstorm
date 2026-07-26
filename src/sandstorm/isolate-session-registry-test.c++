// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2026 Sandstorm contributors
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

#include "isolate-session-registry.h"

#include <kj/test.h>

namespace sandstorm {
namespace {

class EmptySessionContext final: public SessionContext::Server {};

class TrackedSessionContext final: public SessionContext::Server {
public:
  explicit TrackedSessionContext(bool& released): released(released) {}
  ~TrackedSessionContext() noexcept { released = true; }

private:
  bool& released;
};

KJ_TEST("isolate session unregister releases browser handoff capabilities") {
  IsolateSessionRegistry registry;
  auto sessionId = registry.registerSession(kj::heap<EmptySessionContext>());
  bool released = false;
  SessionContext::Client tracked = kj::heap<TrackedSessionContext>(released);
  capnp::Capability::Client capability = tracked;
  auto handoffId = registry.storeBrowserHandoffCapability(
      sessionId, 0xdeadbeef, "test.Interface", kj::mv(capability));
  tracked = nullptr;

  KJ_EXPECT(!released);
  registry.unregisterSession(sessionId);
  KJ_EXPECT(registry.takeBrowserHandoffCapability(
      sessionId, handoffId, 0xdeadbeef) == nullptr);
  KJ_EXPECT(released);
}

KJ_TEST("browser handoff validates its interface and can be consumed only once") {
  IsolateSessionRegistry registry;
  auto sessionId = registry.registerSession(kj::heap<EmptySessionContext>());
  SessionContext::Client capability = kj::heap<EmptySessionContext>();
  auto handoffId = registry.storeBrowserHandoffCapability(
      sessionId, 0x1234, "test.Interface", capability);

  KJ_EXPECT(registry.takeBrowserHandoffCapability(sessionId, handoffId, 0x5678) == nullptr);
  KJ_IF_MAYBE(handoff,
      registry.takeBrowserHandoffCapability(sessionId, handoffId, 0x1234)) {
    KJ_EXPECT(handoff->interfaceId == 0x1234);
    KJ_EXPECT(handoff->interfaceName == "test.Interface");
  } else {
    KJ_FAIL_EXPECT("typed browser handoff was not found");
  }
  KJ_EXPECT(registry.takeBrowserHandoffCapability(sessionId, handoffId, 0x1234) == nullptr);
}

}  // namespace
}  // namespace sandstorm
