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

constexpr const char* ISOLATE_MAIN_VIEW_REGISTRATION_PATH =
    "/__sandstorm/main-view/register";
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
  kj::String compatibilityDate;
  kj::String appTitle;
  kj::String apiPath;
  bool hasBridgeConfig = false;
  kj::String runtimeStateDir;
  kj::String storageRootPath;
  kj::Own<capnp::MallocMessageBuilder> viewInfoMessage;
  kj::Vector<kj::String> compatibilityFlags;
  kj::Vector<Module> modules;
  kj::Vector<Binding> bindings;
  kj::Vector<Export> exports;
};

struct IsolateMainViewRegistration;

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
        sessions(kj::refcounted<IsolateSessionRegistry>()),
        httpFactory(byteStreamFactory, headerTableBuilder),
        ownedHeaderTable(headerTableBuilder.build()),
        headerTable(*ownedHeaderTable) {}

  void setHosted(HostedIsolate::Client value) { hosted = kj::mv(value); }
  void setPlatformBridge(IsolateBridge::Client value) { platformBridge = kj::mv(value); }

  kj::Promise<kj::Own<kj::HttpClient>> getHttpClient() {
    auto& hostedClient = KJ_REQUIRE_NONNULL(hosted, "hosted isolate ingress is not ready");
    return hostedClient.getHttpServiceRequest().send().then(
        [this](auto response) mutable -> kj::Own<kj::HttpClient> {
      auto service = httpFactory.capnpToKj(response.getService());
      return kj::newHttpClient(*service).attach(kj::mv(service));
    });
  }

  kj::Promise<capnp::Capability::Client> getExport(kj::StringPtr name, uint64_t interfaceId) {
    auto& hostedClient = KJ_REQUIRE_NONNULL(hosted, "hosted isolate ingress is not ready");
    auto request = hostedClient.getExportRequest();
    request.setName(name);
    request.setInterfaceId(interfaceId);
    return request.send().then([](auto response) -> capnp::Capability::Client {
      return response.getCap();
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

  capnp::HttpService::Client exportHttpService(kj::Own<kj::HttpService> service) {
    return httpFactory.kjToCapnp(kj::mv(service));
  }

  kj::Promise<kj::Own<IsolateMainViewRegistration>> openMainViewRegistration();
  kj::Promise<void> registerMainView(
      kj::StringPtr registrationId, MainView<>::Client view);
  void removeMainViewRegistration(
      kj::StringPtr registrationId, IsolateMainViewRegistration& registration);

  kj::Network& network;
  kj::Timer& timer;
  kj::String grainId;
  SandstormCore::Client sandstormCore;
  kj::Maybe<IsolateBridge::Client> platformBridge;
  SpoolIoWorker& spoolIo;
  kj::Own<IsolateSessionRegistry> sessions;
  capnp::ByteStreamFactory byteStreamFactory;
  kj::HttpHeaderTable::Builder headerTableBuilder;
  capnp::HttpOverCapnpFactory httpFactory;
  kj::Own<kj::HttpHeaderTable> ownedHeaderTable;
  kj::HttpHeaderTable& headerTable;
  kj::Maybe<HostedIsolate::Client> hosted;
  std::map<std::string, IsolateMainViewRegistration*> mainViewRegistrations;
  uint64_t nextMainViewRegistrationId = 0;
};

struct IsolateMainViewRegistration final {
  IsolateMainViewRegistration(IsolateRuntimeHost& host, kj::String id)
      : host(host), id(kj::mv(id)) {
    auto ready = kj::newPromiseAndFulfiller<void>();
    readyPromise = kj::mv(ready.promise);
    readyFulfiller = kj::mv(ready.fulfiller);
    auto release = kj::newPromiseAndFulfiller<void>();
    releasePromise = kj::mv(release.promise);
    releaseFulfiller = kj::mv(release.fulfiller);
  }

  ~IsolateMainViewRegistration() noexcept(false) {
    host.removeMainViewRegistration(id, *this);
    KJ_IF_MAYBE(fulfiller, releaseFulfiller) {
      if ((*fulfiller)->isWaiting()) (*fulfiller)->fulfill();
    }
  }

  void start() {
    auto path = kj::str(ISOLATE_MAIN_VIEW_REGISTRATION_PATH,
        "?registrationId=", id);
    httpTask = host.getHttpClient()
        .then([this, path = kj::mv(path)](kj::Own<kj::HttpClient>&& client) mutable {
      kj::HttpHeaders headers(host.headerTable);
      headers.set(kj::HttpHeaderId::HOST, "sandbox");
      auto request = client->request(kj::HttpMethod::POST, path, headers, uint64_t(0));
      auto requestBody = kj::mv(request.body);
      return request.response.then(
          [client = kj::mv(client), requestBody = kj::mv(requestBody)](
              kj::HttpClient::Response&& response) mutable -> kj::Promise<void> {
        KJ_REQUIRE(response.statusCode == 204,
            "MainView native registration request failed",
            response.statusCode, response.statusText);
        if (response.body.get() == nullptr) return kj::Promise<void>(kj::READY_NOW);
        return response.body->readAllBytes(4096).then([](kj::Array<byte>&&) {});
      });
    }).then([this]() {
      KJ_IF_MAYBE(fulfiller, readyFulfiller) {
        if ((*fulfiller)->isWaiting()) {
          (*fulfiller)->reject(KJ_EXCEPTION(DISCONNECTED,
              "MainView registration request ended before publishing a capability"));
        }
      }
    }).eagerlyEvaluate([this](kj::Exception&& exception) {
      KJ_IF_MAYBE(fulfiller, readyFulfiller) {
        if ((*fulfiller)->isWaiting()) (*fulfiller)->reject(kj::mv(exception));
      }
    });
  }

  void publish(MainView<>::Client publishedView) {
    KJ_REQUIRE(view == nullptr, "MainView registration was published more than once", id);
    view = kj::mv(publishedView);
    auto fulfiller = kj::mv(KJ_REQUIRE_NONNULL(readyFulfiller));
    readyFulfiller = nullptr;
    fulfiller->fulfill();
  }

  MainView<>::Client getView() {
    return KJ_REQUIRE_NONNULL(view, "MainView registration has no published capability");
  }

  kj::Promise<void> takeReleasePromise() {
    auto promise = kj::mv(KJ_REQUIRE_NONNULL(releasePromise,
        "MainView registration release promise was already consumed"));
    releasePromise = nullptr;
    return kj::mv(promise);
  }

  IsolateRuntimeHost& host;
  kj::String id;
  kj::Maybe<MainView<>::Client> view;
  kj::Promise<void> readyPromise = nullptr;
  kj::Maybe<kj::Own<kj::PromiseFulfiller<void>>> readyFulfiller;
  kj::Maybe<kj::Promise<void>> releasePromise;
  kj::Maybe<kj::Own<kj::PromiseFulfiller<void>>> releaseFulfiller;
  kj::Promise<void> httpTask = nullptr;
};

kj::Promise<kj::Own<IsolateMainViewRegistration>>
IsolateRuntimeHost::openMainViewRegistration() {
  auto id = kj::str("registration-", ++nextMainViewRegistrationId);
  auto registration = kj::heap<IsolateMainViewRegistration>(*this, kj::mv(id));
  auto inserted = mainViewRegistrations.emplace(
      std::string(registration->id.begin(), registration->id.size()), registration.get());
  KJ_ASSERT(inserted.second);
  registration->start();
  auto ready = kj::mv(registration->readyPromise);
  return ready.then([registration = kj::mv(registration)]() mutable {
    return kj::mv(registration);
  });
}

kj::Promise<void> IsolateRuntimeHost::registerMainView(
    kj::StringPtr registrationId, MainView<>::Client view) {
  auto key = std::string(registrationId.begin(), registrationId.size());
  auto found = mainViewRegistrations.find(key);
  KJ_REQUIRE(found != mainViewRegistrations.end(),
      "unknown or expired MainView registration", registrationId);
  found->second->publish(kj::mv(view));
  return found->second->takeReleasePromise();
}

void IsolateRuntimeHost::removeMainViewRegistration(
    kj::StringPtr registrationId, IsolateMainViewRegistration& registration) {
  auto key = std::string(registrationId.begin(), registrationId.size());
  auto found = mainViewRegistrations.find(key);
  if (found != mainViewRegistrations.end() && found->second == &registration) {
    mainViewRegistrations.erase(found);
  }
}

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
    KJ_REQUIRE(binding.name != "__SANDSTORM_NATIVE_CAPNP",
        "Isolate binding name is reserved by the native runtime.", binding.name);
    if (enforceSharedHostLimits) {
      KJ_REQUIRE(binding.name.size() <= MAX_ISOLATE_NAME_BYTES,
          "Isolate binding name exceeds size limit.", binding.name.size());
      totalBindingBytes += binding.value.size();
      KJ_REQUIRE(totalBindingBytes <= MAX_ISOLATE_TOTAL_BINDING_BYTES,
          "Isolate bindings exceed aggregate size limit.", totalBindingBytes,
          MAX_ISOLATE_TOTAL_BINDING_BYTES);
    }
    if (binding.type == IsolateRuntimeConfig::BindingType::SERVICE) {
      KJ_REQUIRE(binding.serviceName.size() > 0, "Isolate service binding is missing service name.",
          binding.name);
      KJ_REQUIRE(binding.serviceName == "main",
          "Isolate service bindings may only target the worker-local main service.",
          binding.name, binding.serviceName);
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

kj::Own<IsolateRuntimeConfig> copyIsolateConfig(
    spk::Manifest::IsolateConfig::Reader config, kj::StringPtr pkgPath,
    bool enforceSharedHostLimits) {
  auto result = kj::refcounted<IsolateRuntimeConfig>();
  result->mainModule = kj::heapString(config.getMainModule());
  result->compatibilityDate = kj::heapString(config.getCompatibilityDate());
  result->hasBridgeConfig = config.hasBridgeConfig();
  if (result->hasBridgeConfig) {
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
  } else {
    result->apiPath = kj::str("");
    result->viewInfoMessage = kj::heap<capnp::MallocMessageBuilder>();
    result->viewInfoMessage->initRoot<UiView::ViewInfo>();
    result->appTitle = kj::str("");
  }
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

  validateIsolateRuntimeConfig(*result, enforceSharedHostLimits);
  return result;
}

kj::StringPtr appTitleOrDefault(IsolateRuntimeConfig& config) {
  return config.appTitle.size() > 0 ? config.appTitle.asPtr() : kj::StringPtr("Isolate grain");
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
    if (binding.serviceName.size() > 0) {
      manifest.addAll(kj::StringPtr(", "));
      appendJsonField(manifest, "serviceName", binding.serviceName);
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
  source.setFormatVersion(config.exports.size() == 0 ? 1 : 2);
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

constexpr uint64_t MAX_RUNTIME_REQUEST_BYTES = 64 * 1024 * 1024;
constexpr uint64_t MAX_RUNTIME_RESPONSE_BYTES = 64 * 1024 * 1024;
constexpr uint64_t MAX_NATIVE_CAPNP_RPC_WEBSOCKET_MESSAGE_BYTES =
    MAX_RUNTIME_REQUEST_BYTES + 1024 * 1024;
constexpr uint64_t MAX_API_BINDING_REQUEST_BYTES = 1024 * 1024;
constexpr uint64_t RUNTIME_RESPONSE_STREAM_THRESHOLD_BYTES = 64 * 1024;
constexpr uint64_t RUNTIME_STREAM_PUMP_CHUNK_BYTES = 1024 * 1024;

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

  auto chunkSize = static_cast<size_t>(
      kj::min(RUNTIME_STREAM_PUMP_CHUNK_BYTES, maxBytes - bytesPumped));
  auto req = stream.writeRequest(capnp::MessageSize {
      chunkSize / sizeof(capnp::word) + 16, 0 });
  auto orphanage = capnp::Orphanage::getForMessageContaining(
      kj::implicitCast<ByteStream::WriteParams::Builder>(req));
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

class IsolateWebSocketEntropySource final: public kj::EntropySource {
public:
  void generate(kj::ArrayPtr<byte> buffer) override {
    randombytes_buf(buffer.begin(), buffer.size());
  }
};

class IsolateWebSocketBridgeState final: public kj::Refcounted,
                                         private kj::TaskSet::ErrorHandler {
public:
  IsolateWebSocketBridgeState(kj::Own<kj::WebSocket> runtimeWebSocket,
      WebSession::WebSocketStream::Client callerStream)
      : pipe(kj::refcounted<WebSessionWebSocketPipe>(kj::mv(callerStream))),
        incoming(pipe->getIncomingStreamCapability()),
        runtimeWebSocket(kj::mv(runtimeWebSocket)),
        callerWebSocket(kj::newWebSocket(kj::addRef(*pipe), entropySource)),
        tasks(*this) {
    tasks.add(this->runtimeWebSocket->pumpTo(*callerWebSocket)
        .then([this]() { closing = true; }));
    tasks.add(callerWebSocket->pumpTo(*this->runtimeWebSocket)
        .then([this]() { closing = true; }));
  }

  WebSession::WebSocketStream::Client getIncoming() { return incoming; }

private:
  static IsolateWebSocketEntropySource entropySource;
  kj::Own<WebSessionWebSocketPipe> pipe;
  WebSession::WebSocketStream::Client incoming;
  kj::Own<kj::WebSocket> runtimeWebSocket;
  kj::Own<kj::WebSocket> callerWebSocket;
  kj::TaskSet tasks;
  bool closing = false;

  void taskFailed(kj::Exception&& exception) override {
    if (!closing && exception.getType() != kj::Exception::Type::DISCONNECTED) {
      KJ_LOG(WARNING, "Isolate WebSession WebSocket bridge failed.", exception);
    }
  }
};

IsolateWebSocketEntropySource IsolateWebSocketBridgeState::entropySource;

class IsolateWebSocketBridge final: public WebSession::WebSocketStream::Server {
public:
  explicit IsolateWebSocketBridge(kj::Own<IsolateWebSocketBridgeState> state)
      : incoming(state->getIncoming()), state(kj::mv(state)) {}

protected:
  kj::Promise<void> sendBytes(SendBytesContext context) override {
    auto request = incoming.sendBytesRequest();
    request.setMessage(context.getParams().getMessage());
    return request.send();
  }

private:
  WebSession::WebSocketStream::Client incoming;
  kj::Own<IsolateWebSocketBridgeState> state;
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
  KJ_REQUIRE(content.getContent().size() <= MAX_RUNTIME_REQUEST_BYTES,
      "buffered isolate request body exceeds maximum allowed size",
      content.getContent().size(), MAX_RUNTIME_REQUEST_BYTES);
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

bool shouldStreamRuntimeResponse(uint statusCode, kj::Vector<FetchHeader>& headers) {
  if (!isFetchContentStatus(statusCode)) {
    return false;
  }

  KJ_IF_MAYBE(contentLength, findFetchResponseHeader(headers, "content-length")) {
    KJ_IF_MAYBE(size, parseUInt64(*contentLength, 10)) {
      return *size > RUNTIME_RESPONSE_STREAM_THRESHOLD_BYTES;
    }
  }

  // If workerd did not provide a usable Content-Length, preserve streaming semantics rather than
  // buffering an arbitrarily large or intentionally streaming response.
  return true;
}

kj::Maybe<uint64_t> getRuntimeResponseContentLength(kj::Vector<FetchHeader>& headers) {
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
    KJ_LOG(INFO, "Starting isolate response body stream.");
    tasks.add(kj::evalLater([this]() {
      return pumpAtMost(*this->bodyStream, this->responseStream, MAX_RUNTIME_RESPONSE_BYTES,
          "streaming isolate response body exceeds maximum allowed size");
    }));
  }

  ~FetchResponseStreamHandle() noexcept(false) {
    KJ_LOG(INFO, "Destroying isolate response body stream handle.");
  }

  kj::Promise<void> ping(PingContext context) override {
    return kj::READY_NOW;
  }

private:
  // Must be declared before bodyStream so the stream is destroyed before the runtime HTTP state.
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

class HostedWorkerClient final {
public:
  HostedWorkerClient(kj::Own<IsolateRuntimeConfig> config, kj::Own<IsolateRuntimeHost> host)
      : config(kj::mv(config)), host(kj::mv(host)) {}

  kj::Promise<FetchResponse> fetch(FetchRequest&& request) {
    return fetchFromRuntime(kj::mv(request)).catch_(
        [this](kj::Exception&& exception) mutable {
      return fetchRuntimeError(kj::mv(exception));
    });
  }

  kj::Promise<void> openWebSocket(FetchRequest&& request,
      WebSession::WebSocketStream::Client clientStream,
      WebSession::OpenWebSocketResults::Builder results) {
    return openWebSocketFromRuntime(kj::mv(request), kj::mv(clientStream), results);
  }

  kj::Own<WebSession::RequestStream::Server> startRequestStream(
      FetchRequest&& request, ByteStream::Client responseStream);

private:
  class StreamingRequestImpl;

  struct RuntimeHttpState final: public FetchResponseBodyAnchor, public kj::Refcounted {
    kj::Own<kj::HttpClient> client;
    kj::Own<kj::AsyncOutputStream> requestBody;
    kj::Promise<kj::HttpClient::Response> response = nullptr;
    kj::Maybe<kj::Own<kj::AsyncInputStream>> responseBody;

    explicit RuntimeHttpState(kj::Own<kj::HttpClient> client): client(kj::mv(client)) {}
  };

  kj::Own<IsolateRuntimeConfig> config;
  kj::Own<IsolateRuntimeHost> host;

  FetchResponse fetchRuntimeError(kj::Exception&& exception) {
    KJ_LOG(WARNING, "Isolate runtime request failed.", exception);

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

  static kj::Promise<FetchResponse> readRuntimeResponse(
      kj::HttpClient::Response&& response, kj::Own<RuntimeHttpState> state) {
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

    if (shouldStreamRuntimeResponse(result.statusCode, result.headers)) {
      KJ_IF_MAYBE(size, getRuntimeResponseContentLength(result.headers)) {
        KJ_REQUIRE(*size <= MAX_RUNTIME_RESPONSE_BYTES,
            "streaming isolate response declared size exceeds maximum allowed size",
            *size, MAX_RUNTIME_RESPONSE_BYTES);
      }
      result.bodyStreamAnchor = kj::mv(state);
      result.bodyStream = kj::mv(response.body);
      KJ_LOG(INFO, "Isolate runtime streaming response received.",
          result.statusCode, result.mimeType);
      return kj::mv(result);
    }

    state->responseBody = kj::mv(response.body);
    auto& body = KJ_ASSERT_NONNULL(state->responseBody);
    return readAllBytesAtMost(*body, MAX_RUNTIME_RESPONSE_BYTES,
        "buffered isolate response body exceeds maximum allowed size")
        .then([result = kj::mv(result), state = kj::mv(state)](kj::Array<byte>&& body) mutable {
      result.body = kj::mv(body);
      KJ_LOG(INFO, "Isolate runtime response received.",
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
        KJ_REQUIRE(*size <= MAX_RUNTIME_REQUEST_BYTES,
            "streaming isolate request expected size exceeds maximum allowed size",
            *size, MAX_RUNTIME_REQUEST_BYTES);
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
      KJ_REQUIRE(bytesReceived <= MAX_RUNTIME_REQUEST_BYTES,
          "streaming isolate request body exceeds maximum allowed size",
          bytesReceived, MAX_RUNTIME_REQUEST_BYTES);
      KJ_IF_MAYBE(size, expectedSize) {
        KJ_REQUIRE(bytesReceived <= *size, "received more bytes than expected");
      }

      auto promise = writeQueue.then([this, data = kj::mv(data)]() mutable -> kj::Promise<void> {
        KJ_IF_MAYBE(file, spoolFile) {
          return host->spoolIo.write(kj::atomicAddRef(**file), kj::mv(data));
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
      auto promise = writeQueue.then([this]() -> kj::Promise<void> {
        KJ_IF_MAYBE(file, spoolFile) {
          return host->spoolIo.sync(kj::atomicAddRef(**file)).then([this]() {
            finishUpload();
          });
        } else {
          auto& current = KJ_ASSERT_NONNULL(state);
          current->requestBody = nullptr;
          finishUpload();
          return kj::READY_NOW;
        }
      });
      auto fork = promise.fork();
      writeQueue = fork.addBranch();
      return fork.addBranch();
    }

    kj::Promise<void> expectSize(ExpectSizeContext context) override {
      auto size = bytesReceived + context.getParams().getSize();
      KJ_REQUIRE(size <= MAX_RUNTIME_REQUEST_BYTES,
          "streaming isolate request expected size exceeds maximum allowed size",
          size, MAX_RUNTIME_REQUEST_BYTES);
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
          return readRuntimeResponse(kj::mv(response), kj::mv(responseState))
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
    kj::Maybe<kj::Own<RuntimeHttpState>> state;
    kj::Maybe<kj::Own<SpoolFile>> spoolFile;
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
        spoolFile = kj::atomicRefcounted<SpoolFile>(
            openTemporary(kj::str(config->runtimeStateDir, "/upload-spool")));
        return kj::READY_NOW;
      }

      return host->getHttpClient()
          .then([this](kj::Own<kj::HttpClient>&& client) mutable {
        auto newState = kj::refcounted<RuntimeHttpState>(kj::mv(client));
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
      auto& file = KJ_ASSERT_NONNULL(spoolFile);
      return host->spoolIo.rewind(kj::atomicAddRef(*file)).then(
          [this]() {
        return host->getHttpClient();
      }).then([this, results, responseStream = kj::mv(responseStream)](
              kj::Own<kj::HttpClient>&& client) mutable {
        auto state = kj::refcounted<RuntimeHttpState>(kj::mv(client));
        kj::HttpHeaders headers(host->headerTable);
        copyHeadersToHttp(request, headers);

        auto httpRequest = state->client->request(
            toHttpMethod(request.method), request.path, headers, bytesReceived);
        auto response = kj::mv(httpRequest.response);

        if (httpRequest.body.get() != nullptr && bytesReceived > 0) {
          auto requestBody = kj::mv(httpRequest.body);
          auto& file = KJ_ASSERT_NONNULL(spoolFile);
          return writeSpoolToAsync(
                  kj::atomicAddRef(*file), *requestBody, bytesReceived)
              .attach(kj::mv(requestBody))
              .then([response = kj::mv(response)]() mutable {
            return kj::mv(response);
          }).then([this, results, state = kj::mv(state),
              responseStream = kj::mv(responseStream)](
              kj::HttpClient::Response&& response) mutable {
            return finishResponse(
                kj::mv(response), kj::mv(state), results, kj::mv(responseStream));
          });
        }

        return response.then([this, results, state = kj::mv(state),
            responseStream = kj::mv(responseStream)](
            kj::HttpClient::Response&& response) mutable {
          return finishResponse(
              kj::mv(response), kj::mv(state), results, kj::mv(responseStream));
        });
      });
    }

    kj::Promise<void> writeSpoolToAsync(
        kj::Own<SpoolFile> file, kj::AsyncOutputStream& output, uint64_t remaining) {
      if (remaining == 0) {
        return kj::READY_NOW;
      }

      auto maxBytes = static_cast<size_t>(kj::min(remaining, uint64_t(8192)));
      return host->spoolIo.read(kj::atomicAddRef(*file), maxBytes).then(
          [this, file = kj::mv(file), &output, remaining](kj::Array<byte> buffer) mutable {
        KJ_REQUIRE(buffer.size() > 0,
            "spooled isolate upload ended before expected byte count");
        auto written = buffer.size();
        return output.write(buffer.begin(), buffer.size())
            .attach(kj::mv(buffer))
            .then([this, file = kj::mv(file), &output, remaining, written]() mutable {
          return writeSpoolToAsync(kj::mv(file), output, remaining - written);
        });
      });
    }

    void finishUpload() {
      KJ_IF_MAYBE(fulfiller, doneFulfiller) {
        (*fulfiller)->fulfill();
      }
      doneFulfiller = nullptr;
    }

    kj::Promise<void> finishResponse(
        kj::HttpClient::Response response,
        kj::Own<RuntimeHttpState> state,
        WebSession::Response::Builder results,
        ByteStream::Client responseStream) {
      return readRuntimeResponse(kj::mv(response), kj::mv(state))
          .then([results, responseStream = kj::mv(responseStream)](
              FetchResponse&& fetchResponse) mutable {
        writeFetchResponse(kj::mv(fetchResponse), results, kj::mv(responseStream));
      });
    }
  };

  kj::Promise<FetchResponse> fetchFromRuntime(FetchRequest&& request) {
    KJ_LOG(INFO, "Forwarding isolate request to runtime.",
        fetchMethodName(request.method), request.path, request.body.size());
    return host->getHttpClient()
        .then([this, request = kj::mv(request)](kj::Own<kj::HttpClient>&& client) mutable {
      auto state = kj::refcounted<RuntimeHttpState>(kj::mv(client));
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
          return readRuntimeResponse(kj::mv(response), kj::mv(state));
        });
      }

      return response.then([state = kj::mv(state)](
          kj::HttpClient::Response&& response) mutable {
        return readRuntimeResponse(kj::mv(response), kj::mv(state));
      });
    });
  }

  kj::Promise<void> openWebSocketFromRuntime(FetchRequest&& request,
      WebSession::WebSocketStream::Client clientStream,
      WebSession::OpenWebSocketResults::Builder results) {
    KJ_LOG(INFO, "Forwarding isolate WebSocket request to runtime.", request.path);
    return host->getHttpClient()
        .then([this, request = kj::mv(request), clientStream = kj::mv(clientStream), results](
            kj::Own<kj::HttpClient>&& client) mutable -> kj::Promise<void> {
      kj::HttpHeaders headers(host->headerTable);
      copyHeadersToHttp(request, headers);
      return client->openWebSocket(request.path, headers)
          .then([client = kj::mv(client), clientStream = kj::mv(clientStream), results](
              kj::HttpClient::WebSocketResponse&& response) mutable -> kj::Promise<void> {
        if (response.statusCode != 101) {
          auto statusCode = response.statusCode;
          auto statusText = kj::str(response.statusText);
          KJ_SWITCH_ONEOF(response.webSocketOrBody) {
            KJ_CASE_ONEOF(body, kj::Own<kj::AsyncInputStream>) {
              return body->readAllText()
                  .attach(kj::mv(body), kj::mv(client))
                  .then([statusCode, statusText = kj::mv(statusText)](kj::String bodyText) {
                KJ_FAIL_REQUIRE("Isolate runtime rejected WebSocket upgrade",
                    statusCode, statusText, bodyText);
              });
            }
            KJ_CASE_ONEOF(webSocket, kj::Own<kj::WebSocket>) {
              (void)webSocket;
              KJ_FAIL_REQUIRE("Isolate runtime rejected WebSocket upgrade",
                  statusCode, statusText);
            }
          }
        }

        kj::Vector<kj::String> protocols;
        if (response.headers != nullptr) {
          response.headers->forEach([&](kj::StringPtr name, kj::StringPtr value) {
            auto normalizedName = kj::str(name);
            toLower(normalizedName);
            if (normalizedName == "sec-websocket-protocol") {
              for (auto part: split(value, ',')) {
                auto protocol = trim(part);
                if (protocol.size() > 0) protocols.add(kj::mv(protocol));
              }
            }
          });
        }
        auto protocolList = results.initProtocol(protocols.size());
        for (auto i: kj::indices(protocols)) protocolList.set(i, protocols[i]);

        KJ_SWITCH_ONEOF(response.webSocketOrBody) {
          KJ_CASE_ONEOF(body, kj::Own<kj::AsyncInputStream>) {
            (void)body;
            KJ_FAIL_REQUIRE("Isolate runtime did not upgrade WebSocket");
          }
          KJ_CASE_ONEOF(webSocket, kj::Own<kj::WebSocket>) {
            auto state = kj::refcounted<IsolateWebSocketBridgeState>(
                kj::mv(webSocket).attach(kj::mv(client)), kj::mv(clientStream));
            results.setServerStream(kj::heap<IsolateWebSocketBridge>(kj::mv(state)));
            return kj::READY_NOW;
          }
        }
        KJ_UNREACHABLE;
      });
    });
  }

};

kj::Own<WebSession::RequestStream::Server> HostedWorkerClient::startRequestStream(
    FetchRequest&& request, ByteStream::Client responseStream) {
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
        runtime(kj::heap<HostedWorkerClient>(kj::mv(config), kj::mv(host))) {}

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
    KJ_LOG(INFO, "Handling isolate WebSession WebSocket request.",
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
  kj::Own<HostedWorkerClient> runtime;

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
    KJ_LOG(INFO, "Handling isolate WebSession request.",
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

class IsolateMainViewRestoredCapability final: public SystemPersistent::Server {
public:
  IsolateMainViewRestoredCapability(kj::Own<IsolateRuntimeHost> host,
      kj::Own<IsolateMainViewRegistration> registration, capnp::Capability::Client cap,
      kj::Maybe<kj::Array<const byte>> parentToken = nullptr,
      kj::Own<PersistentRequirementState> requirementState =
          kj::refcounted<PersistentRequirementState>())
      : host(kj::mv(host)),
        registration(kj::mv(registration)),
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
  kj::Own<IsolateMainViewRegistration> registration;
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
          "Use SandstormApi.save() instead.");
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
          kj::refcounted<PersistentRequirementState>())
      : host(kj::mv(host)),
        exportName(kj::heapString(exportName)),
        interfaceId(interfaceId),
        appCap(nullptr),
        cap(nullptr),
        parentToken(kj::mv(parentToken)),
        requirementState(kj::mv(requirementState)) {
    appCap = cap;
    this->cap = capnp::membrane(kj::mv(cap), kj::refcounted<IsolateWorkerMembranePolicy>(
        kj::addRef(*this->host), this->exportName, this->interfaceId,
        kj::addRef(*this->requirementState)));
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
    kj::StringPtr sessionId, WebSession::WebSocketMessageStream::Client outgoing);

kj::Maybe<kj::StringPtr> isolateBrowserModulePath(kj::StringPtr path) {
  if (path.startsWith("/")) {
    path = path.slice(1);
  }

  const kj::StringPtr capnpPrefix = "__sandstorm/capnp/";
  if (path.startsWith(capnpPrefix)) {
    return path.slice(capnpPrefix.size());
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
  const kj::StringPtr prefix = "__sandstorm/native-capnp/rpc-session?";
  return path.startsWith(prefix) && path.slice(prefix.size()).startsWith("connectionId=");
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
      kj::Own<IsolateDirectSessionState> state, WebSession::Client inner)
      : config(kj::mv(config)), host(kj::mv(host)), state(kj::mv(state)),
        inner(kj::mv(inner)) {}

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
          *config, *host, state->getId(), params.getClientStream()));
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
  WebSession::Client inner;
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
      MainView<>::Client inner)
      : config(kj::mv(config)), host(kj::mv(host)), inner(kj::mv(inner)) {}

  kj::Promise<void> getViewInfo(GetViewInfoContext context) override {
    return inner.getViewInfoRequest().send().then([context](auto response) mutable {
      context.setResults(response);
    });
  }

  kj::Promise<void> newSession(NewSessionContext context) override {
    auto params = context.getParams();
    auto id = host->sessions->registerSession(params.getContext());
    auto state = kj::refcounted<IsolateDirectSessionState>(kj::addRef(*host), kj::mv(id));
    auto request = inner.newSessionRequest();
    copyCommonSessionParams(params, request, *state);
    return finishSession(
        request.send(), context, kj::mv(state), params.getSessionType());
  }

  kj::Promise<void> newRequestSession(NewRequestSessionContext context) override {
    auto params = context.getParams();
    auto id = host->sessions->registerSession(params.getContext());
    auto state = kj::refcounted<IsolateDirectSessionState>(kj::addRef(*host), kj::mv(id));
    auto request = inner.newRequestSessionRequest();
    copyCommonSessionParams(params, request, *state);
    request.setRequestInfo(params.getRequestInfo());
    return finishSession(
        request.send(), context, kj::mv(state), params.getSessionType());
  }

  kj::Promise<void> newOfferSession(NewOfferSessionContext context) override {
    auto params = context.getParams();
    auto id = host->sessions->registerOfferSession(params.getContext(), params.getOffer());
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
                protectedSession.template castAs<WebSession>()))
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
  if (interfaceId == capnp::typeId<MainView<>>()) {
    cap = kj::heap<IsolateDirectMainView>(
        kj::addRef(*config), kj::addRef(*host), kj::mv(cap).castAs<MainView<>>());
  }
  return kj::heap<IsolateWorkerPersistentCapability>(
      kj::mv(host), exportName, interfaceId, kj::mv(cap));
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

IsolateStorage::Client makeIsolateStorage(
    kj::HttpHeaderTable& headerTable, kj::StringPtr storageRootPath);

class SandstormApiBindingService final: public kj::HttpService {
public:
  SandstormApiBindingService(
      kj::HttpHeaderTable& headerTable, IsolateRuntimeConfig& config, IsolateRuntimeHost& host,
      bool powerboxOnly = false)
      : headerTable(headerTable), config(config), host(host), powerboxOnly(powerboxOnly) {}

  static IsolateBridge::Client makeBridge(
      IsolateRuntimeConfig& config, IsolateRuntimeHost& host);

  static BrowserIsolateBridge::Client makeBrowserBridge(
      IsolateRuntimeConfig& config, IsolateRuntimeHost& host, kj::String sessionId);

  static kj::Maybe<kj::Array<byte>> loadBrowserModule(
      IsolateRuntimeConfig& config, kj::StringPtr path);

  kj::Promise<void> request(
      kj::HttpMethod method, kj::StringPtr url, const kj::HttpHeaders& headers,
      kj::AsyncInputStream& requestBody, kj::HttpService::Response& response) override {
    auto methodName = kj::str(method);
    auto path = kj::heapString(url);
    auto route = kj::heapString(urlPath(url));
    KJ_LOG(INFO, "Isolate Sandstorm API binding received request.", methodName, path);

    if (!powerboxOnly && methodName == "GET" && route == "/capnp/rpc-session") {
      return openBrowserNativeCapnpBridgeRpcSession(path, headers, response);
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

    kj::Promise<void> registerMainView(RegisterMainViewContext context) override {
      auto params = context.getParams();
      KJ_REQUIRE(params.hasView(), "Cannot register a null MainView capability.");
      return host.registerMainView(params.getRegistrationId(), params.getView());
    }

    kj::Promise<void> getStorage(GetStorageContext context) override {
      context.getResults().setStorage(
          makeIsolateStorage(host.headerTable, config.storageRootPath));
      return kj::READY_NOW;
    }

    kj::Promise<void> getViewInfo(GetViewInfoContext context) override {
      context.getResults().setViewInfo(
          config.viewInfoMessage->getRoot<UiView::ViewInfo>().asReader());
      return kj::READY_NOW;
    }

    kj::Promise<void> getRuntimeStatus(GetRuntimeStatusContext context) override {
      context.getResults().setMainModule(config.mainModule);
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

  kj::Promise<void> openBrowserNativeCapnpBridgeRpcSession(
      kj::StringPtr url, const kj::HttpHeaders& requestHeaders,
      kj::HttpService::Response& response) {
    if (!requestHeaders.isWebSocket()) {
      return sendJson(response, 426, "Upgrade Required", kj::heapString(
          "{\n  \"ok\": false,\n"
          "  \"error\": \"native Cap'n Proto RPC sessions require WebSocket upgrade\"\n}\n"));
    }

    if (findIsolateQueryParams(url, "bootstrap").size() > 0) {
      return sendJson(response, 400, "Bad Request", renderError(
          "browser Cap'n Proto RPC sessions do not accept a bootstrap mode"));
    }

    return openBrowserIsolateBridgeBootstrapRpcSession(url, requestHeaders, response);
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
      appendJsonField(json, "status", "ready");
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
    KJ_REQUIRE(message.size() <= MAX_NATIVE_CAPNP_RPC_WEBSOCKET_MESSAGE_BYTES,
        "browser isolate bridge RPC message exceeds maximum allowed size",
        message.size(), MAX_NATIVE_CAPNP_RPC_WEBSOCKET_MESSAGE_BYTES);

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
  return SandstormApiBindingService::loadBrowserModule(config, path);
}

WebSession::WebSocketMessageStream::Client makeIsolateBrowserRpcStream(
    IsolateRuntimeConfig& config, IsolateRuntimeHost& host,
    kj::StringPtr sessionId, WebSession::WebSocketMessageStream::Client outgoing) {
  return kj::heap<IsolateBrowserRpcWebSocketStream>(
      kj::mv(outgoing),
      SandstormApiBindingService::makeBrowserBridge(config, host, kj::str(sessionId)));
}

BrowserIsolateBridge::Client SandstormApiBindingService::makeBrowserBridge(
    IsolateRuntimeConfig& config, IsolateRuntimeHost& host, kj::String sessionId) {
  return kj::heap<BrowserIsolateBridgeImpl>(config, host, kj::mv(sessionId));
}

kj::Maybe<kj::Array<byte>> SandstormApiBindingService::loadBrowserModule(
    IsolateRuntimeConfig& config, kj::StringPtr path) {
  KJ_IF_MAYBE(moduleName, browserCapnpEsModuleName(path)) {
    for (auto& module: config.modules) {
      if (module.name == *moduleName) {
        return rewriteBrowserCapnpEsModuleImports(module.content.asPtr());
      }
    }
  }
  return nullptr;
}

IsolateBridge::Client SandstormApiBindingService::makeBridge(
    IsolateRuntimeConfig& config, IsolateRuntimeHost& host) {
  return kj::heap<IsolateBridgeImpl>(config, host);
}

class StorageBindingService final: public kj::HttpService, public IsolateStorage::Server {
public:
  StorageBindingService(kj::HttpHeaderTable& headerTable, kj::StringPtr storageRootPath)
      : headerTable(headerTable), storageRoot(openStorageRoot(storageRootPath)) {}

  kj::Promise<void> request(
      kj::HttpMethod method, kj::StringPtr url, const kj::HttpHeaders& headers,
      kj::AsyncInputStream& requestBody, kj::HttpService::Response& response) override {
    (void)headers;
    auto key = isolateStorageKeyFromUrl(url);
    KJ_LOG(INFO, "Isolate storage binding received request.", kj::str(method), key);

    if (method == kj::HttpMethod::GET && key.size() == 0) {
      return sendJson(response, 200, "OK", renderIndex());
    }

    if (!isValidIsolateStorageKey(key)) {
      return sendJson(response, 400, "Bad Request", kj::heapString(
          "{\n  \"ok\": false,\n  \"error\": \"invalid storage key\"\n}\n"));
    }

    switch (method) {
      case kj::HttpMethod::GET:
        return get(kj::mv(key), response);
      case kj::HttpMethod::HEAD:
        return head(kj::mv(key), response);
      case kj::HttpMethod::PUT:
        return requestBody.readAllBytes(MAX_STORAGE_VALUE_BYTES + 2)
            .then([this, key = kj::mv(key), &response]
                (kj::Array<byte>&& body) mutable {
          if (body.size() > MAX_STORAGE_VALUE_BYTES) {
            return sendJson(response, 413, "Payload Too Large", kj::str(
                "{\n  \"ok\": false,\n"
                "  \"error\": \"isolate storage value exceeds maximum allowed size\",\n"
                "  \"maxBytes\": ", MAX_STORAGE_VALUE_BYTES, "\n}\n"));
          }

          if (!storagePathIsMissingOrRegular(key)) {
            return sendJson(response, 409, "Conflict", kj::heapString(
                "{\n  \"ok\": false,\n"
                "  \"error\": \"storage key is blocked by a non-regular file\"\n}\n"));
          }

          writeStorageFile(key, body);
          return sendJson(response, 200, "OK", renderStored(body.size()));
        });
      case kj::HttpMethod::DELETE:
        return deleteStorageFile(kj::mv(key), response);
      default:
        return sendJson(response, 405, "Method Not Allowed", kj::heapString(
            "{\n  \"ok\": false,\n  \"error\": \"method not allowed\"\n}\n"));
    }
  }

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

  kj::HttpHeaderTable& headerTable;
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

  kj::Promise<void> sendJson(kj::HttpService::Response& response, uint statusCode,
      kj::StringPtr statusText, kj::String body) {
    kj::HttpHeaders responseHeaders(headerTable);
    responseHeaders.set(kj::HttpHeaderId::CONTENT_TYPE, "application/json; charset=utf-8");
    auto stream = response.send(statusCode, statusText, responseHeaders, body.size());
    auto promise = stream->write(body.begin(), body.size());
    return promise.attach(kj::mv(stream), kj::mv(body));
  }

  kj::Promise<void> get(kj::String key, kj::HttpService::Response& response) {
    KJ_IF_MAYBE(fd, openStorageFileIfExists(key)) {
      auto body = readAllBytes(*fd);
      kj::HttpHeaders responseHeaders(headerTable);
      responseHeaders.set(kj::HttpHeaderId::CONTENT_TYPE, "application/octet-stream");
      auto stream = response.send(200, "OK", responseHeaders, body.size());
      auto promise = stream->write(body.begin(), body.size());
      return promise.attach(kj::mv(stream), kj::mv(body), kj::mv(key));
    }

    return sendJson(response, 404, "Not Found", kj::heapString(
        "{\n  \"ok\": false,\n  \"error\": \"storage key not found\"\n}\n"));
  }

  kj::Promise<void> head(kj::String key, kj::HttpService::Response& response) {
    KJ_IF_MAYBE(fd, openStorageFileIfExists(key)) {
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

  kj::Promise<void> deleteStorageFile(kj::String key, kj::HttpService::Response& response) {
    switch (inspectStoragePath(key)) {
      case StoragePathState::MISSING:
        return sendJson(response, 200, "OK", kj::heapString("{\n  \"ok\": true\n}\n"));
      case StoragePathState::REGULAR:
        KJ_SYSCALL(unlinkat(storageRoot, key.cStr(), 0), key);
        return sendJson(response, 200, "OK", kj::heapString("{\n  \"ok\": true\n}\n"));
      case StoragePathState::NON_REGULAR:
        return sendJson(response, 409, "Conflict", kj::heapString(
            "{\n  \"ok\": false,\n"
            "  \"error\": \"storage key is blocked by a non-regular file\"\n}\n"));
    }

    KJ_UNREACHABLE;
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

  kj::String renderStored(size_t bytes) {
    return kj::str("{\n  \"ok\": true,\n  \"bytes\": ", bytes, "\n}\n");
  }

  kj::String renderIndex() {
    auto files = listStorageDirectory();
    kj::Vector<char> json;
    json.addAll(kj::StringPtr("{\n  \"ok\": true,\n  \"keys\": ["));
    uint64_t totalBytes = 0;
    bool first = true;
    for (auto& file: files) {
      if (!isValidIsolateStorageKey(file)) {
        continue;
      }

      KJ_IF_MAYBE(fd, openStorageFileIfExists(file)) {
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
    kj::HttpHeaderTable& headerTable, kj::StringPtr storageRootPath) {
  return kj::heap<StorageBindingService>(headerTable, storageRootPath);
}

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
        service = kj::heap<StorageBindingService>(host->headerTable, config->storageRootPath);
        break;
      case IsolateBindingServices::Binding::POWERBOX:
        service = kj::heap<SandstormApiBindingService>(host->headerTable, *config, *host, true);
        break;
    }
    context.getResults().setService(host->exportHttpService(kj::mv(service)));
    return kj::READY_NOW;
  }

  kj::Promise<void> getBridge(GetBridgeContext context) override {
    context.getResults().setBridge(SandstormApiBindingService::makeBridge(*config, *host));
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

    if (!runtimeConfig->hasBridgeConfig) {
      KJ_UNIMPLEMENTED(
          "isolate command has neither a mainView export nor legacy bridgeConfig");
    }

    context.getResults().setView(kj::heap<IsolateUiViewImpl>(
        kj::addRef(*runtimeConfig), kj::addRef(*runtimeHost)));
    return kj::READY_NOW;
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
        return runtimeHost->openMainViewRegistration().then(
            [this, context, parentToken = kj::mv(parentToken)](
                kj::Own<IsolateMainViewRegistration>&& registration) mutable {
          auto request = registration->getView().restoreRequest();
          request.setObjectId(context.getParams().getRef().getAppRef());
          return request.send().then(
              [this, context, registration = kj::mv(registration),
                  parentToken = kj::mv(parentToken)](auto result) mutable {
            context.getResults().setCap(kj::heap<IsolateMainViewRestoredCapability>(
                kj::addRef(*runtimeHost), kj::mv(registration), result.getCap(),
                kj::mv(parentToken)));
          });
        });
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
      case SupervisorObjectId<>::ROUTE_BACKED_SESSION:
        return kj::READY_NOW;
      case SupervisorObjectId<>::APP_REF: {
        return runtimeHost->openMainViewRegistration().then(
            [context](
                kj::Own<IsolateMainViewRegistration>&& registration) mutable {
          auto request = registration->getView().dropRequest();
          request.setObjectId(context.getParams().getRef().getAppRef());
          return request.send().ignoreResult().attach(kj::mv(registration));
        });
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
      runtimeHost->setPlatformBridge(SandstormApiBindingService::makeBridge(
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
