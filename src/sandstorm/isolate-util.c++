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

#include "isolate-util.h"
#include "util.h"

#include <kj/compat/http.h>
#include <kj/compat/url.h>
#include <kj/encoding.h>

namespace sandstorm {
namespace {

const kj::HttpHeaderTable& getStructuredResponseHeaderTable() {
  static const kj::Own<kj::HttpHeaderTable> table = []() {
    kj::HttpHeaderTable::Builder builder;
    builder.add("Content-Encoding");
    builder.add("Content-Language");
    builder.add("Content-Disposition");
    builder.add("Cache-Control");
    builder.add("ETag");
    return builder.build();
  }();
  return *table;
}

}  // namespace

class IsolateObjectCapabilityServer final: public IsolateObjectCapability::Server {
public:
  explicit IsolateObjectCapabilityServer(kj::Own<IsolateObjectCallTarget> target)
      : target(kj::mv(target)) {}

  kj::Promise<void> call(CallContext context) override {
    auto params = context.getParams();
    auto method = kj::str(params.getMethod());
    auto args = copyIsolateObjectCallArgs(params.getArgs());
    return target->call(kj::mv(method), kj::mv(args))
        .then([context](OwnedIsolateObjectCallResult&& result) mutable {
      copyIsolateObjectCallResult(result.getResult(), context.getResults().initResult());
    });
  }

  kj::Promise<void> drop(DropContext context) override {
    (void)context;
    return target->drop();
  }

private:
  kj::Own<IsolateObjectCallTarget> target;
};

class ImportedIsolateObjectCallTarget final: public IsolateObjectCallTarget {
public:
  explicit ImportedIsolateObjectCallTarget(IsolateObjectCapability::Client capability)
      : capability(kj::mv(capability)) {}

  kj::Promise<OwnedIsolateObjectCallResult> call(
      kj::String method, OwnedIsolateObjectCallArgs args) override {
    auto argReader = args.getArgs();
    return callIsolateObjectCapability(capability, method, argReader);
  }

  kj::Promise<void> drop() override {
    return capability.dropRequest().send().ignoreResult();
  }

private:
  IsolateObjectCapability::Client capability;
};

capnp::List<IsolateObjectCallValue>::Reader OwnedIsolateObjectCallArgs::getArgs() {
  return message->getRoot<capnp::List<IsolateObjectCallValue>>().asReader();
}

IsolateObjectCallResult::Reader OwnedIsolateObjectCallResult::getResult() {
  return message->getRoot<IsolateObjectCallResult>().asReader();
}

kj::Promise<void> IsolateObjectCallTarget::drop() {
  return kj::READY_NOW;
}

RegisteredIsolateObjectCapability IsolateObjectCapabilityTable::exportTarget(
    kj::Own<IsolateObjectCallTarget> target) {
  auto id = nextId(IsolateObjectCapabilityTableEntryKind::EXPORTED);
  auto capability = makeIsolateObjectCapability(kj::mv(target));
  auto resultCapability = capability;
  entries.add(Entry {
    kj::str(id),
    IsolateObjectCapabilityTableEntryKind::EXPORTED,
    kj::mv(capability),
  });
  return RegisteredIsolateObjectCapability { kj::mv(id), kj::mv(resultCapability) };
}

RegisteredIsolateObjectCapability IsolateObjectCapabilityTable::importCapability(
    IsolateObjectCapability::Client capability) {
  auto id = nextId(IsolateObjectCapabilityTableEntryKind::IMPORTED);
  auto localCapability = makeIsolateObjectCapability(
      makeImportedIsolateObjectCallTarget(kj::mv(capability)));
  auto resultCapability = localCapability;
  entries.add(Entry {
    kj::str(id),
    IsolateObjectCapabilityTableEntryKind::IMPORTED,
    kj::mv(localCapability),
  });
  return RegisteredIsolateObjectCapability { kj::mv(id), kj::mv(resultCapability) };
}

kj::Maybe<IsolateObjectCapability::Client> IsolateObjectCapabilityTable::find(kj::StringPtr id) {
  KJ_IF_MAYBE(index, findIndex(id)) {
    return entries[*index].capability;
  }
  return nullptr;
}

kj::Maybe<IsolateObjectCapabilityTableEntryInfo> IsolateObjectCapabilityTable::findInfo(
    kj::StringPtr id) const {
  KJ_IF_MAYBE(index, findIndex(id)) {
    return IsolateObjectCapabilityTableEntryInfo {
      entries[*index].kind,
    };
  }
  return nullptr;
}

kj::Promise<bool> IsolateObjectCapabilityTable::drop(kj::StringPtr id) {
  KJ_IF_MAYBE(index, findIndex(id)) {
    auto entry = remove(*index);
    return entry.capability.dropRequest().send().then([](auto&&) { return true; });
  }
  return false;
}

kj::Promise<uint> IsolateObjectCapabilityTable::dropAll() {
  kj::Vector<kj::Promise<void>> drops;
  while (entries.size() > 0) {
    auto entry = remove(entries.size() - 1);
    drops.add(entry.capability.dropRequest().send().ignoreResult());
  }

  uint dropCount = drops.size();
  return kj::joinPromises(drops.releaseAsArray()).then([dropCount]() {
    return dropCount;
  });
}

IsolateObjectCapabilityTableStats IsolateObjectCapabilityTable::stats() const {
  IsolateObjectCapabilityTableStats result;
  result.totalCount = entries.size();
  for (auto& entry: entries) {
    switch (entry.kind) {
      case IsolateObjectCapabilityTableEntryKind::EXPORTED:
        ++result.exportedCount;
        break;
      case IsolateObjectCapabilityTableEntryKind::IMPORTED:
        ++result.importedCount;
        break;
    }
  }
  return result;
}

kj::String IsolateObjectCapabilityTable::nextId(IsolateObjectCapabilityTableEntryKind kind) {
  switch (kind) {
    case IsolateObjectCapabilityTableEntryKind::EXPORTED:
      return kj::str("native-export-", nextExportId++);
    case IsolateObjectCapabilityTableEntryKind::IMPORTED:
      return kj::str("native-import-", nextImportId++);
  }
  KJ_UNREACHABLE;
}

kj::Maybe<uint> IsolateObjectCapabilityTable::findIndex(kj::StringPtr id) const {
  for (auto i: kj::indices(entries)) {
    if (entries[i].id == id) {
      return i;
    }
  }
  return nullptr;
}

IsolateObjectCapabilityTable::Entry IsolateObjectCapabilityTable::remove(uint index) {
  KJ_REQUIRE(index < entries.size(), index, entries.size());
  auto result = kj::mv(entries[index]);
  if (index + 1 < entries.size()) {
    entries[index] = kj::mv(entries.back());
  }
  entries.removeLast();
  return result;
}

OwnedIsolateObjectCallArgs copyIsolateObjectCallArgs(
    capnp::List<IsolateObjectCallValue>::Reader source) {
  auto message = kj::heap<capnp::MallocMessageBuilder>();
  auto args = message->initRoot<capnp::List<IsolateObjectCallValue>>(source.size());
  for (auto i: kj::indices(source)) {
    copyIsolateObjectCallValue(source[i], args[i]);
  }
  return OwnedIsolateObjectCallArgs { kj::mv(message) };
}

void copyIsolateObjectCallValue(
    IsolateObjectCallValue::Reader source, IsolateObjectCallValue::Builder target) {
  switch (source.which()) {
    case IsolateObjectCallValue::NULL_:
      target.setNull();
      break;
    case IsolateObjectCallValue::BOOL:
      target.setBool(source.getBool());
      break;
    case IsolateObjectCallValue::NUMBER:
      target.setNumber(source.getNumber());
      break;
    case IsolateObjectCallValue::TEXT:
      target.setText(source.getText());
      break;
    case IsolateObjectCallValue::DATA:
      target.setData(source.getData());
      break;
    case IsolateObjectCallValue::LIST: {
      auto sourceList = source.getList();
      auto targetList = target.initList(sourceList.size());
      for (auto i: kj::indices(sourceList)) {
        copyIsolateObjectCallValue(sourceList[i], targetList[i]);
      }
      break;
    }
    case IsolateObjectCallValue::OBJECT: {
      auto sourceFields = source.getObject();
      auto targetFields = target.initObject(sourceFields.size());
      for (auto i: kj::indices(sourceFields)) {
        targetFields[i].setName(sourceFields[i].getName());
        copyIsolateObjectCallValue(sourceFields[i].getValue(), targetFields[i].initValue());
      }
      break;
    }
    case IsolateObjectCallValue::CAPABILITY:
      target.setCapability(source.getCapability());
      break;
  }
}

void copyIsolateObjectCallResult(
    IsolateObjectCallResult::Reader source, IsolateObjectCallResult::Builder target) {
  switch (source.which()) {
    case IsolateObjectCallResult::VALUE:
      copyIsolateObjectCallValue(source.getValue(), target.initValue());
      break;
    case IsolateObjectCallResult::EXCEPTION: {
      auto sourceException = source.getException();
      auto targetException = target.initException();
      targetException.setName(sourceException.getName());
      targetException.setMessage(sourceException.getMessage());
      targetException.setStack(sourceException.getStack());
      break;
    }
  }
}

IsolateObjectCapability::Client makeIsolateObjectCapability(
    kj::Own<IsolateObjectCallTarget> target) {
  return kj::heap<IsolateObjectCapabilityServer>(kj::mv(target));
}

kj::Own<IsolateObjectCallTarget> makeImportedIsolateObjectCallTarget(
    IsolateObjectCapability::Client capability) {
  return kj::heap<ImportedIsolateObjectCallTarget>(kj::mv(capability));
}

kj::Promise<OwnedIsolateObjectCallResult> callIsolateObjectCapability(
    IsolateObjectCapability::Client capability, kj::StringPtr method,
    capnp::List<IsolateObjectCallValue>::Reader args) {
  auto request = capability.callRequest();
  request.setMethod(method);
  auto requestArgs = request.initArgs(args.size());
  for (auto i: kj::indices(args)) {
    copyIsolateObjectCallValue(args[i], requestArgs[i]);
  }

  return request.send().then([](auto response) mutable {
    auto message = kj::heap<capnp::MallocMessageBuilder>();
    copyIsolateObjectCallResult(response.getResult(), message->initRoot<IsolateObjectCallResult>());
    return OwnedIsolateObjectCallResult { kj::mv(message) };
  });
}

bool isCanonicalPackagePath(kj::StringPtr path) {
  if (path.size() == 0 || path.startsWith("/") || path.endsWith("/")) {
    return false;
  }

  size_t start = 0;
  for (size_t i = 0; i <= path.size(); ++i) {
    if (i == path.size() || path[i] == '/') {
      auto part = path.slice(start, i);
      if (part.size() == 0 ||
          (part.size() == 1 && part[0] == '.') ||
          (part.size() == 2 && part[0] == '.' && part[1] == '.')) {
        return false;
      }
      start = i + 1;
    }
  }

  return true;
}

kj::String isolateStorageKeyFromUrl(kj::StringPtr url) {
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

bool isValidIsolateStorageKey(kj::StringPtr key) {
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

kj::String decodeIsolateQueryComponent(kj::StringPtr value) {
  return KJ_REQUIRE_NONNULL(kj::decodeWwwForm(value),
      "malformed isolate query parameter encoding", value);
}

kj::Array<kj::String> findIsolateQueryParams(kj::StringPtr url, kj::StringPtr name) {
  kj::Vector<kj::String> results;
  auto parsed = kj::Url::parse(url, kj::Url::HTTP_REQUEST);
  for (auto& param: parsed.query) {
    if (param.name == name && param.value.begin() != nullptr) {
      results.add(kj::str(param.value));
    }
  }

  return results.releaseAsArray();
}

kj::Maybe<kj::String> findIsolateQueryParam(kj::StringPtr url, kj::StringPtr name) {
  auto parsed = kj::Url::parse(url, kj::Url::HTTP_REQUEST);
  for (auto& param: parsed.query) {
    if (param.name == name && param.value.begin() != nullptr) {
      return kj::str(param.value);
    }
  }

  return nullptr;
}

bool isolateEqualsIgnoreCase(kj::StringPtr a, kj::StringPtr b) {
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

bool isStructuredIsolateResponseHeader(kj::StringPtr name) {
  return getStructuredResponseHeaderTable().stringToId(name) != nullptr;
}

bool isHtmlMimeType(kj::StringPtr mimeType) {
  auto type = trimArray(mimeType);
  auto typeString = kj::StringPtr(type.begin(), type.size());
  KJ_IF_MAYBE(semi, typeString.findFirst(';')) {
    type = type.slice(0, *semi);
  }
  type = trimArray(type);
  return isolateEqualsIgnoreCase(kj::StringPtr(type.begin(), type.size()), "text/html");
}

}  // namespace sandstorm
