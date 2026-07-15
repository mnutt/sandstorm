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

#include "isolate-capnp-framing.h"
#include "isolate-util.h"
#include "sandbox.h"
#include "util.h"
#include "version.h"

#include <sandstorm/isolate/api.js.h>
#include <sandstorm/isolate/capnp-es.js.h>
#include <sandstorm/isolate/capnp-runtime.js.h>

#include <capnp/message.h>
#include <capnp/compat/http-over-capnp.h>
#include <capnp/compat/json.h>
#include <capnp/rpc.capnp.h>
#include <capnp/rpc-twoparty.h>
#include <capnp/schema.h>
#include <capnp/serialize.h>
#include <capnp/serialize-async.h>
#include <capnp/serialize-packed.h>
#include <kj/async-io.h>
#include <kj/async-unix.h>
#include <kj/compat/http.h>
#include <kj/debug.h>
#include <kj/encoding.h>
#include <kj/io.h>
#include <kj/mutex.h>
#include <kj/refcount.h>
#include <kj/thread.h>
#include <sandstorm/api-session.capnp.h>
#include <sandstorm/grain.capnp.h>
#include <sandstorm/identity.capnp.h>
#include <sandstorm/isolate-bridge.capnp.h>
#include <sandstorm/isolate-account-host.capnp.h>
#include <sandstorm/isolate-host.capnp.h>
#include <sandstorm/isolate-supervisor-internal.capnp.h>
#include <sandstorm/isolate-worker-source.capnp.h>
#include <sandstorm/outbound-http-session.capnp.h>
#include <sandstorm/package.capnp.h>
#include <sandstorm/powerbox.capnp.h>
#include <sandstorm/supervisor.capnp.h>
#include <sandstorm/util.capnp.h>
#include <sandstorm/web-session.capnp.h>
#include <netinet/in.h>
#include <sodium/randombytes.h>
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
#include <sys/time.h>
#include <sys/un.h>
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
#include <map>
#include <queue>
#include <set>
#include <string>
#include <utility>

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

constexpr const char* ISOLATE_MAIN_VIEW_RPC_SESSION_PATH =
    "/__sandstorm/main-view/rpc-session";
constexpr uint64_t CAPNP_PERSISTENT_INTERFACE_ID = 0xc8cb212fcd9f5691ull;
constexpr uint64_t SYSTEM_PERSISTENT_INTERFACE_ID = 0xc38cedd77cbed5b4ull;
constexpr uint64_t APP_PERSISTENT_INTERFACE_ID = 0xaffa789add8747b8ull;

volatile sig_atomic_t isolateSidecarPid = 0;
volatile sig_atomic_t isolateKeepAlive = true;

void isolateSupervisorLogSafely(const char* text) {
  while (text[0] != '\0') {
    ssize_t n = write(STDERR_FILENO, text, strlen(text));
    if (n < 0) return;
    text += n;
  }
}

#define SANDSTORM_ISOLATE_LOG(text) \
  isolateSupervisorLogSafely("** SANDSTORM ISOLATE SUPERVISOR: " text "\n")

void killIsolateSidecar() {
  pid_t pid = isolateSidecarPid;
  if (pid != 0) {
    kill(-pid, SIGTERM);
    kill(pid, SIGTERM);
    isolateSidecarPid = 0;
  }
}

[[noreturn]] void killIsolateSidecarAndExit(int status) {
  killIsolateSidecar();
  _exit(status);
}

void isolateSupervisorSignalHandler(int signo) {
  switch (signo) {
    case SIGALRM:
      if (isolateKeepAlive) {
        SANDSTORM_ISOLATE_LOG("Grain still in use; staying up for now.");
        isolateKeepAlive = false;
        return;
      }
      SANDSTORM_ISOLATE_LOG("Grain no longer in use; shutting down.");
      killIsolateSidecarAndExit(0);

    case SIGINT:
    case SIGTERM:
      SANDSTORM_ISOLATE_LOG("Grain supervisor terminated by signal.");
      killIsolateSidecarAndExit(0);

    case SIGABRT:
      SANDSTORM_ISOLATE_LOG("Grain supervisor crashed due to SIGABRT.");
      killIsolateSidecarAndExit(1);

    case SIGSEGV:
      SANDSTORM_ISOLATE_LOG("Grain supervisor crashed due to SIGSEGV.");
      killIsolateSidecarAndExit(1);

    case SIGSYS:
      SANDSTORM_ISOLATE_LOG("Grain supervisor crashed due to SIGSYS.");
      killIsolateSidecarAndExit(1);

    default:
      SANDSTORM_ISOLATE_LOG("Grain supervisor crashed due to signal.");
      killIsolateSidecarAndExit(1);
  }
}

int ISOLATE_DEATH_SIGNALS[] = {
  SIGHUP, SIGINT, SIGQUIT, SIGILL, SIGABRT, SIGFPE, SIGSEGV, SIGTERM, SIGUSR1, SIGUSR2, SIGBUS,
  SIGPOLL, SIGPROF, SIGSYS, SIGTRAP, SIGVTALRM, SIGXCPU, SIGXFSZ, SIGSTKFLT, SIGPWR
};

void registerIsolateSupervisorSignalHandlers() {
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = &isolateSupervisorSignalHandler;
  sigfillset(&action.sa_mask);

  KJ_SYSCALL(sigaction(SIGALRM, &action, nullptr));
  for (int signo: kj::ArrayPtr<int>(ISOLATE_DEATH_SIGNALS)) {
    KJ_SYSCALL(sigaction(signo, &action, nullptr));
  }

  struct itimerval timer;
  memset(&timer, 0, sizeof(timer));
  timer.it_interval.tv_sec = 90;
  timer.it_value.tv_sec = 90;
  KJ_SYSCALL(setitimer(ITIMER_REAL, &timer, nullptr));
}

void keepAliveExistingIsolateSupervisor(kj::StringPtr varPath) {
  auto ioContext = kj::setupAsyncIo();
  auto addr = ioContext.provider->getNetwork()
      .parseAddress(kj::str("unix:", varPath, "/socket"))
      .wait(ioContext.waitScope);

  kj::Own<kj::AsyncIoStream> connection;
  KJ_IF_MAYBE(exception, kj::runCatchingExceptions([&]() {
    connection = addr->connect().wait(ioContext.waitScope);
  })) {
    return;
  }

  capnp::TwoPartyVatNetwork vatNetwork(*connection, capnp::rpc::twoparty::Side::CLIENT);
  auto client = capnp::makeRpcClient(vatNetwork);

  capnp::MallocMessageBuilder message;
  auto hostId = message.initRoot<capnp::rpc::twoparty::VatId>();
  hostId.setSide(capnp::rpc::twoparty::Side::SERVER);
  auto supervisor = client.bootstrap(hostId).castAs<Supervisor>();

  auto promise = supervisor.keepAliveRequest().send();
  KJ_IF_MAYBE(exception, kj::runCatchingExceptions([&]() {
    promise.wait(ioContext.waitScope);
  })) {
    return;
  }

  KJ_SYSCALL(write(STDOUT_FILENO, "Already running...\n", strlen("Already running...\n")));
  _exit(0);
}

enum class IsolateRuntimeTopology {
  PER_GRAIN_SIDECAR,
  ACCOUNT_SHARED_HOST,
};

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
  IsolateRuntimeTopology topology = IsolateRuntimeTopology::PER_GRAIN_SIDECAR;
};

// Shared-host producer limits mirror the native decoder's independent trust-boundary checks.
// Per-grain mode deliberately retains its previous package limits as the compatibility fallback.
constexpr size_t MAX_ISOLATE_MODULES = 1024;
constexpr size_t MAX_ISOLATE_MODULE_BYTES = 8 * 1024 * 1024;
constexpr size_t MAX_ISOLATE_TOTAL_MODULE_BYTES = 16 * 1024 * 1024;
constexpr size_t MAX_ISOLATE_BINDINGS = 1024;
constexpr size_t MAX_ISOLATE_TOTAL_BINDING_BYTES = 4 * 1024 * 1024;
constexpr size_t MAX_ISOLATE_NAME_BYTES = 256;

kj::StringPtr isolateRuntimeTopologyName(IsolateRuntimeTopology topology) {
  switch (topology) {
    case IsolateRuntimeTopology::PER_GRAIN_SIDECAR:
      return "perGrainSidecar";
    case IsolateRuntimeTopology::ACCOUNT_SHARED_HOST:
      return "accountSharedHost";
  }

  KJ_UNREACHABLE;
}

kj::String makeOpaqueToken() {
  kj::Array<byte> bytes = kj::heapArray<byte>(18);
  kj::FdInputStream(raiiOpen("/dev/urandom", O_RDONLY)).read(bytes.begin(), bytes.size());
  return kj::encodeBase64Url(bytes);
}

class IsolateSessionRegistry final: public kj::Refcounted {
public:
  kj::String registerSession(SessionContext::Client context) {
    return registerSession(kj::mv(context), nullptr);
  }

  kj::String registerOfferSession(SessionContext::Client context, capnp::Capability::Client offer) {
    return registerSession(kj::mv(context), kj::mv(offer));
  }

  kj::String registerSession(
      SessionContext::Client context, kj::Maybe<capnp::Capability::Client> offeredCapability) {
    for (;;) {
      auto id = makeOpaqueToken();
      if (findSessionIndex(id) == nullptr) {
        sessions.add(SessionRecord { kj::heapString(id), context, kj::mv(offeredCapability) });
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

  kj::Maybe<capnp::Capability::Client> findOfferedCapability(kj::StringPtr sessionId) {
    KJ_IF_MAYBE(index, findSessionIndex(sessionId)) {
      KJ_IF_MAYBE(cap, sessions[*index].offeredCapability) {
        return *cap;
      }
    }

    return nullptr;
  }

  kj::String storeBrowserHandoffCapability(
      kj::StringPtr sessionId, capnp::Capability::Client cap) {
    KJ_REQUIRE(sessionId.size() > 0, "browser handoff requires a session ID");
    return storeBrowserHandoffCapabilityInternal(sessionId, kj::mv(cap));
  }

  bool dropBrowserHandoffCapability(kj::StringPtr id) {
    KJ_IF_MAYBE(index, findBrowserHandoffCapabilityIndex(id)) {
      if (*index + 1 < browserHandoffCapabilities.size()) {
        browserHandoffCapabilities[*index] = kj::mv(browserHandoffCapabilities.back());
      }
      browserHandoffCapabilities.removeLast();
      return true;
    }

    return false;
  }

  kj::Maybe<capnp::Capability::Client> findBrowserHandoffCapability(
      kj::StringPtr sessionId, kj::StringPtr id) {
    KJ_IF_MAYBE(index, findBrowserHandoffCapabilityIndex(id)) {
      if (browserHandoffCapabilities[*index].sessionId == sessionId) {
        return browserHandoffCapabilities[*index].cap;
      }
    }

    return nullptr;
  }

private:
  kj::String storeBrowserHandoffCapabilityInternal(
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

  struct SessionRecord {
    kj::String id;
    SessionContext::Client context;
    kj::Maybe<capnp::Capability::Client> offeredCapability;
  };

  struct BrowserHandoffCapabilityRecord {
    kj::String id;
    kj::String sessionId;
    capnp::Capability::Client cap;
  };

  kj::Maybe<size_t> findSessionIndex(kj::StringPtr id) {
    for (auto i: kj::indices(sessions)) {
      if (sessions[i].id == id) {
        return i;
      }
    }

    return nullptr;
  }

  kj::Maybe<size_t> findBrowserHandoffCapabilityIndex(kj::StringPtr id) {
    for (auto i: kj::indices(browserHandoffCapabilities)) {
      if (browserHandoffCapabilities[i].id == id) {
        return i;
      }
    }

    return nullptr;
  }

  kj::Vector<SessionRecord> sessions;
  kj::Vector<BrowserHandoffCapabilityRecord> browserHandoffCapabilities;
};

class IsolateRuntimeAdapter;
class IsolateRuntimeAdapterFactory: public kj::Refcounted {
public:
  virtual ~IsolateRuntimeAdapterFactory() noexcept(false);
  virtual kj::HttpHeaderTable& getHeaderTable() = 0;
  virtual bool isConfigured(const IsolateRuntimeConfig& config) = 0;
  virtual bool isAvailable(const IsolateRuntimeConfig& config) = 0;
  virtual kj::Promise<kj::Own<kj::AsyncIoStream>> connect(
      IsolateRuntimeConfig& config, struct IsolateRuntimeHost& host) = 0;
  virtual capnp::HttpService::Client exportHttpService(
      kj::Own<kj::HttpService> service) = 0;
  virtual kj::Own<IsolateRuntimeAdapter> make(
      kj::Own<IsolateRuntimeConfig> config, kj::Own<struct IsolateRuntimeHost> host) = 0;
};

struct IsolateRuntimeHost final: public kj::Refcounted {
  IsolateRuntimeHost(
      kj::Network& network, kj::Timer& timer, kj::StringPtr grainId,
      SandstormCore::Client sandstormCore,
      kj::Own<IsolateRuntimeAdapterFactory> runtimeAdapterFactory)
      : network(network), timer(timer), grainId(kj::heapString(grainId)),
        sandstormCore(kj::mv(sandstormCore)),
        sessions(kj::refcounted<IsolateSessionRegistry>()),
        runtimeAdapterFactory(kj::mv(runtimeAdapterFactory)),
        headerTable(this->runtimeAdapterFactory->getHeaderTable()) {}

  kj::Network& network;
  kj::Timer& timer;
  kj::String grainId;
  SandstormCore::Client sandstormCore;
  kj::Own<IsolateSessionRegistry> sessions;
  kj::Own<IsolateRuntimeAdapterFactory> runtimeAdapterFactory;
  kj::HttpHeaderTable& headerTable;
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

kj::Array<byte> readPackageFile(
    kj::StringPtr pkgPath, kj::StringPtr sourcePath, bool enforceSharedHostLimits) {
  KJ_REQUIRE(isCanonicalPackagePath(sourcePath),
      "Isolate module path must be package-relative and canonical.", sourcePath);
  auto packageDir = raiiOpen(pkgPath, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  KJ_IF_MAYBE(file, raiiOpenAtIfExistsContained(
      packageDir, kj::Path::parse(sourcePath), O_RDONLY | O_CLOEXEC)) {
    struct stat stats;
    KJ_SYSCALL(fstat(*file, &stats), sourcePath);
    KJ_REQUIRE(S_ISREG(stats.st_mode), "Isolate module is not a regular file.", sourcePath);
    KJ_REQUIRE(stats.st_size >= 0, "Isolate module has an invalid size.", sourcePath);
    if (enforceSharedHostLimits) {
      KJ_REQUIRE(stats.st_size <= MAX_ISOLATE_MODULE_BYTES,
          "Isolate module exceeds size limit.", sourcePath, stats.st_size,
          MAX_ISOLATE_MODULE_BYTES);
    }
    auto result = kj::heapArray<byte>(stats.st_size);
    size_t offset = 0;
    while (offset < result.size()) {
      ssize_t count;
      KJ_SYSCALL(count = read(*file, result.begin() + offset, result.size() - offset), sourcePath);
      KJ_REQUIRE(count > 0, "Isolate module ended before its declared size.", sourcePath);
      offset += count;
    }
    return result;
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

size_t bindingValueSize(spk::Manifest::IsolateConfig::Binding::Reader binding) {
  switch (binding.which()) {
    case spk::Manifest::IsolateConfig::Binding::TEXT:
      return binding.getText().size();
    case spk::Manifest::IsolateConfig::Binding::DATA:
      return binding.getData().size();
    case spk::Manifest::IsolateConfig::Binding::JSON:
      return binding.getJson().size();
    case spk::Manifest::IsolateConfig::Binding::SANDSTORM_API:
    case spk::Manifest::IsolateConfig::Binding::STORAGE:
    case spk::Manifest::IsolateConfig::Binding::POWERBOX:
    case spk::Manifest::IsolateConfig::Binding::SERVICE:
      return 0;
  }

  KJ_UNREACHABLE;
}

void validateIsolateRuntimeConfig(
    IsolateRuntimeConfig& config, bool enforceSharedHostLimits = false) {
  KJ_REQUIRE(config.mainModule.size() > 0, "Isolate command is missing mainModule.");
  KJ_REQUIRE(config.apiPath.size() == 0 || config.apiPath.endsWith("/"),
      "Isolate bridgeConfig.apiPath must be empty or end with '/'.", config.apiPath);
  if (enforceSharedHostLimits) {
    KJ_REQUIRE(config.mainModule.size() <= MAX_ISOLATE_NAME_BYTES,
        "Isolate command mainModule exceeds size limit.", config.mainModule.size());
    KJ_REQUIRE(config.compatibilityDate.size() <= 32,
        "Isolate compatibility date exceeds size limit.");
    KJ_REQUIRE(config.compatibilityFlags.size() <= 64,
        "Isolate compatibility flag count exceeds limit.");
  }

  for (auto i: kj::indices(config.compatibilityFlags)) {
    auto& flag = config.compatibilityFlags[i];
    KJ_REQUIRE(flag.size() > 0, "Isolate compatibility flag is empty.");
    if (enforceSharedHostLimits) {
      KJ_REQUIRE(flag.size() <= 128,
          "Isolate compatibility flag exceeds size limit.", flag.size());
    }

    for (uint j = 0; j < i; ++j) {
      KJ_REQUIRE(config.compatibilityFlags[j] != flag,
          "Isolate command has duplicate compatibility flags.", flag);
    }
  }

  if (enforceSharedHostLimits) {
    KJ_REQUIRE(config.modules.size() > 0 && config.modules.size() <= MAX_ISOLATE_MODULES,
        "Isolate command has an invalid module count.", config.modules.size());
  }
  bool foundMainModule = false;
  size_t totalModuleBytes = 0;
  for (auto i: kj::indices(config.modules)) {
    auto& module = config.modules[i];
    KJ_REQUIRE(module.name.size() > 0, "Isolate module is missing name.");
    if (enforceSharedHostLimits) {
      KJ_REQUIRE(module.name.size() <= MAX_ISOLATE_NAME_BYTES,
          "Isolate module name exceeds size limit.", module.name.size());
      KJ_REQUIRE(module.content.size() <= MAX_ISOLATE_MODULE_BYTES,
          "Isolate module exceeds size limit.", module.name, module.content.size(),
          MAX_ISOLATE_MODULE_BYTES);
      totalModuleBytes += module.content.size();
      KJ_REQUIRE(totalModuleBytes <= MAX_ISOLATE_TOTAL_MODULE_BYTES,
          "Isolate modules exceed aggregate size limit.", totalModuleBytes,
          MAX_ISOLATE_TOTAL_MODULE_BYTES);
    }
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

  if (enforceSharedHostLimits) {
    KJ_REQUIRE(config.bindings.size() <= MAX_ISOLATE_BINDINGS,
        "Isolate command binding count exceeds limit.", config.bindings.size());
  }
  size_t totalBindingBytes = 0;
  for (auto i: kj::indices(config.bindings)) {
    auto& binding = config.bindings[i];
    KJ_REQUIRE(binding.name.size() > 0, "Isolate binding is missing name.");
    if (enforceSharedHostLimits) {
      KJ_REQUIRE(binding.name.size() <= MAX_ISOLATE_NAME_BYTES,
          "Isolate binding name exceeds size limit.", binding.name.size());
      totalBindingBytes += binding.value.size();
      KJ_REQUIRE(totalBindingBytes <= MAX_ISOLATE_TOTAL_BINDING_BYTES,
          "Isolate bindings exceed aggregate size limit.", totalBindingBytes,
          MAX_ISOLATE_TOTAL_BINDING_BYTES);
    }
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

kj::String capnpEsRuntimePath(kj::StringPtr moduleName) {
  if (moduleName == "@mnutt/capnp-es") {
    return kj::heapString("capnp-es/index.mjs");
  }

  kj::StringPtr capnpEsPrefix = "@mnutt/capnp-es/";
  if (moduleName.startsWith(capnpEsPrefix)) {
    auto relative = moduleName.slice(capnpEsPrefix.size());
    if (relative.endsWith(".mjs")) {
      return kj::str("capnp-es/", relative);
    }
    return kj::str("capnp-es/", relative, ".mjs");
  }

  kj::StringPtr sharedPrefix = "@mnutt/shared/";
  if (moduleName.startsWith(sharedPrefix)) {
    return kj::str("capnp-es/shared/", moduleName.slice(sharedPrefix.size()));
  }

  kj::StringPtr prefix = "@mnutt/";
  KJ_REQUIRE(moduleName.startsWith(prefix), "Unexpected capnp-es runtime module.", moduleName);
  return kj::str("capnp-es/", moduleName.slice(prefix.size()));
}

kj::String capnpEsSchemeRuntimeSpecifier(kj::StringPtr moduleName) {
  return kj::str("capnp:/", capnpEsRuntimePath(moduleName));
}

kj::String capnpEsSchemeRelativeRuntimeSpecifier(kj::StringPtr moduleName) {
  return kj::str("capnp:./", capnpEsRuntimePath(moduleName));
}

void addGeneratedIsolateHelperModules(IsolateRuntimeConfig& config) {
  addGeneratedIsolateModule(config, "sandstorm:api", IsolateRuntimeConfig::ModuleType::ES_MODULE,
      ISOLATE_API_HELPER_SOURCE);
  addGeneratedIsolateModule(config, "sandstorm-internal:capnp-runtime",
      IsolateRuntimeConfig::ModuleType::ES_MODULE, ISOLATE_CAPNP_RUNTIME_SOURCE);
  for (auto& module: ISOLATE_CAPNP_ES_MODULES) {
    addGeneratedIsolateModule(config, capnpEsSchemeRuntimeSpecifier(module.name),
        IsolateRuntimeConfig::ModuleType::ES_MODULE, module.source);
  }
  for (auto& module: ISOLATE_CAPNP_ES_MODULES) {
    addGeneratedIsolateModule(config, capnpEsRuntimePath(module.name),
        IsolateRuntimeConfig::ModuleType::ES_MODULE, module.source);
  }
  for (auto& module: ISOLATE_CAPNP_ES_MODULES) {
    addGeneratedIsolateModule(config, capnpEsSchemeRelativeRuntimeSpecifier(module.name),
        IsolateRuntimeConfig::ModuleType::ES_MODULE, module.source);
  }
}

kj::Own<IsolateRuntimeConfig> copyIsolateConfig(
    spk::Manifest::IsolateConfig::Reader config, kj::StringPtr pkgPath,
    bool enforceSharedHostLimits) {
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

  auto configuredModules = config.getModules();
  if (enforceSharedHostLimits) {
    KJ_REQUIRE(configuredModules.size() <= MAX_ISOLATE_MODULES,
        "Isolate command module count exceeds limit.", configuredModules.size());
  }
  for (auto module: configuredModules) {
    IsolateRuntimeConfig::Module moduleConfig;
    moduleConfig.name = kj::heapString(module.getName());
    moduleConfig.type = getModuleType(module);
    moduleConfig.sourcePath = copyModuleSourcePath(module);
    moduleConfig.content = readPackageFile(
        pkgPath, moduleConfig.sourcePath, enforceSharedHostLimits);
    result->modules.add(kj::mv(moduleConfig));
  }
  addGeneratedIsolateHelperModules(*result);

  auto configuredBindings = config.getBindings();
  if (enforceSharedHostLimits) {
    KJ_REQUIRE(configuredBindings.size() <= MAX_ISOLATE_BINDINGS,
        "Isolate command binding count exceeds limit.", configuredBindings.size());
  }
  size_t totalBindingBytes = 0;
  for (auto binding: configuredBindings) {
    auto valueSize = bindingValueSize(binding);
    if (enforceSharedHostLimits) {
      KJ_REQUIRE(valueSize <= MAX_ISOLATE_TOTAL_BINDING_BYTES - totalBindingBytes,
          "Isolate bindings exceed aggregate size limit.",
          totalBindingBytes + valueSize, MAX_ISOLATE_TOTAL_BINDING_BYTES);
    }
    totalBindingBytes += valueSize;
    IsolateRuntimeConfig::Binding bindingConfig;
    bindingConfig.name = kj::heapString(binding.getName());
    bindingConfig.type = getBindingType(binding);
    bindingConfig.value = copyBindingValue(binding);
    if (binding.which() == spk::Manifest::IsolateConfig::Binding::SERVICE) {
      bindingConfig.serviceName = kj::heapString(binding.getService());
    }
    result->bindings.add(kj::mv(bindingConfig));
  }

  validateIsolateRuntimeConfig(*result, enforceSharedHostLimits);
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

kj::AutoCloseFd createUnixListener(kj::StringPtr path) {
  struct sockaddr_un address;
  memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;
  KJ_REQUIRE(path.size() < sizeof(address.sun_path), "Unix socket path is too long", path);
  memcpy(address.sun_path, path.begin(), path.size());

  int fd;
  KJ_SYSCALL(fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0));
  kj::AutoCloseFd result(fd);
  KJ_SYSCALL(bind(result, reinterpret_cast<struct sockaddr*>(&address), sizeof(address)), path);
  KJ_SYSCALL(chmod(path.cStr(), 0600), path);
  KJ_SYSCALL(listen(result, SOMAXCONN), path);
  return result;
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

void appendWorkerdModuleEntry(kj::Vector<char>& result, kj::StringPtr name,
    IsolateRuntimeConfig::ModuleType type, kj::StringPtr fileName) {
  result.addAll(kj::StringPtr("          ( name = "));
  appendCapnpString(result, name);
  result.addAll(kj::StringPtr(", "));

  switch (type) {
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

void appendWorkerdModule(
    kj::Vector<char>& result, IsolateRuntimeConfig::Module& module, kj::StringPtr fileName) {
  appendWorkerdModuleEntry(result, module.name, module.type, fileName);
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
    auto& module = config.modules[index];
    auto fileName = moduleBundleFileName(index, module.type);
    appendWorkerdModule(result, module, fileName);
    needsComma = true;
    if (module.name.startsWith("capnp:/sandstorm/")) {
      result.addAll(kj::StringPtr(",\n"));
      appendWorkerdModuleEntry(result,
          module.name.slice(strlen("capnp:/")), module.type, fileName);
    }
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
  manifest.addAll(kj::StringPtr(",\n  "));
  appendJsonField(manifest, "topology",
      isolateRuntimeTopologyName(config.topology));

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

  capnp::MallocMessageBuilder sourceMessage;
  auto source = sourceMessage.initRoot<IsolateWorkerSource>();
  source.setFormatVersion(1);
  source.setMainModule(config.mainModule);
  source.setCompatibilityDate(config.compatibilityDate);
  auto flags = source.initCompatibilityFlags(config.compatibilityFlags.size());
  for (auto i: kj::indices(config.compatibilityFlags)) flags.set(i, config.compatibilityFlags[i]);
  auto modules = source.initModules(config.modules.size());
  for (auto i: kj::indices(config.modules)) {
    auto& input = config.modules[i];
    auto output = modules[i];
    output.setName(input.name);
    switch (input.type) {
      case IsolateRuntimeConfig::ModuleType::ES_MODULE: output.setEsModule(input.content); break;
      case IsolateRuntimeConfig::ModuleType::COMMON_JS_MODULE:
        output.setCommonJsModule(input.content); break;
      case IsolateRuntimeConfig::ModuleType::TEXT: output.setText(input.content); break;
      case IsolateRuntimeConfig::ModuleType::DATA: output.setData(input.content); break;
      case IsolateRuntimeConfig::ModuleType::WASM: output.setWasm(input.content); break;
      case IsolateRuntimeConfig::ModuleType::JSON: output.setJson(input.content); break;
    }
  }
  auto bindings = source.initBindings(config.bindings.size());
  for (auto i: kj::indices(config.bindings)) {
    auto& input = config.bindings[i];
    auto output = bindings[i];
    output.setName(input.name);
    switch (input.type) {
      case IsolateRuntimeConfig::BindingType::TEXT: output.setText(input.value); break;
      case IsolateRuntimeConfig::BindingType::DATA: output.setData(input.value); break;
      case IsolateRuntimeConfig::BindingType::JSON: output.setJson(input.value); break;
      case IsolateRuntimeConfig::BindingType::SANDSTORM_API: output.setSandstormApi(); break;
      case IsolateRuntimeConfig::BindingType::STORAGE: output.setStorage(); break;
      case IsolateRuntimeConfig::BindingType::POWERBOX: output.setPowerbox(); break;
      case IsolateRuntimeConfig::BindingType::SERVICE: output.setService(input.serviceName); break;
    }
  }
  kj::VectorOutputStream sourceBytes;
  capnp::writePackedMessage(sourceBytes, sourceMessage);
  writeFile(kj::str(bundleDir, "/worker-source.capnp.bin"), sourceBytes.getArray());

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
constexpr uint64_t MAX_NATIVE_CAPNP_RPC_WEBSOCKET_MESSAGE_BYTES =
    MAX_SIDECAR_REQUEST_BYTES + 1024 * 1024;
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

struct IsolateWebSocketUpgradeResponse {
  kj::Vector<kj::String> protocols;
  kj::Array<byte> remainder;
};

kj::Maybe<size_t> findHttpHeaderEnd(kj::ArrayPtr<const byte> bytes) {
  for (size_t i = 3; i < bytes.size(); ++i) {
    if (bytes[i - 3] == '\r' && bytes[i - 2] == '\n' &&
        bytes[i - 1] == '\r' && bytes[i] == '\n') {
      return i + 1;
    }
  }

  return nullptr;
}

void requireNoHttpLineBreaks(kj::StringPtr value, kj::StringPtr description) {
  KJ_REQUIRE(value.findFirst('\r') == nullptr && value.findFirst('\n') == nullptr,
      description, value);
}

bool headerNameEquals(kj::StringPtr actual, kj::StringPtr expectedLowercase) {
  auto normalized = kj::str(actual);
  toLower(normalized);
  return normalized == expectedLowercase;
}

kj::Array<byte> renderSidecarWebSocketUpgradeRequest(FetchRequest& request) {
  requireNoHttpLineBreaks(request.path, "isolate WebSocket path contains a line break");

  kj::Vector<char> result;
  auto add = [&](kj::StringPtr text) {
    result.addAll(text.asArray());
  };

  add("GET ");
  add(request.path);
  add(" HTTP/1.1\r\n");
  add("Upgrade: websocket\r\n");
  add("Connection: Upgrade\r\n");
  add("Sec-WebSocket-Key: mj9i153gxeYNlGDoKdoXOQ==\r\n");
  add("Sec-WebSocket-Version: 13\r\n");

  for (auto& header: request.headers) {
    requireNoHttpLineBreaks(header.name, "isolate WebSocket header name contains a line break");
    requireNoHttpLineBreaks(header.value, "isolate WebSocket header value contains a line break");

    if (headerNameEquals(header.name, "upgrade") ||
        headerNameEquals(header.name, "connection") ||
        headerNameEquals(header.name, "sec-websocket-key") ||
        headerNameEquals(header.name, "sec-websocket-version")) {
      continue;
    }

    add(header.name);
    add(": ");
    add(header.value);
    add("\r\n");
  }

  add("\r\n");
  return kj::heapArray<byte>(result.asPtr().asBytes());
}

class IsolateWebSocketUpgradeParser final: public kj::Refcounted {
public:
  kj::Promise<IsolateWebSocketUpgradeResponse> read(kj::AsyncInputStream& stream) {
    return stream.tryRead(scratch, 1, sizeof(scratch))
        .then([this, &stream](size_t amount) mutable
            -> kj::Promise<IsolateWebSocketUpgradeResponse> {
      KJ_REQUIRE(amount > 0, "isolate sidecar closed before WebSocket upgrade response");
      bytes.addAll(kj::arrayPtr(scratch, amount));
      KJ_REQUIRE(bytes.size() <= 65536,
          "isolate sidecar WebSocket upgrade response headers are too large");

      KJ_IF_MAYBE(headerEnd, findHttpHeaderEnd(bytes.asPtr())) {
        return parse(*headerEnd);
      }

      return read(stream);
    });
  }

private:
  byte scratch[4096];
  kj::Vector<byte> bytes;

  IsolateWebSocketUpgradeResponse parse(size_t headerEnd) {
    auto headerText = bytes.asPtr().slice(0, headerEnd).asChars();
    auto lines = split(headerText, '\n');
    KJ_REQUIRE(lines.size() > 0, "isolate sidecar WebSocket response was empty");

    auto status = trim(lines[0]);
    KJ_REQUIRE(status.startsWith("HTTP/1.") &&
        (status == "HTTP/1.0 101" || status.startsWith("HTTP/1.0 101 ") ||
         status == "HTTP/1.1 101" || status.startsWith("HTTP/1.1 101 ")),
        "isolate sidecar did not upgrade WebSocket", status);

    IsolateWebSocketUpgradeResponse result;
    for (size_t i = 1; i < lines.size(); ++i) {
      auto line = trim(lines[i]);
      if (line.size() == 0) {
        continue;
      }

      KJ_IF_MAYBE(colon, line.findFirst(':')) {
        auto name = trim(line.slice(0, *colon));
        toLower(name);
        if (name == "sec-websocket-protocol") {
          auto value = line.slice(*colon + 1, line.size());
          for (auto part: split(value, ',')) {
            auto protocol = trim(part);
            if (protocol.size() > 0) {
              result.protocols.add(kj::mv(protocol));
            }
          }
        }
      }
    }

    result.remainder = kj::heapArray<byte>(bytes.asPtr().slice(headerEnd, bytes.size()));
    return kj::mv(result);
  }
};

class IsolateRawWebSocketPump final: public WebSession::WebSocketStream::Server,
                                    private kj::TaskSet::ErrorHandler {
public:
  IsolateRawWebSocketPump(kj::Own<kj::AsyncIoStream> sidecarStream,
      WebSession::WebSocketStream::Client callerStream, kj::Array<byte> initialBytes)
      : sidecarStream(kj::mv(sidecarStream)),
        callerStream(kj::mv(callerStream)),
        tasks(*this) {
    if (initialBytes.size() > 0) {
      sendData(initialBytes);
    }
    pumpSidecarToCaller();
  }

protected:
  kj::Promise<void> sendBytes(SendBytesContext context) override {
    auto fork = upstream.then([this, context]() mutable {
      auto message = context.getParams().getMessage();
      return sidecarStream->write(message.begin(), message.size());
    }).fork();
    upstream = fork.addBranch();
    return fork.addBranch();
  }

private:
  kj::Own<kj::AsyncIoStream> sidecarStream;
  WebSession::WebSocketStream::Client callerStream;
  kj::Promise<void> upstream = kj::READY_NOW;
  kj::TaskSet tasks;
  byte buffer[4096];

  void pumpSidecarToCaller() {
    tasks.add(sidecarStream->tryRead(buffer, 1, sizeof(buffer))
        .then([this](size_t amount) mutable {
      if (amount > 0) {
        sendData(kj::arrayPtr(buffer, amount));
        pumpSidecarToCaller();
      } else {
        callerStream = nullptr;
      }
    }));
  }

  void sendData(kj::ArrayPtr<const byte> data) {
    auto request = callerStream.sendBytesRequest(
        capnp::MessageSize { data.size() / sizeof(capnp::word) + 8, 0 });
    request.setMessage(data);
    tasks.add(request.send());
  }

  void taskFailed(kj::Exception&& exception) override {
    if (exception.getType() != kj::Exception::Type::DISCONNECTED) {
      KJ_LOG(WARNING, "Isolate WebSession WebSocket pump failed.", exception);
    }
  }
};

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
  virtual kj::Promise<void> openWebSocket(FetchRequest&& request,
      WebSession::WebSocketStream::Client clientStream,
      WebSession::OpenWebSocketResults::Builder results) = 0;
  virtual kj::Own<WebSession::RequestStream::Server> startRequestStream(
      FetchRequest&& request, ByteStream::Client responseStream) = 0;
};

IsolateRuntimeAdapterFactory::~IsolateRuntimeAdapterFactory() noexcept(false) = default;

class WorkerdRuntimeAdapter final: public IsolateRuntimeAdapter {
public:
  WorkerdRuntimeAdapter(kj::Own<IsolateRuntimeConfig> config, kj::Own<IsolateRuntimeHost> host)
      : config(kj::mv(config)), host(kj::mv(host)) {}

  kj::Promise<FetchResponse> fetch(FetchRequest&& request) override {
    if (host->runtimeAdapterFactory->isAvailable(*config)) {
      return fetchFromSidecar(kj::mv(request)).catch_(
          [this](kj::Exception&& exception) mutable {
        return fetchRuntimeError(kj::mv(exception));
      });
    } else if (host->runtimeAdapterFactory->isConfigured(*config)) {
      return fetchPlaceholder(kj::mv(request), "sidecar socket not listening");
    }

    return fetchPlaceholder(kj::mv(request), "sidecar endpoint not configured");
  }

  kj::Promise<void> openWebSocket(FetchRequest&& request,
      WebSession::WebSocketStream::Client clientStream,
      WebSession::OpenWebSocketResults::Builder results) override {
    KJ_REQUIRE(host->runtimeAdapterFactory->isAvailable(*config),
        "isolate runtime endpoint is not available");
    return openWebSocketFromSidecar(kj::mv(request), kj::mv(clientStream), results);
  }

  kj::Own<WebSession::RequestStream::Server> startRequestStream(
      FetchRequest&& request, ByteStream::Client responseStream) override;

private:
  class StreamingRequestImpl;

  struct SidecarHttpState final: public FetchResponseBodyAnchor, public kj::Refcounted {
    kj::Own<kj::AsyncIoStream> stream;
    kj::Own<kj::HttpClient> client;
    kj::Own<kj::AsyncOutputStream> requestBody;
    kj::Promise<kj::HttpClient::Response> response = nullptr;
    kj::Maybe<kj::Own<kj::AsyncInputStream>> responseBody;

    SidecarHttpState(kj::Own<kj::AsyncIoStream> stream, kj::HttpHeaderTable& headerTable)
        : stream(kj::mv(stream)), client(kj::newHttpClient(headerTable, *this->stream)) {}
  };

  kj::Own<IsolateRuntimeConfig> config;
  kj::Own<IsolateRuntimeHost> host;

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

      return host->runtimeAdapterFactory->connect(*config, *host)
          .then([this](kj::Own<kj::AsyncIoStream>&& stream) mutable {
        auto newState = kj::refcounted<SidecarHttpState>(kj::mv(stream), host->headerTable);
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

      return host->runtimeAdapterFactory->connect(*config, *host)
          .then([this, results, responseStream = kj::mv(responseStream)](
              kj::Own<kj::AsyncIoStream>&& stream) mutable {
        auto state = kj::refcounted<SidecarHttpState>(kj::mv(stream), host->headerTable);
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
    return host->runtimeAdapterFactory->connect(*config, *host)
        .then([this, request = kj::mv(request)](kj::Own<kj::AsyncIoStream>&& stream) mutable {
      auto state = kj::refcounted<SidecarHttpState>(kj::mv(stream), host->headerTable);
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

  kj::Promise<void> openWebSocketFromSidecar(FetchRequest&& request,
      WebSession::WebSocketStream::Client clientStream,
      WebSession::OpenWebSocketResults::Builder results) {
    KJ_LOG(WARNING, "Forwarding isolate WebSocket request to sidecar.", request.path);
    return host->runtimeAdapterFactory->connect(*config, *host)
        .then([request = kj::mv(request), clientStream = kj::mv(clientStream), results](
            kj::Own<kj::AsyncIoStream>&& stream) mutable -> kj::Promise<void> {
      auto rawRequest = renderSidecarWebSocketUpgradeRequest(request);
        auto& streamRef = *stream;
        return streamRef.write(rawRequest.begin(), rawRequest.size())
            .attach(kj::mv(rawRequest))
            .then([stream = kj::mv(stream), clientStream = kj::mv(clientStream), results]()
                mutable {
          auto parser = kj::refcounted<IsolateWebSocketUpgradeParser>();
          return parser->read(*stream)
              .then([stream = kj::mv(stream), clientStream = kj::mv(clientStream), results](
                  IsolateWebSocketUpgradeResponse&& upgrade) mutable {
            auto protocols = upgrade.protocols.asPtr();
            auto protocolList = results.initProtocol(protocols.size());
            for (auto i: kj::indices(protocols)) {
              protocolList.set(i, protocols[i]);
            }
            results.setServerStream(kj::heap<IsolateRawWebSocketPump>(
                kj::mv(stream), kj::mv(clientStream), kj::mv(upgrade.remainder)));
          }).attach(kj::mv(parser));
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

class WorkerdRuntimeAdapterFactory final: public IsolateRuntimeAdapterFactory {
public:
  kj::HttpHeaderTable& getHeaderTable() override { return headerTable; }
  bool isConfigured(const IsolateRuntimeConfig& config) override {
    return config.workerdSocketPath.size() > 0;
  }
  bool isAvailable(const IsolateRuntimeConfig& config) override {
    return isConfigured(config) && access(config.workerdSocketPath.cStr(), F_OK) == 0;
  }
  kj::Promise<kj::Own<kj::AsyncIoStream>> connect(
      IsolateRuntimeConfig& config, IsolateRuntimeHost& host) override {
    return host.network.parseAddress(kj::str("unix:", config.workerdSocketPath), 0)
        .then([](kj::Own<kj::NetworkAddress>&& address) { return address->connect(); });
  }

  capnp::HttpService::Client exportHttpService(kj::Own<kj::HttpService>) override {
    KJ_FAIL_REQUIRE("sidecar runtime adapters cannot export in-process binding services");
  }

  kj::Own<IsolateRuntimeAdapter> make(
      kj::Own<IsolateRuntimeConfig> config, kj::Own<IsolateRuntimeHost> host) override {
    return kj::heap<WorkerdRuntimeAdapter>(kj::mv(config), kj::mv(host));
  }

private:
  kj::HttpHeaderTable headerTable;
};

class HostedRuntimeAdapterFactory final: public IsolateRuntimeAdapterFactory {
public:
  HostedRuntimeAdapterFactory()
      : httpFactory(byteStreamFactory, headerTableBuilder),
        headerTable(headerTableBuilder.build()) {}

  explicit HostedRuntimeAdapterFactory(HostedIsolate::Client hosted)
      : HostedRuntimeAdapterFactory() {
    setHosted(kj::mv(hosted));
  }

  void setHosted(HostedIsolate::Client value) { hosted = kj::mv(value); }

  kj::HttpHeaderTable& getHeaderTable() override { return *headerTable; }
  bool isConfigured(const IsolateRuntimeConfig&) override { return true; }
  bool isAvailable(const IsolateRuntimeConfig&) override { return true; }

  kj::Promise<kj::Own<kj::AsyncIoStream>> connect(
      IsolateRuntimeConfig&, IsolateRuntimeHost& host) override {
    auto& hostedClient = KJ_REQUIRE_NONNULL(hosted, "hosted isolate ingress is not ready");
    return hostedClient.getHttpServiceRequest().send().then(
        [this, &host](auto response) mutable -> kj::Own<kj::AsyncIoStream> {
      auto service = httpFactory.capnpToKj(response.getService());
      auto pipe = kj::newTwoWayPipe();
      auto server = kj::heap<kj::HttpServer>(host.timer, *headerTable, *service);
      auto serverTask = server->listenHttp(kj::mv(pipe.ends[0]))
          .attach(kj::mv(server), kj::mv(service));
      return kj::mv(pipe.ends[1]).attach(kj::mv(serverTask));
    });
  }

  capnp::HttpService::Client exportHttpService(kj::Own<kj::HttpService> service) override {
    return httpFactory.kjToCapnp(kj::mv(service));
  }

  kj::Own<IsolateRuntimeAdapter> make(
      kj::Own<IsolateRuntimeConfig> config, kj::Own<IsolateRuntimeHost> host) override {
    return kj::heap<WorkerdRuntimeAdapter>(kj::mv(config), kj::mv(host));
  }

private:
  capnp::ByteStreamFactory byteStreamFactory;
  kj::HttpHeaderTable::Builder headerTableBuilder;
  capnp::HttpOverCapnpFactory httpFactory;
  kj::Own<kj::HttpHeaderTable> headerTable;
  kj::Maybe<HostedIsolate::Client> hosted;
};

kj::Own<WebSession::RequestStream::Server> WorkerdRuntimeAdapter::startRequestStream(
    FetchRequest&& request, ByteStream::Client responseStream) {
  KJ_REQUIRE(host->runtimeAdapterFactory->isAvailable(*config),
      "isolate runtime endpoint is not available");
  return kj::heap<StreamingRequestImpl>(
      kj::addRef(*config), kj::addRef(*host), kj::mv(request), kj::mv(responseStream));
}

kj::Own<IsolateRuntimeConfig> loadIsolateRuntimeConfig(
    kj::StringPtr pkgPath, kj::Maybe<kj::StringPtr> requestedMainModule,
    kj::Maybe<kj::StringPtr> requestedCompatibilityDate,
    bool enforceSharedHostLimits = false) {
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

      found = copyIsolateConfig(isolate, pkgPath, enforceSharedHostLimits);
    }
  };

  KJ_IF_MAYBE(mainModule, requestedMainModule) {
    considerCommand(manifest.getContinueCommand());
    for (auto action: manifest.getActions()) {
      considerCommand(action.getCommand());
    }
  } else {
    if (manifest.getContinueCommand().hasIsolate()) {
      return copyIsolateConfig(
          manifest.getContinueCommand().getIsolate(), pkgPath, enforceSharedHostLimits);
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
};

SupervisorObjectId<>::RouteBackedSession::Type routeBackedCapabilityObjectIdType(
    RouteBackedCapabilityType type) {
  switch (type) {
    case RouteBackedCapabilityType::WEB:
      return SupervisorObjectId<>::RouteBackedSession::Type::WEB;
    case RouteBackedCapabilityType::API:
      return SupervisorObjectId<>::RouteBackedSession::Type::API;
  }
  KJ_UNREACHABLE;
}

RouteBackedCapabilityType routeBackedCapabilityTypeFromObjectId(
    SupervisorObjectId<>::RouteBackedSession::Type type) {
  switch (type) {
    case SupervisorObjectId<>::RouteBackedSession::Type::WEB:
      return RouteBackedCapabilityType::WEB;
    case SupervisorObjectId<>::RouteBackedSession::Type::API:
      return RouteBackedCapabilityType::API;
  }
  KJ_UNREACHABLE;
}

RouteBackedCapabilityType routeBackedCapabilityTypeFromNativeInterface(kj::StringPtr value) {
  if (value == "webSession") {
    return RouteBackedCapabilityType::WEB;
  } else if (value == "apiSession") {
    return RouteBackedCapabilityType::API;
  } else {
    KJ_FAIL_REQUIRE("invalid route-backed capability native interface", value);
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

struct RouteBackedCapabilityRef {
  RouteBackedCapabilityType type;
  kj::String pathPrefix;
};

RouteBackedCapabilityRef readRouteBackedCapabilityRef(
    SupervisorObjectId<>::RouteBackedSession::Reader ref) {
  return RouteBackedCapabilityRef {
      routeBackedCapabilityTypeFromObjectId(ref.getType()),
      normalizeRouteBackedPathPrefix(ref.getPathPrefix()),
  };
}

template <typename InternalSession>
RouteBackedCapabilityType routeBackedCapabilityType();

template <>
RouteBackedCapabilityType routeBackedCapabilityType<IsolateWebSession>() {
  return RouteBackedCapabilityType::WEB;
}

template <>
RouteBackedCapabilityType routeBackedCapabilityType<IsolateApiSession>() {
  return RouteBackedCapabilityType::API;
}

struct PersistentRequirementState final: public kj::Refcounted {
  bool revoked = false;
  kj::Vector<OwnCapnp<capnp::List<MembraneRequirement>>> requirements;
  kj::Vector<SystemPersistent::RevocationObserver::Client> observers;
};

class PersistentRevokerHandle final: public Handle::Server {
public:
  explicit PersistentRevokerHandle(kj::Own<PersistentRequirementState> state)
      : state(kj::mv(state)) {}

  ~PersistentRevokerHandle() noexcept(false) {
    state->revoked = true;
  }

private:
  kj::Own<PersistentRequirementState> state;
};

capnp::Orphan<capnp::List<MembraneRequirement>> collectPersistentRequirements(
    PersistentRequirementState& state, capnp::Orphanage orphanage) {
  if (state.requirements.size() == 0) {
    return {};
  }

  kj::Vector<capnp::List<MembraneRequirement>::Reader> parts(state.requirements.size());
  for (auto& requirement: state.requirements) {
    if (requirement.size() > 0) {
      parts.add(requirement);
    }
  }

  if (parts.size() > 0) {
    return orphanage.newOrphanConcat(parts.asPtr());
  }
  return {};
}

template <typename InternalSession>
class IsolateRouteBackedSessionImpl final: public InternalSession::Server {
public:
  IsolateRouteBackedSessionImpl(
      kj::Own<IsolateRuntimeConfig> config, kj::Own<IsolateRuntimeHost> host,
      kj::StringPtr pathPrefix = "", SessionKind sessionKind = SessionKind::NORMAL,
      SessionMetadata&& sessionMetadata = SessionMetadata(), bool persistent = true,
      kj::Own<PersistentRequirementState> requirementState =
          kj::refcounted<PersistentRequirementState>(),
      kj::Maybe<kj::Array<const byte>> parentToken = nullptr)
      : pathPrefix(kj::heapString(pathPrefix)),
        sessionKind(sessionKind),
        sessionMetadata(kj::mv(sessionMetadata)),
        persistent(persistent),
        requirementState(kj::mv(requirementState)),
        parentToken(kj::mv(parentToken)),
        runtimeConfig(kj::addRef(*config)),
        runtimeHost(kj::addRef(*host)),
        runtime(runtimeHost->runtimeAdapterFactory->make(kj::mv(config), kj::mv(host))) {}

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

  kj::Promise<void> openWebSocket(
      typename InternalSession::Server::OpenWebSocketContext context) override {
    auto params = context.getParams();
    auto request = makeFetchRequest(FetchMethod::GET, prefixedPath(params.getPath()),
        params.getContext());
    auto protocols = params.getProtocol();
    if (protocols.size() > 0) {
      addHeader(request, "sec-websocket-protocol", kj::strArray(protocols, ", "));
    }
    addSessionHeaders(request);
    KJ_LOG(WARNING, "Handling isolate WebSession WebSocket request.",
        request.path, sessionKindName(sessionKind));
    return runtime->openWebSocket(
        kj::mv(request), params.getClientStream(), context.getResults());
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
    req.setHandle(kj::heap<PersistentRevokerHandle>(kj::addRef(*requirementState)));
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
      request.adoptRequirements(collectPersistentRequirements(*requirementState,
          capnp::Orphanage::getForMessageContaining(
              SandstormCore::MakeChildTokenParams::Builder(request))));
      return request.send().then([context](auto result) mutable {
        context.getResults().setSturdyRef(result.getToken());
      });
    } else {
      auto request = runtimeHost->sandstormCore.makeTokenRequest();
      auto routeRef = request.getRef().initRouteBackedSession();
      routeRef.setType(routeBackedCapabilityObjectIdType(capabilityType()));
      routeRef.setPathPrefix(pathPrefix);
      request.setOwner(params.getSealFor());
      request.adoptRequirements(collectPersistentRequirements(*requirementState,
          capnp::Orphanage::getForMessageContaining(
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
  kj::Own<PersistentRequirementState> requirementState;
  kj::Maybe<kj::Array<const byte>> parentToken;
  kj::Own<IsolateRuntimeConfig> runtimeConfig;
  kj::Own<IsolateRuntimeHost> runtimeHost;
  kj::Own<IsolateRuntimeAdapter> runtime;

  RouteBackedCapabilityType capabilityType() { return routeBackedCapabilityType<InternalSession>(); }

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

capnp::Capability::Client makeRouteBackedSessionCapability(
    kj::Own<IsolateRuntimeConfig> config, kj::Own<IsolateRuntimeHost> host,
    RouteBackedCapabilityType capabilityType, kj::StringPtr pathPrefix, bool persistent,
    kj::Maybe<kj::Array<const byte>> parentToken = nullptr) {
  switch (capabilityType) {
    case RouteBackedCapabilityType::WEB:
      return kj::heap<IsolateRouteBackedSessionImpl<IsolateWebSession>>(
          kj::mv(config), kj::mv(host), pathPrefix, SessionKind::NORMAL,
          SessionMetadata(), persistent, kj::refcounted<PersistentRequirementState>(),
          kj::mv(parentToken));
    case RouteBackedCapabilityType::API:
      return kj::heap<IsolateRouteBackedSessionImpl<IsolateApiSession>>(
          kj::mv(config), kj::mv(host), pathPrefix, SessionKind::NORMAL,
          SessionMetadata(), persistent, kj::refcounted<PersistentRequirementState>(),
          kj::mv(parentToken));
  }
  KJ_UNREACHABLE;
}

class IsolateMainViewRpcEntropySource final: public kj::EntropySource {
public:
  void generate(kj::ArrayPtr<byte> buffer) override {
    randombytes_buf(buffer.begin(), buffer.size());
  }
};

struct IsolateMainViewRpcWebSocketState final: public kj::Refcounted {
  kj::Own<kj::AsyncIoStream> stream;
  kj::Own<kj::HttpClient> client;
  kj::Own<kj::WebSocket> webSocket;

  IsolateMainViewRpcWebSocketState(kj::Own<kj::AsyncIoStream>&& stream,
      kj::Own<kj::HttpClient>&& client, kj::Own<kj::WebSocket>&& webSocket)
      : stream(kj::mv(stream)), client(kj::mv(client)), webSocket(kj::mv(webSocket)) {}
};

struct IsolateMainViewRpcFailedWebSocketState final: public kj::Refcounted {
  kj::Own<kj::AsyncIoStream> stream;
  kj::Own<kj::HttpClient> client;
  kj::Own<kj::AsyncInputStream> body;

  IsolateMainViewRpcFailedWebSocketState(kj::Own<kj::AsyncIoStream>&& stream,
      kj::Own<kj::HttpClient>&& client, kj::Own<kj::AsyncInputStream>&& body)
      : stream(kj::mv(stream)), client(kj::mv(client)), body(kj::mv(body)) {}
};

class IsolateMainViewRpcMessageStream final: public capnp::MessageStream {
public:
  IsolateMainViewRpcMessageStream(kj::Own<IsolateRuntimeConfig> config,
      kj::Own<IsolateRuntimeHost> host, kj::HttpHeaderTable& headerTable, kj::String path)
      : config(kj::mv(config)),
        host(kj::mv(host)),
        headerTable(headerTable),
        path(kj::mv(path)) {}

  kj::Promise<kj::Maybe<capnp::MessageReaderAndFds>> tryReadMessage(
      kj::ArrayPtr<kj::AutoCloseFd> fdSpace,
      capnp::ReaderOptions options = capnp::ReaderOptions(),
      kj::ArrayPtr<capnp::word> scratchSpace = nullptr) override {
    (void)fdSpace;
    return ensureStarted().then([this, options, scratchSpace]() mutable {
      auto& current = KJ_ASSERT_NONNULL(state);
      return current->webSocket->receive(MAX_NATIVE_CAPNP_RPC_WEBSOCKET_MESSAGE_BYTES)
          .then([options, scratchSpace](kj::WebSocket::Message&& message) mutable
              -> kj::Maybe<capnp::MessageReaderAndFds> {
        KJ_SWITCH_ONEOF(message) {
          KJ_CASE_ONEOF(text, kj::String) {
            KJ_FAIL_REQUIRE("native Cap'n Proto MainView RPC session received a text WebSocket frame");
          }
          KJ_CASE_ONEOF(bytes, kj::Array<byte>) {
            auto reader = parseIsolateCapnpRpcFrame(bytes, options, scratchSpace);
            return capnp::MessageReaderAndFds { kj::mv(reader), nullptr };
          }
          KJ_CASE_ONEOF(close, kj::WebSocket::Close) {
            (void)close;
            return nullptr;
          }
        }
        KJ_UNREACHABLE;
      });
    });
  }

  kj::Promise<void> writeMessage(kj::ArrayPtr<const int> fds,
      kj::ArrayPtr<const kj::ArrayPtr<const capnp::word>> segments) override {
    if (fds.size() > 0) {
      return KJ_EXCEPTION(UNIMPLEMENTED,
          "native Cap'n Proto MainView RPC sessions do not support file descriptors");
    }

    auto data = serializeMessageSegments(segments);
    auto fork = writeQueue.then([this, data = kj::mv(data)]() mutable {
      return ensureStarted().then([this, data = kj::mv(data)]() mutable {
        auto& current = KJ_ASSERT_NONNULL(state);
        return current->webSocket->send(data.asPtr()).attach(kj::mv(data));
      });
    }).fork();
    writeQueue = fork.addBranch();
    return fork.addBranch();
  }

  kj::Promise<void> writeMessages(
      kj::ArrayPtr<kj::ArrayPtr<const kj::ArrayPtr<const capnp::word>>> messages) override {
    kj::Vector<kj::Array<byte>> serialized;
    for (auto message: messages) {
      serialized.add(serializeMessageSegments(message));
    }
    auto fork = writeQueue.then([this, serialized = serialized.releaseAsArray()]() mutable {
      return ensureStarted().then([this, serialized = kj::mv(serialized)]() mutable {
        auto& current = KJ_ASSERT_NONNULL(state);
        auto webSocket = current->webSocket.get();
        kj::Promise<void> result = kj::READY_NOW;
        for (auto& message: serialized) {
          result = result.then([webSocket, data = kj::mv(message)]() mutable {
            return webSocket->send(data.asPtr()).attach(kj::mv(data));
          });
        }
        return kj::mv(result).attach(kj::mv(serialized));
      });
    }).fork();
    writeQueue = fork.addBranch();
    return fork.addBranch();
  }

  kj::Maybe<int> getSendBufferSize() override {
    return nullptr;
  }

  kj::Promise<void> end() override {
    auto fork = writeQueue.then([this]() mutable -> kj::Promise<void> {
      KJ_IF_MAYBE(existing, started) {
        return existing->addBranch().then([this]() mutable -> kj::Promise<void> {
          KJ_IF_MAYBE(current, state) {
            return (*current)->webSocket->close(1000, "native Cap'n Proto MainView RPC session ended");
          }
          return kj::READY_NOW;
        });
      }

      KJ_IF_MAYBE(current, state) {
        return (*current)->webSocket->close(1000, "native Cap'n Proto MainView RPC session ended");
      }
      return kj::READY_NOW;
    }).fork();
    writeQueue = fork.addBranch();
    return fork.addBranch();
  }

private:
  kj::Own<IsolateRuntimeConfig> config;
  kj::Own<IsolateRuntimeHost> host;
  kj::HttpHeaderTable& headerTable;
  kj::String path;
  kj::Maybe<kj::Own<IsolateMainViewRpcWebSocketState>> state;
  kj::Maybe<kj::ForkedPromise<void>> started;
  kj::Promise<void> writeQueue = kj::READY_NOW;

  kj::Promise<void> ensureStarted() {
    KJ_IF_MAYBE(existing, started) {
      return existing->addBranch();
    }

    started = start().fork();
    return KJ_ASSERT_NONNULL(started).addBranch();
  }

  kj::Promise<void> start() {
    return host->runtimeAdapterFactory->connect(*config, *host)
        .then([this](kj::Own<kj::AsyncIoStream>&& stream) mutable {
      static IsolateMainViewRpcEntropySource entropySource;
      kj::HttpClientSettings settings;
      settings.entropySource = entropySource;
      auto client = kj::newHttpClient(headerTable, *stream, settings);
      kj::HttpHeaders headers(headerTable);
      headers.set(kj::HttpHeaderId::HOST, "sandbox");
      return client->openWebSocket(path, headers)
          .then([this, stream = kj::mv(stream), client = kj::mv(client)](
              kj::HttpClient::WebSocketResponse&& response) mutable -> kj::Promise<void> {
        if (response.statusCode != 101) {
          auto statusCode = response.statusCode;
          auto statusText = kj::str(response.statusText);
          KJ_LOG(WARNING, "MainView RPC WebSocket returned an unsuccessful status.",
              statusCode, statusText);
          KJ_SWITCH_ONEOF(response.webSocketOrBody) {
            KJ_CASE_ONEOF(body, kj::Own<kj::AsyncInputStream>) {
              auto failed = kj::refcounted<IsolateMainViewRpcFailedWebSocketState>(
                  kj::mv(stream), kj::mv(client), kj::mv(body));
              return failed->body->readAllText()
                  .then([statusCode, statusText = kj::mv(statusText),
                      failed = kj::mv(failed)](kj::String&& bodyText) mutable {
                (void)failed;
                KJ_FAIL_REQUIRE(
                    "MainView RPC WebSocket returned an unsuccessful status",
                    statusCode, statusText, bodyText);
              });
            }
            KJ_CASE_ONEOF(webSocket, kj::Own<kj::WebSocket>) {
              (void)webSocket;
              KJ_FAIL_REQUIRE(
                  "MainView RPC WebSocket returned an unsuccessful status",
                  statusCode, statusText);
            }
          }
        }
        KJ_SWITCH_ONEOF(response.webSocketOrBody) {
          KJ_CASE_ONEOF(body, kj::Own<kj::AsyncInputStream>) {
            (void)body;
            KJ_FAIL_REQUIRE("MainView RPC WebSocket did not upgrade");
          }
          KJ_CASE_ONEOF(webSocket, kj::Own<kj::WebSocket>) {
            state = kj::refcounted<IsolateMainViewRpcWebSocketState>(
                kj::mv(stream), kj::mv(client), kj::mv(webSocket));
            return kj::READY_NOW;
          }
        }
        KJ_UNREACHABLE;
      });
    });
  }

  kj::Array<byte> serializeMessageSegments(
      kj::ArrayPtr<const kj::ArrayPtr<const capnp::word>> segments) {
    kj::VectorOutputStream output;
    capnp::writeMessage(output, segments);
    auto data = output.getArray();
    auto result = kj::heapArray<byte>(data.size());
    memcpy(result.begin(), data.begin(), data.size());
    return result;
  }
};

struct IsolateMainViewRpcSession {
  kj::String sessionId;
  kj::String path;
  uint64_t interfaceId = 0;
  kj::String interfaceName;

  IsolateMainViewRpcMessageStream stream;
  capnp::TwoPartyVatNetwork network;
  capnp::RpcSystem<capnp::rpc::twoparty::VatId> rpcSystem;
  kj::Maybe<capnp::Capability::Client> cap;

  IsolateMainViewRpcSession(kj::Own<IsolateRuntimeConfig> config,
      kj::Own<IsolateRuntimeHost> host, kj::HttpHeaderTable& headerTable,
      kj::String sessionId, kj::String path, uint64_t interfaceId, kj::String interfaceName)
      : sessionId(kj::mv(sessionId)),
        path(kj::heapString(path)),
        interfaceId(interfaceId),
        interfaceName(kj::mv(interfaceName)),
        stream(kj::mv(config), kj::mv(host), headerTable, kj::mv(path)),
        network(stream, capnp::rpc::twoparty::Side::CLIENT),
        rpcSystem(network, kj::Maybe<capnp::Capability::Client>(nullptr)) {
    capnp::MallocMessageBuilder message;
    auto vatId = message.initRoot<capnp::rpc::twoparty::VatId>();
    vatId.setSide(capnp::rpc::twoparty::Side::SERVER);
    cap = rpcSystem.bootstrap(vatId);
  }
};

kj::Own<IsolateMainViewRpcSession> newIsolateMainViewRpcSession(
    kj::Own<IsolateRuntimeConfig> config, kj::Own<IsolateRuntimeHost> host,
    kj::HttpHeaderTable& headerTable) {
  return kj::heap<IsolateMainViewRpcSession>(
      kj::mv(config), kj::mv(host), headerTable,
      kj::heapString("mainView"), kj::heapString(ISOLATE_MAIN_VIEW_RPC_SESSION_PATH),
      capnp::typeId<MainView<>>(), kj::heapString("sandstorm.MainView"));
}

class IsolateMainViewRestoredCapability final: public SystemPersistent::Server {
public:
  IsolateMainViewRestoredCapability(kj::Own<IsolateRuntimeHost> host,
      kj::Own<IsolateMainViewRpcSession> session, capnp::Capability::Client cap,
      kj::Maybe<kj::Array<const byte>> parentToken = nullptr,
      kj::Own<PersistentRequirementState> requirementState =
          kj::refcounted<PersistentRequirementState>())
      : host(kj::mv(host)),
        session(kj::mv(session)),
        cap(kj::mv(cap)),
        parentToken(kj::mv(parentToken)),
        requirementState(kj::mv(requirementState)) {}

  DispatchCallResult dispatchCall(uint64_t interfaceId, uint16_t methodId,
      capnp::CallContext<capnp::AnyPointer, capnp::AnyPointer> context) override {
    if (interfaceId == SYSTEM_PERSISTENT_INTERFACE_ID ||
        interfaceId == CAPNP_PERSISTENT_INTERFACE_ID) {
      return SystemPersistent::Server::dispatchCall(interfaceId, methodId, context);
    }
    if (interfaceId == APP_PERSISTENT_INTERFACE_ID) {
      KJ_UNIMPLEMENTED("can't call AppPersistent.save() from outside isolate grain");
    }
    KJ_REQUIRE(!requirementState->revoked,
        "isolate app capability requirements have been revoked");

    capnp::AnyPointer::Reader params = context.getParams();
    auto request = cap.typelessRequest(interfaceId, methodId, params.targetSize());
    request.set(params);
    auto promise = request.send().then([context](auto&& response) mutable -> kj::Promise<void> {
      context.initResults(response.targetSize()).set(response);
      return kj::READY_NOW;
    });
    return { kj::mv(promise), false };
  }

  kj::Promise<void> addRequirements(AddRequirementsContext context) override {
    auto params = context.getParams();
    if (params.getRequirements().size() > 0) {
      requirementState->requirements.add(newOwnCapnp(params.getRequirements()));
    }

    auto observer = params.getObserver();
    auto req = observer.dropWhenRevokedRequest();
    req.setHandle(kj::heap<PersistentRevokerHandle>(kj::addRef(*requirementState)));
    requirementState->observers.add(kj::mv(observer));

    return req.send().ignoreResult().then([this, context]() mutable {
      context.getResults().setCap(this->thisCap().castAs<SystemPersistent>());
    });
  }

  kj::Promise<void> save(SaveContext context) override {
    KJ_REQUIRE(!requirementState->revoked,
        "isolate app capability requirements have been revoked");
    auto owner = newOwnCapnp(context.getParams().getSealFor());
    KJ_IF_MAYBE(parent, parentToken) {
      auto request = host->sandstormCore.makeChildTokenRequest();
      request.setParent(*parent);
      request.setOwner(owner);
      request.adoptRequirements(collectPersistentRequirements(*requirementState,
          capnp::Orphanage::getForMessageContaining(
              SandstormCore::MakeChildTokenParams::Builder(request))));
      return request.send().then([context](auto result) mutable {
        context.getResults().setSturdyRef(result.getToken());
      });
    }

    auto appRequest = cap.castAs<AppPersistent<>>().saveRequest();
    return appRequest.send().then([this, context, KJ_MVCAP(owner)](auto result) mutable {
      auto request = host->sandstormCore.makeTokenRequest();
      request.getRef().setAppRef(result.getObjectId());
      request.setOwner(owner);
      request.adoptRequirements(collectPersistentRequirements(*requirementState,
          capnp::Orphanage::getForMessageContaining(
              SandstormCore::MakeTokenParams::Builder(request))));
      return request.send().then([context](auto result) mutable {
        context.getResults().setSturdyRef(result.getToken());
      });
    });
  }

private:
  kj::Own<IsolateRuntimeHost> host;
  kj::Own<IsolateMainViewRpcSession> session;
  capnp::Capability::Client cap;
  kj::Maybe<kj::Array<const byte>> parentToken;
  kj::Own<PersistentRequirementState> requirementState;
};

class IsolateAppPersistentCapability final: public SystemPersistent::Server {
public:
  IsolateAppPersistentCapability(kj::Own<IsolateRuntimeHost> host,
      capnp::Capability::Client cap,
      kj::Own<PersistentRequirementState> requirementState =
          kj::refcounted<PersistentRequirementState>())
      : host(kj::mv(host)),
        cap(kj::mv(cap)),
        requirementState(kj::mv(requirementState)) {}

  DispatchCallResult dispatchCall(uint64_t interfaceId, uint16_t methodId,
      capnp::CallContext<capnp::AnyPointer, capnp::AnyPointer> context) override {
    if (interfaceId == SYSTEM_PERSISTENT_INTERFACE_ID ||
        interfaceId == CAPNP_PERSISTENT_INTERFACE_ID) {
      return SystemPersistent::Server::dispatchCall(interfaceId, methodId, context);
    }
    if (interfaceId == APP_PERSISTENT_INTERFACE_ID) {
      KJ_UNIMPLEMENTED("can't call AppPersistent.save() from outside isolate grain");
    }
    KJ_REQUIRE(!requirementState->revoked,
        "isolate app capability requirements have been revoked");

    capnp::AnyPointer::Reader params = context.getParams();
    auto request = cap.typelessRequest(interfaceId, methodId, params.targetSize());
    request.set(params);
    auto promise = request.send().then([context](auto&& response) mutable -> kj::Promise<void> {
      context.initResults(response.targetSize()).set(response);
      return kj::READY_NOW;
    });
    return { kj::mv(promise), false };
  }

  kj::Promise<void> addRequirements(AddRequirementsContext context) override {
    auto params = context.getParams();
    if (params.getRequirements().size() > 0) {
      requirementState->requirements.add(newOwnCapnp(params.getRequirements()));
    }

    auto observer = params.getObserver();
    auto req = observer.dropWhenRevokedRequest();
    req.setHandle(kj::heap<PersistentRevokerHandle>(kj::addRef(*requirementState)));
    requirementState->observers.add(kj::mv(observer));

    return req.send().ignoreResult().then([this, context]() mutable {
      context.getResults().setCap(this->thisCap().castAs<SystemPersistent>());
    });
  }

  kj::Promise<void> save(SaveContext context) override {
    KJ_REQUIRE(!requirementState->revoked,
        "isolate app capability requirements have been revoked");
    auto owner = newOwnCapnp(context.getParams().getSealFor());
    auto appRequest = cap.castAs<AppPersistent<>>().saveRequest();
    return appRequest.send().then([this, context, KJ_MVCAP(owner)](auto result) mutable {
      auto request = host->sandstormCore.makeTokenRequest();
      request.getRef().setAppRef(result.getObjectId());
      request.setOwner(owner);
      request.adoptRequirements(collectPersistentRequirements(*requirementState,
          capnp::Orphanage::getForMessageContaining(
              SandstormCore::MakeTokenParams::Builder(request))));
      return request.send().then([context](auto result) mutable {
        context.getResults().setSturdyRef(result.getToken());
      });
    });
  }

private:
  kj::Own<IsolateRuntimeHost> host;
  capnp::Capability::Client cap;
  kj::Own<PersistentRequirementState> requirementState;
};

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
    sessionMetadata.sessionId = runtimeHost->sessions->registerOfferSession(
        params.getContext(), params.getOffer());
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
      isolateSidecarPid = p->getPid();
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
        if (isolateSidecarPid == p->getPid()) {
          isolateSidecarPid = 0;
        }
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
      if (isolateSidecarPid == p->getPid()) {
        isolateSidecarPid = 0;
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

void closeUnexpectedSidecarFds(kj::ArrayPtr<const int> preservedFds = nullptr) {
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
        bool preserve = false;
        for (auto preserved: preservedFds) {
          if (fd == preserved) preserve = true;
        }
        if (!preserve) fds.add(fd);
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

void setupConfinedRuntimeMountRoot(
    kj::StringPtr trustedExecutable, kj::Maybe<kj::StringPtr> runtimeBundleDir) {
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

  KJ_IF_MAYBE(bundleDir, runtimeBundleDir) {
    bindSidecarDirectory(*bundleDir, MS_NOSUID | MS_NODEV);
  }
  bindSidecarFile(trustedExecutable, MS_RDONLY | MS_NOSUID | MS_NODEV, 0755);
  bindSidecarRuntimeLibraries();
  bindSidecarFile("/etc/ld.so.cache", MS_RDONLY | MS_NOSUID | MS_NOEXEC | MS_NODEV);

  KJ_SYSCALL(chroot("/tmp"));
  KJ_SYSCALL(chdir("/"));
  KJ_LOG(WARNING, "Isolate sidecar entered minimal mount root.", trustedExecutable);
}

void setupSidecarMountRoot(kj::StringPtr trustedWorkerd, kj::StringPtr workerdBundleDir) {
  setupConfinedRuntimeMountRoot(trustedWorkerd, workerdBundleDir);
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
    SCMP_SYS(pipe2),
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
    SCMP_SYS(splice),
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

int runConfinedNativeIsolateHost(
    kj::String trustedHost,
    kj::AutoCloseFd controlSocket,
    kj::Maybe<uid_t> sandboxUid,
    bool logSeccompViolations) {
  static constexpr int CONTROL_FD = 3;
  resetSignalHandlersForExec();
  setupSidecarParentDeathSignal();
  setupSidecarProcessGroup();

  int sourceFd = controlSocket.release();
  if (sourceFd != CONTROL_FD) {
    KJ_SYSCALL(dup2(sourceFd, CONTROL_FD));
    KJ_SYSCALL(close(sourceFd));
  } else {
    KJ_SYSCALL(fcntl(CONTROL_FD, F_SETFD, 0));
  }

  auto devNull = raiiOpen("/dev/null", O_RDONLY | O_CLOEXEC);
  KJ_SYSCALL(dup2(devNull, STDIN_FILENO));
  devNull = nullptr;
  int preservedFd = CONTROL_FD;
  closeUnexpectedSidecarFds(kj::arrayPtr(&preservedFd, 1));

  bool hasPrivateNamespaces = trySetupSidecarNamespaces(sandboxUid);
  if (hasPrivateNamespaces) {
    setupConfinedRuntimeMountRoot(trustedHost, nullptr);
  }
  KJ_IF_MAYBE(u, sandboxUid) {
    KJ_SYSCALL(setresuid(*u, *u, *u));
  }
  setupSidecarResourceLimits();
  KJ_SYSCALL(prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0));
  setupSidecarSeccomp(logSeccompViolations);

  char* argv[] = {
    const_cast<char*>(trustedHost.cStr()),
    const_cast<char*>("--control-fd"),
    const_cast<char*>("3"),
    nullptr,
  };
  char* environment[] = {
    const_cast<char*>("LANG=C.UTF-8"),
    nullptr,
  };
  KJ_SYSCALL(execve(trustedHost.cStr(), argv, environment), trustedHost);
  KJ_UNREACHABLE;
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
    KJ_LOG(WARNING, "Isolate Sandstorm API binding received request.", methodName, path);

    if (!powerboxOnly && methodName == "GET" && route == "/capnp/rpc-session") {
      return openNativeCapnpBridgeRpcSession(path, headers, response);
    }

    auto maxBodyBytes = MAX_API_BINDING_REQUEST_BYTES;
    auto maxBodyDescription = "isolate Sandstorm API binding request body exceeds maximum allowed size";

    return readAllBytesAtMost(requestBody, maxBodyBytes, maxBodyDescription).then(
        [this, methodName = kj::mv(methodName), path = kj::mv(path), route = kj::mv(route),
            &response]
        (kj::Array<byte>&& bodyBytes) mutable {
      if (powerboxOnly && !route.startsWith("/powerbox/")) {
        return sendJson(response, 404, "Not Found", kj::heapString(
            "{\n  \"ok\": false,\n"
            "  \"error\": \"unknown Powerbox binding endpoint\"\n}\n"));
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
      } else if (route == "/powerbox/app-interface-descriptor") {
        return appInterfacePowerboxDescriptor(path, response);
      } else if (route == "/capabilities") {
        return sendJson(response, 200, "OK", renderCapabilities());
      } else if (route == "/runtime") {
        return sendJson(response, 200, "OK", renderRuntime());
      } else if (route == "/modules") {
        return sendJson(response, 200, "OK", renderModules());
      } else if (route == "/bindings") {
        return sendJson(response, 200, "OK", renderBindings());
      } else if (route == "/capnp/bridge-info") {
        return sendJson(response, 200, "OK", renderCapnpBridgeInfo());
      } else if (route == "/capnp/browser-module") {
        return browserCapnpEsModule(path, response);
      } else if (route == "/permissions") {
        return sendJson(response, 200, "OK", renderPermissions());
      } else {
        return sendJson(response, 404, "Not Found", kj::heapString(
            "{\n  \"ok\": false,\n  \"error\": \"unknown Sandstorm API binding endpoint\"\n}\n"));
      }
    });
  }

private:
  kj::HttpHeaderTable& headerTable;
  IsolateRuntimeConfig& config;
  IsolateRuntimeHost& host;
  bool powerboxOnly;

  class IsolateBridgeSandstormApi final: public SandstormApi<>::Server {
  public:
    explicit IsolateBridgeSandstormApi(IsolateRuntimeHost& host): host(host) {}

    kj::Promise<void> save(SaveContext context) override {
      auto args = context.getParams();
      KJ_REQUIRE(args.hasCap(), "Cannot save a null capability.");
      auto cap = args.getCap();
      auto appSaveLabel = newOwnCapnp(args.getLabel());
      auto systemSaveLabel = newOwnCapnp(args.getLabel());

      auto appRequest = cap.template castAs<AppPersistent<>>().saveRequest();
      return appRequest.send().then(
          [this, context, KJ_MVCAP(appSaveLabel)](auto result) mutable -> kj::Promise<void> {
        auto request = host.sandstormCore.makeTokenRequest();
        request.getRef().setAppRef(result.getObjectId());
        auto owner = request.getOwner().initGrain();
        owner.setGrainId(host.grainId);
        owner.setSaveLabel(appSaveLabel);
        return request.send().then([context](auto result) mutable {
          context.getResults().setToken(result.getToken());
        });
      }, [this, context, cap, KJ_MVCAP(systemSaveLabel)](
          kj::Exception&& exception) mutable -> kj::Promise<void> {
        auto description = exception.getDescription();
        if (exception.getType() != kj::Exception::Type::UNIMPLEMENTED &&
            strstr(description.cStr(), "not implemented") == nullptr) {
          throw kj::mv(exception);
        }

        auto request = cap.template castAs<SystemPersistent>().saveRequest();
        auto owner = request.getSealFor().initGrain();
        owner.setGrainId(host.grainId);
        owner.setSaveLabel(systemSaveLabel);
        return request.send().then([context](auto result) mutable {
          context.getResults().setToken(result.getSturdyRef());
        });
      });
    }

    kj::Promise<void> restore(RestoreContext context) override {
      auto request = host.sandstormCore.restoreRequest();
      request.setToken(context.getParams().getToken());
      return request.send().then([context](auto result) mutable {
        context.getResults().setCap(result.getCap());
      });
    }

    kj::Promise<void> drop(DropContext context) override {
      auto request = host.sandstormCore.dropRequest();
      request.setToken(context.getParams().getToken());
      return request.send().ignoreResult();
    }

  private:
    IsolateRuntimeHost& host;
  };

  class IsolateBridgeImpl final: public IsolateBridge::Server {
  public:
    IsolateBridgeImpl(IsolateRuntimeConfig& config, IsolateRuntimeHost& host)
        : config(config), host(host) {}

    kj::Promise<void> getSandstormApi(GetSandstormApiContext context) override {
      context.getResults().setApi(kj::heap<IsolateBridgeSandstormApi>(host));
      return kj::READY_NOW;
    }

    kj::Promise<void> getSessionContext(GetSessionContextContext context) override {
      auto sessionId = context.getParams().getSessionId();
      KJ_IF_MAYBE(sessionContext, host.sessions->findSessionContext(sessionId)) {
        context.getResults().setContext(*sessionContext);
      } else {
        KJ_FAIL_REQUIRE("isolate bridge session ID not found", sessionId);
      }
      return kj::READY_NOW;
    }

    kj::Promise<void> getOfferedCapability(GetOfferedCapabilityContext context) override {
      auto sessionId = context.getParams().getSessionId();
      KJ_IF_MAYBE(cap, host.sessions->findOfferedCapability(sessionId)) {
        context.getResults().setFound(true);
        context.getResults().setCap(*cap);
      }
      return kj::READY_NOW;
    }

    kj::Promise<void> createBrowserHandoff(CreateBrowserHandoffContext context) override {
      auto params = context.getParams();
      KJ_REQUIRE(params.hasCap(), "Cannot hand off a null browser capability.");

      auto id = host.sessions->storeBrowserHandoffCapability(
          params.getSessionId(), params.getCap());
      context.getResults().setId(id);
      return kj::READY_NOW;
    }

    kj::Promise<void> dropBrowserHandoff(DropBrowserHandoffContext context) override {
      auto id = context.getParams().getId();
      context.getResults().setReleased(host.sessions->dropBrowserHandoffCapability(id));
      return kj::READY_NOW;
    }

    kj::Promise<void> createRouteBackedCapability(
        CreateRouteBackedCapabilityContext context) override {
      auto params = context.getParams();
      auto capabilityType = routeBackedCapabilityTypeFromNativeInterface(
          params.getNativeInterface());
      auto pathPrefix = normalizeRouteBackedPathPrefix(params.getPathPrefix());

      auto cap = makeRouteBackedSessionCapability(
          kj::addRef(config), kj::addRef(host), capabilityType, pathPrefix, params.getPersistent());
      context.getResults().setCap(kj::mv(cap));
      return kj::READY_NOW;
    }

    kj::Promise<void> wrapAppPersistentCapability(
        WrapAppPersistentCapabilityContext context) override {
      auto params = context.getParams();
      KJ_REQUIRE(params.hasCap(), "Cannot wrap a null app-persistent capability.");
      context.getResults().setCap(kj::heap<IsolateAppPersistentCapability>(
          kj::addRef(host), params.getCap()));
      return kj::READY_NOW;
    }

  private:
    IsolateRuntimeConfig& config;
    IsolateRuntimeHost& host;
  };

  class BrowserIsolateBridgeImpl final: public BrowserIsolateBridge::Server {
  public:
    BrowserIsolateBridgeImpl(IsolateRuntimeConfig& config, IsolateRuntimeHost& host,
        kj::String sessionId)
        : config(config), host(host), sessionId(kj::mv(sessionId)) {}

    kj::Promise<void> getHandoffCapability(GetHandoffCapabilityContext context) override {
      KJ_REQUIRE(sessionId.size() > 0,
          "browser isolate bridge has no SessionContext for handoff resolution");
      auto id = context.getParams().getId();
      KJ_IF_MAYBE(cap, host.sessions->findBrowserHandoffCapability(sessionId, id)) {
        context.getResults().setCap(*cap);
      } else {
        KJ_FAIL_REQUIRE("browser isolate bridge handoff capability ID not found", id);
      }
      return kj::READY_NOW;
    }

    kj::Promise<void> claimPowerboxRequest(ClaimPowerboxRequestContext context) override {
      KJ_REQUIRE(sessionId.size() > 0,
          "browser isolate bridge has no SessionContext for Powerbox claiming");

      KJ_IF_MAYBE(sessionContext, host.sessions->findSessionContext(sessionId)) {
        auto params = context.getParams();
        auto request = sessionContext->claimRequestRequest();
        request.setRequestToken(params.getRequestToken());
        auto permissionDefs = config.viewInfoMessage->getRoot<UiView::ViewInfo>()
            .asReader().getPermissions();
        initRequiredPermissions(
            request.initRequiredPermissions(permissionDefs.size()), params.getRequiredPermissions());
        return request.send().then([context](auto result) mutable {
          context.getResults().setCap(result.getCap());
        });
      } else {
        KJ_FAIL_REQUIRE("browser isolate bridge session ID not found", sessionId);
      }
    }

  private:
    void initRequiredPermissions(
        capnp::List<bool>::Builder permissions, capnp::List<capnp::Text>::Reader requiredNames) {
      auto permissionDefs = config.viewInfoMessage->getRoot<UiView::ViewInfo>()
          .asReader().getPermissions();
      KJ_ASSERT(permissions.size() == permissionDefs.size());

      for (auto requiredName: requiredNames) {
        bool found = false;
        for (auto i: kj::indices(permissionDefs)) {
          if (requiredName == permissionDefs[i].getName()) {
            permissions.set(i, true);
            found = true;
            break;
          }
        }
        KJ_REQUIRE(found, "unknown required permission", requiredName);
      }
    }

    IsolateRuntimeConfig& config;
    IsolateRuntimeHost& host;
    kj::String sessionId;
  };

  class NativeCapnpBridgeController final {
  private:
  class NativeCapnpBridgeWebSocketMessageStream final: public capnp::MessageStream {
  public:
    explicit NativeCapnpBridgeWebSocketMessageStream(kj::Own<kj::WebSocket> webSocket)
        : webSocket(kj::mv(webSocket)) {}

    kj::Promise<kj::Maybe<capnp::MessageReaderAndFds>> tryReadMessage(
        kj::ArrayPtr<kj::AutoCloseFd> fdSpace,
        capnp::ReaderOptions options = capnp::ReaderOptions(),
        kj::ArrayPtr<capnp::word> scratchSpace = nullptr) override {
      (void)fdSpace;
      return webSocket->receive(MAX_NATIVE_CAPNP_RPC_WEBSOCKET_MESSAGE_BYTES)
          .then([options, scratchSpace](kj::WebSocket::Message&& message) mutable
              -> kj::Maybe<capnp::MessageReaderAndFds> {
        KJ_SWITCH_ONEOF(message) {
          KJ_CASE_ONEOF(text, kj::String) {
            KJ_FAIL_REQUIRE("native Cap'n Proto bridge WebSocket received text frame", text);
          }
          KJ_CASE_ONEOF(bytes, kj::Array<byte>) {
            auto reader = parseIsolateCapnpRpcFrame(bytes, options, scratchSpace);
            capnp::MessageReaderAndFds result { kj::mv(reader), nullptr };
            return kj::Maybe<capnp::MessageReaderAndFds>(kj::mv(result));
          }
          KJ_CASE_ONEOF(close, kj::WebSocket::Close) {
            (void)close;
            return nullptr;
          }
        }
        KJ_UNREACHABLE;
      });
    }

    kj::Promise<void> writeMessage(kj::ArrayPtr<const int> fds,
        kj::ArrayPtr<const kj::ArrayPtr<const capnp::word>> segments) override {
      if (fds.size() > 0) {
        return KJ_EXCEPTION(UNIMPLEMENTED,
            "native Cap'n Proto bridge WebSocket does not support file descriptors");
      }

      auto data = serializeMessageSegments(segments);
      auto fork = writeQueue.then([this, data = kj::mv(data)]() mutable {
        return webSocket->send(data.asPtr()).attach(kj::mv(data));
      }).fork();
      writeQueue = fork.addBranch();
      return fork.addBranch();
    }

    kj::Promise<void> writeMessages(
        kj::ArrayPtr<kj::ArrayPtr<const kj::ArrayPtr<const capnp::word>>> messages) override {
      kj::Vector<kj::Array<byte>> serialized;
      for (auto message: messages) {
        serialized.add(serializeMessageSegments(message));
      }
      auto fork = writeQueue.then([this, serialized = serialized.releaseAsArray()]() mutable {
        auto webSocketPtr = webSocket.get();
        kj::Promise<void> result = kj::READY_NOW;
        for (auto& message: serialized) {
          result = result.then([webSocketPtr, data = kj::mv(message)]() mutable {
            return webSocketPtr->send(data.asPtr()).attach(kj::mv(data));
          });
        }
        return kj::mv(result).attach(kj::mv(serialized));
      }).fork();
      writeQueue = fork.addBranch();
      return fork.addBranch();
    }

    kj::Maybe<int> getSendBufferSize() override {
      return nullptr;
    }

    kj::Promise<void> end() override {
      auto fork = writeQueue.then([this]() {
        return webSocket->close(1000, "native Cap'n Proto bridge RPC session ended");
      }).fork();
      writeQueue = fork.addBranch();
      return fork.addBranch();
    }

  private:
    kj::Own<kj::WebSocket> webSocket;
    kj::Promise<void> writeQueue = kj::READY_NOW;

    kj::Array<byte> serializeMessageSegments(
        kj::ArrayPtr<const kj::ArrayPtr<const capnp::word>> segments) {
      kj::VectorOutputStream output;
      capnp::writeMessage(output, segments);
      auto data = output.getArray();
      auto result = kj::heapArray<byte>(data.size());
      memcpy(result.begin(), data.begin(), data.size());
      return result;
    }
  };

  struct NativeCapnpBridgeWebSocketRpcSession {
    NativeCapnpBridgeWebSocketMessageStream stream;
    capnp::TwoPartyVatNetwork network;
    capnp::RpcSystem<capnp::rpc::twoparty::VatId> rpcSystem;

    NativeCapnpBridgeWebSocketRpcSession(kj::Own<kj::WebSocket> webSocket,
        capnp::Capability::Client bootstrap)
        : stream(kj::mv(webSocket)),
          network(stream, capnp::rpc::twoparty::Side::SERVER),
          rpcSystem(capnp::makeRpcServer(network, kj::mv(bootstrap))) {}
  };

  std::set<std::string> nativeCapnpBridgeWebSocketRpcSessionIds;

  std::string nativeCapnpBridgeRpcSessionKey(kj::StringPtr connectionId) {
    return std::string(connectionId.begin(), connectionId.size());
  }

  public:
    bool hasRpcSession(kj::StringPtr connectionId) {
      auto key = nativeCapnpBridgeRpcSessionKey(connectionId);
      return nativeCapnpBridgeWebSocketRpcSessionIds.find(key) !=
          nativeCapnpBridgeWebSocketRpcSessionIds.end();
    }

    kj::Promise<void> openWebSocketRpcSession(kj::Own<kj::WebSocket> webSocket,
        kj::StringPtr connectionId, capnp::Capability::Client bootstrap) {
      auto key = nativeCapnpBridgeRpcSessionKey(connectionId);
      auto inserted = nativeCapnpBridgeWebSocketRpcSessionIds.insert(key);
      KJ_ASSERT(inserted.second);

      auto sessionKey = *inserted.first;
      auto session = kj::heap<NativeCapnpBridgeWebSocketRpcSession>(
          kj::mv(webSocket), kj::mv(bootstrap));
      auto disconnect = session->network.onDisconnect();
      return disconnect.then([this, sessionKey]() mutable {
        nativeCapnpBridgeWebSocketRpcSessionIds.erase(sessionKey);
      }).catch_([this, sessionKey](kj::Exception&& exception) mutable
          -> kj::Promise<void> {
        nativeCapnpBridgeWebSocketRpcSessionIds.erase(sessionKey);
        return kj::Promise<void>(kj::mv(exception));
      }).attach(kj::mv(session));
    }
  };

  NativeCapnpBridgeController nativeCapnpBridge;

  kj::Maybe<kj::String> readNativeCapnpRpcSessionParam(
      kj::StringPtr url, kj::StringPtr name, kj::StringPtr errorMessage, kj::String& output) {
    return readSingleNonEmptyQueryParam(url, name, errorMessage, output);
  }

  kj::Promise<void> openIsolateBridgeBootstrapRpcSession(
      kj::StringPtr url, kj::HttpService::Response& response) {
    kj::String connectionId;
    KJ_IF_MAYBE(error, readNativeCapnpRpcSessionParam(
        url, "connectionId", "isolate bridge RPC session connection id is missing",
        connectionId)) {
      return sendJson(response, 400, "Bad Request", renderError(*error));
    }

    if (findIsolateQueryParams(url, "id").size() > 0 ||
        findIsolateQueryParams(url, "interfaceId").size() > 0 ||
        findIsolateQueryParams(url, "interfaceName").size() > 0) {
      return sendJson(response, 400, "Bad Request", renderError(
          "isolate bridge bootstrap sessions must not specify a target capability"));
    }

    if (nativeCapnpBridge.hasRpcSession(connectionId)) {
      return sendJson(response, 409, "Conflict", renderError(
          "isolate bridge RPC session connection id is already in use"));
    }

    kj::HttpHeaders responseHeaders(headerTable);
    auto webSocket = response.acceptWebSocket(responseHeaders);
    capnp::Capability::Client bootstrap = kj::heap<IsolateBridgeImpl>(config, host);
    return nativeCapnpBridge.openWebSocketRpcSession(kj::mv(webSocket), connectionId,
        kj::mv(bootstrap));
  }

  kj::Promise<void> openBrowserIsolateBridgeBootstrapRpcSession(
      kj::StringPtr url, const kj::HttpHeaders& requestHeaders,
      kj::HttpService::Response& response) {
    kj::String connectionId;
    KJ_IF_MAYBE(error, readNativeCapnpRpcSessionParam(
        url, "connectionId", "browser isolate bridge RPC session connection id is missing",
        connectionId)) {
      return sendJson(response, 400, "Bad Request", renderError(*error));
    }

    if (findIsolateQueryParams(url, "id").size() > 0 ||
        findIsolateQueryParams(url, "interfaceId").size() > 0 ||
        findIsolateQueryParams(url, "interfaceName").size() > 0) {
      return sendJson(response, 400, "Bad Request", renderError(
          "browser isolate bridge bootstrap sessions must not specify a target capability"));
    }

    if (nativeCapnpBridge.hasRpcSession(connectionId)) {
      return sendJson(response, 409, "Conflict", renderError(
          "browser isolate bridge RPC session connection id is already in use"));
    }

    kj::String sessionId;
    KJ_IF_MAYBE(value, findRequestHeader(requestHeaders, "x-sandstorm-session-id")) {
      sessionId = kj::mv(*value);
    } else {
      sessionId = kj::heapString("");
    }

    kj::HttpHeaders responseHeaders(headerTable);
    auto webSocket = response.acceptWebSocket(responseHeaders);
    capnp::Capability::Client bootstrap = kj::heap<BrowserIsolateBridgeImpl>(
        config, host, kj::mv(sessionId));
    return nativeCapnpBridge.openWebSocketRpcSession(kj::mv(webSocket), connectionId,
        kj::mv(bootstrap));
  }

  kj::Promise<void> openNativeCapnpBridgeRpcSession(
      kj::StringPtr url, const kj::HttpHeaders& requestHeaders,
      kj::HttpService::Response& response) {
    if (!requestHeaders.isWebSocket()) {
      return sendJson(response, 426, "Upgrade Required", kj::heapString(
          "{\n  \"ok\": false,\n"
          "  \"error\": \"native Cap'n Proto RPC sessions require WebSocket upgrade\"\n}\n"));
    }

    auto bootstrapModes = findIsolateQueryParams(url, "bootstrap");
    if (bootstrapModes.size() > 1) {
      return sendJson(response, 400, "Bad Request", renderError(
          "native Cap'n Proto RPC session bootstrap mode appears more than once"));
    } else if (bootstrapModes.size() == 0) {
      return sendJson(response, 400, "Bad Request", renderError(
          "native Cap'n Proto RPC session bootstrap mode is missing"));
    }

    if (bootstrapModes[0] == "worker") {
      return openIsolateBridgeBootstrapRpcSession(url, response);
    } else if (bootstrapModes[0] == "browser") {
      return openBrowserIsolateBridgeBootstrapRpcSession(url, requestHeaders, response);
    } else {
      return sendJson(response, 400, "Bad Request", renderError(
          "native Cap'n Proto RPC session bootstrap mode is invalid"));
    }
  }

  kj::Maybe<kj::String> readSingleNonEmptyQueryParam(kj::StringPtr url, kj::StringPtr name,
      kj::StringPtr errorMessage, kj::String& output) {
    auto values = findIsolateQueryParams(url, name);
    if (values.size() != 1 || values[0].size() == 0) {
      return kj::str(errorMessage);
    }

    output = kj::mv(values[0]);
    return nullptr;
  }

  static bool httpHeaderNameEquals(kj::StringPtr left, kj::StringPtr right) {
    if (left.size() != right.size()) {
      return false;
    }

    for (auto i: kj::indices(left)) {
      char l = left[i];
      char r = right[i];
      if ('A' <= l && l <= 'Z') l += 'a' - 'A';
      if ('A' <= r && r <= 'Z') r += 'a' - 'A';
      if (l != r) {
        return false;
      }
    }
    return true;
  }

  static kj::Maybe<kj::String> findRequestHeader(
      const kj::HttpHeaders& headers, kj::StringPtr name) {
    kj::Maybe<kj::String> result = nullptr;
    headers.forEach([&](kj::StringPtr headerName, kj::StringPtr value) {
      if (result == nullptr && httpHeaderNameEquals(headerName, name)) {
        result = kj::str(value);
      }
    });
    return result;
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

  kj::Maybe<uint64_t> parseNativeCapnpInterfaceId(kj::StringPtr value) {
    if (value.startsWith("0x") || value.startsWith("0X")) {
      return parseUInt64(kj::str(value.slice(2)), 16);
    }
    return parseUInt64(value, 10);
  }

  kj::Promise<void> sendBadRequest(
      kj::HttpService::Response& response, kj::StringPtr errorMessage) {
    return sendJson(response, 400, "Bad Request", renderError(errorMessage));
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
        "\"bindings\", \"permissions\", \"capnp.bridgeInfo\", "
        "\"powerbox.claim\", "
        "\"powerbox.apiSessionDescriptor\", \"powerbox.outboundHttpDescriptor\", "
        "\"powerbox.offer\", \"powerbox.fulfillRequest\", \"powerbox.tieToUser\"]\n"
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
        "  \"nativeTransport\": true,\n"
        "  \"nativeRpc\": true,\n"
        "  \"nativeRpcWebSocket\": true\n"
        "}\n");
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

  kj::Promise<void> appInterfacePowerboxDescriptor(
      kj::StringPtr url, kj::HttpService::Response& response) {
    capnp::MallocMessageBuilder message;
    auto descriptor = message.initRoot<PowerboxDescriptor>();
    uint64_t interfaceId = 0;
    KJ_IF_MAYBE(error, initAppInterfacePowerboxDescriptor(url, descriptor, interfaceId)) {
      return sendJson(response, 400, "Bad Request", renderError(*error));
    }

    kj::VectorOutputStream output;
    capnp::writePackedMessage(output, message);
    auto packed = kj::encodeBase64Url(output.getArray());

    auto interfaceNames = findIsolateQueryParams(url, "interfaceName");
    kj::StringPtr interfaceName = interfaceNames.size() == 1 ? interfaceNames[0].asPtr() : "";

    kj::Vector<char> json;
    json.addAll(kj::StringPtr("{\n  \"ok\": true,\n  "));
    appendJsonField(json, "type", "packedPowerboxDescriptor");
    json.addAll(kj::StringPtr(",\n  "));
    appendJsonField(json, "descriptor", packed);
    json.addAll(kj::StringPtr(",\n  \"decoded\": {\n    "));
    appendJsonField(json, "kind", "appInterface");
    json.addAll(kj::StringPtr(",\n    "));
    appendJsonField(json, "interfaceId", kj::str("0x", kj::hex(interfaceId)));
    if (interfaceName.size() > 0) {
      json.addAll(kj::StringPtr(",\n    "));
      appendJsonField(json, "interfaceName", interfaceName);
    }
    json.addAll(kj::StringPtr("\n  }\n}\n"));
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

  kj::Maybe<kj::String> initAppInterfacePowerboxDescriptor(
      kj::StringPtr url, PowerboxDescriptor::Builder descriptor, uint64_t& interfaceId) {
    auto interfaceIds = findIsolateQueryParams(url, "interfaceId");
    if (interfaceIds.size() != 1 || interfaceIds[0].size() == 0) {
      return kj::str("appInterface descriptor requires exactly one interfaceId");
    }

    KJ_IF_MAYBE(parsed, parseNativeCapnpInterfaceId(interfaceIds[0])) {
      if (*parsed == 0) {
        return kj::str("appInterface descriptor interfaceId must not be zero");
      }
      interfaceId = *parsed;
    } else {
      return kj::str("appInterface descriptor interfaceId must be a decimal integer or "
          "0x-prefixed hex integer");
    }

    auto interfaceNames = findIsolateQueryParams(url, "interfaceName");
    if (interfaceNames.size() > 1) {
      return kj::str("appInterface descriptor accepts at most one interfaceName");
    }
    if (interfaceNames.size() == 1 && interfaceNames[0].size() > 512) {
      return kj::str("appInterface descriptor interfaceName is too long");
    }

    auto tag = descriptor.initTags(1)[0];
    tag.setId(interfaceId);
    return nullptr;
  }

  void initAppInterfacePowerboxDescriptor(
      kj::StringPtr url, PowerboxDescriptor::Builder descriptor) {
    uint64_t interfaceId = 0;
    KJ_IF_MAYBE(error, initAppInterfacePowerboxDescriptor(url, descriptor, interfaceId)) {
      KJ_FAIL_REQUIRE(*error);
    }
  }

  kj::String renderRuntime() {
    kj::Vector<char> json;
    json.addAll(kj::StringPtr("{\n  \"ok\": true,\n  \"binding\": \"sandstormApi\",\n  "));
    appendJsonField(json, "mainModule", config.mainModule);
    json.addAll(kj::StringPtr(",\n  "));
    appendJsonField(json, "compatibilityDate", config.compatibilityDate);
    json.addAll(kj::StringPtr(",\n  "));
    appendJsonField(json, "topology",
        isolateRuntimeTopologyName(config.topology));
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

  static bool isValidBrowserModulePath(kj::StringPtr path) {
    if (path.size() == 0 || path.startsWith("/") || path.findFirst('\\') != nullptr) {
      return false;
    }

    size_t segmentStart = 0;
    while (segmentStart <= path.size()) {
      size_t segmentEnd = path.size();
      KJ_IF_MAYBE(slash, path.slice(segmentStart).findFirst('/')) {
        segmentEnd = segmentStart + *slash;
      }
      auto segment = path.slice(segmentStart, segmentEnd);
      if (segment.size() == 0 ||
          segment == kj::StringPtr(".") || segment == kj::StringPtr("..")) {
        return false;
      }
      if (segmentEnd == path.size()) {
        break;
      }
      segmentStart = segmentEnd + 1;
    }

    return true;
  }

  static kj::Maybe<kj::String> browserCapnpEsModuleName(kj::StringPtr path) {
    if (!isValidBrowserModulePath(path)) {
      return nullptr;
    }

    if (path.endsWith(".capnp.js") || path.endsWith(".capnp")) {
      auto schemaPath = path.endsWith(".capnp.js")
          ? path.slice(0, path.size() - strlen(".js"))
          : path;
      if (schemaPath.startsWith(kj::StringPtr("sandstorm/"))) {
        return kj::str("capnp:/", schemaPath);
      }
      return kj::str("capnp:./", schemaPath);
    }

    if (path.startsWith(kj::StringPtr("capnp-es/")) && path.endsWith(kj::StringPtr(".mjs"))) {
      return kj::heapString(path);
    }

    return nullptr;
  }

  static kj::Maybe<kj::String> browserCapnpEsImportSpecifier(kj::StringPtr specifier) {
    if (specifier.startsWith(kj::StringPtr("/sandstorm/")) &&
        specifier.endsWith(kj::StringPtr(".capnp"))) {
      return kj::str("/__sandstorm/capnp", specifier);
    }

    if (specifier.startsWith(kj::StringPtr("capnp:/sandstorm/")) &&
        specifier.endsWith(kj::StringPtr(".capnp"))) {
      return kj::str("/__sandstorm/capnp/",
          specifier.slice(strlen("capnp:/")));
    }

    return nullptr;
  }

  static kj::Maybe<size_t> findSubstring(kj::StringPtr text, kj::StringPtr pattern) {
    if (pattern.size() == 0) {
      return size_t(0);
    }

    if (pattern.size() > text.size()) {
      return nullptr;
    }

    for (size_t i = 0; i <= text.size() - pattern.size(); ++i) {
      if (memcmp(text.begin() + i, pattern.begin(), pattern.size()) == 0) {
        return i;
      }
    }

    return nullptr;
  }

  static void appendBrowserCapnpEsModuleLine(kj::Vector<char>& out, kj::StringPtr line) {
    size_t quotePos = line.size();
    KJ_IF_MAYBE(fromPos, findSubstring(line, " from \"")) {
      quotePos = *fromPos + strlen(" from ");
    } else KJ_IF_MAYBE(fromPos, findSubstring(line, " from '")) {
      quotePos = *fromPos + strlen(" from ");
    } else if (line.startsWith(kj::StringPtr("import \"")) ||
        line.startsWith(kj::StringPtr("import '"))) {
      quotePos = strlen("import ");
    }

    if (quotePos >= line.size()) {
      out.addAll(line);
      return;
    }

    char quote = line[quotePos];
    if (quote != '"' && quote != '\'') {
      out.addAll(line);
      return;
    }

    size_t specifierStart = quotePos + 1;
    size_t specifierEnd = specifierStart;
    while (specifierEnd < line.size() && line[specifierEnd] != quote) {
      ++specifierEnd;
    }
    if (specifierEnd >= line.size()) {
      out.addAll(line);
      return;
    }

    auto specifierSlice = line.slice(specifierStart, specifierEnd);
    kj::StringPtr specifier(specifierSlice.begin(), specifierSlice.size());
    KJ_IF_MAYBE(rewritten, browserCapnpEsImportSpecifier(specifier)) {
      out.addAll(line.slice(0, specifierStart));
      out.addAll(*rewritten);
      out.addAll(line.slice(specifierEnd));
    } else {
      out.addAll(line);
    }
  }

  static kj::Array<byte> rewriteBrowserCapnpEsModuleImports(kj::ArrayPtr<const byte> content) {
    kj::StringPtr source(reinterpret_cast<const char*>(content.begin()), content.size());
    kj::Vector<char> out(content.size() + 64);
    size_t lineStart = 0;
    while (lineStart < source.size()) {
      size_t lineEnd = source.size();
      KJ_IF_MAYBE(newline, source.slice(lineStart).findFirst('\n')) {
        lineEnd = lineStart + *newline + 1;
      }
      auto lineSlice = source.slice(lineStart, lineEnd);
      appendBrowserCapnpEsModuleLine(out,
          kj::StringPtr(lineSlice.begin(), lineSlice.size()));
      lineStart = lineEnd;
    }

    auto chars = out.releaseAsArray();
    auto bytes = kj::heapArray<byte>(chars.size());
    memcpy(bytes.begin(), chars.begin(), chars.size());
    return bytes;
  }

  kj::Promise<void> browserCapnpEsModule(kj::StringPtr url, kj::HttpService::Response& response) {
    auto paths = findIsolateRawQueryParams(url, "path");
    if (paths.size() != 1) {
      return sendJson(response, 400, "Bad Request", kj::heapString(
          "{\n  \"ok\": false,\n"
          "  \"error\": \"expected exactly one path query parameter\"\n}\n"));
    }

    KJ_IF_MAYBE(moduleName, browserCapnpEsModuleName(paths[0])) {
      for (auto& module: config.modules) {
        if (module.name == *moduleName) {
          kj::HttpHeaders responseHeaders(headerTable);
          responseHeaders.set(kj::HttpHeaderId::CONTENT_TYPE, "text/javascript; charset=utf-8");
          return sendBytes(response, 200, "OK", kj::mv(responseHeaders),
              rewriteBrowserCapnpEsModuleImports(module.content.asPtr()));
        }
      }

      return sendJson(response, 404, "Not Found", kj::heapString(
          "{\n  \"ok\": false,\n"
          "  \"error\": \"browser capnp-es module not found\"\n}\n"));
    } else {
      return sendJson(response, 400, "Bad Request", kj::heapString(
          "{\n  \"ok\": false,\n"
          "  \"error\": \"invalid browser capnp-es module path\"\n}\n"));
    }
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
        return requestBody.readAllBytes(MAX_STORAGE_VALUE_BYTES + 2)
            .then([this, key = kj::mv(key), path = kj::mv(path), &response]
                (kj::Array<byte>&& body) mutable {
          if (body.size() > MAX_STORAGE_VALUE_BYTES) {
            return sendJson(response, 413, "Payload Too Large", kj::str(
                "{\n  \"ok\": false,\n"
                "  \"error\": \"isolate storage value exceeds maximum allowed size\",\n"
                "  \"maxBytes\": ", MAX_STORAGE_VALUE_BYTES, "\n}\n"));
          }

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

class HostedIsolateBindingServices final: public IsolateBindingServices::Server {
public:
  HostedIsolateBindingServices(
      kj::Own<IsolateRuntimeConfig> config, kj::Own<IsolateRuntimeHost> host)
      : config(kj::mv(config)), host(kj::mv(host)) {}

  kj::Promise<void> getService(GetServiceContext context) override {
    kj::Own<kj::HttpService> service;
    switch (context.getParams().getBinding()) {
      case IsolateBindingServices::Binding::SANDSTORM_API:
        service = kj::heap<SandstormApiBindingService>(host->headerTable, *config, *host);
        break;
      case IsolateBindingServices::Binding::STORAGE:
        service = kj::heap<StorageBindingService>(host->headerTable, *config);
        break;
      case IsolateBindingServices::Binding::POWERBOX:
        service = kj::heap<SandstormApiBindingService>(host->headerTable, *config, *host, true);
        break;
    }
    context.getResults().setService(
        host->runtimeAdapterFactory->exportHttpService(kj::mv(service)));
    return kj::READY_NOW;
  }

private:
  kj::Own<IsolateRuntimeConfig> config;
  kj::Own<IsolateRuntimeHost> host;
};

class IsolateSupervisorLifecycle: public kj::Refcounted {
public:
  virtual void requireRunning() {}
  virtual kj::Promise<void> keepAlive() { return kj::READY_NOW; }
  virtual kj::Promise<void> shutdown() = 0;
};

class SidecarSupervisorLifecycle final: public IsolateSupervisorLifecycle {
public:
  explicit SidecarSupervisorLifecycle(kj::Own<WorkerdSidecarProcess> sidecar)
      : sidecar(kj::mv(sidecar)) {}

  kj::Promise<void> shutdown() override {
    sidecar->stop();
    _exit(0);
  }

private:
  kj::Own<WorkerdSidecarProcess> sidecar;
};

class HostedSupervisorLifecycle final: public IsolateSupervisorLifecycle {
public:
  HostedSupervisorLifecycle(HostedIsolate::Client hosted, kj::Function<void()> onShutdown)
      : hosted(kj::mv(hosted)), onShutdown(kj::mv(onShutdown)) {}

  void requireRunning() override {
    KJ_REQUIRE(running, "shared isolate grain has been shut down");
  }

  kj::Promise<void> keepAlive() override {
    requireRunning();
    return hosted.keepAliveRequest().send().ignoreResult().catch_(
        [this](kj::Exception&& exception) -> kj::Promise<void> {
      running = false;
      return removeFromAccountLater().then(
          [exception = kj::mv(exception)]() mutable -> kj::Promise<void> {
        return kj::Promise<void>(kj::mv(exception));
      });
    });
  }

  kj::Promise<void> shutdown() override {
    requireRunning();
    running = false;
    return hosted.stopRequest().send().then(
        [this](auto) { return removeFromAccountLater(); },
        [this](kj::Exception&& exception) {
      return removeFromAccountLater().then(
          [exception = kj::mv(exception)]() mutable -> kj::Promise<void> {
        return kj::Promise<void>(kj::mv(exception));
      });
    });
  }

private:
  HostedIsolate::Client hosted;
  kj::Function<void()> onShutdown;
  bool running = true;

  kj::Promise<void> removeFromAccountLater() {
    auto callback = kj::mv(onShutdown);
    return kj::evalLater([callback = kj::mv(callback)]() mutable { callback(); });
  }
};

class IsolateSupervisorImpl final: public Supervisor::Server {
public:
  IsolateSupervisorImpl(
      kj::UnixEventPort& eventPort, kj::StringPtr varPath, kj::Own<CapRedirector> coreRedirector,
      kj::Own<IsolateRuntimeConfig> runtimeConfig, kj::Own<IsolateRuntimeHost> runtimeHost,
      kj::Own<IsolateSupervisorLifecycle> lifecycle, SandstormCore::Client sandstormCore)
      : eventPort(eventPort), varPath(kj::heapString(varPath)), coreRedirector(kj::mv(coreRedirector)),
        runtimeConfig(kj::mv(runtimeConfig)), runtimeHost(kj::mv(runtimeHost)),
        lifecycle(kj::mv(lifecycle)), sandstormCore(kj::mv(sandstormCore)) {}

  kj::Promise<void> getMainView(GetMainViewContext context) override {
    lifecycle->requireRunning();
    context.getResults().setView(kj::heap<IsolateUiViewImpl>(
        kj::addRef(*runtimeConfig), kj::addRef(*runtimeHost)));
    return kj::READY_NOW;
  }

  kj::Promise<void> keepAlive(KeepAliveContext context) override {
    lifecycle->requireRunning();
    isolateKeepAlive = true;

    auto params = context.getParams();
    if (params.hasCore()) {
      coreRedirector->setTarget(params.getCore());
    }

    return lifecycle->keepAlive();
  }

  kj::Promise<void> syncStorage(SyncStorageContext context) override {
    lifecycle->requireRunning();
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
    lifecycle->requireRunning();
    KJ_LOG(WARNING, "Isolate grain shutdown requested.");
    return lifecycle->shutdown();
  }

  kj::Promise<void> restore(RestoreContext context) override {
    lifecycle->requireRunning();
    auto params = context.getParams();
    auto objectId = context.getParams().getRef();
    kj::Maybe<kj::Array<const byte>> parentToken = nullptr;
    if (params.getParentToken().size() > 0) {
      parentToken = kj::heapArray<const byte>(params.getParentToken());
    }

    switch (objectId.which()) {
      case SupervisorObjectId<>::ROUTE_BACKED_SESSION: {
        auto routeRef = readRouteBackedCapabilityRef(objectId.getRouteBackedSession());
        context.getResults().setCap(makeRouteBackedSessionCapability(
            kj::addRef(*runtimeConfig), kj::addRef(*runtimeHost),
            routeRef.type, routeRef.pathPrefix, true, kj::mv(parentToken)));
        return kj::READY_NOW;
      }
      case SupervisorObjectId<>::APP_REF: {
        auto session = newIsolateMainViewRpcSession(
            kj::addRef(*runtimeConfig), kj::addRef(*runtimeHost), runtimeHost->headerTable);
        auto request = KJ_ASSERT_NONNULL(session->cap).castAs<MainView<>>().restoreRequest();
        request.setObjectId(objectId.getAppRef());
        return request.send().then(
            [this, context, session = kj::mv(session), parentToken = kj::mv(parentToken)](
                auto result) mutable {
          context.getResults().setCap(kj::heap<IsolateMainViewRestoredCapability>(
              kj::addRef(*runtimeHost), kj::mv(session), result.getCap(), kj::mv(parentToken)));
        });
      }
      case SupervisorObjectId<>::WAKE_LOCK_NOTIFICATION:
        KJ_FAIL_REQUIRE("isolate supervisor-owned persistent object type is not supported yet");
      default:
        KJ_FAIL_REQUIRE("unknown isolate supervisor object ID type");
    }
  }

  kj::Promise<void> drop(DropContext context) override {
    lifecycle->requireRunning();
    auto objectId = context.getParams().getRef();
    switch (objectId.which()) {
      case SupervisorObjectId<>::ROUTE_BACKED_SESSION:
        return kj::READY_NOW;
      case SupervisorObjectId<>::APP_REF: {
        auto session = newIsolateMainViewRpcSession(
            kj::addRef(*runtimeConfig), kj::addRef(*runtimeHost), runtimeHost->headerTable);
        auto request = KJ_ASSERT_NONNULL(session->cap).castAs<MainView<>>().dropRequest();
        request.setObjectId(objectId.getAppRef());
        return request.send().ignoreResult().attach(kj::mv(session));
      }
      case SupervisorObjectId<>::WAKE_LOCK_NOTIFICATION:
        KJ_FAIL_REQUIRE("isolate supervisor-owned persistent object type is not supported yet");
      default:
        KJ_FAIL_REQUIRE("unknown isolate supervisor object ID type");
    }
  }

  kj::Promise<void> watchLog(WatchLogContext context) override {
    lifecycle->requireRunning();
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
    lifecycle->requireRunning();
    context.getResults().setStatus(Supervisor::WwwFileStatus::NOT_FOUND);
    return kj::READY_NOW;
  }

private:
  kj::UnixEventPort& eventPort;
  kj::String varPath;
  kj::Own<CapRedirector> coreRedirector;
  kj::Own<IsolateRuntimeConfig> runtimeConfig;
  kj::Own<IsolateRuntimeHost> runtimeHost;
  kj::Own<IsolateSupervisorLifecycle> lifecycle;
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

struct AccountAdmissionRequest {
  kj::String appRoot;
  kj::String grainRoot;
  kj::String grainId;
  kj::String packageId;
  kj::String mainModule;
  kj::Maybe<kj::String> compatibilityDate;
  bool isNew;
};

struct AccountAdmissionResult {
  kj::String varPath;
  kj::Own<IsolateRuntimeConfig> runtimeConfig;
  kj::Array<byte> workerSource;
};

void initializeAccountGrainDirectory(kj::StringPtr varPath, bool isNew) {
  if (isNew) {
    KJ_SYSCALL(mkdir(varPath.cStr(), 0770), varPath);
    KJ_SYSCALL(mkdir(kj::str(varPath, "/sandbox").cStr(), 0770), varPath);
  } else {
    KJ_SYSCALL(access(varPath.cStr(), R_OK | W_OK | X_OK), varPath);
  }

  int logFd;
  KJ_SYSCALL(logFd = open(kj::str(varPath, "/log").cStr(),
      O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0660), varPath);
  KJ_SYSCALL(close(logFd));
}

kj::Array<byte> readAccountWorkerSource(kj::StringPtr grainRoot, kj::StringPtr grainId) {
  int rootFd;
  KJ_SYSCALL(rootFd = open(grainRoot.cStr(),
      O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC), grainRoot);
  kj::AutoCloseFd root(rootFd);
  int grainFd;
  KJ_SYSCALL(grainFd = openat(root, grainId.cStr(),
      O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC), grainId);
  kj::AutoCloseFd grain(grainFd);
  int runtimeFd;
  KJ_SYSCALL(runtimeFd = openat(grain, "isolate-runtime",
      O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
  kj::AutoCloseFd runtime(runtimeFd);
  int sourceFd;
  KJ_SYSCALL(sourceFd = openat(runtime, "worker-source.capnp.bin",
      O_RDONLY | O_NOFOLLOW | O_CLOEXEC));
  kj::AutoCloseFd source(sourceFd);
  struct stat stats;
  KJ_SYSCALL(fstat(source, &stats));
  KJ_REQUIRE(S_ISREG(stats.st_mode), "worker source bundle is not a regular file");
  KJ_REQUIRE(stats.st_size > 0 && stats.st_size <= MAX_ISOLATE_TOTAL_MODULE_BYTES,
      "worker source bundle exceeds size limit", stats.st_size,
      MAX_ISOLATE_TOTAL_MODULE_BYTES);
  auto result = kj::heapArray<byte>(stats.st_size);
  size_t offset = 0;
  while (offset < result.size()) {
    ssize_t count;
    KJ_SYSCALL(count = read(source, result.begin() + offset, result.size() - offset));
    KJ_REQUIRE(count > 0, "worker source bundle ended before its declared size");
    offset += count;
  }
  return result;
}

kj::Own<AccountAdmissionResult> prepareAccountAdmission(AccountAdmissionRequest request) {
  auto varPath = kj::str(request.grainRoot, "/", request.grainId);
  auto pkgPath = kj::str(request.appRoot, "/", request.packageId);
  initializeAccountGrainDirectory(varPath, request.isNew);

  kj::Maybe<kj::StringPtr> compatibilityDate;
  KJ_IF_MAYBE(value, request.compatibilityDate) {
    compatibilityDate = *value;
  }
  auto runtimeConfig = loadIsolateRuntimeConfig(
      pkgPath, request.mainModule.asPtr(), compatibilityDate, true);
  runtimeConfig->topology = IsolateRuntimeTopology::ACCOUNT_SHARED_HOST;
  prepareRuntimeBundleAndCleanupSockets(varPath, *runtimeConfig);
  auto workerSource = readAccountWorkerSource(request.grainRoot, request.grainId);
  return kj::heap<AccountAdmissionResult>(AccountAdmissionResult{
    kj::mv(varPath), kj::mv(runtimeConfig), kj::mv(workerSource)});
}

class AccountAdmissionWorker {
public:
  AccountAdmissionWorker(): thread([this]() noexcept { run(); }) {
    auto lock = shared.lockExclusive();
    lock.wait([](const Shared& state) { return state.executor != nullptr; });
  }

  ~AccountAdmissionWorker() noexcept(false) {
    auto executor = getExecutor();
    executor->executeSync([this]() {
      auto lock = shared.lockExclusive();
      KJ_ASSERT(lock->shutdownFulfiller != nullptr);
      lock->shutdownFulfiller->fulfill();
      lock->shutdownFulfiller = nullptr;
    });
  }

  kj::Promise<kj::Own<AccountAdmissionResult>> admit(AccountAdmissionRequest request) {
    auto executor = getExecutor();
    return executor->executeAsync([request = kj::mv(request)]() mutable {
      auto& clock = kj::systemPreciseMonotonicClock();
      auto started = clock.now();
      auto result = prepareAccountAdmission(kj::mv(request));
      KJ_REQUIRE(clock.now() - started <= 5 * kj::SECONDS,
          "account worker admission exceeded its five-second deadline");
      return result;
    });
  }

private:
  struct Shared {
    kj::Maybe<kj::Own<const kj::Executor>> executor;
    kj::PromiseFulfiller<void>* shutdownFulfiller = nullptr;
  };

  kj::MutexGuarded<Shared> shared;
  kj::Thread thread;

  kj::Own<const kj::Executor> getExecutor() {
    auto lock = shared.lockExclusive();
    return KJ_ASSERT_NONNULL(lock->executor)->addRef();
  }

  void run() noexcept {
    kj::EventLoop eventLoop;
    kj::WaitScope waitScope(eventLoop);
    auto shutdown = kj::newPromiseAndFulfiller<void>();
    {
      auto lock = shared.lockExclusive();
      lock->executor = kj::getCurrentThreadExecutor().addRef();
      lock->shutdownFulfiller = shutdown.fulfiller.get();
    }
    shutdown.promise.wait(waitScope);
    auto lock = shared.lockExclusive();
    lock->executor = nullptr;
  }
};

class AccountAdmissionPool {
public:
  AccountAdmissionPool() {
    // A small fixed pool keeps filesystem and packed-bundle work off the account event loop while
    // bounding the memory and thread cost of concurrent grain starts.
    workers.add(kj::heap<AccountAdmissionWorker>());
    workers.add(kj::heap<AccountAdmissionWorker>());
  }

  kj::Promise<kj::Own<AccountAdmissionResult>> admit(AccountAdmissionRequest request) {
    KJ_REQUIRE(outstanding < MAX_OUTSTANDING,
        "account worker admission queue is full", outstanding, MAX_OUTSTANDING);
    ++outstanding;
    auto& worker = *workers[nextWorker++ % workers.size()];
    return worker.admit(kj::mv(request))
        .attach(kj::defer([this]() { --outstanding; }));
  }

private:
  static constexpr size_t MAX_OUTSTANDING = 16;
  kj::Vector<kj::Own<AccountAdmissionWorker>> workers;
  size_t nextWorker = 0;
  size_t outstanding = 0;
};

class IsolateAccountHostImpl final: public IsolateAccountHost::Server {
public:
  IsolateAccountHostImpl(kj::UnixEventPort& eventPort,
      kj::Network& network,
      kj::Timer& timer,
      IsolateHost::Client nativeHost,
      kj::String appRoot,
      kj::String grainRoot)
      : eventPort(eventPort), network(network), timer(timer), nativeHost(kj::mv(nativeHost)),
        appRoot(kj::mv(appRoot)), grainRoot(kj::mv(grainRoot)) {}

  kj::Promise<void> startGrain(StartGrainContext context) override {
    auto params = context.getParams();
    auto grainId = validateOpaqueId(params.getGrainId(), "grain ID");
    auto packageId = validateOpaqueId(params.getPackageId(), "package ID");
    KJ_REQUIRE(params.getMainModule().size() > 0, "missing isolate main module");

    KJ_IF_MAYBE(existing, supervisors.find(grainId)) {
      context.getResults().setSupervisor(*existing);
      return kj::READY_NOW;
    }

    kj::Maybe<kj::String> compatibilityDate;
    if (params.getCompatibilityDate().size() > 0) {
      compatibilityDate = kj::str(params.getCompatibilityDate());
    }
    auto core = params.getCore();
    auto admission = admissionPool.admit(AccountAdmissionRequest{
      kj::str(appRoot),
      kj::str(grainRoot),
      kj::str(grainId),
      kj::mv(packageId),
      kj::str(params.getMainModule()),
      kj::mv(compatibilityDate),
      params.getIsNew(),
    });
    context.releaseParams();
    return admission.then([this, context, grainId = kj::mv(grainId),
        core = kj::mv(core)](kj::Own<AccountAdmissionResult> admitted) mutable
        -> kj::Promise<void> {
      KJ_IF_MAYBE(existing, supervisors.find(grainId)) {
        context.getResults().setSupervisor(*existing);
        return kj::READY_NOW;
      }

      auto coreRedirector = kj::refcounted<CapRedirector>();
      coreRedirector->setTarget(core);
      SandstormCore::Client coreCap = static_cast<capnp::Capability::Client>(
          kj::addRef(*coreRedirector)).castAs<SandstormCore>();
      auto adapterFactory = kj::refcounted<HostedRuntimeAdapterFactory>();
      auto runtimeHost = kj::refcounted<IsolateRuntimeHost>(
          network, timer, grainId, coreCap, kj::addRef(*adapterFactory));

      auto nativeStart = nativeHost.startGrainRequest();
      nativeStart.setGrainId(grainId);
      nativeStart.setWorkerSource(admitted->workerSource);
      nativeStart.setServices(kj::heap<HostedIsolateBindingServices>(
          kj::addRef(*admitted->runtimeConfig), kj::addRef(*runtimeHost)));
      return nativeStart.send().then([this, context, grainId = kj::mv(grainId),
          admitted = kj::mv(admitted), coreRedirector = kj::mv(coreRedirector),
          runtimeHost = kj::mv(runtimeHost), adapterFactory = kj::mv(adapterFactory),
          coreCap = kj::mv(coreCap)](auto response) mutable {
        auto hosted = response.getGrain();
        HostedIsolate::Client lifecycleHosted = hosted;
        adapterFactory->setHosted(kj::mv(hosted));
        auto lifecycle = kj::refcounted<HostedSupervisorLifecycle>(
            kj::mv(lifecycleHosted),
            [this, grainId = kj::str(grainId)]() { supervisors.erase(grainId); });
        Supervisor::Client supervisor = kj::heap<IsolateSupervisorImpl>(eventPort,
            admitted->varPath, kj::mv(coreRedirector), kj::mv(admitted->runtimeConfig),
            kj::mv(runtimeHost), kj::mv(lifecycle), kj::mv(coreCap));
        context.getResults().setSupervisor(supervisor);
        supervisors.insert(kj::mv(grainId), kj::mv(supervisor));
      });
    });
  }

  kj::Promise<void> openLocalCapnpChannel(OpenLocalCapnpChannelContext context) override {
    auto params = context.getParams();
    auto firstGrainId = validateOpaqueId(params.getFirstGrainId(), "first grain ID");
    auto secondGrainId = validateOpaqueId(params.getSecondGrainId(), "second grain ID");
    KJ_REQUIRE(supervisors.find(firstGrainId) != nullptr,
        "first local Cap'n Proto link grain is not live in this account", firstGrainId);
    KJ_REQUIRE(supervisors.find(secondGrainId) != nullptr,
        "second local Cap'n Proto link grain is not live in this account", secondGrainId);
    KJ_REQUIRE(params.getFirstName().size() > 0 && params.getFirstName().size() <= 256,
        "invalid first local Cap'n Proto link name");
    KJ_REQUIRE(params.getSecondName().size() > 0 && params.getSecondName().size() <= 256,
        "invalid second local Cap'n Proto link name");

    auto request = nativeHost.openLocalCapnpChannelRequest();
    request.setFirstGrainId(firstGrainId);
    request.setFirstName(params.getFirstName());
    request.setSecondGrainId(secondGrainId);
    request.setSecondName(params.getSecondName());
    return request.send().ignoreResult();
  }

private:
  static kj::String validateOpaqueId(kj::StringPtr value, kj::StringPtr label) {
    KJ_REQUIRE(value.size() >= 8 && !value.startsWith(".") && value.findFirst('/') == nullptr,
        "invalid opaque identifier", label, value);
    return kj::str(value);
  }

  kj::UnixEventPort& eventPort;
  kj::Network& network;
  kj::Timer& timer;
  IsolateHost::Client nativeHost;
  kj::String appRoot;
  kj::String grainRoot;
  AccountAdmissionPool admissionPool;
  kj::HashMap<kj::String, Supervisor::Client> supervisors;
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

IsolateAccountHostMain::IsolateAccountHostMain(kj::ProcessContext& context): context(context) {}

kj::MainFunc IsolateAccountHostMain::getMain() {
  return kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
                         "Runs an account-scoped shared isolate supervisor host.")
      .addOptionWithArg({"trust-domain"}, KJ_BIND_METHOD(*this, setTrustDomain), "<account-id>",
                        "Set the validated account trust domain.")
      .addOptionWithArg({"control-socket"}, KJ_BIND_METHOD(*this, setControlSocket), "<path>",
                        "Listen for backend requests on this Unix socket.")
      .addOptionWithArg({"native-host"}, KJ_BIND_METHOD(*this, setNativeHostPath), "<path>",
                        "Launch this native workerd host inside the runtime sandbox.")
      .addOptionWithArg({"uid"}, KJ_BIND_METHOD(*this, setUid), "<uid>",
                        "Drop the native host and account host to this sandbox UID.")
      .addOption({"log-seccomp-violations"},
                 [this]() { logSeccompViolations = true; return true; },
                 "Log native-host seccomp violations.")
      .addOption({"wait-for-startup"}, [this]() { waitForStartup = true; return true; },
                 "Wait for a byte on stdin before launching the native host.")
      .addOptionWithArg({"app-root"}, KJ_BIND_METHOD(*this, setAppRoot), "<path>",
                        "Set the trusted package root.")
      .addOptionWithArg({"grain-root"}, KJ_BIND_METHOD(*this, setGrainRoot), "<path>",
                        "Set the trusted grain root.")
      .callAfterParsing(KJ_BIND_METHOD(*this, run))
      .build();
}

kj::MainBuilder::Validity IsolateAccountHostMain::setTrustDomain(kj::StringPtr value) {
  if (value.size() < 8 || value.startsWith(".") || value.findFirst('/') != nullptr) {
    return "Invalid isolate trust domain.";
  }
  trustDomain = kj::str(value);
  return true;
}

kj::MainBuilder::Validity IsolateAccountHostMain::setControlSocket(kj::StringPtr value) {
  controlSocket = kj::str(value);
  return true;
}

kj::MainBuilder::Validity IsolateAccountHostMain::setNativeHostPath(kj::StringPtr value) {
  nativeHostPath = kj::str(value);
  return true;
}

kj::MainBuilder::Validity IsolateAccountHostMain::setUid(kj::StringPtr value) {
  KJ_IF_MAYBE(u, parseUInt(value, 10)) {
    if (getuid() != 0) return "must start as root to use --uid";
    if (*u == 0) return "native host sandbox UID cannot be root";
    sandboxUid = *u;
    return true;
  }
  return "UID must be a number";
}

kj::MainBuilder::Validity IsolateAccountHostMain::setAppRoot(kj::StringPtr value) {
  appRoot = kj::str(value);
  return true;
}

kj::MainBuilder::Validity IsolateAccountHostMain::setGrainRoot(kj::StringPtr value) {
  grainRoot = kj::str(value);
  return true;
}

kj::MainBuilder::Validity IsolateAccountHostMain::run() {
  KJ_REQUIRE(trustDomain.size() > 0, "missing account trust domain");
  KJ_REQUIRE(controlSocket.startsWith("/"), "control socket path must be absolute");
  KJ_REQUIRE(nativeHostPath.startsWith("/"), "native host path must be absolute");
  KJ_REQUIRE(appRoot.startsWith("/") && grainRoot.startsWith("/"),
      "account host roots must be absolute");

  if (waitForStartup) {
    char byte;
    ssize_t count;
    KJ_SYSCALL(count = read(STDIN_FILENO, &byte, 1));
    KJ_REQUIRE(count == 1, "account host startup gate closed before release");
  }

  unlinkIfExists(controlSocket);
  auto accountListenerFd = createUnixListener(controlSocket);
  KJ_IF_MAYBE(u, sandboxUid) {
    chownPathTo(controlSocket, *u);
  }

  auto nativePipe = Pipe::makeTwoWayAsync();
  Subprocess nativeProcess(
      [nativeHostPath = kj::str(nativeHostPath), control = kj::mv(nativePipe.writeEnd),
       sandboxUid = sandboxUid, logSeccompViolations = logSeccompViolations]() mutable {
    return runConfinedNativeIsolateHost(kj::mv(nativeHostPath), kj::mv(control),
        sandboxUid, logSeccompViolations);
  });
  KJ_IF_MAYBE(u, sandboxUid) {
    KJ_SYSCALL(setresuid(*u, *u, *u));
  }

  auto io = kj::setupAsyncIo();
  auto listener = io.lowLevelProvider->wrapListenSocketFd(
      kj::mv(accountListenerFd), kj::LowLevelAsyncIoProvider::ALREADY_CLOEXEC);
  auto nativeStream = io.lowLevelProvider->wrapSocketFd(kj::mv(nativePipe.readEnd));
  capnp::TwoPartyClient nativeRpc(*nativeStream);
  auto nativeHost = nativeRpc.bootstrap().castAs<IsolateHost>();

  capnp::TwoPartyServer server(kj::heap<IsolateAccountHostImpl>(io.unixEventPort,
      io.provider->getNetwork(), io.provider->getTimer(), kj::mv(nativeHost),
      kj::str(appRoot), kj::str(grainRoot)));
  KJ_LOG(WARNING, "Account-scoped isolate host listening.", trustDomain, controlSocket,
      nativeHostPath, nativeProcess.getPid());
  server.listen(*listener).exclusiveJoin(nativeRpc.onDisconnect()).wait(io.waitScope);
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
      .addOptionWithArg({"isolate-trust-domain"},
                        KJ_BIND_METHOD(*this, setIsolateTrustDomain), "<account-id>",
                        "Select the server-controlled account trust domain for shared hosting.")
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

kj::MainBuilder::Validity IsolateSupervisorMain::setIsolateTrustDomain(kj::StringPtr trustDomain) {
  if (trustDomain.size() < 8 || trustDomain.startsWith(".") ||
      trustDomain.findFirst('/') != nullptr) {
    return "Invalid isolate trust domain.";
  }
  isolateTrustDomain = kj::heapString(trustDomain);
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
  KJ_REQUIRE(isolateTrustDomain != nullptr,
      "isolate supervisor requires a server-controlled trust domain");
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

  keepAliveExistingIsolateSupervisor(varPath);
  registerIsolateSupervisorSignalHandlers();

  auto runtimeConfig = loadIsolateRuntimeConfig(
      pkgPath, requestedMainModule, requestedCompatibilityDate);

  prepareRuntimeBundleAsSandboxUser(varPath, *runtimeConfig, sandboxUid);

  KJ_LOG(WARNING, "Starting isolate supervisor with workerd adapter skeleton.",
      grainId, isolateTrustDomain, pkgPath,
      runtimeConfig->mainModule, runtimeConfig->compatibilityDate,
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
      ioContext.provider->getNetwork(), ioContext.provider->getTimer(), grainId, coreCap,
      kj::refcounted<WorkerdRuntimeAdapterFactory>());
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
  auto lifecycle = kj::refcounted<SidecarSupervisorLifecycle>(kj::mv(sidecar));

  KJ_LOG(WARNING, "Creating isolate supervisor capability.");
  Supervisor::Client mainCap = kj::heap<IsolateSupervisorImpl>(
      ioContext.unixEventPort, varPath, kj::addRef(*coreRedirector), kj::mv(runtimeConfig),
      kj::mv(runtimeHost), kj::mv(lifecycle), kj::mv(coreCap));
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

  auto listenTask = listener->listen(kj::mv(serverPort)).attach(kj::mv(listener));
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
