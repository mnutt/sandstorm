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
  auto handoffId = registry.storeBrowserHandoffCapability(sessionId, kj::mv(capability));
  tracked = nullptr;

  KJ_EXPECT(registry.findBrowserHandoffCapability(sessionId, handoffId) != nullptr);
  KJ_EXPECT(!released);
  registry.unregisterSession(sessionId);
  KJ_EXPECT(registry.findBrowserHandoffCapability(sessionId, handoffId) == nullptr);
  KJ_EXPECT(released);
}

}  // namespace
}  // namespace sandstorm
