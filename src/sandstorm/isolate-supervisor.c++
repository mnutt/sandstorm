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
#include <sandstorm/isolate/rpc.js.h>

#include <capnp/message.h>
#include <capnp/compat/json.h>
#include <capnp/rpc-twoparty.h>
#include <capnp/schema.h>
#include <capnp/serialize.h>
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
#include <sandstorm/isolate-supervisor-internal.capnp.h>
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

namespace sandstorm {

namespace {

constexpr const char* ISOLATE_WEBS_SESSION_TOKEN_PREFIX = "sandstorm-isolate-websession:";

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
    PUBLIC_FETCH,
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
  kj::String savedCapabilityDir;
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

  kj::String storeClaimedCapability(capnp::Capability::Client cap) {
    for (;;) {
      auto id = makeOpaqueToken();
      if (findClaimedCapabilityIndex(id) == nullptr) {
        claimedCapabilities.add(ClaimedCapabilityRecord { kj::heapString(id), cap });
        return id;
      }
    }
  }

  bool dropClaimedCapability(kj::StringPtr id) {
    KJ_IF_MAYBE(index, findClaimedCapabilityIndex(id)) {
      if (*index + 1 < claimedCapabilities.size()) {
        claimedCapabilities[*index] = kj::mv(claimedCapabilities.back());
      }
      claimedCapabilities.removeLast();
      return true;
    }

    return false;
  }

  kj::Maybe<capnp::Capability::Client> findClaimedCapability(kj::StringPtr id) {
    KJ_IF_MAYBE(index, findClaimedCapabilityIndex(id)) {
      return claimedCapabilities[*index].cap;
    }

    return nullptr;
  }

private:
  struct SessionRecord {
    kj::String id;
    SessionContext::Client context;
  };

  struct ClaimedCapabilityRecord {
    kj::String id;
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
    case spk::Manifest::IsolateConfig::Binding::PUBLIC_FETCH:
      return IsolateRuntimeConfig::BindingType::PUBLIC_FETCH;
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
    case IsolateRuntimeConfig::BindingType::PUBLIC_FETCH:
      return "publicFetch";
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
    case IsolateRuntimeConfig::BindingType::PUBLIC_FETCH:
      return false;
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
    case spk::Manifest::IsolateConfig::Binding::PUBLIC_FETCH:
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
    case IsolateRuntimeConfig::BindingType::PUBLIC_FETCH:
      return false;
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
    case IsolateRuntimeConfig::BindingType::PUBLIC_FETCH:
      KJ_UNREACHABLE;
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
  auto savedCapabilityDir = kj::str(varPath, "/isolate-capabilities");
  config.sandstormApiSocketPath = kj::heapString(sandstormApiSocketPath);
  config.powerboxSocketPath = kj::heapString(powerboxSocketPath);
  config.storageSocketPath = kj::heapString(storageSocketPath);
  config.storageRootPath = kj::heapString(storageRootPath);
  config.savedCapabilityDir = kj::heapString(savedCapabilityDir);
  ensureDirectory(bundleDir);
  ensureDirectory(modulesDir);
  ensureDirectory(bindingsDir);
  ensureDirectory(storageRootPath);
  ensureDirectory(savedCapabilityDir);

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

  auto cookies = context.getCookies();
  if (cookies.size() > 0) {
    kj::Vector<char> value;
    for (auto cookie: cookies) {
      if (value.size() > 0) {
        value.addAll(kj::StringPtr("; "));
      }
      value.addAll(cookie.getKey());
      value.add('=');
      value.addAll(cookie.getValue());
    }
    value.add('\0');
    addHeader(request, "cookie", kj::String(value.releaseAsArray()));
  }
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
    if (!isStructuredIsolateResponseHeader(header.name) &&
        responseHeaderWhitelist.matches(header.name)) {
      ++count;
    }
  }

  auto outputHeaders = builder.initAdditionalHeaders(count);
  size_t j = 0;
  for (auto i: kj::indices(headers)) {
    if (!isStructuredIsolateResponseHeader(headers[i].name) &&
        responseHeaderWhitelist.matches(headers[i].name)) {
      outputHeaders[j].setName(headers[i].name);
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
      return pump(*this->bodyStream, this->responseStream);
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

class IsolateWebSessionImpl final: public IsolateWebSession::Server {
public:
  IsolateWebSessionImpl(
      kj::Own<IsolateRuntimeConfig> config, kj::Own<IsolateRuntimeHost> host,
      kj::StringPtr pathPrefix = "", SessionKind sessionKind = SessionKind::NORMAL,
      SessionMetadata&& sessionMetadata = SessionMetadata(), bool persistent = true)
      : pathPrefix(kj::heapString(pathPrefix)),
        sessionKind(sessionKind),
        sessionMetadata(kj::mv(sessionMetadata)),
        persistent(persistent),
        runtimeConfig(kj::addRef(*config)),
        runtimeHost(kj::addRef(*host)),
        runtime(kj::heap<WorkerdRuntimeAdapter>(kj::mv(config), kj::mv(host))) {}

  ~IsolateWebSessionImpl() noexcept(false) {
    if (sessionMetadata.sessionId.size() > 0) {
      runtimeHost->sessions->unregisterSession(sessionMetadata.sessionId);
    }
  }

  kj::Promise<void> get(GetContext context) override {
    auto params = context.getParams();
    auto method = params.getIgnoreBody() ? FetchMethod::HEAD : FetchMethod::GET;
    auto request = makeFetchRequest(method, prefixedPath(params.getPath()), params.getContext());
    return fetch(kj::mv(request), context.getResults(), params.getContext().getResponseStream());
  }

  kj::Promise<void> post(PostContext context) override {
    auto params = context.getParams();
    auto request = makeFetchRequest(FetchMethod::POST, prefixedPath(params.getPath()),
        params.getContext());
    setFetchRequestBody(request, params.getContent());
    return fetch(kj::mv(request), context.getResults(), params.getContext().getResponseStream());
  }

  kj::Promise<void> postStreaming(PostStreamingContext context) override {
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

  kj::Promise<void> put(PutContext context) override {
    auto params = context.getParams();
    auto request = makeFetchRequest(FetchMethod::PUT, prefixedPath(params.getPath()),
        params.getContext());
    setFetchRequestBody(request, params.getContent());
    return fetch(kj::mv(request), context.getResults(), params.getContext().getResponseStream());
  }

  kj::Promise<void> putStreaming(PutStreamingContext context) override {
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

  kj::Promise<void> delete_(DeleteContext context) override {
    auto params = context.getParams();
    auto request = makeFetchRequest(FetchMethod::DELETE_, prefixedPath(params.getPath()),
        params.getContext());
    return fetch(kj::mv(request), context.getResults(), params.getContext().getResponseStream());
  }

  kj::Promise<void> patch(PatchContext context) override {
    auto params = context.getParams();
    auto request = makeFetchRequest(FetchMethod::PATCH, prefixedPath(params.getPath()),
        params.getContext());
    setFetchRequestBody(request, params.getContent());
    return fetch(kj::mv(request), context.getResults(), params.getContext().getResponseStream());
  }

  kj::Promise<void> options(OptionsContext context) override {
    return kj::READY_NOW;
  }

  kj::Promise<void> addRequirements(AddRequirementsContext context) override {
    context.getResults().setCap(thisCap().castAs<SystemPersistent>());
    return kj::READY_NOW;
  }

  kj::Promise<void> save(SaveContext context) override {
    KJ_REQUIRE(persistent, "isolate WebSession capability is not persistent");
    auto token = makeOpaqueToken();
    writeFile(kj::str(runtimeConfig->savedCapabilityDir, "/", token), pathPrefix.asBytes());
    auto sturdyRef = kj::str(ISOLATE_WEBS_SESSION_TOKEN_PREFIX, token);
    context.getResults().setSturdyRef(sturdyRef.asBytes());
    return kj::READY_NOW;
  }

private:
  kj::String pathPrefix;
  SessionKind sessionKind;
  SessionMetadata sessionMetadata;
  bool persistent;
  kj::Own<IsolateRuntimeConfig> runtimeConfig;
  kj::Own<IsolateRuntimeHost> runtimeHost;
  kj::Own<IsolateRuntimeAdapter> runtime;

  kj::String prefixedPath(kj::StringPtr path) {
    if (pathPrefix.size() == 0) {
      return kj::heapString(path);
    } else if (path.size() == 0) {
      return kj::heapString(pathPrefix);
    } else if (pathPrefix[pathPrefix.size() - 1] == '/' && path[0] == '/') {
      return kj::str(pathPrefix.slice(0, pathPrefix.size() - 1), path);
    } else if (pathPrefix[pathPrefix.size() - 1] != '/' && path[0] != '/') {
      return kj::str(pathPrefix, "/", path);
    } else {
      return kj::str(pathPrefix, path);
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
    context.getResults().setSession(
        kj::heap<IsolateWebSessionImpl>(
            kj::addRef(*runtimeConfig), kj::addRef(*runtimeHost), pathPrefix, SessionKind::NORMAL,
            kj::mv(sessionMetadata)));
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
    context.getResults().setSession(kj::heap<IsolateWebSessionImpl>(
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
        params.getOffer());
    context.getResults().setSession(kj::heap<IsolateWebSessionImpl>(
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

void bindSidecarFile(kj::StringPtr src, unsigned long flags) {
  if (access(src.cStr(), F_OK) != 0) {
    int error = errno;
    if (error == ENOENT || error == ENOTDIR) {
      return;
    }
    KJ_FAIL_SYSCALL("access", error, src);
  }

  auto dst = sidecarRootPath(src);
  recursivelyCreateParent(dst);
  KJ_SYSCALL(mknod(dst.cStr(), S_IFREG | 0644, 0), dst);
  sidecarBind(src, dst, flags);
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
  bindSidecarFile(trustedWorkerd, MS_RDONLY | MS_NOSUID | MS_NODEV);

  bindSidecarDirectory("/lib", MS_RDONLY | MS_NOSUID | MS_NODEV);
  bindSidecarDirectory("/lib64", MS_RDONLY | MS_NOSUID | MS_NODEV);
  bindSidecarDirectory("/usr/lib", MS_RDONLY | MS_NOSUID | MS_NODEV);
  bindSidecarDirectory("/usr/lib64", MS_RDONLY | MS_NOSUID | MS_NODEV);
  bindSidecarDirectory("/workerd", MS_RDONLY | MS_NOSUID | MS_NODEV);
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
      KJ_LOG(WARNING,
          "Could not enter privileged isolate sidecar namespaces; continuing with seccomp only.",
          error, strerror(error));
      return false;
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
    KJ_LOG(WARNING, "Could not enter isolate sidecar namespaces; continuing with seccomp only.",
        error, strerror(error));
    return false;
  }

  sandbox::hideUserGroupIds(realUid, realGid, false);
  finishSidecarNamespaceSetup();
  KJ_LOG(WARNING, "Isolate sidecar entered private user/network/mount/ipc/uts namespaces.");
  return true;
}

void setupSidecarSeccomp(bool logSeccompViolations) {
  scmp_filter_ctx ctx = seccomp_init(SCMP_ACT_ALLOW);
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
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(ptrace), 0));

  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EAFNOSUPPORT), SCMP_SYS(socket), 1,
      SCMP_A0(SCMP_CMP_GE, AF_NETLINK + 1)));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EAFNOSUPPORT), SCMP_SYS(socket), 1,
      SCMP_A0(SCMP_CMP_EQ, AF_AX25)));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EAFNOSUPPORT), SCMP_SYS(socket), 1,
      SCMP_A0(SCMP_CMP_EQ, AF_IPX)));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EAFNOSUPPORT), SCMP_SYS(socket), 1,
      SCMP_A0(SCMP_CMP_EQ, AF_APPLETALK)));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EAFNOSUPPORT), SCMP_SYS(socket), 1,
      SCMP_A0(SCMP_CMP_EQ, AF_NETROM)));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EAFNOSUPPORT), SCMP_SYS(socket), 1,
      SCMP_A0(SCMP_CMP_EQ, AF_BRIDGE)));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EAFNOSUPPORT), SCMP_SYS(socket), 1,
      SCMP_A0(SCMP_CMP_EQ, AF_ATMPVC)));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EAFNOSUPPORT), SCMP_SYS(socket), 1,
      SCMP_A0(SCMP_CMP_EQ, AF_X25)));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EAFNOSUPPORT), SCMP_SYS(socket), 1,
      SCMP_A0(SCMP_CMP_EQ, AF_ROSE)));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EAFNOSUPPORT), SCMP_SYS(socket), 1,
      SCMP_A0(SCMP_CMP_EQ, AF_DECnet)));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EAFNOSUPPORT), SCMP_SYS(socket), 1,
      SCMP_A0(SCMP_CMP_EQ, AF_NETBEUI)));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EAFNOSUPPORT), SCMP_SYS(socket), 1,
      SCMP_A0(SCMP_CMP_EQ, AF_SECURITY)));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EAFNOSUPPORT), SCMP_SYS(socket), 1,
      SCMP_A0(SCMP_CMP_EQ, AF_KEY)));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPROTONOSUPPORT), SCMP_SYS(socket), 1,
      SCMP_A1(SCMP_CMP_MASKED_EQ, 0x0f, SOCK_DCCP)));

  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(add_key), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(request_key), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(keyctl), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(syslog), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(uselib), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(personality), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(acct), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(modify_ldt), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(set_thread_area), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(unshare), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(mount), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(pivot_root), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(quotactl), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(clone), 1,
      SCMP_A0(SCMP_CMP_MASKED_EQ, CLONE_NEWUSER, CLONE_NEWUSER)));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(io_setup), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(io_destroy), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(io_getevents), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(io_submit), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(io_cancel), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(remap_file_pages), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(mbind), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(get_mempolicy), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(set_mempolicy), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(migrate_pages), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(move_pages), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(vmsplice), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(set_robust_list), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(get_robust_list), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(perf_event_open), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EINVAL), SCMP_SYS(prctl), 1,
      SCMP_A0(SCMP_CMP_EQ, PR_SET_SECCOMP)));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(seccomp), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(bpf), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(userfaultfd), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(io_pgetevents), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(rseq), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(pkey_mprotect), 0));

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
    KJ_LOG(WARNING, "Isolate Sandstorm API binding received request.", methodName, path);

    return readAllBytesAtMost(requestBody, 1024 * 1024,
        "isolate Sandstorm API binding request body exceeds maximum allowed size").then(
        [this, methodName = kj::mv(methodName), path = kj::mv(path), route = kj::mv(route),
            contentType = kj::mv(contentType), &response]
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
      } else if (methodName == "POST" && route == "/powerbox/drop-saved") {
        return dropSavedPowerboxCapability(path, response);
      } else if (methodName == "POST" && route == "/powerbox/drop") {
        return dropPowerboxCapability(path, response);
      } else if (methodName == "POST" && route == "/powerbox/fetch") {
        return fetchClaimedCapability(path, contentType, kj::mv(bodyBytes), response);
      } else if (methodName == "POST" && route == "/powerbox/offer") {
        return offerClaimedCapability(path, response);
      } else if (methodName == "POST" && route == "/powerbox/fulfill-request") {
        return fulfillRequestWithCapability(path, response);
      } else if (methodName == "POST" && route == "/powerbox/tie-to-user") {
        return tieClaimedCapabilityToUser(path, response);
      } else if (methodName == "POST" && route == "/capabilities/web-session") {
        return createWebSessionCapability(path, response);
      }

      if (methodName != "GET") {
        return sendJson(response, 405, "Method Not Allowed", kj::heapString(
            "{\n  \"ok\": false,\n  \"error\": \"method not allowed\"\n}\n"));
      }

      if (route == "/" || route == "/status") {
        return sendJson(response, 200, "OK", renderStatus(methodName, path, bodyBytes.size()));
      } else if (route == "/capabilities") {
        return sendJson(response, 200, "OK", renderCapabilities());
      } else if (route == "/runtime") {
        return sendJson(response, 200, "OK", renderRuntime());
      } else if (route == "/modules") {
        return sendJson(response, 200, "OK", renderModules());
      } else if (route == "/bindings") {
        return sendJson(response, 200, "OK", renderBindings());
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

  class BufferedByteStream final: public ByteStream::Server {
  public:
    BufferedByteStream() {
      auto paf = kj::newPromiseAndFulfiller<kj::Array<byte>>();
      donePromise = kj::mv(paf.promise);
      doneFulfiller = kj::mv(paf.fulfiller);
    }

    ~BufferedByteStream() noexcept(false) {
      KJ_IF_MAYBE(fulfiller, doneFulfiller) {
        if ((*fulfiller)->isWaiting()) {
          (*fulfiller)->reject(KJ_EXCEPTION(DISCONNECTED,
              "claimed capability response stream ended before done()"));
        }
      }
    }

    kj::Promise<void> write(WriteContext context) override {
      auto data = context.getParams().getData();
      bytes += data.size();
      KJ_REQUIRE(bytes <= MAX_SIDECAR_RESPONSE_BYTES,
          "claimed capability response body exceeds maximum allowed size",
          bytes, MAX_SIDECAR_RESPONSE_BYTES);
      body.addAll(data);
      return kj::READY_NOW;
    }

    kj::Promise<void> done(DoneContext context) override {
      (void)context;
      KJ_IF_MAYBE(fulfiller, doneFulfiller) {
        (*fulfiller)->fulfill(body.releaseAsArray());
        doneFulfiller = nullptr;
      }
      return kj::READY_NOW;
    }

    kj::Promise<kj::Array<byte>> consumeDonePromise() {
      return kj::mv(donePromise);
    }

  private:
    kj::Vector<byte> body;
    uint64_t bytes = 0;
    kj::Promise<kj::Array<byte>> donePromise = nullptr;
    kj::Maybe<kj::Own<kj::PromiseFulfiller<kj::Array<byte>>>> doneFulfiller;
  };

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
        "  \"capabilities\": [\"status\", \"capabilities\", \"runtime\", \"modules\", \"bindings\", "
        "\"powerbox.claimRequest\", \"powerbox.save\", \"powerbox.restore\", "
        "\"powerbox.dropSaved\", \"powerbox.drop\", \"powerbox.fetch\", "
        "\"powerbox.offer\", \"powerbox.fulfillRequest\", \"powerbox.tieToUser\", "
        "\"capabilities.webSession\"]\n"
        "}\n");
  }

  kj::String normalizeCapabilityFetchPath(kj::StringPtr path) {
    KJ_REQUIRE(path.size() <= 8192, "claimed capability fetch path is too long");
    for (size_t i = 0; i + 2 < path.size(); ++i) {
      KJ_REQUIRE(!(path[i] == ':' && path[i + 1] == '/' && path[i + 2] == '/'),
          "claimed capability fetch path must be path-relative");
    }
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
      if (c == '\r' || c == '\n' || c == '\0') {
        return false;
      }
    }

    return true;
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

  kj::String normalizeWebSessionPathPrefix(kj::StringPtr pathPrefix) {
    KJ_REQUIRE(pathPrefix.size() <= 1024, "web session capability pathPrefix is too long");
    for (size_t i = 0; i + 2 < pathPrefix.size(); ++i) {
      KJ_REQUIRE(!(pathPrefix[i] == ':' && pathPrefix[i + 1] == '/' && pathPrefix[i + 2] == '/'),
          "web session capability pathPrefix must be path-relative");
    }
    KJ_REQUIRE(pathPrefix.size() == 0 || pathPrefix[0] == '/',
        "web session capability pathPrefix must be empty or start with '/'");
    return kj::heapString(pathPrefix);
  }

  kj::Promise<void> createWebSessionCapability(
      kj::StringPtr url, kj::HttpService::Response& response) {
    auto pathPrefixes = findIsolateQueryParams(url, "pathPrefix");
    auto persistentParams = findIsolateQueryParams(url, "persistent");
    if (pathPrefixes.size() > 1 || persistentParams.size() > 1) {
      return sendJson(response, 400, "Bad Request", kj::heapString(
          "{\n  \"ok\": false,\n"
          "  \"error\": \"expected at most one pathPrefix and persistent flag\"\n}\n"));
    }

    auto pathPrefix = pathPrefixes.size() == 1
        ? normalizeWebSessionPathPrefix(pathPrefixes[0])
        : kj::heapString("");
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
    auto cap = kj::heap<IsolateWebSessionImpl>(
        kj::addRef(config), kj::addRef(host), pathPrefix, SessionKind::NORMAL, SessionMetadata(),
        persistent);
    auto capId = host.sessions->storeClaimedCapability(kj::mv(cap));
    return sendJson(response, 200, "OK", renderClaimedCapability(capId));
  }

  kj::Promise<void> fetchClaimedCapability(
      kj::StringPtr url, kj::StringPtr contentType, kj::Array<byte> bodyBytes,
      kj::HttpService::Response& response) {
    auto ids = findIsolateQueryParams(url, "id");
    auto methods = findIsolateQueryParams(url, "method");
    auto paths = findIsolateQueryParams(url, "path");
    auto contextParams = getCapabilityFetchContextParams(url);
    if (ids.size() != 1 || ids[0].size() == 0 ||
        methods.size() != 1 || methods[0].size() == 0 ||
        paths.size() != 1) {
      return sendJson(response, 400, "Bad Request", kj::heapString(
          "{\n  \"ok\": false,\n"
          "  \"error\": \"expected exactly one capability id, method, and path\"\n}\n"));
    }

    KJ_IF_MAYBE(cap, host.sessions->findClaimedCapability(ids[0])) {
      auto webSession = cap->castAs<WebSession>();
      auto responseStreamServer = kj::heap<BufferedByteStream>();
      auto streamDone = responseStreamServer->consumeDonePromise();

      auto method = kj::heapString(methods[0]);
      toLower(method);
      auto path = normalizeCapabilityFetchPath(paths[0]);

      if (method == "get" || method == "head") {
        auto request = webSession.getRequest();
        request.setPath(path);
        request.setIgnoreBody(method == "head");
        initCapabilityFetchContext(
            request.initContext(), kj::mv(responseStreamServer), contextParams);
        auto sendNotModified = shouldSendNotModifiedForPrecondition(contextParams);
        return request.send()
            .then([this, &response, streamDone = kj::mv(streamDone), sendNotModified]
                (auto result) mutable {
          return sendWebSessionHttpResponse(
              kj::mv(result), response, kj::mv(streamDone), sendNotModified);
        }).catch_([this, &response](kj::Exception&& exception) mutable {
          return sendJson(response, 502, "Bad Gateway", renderError(
              kj::str("claimed capability fetch failed: ", exception.getDescription())));
        });
      } else if (method == "post") {
        auto request = webSession.postRequest();
        request.setPath(path);
        initPostContent(request.initContent(), contentType, bodyBytes);
        initCapabilityFetchContext(
            request.initContext(), kj::mv(responseStreamServer), contextParams);
        auto sendNotModified = shouldSendNotModifiedForPrecondition(contextParams);
        return request.send()
            .then([this, &response, streamDone = kj::mv(streamDone), sendNotModified]
                (auto result) mutable {
          return sendWebSessionHttpResponse(
              kj::mv(result), response, kj::mv(streamDone), sendNotModified);
        }).catch_([this, &response](kj::Exception&& exception) mutable {
          return sendJson(response, 502, "Bad Gateway", renderError(
              kj::str("claimed capability fetch failed: ", exception.getDescription())));
        });
      } else if (method == "put") {
        auto request = webSession.putRequest();
        request.setPath(path);
        initPutContent(request.initContent(), contentType, bodyBytes);
        initCapabilityFetchContext(
            request.initContext(), kj::mv(responseStreamServer), contextParams);
        auto sendNotModified = shouldSendNotModifiedForPrecondition(contextParams);
        return request.send()
            .then([this, &response, streamDone = kj::mv(streamDone), sendNotModified]
                (auto result) mutable {
          return sendWebSessionHttpResponse(
              kj::mv(result), response, kj::mv(streamDone), sendNotModified);
        }).catch_([this, &response](kj::Exception&& exception) mutable {
          return sendJson(response, 502, "Bad Gateway", renderError(
              kj::str("claimed capability fetch failed: ", exception.getDescription())));
        });
      } else if (method == "patch") {
        auto request = webSession.patchRequest();
        request.setPath(path);
        initPostContent(request.initContent(), contentType, bodyBytes);
        initCapabilityFetchContext(
            request.initContext(), kj::mv(responseStreamServer), contextParams);
        auto sendNotModified = shouldSendNotModifiedForPrecondition(contextParams);
        return request.send()
            .then([this, &response, streamDone = kj::mv(streamDone), sendNotModified]
                (auto result) mutable {
          return sendWebSessionHttpResponse(
              kj::mv(result), response, kj::mv(streamDone), sendNotModified);
        }).catch_([this, &response](kj::Exception&& exception) mutable {
          return sendJson(response, 502, "Bad Gateway", renderError(
              kj::str("claimed capability fetch failed: ", exception.getDescription())));
        });
      } else if (method == "delete") {
        auto request = webSession.deleteRequest();
        request.setPath(path);
        initCapabilityFetchContext(
            request.initContext(), kj::mv(responseStreamServer), contextParams);
        auto sendNotModified = shouldSendNotModifiedForPrecondition(contextParams);
        return request.send()
            .then([this, &response, streamDone = kj::mv(streamDone), sendNotModified]
                (auto result) mutable {
          return sendWebSessionHttpResponse(
              kj::mv(result), response, kj::mv(streamDone), sendNotModified);
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

  void initCapabilityFetchContext(
      WebSession::Context::Builder context, kj::Own<BufferedByteStream> responseStream,
      CapabilityFetchContextParams& contextParams) {
    context.initCookies(0);
    context.setResponseStream(kj::mv(responseStream));
    context.initAccept(0);
    context.initAcceptEncoding(0);
    initCapabilityFetchETagPrecondition(context, contextParams);
    auto additionalHeaders = contextParams.additionalHeaders.asPtr();
    auto headers = context.initAdditionalHeaders(additionalHeaders.size());
    for (auto i: kj::indices(additionalHeaders)) {
      headers[i].setName(additionalHeaders[i].name);
      headers[i].setValue(additionalHeaders[i].value);
    }
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
      kj::Promise<kj::Array<byte>> streamDone, bool sendNotModifiedForPrecondition) {
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
          case WebSession::Response::Content::Body::STREAM:
            return streamDone.then(
                [this, &response, statusCode, headers = kj::mv(headers),
                    webResponse = kj::mv(webResponse)]
                (kj::Array<byte>&& bytes) mutable {
              return sendBytes(response, statusCode, "OK", kj::mv(headers), kj::mv(bytes));
            });
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
        if (sendNotModifiedForPrecondition) {
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

  kj::Promise<void> claimPowerboxRequest(
      kj::StringPtr url, kj::HttpService::Response& response) {
    auto sessionIds = findIsolateQueryParams(url, "sessionId");
    auto tokens = findIsolateQueryParams(url, "token");
    if (sessionIds.size() != 1 || tokens.size() != 1 ||
        sessionIds[0].size() == 0 || tokens[0].size() == 0) {
      return sendJson(response, 400, "Bad Request", kj::heapString(
          "{\n  \"ok\": false,\n  \"error\": \"expected exactly one sessionId and token\"\n}\n"));
    }

    auto viewInfo = config.viewInfoMessage->getRoot<UiView::ViewInfo>().asReader();
    auto permissionDefs = viewInfo.getPermissions();
    auto permissionNames = findIsolateQueryParams(url, "requiredPermission");
    for (auto& name: permissionNames) {
      if (name.size() == 0) {
        return sendJson(response, 400, "Bad Request",
            renderError("missing required permission name"));
      }
    }

    KJ_IF_MAYBE(sessionContext, host.sessions->findSessionContext(sessionIds[0])) {
      auto request = sessionContext->claimRequestRequest();
      request.setRequestToken(tokens[0]);
      auto requiredPermissions = request.initRequiredPermissions(permissionDefs.size());
      for (auto& name: permissionNames) {
        KJ_IF_MAYBE(error, setRequiredPermission(name, requiredPermissions, permissionDefs)) {
          return sendJson(response, 400, "Bad Request", renderError(*error));
        }
      }
      return request.send().then(
          [this, &response](auto result) mutable {
        auto capId = host.sessions->storeClaimedCapability(result.getCap());
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

    return kj::str("unknown required permission: ", name);
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

  kj::Maybe<kj::Array<byte>> decodeSavedCapabilityToken(kj::StringPtr token) {
    if (token.size() == 0 || token.size() > 4096 || token.size() % 4 == 1) {
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

  bool isOpaqueSavedCapabilityToken(kj::StringPtr token) {
    if (token.size() == 0 || token.size() > 128) {
      return false;
    }

    for (char c: token) {
      if (!((c >= 'a' && c <= 'z') ||
            (c >= 'A' && c <= 'Z') ||
            (c >= '0' && c <= '9') ||
            c == '-' || c == '_')) {
        return false;
      }
    }

    return true;
  }

  kj::Maybe<kj::String> readIsolateWebSessionSavedToken(kj::ArrayPtr<const byte> token) {
    auto text = kj::StringPtr(token.asChars().begin(), token.size());
    auto prefix = kj::StringPtr(ISOLATE_WEBS_SESSION_TOKEN_PREFIX);
    if (!text.startsWith(prefix)) {
      return nullptr;
    }

    auto tokenName = kj::StringPtr(text.begin() + prefix.size(), text.size() - prefix.size());
    KJ_REQUIRE(isOpaqueSavedCapabilityToken(tokenName), "invalid isolate WebSession saved token");
    return normalizeWebSessionPathPrefix(readAll(kj::str(config.savedCapabilityDir, "/", tokenName)));
  }

  bool dropIsolateWebSessionSavedToken(kj::ArrayPtr<const byte> token) {
    auto text = kj::StringPtr(token.asChars().begin(), token.size());
    auto prefix = kj::StringPtr(ISOLATE_WEBS_SESSION_TOKEN_PREFIX);
    if (!text.startsWith(prefix)) {
      return false;
    }

    auto tokenName = kj::StringPtr(text.begin() + prefix.size(), text.size() - prefix.size());
    KJ_REQUIRE(isOpaqueSavedCapabilityToken(tokenName), "invalid isolate WebSession saved token");
    unlinkIfExists(kj::str(config.savedCapabilityDir, "/", tokenName));
    return true;
  }

  kj::Promise<void> offerClaimedCapability(
      kj::StringPtr url, kj::HttpService::Response& response) {
    auto sessionIds = findIsolateQueryParams(url, "sessionId");
    auto ids = findIsolateQueryParams(url, "id");
    auto titles = findIsolateQueryParams(url, "title");
    if (sessionIds.size() != 1 || sessionIds[0].size() == 0 ||
        ids.size() != 1 || ids[0].size() == 0 ||
        titles.size() > 1) {
      return sendJson(response, 400, "Bad Request", kj::heapString(
          "{\n  \"ok\": false,\n"
          "  \"error\": \"expected exactly one sessionId and capability id\"\n}\n"));
    }

    KJ_IF_MAYBE(sessionContext, host.sessions->findSessionContext(sessionIds[0])) {
      KJ_IF_MAYBE(cap, host.sessions->findClaimedCapability(ids[0])) {
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
    auto sessionIds = findIsolateQueryParams(url, "sessionId");
    auto ids = findIsolateQueryParams(url, "id");
    auto titles = findIsolateQueryParams(url, "title");
    if (sessionIds.size() != 1 || sessionIds[0].size() == 0 ||
        ids.size() != 1 || ids[0].size() == 0 ||
        titles.size() > 1) {
      return sendJson(response, 400, "Bad Request", kj::heapString(
          "{\n  \"ok\": false,\n"
          "  \"error\": \"expected exactly one sessionId and capability id\"\n}\n"));
    }

    KJ_IF_MAYBE(sessionContext, host.sessions->findSessionContext(sessionIds[0])) {
      KJ_IF_MAYBE(cap, host.sessions->findClaimedCapability(ids[0])) {
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
    auto sessionIds = findIsolateQueryParams(url, "sessionId");
    auto ids = findIsolateQueryParams(url, "id");
    auto titles = findIsolateQueryParams(url, "title");
    if (sessionIds.size() != 1 || sessionIds[0].size() == 0 ||
        ids.size() != 1 || ids[0].size() == 0 ||
        titles.size() > 1) {
      return sendJson(response, 400, "Bad Request", kj::heapString(
          "{\n  \"ok\": false,\n"
          "  \"error\": \"expected exactly one sessionId and capability id\"\n}\n"));
    }

    KJ_IF_MAYBE(sessionContext, host.sessions->findSessionContext(sessionIds[0])) {
      KJ_IF_MAYBE(cap, host.sessions->findClaimedCapability(ids[0])) {
        auto request = sessionContext->tieToUserRequest();
        request.setCap(*cap);
        auto viewInfo = config.viewInfoMessage->getRoot<UiView::ViewInfo>().asReader();
        initSessionActionParams(url, titles,
            request.initRequiredPermissions(viewInfo.getPermissions().size()),
            request.initDisplayInfo());
        return request.send().then([this, &response](auto result) mutable {
          auto capId = host.sessions->storeClaimedCapability(result.getTiedCap());
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
  }

  void initSessionActionParamsWithDescriptor(kj::StringPtr url, kj::ArrayPtr<kj::String> titles,
      capnp::List<bool>::Builder requiredPermissions,
      PowerboxDescriptor::Builder descriptor, PowerboxDisplayInfo::Builder displayInfo) {
    initSessionActionParams(url, titles, requiredPermissions, displayInfo);
    descriptor.initTags(0);
  }

  kj::Promise<void> savePowerboxCapability(
      kj::StringPtr url, kj::HttpService::Response& response) {
    auto ids = findIsolateQueryParams(url, "id");
    auto labels = findIsolateQueryParams(url, "label");
    if (ids.size() != 1 || ids[0].size() == 0) {
      return sendJson(response, 400, "Bad Request", kj::heapString(
          "{\n  \"ok\": false,\n  \"error\": \"expected exactly one capability id\"\n}\n"));
    }
    if (labels.size() > 1) {
      return sendJson(response, 400, "Bad Request", kj::heapString(
          "{\n  \"ok\": false,\n  \"error\": \"expected at most one save label\"\n}\n"));
    }

    kj::StringPtr label = "Claimed Sandstorm capability";
    if (labels.size() == 1) {
      label = labels[0];
      if (label.size() == 0 || label.size() > 256) {
        return sendJson(response, 400, "Bad Request", kj::heapString(
            "{\n  \"ok\": false,\n  \"error\": \"save label must be 1-256 bytes\"\n}\n"));
      }
    }

    KJ_IF_MAYBE(cap, host.sessions->findClaimedCapability(ids[0])) {
      auto request = cap->castAs<SystemPersistent>().saveRequest();
      auto owner = request.getSealFor().initGrain();
      owner.setGrainId(host.grainId);
      owner.getSaveLabel().setDefaultText(label);
      return request.send().then(
          [this, &response, capabilityId = kj::heapString(ids[0])]
          (auto result) mutable {
        auto token = kj::encodeBase64Url(result.getSturdyRef());
        return sendJson(response, 200, "OK", renderSavedCapability(capabilityId, token));
      });
    } else {
      return sendJson(response, 404, "Not Found", kj::heapString(
          "{\n  \"ok\": false,\n  \"error\": \"unknown claimed capability\"\n}\n"));
    }
  }

  kj::Promise<void> restorePowerboxCapability(
      kj::StringPtr url, kj::HttpService::Response& response) {
    auto tokens = findIsolateQueryParams(url, "token");
    if (tokens.size() != 1 || tokens[0].size() == 0) {
      return sendJson(response, 400, "Bad Request", kj::heapString(
          "{\n  \"ok\": false,\n  \"error\": \"expected exactly one saved capability token\"\n}\n"));
    }

    KJ_IF_MAYBE(token, decodeSavedCapabilityToken(tokens[0])) {
      KJ_IF_MAYBE(pathPrefix, readIsolateWebSessionSavedToken(token->asPtr())) {
        auto cap = kj::heap<IsolateWebSessionImpl>(
            kj::addRef(config), kj::addRef(host), *pathPrefix, SessionKind::NORMAL,
            SessionMetadata(), true);
        auto capId = host.sessions->storeClaimedCapability(kj::mv(cap));
        return sendJson(response, 200, "OK", renderClaimedCapability(capId));
      }

      auto request = host.sandstormCore.restoreRequest();
      request.setToken(token->asPtr());
      return request.send().then(
          [this, &response](auto result) mutable {
        auto capId = host.sessions->storeClaimedCapability(result.getCap());
        return sendJson(response, 200, "OK", renderClaimedCapability(capId));
      });
    } else {
      return sendJson(response, 400, "Bad Request", kj::heapString(
          "{\n  \"ok\": false,\n  \"error\": \"invalid saved capability token\"\n}\n"));
    }
  }

  kj::Promise<void> dropSavedPowerboxCapability(
      kj::StringPtr url, kj::HttpService::Response& response) {
    auto tokens = findIsolateQueryParams(url, "token");
    if (tokens.size() != 1 || tokens[0].size() == 0) {
      return sendJson(response, 400, "Bad Request", kj::heapString(
          "{\n  \"ok\": false,\n  \"error\": \"expected exactly one saved capability token\"\n}\n"));
    }

    KJ_IF_MAYBE(token, decodeSavedCapabilityToken(tokens[0])) {
      if (dropIsolateWebSessionSavedToken(token->asPtr())) {
        return sendJson(response, 200, "OK", kj::heapString("{\n  \"ok\": true\n}\n"));
      }

      auto request = host.sandstormCore.dropRequest();
      request.setToken(token->asPtr());
      return request.send().then(
          [this, &response](auto result) mutable {
        (void)result;
        return sendJson(response, 200, "OK", kj::heapString("{\n  \"ok\": true\n}\n"));
      });
    } else {
      return sendJson(response, 400, "Bad Request", kj::heapString(
          "{\n  \"ok\": false,\n  \"error\": \"invalid saved capability token\"\n}\n"));
    }
  }

  kj::Promise<void> dropPowerboxCapability(
      kj::StringPtr url, kj::HttpService::Response& response) {
    auto ids = findIsolateQueryParams(url, "id");
    if (ids.size() != 1 || ids[0].size() == 0) {
      return sendJson(response, 400, "Bad Request", kj::heapString(
          "{\n  \"ok\": false,\n  \"error\": \"expected exactly one capability id\"\n}\n"));
    }

    if (host.sessions->dropClaimedCapability(ids[0])) {
      return sendJson(response, 200, "OK", kj::heapString("{\n  \"ok\": true\n}\n"));
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
    bool first = true;
    for (auto& file: files) {
      if (!isValidIsolateStorageKey(file)) {
        continue;
      }

      auto path = kj::str(config.storageRootPath, "/", file);
      KJ_IF_MAYBE(fd, openStorageFileIfExists(path)) {
        struct stat stats;
        KJ_SYSCALL(fstat(*fd, &stats));

        if (!first) json.addAll(kj::StringPtr(", "));
        json.addAll(kj::StringPtr("{ "));
        appendJsonField(json, "name", file);
        json.addAll(kj::StringPtr(", \"bytes\": "));
        json.addAll(kj::str(stats.st_size));
        json.addAll(kj::StringPtr(" }"));
        first = false;
      }
    }
    json.addAll(kj::StringPtr("]\n}\n"));
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
      case SupervisorObjectId<>::APP_REF:
        KJ_FAIL_REQUIRE(
            "isolate grain app-defined persistent capabilities are not implemented yet");
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
        KJ_FAIL_REQUIRE(
            "isolate grain app-defined persistent capabilities are not implemented yet");
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
