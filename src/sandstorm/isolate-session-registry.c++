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

#include "util.h"

#include <fcntl.h>
#include <kj/debug.h>
#include <kj/encoding.h>

namespace sandstorm {
namespace {

kj::String makeOpaqueToken() {
  auto bytes = kj::heapArray<kj::byte>(18);
  kj::FdInputStream(raiiOpen("/dev/urandom", O_RDONLY)).read(bytes.begin(), bytes.size());
  return kj::encodeBase64Url(bytes);
}

}  // namespace

kj::String IsolateSessionRegistry::registerSession(SessionContext::Client context) {
  return registerSession(kj::mv(context), nullptr);
}

kj::String IsolateSessionRegistry::registerOfferSession(
    SessionContext::Client context, capnp::Capability::Client offer) {
  return registerSession(kj::mv(context), kj::mv(offer));
}

kj::String IsolateSessionRegistry::registerSession(
    SessionContext::Client context,
    kj::Maybe<capnp::Capability::Client> offeredCapability) {
  for (;;) {
    auto id = makeOpaqueToken();
    if (findSessionIndex(id) == nullptr) {
      sessions.add(SessionRecord { kj::heapString(id), context, kj::mv(offeredCapability) });
      return id;
    }
  }
}

void IsolateSessionRegistry::unregisterSession(kj::StringPtr id) {
  KJ_IF_MAYBE(index, findSessionIndex(id)) {
    if (*index + 1 < sessions.size()) {
      sessions[*index] = kj::mv(sessions.back());
    }
    sessions.removeLast();
  }

  // Handoffs are scoped to the browser session that created them. Reclaim both the record and its
  // live capability as part of unregister so a closed tab cannot pin authority indefinitely.
  for (size_t i = browserHandoffCapabilities.size(); i > 0; --i) {
    if (browserHandoffCapabilities[i - 1].sessionId == id) {
      removeBrowserHandoffCapability(i - 1);
    }
  }
}

kj::Maybe<SessionContext::Client> IsolateSessionRegistry::findSessionContext(kj::StringPtr id) {
  KJ_IF_MAYBE(index, findSessionIndex(id)) {
    return sessions[*index].context;
  }
  return nullptr;
}

kj::Maybe<capnp::Capability::Client> IsolateSessionRegistry::findOfferedCapability(
    kj::StringPtr sessionId) {
  KJ_IF_MAYBE(index, findSessionIndex(sessionId)) {
    KJ_IF_MAYBE(cap, sessions[*index].offeredCapability) {
      return *cap;
    }
  }
  return nullptr;
}

kj::String IsolateSessionRegistry::storeBrowserHandoffCapability(
    kj::StringPtr sessionId, capnp::Capability::Client cap) {
  KJ_REQUIRE(findSessionIndex(sessionId) != nullptr,
      "browser handoff requires a registered session", sessionId);
  return storeBrowserHandoffCapabilityInternal(sessionId, kj::mv(cap));
}

bool IsolateSessionRegistry::dropBrowserHandoffCapability(kj::StringPtr id) {
  KJ_IF_MAYBE(index, findBrowserHandoffCapabilityIndex(id)) {
    removeBrowserHandoffCapability(*index);
    return true;
  }
  return false;
}

kj::Maybe<capnp::Capability::Client> IsolateSessionRegistry::findBrowserHandoffCapability(
    kj::StringPtr sessionId, kj::StringPtr id) {
  KJ_IF_MAYBE(index, findBrowserHandoffCapabilityIndex(id)) {
    if (browserHandoffCapabilities[*index].sessionId == sessionId) {
      return browserHandoffCapabilities[*index].cap;
    }
  }
  return nullptr;
}

kj::String IsolateSessionRegistry::storeBrowserHandoffCapabilityInternal(
    kj::StringPtr sessionId, capnp::Capability::Client cap) {
  for (;;) {
    auto id = makeOpaqueToken();
    if (findBrowserHandoffCapabilityIndex(id) == nullptr) {
      browserHandoffCapabilities.add(BrowserHandoffCapabilityRecord {
        kj::heapString(id), kj::heapString(sessionId), cap });
      return id;
    }
  }
}

void IsolateSessionRegistry::removeBrowserHandoffCapability(size_t index) {
  KJ_REQUIRE(index < browserHandoffCapabilities.size());
  if (index + 1 < browserHandoffCapabilities.size()) {
    browserHandoffCapabilities[index] = kj::mv(browserHandoffCapabilities.back());
  }
  browserHandoffCapabilities.removeLast();
}

kj::Maybe<size_t> IsolateSessionRegistry::findSessionIndex(kj::StringPtr id) {
  for (auto i: kj::indices(sessions)) {
    if (sessions[i].id == id) return i;
  }
  return nullptr;
}

kj::Maybe<size_t> IsolateSessionRegistry::findBrowserHandoffCapabilityIndex(kj::StringPtr id) {
  for (auto i: kj::indices(browserHandoffCapabilities)) {
    if (browserHandoffCapabilities[i].id == id) return i;
  }
  return nullptr;
}

}  // namespace sandstorm
