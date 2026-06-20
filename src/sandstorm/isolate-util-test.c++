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

#include <kj/encoding.h>
#include <kj/test.h>

namespace sandstorm {
namespace {

class TestNativeAppRpcAdapter final: public NativeAppRpcJsonCapabilityAdapter {
public:
  void add(kj::String id, IsolateObjectCapability::Client capability) {
    caps.add(Cap {
      kj::mv(id),
      kj::mv(capability),
    });
  }

  kj::Maybe<IsolateObjectCapability::Client> findCapability(kj::StringPtr id) override {
    for (auto& cap: caps) {
      if (cap.id == id) {
        return cap.capability;
      }
    }
    return nullptr;
  }

  kj::String storeCapability(IsolateObjectCapability::Client capability) override {
    auto id = kj::str("stored-", nextId++);
    add(kj::str(id), kj::mv(capability));
    return id;
  }

private:
  struct Cap {
    kj::String id;
    IsolateObjectCapability::Client capability;
  };

  uint nextId = 0;
  kj::Vector<Cap> caps;
};

class EchoIsolateObjectCallTarget final: public IsolateObjectCallTarget {
public:
  kj::Promise<OwnedIsolateObjectCallResult> call(
      kj::String method, OwnedIsolateObjectCallArgs args) override {
    ++callCount;
    lastMethod = kj::mv(method);

    auto message = kj::heap<capnp::MallocMessageBuilder>();
    auto result = message->initRoot<IsolateObjectCallResult>();
    auto value = result.initValue();
    auto fields = value.initObject(2);
    fields[0].setName("method");
    fields[0].initValue().setText(lastMethod);
    fields[1].setName("argCount");
    fields[1].initValue().setNumber(args.getArgs().size());
    return OwnedIsolateObjectCallResult { kj::mv(message) };
  }

  kj::Promise<void> drop() override {
    ++dropCount;
    return kj::READY_NOW;
  }

  uint callCount = 0;
  uint dropCount = 0;
  kj::String lastMethod = kj::heapString("");
};

KJ_TEST("isolate package paths must be canonical and package-relative") {
  KJ_EXPECT(isCanonicalPackagePath("worker.js"));
  KJ_EXPECT(isCanonicalPackagePath("modules/worker.js"));
  KJ_EXPECT(isCanonicalPackagePath("a.b/c-d_e/file.json"));

  KJ_EXPECT(!isCanonicalPackagePath(""));
  KJ_EXPECT(!isCanonicalPackagePath("/worker.js"));
  KJ_EXPECT(!isCanonicalPackagePath("worker.js/"));
  KJ_EXPECT(!isCanonicalPackagePath("./worker.js"));
  KJ_EXPECT(!isCanonicalPackagePath("modules/../worker.js"));
  KJ_EXPECT(!isCanonicalPackagePath("modules//worker.js"));
  KJ_EXPECT(!isCanonicalPackagePath("modules/./worker.js"));
}

KJ_TEST("isolate storage keys are extracted and validated") {
  KJ_EXPECT(isolateStorageKeyFromUrl("/") == "");
  KJ_EXPECT(isolateStorageKeyFromUrl("/counter") == "counter");
  KJ_EXPECT(isolateStorageKeyFromUrl("///counter?ignored=true") == "counter");
  KJ_EXPECT(isolateStorageKeyFromUrl("/nested/path") == "nested/path");

  KJ_EXPECT(isValidIsolateStorageKey("counter"));
  KJ_EXPECT(isValidIsolateStorageKey("counter-1_2.name"));
  KJ_EXPECT(isValidIsolateStorageKey("ABCxyz012"));

  KJ_EXPECT(!isValidIsolateStorageKey(""));
  KJ_EXPECT(!isValidIsolateStorageKey(".hidden"));
  KJ_EXPECT(!isValidIsolateStorageKey("a..b"));
  KJ_EXPECT(!isValidIsolateStorageKey("../bad"));
  KJ_EXPECT(!isValidIsolateStorageKey("bad/key"));
  KJ_EXPECT(!isValidIsolateStorageKey("bad key"));

  kj::Vector<char> longKeyChars;
  for (size_t i = 0; i < 129; ++i) {
    longKeyChars.add('a');
  }
  longKeyChars.add('\0');
  auto longKey = kj::String(longKeyChars.releaseAsArray());
  KJ_EXPECT(!isValidIsolateStorageKey(longKey));
}

KJ_TEST("isolate query parameters are percent-decoded") {
  KJ_EXPECT(decodeIsolateQueryComponent("simple") == "simple");
  KJ_EXPECT(decodeIsolateQueryComponent("a%20b+c") == "a b c");
  KJ_EXPECT(decodeIsolateQueryComponent("view%2Cedit") == "view,edit");
  KJ_EXPECT_THROW_MESSAGE(
      "malformed isolate query parameter encoding", decodeIsolateQueryComponent("bad%xxescape"));

  auto token = findIsolateQueryParam(
      "/powerbox/claim-request?sessionId=session%2Fone&token=req%2Btoken%3D%3D",
      "token");
  KJ_IF_MAYBE(value, token) {
    KJ_EXPECT(*value == "req+token==");
  } else {
    KJ_FAIL_ASSERT("expected token query parameter");
  }

  auto encodedValue = findIsolateQueryParam(
      "/powerbox/claim-request?encoded=view%2Cedit&token=ignored",
      "encoded");
  KJ_IF_MAYBE(value, encodedValue) {
    KJ_EXPECT(*value == "view,edit");
  } else {
    KJ_FAIL_ASSERT("expected encoded query parameter");
  }

  auto repeatedPermissions = findIsolateQueryParams(
      "/powerbox/claim-request?requiredPermission=view&requiredPermission=edit%2Bshare",
      "requiredPermission");
  KJ_EXPECT(repeatedPermissions.size() == 2);
  KJ_EXPECT(repeatedPermissions[0] == "view");
  KJ_EXPECT(repeatedPermissions[1] == "edit+share");

  KJ_EXPECT(findIsolateQueryParam("/powerbox/claim-request?token=present", "missing") == nullptr);
  KJ_EXPECT_THROW_MESSAGE(
      "invalid URL", findIsolateQueryParam("/powerbox/claim-request?token=bad%xxescape", "token"));
}

KJ_TEST("isolate response helper detects structured headers") {
  KJ_EXPECT(isolateEqualsIgnoreCase("Content-Type", "content-type"));
  KJ_EXPECT(!isolateEqualsIgnoreCase("Content-Type", "content-length"));

  KJ_EXPECT(isStructuredIsolateResponseHeader("Content-Type"));
  KJ_EXPECT(isStructuredIsolateResponseHeader("Content-Encoding"));
  KJ_EXPECT(isStructuredIsolateResponseHeader("Content-Disposition"));
  KJ_EXPECT(isStructuredIsolateResponseHeader("content-length"));
  KJ_EXPECT(isStructuredIsolateResponseHeader("Transfer-Encoding"));
  KJ_EXPECT(isStructuredIsolateResponseHeader("Connection"));
  KJ_EXPECT(isStructuredIsolateResponseHeader("Cache-Control"));
  KJ_EXPECT(isStructuredIsolateResponseHeader("ETag"));
  KJ_EXPECT(!isStructuredIsolateResponseHeader("X-Frame-Options"));
}

KJ_TEST("isolate response helper detects HTML MIME type") {
  KJ_EXPECT(isHtmlMimeType("text/html"));
  KJ_EXPECT(isHtmlMimeType("Text/HTML"));
  KJ_EXPECT(isHtmlMimeType(" text/html ; charset=utf-8 "));

  KJ_EXPECT(!isHtmlMimeType("application/json"));
  KJ_EXPECT(!isHtmlMimeType("application/xhtml+xml"));
  KJ_EXPECT(!isHtmlMimeType("text/plain; charset=utf-8"));
}

KJ_TEST("native app RPC JSON codec preserves data and capability slots") {
  kj::EventLoop loop;
  kj::WaitScope waitScope(loop);

  auto target = kj::heap<EchoIsolateObjectCallTarget>();
  auto targetPtr = target.get();
  auto capability = makeIsolateObjectCapability(kj::mv(target));

  TestNativeAppRpcAdapter adapter;
  adapter.add(kj::str("slot-1"), capability);

  auto callJson = kj::heapString(
      "{\"method\":\"deliver\",\"args\":["
      "{\"type\":\"data\",\"value\":\"aGVsbG8\"},"
      "{\"type\":\"capability\",\"value\":{\"id\":\"slot-1\",\"nativeInterface\":\"appObject\"}}"
      "]}");
  auto call = parseWorkerAppObjectCallJson(callJson.asBytes(), adapter, 32);
  KJ_EXPECT(call.method == "deliver");

  auto args = call.args.getArgs();
  KJ_ASSERT(args.size() == 2);
  KJ_ASSERT(args[0].which() == IsolateObjectCallValue::DATA);
  KJ_EXPECT(kj::str(kj::ArrayPtr<const char>(
      reinterpret_cast<const char*>(args[0].getData().begin()), args[0].getData().size())) ==
      "hello");
  KJ_ASSERT(args[1].which() == IsolateObjectCallValue::CAPABILITY);

  auto callbackResult = callIsolateObjectCapability(
      args[1].getCapability(), "callback", args).wait(waitScope);
  KJ_EXPECT(targetPtr->callCount == 1);
  KJ_EXPECT(targetPtr->lastMethod == "callback");
  auto callbackValue = callbackResult.getResult().getValue().getObject();
  KJ_EXPECT(callbackValue[0].getValue().getText() == "callback");
  KJ_EXPECT(callbackValue[1].getValue().getNumber() == 2);

  capnp::MallocMessageBuilder resultMessage;
  auto result = resultMessage.initRoot<IsolateObjectCallResult>();
  auto fields = result.initValue().initObject(2);
  fields[0].setName("payload");
  fields[0].initValue().setData(kj::ArrayPtr<const kj::byte>(
      reinterpret_cast<const kj::byte*>("ok"), 2));
  fields[1].setName("callback");
  fields[1].initValue().setCapability(args[1].getCapability());

  auto resultJson = renderWorkerAppObjectResultJson(result, adapter);
  KJ_EXPECT(resultJson == kj::StringPtr(
      "{\"type\":\"value\",\"value\":{\"type\":\"object\",\"value\":["
      "{\"name\":\"payload\",\"value\":{\"type\":\"data\",\"value\":\"b2s\"}},"
      "{\"name\":\"callback\",\"value\":{\"type\":\"capability\",\"value\":"
      "{\"id\":\"stored-0\",\"nativeInterface\":\"appObject\"}}}]}}"));

  KJ_EXPECT_THROW_MESSAGE(
      "native app RPC data value must be base64url text",
      parseWorkerAppObjectCallJson(
          kj::StringPtr("{\"method\":\"bad\",\"args\":[{\"type\":\"data\",\"value\":\"!!!\"}]}")
              .asBytes(),
          adapter, 32));
  KJ_EXPECT_THROW_MESSAGE(
      "unknown claimed capability in native app RPC argument",
      parseWorkerAppObjectCallJson(
          kj::StringPtr(
              "{\"method\":\"bad\",\"args\":[{\"type\":\"capability\",\"value\":{\"id\":\"missing\"}}]}")
              .asBytes(),
          adapter, 32));
}

}  // namespace
}  // namespace sandstorm
