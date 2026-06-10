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
#include <kj/debug.h>
#include <kj/encoding.h>
#include <kj/io.h>
#include <kj/refcount.h>
#include <sandstorm/api-session.capnp.h>
#include <sandstorm/grain.capnp.h>
#include <sandstorm/identity.capnp.h>
#include <sandstorm/package.capnp.h>
#include <sandstorm/supervisor.capnp.h>
#include <sandstorm/util.capnp.h>
#include <sandstorm/web-session.capnp.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>

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
  kj::String workerdSocketPath;
  kj::Own<capnp::MallocMessageBuilder> viewInfoMessage;
  kj::Vector<kj::String> compatibilityFlags;
  kj::Vector<Module> modules;
  kj::Vector<Binding> bindings;
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

kj::String moduleBundleFileName(size_t index, IsolateRuntimeConfig::ModuleType type) {
  return kj::str("module-", index, moduleFileExtension(type));
}

kj::String bindingBundleFileName(size_t index) {
  return kj::str("binding-", index, ".bin");
}

kj::String prepareWorkerdBundle(kj::StringPtr varPath, IsolateRuntimeConfig& config) {
  auto bundleDir = kj::str(varPath, "/isolate-runtime");
  auto modulesDir = kj::str(bundleDir, "/modules");
  auto bindingsDir = kj::str(bundleDir, "/bindings");
  ensureDirectory(bundleDir);
  ensureDirectory(modulesDir);
  ensureDirectory(bindingsDir);

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
  return bundleDir;
}

enum class FetchMethod {
  GET,
  HEAD,
  POST,
  PUT,
  DELETE_,
  PATCH,
};

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

FetchRequest makeFetchRequest(
    FetchMethod method, kj::StringPtr path, WebSession::Context::Reader context) {
  FetchRequest request;
  request.method = method;
  request.path = kj::heapString(path);
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

bool isStructuredResponseHeader(kj::StringPtr name) {
  return name == "content-type" || name == "content-encoding" || name == "content-language" ||
      name == "content-disposition" || name == "etag" || name == "location";
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
    if (header.name == name) {
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
  explicit WorkerdRuntimeAdapter(kj::Own<IsolateRuntimeConfig> config)
      : config(kj::mv(config)) {}

  kj::Promise<FetchResponse> fetch(FetchRequest&& request) override {
    if (hasSidecarEndpoint()) {
      return fetchPlaceholder(kj::mv(request), "sidecar endpoint configured");
    }

    return fetchPlaceholder(kj::mv(request), "sidecar endpoint not configured");
  }

private:
  kj::Own<IsolateRuntimeConfig> config;

  bool hasSidecarEndpoint() {
    return config->workerdSocketPath.size() > 0;
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
      auto isolate = command.getIsolate();
      KJ_IF_MAYBE(mainModule, requestedMainModule) {
        if (isolate.getMainModule() != *mainModule) {
          return;
        }
      }

      KJ_REQUIRE(found == nullptr,
          "Manifest has multiple isolate commands matching the selected mainModule.");
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

class IsolateWebSessionImpl final: public WebSession::Server {
public:
  IsolateWebSessionImpl(
      kj::Own<IsolateRuntimeConfig> config, kj::StringPtr pathPrefix = "",
      SessionKind sessionKind = SessionKind::NORMAL,
      SessionMetadata&& sessionMetadata = SessionMetadata())
      : pathPrefix(kj::heapString(pathPrefix)),
        sessionKind(sessionKind),
        sessionMetadata(kj::mv(sessionMetadata)),
        runtime(kj::heap<WorkerdRuntimeAdapter>(kj::mv(config))) {}

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
    return runtime->fetch(kj::mv(request))
        .then([response](FetchResponse&& fetchResponse) mutable {
      writeFetchResponse(kj::mv(fetchResponse), response);
    });
  }
};

class IsolateUiViewImpl final: public UiView::Server {
public:
  explicit IsolateUiViewImpl(kj::Own<IsolateRuntimeConfig> runtimeConfig)
      : runtimeConfig(kj::mv(runtimeConfig)) {}

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
            kj::addRef(*runtimeConfig), pathPrefix, SessionKind::NORMAL, kj::mv(sessionMetadata)));
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
        kj::addRef(*runtimeConfig), "", SessionKind::REQUEST, kj::mv(sessionMetadata)));
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
        kj::addRef(*runtimeConfig), "", SessionKind::OFFER, kj::mv(sessionMetadata)));
    return kj::READY_NOW;
  }

private:
  kj::Own<IsolateRuntimeConfig> runtimeConfig;
};

class IsolateSupervisorImpl final: public Supervisor::Server {
public:
  IsolateSupervisorImpl(
      kj::StringPtr varPath, kj::Own<CapRedirector> coreRedirector,
      kj::Own<IsolateRuntimeConfig> runtimeConfig)
      : varPath(kj::heapString(varPath)), coreRedirector(kj::mv(coreRedirector)),
        runtimeConfig(kj::mv(runtimeConfig)) {}

  kj::Promise<void> getMainView(GetMainViewContext context) override {
    context.getResults().setView(kj::heap<IsolateUiViewImpl>(kj::addRef(*runtimeConfig)));
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
    _exit(0);
  }

  kj::Promise<void> restore(RestoreContext context) override {
    KJ_UNIMPLEMENTED("isolate grain capability restore is not implemented yet");
  }

  kj::Promise<void> drop(DropContext context) override {
    KJ_UNIMPLEMENTED("isolate grain capability drop is not implemented yet");
  }

  kj::Promise<void> watchLog(WatchLogContext context) override {
    KJ_UNIMPLEMENTED("isolate grain log watching is not implemented yet");
  }

  kj::Promise<void> getWwwFileHack(GetWwwFileHackContext context) override {
    context.getResults().setStatus(Supervisor::WwwFileStatus::NOT_FOUND);
    return kj::READY_NOW;
  }

private:
  kj::String varPath;
  kj::Own<CapRedirector> coreRedirector;
  kj::Own<IsolateRuntimeConfig> runtimeConfig;
};

}  // namespace

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

  auto runtimeConfig = loadIsolateRuntimeConfig(
      pkgPath, requestedMainModule, requestedCompatibilityDate);

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

  if (!keepStdio) {
    int log;
    KJ_SYSCALL(log = open(kj::str(varPath, "/log").cStr(),
        O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0660));
    KJ_SYSCALL(dup2(log, STDERR_FILENO));
    KJ_SYSCALL(close(log));
  }

  KJ_IF_MAYBE(u, sandboxUid) {
    KJ_SYSCALL(setuid(*u));
  }

  runtimeConfig->workerdBundleDir = prepareWorkerdBundle(varPath, *runtimeConfig);
  runtimeConfig->workerdSocketPath = kj::str(runtimeConfig->workerdBundleDir, "/workerd.sock");

  KJ_LOG(WARNING, "Starting isolate supervisor with workerd adapter skeleton.",
      grainId, pkgPath, runtimeConfig->mainModule, runtimeConfig->compatibilityDate,
      runtimeConfig->compatibilityFlags.size(), runtimeConfig->modules.size(),
      runtimeConfig->bindings.size(), runtimeConfig->workerdBundleDir,
      runtimeConfig->workerdSocketPath);

  auto ioContext = kj::setupAsyncIo();
  auto coreRedirector = kj::refcounted<CapRedirector>();
  Supervisor::Client mainCap = kj::heap<IsolateSupervisorImpl>(
      varPath, kj::addRef(*coreRedirector), kj::mv(runtimeConfig));
  auto listener = kj::heap<TwoPartyServerWithClientBootstrap>(
      kj::mv(mainCap), kj::mv(coreRedirector));

  auto socketPath = kj::str(varPath, "/socket");
  unlink(socketPath.cStr());

  auto address = ioContext.provider->getNetwork()
      .parseAddress(kj::str("unix:", socketPath), 0)
      .wait(ioContext.waitScope);
  auto serverPort = address->listen();

  KJ_SYSCALL(write(STDOUT_FILENO, "Listening...\n", strlen("Listening...\n")));

  listener->listen(kj::mv(serverPort)).wait(ioContext.waitScope);
  return true;
}

}  // namespace sandstorm
