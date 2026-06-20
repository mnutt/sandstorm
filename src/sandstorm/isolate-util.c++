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

#include <capnp/compat/json.h>
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

kj::Maybe<kj::Array<byte>> decodeWorkerAppObjectBase64Url(
    kj::StringPtr text, size_t maxSize) {
  if (text.size() > maxSize * 4 / 3 + 4) {
    return nullptr;
  }

  size_t padding = (4 - (text.size() % 4)) % 4;
  auto base64 = kj::heapArray<char>(text.size() + padding);
  for (auto i: kj::indices(text)) {
    char c = text[i];
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
        (c >= '0' && c <= '9')) {
      base64[i] = c;
    } else if (c == '-') {
      base64[i] = '+';
    } else if (c == '_') {
      base64[i] = '/';
    } else {
      return nullptr;
    }
  }
  for (size_t i = text.size(); i < base64.size(); ++i) {
    base64[i] = '=';
  }

  auto decoded = kj::decodeBase64(base64.asPtr());
  if (decoded.hadErrors || decoded.size() > maxSize) {
    return nullptr;
  }
  return kj::mv(decoded);
}

kj::StringPtr requireJsonString(capnp::JsonValue::Reader value, kj::StringPtr name) {
  KJ_REQUIRE(value.which() == capnp::JsonValue::STRING,
      "native app RPC JSON field must be a string", name);
  return value.getString();
}

class WorkerAppObjectDataJsonHandler final: public capnp::JsonCodec::Handler<capnp::Data> {
public:
  explicit WorkerAppObjectDataJsonHandler(size_t maxDataBytes): maxDataBytes(maxDataBytes) {}

  void encode(const capnp::JsonCodec& codec, capnp::Data::Reader input,
              capnp::JsonValue::Builder output) const override {
    (void)codec;
    output.setString(kj::encodeBase64Url(input));
  }

  capnp::Orphan<capnp::Data> decode(
      const capnp::JsonCodec& codec, capnp::JsonValue::Reader input,
      capnp::Orphanage orphanage) const override {
    (void)codec;
    auto encoded = requireJsonString(input, "data");
    KJ_IF_MAYBE(decoded, decodeWorkerAppObjectBase64Url(encoded, maxDataBytes)) {
      return orphanage.newOrphanCopy(capnp::Data::Reader(*decoded));
    } else {
      KJ_FAIL_REQUIRE("native app RPC data value must be base64url text");
    }
  }

private:
  size_t maxDataBytes;
};

class WorkerAppObjectCapabilityJsonHandler final
    : public capnp::JsonCodec::Handler<IsolateObjectCapability> {
public:
  explicit WorkerAppObjectCapabilityJsonHandler(WorkerAppObjectJsonCapabilityAdapter& adapter)
      : adapter(adapter) {}

  void encode(const capnp::JsonCodec& codec, IsolateObjectCapability::Client input,
              capnp::JsonValue::Builder output) const override {
    (void)codec;
    auto id = adapter.storeCapability(kj::mv(input));
    auto fields = output.initObject(2);
    fields[0].setName("id");
    fields[0].initValue().setString(id);
    fields[1].setName("nativeInterface");
    fields[1].initValue().setString("appObject");
  }

  IsolateObjectCapability::Client decode(
      const capnp::JsonCodec& codec, capnp::JsonValue::Reader input) const override {
    (void)codec;
    KJ_REQUIRE(input.which() == capnp::JsonValue::OBJECT,
        "native app RPC capability value must be an object");
    for (auto field: input.getObject()) {
      if (field.getName() == "id") {
        auto id = requireJsonString(field.getValue(), "id");
        KJ_IF_MAYBE(cap, adapter.findCapability(id)) {
          return *cap;
        }
        KJ_FAIL_REQUIRE("unknown claimed capability in native app RPC argument", id);
      }
    }
    KJ_FAIL_REQUIRE("native app RPC capability value is missing required field", "id");
  }

private:
  WorkerAppObjectJsonCapabilityAdapter& adapter;
};

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

OwnedWorkerAppObjectCall parseWorkerAppObjectCallJson(
    kj::ArrayPtr<const kj::byte> body, WorkerAppObjectJsonCapabilityAdapter& adapter,
    size_t maxDataBytes) {
  WorkerAppObjectDataJsonHandler dataHandler(maxDataBytes);
  WorkerAppObjectCapabilityJsonHandler capabilityHandler(adapter);
  capnp::JsonCodec codec;
  codec.addTypeHandler(dataHandler);
  codec.addTypeHandler(capabilityHandler);
  codec.handleByAnnotation<NativeAppRpcCall>();
  codec.handleByAnnotation<IsolateObjectCallValue>();

  auto callMessage = kj::heap<capnp::MallocMessageBuilder>();
  auto call = callMessage->initRoot<NativeAppRpcCall>();
  codec.decode(body.asChars(), call);

  auto argsMessage = kj::heap<capnp::MallocMessageBuilder>();
  auto args = argsMessage->initRoot<capnp::List<IsolateObjectCallValue>>(call.getArgs().size());
  for (auto i: kj::indices(call.getArgs())) {
    copyIsolateObjectCallValue(call.getArgs()[i], args[i]);
  }
  return OwnedWorkerAppObjectCall {
    kj::str(call.getMethod()),
    OwnedIsolateObjectCallArgs { kj::mv(argsMessage) },
  };
}

kj::String renderWorkerAppObjectCallJson(
    kj::StringPtr method, capnp::List<IsolateObjectCallValue>::Reader args,
    WorkerAppObjectJsonCapabilityAdapter& adapter) {
  WorkerAppObjectDataJsonHandler dataHandler(kj::maxValue);
  WorkerAppObjectCapabilityJsonHandler capabilityHandler(adapter);
  capnp::JsonCodec codec;
  codec.addTypeHandler(dataHandler);
  codec.addTypeHandler(capabilityHandler);
  codec.handleByAnnotation<NativeAppRpcCall>();
  codec.handleByAnnotation<IsolateObjectCallValue>();

  capnp::MallocMessageBuilder message;
  auto call = message.initRoot<NativeAppRpcCall>();
  call.setMethod(method);
  auto callArgs = call.initArgs(args.size());
  for (auto i: kj::indices(args)) {
    copyIsolateObjectCallValue(args[i], callArgs[i]);
  }
  return codec.encode(call.asReader());
}

OwnedIsolateObjectCallResult parseWorkerAppObjectResultJson(
    kj::ArrayPtr<const kj::byte> body, WorkerAppObjectJsonCapabilityAdapter& adapter,
    size_t maxDataBytes) {
  WorkerAppObjectDataJsonHandler dataHandler(maxDataBytes);
  WorkerAppObjectCapabilityJsonHandler capabilityHandler(adapter);
  capnp::JsonCodec codec;
  codec.addTypeHandler(dataHandler);
  codec.addTypeHandler(capabilityHandler);
  codec.handleByAnnotation<IsolateObjectCallResult>();
  codec.handleByAnnotation<IsolateObjectCallValue>();

  auto resultMessage = kj::heap<capnp::MallocMessageBuilder>();
  auto result = resultMessage->initRoot<IsolateObjectCallResult>();
  codec.decode(body.asChars(), result);

  auto copiedMessage = kj::heap<capnp::MallocMessageBuilder>();
  copyIsolateObjectCallResult(result.asReader(),
      copiedMessage->initRoot<IsolateObjectCallResult>());
  return OwnedIsolateObjectCallResult { kj::mv(copiedMessage) };
}

kj::String renderWorkerAppObjectResultJson(
    IsolateObjectCallResult::Reader result, WorkerAppObjectJsonCapabilityAdapter& adapter) {
  WorkerAppObjectDataJsonHandler dataHandler(kj::maxValue);
  WorkerAppObjectCapabilityJsonHandler capabilityHandler(adapter);
  capnp::JsonCodec codec;
  codec.addTypeHandler(dataHandler);
  codec.addTypeHandler(capabilityHandler);
  codec.handleByAnnotation<IsolateObjectCallResult>();
  codec.handleByAnnotation<IsolateObjectCallValue>();
  return codec.encode(result);
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
