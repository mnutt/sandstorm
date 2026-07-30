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

#ifndef SANDSTORM_ISOLATE_SESSION_REGISTRY_H_
#define SANDSTORM_ISOLATE_SESSION_REGISTRY_H_

#include <capnp/capability.h>
#include <kj/memory.h>
#include <kj/string.h>
#include <kj/vector.h>
#include <sandstorm/grain.capnp.h>

namespace sandstorm {

class IsolateSessionRegistry final: public kj::Refcounted {
public:
  struct BrowserHandoffCapability {
    uint64_t interfaceId;
    kj::String interfaceName;
    capnp::Capability::Client cap;
  };

  kj::String registerSession(SessionContext::Client context);
  kj::String registerOfferSession(
      SessionContext::Client context, capnp::Capability::Client offer);
  void unregisterSession(kj::StringPtr id);

  kj::Maybe<SessionContext::Client> findSessionContext(kj::StringPtr id);
  kj::Maybe<capnp::Capability::Client> findOfferedCapability(kj::StringPtr sessionId);

  kj::String storeBrowserHandoffCapability(
      kj::StringPtr sessionId, uint64_t interfaceId, kj::StringPtr interfaceName,
      capnp::Capability::Client cap);
  bool dropBrowserHandoffCapability(kj::StringPtr id);
  kj::Maybe<BrowserHandoffCapability> takeBrowserHandoffCapability(
      kj::StringPtr sessionId, kj::StringPtr id, uint64_t interfaceId);

private:
  kj::String registerSession(
      SessionContext::Client context, kj::Maybe<capnp::Capability::Client> offeredCapability);
  kj::String storeBrowserHandoffCapabilityInternal(
      kj::StringPtr sessionId, uint64_t interfaceId, kj::StringPtr interfaceName,
      capnp::Capability::Client cap);
  void removeBrowserHandoffCapability(size_t index);

  struct SessionRecord {
    kj::String id;
    SessionContext::Client context;
    kj::Maybe<capnp::Capability::Client> offeredCapability;
  };

  struct BrowserHandoffCapabilityRecord {
    kj::String id;
    kj::String sessionId;
    uint64_t interfaceId;
    kj::String interfaceName;
    capnp::Capability::Client cap;
  };

  kj::Maybe<size_t> findSessionIndex(kj::StringPtr id);
  kj::Maybe<size_t> findBrowserHandoffCapabilityIndex(kj::StringPtr id);

  kj::Vector<SessionRecord> sessions;
  kj::Vector<BrowserHandoffCapabilityRecord> browserHandoffCapabilities;
};

}  // namespace sandstorm

#endif  // SANDSTORM_ISOLATE_SESSION_REGISTRY_H_
