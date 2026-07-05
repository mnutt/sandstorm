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

#include "isolate-supervisor.h"

#include "isolate-util.h"
#include "sandbox.h"
#include "util.h"
#include "version.h"

#include <sandstorm/isolate/api.js.h>
#include <sandstorm/isolate/capnweb.js.h>
#include <sandstorm/isolate/capnp-es.js.h>
#include <sandstorm/isolate/capnp.js.h>
#include <sandstorm/isolate/native-capnp-bridge.js.h>
#include <sandstorm/isolate/rpc.js.h>

#include <capnp/message.h>
#include <capnp/compat/json.h>
#include <capnp/rpc-twoparty.h>
#include <capnp/schema.h>
#include <capnp/serialize.h>
#include <capnp/serialize-packed.h>
#include <kj/async-io.h>
#include <kj/async-unix.h>
#include <kj/compat/http.h>
#include <kj/debug.h>
#include <kj/encoding.h>
#include <kj/io.h>
#include <kj/refcount.h>
#include <sandstorm/api-session.capnp.h>
#include <sandstorm/grain.capnp.h>
#include <sandstorm/identity.capnp.h>
#include <sandstorm/isolate-native-capnp-bridge.capnp.h>
#include <sandstorm/isolate-supervisor-internal.capnp.h>
#include <sandstorm/outbound-http-session.capnp.h>
#include <sandstorm/package.capnp.h>
#include <sandstorm/powerbox.capnp.h>
#include <sandstorm/supervisor.capnp.h>
#include <sandstorm/util.capnp.h>
#include <sandstorm/web-session.capnp.h>
#include <netinet/in.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <sys/inotify.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/ptrace.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <dirent.h>
#include <unistd.h>
#include <time.h>
#include <fcntl.h>
#include <errno.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>
#include <sched.h>

#ifndef __NR_bpf
#define __NR_bpf 321
#endif
#ifndef __NR_userfaultfd
#define __NR_userfaultfd 323
#endif
#include <seccomp.h>

#ifndef PR_SET_NO_NEW_PRIVS
#define PR_SET_NO_NEW_PRIVS 38
#endif
#ifndef PR_SET_VMA
#define PR_SET_VMA 0x53564d41
#endif

namespace sandstorm {

namespace {

constexpr const char* ISOLATE_ROUTE_BACKED_APP_REF_PREFIX =
    "sandstorm-isolate-route-backed-v1\n";

struct IsolateRuntimeConfig final: public kj::Refcounted {
  enum class ModuleType {
    ES_MODULE,
    COMMON_JS_MODULE,
    TEXT,
    DATA,
    WASM,
    JSON,
  };

  enum class BindingType {
    TEXT,
    DATA,
    JSON,
    SANDSTORM_API,
    STORAGE,
    POWERBOX,
    SERVICE,
  };

  struct Module {
    kj::String name;
    ModuleType type;
    kj::String sourcePath;
    kj::Array<byte> content;
  };

  struct Binding {
    kj::String name;
    BindingType type;
    kj::Array<byte> value;
    kj::String serviceName;
  };

  kj::String mainModule;
  kj::String compatibilityDate;
  kj::String appTitle;
  kj::String apiPath;
  kj::String workerdBundleDir;
  kj::String workerdConfigPath;
  kj::String workerdSocketPath;
  kj::String sandstormApiSocketPath;
  kj::String powerboxSocketPath;
  kj::String storageSocketPath;
  kj::String storageRootPath;
  kj::Own<capnp::MallocMessageBuilder> viewInfoMessage;
  kj::Vector<kj::String> compatibilityFlags;
  kj::Vector<Module> modules;
  kj::Vector<Binding> bindings;
};

kj::String makeOpaqueToken() {
  kj::Array<byte> bytes = kj::heapArray<byte>(18);
  kj::FdInputStream(raiiOpen("/dev/urandom", O_RDONLY)).read(bytes.begin(), bytes.size());
  return kj::encodeBase64Url(bytes);
}

enum class ClaimedCapabilityKind {
  UNKNOWN,
  POWERBOX_CLAIM,
  POWERBOX_OFFER,
  RESTORED,
  TIED,
  ROUTE_BACKED_WEB_SESSION,
  ROUTE_BACKED_API_SESSION,
  ROUTE_BACKED_APP_OBJECT,
};

enum class ClaimedCapabilityResidence {
  UNKNOWN,
  LOCAL_EXPORT,
  IMPORTED,
};

enum class ClaimedCapabilityNativeInterface {
  UNKNOWN,
  WEB_SESSION,
  API_SESSION,
  OUTBOUND_HTTP_SESSION,
  APP_OBJECT,
};

kj::StringPtr claimedCapabilityKindName(ClaimedCapabilityKind kind) {
  switch (kind) {
    case ClaimedCapabilityKind::UNKNOWN:
      return "unknown";
    case ClaimedCapabilityKind::POWERBOX_CLAIM:
      return "powerboxClaim";
    case ClaimedCapabilityKind::POWERBOX_OFFER:
      return "powerboxOffer";
    case ClaimedCapabilityKind::RESTORED:
      return "restored";
    case ClaimedCapabilityKind::TIED:
      return "tied";
    case ClaimedCapabilityKind::ROUTE_BACKED_WEB_SESSION:
      return "routeBackedWebSession";
    case ClaimedCapabilityKind::ROUTE_BACKED_API_SESSION:
      return "routeBackedApiSession";
    case ClaimedCapabilityKind::ROUTE_BACKED_APP_OBJECT:
      return "routeBackedAppObject";
  }
  KJ_UNREACHABLE;
}

kj::StringPtr claimedCapabilityResidenceName(ClaimedCapabilityResidence residence) {
  switch (residence) {
    case ClaimedCapabilityResidence::UNKNOWN:
      return "unknown";
    case ClaimedCapabilityResidence::LOCAL_EXPORT:
      return "localExport";
    case ClaimedCapabilityResidence::IMPORTED:
      return "imported";
  }
  KJ_UNREACHABLE;
}

kj::StringPtr claimedCapabilityNativeInterfaceName(
    ClaimedCapabilityNativeInterface nativeInterface) {
  switch (nativeInterface) {
    case ClaimedCapabilityNativeInterface::UNKNOWN:
      return "unknown";
    case ClaimedCapabilityNativeInterface::WEB_SESSION:
      return "webSession";
    case ClaimedCapabilityNativeInterface::API_SESSION:
      return "apiSession";
    case ClaimedCapabilityNativeInterface::OUTBOUND_HTTP_SESSION:
      return "outboundHttpSession";
    case ClaimedCapabilityNativeInterface::APP_OBJECT:
      return "appObject";
  }
  KJ_UNREACHABLE;
}

kj::Maybe<ClaimedCapabilityNativeInterface> claimedCapabilityNativeInterfaceFromName(
    kj::StringPtr name) {
  if (name == "unknown") {
    return ClaimedCapabilityNativeInterface::UNKNOWN;
  } else if (name == "webSession") {
    return ClaimedCapabilityNativeInterface::WEB_SESSION;
  } else if (name == "apiSession") {
    return ClaimedCapabilityNativeInterface::API_SESSION;
  } else if (name == "outboundHttpSession") {
    return ClaimedCapabilityNativeInterface::OUTBOUND_HTTP_SESSION;
  } else if (name == "appObject") {
    return ClaimedCapabilityNativeInterface::APP_OBJECT;
  } else {
    return nullptr;
  }
}

bool claimedCapabilitySupportsWebFetch(ClaimedCapabilityNativeInterface nativeInterface) {
  switch (nativeInterface) {
    case ClaimedCapabilityNativeInterface::UNKNOWN:
    case ClaimedCapabilityNativeInterface::WEB_SESSION:
    case ClaimedCapabilityNativeInterface::API_SESSION:
      return true;
    case ClaimedCapabilityNativeInterface::OUTBOUND_HTTP_SESSION:
    case ClaimedCapabilityNativeInterface::APP_OBJECT:
      return false;
  }
  KJ_UNREACHABLE;
}

bool claimedCapabilitySupportsOutboundHttpFetch(
    ClaimedCapabilityNativeInterface nativeInterface) {
  switch (nativeInterface) {
    case ClaimedCapabilityNativeInterface::UNKNOWN:
    case ClaimedCapabilityNativeInterface::OUTBOUND_HTTP_SESSION:
      return true;
    case ClaimedCapabilityNativeInterface::WEB_SESSION:
    case ClaimedCapabilityNativeInterface::API_SESSION:
    case ClaimedCapabilityNativeInterface::APP_OBJECT:
      return false;
  }
  KJ_UNREACHABLE;
}

bool claimedCapabilitySupportsAppObjectCall(ClaimedCapabilityNativeInterface nativeInterface) {
  switch (nativeInterface) {
    case ClaimedCapabilityNativeInterface::APP_OBJECT:
      return true;
    case ClaimedCapabilityNativeInterface::UNKNOWN:
    case ClaimedCapabilityNativeInterface::WEB_SESSION:
    case ClaimedCapabilityNativeInterface::API_SESSION:
    case ClaimedCapabilityNativeInterface::OUTBOUND_HTTP_SESSION:
      return false;
  }
  KJ_UNREACHABLE;
}

struct ClaimedCapabilityMetadata {
  ClaimedCapabilityKind kind = ClaimedCapabilityKind::UNKNOWN;
  ClaimedCapabilityResidence residence = ClaimedCapabilityResidence::UNKNOWN;
  ClaimedCapabilityNativeInterface nativeInterface = ClaimedCapabilityNativeInterface::UNKNOWN;
  kj::String pathPrefix = kj::heapString("");
  bool persistent = true;
  bool hasDropNotify = false;
  bool hasNativeCapability = true;
  bool liveForwardable = true;
};

ClaimedCapabilityMetadata copyClaimedCapabilityMetadata(
    const ClaimedCapabilityMetadata& metadata) {
  return ClaimedCapabilityMetadata {
    metadata.kind,
    metadata.residence,
    metadata.nativeInterface,
    kj::heapString(metadata.pathPrefix),
    metadata.persistent,
    metadata.hasDropNotify,
    metadata.hasNativeCapability,
    metadata.liveForwardable,
  };
}

ClaimedCapabilityMetadata makeImportedClaimedCapabilityMetadata(
    ClaimedCapabilityKind kind,
    ClaimedCapabilityNativeInterface nativeInterface = ClaimedCapabilityNativeInterface::UNKNOWN) {
  return ClaimedCapabilityMetadata {
    kind,
    ClaimedCapabilityResidence::IMPORTED,
    nativeInterface,
    kj::heapString(""),
    true,
    false,
    true,
    true,
  };
}

struct ClaimedCapabilityInfo {
  ClaimedCapabilityMetadata metadata;
  uint dropNotifyRefCount = 0;
};

struct ClaimedCapabilityStats {
  uint claimedCapabilityCount = 0;
  uint dropNotifyGroupCount = 0;
  uint localExportCount = 0;
  uint importedCount = 0;
  uint webSessionNativeCount = 0;
  uint apiSessionNativeCount = 0;
  uint outboundHttpNativeCount = 0;
  uint appObjectNativeCount = 0;
  uint unknownNativeCount = 0;
  uint routeBackedWebSessionCount = 0;
  uint routeBackedApiSessionCount = 0;
  uint routeBackedAppObjectCount = 0;
  uint powerboxClaimCount = 0;
  uint powerboxOfferCount = 0;
  uint restoredCount = 0;
  uint tiedCount = 0;
};

class IsolateSessionRegistry final: public kj::Refcounted {
public:
  kj::String registerSession(SessionContext::Client context) {
    for (;;) {
      auto id = makeOpaqueToken();
      if (findSessionIndex(id) == nullptr) {
        sessions.add(SessionRecord { kj::heapString(id), context });
        return id;
      }
    }
  }

  void unregisterSession(kj::StringPtr id) {
    KJ_IF_MAYBE(index, findSessionIndex(id)) {
      if (*index + 1 < sessions.size()) {
        sessions[*index] = kj::mv(sessions.back());
      }
      sessions.removeLast();
    }
  }

  kj::Maybe<SessionContext::Client> findSessionContext(kj::StringPtr id) {
    KJ_IF_MAYBE(index, findSessionIndex(id)) {
      return sessions[*index].context;
    }

    return nullptr;
  }

  kj::String storeClaimedCapability(capnp::Capability::Client cap,
      ClaimedCapabilityMetadata metadata = ClaimedCapabilityMetadata()) {
    return storeClaimedCapabilityInternal(kj::mv(cap), kj::mv(metadata), nullptr);
  }

  kj::String storeClaimedCapability(capnp::Capability::Client cap,
      ClaimedCapabilityMetadata metadata, kj::String dropNotifyPath) {
    metadata.hasDropNotify = true;
    return storeClaimedCapabilityInternal(kj::mv(cap), kj::mv(metadata),
        createDropNotifyGroup(kj::mv(dropNotifyPath)));
  }

  kj::Maybe<kj::String> duplicateClaimedCapability(kj::StringPtr id) {
    KJ_IF_MAYBE(index, findClaimedCapabilityIndex(id)) {
      kj::Maybe<kj::String> dropNotifyGroupId = nullptr;
      KJ_IF_MAYBE(groupId, claimedCapabilities[*index].dropNotifyGroupId) {
        retainDropNotifyGroup(*groupId);
        dropNotifyGroupId = kj::heapString(*groupId);
      }
      return storeClaimedCapabilityInternal(
          claimedCapabilities[*index].cap,
          copyClaimedCapabilityMetadata(claimedCapabilities[*index].metadata),
          kj::mv(dropNotifyGroupId));
    }

    return nullptr;
  }

  struct DroppedClaimedCapability {
    capnp::Capability::Client cap;
    ClaimedCapabilityMetadata metadata;
    kj::Maybe<kj::String> dropNotifyPath;
  };

  kj::Maybe<DroppedClaimedCapability> dropClaimedCapability(kj::StringPtr id) {
    KJ_IF_MAYBE(index, findClaimedCapabilityIndex(id)) {
      DroppedClaimedCapability result {
        claimedCapabilities[*index].cap,
        copyClaimedCapabilityMetadata(claimedCapabilities[*index].metadata),
        nullptr,
      };
      KJ_IF_MAYBE(groupId, claimedCapabilities[*index].dropNotifyGroupId) {
        result.dropNotifyPath = releaseDropNotifyGroup(*groupId);
      }
      if (*index + 1 < claimedCapabilities.size()) {
        claimedCapabilities[*index] = kj::mv(claimedCapabilities.back());
      }
      claimedCapabilities.removeLast();
      return kj::mv(result);
    }

    return nullptr;
  }

  kj::Maybe<capnp::Capability::Client> findClaimedCapability(kj::StringPtr id) {
    KJ_IF_MAYBE(index, findClaimedCapabilityIndex(id)) {
      return claimedCapabilities[*index].cap;
    }

    return nullptr;
  }

  kj::Maybe<ClaimedCapabilityInfo> findClaimedCapabilityInfo(kj::StringPtr id) {
    KJ_IF_MAYBE(index, findClaimedCapabilityIndex(id)) {
      uint dropNotifyRefCount = 0;
      KJ_IF_MAYBE(groupId, claimedCapabilities[*index].dropNotifyGroupId) {
        KJ_IF_MAYBE(groupIndex, findDropNotifyGroupIndex(*groupId)) {
          dropNotifyRefCount = dropNotifyGroups[*groupIndex].refcount;
        } else {
          KJ_FAIL_REQUIRE("isolate claimed capability drop-notify group is missing");
        }
      }
      return ClaimedCapabilityInfo {
        copyClaimedCapabilityMetadata(claimedCapabilities[*index].metadata),
        dropNotifyRefCount,
      };
    }

    return nullptr;
  }

  kj::Maybe<ClaimedCapabilityNativeInterface> findClaimedCapabilityNativeInterface(
      kj::StringPtr id) {
    KJ_IF_MAYBE(index, findClaimedCapabilityIndex(id)) {
      return claimedCapabilities[*index].metadata.nativeInterface;
    }

    return nullptr;
  }

  kj::Maybe<ClaimedCapabilityMetadata> findClaimedCapabilityMetadata(kj::StringPtr id) {
    KJ_IF_MAYBE(index, findClaimedCapabilityIndex(id)) {
      return copyClaimedCapabilityMetadata(claimedCapabilities[*index].metadata);
    }

    return nullptr;
  }

  ClaimedCapabilityStats getClaimedCapabilityStats() {
    ClaimedCapabilityStats stats {
      static_cast<uint>(claimedCapabilities.size()),
      static_cast<uint>(dropNotifyGroups.size()),
    };
    for (auto& capability: claimedCapabilities) {
      switch (capability.metadata.residence) {
        case ClaimedCapabilityResidence::LOCAL_EXPORT:
          ++stats.localExportCount;
          break;
        case ClaimedCapabilityResidence::IMPORTED:
          ++stats.importedCount;
          break;
        case ClaimedCapabilityResidence::UNKNOWN:
          break;
      }

      switch (capability.metadata.nativeInterface) {
        case ClaimedCapabilityNativeInterface::WEB_SESSION:
          ++stats.webSessionNativeCount;
          break;
        case ClaimedCapabilityNativeInterface::API_SESSION:
          ++stats.apiSessionNativeCount;
          break;
        case ClaimedCapabilityNativeInterface::OUTBOUND_HTTP_SESSION:
          ++stats.outboundHttpNativeCount;
          break;
        case ClaimedCapabilityNativeInterface::APP_OBJECT:
          ++stats.appObjectNativeCount;
          break;
        case ClaimedCapabilityNativeInterface::UNKNOWN:
          ++stats.unknownNativeCount;
          break;
      }

      switch (capability.metadata.kind) {
        case ClaimedCapabilityKind::ROUTE_BACKED_WEB_SESSION:
          ++stats.routeBackedWebSessionCount;
          break;
        case ClaimedCapabilityKind::ROUTE_BACKED_API_SESSION:
          ++stats.routeBackedApiSessionCount;
          break;
        case ClaimedCapabilityKind::ROUTE_BACKED_APP_OBJECT:
          ++stats.routeBackedAppObjectCount;
          break;
        case ClaimedCapabilityKind::POWERBOX_CLAIM:
          ++stats.powerboxClaimCount;
          break;
        case ClaimedCapabilityKind::POWERBOX_OFFER:
          ++stats.powerboxOfferCount;
          break;
        case ClaimedCapabilityKind::RESTORED:
          ++stats.restoredCount;
          break;
        case ClaimedCapabilityKind::TIED:
          ++stats.tiedCount;
          break;
        case ClaimedCapabilityKind::UNKNOWN:
          break;
      }
    }
    return stats;
  }

private:
  kj::String storeClaimedCapabilityInternal(capnp::Capability::Client cap,
      ClaimedCapabilityMetadata metadata, kj::Maybe<kj::String> dropNotifyGroupId) {
    for (;;) {
      auto id = makeOpaqueToken();
      if (findClaimedCapabilityIndex(id) == nullptr) {
        claimedCapabilities.add(ClaimedCapabilityRecord {
            kj::heapString(id), cap, kj::mv(metadata), kj::mv(dropNotifyGroupId) });
        return id;
      }
    }
  }

  kj::String createDropNotifyGroup(kj::String dropNotifyPath) {
    for (;;) {
      auto id = makeOpaqueToken();
      if (findDropNotifyGroupIndex(id) == nullptr) {
        dropNotifyGroups.add(DropNotifyGroup { kj::heapString(id), kj::mv(dropNotifyPath), 1 });
        return id;
      }
    }
  }

  void retainDropNotifyGroup(kj::StringPtr id) {
    KJ_IF_MAYBE(index, findDropNotifyGroupIndex(id)) {
      ++dropNotifyGroups[*index].refcount;
    } else {
      KJ_FAIL_REQUIRE("isolate claimed capability drop-notify group is missing");
    }
  }

  kj::Maybe<kj::String> releaseDropNotifyGroup(kj::StringPtr id) {
    KJ_IF_MAYBE(index, findDropNotifyGroupIndex(id)) {
      KJ_REQUIRE(dropNotifyGroups[*index].refcount > 0);
      --dropNotifyGroups[*index].refcount;
      if (dropNotifyGroups[*index].refcount == 0) {
        auto dropNotifyPath = kj::mv(dropNotifyGroups[*index].dropNotifyPath);
        if (*index + 1 < dropNotifyGroups.size()) {
          dropNotifyGroups[*index] = kj::mv(dropNotifyGroups.back());
        }
        dropNotifyGroups.removeLast();
        return kj::mv(dropNotifyPath);
      }
      return nullptr;
    } else {
      KJ_FAIL_REQUIRE("isolate claimed capability drop-notify group is missing");
    }
  }

  struct SessionRecord {
    kj::String id;
    SessionContext::Client context;
  };

  struct ClaimedCapabilityRecord {
    kj::String id;
    capnp::Capability::Client cap;
    ClaimedCapabilityMetadata metadata;
    kj::Maybe<kj::String> dropNotifyGroupId;
  };

  struct DropNotifyGroup {
    kj::String id;
    kj::Maybe<kj::String> dropNotifyPath;
    uint refcount;
  };

  kj::Maybe<size_t> findSessionIndex(kj::StringPtr id) {
    for (auto i: kj::indices(sessions)) {
      if (sessions[i].id == id) {
        return i;
      }
    }

    return nullptr;
  }

  kj::Maybe<size_t> findClaimedCapabilityIndex(kj::StringPtr id) {
    for (auto i: kj::indices(claimedCapabilities)) {
      if (claimedCapabilities[i].id == id) {
        return i;
      }
    }

    return nullptr;
  }

  kj::Vector<SessionRecord> sessions;
  kj::Vector<ClaimedCapabilityRecord> claimedCapabilities;
  kj::Vector<DropNotifyGroup> dropNotifyGroups;

  kj::Maybe<size_t> findDropNotifyGroupIndex(kj::StringPtr id) {
    for (auto i: kj::indices(dropNotifyGroups)) {
      if (dropNotifyGroups[i].id == id) {
        return i;
      }
    }

    return nullptr;
  }
};

struct IsolateRuntimeHost final: public kj::Refcounted {
  IsolateRuntimeHost(
      kj::Network& network, kj::Timer& timer, kj::StringPtr grainId,
      SandstormCore::Client sandstormCore)
      : network(network), timer(timer), grainId(kj::heapString(grainId)),
        sandstormCore(kj::mv(sandstormCore)),
        sessions(kj::refcounted<IsolateSessionRegistry>()) {}

  kj::Network& network;
  kj::Timer& timer;
  kj::String grainId;
  SandstormCore::Client sandstormCore;
  kj::HttpHeaderTable headerTable;
  kj::Own<IsolateSessionRegistry> sessions;
};

IsolateRuntimeConfig::ModuleType getModuleType(
    spk::Manifest::IsolateConfig::Module::Reader module) {
  switch (module.which()) {
    case spk::Manifest::IsolateConfig::Module::ES_MODULE_PATH:
      return IsolateRuntimeConfig::ModuleType::ES_MODULE;
    case spk::Manifest::IsolateConfig::Module::COMMON_JS_MODULE_PATH:
      return IsolateRuntimeConfig::ModuleType::COMMON_JS_MODULE;
    case spk::Manifest::IsolateConfig::Module::TEXT_PATH:
      return IsolateRuntimeConfig::ModuleType::TEXT;
    case spk::Manifest::IsolateConfig::Module::DATA_PATH:
      return IsolateRuntimeConfig::ModuleType::DATA;
    case spk::Manifest::IsolateConfig::Module::WASM_PATH:
      return IsolateRuntimeConfig::ModuleType::WASM;
    case spk::Manifest::IsolateConfig::Module::JSON_PATH:
      return IsolateRuntimeConfig::ModuleType::JSON;
  }

  KJ_UNREACHABLE;
}

kj::StringPtr moduleTypeName(IsolateRuntimeConfig::ModuleType type) {
  switch (type) {
    case IsolateRuntimeConfig::ModuleType::ES_MODULE:
      return "esModule";
    case IsolateRuntimeConfig::ModuleType::COMMON_JS_MODULE:
      return "commonJsModule";
    case IsolateRuntimeConfig::ModuleType::TEXT:
      return "text";
    case IsolateRuntimeConfig::ModuleType::DATA:
      return "data";
    case IsolateRuntimeConfig::ModuleType::WASM:
      return "wasm";
    case IsolateRuntimeConfig::ModuleType::JSON:
      return "json";
  }

  KJ_UNREACHABLE;
}

IsolateRuntimeConfig::BindingType getBindingType(
    spk::Manifest::IsolateConfig::Binding::Reader binding) {
  switch (binding.which()) {
    case spk::Manifest::IsolateConfig::Binding::TEXT:
      return IsolateRuntimeConfig::BindingType::TEXT;
    case spk::Manifest::IsolateConfig::Binding::DATA:
      return IsolateRuntimeConfig::BindingType::DATA;
    case spk::Manifest::IsolateConfig::Binding::JSON:
      return IsolateRuntimeConfig::BindingType::JSON;
    case spk::Manifest::IsolateConfig::Binding::SANDSTORM_API:
      return IsolateRuntimeConfig::BindingType::SANDSTORM_API;
    case spk::Manifest::IsolateConfig::Binding::STORAGE:
      return IsolateRuntimeConfig::BindingType::STORAGE;
    case spk::Manifest::IsolateConfig::Binding::POWERBOX:
      return IsolateRuntimeConfig::BindingType::POWERBOX;
    case spk::Manifest::IsolateConfig::Binding::SERVICE:
      return IsolateRuntimeConfig::BindingType::SERVICE;
  }

  KJ_UNREACHABLE;
}

kj::StringPtr bindingTypeName(IsolateRuntimeConfig::BindingType type) {
  switch (type) {
    case IsolateRuntimeConfig::BindingType::TEXT:
      return "text";
    case IsolateRuntimeConfig::BindingType::DATA:
      return "data";
    case IsolateRuntimeConfig::BindingType::JSON:
      return "json";
    case IsolateRuntimeConfig::BindingType::SANDSTORM_API:
      return "sandstormApi";
    case IsolateRuntimeConfig::BindingType::STORAGE:
      return "storage";
    case IsolateRuntimeConfig::BindingType::POWERBOX:
      return "powerbox";
    case IsolateRuntimeConfig::BindingType::SERVICE:
      return "service";
  }

  KJ_UNREACHABLE;
}

bool isImplementedBinding(IsolateRuntimeConfig::BindingType type) {
  switch (type) {
    case IsolateRuntimeConfig::BindingType::TEXT:
    case IsolateRuntimeConfig::BindingType::DATA:
    case IsolateRuntimeConfig::BindingType::JSON:
    case IsolateRuntimeConfig::BindingType::SANDSTORM_API:
    case IsolateRuntimeConfig::BindingType::STORAGE:
    case IsolateRuntimeConfig::BindingType::POWERBOX:
    case IsolateRuntimeConfig::BindingType::SERVICE:
      return true;
  }

  KJ_UNREACHABLE;
}

kj::StringPtr moduleFileExtension(IsolateRuntimeConfig::ModuleType type) {
  switch (type) {
    case IsolateRuntimeConfig::ModuleType::ES_MODULE:
      return ".mjs";
    case IsolateRuntimeConfig::ModuleType::COMMON_JS_MODULE:
      return ".cjs";
    case IsolateRuntimeConfig::ModuleType::TEXT:
      return ".txt";
    case IsolateRuntimeConfig::ModuleType::DATA:
      return ".bin";
    case IsolateRuntimeConfig::ModuleType::WASM:
      return ".wasm";
    case IsolateRuntimeConfig::ModuleType::JSON:
      return ".json";
  }

  KJ_UNREACHABLE;
}

kj::String copyModuleSourcePath(spk::Manifest::IsolateConfig::Module::Reader module) {
  switch (module.which()) {
    case spk::Manifest::IsolateConfig::Module::ES_MODULE_PATH:
      return kj::heapString(module.getEsModulePath());
    case spk::Manifest::IsolateConfig::Module::COMMON_JS_MODULE_PATH:
      return kj::heapString(module.getCommonJsModulePath());
    case spk::Manifest::IsolateConfig::Module::TEXT_PATH:
      return kj::heapString(module.getTextPath());
    case spk::Manifest::IsolateConfig::Module::DATA_PATH:
      return kj::heapString(module.getDataPath());
    case spk::Manifest::IsolateConfig::Module::WASM_PATH:
      return kj::heapString(module.getWasmPath());
    case spk::Manifest::IsolateConfig::Module::JSON_PATH:
      return kj::heapString(module.getJsonPath());
  }

  KJ_UNREACHABLE;
}

kj::Array<byte> readPackageFile(kj::StringPtr pkgPath, kj::StringPtr sourcePath) {
  KJ_REQUIRE(isCanonicalPackagePath(sourcePath),
      "Isolate module path must be package-relative and canonical.", sourcePath);
  auto packageDir = raiiOpen(pkgPath, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  KJ_IF_MAYBE(file, raiiOpenAtIfExistsContained(
      packageDir, kj::Path::parse(sourcePath), O_RDONLY | O_CLOEXEC)) {
    return readAllBytes(*file);
  }

  KJ_FAIL_REQUIRE("Isolate module path does not exist in package.", sourcePath);
}

kj::Array<byte> copyBindingValue(spk::Manifest::IsolateConfig::Binding::Reader binding) {
  switch (binding.which()) {
    case spk::Manifest::IsolateConfig::Binding::TEXT:
      return kj::heapArray<byte>(binding.getText().asBytes());
    case spk::Manifest::IsolateConfig::Binding::DATA:
      return kj::heapArray<byte>(binding.getData());
    case spk::Manifest::IsolateConfig::Binding::JSON:
      return kj::heapArray<byte>(binding.getJson().asBytes());
    case spk::Manifest::IsolateConfig::Binding::SANDSTORM_API:
    case spk::Manifest::IsolateConfig::Binding::STORAGE:
    case spk::Manifest::IsolateConfig::Binding::POWERBOX:
    case spk::Manifest::IsolateConfig::Binding::SERVICE:
      return nullptr;
  }

  KJ_UNREACHABLE;
}

void validateIsolateRuntimeConfig(IsolateRuntimeConfig& config) {
  KJ_REQUIRE(config.mainModule.size() > 0, "Isolate command is missing mainModule.");
  KJ_REQUIRE(config.apiPath.size() == 0 || config.apiPath.endsWith("/"),
      "Isolate bridgeConfig.apiPath must be empty or end with '/'.", config.apiPath);

  for (auto i: kj::indices(config.compatibilityFlags)) {
    auto& flag = config.compatibilityFlags[i];
    KJ_REQUIRE(flag.size() > 0, "Isolate compatibility flag is empty.");

    for (uint j = 0; j < i; ++j) {
      KJ_REQUIRE(config.compatibilityFlags[j] != flag,
          "Isolate command has duplicate compatibility flags.", flag);
    }
  }

  bool foundMainModule = false;
  for (auto i: kj::indices(config.modules)) {
    auto& module = config.modules[i];
    KJ_REQUIRE(module.name.size() > 0, "Isolate module is missing name.");
    if (module.name == config.mainModule) {
      foundMainModule = true;
    }

    for (uint j = 0; j < i; ++j) {
      KJ_REQUIRE(config.modules[j].name != module.name,
          "Isolate command has duplicate module names.", module.name);
    }
  }
  KJ_REQUIRE(foundMainModule, "Isolate mainModule does not match any configured module.",
      config.mainModule);

  for (auto i: kj::indices(config.bindings)) {
    auto& binding = config.bindings[i];
    KJ_REQUIRE(binding.name.size() > 0, "Isolate binding is missing name.");
    KJ_REQUIRE(isImplementedBinding(binding.type),
        "Isolate binding type is declared in the manifest schema but is not implemented yet.",
        binding.name, bindingTypeName(binding.type));
    if (binding.type == IsolateRuntimeConfig::BindingType::SERVICE) {
      KJ_REQUIRE(binding.serviceName.size() > 0, "Isolate service binding is missing service name.",
          binding.name);
    }

    for (uint j = 0; j < i; ++j) {
      KJ_REQUIRE(config.bindings[j].name != binding.name,
          "Isolate command has duplicate binding names.", binding.name);
    }
  }
}

bool hasIsolateModule(IsolateRuntimeConfig& config, kj::StringPtr name) {
  for (auto& module: config.modules) {
    if (module.name == name) {
      return true;
    }
  }

  return false;
}

void addGeneratedIsolateModule(
    IsolateRuntimeConfig& config, kj::StringPtr name, IsolateRuntimeConfig::ModuleType type,
    kj::StringPtr source) {
  if (hasIsolateModule(config, name)) {
    return;
  }

  IsolateRuntimeConfig::Module moduleConfig;
  moduleConfig.name = kj::heapString(name);
  moduleConfig.type = type;
  moduleConfig.sourcePath = kj::str("<generated:", name, ">");
  moduleConfig.content = kj::heapArray<byte>(source.asBytes());
  config.modules.add(kj::mv(moduleConfig));
}

void addGeneratedIsolateHelperModules(IsolateRuntimeConfig& config) {
  addGeneratedIsolateModule(config, "capnweb", IsolateRuntimeConfig::ModuleType::ES_MODULE,
      CAPNWEB_SOURCE);
  addGeneratedIsolateModule(config, "sandstorm:capnweb-source",
      IsolateRuntimeConfig::ModuleType::TEXT, CAPNWEB_SOURCE);
  addGeneratedIsolateModule(config, "sandstorm:rpc", IsolateRuntimeConfig::ModuleType::ES_MODULE,
      ISOLATE_RPC_HELPER_SOURCE);
  addGeneratedIsolateModule(config, "sandstorm:api", IsolateRuntimeConfig::ModuleType::ES_MODULE,
      ISOLATE_API_HELPER_SOURCE);
  addGeneratedIsolateModule(config, "sandstorm:capnp", IsolateRuntimeConfig::ModuleType::ES_MODULE,
      ISOLATE_CAPNP_HELPER_SOURCE);
  addGeneratedIsolateModule(config, "sandstorm:native-capnp-bridge",
      IsolateRuntimeConfig::ModuleType::ES_MODULE, ISOLATE_NATIVE_CAPNP_BRIDGE_SOURCE);
  for (auto& module: ISOLATE_CAPNP_ES_MODULES) {
    addGeneratedIsolateModule(
        config, module.name, IsolateRuntimeConfig::ModuleType::ES_MODULE, module.source);
  }
}

kj::Own<IsolateRuntimeConfig> copyIsolateConfig(
    spk::Manifest::IsolateConfig::Reader config, kj::StringPtr pkgPath) {
  auto result = kj::refcounted<IsolateRuntimeConfig>();
  result->mainModule = kj::heapString(config.getMainModule());
  result->compatibilityDate = kj::heapString(config.getCompatibilityDate());
  auto bridgeConfig = config.getBridgeConfig();
  result->apiPath = kj::heapString(bridgeConfig.getApiPath());
  auto viewInfo = bridgeConfig.getViewInfo();
  result->viewInfoMessage = kj::heap<capnp::MallocMessageBuilder>(
      viewInfo.totalSize().wordCount + 4);
  result->viewInfoMessage->setRoot(viewInfo);
  auto powerboxApis = bridgeConfig.getPowerboxApis();
  if (powerboxApis.size() > 0) {
    auto copiedViewInfo = result->viewInfoMessage->getRoot<UiView::ViewInfo>();
    auto descriptors = copiedViewInfo.initMatchRequests(powerboxApis.size());
    for (auto i: kj::indices(powerboxApis)) {
      auto tag = descriptors[i].initTags(1)[0];
      tag.setId(capnp::typeId<ApiSession>());
      tag.getValue().setAs<ApiSession::PowerboxTag>(powerboxApis[i].getTag());
    }
  }
  result->appTitle = kj::heapString(viewInfo.getAppTitle().getDefaultText());
  for (auto flag: config.getCompatibilityFlags()) {
    result->compatibilityFlags.add(kj::heapString(flag));
  }

  for (auto module: config.getModules()) {
    IsolateRuntimeConfig::Module moduleConfig;
    moduleConfig.name = kj::heapString(module.getName());
    moduleConfig.type = getModuleType(module);
    moduleConfig.sourcePath = copyModuleSourcePath(module);
    moduleConfig.content = readPackageFile(pkgPath, moduleConfig.sourcePath);
    result->modules.add(kj::mv(moduleConfig));
  }
  addGeneratedIsolateHelperModules(*result);

  for (auto binding: config.getBindings()) {
    IsolateRuntimeConfig::Binding bindingConfig;
    bindingConfig.name = kj::heapString(binding.getName());
    bindingConfig.type = getBindingType(binding);
    bindingConfig.value = copyBindingValue(binding);
    if (binding.which() == spk::Manifest::IsolateConfig::Binding::SERVICE) {
      bindingConfig.serviceName = kj::heapString(binding.getService());
    }
    result->bindings.add(kj::mv(bindingConfig));
  }

  validateIsolateRuntimeConfig(*result);
  return result;
}

kj::String htmlEscape(kj::StringPtr text) {
  kj::Vector<char> result(text.size() + 1);
  for (char c: text) {
    switch (c) {
      case '<': result.addAll(kj::StringPtr("&lt;")); break;
      case '>': result.addAll(kj::StringPtr("&gt;")); break;
      case '&': result.addAll(kj::StringPtr("&amp;")); break;
      case '"': result.addAll(kj::StringPtr("&quot;")); break;
      default: result.add(c); break;
    }
  }
  result.add('\0');
  return kj::String(result.releaseAsArray());
}

void appendString(kj::Vector<char>& target, kj::StringPtr value) {
  target.addAll(value);
}

kj::StringPtr appTitleOrDefault(IsolateRuntimeConfig& config) {
  return config.appTitle.size() > 0 ? config.appTitle.asPtr() : kj::StringPtr("Isolate grain");
}

kj::String renderCompatibilityFlagsHtml(IsolateRuntimeConfig& config) {
  if (config.compatibilityFlags.size() == 0) {
    return kj::heapString("<p>None</p>");
  }

  kj::Vector<char> result;
  result.addAll(kj::StringPtr("<ul>"));

  for (auto& flag: config.compatibilityFlags) {
    auto escapedFlag = htmlEscape(flag);
    auto line = kj::str("<li><code>", escapedFlag, "</code></li>");
    appendString(result, line);
  }

  result.addAll(kj::StringPtr("</ul>"));
  result.add('\0');
  return kj::String(result.releaseAsArray());
}

kj::String renderModuleListHtml(IsolateRuntimeConfig& config) {
  kj::Vector<char> result;
  result.addAll(kj::StringPtr("<ul>"));

  for (auto& module: config.modules) {
    auto name = htmlEscape(module.name);
    auto line = kj::str("<li><code>", name, "</code> <span>(", moduleTypeName(module.type),
        ", ", module.content.size(), " bytes)</span></li>");
    appendString(result, line);
  }

  result.addAll(kj::StringPtr("</ul>"));
  result.add('\0');
  return kj::String(result.releaseAsArray());
}

kj::String renderBindingListHtml(IsolateRuntimeConfig& config) {
  kj::Vector<char> result;
  result.addAll(kj::StringPtr("<ul>"));

  for (auto& binding: config.bindings) {
    auto name = htmlEscape(binding.name);
    kj::String serviceSuffix;
    if (binding.type == IsolateRuntimeConfig::BindingType::SERVICE) {
      auto serviceName = htmlEscape(binding.serviceName);
      serviceSuffix = kj::str(" -> <code>", serviceName, "</code>");
    } else {
      serviceSuffix = kj::heapString("");
    }

    auto line = kj::str("<li><code>", name, "</code> <span>(", bindingTypeName(binding.type),
        serviceSuffix, ")</span></li>");
    appendString(result, line);
  }

  result.addAll(kj::StringPtr("</ul>"));
  result.add('\0');
  return kj::String(result.releaseAsArray());
}

void ensureDirectory(kj::StringPtr path) {
  if (mkdir(path.cStr(), 0770) != 0) {
    int error = errno;
    if (error != EEXIST) {
      KJ_FAIL_SYSCALL("mkdir", error, path);
    }

    struct stat stats;
    KJ_SYSCALL(lstat(path.cStr(), &stats), path);
    KJ_REQUIRE(S_ISDIR(stats.st_mode) && !S_ISLNK(stats.st_mode),
        "Generated isolate runtime path exists but is not a real directory.", path);
  }

  int fd;
  KJ_SYSCALL(fd = open(path.cStr(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW), path);
  KJ_DEFER(close(fd));
  KJ_SYSCALL(fchmod(fd, 0770), path);
}

void chownPathTo(kj::StringPtr path, uid_t uid) {
  KJ_SYSCALL(lchown(path.cStr(), uid, static_cast<gid_t>(-1)), path);
}

void writeAllToFd(int fd, kj::ArrayPtr<const byte> content) {
  while (content.size() > 0) {
    ssize_t n;
    KJ_SYSCALL(n = write(fd, content.begin(), content.size()));
    KJ_REQUIRE(n > 0, "write() made no progress");
    auto written = static_cast<size_t>(n);
    content = content.slice(written, content.size());
  }
}

void writeFile(kj::StringPtr path, kj::ArrayPtr<const byte> content) {
  int fd;
  KJ_SYSCALL(fd = open(path.cStr(),
      O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC | O_NOFOLLOW, 0660), path);
  KJ_DEFER(close(fd));
  KJ_SYSCALL(fchmod(fd, 0660), path);
  writeAllToFd(fd, content);
}

void unlinkIfExists(kj::StringPtr path) {
  if (unlink(path.cStr()) != 0) {
    int error = errno;
    if (error != ENOENT) {
      KJ_FAIL_SYSCALL("unlink", error, path);
    }
  }
}

void unlinkSocketIfExists(kj::StringPtr path) {
  struct stat stats;
  if (lstat(path.cStr(), &stats) != 0) {
    int error = errno;
    if (error == ENOENT || error == ENOTDIR) {
      return;
    }

    KJ_FAIL_SYSCALL("lstat", error, path);
  }

  KJ_REQUIRE(S_ISSOCK(stats.st_mode),
      "Refusing to remove non-socket at generated isolate sidecar socket path.", path);
  KJ_SYSCALL(unlink(path.cStr()), path);
}

uint64_t computeDiskUsage(kj::StringPtr path) {
  struct stat stats;
  if (lstat(path.cStr(), &stats) != 0) {
    int error = errno;
    if (error == ENOENT || error == ENOTDIR) {
      return 0;
    }

    KJ_FAIL_SYSCALL("lstat", error, path);
  }

  uint64_t total = static_cast<uint64_t>(stats.st_blocks) * 512;
  if (!S_ISDIR(stats.st_mode)) {
    return total;
  }

  DIR* dir = opendir(path.cStr());
  if (dir == nullptr) {
    int error = errno;
    if (error == ENOENT || error == ENOTDIR) {
      return total;
    }

    KJ_FAIL_SYSCALL("opendir", error, path);
  }
  KJ_DEFER(closedir(dir));

  for (;;) {
    errno = 0;
    auto entry = readdir(dir);
    if (entry == nullptr) {
      int error = errno;
      if (error != 0) {
        KJ_FAIL_SYSCALL("readdir", error, path);
      }
      break;
    }

    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) {
      continue;
    }

    total += computeDiskUsage(kj::str(path, "/", entry->d_name));
  }

  return total;
}

void appendJsonString(kj::Vector<char>& result, kj::StringPtr text) {
  capnp::MallocMessageBuilder message;
  auto value = message.initRoot<capnp::JsonValue>();
  value.setString(text);

  capnp::JsonCodec codec;
  auto encoded = codec.encodeRaw(value.asReader());
  result.addAll(encoded);
}

char hexDigit(uint value) {
  KJ_ASSERT(value < 16);
  return value < 10 ? '0' + value : 'A' + value - 10;
}

void appendCapnpString(kj::Vector<char>& result, kj::StringPtr text) {
  result.add('"');
  for (unsigned char c: text) {
    switch (c) {
      case '"': result.addAll(kj::StringPtr("\\\"")); break;
      case '\\': result.addAll(kj::StringPtr("\\\\")); break;
      case '\b': result.addAll(kj::StringPtr("\\b")); break;
      case '\f': result.addAll(kj::StringPtr("\\f")); break;
      case '\n': result.addAll(kj::StringPtr("\\n")); break;
      case '\r': result.addAll(kj::StringPtr("\\r")); break;
      case '\t': result.addAll(kj::StringPtr("\\t")); break;
      default: {
        if (c < 0x20) {
          result.addAll(kj::StringPtr("\\x"));
          result.add(hexDigit(c >> 4));
          result.add(hexDigit(c & 0x0f));
        } else {
          result.add(static_cast<char>(c));
        }
        break;
      }
    }
  }
  result.add('"');
}

void appendJsonField(kj::Vector<char>& result, kj::StringPtr name, kj::StringPtr value) {
  appendJsonString(result, name);
  result.addAll(kj::StringPtr(": "));
  appendJsonString(result, value);
}

kj::String moduleBundleFileName(size_t index, IsolateRuntimeConfig::ModuleType type) {
  return kj::str("module-", index, moduleFileExtension(type));
}

kj::String bindingBundleFileName(size_t index) {
  return kj::str("binding-", index, ".bin");
}

void appendWorkerdModule(
    kj::Vector<char>& result, IsolateRuntimeConfig::Module& module, kj::StringPtr fileName) {
  result.addAll(kj::StringPtr("          ( name = "));
  appendCapnpString(result, module.name);
  result.addAll(kj::StringPtr(", "));

  switch (module.type) {
    case IsolateRuntimeConfig::ModuleType::ES_MODULE:
      result.addAll(kj::StringPtr("esModule"));
      break;
    case IsolateRuntimeConfig::ModuleType::COMMON_JS_MODULE:
      result.addAll(kj::StringPtr("commonJsModule"));
      break;
    case IsolateRuntimeConfig::ModuleType::TEXT:
      result.addAll(kj::StringPtr("text"));
      break;
    case IsolateRuntimeConfig::ModuleType::DATA:
      result.addAll(kj::StringPtr("data"));
      break;
    case IsolateRuntimeConfig::ModuleType::WASM:
      result.addAll(kj::StringPtr("wasm"));
      break;
    case IsolateRuntimeConfig::ModuleType::JSON:
      result.addAll(kj::StringPtr("json"));
      break;
  }

  result.addAll(kj::StringPtr(" = embed "));
  appendCapnpString(result, kj::str("modules/", fileName));
  result.addAll(kj::StringPtr(" )"));
}

bool isWorkerdDirectBinding(IsolateRuntimeConfig::Binding& binding) {
  switch (binding.type) {
    case IsolateRuntimeConfig::BindingType::TEXT:
    case IsolateRuntimeConfig::BindingType::DATA:
    case IsolateRuntimeConfig::BindingType::JSON:
    case IsolateRuntimeConfig::BindingType::SANDSTORM_API:
    case IsolateRuntimeConfig::BindingType::STORAGE:
    case IsolateRuntimeConfig::BindingType::POWERBOX:
    case IsolateRuntimeConfig::BindingType::SERVICE:
      return true;
  }

  KJ_UNREACHABLE;
}

void appendWorkerdBinding(
    kj::Vector<char>& result, IsolateRuntimeConfig::Binding& binding, kj::StringPtr fileName) {
  result.addAll(kj::StringPtr("          ( name = "));
  appendCapnpString(result, binding.name);
  result.addAll(kj::StringPtr(", "));

  switch (binding.type) {
    case IsolateRuntimeConfig::BindingType::TEXT: {
      result.addAll(kj::StringPtr("text = "));
      auto text = kj::heapString(binding.value.asChars());
      appendCapnpString(result, text);
      break;
    }
    case IsolateRuntimeConfig::BindingType::DATA:
      result.addAll(kj::StringPtr("data = embed "));
      appendCapnpString(result, kj::str("bindings/", fileName));
      break;
    case IsolateRuntimeConfig::BindingType::JSON: {
      result.addAll(kj::StringPtr("json = "));
      auto text = kj::heapString(binding.value.asChars());
      appendCapnpString(result, text);
      break;
    }
    case IsolateRuntimeConfig::BindingType::SANDSTORM_API:
      result.addAll(kj::StringPtr("service = \"sandstorm-api\""));
      break;
    case IsolateRuntimeConfig::BindingType::STORAGE:
      result.addAll(kj::StringPtr("service = \"sandstorm-storage\""));
      break;
    case IsolateRuntimeConfig::BindingType::POWERBOX:
      result.addAll(kj::StringPtr("service = \"sandstorm-powerbox\""));
      break;
    case IsolateRuntimeConfig::BindingType::SERVICE:
      result.addAll(kj::StringPtr("service = "));
      appendCapnpString(result, binding.serviceName);
      break;
  }

  result.addAll(kj::StringPtr(" )"));
}

bool hasSandstormApiBinding(IsolateRuntimeConfig& config) {
  for (auto& binding: config.bindings) {
    if (binding.type == IsolateRuntimeConfig::BindingType::SANDSTORM_API) {
      return true;
    }
  }

  return false;
}

bool hasStorageBinding(IsolateRuntimeConfig& config) {
  for (auto& binding: config.bindings) {
    if (binding.type == IsolateRuntimeConfig::BindingType::STORAGE) {
      return true;
    }
  }

  return false;
}

bool hasPowerboxBinding(IsolateRuntimeConfig& config) {
  for (auto& binding: config.bindings) {
    if (binding.type == IsolateRuntimeConfig::BindingType::POWERBOX) {
      return true;
    }
  }

  return false;
}

void appendExternalWorkerdService(
    kj::Vector<char>& result, kj::StringPtr name, kj::StringPtr socketPath) {
  result.addAll(kj::StringPtr(",\n    ( name = "));
  appendCapnpString(result, name);
  result.addAll(kj::StringPtr(", external = ( address = "));
  appendCapnpString(result, kj::str("unix:", socketPath));
  result.addAll(kj::StringPtr(", http = () ) )"));
}

void appendWorkerdConfig(
    kj::Vector<char>& result, IsolateRuntimeConfig& config, kj::StringPtr socketPath) {
  result.addAll(kj::StringPtr(
      "using Workerd = import \"/workerd/workerd.capnp\";\n"
      "\n"
      "const sandstormConfig :Workerd.Config = (\n"
      "  services = [\n"
      "    ( name = \"main\", worker = (\n"
      "        modules = [\n"));

  bool needsComma = false;
  auto appendModuleByIndex = [&](size_t index) {
    if (needsComma) {
      result.addAll(kj::StringPtr(",\n"));
    }
    appendWorkerdModule(result, config.modules[index],
        moduleBundleFileName(index, config.modules[index].type));
    needsComma = true;
  };

  for (auto i: kj::indices(config.modules)) {
    if (config.modules[i].name == config.mainModule) {
      appendModuleByIndex(i);
    }
  }
  for (auto i: kj::indices(config.modules)) {
    if (config.modules[i].name != config.mainModule) {
      appendModuleByIndex(i);
    }
  }

  result.addAll(kj::StringPtr("\n        ],\n        compatibilityDate = "));
  appendCapnpString(result, config.compatibilityDate);
  result.addAll(kj::StringPtr(",\n        compatibilityFlags = ["));
  for (auto i: kj::indices(config.compatibilityFlags)) {
    if (i > 0) {
      result.addAll(kj::StringPtr(", "));
    }
    appendCapnpString(result, config.compatibilityFlags[i]);
  }
  result.addAll(kj::StringPtr("],\n        bindings = [\n"));

  needsComma = false;
  for (auto i: kj::indices(config.bindings)) {
    auto& binding = config.bindings[i];
    if (!isWorkerdDirectBinding(binding)) {
      continue;
    }

    if (needsComma) {
      result.addAll(kj::StringPtr(",\n"));
    }
    appendWorkerdBinding(result, binding, bindingBundleFileName(i));
    needsComma = true;
  }

  result.addAll(kj::StringPtr(
      "\n        ]\n"
      "    ) )"));

  if (hasSandstormApiBinding(config)) {
    appendExternalWorkerdService(result, "sandstorm-api", config.sandstormApiSocketPath);
  }
  if (hasStorageBinding(config)) {
    appendExternalWorkerdService(result, "sandstorm-storage", config.storageSocketPath);
  }
  if (hasPowerboxBinding(config)) {
    appendExternalWorkerdService(result, "sandstorm-powerbox", config.powerboxSocketPath);
  }

  result.addAll(kj::StringPtr(
      "\n  ],\n"
      "  sockets = [\n"
      "    ( name = \"sandstorm\", address = "));
  appendCapnpString(result, kj::str("unix:", socketPath));
  result.addAll(kj::StringPtr(
      ", http = (), service = \"main\" )\n"
      "  ]\n"
      ");\n"));
}

kj::String prepareWorkerdBundle(kj::StringPtr varPath, IsolateRuntimeConfig& config) {
  auto bundleDir = kj::str(varPath, "/isolate-runtime");
  auto modulesDir = kj::str(bundleDir, "/modules");
  auto bindingsDir = kj::str(bundleDir, "/bindings");
  auto socketPath = kj::str(bundleDir, "/workerd.sock");
  auto sandstormApiSocketPath = kj::str(bundleDir, "/sandstorm-api.sock");
  auto powerboxSocketPath = kj::str(bundleDir, "/sandstorm-powerbox.sock");
  auto storageSocketPath = kj::str(bundleDir, "/sandstorm-storage.sock");
  auto storageRootPath = kj::str(varPath, "/isolate-storage");
  config.sandstormApiSocketPath = kj::heapString(sandstormApiSocketPath);
  config.powerboxSocketPath = kj::heapString(powerboxSocketPath);
  config.storageSocketPath = kj::heapString(storageSocketPath);
  config.storageRootPath = kj::heapString(storageRootPath);
  ensureDirectory(bundleDir);
  ensureDirectory(modulesDir);
  ensureDirectory(bindingsDir);
  ensureDirectory(storageRootPath);

  kj::Vector<char> manifest;
  manifest.addAll(kj::StringPtr("{\n  "));
  appendJsonField(manifest, "mainModule", config.mainModule);
  manifest.addAll(kj::StringPtr(",\n  "));
  appendJsonField(manifest, "compatibilityDate", config.compatibilityDate);

  manifest.addAll(kj::StringPtr(",\n  \"compatibilityFlags\": ["));
  for (auto i: kj::indices(config.compatibilityFlags)) {
    if (i > 0) manifest.addAll(kj::StringPtr(", "));
    appendJsonString(manifest, config.compatibilityFlags[i]);
  }
  manifest.addAll(kj::StringPtr("],\n  \"modules\": [\n"));

  for (auto i: kj::indices(config.modules)) {
    auto& module = config.modules[i];
    auto fileName = moduleBundleFileName(i, module.type);
    writeFile(kj::str(modulesDir, "/", fileName), module.content);

    if (i > 0) manifest.addAll(kj::StringPtr(",\n"));
    manifest.addAll(kj::StringPtr("    { "));
    appendJsonField(manifest, "name", module.name);
    manifest.addAll(kj::StringPtr(", "));
    appendJsonField(manifest, "type", moduleTypeName(module.type));
    manifest.addAll(kj::StringPtr(", "));
    appendJsonField(manifest, "file", kj::str("modules/", fileName));
    manifest.addAll(kj::StringPtr(" }"));
  }

  manifest.addAll(kj::StringPtr("\n  ],\n  \"bindings\": [\n"));
  for (auto i: kj::indices(config.bindings)) {
    auto& binding = config.bindings[i];
    if (binding.value.size() > 0) {
      writeFile(kj::str(bindingsDir, "/", bindingBundleFileName(i)), binding.value);
    }

    if (i > 0) manifest.addAll(kj::StringPtr(",\n"));
    manifest.addAll(kj::StringPtr("    { "));
    appendJsonField(manifest, "name", binding.name);
    manifest.addAll(kj::StringPtr(", "));
    appendJsonField(manifest, "type", bindingTypeName(binding.type));
    if (binding.value.size() > 0) {
      manifest.addAll(kj::StringPtr(", "));
      appendJsonField(manifest, "file", kj::str("bindings/", bindingBundleFileName(i)));
    }
    if (binding.serviceName.size() > 0) {
      manifest.addAll(kj::StringPtr(", "));
      appendJsonField(manifest, "serviceName", binding.serviceName);
    }
    manifest.addAll(kj::StringPtr(" }"));
  }

  manifest.addAll(kj::StringPtr("\n  ]\n}\n"));
  manifest.add('\0');
  auto manifestText = kj::String(manifest.releaseAsArray());
  writeFile(kj::str(bundleDir, "/runtime-manifest.json"), manifestText.asBytes());

  kj::Vector<char> workerdConfig;
  appendWorkerdConfig(workerdConfig, config, socketPath);
  workerdConfig.add('\0');
  auto workerdConfigText = kj::String(workerdConfig.releaseAsArray());
  writeFile(kj::str(bundleDir, "/workerd.capnp"), workerdConfigText.asBytes());
  return bundleDir;
}

void prepareRuntimeBundleAndCleanupSockets(kj::StringPtr varPath, IsolateRuntimeConfig& config) {
  config.workerdBundleDir = prepareWorkerdBundle(varPath, config);
  config.workerdConfigPath = kj::str(config.workerdBundleDir, "/workerd.capnp");
  config.workerdSocketPath = kj::str(config.workerdBundleDir, "/workerd.sock");
  unlinkSocketIfExists(config.workerdSocketPath);
  unlinkSocketIfExists(config.sandstormApiSocketPath);
  unlinkSocketIfExists(config.powerboxSocketPath);
  unlinkSocketIfExists(config.storageSocketPath);
}

void prepareRuntimeBundleAsSandboxUser(
    kj::StringPtr varPath, IsolateRuntimeConfig& config, kj::Maybe<uid_t> sandboxUid) {
  KJ_IF_MAYBE(u, sandboxUid) {
    KJ_SYSCALL(seteuid(*u));
    KJ_DEFER(KJ_SYSCALL(seteuid(0)));
    prepareRuntimeBundleAndCleanupSockets(varPath, config);
  } else {
    prepareRuntimeBundleAndCleanupSockets(varPath, config);
  }
}

enum class FetchMethod {
  GET,
  HEAD,
  POST,
  PUT,
  DELETE_,
  PATCH,
};

kj::HttpMethod toHttpMethod(FetchMethod method) {
  switch (method) {
    case FetchMethod::GET:
      return kj::HttpMethod::GET;
    case FetchMethod::HEAD:
      return kj::HttpMethod::HEAD;
    case FetchMethod::POST:
      return kj::HttpMethod::POST;
    case FetchMethod::PUT:
      return kj::HttpMethod::PUT;
    case FetchMethod::DELETE_:
      return kj::HttpMethod::DELETE;
    case FetchMethod::PATCH:
      return kj::HttpMethod::PATCH;
  }

  KJ_UNREACHABLE;
}

kj::StringPtr fetchMethodName(FetchMethod method) {
  switch (method) {
    case FetchMethod::GET:
      return "GET";
    case FetchMethod::HEAD:
      return "HEAD";
    case FetchMethod::POST:
      return "POST";
    case FetchMethod::PUT:
      return "PUT";
    case FetchMethod::DELETE_:
      return "DELETE";
    case FetchMethod::PATCH:
      return "PATCH";
  }

  KJ_UNREACHABLE;
}

enum class SessionKind {
  NORMAL,
  REQUEST,
  OFFER,
};

kj::StringPtr sessionKindName(SessionKind kind) {
  switch (kind) {
    case SessionKind::NORMAL:
      return "normal";
    case SessionKind::REQUEST:
      return "request";
    case SessionKind::OFFER:
      return "offer";
  }

  KJ_UNREACHABLE;
}

struct SessionMetadata {
  kj::String sessionId;
  kj::String basePath;
  kj::String host;
  kj::String forwardedProto;
  kj::String userAgent;
  kj::String acceptableLanguages;
  kj::String tabId;
  kj::String userDisplayName;
  kj::String userId;
  kj::String userHandle;
  kj::String userPicture;
  kj::String userPronouns;
  kj::String permissions;
  kj::String offeredCapabilityId;
  kj::String offerDescriptorJson;
};

kj::String textIdentityId(capnp::Data::Reader id) {
  KJ_ASSERT(id.size() == 32, "Identity ID not a SHA-256?");
  return kj::encodeHex(id.slice(0, kj::min(id.size(), 16)));
}

kj::String formatPermissions(
    UiView::ViewInfo::Reader viewInfo, capnp::List<bool>::Reader userPermissions) {
  auto configPermissions = viewInfo.getPermissions();
  kj::Vector<kj::String> permissionVec(configPermissions.size());

  for (uint i = 0; i < configPermissions.size() && i < userPermissions.size(); ++i) {
    if (userPermissions[i]) {
      permissionVec.add(kj::str(configPermissions[i].getName()));
    }
  }

  return kj::strArray(permissionVec, ",");
}

kj::String formatPronouns(Profile::Pronouns pronouns) {
  capnp::EnumSchema schema = capnp::Schema::from<Profile::Pronouns>();
  uint pronounValue = static_cast<uint>(pronouns);
  auto enumerants = schema.getEnumerants();
  if (pronounValue > 0 && pronounValue < enumerants.size()) {
    return kj::str(enumerants[pronounValue].getProto().getName());
  } else {
    return nullptr;
  }
}

void copyUserMetadata(
    SessionMetadata& result, UserInfo::Reader userInfo, UiView::ViewInfo::Reader viewInfo) {
  result.userDisplayName = kj::heapString(userInfo.getDisplayName().getDefaultText());
  result.permissions = formatPermissions(viewInfo, userInfo.getPermissions());

  if (userInfo.getIdentityId().size() > 0) {
    result.userId = textIdentityId(userInfo.getIdentityId());
    result.userHandle = kj::heapString(userInfo.getPreferredHandle());
    result.userPicture = kj::heapString(userInfo.getPictureUrl());
    result.userPronouns = formatPronouns(userInfo.getPronouns());
  }
}

SessionMetadata copySessionMetadata(
    WebSession::Params::Reader params, UserInfo::Reader userInfo,
    UiView::ViewInfo::Reader viewInfo, capnp::Data::Reader tabId) {
  SessionMetadata result;
  result.basePath = kj::heapString(params.getBasePath());
  if (result.basePath.size() > 0) {
    result.host = kj::heapString(extractHostFromUrl(result.basePath));
    result.forwardedProto = kj::heapString(extractProtocolFromUrl(result.basePath));
  } else {
    result.host = kj::heapString("sandbox");
  }
  result.userAgent = kj::heapString(params.getUserAgent());
  result.acceptableLanguages = kj::strArray(
      KJ_MAP(language, params.getAcceptableLanguages()) {
    return kj::str(language);
  }, ",");
  result.tabId = kj::encodeHex(tabId);
  copyUserMetadata(result, userInfo, viewInfo);
  return result;
}

SessionMetadata copyApiSessionMetadata(
    UserInfo::Reader userInfo, UiView::ViewInfo::Reader viewInfo, capnp::Data::Reader tabId) {
  SessionMetadata result;
  result.host = kj::heapString("sandbox");
  result.tabId = kj::encodeHex(tabId);
  copyUserMetadata(result, userInfo, viewInfo);
  return result;
}

void appendApiSessionDescriptorJson(kj::Vector<char>& json, ApiSession::PowerboxTag::Reader tag) {
  json.addAll(kj::StringPtr("{"));
  appendJsonField(json, "type", "apiSession");
  json.addAll(kj::StringPtr(", "));
  appendJsonField(json, "canonicalUrl", tag.getCanonicalUrl());
  json.addAll(kj::StringPtr(", \"oauthScopes\": ["));
  auto scopes = tag.getOauthScopes();
  for (auto i: kj::indices(scopes)) {
    if (i > 0) {
      json.addAll(kj::StringPtr(", "));
    }
    appendJsonString(json, scopes[i].getName());
  }
  json.addAll(kj::StringPtr("]}"));
}

kj::StringPtr outboundHttpMethodName(OutboundHttpSession::Method method) {
  switch (method) {
    case OutboundHttpSession::Method::GET:
      return "GET";
    case OutboundHttpSession::Method::POST:
      return "POST";
    case OutboundHttpSession::Method::PUT:
      return "PUT";
    case OutboundHttpSession::Method::PATCH:
      return "PATCH";
    case OutboundHttpSession::Method::DELETE:
      return "DELETE";
    case OutboundHttpSession::Method::HEAD:
      return "HEAD";
    case OutboundHttpSession::Method::OPTIONS:
      return "OPTIONS";
  }

  KJ_UNREACHABLE;
}

kj::Maybe<OutboundHttpSession::Method> parseOutboundHttpMethod(kj::StringPtr method) {
  if (isolateEqualsIgnoreCase(method, "GET")) return OutboundHttpSession::Method::GET;
  if (isolateEqualsIgnoreCase(method, "POST")) return OutboundHttpSession::Method::POST;
  if (isolateEqualsIgnoreCase(method, "PUT")) return OutboundHttpSession::Method::PUT;
  if (isolateEqualsIgnoreCase(method, "PATCH")) return OutboundHttpSession::Method::PATCH;
  if (isolateEqualsIgnoreCase(method, "DELETE")) return OutboundHttpSession::Method::DELETE;
  if (isolateEqualsIgnoreCase(method, "HEAD")) return OutboundHttpSession::Method::HEAD;
  if (isolateEqualsIgnoreCase(method, "OPTIONS")) return OutboundHttpSession::Method::OPTIONS;
  return nullptr;
}

void appendOutboundHttpDescriptorJson(
    kj::Vector<char>& json, OutboundHttpSession::PowerboxTag::Reader tag) {
  json.addAll(kj::StringPtr("{"));
  appendJsonField(json, "type", "outboundHttp");
  json.addAll(kj::StringPtr(", "));
  appendJsonField(json, "baseUrl", tag.getBaseUrl());
  json.addAll(kj::StringPtr(", \"methods\": ["));
  auto methods = tag.getMethods();
  for (auto i: kj::indices(methods)) {
    if (i > 0) {
      json.addAll(kj::StringPtr(", "));
    }
    appendJsonString(json, outboundHttpMethodName(methods[i]));
  }
  json.addAll(kj::StringPtr("]}"));
}

kj::String renderApiSessionDescriptorHeader(ApiSession::PowerboxTag::Reader tag) {
  kj::Vector<char> json;
  appendApiSessionDescriptorJson(json, tag);
  return kj::encodeBase64Url(json.asPtr().asBytes());
}

ClaimedCapabilityNativeInterface nativeInterfaceFromPowerboxDescriptor(
    PowerboxDescriptor::Reader descriptor) {
  kj::Maybe<ClaimedCapabilityNativeInterface> result = nullptr;
  for (auto tag: descriptor.getTags()) {
    ClaimedCapabilityNativeInterface candidate;
    if (tag.getId() == capnp::typeId<ApiSession>()) {
      candidate = ClaimedCapabilityNativeInterface::API_SESSION;
    } else if (tag.getId() == capnp::typeId<OutboundHttpSession>()) {
      candidate = ClaimedCapabilityNativeInterface::OUTBOUND_HTTP_SESSION;
    } else {
      continue;
    }

    KJ_IF_MAYBE(existing, result) {
      if (*existing != candidate) {
        return ClaimedCapabilityNativeInterface::UNKNOWN;
      }
    } else {
      result = candidate;
    }
  }

  KJ_IF_MAYBE(nativeInterface, result) {
    return *nativeInterface;
  }
  return ClaimedCapabilityNativeInterface::UNKNOWN;
}

void copyOfferDescriptor(SessionMetadata& result, PowerboxDescriptor::Reader descriptor) {
  auto tags = descriptor.getTags();
  if (tags.size() == 1 && tags[0].getId() == capnp::typeId<ApiSession>()) {
    result.offerDescriptorJson = renderApiSessionDescriptorHeader(
        tags[0].getValue().getAs<ApiSession::PowerboxTag>());
  }
}

struct FetchHeader {
  kj::String name;
  kj::String value;
};

struct FetchResponseBodyAnchor {
  virtual ~FetchResponseBodyAnchor() noexcept(false) {}
};

struct FetchRequest {
  FetchMethod method;
  kj::String path;
  kj::String mimeType;
  kj::String encoding;
  kj::Maybe<uint64_t> expectedBodySize;
  kj::Array<byte> body;
  kj::Vector<FetchHeader> headers;
};

struct FetchResponse {
  uint statusCode = 200;
  kj::String mimeType = kj::heapString("text/plain; charset=utf-8");
  // Must be declared before bodyStream so the stream is destroyed before the state it depends on.
  kj::Maybe<kj::Own<FetchResponseBodyAnchor>> bodyStreamAnchor;
  kj::Maybe<kj::Own<kj::AsyncInputStream>> bodyStream;
  kj::Array<byte> body;
  kj::Vector<FetchHeader> headers;
};

struct ParsedETag {
  kj::String value;
  bool weak = false;
};

constexpr uint64_t MAX_SIDECAR_REQUEST_BYTES = 64 * 1024 * 1024;
constexpr uint64_t MAX_SIDECAR_RESPONSE_BYTES = 64 * 1024 * 1024;
constexpr uint64_t MAX_API_BINDING_REQUEST_BYTES = 1024 * 1024;
constexpr uint NATIVE_CAPNP_BRIDGE_PROTOCOL_VERSION = 0;
constexpr uint64_t SIDECAR_RESPONSE_STREAM_THRESHOLD_BYTES = 64 * 1024;
constexpr uint SIDECAR_READY_TIMEOUT_MS = 10000;
constexpr uint SIDECAR_READY_POLL_MS = 50;
constexpr uint SIDECAR_SHUTDOWN_TIMEOUT_MS = 2000;

void sleepMillis(uint millis);

kj::Promise<kj::Array<byte>> readAllBytesAtMost(
    kj::AsyncInputStream& input, uint64_t maxBytes, kj::StringPtr description) {
  constexpr uint64_t maxReadAllBytesLimit = ~uint64_t(0) - 2;
  KJ_REQUIRE(maxBytes <= maxReadAllBytesLimit);
  auto ownedDescription = kj::heapString(description);
  // KJ's readAllBytes(limit) rejects only after reading exactly `limit` bytes without seeing EOF.
  // Use two bytes of headroom so exact-limit bodies succeed and one-byte-over bodies report our
  // domain-specific size error.
  return input.readAllBytes(maxBytes + 2)
      .then([maxBytes, description = kj::mv(ownedDescription)](
          kj::Array<byte>&& body) mutable {
    KJ_REQUIRE(body.size() <= maxBytes, description, body.size(), maxBytes);
    return kj::mv(body);
  });
}

kj::Promise<void> pumpAtMost(kj::AsyncInputStream& input, ByteStream::Client stream,
    uint64_t maxBytes, kj::StringPtr description, uint64_t bytesPumped = 0) {
  if (bytesPumped == maxBytes) {
    auto req = stream.writeRequest(capnp::MessageSize { 2100, 0 });
    auto orphanage = capnp::Orphanage::getForMessageContaining(
        kj::implicitCast<ByteStream::WriteParams::Builder>(req));
    auto orphan = orphanage.newOrphan<capnp::Data>(1);
    auto buffer = orphan.get();

    return input.tryRead(buffer.begin(), 1, buffer.size())
        .then([KJ_MVCAP(stream), maxBytes, description](size_t n) mutable -> kj::Promise<void> {
      KJ_REQUIRE(n == 0, description, maxBytes + 1, maxBytes);
      return stream.doneRequest(capnp::MessageSize {4, 0}).send().then([](auto&&) {});
    });
  }

  auto req = stream.writeRequest(capnp::MessageSize { 2100, 0 });
  auto orphanage = capnp::Orphanage::getForMessageContaining(
      kj::implicitCast<ByteStream::WriteParams::Builder>(req));
  auto chunkSize = static_cast<size_t>(kj::min(uint64_t(8192), maxBytes - bytesPumped));
  auto orphan = orphanage.newOrphan<capnp::Data>(chunkSize);
  auto buffer = orphan.get();

  return input.tryRead(buffer.begin(), 1, buffer.size())
      .then([&input, KJ_MVCAP(stream), KJ_MVCAP(req), KJ_MVCAP(orphan),
          maxBytes, description, bytesPumped](size_t n) mutable -> kj::Promise<void> {
    if (n == 0) {
      return stream.doneRequest(capnp::MessageSize {4, 0}).send().then([](auto&&) {});
    }

    auto newBytesPumped = bytesPumped + n;
    KJ_REQUIRE(newBytesPumped <= maxBytes, description, newBytesPumped, maxBytes);
    orphan.truncate(n);
    req.adoptData(kj::mv(orphan));

    return req.send().then([&input, KJ_MVCAP(stream), maxBytes, description,
        newBytesPumped]() mutable {
      return pumpAtMost(input, kj::mv(stream), maxBytes, description, newBytesPumped);
    });
  });
}

void addHeader(FetchRequest& request, kj::StringPtr name, kj::StringPtr value) {
  FetchHeader header;
  header.name = kj::heapString(name);
  header.value = kj::heapString(value);
  request.headers.add(kj::mv(header));
}

kj::String formatRequestETag(WebSession::ETag::Reader eTag) {
  if (eTag.getWeak()) {
    return kj::str("W/\"", eTag.getValue(), '"');
  } else {
    return kj::str('"', eTag.getValue(), '"');
  }
}

kj::String escapeHttpQuotedString(kj::StringPtr value) {
  kj::Vector<char> chars(value.size() + 1);

  for (char c: value) {
    switch (c) {
      case '\\':
      case '\"':
        chars.add('\\');
        chars.add(c);
        break;
      case '\r':
      case '\n':
        chars.add('_');
        break;
      default:
        chars.add(c);
        break;
    }
  }

  chars.add('\0');
  return kj::String(chars.releaseAsArray());
}

void addETagPreconditionHeaders(FetchRequest& request, WebSession::Context::Reader context) {
  auto eTagPrecondition = context.getETagPrecondition();
  switch (eTagPrecondition.which()) {
    case WebSession::Context::ETagPrecondition::NONE:
      break;
    case WebSession::Context::ETagPrecondition::EXISTS:
      addHeader(request, "if-match", "*");
      break;
    case WebSession::Context::ETagPrecondition::DOESNT_EXIST:
      addHeader(request, "if-none-match", "*");
      break;
    case WebSession::Context::ETagPrecondition::MATCHES_ONE_OF:
      addHeader(request, "if-match", kj::strArray(
          KJ_MAP(e, eTagPrecondition.getMatchesOneOf()) {
            return formatRequestETag(e);
          }, ", "));
      break;
    case WebSession::Context::ETagPrecondition::MATCHES_NONE_OF:
      addHeader(request, "if-none-match", kj::strArray(
          KJ_MAP(e, eTagPrecondition.getMatchesNoneOf()) {
            return formatRequestETag(e);
          }, ", "));
      break;
  }
}

void addRequestContextHeaders(FetchRequest& request, WebSession::Context::Reader context) {
  for (auto header: context.getAdditionalHeaders()) {
    addHeader(request, header.getName(), header.getValue());
  }

  addETagPreconditionHeaders(request, context);
}

kj::String toHttpRequestTarget(kj::StringPtr path) {
  if (path.size() == 0) {
    return kj::heapString("/");
  } else if (path[0] == '/') {
    return kj::heapString(path);
  } else {
    return kj::str("/", path);
  }
}

FetchRequest makeFetchRequest(
    FetchMethod method, kj::StringPtr path, WebSession::Context::Reader context) {
  FetchRequest request;
  request.method = method;
  request.path = toHttpRequestTarget(path);
  addRequestContextHeaders(request, context);
  return request;
}

void setFetchRequestBodyHeaders(FetchRequest& request, kj::StringPtr mimeType, kj::StringPtr encoding) {
  request.mimeType = kj::heapString(mimeType);
  request.encoding = kj::heapString(encoding);
  if (request.mimeType.size() > 0) {
    addHeader(request, "content-type", request.mimeType);
  }
  if (request.encoding.size() > 0) {
    addHeader(request, "content-encoding", request.encoding);
  }
}

template <typename ContentReader>
void setFetchRequestBody(FetchRequest& request, ContentReader content) {
  setFetchRequestBodyHeaders(request, content.getMimeType(), content.getEncoding());
  KJ_REQUIRE(content.getContent().size() <= MAX_SIDECAR_REQUEST_BYTES,
      "buffered isolate request body exceeds maximum allowed size",
      content.getContent().size(), MAX_SIDECAR_REQUEST_BYTES);
  request.body = kj::heapArray<byte>(content.getContent());
}

WebSession::Response::SuccessCode successCodeForStatus(uint statusCode) {
  switch (statusCode) {
    case 200: return WebSession::Response::SuccessCode::OK;
    case 201: return WebSession::Response::SuccessCode::CREATED;
    case 202: return WebSession::Response::SuccessCode::ACCEPTED;
    case 206: return WebSession::Response::SuccessCode::PARTIAL_CONTENT;
    case 207: return WebSession::Response::SuccessCode::MULTI_STATUS;
    case 304: return WebSession::Response::SuccessCode::NOT_MODIFIED;
    default: return WebSession::Response::SuccessCode::OK;
  }
}

WebSession::Response::ClientErrorCode clientErrorCodeForStatus(uint statusCode) {
  switch (statusCode) {
    case 400: return WebSession::Response::ClientErrorCode::BAD_REQUEST;
    case 403: return WebSession::Response::ClientErrorCode::FORBIDDEN;
    case 404: return WebSession::Response::ClientErrorCode::NOT_FOUND;
    case 405: return WebSession::Response::ClientErrorCode::METHOD_NOT_ALLOWED;
    case 406: return WebSession::Response::ClientErrorCode::NOT_ACCEPTABLE;
    case 409: return WebSession::Response::ClientErrorCode::CONFLICT;
    case 410: return WebSession::Response::ClientErrorCode::GONE;
    case 412: return WebSession::Response::ClientErrorCode::PRECONDITION_FAILED;
    case 413: return WebSession::Response::ClientErrorCode::REQUEST_ENTITY_TOO_LARGE;
    case 414: return WebSession::Response::ClientErrorCode::REQUEST_URI_TOO_LONG;
    case 415: return WebSession::Response::ClientErrorCode::UNSUPPORTED_MEDIA_TYPE;
    case 418: return WebSession::Response::ClientErrorCode::IM_A_TEAPOT;
    case 422: return WebSession::Response::ClientErrorCode::UNPROCESSABLE_ENTITY;
    default: return WebSession::Response::ClientErrorCode::BAD_REQUEST;
  }
}

bool isFetchContentStatus(uint statusCode) {
  switch (statusCode) {
    case 200:
    case 201:
    case 202:
    case 206:
    case 207:
      return true;
    default:
      return false;
  }
}

void addFetchResponseHeaders(WebSession::Response::Builder builder, kj::Vector<FetchHeader>& headers) {
  HeaderWhitelist responseHeaderWhitelist(*WebSession::Response::HEADER_WHITELIST);

  size_t count = 0;
  for (auto& header: headers) {
    auto name = kj::str(header.name);
    toLower(name);
    if (!isStructuredIsolateResponseHeader(name) &&
        responseHeaderWhitelist.matches(name)) {
      ++count;
    }
  }

  auto outputHeaders = builder.initAdditionalHeaders(count);
  size_t j = 0;
  for (auto i: kj::indices(headers)) {
    auto name = kj::str(headers[i].name);
    toLower(name);
    if (!isStructuredIsolateResponseHeader(name) &&
        responseHeaderWhitelist.matches(name)) {
      outputHeaders[j].setName(name);
      outputHeaders[j].setValue(headers[i].value);
      ++j;
    }
  }
}

kj::Maybe<ParsedETag> parseFetchETag(kj::StringPtr input) {
  auto trimmed = trim(input);
  input = trimmed;

  ParsedETag result;
  if (input.startsWith("W/")) {
    input = input.slice(2);
    result.weak = true;
  }

  if (!input.startsWith("\"") || !input.endsWith("\"") || input.size() <= 1) {
    KJ_LOG(WARNING, "Dropping invalid ETag from isolate response.", input);
    return nullptr;
  }

  bool escaped = false;
  kj::Vector<char> value(input.size() - 2);
  for (char c: input.slice(1, input.size() - 1)) {
    if (escaped) {
      escaped = false;
    } else {
      if (c == '"') {
        KJ_LOG(WARNING, "Dropping invalid ETag from isolate response.", input);
        return nullptr;
      }
      if (c == '\\') {
        escaped = true;
        continue;
      }
    }
    value.add(c);
  }

  result.value = kj::heapString(value.asPtr());
  return kj::mv(result);
}

void copyFetchETag(ParsedETag& input, WebSession::ETag::Builder output) {
  output.setValue(input.value);
  output.setWeak(input.weak);
}

kj::Maybe<kj::String> parseFetchDownloadFilename(kj::StringPtr disposition) {
  auto parts = split(disposition, ';');
  if (parts.size() <= 1) {
    return nullptr;
  }

  auto type = trim(parts[0]);
  toLower(type);
  if (type != "attachment") {
    return nullptr;
  }

  for (auto& part: parts.asPtr().slice(1, parts.size())) {
    for (size_t i: kj::indices(part)) {
      if (part[i] != '=') {
        continue;
      }

      auto name = trim(part.slice(0, i));
      toLower(name);
      if (name == "filename") {
        auto filename = trimArray(part.slice(i + 1, part.size()));
        if (filename.size() >= 2 && filename[0] == '"' && filename[filename.size() - 1] == '"') {
          filename = filename.slice(1, filename.size() - 1);

          kj::Vector<char> unescaped(filename.size());
          for (size_t j = 0; j < filename.size(); ++j) {
            if (filename[j] == '\\' && ++j >= filename.size()) {
              break;
            }
            unescaped.add(filename[j]);
          }

          return kj::heapString(unescaped.asPtr());
        } else {
          return kj::str(filename);
        }
      }

      break;
    }
  }

  return nullptr;
}

kj::Maybe<kj::StringPtr> findFetchResponseHeader(
    kj::Vector<FetchHeader>& headers, kj::StringPtr name) {
  for (auto& header: headers) {
    if (isolateEqualsIgnoreCase(header.name, name)) {
      return kj::StringPtr(header.value);
    }
  }

  return nullptr;
}

void applyFetchCachePolicy(WebSession::Response::Builder builder,
    kj::Vector<FetchHeader>& headers) {
  KJ_IF_MAYBE(cacheControl, findFetchResponseHeader(headers, "cache-control")) {
    bool noStore = false;
    bool noCache = false;
    bool explicitlyCacheable = false;
    bool immutable = false;
    bool hasMaxAge = false;
    uint64_t maxAge = 0;

    for (auto& rawDirective: split(*cacheControl, ',')) {
      auto directive = trim(rawDirective);
      toLower(directive);

      kj::StringPtr name = directive;
      auto value = kj::heapString("");
      KJ_IF_MAYBE(eq, name.findFirst('=')) {
        value = trim(name.slice(*eq + 1, name.size()));
        name = kj::StringPtr(name.begin(), *eq);
      }

      if (name == "no-store") {
        noStore = true;
      } else if (name == "no-cache" || name == "must-revalidate") {
        noCache = true;
      } else if (name == "private" || name == "public") {
        explicitlyCacheable = true;
      } else if (name == "immutable") {
        immutable = true;
      } else if (name == "max-age") {
        KJ_IF_MAYBE(parsed, parseUInt64(value, 10)) {
          hasMaxAge = true;
          maxAge = *parsed;
        }
      }
    }

    if (noStore) {
      return;
    }

    if (immutable && hasMaxAge && maxAge > 0 && !noCache) {
      auto policy = builder.initCachePolicy();
      policy.setPermanent(WebSession::CachePolicy::Scope::PER_SESSION);
    } else if (noCache || explicitlyCacheable || hasMaxAge) {
      auto policy = builder.initCachePolicy();
      policy.setWithCheck(WebSession::CachePolicy::Scope::PER_SESSION);
    }
  }
}

kj::String bytesToString(kj::ArrayPtr<const byte> bytes) {
  kj::Vector<char> chars(bytes.size() + 1);
  for (auto b: bytes) {
    chars.add(static_cast<char>(b));
  }
  chars.add('\0');
  return kj::String(chars.releaseAsArray());
}

template <typename ErrorBuilder>
void setFetchErrorBody(ErrorBuilder error, FetchResponse& response) {
  if (response.body.size() == 0) {
    return;
  }

  if (isHtmlMimeType(response.mimeType)) {
    auto html = bytesToString(response.body);
    error.setDescriptionHtml(html);
  } else {
    auto nonHtml = error.initNonHtmlBody();
    nonHtml.setMimeType(response.mimeType);
    KJ_IF_MAYBE(encoding, findFetchResponseHeader(response.headers, "content-encoding")) {
      nonHtml.setEncoding(*encoding);
    }
    KJ_IF_MAYBE(language, findFetchResponseHeader(response.headers, "content-language")) {
      nonHtml.setLanguage(*language);
    }
    nonHtml.setData(response.body);
  }
}

bool shouldStreamSidecarResponse(uint statusCode, kj::Vector<FetchHeader>& headers) {
  if (!isFetchContentStatus(statusCode)) {
    return false;
  }

  KJ_IF_MAYBE(contentLength, findFetchResponseHeader(headers, "content-length")) {
    KJ_IF_MAYBE(size, parseUInt64(*contentLength, 10)) {
      return *size > SIDECAR_RESPONSE_STREAM_THRESHOLD_BYTES;
    }
  }

  // If workerd did not provide a usable Content-Length, preserve streaming semantics rather than
  // buffering an arbitrarily large or intentionally streaming response.
  return true;
}

kj::Maybe<uint64_t> getSidecarResponseContentLength(kj::Vector<FetchHeader>& headers) {
  KJ_IF_MAYBE(contentLength, findFetchResponseHeader(headers, "content-length")) {
    KJ_IF_MAYBE(size, parseUInt64(*contentLength, 10)) {
      return *size;
    }
  }

  return nullptr;
}

class FetchResponseStreamHandle final: public Handle::Server, private kj::TaskSet::ErrorHandler {
public:
  FetchResponseStreamHandle(
      kj::Maybe<kj::Own<FetchResponseBodyAnchor>> bodyStreamAnchor,
      kj::Own<kj::AsyncInputStream> bodyStream, ByteStream::Client responseStream)
      : bodyStreamAnchor(kj::mv(bodyStreamAnchor)),
        bodyStream(kj::mv(bodyStream)),
        responseStream(kj::mv(responseStream)),
        tasks(*this) {
    KJ_LOG(WARNING, "Starting isolate response body stream.");
    tasks.add(kj::evalLater([this]() {
      return pumpAtMost(*this->bodyStream, this->responseStream, MAX_SIDECAR_RESPONSE_BYTES,
          "streaming isolate response body exceeds maximum allowed size");
    }));
  }

  ~FetchResponseStreamHandle() noexcept(false) {
    KJ_LOG(WARNING, "Destroying isolate response body stream handle.");
  }

  kj::Promise<void> ping(PingContext context) override {
    return kj::READY_NOW;
  }

private:
  // Must be declared before bodyStream so the stream is destroyed before the sidecar HTTP state.
  kj::Maybe<kj::Own<FetchResponseBodyAnchor>> bodyStreamAnchor;
  kj::Own<kj::AsyncInputStream> bodyStream;
  ByteStream::Client responseStream;
  kj::TaskSet tasks;

  void taskFailed(kj::Exception&& exception) override {
    KJ_LOG(WARNING, "Isolate response body stream failed.", exception);
  }
};

void writeFetchResponse(
    FetchResponse&& response, WebSession::Response::Builder builder,
    ByteStream::Client responseStream, bool omitBody = false) {
  applyFetchCachePolicy(builder, response.headers);
  addFetchResponseHeaders(builder, response.headers);

  if (response.statusCode == 204 || response.statusCode == 205) {
    auto noContent = builder.initNoContent();
    noContent.setShouldResetForm(response.statusCode == 205);
    KJ_IF_MAYBE(etag, findFetchResponseHeader(response.headers, "etag")) {
      KJ_IF_MAYBE(parsed, parseFetchETag(*etag)) {
        copyFetchETag(*parsed, noContent.initETag());
      }
    }
  } else if (response.statusCode == 304 || response.statusCode == 412) {
    auto preconditionFailed = builder.initPreconditionFailed();
    KJ_IF_MAYBE(etag, findFetchResponseHeader(response.headers, "etag")) {
      KJ_IF_MAYBE(parsed, parseFetchETag(*etag)) {
        copyFetchETag(*parsed, preconditionFailed.initMatchingETag());
      }
    }
  } else if (response.statusCode == 301 || response.statusCode == 302 ||
             response.statusCode == 303 || response.statusCode == 307 ||
             response.statusCode == 308) {
    auto redirect = builder.initRedirect();
    redirect.setIsPermanent(response.statusCode == 301 || response.statusCode == 308);
    redirect.setSwitchToGet(response.statusCode == 301 || response.statusCode == 302 ||
        response.statusCode == 303);
    KJ_IF_MAYBE(location, findFetchResponseHeader(response.headers, "location")) {
      redirect.setLocation(*location);
    } else {
      redirect.setLocation("");
    }
  } else if (isFetchContentStatus(response.statusCode)) {
    auto content = builder.initContent();
    content.setStatusCode(successCodeForStatus(response.statusCode));
    content.setMimeType(response.mimeType);
    KJ_IF_MAYBE(encoding, findFetchResponseHeader(response.headers, "content-encoding")) {
      content.setEncoding(*encoding);
    }
    KJ_IF_MAYBE(language, findFetchResponseHeader(response.headers, "content-language")) {
      content.setLanguage(*language);
    }
    KJ_IF_MAYBE(etag, findFetchResponseHeader(response.headers, "etag")) {
      KJ_IF_MAYBE(parsed, parseFetchETag(*etag)) {
        copyFetchETag(*parsed, content.initETag());
      }
    }
    KJ_IF_MAYBE(disposition, findFetchResponseHeader(response.headers, "content-disposition")) {
      KJ_IF_MAYBE(filename, parseFetchDownloadFilename(*disposition)) {
        content.getDisposition().setDownload(*filename);
      }
    }
    if (!omitBody) {
      KJ_IF_MAYBE(bodyStream, response.bodyStream) {
        auto anchor = kj::mv(response.bodyStreamAnchor);
        content.initBody().setStream(kj::heap<FetchResponseStreamHandle>(
            kj::mv(anchor), kj::mv(*bodyStream), kj::mv(responseStream)));
      } else if (response.body.size() > 0) {
        content.initBody().setBytes(response.body);
      }
    }
  } else if (response.statusCode >= 400 && response.statusCode < 500) {
    auto error = builder.initClientError();
    error.setStatusCode(clientErrorCodeForStatus(response.statusCode));
    if (!omitBody) {
      setFetchErrorBody(error, response);
    }
  } else {
    if (response.statusCode < 500) {
      KJ_LOG(WARNING, "Isolate response used unsupported HTTP status code.", response.statusCode);
    }

    auto error = builder.initServerError();
    if (!omitBody) {
      setFetchErrorBody(error, response);
    }
  }
}

class IsolateRuntimeAdapter {
public:
  virtual ~IsolateRuntimeAdapter() noexcept(false) {}
  virtual kj::Promise<FetchResponse> fetch(FetchRequest&& request) = 0;
  virtual kj::Own<WebSession::RequestStream::Server> startRequestStream(
      FetchRequest&& request, ByteStream::Client responseStream) = 0;
};

class WorkerdRuntimeAdapter final: public IsolateRuntimeAdapter {
public:
  WorkerdRuntimeAdapter(kj::Own<IsolateRuntimeConfig> config, kj::Own<IsolateRuntimeHost> host)
      : config(kj::mv(config)), host(kj::mv(host)) {}

  kj::Promise<FetchResponse> fetch(FetchRequest&& request) override {
    if (isSidecarSocketAvailable()) {
      return fetchFromSidecar(kj::mv(request)).catch_(
          [this](kj::Exception&& exception) mutable {
        return fetchRuntimeError(kj::mv(exception));
      });
    } else if (hasSidecarEndpoint()) {
      return fetchPlaceholder(kj::mv(request), "sidecar socket not listening");
    }

    return fetchPlaceholder(kj::mv(request), "sidecar endpoint not configured");
  }

  kj::Own<WebSession::RequestStream::Server> startRequestStream(
      FetchRequest&& request, ByteStream::Client responseStream) override;

private:
  class StreamingRequestImpl;

  struct SidecarHttpState final: public FetchResponseBodyAnchor, public kj::Refcounted {
    kj::Own<kj::NetworkAddress> addr;
    kj::Own<kj::HttpClient> client;
    kj::Own<kj::AsyncOutputStream> requestBody;
    kj::Promise<kj::HttpClient::Response> response = nullptr;
    kj::Maybe<kj::Own<kj::AsyncInputStream>> responseBody;

    SidecarHttpState(kj::Own<kj::NetworkAddress>&& addr, kj::Own<kj::HttpClient>&& client)
        : addr(kj::mv(addr)), client(kj::mv(client)) {}
  };

  kj::Own<IsolateRuntimeConfig> config;
  kj::Own<IsolateRuntimeHost> host;

  bool hasSidecarEndpoint() {
    return config->workerdSocketPath.size() > 0;
  }

  bool isSidecarSocketAvailable() {
    return hasSidecarEndpoint() && access(config->workerdSocketPath.cStr(), F_OK) == 0;
  }

  FetchResponse fetchRuntimeError(kj::Exception&& exception) {
    KJ_LOG(WARNING, "Isolate sidecar request failed.", exception);

    FetchResponse response;
    response.statusCode = 502;
    response.mimeType = kj::heapString("text/plain; charset=utf-8");
    auto body = kj::str("Isolate runtime request failed: ", exception.getDescription(), "\n");
    response.body = kj::heapArray<byte>(body.asBytes());
    return response;
  }

  static void copyHeadersToHttp(FetchRequest& request, kj::HttpHeaders& headers) {
    for (auto& header: request.headers) {
      headers.add(header.name, header.value);
    }
  }

  static kj::Promise<FetchResponse> readSidecarResponse(
      kj::HttpClient::Response&& response, kj::Own<SidecarHttpState> state) {
    FetchResponse result;
    result.statusCode = response.statusCode;

    if (response.headers != nullptr) {
      KJ_IF_MAYBE(contentType, response.headers->get(kj::HttpHeaderId::CONTENT_TYPE)) {
        result.mimeType = kj::heapString(*contentType);
      }

      response.headers->forEach([&](kj::StringPtr name, kj::StringPtr value) {
        FetchHeader header;
        header.name = kj::heapString(name);
        header.value = kj::heapString(value);
        result.headers.add(kj::mv(header));
      });
    }

    if (response.body.get() == nullptr) {
      return kj::mv(result);
    }

    if (shouldStreamSidecarResponse(result.statusCode, result.headers)) {
      KJ_IF_MAYBE(size, getSidecarResponseContentLength(result.headers)) {
        KJ_REQUIRE(*size <= MAX_SIDECAR_RESPONSE_BYTES,
            "streaming isolate response declared size exceeds maximum allowed size",
            *size, MAX_SIDECAR_RESPONSE_BYTES);
      }
      result.bodyStreamAnchor = kj::mv(state);
      result.bodyStream = kj::mv(response.body);
      KJ_LOG(WARNING, "Isolate sidecar streaming response received.",
          result.statusCode, result.mimeType);
      return kj::mv(result);
    }

    state->responseBody = kj::mv(response.body);
    auto& body = KJ_ASSERT_NONNULL(state->responseBody);
    return readAllBytesAtMost(*body, MAX_SIDECAR_RESPONSE_BYTES,
        "buffered isolate response body exceeds maximum allowed size")
        .then([result = kj::mv(result), state = kj::mv(state)](kj::Array<byte>&& body) mutable {
      result.body = kj::mv(body);
      KJ_LOG(WARNING, "Isolate sidecar response received.",
          result.statusCode, result.mimeType, result.body.size());
      return kj::mv(result);
    });
  }

  class StreamingRequestImpl final: public WebSession::RequestStream::Server {
  public:
    StreamingRequestImpl(
        kj::Own<IsolateRuntimeConfig> config, kj::Own<IsolateRuntimeHost> host,
        FetchRequest&& request, ByteStream::Client responseStream)
        : config(kj::mv(config)),
          host(kj::mv(host)),
          request(kj::mv(request)),
          responseStream(kj::mv(responseStream)),
          started(start().fork()),
          writeQueue(started.addBranch()) {
      expectedSize = this->request.expectedBodySize;
      KJ_IF_MAYBE(size, expectedSize) {
        KJ_REQUIRE(*size <= MAX_SIDECAR_REQUEST_BYTES,
            "streaming isolate request expected size exceeds maximum allowed size",
            *size, MAX_SIDECAR_REQUEST_BYTES);
      }
      if (this->request.expectedBodySize == nullptr) {
        auto paf = kj::newPromiseAndFulfiller<void>();
        donePromise = kj::mv(paf.promise);
        doneFulfiller = kj::mv(paf.fulfiller);
      }
    }

    ~StreamingRequestImpl() noexcept(false) {
      KJ_IF_MAYBE(fulfiller, doneFulfiller) {
        if ((*fulfiller)->isWaiting()) {
          (*fulfiller)->reject(KJ_EXCEPTION(DISCONNECTED,
              "streaming isolate upload ended before done()"));
        }
      }
    }

    kj::Promise<void> write(WriteContext context) override {
      KJ_REQUIRE(!doneCalled, "write() called after done()");
      auto data = kj::heapArray<byte>(context.getParams().getData());
      bytesReceived += data.size();
      KJ_REQUIRE(bytesReceived <= MAX_SIDECAR_REQUEST_BYTES,
          "streaming isolate request body exceeds maximum allowed size",
          bytesReceived, MAX_SIDECAR_REQUEST_BYTES);
      KJ_IF_MAYBE(size, expectedSize) {
        KJ_REQUIRE(bytesReceived <= *size, "received more bytes than expected");
      }

      auto promise = writeQueue.then([this, data = kj::mv(data)]() mutable -> kj::Promise<void> {
        KJ_IF_MAYBE(fd, spoolFd) {
          writeAllToFd(fd->get(), data);
          return kj::READY_NOW;
        } else {
          auto& current = KJ_ASSERT_NONNULL(state);
          KJ_REQUIRE(current->requestBody.get() != nullptr, "streaming request body is closed");
          return current->requestBody->write(data.begin(), data.size()).attach(kj::mv(data));
        }
      });
      auto fork = promise.fork();
      writeQueue = fork.addBranch();
      return fork.addBranch();
    }

    kj::Promise<void> done(DoneContext context) override {
      KJ_REQUIRE(!doneCalled, "done() called twice");
      KJ_IF_MAYBE(size, expectedSize) {
        KJ_REQUIRE(bytesReceived == *size,
            "done() called before all bytes expected via expectSize() were written");
      }

      doneCalled = true;
      auto promise = writeQueue.then([this]() {
        KJ_IF_MAYBE(fd, spoolFd) {
          KJ_SYSCALL(fsync(fd->get()));
        } else {
          auto& current = KJ_ASSERT_NONNULL(state);
          current->requestBody = nullptr;
        }
        KJ_IF_MAYBE(fulfiller, doneFulfiller) {
          (*fulfiller)->fulfill();
        }
        doneFulfiller = nullptr;
      });
      auto fork = promise.fork();
      writeQueue = fork.addBranch();
      return fork.addBranch();
    }

    kj::Promise<void> expectSize(ExpectSizeContext context) override {
      auto size = bytesReceived + context.getParams().getSize();
      KJ_REQUIRE(size <= MAX_SIDECAR_REQUEST_BYTES,
          "streaming isolate request expected size exceeds maximum allowed size",
          size, MAX_SIDECAR_REQUEST_BYTES);
      KJ_IF_MAYBE(expected, expectedSize) {
        KJ_REQUIRE(*expected == size, "expectSize() disagrees with expected streaming request size");
      }
      expectedSize = size;
      return kj::READY_NOW;
    }

    kj::Promise<void> getResponse(GetResponseContext context) override {
      KJ_REQUIRE(!responseCalled, "getResponse() called more than once");
      responseCalled = true;

      auto results = context.getResults();
      auto stream = kj::mv(responseStream);
      if (request.expectedBodySize == nullptr) {
        auto waitForDone = kj::mv(donePromise);
        return kj::mv(waitForDone).then([this, results, stream = kj::mv(stream)]() mutable {
          return sendSpooledRequest(results, kj::mv(stream));
        });
      }

      return started.addBranch().then([this, results, stream = kj::mv(stream)]() mutable {
        auto& current = KJ_ASSERT_NONNULL(state);
        auto response = kj::mv(current->response);
        auto responseState = kj::addRef(*current);
        return response.then([results, responseState = kj::mv(responseState),
            stream = kj::mv(stream)](
            kj::HttpClient::Response&& response) mutable {
          return readSidecarResponse(kj::mv(response), kj::mv(responseState))
              .then([results, stream = kj::mv(stream)](
                  FetchResponse&& fetchResponse) mutable {
            writeFetchResponse(kj::mv(fetchResponse), results, kj::mv(stream));
          });
        });
      });
    }

  private:
    kj::Own<IsolateRuntimeConfig> config;
    kj::Own<IsolateRuntimeHost> host;
    FetchRequest request;
    ByteStream::Client responseStream;
    kj::Maybe<kj::Own<SidecarHttpState>> state;
    kj::Maybe<kj::AutoCloseFd> spoolFd;
    kj::ForkedPromise<void> started;
    kj::Promise<void> writeQueue;
    kj::Maybe<kj::Own<kj::PromiseFulfiller<void>>> doneFulfiller;
    kj::Promise<void> donePromise = nullptr;
    kj::Maybe<uint64_t> expectedSize;
    uint64_t bytesReceived = 0;
    bool doneCalled = false;
    bool responseCalled = false;

    kj::Promise<void> start() {
      if (request.expectedBodySize == nullptr) {
        spoolFd = openTemporary(kj::str(config->workerdBundleDir, "/upload-spool"));
        return kj::READY_NOW;
      }

      return host->network.parseAddress(kj::str("unix:", config->workerdSocketPath), 0)
          .then([this](kj::Own<kj::NetworkAddress>&& addr) mutable {
        auto client = kj::newHttpClient(host->timer, host->headerTable, *addr);
        auto newState = kj::refcounted<SidecarHttpState>(kj::mv(addr), kj::mv(client));
        kj::HttpHeaders headers(host->headerTable);
        copyHeadersToHttp(request, headers);

        auto httpRequest = newState->client->request(
            toHttpMethod(request.method), request.path, headers, request.expectedBodySize);
        KJ_REQUIRE(httpRequest.body.get() != nullptr,
            "streaming request did not produce a request body stream");
        newState->requestBody = kj::mv(httpRequest.body);
        newState->response = kj::mv(httpRequest.response);
        state = kj::mv(newState);
      });
    }

    kj::Promise<void> sendSpooledRequest(
        WebSession::Response::Builder results, ByteStream::Client responseStream) {
      auto& fd = KJ_ASSERT_NONNULL(spoolFd);
      KJ_SYSCALL(lseek(fd.get(), 0, SEEK_SET));

      return host->network.parseAddress(kj::str("unix:", config->workerdSocketPath), 0)
          .then([this, results, responseStream = kj::mv(responseStream)](
              kj::Own<kj::NetworkAddress>&& addr) mutable {
        auto client = kj::newHttpClient(host->timer, host->headerTable, *addr);
        auto state = kj::refcounted<SidecarHttpState>(kj::mv(addr), kj::mv(client));
        kj::HttpHeaders headers(host->headerTable);
        copyHeadersToHttp(request, headers);

        auto httpRequest = state->client->request(
            toHttpMethod(request.method), request.path, headers, bytesReceived);
        auto response = kj::mv(httpRequest.response);

        if (httpRequest.body.get() != nullptr && bytesReceived > 0) {
          auto requestBody = kj::mv(httpRequest.body);
          auto& fd = KJ_ASSERT_NONNULL(spoolFd);
          return writeFdToAsync(fd.get(), *requestBody, bytesReceived)
              .attach(kj::mv(requestBody))
              .then([response = kj::mv(response)]() mutable {
            return kj::mv(response);
          }).then([results, state = kj::mv(state), responseStream = kj::mv(responseStream)](
              kj::HttpClient::Response&& response) mutable {
            return readSidecarResponse(kj::mv(response), kj::mv(state))
                .then([results, responseStream = kj::mv(responseStream)](
                    FetchResponse&& fetchResponse) mutable {
              writeFetchResponse(kj::mv(fetchResponse), results, kj::mv(responseStream));
            });
          });
        }

        return response.then([results, state = kj::mv(state),
            responseStream = kj::mv(responseStream)](
            kj::HttpClient::Response&& response) mutable {
          return readSidecarResponse(kj::mv(response), kj::mv(state))
              .then([results, responseStream = kj::mv(responseStream)](
                  FetchResponse&& fetchResponse) mutable {
            writeFetchResponse(kj::mv(fetchResponse), results, kj::mv(responseStream));
          });
        });
      });
    }

    static kj::Promise<void> writeFdToAsync(
        int fd, kj::AsyncOutputStream& output, uint64_t remaining) {
      if (remaining == 0) {
        return kj::READY_NOW;
      }

      auto buffer = kj::heapArray<byte>(
          static_cast<size_t>(kj::min(remaining, uint64_t(8192))));
      ssize_t n;
      KJ_SYSCALL(n = read(fd, buffer.begin(), buffer.size()));
      KJ_REQUIRE(n > 0, "spooled isolate upload ended before expected byte count");
      auto written = static_cast<uint64_t>(n);

      return output.write(buffer.begin(), static_cast<size_t>(n))
          .attach(kj::mv(buffer))
          .then([fd, &output, remaining, written]() {
        return writeFdToAsync(fd, output, remaining - written);
      });
    }
  };

  kj::Promise<FetchResponse> fetchFromSidecar(FetchRequest&& request) {
    KJ_LOG(WARNING, "Forwarding isolate request to sidecar.",
        fetchMethodName(request.method), request.path, request.body.size());
    return host->network.parseAddress(kj::str("unix:", config->workerdSocketPath), 0)
        .then([this, request = kj::mv(request)](kj::Own<kj::NetworkAddress>&& addr) mutable {
      auto client = kj::newHttpClient(host->timer, host->headerTable, *addr);
      auto state = kj::refcounted<SidecarHttpState>(kj::mv(addr), kj::mv(client));
      kj::HttpHeaders headers(host->headerTable);
      copyHeadersToHttp(request, headers);

      auto bodySize = static_cast<uint64_t>(request.body.size());
      auto httpRequest = state->client->request(toHttpMethod(request.method), request.path, headers,
          bodySize);
      auto response = kj::mv(httpRequest.response);

      if (httpRequest.body.get() != nullptr && request.body.size() > 0) {
        auto requestBody = kj::mv(httpRequest.body);
        auto body = kj::mv(request.body);
        return requestBody->write(body.begin(), body.size())
            .attach(kj::mv(requestBody), kj::mv(body))
            .then([response = kj::mv(response)]() mutable {
          return kj::mv(response);
        }).then([state = kj::mv(state)](
            kj::HttpClient::Response&& response) mutable {
          return readSidecarResponse(kj::mv(response), kj::mv(state));
        });
      }

      return response.then([state = kj::mv(state)](
          kj::HttpClient::Response&& response) mutable {
        return readSidecarResponse(kj::mv(response), kj::mv(state));
      });
    });
  }

  kj::Promise<FetchResponse> fetchPlaceholder(
      FetchRequest&& request, kj::StringPtr runtimeState) {
    if (request.method == FetchMethod::GET || request.method == FetchMethod::HEAD) {
      FetchResponse response;
      response.statusCode = 200;
      response.mimeType = kj::heapString("text/html; charset=utf-8");

      if (request.method == FetchMethod::GET) {
        auto escapedMainModule = htmlEscape(config->mainModule);
        auto escapedCompatibilityDate = htmlEscape(config->compatibilityDate);
        auto escapedAppTitle = htmlEscape(appTitleOrDefault(*config));
        auto escapedBundleDir = htmlEscape(config->workerdBundleDir);
        auto escapedWorkerdConfigPath = htmlEscape(config->workerdConfigPath);
        auto escapedSocketPath = htmlEscape(config->workerdSocketPath);
        auto compatibilityFlags = renderCompatibilityFlagsHtml(*config);
        auto modules = renderModuleListHtml(*config);
        auto bindings = renderBindingListHtml(*config);
        auto body = kj::str(
            "<!doctype html><meta charset=\"utf-8\">"
            "<title>Isolate grain runtime</title>"
            "<h1>Isolate grain runtime</h1>"
            "<p>The isolate supervisor is wired into Sandstorm, "
            "and the workerd adapter seam has loaded the package configuration, "
            "but V8 execution is not implemented yet.</p>"
            "<p>Runtime state: <code>", runtimeState, "</code></p>"
            "<p>App title: <code>", escapedAppTitle, "</code></p>"
            "<p>Main module: <code>", escapedMainModule, "</code></p>"
            "<p>Compatibility date: <code>", escapedCompatibilityDate, "</code></p>"
            "<p>Runtime bundle: <code>", escapedBundleDir, "</code></p>"
            "<p>workerd config: <code>", escapedWorkerdConfigPath, "</code></p>"
            "<p>Runtime socket: <code>", escapedSocketPath, "</code></p>"
            "<h2>Compatibility flags</h2>", compatibilityFlags,
            "<h2>Modules</h2>", modules,
            "<h2>Bindings</h2>", bindings);
        response.body = kj::heapArray<byte>(body.asBytes());
      }

      return kj::mv(response);
    }

    FetchResponse response;
    response.statusCode = 500;
    response.mimeType = kj::heapString("text/plain; charset=utf-8");
    response.body = kj::heapArray<byte>(kj::StringPtr(
        "Isolate workerd adapter is configured, but V8 execution is not implemented yet.").asBytes());
    return kj::mv(response);
  }
};

kj::Own<WebSession::RequestStream::Server> WorkerdRuntimeAdapter::startRequestStream(
    FetchRequest&& request, ByteStream::Client responseStream) {
  KJ_REQUIRE(isSidecarSocketAvailable(), "isolate sidecar socket is not available");
  return kj::heap<StreamingRequestImpl>(
      kj::addRef(*config), kj::addRef(*host), kj::mv(request), kj::mv(responseStream));
}

kj::Own<IsolateRuntimeConfig> loadIsolateRuntimeConfig(
    kj::StringPtr pkgPath, kj::Maybe<kj::StringPtr> requestedMainModule,
    kj::Maybe<kj::StringPtr> requestedCompatibilityDate) {
  auto manifestFile = raiiOpen(kj::str(pkgPath, "/sandstorm-manifest"), O_RDONLY | O_CLOEXEC);

  capnp::ReaderOptions manifestLimits;
  manifestLimits.traversalLimitInWords = spk::Manifest::SIZE_LIMIT_IN_WORDS;
  capnp::StreamFdMessageReader reader(kj::mv(manifestFile), manifestLimits);
  auto manifest = reader.getRoot<spk::Manifest>();

  kj::Maybe<kj::Own<IsolateRuntimeConfig>> found;
  auto considerCommand = [&](spk::Manifest::Command::Reader command) {
    if (command.hasIsolate()) {
      if (found != nullptr) {
        return;
      }

      auto isolate = command.getIsolate();
      KJ_IF_MAYBE(mainModule, requestedMainModule) {
        if (isolate.getMainModule() != *mainModule) {
          return;
        }
      }

      KJ_IF_MAYBE(compatibilityDate, requestedCompatibilityDate) {
        if (isolate.hasCompatibilityDate() && isolate.getCompatibilityDate().size() > 0 &&
            isolate.getCompatibilityDate() != *compatibilityDate) {
          return;
        }
      }

      found = copyIsolateConfig(isolate, pkgPath);
    }
  };

  KJ_IF_MAYBE(mainModule, requestedMainModule) {
    considerCommand(manifest.getContinueCommand());
    for (auto action: manifest.getActions()) {
      considerCommand(action.getCommand());
    }
  } else {
    if (manifest.getContinueCommand().hasIsolate()) {
      return copyIsolateConfig(manifest.getContinueCommand().getIsolate(), pkgPath);
    }

    for (auto action: manifest.getActions()) {
      considerCommand(action.getCommand());
    }
  }

  KJ_IF_MAYBE(config, found) {
    KJ_IF_MAYBE(compatibilityDate, requestedCompatibilityDate) {
      if ((*config)->compatibilityDate.size() == 0) {
        (*config)->compatibilityDate = kj::heapString(*compatibilityDate);
      }
    }
    return kj::mv(*config);
  } else {
    KJ_FAIL_REQUIRE("Manifest does not contain the selected isolate command.");
  }
}

enum class RouteBackedCapabilityType {
  WEB,
  API,
  OBJECT,
};

kj::StringPtr routeBackedCapabilityTypeToken(RouteBackedCapabilityType type) {
  switch (type) {
    case RouteBackedCapabilityType::WEB:
      return "web";
    case RouteBackedCapabilityType::API:
      return "api";
    case RouteBackedCapabilityType::OBJECT:
      return "object";
  }
  KJ_UNREACHABLE;
}

RouteBackedCapabilityType parseRouteBackedCapabilityType(kj::StringPtr value) {
  if (value == "web") {
    return RouteBackedCapabilityType::WEB;
  } else if (value == "api") {
    return RouteBackedCapabilityType::API;
  } else if (value == "object") {
    return RouteBackedCapabilityType::OBJECT;
  } else {
    KJ_FAIL_REQUIRE("invalid isolate route-backed capability type", value);
  }
}

void requireNoRouteBackedDotSegments(kj::StringPtr path, kj::StringPtr description) {
  size_t end = path.size();
  KJ_IF_MAYBE(query, path.findFirst('?')) {
    end = *query;
  }

  size_t start = 0;
  for (size_t i = 0; i <= end; ++i) {
    if (i == end || path[i] == '/') {
      auto segment = path.slice(start, i);
      KJ_REQUIRE(!(segment.size() == 1 && segment[0] == '.') &&
          !(segment.size() == 2 && segment[0] == '.' && segment[1] == '.'),
          description, path);
      start = i + 1;
    }
  }
}

void requireRouteBackedPathRelative(kj::StringPtr path, kj::StringPtr description) {
  for (size_t i = 0; i + 2 < path.size(); ++i) {
    KJ_REQUIRE(!(path[i] == ':' && path[i + 1] == '/' && path[i + 2] == '/'),
        description, path);
  }
  requireNoRouteBackedDotSegments(path, description);
}

kj::String normalizeRouteBackedPathPrefix(kj::StringPtr pathPrefix) {
  KJ_REQUIRE(pathPrefix.size() <= 1024, "route-backed capability pathPrefix is too long");
  KJ_REQUIRE(pathPrefix.findFirst('?') == nullptr && pathPrefix.findFirst('#') == nullptr,
      "route-backed capability pathPrefix must not contain query strings or fragments");
  requireRouteBackedPathRelative(pathPrefix,
      "route-backed capability pathPrefix must be path-relative and canonical");
  KJ_REQUIRE(pathPrefix.size() == 0 || pathPrefix[0] == '/',
      "route-backed capability pathPrefix must be empty or start with '/'");
  return kj::heapString(pathPrefix);
}

kj::String normalizeRouteBackedRequestPath(kj::StringPtr path) {
  KJ_REQUIRE(path.size() <= 8192, "route-backed capability request path is too long");
  requireRouteBackedPathRelative(path,
      "route-backed capability request path must be path-relative and canonical");
  return kj::heapString(path);
}

bool routeBackedPathIsWithinPrefix(kj::StringPtr path, kj::StringPtr prefix) {
  if (prefix.size() == 0) {
    return true;
  }
  if (prefix == "/") {
    return path.startsWith("/");
  }
  if (path == prefix) {
    return true;
  }
  if (prefix.endsWith("/")) {
    return path.startsWith(prefix);
  }
  return path.size() > prefix.size() && path.startsWith(prefix) && path[prefix.size()] == '/';
}

struct RouteBackedCapabilityRef {
  RouteBackedCapabilityType type;
  kj::String pathPrefix;
};

RouteBackedCapabilityRef parseRouteBackedCapabilityRef(kj::StringPtr payload) {
  KJ_IF_MAYBE(newline, payload.findFirst('\n')) {
    auto typeName = kj::StringPtr(payload.begin(), *newline);
    auto pathPrefix = kj::StringPtr(payload.begin() + *newline + 1,
        payload.size() - *newline - 1);
    return RouteBackedCapabilityRef {
        parseRouteBackedCapabilityType(typeName),
        normalizeRouteBackedPathPrefix(pathPrefix)
    };
  } else {
    return RouteBackedCapabilityRef {
        RouteBackedCapabilityType::WEB,
        normalizeRouteBackedPathPrefix(payload)
    };
  }
}

RouteBackedCapabilityRef parseRouteBackedCapabilityAppRef(capnp::Data::Reader appRef) {
  auto text = kj::StringPtr(appRef.asChars().begin(), appRef.size());
  auto prefix = kj::StringPtr(ISOLATE_ROUTE_BACKED_APP_REF_PREFIX);
  KJ_REQUIRE(text.startsWith(prefix), "unknown isolate app-ref format");
  return parseRouteBackedCapabilityRef(
      kj::StringPtr(text.begin() + prefix.size(), text.size() - prefix.size()));
}

template <typename InternalSession>
kj::StringPtr routeBackedCapabilityTypeToken();

template <>
kj::StringPtr routeBackedCapabilityTypeToken<IsolateWebSession>() {
  return routeBackedCapabilityTypeToken(RouteBackedCapabilityType::WEB);
}

template <>
kj::StringPtr routeBackedCapabilityTypeToken<IsolateApiSession>() {
  return routeBackedCapabilityTypeToken(RouteBackedCapabilityType::API);
}

struct RouteBackedRequirementState final: public kj::Refcounted {
  bool revoked = false;
  kj::Vector<OwnCapnp<capnp::List<MembraneRequirement>>> requirements;
  kj::Vector<SystemPersistent::RevocationObserver::Client> observers;
};

class RouteBackedRevokerHandle final: public Handle::Server {
public:
  explicit RouteBackedRevokerHandle(kj::Own<RouteBackedRequirementState> state)
      : state(kj::mv(state)) {}

  ~RouteBackedRevokerHandle() noexcept(false) {
    state->revoked = true;
  }

private:
  kj::Own<RouteBackedRequirementState> state;
};

template <typename InternalSession>
class IsolateRouteBackedSessionImpl final: public InternalSession::Server {
public:
  IsolateRouteBackedSessionImpl(
      kj::Own<IsolateRuntimeConfig> config, kj::Own<IsolateRuntimeHost> host,
      kj::StringPtr pathPrefix = "", SessionKind sessionKind = SessionKind::NORMAL,
      SessionMetadata&& sessionMetadata = SessionMetadata(), bool persistent = true,
      kj::Own<RouteBackedRequirementState> requirementState =
          kj::refcounted<RouteBackedRequirementState>(),
      kj::Maybe<kj::Array<const byte>> parentToken = nullptr)
      : pathPrefix(kj::heapString(pathPrefix)),
        sessionKind(sessionKind),
        sessionMetadata(kj::mv(sessionMetadata)),
        persistent(persistent),
        requirementState(kj::mv(requirementState)),
        parentToken(kj::mv(parentToken)),
        runtimeConfig(kj::addRef(*config)),
        runtimeHost(kj::addRef(*host)),
        runtime(kj::heap<WorkerdRuntimeAdapter>(kj::mv(config), kj::mv(host))) {}

  ~IsolateRouteBackedSessionImpl() noexcept(false) {
    if (sessionMetadata.sessionId.size() > 0) {
      runtimeHost->sessions->unregisterSession(sessionMetadata.sessionId);
    }
  }

  kj::Promise<void> get(typename InternalSession::Server::GetContext context) override {
    auto params = context.getParams();
    auto method = params.getIgnoreBody() ? FetchMethod::HEAD : FetchMethod::GET;
    auto request = makeFetchRequest(method, prefixedPath(params.getPath()), params.getContext());
    return fetch(kj::mv(request), context.getResults(), params.getContext().getResponseStream());
  }

  kj::Promise<void> post(typename InternalSession::Server::PostContext context) override {
    auto params = context.getParams();
    auto request = makeFetchRequest(FetchMethod::POST, prefixedPath(params.getPath()),
        params.getContext());
    setFetchRequestBody(request, params.getContent());
    return fetch(kj::mv(request), context.getResults(), params.getContext().getResponseStream());
  }

  kj::Promise<void> postStreaming(
      typename InternalSession::Server::PostStreamingContext context) override {
    auto params = context.getParams();
    auto request = makeFetchRequest(FetchMethod::POST, prefixedPath(params.getPath()),
        params.getContext());
    setFetchRequestBodyHeaders(request, params.getMimeType(), params.getEncoding());
    if (params.getExpectedSize() > 0) {
      request.expectedBodySize = params.getExpectedSize();
    }
    addSessionHeaders(request);
    context.getResults().setStream(runtime->startRequestStream(
        kj::mv(request), params.getContext().getResponseStream()));
    return kj::READY_NOW;
  }

  kj::Promise<void> put(typename InternalSession::Server::PutContext context) override {
    auto params = context.getParams();
    auto request = makeFetchRequest(FetchMethod::PUT, prefixedPath(params.getPath()),
        params.getContext());
    setFetchRequestBody(request, params.getContent());
    return fetch(kj::mv(request), context.getResults(), params.getContext().getResponseStream());
  }

  kj::Promise<void> putStreaming(
      typename InternalSession::Server::PutStreamingContext context) override {
    auto params = context.getParams();
    auto request = makeFetchRequest(FetchMethod::PUT, prefixedPath(params.getPath()),
        params.getContext());
    setFetchRequestBodyHeaders(request, params.getMimeType(), params.getEncoding());
    if (params.getExpectedSize() > 0) {
      request.expectedBodySize = params.getExpectedSize();
    }
    addSessionHeaders(request);
    context.getResults().setStream(runtime->startRequestStream(
        kj::mv(request), params.getContext().getResponseStream()));
    return kj::READY_NOW;
  }

  kj::Promise<void> delete_(typename InternalSession::Server::DeleteContext context) override {
    auto params = context.getParams();
    auto request = makeFetchRequest(FetchMethod::DELETE_, prefixedPath(params.getPath()),
        params.getContext());
    return fetch(kj::mv(request), context.getResults(), params.getContext().getResponseStream());
  }

  kj::Promise<void> patch(typename InternalSession::Server::PatchContext context) override {
    auto params = context.getParams();
    auto request = makeFetchRequest(FetchMethod::PATCH, prefixedPath(params.getPath()),
        params.getContext());
    setFetchRequestBody(request, params.getContent());
    return fetch(kj::mv(request), context.getResults(), params.getContext().getResponseStream());
  }

  kj::Promise<void> options(typename InternalSession::Server::OptionsContext context) override {
    return kj::READY_NOW;
  }

  kj::Promise<void> addRequirements(
      typename InternalSession::Server::AddRequirementsContext context) override {
    auto params = context.getParams();
    if (params.getRequirements().size() > 0) {
      requirementState->requirements.add(newOwnCapnp(params.getRequirements()));
    }

    auto observer = params.getObserver();
    auto req = observer.dropWhenRevokedRequest();
    req.setHandle(kj::heap<RouteBackedRevokerHandle>(kj::addRef(*requirementState)));
    requirementState->observers.add(kj::mv(observer));

    return req.send().ignoreResult().then([this, context]() mutable {
      context.getResults().setCap(this->thisCap().template castAs<SystemPersistent>());
    });
  }

  kj::Promise<void> save(typename InternalSession::Server::SaveContext context) override {
    KJ_REQUIRE(persistent, "isolate route-backed capability is not persistent");
    KJ_REQUIRE(!requirementState->revoked,
        "isolate route-backed capability requirements have been revoked");
    auto params = context.getParams();
    KJ_IF_MAYBE(parent, parentToken) {
      auto request = runtimeHost->sandstormCore.makeChildTokenRequest();
      request.setParent(*parent);
      request.setOwner(params.getSealFor());
      request.adoptRequirements(collectRequirements(capnp::Orphanage::getForMessageContaining(
          SandstormCore::MakeChildTokenParams::Builder(request))));
      return request.send().then([context](auto result) mutable {
        context.getResults().setSturdyRef(result.getToken());
      });
    } else {
      auto payload = kj::str(ISOLATE_ROUTE_BACKED_APP_REF_PREFIX, capabilityTypeToken(), "\n",
          pathPrefix);

      capnp::MallocMessageBuilder appRefMessage;
      auto appRef = appRefMessage.initRoot<capnp::AnyPointer>();
      appRef.setAs<capnp::Data>(payload.asBytes());

      auto request = runtimeHost->sandstormCore.makeTokenRequest();
      request.getRef().setAppRef(appRef.asReader());
      request.setOwner(params.getSealFor());
      request.adoptRequirements(collectRequirements(capnp::Orphanage::getForMessageContaining(
          SandstormCore::MakeTokenParams::Builder(request))));
      return request.send().then([context](auto result) mutable {
        context.getResults().setSturdyRef(result.getToken());
      });
    }
  }

private:
  kj::String pathPrefix;
  SessionKind sessionKind;
  SessionMetadata sessionMetadata;
  bool persistent;
  kj::Own<RouteBackedRequirementState> requirementState;
  kj::Maybe<kj::Array<const byte>> parentToken;
  kj::Own<IsolateRuntimeConfig> runtimeConfig;
  kj::Own<IsolateRuntimeHost> runtimeHost;
  kj::Own<IsolateRuntimeAdapter> runtime;

  kj::StringPtr capabilityTypeToken() { return routeBackedCapabilityTypeToken<InternalSession>(); }

  capnp::Orphan<capnp::List<MembraneRequirement>> collectRequirements(
      capnp::Orphanage orphanage) {
    if (requirementState->requirements.size() == 0) {
      return {};
    }

    kj::Vector<capnp::List<MembraneRequirement>::Reader> parts(
        requirementState->requirements.size());
    for (auto& requirement: requirementState->requirements) {
      if (requirement.size() > 0) {
        parts.add(requirement);
      }
    }

    if (parts.size() > 0) {
      return orphanage.newOrphanConcat(parts.asPtr());
    }
    return {};
  }

  kj::String prefixedPath(kj::StringPtr path) {
    auto normalizedPath = normalizeRouteBackedRequestPath(path);
    if (pathPrefix.size() == 0) {
      return kj::mv(normalizedPath);
    } else if (normalizedPath.size() == 0) {
      return kj::heapString(pathPrefix);
    } else if (pathPrefix[pathPrefix.size() - 1] == '/' && normalizedPath[0] == '/') {
      return kj::str(pathPrefix.slice(0, pathPrefix.size() - 1), normalizedPath);
    } else if (pathPrefix[pathPrefix.size() - 1] != '/' && normalizedPath[0] != '/') {
      return kj::str(pathPrefix, "/", normalizedPath);
    } else {
      return kj::str(pathPrefix, normalizedPath);
    }
  }

  void addSessionHeaders(FetchRequest& request) {
    addHeader(request, "x-sandstorm-session-type", sessionKindName(sessionKind));
    if (sessionMetadata.sessionId.size() > 0) {
      addHeader(request, "x-sandstorm-session-id", sessionMetadata.sessionId);
    }
    if (sessionMetadata.offeredCapabilityId.size() > 0) {
      addHeader(request, "x-sandstorm-offered-capability-id",
          sessionMetadata.offeredCapabilityId);
    }
    if (sessionMetadata.offerDescriptorJson.size() > 0) {
      addHeader(request, "x-sandstorm-offer-descriptor", sessionMetadata.offerDescriptorJson);
    }
    if (sessionMetadata.userDisplayName.size() > 0) {
      addHeader(request, "x-sandstorm-username", sessionMetadata.userDisplayName);
    }
    if (sessionMetadata.permissions.size() > 0) {
      addHeader(request, "x-sandstorm-permissions", sessionMetadata.permissions);
    }
    if (sessionMetadata.userId.size() > 0) {
      addHeader(request, "x-sandstorm-user-id", sessionMetadata.userId);
    }
    if (sessionMetadata.userHandle.size() > 0) {
      addHeader(request, "x-sandstorm-preferred-handle", sessionMetadata.userHandle);
    }
    if (sessionMetadata.userPicture.size() > 0) {
      addHeader(request, "x-sandstorm-user-picture", sessionMetadata.userPicture);
    }
    if (sessionMetadata.userPronouns.size() > 0) {
      addHeader(request, "x-sandstorm-user-pronouns", sessionMetadata.userPronouns);
    }
    if (sessionMetadata.userAgent.size() > 0) {
      addHeader(request, "user-agent", sessionMetadata.userAgent);
    }
    if (sessionMetadata.acceptableLanguages.size() > 0) {
      addHeader(request, "accept-language", sessionMetadata.acceptableLanguages);
    }
    if (sessionMetadata.tabId.size() > 0) {
      addHeader(request, "x-sandstorm-tab-id", sessionMetadata.tabId);
    }
    if (sessionMetadata.basePath.size() > 0) {
      addHeader(request, "x-sandstorm-base-path", sessionMetadata.basePath);
    }
    addHeader(request, "host",
        sessionMetadata.host.size() > 0 ? kj::StringPtr(sessionMetadata.host) : "sandbox");
    addHeader(request, "x-forwarded-proto",
        sessionMetadata.forwardedProto.size() > 0
            ? kj::StringPtr(sessionMetadata.forwardedProto)
            : "http");
  }

  kj::Promise<void> fetch(
      FetchRequest&& request, WebSession::Response::Builder response, ByteStream::Client responseStream) {
    addSessionHeaders(request);
    bool omitBody = request.method == FetchMethod::HEAD;
    KJ_LOG(WARNING, "Handling isolate WebSession request.",
        fetchMethodName(request.method), request.path, sessionKindName(sessionKind));
    return runtime->fetch(kj::mv(request))
        .then([response, responseStream = kj::mv(responseStream), omitBody](
            FetchResponse&& fetchResponse) mutable {
      writeFetchResponse(kj::mv(fetchResponse), response, kj::mv(responseStream), omitBody);
    });
  }
};

class ClaimedIsolateObjectCapability final: public IsolatePersistentObjectCapability::Server {
public:
  ClaimedIsolateObjectCapability(kj::Own<IsolateSessionRegistry> sessions,
      kj::StringPtr id, IsolateObjectCapability::Client cap)
      : sessions(kj::mv(sessions)), id(kj::heapString(id)), cap(kj::mv(cap)) {}

  kj::Promise<void> call(CallContext context) override {
    auto params = context.getParams();
    return callIsolateObjectCapability(cap, params.getMethod(), params.getArgs())
        .then([context](OwnedIsolateObjectCallResult&& result) mutable {
      copyIsolateObjectCallResult(result.getResult(), context.getResults().initResult());
    });
  }

  kj::Promise<void> drop(DropContext context) override {
    auto req = cap.dropRequest();
    return req.send()
        .then([this, context](auto result) mutable {
      context.getResults().setReleased(result.getReleased());
      sessions->dropClaimedCapability(id);
    });
  }

  kj::Promise<void> dup(DupContext context) override {
    auto req = cap.dupRequest();
    return req.send().then([this, context](auto result) mutable {
      auto duplicatedId = sessions->storeClaimedCapability(
          result.getCapability(),
          makeImportedClaimedCapabilityMetadata(
            ClaimedCapabilityKind::UNKNOWN, ClaimedCapabilityNativeInterface::APP_OBJECT));
      KJ_IF_MAYBE(duplicatedCap, sessions->findClaimedCapability(duplicatedId)) {
        context.getResults().setCapability(IsolateObjectCapability::Client(
            kj::heap<ClaimedIsolateObjectCapability>(
              kj::addRef(*sessions), duplicatedId,
              duplicatedCap->template castAs<IsolateObjectCapability>())));
      }
    });
  }

  kj::Promise<void> save(SaveContext context) override {
    auto request = cap.castAs<SystemPersistent>().saveRequest();
    request.setSealFor(context.getParams().getSealFor());
    return request.send().then([context](auto result) mutable {
      context.getResults().setSturdyRef(result.getSturdyRef());
    });
  }

  kj::Promise<void> addRequirements(AddRequirementsContext context) override {
    auto request = cap.castAs<SystemPersistent>().addRequirementsRequest();
    request.setRequirements(context.getParams().getRequirements());
    request.setObserver(context.getParams().getObserver());
    return request.send().then([context](auto result) mutable {
      context.getResults().setCap(result.getCap());
    });
  }

private:
  kj::Own<IsolateSessionRegistry> sessions;
  kj::String id;
  IsolateObjectCapability::Client cap;
};

class ClaimedCapabilityWorkerAppObjectAdapter final: public WorkerAppObjectJsonCapabilityAdapter {
public:
  explicit ClaimedCapabilityWorkerAppObjectAdapter(IsolateSessionRegistry& sessions)
      : sessions(sessions) {}

  kj::Maybe<IsolateObjectCapability::Client> findCapability(kj::StringPtr id) override {
    KJ_IF_MAYBE(metadata, sessions.findClaimedCapabilityMetadata(id)) {
      KJ_REQUIRE(claimedCapabilitySupportsAppObjectCall(metadata->nativeInterface),
          "claimed capability cannot be used as native app RPC argument",
          claimedCapabilityNativeInterfaceName(metadata->nativeInterface));
    }
    KJ_IF_MAYBE(cap, sessions.findClaimedCapability(id)) {
      return IsolateObjectCapability::Client(kj::heap<ClaimedIsolateObjectCapability>(
          kj::addRef(sessions), id, cap->castAs<IsolateObjectCapability>()));
    }
    return nullptr;
  }

  kj::String storeCapability(IsolateObjectCapability::Client capability) override {
    return sessions.storeClaimedCapability(
        kj::mv(capability),
        makeImportedClaimedCapabilityMetadata(
          ClaimedCapabilityKind::UNKNOWN, ClaimedCapabilityNativeInterface::APP_OBJECT));
  }

private:
  IsolateSessionRegistry& sessions;
};

struct RouteBackedObjectCapabilityState final: public kj::Refcounted {
  kj::String pathPrefix;
  kj::Maybe<kj::String> claimedId;
  kj::Own<RouteBackedRequirementState> requirementState =
      kj::refcounted<RouteBackedRequirementState>();
};

class RouteBackedIsolateObjectCapability final
    : public IsolatePersistentObjectCapability::Server {
public:
  RouteBackedIsolateObjectCapability(
      kj::Own<IsolateRuntimeConfig> config, kj::Own<IsolateRuntimeHost> host,
      kj::Own<RouteBackedObjectCapabilityState> state, bool persistent,
      kj::Maybe<kj::Array<const byte>> parentToken = nullptr)
      : state(kj::mv(state)),
        persistent(persistent),
        parentToken(kj::mv(parentToken)),
        runtimeConfig(kj::addRef(*config)),
        runtimeHost(kj::addRef(*host)),
        runtime(kj::heap<WorkerdRuntimeAdapter>(kj::mv(config), kj::mv(host))) {}

  kj::Promise<void> call(CallContext context) override {
    auto params = context.getParams();
    auto adapter = kj::heap<ClaimedCapabilityWorkerAppObjectAdapter>(*runtimeHost->sessions);
    auto body = renderWorkerAppObjectCallJson(
        params.getMethod(), params.getArgs(), *adapter);

    FetchRequest request;
    request.method = FetchMethod::POST;
    request.path = kj::str(state->pathPrefix, "/native-app-rpc-call");
    request.mimeType = kj::heapString("application/json; charset=utf-8");
    request.encoding = kj::heapString("");
    request.expectedBodySize = body.size();
    request.body = kj::heapArray<byte>(body.asBytes());
    addHeader(request, "content-type", "application/json; charset=utf-8");
    addHeader(request, "host", "sandbox");

    return runtime->fetch(kj::mv(request))
        .then([context, adapter = kj::mv(adapter)](FetchResponse&& response) mutable {
      auto result = parseWorkerAppObjectResultJson(
          response.body.asPtr(), *adapter, MAX_API_BINDING_REQUEST_BYTES);
      copyIsolateObjectCallResult(result.getResult(), context.getResults().initResult());
    });
  }

  kj::Promise<void> drop(DropContext context) override {
    KJ_IF_MAYBE(id, state->claimedId) {
      KJ_IF_MAYBE(dropped, runtimeHost->sessions->dropClaimedCapability(*id)) {
        KJ_IF_MAYBE(dropNotifyPath, dropped->dropNotifyPath) {
          context.getResults().setReleased(true);
          FetchRequest request;
          request.method = FetchMethod::POST;
          request.path = toHttpRequestTarget(kj::str(*dropNotifyPath, "/__sandstorm_dispose"));
          request.mimeType = kj::heapString("application/json; charset=utf-8");
          request.encoding = kj::heapString("");
          auto body = kj::StringPtr("{}");
          request.expectedBodySize = body.size();
          request.body = kj::heapArray<byte>(body.asBytes());
          addHeader(request, "content-type", "application/json; charset=utf-8");
          addHeader(request, "host", "sandbox");
          state->claimedId = nullptr;
          return runtime->fetch(kj::mv(request)).ignoreResult()
              .catch_([](kj::Exception&& exception) {
            KJ_LOG(WARNING, "Isolate route-backed object capability drop notification threw.",
                exception);
          });
        }
      }
      state->claimedId = nullptr;
    }
    context.getResults().setReleased(false);
    return kj::READY_NOW;
  }

  kj::Promise<void> dup(DupContext context) override {
    KJ_IF_MAYBE(id, state->claimedId) {
      KJ_IF_MAYBE(duplicatedId, runtimeHost->sessions->duplicateClaimedCapability(*id)) {
        auto duplicatedState = kj::refcounted<RouteBackedObjectCapabilityState>();
        duplicatedState->pathPrefix = kj::heapString(state->pathPrefix);
        duplicatedState->claimedId = kj::heapString(*duplicatedId);
        duplicatedState->requirementState = kj::addRef(*state->requirementState);
        context.getResults().setCapability(IsolateObjectCapability::Client(
            kj::heap<RouteBackedIsolateObjectCapability>(
              kj::addRef(*runtimeConfig), kj::addRef(*runtimeHost),
              kj::mv(duplicatedState), persistent)));
        return kj::READY_NOW;
      }
    }

    KJ_FAIL_REQUIRE("unknown route-backed isolate object capability");
  }

  kj::Promise<void> addRequirements(AddRequirementsContext context) override {
    auto params = context.getParams();
    if (params.getRequirements().size() > 0) {
      state->requirementState->requirements.add(newOwnCapnp(params.getRequirements()));
    }

    auto observer = params.getObserver();
    auto req = observer.dropWhenRevokedRequest();
    req.setHandle(kj::heap<RouteBackedRevokerHandle>(
        kj::addRef(*state->requirementState)));
    state->requirementState->observers.add(kj::mv(observer));

    return req.send().ignoreResult().then([this, context]() mutable {
      context.getResults().setCap(this->thisCap().castAs<SystemPersistent>());
    });
  }

  kj::Promise<void> save(SaveContext context) override {
    KJ_REQUIRE(persistent, "isolate route-backed object capability is not persistent");
    KJ_REQUIRE(!state->requirementState->revoked,
        "isolate route-backed object capability requirements have been revoked");
    auto params = context.getParams();
    KJ_IF_MAYBE(parent, parentToken) {
      auto request = runtimeHost->sandstormCore.makeChildTokenRequest();
      request.setParent(*parent);
      request.setOwner(params.getSealFor());
      request.adoptRequirements(collectRequirements(capnp::Orphanage::getForMessageContaining(
          SandstormCore::MakeChildTokenParams::Builder(request))));
      return request.send().then([context](auto result) mutable {
        context.getResults().setSturdyRef(result.getToken());
      });
    } else {
      auto payload = kj::str(ISOLATE_ROUTE_BACKED_APP_REF_PREFIX,
          routeBackedCapabilityTypeToken(RouteBackedCapabilityType::OBJECT), "\n", state->pathPrefix);

      capnp::MallocMessageBuilder appRefMessage;
      auto appRef = appRefMessage.initRoot<capnp::AnyPointer>();
      appRef.setAs<capnp::Data>(payload.asBytes());

      auto request = runtimeHost->sandstormCore.makeTokenRequest();
      request.getRef().setAppRef(appRef.asReader());
      request.setOwner(params.getSealFor());
      request.adoptRequirements(collectRequirements(capnp::Orphanage::getForMessageContaining(
          SandstormCore::MakeTokenParams::Builder(request))));
      return request.send().then([context](auto result) mutable {
        context.getResults().setSturdyRef(result.getToken());
      });
    }
  }

private:
  kj::Own<RouteBackedObjectCapabilityState> state;
  bool persistent;
  kj::Maybe<kj::Array<const byte>> parentToken;
  kj::Own<IsolateRuntimeConfig> runtimeConfig;
  kj::Own<IsolateRuntimeHost> runtimeHost;
  kj::Own<IsolateRuntimeAdapter> runtime;

  capnp::Orphan<capnp::List<MembraneRequirement>> collectRequirements(
      capnp::Orphanage orphanage) {
    if (state->requirementState->requirements.size() == 0) {
      return {};
    }

    kj::Vector<capnp::List<MembraneRequirement>::Reader> parts(
        state->requirementState->requirements.size());
    for (auto& requirement: state->requirementState->requirements) {
      if (requirement.size() > 0) {
        parts.add(requirement);
      }
    }

    if (parts.size() > 0) {
      return orphanage.newOrphanConcat(parts.asPtr());
    }
    return {};
  }
};

struct RouteBackedObjectCapability {
  IsolateObjectCapability::Client cap;
  kj::Own<RouteBackedObjectCapabilityState> state;
};

RouteBackedObjectCapability makeRouteBackedObjectCapabilityWithState(
    kj::Own<IsolateRuntimeConfig> config, kj::Own<IsolateRuntimeHost> host,
    kj::StringPtr pathPrefix, bool persistent,
    kj::Maybe<kj::Array<const byte>> parentToken = nullptr) {
  auto state = kj::refcounted<RouteBackedObjectCapabilityState>();
  state->pathPrefix = kj::heapString(pathPrefix);
  auto cap = kj::heap<RouteBackedIsolateObjectCapability>(
      kj::mv(config), kj::mv(host), kj::addRef(*state), persistent, kj::mv(parentToken));
  return RouteBackedObjectCapability { kj::mv(cap), kj::mv(state) };
}

IsolateObjectCapability::Client makeRouteBackedObjectCapability(
    kj::Own<IsolateRuntimeConfig> config, kj::Own<IsolateRuntimeHost> host,
    kj::StringPtr pathPrefix, bool persistent,
    kj::Maybe<kj::Array<const byte>> parentToken = nullptr) {
  auto object = makeRouteBackedObjectCapabilityWithState(
      kj::mv(config), kj::mv(host), pathPrefix, persistent, kj::mv(parentToken));
  return kj::mv(object.cap);
}

capnp::Capability::Client makeRouteBackedSessionCapability(
    kj::Own<IsolateRuntimeConfig> config, kj::Own<IsolateRuntimeHost> host,
    RouteBackedCapabilityType capabilityType, kj::StringPtr pathPrefix, bool persistent,
    kj::Maybe<kj::Array<const byte>> parentToken = nullptr) {
  switch (capabilityType) {
    case RouteBackedCapabilityType::WEB:
      return kj::heap<IsolateRouteBackedSessionImpl<IsolateWebSession>>(
          kj::mv(config), kj::mv(host), pathPrefix, SessionKind::NORMAL,
          SessionMetadata(), persistent, kj::refcounted<RouteBackedRequirementState>(),
          kj::mv(parentToken));
    case RouteBackedCapabilityType::API:
      return kj::heap<IsolateRouteBackedSessionImpl<IsolateApiSession>>(
          kj::mv(config), kj::mv(host), pathPrefix, SessionKind::NORMAL,
          SessionMetadata(), persistent, kj::refcounted<RouteBackedRequirementState>(),
          kj::mv(parentToken));
    case RouteBackedCapabilityType::OBJECT:
      KJ_FAIL_REQUIRE("route-backed object capabilities are not session capabilities");
  }
  KJ_UNREACHABLE;
}

class IsolateUiViewImpl final: public UiView::Server {
public:
  IsolateUiViewImpl(kj::Own<IsolateRuntimeConfig> runtimeConfig,
      kj::Own<IsolateRuntimeHost> runtimeHost)
      : runtimeConfig(kj::mv(runtimeConfig)), runtimeHost(kj::mv(runtimeHost)) {}

  kj::Promise<void> getViewInfo(GetViewInfoContext context) override {
    context.setResults(runtimeConfig->viewInfoMessage->getRoot<UiView::ViewInfo>().asReader());

    if (runtimeConfig->appTitle.size() == 0) {
      context.getResults().initAppTitle().setDefaultText(appTitleOrDefault(*runtimeConfig));
    }
    return kj::READY_NOW;
  }

  kj::Promise<void> newSession(NewSessionContext context) override {
    auto params = context.getParams();
    auto sessionType = params.getSessionType();
    auto viewInfo = runtimeConfig->viewInfoMessage->getRoot<UiView::ViewInfo>().asReader();
    bool isWebSession = sessionType == capnp::typeId<WebSession>();
    bool isApiSession = sessionType == capnp::typeId<ApiSession>() &&
        runtimeConfig->apiPath.size() > 0;
    KJ_REQUIRE(isWebSession || isApiSession,
        "Unsupported isolate grain session type.");

    kj::StringPtr pathPrefix = isApiSession ? runtimeConfig->apiPath.asPtr() : kj::StringPtr("");
    auto sessionMetadata = isWebSession
        ? copySessionMetadata(params.getSessionParams().getAs<WebSession::Params>(),
            params.getUserInfo(), viewInfo, params.getTabId())
        : copyApiSessionMetadata(params.getUserInfo(), viewInfo, params.getTabId());
    sessionMetadata.sessionId = runtimeHost->sessions->registerSession(params.getContext());
    if (isApiSession) {
      context.getResults().setSession(
          kj::heap<IsolateRouteBackedSessionImpl<IsolateApiSession>>(
              kj::addRef(*runtimeConfig), kj::addRef(*runtimeHost), pathPrefix,
              SessionKind::NORMAL, kj::mv(sessionMetadata)));
    } else {
      context.getResults().setSession(
          kj::heap<IsolateRouteBackedSessionImpl<IsolateWebSession>>(
              kj::addRef(*runtimeConfig), kj::addRef(*runtimeHost), pathPrefix,
              SessionKind::NORMAL, kj::mv(sessionMetadata)));
    }
    return kj::READY_NOW;
  }

  kj::Promise<void> newRequestSession(NewRequestSessionContext context) override {
    auto params = context.getParams();
    KJ_REQUIRE(params.getSessionType() == capnp::typeId<WebSession>(),
        "Unsupported isolate grain request session type.");

    auto viewInfo = runtimeConfig->viewInfoMessage->getRoot<UiView::ViewInfo>().asReader();
    auto sessionMetadata = copySessionMetadata(
        params.getSessionParams().getAs<WebSession::Params>(), params.getUserInfo(), viewInfo,
        params.getTabId());
    sessionMetadata.sessionId = runtimeHost->sessions->registerSession(params.getContext());
    context.getResults().setSession(kj::heap<IsolateRouteBackedSessionImpl<IsolateWebSession>>(
        kj::addRef(*runtimeConfig), kj::addRef(*runtimeHost), "", SessionKind::REQUEST,
        kj::mv(sessionMetadata)));
    return kj::READY_NOW;
  }

  kj::Promise<void> newOfferSession(NewOfferSessionContext context) override {
    auto params = context.getParams();
    KJ_REQUIRE(params.getSessionType() == capnp::typeId<WebSession>(),
        "Unsupported isolate grain offer session type.");

    auto viewInfo = runtimeConfig->viewInfoMessage->getRoot<UiView::ViewInfo>().asReader();
    auto sessionMetadata = copySessionMetadata(
        params.getSessionParams().getAs<WebSession::Params>(), params.getUserInfo(), viewInfo,
        params.getTabId());
    sessionMetadata.sessionId = runtimeHost->sessions->registerSession(params.getContext());
    sessionMetadata.offeredCapabilityId = runtimeHost->sessions->storeClaimedCapability(
        params.getOffer(), makeImportedClaimedCapabilityMetadata(
          ClaimedCapabilityKind::POWERBOX_OFFER,
          nativeInterfaceFromPowerboxDescriptor(params.getDescriptor())));
    copyOfferDescriptor(sessionMetadata, params.getDescriptor());
    context.getResults().setSession(kj::heap<IsolateRouteBackedSessionImpl<IsolateWebSession>>(
        kj::addRef(*runtimeConfig), kj::addRef(*runtimeHost), "", SessionKind::OFFER,
        kj::mv(sessionMetadata)));
    return kj::READY_NOW;
  }

private:
  kj::Own<IsolateRuntimeConfig> runtimeConfig;
  kj::Own<IsolateRuntimeHost> runtimeHost;
};

kj::String trustedWorkerdExecutablePath();
void requireAllowedSidecarCommand(
    kj::ArrayPtr<const kj::String> argvStrings, IsolateRuntimeConfig& runtimeConfig);
int runConfinedWorkerdSidecar(
    kj::Array<kj::String> argvStrings,
    kj::Array<kj::String> environment,
    kj::String trustedWorkerd,
    kj::String workerdBundleDir,
    kj::Maybe<uid_t> sandboxUid,
    bool logSeccompViolations);

class WorkerdSidecarProcess final {
public:
  WorkerdSidecarProcess(
      kj::ArrayPtr<const kj::String> runtimeArgs,
      kj::ArrayPtr<const kj::String> environment,
      IsolateRuntimeConfig& runtimeConfig,
      kj::Maybe<uid_t> sandboxUid,
      bool logSeccompViolations) {
    if (runtimeArgs.size() == 0) {
      KJ_LOG(WARNING, "No isolate sidecar command configured; runtime remains in diagnostics mode.",
          runtimeConfig.workerdBundleDir, runtimeConfig.workerdSocketPath);
      return;
    }

    auto argvStrings = KJ_MAP(arg, runtimeArgs) {
      return expandSidecarPlaceholders(arg, runtimeConfig);
    };
    requireAllowedSidecarCommand(argvStrings.asPtr(), runtimeConfig);
    auto childEnvStrings = makeSidecarEnvironment(environment, runtimeConfig);

    auto trustedWorkerd = trustedWorkerdExecutablePath();
    auto trustedWorkerdForLog = kj::str(trustedWorkerd);
    process = Subprocess([argvStrings = kj::mv(argvStrings),
                          childEnvStrings = kj::mv(childEnvStrings),
                          trustedWorkerd = kj::mv(trustedWorkerd),
                          workerdBundleDir = kj::heapString(runtimeConfig.workerdBundleDir),
                          sandboxUid,
                          logSeccompViolations]() mutable {
      return runConfinedWorkerdSidecar(
          kj::mv(argvStrings), kj::mv(childEnvStrings), kj::mv(trustedWorkerd),
          kj::mv(workerdBundleDir), sandboxUid, logSeccompViolations);
    });

    KJ_IF_MAYBE(p, process) {
      KJ_LOG(WARNING, "Started isolate sidecar process.",
          trustedWorkerdForLog, p->getPid(), runtimeConfig.workerdBundleDir,
          runtimeConfig.workerdSocketPath);
    }
  }

  ~WorkerdSidecarProcess() noexcept(false) {
    stop();
  }

  KJ_DISALLOW_COPY(WorkerdSidecarProcess);

  bool isConfigured() {
    KJ_IF_MAYBE(p, process) {
      return true;
    }

    return false;
  }

  bool isRunning() {
    KJ_IF_MAYBE(p, process) {
      if (!p->isRunning()) {
        return false;
      }

      int status;
      pid_t waitResult;
      KJ_SYSCALL(waitResult = waitpid(p->getPid(), &status, WNOHANG));
      if (waitResult == p->getPid()) {
        logExitStatus(status);
        p->notifyExited(status);
        return false;
      }

      if (waitResult == 0 && kill(p->getPid(), 0) == 0) {
        return true;
      }

      int error = errno;
      return error == EPERM;
    }

    return false;
  }

  void stop() {
    KJ_IF_MAYBE(p, process) {
      if (p->isRunning()) {
        auto pid = p->getPid();
        KJ_LOG(WARNING, "Stopping isolate sidecar process group.", pid);
        signalProcessGroup(pid, SIGTERM);

        for (uint elapsed = 0; elapsed < SIDECAR_SHUTDOWN_TIMEOUT_MS;
             elapsed += SIDECAR_READY_POLL_MS) {
          if (!isRunning()) {
            process = nullptr;
            return;
          }
          sleepMillis(SIDECAR_READY_POLL_MS);
        }

        KJ_LOG(WARNING, "Killing isolate sidecar process group after shutdown timeout.", pid);
        signalProcessGroup(pid, SIGKILL);
      }
      process = nullptr;
    }
  }

private:
  kj::Maybe<Subprocess> process;

  static void signalProcessGroup(pid_t pid, int signo) {
    if (kill(-pid, signo) != 0) {
      int error = errno;
      if (error == ESRCH) {
        return;
      }

      KJ_SYSCALL(kill(pid, signo), pid, signo);
    }
  }

  static void logExitStatus(int status) {
    if (WIFEXITED(status)) {
      KJ_LOG(WARNING, "Isolate sidecar process exited.", WEXITSTATUS(status));
    } else if (WIFSIGNALED(status)) {
      KJ_LOG(WARNING, "Isolate sidecar process was killed.", WTERMSIG(status));
    } else {
      KJ_LOG(WARNING, "Isolate sidecar process stopped unexpectedly.", status);
    }
  }

  static bool appendPlaceholder(
      kj::Vector<char>& result, kj::StringPtr input, size_t& pos, kj::StringPtr token,
      kj::StringPtr value) {
    if (!input.slice(pos, input.size()).startsWith(token)) {
      return false;
    }

    result.addAll(value);
    pos += token.size();
    return true;
  }

  static kj::String expandSidecarPlaceholders(
      kj::StringPtr input, IsolateRuntimeConfig& runtimeConfig) {
    kj::Vector<char> result(input.size() + 1);
    size_t pos = 0;
    while (pos < input.size()) {
      if (appendPlaceholder(result, input, pos, "${SANDSTORM_ISOLATE_RUNTIME_DIR}",
          runtimeConfig.workerdBundleDir)) {
        continue;
      }
      if (appendPlaceholder(result, input, pos, "${SANDSTORM_ISOLATE_WORKERD_CONFIG}",
          runtimeConfig.workerdConfigPath)) {
        continue;
      }
      if (appendPlaceholder(result, input, pos, "${SANDSTORM_ISOLATE_RUNTIME_MANIFEST}",
          kj::str(runtimeConfig.workerdBundleDir, "/runtime-manifest.json"))) {
        continue;
      }
      if (appendPlaceholder(result, input, pos, "${SANDSTORM_ISOLATE_SOCKET}",
          runtimeConfig.workerdSocketPath)) {
        continue;
      }
      if (appendPlaceholder(result, input, pos, "${SANDSTORM_ISOLATE_MAIN_MODULE}",
          runtimeConfig.mainModule)) {
        continue;
      }
      if (appendPlaceholder(result, input, pos, "${SANDSTORM_ISOLATE_COMPATIBILITY_DATE}",
          runtimeConfig.compatibilityDate)) {
        continue;
      }

      result.add(input[pos]);
      ++pos;
    }

    result.add('\0');
    return kj::String(result.releaseAsArray());
  }

  static kj::Array<kj::String> makeSidecarEnvironment(
      kj::ArrayPtr<const kj::String> environment,
      IsolateRuntimeConfig& runtimeConfig) {
    if (environment.size() > 0) {
      KJ_LOG(WARNING, "Ignoring package-provided isolate sidecar environment.",
          environment.size());
    }

    kj::Vector<kj::String> result(6);
    result.add(kj::str("SANDSTORM_ISOLATE_RUNTIME_DIR=", runtimeConfig.workerdBundleDir));
    result.add(kj::str("SANDSTORM_ISOLATE_WORKERD_CONFIG=", runtimeConfig.workerdConfigPath));
    result.add(kj::str("SANDSTORM_ISOLATE_RUNTIME_MANIFEST=",
        runtimeConfig.workerdBundleDir, "/runtime-manifest.json"));
    result.add(kj::str("SANDSTORM_ISOLATE_SOCKET=", runtimeConfig.workerdSocketPath));
    result.add(kj::str("SANDSTORM_ISOLATE_MAIN_MODULE=", runtimeConfig.mainModule));
    result.add(kj::str("SANDSTORM_ISOLATE_COMPATIBILITY_DATE=",
        runtimeConfig.compatibilityDate));
    return result.releaseAsArray();
  }
};

bool isSocketReady(kj::StringPtr path) {
  struct stat statbuf;
  if (stat(path.cStr(), &statbuf) != 0) {
    int error = errno;
    if (error == ENOENT || error == ENOTDIR) {
      return false;
    }

    KJ_FAIL_SYSCALL("stat", error, path);
  }

  return S_ISSOCK(statbuf.st_mode);
}

void sleepMillis(uint millis) {
  struct timespec request;
  request.tv_sec = millis / 1000;
  request.tv_nsec = (millis % 1000) * 1000 * 1000;

  while (nanosleep(&request, &request) != 0) {
    int error = errno;
    if (error != EINTR) {
      KJ_FAIL_SYSCALL("nanosleep", error);
    }
  }
}

kj::String dirname(kj::StringPtr path) {
  KJ_IF_MAYBE(slash, path.findLast('/')) {
    if (*slash == 0) {
      return kj::heapString("/");
    } else {
      return kj::heapString(path.slice(0, *slash));
    }
  } else {
    return kj::heapString(".");
  }
}

kj::String currentExecutablePath() {
  char buffer[PATH_MAX + 1];
  ssize_t n;
  KJ_SYSCALL(n = readlink("/proc/self/exe", buffer, PATH_MAX), "/proc/self/exe");
  KJ_REQUIRE(n < PATH_MAX, "/proc/self/exe path too long");
  buffer[n] = '\0';
  return kj::heapString(buffer);
}

kj::String trustedWorkerdExecutablePath() {
  auto exePath = currentExecutablePath();
  auto exeDir = dirname(exePath);

  auto sibling = kj::str(exeDir, "/workerd");
  if (exeDir == "/") {
    sibling = kj::heapString("/workerd");
  }
  if (access(sibling.cStr(), X_OK) == 0) {
    return sibling;
  }

  auto bundled = kj::str(exeDir, "/bin/workerd");
  if (exeDir == "/") {
    bundled = kj::heapString("/bin/workerd");
  }
  if (access(bundled.cStr(), X_OK) == 0) {
    return bundled;
  }

  KJ_FAIL_REQUIRE("Could not find bundled workerd executable next to sandstorm binary.",
      exePath, sibling, bundled);
}

void requireAllowedSidecarCommand(
    kj::ArrayPtr<const kj::String> argvStrings, IsolateRuntimeConfig& runtimeConfig) {
  KJ_REQUIRE(argvStrings.size() == 4 &&
      argvStrings[0] == "workerd" &&
      argvStrings[1] == "serve" &&
      argvStrings[2] == runtimeConfig.workerdConfigPath &&
      argvStrings[3] == "sandstormConfig",
      "Isolate sidecar command is not allowlisted. Use: workerd serve "
      "${SANDSTORM_ISOLATE_WORKERD_CONFIG} sandstormConfig");
}

void resetSignalHandlersForExec() {
  for (uint i = 0; i < NSIG; i++) {
    ::signal(i, SIG_DFL);
  }

  sigset_t sigmask;
  sigemptyset(&sigmask);
  KJ_SYSCALL(sigprocmask(SIG_SETMASK, &sigmask, nullptr));
}

void setupSidecarParentDeathSignal() {
  KJ_SYSCALL(prctl(PR_SET_PDEATHSIG, SIGTERM));
  if (getppid() == 1) {
    _exit(1);
  }
}

void setupSidecarProcessGroup() {
  KJ_SYSCALL(setpgid(0, 0));
}

void setupSidecarStdio() {
  auto devNullIn = raiiOpen("/dev/null", O_RDONLY | O_CLOEXEC);
  auto devNullOut = raiiOpen("/dev/null", O_WRONLY | O_CLOEXEC);
  KJ_SYSCALL(dup2(devNullIn, STDIN_FILENO));
  KJ_SYSCALL(dup2(devNullOut, STDOUT_FILENO));
}

void closeUnexpectedSidecarFds() {
  kj::Vector<int> fds;
  DIR* dir = opendir("/proc/self/fd");
  if (dir == nullptr) {
    KJ_FAIL_SYSCALL("opendir(/proc/self/fd)", errno);
  }
  KJ_DEFER(KJ_SYSCALL(closedir(dir)) { break; });

  for (;;) {
    errno = 0;
    auto entry = readdir(dir);
    if (entry == nullptr) {
      if (errno != 0) {
        KJ_FAIL_SYSCALL("readdir(/proc/self/fd)", errno);
      }
      break;
    }

    if (entry->d_name[0] != '.') {
      char* end;
      int fd = strtoul(entry->d_name, &end, 10);
      if (*end == '\0' && end > entry->d_name && fd > STDERR_FILENO && fd != dirfd(dir)) {
        fds.add(fd);
      }
    }
  }

  for (auto fd: fds) {
    close(fd);
  }
}

void setupSidecarResourceLimits() {
  struct rlimit nofile;
  memset(&nofile, 0, sizeof(nofile));
  nofile.rlim_cur = 1024;
  nofile.rlim_max = 4096;
  KJ_SYSCALL(setrlimit(RLIMIT_NOFILE, &nofile));

  struct rlimit core;
  memset(&core, 0, sizeof(core));
  KJ_SYSCALL(setrlimit(RLIMIT_CORE, &core));
}

void finishSidecarNamespaceSetup() {
  KJ_SYSCALL(mount("none", "/", nullptr, MS_REC | MS_PRIVATE, nullptr));
  KJ_SYSCALL(sethostname("sandbox", 7));
  KJ_SYSCALL(setdomainname("sandbox", 7));
}

void sidecarBind(kj::StringPtr src, kj::StringPtr dst, unsigned long flags) {
  KJ_SYSCALL(mount(src.cStr(), dst.cStr(), nullptr, MS_BIND | MS_REC, nullptr), src, dst);
  KJ_SYSCALL(mount(src.cStr(), dst.cStr(), nullptr,
      MS_BIND | MS_REC | MS_REMOUNT | flags, nullptr), src, dst);
}

kj::String sidecarRootPath(kj::StringPtr absolutePath) {
  KJ_REQUIRE(absolutePath.startsWith("/"), "Expected absolute sidecar path.", absolutePath);
  if (absolutePath == "/") {
    return kj::heapString("/tmp");
  } else {
    return kj::str("/tmp", absolutePath);
  }
}

void ensureSidecarDirectory(kj::StringPtr path, mode_t mode = 0755) {
  if (mkdir(path.cStr(), mode) != 0) {
    int error = errno;
    if (error != EEXIST) {
      KJ_FAIL_SYSCALL("mkdir", error, path);
    }
  }
}

void bindSidecarDirectory(kj::StringPtr src, unsigned long flags) {
  if (access(src.cStr(), F_OK) != 0) {
    int error = errno;
    if (error == ENOENT || error == ENOTDIR) {
      return;
    }
    KJ_FAIL_SYSCALL("access", error, src);
  }

  auto dst = sidecarRootPath(src);
  recursivelyCreateParent(dst);
  ensureSidecarDirectory(dst);
  sidecarBind(src, dst, flags);
}

void bindSidecarFile(kj::StringPtr src, unsigned long flags, mode_t mode = 0644) {
  if (access(src.cStr(), F_OK) != 0) {
    int error = errno;
    if (error == ENOENT || error == ENOTDIR) {
      return;
    }
    KJ_FAIL_SYSCALL("access", error, src);
  }

  auto dst = sidecarRootPath(src);
  recursivelyCreateParent(dst);
  KJ_SYSCALL(mknod(dst.cStr(), S_IFREG | mode, 0), dst);
  sidecarBind(src, dst, flags);
}

void bindSidecarRuntimeLibraryFile(kj::StringPtr src) {
  bindSidecarFile(src, MS_RDONLY | MS_NOSUID | MS_NODEV, 0755);
}

void bindSidecarRuntimeLibraryCandidates(kj::StringPtr name) {
  bindSidecarRuntimeLibraryFile(kj::str("/lib/", name));
  bindSidecarRuntimeLibraryFile(kj::str("/lib64/", name));
  bindSidecarRuntimeLibraryFile(kj::str("/usr/lib/", name));
  bindSidecarRuntimeLibraryFile(kj::str("/usr/lib64/", name));
  bindSidecarRuntimeLibraryFile(kj::str("/lib/x86_64-linux-gnu/", name));
  bindSidecarRuntimeLibraryFile(kj::str("/usr/lib/x86_64-linux-gnu/", name));
}

void bindSidecarRuntimeLibraries() {
  bindSidecarRuntimeLibraryFile("/lib64/ld-linux-x86-64.so.2");
  bindSidecarRuntimeLibraryFile("/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2");

  bindSidecarRuntimeLibraryCandidates("libc.so.6");
  bindSidecarRuntimeLibraryCandidates("libm.so.6");

  // These are not needed by the current npm workerd build on all distros, but
  // are common C/C++ runtime dependencies. Keep this list file-based rather
  // than mounting whole library directories.
  bindSidecarRuntimeLibraryCandidates("libdl.so.2");
  bindSidecarRuntimeLibraryCandidates("libpthread.so.0");
  bindSidecarRuntimeLibraryCandidates("librt.so.1");
  bindSidecarRuntimeLibraryCandidates("libstdc++.so.6");
  bindSidecarRuntimeLibraryCandidates("libgcc_s.so.1");
}

void setupSidecarMountRoot(kj::StringPtr trustedWorkerd, kj::StringPtr workerdBundleDir) {
  auto oldUmask = umask(0);
  KJ_DEFER(umask(oldUmask));

  KJ_SYSCALL(mount("sandstorm-isolate-sidecar-root", "/tmp", "tmpfs",
      MS_NOSUID | MS_NODEV, "size=64m,nr_inodes=4096,mode=755"));

  ensureSidecarDirectory("/tmp/tmp", 0777);
  ensureSidecarDirectory("/tmp/dev", 0755);
  KJ_SYSCALL(mount("sandstorm-isolate-sidecar-dev", "/tmp/dev", "tmpfs",
      MS_NOATIME | MS_NOSUID | MS_NOEXEC, "size=1m,nr_inodes=16,mode=755"));
  bindSidecarFile("/dev/null", MS_NOSUID | MS_NOEXEC);
  bindSidecarFile("/dev/zero", MS_NOSUID | MS_NOEXEC);
  bindSidecarFile("/dev/random", MS_NOSUID | MS_NOEXEC);
  bindSidecarFile("/dev/urandom", MS_NOSUID | MS_NOEXEC);
  KJ_SYSCALL(mount("/tmp/dev", "/tmp/dev", nullptr,
      MS_BIND | MS_REMOUNT | MS_RDONLY | MS_NOSUID | MS_NOEXEC, nullptr));

  bindSidecarDirectory(workerdBundleDir, MS_NOSUID | MS_NODEV);
  bindSidecarFile(trustedWorkerd, MS_RDONLY | MS_NOSUID | MS_NODEV, 0755);
  bindSidecarRuntimeLibraries();
  bindSidecarFile("/etc/ld.so.cache", MS_RDONLY | MS_NOSUID | MS_NOEXEC | MS_NODEV);

  KJ_SYSCALL(chroot("/tmp"));
  KJ_SYSCALL(chdir("/"));
  KJ_LOG(WARNING, "Isolate sidecar entered minimal mount root.",
      trustedWorkerd, workerdBundleDir);
}

bool trySetupSidecarNamespaces(kj::Maybe<uid_t> sandboxUid) {
  KJ_IF_MAYBE(u, sandboxUid) {
    if (unshare(CLONE_NEWNET | CLONE_NEWNS | CLONE_NEWIPC | CLONE_NEWUTS) < 0) {
      int error = errno;
      KJ_FAIL_SYSCALL("unshare(CLONE_NEWNET | CLONE_NEWNS | CLONE_NEWIPC | CLONE_NEWUTS)",
          error);
    } else {
      finishSidecarNamespaceSetup();
      KJ_LOG(WARNING, "Isolate sidecar entered private network/mount/ipc/uts namespaces.");
      return true;
    }
  }

  uid_t realUid = getuid();
  gid_t realGid = getgid();

  if (unshare(CLONE_NEWUSER | CLONE_NEWNET | CLONE_NEWNS | CLONE_NEWIPC | CLONE_NEWUTS) < 0) {
    int error = errno;
    KJ_FAIL_SYSCALL(
        "unshare(CLONE_NEWUSER | CLONE_NEWNET | CLONE_NEWNS | CLONE_NEWIPC | CLONE_NEWUTS)",
        error);
  }

  sandbox::hideUserGroupIds(realUid, realGid, false);
  finishSidecarNamespaceSetup();
  KJ_LOG(WARNING, "Isolate sidecar entered private user/network/mount/ipc/uts namespaces.");
  return true;
}

void setupSidecarSeccomp(bool logSeccompViolations) {
  scmp_filter_ctx ctx = seccomp_init(SCMP_ACT_ERRNO(ENOSYS));
  if (ctx == nullptr) {
    KJ_FAIL_SYSCALL("seccomp_init", 0);
  }
  KJ_DEFER(seccomp_release(ctx));

#define CHECK_SECCOMP(call)                   \
  do {                                        \
    if (auto result = (call)) {               \
      KJ_FAIL_SYSCALL(#call, -result);        \
    }                                         \
  } while (0)

  CHECK_SECCOMP(seccomp_attr_set(ctx, SCMP_FLTATR_CTL_NNP, 1));
  CHECK_SECCOMP(seccomp_attr_set(ctx, SCMP_FLTATR_ACT_BADARCH, SCMP_ACT_ERRNO(ENOSYS)));
  if (logSeccompViolations) {
    CHECK_SECCOMP(seccomp_attr_set(ctx, SCMP_FLTATR_CTL_LOG, 1));
  }

#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wmissing-field-initializers"
  // This allowlist is based on post-exec workerd traces from
  // `make isolate-supervisor-syscall-trace`. Calls used only while setting up
  // namespaces, mounts, credential drops, or seccomp itself intentionally stay
  // unavailable after the filter is loaded.
  int allowedSyscalls[] = {
    SCMP_SYS(accept4),
    SCMP_SYS(access),
    SCMP_SYS(arch_prctl),
    SCMP_SYS(bind),
    SCMP_SYS(brk),
    SCMP_SYS(clock_nanosleep),
    SCMP_SYS(close),
    SCMP_SYS(connect),
    SCMP_SYS(dup),
    SCMP_SYS(dup2),
    SCMP_SYS(epoll_create1),
    SCMP_SYS(epoll_ctl),
    SCMP_SYS(epoll_pwait),
    SCMP_SYS(epoll_wait),
    SCMP_SYS(eventfd2),
    SCMP_SYS(execve),
    SCMP_SYS(exit),
    SCMP_SYS(exit_group),
    SCMP_SYS(fcntl),
    SCMP_SYS(fstat),
    SCMP_SYS(futex),
    SCMP_SYS(getcwd),
    SCMP_SYS(getpid),
    SCMP_SYS(getrandom),
    SCMP_SYS(getsockopt),
    SCMP_SYS(gettid),
    SCMP_SYS(ioctl),
    SCMP_SYS(listen),
    SCMP_SYS(lseek),
    SCMP_SYS(madvise),
    SCMP_SYS(mmap),
    SCMP_SYS(mprotect),
    SCMP_SYS(munmap),
    SCMP_SYS(newfstatat),
    SCMP_SYS(openat),
    SCMP_SYS(pkey_alloc),
    SCMP_SYS(poll),
    SCMP_SYS(pread64),
    SCMP_SYS(prlimit64),
    SCMP_SYS(read),
    SCMP_SYS(readlink),
    SCMP_SYS(readlinkat),
    SCMP_SYS(readv),
    SCMP_SYS(rt_sigaction),
    SCMP_SYS(rt_sigprocmask),
    SCMP_SYS(rt_sigreturn),
    SCMP_SYS(sched_getaffinity),
    SCMP_SYS(sched_getparam),
    SCMP_SYS(sched_getscheduler),
    SCMP_SYS(set_tid_address),
    SCMP_SYS(setsockopt),
    SCMP_SYS(sigaltstack),
    SCMP_SYS(umask),
    SCMP_SYS(uname),
    SCMP_SYS(write),
    SCMP_SYS(writev),
  };

  for (auto syscall: allowedSyscalls) {
    CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ALLOW, syscall, 0));
  }

  // Do not allow clone3(): libseccomp cannot inspect the pointed-to clone_args
  // flags. Returning ENOSYS makes glibc fall back to clone(), where we can at
  // least reject namespace-creating flags.
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(clone), 1,
      SCMP_A0(SCMP_CMP_MASKED_EQ,
          CLONE_NEWNS | CLONE_NEWUTS | CLONE_NEWIPC | CLONE_NEWUSER |
          CLONE_NEWPID | CLONE_NEWNET, 0)));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(prctl), 1,
      SCMP_A0(SCMP_CMP_EQ, PR_SET_NAME)));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(prctl), 1,
      SCMP_A0(SCMP_CMP_EQ, PR_SET_VMA)));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(socket), 1,
      SCMP_A0(SCMP_CMP_EQ, AF_UNIX)));

  CHECK_SECCOMP(seccomp_load(ctx));
#pragma GCC diagnostic pop
#undef CHECK_SECCOMP
}

int runConfinedWorkerdSidecar(
    kj::Array<kj::String> argvStrings,
    kj::Array<kj::String> environment,
    kj::String trustedWorkerd,
    kj::String workerdBundleDir,
    kj::Maybe<uid_t> sandboxUid,
    bool logSeccompViolations) {
  resetSignalHandlersForExec();
  setupSidecarParentDeathSignal();
  setupSidecarProcessGroup();
  setupSidecarStdio();
  closeUnexpectedSidecarFds();
  bool hasPrivateNamespaces = trySetupSidecarNamespaces(sandboxUid);
  if (hasPrivateNamespaces) {
    setupSidecarMountRoot(trustedWorkerd, workerdBundleDir);
  }
  KJ_IF_MAYBE(u, sandboxUid) {
    KJ_SYSCALL(setresuid(*u, *u, *u));
  }
  setupSidecarResourceLimits();
  KJ_SYSCALL(prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0));
  setupSidecarSeccomp(logSeccompViolations);

  KJ_STACK_ARRAY(char*, argv, argvStrings.size() + 1, 16, 64);
  for (auto i: kj::indices(argvStrings)) {
    argv[i] = const_cast<char*>(argvStrings[i].cStr());
  }
  argv[argvStrings.size()] = nullptr;

  KJ_STACK_ARRAY(char*, envp, environment.size() + 1, 16, 64);
  for (auto i: kj::indices(environment)) {
    envp[i] = const_cast<char*>(environment[i].cStr());
  }
  envp[environment.size()] = nullptr;

  KJ_SYSCALL(execve(trustedWorkerd.cStr(), argv.begin(), envp.begin()), trustedWorkerd);
  KJ_UNREACHABLE;
}

void waitForSidecarSocket(WorkerdSidecarProcess& sidecar, IsolateRuntimeConfig& runtimeConfig) {
  if (!sidecar.isConfigured()) {
    return;
  }

  for (uint elapsed = 0; elapsed <= SIDECAR_READY_TIMEOUT_MS;
       elapsed += SIDECAR_READY_POLL_MS) {
    if (isSocketReady(runtimeConfig.workerdSocketPath)) {
      KJ_LOG(WARNING, "Isolate sidecar socket is ready.", runtimeConfig.workerdSocketPath);
      return;
    }

    KJ_REQUIRE(sidecar.isRunning(), "Isolate sidecar exited before its socket was ready.",
        runtimeConfig.workerdSocketPath);
    sleepMillis(SIDECAR_READY_POLL_MS);
  }

  KJ_FAIL_REQUIRE("Timed out waiting for isolate sidecar socket.",
      runtimeConfig.workerdSocketPath);
}

kj::StringPtr urlPath(kj::StringPtr url) {
  KJ_IF_MAYBE(query, url.findFirst('?')) {
    return kj::StringPtr(url.begin(), *query);
  }

  return url;
}

kj::Array<kj::String> findIsolateRawQueryParams(kj::StringPtr url, kj::StringPtr name) {
  kj::Vector<kj::String> results;
  KJ_IF_MAYBE(queryStart, url.findFirst('?')) {
    auto query = url.slice(*queryStart + 1, url.size());
    KJ_IF_MAYBE(fragment, query.findFirst('#')) {
      query = query.slice(0, *fragment);
    }

    size_t start = 0;
    while (start <= query.size()) {
      size_t end = query.size();
      KJ_IF_MAYBE(amp, query.slice(start, query.size()).findFirst('&')) {
        end = start + *amp;
      }

      if (end > start) {
        auto part = query.slice(start, end);
        KJ_IF_MAYBE(eq, part.findFirst('=')) {
          auto paramName = decodeIsolateQueryComponent(kj::StringPtr(part.begin(), *eq));
          if (paramName == name) {
            results.add(decodeIsolateQueryComponent(
                kj::StringPtr(part.begin() + *eq + 1, part.size() - *eq - 1)));
          }
        }
      }

      if (end == query.size()) {
        break;
      }
      start = end + 1;
    }
  }

  return results.releaseAsArray();
}

class SandstormApiBindingService final: public kj::HttpService {
public:
  SandstormApiBindingService(
      kj::HttpHeaderTable& headerTable, IsolateRuntimeConfig& config, IsolateRuntimeHost& host,
      bool powerboxOnly = false)
      : headerTable(headerTable), config(config), host(host), powerboxOnly(powerboxOnly) {}

  kj::Promise<void> request(
      kj::HttpMethod method, kj::StringPtr url, const kj::HttpHeaders& headers,
      kj::AsyncInputStream& requestBody, kj::HttpService::Response& response) override {
    auto methodName = kj::str(method);
    auto path = kj::heapString(url);
    auto route = kj::heapString(urlPath(url));
    auto contentType = kj::heapString("application/octet-stream");
    KJ_IF_MAYBE(value, headers.get(kj::HttpHeaderId::CONTENT_TYPE)) {
      contentType = kj::str(*value);
    }
    auto accept = kj::heapString("");
    headers.forEach([&](kj::StringPtr name, kj::StringPtr value) {
      auto lowerName = kj::str(name);
      toLower(lowerName);
      if (lowerName == "accept") {
        accept = kj::str(value);
      }
    });
    KJ_LOG(WARNING, "Isolate Sandstorm API binding received request.", methodName, path);

    kj::Vector<FetchHeader> outboundHeaderValues;
    if (methodName == "POST" && route == "/powerbox/outbound-http-fetch") {
      headers.forEach([&](kj::StringPtr name, kj::StringPtr value) {
        auto lowerName = kj::str(name);
        toLower(lowerName);
        if (lowerName.startsWith("x-sandstorm-outbound-header-")) {
          outboundHeaderValues.add(FetchHeader { kj::mv(lowerName), kj::heapString(value) });
        }
      });
    }

    auto isLargePowerboxBody = methodName == "POST" &&
        (route == "/powerbox/fetch" || route == "/powerbox/outbound-http-fetch");
    auto maxBodyBytes = isLargePowerboxBody
        ? MAX_SIDECAR_REQUEST_BYTES
        : MAX_API_BINDING_REQUEST_BYTES;
    auto maxBodyDescription = isLargePowerboxBody
        ? "claimed capability fetch request body exceeds maximum allowed size"
        : "isolate Sandstorm API binding request body exceeds maximum allowed size";

    return readAllBytesAtMost(requestBody, maxBodyBytes, maxBodyDescription).then(
        [this, methodName = kj::mv(methodName), path = kj::mv(path), route = kj::mv(route),
            contentType = kj::mv(contentType), accept = kj::mv(accept),
            outboundHeaderValues = outboundHeaderValues.releaseAsArray(), &response]
        (kj::Array<byte>&& bodyBytes) mutable {
      if (powerboxOnly && !route.startsWith("/powerbox/")) {
        return sendJson(response, 404, "Not Found", kj::heapString(
            "{\n  \"ok\": false,\n"
            "  \"error\": \"unknown Powerbox binding endpoint\"\n}\n"));
      } else if (methodName == "POST" && route == "/powerbox/claim-request") {
        return claimPowerboxRequest(path, response);
      } else if (methodName == "POST" && route == "/powerbox/save") {
        return savePowerboxCapability(path, response);
      } else if (methodName == "POST" && route == "/powerbox/restore") {
        return restorePowerboxCapability(path, response);
      } else if (methodName == "POST" && route == "/powerbox/dup") {
        return duplicatePowerboxCapability(path, response);
      } else if (methodName == "POST" && route == "/powerbox/drop-saved") {
        return dropSavedPowerboxCapability(path, response);
      } else if (methodName == "POST" && route == "/powerbox/drop") {
        return dropPowerboxCapability(path, response);
      } else if (methodName == "POST" && route == "/powerbox/fetch") {
        return fetchClaimedCapability(path, contentType, kj::mv(bodyBytes), response);
      } else if (methodName == "POST" && route == "/powerbox/outbound-http-fetch") {
        return fetchOutboundHttpCapability(
            path, kj::mv(outboundHeaderValues), kj::mv(bodyBytes), response);
      } else if (methodName == "POST" && route == "/powerbox/native-app-rpc-call") {
        return callWorkerAppObjectCapability(path, kj::mv(bodyBytes), response);
      } else if (methodName == "POST" && route == "/capnp/call") {
        return callNativeCapnpBridge(
            kj::mv(bodyBytes), response, accept == "application/octet-stream");
      } else if (methodName == "POST" && route == "/powerbox/offer") {
        return offerClaimedCapability(path, response);
      } else if (methodName == "POST" && route == "/powerbox/fulfill-request") {
        return fulfillRequestWithCapability(path, response);
      } else if (methodName == "POST" && route == "/powerbox/tie-to-user") {
        return tieClaimedCapabilityToUser(path, response);
      } else if (methodName == "POST" && route == "/capabilities/web-session") {
        return createRouteBackedCapability(path, response, RouteBackedCapabilityType::WEB);
      } else if (methodName == "POST" && route == "/capabilities/api-session") {
        return createRouteBackedCapability(path, response, RouteBackedCapabilityType::API);
      } else if (methodName == "POST" && route == "/capabilities/app-object") {
        return createRouteBackedCapability(path, response, RouteBackedCapabilityType::OBJECT);
      }

      if (methodName != "GET") {
        return sendJson(response, 405, "Method Not Allowed", kj::heapString(
            "{\n  \"ok\": false,\n  \"error\": \"method not allowed\"\n}\n"));
      }

      if (route == "/" || route == "/status") {
        return sendJson(response, 200, "OK", renderStatus(methodName, path, bodyBytes.size()));
      } else if (route == "/powerbox/api-session-descriptor") {
        return apiSessionPowerboxDescriptor(path, response);
      } else if (route == "/powerbox/outbound-http-descriptor") {
        return outboundHttpPowerboxDescriptor(path, response);
      } else if (route == "/capabilities") {
        return sendJson(response, 200, "OK", renderCapabilities());
      } else if (route == "/capabilities/claimed") {
        return claimedCapabilityInfo(path, response);
      } else if (route == "/capabilities/claimed-stats") {
        return sendJson(response, 200, "OK", renderClaimedCapabilityStats());
      } else if (route == "/runtime") {
        return sendJson(response, 200, "OK", renderRuntime());
      } else if (route == "/modules") {
        return sendJson(response, 200, "OK", renderModules());
      } else if (route == "/bindings") {
        return sendJson(response, 200, "OK", renderBindings());
      } else if (route == "/capnp/bridge-info") {
        return sendJson(response, 200, "OK", renderCapnpBridgeInfo());
      } else if (route == "/permissions") {
        return sendJson(response, 200, "OK", renderPermissions());
      } else {
        return sendJson(response, 404, "Not Found", kj::heapString(
            "{\n  \"ok\": false,\n  \"error\": \"unknown Sandstorm API binding endpoint\"\n}\n"));
      }
    });
  }

private:
  struct CapabilityFetchContextParams {
    kj::Vector<FetchHeader> additionalHeaders;
    kj::Maybe<kj::String> ifMatch;
    kj::Maybe<kj::String> ifNoneMatch;
  };

  kj::HttpHeaderTable& headerTable;
  IsolateRuntimeConfig& config;
  IsolateRuntimeHost& host;
  bool powerboxOnly;

  kj::Maybe<kj::String> readSingleNonEmptyQueryParam(kj::StringPtr url, kj::StringPtr name,
      kj::StringPtr errorMessage, kj::String& output) {
    auto values = findIsolateQueryParams(url, name);
    if (values.size() != 1 || values[0].size() == 0) {
      return kj::str(errorMessage);
    }

    output = kj::mv(values[0]);
    return nullptr;
  }

  kj::Maybe<kj::String> readAtMostOneQueryParam(kj::StringPtr url, kj::StringPtr name,
      kj::StringPtr errorMessage, kj::Array<kj::String>& output) {
    auto values = findIsolateQueryParams(url, name);
    if (values.size() > 1) {
      return kj::str(errorMessage);
    }

    output = kj::mv(values);
    return nullptr;
  }

  kj::Promise<void> sendBadRequest(
      kj::HttpService::Response& response, kj::StringPtr errorMessage) {
    return sendJson(response, 400, "Bad Request", renderError(errorMessage));
  }

  class NoStreamingByteStream final: public ByteStream::Server {
  public:
    kj::Promise<void> write(WriteContext context) override {
      KJ_FAIL_REQUIRE("claimed capability response stream was not expected");
    }

    kj::Promise<void> done(DoneContext context) override {
      KJ_FAIL_REQUIRE("claimed capability response stream was not expected");
    }

    kj::Promise<void> expectSize(ExpectSizeContext context) override {
      KJ_FAIL_REQUIRE("claimed capability response stream was not expected");
    }
  };

  class HttpResponseByteStream final: public ByteStream::Server {
  public:
    HttpResponseByteStream(uint statusCode, kj::StringPtr statusText,
        kj::HttpHeaders&& headers, kj::HttpService::Response& response) {
      state.init<NotStarted>(NotStarted { statusCode, statusText, kj::mv(headers), response });
    }

    ~HttpResponseByteStream() noexcept(false) {
      KJ_IF_MAYBE(fulfiller, doneFulfiller) {
        if ((*fulfiller)->isWaiting()) {
          (*fulfiller)->reject(KJ_EXCEPTION(FAILED,
              "claimed capability did not finish writing response stream"));
        }
      }
    }

    kj::Promise<void> write(WriteContext context) override {
      auto data = kj::heapArray<byte>(context.getParams().getData());
      auto fork = queue.then([this, data = kj::mv(data)]() mutable {
        auto& stream = ensureStarted(nullptr);
        auto promise = stream.write(data.begin(), data.size());
        return promise.attach(kj::mv(data));
      }).fork();
      queue = fork.addBranch();
      return fork.addBranch();
    }

    kj::Promise<void> done(DoneContext context) override {
      (void)context;
      auto fork = queue.then([this]() {
        ensureStarted(uint64_t(0));
        state.init<Done>();
        KJ_IF_MAYBE(fulfiller, doneFulfiller) {
          (*fulfiller)->fulfill();
          doneFulfiller = nullptr;
        }
      }).fork();
      queue = fork.addBranch();
      return fork.addBranch();
    }

    kj::Promise<void> expectSize(ExpectSizeContext context) override {
      ensureStarted(context.getParams().getSize());
      return kj::READY_NOW;
    }

    kj::Promise<void> whenDone() {
      auto paf = kj::newPromiseAndFulfiller<void>();
      doneFulfiller = kj::mv(paf.fulfiller);
      return kj::mv(paf.promise);
    }

  private:
    struct NotStarted {
      uint statusCode;
      kj::StringPtr statusText;
      kj::HttpHeaders headers;
      kj::HttpService::Response& response;
    };

    struct Started {
      kj::Own<kj::AsyncOutputStream> output;
    };

    struct Done {};

    kj::OneOf<NotStarted, Started, Done> state;
    kj::Maybe<kj::Own<kj::PromiseFulfiller<void>>> doneFulfiller;
    kj::Promise<void> queue = kj::READY_NOW;

    kj::AsyncOutputStream& ensureStarted(kj::Maybe<uint64_t> size) {
      if (state.is<NotStarted>()) {
        auto& pending = state.get<NotStarted>();
        auto stream = pending.response.send(
            pending.statusCode, pending.statusText, pending.headers, size);
        kj::AsyncOutputStream& ref = *stream;
        state.init<Started>(Started { kj::mv(stream) });
        return ref;
      }

      KJ_REQUIRE(!state.is<Done>(), "already called done()");
      return *state.get<Started>().output;
    }
  };

  class BufferedByteStream final: public ByteStream::Server {
  public:
    explicit BufferedByteStream(kj::StringPtr description)
        : description(kj::heapString(description)) {
      auto paf = kj::newPromiseAndFulfiller<kj::Array<byte>>();
      donePromise = kj::mv(paf.promise);
      doneFulfiller = kj::mv(paf.fulfiller);
    }

    ~BufferedByteStream() noexcept(false) {
      KJ_IF_MAYBE(fulfiller, doneFulfiller) {
        if ((*fulfiller)->isWaiting()) {
          (*fulfiller)->reject(KJ_EXCEPTION(FAILED, description));
        }
      }
    }

    kj::Promise<void> write(WriteContext context) override {
      auto data = kj::heapArray<byte>(context.getParams().getData());
      auto fork = queue.then([this, data = kj::mv(data)]() mutable {
        KJ_REQUIRE(!isDone, "response body stream is already done");
        KJ_REQUIRE(data.size() <= MAX_SIDECAR_REQUEST_BYTES - body.size(),
            description, body.size() + data.size(), MAX_SIDECAR_REQUEST_BYTES);
        body.addAll(data);
      }).fork();
      queue = fork.addBranch();
      return fork.addBranch();
    }

    kj::Promise<void> done(DoneContext context) override {
      (void)context;
      auto fork = queue.then([this]() mutable {
        KJ_REQUIRE(!isDone, "response body stream is already done");
        KJ_IF_MAYBE(size, expectedSize) {
          KJ_REQUIRE(body.size() == *size, description, body.size(), *size);
        }
        isDone = true;
        auto data = body.releaseAsArray();
        KJ_ASSERT_NONNULL(doneFulfiller)->fulfill(kj::mv(data));
        doneFulfiller = nullptr;
      }).fork();
      queue = fork.addBranch();
      return fork.addBranch();
    }

    kj::Promise<void> expectSize(ExpectSizeContext context) override {
      auto size = context.getParams().getSize();
      KJ_REQUIRE(size <= MAX_SIDECAR_REQUEST_BYTES,
          description, size, MAX_SIDECAR_REQUEST_BYTES);
      expectedSize = size;
      return kj::READY_NOW;
    }

    kj::Promise<kj::Array<byte>> whenDone() {
      return kj::mv(KJ_ASSERT_NONNULL(donePromise));
    }

  private:
    kj::String description;
    kj::Vector<byte> body;
    kj::Maybe<uint64_t> expectedSize;
    kj::Maybe<kj::Promise<kj::Array<byte>>> donePromise;
    kj::Maybe<kj::Own<kj::PromiseFulfiller<kj::Array<byte>>>> doneFulfiller;
    kj::Promise<void> queue = kj::READY_NOW;
    bool isDone = false;
  };

  struct OutboundHttpFetchParams {
    kj::String id;
    OutboundHttpSession::Method method;
    kj::String path;
    kj::Vector<FetchHeader> headers;
  };

  struct CapabilityFetchContext {
    kj::Maybe<kj::Own<kj::PromiseFulfiller<ByteStream::Client>>> responseStreamFulfiller;
    bool sendNotModifiedForPrecondition = false;
  };

  void fulfillNoStreaming(CapabilityFetchContext& context) {
    KJ_IF_MAYBE(fulfiller, context.responseStreamFulfiller) {
      (*fulfiller)->fulfill(kj::heap<NoStreamingByteStream>());
      context.responseStreamFulfiller = nullptr;
    }
  }

  kj::Promise<void> sendJson(kj::HttpService::Response& response, uint statusCode,
      kj::StringPtr statusText, kj::String body) {
    kj::HttpHeaders responseHeaders(headerTable);
    responseHeaders.set(kj::HttpHeaderId::CONTENT_TYPE, "application/json; charset=utf-8");
    auto stream = response.send(statusCode, statusText, responseHeaders, body.size());
    auto promise = stream->write(body.begin(), body.size());
    return promise.attach(kj::mv(stream), kj::mv(body));
  }

  kj::Promise<void> sendBytes(kj::HttpService::Response& response, uint statusCode,
      kj::StringPtr statusText, kj::HttpHeaders headers, kj::Array<byte> body) {
    auto stream = response.send(statusCode, statusText, headers, body.size());
    auto promise = stream->write(body.begin(), body.size());
    return promise.attach(kj::mv(stream), kj::mv(headers), kj::mv(body));
  }

  kj::Promise<void> sendText(kj::HttpService::Response& response, uint statusCode,
      kj::StringPtr statusText, kj::HttpHeaders headers, kj::String body) {
    auto stream = response.send(statusCode, statusText, headers, body.size());
    auto promise = stream->write(body.begin(), body.size());
    return promise.attach(kj::mv(stream), kj::mv(headers), kj::mv(body));
  }

  kj::String renderStatus(kj::StringPtr methodName, kj::StringPtr path, size_t bodySize) {
      kj::Vector<char> json;
      json.addAll(kj::StringPtr("{\n  \"ok\": true,\n  \"binding\": \"sandstormApi\",\n  "));
      appendJsonField(json, "status", "prototype");
      json.addAll(kj::StringPtr(",\n  "));
      appendJsonField(json, "method", methodName);
      json.addAll(kj::StringPtr(",\n  "));
      appendJsonField(json, "path", path);
      json.addAll(kj::StringPtr(",\n  \"requestBodyBytes\": "));
      json.addAll(kj::str(bodySize));
      json.addAll(kj::StringPtr(",\n  "));
      appendJsonField(json, "mainModule", config.mainModule);
      json.addAll(kj::StringPtr("\n}\n"));
      json.add('\0');
      return kj::String(json.releaseAsArray());
  }

  kj::String renderCapabilities() {
    return kj::str(
        "{\n"
        "  \"ok\": true,\n"
        "  \"binding\": \"sandstormApi\",\n"
        "  \"capabilities\": [\"status\", \"capabilities\", \"runtime\", \"modules\", "
        "\"bindings\", \"permissions\", \"capnp.bridgeInfo\", \"capnp.call\", "
        "\"powerbox.claim\", \"powerbox.fetch\", "
        "\"powerbox.outboundHttpFetch\", \"powerbox.nativeAppRpcCall\", "
        "\"powerbox.apiSessionDescriptor\", \"powerbox.outboundHttpDescriptor\", "
        "\"powerbox.offer\", \"powerbox.fulfillRequest\", \"powerbox.tieToUser\", "
        "\"capabilities.webSession\", \"capabilities.apiSession\", "
        "\"capabilities.claimed\", \"capabilities.claimedStats\"]\n"
        "}\n");
  }

  kj::String renderCapnpBridgeInfo() {
    return kj::str(
        "{\n"
        "  \"ok\": true,\n"
        "  \"type\": \"capnpBridgeInfo\",\n"
        "  \"protocolVersion\": ", NATIVE_CAPNP_BRIDGE_PROTOCOL_VERSION, ",\n"
        "  \"minProtocolVersion\": ", NATIVE_CAPNP_BRIDGE_PROTOCOL_VERSION, ",\n"
        "  \"maxProtocolVersion\": ", NATIVE_CAPNP_BRIDGE_PROTOCOL_VERSION, ",\n"
        "  \"nativeTransport\": false,\n"
        "  \"nativeCalls\": false,\n"
        "  \"nativeExports\": false,\n"
        "  \"capabilitySlots\": false,\n"
        "  \"fallbackTransport\": \"appObjectRpc\"\n"
        "}\n");
  }

  kj::String renderNativeCapnpBridgeDisabled() {
    return kj::str(
        "{\n"
        "  \"ok\": false,\n"
        "  \"type\": \"nativeCapnpBridgeResponse\",\n"
        "  \"protocolVersion\": ", NATIVE_CAPNP_BRIDGE_PROTOCOL_VERSION, ",\n"
        "  \"error\": \"native Cap'n Proto bridge transport is not enabled\",\n"
        "  \"exception\": {\n"
        "    \"type\": \"unimplemented\",\n"
        "    \"reason\": \"native Cap'n Proto bridge transport is not enabled\",\n"
        "    \"trace\": \"\"\n"
        "  }\n"
        "}\n");
  }

  void appendNativeCapnpBridgeTargetJson(
      kj::Vector<char>& json, NativeCapnpCapabilitySlot::Reader target) {
    appendJsonField(json, "targetId", target.getId());
    json.addAll(kj::StringPtr(",\n    "));
    appendJsonField(json, "targetInterfaceId", kj::str("0x", kj::hex(target.getInterfaceId())));
    json.addAll(kj::StringPtr(",\n    "));
    appendJsonField(json, "targetInterfaceName", target.getInterfaceName());
  }

  kj::String renderNativeCapnpBridgeDisabled(NativeCapnpBridgeRequest::Reader request) {
    kj::Vector<char> json;
    json.addAll(kj::StringPtr(
        "{\n"
        "  \"ok\": false,\n"
        "  \"type\": \"nativeCapnpBridgeResponse\",\n"
        "  \"protocolVersion\": "));
    json.addAll(kj::str(NATIVE_CAPNP_BRIDGE_PROTOCOL_VERSION));
    json.addAll(kj::StringPtr(",\n"
        "  \"error\": \"native Cap'n Proto bridge transport is not enabled\",\n"
        "  \"request\": {\n"
        "    \"kind\": "));
    if (request.isCall()) {
      appendJsonString(json, "call");
    } else if (request.isDrop()) {
      appendJsonString(json, "drop");
    } else if (request.isSave()) {
      appendJsonString(json, "save");
    } else if (request.isRestore()) {
      appendJsonString(json, "restore");
    } else {
      appendJsonString(json, "unknown");
    }
    json.addAll(kj::StringPtr(",\n"
        "    \"protocolVersion\": "));
    json.addAll(kj::str(request.getProtocolVersion()));

    if (request.isCall()) {
      auto call = request.getCall();
      auto target = call.getTarget();
      auto params = call.getParams();
      json.addAll(kj::StringPtr(",\n    "));
      appendNativeCapnpBridgeTargetJson(json, target);
      json.addAll(kj::StringPtr(",\n    "));
      appendJsonField(json, "interfaceId", kj::str("0x", kj::hex(call.getInterfaceId())));
      json.addAll(kj::StringPtr(",\n    \"methodOrdinal\": "));
      json.addAll(kj::str(call.getMethodOrdinal()));
      json.addAll(kj::StringPtr(",\n    "));
      appendJsonField(json, "methodName", call.getMethodName());
      json.addAll(kj::StringPtr(",\n    \"paramsBytes\": "));
      json.addAll(kj::str(params.getMessage().size()));
      json.addAll(kj::StringPtr(",\n    \"capabilityCount\": "));
      json.addAll(kj::str(params.getCapabilities().size()));
    } else if (request.isDrop()) {
      auto drop = request.getDrop();
      json.addAll(kj::StringPtr(",\n    "));
      appendNativeCapnpBridgeTargetJson(json, drop.getTarget());
    } else if (request.isSave()) {
      auto save = request.getSave();
      json.addAll(kj::StringPtr(",\n    "));
      appendNativeCapnpBridgeTargetJson(json, save.getTarget());
    } else if (request.isRestore()) {
      auto restore = request.getRestore();
      json.addAll(kj::StringPtr(",\n    "));
      appendJsonField(json, "token", restore.getToken());
      json.addAll(kj::StringPtr(",\n    "));
      appendJsonField(json, "expectedInterfaceId",
          kj::str("0x", kj::hex(restore.getExpectedInterfaceId())));
      json.addAll(kj::StringPtr(",\n    "));
      appendJsonField(json, "expectedInterfaceName", restore.getExpectedInterfaceName());
    }

    json.addAll(kj::StringPtr("\n  },\n"
        "  \"exception\": {\n"
        "    \"type\": \"unimplemented\",\n"
        "    \"reason\": \"native Cap'n Proto bridge transport is not enabled\",\n"
        "    \"trace\": \"\"\n"
        "  }\n"
        "}\n"));
    json.add('\0');
    return kj::String(json.releaseAsArray());
  }

  kj::Array<byte> encodeNativeCapnpBridgeExceptionResponse(
      kj::StringPtr type, kj::StringPtr reason, kj::StringPtr trace = "") {
    capnp::MallocMessageBuilder message;
    auto response = message.initRoot<NativeCapnpBridgeResponse>();
    response.setProtocolVersion(NATIVE_CAPNP_BRIDGE_PROTOCOL_VERSION);
    auto exception = response.initException();
    exception.setType(type);
    exception.setReason(reason);
    exception.setTrace(trace);

    auto words = capnp::messageToFlatArray(message);
    return kj::heapArray<byte>(words.asBytes());
  }

  kj::Promise<void> sendNativeCapnpBridgeException(
      kj::HttpService::Response& response, uint statusCode, kj::StringPtr statusText,
      kj::StringPtr type, kj::StringPtr reason) {
    kj::HttpHeaders responseHeaders(headerTable);
    responseHeaders.set(kj::HttpHeaderId::CONTENT_TYPE, "application/octet-stream");
    return sendBytes(response, statusCode, statusText, kj::mv(responseHeaders),
        encodeNativeCapnpBridgeExceptionResponse(type, reason));
  }

  kj::Promise<void> sendNativeCapnpBridgeError(
      kj::HttpService::Response& response, uint statusCode, kj::StringPtr statusText,
      kj::StringPtr type, kj::StringPtr reason, bool binaryResponse) {
    if (binaryResponse) {
      return sendNativeCapnpBridgeException(response, statusCode, statusText, type, reason);
    } else {
      return sendJson(response, statusCode, statusText, renderError(reason));
    }
  }

  kj::String renderClaimedCapabilityStats() {
    auto stats = host.sessions->getClaimedCapabilityStats();
    return kj::str(
        "{\n"
        "  \"ok\": true,\n"
        "  \"type\": \"claimedCapabilityStats\",\n"
        "  \"claimedCapabilityCount\": ", stats.claimedCapabilityCount, ",\n"
        "  \"dropNotifyGroupCount\": ", stats.dropNotifyGroupCount, ",\n"
        "  \"localExportCount\": ", stats.localExportCount, ",\n"
        "  \"importedCount\": ", stats.importedCount, ",\n"
        "  \"webSessionNativeCount\": ", stats.webSessionNativeCount, ",\n"
        "  \"apiSessionNativeCount\": ", stats.apiSessionNativeCount, ",\n"
        "  \"outboundHttpNativeCount\": ", stats.outboundHttpNativeCount, ",\n"
        "  \"appObjectNativeCount\": ", stats.appObjectNativeCount, ",\n"
        "  \"unknownNativeCount\": ", stats.unknownNativeCount, ",\n"
        "  \"routeBackedWebSessionCount\": ", stats.routeBackedWebSessionCount, ",\n"
        "  \"routeBackedApiSessionCount\": ", stats.routeBackedApiSessionCount, ",\n"
        "  \"routeBackedAppObjectCount\": ", stats.routeBackedAppObjectCount, ",\n"
        "  \"powerboxClaimCount\": ", stats.powerboxClaimCount, ",\n"
        "  \"powerboxOfferCount\": ", stats.powerboxOfferCount, ",\n"
        "  \"restoredCount\": ", stats.restoredCount, ",\n"
        "  \"tiedCount\": ", stats.tiedCount, "\n"
        "}\n");
  }

  kj::String renderClaimedCapabilityInfo(kj::StringPtr id,
      const ClaimedCapabilityInfo& info) {
    auto& metadata = info.metadata;
    kj::Vector<char> json;
    json.addAll(kj::StringPtr("{\n  \"ok\": true,\n  "));
    appendJsonField(json, "type", "claimedCapabilityInfo");
    json.addAll(kj::StringPtr(",\n  "));
    appendJsonField(json, "id", id);
    json.addAll(kj::StringPtr(",\n  "));
    appendJsonField(json, "kind", claimedCapabilityKindName(metadata.kind));
    json.addAll(kj::StringPtr(",\n  "));
    appendJsonField(json, "residence", claimedCapabilityResidenceName(metadata.residence));
    json.addAll(kj::StringPtr(",\n  "));
    appendJsonField(json, "nativeInterface",
        claimedCapabilityNativeInterfaceName(metadata.nativeInterface));
    json.addAll(kj::StringPtr(",\n  "));
    appendJsonField(json, "pathPrefix", metadata.pathPrefix);
    json.addAll(kj::StringPtr(",\n  \"persistent\": "));
    json.addAll(metadata.persistent ? kj::StringPtr("true") : kj::StringPtr("false"));
    json.addAll(kj::StringPtr(",\n  \"hasDropNotify\": "));
    json.addAll(metadata.hasDropNotify ? kj::StringPtr("true") : kj::StringPtr("false"));
    json.addAll(kj::StringPtr(",\n  \"dropNotifyRefCount\": "));
    json.addAll(kj::str(info.dropNotifyRefCount));
    json.addAll(kj::StringPtr(",\n  \"supportsWebFetch\": "));
    json.addAll(claimedCapabilitySupportsWebFetch(metadata.nativeInterface)
        ? kj::StringPtr("true") : kj::StringPtr("false"));
    json.addAll(kj::StringPtr(",\n  \"supportsOutboundHttpFetch\": "));
    json.addAll(claimedCapabilitySupportsOutboundHttpFetch(metadata.nativeInterface)
        ? kj::StringPtr("true") : kj::StringPtr("false"));
    json.addAll(kj::StringPtr(",\n  \"hasNativeCapability\": "));
    json.addAll(metadata.hasNativeCapability ? kj::StringPtr("true") : kj::StringPtr("false"));
    json.addAll(kj::StringPtr(",\n  \"liveForwardable\": "));
    json.addAll(metadata.liveForwardable ? kj::StringPtr("true") : kj::StringPtr("false"));
    json.addAll(kj::StringPtr("\n}\n"));
    json.add('\0');
    return kj::String(json.releaseAsArray());
  }

  kj::Promise<void> claimedCapabilityInfo(
      kj::StringPtr url, kj::HttpService::Response& response) {
    kj::String id = nullptr;
    KJ_IF_MAYBE(error, readSingleNonEmptyQueryParam(
        url, "id", "expected exactly one capability id", id)) {
      return sendBadRequest(response, *error);
    }

    KJ_IF_MAYBE(info, host.sessions->findClaimedCapabilityInfo(id)) {
      return sendJson(response, 200, "OK", renderClaimedCapabilityInfo(id, *info));
    } else {
      return sendJson(response, 404, "Not Found", kj::heapString(
          "{\n  \"ok\": false,\n  \"error\": \"unknown claimed capability\"\n}\n"));
    }
  }

  kj::String renderPermissions() {
    auto viewInfo = config.viewInfoMessage->getRoot<UiView::ViewInfo>().asReader();
    auto permissionDefs = viewInfo.getPermissions();
    kj::Vector<char> json;
    json.addAll(kj::StringPtr("{\n  \"ok\": true,\n  \"permissions\": ["));
    for (auto i: kj::indices(permissionDefs)) {
      if (i > 0) {
        json.addAll(kj::StringPtr(", "));
      }

      json.addAll(kj::StringPtr("{\"name\": "));
      appendJsonString(json, permissionDefs[i].getName());
      json.addAll(kj::StringPtr(", \"title\": "));
      appendJsonString(json, permissionDefs[i].getTitle().getDefaultText());
      json.addAll(kj::StringPtr(", \"description\": "));
      appendJsonString(json, permissionDefs[i].getDescription().getDefaultText());
      json.addAll(kj::StringPtr("}"));
    }
    json.addAll(kj::StringPtr("]\n}\n"));
    json.add('\0');
    return kj::String(json.releaseAsArray());
  }

  kj::String normalizeCapabilityFetchPath(kj::StringPtr path) {
    KJ_REQUIRE(path.size() <= 8192, "claimed capability fetch path is too long");
    requireRouteBackedPathRelative(path,
        "claimed capability fetch path must be path-relative and canonical");
    size_t start = 0;
    while (start < path.size() && path[start] == '/') {
      ++start;
    }
    return kj::str(path.slice(start, path.size()));
  }

  bool isValidCapabilityFetchHeaderName(kj::StringPtr name) {
    if (name.size() == 0 || name.size() > 256) {
      return false;
    }

    for (auto c: name) {
      if (!((c >= 'a' && c <= 'z') ||
            (c >= 'A' && c <= 'Z') ||
            (c >= '0' && c <= '9') ||
            c == '!' || c == '#' || c == '$' || c == '%' || c == '&' ||
            c == '\'' || c == '*' || c == '+' || c == '-' || c == '.' ||
            c == '^' || c == '_' || c == '`' || c == '|' || c == '~')) {
        return false;
      }
    }

    return true;
  }

  bool isValidCapabilityFetchHeaderValue(kj::StringPtr value) {
    if (value.size() > 8192) {
      return false;
    }

    for (auto c: value) {
      if ((c >= 0 && c < 0x20 && c != '\t') || c == 0x7f) {
        return false;
      }
    }

    return true;
  }

  kj::String normalizeOutboundHttpFetchPath(kj::StringPtr path) {
    KJ_REQUIRE(path.size() <= 8192, "outbound HTTP fetch path is too long");
    KJ_REQUIRE(!path.startsWith("/"),
        "outbound HTTP fetch path must be relative to the granted base URL");
    for (size_t i = 0; i + 2 < path.size(); ++i) {
      KJ_REQUIRE(!(path[i] == ':' && path[i + 1] == '/' && path[i + 2] == '/'),
          "outbound HTTP fetch path must not be an absolute URL");
    }

    kj::StringPtr pathOnly = path;
    KJ_IF_MAYBE(query, path.findFirst('?')) {
      pathOnly = kj::StringPtr(path.begin(), *query);
    }
    KJ_IF_MAYBE(fragment, pathOnly.findFirst('#')) {
      KJ_FAIL_REQUIRE("outbound HTTP fetch path must not contain a fragment");
    }

    auto parts = split(pathOnly, '/');
    for (auto part: parts) {
      auto segment = kj::StringPtr(part.begin(), part.size());
      KJ_REQUIRE(segment != kj::StringPtr(".") && segment != kj::StringPtr(".."),
          "outbound HTTP fetch path must not contain dot segments");
    }

    for (auto c: path) {
      KJ_REQUIRE(c != '\r' && c != '\n' && c != '\0',
          "outbound HTTP fetch path contains invalid characters");
    }

    return kj::heapString(path);
  }

  kj::Maybe<kj::StringPtr> findOutboundHeaderValue(
      kj::ArrayPtr<FetchHeader> outboundHeaderValues, uint index) {
    auto internalName = kj::str("x-sandstorm-outbound-header-", index);
    for (auto& header: outboundHeaderValues) {
      if (header.name == internalName) {
        return header.value.asPtr();
      }
    }
    return nullptr;
  }

  OutboundHttpFetchParams getOutboundHttpFetchParams(
      kj::StringPtr url, kj::ArrayPtr<FetchHeader> outboundHeaderValues) {
    auto ids = findIsolateQueryParams(url, "id");
    auto methods = findIsolateQueryParams(url, "method");
    auto paths = findIsolateRawQueryParams(url, "path");
    KJ_REQUIRE(ids.size() == 1 && ids[0].size() > 0 &&
        methods.size() == 1 && methods[0].size() > 0 &&
        paths.size() == 1,
        "expected exactly one outbound HTTP capability id, method, and path");

    auto method = KJ_REQUIRE_NONNULL(parseOutboundHttpMethod(methods[0]),
        "unsupported outbound HTTP method", methods[0]);
    auto names = findIsolateQueryParams(url, "headerName");
    KJ_REQUIRE(names.size() <= 64, "outbound HTTP fetch has too many headers");

    OutboundHttpFetchParams result {
      kj::mv(ids[0]),
      method,
      normalizeOutboundHttpFetchPath(paths[0]),
      kj::Vector<FetchHeader>()
    };

    for (auto i: kj::indices(names)) {
      auto& name = names[i];
      KJ_REQUIRE(isValidCapabilityFetchHeaderName(name),
          "outbound HTTP fetch header name is invalid", name);
      auto value = KJ_ASSERT_NONNULL(findOutboundHeaderValue(outboundHeaderValues, i),
          "outbound HTTP fetch header value is missing", name);
      KJ_REQUIRE(isValidCapabilityFetchHeaderValue(value),
          "outbound HTTP fetch header value is invalid", name);
      auto normalizedName = kj::heapString(name);
      toLower(normalizedName);
      result.headers.add(FetchHeader { kj::mv(normalizedName), kj::heapString(value) });
    }

    return kj::mv(result);
  }

  bool shouldForwardOutboundHttpResponseHeader(kj::StringPtr name) {
    if (!isValidCapabilityFetchHeaderName(name)) {
      return false;
    }

    auto lower = kj::heapString(name);
    toLower(lower);
    return lower != "connection" &&
        lower != "content-length" &&
        lower != "keep-alive" &&
        lower != "te" &&
        lower != "trailer" &&
        lower != "transfer-encoding" &&
        lower != "upgrade";
  }

  kj::String safeOutboundHttpStatusText(kj::StringPtr statusText) {
    if (statusText.size() == 0 || statusText.size() > 128 ||
        !isValidCapabilityFetchHeaderValue(statusText)) {
      return kj::heapString("OK");
    }

    return kj::heapString(statusText);
  }

  kj::HttpHeaders makeOutboundHttpResponseHeaders(
      OutboundHttpSession::Response::Reader outboundResponse) {
    kj::HttpHeaders headers(headerTable);
    for (auto header: outboundResponse.getHeaders()) {
      auto name = header.getName();
      auto value = header.getValue();
      if (!isValidCapabilityFetchHeaderName(name)) {
        continue;
      }

      if (!shouldForwardOutboundHttpResponseHeader(name)) {
        continue;
      }

      if (!isValidCapabilityFetchHeaderValue(value)) {
        continue;
      }

      headers.add(kj::heapString(name), kj::heapString(value));
    }
    return kj::mv(headers);
  }

  CapabilityFetchContextParams getCapabilityFetchContextParams(kj::StringPtr url) {
    auto names = findIsolateQueryParams(url, "headerName");
    auto values = findIsolateQueryParams(url, "headerValue");
    KJ_REQUIRE(names.size() == values.size(),
        "claimed capability fetch headers must have matching names and values");
    KJ_REQUIRE(names.size() <= 32, "claimed capability fetch has too many headers");

    HeaderWhitelist requestHeaderWhitelist(*WebSession::Context::HEADER_WHITELIST);
    CapabilityFetchContextParams result;
    for (auto i: kj::indices(names)) {
      KJ_REQUIRE(isValidCapabilityFetchHeaderName(names[i]),
          "claimed capability fetch header name is invalid", names[i]);
      KJ_REQUIRE(isValidCapabilityFetchHeaderValue(values[i]),
          "claimed capability fetch header value is invalid", names[i]);

      auto name = kj::heapString(names[i]);
      toLower(name);
      if (name == "if-match") {
        KJ_IF_MAYBE(existing, result.ifMatch) {
          KJ_FAIL_REQUIRE("claimed capability fetch can only include one If-Match header");
        }
        result.ifMatch = kj::mv(values[i]);
      } else if (name == "if-none-match") {
        KJ_IF_MAYBE(existing, result.ifNoneMatch) {
          KJ_FAIL_REQUIRE("claimed capability fetch can only include one If-None-Match header");
        }
        result.ifNoneMatch = kj::mv(values[i]);
      } else if (requestHeaderWhitelist.matches(name)) {
        result.additionalHeaders.add(FetchHeader { kj::mv(name), kj::mv(values[i]) });
      }
    }

    return result;
  }

  kj::Vector<ParsedETag> parseCapabilityFetchETagList(kj::StringPtr value) {
    auto parts = split(value, ',');
    KJ_REQUIRE(parts.size() > 0, "claimed capability fetch ETag precondition is empty");

    kj::Vector<ParsedETag> result;
    for (auto part: parts) {
      KJ_IF_MAYBE(parsed, parseFetchETag(kj::StringPtr(part.begin(), part.size()))) {
        result.add(kj::mv(*parsed));
      } else {
        KJ_FAIL_REQUIRE("claimed capability fetch ETag precondition is invalid", value);
      }
    }
    return result;
  }

  void initCapabilityFetchETagList(
      capnp::List<WebSession::ETag>::Builder output,
      kj::Vector<ParsedETag>& input) {
    for (auto i: kj::indices(input)) {
      copyFetchETag(input[i], output[i]);
    }
  }

  void initCapabilityFetchETagPrecondition(
      WebSession::Context::Builder context, CapabilityFetchContextParams& params) {
    KJ_IF_MAYBE(ifMatch, params.ifMatch) {
      auto value = kj::str(trim(*ifMatch));
      if (value == "*") {
        context.getETagPrecondition().setExists();
      } else {
        auto parsed = parseCapabilityFetchETagList(value);
        initCapabilityFetchETagList(
            context.getETagPrecondition().initMatchesOneOf(parsed.size()), parsed);
      }
      return;
    }

    KJ_IF_MAYBE(ifNoneMatch, params.ifNoneMatch) {
      auto value = kj::str(trim(*ifNoneMatch));
      if (value == "*") {
        context.getETagPrecondition().setDoesntExist();
      } else {
        auto parsed = parseCapabilityFetchETagList(value);
        initCapabilityFetchETagList(
            context.getETagPrecondition().initMatchesNoneOf(parsed.size()), parsed);
      }
    }
  }

  bool shouldSendNotModifiedForPrecondition(CapabilityFetchContextParams& params) {
    KJ_IF_MAYBE(ifMatch, params.ifMatch) {
      return false;
    }
    KJ_IF_MAYBE(ifNoneMatch, params.ifNoneMatch) {
      return true;
    }
    return false;
  }

  kj::String normalizeRouteBackedCapabilityPathPrefix(kj::StringPtr pathPrefix) {
    return normalizeRouteBackedPathPrefix(pathPrefix);
  }

  capnp::Capability::Client makeRouteBackedSessionCapability(
      RouteBackedCapabilityType capabilityType, kj::StringPtr pathPrefix, bool persistent) {
    return sandstorm::makeRouteBackedSessionCapability(
        kj::addRef(config), kj::addRef(host), capabilityType, pathPrefix, persistent);
  }

  capnp::Capability::Client makeRouteBackedCapability(
      RouteBackedCapabilityType capabilityType, kj::StringPtr pathPrefix, bool persistent) {
    if (capabilityType == RouteBackedCapabilityType::OBJECT) {
      return makeRouteBackedObjectCapability(
          kj::addRef(config), kj::addRef(host), pathPrefix, persistent);
    }
    return makeRouteBackedSessionCapability(capabilityType, pathPrefix, persistent);
  }

  ClaimedCapabilityMetadata makeRouteBackedClaimedCapabilityMetadata(
      RouteBackedCapabilityType capabilityType, kj::StringPtr pathPrefix, bool persistent) {
    ClaimedCapabilityKind kind;
    ClaimedCapabilityNativeInterface nativeInterface;
    switch (capabilityType) {
      case RouteBackedCapabilityType::WEB:
        kind = ClaimedCapabilityKind::ROUTE_BACKED_WEB_SESSION;
        nativeInterface = ClaimedCapabilityNativeInterface::WEB_SESSION;
        break;
      case RouteBackedCapabilityType::API:
        kind = ClaimedCapabilityKind::ROUTE_BACKED_API_SESSION;
        nativeInterface = ClaimedCapabilityNativeInterface::API_SESSION;
        break;
      case RouteBackedCapabilityType::OBJECT:
        kind = ClaimedCapabilityKind::ROUTE_BACKED_APP_OBJECT;
        nativeInterface = ClaimedCapabilityNativeInterface::APP_OBJECT;
        break;
    }

    return ClaimedCapabilityMetadata {
      kind,
      ClaimedCapabilityResidence::LOCAL_EXPORT,
      nativeInterface,
      kj::heapString(pathPrefix),
      persistent,
      false,
      true,
      true,
    };
  }

  kj::Promise<void> createRouteBackedCapability(
      kj::StringPtr url, kj::HttpService::Response& response,
      RouteBackedCapabilityType capabilityType) {
    auto pathPrefixes = findIsolateRawQueryParams(url, "pathPrefix");
    auto persistentParams = findIsolateQueryParams(url, "persistent");
    auto dropNotifyPaths = findIsolateRawQueryParams(url, "dropNotifyPath");
    if (pathPrefixes.size() > 1 || persistentParams.size() > 1 || dropNotifyPaths.size() > 1) {
      return sendJson(response, 400, "Bad Request", kj::heapString(
          "{\n  \"ok\": false,\n"
          "  \"error\": \"expected at most one pathPrefix, persistent flag, and dropNotifyPath\"\n}\n"));
    }

    auto pathPrefix = pathPrefixes.size() == 1
        ? normalizeRouteBackedCapabilityPathPrefix(pathPrefixes[0])
        : kj::heapString("");
    kj::Maybe<kj::String> dropNotifyPath = nullptr;
    if (dropNotifyPaths.size() == 1 && dropNotifyPaths[0].size() > 0) {
      auto notifyPath = normalizeRouteBackedCapabilityPathPrefix(dropNotifyPaths[0]);
      if (!routeBackedPathIsWithinPrefix(notifyPath, pathPrefix)) {
        return sendJson(response, 400, "Bad Request", renderError(
            "dropNotifyPath must be within pathPrefix"));
      }
      dropNotifyPath = kj::mv(notifyPath);
    }
    bool persistent = true;
    if (persistentParams.size() == 1) {
      auto value = kj::heapString(persistentParams[0]);
      toLower(value);
      if (value == "false" || value == "0") {
        persistent = false;
      } else if (value == "true" || value == "1") {
        persistent = true;
      } else {
        return sendJson(response, 400, "Bad Request", renderError(
            "persistent must be true or false"));
      }
    }
    auto metadata = makeRouteBackedClaimedCapabilityMetadata(capabilityType, pathPrefix, persistent);
    kj::String capId;
    if (capabilityType == RouteBackedCapabilityType::OBJECT) {
      auto object = makeRouteBackedObjectCapabilityWithState(
          kj::addRef(config), kj::addRef(host), pathPrefix, persistent);
      capId = dropNotifyPath == nullptr
          ? host.sessions->storeClaimedCapability(kj::mv(object.cap), kj::mv(metadata))
          : host.sessions->storeClaimedCapability(kj::mv(object.cap), kj::mv(metadata),
              kj::mv(KJ_ASSERT_NONNULL(dropNotifyPath)));
      object.state->claimedId = kj::heapString(capId);
    } else {
      auto cap = makeRouteBackedCapability(capabilityType, pathPrefix, persistent);
      capId = dropNotifyPath == nullptr
          ? host.sessions->storeClaimedCapability(kj::mv(cap), kj::mv(metadata))
          : host.sessions->storeClaimedCapability(kj::mv(cap), kj::mv(metadata),
              kj::mv(KJ_ASSERT_NONNULL(dropNotifyPath)));
    }
    return sendJson(response, 200, "OK", renderClaimedCapability(capId));
  }

  kj::Promise<void> callWorkerAppObjectCapability(
      kj::StringPtr url, kj::Array<byte> bodyBytes, kj::HttpService::Response& response) {
    auto ids = findIsolateQueryParams(url, "id");
    if (ids.size() != 1 || ids[0].size() == 0) {
      return sendJson(response, 400, "Bad Request", kj::heapString(
          "{\n  \"ok\": false,\n"
          "  \"error\": \"expected exactly one capability id\"\n}\n"));
    }

    KJ_IF_MAYBE(metadata, host.sessions->findClaimedCapabilityMetadata(ids[0])) {
      if (!claimedCapabilitySupportsAppObjectCall(metadata->nativeInterface)) {
        return sendJson(response, 400, "Bad Request", renderError(kj::str(
            "claimed capability native interface ",
            claimedCapabilityNativeInterfaceName(metadata->nativeInterface),
            " cannot be used with powerbox.nativeAppRpcCall")));
      }
    }

    KJ_IF_MAYBE(cap, host.sessions->findClaimedCapability(ids[0])) {
      ClaimedCapabilityWorkerAppObjectAdapter adapter(*host.sessions);
      kj::Maybe<OwnedWorkerAppObjectCall> parsedCall;
      try {
        parsedCall = parseWorkerAppObjectCallJson(
            bodyBytes.asPtr(), adapter, MAX_API_BINDING_REQUEST_BYTES);
      } catch (kj::Exception& exception) {
        return sendJson(response, 400, "Bad Request", renderError(
            kj::str("invalid native app RPC call envelope: ", exception.getDescription())));
      }

      auto call = kj::mv(KJ_ASSERT_NONNULL(parsedCall));
      auto object = cap->castAs<IsolateObjectCapability>();
      auto args = call.args.getArgs();
      return callIsolateObjectCapability(object, call.method, args)
          .then([this, &response](OwnedIsolateObjectCallResult&& result) mutable {
        ClaimedCapabilityWorkerAppObjectAdapter adapter(*host.sessions);
        return sendJson(
            response, 200, "OK", renderWorkerAppObjectResultJson(result.getResult(), adapter));
      }).catch_([this, &response](kj::Exception&& exception) mutable {
        return sendJson(response, 502, "Bad Gateway", renderError(
            kj::str("native app RPC call failed: ", exception.getDescription())));
      });
    } else {
      return sendJson(response, 404, "Not Found", kj::heapString(
          "{\n  \"ok\": false,\n  \"error\": \"unknown claimed capability\"\n}\n"));
    }
  }

  kj::Promise<void> callNativeCapnpBridge(
      kj::Array<byte> bodyBytes, kj::HttpService::Response& response, bool binaryResponse) {
    if (bodyBytes.size() == 0) {
      return sendNativeCapnpBridgeError(response, 400, "Bad Request", "failed",
          "native Cap'n Proto bridge request body is empty", binaryResponse);
    }

    try {
      kj::ArrayInputStream input(bodyBytes);
      capnp::InputStreamMessageReader reader(input);
      auto request = reader.getRoot<NativeCapnpBridgeRequest>();
      if (request.getProtocolVersion() != NATIVE_CAPNP_BRIDGE_PROTOCOL_VERSION) {
        return sendNativeCapnpBridgeError(response, 400, "Bad Request", "failed", kj::str(
            "unsupported native Cap'n Proto bridge protocol version: ",
            request.getProtocolVersion()), binaryResponse);
      }
      if (request.isCall() && request.hasCall()) {
        auto call = request.getCall();
        if (!call.hasTarget()) {
          return sendNativeCapnpBridgeError(response, 400, "Bad Request", "failed",
              "native Cap'n Proto bridge call request is missing target", binaryResponse);
        }
        if (!call.hasParams()) {
          return sendNativeCapnpBridgeError(response, 400, "Bad Request", "failed",
              "native Cap'n Proto bridge call request is missing params", binaryResponse);
        }

        auto target = call.getTarget();
        if (target.getId().size() == 0) {
          return sendNativeCapnpBridgeError(response, 400, "Bad Request", "failed",
              "native Cap'n Proto bridge call request target id is empty", binaryResponse);
        }
        if (host.sessions->findClaimedCapability(target.getId()) == nullptr) {
          return sendNativeCapnpBridgeError(response, 404, "Not Found", "failed",
              "unknown native Cap'n Proto bridge target capability", binaryResponse);
        }
      } else if (request.isDrop() && request.hasDrop()) {
        auto target = request.getDrop().getTarget();
        if (target.getId().size() == 0) {
          return sendNativeCapnpBridgeError(response, 400, "Bad Request", "failed",
              "native Cap'n Proto bridge drop request target id is empty", binaryResponse);
        }
        if (host.sessions->findClaimedCapability(target.getId()) == nullptr) {
          return sendNativeCapnpBridgeError(response, 404, "Not Found", "failed",
              "unknown native Cap'n Proto bridge target capability", binaryResponse);
        }
      } else if (request.isSave() && request.hasSave()) {
        auto target = request.getSave().getTarget();
        if (target.getId().size() == 0) {
          return sendNativeCapnpBridgeError(response, 400, "Bad Request", "failed",
              "native Cap'n Proto bridge save request target id is empty", binaryResponse);
        }
        if (host.sessions->findClaimedCapability(target.getId()) == nullptr) {
          return sendNativeCapnpBridgeError(response, 404, "Not Found", "failed",
              "unknown native Cap'n Proto bridge target capability", binaryResponse);
        }
      } else if (request.isRestore() && request.hasRestore()) {
        auto restore = request.getRestore();
        if (restore.getToken().size() == 0) {
          return sendNativeCapnpBridgeError(response, 400, "Bad Request", "failed",
              "native Cap'n Proto bridge restore request token is empty", binaryResponse);
        }
      } else {
        return sendNativeCapnpBridgeError(response, 400, "Bad Request", "failed",
            "expected native Cap'n Proto bridge request", binaryResponse);
      }

      if (binaryResponse) {
        return sendNativeCapnpBridgeException(response, 501, "Not Implemented", "unimplemented",
            "native Cap'n Proto bridge transport is not enabled");
      } else {
        return sendJson(response, 501, "Not Implemented", renderNativeCapnpBridgeDisabled(request));
      }
    } catch (kj::Exception& exception) {
      return sendNativeCapnpBridgeError(response, 400, "Bad Request", "failed", kj::str(
          "invalid native Cap'n Proto bridge request: ", exception.getDescription()),
          binaryResponse);
    }
  }

  kj::Promise<void> fetchClaimedCapability(
      kj::StringPtr url, kj::StringPtr contentType, kj::Array<byte> bodyBytes,
      kj::HttpService::Response& response) {
    auto ids = findIsolateQueryParams(url, "id");
    auto methods = findIsolateQueryParams(url, "method");
    auto paths = findIsolateRawQueryParams(url, "path");
    auto contextParams = getCapabilityFetchContextParams(url);
    if (ids.size() != 1 || ids[0].size() == 0 ||
        methods.size() != 1 || methods[0].size() == 0 ||
        paths.size() != 1) {
      return sendJson(response, 400, "Bad Request", kj::heapString(
          "{\n  \"ok\": false,\n"
          "  \"error\": \"expected exactly one capability id, method, and path\"\n}\n"));
    }

    KJ_IF_MAYBE(nativeInterface, host.sessions->findClaimedCapabilityNativeInterface(ids[0])) {
      if (!claimedCapabilitySupportsWebFetch(*nativeInterface)) {
        return sendJson(response, 400, "Bad Request", renderError(kj::str(
            "claimed capability native interface ",
            claimedCapabilityNativeInterfaceName(*nativeInterface),
            " cannot be used with powerbox.fetch")));
      }
    }

    KJ_IF_MAYBE(cap, host.sessions->findClaimedCapability(ids[0])) {
      auto webSession = cap->castAs<WebSession>();

      auto method = kj::heapString(methods[0]);
      toLower(method);
      auto path = normalizeCapabilityFetchPath(paths[0]);

      if (method == "get" || method == "head") {
        auto request = webSession.getRequest();
        request.setPath(path);
        request.setIgnoreBody(method == "head");
        auto fetchContext = initCapabilityFetchContext(request.initContext(), contextParams);
        return request.send()
            .then([this, &response, fetchContext = kj::mv(fetchContext)]
                (auto result) mutable {
          return sendWebSessionHttpResponse(kj::mv(result), response, kj::mv(fetchContext));
        }).catch_([this, &response](kj::Exception&& exception) mutable {
          return sendJson(response, 502, "Bad Gateway", renderError(
              kj::str("claimed capability fetch failed: ", exception.getDescription())));
        });
      } else if (method == "post") {
        auto request = webSession.postRequest();
        request.setPath(path);
        initPostContent(request.initContent(), contentType, bodyBytes);
        auto fetchContext = initCapabilityFetchContext(request.initContext(), contextParams);
        return request.send()
            .then([this, &response, fetchContext = kj::mv(fetchContext)]
                (auto result) mutable {
          return sendWebSessionHttpResponse(kj::mv(result), response, kj::mv(fetchContext));
        }).catch_([this, &response](kj::Exception&& exception) mutable {
          return sendJson(response, 502, "Bad Gateway", renderError(
              kj::str("claimed capability fetch failed: ", exception.getDescription())));
        });
      } else if (method == "put") {
        auto request = webSession.putRequest();
        request.setPath(path);
        initPutContent(request.initContent(), contentType, bodyBytes);
        auto fetchContext = initCapabilityFetchContext(request.initContext(), contextParams);
        return request.send()
            .then([this, &response, fetchContext = kj::mv(fetchContext)]
                (auto result) mutable {
          return sendWebSessionHttpResponse(kj::mv(result), response, kj::mv(fetchContext));
        }).catch_([this, &response](kj::Exception&& exception) mutable {
          return sendJson(response, 502, "Bad Gateway", renderError(
              kj::str("claimed capability fetch failed: ", exception.getDescription())));
        });
      } else if (method == "patch") {
        auto request = webSession.patchRequest();
        request.setPath(path);
        initPostContent(request.initContent(), contentType, bodyBytes);
        auto fetchContext = initCapabilityFetchContext(request.initContext(), contextParams);
        return request.send()
            .then([this, &response, fetchContext = kj::mv(fetchContext)]
                (auto result) mutable {
          return sendWebSessionHttpResponse(kj::mv(result), response, kj::mv(fetchContext));
        }).catch_([this, &response](kj::Exception&& exception) mutable {
          return sendJson(response, 502, "Bad Gateway", renderError(
              kj::str("claimed capability fetch failed: ", exception.getDescription())));
        });
      } else if (method == "delete") {
        auto request = webSession.deleteRequest();
        request.setPath(path);
        auto fetchContext = initCapabilityFetchContext(request.initContext(), contextParams);
        return request.send()
            .then([this, &response, fetchContext = kj::mv(fetchContext)]
                (auto result) mutable {
          return sendWebSessionHttpResponse(kj::mv(result), response, kj::mv(fetchContext));
        }).catch_([this, &response](kj::Exception&& exception) mutable {
          return sendJson(response, 502, "Bad Gateway", renderError(
              kj::str("claimed capability fetch failed: ", exception.getDescription())));
        });
      } else {
        return sendJson(response, 405, "Method Not Allowed", kj::heapString(
            "{\n  \"ok\": false,\n"
            "  \"error\": \"claimed capability fetch method is not supported\"\n}\n"));
      }
    } else {
      return sendJson(response, 404, "Not Found", kj::heapString(
          "{\n  \"ok\": false,\n  \"error\": \"unknown claimed capability\"\n}\n"));
    }
  }

  kj::Promise<void> fetchOutboundHttpCapability(
      kj::StringPtr url, kj::Array<FetchHeader> outboundHeaderValues, kj::Array<byte> bodyBytes,
      kj::HttpService::Response& response) {
    auto params = getOutboundHttpFetchParams(url, outboundHeaderValues);

    KJ_IF_MAYBE(nativeInterface, host.sessions->findClaimedCapabilityNativeInterface(params.id)) {
      if (*nativeInterface != ClaimedCapabilityNativeInterface::UNKNOWN &&
          *nativeInterface != ClaimedCapabilityNativeInterface::OUTBOUND_HTTP_SESSION) {
        return sendJson(response, 400, "Bad Request", renderError(kj::str(
            "claimed capability native interface ",
            claimedCapabilityNativeInterfaceName(*nativeInterface),
            " cannot be used with powerbox.outboundHttpFetch")));
      }
    }

    KJ_IF_MAYBE(cap, host.sessions->findClaimedCapability(params.id)) {
      auto outbound = cap->castAs<OutboundHttpSession>();
      auto request = outbound.requestRequest();
      request.setMethod(params.method);
      request.setPath(params.path);
      auto headers = request.initHeaders(params.headers.size());
      for (auto i: kj::indices(params.headers)) {
        headers[i].setName(params.headers[i].name);
        headers[i].setValue(params.headers[i].value);
      }
      request.setBody(bodyBytes);

      auto responseStream = kj::heap<BufferedByteStream>(
          "outbound HTTP response body exceeds maximum allowed size");
      auto responseBody = responseStream->whenDone();
      ByteStream::Client responseStreamClient(kj::mv(responseStream));
      request.setResponseStream(kj::mv(responseStreamClient));

      auto responseStarted = kj::heap<bool>(false);
      auto responseStartedPtr = responseStarted.get();

      return request.send()
          .then([this, &response, responseBody = kj::mv(responseBody), responseStartedPtr](
              auto result) mutable {
        uint statusCode = result.getStatusCode();
        auto statusText = safeOutboundHttpStatusText(result.getStatusText());
        auto responseHeaders = makeOutboundHttpResponseHeaders(result);
        return responseBody.then([this, &response, statusCode, statusText = kj::mv(statusText),
            responseHeaders = kj::mv(responseHeaders), responseStartedPtr](
                kj::Array<byte>&& body) mutable {
          auto statusTextPtr = statusText.size() == 0 ? kj::StringPtr("OK") : statusText.asPtr();
          *responseStartedPtr = true;
          return sendBytes(response, statusCode, statusTextPtr, kj::mv(responseHeaders),
              kj::mv(body));
        });
      }).catch_([this, &response, responseStartedPtr](
          kj::Exception&& exception) mutable -> kj::Promise<void> {
        if (*responseStartedPtr) {
          KJ_LOG(WARNING, "Outbound HTTP response write failed after response started.",
              exception);
          return kj::mv(exception);
        }

        return sendJson(response, 502, "Bad Gateway", renderError(
            kj::str("outbound HTTP fetch failed: ", exception.getDescription())));
      }).attach(kj::mv(outboundHeaderValues), kj::mv(bodyBytes), kj::mv(params),
          kj::mv(responseStarted));
    } else {
      return sendJson(response, 404, "Not Found", kj::heapString(
          "{\n  \"ok\": false,\n  \"error\": \"unknown claimed capability\"\n}\n"));
    }
  }

  CapabilityFetchContext initCapabilityFetchContext(
      WebSession::Context::Builder context, CapabilityFetchContextParams& contextParams) {
    auto paf = kj::newPromiseAndFulfiller<ByteStream::Client>();
    context.initCookies(0);
    context.setResponseStream(kj::mv(paf.promise));
    context.initAccept(0);
    context.initAcceptEncoding(0);
    initCapabilityFetchETagPrecondition(context, contextParams);
    auto additionalHeaders = contextParams.additionalHeaders.asPtr();
    auto headers = context.initAdditionalHeaders(additionalHeaders.size());
    for (auto i: kj::indices(additionalHeaders)) {
      headers[i].setName(additionalHeaders[i].name);
      headers[i].setValue(additionalHeaders[i].value);
    }

    return CapabilityFetchContext {
      kj::mv(paf.fulfiller),
      shouldSendNotModifiedForPrecondition(contextParams)
    };
  }

  void initPostContent(
      WebSession::PostContent::Builder content, kj::StringPtr contentType,
      kj::ArrayPtr<const byte> body) {
    content.setMimeType(contentType);
    content.setContent(body);
  }

  void initPutContent(
      WebSession::PutContent::Builder content, kj::StringPtr contentType,
      kj::ArrayPtr<const byte> body) {
    content.setMimeType(contentType);
    content.setContent(body);
  }

  uint statusCodeForSuccess(WebSession::Response::SuccessCode code) {
    switch (code) {
      case WebSession::Response::SuccessCode::OK: return 200;
      case WebSession::Response::SuccessCode::CREATED: return 201;
      case WebSession::Response::SuccessCode::ACCEPTED: return 202;
      case WebSession::Response::SuccessCode::NO_CONTENT: return 204;
      case WebSession::Response::SuccessCode::PARTIAL_CONTENT: return 206;
      case WebSession::Response::SuccessCode::MULTI_STATUS: return 207;
      case WebSession::Response::SuccessCode::NOT_MODIFIED: return 304;
    }
    KJ_UNREACHABLE;
  }

  uint statusCodeForClientError(WebSession::Response::ClientErrorCode code) {
    switch (code) {
      case WebSession::Response::ClientErrorCode::BAD_REQUEST: return 400;
      case WebSession::Response::ClientErrorCode::FORBIDDEN: return 403;
      case WebSession::Response::ClientErrorCode::NOT_FOUND: return 404;
      case WebSession::Response::ClientErrorCode::METHOD_NOT_ALLOWED: return 405;
      case WebSession::Response::ClientErrorCode::NOT_ACCEPTABLE: return 406;
      case WebSession::Response::ClientErrorCode::CONFLICT: return 409;
      case WebSession::Response::ClientErrorCode::GONE: return 410;
      case WebSession::Response::ClientErrorCode::PRECONDITION_FAILED: return 412;
      case WebSession::Response::ClientErrorCode::REQUEST_ENTITY_TOO_LARGE: return 413;
      case WebSession::Response::ClientErrorCode::REQUEST_URI_TOO_LONG: return 414;
      case WebSession::Response::ClientErrorCode::UNSUPPORTED_MEDIA_TYPE: return 415;
      case WebSession::Response::ClientErrorCode::IM_A_TEAPOT: return 418;
      case WebSession::Response::ClientErrorCode::UNPROCESSABLE_ENTITY: return 422;
    }
    KJ_UNREACHABLE;
  }

  kj::HttpHeaders makeHttpHeaders(WebSession::Response::Reader webResponse) {
    kj::HttpHeaders headers(headerTable);
    for (auto header: webResponse.getAdditionalHeaders()) {
      headers.add(header.getName(), header.getValue());
    }
    return kj::mv(headers);
  }

  void addContentHeaders(
      kj::HttpHeaders& headers, WebSession::Response::Content::Reader content) {
    if (content.hasEncoding()) {
      headers.add("content-encoding", content.getEncoding());
    }
    if (content.hasLanguage()) {
      headers.add("content-language", content.getLanguage());
    }
    if (content.hasETag()) {
      headers.add("etag", formatRequestETag(content.getETag()));
    }

    auto disposition = content.getDisposition();
    switch (disposition.which()) {
      case WebSession::Response::Content::Disposition::NORMAL:
        break;
      case WebSession::Response::Content::Disposition::DOWNLOAD:
        headers.add("content-disposition",
            kj::str("attachment; filename=\"",
                escapeHttpQuotedString(disposition.getDownload()), "\""));
        break;
    }
  }

  kj::Promise<void> sendWebSessionHttpResponse(
      capnp::Response<WebSession::Response>&& webResponse, kj::HttpService::Response& response,
      CapabilityFetchContext&& fetchContext) {
    KJ_DEFER(fulfillNoStreaming(fetchContext));

    switch (webResponse.which()) {
      case WebSession::Response::CONTENT: {
        auto content = webResponse.getContent();
        auto headers = makeHttpHeaders(webResponse);
        headers.set(kj::HttpHeaderId::CONTENT_TYPE, content.getMimeType());
        addContentHeaders(headers, content);
        auto statusCode = statusCodeForSuccess(content.getStatusCode());
        auto body = content.getBody();
        switch (body.which()) {
          case WebSession::Response::Content::Body::BYTES:
            return sendBytes(response, statusCode, "OK", kj::mv(headers),
                kj::heapArray<byte>(body.getBytes()));
          case WebSession::Response::Content::Body::STREAM: {
            auto streamServer = kj::heap<HttpResponseByteStream>(
                statusCode, "OK", kj::mv(headers), response);
            auto done = streamServer->whenDone();
            KJ_ASSERT_NONNULL(fetchContext.responseStreamFulfiller)
                ->fulfill(kj::mv(streamServer));
            fetchContext.responseStreamFulfiller = nullptr;
            return done.attach(kj::mv(webResponse));
          }
        }
        KJ_UNREACHABLE;
      }
      case WebSession::Response::NO_CONTENT: {
        auto noContent = webResponse.getNoContent();
        auto headers = makeHttpHeaders(webResponse);
        if (noContent.hasETag()) {
          headers.add("etag", formatRequestETag(noContent.getETag()));
        }
        response.send(noContent.getShouldResetForm() ? 205 : 204, "No Content",
            headers, uint64_t(0));
        return kj::READY_NOW;
      }
      case WebSession::Response::PRECONDITION_FAILED: {
        auto preconditionFailed = webResponse.getPreconditionFailed();
        auto headers = makeHttpHeaders(webResponse);
        if (preconditionFailed.hasMatchingETag()) {
          headers.add("etag", formatRequestETag(preconditionFailed.getMatchingETag()));
        }
        if (fetchContext.sendNotModifiedForPrecondition) {
          response.send(304, "Not Modified", headers, uint64_t(0));
        } else {
          response.send(412, "Precondition Failed", headers, uint64_t(0));
        }
        return kj::READY_NOW;
      }
      case WebSession::Response::REDIRECT: {
        auto redirect = webResponse.getRedirect();
        auto headers = makeHttpHeaders(webResponse);
        headers.set(kj::HttpHeaderId::LOCATION, redirect.getLocation());
        uint statusCode = redirect.getIsPermanent()
            ? (redirect.getSwitchToGet() ? 301 : 308)
            : (redirect.getSwitchToGet() ? 303 : 307);
        response.send(statusCode, "Redirect", headers, uint64_t(0));
        return kj::READY_NOW;
      }
      case WebSession::Response::CLIENT_ERROR:
        return sendWebSessionError(response, statusCodeForClientError(
            webResponse.getClientError().getStatusCode()), webResponse.getClientError());
      case WebSession::Response::SERVER_ERROR:
        return sendWebSessionError(response, 500, webResponse.getServerError());
    }

    KJ_UNREACHABLE;
  }

  template <typename ErrorReader>
  kj::Promise<void> sendWebSessionError(
      kj::HttpService::Response& response, uint statusCode, ErrorReader error) {
    kj::HttpHeaders headers(headerTable);
    if (error.hasNonHtmlBody()) {
      auto body = error.getNonHtmlBody();
      headers.set(kj::HttpHeaderId::CONTENT_TYPE, body.getMimeType());
      return sendBytes(response, statusCode, "Error", kj::mv(headers),
          kj::heapArray<byte>(body.getData()));
    } else if (error.hasDescriptionHtml()) {
      headers.set(kj::HttpHeaderId::CONTENT_TYPE, "text/html; charset=utf-8");
      return sendText(response, statusCode, "Error", kj::mv(headers),
          kj::heapString(error.getDescriptionHtml()));
    } else {
      response.send(statusCode, "Error", headers, uint64_t(0));
      return kj::READY_NOW;
    }
  }

  ClaimedCapabilityNativeInterface nativeInterfaceFromPowerboxDescriptorParams(
      kj::StringPtr url) {
    kj::Maybe<ClaimedCapabilityNativeInterface> explicitNativeInterface = nullptr;
    auto nativeInterfaceNames = findIsolateQueryParams(url, "nativeInterface");
    KJ_REQUIRE(nativeInterfaceNames.size() <= 1, "expected at most one nativeInterface");
    if (nativeInterfaceNames.size() == 1) {
      KJ_REQUIRE(nativeInterfaceNames[0].size() > 0, "nativeInterface must not be empty");
      KJ_IF_MAYBE(nativeInterface, claimedCapabilityNativeInterfaceFromName(
          nativeInterfaceNames[0])) {
        explicitNativeInterface = *nativeInterface;
      } else {
        KJ_FAIL_REQUIRE("unsupported nativeInterface", nativeInterfaceNames[0]);
      }
    }

    auto descriptorTypes = findIsolateQueryParams(url, "descriptor");
    KJ_REQUIRE(descriptorTypes.size() <= 1, "expected at most one powerbox descriptor type");
    if (descriptorTypes.size() == 0 || descriptorTypes[0].size() == 0) {
      KJ_IF_MAYBE(nativeInterface, explicitNativeInterface) {
        return *nativeInterface;
      }
      return ClaimedCapabilityNativeInterface::UNKNOWN;
    }

    capnp::MallocMessageBuilder message;
    auto descriptor = message.initRoot<PowerboxDescriptor>();
    if (descriptorTypes[0] == "apiSession") {
      initApiSessionPowerboxDescriptor(url, descriptor);
    } else if (descriptorTypes[0] == "outboundHttp") {
      initOutboundHttpPowerboxDescriptor(url, descriptor);
    } else if (descriptorTypes[0] == "packed") {
      initPackedPowerboxDescriptor(url, descriptor);
    } else {
      KJ_FAIL_REQUIRE("unsupported powerbox descriptor type", descriptorTypes[0]);
    }

    auto nativeInterface = nativeInterfaceFromPowerboxDescriptor(descriptor.asReader());
    KJ_IF_MAYBE(explicitNativeInterfaceValue, explicitNativeInterface) {
      if (nativeInterface != ClaimedCapabilityNativeInterface::UNKNOWN &&
          nativeInterface != *explicitNativeInterfaceValue) {
        KJ_FAIL_REQUIRE("nativeInterface conflicts with powerbox descriptor",
            claimedCapabilityNativeInterfaceName(*explicitNativeInterfaceValue),
            claimedCapabilityNativeInterfaceName(nativeInterface));
      }
      return *explicitNativeInterfaceValue;
    }
    return nativeInterface;
  }

  kj::Promise<void> claimPowerboxRequest(
      kj::StringPtr url, kj::HttpService::Response& response) {
    kj::String sessionId = nullptr;
    kj::String token = nullptr;
    KJ_IF_MAYBE(error, readSingleNonEmptyQueryParam(
        url, "sessionId", "expected exactly one sessionId and token", sessionId)) {
      return sendBadRequest(response, *error);
    }
    KJ_IF_MAYBE(error, readSingleNonEmptyQueryParam(
        url, "token", "expected exactly one sessionId and token", token)) {
      return sendBadRequest(response, *error);
    }
    auto nativeInterface = nativeInterfaceFromPowerboxDescriptorParams(url);

    auto viewInfo = config.viewInfoMessage->getRoot<UiView::ViewInfo>().asReader();
    auto permissionDefs = viewInfo.getPermissions();
    auto permissionNames = findIsolateQueryParams(url, "requiredPermission");
    for (auto& name: permissionNames) {
      if (name.size() == 0) {
        return sendJson(response, 400, "Bad Request",
            renderError("missing required permission name"));
      }
    }

    KJ_IF_MAYBE(sessionContext, host.sessions->findSessionContext(sessionId)) {
      auto request = sessionContext->claimRequestRequest();
      request.setRequestToken(token);
      auto requiredPermissions = request.initRequiredPermissions(permissionDefs.size());
      for (auto& name: permissionNames) {
        KJ_IF_MAYBE(error, setRequiredPermission(name, requiredPermissions, permissionDefs)) {
          return sendJson(response, 400, "Bad Request", renderError(*error));
        }
      }
      return request.send().then(
          [this, &response, nativeInterface](auto result) mutable {
        auto capId = host.sessions->storeClaimedCapability(
            result.getCap(), makeImportedClaimedCapabilityMetadata(
              ClaimedCapabilityKind::POWERBOX_CLAIM, nativeInterface));
        return sendJson(response, 200, "OK", renderClaimedCapability(capId));
      });
    } else {
      return sendJson(response, 404, "Not Found", kj::heapString(
          "{\n  \"ok\": false,\n  \"error\": \"unknown isolate session\"\n}\n"));
    }
  }

  kj::Maybe<kj::String> setRequiredPermission(
      kj::StringPtr name, capnp::List<bool>::Builder output,
      capnp::List<PermissionDef>::Reader permissionDefs) {
    if (name.size() == 0) {
      return kj::str("missing required permission name");
    }

    for (auto i: kj::indices(permissionDefs)) {
      if (permissionDefs[i].getName() == name) {
        output.set(i, true);
        return nullptr;
      }
    }

    kj::Vector<char> known;
    for (auto i: kj::indices(permissionDefs)) {
      if (i > 0) {
        known.addAll(kj::StringPtr(", "));
      }
      known.addAll(permissionDefs[i].getName());
    }
    if (permissionDefs.size() == 0) {
      known.addAll(kj::StringPtr("(none)"));
    }

    return kj::str("unknown required permission: ", name,
        "; this app defines permissions: ", known.asPtr(),
        ". requiredPermissions must use names from this app's viewInfo.permissions.");
  }

  kj::Promise<void> apiSessionPowerboxDescriptor(
      kj::StringPtr url, kj::HttpService::Response& response) {
    capnp::MallocMessageBuilder message;
    auto descriptor = message.initRoot<PowerboxDescriptor>();
    initApiSessionPowerboxDescriptor(url, descriptor);
    auto descriptorReader = descriptor.asReader();
    auto tag = descriptorReader.getTags()[0].getValue().getAs<ApiSession::PowerboxTag>();

    kj::VectorOutputStream output;
    capnp::writePackedMessage(output, message);
    auto packed = kj::encodeBase64Url(output.getArray());

    kj::Vector<char> json;
    json.addAll(kj::StringPtr("{\n  \"ok\": true,\n  "));
    appendJsonField(json, "type", "packedPowerboxDescriptor");
    json.addAll(kj::StringPtr(",\n  "));
    appendJsonField(json, "descriptor", packed);
    json.addAll(kj::StringPtr(",\n  \"decoded\": "));
    appendApiSessionDescriptorJson(json, tag);
    json.addAll(kj::StringPtr("\n}\n"));
    json.add('\0');
    return sendJson(response, 200, "OK", kj::String(json.releaseAsArray()));
  }

  kj::Promise<void> outboundHttpPowerboxDescriptor(
      kj::StringPtr url, kj::HttpService::Response& response) {
    capnp::MallocMessageBuilder message;
    auto descriptor = message.initRoot<PowerboxDescriptor>();
    initOutboundHttpPowerboxDescriptor(url, descriptor);
    auto descriptorReader = descriptor.asReader();
    auto tag = descriptorReader.getTags()[0].getValue().getAs<OutboundHttpSession::PowerboxTag>();

    kj::VectorOutputStream output;
    capnp::writePackedMessage(output, message);
    auto packed = kj::encodeBase64Url(output.getArray());

    kj::Vector<char> json;
    json.addAll(kj::StringPtr("{\n  \"ok\": true,\n  "));
    appendJsonField(json, "type", "packedPowerboxDescriptor");
    json.addAll(kj::StringPtr(",\n  "));
    appendJsonField(json, "descriptor", packed);
    json.addAll(kj::StringPtr(",\n  \"decoded\": "));
    appendOutboundHttpDescriptorJson(json, tag);
    json.addAll(kj::StringPtr("\n}\n"));
    json.add('\0');
    return sendJson(response, 200, "OK", kj::String(json.releaseAsArray()));
  }

  kj::String renderError(kj::StringPtr error) {
    kj::Vector<char> json;
    json.addAll(kj::StringPtr("{\n  \"ok\": false,\n  "));
    appendJsonField(json, "error", error);
    json.addAll(kj::StringPtr("\n}\n"));
    json.add('\0');
    return kj::String(json.releaseAsArray());
  }

  kj::String renderClaimedCapability(kj::StringPtr capabilityId) {
    kj::Vector<char> json;
    json.addAll(kj::StringPtr("{\n  \"ok\": true,\n  \"type\": \"claimedCapability\",\n  "));
    appendJsonField(json, "id", capabilityId);
    json.addAll(kj::StringPtr("\n}\n"));
    json.add('\0');
    return kj::String(json.releaseAsArray());
  }

  kj::String renderSavedCapability(kj::StringPtr capabilityId, kj::StringPtr token) {
    kj::Vector<char> json;
    json.addAll(kj::StringPtr("{\n  \"ok\": true,\n  \"type\": \"savedCapability\",\n  "));
    appendJsonField(json, "id", capabilityId);
    json.addAll(kj::StringPtr(",\n  "));
    appendJsonField(json, "token", token);
    json.addAll(kj::StringPtr(",\n  "));
    appendJsonField(json, "tokenEncoding", "base64url");
    json.addAll(kj::StringPtr("\n}\n"));
    json.add('\0');
    return kj::String(json.releaseAsArray());
  }

  kj::Maybe<kj::Array<byte>> decodeBase64UrlText(kj::StringPtr token, size_t maxSize) {
    if (token.size() == 0 || token.size() > maxSize || token.size() % 4 == 1) {
      return nullptr;
    }

    size_t padding = (4 - token.size() % 4) % 4;
    auto base64 = kj::heapArray<char>(token.size() + padding);
    for (auto i: kj::indices(token)) {
      char c = token[i];
      if (c >= 'A' && c <= 'Z') {
        base64[i] = c;
      } else if (c >= 'a' && c <= 'z') {
        base64[i] = c;
      } else if (c >= '0' && c <= '9') {
        base64[i] = c;
      } else if (c == '-') {
        base64[i] = '+';
      } else if (c == '_') {
        base64[i] = '/';
      } else {
        return nullptr;
      }
    }
    for (size_t i = token.size(); i < base64.size(); ++i) {
      base64[i] = '=';
    }

    auto decoded = kj::decodeBase64(base64.asPtr());
    if (decoded.hadErrors) {
      return nullptr;
    }

    return kj::mv(decoded);
  }

  kj::Maybe<kj::Array<byte>> decodeSavedCapabilityToken(kj::StringPtr token) {
    return decodeBase64UrlText(token, 4096);
  }

  struct DecodedSavedCapabilityToken {
    kj::Array<byte> sturdyRef;
    ClaimedCapabilityMetadata metadata;
  };

  kj::String encodeSavedCapabilityToken(
      kj::ArrayPtr<const byte> sturdyRef, kj::Maybe<ClaimedCapabilityMetadata>& metadata) {
    bool hasMetadataEnvelope = false;
    kj::StringPtr type = "unknown";
    kj::String pathPrefix = kj::heapString("");
    KJ_IF_MAYBE(info, metadata) {
      switch (info->nativeInterface) {
        case ClaimedCapabilityNativeInterface::WEB_SESSION:
          hasMetadataEnvelope = true;
          type = routeBackedCapabilityTypeToken(RouteBackedCapabilityType::WEB);
          break;
        case ClaimedCapabilityNativeInterface::API_SESSION:
          hasMetadataEnvelope = true;
          type = routeBackedCapabilityTypeToken(RouteBackedCapabilityType::API);
          break;
        case ClaimedCapabilityNativeInterface::APP_OBJECT:
          hasMetadataEnvelope = true;
          type = routeBackedCapabilityTypeToken(RouteBackedCapabilityType::OBJECT);
          break;
        case ClaimedCapabilityNativeInterface::OUTBOUND_HTTP_SESSION:
          hasMetadataEnvelope = true;
          type = "outboundHttp";
          break;
        case ClaimedCapabilityNativeInterface::UNKNOWN:
          break;
      }

      switch (info->kind) {
        case ClaimedCapabilityKind::ROUTE_BACKED_WEB_SESSION:
        case ClaimedCapabilityKind::ROUTE_BACKED_API_SESSION:
        case ClaimedCapabilityKind::ROUTE_BACKED_APP_OBJECT:
          pathPrefix = kj::heapString(info->pathPrefix);
          break;
        default:
          break;
      }
    }

    if (!hasMetadataEnvelope) {
      return kj::encodeBase64Url(sturdyRef);
    }

    auto encodedPathPrefix = kj::encodeBase64Url(pathPrefix.asBytes());
    auto encodedSturdyRef = kj::encodeBase64Url(sturdyRef);
    auto payload = kj::str(
        "isolate-saved-capability-v1\n",
        type, "\n",
        encodedPathPrefix, "\n",
        encodedSturdyRef);
    return kj::encodeBase64Url(payload.asBytes());
  }

  kj::Maybe<kj::StringPtr> consumeLine(kj::StringPtr& text) {
    KJ_IF_MAYBE(newline, text.findFirst('\n')) {
      auto line = kj::StringPtr(text.begin(), *newline);
      text = kj::StringPtr(text.begin() + *newline + 1, text.size() - *newline - 1);
      return line;
    } else {
      return nullptr;
    }
  }

  kj::Maybe<DecodedSavedCapabilityToken> decodeSavedCapabilityEnvelope(kj::StringPtr token) {
    KJ_IF_MAYBE(decoded, decodeSavedCapabilityToken(token)) {
      auto text = kj::StringPtr(decoded->asChars().begin(), decoded->size());
      KJ_IF_MAYBE(version, consumeLine(text)) {
        if (*version != "isolate-saved-capability-v1") {
          return DecodedSavedCapabilityToken {
            kj::mv(*decoded),
            makeImportedClaimedCapabilityMetadata(ClaimedCapabilityKind::RESTORED),
          };
        }
      } else {
        return DecodedSavedCapabilityToken {
          kj::mv(*decoded),
          makeImportedClaimedCapabilityMetadata(ClaimedCapabilityKind::RESTORED),
        };
      }

      kj::StringPtr type;
      KJ_IF_MAYBE(parsedType, consumeLine(text)) {
        type = *parsedType;
      } else {
        return nullptr;
      }

      kj::StringPtr encodedPathPrefix;
      KJ_IF_MAYBE(parsedPathPrefix, consumeLine(text)) {
        encodedPathPrefix = *parsedPathPrefix;
      } else {
        return nullptr;
      }

      kj::Array<byte> pathPrefixBytes = nullptr;
      if (encodedPathPrefix.size() == 0) {
        pathPrefixBytes = kj::heapArray<byte>(0);
      } else KJ_IF_MAYBE(decodedPathPrefix, decodeBase64UrlText(encodedPathPrefix, 2048)) {
        pathPrefixBytes = kj::mv(*decodedPathPrefix);
      } else {
        return nullptr;
      }

      KJ_IF_MAYBE(sturdyRef, decodeBase64UrlText(text, 4096)) {
        auto pathPrefixText = kj::StringPtr(
            pathPrefixBytes.asChars().begin(), pathPrefixBytes.size());
        auto pathPrefix = normalizeRouteBackedPathPrefix(pathPrefixText);

        ClaimedCapabilityNativeInterface nativeInterface =
            ClaimedCapabilityNativeInterface::UNKNOWN;
        if (type == routeBackedCapabilityTypeToken(RouteBackedCapabilityType::WEB)) {
          nativeInterface = ClaimedCapabilityNativeInterface::WEB_SESSION;
        } else if (type == routeBackedCapabilityTypeToken(RouteBackedCapabilityType::API)) {
          nativeInterface = ClaimedCapabilityNativeInterface::API_SESSION;
        } else if (type == routeBackedCapabilityTypeToken(RouteBackedCapabilityType::OBJECT)) {
          nativeInterface = ClaimedCapabilityNativeInterface::APP_OBJECT;
        } else if (type == "outboundHttp") {
          nativeInterface = ClaimedCapabilityNativeInterface::OUTBOUND_HTTP_SESSION;
        } else if (type != "unknown") {
          return nullptr;
        }

        return DecodedSavedCapabilityToken {
          kj::mv(*sturdyRef),
          ClaimedCapabilityMetadata {
            ClaimedCapabilityKind::RESTORED,
            ClaimedCapabilityResidence::IMPORTED,
            nativeInterface,
            kj::mv(pathPrefix),
            true,
            false,
            true,
            true,
          },
        };
      }
    }

    return nullptr;
  }

  kj::Promise<void> offerClaimedCapability(
      kj::StringPtr url, kj::HttpService::Response& response) {
    kj::String sessionId = nullptr;
    kj::String id = nullptr;
    kj::Array<kj::String> titles = nullptr;
    KJ_IF_MAYBE(error, readSingleNonEmptyQueryParam(
        url, "sessionId", "expected exactly one sessionId and capability id", sessionId)) {
      return sendBadRequest(response, *error);
    }
    KJ_IF_MAYBE(error, readSingleNonEmptyQueryParam(
        url, "id", "expected exactly one sessionId and capability id", id)) {
      return sendBadRequest(response, *error);
    }
    KJ_IF_MAYBE(error, readAtMostOneQueryParam(
        url, "title", "expected exactly one sessionId and capability id", titles)) {
      return sendBadRequest(response, *error);
    }

    KJ_IF_MAYBE(sessionContext, host.sessions->findSessionContext(sessionId)) {
      KJ_IF_MAYBE(cap, host.sessions->findClaimedCapability(id)) {
        auto request = sessionContext->offerRequest();
        request.setCap(*cap);
        initSessionActionParamsWithDescriptor(url, titles, request.initRequiredPermissions(
            config.viewInfoMessage->getRoot<UiView::ViewInfo>().getPermissions().size()),
            request.initDescriptor(), request.initDisplayInfo());
        return request.send().then([this, &response](auto result) mutable {
          (void)result;
          return sendJson(response, 200, "OK", kj::heapString("{\n  \"ok\": true\n}\n"));
        });
      } else {
        return sendJson(response, 404, "Not Found", kj::heapString(
            "{\n  \"ok\": false,\n  \"error\": \"unknown claimed capability\"\n}\n"));
      }
    } else {
      return sendJson(response, 404, "Not Found", kj::heapString(
          "{\n  \"ok\": false,\n  \"error\": \"unknown isolate session\"\n}\n"));
    }
  }

  kj::Promise<void> fulfillRequestWithCapability(
      kj::StringPtr url, kj::HttpService::Response& response) {
    kj::String sessionId = nullptr;
    kj::String id = nullptr;
    kj::Array<kj::String> titles = nullptr;
    KJ_IF_MAYBE(error, readSingleNonEmptyQueryParam(
        url, "sessionId", "expected exactly one sessionId and capability id", sessionId)) {
      return sendBadRequest(response, *error);
    }
    KJ_IF_MAYBE(error, readSingleNonEmptyQueryParam(
        url, "id", "expected exactly one sessionId and capability id", id)) {
      return sendBadRequest(response, *error);
    }
    KJ_IF_MAYBE(error, readAtMostOneQueryParam(
        url, "title", "expected exactly one sessionId and capability id", titles)) {
      return sendBadRequest(response, *error);
    }

    KJ_IF_MAYBE(sessionContext, host.sessions->findSessionContext(sessionId)) {
      KJ_IF_MAYBE(cap, host.sessions->findClaimedCapability(id)) {
        auto request = sessionContext->fulfillRequestRequest();
        request.setCap(*cap);
        initSessionActionParamsWithDescriptor(url, titles, request.initRequiredPermissions(
            config.viewInfoMessage->getRoot<UiView::ViewInfo>().getPermissions().size()),
            request.initDescriptor(), request.initDisplayInfo());
        return request.send().then([this, &response](auto result) mutable {
          (void)result;
          return sendJson(response, 200, "OK", kj::heapString("{\n  \"ok\": true\n}\n"));
        });
      } else {
        return sendJson(response, 404, "Not Found", kj::heapString(
            "{\n  \"ok\": false,\n  \"error\": \"unknown claimed capability\"\n}\n"));
      }
    } else {
      return sendJson(response, 404, "Not Found", kj::heapString(
          "{\n  \"ok\": false,\n  \"error\": \"unknown isolate session\"\n}\n"));
    }
  }

  kj::Promise<void> tieClaimedCapabilityToUser(
      kj::StringPtr url, kj::HttpService::Response& response) {
    kj::String sessionId = nullptr;
    kj::String id = nullptr;
    kj::Array<kj::String> titles = nullptr;
    KJ_IF_MAYBE(error, readSingleNonEmptyQueryParam(
        url, "sessionId", "expected exactly one sessionId and capability id", sessionId)) {
      return sendBadRequest(response, *error);
    }
    KJ_IF_MAYBE(error, readSingleNonEmptyQueryParam(
        url, "id", "expected exactly one sessionId and capability id", id)) {
      return sendBadRequest(response, *error);
    }
    KJ_IF_MAYBE(error, readAtMostOneQueryParam(
        url, "title", "expected exactly one sessionId and capability id", titles)) {
      return sendBadRequest(response, *error);
    }

    KJ_IF_MAYBE(sessionContext, host.sessions->findSessionContext(sessionId)) {
      KJ_IF_MAYBE(cap, host.sessions->findClaimedCapability(id)) {
        auto request = sessionContext->tieToUserRequest();
        request.setCap(*cap);
        auto viewInfo = config.viewInfoMessage->getRoot<UiView::ViewInfo>().asReader();
        initSessionActionParams(url, titles,
            request.initRequiredPermissions(viewInfo.getPermissions().size()),
            request.initDisplayInfo());
        return request.send().then([this, &response](auto result) mutable {
          auto capId = host.sessions->storeClaimedCapability(
              result.getTiedCap(), makeImportedClaimedCapabilityMetadata(
                ClaimedCapabilityKind::TIED));
          return sendJson(response, 200, "OK", renderClaimedCapability(capId));
        });
      } else {
        return sendJson(response, 404, "Not Found", kj::heapString(
            "{\n  \"ok\": false,\n  \"error\": \"unknown claimed capability\"\n}\n"));
      }
    } else {
      return sendJson(response, 404, "Not Found", kj::heapString(
          "{\n  \"ok\": false,\n  \"error\": \"unknown isolate session\"\n}\n"));
    }
  }

  void initSessionActionParams(kj::StringPtr url, kj::ArrayPtr<kj::String> titles,
      capnp::List<bool>::Builder requiredPermissions,
      PowerboxDisplayInfo::Builder displayInfo) {
    auto viewInfo = config.viewInfoMessage->getRoot<UiView::ViewInfo>().asReader();
    auto permissionDefs = viewInfo.getPermissions();
    auto permissionNames = findIsolateQueryParams(url, "requiredPermission");
    for (auto& name: permissionNames) {
      KJ_REQUIRE(name.size() > 0, "missing required permission name");
      KJ_IF_MAYBE(error, setRequiredPermission(name, requiredPermissions, permissionDefs)) {
        KJ_FAIL_REQUIRE(*error);
      }
    }

    auto title = titles.size() == 1 && titles[0].size() > 0
        ? titles[0].asPtr()
        : kj::StringPtr("Claimed Sandstorm capability");
    displayInfo.initTitle().setDefaultText(title);

    auto verbPhrases = findIsolateQueryParams(url, "verbPhrase");
    KJ_REQUIRE(verbPhrases.size() <= 1, "expected at most one verbPhrase");
    if (verbPhrases.size() == 1 && verbPhrases[0].size() > 0) {
      KJ_REQUIRE(verbPhrases[0].size() <= 1024, "verbPhrase is too long");
      displayInfo.initVerbPhrase().setDefaultText(verbPhrases[0]);
    }

    auto descriptions = findIsolateQueryParams(url, "description");
    KJ_REQUIRE(descriptions.size() <= 1, "expected at most one description");
    if (descriptions.size() == 1 && descriptions[0].size() > 0) {
      KJ_REQUIRE(descriptions[0].size() <= 1024, "description is too long");
      displayInfo.initDescription().setDefaultText(descriptions[0]);
    }
  }

  void initSessionActionParamsWithDescriptor(kj::StringPtr url, kj::ArrayPtr<kj::String> titles,
      capnp::List<bool>::Builder requiredPermissions,
      PowerboxDescriptor::Builder descriptor, PowerboxDisplayInfo::Builder displayInfo) {
    initSessionActionParams(url, titles, requiredPermissions, displayInfo);

    auto descriptorTypes = findIsolateQueryParams(url, "descriptor");
    KJ_REQUIRE(descriptorTypes.size() <= 1,
        "expected at most one powerbox descriptor type");
    if (descriptorTypes.size() == 0 || descriptorTypes[0].size() == 0) {
      descriptor.initTags(0);
      return;
    }

    if (descriptorTypes[0] == "apiSession") {
      initApiSessionPowerboxDescriptor(url, descriptor);
    } else if (descriptorTypes[0] == "outboundHttp") {
      initOutboundHttpPowerboxDescriptor(url, descriptor);
    } else if (descriptorTypes[0] == "packed") {
      initPackedPowerboxDescriptor(url, descriptor);
    } else {
      KJ_FAIL_REQUIRE("unsupported powerbox descriptor type", descriptorTypes[0]);
    }
  }

  void initPackedPowerboxDescriptor(
      kj::StringPtr url, PowerboxDescriptor::Builder descriptor) {
    auto packedDescriptors = findIsolateQueryParams(url, "packedPowerboxDescriptor");
    KJ_REQUIRE(packedDescriptors.size() == 1 && packedDescriptors[0].size() > 0,
        "packed descriptor requires exactly one packedPowerboxDescriptor");

    KJ_IF_MAYBE(decoded, decodeBase64UrlText(packedDescriptors[0], 65536)) {
      kj::ArrayInputStream input(decoded->asPtr());
      capnp::PackedMessageReader reader(input);
      descriptor.setTags(reader.getRoot<PowerboxDescriptor>().getTags());
    } else {
      KJ_FAIL_REQUIRE("invalid packed Powerbox descriptor");
    }
  }

  void initApiSessionPowerboxDescriptor(
      kj::StringPtr url, PowerboxDescriptor::Builder descriptor) {
    auto canonicalUrls = findIsolateQueryParams(url, "apiCanonicalUrl");
    KJ_REQUIRE(canonicalUrls.size() == 1 && canonicalUrls[0].size() > 0,
        "apiSession descriptor requires exactly one canonicalUrl");
    KJ_REQUIRE(canonicalUrls[0].size() <= 2048,
        "apiSession descriptor canonicalUrl is too long");
    KJ_REQUIRE(!canonicalUrls[0].endsWith("/"),
        "apiSession descriptor canonicalUrl must not end with '/'");

    auto tag = descriptor.initTags(1)[0];
    tag.setId(capnp::typeId<ApiSession>());
    auto value = tag.initValue().initAs<ApiSession::PowerboxTag>();
    value.setCanonicalUrl(canonicalUrls[0]);

    auto oauthScopes = findIsolateQueryParams(url, "apiOauthScope");
    auto scopes = value.initOauthScopes(oauthScopes.size());
    for (auto i: kj::indices(oauthScopes)) {
      KJ_REQUIRE(oauthScopes[i].size() > 0 && oauthScopes[i].size() <= 256,
          "apiSession descriptor OAuth scope must be 1-256 bytes");
      scopes[i].setName(oauthScopes[i]);
    }
  }

  void initOutboundHttpPowerboxDescriptor(
      kj::StringPtr url, PowerboxDescriptor::Builder descriptor) {
    auto baseUrls = findIsolateQueryParams(url, "outboundHttpBaseUrl");
    KJ_REQUIRE(baseUrls.size() == 1 && baseUrls[0].size() > 0,
        "outboundHttp descriptor requires exactly one baseUrl");
    KJ_REQUIRE(baseUrls[0].size() <= 2048,
        "outboundHttp descriptor baseUrl is too long");

    auto tag = descriptor.initTags(1)[0];
    tag.setId(capnp::typeId<OutboundHttpSession>());
    auto value = tag.initValue().initAs<OutboundHttpSession::PowerboxTag>();
    value.setBaseUrl(baseUrls[0]);

    auto methodNames = findIsolateQueryParams(url, "outboundHttpMethod");
    auto methods = value.initMethods(methodNames.size());
    for (auto i: kj::indices(methodNames)) {
      KJ_REQUIRE(methodNames[i].size() > 0,
          "outboundHttp descriptor method must not be empty");
      KJ_IF_MAYBE(method, parseOutboundHttpMethod(methodNames[i])) {
        methods.set(i, *method);
      } else {
        KJ_FAIL_REQUIRE("unsupported outboundHttp method", methodNames[i]);
      }
    }
  }

  kj::Promise<void> savePowerboxCapability(
      kj::StringPtr url, kj::HttpService::Response& response) {
    kj::String id = nullptr;
    kj::Array<kj::String> labels = nullptr;
    KJ_IF_MAYBE(error, readSingleNonEmptyQueryParam(
        url, "id", "expected exactly one capability id", id)) {
      return sendBadRequest(response, *error);
    }
    KJ_IF_MAYBE(error, readAtMostOneQueryParam(
        url, "label", "expected at most one save label", labels)) {
      return sendBadRequest(response, *error);
    }

    kj::StringPtr label = "Claimed Sandstorm capability";
    if (labels.size() == 1) {
      label = labels[0];
      if (label.size() == 0 || label.size() > 256) {
        return sendBadRequest(response, "save label must be 1-256 bytes");
      }
    }

    KJ_IF_MAYBE(cap, host.sessions->findClaimedCapability(id)) {
      auto metadata = host.sessions->findClaimedCapabilityMetadata(id);
      auto request = cap->castAs<SystemPersistent>().saveRequest();
      auto owner = request.getSealFor().initGrain();
      owner.setGrainId(host.grainId);
      owner.getSaveLabel().setDefaultText(label);
      return request.send().then(
          [this, &response, capabilityId = kj::mv(id), metadata = kj::mv(metadata)]
          (auto result) mutable {
        auto token = encodeSavedCapabilityToken(result.getSturdyRef(), metadata);
        return sendJson(response, 200, "OK", renderSavedCapability(capabilityId, token));
      });
    } else {
      return sendJson(response, 404, "Not Found", kj::heapString(
          "{\n  \"ok\": false,\n  \"error\": \"unknown claimed capability\"\n}\n"));
    }
  }

  kj::Promise<void> restorePowerboxCapability(
      kj::StringPtr url, kj::HttpService::Response& response) {
    kj::String tokenParam = nullptr;
    KJ_IF_MAYBE(error, readSingleNonEmptyQueryParam(
        url, "token", "expected exactly one saved capability token", tokenParam)) {
      return sendBadRequest(response, *error);
    }

    KJ_IF_MAYBE(token, decodeSavedCapabilityEnvelope(tokenParam)) {
      auto request = host.sandstormCore.restoreRequest();
      request.setToken(token->sturdyRef.asPtr());
      return request.send().then(
          [this, &response, metadata = kj::mv(token->metadata)](auto result) mutable {
        auto capId = host.sessions->storeClaimedCapability(
            result.getCap(), kj::mv(metadata));
        return sendJson(response, 200, "OK", renderClaimedCapability(capId));
      });
    } else {
      return sendBadRequest(response, "invalid saved capability token");
    }
  }

  kj::Promise<void> duplicatePowerboxCapability(
      kj::StringPtr url, kj::HttpService::Response& response) {
    kj::String id = nullptr;
    KJ_IF_MAYBE(error, readSingleNonEmptyQueryParam(
        url, "id", "expected exactly one capability id", id)) {
      return sendBadRequest(response, *error);
    }

    KJ_IF_MAYBE(metadata, host.sessions->findClaimedCapabilityMetadata(id)) {
      if (metadata->nativeInterface == ClaimedCapabilityNativeInterface::APP_OBJECT) {
        KJ_IF_MAYBE(cap, host.sessions->findClaimedCapability(id)) {
          auto request = cap->castAs<IsolateObjectCapability>().dupRequest();
          return request.send().then([this, &response](auto result) mutable {
            auto capId = host.sessions->storeClaimedCapability(
                result.getCapability(),
                makeImportedClaimedCapabilityMetadata(
                  ClaimedCapabilityKind::UNKNOWN, ClaimedCapabilityNativeInterface::APP_OBJECT));
            return sendJson(response, 200, "OK", renderClaimedCapability(capId));
          });
        }
      }
    }

    KJ_IF_MAYBE(duplicatedId, host.sessions->duplicateClaimedCapability(id)) {
      return sendJson(response, 200, "OK", renderClaimedCapability(*duplicatedId));
    } else {
      return sendJson(response, 404, "Not Found", kj::heapString(
          "{\n  \"ok\": false,\n  \"error\": \"unknown claimed capability\"\n}\n"));
    }
  }

  kj::Promise<void> dropSavedPowerboxCapability(
      kj::StringPtr url, kj::HttpService::Response& response) {
    kj::String tokenParam = nullptr;
    KJ_IF_MAYBE(error, readSingleNonEmptyQueryParam(
        url, "token", "expected exactly one saved capability token", tokenParam)) {
      return sendBadRequest(response, *error);
    }

    KJ_IF_MAYBE(token, decodeSavedCapabilityEnvelope(tokenParam)) {
      auto request = host.sandstormCore.dropRequest();
      request.setToken(token->sturdyRef.asPtr());
      return request.send().then(
          [this, &response](auto result) mutable {
        (void)result;
        return sendJson(response, 200, "OK", kj::heapString("{\n  \"ok\": true\n}\n"));
      });
    } else {
      return sendBadRequest(response, "invalid saved capability token");
    }
  }

  kj::Promise<void> notifyDroppedClaimedCapability(kj::String dropNotifyPath) {
    FetchRequest request;
    request.method = FetchMethod::POST;
    request.path = toHttpRequestTarget(kj::str(dropNotifyPath, "/__sandstorm_dispose"));
    addHeader(request, "host", "sandbox");
    addHeader(request, "content-type", "application/json; charset=utf-8");
    auto body = kj::StringPtr("{}");
    request.body = kj::heapArray<byte>(body.asBytes());

    auto runtime = kj::heap<WorkerdRuntimeAdapter>(kj::addRef(config), kj::addRef(host));
    return runtime->fetch(kj::mv(request))
        .then([runtime = kj::mv(runtime), dropNotifyPath = kj::mv(dropNotifyPath)](
            FetchResponse&& result) mutable {
      if (result.statusCode < 200 || result.statusCode >= 300) {
        KJ_LOG(WARNING, "Isolate claimed capability drop notification failed.",
            dropNotifyPath, result.statusCode);
      }
    });
  }

  kj::Promise<void> dropPowerboxCapability(
      kj::StringPtr url, kj::HttpService::Response& response) {
    kj::String id = nullptr;
    KJ_IF_MAYBE(error, readSingleNonEmptyQueryParam(
        url, "id", "expected exactly one capability id", id)) {
      return sendBadRequest(response, *error);
    }

    KJ_IF_MAYBE(dropped, host.sessions->dropClaimedCapability(id)) {
      KJ_IF_MAYBE(dropNotifyPath, dropped->dropNotifyPath) {
        return notifyDroppedClaimedCapability(kj::mv(*dropNotifyPath))
            .catch_([](kj::Exception&& exception) {
          KJ_LOG(WARNING, "Isolate claimed capability drop notification threw.", exception);
        }).then([this, &response]() mutable {
          return sendJson(response, 200, "OK", kj::heapString(
              "{\n  \"ok\": true,\n  \"released\": true\n}\n"));
        });
      } else if (dropped->metadata.nativeInterface == ClaimedCapabilityNativeInterface::APP_OBJECT &&
          dropped->metadata.hasDropNotify) {
        return sendJson(response, 200, "OK", kj::heapString(
            "{\n  \"ok\": true,\n  \"released\": false\n}\n"));
      } else if (dropped->metadata.nativeInterface == ClaimedCapabilityNativeInterface::APP_OBJECT) {
        auto req = dropped->cap.castAs<IsolateObjectCapability>().dropRequest();
        return req.send().then([this, &response](auto result) mutable {
          return sendJson(response, 200, "OK", kj::str(
              "{\n  \"ok\": true,\n  \"released\": ",
              result.getReleased() ? "true" : "false",
              "\n}\n"));
        }).catch_([this, &response](kj::Exception&& exception) {
          KJ_LOG(WARNING, "Isolate object capability drop threw.", exception);
          return sendJson(response, 200, "OK", kj::heapString(
              "{\n  \"ok\": true,\n  \"released\": false\n}\n"));
        });
      } else {
        return sendJson(response, 200, "OK", kj::heapString(
            "{\n  \"ok\": true,\n  \"released\": false\n}\n"));
      }
    } else {
      return sendJson(response, 404, "Not Found", kj::heapString(
          "{\n  \"ok\": false,\n  \"error\": \"unknown claimed capability\"\n}\n"));
    }
  }

  kj::String renderRuntime() {
    kj::Vector<char> json;
    json.addAll(kj::StringPtr("{\n  \"ok\": true,\n  \"binding\": \"sandstormApi\",\n  "));
    appendJsonField(json, "mainModule", config.mainModule);
    json.addAll(kj::StringPtr(",\n  "));
    appendJsonField(json, "compatibilityDate", config.compatibilityDate);
    json.addAll(kj::StringPtr(",\n  \"compatibilityFlags\": ["));
    for (auto i: kj::indices(config.compatibilityFlags)) {
      if (i > 0) json.addAll(kj::StringPtr(", "));
      appendJsonString(json, config.compatibilityFlags[i]);
    }
    json.addAll(kj::StringPtr("],\n  \"moduleCount\": "));
    json.addAll(kj::str(config.modules.size()));
    json.addAll(kj::StringPtr(",\n  \"bindingCount\": "));
    json.addAll(kj::str(config.bindings.size()));
    json.addAll(kj::StringPtr("\n}\n"));
    json.add('\0');
    return kj::String(json.releaseAsArray());
  }

  kj::String renderModules() {
    kj::Vector<char> json;
    json.addAll(kj::StringPtr("{\n  \"ok\": true,\n  \"modules\": [\n"));
    for (auto i: kj::indices(config.modules)) {
      if (i > 0) json.addAll(kj::StringPtr(",\n"));
      json.addAll(kj::StringPtr("    { "));
      appendJsonField(json, "name", config.modules[i].name);
      json.addAll(kj::StringPtr(", "));
      appendJsonField(json, "type", moduleTypeName(config.modules[i].type));
      json.addAll(kj::StringPtr(", \"main\": "));
      json.addAll(config.modules[i].name == config.mainModule
          ? kj::StringPtr("true") : kj::StringPtr("false"));
      json.addAll(kj::StringPtr(" }"));
    }
    json.addAll(kj::StringPtr("\n  ]\n}\n"));
    json.add('\0');
    return kj::String(json.releaseAsArray());
  }

  kj::String renderBindings() {
    kj::Vector<char> json;
    json.addAll(kj::StringPtr("{\n  \"ok\": true,\n  \"bindings\": [\n"));
    for (auto i: kj::indices(config.bindings)) {
      if (i > 0) json.addAll(kj::StringPtr(",\n"));
      json.addAll(kj::StringPtr("    { "));
      appendJsonField(json, "name", config.bindings[i].name);
      json.addAll(kj::StringPtr(", "));
      appendJsonField(json, "type", bindingTypeName(config.bindings[i].type));
      json.addAll(kj::StringPtr(", \"workerdDirect\": "));
      json.addAll(isWorkerdDirectBinding(config.bindings[i])
          ? kj::StringPtr("true") : kj::StringPtr("false"));
      if (config.bindings[i].serviceName.size() > 0) {
        json.addAll(kj::StringPtr(", "));
        appendJsonField(json, "serviceName", config.bindings[i].serviceName);
      }
      json.addAll(kj::StringPtr(" }"));
    }
    json.addAll(kj::StringPtr("\n  ]\n}\n"));
    json.add('\0');
    return kj::String(json.releaseAsArray());
  }
};

class StorageBindingService final: public kj::HttpService {
public:
  StorageBindingService(kj::HttpHeaderTable& headerTable, IsolateRuntimeConfig& config)
      : headerTable(headerTable), config(config) {}

  kj::Promise<void> request(
      kj::HttpMethod method, kj::StringPtr url, const kj::HttpHeaders& headers,
      kj::AsyncInputStream& requestBody, kj::HttpService::Response& response) override {
    (void)headers;
    auto key = isolateStorageKeyFromUrl(url);
    KJ_LOG(WARNING, "Isolate storage binding received request.", kj::str(method), key);

    if (method == kj::HttpMethod::GET && key.size() == 0) {
      return sendJson(response, 200, "OK", renderIndex());
    }

    if (!isValidIsolateStorageKey(key)) {
      return sendJson(response, 400, "Bad Request", kj::heapString(
          "{\n  \"ok\": false,\n  \"error\": \"invalid storage key\"\n}\n"));
    }

    auto path = kj::str(config.storageRootPath, "/", key);
    switch (method) {
      case kj::HttpMethod::GET:
        return get(kj::mv(path), response);
      case kj::HttpMethod::HEAD:
        return head(kj::mv(path), response);
      case kj::HttpMethod::PUT:
        return readAllBytesAtMost(requestBody, MAX_STORAGE_VALUE_BYTES,
            "isolate storage value exceeds maximum allowed size")
            .then([this, key = kj::mv(key), path = kj::mv(path), &response]
                (kj::Array<byte>&& body) mutable {
          if (!storagePathIsMissingOrRegular(path)) {
            return sendJson(response, 409, "Conflict", kj::heapString(
                "{\n  \"ok\": false,\n"
                "  \"error\": \"storage key is blocked by a non-regular file\"\n}\n"));
          }

          writeStorageFile(path, key, body);
          return sendJson(response, 200, "OK", renderStored(body.size()));
        });
      case kj::HttpMethod::DELETE:
        return deleteStorageFile(kj::mv(path), response);
      default:
        return sendJson(response, 405, "Method Not Allowed", kj::heapString(
            "{\n  \"ok\": false,\n  \"error\": \"method not allowed\"\n}\n"));
    }
  }

private:
  static constexpr size_t MAX_STORAGE_VALUE_BYTES = 1024 * 1024;

  enum class StoragePathState {
    MISSING,
    REGULAR,
    NON_REGULAR,
  };

  kj::HttpHeaderTable& headerTable;
  IsolateRuntimeConfig& config;

  kj::Promise<void> sendJson(kj::HttpService::Response& response, uint statusCode,
      kj::StringPtr statusText, kj::String body) {
    kj::HttpHeaders responseHeaders(headerTable);
    responseHeaders.set(kj::HttpHeaderId::CONTENT_TYPE, "application/json; charset=utf-8");
    auto stream = response.send(statusCode, statusText, responseHeaders, body.size());
    auto promise = stream->write(body.begin(), body.size());
    return promise.attach(kj::mv(stream), kj::mv(body));
  }

  kj::Promise<void> get(kj::String path, kj::HttpService::Response& response) {
    KJ_IF_MAYBE(fd, openStorageFileIfExists(path)) {
      auto body = readAllBytes(*fd);
      kj::HttpHeaders responseHeaders(headerTable);
      responseHeaders.set(kj::HttpHeaderId::CONTENT_TYPE, "application/octet-stream");
      auto stream = response.send(200, "OK", responseHeaders, body.size());
      auto promise = stream->write(body.begin(), body.size());
      return promise.attach(kj::mv(stream), kj::mv(body), kj::mv(path));
    }

    return sendJson(response, 404, "Not Found", kj::heapString(
        "{\n  \"ok\": false,\n  \"error\": \"storage key not found\"\n}\n"));
  }

  kj::Promise<void> head(kj::String path, kj::HttpService::Response& response) {
    KJ_IF_MAYBE(fd, openStorageFileIfExists(path)) {
      struct stat stats;
      KJ_SYSCALL(fstat(*fd, &stats));
      kj::HttpHeaders responseHeaders(headerTable);
      responseHeaders.set(kj::HttpHeaderId::CONTENT_TYPE, "application/octet-stream");
      responseHeaders.add("X-Sandstorm-Storage-Bytes", kj::str(stats.st_size));
      response.send(200, "OK", responseHeaders, uint64_t(0));
      return kj::READY_NOW;
    }

    kj::HttpHeaders responseHeaders(headerTable);
    response.send(404, "Not Found", responseHeaders, uint64_t(0));
    return kj::READY_NOW;
  }

  kj::Maybe<kj::AutoCloseFd> openStorageFileIfExists(kj::StringPtr path) {
    int fd = open(path.cStr(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd == -1) {
      int error = errno;
      if (error == ENOENT || error == ENOTDIR || error == ELOOP) {
        return nullptr;
      }

      KJ_FAIL_SYSCALL("open", error, path);
    }

    kj::AutoCloseFd result(fd);
    struct stat stats;
    KJ_SYSCALL(fstat(result.get(), &stats), path);
    if (!S_ISREG(stats.st_mode)) {
      return nullptr;
    }

    return kj::mv(result);
  }

  StoragePathState inspectStoragePath(kj::StringPtr path) {
    struct stat stats;
    if (lstat(path.cStr(), &stats) != 0) {
      int error = errno;
      if (error == ENOENT || error == ENOTDIR) {
        return StoragePathState::MISSING;
      }

      KJ_FAIL_SYSCALL("lstat", error, path);
    }

    return S_ISREG(stats.st_mode) ? StoragePathState::REGULAR : StoragePathState::NON_REGULAR;
  }

  bool storagePathIsMissingOrRegular(kj::StringPtr path) {
    return inspectStoragePath(path) != StoragePathState::NON_REGULAR;
  }

  kj::Promise<void> deleteStorageFile(kj::String path, kj::HttpService::Response& response) {
    switch (inspectStoragePath(path)) {
      case StoragePathState::MISSING:
        return sendJson(response, 200, "OK", kj::heapString("{\n  \"ok\": true\n}\n"));
      case StoragePathState::REGULAR:
        KJ_SYSCALL(unlink(path.cStr()), path);
        return sendJson(response, 200, "OK", kj::heapString("{\n  \"ok\": true\n}\n"));
      case StoragePathState::NON_REGULAR:
        return sendJson(response, 409, "Conflict", kj::heapString(
            "{\n  \"ok\": false,\n"
            "  \"error\": \"storage key is blocked by a non-regular file\"\n}\n"));
    }

    KJ_UNREACHABLE;
  }

  void writeStorageFile(kj::StringPtr path, kj::StringPtr key, kj::ArrayPtr<const byte> content) {
    auto tmpPath = kj::str(config.storageRootPath, "/.tmp-", getpid(), "-", key);
    switch (inspectStoragePath(tmpPath)) {
      case StoragePathState::MISSING:
        break;
      case StoragePathState::REGULAR:
        KJ_SYSCALL(unlink(tmpPath.cStr()), tmpPath);
        break;
      case StoragePathState::NON_REGULAR:
        KJ_FAIL_REQUIRE("refusing to replace non-regular temporary storage file", tmpPath);
    }

    int fd;
    KJ_SYSCALL(fd = open(tmpPath.cStr(),
        O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0660), tmpPath);
    KJ_DEFER(close(fd));
    writeAllToFd(fd, content);
    KJ_SYSCALL(fsync(fd), tmpPath);
    KJ_SYSCALL(rename(tmpPath.cStr(), path.cStr()), tmpPath, path);

    auto dirFd = raiiOpen(config.storageRootPath, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    KJ_SYSCALL(fsync(dirFd), config.storageRootPath);
  }

  kj::String renderStored(size_t bytes) {
    return kj::str("{\n  \"ok\": true,\n  \"bytes\": ", bytes, "\n}\n");
  }

  kj::String renderIndex() {
    auto files = listDirectory(config.storageRootPath);
    kj::Vector<char> json;
    json.addAll(kj::StringPtr("{\n  \"ok\": true,\n  \"keys\": ["));
    uint64_t totalBytes = 0;
    bool first = true;
    for (auto& file: files) {
      if (!isValidIsolateStorageKey(file)) {
        continue;
      }

      auto path = kj::str(config.storageRootPath, "/", file);
      KJ_IF_MAYBE(fd, openStorageFileIfExists(path)) {
        struct stat stats;
        KJ_SYSCALL(fstat(*fd, &stats));

        totalBytes += static_cast<uint64_t>(stats.st_size);
        if (!first) json.addAll(kj::StringPtr(", "));
        json.addAll(kj::StringPtr("{ "));
        appendJsonField(json, "name", file);
        json.addAll(kj::StringPtr(", \"bytes\": "));
        json.addAll(kj::str(stats.st_size));
        json.addAll(kj::StringPtr(" }"));
        first = false;
      }
    }
    json.addAll(kj::StringPtr("],\n  \"totalBytes\": "));
    json.addAll(kj::str(totalBytes));
    json.addAll(kj::StringPtr("\n}\n"));
    json.add('\0');
    return kj::String(json.releaseAsArray());
  }
};

class IsolateSupervisorImpl final: public Supervisor::Server {
public:
  IsolateSupervisorImpl(
      kj::UnixEventPort& eventPort, kj::StringPtr varPath, kj::Own<CapRedirector> coreRedirector,
      kj::Own<IsolateRuntimeConfig> runtimeConfig, kj::Own<IsolateRuntimeHost> runtimeHost,
      kj::Own<WorkerdSidecarProcess> sidecar, SandstormCore::Client sandstormCore)
      : eventPort(eventPort), varPath(kj::heapString(varPath)), coreRedirector(kj::mv(coreRedirector)),
        runtimeConfig(kj::mv(runtimeConfig)), runtimeHost(kj::mv(runtimeHost)),
        sidecar(kj::mv(sidecar)), sandstormCore(kj::mv(sandstormCore)) {}

  kj::Promise<void> getMainView(GetMainViewContext context) override {
    context.getResults().setView(kj::heap<IsolateUiViewImpl>(
        kj::addRef(*runtimeConfig), kj::addRef(*runtimeHost)));
    return kj::READY_NOW;
  }

  kj::Promise<void> keepAlive(KeepAliveContext context) override {
    auto params = context.getParams();
    if (params.hasCore()) {
      coreRedirector->setTarget(params.getCore());
    }

    return kj::READY_NOW;
  }

  kj::Promise<void> syncStorage(SyncStorageContext context) override {
    (void)context;
    auto fd = raiiOpen(varPath, O_RDONLY | O_DIRECTORY);
    KJ_SYSCALL(syncfs(fd));

    auto bytes = computeDiskUsage(varPath);
    KJ_LOG(WARNING, "Reporting isolate grain disk usage.", varPath, bytes);
    auto req = sandstormCore.reportGrainSizeRequest();
    req.setBytes(bytes);
    return req.send().ignoreResult();
  }

  kj::Promise<void> shutdown(ShutdownContext context) override {
    sidecar->stop();
    _exit(0);
  }

  kj::Promise<void> restore(RestoreContext context) override {
    auto objectId = context.getParams().getRef();
    switch (objectId.which()) {
      case SupervisorObjectId<>::APP_REF: {
        auto params = context.getParams();
        auto routeRef = parseRouteBackedCapabilityAppRef(objectId.getAppRef().getAs<capnp::Data>());
        kj::Maybe<kj::Array<const byte>> parentToken = nullptr;
        if (params.getParentToken().size() > 0) {
          parentToken = kj::heapArray<const byte>(params.getParentToken());
        }
        if (routeRef.type == RouteBackedCapabilityType::OBJECT) {
          context.getResults().setCap(makeRouteBackedObjectCapability(
              kj::addRef(*runtimeConfig), kj::addRef(*runtimeHost),
              routeRef.pathPrefix, true, kj::mv(parentToken)));
        } else {
          context.getResults().setCap(makeRouteBackedSessionCapability(
              kj::addRef(*runtimeConfig), kj::addRef(*runtimeHost),
              routeRef.type, routeRef.pathPrefix, true, kj::mv(parentToken)));
        }
        return kj::READY_NOW;
      }
      case SupervisorObjectId<>::WAKE_LOCK_NOTIFICATION:
        KJ_FAIL_REQUIRE("isolate supervisor-owned persistent object type is not supported yet");
      default:
        KJ_FAIL_REQUIRE("unknown isolate supervisor object ID type");
    }
  }

  kj::Promise<void> drop(DropContext context) override {
    auto objectId = context.getParams().getRef();
    switch (objectId.which()) {
      case SupervisorObjectId<>::APP_REF:
        parseRouteBackedCapabilityAppRef(objectId.getAppRef().getAs<capnp::Data>());
        return kj::READY_NOW;
      case SupervisorObjectId<>::WAKE_LOCK_NOTIFICATION:
        KJ_FAIL_REQUIRE("isolate supervisor-owned persistent object type is not supported yet");
      default:
        KJ_FAIL_REQUIRE("unknown isolate supervisor object ID type");
    }
  }

  kj::Promise<void> watchLog(WatchLogContext context) override {
    auto params = context.getParams();
    auto logPath = kj::str(varPath, "/log");
    auto logFile = raiiOpen(logPath, O_RDONLY | O_CLOEXEC);

    struct stat stats;
    KJ_SYSCALL(fstat(logFile, &stats));
    uint64_t requestedBacklog = params.getBacklogAmount();
    uint64_t backlog = kj::min(requestedBacklog, stats.st_size);
    KJ_SYSCALL(lseek(logFile, stats.st_size - backlog, SEEK_SET));

    kj::Maybe<kj::Promise<void>> firstWrite;
    if (stats.st_size < requestedBacklog) {
      KJ_IF_MAYBE(log1, raiiOpenIfExists(kj::str(varPath, "/log.1"), O_RDONLY)) {
        struct stat stats1;
        KJ_SYSCALL(fstat(*log1, &stats1));
        uint64_t requestedBacklog1 = requestedBacklog - stats.st_size;
        uint64_t backlog1 = kj::min(requestedBacklog1, stats1.st_size);
        KJ_SYSCALL(lseek(*log1, stats1.st_size - backlog1, SEEK_SET));

        kj::FdInputStream in(log1->get());
        auto req = params.getStream().writeRequest();
        auto data = req.initData(backlog1);
        in.read(data.begin(), backlog1);
        firstWrite = req.send();
      }
    }

    auto watcher = kj::heap<LogWatcher>(eventPort, logPath, kj::mv(logFile), params.getStream());

    KJ_IF_MAYBE(f, firstWrite) {
      watcher->addTask(kj::mv(*f));
    }

    context.releaseParams();
    context.getResults(capnp::MessageSize { 4, 1 }).setHandle(kj::mv(watcher));
    return kj::READY_NOW;
  }

  kj::Promise<void> getWwwFileHack(GetWwwFileHackContext context) override {
    context.getResults().setStatus(Supervisor::WwwFileStatus::NOT_FOUND);
    return kj::READY_NOW;
  }

private:
  kj::UnixEventPort& eventPort;
  kj::String varPath;
  kj::Own<CapRedirector> coreRedirector;
  kj::Own<IsolateRuntimeConfig> runtimeConfig;
  kj::Own<IsolateRuntimeHost> runtimeHost;
  kj::Own<WorkerdSidecarProcess> sidecar;
  SandstormCore::Client sandstormCore;

  class LogWatcher final: public Handle::Server, private kj::TaskSet::ErrorHandler {
  public:
    explicit LogWatcher(kj::UnixEventPort& eventPort, kj::StringPtr logPath,
                        kj::AutoCloseFd logFileParam, ByteStream::Client stream)
        : logFile(kj::mv(logFileParam)),
          inotify(makeInotifyFd()),
          inotifyObserver(eventPort, inotify, kj::UnixEventPort::FdObserver::OBSERVE_READ),
          stream(kj::mv(stream)),
          tasks(*this),
          logPath(kj::heapString(logPath)) {
      KJ_SYSCALL(inotify_add_watch(inotify, logPath.cStr(), IN_MODIFY));
      tasks.add(watchLoop());
    }

    void addTask(kj::Promise<void> task) {
      tasks.add(kj::mv(task));
    }

  private:
    kj::AutoCloseFd logFile;
    kj::AutoCloseFd inotify;
    kj::UnixEventPort::FdObserver inotifyObserver;
    ByteStream::Client stream;
    kj::TaskSet tasks;
    off_t lastOffset = 0;
    kj::String logPath;

    void taskFailed(kj::Exception&& exception) override {
      KJ_LOG(ERROR, exception);
    }

    kj::Promise<void> copyLog() {
      auto req = stream.writeRequest();
      auto orphanage =
          capnp::Orphanage::getForMessageContaining<ByteStream::WriteParams::Builder>(req);
      auto orphan = orphanage.newOrphan<capnp::Data>(4096);
      auto data = orphan.get();

      size_t n = kj::FdInputStream(logFile.get())
          .tryRead(data.begin(), data.size(), data.size());
      bool done = n < data.size();
      if (done) {
        orphan.truncate(n);
      }
      req.adoptData(kj::mv(orphan));

      if (done) {
        return req.send();
      } else {
        return req.send().then([this]() {
          return copyLog();
        });
      }
    }

    kj::Promise<void> watchLoop() {
      for (;;) {
        byte buffer[sizeof(struct inotify_event) + NAME_MAX + 1];
        ssize_t n;
        KJ_NONBLOCKING_SYSCALL(n = read(inotify, buffer, sizeof(buffer)));
        if (n < 0) break;
        KJ_ASSERT(n > 0);
      }

      struct stat stats;
      KJ_SYSCALL(fstat(logFile, &stats));
      if (lastOffset > stats.st_size) {
        lastOffset = 0;
        KJ_SYSCALL(lseek(logFile, 0, SEEK_SET));
      }

      return copyLog().then([this]() {
        KJ_SYSCALL(lastOffset = lseek(logFile, 0, SEEK_CUR));

        return inotifyObserver.whenBecomesReadable().then([this]() {
          return watchLoop();
        });
      });
    }

    static kj::AutoCloseFd makeInotifyFd() {
      int ifd;
      KJ_SYSCALL(ifd = inotify_init1(IN_NONBLOCK | IN_CLOEXEC));
      return kj::AutoCloseFd(ifd);
    }
  };
};

kj::String getenvString(kj::StringPtr name) {
  char* value = getenv(name.cStr());
  KJ_REQUIRE(value != nullptr, "Required environment variable is missing.", name);
  return kj::heapString(value);
}

kj::String readOptionalTextFile(kj::StringPtr path) {
  if (path.size() == 0) {
    return kj::heapString("(not configured)");
  }

  KJ_IF_MAYBE(fd, raiiOpenIfExists(path, O_RDONLY | O_CLOEXEC)) {
    return readAll(*fd);
  } else {
    return kj::str("(missing: ", path, ")");
  }
}

class IsolateDevSidecarService final: public kj::HttpService {
public:
  explicit IsolateDevSidecarService(kj::HttpHeaderTable& headerTable)
      : headerTable(headerTable),
        socketPath(getenvString("SANDSTORM_ISOLATE_SOCKET")),
        runtimeDir(getenvString("SANDSTORM_ISOLATE_RUNTIME_DIR")),
        runtimeManifestPath(getenvString("SANDSTORM_ISOLATE_RUNTIME_MANIFEST")),
        workerdConfigPath(getenvString("SANDSTORM_ISOLATE_WORKERD_CONFIG")),
        mainModule(getenvString("SANDSTORM_ISOLATE_MAIN_MODULE")),
        compatibilityDate(getenvString("SANDSTORM_ISOLATE_COMPATIBILITY_DATE")) {}

  kj::Promise<void> request(
      kj::HttpMethod method, kj::StringPtr url, const kj::HttpHeaders& headers,
      kj::AsyncInputStream& requestBody, kj::HttpService::Response& response) override {
    auto methodName = kj::str(method);
    auto path = kj::heapString(url);
    KJ_LOG(WARNING, "Isolate development sidecar received request.", methodName, path);

    return readAllBytesAtMost(requestBody, 1024 * 1024,
        "isolate development sidecar request body exceeds maximum allowed size").then(
        [this, methodName = kj::mv(methodName), path = kj::mv(path), &response]
        (kj::Array<byte>&& bodyBytes) mutable {
      kj::HttpHeaders responseHeaders(headerTable);
      responseHeaders.set(kj::HttpHeaderId::CONTENT_TYPE, "text/html; charset=utf-8");

      auto escapedMethod = htmlEscape(methodName);
      auto escapedPath = htmlEscape(path);
      auto escapedSocketPath = htmlEscape(socketPath);
      auto escapedRuntimeDir = htmlEscape(runtimeDir);
      auto escapedMainModule = htmlEscape(mainModule);
      auto escapedCompatibilityDate = htmlEscape(compatibilityDate);
      auto escapedManifest = htmlEscape(readOptionalTextFile(runtimeManifestPath));
      auto escapedWorkerdConfig = htmlEscape(readOptionalTextFile(workerdConfigPath));

      auto body = kj::str(
          "<!doctype html><meta charset=\"utf-8\">"
          "<title>Isolate dev sidecar</title>"
          "<h1>Isolate dev sidecar</h1>"
          "<p>This response came through the isolate sidecar HTTP proxy path.</p>"
          "<dl>"
          "<dt>Method</dt><dd><code>", escapedMethod, "</code></dd>"
          "<dt>Path</dt><dd><code>", escapedPath, "</code></dd>"
          "<dt>Request body bytes</dt><dd><code>", bodyBytes.size(), "</code></dd>"
          "<dt>Socket</dt><dd><code>", escapedSocketPath, "</code></dd>"
          "<dt>Runtime dir</dt><dd><code>", escapedRuntimeDir, "</code></dd>"
          "<dt>Main module</dt><dd><code>", escapedMainModule, "</code></dd>"
          "<dt>Compatibility date</dt><dd><code>", escapedCompatibilityDate, "</code></dd>"
          "</dl>"
          "<h2>runtime-manifest.json</h2><pre>", escapedManifest, "</pre>"
          "<h2>workerd.capnp</h2><pre>", escapedWorkerdConfig, "</pre>");

      auto stream = response.send(200, "OK", responseHeaders, body.size());
      auto promise = stream->write(body.begin(), body.size());
      return promise.attach(kj::mv(stream), kj::mv(body), kj::mv(bodyBytes));
    });
  }

private:
  kj::HttpHeaderTable& headerTable;
  kj::String socketPath;
  kj::String runtimeDir;
  kj::String runtimeManifestPath;
  kj::String workerdConfigPath;
  kj::String mainModule;
  kj::String compatibilityDate;
};

}  // namespace

IsolateDevSidecarMain::IsolateDevSidecarMain(kj::ProcessContext& context): context(context) {}

kj::MainFunc IsolateDevSidecarMain::getMain() {
  return kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
                         "Runs the built-in isolate development sidecar.")
      .callAfterParsing(KJ_BIND_METHOD(*this, run))
      .build();
}

kj::MainBuilder::Validity IsolateDevSidecarMain::run() {
  auto socketPath = getenvString("SANDSTORM_ISOLATE_SOCKET");
  unlinkIfExists(socketPath);

  auto ioContext = kj::setupAsyncIo();
  kj::HttpHeaderTable headerTable;
  IsolateDevSidecarService service(headerTable);
  kj::HttpServer server(ioContext.provider->getTimer(), headerTable, service);

  auto address = ioContext.provider->getNetwork()
      .parseAddress(kj::str("unix:", socketPath), 0)
      .wait(ioContext.waitScope);
  auto port = address->listen();

  KJ_LOG(WARNING, "Isolate development sidecar listening.", socketPath);
  server.listenHttp(*port).wait(ioContext.waitScope);
  return true;
}

IsolateSupervisorMain::IsolateSupervisorMain(kj::ProcessContext& context): context(context) {
  sigset_t sigset;
  KJ_SYSCALL(sigemptyset(&sigset));
  KJ_SYSCALL(sigprocmask(SIG_SETMASK, &sigset, nullptr));
}

kj::MainFunc IsolateSupervisorMain::getMain() {
  return kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
                         "Runs a V8-isolate grain supervisor.")
      .addOptionWithArg({"uid"}, KJ_BIND_METHOD(*this, setUid), "<uid>",
                        "Accept the traditional supervisor --uid option.")
      .addOptionWithArg({"pkg"}, KJ_BIND_METHOD(*this, setPkg), "<path>",
                        "Set directory containing the app package.")
      .addOptionWithArg({"var"}, KJ_BIND_METHOD(*this, setVar), "<path>",
                        "Set directory where grain data will be stored.")
      .addOptionWithArg({'e', "env"}, KJ_BIND_METHOD(*this, addEnv), "<name>=<val>",
                        "Record an isolate environment binding.")
      .addOptionWithArg({"isolate-main-module"}, KJ_BIND_METHOD(*this, setIsolateMainModule),
                        "<module>", "Select the isolate command main module from the manifest.")
      .addOptionWithArg({"isolate-compatibility-date"},
                        KJ_BIND_METHOD(*this, setIsolateCompatibilityDate), "<date>",
                        "Record the selected isolate command compatibility date.")
      .addOption({"proc"}, []() { return true; },
                 "Accepted for compatibility with supervisor launch flags.")
      .addOption({"stdio"}, [this]() { keepStdio = true; return true; },
                 "Do not redirect stderr to the grain log.")
      .addOption({"dev"}, []() { return true; },
                 "Accepted for compatibility with supervisor launch flags.")
      .addOption({"use-experimental-seccomp-filter"}, []() { return true; },
                 "Accepted for compatibility with supervisor launch flags.")
      .addOption({"log-seccomp-violations"},
                 [this]() { logSeccompViolations = true; return true; },
                 "Accepted for compatibility with supervisor launch flags.")
      .addOption({'n', "new"}, [this]() { isNew = true; return true; },
                 "Initialize a new grain.")
      .expectArg("<app-name>", KJ_BIND_METHOD(*this, setAppName))
      .expectArg("<grain-id>", KJ_BIND_METHOD(*this, setGrainId))
      .expectZeroOrMoreArgs("<runtime-arg>", KJ_BIND_METHOD(*this, addRuntimeArg))
      .callAfterParsing(KJ_BIND_METHOD(*this, run))
      .build();
}

kj::MainBuilder::Validity IsolateSupervisorMain::setAppName(kj::StringPtr name) {
  if (name == nullptr || name.findFirst('/') != nullptr) {
    return "Invalid app name.";
  }
  appName = kj::heapString(name);
  return true;
}

kj::MainBuilder::Validity IsolateSupervisorMain::setGrainId(kj::StringPtr id) {
  if (id == nullptr || id.findFirst('/') != nullptr) {
    return "Invalid grain id.";
  }
  grainId = kj::heapString(id);
  return true;
}

kj::MainBuilder::Validity IsolateSupervisorMain::setPkg(kj::StringPtr path) {
  pkgPath = realPath(path);
  return true;
}

kj::MainBuilder::Validity IsolateSupervisorMain::setVar(kj::StringPtr path) {
  varPath = realPath(path);
  return true;
}

kj::MainBuilder::Validity IsolateSupervisorMain::setUid(kj::StringPtr arg) {
  KJ_IF_MAYBE(u, parseUInt(arg, 10)) {
    if (getuid() != 0) {
      return "must start as root to use --uid";
    }
    if (*u == 0) {
      return "can't run isolate supervisor as root";
    }
    sandboxUid = *u;
    return true;
  } else {
    return "UID must be a number";
  }
}

kj::MainBuilder::Validity IsolateSupervisorMain::setIsolateMainModule(kj::StringPtr mainModule) {
  isolateMainModule = kj::heapString(mainModule);
  return true;
}

kj::MainBuilder::Validity IsolateSupervisorMain::setIsolateCompatibilityDate(
    kj::StringPtr compatibilityDate) {
  isolateCompatibilityDate = kj::heapString(compatibilityDate);
  return true;
}

kj::MainBuilder::Validity IsolateSupervisorMain::addEnv(kj::StringPtr arg) {
  environment.add(kj::heapString(arg));
  return true;
}

kj::MainBuilder::Validity IsolateSupervisorMain::addRuntimeArg(kj::StringPtr arg) {
  runtimeArgs.add(kj::heapString(arg));
  return true;
}

kj::String IsolateSupervisorMain::realPath(kj::StringPtr path) {
  char* cResult = realpath(path.cStr(), nullptr);
  if (cResult == nullptr) {
    int error = errno;
    if (error != ENOENT) {
      KJ_FAIL_SYSCALL("realpath", error, path);
    }

    KJ_IF_MAYBE(slashPos, path.findLast('/')) {
      if (*slashPos == 0) {
        return kj::heapString(path);
      } else {
        auto parent = kj::heapString(path.slice(0, *slashPos));
        auto suffix = kj::heapString(path.slice(*slashPos));
        return kj::str(realPath(parent), suffix);
      }
    } else {
      char* cwd = getcwd(nullptr, 0);
      if (cwd == nullptr) {
        KJ_FAIL_SYSCALL("getcwd", errno);
      }
      KJ_DEFER(free(cwd));
      if (cwd[0] == '/' && cwd[1] == '\0') {
        return kj::str('/', path);
      } else {
        return kj::str(cwd, '/', path);
      }
    }
  }

  auto result = kj::heapString(cResult);
  free(cResult);
  return result;
}

kj::MainBuilder::Validity IsolateSupervisorMain::run() {
  if (pkgPath == nullptr) pkgPath = kj::str("/var/sandstorm/apps/", appName);
  if (varPath == nullptr) varPath = kj::str("/var/sandstorm/grains/", grainId);

  KJ_SYSCALL(access(pkgPath.cStr(), R_OK | X_OK), pkgPath);
  kj::Maybe<kj::StringPtr> requestedMainModule;
  if (isolateMainModule != nullptr) {
    requestedMainModule = isolateMainModule;
  }

  kj::Maybe<kj::StringPtr> requestedCompatibilityDate;
  if (isolateCompatibilityDate != nullptr) {
    requestedCompatibilityDate = isolateCompatibilityDate;
  }

  umask(0007);
  if (isNew) {
    if (mkdir(varPath.cStr(), 0770) != 0) {
      int error = errno;
      if (error == EEXIST) {
        context.exitError(kj::str("Grain already exists: ", grainId));
      } else {
        KJ_FAIL_SYSCALL("mkdir(varPath.cStr(), 0770)", error, varPath);
      }
    }
    KJ_SYSCALL(mkdir(kj::str(varPath, "/sandbox").cStr(), 0770), varPath);
  } else {
    if (access(varPath.cStr(), R_OK | W_OK | X_OK) != 0) {
      int error = errno;
      if (error == ENOENT) {
        context.exitError(kj::str("No such grain: ", grainId));
      } else {
        KJ_FAIL_SYSCALL("access(varPath.cStr(), R_OK | W_OK | X_OK)", error, varPath);
      }
    }
  }

  KJ_IF_MAYBE(u, sandboxUid) {
    chownPathTo(varPath, *u);
    chownPathTo(kj::str(varPath, "/sandbox"), *u);
  }

  if (!keepStdio) {
    int log;
    KJ_SYSCALL(log = open(kj::str(varPath, "/log").cStr(),
        O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0660));
    KJ_IF_MAYBE(u, sandboxUid) {
      KJ_SYSCALL(fchown(log, *u, static_cast<gid_t>(-1)));
    }
    KJ_SYSCALL(dup2(log, STDERR_FILENO));
    KJ_SYSCALL(close(log));
  }

  auto runtimeConfig = loadIsolateRuntimeConfig(
      pkgPath, requestedMainModule, requestedCompatibilityDate);

  prepareRuntimeBundleAsSandboxUser(varPath, *runtimeConfig, sandboxUid);

  KJ_LOG(WARNING, "Starting isolate supervisor with workerd adapter skeleton.",
      grainId, pkgPath, runtimeConfig->mainModule, runtimeConfig->compatibilityDate,
      runtimeConfig->compatibilityFlags.size(), runtimeConfig->modules.size(),
      runtimeConfig->bindings.size(), runtimeConfig->workerdBundleDir,
      runtimeConfig->workerdSocketPath);

  auto sidecar = kj::heap<WorkerdSidecarProcess>(
      runtimeArgs.asPtr(), environment.asPtr(), *runtimeConfig, sandboxUid, logSeccompViolations);

  KJ_IF_MAYBE(u, sandboxUid) {
    KJ_SYSCALL(setuid(*u));
  }

  auto ioContext = kj::setupAsyncIo();
  auto coreRedirector = kj::refcounted<CapRedirector>();
  SandstormCore::Client coreCap = static_cast<capnp::Capability::Client>(
      kj::addRef(*coreRedirector)).castAs<SandstormCore>();
  KJ_LOG(WARNING, "Isolate supervisor core redirector created.");

  auto runtimeHost = kj::refcounted<IsolateRuntimeHost>(
      ioContext.provider->getNetwork(), ioContext.provider->getTimer(), grainId, coreCap);
  kj::Maybe<kj::Promise<void>> apiListenTask = nullptr;
  kj::Maybe<kj::Promise<void>> powerboxListenTask = nullptr;
  kj::Maybe<kj::Promise<void>> storageListenTask = nullptr;
  if (hasSandstormApiBinding(*runtimeConfig)) {
    auto apiService = kj::heap<SandstormApiBindingService>(
        runtimeHost->headerTable, *runtimeConfig, *runtimeHost);
    auto apiServer = kj::heap<kj::HttpServer>(
        runtimeHost->timer, runtimeHost->headerTable, *apiService);
    apiServer = apiServer.attach(kj::mv(apiService));
    auto apiAddress = runtimeHost->network
        .parseAddress(kj::str("unix:", runtimeConfig->sandstormApiSocketPath), 0)
        .wait(ioContext.waitScope);
    auto apiPort = apiAddress->listen();
    KJ_LOG(WARNING, "Isolate Sandstorm API binding socket is listening.",
        runtimeConfig->sandstormApiSocketPath);
    apiListenTask = apiServer->listenHttp(*apiPort)
        .attach(kj::mv(apiPort), kj::mv(apiServer));
  }
  if (hasPowerboxBinding(*runtimeConfig)) {
    auto powerboxService = kj::heap<SandstormApiBindingService>(
        runtimeHost->headerTable, *runtimeConfig, *runtimeHost, true);
    auto powerboxServer = kj::heap<kj::HttpServer>(
        runtimeHost->timer, runtimeHost->headerTable, *powerboxService);
    powerboxServer = powerboxServer.attach(kj::mv(powerboxService));
    auto powerboxAddress = runtimeHost->network
        .parseAddress(kj::str("unix:", runtimeConfig->powerboxSocketPath), 0)
        .wait(ioContext.waitScope);
    auto powerboxPort = powerboxAddress->listen();
    KJ_LOG(WARNING, "Isolate Powerbox binding socket is listening.",
        runtimeConfig->powerboxSocketPath);
    powerboxListenTask = powerboxServer->listenHttp(*powerboxPort)
        .attach(kj::mv(powerboxPort), kj::mv(powerboxServer));
  }
  if (hasStorageBinding(*runtimeConfig)) {
    auto storageService = kj::heap<StorageBindingService>(
        runtimeHost->headerTable, *runtimeConfig);
    auto storageServer = kj::heap<kj::HttpServer>(
        runtimeHost->timer, runtimeHost->headerTable, *storageService);
    storageServer = storageServer.attach(kj::mv(storageService));
    auto storageAddress = runtimeHost->network
        .parseAddress(kj::str("unix:", runtimeConfig->storageSocketPath), 0)
        .wait(ioContext.waitScope);
    auto storagePort = storageAddress->listen();
    KJ_LOG(WARNING, "Isolate storage binding socket is listening.",
        runtimeConfig->storageSocketPath);
    storageListenTask = storageServer->listenHttp(*storagePort)
        .attach(kj::mv(storagePort), kj::mv(storageServer));
  }

  waitForSidecarSocket(*sidecar, *runtimeConfig);
  KJ_LOG(WARNING, "Isolate supervisor sidecar readiness complete.");

  KJ_LOG(WARNING, "Creating isolate supervisor capability.");
  Supervisor::Client mainCap = kj::heap<IsolateSupervisorImpl>(
      ioContext.unixEventPort, varPath, kj::addRef(*coreRedirector), kj::mv(runtimeConfig),
      kj::mv(runtimeHost), kj::mv(sidecar), kj::mv(coreCap));
  KJ_LOG(WARNING, "Isolate supervisor capability created.");

  KJ_LOG(WARNING, "Creating isolate supervisor listener.");
  auto listener = kj::heap<TwoPartyServerWithClientBootstrap>(
      kj::mv(mainCap), kj::mv(coreRedirector));
  KJ_LOG(WARNING, "Isolate supervisor listener created.");

  auto socketPath = kj::str(varPath, "/socket");
  unlinkIfExists(socketPath);

  KJ_LOG(WARNING, "Parsing isolate supervisor socket address.", socketPath);
  auto address = ioContext.provider->getNetwork()
      .parseAddress(kj::str("unix:", socketPath), 0)
      .wait(ioContext.waitScope);
  KJ_LOG(WARNING, "Parsed isolate supervisor socket address.", socketPath);

  KJ_LOG(WARNING, "Listening on isolate supervisor socket.", socketPath);
  auto serverPort = address->listen();
  KJ_LOG(WARNING, "Listening on isolate supervisor socket succeeded.", socketPath);

  KJ_SYSCALL(write(STDOUT_FILENO, "Listening...\n", strlen("Listening...\n")));
  KJ_LOG(WARNING, "Isolate supervisor socket is listening.", socketPath);

  auto listenTask = listener->listen(kj::mv(serverPort));
  KJ_IF_MAYBE(apiTask, apiListenTask) {
    listenTask = listenTask.exclusiveJoin(kj::mv(*apiTask));
  }
  KJ_IF_MAYBE(powerboxTask, powerboxListenTask) {
    listenTask = listenTask.exclusiveJoin(kj::mv(*powerboxTask));
  }
  KJ_IF_MAYBE(storageTask, storageListenTask) {
    listenTask = listenTask.exclusiveJoin(kj::mv(*storageTask));
  }
  listenTask.wait(ioContext.waitScope);
  return true;
}

}  // namespace sandstorm
