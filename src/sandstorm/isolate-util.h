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

struct OwnedWorkerAppObjectCall {
  kj::String method;
  OwnedIsolateObjectCallArgs args;
};

class IsolateObjectCallTarget {
public:
  virtual ~IsolateObjectCallTarget() noexcept(false) {}

  virtual kj::Promise<OwnedIsolateObjectCallResult> call(
      kj::String method, OwnedIsolateObjectCallArgs args) = 0;
  virtual kj::Promise<bool> drop();
};

class WorkerAppObjectJsonCapabilityAdapter {
public:
  virtual ~WorkerAppObjectJsonCapabilityAdapter() noexcept(false) {}

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
OwnedWorkerAppObjectCall parseWorkerAppObjectCallJson(
    kj::ArrayPtr<const kj::byte> body, WorkerAppObjectJsonCapabilityAdapter& adapter,
    size_t maxDataBytes);
kj::String renderWorkerAppObjectCallJson(
    kj::StringPtr method, capnp::List<IsolateObjectCallValue>::Reader args,
    WorkerAppObjectJsonCapabilityAdapter& adapter);
OwnedIsolateObjectCallResult parseWorkerAppObjectResultJson(
    kj::ArrayPtr<const kj::byte> body, WorkerAppObjectJsonCapabilityAdapter& adapter,
    size_t maxDataBytes);
kj::String renderWorkerAppObjectResultJson(
    IsolateObjectCallResult::Reader result, WorkerAppObjectJsonCapabilityAdapter& adapter);
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
