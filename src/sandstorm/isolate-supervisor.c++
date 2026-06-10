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

#include "util.h"
#include "version.h"

#include <capnp/message.h>
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
#include <sandstorm/supervisor.capnp.h>
#include <sandstorm/util.capnp.h>
#include <sandstorm/web-session.capnp.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <sys/inotify.h>
#include <unistd.h>
#include <time.h>
#include <fcntl.h>
#include <errno.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>

namespace sandstorm {

namespace {

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
  kj::String storageSocketPath;
  kj::String storageRootPath;
  kj::Own<capnp::MallocMessageBuilder> viewInfoMessage;
  kj::Vector<kj::String> compatibilityFlags;
  kj::Vector<Module> modules;
  kj::Vector<Binding> bindings;
};

struct IsolateRuntimeHost final: public kj::Refcounted {
  IsolateRuntimeHost(kj::Network& network, kj::Timer& timer): network(network), timer(timer) {}

  kj::Network& network;
  kj::Timer& timer;
  kj::HttpHeaderTable headerTable;
};

IsolateRuntimeConfig::ModuleType getModuleType(
    spk::Manifest::IsolateConfig::Module::Reader module) {
  switch (module.which()) {
    case spk::Manifest::IsolateConfig::Module::ES_MODULE:
      return IsolateRuntimeConfig::ModuleType::ES_MODULE;
    case spk::Manifest::IsolateConfig::Module::COMMON_JS_MODULE:
      return IsolateRuntimeConfig::ModuleType::COMMON_JS_MODULE;
    case spk::Manifest::IsolateConfig::Module::TEXT:
      return IsolateRuntimeConfig::ModuleType::TEXT;
    case spk::Manifest::IsolateConfig::Module::DATA:
      return IsolateRuntimeConfig::ModuleType::DATA;
    case spk::Manifest::IsolateConfig::Module::WASM:
      return IsolateRuntimeConfig::ModuleType::WASM;
    case spk::Manifest::IsolateConfig::Module::JSON:
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

kj::Array<byte> copyModuleContent(spk::Manifest::IsolateConfig::Module::Reader module) {
  switch (module.which()) {
    case spk::Manifest::IsolateConfig::Module::ES_MODULE:
      return kj::heapArray<byte>(module.getEsModule().asBytes());
    case spk::Manifest::IsolateConfig::Module::COMMON_JS_MODULE:
      return kj::heapArray<byte>(module.getCommonJsModule().asBytes());
    case spk::Manifest::IsolateConfig::Module::TEXT:
      return kj::heapArray<byte>(module.getText().asBytes());
    case spk::Manifest::IsolateConfig::Module::DATA:
      return kj::heapArray<byte>(module.getData());
    case spk::Manifest::IsolateConfig::Module::WASM:
      return kj::heapArray<byte>(module.getWasm());
    case spk::Manifest::IsolateConfig::Module::JSON:
      return kj::heapArray<byte>(module.getJson().asBytes());
  }

  KJ_UNREACHABLE;
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

kj::Own<IsolateRuntimeConfig> copyIsolateConfig(spk::Manifest::IsolateConfig::Reader config) {
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
    moduleConfig.content = copyModuleContent(module);
    result->modules.add(kj::mv(moduleConfig));
  }

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
  }
}

void chownPathTo(kj::StringPtr path, uid_t uid) {
  KJ_SYSCALL(chown(path.cStr(), uid, static_cast<gid_t>(-1)), path);
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
  KJ_SYSCALL(fd = open(path.cStr(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0660), path);
  KJ_DEFER(close(fd));
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

void appendJsonString(kj::Vector<char>& result, kj::StringPtr text) {
  result.add('"');
  for (char c: text) {
    switch (c) {
      case '"': result.addAll(kj::StringPtr("\\\"")); break;
      case '\\': result.addAll(kj::StringPtr("\\\\")); break;
      case '\b': result.addAll(kj::StringPtr("\\b")); break;
      case '\f': result.addAll(kj::StringPtr("\\f")); break;
      case '\n': result.addAll(kj::StringPtr("\\n")); break;
      case '\r': result.addAll(kj::StringPtr("\\r")); break;
      case '\t': result.addAll(kj::StringPtr("\\t")); break;
      default:
        result.add(c < 0x20 ? ' ' : c);
        break;
    }
  }
  result.add('"');
}

void appendJsonField(kj::Vector<char>& result, kj::StringPtr name, kj::StringPtr value) {
  appendJsonString(result, name);
  result.addAll(kj::StringPtr(": "));
  appendJsonString(result, value);
}

void appendCapnpString(kj::Vector<char>& result, kj::StringPtr text) {
  appendJsonString(result, text);
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
      return true;
    case IsolateRuntimeConfig::BindingType::POWERBOX:
    case IsolateRuntimeConfig::BindingType::PUBLIC_FETCH:
    case IsolateRuntimeConfig::BindingType::SERVICE:
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
    case IsolateRuntimeConfig::BindingType::PUBLIC_FETCH:
    case IsolateRuntimeConfig::BindingType::SERVICE:
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
  auto storageSocketPath = kj::str(bundleDir, "/sandstorm-storage.sock");
  auto storageRootPath = kj::str(varPath, "/isolate-storage");
  config.sandstormApiSocketPath = kj::heapString(sandstormApiSocketPath);
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

void chownGeneratedWorkerdBundle(kj::StringPtr bundleDir, IsolateRuntimeConfig& config, uid_t uid) {
  auto modulesDir = kj::str(bundleDir, "/modules");
  auto bindingsDir = kj::str(bundleDir, "/bindings");

  chownPathTo(bundleDir, uid);
  chownPathTo(modulesDir, uid);
  chownPathTo(bindingsDir, uid);
  chownPathTo(config.storageRootPath, uid);
  chownPathTo(kj::str(bundleDir, "/runtime-manifest.json"), uid);
  chownPathTo(kj::str(bundleDir, "/workerd.capnp"), uid);

  for (auto i: kj::indices(config.modules)) {
    chownPathTo(kj::str(modulesDir, "/", moduleBundleFileName(i, config.modules[i].type)), uid);
  }

  for (auto i: kj::indices(config.bindings)) {
    if (config.bindings[i].value.size() > 0) {
      chownPathTo(kj::str(bindingsDir, "/", bindingBundleFileName(i)), uid);
    }
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

struct FetchRequest {
  FetchMethod method;
  kj::String path;
  kj::String mimeType;
  kj::String encoding;
  kj::Array<byte> body;
  kj::Vector<FetchHeader> headers;
};

struct FetchResponse {
  uint statusCode = 200;
  kj::String mimeType = kj::heapString("text/plain; charset=utf-8");
  kj::Array<byte> body;
  kj::Vector<FetchHeader> headers;
};

constexpr uint64_t MAX_SIDECAR_RESPONSE_BYTES = 64 * 1024 * 1024;
constexpr uint SIDECAR_READY_TIMEOUT_MS = 10000;
constexpr uint SIDECAR_READY_POLL_MS = 50;
constexpr uint SIDECAR_SHUTDOWN_TIMEOUT_MS = 2000;

void sleepMillis(uint millis);

void addHeader(FetchRequest& request, kj::StringPtr name, kj::StringPtr value) {
  FetchHeader header;
  header.name = kj::heapString(name);
  header.value = kj::heapString(value);
  request.headers.add(kj::mv(header));
}

void addRequestContextHeaders(FetchRequest& request, WebSession::Context::Reader context) {
  for (auto header: context.getAdditionalHeaders()) {
    addHeader(request, header.getName(), header.getValue());
  }

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

template <typename ContentReader>
void setFetchRequestBody(FetchRequest& request, ContentReader content) {
  request.mimeType = kj::heapString(content.getMimeType());
  request.encoding = kj::heapString(content.getEncoding());
  request.body = kj::heapArray<byte>(content.getContent());

  if (request.mimeType.size() > 0) {
    addHeader(request, "content-type", request.mimeType);
  }
  if (request.encoding.size() > 0) {
    addHeader(request, "content-encoding", request.encoding);
  }
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

bool equalsIgnoreCase(kj::StringPtr a, kj::StringPtr b) {
  if (a.size() != b.size()) {
    return false;
  }

  for (auto i: kj::indices(a)) {
    char ca = a[i];
    char cb = b[i];
    if (ca >= 'A' && ca <= 'Z') {
      ca += 'a' - 'A';
    }
    if (cb >= 'A' && cb <= 'Z') {
      cb += 'a' - 'A';
    }
    if (ca != cb) {
      return false;
    }
  }

  return true;
}

bool isStructuredResponseHeader(kj::StringPtr name) {
  return equalsIgnoreCase(name, "content-type") ||
      equalsIgnoreCase(name, "content-encoding") ||
      equalsIgnoreCase(name, "content-language") ||
      equalsIgnoreCase(name, "content-disposition") ||
      equalsIgnoreCase(name, "etag") ||
      equalsIgnoreCase(name, "location") ||
      equalsIgnoreCase(name, "content-length") ||
      equalsIgnoreCase(name, "transfer-encoding") ||
      equalsIgnoreCase(name, "connection") ||
      equalsIgnoreCase(name, "keep-alive") ||
      equalsIgnoreCase(name, "te") ||
      equalsIgnoreCase(name, "trailer") ||
      equalsIgnoreCase(name, "upgrade");
}

void addFetchResponseHeaders(WebSession::Response::Builder builder, kj::Vector<FetchHeader>& headers) {
  size_t count = 0;
  for (auto& header: headers) {
    if (!isStructuredResponseHeader(header.name)) {
      ++count;
    }
  }

  auto outputHeaders = builder.initAdditionalHeaders(count);
  size_t j = 0;
  for (auto i: kj::indices(headers)) {
    if (!isStructuredResponseHeader(headers[i].name)) {
      outputHeaders[j].setName(headers[i].name);
      outputHeaders[j].setValue(headers[i].value);
      ++j;
    }
  }
}

kj::Maybe<kj::StringPtr> findFetchResponseHeader(
    kj::Vector<FetchHeader>& headers, kj::StringPtr name) {
  for (auto& header: headers) {
    if (equalsIgnoreCase(header.name, name)) {
      return kj::StringPtr(header.value);
    }
  }

  return nullptr;
}

void writeFetchResponse(FetchResponse&& response, WebSession::Response::Builder builder) {
  addFetchResponseHeaders(builder, response.headers);

  if (response.statusCode == 204 || response.statusCode == 205) {
    auto noContent = builder.initNoContent();
    noContent.setShouldResetForm(response.statusCode == 205);
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
  } else if (response.statusCode >= 200 && response.statusCode < 400) {
    auto content = builder.initContent();
    content.setStatusCode(successCodeForStatus(response.statusCode));
    content.setMimeType(response.mimeType);
    KJ_IF_MAYBE(encoding, findFetchResponseHeader(response.headers, "content-encoding")) {
      content.setEncoding(*encoding);
    }
    KJ_IF_MAYBE(language, findFetchResponseHeader(response.headers, "content-language")) {
      content.setLanguage(*language);
    }
    if (response.body.size() > 0) {
      content.initBody().setBytes(response.body);
    }
  } else if (response.statusCode >= 400 && response.statusCode < 500) {
    auto error = builder.initClientError();
    error.setStatusCode(clientErrorCodeForStatus(response.statusCode));
    if (response.body.size() > 0) {
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
  } else {
    auto error = builder.initServerError();
    if (response.body.size() > 0) {
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
}

class IsolateRuntimeAdapter {
public:
  virtual ~IsolateRuntimeAdapter() noexcept(false) {}
  virtual kj::Promise<FetchResponse> fetch(FetchRequest&& request) = 0;
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

private:
  struct SidecarHttpState {
    kj::Own<kj::NetworkAddress> addr;
    kj::Own<kj::HttpClient> client;
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

  void copyHeadersToHttp(FetchRequest& request, kj::HttpHeaders& headers) {
    for (auto& header: request.headers) {
      headers.add(header.name, header.value);
    }
  }

  kj::Promise<FetchResponse> readSidecarResponse(
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

    state->responseBody = kj::mv(response.body);
    auto& body = KJ_ASSERT_NONNULL(state->responseBody);
    return body->readAllBytes(MAX_SIDECAR_RESPONSE_BYTES)
        .then([result = kj::mv(result), state = kj::mv(state)](kj::Array<byte>&& body) mutable {
      result.body = kj::mv(body);
      KJ_LOG(WARNING, "Isolate sidecar response received.",
          result.statusCode, result.mimeType, result.body.size());
      return kj::mv(result);
    });
  }

  kj::Promise<FetchResponse> fetchFromSidecar(FetchRequest&& request) {
    KJ_LOG(WARNING, "Forwarding isolate request to sidecar.",
        fetchMethodName(request.method), request.path, request.body.size());
    return host->network.parseAddress(kj::str("unix:", config->workerdSocketPath), 0)
        .then([this, request = kj::mv(request)](kj::Own<kj::NetworkAddress>&& addr) mutable {
      auto client = kj::newHttpClient(host->timer, host->headerTable, *addr);
      auto state = kj::heap<SidecarHttpState>(kj::mv(addr), kj::mv(client));
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
        }).then([this, state = kj::mv(state)](
            kj::HttpClient::Response&& response) mutable {
          return readSidecarResponse(kj::mv(response), kj::mv(state));
        });
      }

      return response.then([this, state = kj::mv(state)](
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

      found = copyIsolateConfig(isolate);
    }
  };

  KJ_IF_MAYBE(mainModule, requestedMainModule) {
    considerCommand(manifest.getContinueCommand());
    for (auto action: manifest.getActions()) {
      considerCommand(action.getCommand());
    }
  } else {
    if (manifest.getContinueCommand().hasIsolate()) {
      return copyIsolateConfig(manifest.getContinueCommand().getIsolate());
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
      SessionMetadata&& sessionMetadata = SessionMetadata())
      : pathPrefix(kj::heapString(pathPrefix)),
        sessionKind(sessionKind),
        sessionMetadata(kj::mv(sessionMetadata)),
        runtime(kj::heap<WorkerdRuntimeAdapter>(kj::mv(config), kj::mv(host))) {}

  kj::Promise<void> get(GetContext context) override {
    auto params = context.getParams();
    auto method = params.getIgnoreBody() ? FetchMethod::HEAD : FetchMethod::GET;
    auto request = makeFetchRequest(method, prefixedPath(params.getPath()), params.getContext());
    return fetch(kj::mv(request), context.getResults());
  }

  kj::Promise<void> post(PostContext context) override {
    auto params = context.getParams();
    auto request = makeFetchRequest(FetchMethod::POST, prefixedPath(params.getPath()),
        params.getContext());
    setFetchRequestBody(request, params.getContent());
    return fetch(kj::mv(request), context.getResults());
  }

  kj::Promise<void> put(PutContext context) override {
    auto params = context.getParams();
    auto request = makeFetchRequest(FetchMethod::PUT, prefixedPath(params.getPath()),
        params.getContext());
    setFetchRequestBody(request, params.getContent());
    return fetch(kj::mv(request), context.getResults());
  }

  kj::Promise<void> delete_(DeleteContext context) override {
    auto params = context.getParams();
    auto request = makeFetchRequest(FetchMethod::DELETE_, prefixedPath(params.getPath()),
        params.getContext());
    return fetch(kj::mv(request), context.getResults());
  }

  kj::Promise<void> patch(PatchContext context) override {
    auto params = context.getParams();
    auto request = makeFetchRequest(FetchMethod::PATCH, prefixedPath(params.getPath()),
        params.getContext());
    setFetchRequestBody(request, params.getContent());
    return fetch(kj::mv(request), context.getResults());
  }

  kj::Promise<void> options(OptionsContext context) override {
    return kj::READY_NOW;
  }

  kj::Promise<void> addRequirements(AddRequirementsContext context) override {
    context.getResults().setCap(thisCap().castAs<SystemPersistent>());
    return kj::READY_NOW;
  }

private:
  kj::String pathPrefix;
  SessionKind sessionKind;
  SessionMetadata sessionMetadata;
  kj::Own<IsolateRuntimeAdapter> runtime;

  kj::String prefixedPath(kj::StringPtr path) {
    if (pathPrefix.size() == 0) {
      return kj::heapString(path);
    } else {
      return kj::str(pathPrefix, path);
    }
  }

  void addSessionHeaders(FetchRequest& request) {
    addHeader(request, "x-sandstorm-session-type", sessionKindName(sessionKind));
    addHeader(request, "x-sandstorm-username", sessionMetadata.userDisplayName);
    addHeader(request, "x-sandstorm-permissions", sessionMetadata.permissions);
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
    if (sessionMetadata.host.size() > 0) {
      addHeader(request, "host", sessionMetadata.host);
    }
    if (sessionMetadata.forwardedProto.size() > 0) {
      addHeader(request, "x-forwarded-proto", sessionMetadata.forwardedProto);
    }
  }

  kj::Promise<void> fetch(FetchRequest&& request, WebSession::Response::Builder response) {
    addSessionHeaders(request);
    KJ_LOG(WARNING, "Handling isolate WebSession request.",
        fetchMethodName(request.method), request.path, sessionKindName(sessionKind));
    return runtime->fetch(kj::mv(request))
        .then([response](FetchResponse&& fetchResponse) mutable {
      writeFetchResponse(kj::mv(fetchResponse), response);
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
    context.getResults().setSession(kj::heap<IsolateWebSessionImpl>(
        kj::addRef(*runtimeConfig), kj::addRef(*runtimeHost), "", SessionKind::OFFER,
        kj::mv(sessionMetadata)));
    return kj::READY_NOW;
  }

private:
  kj::Own<IsolateRuntimeConfig> runtimeConfig;
  kj::Own<IsolateRuntimeHost> runtimeHost;
};

class WorkerdSidecarProcess final {
public:
  WorkerdSidecarProcess(
      kj::ArrayPtr<const kj::String> runtimeArgs,
      kj::ArrayPtr<const kj::String> environment,
      IsolateRuntimeConfig& runtimeConfig) {
    if (runtimeArgs.size() == 0) {
      KJ_LOG(WARNING, "No isolate sidecar command configured; runtime remains in diagnostics mode.",
          runtimeConfig.workerdBundleDir, runtimeConfig.workerdSocketPath);
      return;
    }

    auto argvStrings = KJ_MAP(arg, runtimeArgs) {
      return expandSidecarPlaceholders(arg, runtimeConfig);
    };
    auto argv = KJ_MAP(arg, argvStrings) -> kj::StringPtr {
      return arg;
    };
    auto childEnvStrings = makeSidecarEnvironment(environment, runtimeConfig);
    auto childEnv = KJ_MAP(item, childEnvStrings) -> kj::StringPtr {
      return item;
    };

    auto stdoutNull = raiiOpen("/dev/null", O_WRONLY | O_CLOEXEC);
    Subprocess::Options options(argv.asPtr());
    if (argvStrings[0] == "/sandstorm") {
      options.executable = "/proc/self/exe";
    }
    options.environment = childEnv.asPtr();
    options.stdout = stdoutNull;
    options.parentDeathSignal = SIGTERM;
    process = Subprocess(kj::mv(options));

    KJ_IF_MAYBE(p, process) {
      KJ_LOG(WARNING, "Started isolate sidecar process.",
          argvStrings[0], p->getPid(), runtimeConfig.workerdBundleDir,
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
        KJ_LOG(WARNING, "Stopping isolate sidecar process.", pid);
        p->signal(SIGTERM);

        for (uint elapsed = 0; elapsed < SIDECAR_SHUTDOWN_TIMEOUT_MS;
             elapsed += SIDECAR_READY_POLL_MS) {
          if (!isRunning()) {
            process = nullptr;
            return;
          }
          sleepMillis(SIDECAR_READY_POLL_MS);
        }

        KJ_LOG(WARNING, "Killing isolate sidecar process after shutdown timeout.", pid);
        p->signal(SIGKILL);
      }
      process = nullptr;
    }
  }

private:
  kj::Maybe<Subprocess> process;

  static void logExitStatus(int status) {
    if (WIFEXITED(status)) {
      KJ_LOG(WARNING, "Isolate sidecar process exited.", WEXITSTATUS(status));
    } else if (WIFSIGNALED(status)) {
      KJ_LOG(WARNING, "Isolate sidecar process was killed.", WTERMSIG(status));
    } else {
      KJ_LOG(WARNING, "Isolate sidecar process stopped unexpectedly.", status);
    }
  }

  static bool hasEnvVar(kj::ArrayPtr<const kj::String> environment, kj::StringPtr name) {
    for (auto& item: environment) {
      KJ_IF_MAYBE(separator, item.findFirst('=')) {
        if (item.slice(0, *separator) == name) {
          return true;
        }
      }
    }

    return false;
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
    kj::Vector<kj::String> result(environment.size() + 7);
    for (auto& item: environment) {
      result.add(expandSidecarPlaceholders(item, runtimeConfig));
    }

    if (!hasEnvVar(environment, "PATH")) {
      char* inheritedPath = getenv("PATH");
      if (inheritedPath != nullptr) {
        result.add(kj::str("PATH=", inheritedPath));
      } else {
        result.add(kj::heapString("PATH=/bin:/usr/bin:/usr/local/bin"));
      }
    }

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

class SandstormApiBindingService final: public kj::HttpService {
public:
  SandstormApiBindingService(kj::HttpHeaderTable& headerTable, IsolateRuntimeConfig& config)
      : headerTable(headerTable), config(config) {}

  kj::Promise<void> request(
      kj::HttpMethod method, kj::StringPtr url, const kj::HttpHeaders& headers,
      kj::AsyncInputStream& requestBody, kj::HttpService::Response& response) override {
    (void)headers;
    auto methodName = kj::str(method);
    auto path = kj::heapString(url);
    KJ_LOG(WARNING, "Isolate Sandstorm API binding received request.", methodName, path);

    return requestBody.readAllBytes(1024 * 1024).then(
        [this, methodName = kj::mv(methodName), path = kj::mv(path), &response]
        (kj::Array<byte>&& bodyBytes) mutable {
      if (methodName != "GET") {
        return sendJson(response, 405, "Method Not Allowed", kj::heapString(
            "{\n  \"ok\": false,\n  \"error\": \"method not allowed\"\n}\n"));
      }

      if (path == "/" || path == "/status") {
        return sendJson(response, 200, "OK", renderStatus(methodName, path, bodyBytes.size()));
      } else if (path == "/capabilities") {
        return sendJson(response, 200, "OK", renderCapabilities());
      } else if (path == "/runtime") {
        return sendJson(response, 200, "OK", renderRuntime());
      } else if (path == "/modules") {
        return sendJson(response, 200, "OK", renderModules());
      } else if (path == "/bindings") {
        return sendJson(response, 200, "OK", renderBindings());
      } else {
        return sendJson(response, 404, "Not Found", kj::heapString(
            "{\n  \"ok\": false,\n  \"error\": \"unknown Sandstorm API binding endpoint\"\n}\n"));
      }
    });
  }

private:
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
        "  \"capabilities\": [\"status\", \"capabilities\", \"runtime\", \"modules\", \"bindings\"]\n"
        "}\n");
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
    auto key = storageKeyFromUrl(url);
    KJ_LOG(WARNING, "Isolate storage binding received request.", kj::str(method), key);

    if (method == kj::HttpMethod::GET && key.size() == 0) {
      return sendJson(response, 200, "OK", renderIndex());
    }

    if (!isValidStorageKey(key)) {
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
        return requestBody.readAllBytes(MAX_STORAGE_VALUE_BYTES)
            .then([this, key = kj::mv(key), path = kj::mv(path), &response]
                (kj::Array<byte>&& body) mutable {
          writeStorageFile(path, key, body);
          return sendJson(response, 200, "OK", renderStored(body.size()));
        });
      case kj::HttpMethod::DELETE:
        unlinkIfExists(path);
        return sendJson(response, 200, "OK", kj::heapString("{\n  \"ok\": true\n}\n"));
      default:
        return sendJson(response, 405, "Method Not Allowed", kj::heapString(
            "{\n  \"ok\": false,\n  \"error\": \"method not allowed\"\n}\n"));
    }
  }

private:
  static constexpr size_t MAX_STORAGE_VALUE_BYTES = 1024 * 1024;

  kj::HttpHeaderTable& headerTable;
  IsolateRuntimeConfig& config;

  kj::String storageKeyFromUrl(kj::StringPtr url) {
    size_t begin = 0;
    size_t end = url.size();
    KJ_IF_MAYBE(query, url.findFirst('?')) {
      end = *query;
    }
    while (begin < end && url[begin] == '/') {
      ++begin;
    }
    return kj::str(url.slice(begin, end));
  }

  bool isValidStorageKey(kj::StringPtr key) {
    if (key.size() == 0 || key.size() > 128 || key.startsWith(".")) {
      return false;
    }

    for (char c: key) {
      if (!(c >= 'a' && c <= 'z') &&
          !(c >= 'A' && c <= 'Z') &&
          !(c >= '0' && c <= '9') &&
          c != '-' && c != '_' && c != '.') {
        return false;
      }
    }

    for (size_t i = 1; i < key.size(); ++i) {
      if (key[i - 1] == '.' && key[i] == '.') {
        return false;
      }
    }
    return true;
  }

  kj::Promise<void> sendJson(kj::HttpService::Response& response, uint statusCode,
      kj::StringPtr statusText, kj::String body) {
    kj::HttpHeaders responseHeaders(headerTable);
    responseHeaders.set(kj::HttpHeaderId::CONTENT_TYPE, "application/json; charset=utf-8");
    auto stream = response.send(statusCode, statusText, responseHeaders, body.size());
    auto promise = stream->write(body.begin(), body.size());
    return promise.attach(kj::mv(stream), kj::mv(body));
  }

  kj::Promise<void> get(kj::String path, kj::HttpService::Response& response) {
    KJ_IF_MAYBE(fd, raiiOpenIfExists(path, O_RDONLY | O_CLOEXEC)) {
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
    KJ_IF_MAYBE(fd, raiiOpenIfExists(path, O_RDONLY | O_CLOEXEC)) {
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

  void writeStorageFile(kj::StringPtr path, kj::StringPtr key, kj::ArrayPtr<const byte> content) {
    auto tmpPath = kj::str(config.storageRootPath, "/.tmp-", getpid(), "-", key);
    unlinkIfExists(tmpPath);

    int fd;
    KJ_SYSCALL(fd = open(tmpPath.cStr(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0660),
        tmpPath);
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
      if (file.startsWith(".")) {
        continue;
      }

      auto path = kj::str(config.storageRootPath, "/", file);
      KJ_IF_MAYBE(fd, raiiOpenIfExists(path, O_RDONLY | O_CLOEXEC)) {
        struct stat stats;
        KJ_SYSCALL(fstat(*fd, &stats));
        if (!S_ISREG(stats.st_mode)) {
          continue;
        }

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
      kj::Own<WorkerdSidecarProcess> sidecar)
      : eventPort(eventPort), varPath(kj::heapString(varPath)), coreRedirector(kj::mv(coreRedirector)),
        runtimeConfig(kj::mv(runtimeConfig)), runtimeHost(kj::mv(runtimeHost)),
        sidecar(kj::mv(sidecar)) {}

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
    auto fd = raiiOpen(varPath, O_RDONLY | O_DIRECTORY);
    KJ_SYSCALL(syncfs(fd));
    return kj::READY_NOW;
  }

  kj::Promise<void> shutdown(ShutdownContext context) override {
    sidecar->stop();
    _exit(0);
  }

  kj::Promise<void> restore(RestoreContext context) override {
    KJ_UNIMPLEMENTED("isolate grain capability restore is not implemented yet");
  }

  kj::Promise<void> drop(DropContext context) override {
    KJ_UNIMPLEMENTED("isolate grain capability drop is not implemented yet");
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

    return requestBody.readAllBytes(1024 * 1024).then(
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
      .addOption({"log-seccomp-violations"}, []() { return true; },
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

  runtimeConfig->workerdBundleDir = prepareWorkerdBundle(varPath, *runtimeConfig);
  runtimeConfig->workerdConfigPath = kj::str(runtimeConfig->workerdBundleDir, "/workerd.capnp");
  runtimeConfig->workerdSocketPath = kj::str(runtimeConfig->workerdBundleDir, "/workerd.sock");
  unlinkIfExists(runtimeConfig->workerdSocketPath);
  unlinkIfExists(runtimeConfig->sandstormApiSocketPath);
  unlinkIfExists(runtimeConfig->storageSocketPath);

  KJ_IF_MAYBE(u, sandboxUid) {
    chownGeneratedWorkerdBundle(runtimeConfig->workerdBundleDir, *runtimeConfig, *u);
    KJ_SYSCALL(setuid(*u));
  }

  KJ_LOG(WARNING, "Starting isolate supervisor with workerd adapter skeleton.",
      grainId, pkgPath, runtimeConfig->mainModule, runtimeConfig->compatibilityDate,
      runtimeConfig->compatibilityFlags.size(), runtimeConfig->modules.size(),
      runtimeConfig->bindings.size(), runtimeConfig->workerdBundleDir,
      runtimeConfig->workerdSocketPath);

  auto ioContext = kj::setupAsyncIo();
  auto runtimeHost = kj::refcounted<IsolateRuntimeHost>(
      ioContext.provider->getNetwork(), ioContext.provider->getTimer());
  kj::Maybe<kj::Promise<void>> apiListenTask = nullptr;
  kj::Maybe<kj::Promise<void>> storageListenTask = nullptr;
  if (hasSandstormApiBinding(*runtimeConfig)) {
    auto apiService = kj::heap<SandstormApiBindingService>(
        runtimeHost->headerTable, *runtimeConfig);
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

  auto sidecar = kj::heap<WorkerdSidecarProcess>(
      runtimeArgs.asPtr(), environment.asPtr(), *runtimeConfig);
  waitForSidecarSocket(*sidecar, *runtimeConfig);
  KJ_LOG(WARNING, "Isolate supervisor sidecar readiness complete.");

  auto coreRedirector = kj::refcounted<CapRedirector>();
  KJ_LOG(WARNING, "Isolate supervisor core redirector created.");

  KJ_LOG(WARNING, "Creating isolate supervisor capability.");
  Supervisor::Client mainCap = kj::heap<IsolateSupervisorImpl>(
      ioContext.unixEventPort, varPath, kj::addRef(*coreRedirector), kj::mv(runtimeConfig),
      kj::mv(runtimeHost), kj::mv(sidecar));
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
  KJ_IF_MAYBE(storageTask, storageListenTask) {
    listenTask = listenTask.exclusiveJoin(kj::mv(*storageTask));
  }
  listenTask.wait(ioContext.waitScope);
  return true;
}

}  // namespace sandstorm
