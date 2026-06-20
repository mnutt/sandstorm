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

#ifndef SANDSTORM_ISOLATE_UTIL_H_
#define SANDSTORM_ISOLATE_UTIL_H_

#include <capnp/message.h>
#include <kj/async.h>
#include <kj/string.h>
#include <kj/vector.h>
#include <sandstorm/isolate-supervisor-internal.capnp.h>

namespace sandstorm {

struct OwnedIsolateObjectCallArgs {
  kj::Own<capnp::MallocMessageBuilder> message;

  capnp::List<IsolateObjectCallValue>::Reader getArgs();
};

struct OwnedIsolateObjectCallResult {
  kj::Own<capnp::MallocMessageBuilder> message;

  IsolateObjectCallResult::Reader getResult();
};

struct OwnedNativeAppRpcCall {
  kj::String method;
  OwnedIsolateObjectCallArgs args;
};

class IsolateObjectCallTarget {
public:
  virtual ~IsolateObjectCallTarget() noexcept(false) {}

  virtual kj::Promise<OwnedIsolateObjectCallResult> call(
      kj::String method, OwnedIsolateObjectCallArgs args) = 0;
  virtual kj::Promise<void> drop();
};

enum class IsolateObjectCapabilityTableEntryKind {
  EXPORTED,
  IMPORTED,
};

struct RegisteredIsolateObjectCapability {
  kj::String id;
  IsolateObjectCapability::Client capability;
};

struct IsolateObjectCapabilityTableStats {
  uint totalCount = 0;
  uint exportedCount = 0;
  uint importedCount = 0;
};

struct IsolateObjectCapabilityTableEntryInfo {
  IsolateObjectCapabilityTableEntryKind kind;
};

class IsolateObjectCapabilityTable {
public:
  IsolateObjectCapabilityTable() = default;
  IsolateObjectCapabilityTable(const IsolateObjectCapabilityTable&) = delete;
  IsolateObjectCapabilityTable& operator=(const IsolateObjectCapabilityTable&) = delete;
  IsolateObjectCapabilityTable(IsolateObjectCapabilityTable&&) = delete;
  IsolateObjectCapabilityTable& operator=(IsolateObjectCapabilityTable&&) = delete;

  RegisteredIsolateObjectCapability exportTarget(kj::Own<IsolateObjectCallTarget> target);
  RegisteredIsolateObjectCapability importCapability(IsolateObjectCapability::Client capability);
  kj::Maybe<IsolateObjectCapability::Client> find(kj::StringPtr id);
  kj::Maybe<IsolateObjectCapabilityTableEntryInfo> findInfo(kj::StringPtr id) const;
  kj::Promise<bool> drop(kj::StringPtr id);
  kj::Promise<uint> dropAll();
  IsolateObjectCapabilityTableStats stats() const;

private:
  struct Entry {
    kj::String id;
    IsolateObjectCapabilityTableEntryKind kind;
    IsolateObjectCapability::Client capability;
  };

  kj::String nextId(IsolateObjectCapabilityTableEntryKind kind);
  kj::Maybe<uint> findIndex(kj::StringPtr id) const;
  Entry remove(uint index);

  uint nextExportId = 0;
  uint nextImportId = 0;
  kj::Vector<Entry> entries;
};

class NativeAppRpcJsonCapabilityAdapter {
public:
  virtual ~NativeAppRpcJsonCapabilityAdapter() noexcept(false) {}

  virtual kj::Maybe<IsolateObjectCapability::Client> findCapability(kj::StringPtr id) = 0;
  virtual kj::String storeCapability(IsolateObjectCapability::Client capability) = 0;
};

OwnedIsolateObjectCallArgs copyIsolateObjectCallArgs(
    capnp::List<IsolateObjectCallValue>::Reader source);
void copyIsolateObjectCallValue(
    IsolateObjectCallValue::Reader source, IsolateObjectCallValue::Builder target);
void copyIsolateObjectCallResult(
    IsolateObjectCallResult::Reader source, IsolateObjectCallResult::Builder target);
IsolateObjectCapability::Client makeIsolateObjectCapability(
    kj::Own<IsolateObjectCallTarget> target);
kj::Own<IsolateObjectCallTarget> makeImportedIsolateObjectCallTarget(
    IsolateObjectCapability::Client capability);
kj::Promise<OwnedIsolateObjectCallResult> callIsolateObjectCapability(
    IsolateObjectCapability::Client capability, kj::StringPtr method,
    capnp::List<IsolateObjectCallValue>::Reader args);
OwnedNativeAppRpcCall parseNativeAppRpcJsonCall(
    kj::ArrayPtr<const kj::byte> body, NativeAppRpcJsonCapabilityAdapter& adapter,
    size_t maxDataBytes);
kj::String renderNativeAppRpcJsonResult(
    IsolateObjectCallResult::Reader result, NativeAppRpcJsonCapabilityAdapter& adapter);
bool isCanonicalPackagePath(kj::StringPtr path);
kj::String isolateStorageKeyFromUrl(kj::StringPtr url);
bool isValidIsolateStorageKey(kj::StringPtr key);
kj::String decodeIsolateQueryComponent(kj::StringPtr value);
kj::Maybe<kj::String> findIsolateQueryParam(kj::StringPtr url, kj::StringPtr name);
kj::Array<kj::String> findIsolateQueryParams(kj::StringPtr url, kj::StringPtr name);
bool isolateEqualsIgnoreCase(kj::StringPtr a, kj::StringPtr b);
bool isStructuredIsolateResponseHeader(kj::StringPtr name);
bool isHtmlMimeType(kj::StringPtr mimeType);

}  // namespace sandstorm

#endif  // SANDSTORM_ISOLATE_UTIL_H_
