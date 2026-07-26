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
#include "isolate-native-host-launch.h"
#include "isolate-session-registry.h"
#include "isolate-util.h"
#include "util.h"
#include "version.h"
#include "web-session-websocket.h"

#include <sandstorm/isolate/api.js.h>
#include <sandstorm/isolate/capnp-es.js.h>
#include <sandstorm/isolate/capnp-runtime.js.h>

#include <capnp/message.h>
#include <capnp/compat/http-over-capnp.h>
#include <capnp/compat/json.h>
#include <capnp/membrane.h>
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
#include <sandstorm/isolate-exports.capnp.h>
#include <sandstorm/isolate-account-host.capnp.h>
#include <sandstorm/isolate-host.capnp.h>
#include <sandstorm/isolate-session-exports.capnp.h>
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
#include <sys/ptrace.h>
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
namespace sandstorm {

namespace {

constexpr uint64_t CAPNP_PERSISTENT_INTERFACE_ID = 0xc8cb212fcd9f5691ull;
constexpr uint64_t SYSTEM_PERSISTENT_INTERFACE_ID = 0xc38cedd77cbed5b4ull;
constexpr uint64_t APP_PERSISTENT_INTERFACE_ID = 0xaffa789add8747b8ull;

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
  };

  struct Export {
    enum class Role {
      ORDINARY,
      MAIN_VIEW,
    };

    kj::String name;
    uint64_t interfaceId;
    Role role;
  };

  kj::String mainModule;
  kj::String declaredMainModule;  // Manifest identity, before any internal entry adapter.
  kj::String compatibilityDate;
  kj::String runtimeStateDir;
  kj::String storageRootPath;
  kj::Own<capnp::MallocMessageBuilder> viewInfoMessage;
  kj::Vector<kj::String> compatibilityFlags;
  kj::Vector<Module> modules;
  kj::Vector<Binding> bindings;
  kj::Vector<Export> exports;
};

// Producer limits mirror the native decoder's independent trust-boundary checks.
constexpr size_t MAX_ISOLATE_MODULES = 1024;
constexpr size_t MAX_ISOLATE_MODULE_BYTES = 8 * 1024 * 1024;
constexpr size_t MAX_ISOLATE_TOTAL_MODULE_BYTES = 16 * 1024 * 1024;
constexpr size_t MAX_ISOLATE_BINDINGS = 1024;
constexpr size_t MAX_ISOLATE_EXPORTS = 256;
constexpr size_t MAX_ISOLATE_TOTAL_BINDING_BYTES = 4 * 1024 * 1024;
constexpr size_t MAX_ISOLATE_NAME_BYTES = 256;

void writeAllToFd(int fd, kj::ArrayPtr<const byte> content);

struct SpoolFile final: public kj::AtomicRefcounted {
  explicit SpoolFile(kj::AutoCloseFd fd): fd(kj::mv(fd)) {}
  kj::AutoCloseFd fd;
};

class SpoolIoWorker final {
public:
  SpoolIoWorker(): thread([this]() noexcept { run(); }) {
    auto lock = shared.lockExclusive();
    lock.wait([](const Shared& state) { return state.executor != nullptr; });
  }

  ~SpoolIoWorker() noexcept(false) {
    auto executor = getExecutor();
    executor->executeSync([this]() {
      auto lock = shared.lockExclusive();
      KJ_ASSERT(lock->shutdownFulfiller != nullptr);
      lock->shutdownFulfiller->fulfill();
      lock->shutdownFulfiller = nullptr;
    });
  }

  kj::Promise<void> write(kj::Own<SpoolFile> file, kj::Array<byte> data) {
    return getExecutor()->executeAsync(
        [file = kj::mv(file), data = kj::mv(data)]() mutable {
      writeAllToFd(file->fd.get(), data);
    });
  }

  kj::Promise<void> sync(kj::Own<SpoolFile> file) {
    return getExecutor()->executeAsync([file = kj::mv(file)]() mutable {
      KJ_SYSCALL(fsync(file->fd.get()));
    });
  }

  kj::Promise<void> rewind(kj::Own<SpoolFile> file) {
    return getExecutor()->executeAsync([file = kj::mv(file)]() mutable {
      KJ_SYSCALL(lseek(file->fd.get(), 0, SEEK_SET));
    });
  }

  kj::Promise<kj::Array<byte>> read(kj::Own<SpoolFile> file, size_t maxBytes) {
    return getExecutor()->executeAsync(
        [file = kj::mv(file), maxBytes]() mutable -> kj::Array<byte> {
      auto buffer = kj::heapArray<byte>(maxBytes);
      ssize_t count;
      KJ_SYSCALL(count = ::read(file->fd.get(), buffer.begin(), buffer.size()));
      return kj::heapArray<byte>(buffer.asPtr().slice(0, static_cast<size_t>(count)));
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

struct IsolateRuntimeHost final: public kj::Refcounted {
  IsolateRuntimeHost(
      kj::Network& network, kj::Timer& timer, kj::StringPtr grainId,
      SandstormCore::Client sandstormCore, SpoolIoWorker& spoolIo)
      : network(network), timer(timer), grainId(kj::heapString(grainId)),
        sandstormCore(kj::mv(sandstormCore)),
        spoolIo(spoolIo),
        sessions(kj::refcounted<IsolateSessionRegistry>()) {}

  void setHosted(HostedIsolate::Client value) { hosted = kj::mv(value); }
  void setPlatformBridge(IsolateBridge::Client value) { platformBridge = kj::mv(value); }

  kj::Promise<capnp::Capability::Client> getExport(kj::StringPtr name, uint64_t interfaceId) {
    auto& hostedClient = KJ_REQUIRE_NONNULL(hosted, "hosted isolate ingress is not ready");
    auto request = hostedClient.getExportRequest();
    request.setName(name);
    request.setInterfaceId(interfaceId);
    return request.send().then([](auto response) -> capnp::Capability::Client {
      return response.getCap();
    });
  }

  kj::Promise<capnp::Capability::Client> getWorkerInternalExport(
      kj::StringPtr name, uint64_t interfaceId) {
    auto& hostedClient = KJ_REQUIRE_NONNULL(hosted, "hosted isolate ingress is not ready");
    IsolateBridge::Client platform = KJ_REQUIRE_NONNULL(
        platformBridge, "isolate platform bridge is not ready");
    auto bootstrapRequest = hostedClient.getRpcBootstrapRequest();
    return bootstrapRequest.send().then(
        [name = kj::heapString(name), interfaceId, platform = kj::mv(platform)](
            auto response) mutable {
      capnp::Capability::Client bootstrap = response.getCap();
      auto request = bootstrap.castAs<IsolateExportBroker>().getExportRequest();
      request.setName(name);
      request.setInterfaceId(interfaceId);
      request.setPlatform(platform);
      return request.send().then([](auto result) -> capnp::Capability::Client {
        return result.getCap();
      });
    });
  }

  kj::Promise<capnp::Capability::Client> restoreExport(
      kj::StringPtr name, uint64_t interfaceId, capnp::AnyPointer::Reader objectId) {
    auto& hostedClient = KJ_REQUIRE_NONNULL(hosted, "hosted isolate ingress is not ready");
    capnp::MallocMessageBuilder objectIdMessage;
    objectIdMessage.getRoot<capnp::AnyPointer>().set(objectId);
    auto objectIdWords = capnp::messageToFlatArray(objectIdMessage);
    IsolateBridge::Client platform = KJ_REQUIRE_NONNULL(
        platformBridge, "isolate platform bridge is not ready");
    auto bootstrapRequest = hostedClient.getRpcBootstrapRequest();
    return bootstrapRequest.send().then(
        [name = kj::heapString(name), interfaceId, platform = kj::mv(platform),
            objectIdWords = kj::mv(objectIdWords)](auto response) mutable {
      capnp::Capability::Client bootstrap = response.getCap();
      auto request = bootstrap.castAs<IsolateExportBroker>().restoreExportRequest();
      request.setName(name);
      request.setInterfaceId(interfaceId);
      request.setPlatform(platform);
      capnp::FlatArrayMessageReader objectIdReader(objectIdWords.asPtr());
      request.getObjectId().set(objectIdReader.getRoot<capnp::AnyPointer>());
      return request.send().then([](auto result) -> capnp::Capability::Client {
        return result.getCap();
      });
    });
  }

  kj::Promise<void> dropExport(
      kj::StringPtr name, uint64_t interfaceId, capnp::AnyPointer::Reader objectId) {
    auto& hostedClient = KJ_REQUIRE_NONNULL(hosted, "hosted isolate ingress is not ready");
    capnp::MallocMessageBuilder objectIdMessage;
    objectIdMessage.getRoot<capnp::AnyPointer>().set(objectId);
    auto objectIdWords = capnp::messageToFlatArray(objectIdMessage);
    IsolateBridge::Client platform = KJ_REQUIRE_NONNULL(
        platformBridge, "isolate platform bridge is not ready");
    auto bootstrapRequest = hostedClient.getRpcBootstrapRequest();
    return bootstrapRequest.send().then(
        [name = kj::heapString(name), interfaceId, platform = kj::mv(platform),
            objectIdWords = kj::mv(objectIdWords)](auto response) mutable {
      capnp::Capability::Client bootstrap = response.getCap();
      auto request = bootstrap.castAs<IsolateExportBroker>().dropExportRequest();
      request.setName(name);
      request.setInterfaceId(interfaceId);
      request.setPlatform(platform);
      capnp::FlatArrayMessageReader objectIdReader(objectIdWords.asPtr());
      request.getObjectId().set(objectIdReader.getRoot<capnp::AnyPointer>());
      return request.send().ignoreResult();
    });
  }

  kj::Network& network;
  kj::Timer& timer;
  kj::String grainId;
  SandstormCore::Client sandstormCore;
  kj::Maybe<IsolateBridge::Client> platformBridge;
  SpoolIoWorker& spoolIo;
  kj::Own<IsolateSessionRegistry> sessions;
  kj::Maybe<HostedIsolate::Client> hosted;
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
  }

  KJ_UNREACHABLE;
}

void validateIsolateRuntimeConfig(
    IsolateRuntimeConfig& config, bool enforceSharedHostLimits = false) {
  KJ_REQUIRE(config.mainModule.size() > 0, "Isolate command is missing mainModule.");
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

    for (uint j = 0; j < i; ++j) {
      KJ_REQUIRE(config.bindings[j].name != binding.name,
          "Isolate command has duplicate binding names.", binding.name);
    }
  }

  if (enforceSharedHostLimits) {
    KJ_REQUIRE(config.exports.size() <= MAX_ISOLATE_EXPORTS,
        "Isolate command export count exceeds limit.", config.exports.size());
  }
  for (auto i: kj::indices(config.exports)) {
    auto& workerExport = config.exports[i];
    KJ_REQUIRE(workerExport.name.size() > 0, "Isolate export is missing name.");
    KJ_REQUIRE(workerExport.interfaceId != 0,
        "Isolate export interface ID must be nonzero.", workerExport.name);
    if (enforceSharedHostLimits) {
      KJ_REQUIRE(workerExport.name.size() <= MAX_ISOLATE_NAME_BYTES,
          "Isolate export name exceeds size limit.", workerExport.name.size());
    }
    for (uint j = 0; j < i; ++j) {
      KJ_REQUIRE(config.exports[j].name != workerExport.name,
          "Isolate command has duplicate export names.", workerExport.name);
      KJ_REQUIRE(workerExport.role != IsolateRuntimeConfig::Export::Role::MAIN_VIEW ||
              config.exports[j].role != IsolateRuntimeConfig::Export::Role::MAIN_VIEW,
          "Isolate command declares more than one mainView export.", workerExport.name,
          config.exports[j].name);
    }
    if (workerExport.role == IsolateRuntimeConfig::Export::Role::MAIN_VIEW) {
      KJ_REQUIRE(workerExport.interfaceId == capnp::typeId<MainView<>>(),
          "Isolate mainView export must implement sandstorm MainView.", workerExport.name,
          workerExport.interfaceId, capnp::typeId<MainView<>>());
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
  addGeneratedIsolateModule(config, "sandstorm-internal:validation",
      IsolateRuntimeConfig::ModuleType::ES_MODULE, ISOLATE_VALIDATION_HELPER_SOURCE);
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

kj::String quoteIsolateJavaScriptString(kj::StringPtr value) {
  static constexpr char HEX[] = "0123456789abcdef";
  kj::Vector<char> output(value.size() + 3);
  output.add('"');
  for (char raw: value) {
    auto c = static_cast<unsigned char>(raw);
    switch (c) {
      case '"': output.addAll(kj::StringPtr("\\\"")); break;
      case '\\': output.addAll(kj::StringPtr("\\\\")); break;
      case '\b': output.addAll(kj::StringPtr("\\b")); break;
      case '\f': output.addAll(kj::StringPtr("\\f")); break;
      case '\n': output.addAll(kj::StringPtr("\\n")); break;
      case '\r': output.addAll(kj::StringPtr("\\r")); break;
      case '\t': output.addAll(kj::StringPtr("\\t")); break;
      default:
        if (c < 0x20) {
          output.addAll(kj::StringPtr("\\u00"));
          output.add(HEX[c >> 4]);
          output.add(HEX[c & 0x0f]);
        } else {
          output.add(raw);
        }
        break;
    }
  }
  output.add('"');
  output.add('\0');
  return kj::String(output.releaseAsArray());
}

kj::String makeIsolateMainViewEntrySource(kj::StringPtr userMainModule) {
  auto quotedMainModule = quoteIsolateJavaScriptString(userMainModule);
  return kj::str(
      "import worker from ", quotedMainModule, ";\n"
      "import { defineWorker, mainViewFromFetch } from \"sandstorm:api\";\n"
      "\n"
      "function normalizeWorker(worker) {\n"
      "  const workerLike = worker !== null &&\n"
      "      (typeof worker === \"object\" || typeof worker === \"function\");\n"
      "  if (workerLike && typeof worker.sandstormRpcEvent === \"function\") {\n"
      "    return worker;\n"
      "  }\n"
      "\n"
      "  let fetch;\n"
      "  if (typeof worker === \"function\") {\n"
      "    fetch = worker;\n"
      "  } else if (workerLike && typeof worker.fetch === \"function\") {\n"
      "    fetch = worker.fetch.bind(worker);\n"
      "  } else {\n"
      "    throw new TypeError(\n"
      "        \"main-view isolate must default-export defineWorker(), a fetch function, \" +\n"
      "        \"or an object with fetch()\");\n"
      "  }\n"
      "\n"
      "  const options = { fetch, viewInfo: {} };\n"
      "  if (workerLike && worker.browser !== undefined) {\n"
      "    options.browser = worker.browser;\n"
      "  }\n"
      "  if (workerLike && worker.webSocket !== undefined) {\n"
      "    if (typeof worker.webSocket !== \"function\") {\n"
      "      throw new TypeError(\"simple isolate webSocket must be a function\");\n"
      "    }\n"
      "    options.webSocket = worker.webSocket.bind(worker);\n"
      "  }\n"
      "\n"
      "  return defineWorker({\n"
      "    capabilities: { ui: mainViewFromFetch(options) },\n"
      "  });\n"
      "}\n"
      "\n"
      "export default normalizeWorker(worker);\n");
}

void wrapIsolateMainViewEntry(IsolateRuntimeConfig& config) {
  bool hasMainView = false;
  for (auto& workerExport: config.exports) {
    if (workerExport.role == IsolateRuntimeConfig::Export::Role::MAIN_VIEW) {
      hasMainView = true;
      break;
    }
  }
  if (!hasMainView) return;

  constexpr kj::StringPtr WRAPPER_MODULE = "sandstorm-internal:main-view-entry"_kj;
  KJ_REQUIRE(!hasIsolateModule(config, WRAPPER_MODULE),
      "Isolate command uses a reserved module name.", WRAPPER_MODULE);
  auto source = makeIsolateMainViewEntrySource(config.mainModule);
  addGeneratedIsolateModule(
      config, WRAPPER_MODULE, IsolateRuntimeConfig::ModuleType::ES_MODULE, source);
  config.mainModule = kj::str(WRAPPER_MODULE);
}

kj::Own<IsolateRuntimeConfig> copyIsolateConfig(
    spk::Manifest::IsolateConfig::Reader config, kj::StringPtr pkgPath,
    bool enforceSharedHostLimits) {
  auto result = kj::refcounted<IsolateRuntimeConfig>();
  result->mainModule = kj::heapString(config.getMainModule());
  result->declaredMainModule = kj::heapString(config.getMainModule());
  result->compatibilityDate = kj::heapString(config.getCompatibilityDate());
  result->viewInfoMessage = kj::heap<capnp::MallocMessageBuilder>();
  result->viewInfoMessage->initRoot<UiView::ViewInfo>();
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
    result->bindings.add(kj::mv(bindingConfig));
  }

  auto configuredExports = config.getExports();
  if (enforceSharedHostLimits) {
    KJ_REQUIRE(configuredExports.size() <= MAX_ISOLATE_EXPORTS,
        "Isolate command export count exceeds limit.", configuredExports.size());
  }
  for (auto workerExport: configuredExports) {
    auto role = [&]() {
      switch (workerExport.getRole()) {
        case spk::Manifest::IsolateConfig::Export::Role::ORDINARY:
          return IsolateRuntimeConfig::Export::Role::ORDINARY;
        case spk::Manifest::IsolateConfig::Export::Role::MAIN_VIEW:
          return IsolateRuntimeConfig::Export::Role::MAIN_VIEW;
      }
      KJ_UNREACHABLE;
    }();
    result->exports.add(IsolateRuntimeConfig::Export{
      .name = kj::heapString(workerExport.getName()),
      .interfaceId = workerExport.getInterfaceId(),
      .role = role,
    });
  }

  wrapIsolateMainViewEntry(*result);
  validateIsolateRuntimeConfig(*result, enforceSharedHostLimits);
  return result;
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

kj::Array<byte> prepareRuntimeState(kj::StringPtr varPath, IsolateRuntimeConfig& config) {
  auto bundleDir = kj::str(varPath, "/isolate-runtime");
  config.runtimeStateDir = kj::str(bundleDir);
  auto modulesDir = kj::str(bundleDir, "/modules");
  auto bindingsDir = kj::str(bundleDir, "/bindings");
  auto storageRootPath = kj::str(varPath, "/isolate-storage");
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
  appendJsonField(manifest, "topology", "accountSharedHost");

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
    manifest.addAll(kj::StringPtr(" }"));
  }

  manifest.addAll(kj::StringPtr("\n  ],\n  \"exports\": [\n"));
  for (auto i: kj::indices(config.exports)) {
    auto& workerExport = config.exports[i];
    if (i > 0) manifest.addAll(kj::StringPtr(",\n"));
    manifest.addAll(kj::StringPtr("    { "));
    appendJsonField(manifest, "name", workerExport.name);
    manifest.addAll(kj::StringPtr(", "));
    appendJsonField(manifest, "interfaceId", kj::str("0x", kj::hex(workerExport.interfaceId)));
    manifest.addAll(kj::StringPtr(" }"));
  }
  manifest.addAll(kj::StringPtr("\n  ]\n}\n"));
  manifest.add('\0');
  auto manifestText = kj::String(manifest.releaseAsArray());
  writeFile(kj::str(bundleDir, "/runtime-manifest.json"), manifestText.asBytes());

  capnp::MallocMessageBuilder sourceMessage;
  auto source = sourceMessage.initRoot<IsolateWorkerSource>();
  source.setFormatVersion(2);
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
    }
  }
  auto exports = source.initExports(config.exports.size());
  for (auto i: kj::indices(config.exports)) {
    exports[i].setName(config.exports[i].name);
    exports[i].setInterfaceId(config.exports[i].interfaceId);
  }
  kj::VectorOutputStream sourceBytes;
  capnp::writePackedMessage(sourceBytes, sourceMessage);
  auto result = kj::heapArray<byte>(sourceBytes.getArray());
  writeFile(kj::str(bundleDir, "/worker-source.capnp.bin"), result);
  return result;
}

struct PersistentRequirementState final: public kj::Refcounted {
  PersistentRequirementState() {
    auto revoked = kj::newPromiseAndFulfiller<void>();
    revocation = revoked.promise.fork();
    revocationFulfiller = kj::mv(revoked.fulfiller);
  }

  void revoke() {
    if (revoked) return;
    revoked = true;
    revocationFulfiller->fulfill();
    revocationFulfiller = nullptr;
  }

  bool revoked = false;
  kj::Maybe<kj::ForkedPromise<void>> revocation;
  kj::Own<kj::PromiseFulfiller<void>> revocationFulfiller;
  kj::Vector<OwnCapnp<capnp::List<MembraneRequirement>>> requirements;
  kj::Vector<SystemPersistent::RevocationObserver::Client> observers;
};

constexpr uint64_t MAX_BROWSER_CAPNP_RPC_WEBSOCKET_MESSAGE_BYTES =
    65 * 1024 * 1024;

class PersistentRevokerHandle final: public Handle::Server {
public:
  explicit PersistentRevokerHandle(kj::Own<PersistentRequirementState> state)
      : state(kj::mv(state)) {}

  ~PersistentRevokerHandle() noexcept(false) {
    state->revoke();
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

class IsolateAppRefCapability final: public SystemPersistent::Server {
public:
  IsolateAppRefCapability(kj::Own<IsolateRuntimeHost> host,
      capnp::Capability::Client cap,
      kj::Maybe<kj::Array<const byte>> parentToken = nullptr,
      kj::Own<PersistentRequirementState> requirementState =
          kj::refcounted<PersistentRequirementState>())
      : host(kj::mv(host)),
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

    auto params = context.getParams();
    auto request = cap.typelessRequest(interfaceId, methodId, params.targetSize());
    request.set(params);
    auto promise = request.send().then([context](auto&& response) mutable {
      context.initResults(response.targetSize()).set(response);
    });
    return { kj::mv(promise), false };
  }

  kj::Promise<void> addRequirements(AddRequirementsContext context) override {
    auto params = context.getParams();
    if (params.getRequirements().size() > 0) {
      requirementState->requirements.add(newOwnCapnp(params.getRequirements()));
    }

    auto observer = params.getObserver();
    auto request = observer.dropWhenRevokedRequest();
    request.setHandle(kj::heap<PersistentRevokerHandle>(kj::addRef(*requirementState)));
    requirementState->observers.add(kj::mv(observer));
    return request.send().ignoreResult().then([this, context]() mutable {
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

capnp::Capability::Client makeIsolateWorkerPersistentCapability(
    kj::Own<IsolateRuntimeHost> host, kj::StringPtr exportName, uint64_t interfaceId,
    capnp::Capability::Client cap, kj::Own<PersistentRequirementState> requirementState);

class IsolateWorkerMembranePolicy final:
    public capnp::MembranePolicy, public kj::Refcounted {
public:
  IsolateWorkerMembranePolicy(kj::Own<IsolateRuntimeHost> host,
      kj::StringPtr exportName, uint64_t interfaceId,
      kj::Own<PersistentRequirementState> requirementState)
      : host(kj::mv(host)),
        exportName(kj::heapString(exportName)),
        interfaceId(interfaceId),
        requirementState(kj::mv(requirementState)) {}

  bool shouldResolveBeforeRedirecting() override { return true; }

  kj::Maybe<capnp::Capability::Client> inboundCall(
      uint64_t requestedInterfaceId, uint16_t methodId,
      capnp::Capability::Client target) override {
    if (requestedInterfaceId == SYSTEM_PERSISTENT_INTERFACE_ID ||
        requestedInterfaceId == CAPNP_PERSISTENT_INTERFACE_ID) {
      return makeIsolateWorkerPersistentCapability(
          kj::addRef(*host), exportName, interfaceId, kj::mv(target),
          kj::addRef(*requirementState));
    } else if (requestedInterfaceId == APP_PERSISTENT_INTERFACE_ID) {
      KJ_UNIMPLEMENTED("can't call AppPersistent.save() from outside isolate grain");
    }
    return nullptr;
  }

  kj::Maybe<capnp::Capability::Client> outboundCall(
      uint64_t requestedInterfaceId, uint16_t methodId,
      capnp::Capability::Client target) override {
    if (requestedInterfaceId == APP_PERSISTENT_INTERFACE_ID) {
      KJ_UNIMPLEMENTED(
          "can't call AppPersistent.save() on capabilities from outside the isolate grain");
    } else if (requestedInterfaceId == SYSTEM_PERSISTENT_INTERFACE_ID ||
               requestedInterfaceId == CAPNP_PERSISTENT_INTERFACE_ID) {
      KJ_FAIL_REQUIRE("Cannot directly save an external capability from an isolate grain. "
          "Use the capability's operation-scoped saver instead.");
    }
    return nullptr;
  }

  kj::Own<MembranePolicy> addRef() override { return kj::addRef(*this); }

  kj::Maybe<kj::Promise<void>> onRevoked() override {
    KJ_IF_MAYBE(revocation, requirementState->revocation) {
      return revocation->addBranch();
    }
    KJ_UNREACHABLE;
  }

private:
  kj::Own<IsolateRuntimeHost> host;
  kj::String exportName;
  uint64_t interfaceId;
  kj::Own<PersistentRequirementState> requirementState;
};

class IsolateWorkerPersistentCapability final: public SystemPersistent::Server {
public:
  IsolateWorkerPersistentCapability(kj::Own<IsolateRuntimeHost> host,
      kj::StringPtr exportName, uint64_t interfaceId, capnp::Capability::Client cap,
      kj::Maybe<kj::Array<const byte>> parentToken = nullptr,
      kj::Own<PersistentRequirementState> requirementState =
          kj::refcounted<PersistentRequirementState>(),
      kj::Maybe<kj::Own<IsolateWorkerMembranePolicy>> membranePolicy = nullptr)
      : host(kj::mv(host)),
        exportName(kj::heapString(exportName)),
        interfaceId(interfaceId),
        appCap(nullptr),
        cap(nullptr),
        parentToken(kj::mv(parentToken)),
        requirementState(kj::mv(requirementState)) {
    appCap = cap;
    KJ_IF_MAYBE(policy, membranePolicy) {
      this->cap = capnp::membrane(kj::mv(cap), kj::mv(*policy));
    } else {
      this->cap = capnp::membrane(kj::mv(cap), kj::refcounted<IsolateWorkerMembranePolicy>(
          kj::addRef(*this->host), this->exportName, this->interfaceId,
          kj::addRef(*this->requirementState)));
    }
  }

  DispatchCallResult dispatchCall(uint64_t requestedInterfaceId, uint16_t methodId,
      capnp::CallContext<capnp::AnyPointer, capnp::AnyPointer> context) override {
    context.allowCancellation();
    if (requestedInterfaceId == SYSTEM_PERSISTENT_INTERFACE_ID ||
        requestedInterfaceId == CAPNP_PERSISTENT_INTERFACE_ID) {
      return SystemPersistent::Server::dispatchCall(requestedInterfaceId, methodId, context);
    }
    if (requestedInterfaceId == APP_PERSISTENT_INTERFACE_ID) {
      KJ_UNIMPLEMENTED("can't call AppPersistent.save() from outside isolate grain");
    }
    KJ_REQUIRE(!requirementState->revoked,
        "isolate worker capability requirements have been revoked");

    auto params = context.getParams();
    auto request = cap.typelessRequest(requestedInterfaceId, methodId, params.targetSize());
    request.set(params);
    auto promise = request.send().then([context](auto&& response) mutable {
      context.initResults(response.targetSize()).set(response);
    });
    return { kj::mv(promise), false };
  }

  kj::Promise<void> addRequirements(AddRequirementsContext context) override {
    auto params = context.getParams();
    if (params.getRequirements().size() > 0) {
      requirementState->requirements.add(newOwnCapnp(params.getRequirements()));
    }

    auto observer = params.getObserver();
    auto request = observer.dropWhenRevokedRequest();
    request.setHandle(kj::heap<PersistentRevokerHandle>(kj::addRef(*requirementState)));
    requirementState->observers.add(kj::mv(observer));
    return request.send().ignoreResult().then([this, context]() mutable {
      context.getResults().setCap(this->thisCap().castAs<SystemPersistent>());
    });
  }

  kj::Promise<void> save(SaveContext context) override {
    KJ_REQUIRE(!requirementState->revoked,
        "isolate worker capability requirements have been revoked");
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

    auto appRequest = appCap.castAs<AppPersistent<>>().saveRequest();
    return appRequest.send().then([this, context, KJ_MVCAP(owner)](auto result) mutable {
      auto request = host->sandstormCore.makeTokenRequest();
      auto workerRef = request.getRef().initIsolateWorkerRef();
      workerRef.setExportName(exportName);
      workerRef.setInterfaceId(interfaceId);
      workerRef.getObjectId().setAs<capnp::AnyPointer>(result.getObjectId());
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
  kj::String exportName;
  uint64_t interfaceId;
  capnp::Capability::Client appCap;
  capnp::Capability::Client cap;
  kj::Maybe<kj::Array<const byte>> parentToken;
  kj::Own<PersistentRequirementState> requirementState;
};

capnp::Capability::Client makeIsolateWorkerPersistentCapability(
    kj::Own<IsolateRuntimeHost> host, kj::StringPtr exportName, uint64_t interfaceId,
    capnp::Capability::Client cap, kj::Own<PersistentRequirementState> requirementState) {
  return kj::heap<IsolateWorkerPersistentCapability>(
      kj::mv(host), exportName, interfaceId, kj::mv(cap), nullptr,
      kj::mv(requirementState));
}

kj::Maybe<kj::Array<byte>> loadIsolateBrowserModule(
    IsolateRuntimeConfig& config, kj::StringPtr path);

WebSession::WebSocketMessageStream::Client makeIsolateBrowserRpcStream(
    IsolateRuntimeConfig& config, IsolateRuntimeHost& host,
    kj::StringPtr sessionId, WorkerMainViewSession::Client session,
    WebSession::WebSocketMessageStream::Client outgoing);

kj::Maybe<kj::StringPtr> isolateBrowserModulePath(kj::StringPtr path) {
  if (path.startsWith("/")) {
    path = path.slice(1);
  }

  const kj::StringPtr capnpPrefix = "__sandstorm/capnp/";
  if (path.startsWith(capnpPrefix)) {
    return path.slice(capnpPrefix.size());
  }
  if (path == "__sandstorm/native-capnp/client.js") {
    return path;
  }
  if (path.startsWith("capnp-es/")) {
    return path;
  }
  return nullptr;
}

bool isIsolateBrowserRpcPath(kj::StringPtr path) {
  if (path.startsWith("/")) {
    path = path.slice(1);
  }
  return path == "__sandstorm/native-capnp/rpc-session";
}

class IsolateDirectSessionState final: public kj::Refcounted {
public:
  IsolateDirectSessionState(kj::Own<IsolateRuntimeHost> host, kj::String id)
      : host(kj::mv(host)), id(kj::mv(id)) {}

  ~IsolateDirectSessionState() noexcept(false) {
    host->sessions->unregisterSession(id);
  }

  kj::StringPtr getId() const { return id; }

private:
  kj::Own<IsolateRuntimeHost> host;
  kj::String id;
};

class IsolateSessionIdCapability final: public IsolateSessionContext::Server {
public:
  explicit IsolateSessionIdCapability(kj::Own<IsolateDirectSessionState> state)
      : state(kj::mv(state)) {}

  kj::Promise<void> getSessionId(GetSessionIdContext context) override {
    context.getResults().setId(state->getId());
    return kj::READY_NOW;
  }

private:
  kj::Own<IsolateDirectSessionState> state;
};

class IsolateSessionContextMembrane final:
    public capnp::MembranePolicy, public kj::Refcounted {
public:
  explicit IsolateSessionContextMembrane(kj::Own<IsolateDirectSessionState> state)
      : state(kj::mv(state)) {}

  bool shouldResolveBeforeRedirecting() override { return true; }

  kj::Maybe<capnp::Capability::Client> inboundCall(
      uint64_t requestedInterfaceId, uint16_t methodId,
      capnp::Capability::Client target) override {
    (void)target;
    if (requestedInterfaceId == capnp::typeId<IsolateSessionContext>() && methodId == 0) {
      return capnp::Capability::Client(
          kj::heap<IsolateSessionIdCapability>(kj::addRef(*state)));
    }
    return nullptr;
  }

  kj::Maybe<capnp::Capability::Client> outboundCall(
      uint64_t requestedInterfaceId, uint16_t methodId,
      capnp::Capability::Client target) override {
    (void)requestedInterfaceId;
    (void)methodId;
    (void)target;
    return nullptr;
  }

  kj::Own<MembranePolicy> addRef() override { return kj::addRef(*this); }

private:
  kj::Own<IsolateDirectSessionState> state;
};

class IsolateBrowserWebSessionMethods final: public WebSession::Server {
public:
  IsolateBrowserWebSessionMethods(
      kj::Own<IsolateRuntimeConfig> config, kj::Own<IsolateRuntimeHost> host,
      kj::Own<IsolateDirectSessionState> state, WorkerMainViewSession::Client inner)
      : config(kj::mv(config)), host(kj::mv(host)), state(kj::mv(state)),
        inner(kj::mv(inner)) {}

  DispatchCallResult dispatchCall(uint64_t interfaceId, uint16_t methodId,
      capnp::CallContext<capnp::AnyPointer, capnp::AnyPointer> context) override {
    // WebSession.get() and openWebSocketMessages() are ordinals 0 and 18.
    if (interfaceId == capnp::typeId<WebSession>() && (methodId == 0 || methodId == 18)) {
      return WebSession::Server::dispatchCall(interfaceId, methodId, context);
    }

    auto params = context.getParams();
    auto request = inner.typelessRequest(interfaceId, methodId, params.targetSize());
    request.set(params);
    return { context.tailCall(kj::mv(request)), false };
  }

  kj::Promise<void> get(GetContext context) override {
    auto params = context.getParams();
    KJ_IF_MAYBE(path, isolateBrowserModulePath(params.getPath())) {
      KJ_IF_MAYBE(source, loadIsolateBrowserModule(*config, *path)) {
        auto response = context.getResults();
        response.initSetCookies(0);
        auto content = response.initContent();
        content.setStatusCode(WebSession::Response::SuccessCode::OK);
        content.setMimeType("text/javascript; charset=utf-8");
        content.initBody().setBytes(*source);
        content.getDisposition().setNormal();
        return kj::READY_NOW;
      }

      auto response = context.getResults();
      response.initSetCookies(0);
      auto error = response.initClientError();
      error.setStatusCode(WebSession::Response::ClientErrorCode::NOT_FOUND);
      error.setDescriptionHtml("browser capnp-es module not found");
      return kj::READY_NOW;
    }

    auto request = inner.getRequest();
    request.setPath(params.getPath());
    request.setContext(params.getContext());
    request.setIgnoreBody(params.getIgnoreBody());
    return context.tailCall(kj::mv(request));
  }

  kj::Promise<void> openWebSocketMessages(OpenWebSocketMessagesContext context) override {
    auto params = context.getParams();
    if (isIsolateBrowserRpcPath(params.getPath())) {
      KJ_REQUIRE(params.getProtocol().size() == 0,
          "browser isolate bridge RPC does not use WebSocket subprotocols");
      context.getResults().initProtocol(0);
      context.getResults().setServerStream(makeIsolateBrowserRpcStream(
          *config, *host, state->getId(), inner, params.getClientStream()));
      return kj::READY_NOW;
    }

    auto request = inner.openWebSocketMessagesRequest();
    request.setPath(params.getPath());
    request.setContext(params.getContext());
    request.setProtocol(params.getProtocol());
    request.setClientStream(params.getClientStream());
    return context.tailCall(kj::mv(request));
  }

private:
  kj::Own<IsolateRuntimeConfig> config;
  kj::Own<IsolateRuntimeHost> host;
  kj::Own<IsolateDirectSessionState> state;
  WorkerMainViewSession::Client inner;
};

class IsolateSessionLifetimeMembrane final:
    public capnp::MembranePolicy, public kj::Refcounted {
public:
  explicit IsolateSessionLifetimeMembrane(kj::Own<IsolateDirectSessionState> state)
      : state(kj::mv(state)) {}

  kj::Maybe<capnp::Capability::Client> inboundCall(
      uint64_t requestedInterfaceId, uint16_t methodId,
      capnp::Capability::Client target) override {
    (void)requestedInterfaceId;
    (void)methodId;
    (void)target;
    return nullptr;
  }

  kj::Maybe<capnp::Capability::Client> outboundCall(
      uint64_t requestedInterfaceId, uint16_t methodId,
      capnp::Capability::Client target) override {
    (void)requestedInterfaceId;
    (void)methodId;
    (void)target;
    return nullptr;
  }

  kj::Own<MembranePolicy> addRef() override { return kj::addRef(*this); }

private:
  kj::Own<IsolateDirectSessionState> state;
};

class IsolateDirectMainView final: public MainView<>::Server {
public:
  IsolateDirectMainView(
      kj::Own<IsolateRuntimeConfig> config, kj::Own<IsolateRuntimeHost> host,
      MainView<>::Client inner, kj::Own<IsolateWorkerMembranePolicy> workerMembranePolicy)
      : config(kj::mv(config)), host(kj::mv(host)), inner(kj::mv(inner)),
        workerMembranePolicy(kj::mv(workerMembranePolicy)) {}

  DispatchCallResult dispatchCall(uint64_t interfaceId, uint16_t methodId,
      capnp::CallContext<capnp::AnyPointer, capnp::AnyPointer> context) override {
    if (interfaceId == capnp::typeId<MainView<>>() || interfaceId == capnp::typeId<UiView>()) {
      return MainView<>::Server::dispatchCall(interfaceId, methodId, context);
    }

    auto params = context.getParams();
    auto request = inner.typelessRequest(interfaceId, methodId, params.targetSize());
    request.set(params);
    return { context.tailCall(kj::mv(request)), false };
  }

  kj::Promise<void> getViewInfo(GetViewInfoContext context) override {
    return inner.getViewInfoRequest().send().then([this, context](auto response) mutable {
      config->viewInfoMessage = kj::heap<capnp::MallocMessageBuilder>(
          response.totalSize().wordCount + 4);
      config->viewInfoMessage->setRoot(response);
      context.setResults(response);
    });
  }

  kj::Promise<void> newSession(NewSessionContext context) override {
    auto params = context.getParams();
    auto id = host->sessions->registerSession(unwrapExternal(params.getContext()));
    auto state = kj::refcounted<IsolateDirectSessionState>(kj::addRef(*host), kj::mv(id));
    auto request = inner.newSessionRequest();
    copyCommonSessionParams(params, request, *state);
    return finishSession(
        request.send(), context, kj::mv(state), params.getSessionType());
  }

  kj::Promise<void> newRequestSession(NewRequestSessionContext context) override {
    auto params = context.getParams();
    auto id = host->sessions->registerSession(unwrapExternal(params.getContext()));
    auto state = kj::refcounted<IsolateDirectSessionState>(kj::addRef(*host), kj::mv(id));
    auto request = inner.newRequestSessionRequest();
    copyCommonSessionParams(params, request, *state);
    request.setRequestInfo(params.getRequestInfo());
    return finishSession(
        request.send(), context, kj::mv(state), params.getSessionType());
  }

  kj::Promise<void> newOfferSession(NewOfferSessionContext context) override {
    auto params = context.getParams();
    auto id = host->sessions->registerOfferSession(
        unwrapExternal(params.getContext()), unwrapExternal(params.getOffer()));
    auto state = kj::refcounted<IsolateDirectSessionState>(kj::addRef(*host), kj::mv(id));
    auto request = inner.newOfferSessionRequest();
    copyCommonSessionParams(params, request, *state);
    request.setOffer(params.getOffer());
    request.setDescriptor(params.getDescriptor());
    return finishSession(
        request.send(), context, kj::mv(state), params.getSessionType());
  }

  kj::Promise<void> restore(RestoreContext context) override {
    auto request = inner.restoreRequest();
    request.getObjectId().set(context.getParams().getObjectId());
    return request.send().then([context](auto response) mutable {
      context.getResults().setCap(response.getCap());
    });
  }

  kj::Promise<void> drop(DropContext context) override {
    auto request = inner.dropRequest();
    request.getObjectId().set(context.getParams().getObjectId());
    return request.send().ignoreResult();
  }

private:
  kj::Own<IsolateRuntimeConfig> config;
  kj::Own<IsolateRuntimeHost> host;
  MainView<>::Client inner;
  kj::Own<IsolateWorkerMembranePolicy> workerMembranePolicy;

  template <typename Client>
  Client unwrapExternal(Client client) {
    return capnp::membrane(kj::mv(client), workerMembranePolicy->addRef());
  }

  template <typename Params, typename Request>
  void copyCommonSessionParams(
      Params params, Request& request, IsolateDirectSessionState& state) {
    request.setUserInfo(params.getUserInfo());
    request.setContext(capnp::membrane(
        params.getContext(), kj::refcounted<IsolateSessionContextMembrane>(kj::addRef(state)))
        .template castAs<SessionContext>());
    request.setSessionType(params.getSessionType());
    request.getSessionParams().set(params.getSessionParams());
    request.setTabId(params.getTabId());
  }

  template <typename RemotePromise, typename Context>
  kj::Promise<void> finishSession(
      RemotePromise promise, Context context, kj::Own<IsolateDirectSessionState> state,
      uint64_t sessionType) {
    return promise.then(
        [this, context, state = kj::mv(state), sessionType](auto response) mutable {
      auto protectedSession = capnp::membrane(
          response.getSession(),
          kj::refcounted<IsolateSessionLifetimeMembrane>(kj::addRef(*state)))
          .template castAs<UiSession>();
      if (sessionType == capnp::typeId<WebSession>()) {
        context.getResults().setSession(
            WebSession::Client(kj::heap<IsolateBrowserWebSessionMethods>(
                kj::addRef(*config), kj::addRef(*host), kj::mv(state),
                protectedSession.template castAs<WorkerMainViewSession>()))
            .template castAs<UiSession>());
      } else {
        context.getResults().setSession(protectedSession);
      }
    });
  }
};

capnp::Capability::Client wrapIsolateWorkerExport(
    kj::Own<IsolateRuntimeConfig> config, kj::Own<IsolateRuntimeHost> host, kj::StringPtr exportName,
    uint64_t interfaceId, capnp::Capability::Client cap) {
  auto requirementState = kj::refcounted<PersistentRequirementState>();
  auto membranePolicy = kj::refcounted<IsolateWorkerMembranePolicy>(
      kj::addRef(*host), exportName, interfaceId, kj::addRef(*requirementState));
  if (interfaceId == capnp::typeId<MainView<>>()) {
    cap = kj::heap<IsolateDirectMainView>(
        kj::mv(config), kj::addRef(*host), kj::mv(cap).castAs<MainView<>>(),
        kj::addRef(*membranePolicy));
  }
  return kj::heap<IsolateWorkerPersistentCapability>(
      kj::mv(host), exportName, interfaceId, kj::mv(cap), nullptr,
      kj::mv(requirementState), kj::mv(membranePolicy));
}

IsolateStorage::Client makeIsolateStorage(
    kj::StringPtr storageRootPath);

class IsolatePlatformServices final {
public:
  static IsolateBridge::Client makeBridge(
      IsolateRuntimeConfig& config, IsolateRuntimeHost& host);

  static BrowserIsolateBridge::Client makeBrowserBridge(
      IsolateRuntimeConfig& config, IsolateRuntimeHost& host, kj::String sessionId,
      WorkerMainViewSession::Client session);

  static kj::Maybe<kj::Array<byte>> loadBrowserModule(
      IsolateRuntimeConfig& config, kj::StringPtr path);

private:
  class IsolateBridgeImpl final: public IsolateBridge::Server {
  public:
    IsolateBridgeImpl(IsolateRuntimeConfig& config, IsolateRuntimeHost& host)
        : config(config), host(host) {}

    class CapabilitySaver final: public IsolateCapabilitySaver::Server {
    public:
      CapabilitySaver(IsolateRuntimeHost& host, capnp::Capability::Client cap)
          : host(host), cap(kj::mv(cap)) {}

      kj::Promise<void> save(SaveContext context) override {
        auto request = cap.castAs<SystemPersistent>().saveRequest();
        auto owner = request.getSealFor().initGrain();
        owner.setGrainId(host.grainId);
        owner.setSaveLabel(context.getParams().getLabel());
        return request.send().then([context](auto result) mutable {
          context.getResults().setToken(result.getSturdyRef());
        });
      }

    private:
      IsolateRuntimeHost& host;
      capnp::Capability::Client cap;
    };

    kj::Promise<void> saveAppCapability(SaveAppCapabilityContext context) override {
      auto params = context.getParams();
      KJ_REQUIRE(params.hasCap(), "Cannot save a null app capability.");
      auto request = params.getCap().castAs<AppPersistent<>>().saveRequest();
      auto saveLabel = newOwnCapnp(params.getLabel());
      return request.send().then(
          [this, context, KJ_MVCAP(saveLabel)](auto result) mutable {
        auto tokenRequest = host.sandstormCore.makeTokenRequest();
        tokenRequest.getRef().setAppRef(result.getObjectId());
        auto owner = tokenRequest.getOwner().initGrain();
        owner.setGrainId(host.grainId);
        owner.setSaveLabel(saveLabel);
        return tokenRequest.send().then([context](auto tokenResult) mutable {
          context.getResults().setToken(tokenResult.getToken());
        });
      });
    }

    kj::Promise<void> restoreCapability(RestoreCapabilityContext context) override {
      auto request = host.sandstormCore.restoreRequest();
      request.setToken(context.getParams().getToken());
      return request.send().then([this, context](auto result) mutable {
        auto cap = result.getCap();
        context.getResults().setCap(cap);
        context.getResults().setSaver(kj::heap<CapabilitySaver>(host, kj::mv(cap)));
      });
    }

    kj::Promise<void> dropCapability(DropCapabilityContext context) override {
      auto request = host.sandstormCore.dropRequest();
      request.setToken(context.getParams().getToken());
      return request.send().ignoreResult();
    }

    kj::Promise<void> getOfferedCapability(GetOfferedCapabilityContext context) override {
      auto sessionId = context.getParams().getSessionId();
      KJ_IF_MAYBE(cap, host.sessions->findOfferedCapability(sessionId)) {
        context.getResults().setFound(true);
        context.getResults().setCap(*cap);
        context.getResults().setSaver(kj::heap<CapabilitySaver>(host, *cap));
      }
      return kj::READY_NOW;
    }

    kj::Promise<void> getWorkerExport(GetWorkerExportContext context) override {
      auto params = context.getParams();
      auto name = kj::heapString(params.getName());
      auto interfaceId = params.getInterfaceId();
      return host.getWorkerInternalExport(name, interfaceId).then(
          [this, context, name = kj::mv(name), interfaceId](
              capnp::Capability::Client cap) mutable {
        auto wrapped = wrapIsolateWorkerExport(
            kj::addRef(config), kj::addRef(host), name, interfaceId, kj::mv(cap));
        context.getResults().setCap(wrapped);
        context.getResults().setSaver(kj::heap<CapabilitySaver>(host, kj::mv(wrapped)));
      });
    }

    kj::Promise<void> createBrowserHandoff(CreateBrowserHandoffContext context) override {
      auto params = context.getParams();
      KJ_REQUIRE(params.hasCap(), "Cannot hand off a null browser capability.");

      auto id = host.sessions->storeBrowserHandoffCapability(
          params.getSessionId(), params.getInterfaceId(), params.getInterfaceName(),
          params.getCap());
      context.getResults().setId(id);
      return kj::READY_NOW;
    }

    kj::Promise<void> dropBrowserHandoff(DropBrowserHandoffContext context) override {
      auto id = context.getParams().getId();
      context.getResults().setReleased(host.sessions->dropBrowserHandoffCapability(id));
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

    kj::Promise<void> getStorage(GetStorageContext context) override {
      context.getResults().setStorage(
          makeIsolateStorage(config.storageRootPath));
      return kj::READY_NOW;
    }

    kj::Promise<void> getViewInfo(GetViewInfoContext context) override {
      context.getResults().setViewInfo(
          config.viewInfoMessage->getRoot<UiView::ViewInfo>().asReader());
      return kj::READY_NOW;
    }

    kj::Promise<void> getRuntimeStatus(GetRuntimeStatusContext context) override {
      context.getResults().setMainModule(config.declaredMainModule);
      return kj::READY_NOW;
    }

    kj::Promise<void> claimPowerboxRequest(ClaimPowerboxRequestContext context) override {
      auto params = context.getParams();
      KJ_IF_MAYBE(sessionContext, host.sessions->findSessionContext(params.getSessionId())) {
        auto request = sessionContext->claimRequestRequest();
        request.setRequestToken(params.getRequestToken());
        request.setRequiredPermissions(params.getRequiredPermissions());
        return request.send().then([this, context](auto result) mutable {
          auto cap = result.getCap();
          context.getResults().setCap(cap);
          context.getResults().setSaver(kj::heap<CapabilitySaver>(host, kj::mv(cap)));
        });
      }

      KJ_FAIL_REQUIRE("isolate bridge session ID not found", params.getSessionId());
    }

    kj::Promise<void> offerPowerboxCapability(
        OfferPowerboxCapabilityContext context) override {
      auto params = context.getParams();
      KJ_IF_MAYBE(sessionContext, host.sessions->findSessionContext(params.getSessionId())) {
        auto request = sessionContext->offerRequest();
        request.setCap(params.getCap());
        request.setRequiredPermissions(params.getRequiredPermissions());
        request.setDescriptor(params.getDescriptor());
        request.setDisplayInfo(params.getDisplayInfo());
        return request.send().ignoreResult();
      }

      KJ_FAIL_REQUIRE("isolate bridge session ID not found", params.getSessionId());
    }

    kj::Promise<void> fulfillPowerboxRequest(
        FulfillPowerboxRequestContext context) override {
      auto params = context.getParams();
      KJ_IF_MAYBE(sessionContext, host.sessions->findSessionContext(params.getSessionId())) {
        auto request = sessionContext->fulfillRequestRequest();
        request.setCap(params.getCap());
        request.setRequiredPermissions(params.getRequiredPermissions());
        request.setDescriptor(params.getDescriptor());
        request.setDisplayInfo(params.getDisplayInfo());
        return request.send().ignoreResult();
      }

      KJ_FAIL_REQUIRE("isolate bridge session ID not found", params.getSessionId());
    }

    kj::Promise<void> tieCapabilityToUser(
        TieCapabilityToUserContext context) override {
      auto params = context.getParams();
      KJ_IF_MAYBE(sessionContext, host.sessions->findSessionContext(params.getSessionId())) {
        auto request = sessionContext->tieToUserRequest();
        request.setCap(params.getCap());
        request.setRequiredPermissions(params.getRequiredPermissions());
        request.setDisplayInfo(params.getDisplayInfo());
        return request.send().then([this, context](auto result) mutable {
          auto cap = result.getTiedCap();
          context.getResults().setCap(cap);
          context.getResults().setSaver(kj::heap<CapabilitySaver>(host, kj::mv(cap)));
        });
      }

      KJ_FAIL_REQUIRE("isolate bridge session ID not found", params.getSessionId());
    }
  private:
    IsolateRuntimeConfig& config;
    IsolateRuntimeHost& host;
  };

  class BrowserIsolateBridgeImpl final: public BrowserIsolateBridge::Server {
  public:
    BrowserIsolateBridgeImpl(IsolateRuntimeConfig& config, IsolateRuntimeHost& host,
        kj::String sessionId, WorkerMainViewSession::Client session)
        : config(config), host(host), sessionId(kj::mv(sessionId)), session(kj::mv(session)) {}

    kj::Promise<void> takeHandoffCapability(TakeHandoffCapabilityContext context) override {
      KJ_REQUIRE(sessionId.size() > 0,
          "browser isolate bridge has no SessionContext for handoff resolution");
      auto params = context.getParams();
      auto id = params.getId();
      KJ_IF_MAYBE(handoff,
          host.sessions->takeBrowserHandoffCapability(
              sessionId, id, params.getInterfaceId())) {
        context.getResults().setCap(handoff->cap);
      } else {
        KJ_FAIL_REQUIRE(
            "browser isolate bridge handoff capability ID or interface not found", id);
      }
      return kj::READY_NOW;
    }

    kj::Promise<void> getApplicationBootstrap(
        GetApplicationBootstrapContext context) override {
      auto request = session.getBrowserBootstrapRequest();
      return request.send().then([context](auto response) mutable {
        auto results = context.getResults();
        results.setFound(response.getFound());
        if (response.getFound()) {
          KJ_REQUIRE(response.getInterfaceId() != 0,
              "worker returned an untyped browser application capability");
          KJ_REQUIRE(response.hasCap(),
              "worker returned a null browser application capability");
          results.setInterfaceId(response.getInterfaceId());
          results.setInterfaceName(response.getInterfaceName());
          results.setCap(response.getCap());
        }
      });
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
    WorkerMainViewSession::Client session;
  };

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

};

class IsolateBrowserRpcMessageStream final: public capnp::MessageStream {
public:
  explicit IsolateBrowserRpcMessageStream(
      WebSession::WebSocketMessageStream::Client outgoing)
      : outgoing(kj::mv(outgoing)) {}

  ~IsolateBrowserRpcMessageStream() noexcept(false) {
    closeIncoming();
  }

  kj::Promise<void> receive(capnp::Data::Reader message) {
    KJ_REQUIRE(!incomingClosed,
        "browser isolate bridge RPC session received a message after close");
    KJ_REQUIRE(message.size() <= MAX_BROWSER_CAPNP_RPC_WEBSOCKET_MESSAGE_BYTES,
        "browser isolate bridge RPC message exceeds maximum allowed size",
        message.size(), MAX_BROWSER_CAPNP_RPC_WEBSOCKET_MESSAGE_BYTES);

    auto bytes = kj::heapArray<byte>(message.size());
    memcpy(bytes.begin(), message.begin(), message.size());
    KJ_IF_MAYBE(pending, pendingRead) {
      auto pendingValue = kj::mv(*pending);
      pendingRead = nullptr;
      auto result = readFrame(
          kj::mv(bytes), pendingValue.options, pendingValue.scratchSpace);
      pendingValue.fulfiller->fulfill(kj::mv(result));
      return kj::READY_NOW;
    }

    auto consumed = kj::newPromiseAndFulfiller<void>();
    incoming.push(QueuedFrame { kj::mv(bytes), kj::mv(consumed.fulfiller) });
    return kj::mv(consumed.promise);
  }

  void closeIncoming() {
    if (incomingClosed) return;
    incomingClosed = true;
    KJ_IF_MAYBE(pending, pendingRead) {
      auto pendingValue = kj::mv(*pending);
      pendingRead = nullptr;
      pendingValue.fulfiller->fulfill(nullptr);
    }
    while (!incoming.empty()) {
      auto frame = kj::mv(incoming.front());
      incoming.pop();
      frame.consumed->reject(KJ_EXCEPTION(DISCONNECTED,
          "browser isolate bridge RPC session closed before consuming message"));
    }
  }

  kj::Promise<kj::Maybe<capnp::MessageReaderAndFds>> tryReadMessage(
      kj::ArrayPtr<kj::AutoCloseFd> fdSpace,
      capnp::ReaderOptions options = capnp::ReaderOptions(),
      kj::ArrayPtr<capnp::word> scratchSpace = nullptr) override {
    (void)fdSpace;
    KJ_REQUIRE(pendingRead == nullptr,
        "browser isolate bridge RPC stream cannot have concurrent reads");
    if (!incoming.empty()) {
      auto frame = kj::mv(incoming.front());
      incoming.pop();
      auto result = readFrame(kj::mv(frame.bytes), options, scratchSpace);
      frame.consumed->fulfill();
      return kj::mv(result);
    }
    if (incomingClosed) {
      return kj::Maybe<capnp::MessageReaderAndFds>(nullptr);
    }

    auto pending = kj::newPromiseAndFulfiller<
        kj::Maybe<capnp::MessageReaderAndFds>>();
    pendingRead = PendingRead {
      kj::mv(pending.fulfiller), options, scratchSpace
    };
    return kj::mv(pending.promise);
  }

  kj::Promise<void> writeMessage(kj::ArrayPtr<const int> fds,
      kj::ArrayPtr<const kj::ArrayPtr<const capnp::word>> segments) override {
    KJ_REQUIRE(fds.size() == 0,
        "browser isolate bridge RPC does not support file descriptors");
    return sendSerialized(serializeMessageSegments(segments));
  }

  kj::Promise<void> writeMessages(
      kj::ArrayPtr<kj::ArrayPtr<const kj::ArrayPtr<const capnp::word>>> messages) override {
    kj::Vector<kj::Array<byte>> serialized(messages.size());
    for (auto message: messages) {
      serialized.add(serializeMessageSegments(message));
    }
    auto fork = writeQueue.then(
        [this, serialized = serialized.releaseAsArray()]() mutable {
      kj::Promise<void> result = kj::READY_NOW;
      for (auto& data: serialized) {
        result = result.then([this, data = kj::mv(data)]() mutable {
          auto request = outgoing.sendDataRequest();
          request.setMessage(data);
          return request.send().attach(kj::mv(data));
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
      auto request = outgoing.closeRequest();
      request.setCode(1000);
      request.setReason("native Cap'n Proto bridge RPC session ended");
      return request.send();
    }).fork();
    writeQueue = fork.addBranch();
    return fork.addBranch();
  }

private:
  struct QueuedFrame {
    kj::Array<byte> bytes;
    kj::Own<kj::PromiseFulfiller<void>> consumed;
  };

  struct PendingRead {
    kj::Own<kj::PromiseFulfiller<kj::Maybe<capnp::MessageReaderAndFds>>> fulfiller;
    capnp::ReaderOptions options;
    kj::ArrayPtr<capnp::word> scratchSpace;
  };

  WebSession::WebSocketMessageStream::Client outgoing;
  kj::Promise<void> writeQueue = kj::READY_NOW;
  std::queue<QueuedFrame> incoming;
  kj::Maybe<PendingRead> pendingRead;
  bool incomingClosed = false;

  static kj::Maybe<capnp::MessageReaderAndFds> readFrame(
      kj::Array<byte> bytes, capnp::ReaderOptions options,
      kj::ArrayPtr<capnp::word> scratchSpace) {
    auto reader = parseIsolateCapnpRpcFrame(bytes, options, scratchSpace);
    capnp::MessageReaderAndFds result { kj::mv(reader), nullptr };
    return kj::Maybe<capnp::MessageReaderAndFds>(kj::mv(result));
  }

  static kj::Array<byte> serializeMessageSegments(
      kj::ArrayPtr<const kj::ArrayPtr<const capnp::word>> segments) {
    kj::VectorOutputStream output;
    capnp::writeMessage(output, segments);
    auto data = output.getArray();
    auto result = kj::heapArray<byte>(data.size());
    memcpy(result.begin(), data.begin(), data.size());
    return result;
  }

  kj::Promise<void> sendSerialized(kj::Array<byte> data) {
    auto fork = writeQueue.then([this, data = kj::mv(data)]() mutable {
      auto request = outgoing.sendDataRequest();
      request.setMessage(data);
      return request.send().attach(kj::mv(data));
    }).fork();
    writeQueue = fork.addBranch();
    return fork.addBranch();
  }
};

class IsolateBrowserRpcWebSocketStream final:
    public WebSession::WebSocketMessageStream::Server {
public:
  IsolateBrowserRpcWebSocketStream(
      WebSession::WebSocketMessageStream::Client outgoing,
      BrowserIsolateBridge::Client bootstrap)
      : stream(kj::mv(outgoing)),
        network(stream, capnp::rpc::twoparty::Side::SERVER),
        rpcSystem(capnp::makeRpcServer(network, kj::mv(bootstrap))) {}

  ~IsolateBrowserRpcWebSocketStream() noexcept(false) {
    stream.closeIncoming();
  }

  kj::Promise<void> sendText(SendTextContext context) override {
    KJ_FAIL_REQUIRE(
        "browser isolate bridge RPC requires binary WebSocket messages",
        context.getParams().getMessage());
  }

  kj::Promise<void> sendData(SendDataContext context) override {
    return stream.receive(context.getParams().getMessage());
  }

  kj::Promise<void> close(CloseContext context) override {
    (void)context;
    stream.closeIncoming();
    return kj::READY_NOW;
  }

private:
  IsolateBrowserRpcMessageStream stream;
  capnp::TwoPartyVatNetwork network;
  capnp::RpcSystem<capnp::rpc::twoparty::VatId> rpcSystem;
};

kj::Maybe<kj::Array<byte>> loadIsolateBrowserModule(
    IsolateRuntimeConfig& config, kj::StringPtr path) {
  return IsolatePlatformServices::loadBrowserModule(config, path);
}

WebSession::WebSocketMessageStream::Client makeIsolateBrowserRpcStream(
    IsolateRuntimeConfig& config, IsolateRuntimeHost& host,
    kj::StringPtr sessionId, WorkerMainViewSession::Client session,
    WebSession::WebSocketMessageStream::Client outgoing) {
  return kj::heap<IsolateBrowserRpcWebSocketStream>(
      kj::mv(outgoing),
      IsolatePlatformServices::makeBrowserBridge(
          config, host, kj::str(sessionId), kj::mv(session)));
}

BrowserIsolateBridge::Client IsolatePlatformServices::makeBrowserBridge(
    IsolateRuntimeConfig& config, IsolateRuntimeHost& host, kj::String sessionId,
    WorkerMainViewSession::Client session) {
  return kj::heap<BrowserIsolateBridgeImpl>(
      config, host, kj::mv(sessionId), kj::mv(session));
}

kj::Maybe<kj::Array<byte>> IsolatePlatformServices::loadBrowserModule(
    IsolateRuntimeConfig& config, kj::StringPtr path) {
  if (path == "__sandstorm/native-capnp/client.js") {
    return kj::heapArray<byte>(kj::StringPtr(ISOLATE_BROWSER_CLIENT_SOURCE).asBytes());
  }
  KJ_IF_MAYBE(moduleName, browserCapnpEsModuleName(path)) {
    for (auto& module: config.modules) {
      if (module.name == *moduleName) {
        return rewriteBrowserCapnpEsModuleImports(module.content.asPtr());
      }
    }
  }
  return nullptr;
}

IsolateBridge::Client IsolatePlatformServices::makeBridge(
    IsolateRuntimeConfig& config, IsolateRuntimeHost& host) {
  return kj::heap<IsolateBridgeImpl>(config, host);
}

class IsolateStorageImpl final: public IsolateStorage::Server {
public:
  explicit IsolateStorageImpl(kj::StringPtr storageRootPath)
      : storageRoot(openStorageRoot(storageRootPath)) {}

protected:
  kj::Promise<void> put(PutContext context) override {
    auto params = context.getParams();
    auto key = params.getKey();
    auto value = params.getValue();
    requireValidKey(key);
    KJ_REQUIRE(value.size() <= MAX_STORAGE_VALUE_BYTES,
        "isolate storage value exceeds maximum allowed size",
        value.size(), MAX_STORAGE_VALUE_BYTES);
    KJ_REQUIRE(storagePathIsMissingOrRegular(key),
        "storage key is blocked by a non-regular file", key);
    writeStorageFile(key, value.asBytes());
    context.getResults().setBytes(value.size());
    return kj::READY_NOW;
  }

  kj::Promise<void> get(GetContext context) override {
    auto key = context.getParams().getKey();
    requireValidKey(key);
    KJ_IF_MAYBE(fd, openStorageFileIfExists(key)) {
      auto body = readAllBytes(*fd);
      context.getResults().setFound(true);
      context.getResults().setValue(body);
    }
    return kj::READY_NOW;
  }

  kj::Promise<void> stat(StatContext context) override {
    auto key = context.getParams().getKey();
    requireValidKey(key);
    KJ_IF_MAYBE(fd, openStorageFileIfExists(key)) {
      struct stat stats;
      KJ_SYSCALL(fstat(*fd, &stats));
      context.getResults().setFound(true);
      context.getResults().setBytes(stats.st_size);
    }
    return kj::READY_NOW;
  }

  kj::Promise<void> remove(RemoveContext context) override {
    auto key = context.getParams().getKey();
    requireValidKey(key);
    switch (inspectStoragePath(key)) {
      case StoragePathState::MISSING:
        break;
      case StoragePathState::REGULAR:
        KJ_SYSCALL(unlinkat(storageRoot, key.cStr(), 0), key);
        break;
      case StoragePathState::NON_REGULAR:
        KJ_FAIL_REQUIRE("storage key is blocked by a non-regular file", key);
    }
    return kj::READY_NOW;
  }

  kj::Promise<void> list(ListContext context) override {
    auto files = listStorageDirectory();
    struct Entry {
      kj::String name;
      uint64_t bytes;
    };
    kj::Vector<Entry> entries;
    uint64_t totalBytes = 0;
    for (auto& file: files) {
      if (!isValidIsolateStorageKey(file)) continue;
      KJ_IF_MAYBE(fd, openStorageFileIfExists(file)) {
        struct stat stats;
        KJ_SYSCALL(fstat(*fd, &stats));
        auto bytes = static_cast<uint64_t>(stats.st_size);
        totalBytes += bytes;
        entries.add(Entry{kj::mv(file), bytes});
      }
    }

    auto results = context.getResults();
    auto output = results.initEntries(entries.size());
    for (auto i: kj::indices(entries)) {
      output[i].setName(entries[i].name);
      output[i].setBytes(entries[i].bytes);
    }
    results.setTotalBytes(totalBytes);
    return kj::READY_NOW;
  }

private:
  static constexpr size_t MAX_STORAGE_VALUE_BYTES = 1024 * 1024;

  enum class StoragePathState {
    MISSING,
    REGULAR,
    NON_REGULAR,
  };

  kj::AutoCloseFd storageRoot;

  static void requireValidKey(kj::StringPtr key) {
    KJ_REQUIRE(isValidIsolateStorageKey(key), "invalid storage key", key);
  }

  static kj::AutoCloseFd openStorageRoot(kj::StringPtr path) {
    int fd;
    KJ_SYSCALL(fd = open(path.cStr(),
        O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW), path);
    return kj::AutoCloseFd(fd);
  }

  kj::Maybe<kj::AutoCloseFd> openStorageFileIfExists(kj::StringPtr key) {
    int fd = openat(storageRoot, key.cStr(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd == -1) {
      int error = errno;
      if (error == ENOENT || error == ENOTDIR || error == ELOOP) {
        return nullptr;
      }

      KJ_FAIL_SYSCALL("openat", error, key);
    }

    kj::AutoCloseFd result(fd);
    struct stat stats;
    KJ_SYSCALL(fstat(result.get(), &stats), key);
    if (!S_ISREG(stats.st_mode)) {
      return nullptr;
    }

    return kj::mv(result);
  }

  StoragePathState inspectStoragePath(kj::StringPtr key) {
    struct stat stats;
    if (fstatat(storageRoot, key.cStr(), &stats, AT_SYMLINK_NOFOLLOW) != 0) {
      int error = errno;
      if (error == ENOENT || error == ENOTDIR) {
        return StoragePathState::MISSING;
      }

      KJ_FAIL_SYSCALL("fstatat", error, key);
    }

    return S_ISREG(stats.st_mode) ? StoragePathState::REGULAR : StoragePathState::NON_REGULAR;
  }

  bool storagePathIsMissingOrRegular(kj::StringPtr key) {
    return inspectStoragePath(key) != StoragePathState::NON_REGULAR;
  }

  void writeStorageFile(kj::StringPtr key, kj::ArrayPtr<const byte> content) {
    auto tmpName = kj::str(".tmp-", getpid(), "-", key);
    switch (inspectStoragePath(tmpName)) {
      case StoragePathState::MISSING:
        break;
      case StoragePathState::REGULAR:
        KJ_SYSCALL(unlinkat(storageRoot, tmpName.cStr(), 0), tmpName);
        break;
      case StoragePathState::NON_REGULAR:
        KJ_FAIL_REQUIRE("refusing to replace non-regular temporary storage file", tmpName);
    }

    int fd;
    KJ_SYSCALL(fd = openat(storageRoot, tmpName.cStr(),
        O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0660), tmpName);
    kj::AutoCloseFd output(fd);
    writeAllToFd(output, content);
    KJ_SYSCALL(fsync(output), tmpName);
    KJ_SYSCALL(renameat(storageRoot, tmpName.cStr(), storageRoot, key.cStr()), tmpName, key);
    KJ_SYSCALL(fsync(storageRoot));
  }

  kj::Vector<kj::String> listStorageDirectory() {
    int directoryFd;
    KJ_SYSCALL(directoryFd = openat(storageRoot, ".",
        O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW));
    DIR* dir = fdopendir(directoryFd);
    if (dir == nullptr) {
      int error = errno;
      KJ_SYSCALL(close(directoryFd));
      KJ_FAIL_SYSCALL("fdopendir", error);
    }
    KJ_DEFER(KJ_SYSCALL(closedir(dir)) { break; });

    kj::Vector<kj::String> result;
    for (;;) {
      errno = 0;
      auto entry = readdir(dir);
      if (entry == nullptr) {
        int error = errno;
        if (error != 0) KJ_FAIL_SYSCALL("readdir", error);
        break;
      }
      if (strcmp(entry->d_name, ".") != 0 && strcmp(entry->d_name, "..") != 0) {
        result.add(kj::str(entry->d_name));
      }
    }
    return result;
  }
};

IsolateStorage::Client makeIsolateStorage(
    kj::StringPtr storageRootPath) {
  return kj::heap<IsolateStorageImpl>(storageRootPath);
}

class HostedIsolateBindingServices final: public IsolateBindingServices::Server {
public:
  HostedIsolateBindingServices(
      kj::Own<IsolateRuntimeConfig> config, kj::Own<IsolateRuntimeHost> host)
      : config(kj::mv(config)), host(kj::mv(host)) {}

  kj::Promise<void> getBridge(GetBridgeContext context) override {
    context.getResults().setBridge(IsolatePlatformServices::makeBridge(*config, *host));
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

    for (auto& workerExport: runtimeConfig->exports) {
      if (workerExport.role == IsolateRuntimeConfig::Export::Role::MAIN_VIEW) {
        auto exportName = kj::heapString(workerExport.name);
        auto interfaceId = workerExport.interfaceId;
        return runtimeHost->getExport(exportName, interfaceId).then(
            [this, context, exportName = kj::mv(exportName), interfaceId](
                capnp::Capability::Client cap) mutable {
          auto persistent = wrapIsolateWorkerExport(
              kj::addRef(*runtimeConfig), kj::addRef(*runtimeHost),
              exportName, interfaceId, kj::mv(cap));
          context.getResults().setView(persistent.castAs<UiView>());
        });
      }
    }

    KJ_UNIMPLEMENTED("isolate command has no typed mainView export");
  }

  kj::Promise<void> getExport(GetExportContext context) override {
    lifecycle->requireRunning();
    auto params = context.getParams();
    auto name = kj::heapString(params.getName());
    auto interfaceId = params.getInterfaceId();
    return runtimeHost->getExport(params.getName(), params.getInterfaceId()).then(
        [this, context, name = kj::mv(name), interfaceId](
            capnp::Capability::Client cap) mutable {
      context.getResults().setCap(wrapIsolateWorkerExport(
          kj::addRef(*runtimeConfig), kj::addRef(*runtimeHost),
          name, interfaceId, kj::mv(cap)));
    });
  }

  kj::Promise<void> keepAlive(KeepAliveContext context) override {
    lifecycle->requireRunning();

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
    KJ_LOG(INFO, "Reporting isolate grain disk usage.", varPath, bytes);
    auto req = sandstormCore.reportGrainSizeRequest();
    req.setBytes(bytes);
    return req.send().ignoreResult();
  }

  kj::Promise<void> shutdown(ShutdownContext context) override {
    lifecycle->requireRunning();
    KJ_LOG(INFO, "Isolate grain shutdown requested.");
    return lifecycle->shutdown().then([]() -> kj::Promise<void> {
      // Supervisor.shutdown() is specified never to return successfully: traditional
      // per-grain supervisors satisfy that by exiting. Account-hosted isolates must
      // emulate the same RPC contract after removing the grain from the shared host.
      return kj::Promise<void>(
          KJ_EXCEPTION(DISCONNECTED, "isolate grain shut down"));
    });
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
      case SupervisorObjectId<>::APP_REF: {
        for (auto& workerExport: runtimeConfig->exports) {
          if (workerExport.role == IsolateRuntimeConfig::Export::Role::MAIN_VIEW) {
            auto exportName = kj::heapString(workerExport.name);
            auto interfaceId = workerExport.interfaceId;
            return runtimeHost->getExport(exportName, interfaceId).then(
                [this, context, parentToken = kj::mv(parentToken)](
                    capnp::Capability::Client cap) mutable {
              auto request = cap.castAs<MainView<>>().restoreRequest();
              request.setObjectId(context.getParams().getRef().getAppRef());
              return request.send().then(
                  [this, context, parentToken = kj::mv(parentToken)](
                      auto result) mutable {
                context.getResults().setCap(kj::heap<IsolateAppRefCapability>(
                    kj::addRef(*runtimeHost), result.getCap(), kj::mv(parentToken)));
              });
            });
          }
        }
        KJ_FAIL_REQUIRE("isolate command has no typed mainView export for AppPersistent restore");
      }
      case SupervisorObjectId<>::ISOLATE_WORKER_REF: {
        auto workerRef = objectId.getIsolateWorkerRef();
        auto exportName = kj::heapString(workerRef.getExportName());
        auto interfaceId = workerRef.getInterfaceId();
        return runtimeHost->restoreExport(
            exportName, interfaceId, workerRef.getObjectId()).then(
            [this, context, exportName = kj::mv(exportName), interfaceId,
                parentToken = kj::mv(parentToken)](capnp::Capability::Client cap) mutable {
          context.getResults().setCap(kj::heap<IsolateWorkerPersistentCapability>(
              kj::addRef(*runtimeHost), exportName, interfaceId, kj::mv(cap),
              kj::mv(parentToken)));
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
      case SupervisorObjectId<>::APP_REF: {
        for (auto& workerExport: runtimeConfig->exports) {
          if (workerExport.role == IsolateRuntimeConfig::Export::Role::MAIN_VIEW) {
            auto exportName = kj::heapString(workerExport.name);
            auto interfaceId = workerExport.interfaceId;
            return runtimeHost->getExport(exportName, interfaceId).then(
                [context](capnp::Capability::Client cap) mutable {
              auto request = cap.castAs<MainView<>>().dropRequest();
              request.setObjectId(context.getParams().getRef().getAppRef());
              return request.send().ignoreResult();
            });
          }
        }
        KJ_FAIL_REQUIRE("isolate command has no typed mainView export for AppPersistent drop");
      }
      case SupervisorObjectId<>::ISOLATE_WORKER_REF: {
        auto workerRef = objectId.getIsolateWorkerRef();
        return runtimeHost->dropExport(
            workerRef.getExportName(), workerRef.getInterfaceId(), workerRef.getObjectId());
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
  auto workerSource = prepareRuntimeState(varPath, *runtimeConfig);
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
      return existing->addBranch().then(
          [context](Supervisor::Client&& supervisor) mutable {
        context.getResults().setSupervisor(supervisor);
      });
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
    auto mapGrainId = kj::str(grainId);
    auto start = admission.then([this, grainId = kj::mv(grainId), core = kj::mv(core)](
        kj::Own<AccountAdmissionResult> admitted) mutable -> kj::Promise<Supervisor::Client> {
      auto coreRedirector = kj::refcounted<CapRedirector>();
      coreRedirector->setTarget(core);
      SandstormCore::Client coreCap = static_cast<capnp::Capability::Client>(
          kj::addRef(*coreRedirector)).castAs<SandstormCore>();
      auto runtimeHost = kj::refcounted<IsolateRuntimeHost>(
          network, timer, grainId, coreCap, spoolIo);
      runtimeHost->setPlatformBridge(IsolatePlatformServices::makeBridge(
          *admitted->runtimeConfig, *runtimeHost));

      auto nativeStart = nativeHost.startGrainRequest();
      nativeStart.setGrainId(grainId);
      nativeStart.setWorkerSource(admitted->workerSource);
      nativeStart.setServices(kj::heap<HostedIsolateBindingServices>(
          kj::addRef(*admitted->runtimeConfig), kj::addRef(*runtimeHost)));
      return nativeStart.send().then([this, grainId = kj::mv(grainId),
          admitted = kj::mv(admitted), coreRedirector = kj::mv(coreRedirector),
          runtimeHost = kj::mv(runtimeHost),
          coreCap = kj::mv(coreCap)](auto response) mutable -> Supervisor::Client {
        auto hosted = response.getGrain();
        HostedIsolate::Client lifecycleHosted = hosted;
        runtimeHost->setHosted(kj::mv(hosted));
        auto lifecycle = kj::refcounted<HostedSupervisorLifecycle>(
            kj::mv(lifecycleHosted),
            [this, grainId = kj::str(grainId)]() { supervisors.erase(grainId); });
        Supervisor::Client supervisor = kj::heap<IsolateSupervisorImpl>(eventPort,
            admitted->varPath, kj::mv(coreRedirector), kj::mv(admitted->runtimeConfig),
            kj::mv(runtimeHost), kj::mv(lifecycle), kj::mv(coreCap));
        return supervisor;
      });
    }).then([](Supervisor::Client&& supervisor) {
      return kj::mv(supervisor);
    }, [this, grainId = kj::str(mapGrainId)](kj::Exception&& exception)
        -> kj::Promise<Supervisor::Client> {
      supervisors.erase(grainId);
      return kj::mv(exception);
    }).fork();

    // Publish the fork before admission begins. Concurrent callers for this grain join the same
    // startup and cannot race a duplicate nativeHost.startGrain() call.
    auto response = start.addBranch().then(
        [context](Supervisor::Client&& supervisor) mutable {
      context.getResults().setSupervisor(supervisor);
    });
    supervisors.insert(kj::mv(mapGrainId), kj::mv(start));
    return response;
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
  SpoolIoWorker spoolIo;
  AccountAdmissionPool admissionPool;
  kj::HashMap<kj::String, kj::ForkedPromise<Supervisor::Client>> supervisors;
};

}  // namespace

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
  KJ_LOG(INFO, "Account-scoped isolate host listening.", trustDomain, controlSocket,
      nativeHostPath, nativeProcess.getPid());
  server.listen(*listener).exclusiveJoin(nativeRpc.onDisconnect()).wait(io.waitScope);
  return true;
}

}  // namespace sandstorm
