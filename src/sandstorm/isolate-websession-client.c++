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

#include <capnp/rpc-twoparty.h>
#include <kj/async-io.h>
#include <kj/debug.h>
#include <kj/encoding.h>
#include <kj/main.h>
#include <sandstorm/util.h>
#include <sandstorm/api-session.capnp.h>
#include <sandstorm/grain.capnp.h>
#include <sandstorm/identity.capnp.h>
#include <sandstorm/isolate-supervisor-internal.capnp.h>
#include <sandstorm/outbound-http-session.capnp.h>
#include <sandstorm/supervisor.capnp.h>
#include <sandstorm/util.capnp.h>
#include <sandstorm/web-session.capnp.h>

#include <fcntl.h>
#include <stdlib.h>
#include <unistd.h>

#include "isolate-util.h"

namespace sandstorm {

constexpr const char* ISOLATE_ROUTE_BACKED_APP_REF_PREFIX =
    "sandstorm-isolate-route-backed-v1\n";
constexpr uint64_t TEST_PROVIDER_TAG_ID = 0xdf9518c9479ddfcbull;

static_assert(capnp::typeId<IsolateObjectCapability>() == 0xd7a322498a996313,
    "IsolateObjectCapability schema ID changed");
static_assert(capnp::typeId<IsolateObjectCallValue>() == 0x976b1fa67593b262,
    "IsolateObjectCallValue schema ID changed");
static_assert(capnp::typeId<IsolateObjectCallResult>() == 0xdaea7034fe7730f4,
    "IsolateObjectCallResult schema ID changed");

bool contains(kj::StringPtr haystack, kj::StringPtr needle) {
  if (needle.size() > haystack.size()) {
    return false;
  }

  for (size_t i = 0; i <= haystack.size() - needle.size(); ++i) {
    if (haystack.slice(i).startsWith(needle)) {
      return true;
    }
  }

  return false;
}

kj::Maybe<kj::StringPtr> findResponseHeader(
    WebSession::Response::Reader response, kj::StringPtr name) {
  for (auto header: response.getAdditionalHeaders()) {
    if (header.getName() == name) {
      return header.getValue();
    }
  }

  return nullptr;
}

kj::Array<byte> makeBytes(size_t size) {
  auto result = kj::heapArray<byte>(size);
  for (auto i: kj::indices(result)) {
    result[i] = static_cast<byte>(i & 0xff);
  }
  return result;
}

kj::Array<byte> makeBytesAt(size_t size, uint64_t offset) {
  auto result = kj::heapArray<byte>(size);
  for (auto i: kj::indices(result)) {
    result[i] = static_cast<byte>((offset + i) & 0xff);
  }
  return result;
}

uint checksum(kj::ArrayPtr<const byte> data) {
  uint result = 0;
  for (auto b: data) {
    result = (result + b) & 0xffffffffu;
  }
  return result;
}

uint checksumPattern(uint64_t size) {
  constexpr uint64_t cycleSum = 32640;
  uint64_t cycles = size / 256;
  uint64_t remainder = size % 256;
  uint64_t result = cycles * cycleSum;
  for (uint64_t i = 0; i < remainder; ++i) {
    result += i;
  }
  return static_cast<uint>(result & 0xffffffffu);
}

bool stress64mEnabled() {
  char* value = getenv("ISOLATE_STRESS_64M");
  return value != nullptr && kj::StringPtr(value) == "1";
}

void expectSupervisorRefFailure(kj::WaitScope& waitScope, kj::Promise<void> promise) {
  try {
    promise.wait(waitScope);
    KJ_FAIL_REQUIRE("expected isolate supervisor persistent-ref call to fail");
  } catch (kj::Exception& exception) {
    auto description = exception.getDescription();
    KJ_REQUIRE(contains(description, "isolate supervisor-owned persistent object type"),
        description);
  }
}

void expectRoutePathFailure(kj::WaitScope& waitScope, kj::Promise<void> promise) {
  try {
    promise.wait(waitScope);
    KJ_FAIL_REQUIRE("expected route-backed session path call to fail");
  } catch (kj::Exception& exception) {
    auto description = exception.getDescription();
    KJ_REQUIRE(contains(description, "route-backed capability request path"),
        description);
  }
}

kj::String makeRouteBackedSessionAppRef(kj::StringPtr type, kj::StringPtr pathPrefix) {
  return kj::str(ISOLATE_ROUTE_BACKED_APP_REF_PREFIX, type, "\n", pathPrefix);
}

kj::String fakeCoreTokenStorePath(kj::StringPtr socketPath) {
  auto slash = KJ_ASSERT_NONNULL(socketPath.findLast('/'));
  return kj::str(socketPath.slice(0, slash), "/fake-core-tokens");
}

void writeTestFile(kj::StringPtr path, kj::ArrayPtr<const char> content) {
  auto pathString = kj::heapString(path);
  int fd;
  KJ_SYSCALL(fd = open(pathString.cStr(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600),
      pathString);
  KJ_DEFER(close(fd));

  auto remaining = content;
  while (remaining.size() > 0) {
    ssize_t n;
    KJ_SYSCALL(n = write(fd, remaining.begin(), remaining.size()));
    remaining = remaining.slice(n, remaining.size());
  }
}

class IgnoreByteStream final: public ByteStream::Server {
public:
  kj::Promise<void> write(WriteContext context) override {
    (void)context;
    return kj::READY_NOW;
  }
};

class CollectByteStream final: public ByteStream::Server {
public:
  kj::Promise<void> write(WriteContext context) override {
    data.addAll(context.getParams().getData());
    return kj::READY_NOW;
  }

  kj::Promise<void> done(DoneContext context) override {
    doneCalled = true;
    return kj::READY_NOW;
  }

  void waitForDone(kj::AsyncIoContext& io) {
    while (!doneCalled) {
      io.provider->getTimer().afterDelay(10 * kj::MILLISECONDS).wait(io.waitScope);
    }
  }

  kj::String waitForText(kj::AsyncIoContext& io, kj::StringPtr needle) {
    for (uint i = 0; i < 200; ++i) {
      auto text = kj::str(data.asPtr().asChars());
      if (contains(text, needle)) {
        return text;
      }
      io.provider->getTimer().afterDelay(10 * kj::MILLISECONDS).wait(io.waitScope);
    }

    return kj::str(data.asPtr().asChars());
  }

  kj::ArrayPtr<const byte> getData() {
    return data.asPtr();
  }

private:
  kj::Vector<byte> data;
  bool doneCalled = false;
};

class CountingByteStream final: public ByteStream::Server {
public:
  kj::Promise<void> write(WriteContext context) override {
    auto bytes = context.getParams().getData();
    byteCount += bytes.size();
    checksumValue = (checksumValue + checksum(bytes)) & 0xffffffffu;
    return kj::READY_NOW;
  }

  kj::Promise<void> done(DoneContext context) override {
    doneCalled = true;
    return kj::READY_NOW;
  }

  void waitForDone(kj::AsyncIoContext& io) {
    while (!doneCalled) {
      io.provider->getTimer().afterDelay(10 * kj::MILLISECONDS).wait(io.waitScope);
    }
  }

  uint64_t getByteCount() {
    return byteCount;
  }

  uint getChecksum() {
    return checksumValue;
  }

private:
  uint64_t byteCount = 0;
  uint checksumValue = 0;
  bool doneCalled = false;
};

class FakeClaimedCapability final: public IsolateWebSession::Server {
public:
  explicit FakeClaimedCapability(uint& saveCount): saveCount(saveCount) {}

  kj::Promise<void> get(GetContext context) override {
    auto params = context.getParams();
    auto response = context.getResults();
    auto content = response.initContent();
    content.setStatusCode(WebSession::Response::SuccessCode::OK);
    content.setMimeType("application/json; charset=utf-8");
    auto body = kj::str(
        "{\"ok\":true,\"source\":\"fake-claimed-capability\",\"path\":\"",
        params.getPath(), "\"}");
    content.initBody().setBytes(body.asBytes());
    return kj::READY_NOW;
  }

  kj::Promise<void> save(SaveContext context) override {
    auto params = context.getParams();
    KJ_REQUIRE(params.getSealFor().which() == ApiTokenOwner::GRAIN);
    auto owner = params.getSealFor().getGrain();
    KJ_REQUIRE(owner.getGrainId().size() > 0);
    KJ_REQUIRE(owner.getSaveLabel().getDefaultText() == "WebSession saved capability");
    ++saveCount;
    context.getResults().setSturdyRef(kj::StringPtr("websession-saved-token").asBytes());
    return kj::READY_NOW;
  }

  kj::Promise<void> addRequirements(AddRequirementsContext context) override {
    context.getResults().setCap(thisCap().castAs<SystemPersistent>());
    return kj::READY_NOW;
  }

private:
  uint& saveCount;
};

class FakeOutboundHttpSession final: public OutboundHttpSession::Server {
public:
  kj::Promise<void> request(RequestContext context) override {
    auto params = context.getParams();
    KJ_REQUIRE(params.getMethod() == OutboundHttpSession::Method::POST);
    KJ_REQUIRE(params.getPath() == "v1/chat/completions?model=test", params.getPath());

    kj::StringPtr authorization = "";
    kj::StringPtr contentType = "";
    for (auto header: params.getHeaders()) {
      if (header.getName() == "authorization") {
        authorization = header.getValue();
      } else if (header.getName() == "content-type") {
        contentType = header.getValue();
      }
    }
    KJ_REQUIRE(authorization == "Bearer isolate-test", authorization);
    KJ_REQUIRE(contentType == "text/plain;charset=UTF-8" ||
        contentType == "text/plain;charset=utf-8" ||
        contentType == "text/plain; charset=utf-8" ||
        contentType == "text/plain", contentType);
    KJ_REQUIRE(kj::str(params.getBody().asChars()) == "hello");

    auto response = context.getResults();
    response.setStatusCode(201);
    response.setStatusText("Created");
    auto headers = response.initHeaders(2);
    headers[0].setName("content-type");
    headers[0].setValue("application/json; charset=utf-8");
    headers[1].setName("x-outbound-test");
    headers[1].setValue("yes");

    auto body = kj::str(
        "{\"ok\":true,\"source\":\"fake-outbound-http\","
        "\"method\":\"POST\","
        "\"path\":\"", params.getPath(), "\","
        "\"authorization\":\"", authorization, "\","
        "\"body\":\"", params.getBody().asChars(), "\"}");
    auto stream = params.getResponseStream();
    auto write = stream.writeRequest();
    write.setData(body.asBytes());
    return write.send()
        .then([stream = kj::mv(stream), body = kj::mv(body)]() mutable {
      return stream.doneRequest().send().then([](auto) {});
    });
  }
};

class FakeSessionContext final: public SessionContext::Server {
public:
  kj::Promise<void> claimRequest(ClaimRequestContext context) override {
    auto params = context.getParams();
    auto requiredPermissions = params.getRequiredPermissions();
    KJ_REQUIRE(requiredPermissions.size() == 1);
    KJ_REQUIRE(requiredPermissions[0]);
    claimCount++;

    if (params.getRequestToken() == "websession/test+token==") {
      context.getResults().setCap(kj::heap<FakeClaimedCapability>(saveCount));
    } else if (params.getRequestToken() == "outbound-http/test-token") {
      context.getResults().setCap(kj::heap<FakeOutboundHttpSession>());
    } else {
      KJ_FAIL_REQUIRE("unexpected fake powerbox request token", params.getRequestToken());
    }
    return kj::READY_NOW;
  }

  kj::Promise<void> offer(OfferContext context) override {
    auto params = context.getParams();
    KJ_REQUIRE(params.hasCap());
    KJ_REQUIRE(params.getRequiredPermissions().size() == 1);
    KJ_REQUIRE(params.getRequiredPermissions()[0]);
    validateDescriptor(params.getDescriptor());
    validateDisplayInfo(params.getDisplayInfo(),
        "WebSession offered capability",
        "can use offered capability",
        "Offered capability description");
    ++offerCount;
    return kj::READY_NOW;
  }

  kj::Promise<void> request(RequestContext context) override {
    auto params = context.getParams();
    auto query = params.getQuery();
    KJ_REQUIRE(query.size() == 1);
    auto requiredPermissions = params.getRequiredPermissions();
    KJ_REQUIRE(requiredPermissions.size() == 1);
    KJ_REQUIRE(requiredPermissions[0]);
    validateDescriptor(query[0]);
    ++requestCount;
    context.getResults().setCap(kj::heap<FakeClaimedCapability>(saveCount));
    context.getResults().setDescriptor(query[0]);
    return kj::READY_NOW;
  }

  kj::Promise<void> fulfillRequest(FulfillRequestContext context) override {
    auto params = context.getParams();
    KJ_REQUIRE(params.hasCap());
    KJ_REQUIRE(params.getRequiredPermissions().size() == 1);
    KJ_REQUIRE(params.getRequiredPermissions()[0]);
    validateDescriptor(params.getDescriptor());
    validateDisplayInfo(params.getDisplayInfo(),
        "WebSession fulfilled capability",
        "can use fulfilled capability",
        "Fulfilled capability description");
    ++fulfillCount;
    return kj::READY_NOW;
  }

  kj::Promise<void> tieToUser(TieToUserContext context) override {
    auto params = context.getParams();
    KJ_REQUIRE(params.hasCap());
    KJ_REQUIRE(params.getRequiredPermissions().size() == 1);
    KJ_REQUIRE(params.getRequiredPermissions()[0]);
    validateDisplayInfo(params.getDisplayInfo(),
        "WebSession tied capability",
        "can use tied capability",
        "Tied capability description");
    ++tieCount;
    context.getResults().setTiedCap(kj::heap<FakeClaimedCapability>(saveCount));
    return kj::READY_NOW;
  }

  uint claimCount = 0;
  uint saveCount = 0;
  uint restoreCount = 0;
  uint tokenDropCount = 0;
  uint offerCount = 0;
  uint requestCount = 0;
  uint fulfillCount = 0;
  uint tieCount = 0;
  uint apiDescriptorCount = 0;
  uint providerDescriptorCount = 0;
  uint grainSizeReportCount = 0;
  uint routeBackedTokenCount = 0;
  uint childTokenCount = 0;
  uint64_t lastGrainSizeBytes = 0;
  kj::String lastRouteBackedAppRef;
  kj::String lastChildTokenParent;

private:
  void validateDisplayInfo(PowerboxDisplayInfo::Reader displayInfo,
      kj::StringPtr title, kj::StringPtr verbPhrase, kj::StringPtr description) {
    KJ_REQUIRE(displayInfo.getTitle().getDefaultText() == title,
        displayInfo.getTitle().getDefaultText(), title);
    KJ_REQUIRE(displayInfo.getVerbPhrase().getDefaultText() == verbPhrase,
        displayInfo.getVerbPhrase().getDefaultText(), verbPhrase);
    KJ_REQUIRE(displayInfo.getDescription().getDefaultText() == description,
        displayInfo.getDescription().getDefaultText(), description);
  }

  void validateDescriptor(PowerboxDescriptor::Reader descriptor) {
    auto tags = descriptor.getTags();
    if (tags.size() == 0) {
      return;
    }

    KJ_REQUIRE(tags.size() == 1);
    if (tags[0].getId() == TEST_PROVIDER_TAG_ID) {
      ++providerDescriptorCount;
      return;
    }

    KJ_REQUIRE(tags[0].getId() == capnp::typeId<ApiSession>());
    auto tag = tags[0].getValue().getAs<ApiSession::PowerboxTag>();
    KJ_REQUIRE(tag.getCanonicalUrl() == "https://api.example.test/v1");
    auto scopes = tag.getOauthScopes();
    KJ_REQUIRE(scopes.size() == 2);
    KJ_REQUIRE(scopes[0].getName() == "read");
    KJ_REQUIRE(scopes[1].getName() == "write");
    ++apiDescriptorCount;
  }
};

class FakeSandstormCore final: public SandstormCore::Server {
public:
  explicit FakeSandstormCore(FakeSessionContext& sessionContext)
      : sessionContext(sessionContext) {}

  FakeSandstormCore(FakeSessionContext& sessionContext, kj::StringPtr tokenStorePath)
      : sessionContext(sessionContext),
        tokenStorePath(kj::heapString(tokenStorePath)) {
    loadRouteBackedTokens();
  }

  void setSupervisor(Supervisor::Client supervisor) {
    this->supervisor = kj::mv(supervisor);
  }

  kj::Promise<void> restore(RestoreContext context) override {
    auto token = context.getParams().getToken();
    auto tokenText = kj::heapString(token.asChars());
    if (tokenText == "websession-saved-token") {
      ++sessionContext.restoreCount;
      context.getResults().setCap(kj::heap<FakeClaimedCapability>(sessionContext.saveCount));
      return kj::READY_NOW;
    }

    KJ_IF_MAYBE(saved, findRouteBackedToken(tokenText)) {
      ++sessionContext.restoreCount;
      KJ_IF_MAYBE(supervisor, this->supervisor) {
        capnp::MallocMessageBuilder appRefMessage;
        auto appRef = appRefMessage.initRoot<capnp::AnyPointer>();
        appRef.setAs<capnp::Data>(saved->appRef.asPtr());

        auto request = supervisor->restoreRequest();
        request.getRef().setAppRef(appRef.asReader());
        return request.send().then([context](auto result) mutable {
          context.getResults().setCap(result.getCap());
        });
      } else {
        KJ_FAIL_REQUIRE("fake SandstormCore has no supervisor for route-backed restore");
      }
    } else {
      KJ_FAIL_REQUIRE("unknown fake SandstormCore token", tokenText);
    }
  }

  kj::Promise<void> drop(DropContext context) override {
    auto token = context.getParams().getToken();
    auto tokenText = kj::heapString(token.asChars());
    if (tokenText == "websession-saved-token") {
      ++sessionContext.tokenDropCount;
      return kj::READY_NOW;
    }

    for (auto i: kj::indices(routeBackedTokens)) {
      if (routeBackedTokens[i].token == tokenText) {
        if (i + 1 < routeBackedTokens.size()) {
          routeBackedTokens[i] = kj::mv(routeBackedTokens.back());
        }
        routeBackedTokens.removeLast();
        saveRouteBackedTokens();
        ++sessionContext.tokenDropCount;
        return kj::READY_NOW;
      }
    }

    KJ_FAIL_REQUIRE("unknown fake SandstormCore token", tokenText);
  }

  kj::Promise<void> makeToken(MakeTokenContext context) override {
    auto params = context.getParams();
    KJ_REQUIRE(params.getRef().which() == SupervisorObjectId<>::APP_REF,
        "fake SandstormCore only supports isolate app refs");
    auto owner = params.getOwner();
    KJ_REQUIRE(owner.which() == ApiTokenOwner::GRAIN);
    KJ_REQUIRE(owner.getGrain().getGrainId().size() > 0);

    auto appRef = params.getRef().getAppRef().getAs<capnp::Data>();
    auto token = kj::str("route-backed-token-", ++routeBackedTokenCounter);
    routeBackedTokens.add(RouteBackedToken {
        kj::heapString(token),
        kj::heapArray<byte>(appRef.begin(), appRef.end())
    });
    ++sessionContext.routeBackedTokenCount;
    sessionContext.lastRouteBackedAppRef = kj::heapString(appRef.asChars());
    saveRouteBackedTokens();
    context.getResults().setToken(token.asBytes());
    return kj::READY_NOW;
  }

  kj::Promise<void> makeChildToken(MakeChildTokenContext context) override {
    auto params = context.getParams();
    auto parent = params.getParent();
    ++sessionContext.childTokenCount;
    sessionContext.lastChildTokenParent = kj::heapString(parent.asChars());
    context.getResults().setToken(params.getParent());
    return kj::READY_NOW;
  }

  kj::Promise<void> reportGrainSize(ReportGrainSizeContext context) override {
    ++sessionContext.grainSizeReportCount;
    sessionContext.lastGrainSizeBytes = context.getParams().getBytes();
    KJ_REQUIRE(sessionContext.lastGrainSizeBytes > 0);
    return kj::READY_NOW;
  }

private:
  struct RouteBackedToken {
    kj::String token;
    kj::Array<byte> appRef;
  };

  kj::Maybe<RouteBackedToken&> findRouteBackedToken(kj::StringPtr token) {
    for (auto& saved: routeBackedTokens) {
      if (saved.token == token) {
        return saved;
      }
    }
    return nullptr;
  }

  FakeSessionContext& sessionContext;
  kj::Maybe<Supervisor::Client> supervisor;
  kj::Maybe<kj::String> tokenStorePath;
  uint routeBackedTokenCounter = 0;
  kj::Vector<RouteBackedToken> routeBackedTokens;

  void loadRouteBackedTokens() {
    KJ_IF_MAYBE(path, tokenStorePath) {
      KJ_IF_MAYBE(file, raiiOpenIfExists(*path, O_RDONLY | O_CLOEXEC)) {
        for (auto& line: splitLines(readAll(*file))) {
          if (line.size() == 0) continue;

          KJ_IF_MAYBE(tab, line.findFirst('\t')) {
            auto token = kj::heapString(kj::StringPtr(line.begin(), *tab));
            auto encodedAppRef = kj::StringPtr(line.begin() + *tab + 1, line.size() - *tab - 1);
            auto decoded = kj::decodeBase64(encodedAppRef);
            KJ_REQUIRE(!decoded.hadErrors, "invalid fake core token store app-ref");
            routeBackedTokens.add(RouteBackedToken { kj::mv(token), kj::mv(decoded) });
          } else {
            KJ_FAIL_REQUIRE("invalid fake core token store line", line);
          }
        }
        routeBackedTokenCounter = routeBackedTokens.size();
      }
    }
  }

  void saveRouteBackedTokens() {
    KJ_IF_MAYBE(path, tokenStorePath) {
      kj::Vector<char> content;
      for (auto& token: routeBackedTokens) {
        content.addAll(token.token);
        content.add('\t');
        auto encodedAppRef = kj::encodeBase64Url(token.appRef.asPtr());
        content.addAll(encodedAppRef);
        content.add('\n');
      }
      writeTestFile(*path, content.asPtr());
    }
  }
};

class FakeIsolateObjectCallTarget final: public IsolateObjectCallTarget {
public:
  FakeIsolateObjectCallTarget(kj::String label, uint& dropCount)
      : label(kj::mv(label)), dropCount(dropCount) {}

  kj::Promise<OwnedIsolateObjectCallResult> call(
      kj::String method, OwnedIsolateObjectCallArgs ownedArgs) override {
    auto args = ownedArgs.getArgs();
    auto result = kj::heap<capnp::MallocMessageBuilder>();

    if (method == "echo") {
      KJ_REQUIRE(args.size() == 1, "echo expects one argument");
      copyIsolateObjectCallValue(args[0], result->initRoot<IsolateObjectCallResult>().initValue());
      return OwnedIsolateObjectCallResult { kj::mv(result) };
    } else if (method == "sum") {
      double sum = 0;
      for (auto arg: args) {
        KJ_REQUIRE(arg.which() == IsolateObjectCallValue::NUMBER, "sum expects number args");
        sum += arg.getNumber();
      }
      result->initRoot<IsolateObjectCallResult>().initValue().setNumber(sum);
      return OwnedIsolateObjectCallResult { kj::mv(result) };
    } else if (method == "describe") {
      auto fields = result->initRoot<IsolateObjectCallResult>().initValue().initObject(2);
      fields[0].setName("label");
      fields[0].initValue().setText(label);
      fields[1].setName("argCount");
      fields[1].initValue().setNumber(args.size());
      return OwnedIsolateObjectCallResult { kj::mv(result) };
    } else if (method == "callCap") {
      KJ_REQUIRE(args.size() == 1, "callCap expects one capability argument");
      KJ_REQUIRE(args[0].which() == IsolateObjectCallValue::CAPABILITY,
          "callCap expects a capability argument");
      capnp::MallocMessageBuilder callbackMessage;
      auto callbackArgs = callbackMessage.initRoot<capnp::List<IsolateObjectCallValue>>(1);
      callbackArgs[0].setText("from-capability");
      return callIsolateObjectCapability(
          args[0].getCapability(), "echo", callbackArgs.asReader());
    } else if (method == "fail") {
      auto exception = result->initRoot<IsolateObjectCallResult>().initException();
      exception.setName("NativeObjectError");
      exception.setMessage("fake native object failure");
      exception.setStack("FakeIsolateObjectCapability.fail");
      return OwnedIsolateObjectCallResult { kj::mv(result) };
    } else {
      auto exception = result->initRoot<IsolateObjectCallResult>().initException();
      exception.setName("NoSuchMethod");
      exception.setMessage(kj::str("unknown method: ", method));
      return OwnedIsolateObjectCallResult { kj::mv(result) };
    }
  }

  kj::Promise<void> drop() override {
    ++dropCount;
    return kj::READY_NOW;
  }

private:
  kj::String label;
  uint& dropCount;
};

void testNativeObjectCapabilityTransport(kj::WaitScope& waitScope) {
  uint rootDropCount = 0;
  uint childDropCount = 0;
  uint remoteDropCount = 0;
  uint callbackDropCount = 0;
  uint tableLocalDropCount = 0;
  uint tableRemoteDropCount = 0;
  uint bulkLocalDropCount = 0;
  uint bulkRemoteDropCount = 0;
  IsolateObjectCapability::Client root = makeIsolateObjectCapability(
      kj::heap<FakeIsolateObjectCallTarget>(kj::heapString("root"), rootDropCount));
  IsolateObjectCapability::Client child = makeIsolateObjectCapability(
      kj::heap<FakeIsolateObjectCallTarget>(kj::heapString("child"), childDropCount));
  IsolateObjectCapability::Client remote = makeIsolateObjectCapability(
      kj::heap<FakeIsolateObjectCallTarget>(kj::heapString("remote"), remoteDropCount));
  IsolateObjectCapability::Client callback = makeIsolateObjectCapability(
      kj::heap<FakeIsolateObjectCallTarget>(kj::heapString("callback"), callbackDropCount));
  IsolateObjectCapability::Client tableRemote = makeIsolateObjectCapability(
      kj::heap<FakeIsolateObjectCallTarget>(kj::heapString("table-remote"), tableRemoteDropCount));

  capnp::MallocMessageBuilder echoMessage;
  auto echoArgs = echoMessage.initRoot<capnp::List<IsolateObjectCallValue>>(1);
  echoArgs[0].setText("hello native object");
  auto echoOwned = callIsolateObjectCapability(root, "echo", echoArgs.asReader()).wait(waitScope);
  auto echoResult = echoOwned.getResult();
  KJ_REQUIRE(echoResult.which() == IsolateObjectCallResult::VALUE);
  KJ_REQUIRE(echoResult.getValue().which() == IsolateObjectCallValue::TEXT);
  KJ_REQUIRE(echoResult.getValue().getText() == "hello native object");

  capnp::MallocMessageBuilder nestedEchoMessage;
  auto nestedEchoArgs = nestedEchoMessage.initRoot<capnp::List<IsolateObjectCallValue>>(1);
  auto nestedArg = nestedEchoArgs[0].initObject(4);
  nestedArg[0].setName("nothing");
  nestedArg[0].initValue().setNull();
  nestedArg[1].setName("flag");
  nestedArg[1].initValue().setBool(true);
  nestedArg[2].setName("bytes");
  nestedArg[2].initValue().setData(kj::StringPtr("abc").asBytes());
  nestedArg[3].setName("items");
  auto nestedItems = nestedArg[3].initValue().initList(2);
  nestedItems[0].setText("first");
  nestedItems[1].setNumber(2);
  auto nestedEchoOwned =
      callIsolateObjectCapability(root, "echo", nestedEchoArgs.asReader()).wait(waitScope);
  auto nestedEchoResult = nestedEchoOwned.getResult();
  KJ_REQUIRE(nestedEchoResult.which() == IsolateObjectCallResult::VALUE);
  KJ_REQUIRE(nestedEchoResult.getValue().which() == IsolateObjectCallValue::OBJECT);
  auto nestedFields = nestedEchoResult.getValue().getObject();
  KJ_REQUIRE(nestedFields.size() == 4);
  KJ_REQUIRE(nestedFields[0].getName() == "nothing");
  KJ_REQUIRE(nestedFields[0].getValue().which() == IsolateObjectCallValue::NULL_);
  KJ_REQUIRE(nestedFields[1].getName() == "flag");
  KJ_REQUIRE(nestedFields[1].getValue().getBool());
  KJ_REQUIRE(nestedFields[2].getName() == "bytes");
  KJ_REQUIRE(kj::str(nestedFields[2].getValue().getData().asChars()) == "abc");
  KJ_REQUIRE(nestedFields[3].getName() == "items");
  auto echoedItems = nestedFields[3].getValue().getList();
  KJ_REQUIRE(echoedItems.size() == 2);
  KJ_REQUIRE(echoedItems[0].getText() == "first");
  KJ_REQUIRE(echoedItems[1].getNumber() == 2);

  auto sum = root.callRequest();
  sum.setMethod("sum");
  auto sumArgs = sum.initArgs(3);
  sumArgs[0].setNumber(4);
  sumArgs[1].setNumber(5.5);
  sumArgs[2].setNumber(6);
  auto sumResponse = sum.send().wait(waitScope);
  auto sumResult = sumResponse.getResult();
  KJ_REQUIRE(sumResult.which() == IsolateObjectCallResult::VALUE);
  KJ_REQUIRE(sumResult.getValue().which() == IsolateObjectCallValue::NUMBER);
  KJ_REQUIRE(sumResult.getValue().getNumber() == 15.5);

  auto describe = root.callRequest();
  describe.setMethod("describe");
  describe.initArgs(2);
  auto describeResponse = describe.send().wait(waitScope);
  auto describeResult = describeResponse.getResult();
  KJ_REQUIRE(describeResult.which() == IsolateObjectCallResult::VALUE);
  KJ_REQUIRE(describeResult.getValue().which() == IsolateObjectCallValue::OBJECT);
  auto fields = describeResult.getValue().getObject();
  KJ_REQUIRE(fields.size() == 2);
  KJ_REQUIRE(fields[0].getName() == "label");
  KJ_REQUIRE(fields[0].getValue().getText() == "root");
  KJ_REQUIRE(fields[1].getName() == "argCount");
  KJ_REQUIRE(fields[1].getValue().getNumber() == 2);

  capnp::MallocMessageBuilder callCapMessage;
  auto callCapArgs = callCapMessage.initRoot<capnp::List<IsolateObjectCallValue>>(1);
  callCapArgs[0].setCapability(child);
  auto callCapOwned =
      callIsolateObjectCapability(root, "callCap", callCapArgs.asReader()).wait(waitScope);
  auto callCapResult = callCapOwned.getResult();
  KJ_REQUIRE(callCapResult.which() == IsolateObjectCallResult::VALUE);
  KJ_REQUIRE(callCapResult.getValue().which() == IsolateObjectCallValue::TEXT);
  KJ_REQUIRE(callCapResult.getValue().getText() == "from-capability");

  auto importedRemote = makeIsolateObjectCapability(
      makeImportedIsolateObjectCallTarget(remote));

  capnp::MallocMessageBuilder importedDescribeMessage;
  auto importedDescribeArgs =
      importedDescribeMessage.initRoot<capnp::List<IsolateObjectCallValue>>(2);
  importedDescribeArgs[0].setText("first");
  importedDescribeArgs[1].setBool(true);
  auto importedDescribeOwned = callIsolateObjectCapability(
      importedRemote, "describe", importedDescribeArgs.asReader()).wait(waitScope);
  auto importedDescribeResult = importedDescribeOwned.getResult();
  KJ_REQUIRE(importedDescribeResult.which() == IsolateObjectCallResult::VALUE);
  KJ_REQUIRE(importedDescribeResult.getValue().which() == IsolateObjectCallValue::OBJECT);
  auto importedDescribeFields = importedDescribeResult.getValue().getObject();
  KJ_REQUIRE(importedDescribeFields.size() == 2);
  KJ_REQUIRE(importedDescribeFields[0].getName() == "label");
  KJ_REQUIRE(importedDescribeFields[0].getValue().getText() == "remote");
  KJ_REQUIRE(importedDescribeFields[1].getName() == "argCount");
  KJ_REQUIRE(importedDescribeFields[1].getValue().getNumber() == 2);

  capnp::MallocMessageBuilder importedCallCapMessage;
  auto importedCallCapArgs =
      importedCallCapMessage.initRoot<capnp::List<IsolateObjectCallValue>>(1);
  importedCallCapArgs[0].setCapability(callback);
  auto importedCallCapOwned = callIsolateObjectCapability(
      importedRemote, "callCap", importedCallCapArgs.asReader()).wait(waitScope);
  auto importedCallCapResult = importedCallCapOwned.getResult();
  KJ_REQUIRE(importedCallCapResult.which() == IsolateObjectCallResult::VALUE);
  KJ_REQUIRE(importedCallCapResult.getValue().which() == IsolateObjectCallValue::TEXT);
  KJ_REQUIRE(importedCallCapResult.getValue().getText() == "from-capability");

  auto importedFail = importedRemote.callRequest();
  importedFail.setMethod("fail");
  importedFail.initArgs(0);
  auto importedFailResponse = importedFail.send().wait(waitScope);
  auto importedFailResult = importedFailResponse.getResult();
  KJ_REQUIRE(importedFailResult.which() == IsolateObjectCallResult::EXCEPTION);
  KJ_REQUIRE(importedFailResult.getException().getName() == "NativeObjectError");

  IsolateObjectCapabilityTable table;
  auto tableExport = table.exportTarget(
      kj::heap<FakeIsolateObjectCallTarget>(kj::heapString("table-local"), tableLocalDropCount));
  auto tableImport = table.importCapability(tableRemote);
  KJ_REQUIRE(tableExport.id == "native-export-0");
  KJ_REQUIRE(tableImport.id == "native-import-0");
  auto tableStats = table.stats();
  KJ_REQUIRE(tableStats.totalCount == 2, tableStats.totalCount);
  KJ_REQUIRE(tableStats.exportedCount == 1, tableStats.exportedCount);
  KJ_REQUIRE(tableStats.importedCount == 1, tableStats.importedCount);
  KJ_IF_MAYBE(info, table.findInfo(tableExport.id)) {
    KJ_REQUIRE(info->kind == IsolateObjectCapabilityTableEntryKind::EXPORTED);
  } else {
    KJ_FAIL_REQUIRE("expected native object table export info");
  }
  KJ_IF_MAYBE(info, table.findInfo(tableImport.id)) {
    KJ_REQUIRE(info->kind == IsolateObjectCapabilityTableEntryKind::IMPORTED);
  } else {
    KJ_FAIL_REQUIRE("expected native object table import info");
  }

  KJ_IF_MAYBE(foundExport, table.find(tableExport.id)) {
    capnp::MallocMessageBuilder tableSumMessage;
    auto tableSumArgs = tableSumMessage.initRoot<capnp::List<IsolateObjectCallValue>>(2);
    tableSumArgs[0].setNumber(7);
    tableSumArgs[1].setNumber(8);
    auto tableSumOwned =
        callIsolateObjectCapability(*foundExport, "sum", tableSumArgs.asReader()).wait(waitScope);
    auto tableSumResult = tableSumOwned.getResult();
    KJ_REQUIRE(tableSumResult.which() == IsolateObjectCallResult::VALUE);
    KJ_REQUIRE(tableSumResult.getValue().getNumber() == 15);
  } else {
    KJ_FAIL_REQUIRE("expected native object table export lookup");
  }

  KJ_IF_MAYBE(foundImport, table.find(tableImport.id)) {
    capnp::MallocMessageBuilder tableDescribeMessage;
    auto tableDescribeArgs =
        tableDescribeMessage.initRoot<capnp::List<IsolateObjectCallValue>>(1);
    tableDescribeArgs[0].setText("through-table");
    auto tableDescribeOwned = callIsolateObjectCapability(
        *foundImport, "describe", tableDescribeArgs.asReader()).wait(waitScope);
    auto tableDescribeResult = tableDescribeOwned.getResult();
    KJ_REQUIRE(tableDescribeResult.which() == IsolateObjectCallResult::VALUE);
    auto tableDescribeFields = tableDescribeResult.getValue().getObject();
    KJ_REQUIRE(tableDescribeFields[0].getName() == "label");
    KJ_REQUIRE(tableDescribeFields[0].getValue().getText() == "table-remote");
    KJ_REQUIRE(tableDescribeFields[1].getName() == "argCount");
    KJ_REQUIRE(tableDescribeFields[1].getValue().getNumber() == 1);
  } else {
    KJ_FAIL_REQUIRE("expected native object table import lookup");
  }

  KJ_REQUIRE(!table.drop("missing-native-object").wait(waitScope));
  KJ_REQUIRE(table.drop(tableExport.id).wait(waitScope));
  KJ_REQUIRE(table.drop(tableImport.id).wait(waitScope));
  KJ_REQUIRE(table.find(tableExport.id) == nullptr);
  KJ_REQUIRE(table.find(tableImport.id) == nullptr);
  KJ_REQUIRE(table.findInfo(tableExport.id) == nullptr);
  KJ_REQUIRE(table.findInfo(tableImport.id) == nullptr);
  tableStats = table.stats();
  KJ_REQUIRE(tableStats.totalCount == 0, tableStats.totalCount);
  KJ_REQUIRE(tableStats.exportedCount == 0, tableStats.exportedCount);
  KJ_REQUIRE(tableStats.importedCount == 0, tableStats.importedCount);
  KJ_REQUIRE(tableLocalDropCount == 1, tableLocalDropCount);
  KJ_REQUIRE(tableRemoteDropCount == 1, tableRemoteDropCount);

  IsolateObjectCapabilityTable bulkTable;
  IsolateObjectCapability::Client bulkRemote = makeIsolateObjectCapability(
      kj::heap<FakeIsolateObjectCallTarget>(kj::heapString("bulk-remote"), bulkRemoteDropCount));
  auto bulkExportA = bulkTable.exportTarget(
      kj::heap<FakeIsolateObjectCallTarget>(kj::heapString("bulk-local-a"), bulkLocalDropCount));
  auto bulkExportB = bulkTable.exportTarget(
      kj::heap<FakeIsolateObjectCallTarget>(kj::heapString("bulk-local-b"), bulkLocalDropCount));
  auto bulkImport = bulkTable.importCapability(bulkRemote);
  KJ_REQUIRE(bulkExportA.id == "native-export-0");
  KJ_REQUIRE(bulkExportB.id == "native-export-1");
  KJ_REQUIRE(bulkImport.id == "native-import-0");
  auto bulkStats = bulkTable.stats();
  KJ_REQUIRE(bulkStats.totalCount == 3, bulkStats.totalCount);
  KJ_REQUIRE(bulkStats.exportedCount == 2, bulkStats.exportedCount);
  KJ_REQUIRE(bulkStats.importedCount == 1, bulkStats.importedCount);
  KJ_REQUIRE(bulkTable.dropAll().wait(waitScope) == 3);
  bulkStats = bulkTable.stats();
  KJ_REQUIRE(bulkStats.totalCount == 0, bulkStats.totalCount);
  KJ_REQUIRE(bulkStats.exportedCount == 0, bulkStats.exportedCount);
  KJ_REQUIRE(bulkStats.importedCount == 0, bulkStats.importedCount);
  KJ_REQUIRE(bulkLocalDropCount == 2, bulkLocalDropCount);
  KJ_REQUIRE(bulkRemoteDropCount == 1, bulkRemoteDropCount);

  auto fail = root.callRequest();
  fail.setMethod("fail");
  fail.initArgs(0);
  auto failResponse = fail.send().wait(waitScope);
  auto failResult = failResponse.getResult();
  KJ_REQUIRE(failResult.which() == IsolateObjectCallResult::EXCEPTION);
  KJ_REQUIRE(failResult.getException().getName() == "NativeObjectError");
  KJ_REQUIRE(failResult.getException().getMessage() == "fake native object failure");

  root.dropRequest().send().wait(waitScope);
  child.dropRequest().send().wait(waitScope);
  importedRemote.dropRequest().send().wait(waitScope);
  callback.dropRequest().send().wait(waitScope);
  KJ_REQUIRE(rootDropCount == 1, rootDropCount);
  KJ_REQUIRE(childDropCount == 1, childDropCount);
  KJ_REQUIRE(remoteDropCount == 1, remoteDropCount);
  KJ_REQUIRE(callbackDropCount == 1, callbackDropCount);
}

kj::String responseDebugBody(WebSession::Response::Reader response) {
  switch (response.which()) {
    case WebSession::Response::CONTENT:
      if (response.getContent().getBody().which() ==
          WebSession::Response::Content::Body::BYTES) {
        return kj::str(response.getContent().getBody().getBytes().asChars());
      }
      return kj::str("<streaming content>");
    case WebSession::Response::CLIENT_ERROR:
      if (response.getClientError().hasNonHtmlBody()) {
        return kj::str(response.getClientError().getNonHtmlBody().getData().asChars());
      } else {
        return kj::str(response.getClientError().getDescriptionHtml());
      }
    case WebSession::Response::SERVER_ERROR:
      if (response.getServerError().hasNonHtmlBody()) {
        return kj::str(response.getServerError().getNonHtmlBody().getData().asChars());
      } else {
        return kj::str(response.getServerError().getDescriptionHtml());
      }
    default:
      return kj::str("<response kind ", static_cast<uint>(response.which()), ">");
  }
}

class IsolateWebSessionClientMain {
public:
  explicit IsolateWebSessionClientMain(kj::ProcessContext& context)
      : context(context), io(kj::setupAsyncIo()) {}

  kj::MainFunc getMain() {
    return kj::MainBuilder(context, "Sandstorm isolate WebSession integration client",
        "Connects to an isolate supervisor socket and validates the WebSession path.")
        .addOption({"core-server"}, KJ_BIND_METHOD(*this, setCoreServerMode),
            "Keep a fake SandstormCore connected until terminated.")
        .expectArg("<supervisor-socket>", KJ_BIND_METHOD(*this, setSocketPath))
        .callAfterParsing(KJ_BIND_METHOD(*this, run))
        .build();
  }

  kj::MainBuilder::Validity setCoreServerMode() {
    coreServerMode = true;
    return true;
  }

  kj::MainBuilder::Validity setSocketPath(kj::StringPtr path) {
    socketPath = kj::heapString(path);
    return true;
  }

  kj::MainBuilder::Validity run() {
    KJ_REQUIRE(socketPath != nullptr);
    testNativeObjectCapabilityTransport(io.waitScope);

    auto address = io.provider->getNetwork()
        .parseAddress(kj::str("unix:", socketPath), 0)
        .wait(io.waitScope);
    auto stream = address->connect().wait(io.waitScope);
    auto sessionContext = kj::heap<FakeSessionContext>();
    auto& sessionContextRef = *sessionContext;

    auto tokenStorePath = fakeCoreTokenStorePath(socketPath);
    auto fakeCore = coreServerMode
        ? kj::heap<FakeSandstormCore>(sessionContextRef, tokenStorePath)
        : kj::heap<FakeSandstormCore>(sessionContextRef);
    auto& fakeCoreRef = *fakeCore;
    capnp::TwoPartyVatNetwork network(*stream, capnp::rpc::twoparty::Side::CLIENT);
    auto rpcSystem = capnp::makeRpcServer(network, kj::mv(fakeCore));

    capnp::MallocMessageBuilder vatMessage;
    auto hostId = vatMessage.initRoot<capnp::rpc::twoparty::VatId>();
    hostId.setSide(capnp::rpc::twoparty::Side::SERVER);

    auto supervisor = rpcSystem.bootstrap(hostId).castAs<Supervisor>();
    fakeCoreRef.setSupervisor(supervisor);

    if (coreServerMode) {
      context.warning("Core ready.");
      network.onDisconnect().wait(io.waitScope);
      return true;
    }

    auto restoreRequest = supervisor.restoreRequest();
    restoreRequest.getRef().setWakeLockNotification(123);
    expectSupervisorRefFailure(io.waitScope, restoreRequest.send().ignoreResult());

    auto dropRequest = supervisor.dropRequest();
    dropRequest.getRef().setWakeLockNotification(123);
    expectSupervisorRefFailure(io.waitScope, dropRequest.send().ignoreResult());

    auto routeAppRef = makeRouteBackedSessionAppRef("web", "/exported");
    capnp::MallocMessageBuilder appRefMessage;
    auto appRef = appRefMessage.initRoot<capnp::AnyPointer>();
    appRef.setAs<capnp::Data>(routeAppRef.asBytes());

    auto routeRestoreRequest = supervisor.restoreRequest();
    routeRestoreRequest.getRef().setAppRef(appRef.asReader());
    routeRestoreRequest.setParentToken(kj::StringPtr("parent-route-token").asBytes());
    auto restoredRouteSession = routeRestoreRequest.send().wait(io.waitScope)
        .getCap().castAs<WebSession>();

    auto routeRequest = restoredRouteSession.getRequest();
    routeRequest.setPath("/capability-echo?source=supervisor-app-ref");
    routeRequest.setIgnoreBody(false);
    auto routeContext = routeRequest.initContext();
    routeContext.setResponseStream(kj::heap<IgnoreByteStream>());
    routeContext.initCookies(0);
    routeContext.initAccept(0);
    routeContext.initAcceptEncoding(0);
    routeContext.initAdditionalHeaders(0);

    auto routeResponse = routeRequest.send().wait(io.waitScope);
    auto routeDebugBody = responseDebugBody(routeResponse);
    KJ_REQUIRE(routeResponse.which() == WebSession::Response::CONTENT, routeDebugBody);
    auto routeContent = routeResponse.getContent();
    KJ_REQUIRE(routeContent.getStatusCode() == WebSession::Response::SuccessCode::OK);
    KJ_REQUIRE(routeContent.getBody().which() == WebSession::Response::Content::Body::BYTES);
    auto routeBody = kj::str(routeContent.getBody().getBytes().asChars());
    KJ_REQUIRE(contains(routeBody, "\"ok\":true"), routeBody);
    KJ_REQUIRE(contains(routeBody, "\"source\":\"exported-web-session\""), routeBody);
    KJ_REQUIRE(contains(routeBody, "\"pathname\":\"/exported/capability-echo\""), routeBody);
    KJ_REQUIRE(contains(routeBody, "\"search\":\"?source=supervisor-app-ref\""), routeBody);

    auto routeSaveRequest = restoredRouteSession.castAs<SystemPersistent>().saveRequest();
    auto routeSaveOwner = routeSaveRequest.getSealFor().initGrain();
    routeSaveOwner.setGrainId("route-resave-grain");
    routeSaveOwner.getSaveLabel().setDefaultText("Route re-save fixture");
    auto routeSavedToken = routeSaveRequest.send().wait(io.waitScope).getSturdyRef();
    auto routeSavedTokenText = kj::StringPtr(
        routeSavedToken.asChars().begin(), routeSavedToken.size());
    KJ_REQUIRE(routeSavedTokenText == "parent-route-token", routeSavedTokenText);
    KJ_REQUIRE(sessionContextRef.childTokenCount == 1, sessionContextRef.childTokenCount);
    KJ_REQUIRE(sessionContextRef.lastChildTokenParent == "parent-route-token",
        sessionContextRef.lastChildTokenParent);

    auto routeEscapeRequest = restoredRouteSession.getRequest();
    routeEscapeRequest.setPath("../capability-echo?source=escape");
    routeEscapeRequest.setIgnoreBody(false);
    auto routeEscapeContext = routeEscapeRequest.initContext();
    routeEscapeContext.setResponseStream(kj::heap<IgnoreByteStream>());
    routeEscapeContext.initCookies(0);
    routeEscapeContext.initAccept(0);
    routeEscapeContext.initAcceptEncoding(0);
    routeEscapeContext.initAdditionalHeaders(0);
    expectRoutePathFailure(io.waitScope, routeEscapeRequest.send().ignoreResult());

    auto routeDropRequest = supervisor.dropRequest();
    routeDropRequest.getRef().setAppRef(appRef.asReader());
    routeDropRequest.send().wait(io.waitScope);

    auto view = supervisor.getMainViewRequest().send().wait(io.waitScope).getView();

    auto apiSessionContext = kj::heap<FakeSessionContext>();
    auto apiSessionRequest = view.newSessionRequest();
    auto apiUserInfo = apiSessionRequest.initUserInfo();
    apiUserInfo.initDisplayName().setDefaultText("ApiSession Test User");
    apiUserInfo.setPreferredHandle("apisession-test");
    apiUserInfo.initPermissions(1).set(0, true);
    apiSessionRequest.setContext(kj::mv(apiSessionContext));
    apiSessionRequest.setSessionType(capnp::typeId<ApiSession>());
    apiSessionRequest.getSessionParams().initAs<ApiSession::Params>();
    apiSessionRequest.setTabId(kj::StringPtr("apisession-tab").asBytes());

    auto apiSession = apiSessionRequest.send().wait(io.waitScope)
        .getSession().castAs<ApiSession>();
    auto apiSaveRequest = apiSession.castAs<SystemPersistent>().saveRequest();
    auto apiSaveOwner = apiSaveRequest.getSealFor().initGrain();
    apiSaveOwner.setGrainId("api-session-grain");
    apiSaveOwner.getSaveLabel().setDefaultText("ApiSession save fixture");
    apiSaveRequest.send().wait(io.waitScope);
    KJ_REQUIRE(contains(sessionContextRef.lastRouteBackedAppRef,
        "sandstorm-isolate-route-backed-v1\napi\n/api/"),
        sessionContextRef.lastRouteBackedAppRef);

    auto sessionRequest = view.newSessionRequest();
    auto userInfo = sessionRequest.initUserInfo();
    userInfo.initDisplayName().setDefaultText("WebSession Test User");
    userInfo.setPreferredHandle("websession-test");
    userInfo.setPictureUrl("https://static.invalid/user.png");
    userInfo.setPronouns(Profile::Pronouns::ROBOT);
    userInfo.initPermissions(1).set(0, true);
    userInfo.setIdentityId(
        kj::StringPtr("0123456789abcdef0123456789abcdef").asBytes());
    sessionRequest.setContext(kj::mv(sessionContext));
    sessionRequest.setSessionType(capnp::typeId<WebSession>());
    auto sessionParams = sessionRequest.getSessionParams().initAs<WebSession::Params>();
    sessionParams.setBasePath("https://ui-test.invalid");
    sessionParams.setUserAgent("isolate-websession-client");
    auto languages = sessionParams.initAcceptableLanguages(2);
    languages.set(0, "en-US");
    languages.set(1, "en");
    sessionRequest.setTabId(kj::StringPtr("websession-tab").asBytes());

    auto session = sessionRequest.send().wait(io.waitScope).getSession().castAs<WebSession>();

    auto getRequest = session.getRequest();
    getRequest.setPath("/");
    getRequest.setIgnoreBody(false);
    auto getContext = getRequest.initContext();
    getContext.setResponseStream(kj::heap<IgnoreByteStream>());
    auto getCookies = getContext.initCookies(2);
    getCookies[0].setKey("ambient");
    getCookies[0].setValue("one");
    getCookies[1].setKey("theme");
    getCookies[1].setValue("dark");
    getContext.initAccept(0);
    getContext.initAcceptEncoding(0);
    getContext.initAdditionalHeaders(1);
    getContext.getAdditionalHeaders()[0].setName("x-sandstorm-app-test-websession");
    getContext.getAdditionalHeaders()[0].setValue("present");
    auto preconditions = getContext.getETagPrecondition().initMatchesNoneOf(2);
    preconditions[0].setValue("cached-etag");
    preconditions[1].setValue("weak-cached-etag");
    preconditions[1].setWeak(true);

    auto response = getRequest.send().wait(io.waitScope);
    KJ_REQUIRE(response.which() == WebSession::Response::CONTENT);
    auto content = response.getContent();
    KJ_REQUIRE(content.getStatusCode() == WebSession::Response::SuccessCode::OK);
    KJ_REQUIRE(content.getMimeType().startsWith("application/json"));
    KJ_REQUIRE(content.getBody().which() == WebSession::Response::Content::Body::BYTES);

    auto body = kj::str(content.getBody().getBytes().asChars());
    KJ_REQUIRE(contains(body, "\"ok\":true"), body);
    KJ_REQUIRE(contains(body, "\"pathname\":\"/\""), body);
    KJ_REQUIRE(contains(body, "\"x-sandstorm-session-id\":\""), body);
    KJ_REQUIRE(!contains(body, "\"x-sandstorm-session-id\":\"0\""), body);
    KJ_REQUIRE(contains(body, "\"x-sandstorm-username\":\"WebSession Test User\""), body);
    KJ_REQUIRE(contains(body, "\"x-sandstorm-preferred-handle\":\"websession-test\""), body);
    KJ_REQUIRE(contains(body, "\"x-sandstorm-tab-id\":\"77656273657373696f6e2d746162\""), body);
    KJ_REQUIRE(contains(body, "\"if-none-match\":\"\\\"cached-etag\\\", W/\\\"weak-cached-etag\\\"\""),
        body);
    KJ_REQUIRE(!contains(body, "\"cookie\""), body);

    auto downloadStreamServer = kj::heap<CollectByteStream>();
    auto& downloadStream = *downloadStreamServer;
    auto downloadRequest = session.getRequest();
    downloadRequest.setPath("/download?bytes=131072");
    downloadRequest.setIgnoreBody(false);
    auto downloadContext = downloadRequest.initContext();
    downloadContext.setResponseStream(kj::mv(downloadStreamServer));
    downloadContext.initCookies(0);
    downloadContext.initAccept(0);
    downloadContext.initAcceptEncoding(0);
    downloadContext.initAdditionalHeaders(0);

    auto downloadResponse = downloadRequest.send().wait(io.waitScope);
    auto downloadDebugBody = responseDebugBody(downloadResponse);
    KJ_REQUIRE(downloadResponse.which() == WebSession::Response::CONTENT, downloadDebugBody);
    auto downloadContent = downloadResponse.getContent();
    KJ_REQUIRE(downloadContent.getMimeType() == "application/octet-stream");
    KJ_REQUIRE(downloadContent.getBody().which() ==
        WebSession::Response::Content::Body::STREAM);
    downloadStream.waitForDone(io);
    KJ_REQUIRE(downloadStream.getData().size() == 131072, downloadStream.getData().size());
    KJ_REQUIRE(downloadStream.getData()[0] == 0);
    KJ_REQUIRE(downloadStream.getData()[255] == 255);
    KJ_REQUIRE(downloadStream.getData()[256] == 0);

    auto rangeRequest = session.getRequest();
    rangeRequest.setPath("/range");
    rangeRequest.setIgnoreBody(false);
    auto rangeContext = rangeRequest.initContext();
    rangeContext.setResponseStream(kj::heap<IgnoreByteStream>());
    rangeContext.initCookies(0);
    rangeContext.initAccept(0);
    rangeContext.initAcceptEncoding(0);
    auto rangeHeaders = rangeContext.initAdditionalHeaders(1);
    rangeHeaders[0].setName("range");
    rangeHeaders[0].setValue("bytes=10-19");

    auto rangeResponse = rangeRequest.send().wait(io.waitScope);
    auto rangeDebugBody = responseDebugBody(rangeResponse);
    KJ_REQUIRE(rangeResponse.which() == WebSession::Response::CONTENT, rangeDebugBody);
    auto rangeContent = rangeResponse.getContent();
    KJ_REQUIRE(rangeContent.getStatusCode() ==
        WebSession::Response::SuccessCode::PARTIAL_CONTENT);
    KJ_REQUIRE(rangeContent.getMimeType() == "application/octet-stream");
    KJ_REQUIRE(rangeContent.getBody().which() == WebSession::Response::Content::Body::BYTES);
    auto rangeBody = rangeContent.getBody().getBytes();
    KJ_REQUIRE(rangeBody.size() == 10, rangeBody.size());
    KJ_REQUIRE(rangeBody[0] == 10, rangeBody[0]);
    KJ_REQUIRE(rangeBody[9] == 19, rangeBody[9]);
    KJ_IF_MAYBE(rangeHeader, findResponseHeader(
        rangeResponse, "x-sandstorm-app-range-response")) {
      KJ_REQUIRE(*rangeHeader == "present", *rangeHeader);
    } else {
      KJ_FAIL_REQUIRE("missing range response header");
    }
    KJ_IF_MAYBE(contentRange, findResponseHeader(rangeResponse, "content-range")) {
      KJ_REQUIRE(*contentRange == "bytes 10-19/256", *contentRange);
    } else {
      KJ_FAIL_REQUIRE("missing content-range response header");
    }
    KJ_IF_MAYBE(acceptRanges, findResponseHeader(rangeResponse, "accept-ranges")) {
      KJ_REQUIRE(*acceptRanges == "bytes", *acceptRanges);
    } else {
      KJ_FAIL_REQUIRE("missing accept-ranges response header");
    }

    auto uploadBytes = makeBytes(32768);
    auto uploadRequest = session.postStreamingRequest();
    uploadRequest.setPath("/upload");
    uploadRequest.setMimeType("application/octet-stream");
    uploadRequest.setEncoding("");
    uploadRequest.setExpectedSize(uploadBytes.size());
    auto uploadContext = uploadRequest.initContext();
    uploadContext.setResponseStream(kj::heap<IgnoreByteStream>());
    uploadContext.initCookies(0);
    uploadContext.initAccept(0);
    uploadContext.initAcceptEncoding(0);
    uploadContext.initAdditionalHeaders(0);

    auto uploadStream = uploadRequest.send().wait(io.waitScope).getStream();
    auto uploadResponsePromise = uploadStream.getResponseRequest().send();
    size_t offset = 0;
    for (size_t chunkSize: {size_t(777), size_t(8192), size_t(5000), size_t(1887)}) {
      auto size = kj::min(chunkSize, uploadBytes.size() - offset);
      if (size == 0) break;
      auto write = uploadStream.writeRequest();
      write.setData(uploadBytes.asPtr().slice(offset, offset + size));
      write.send().wait(io.waitScope);
      offset += size;
    }
    while (offset < uploadBytes.size()) {
      auto size = kj::min(size_t(4096), uploadBytes.size() - offset);
      auto write = uploadStream.writeRequest();
      write.setData(uploadBytes.asPtr().slice(offset, offset + size));
      write.send().wait(io.waitScope);
      offset += size;
    }
    uploadStream.doneRequest().send().wait(io.waitScope);
    auto uploadResponse = uploadResponsePromise.wait(io.waitScope);
    auto uploadDebugBody = responseDebugBody(uploadResponse);
    KJ_REQUIRE(uploadResponse.which() == WebSession::Response::CONTENT, uploadDebugBody);
    auto uploadContent = uploadResponse.getContent();
    KJ_REQUIRE(uploadContent.getMimeType().startsWith("application/json"));
    KJ_REQUIRE(uploadContent.getBody().which() == WebSession::Response::Content::Body::BYTES);
    auto uploadBody = kj::str(uploadContent.getBody().getBytes().asChars());
    KJ_REQUIRE(contains(uploadBody, "\"ok\":true"), uploadBody);
    KJ_REQUIRE(contains(uploadBody, "\"method\":\"POST\""), uploadBody);
    KJ_REQUIRE(contains(uploadBody, "\"bodyBytes\":32768"), uploadBody);
    KJ_REQUIRE(contains(uploadBody, kj::str("\"checksum\":", checksum(uploadBytes))), uploadBody);
    KJ_REQUIRE(contains(uploadBody, "\"contentType\":\"application/octet-stream\""), uploadBody);

    if (stress64mEnabled()) {
      constexpr uint64_t STRESS_BYTES = 64ull * 1024 * 1024;

      auto stressDownloadStreamServer = kj::heap<CountingByteStream>();
      auto& stressDownloadStream = *stressDownloadStreamServer;
      auto stressDownloadRequest = session.getRequest();
      stressDownloadRequest.setPath(kj::str("/download?bytes=", STRESS_BYTES));
      stressDownloadRequest.setIgnoreBody(false);
      auto stressDownloadContext = stressDownloadRequest.initContext();
      stressDownloadContext.setResponseStream(kj::mv(stressDownloadStreamServer));
      stressDownloadContext.initCookies(0);
      stressDownloadContext.initAccept(0);
      stressDownloadContext.initAcceptEncoding(0);
      stressDownloadContext.initAdditionalHeaders(0);

      auto stressDownloadResponse = stressDownloadRequest.send().wait(io.waitScope);
      auto stressDownloadDebugBody = responseDebugBody(stressDownloadResponse);
      KJ_REQUIRE(stressDownloadResponse.which() == WebSession::Response::CONTENT,
          stressDownloadDebugBody);
      auto stressDownloadContent = stressDownloadResponse.getContent();
      KJ_REQUIRE(stressDownloadContent.getMimeType() == "application/octet-stream");
      KJ_REQUIRE(stressDownloadContent.getBody().which() ==
          WebSession::Response::Content::Body::STREAM);
      stressDownloadStream.waitForDone(io);
      KJ_REQUIRE(stressDownloadStream.getByteCount() == STRESS_BYTES,
          stressDownloadStream.getByteCount());
      KJ_REQUIRE(stressDownloadStream.getChecksum() == checksumPattern(STRESS_BYTES),
          stressDownloadStream.getChecksum(), checksumPattern(STRESS_BYTES));

      auto tooLargeDownloadRequest = session.getRequest();
      tooLargeDownloadRequest.setPath(kj::str("/download?bytes=", STRESS_BYTES + 1));
      tooLargeDownloadRequest.setIgnoreBody(false);
      auto tooLargeDownloadContext = tooLargeDownloadRequest.initContext();
      tooLargeDownloadContext.setResponseStream(kj::heap<IgnoreByteStream>());
      tooLargeDownloadContext.initCookies(0);
      tooLargeDownloadContext.initAccept(0);
      tooLargeDownloadContext.initAcceptEncoding(0);
      tooLargeDownloadContext.initAdditionalHeaders(0);

      auto tooLargeDownloadResponse = tooLargeDownloadRequest.send().wait(io.waitScope);
      auto tooLargeDownloadDebugBody = responseDebugBody(tooLargeDownloadResponse);
      KJ_REQUIRE(tooLargeDownloadResponse.which() == WebSession::Response::SERVER_ERROR,
          tooLargeDownloadDebugBody);
      KJ_REQUIRE(contains(tooLargeDownloadDebugBody,
          "streaming isolate response declared size exceeds maximum allowed size"),
          tooLargeDownloadDebugBody);

      auto stressUploadRequest = session.postStreamingRequest();
      stressUploadRequest.setPath("/upload");
      stressUploadRequest.setMimeType("application/octet-stream");
      stressUploadRequest.setEncoding("");
      stressUploadRequest.setExpectedSize(STRESS_BYTES);
      auto stressUploadContext = stressUploadRequest.initContext();
      stressUploadContext.setResponseStream(kj::heap<IgnoreByteStream>());
      stressUploadContext.initCookies(0);
      stressUploadContext.initAccept(0);
      stressUploadContext.initAcceptEncoding(0);
      stressUploadContext.initAdditionalHeaders(0);

      auto stressUploadStream = stressUploadRequest.send().wait(io.waitScope).getStream();
      auto stressUploadResponsePromise = stressUploadStream.getResponseRequest().send();
      uint64_t stressUploadOffset = 0;
      while (stressUploadOffset < STRESS_BYTES) {
        auto size = static_cast<size_t>(kj::min(uint64_t(64 * 1024),
            STRESS_BYTES - stressUploadOffset));
        auto chunk = makeBytesAt(size, stressUploadOffset);
        auto write = stressUploadStream.writeRequest();
        write.setData(chunk);
        write.send().wait(io.waitScope);
        stressUploadOffset += size;
      }
      stressUploadStream.doneRequest().send().wait(io.waitScope);
      auto stressUploadResponse = stressUploadResponsePromise.wait(io.waitScope);
      auto stressUploadDebugBody = responseDebugBody(stressUploadResponse);
      KJ_REQUIRE(stressUploadResponse.which() == WebSession::Response::CONTENT,
          stressUploadDebugBody);
      auto stressUploadContent = stressUploadResponse.getContent();
      KJ_REQUIRE(stressUploadContent.getBody().which() == WebSession::Response::Content::Body::BYTES);
      auto stressUploadBody = kj::str(stressUploadContent.getBody().getBytes().asChars());
      KJ_REQUIRE(contains(stressUploadBody, "\"ok\":true"), stressUploadBody);
      KJ_REQUIRE(contains(stressUploadBody, "\"bodyBytes\":67108864"), stressUploadBody);
      KJ_REQUIRE(contains(stressUploadBody,
          kj::str("\"checksum\":", checksumPattern(STRESS_BYTES))), stressUploadBody);

      auto tooLargeUploadRequest = session.postStreamingRequest();
      tooLargeUploadRequest.setPath("/upload");
      tooLargeUploadRequest.setMimeType("application/octet-stream");
      tooLargeUploadRequest.setEncoding("");
      tooLargeUploadRequest.setExpectedSize(STRESS_BYTES + 1);
      auto tooLargeUploadContext = tooLargeUploadRequest.initContext();
      tooLargeUploadContext.setResponseStream(kj::heap<IgnoreByteStream>());
      tooLargeUploadContext.initCookies(0);
      tooLargeUploadContext.initAccept(0);
      tooLargeUploadContext.initAcceptEncoding(0);
      tooLargeUploadContext.initAdditionalHeaders(0);

      try {
        tooLargeUploadRequest.send().wait(io.waitScope);
        KJ_FAIL_REQUIRE("expected over-limit streaming upload to fail");
      } catch (kj::Exception& exception) {
        auto description = exception.getDescription();
        KJ_REQUIRE(contains(description,
            "streaming isolate request expected size exceeds maximum allowed size"), description);
      }
    }

    auto headersRequest = session.getRequest();
    headersRequest.setPath("/headers");
    headersRequest.setIgnoreBody(false);
    auto headersContext = headersRequest.initContext();
    headersContext.setResponseStream(kj::heap<IgnoreByteStream>());
    headersContext.initCookies(0);
    headersContext.initAccept(0);
    headersContext.initAcceptEncoding(0);
    headersContext.initAdditionalHeaders(0);

    auto headersResponse = headersRequest.send().wait(io.waitScope);
    auto headersDebugBody = responseDebugBody(headersResponse);
    KJ_REQUIRE(headersResponse.which() == WebSession::Response::CONTENT, headersDebugBody);
    KJ_REQUIRE(headersResponse.getContent().getMimeType().startsWith("text/plain"));
    KJ_REQUIRE(headersResponse.getAdditionalHeaders().size() == 1,
        headersResponse.getAdditionalHeaders().size());
    KJ_REQUIRE(headersResponse.getAdditionalHeaders()[0].getName() ==
        "x-sandstorm-app-test-response");
    KJ_REQUIRE(headersResponse.getAdditionalHeaders()[0].getValue() == "present");
    KJ_REQUIRE(!headersResponse.hasCachePolicy());

    auto setCookieRequest = session.getRequest();
    setCookieRequest.setPath("/set-cookie");
    setCookieRequest.setIgnoreBody(false);
    auto setCookieContext = setCookieRequest.initContext();
    setCookieContext.setResponseStream(kj::heap<IgnoreByteStream>());
    setCookieContext.initCookies(0);
    setCookieContext.initAccept(0);
    setCookieContext.initAcceptEncoding(0);
    setCookieContext.initAdditionalHeaders(0);

    auto setCookieResponse = setCookieRequest.send().wait(io.waitScope);
    auto setCookieDebugBody = responseDebugBody(setCookieResponse);
    KJ_REQUIRE(setCookieResponse.which() == WebSession::Response::CONTENT, setCookieDebugBody);
    KJ_REQUIRE(setCookieResponse.getSetCookies().size() == 0);
    KJ_REQUIRE(setCookieResponse.getAdditionalHeaders().size() == 1,
        setCookieResponse.getAdditionalHeaders().size());
    KJ_REQUIRE(setCookieResponse.getAdditionalHeaders()[0].getName() ==
        "x-sandstorm-app-cookie-test");
    KJ_REQUIRE(setCookieResponse.getAdditionalHeaders()[0].getValue() == "present");

    auto cacheRevalidateRequest = session.getRequest();
    cacheRevalidateRequest.setPath("/cache-revalidate");
    cacheRevalidateRequest.setIgnoreBody(false);
    auto cacheRevalidateContext = cacheRevalidateRequest.initContext();
    cacheRevalidateContext.setResponseStream(kj::heap<IgnoreByteStream>());
    cacheRevalidateContext.initCookies(0);
    cacheRevalidateContext.initAccept(0);
    cacheRevalidateContext.initAcceptEncoding(0);
    cacheRevalidateContext.initAdditionalHeaders(0);

    auto cacheRevalidateResponse = cacheRevalidateRequest.send().wait(io.waitScope);
    KJ_REQUIRE(cacheRevalidateResponse.which() == WebSession::Response::CONTENT,
        responseDebugBody(cacheRevalidateResponse));
    KJ_REQUIRE(cacheRevalidateResponse.hasCachePolicy());
    KJ_REQUIRE(cacheRevalidateResponse.getCachePolicy().getWithCheck() ==
        WebSession::CachePolicy::Scope::PER_SESSION);
    KJ_REQUIRE(cacheRevalidateResponse.getCachePolicy().getPermanent() ==
        WebSession::CachePolicy::Scope::NONE);
    KJ_REQUIRE(cacheRevalidateResponse.getAdditionalHeaders().size() == 0,
        cacheRevalidateResponse.getAdditionalHeaders().size());

    auto cacheImmutableRequest = session.getRequest();
    cacheImmutableRequest.setPath("/cache-immutable");
    cacheImmutableRequest.setIgnoreBody(false);
    auto cacheImmutableContext = cacheImmutableRequest.initContext();
    cacheImmutableContext.setResponseStream(kj::heap<IgnoreByteStream>());
    cacheImmutableContext.initCookies(0);
    cacheImmutableContext.initAccept(0);
    cacheImmutableContext.initAcceptEncoding(0);
    cacheImmutableContext.initAdditionalHeaders(0);

    auto cacheImmutableResponse = cacheImmutableRequest.send().wait(io.waitScope);
    KJ_REQUIRE(cacheImmutableResponse.which() == WebSession::Response::CONTENT,
        responseDebugBody(cacheImmutableResponse));
    KJ_REQUIRE(cacheImmutableResponse.hasCachePolicy());
    KJ_REQUIRE(cacheImmutableResponse.getCachePolicy().getWithCheck() ==
        WebSession::CachePolicy::Scope::NONE);
    KJ_REQUIRE(cacheImmutableResponse.getCachePolicy().getPermanent() ==
        WebSession::CachePolicy::Scope::PER_SESSION);
    KJ_REQUIRE(cacheImmutableResponse.getAdditionalHeaders().size() == 0,
        cacheImmutableResponse.getAdditionalHeaders().size());

    auto attachmentRequest = session.getRequest();
    attachmentRequest.setPath("/attachment");
    attachmentRequest.setIgnoreBody(false);
    auto attachmentContext = attachmentRequest.initContext();
    attachmentContext.setResponseStream(kj::heap<IgnoreByteStream>());
    attachmentContext.initCookies(0);
    attachmentContext.initAccept(0);
    attachmentContext.initAcceptEncoding(0);
    attachmentContext.initAdditionalHeaders(0);

    auto attachmentResponse = attachmentRequest.send().wait(io.waitScope);
    auto attachmentDebugBody = responseDebugBody(attachmentResponse);
    KJ_REQUIRE(attachmentResponse.which() == WebSession::Response::CONTENT, attachmentDebugBody);
    auto attachmentContent = attachmentResponse.getContent();
    KJ_REQUIRE(attachmentContent.getMimeType().startsWith("text/plain"));
    KJ_REQUIRE(attachmentContent.hasETag());
    KJ_REQUIRE(attachmentContent.getETag().getValue() == "fixture-etag");
    KJ_REQUIRE(!attachmentContent.getETag().getWeak());
    KJ_REQUIRE(attachmentContent.getDisposition().which() ==
        WebSession::Response::Content::Disposition::DOWNLOAD);
    KJ_REQUIRE(attachmentContent.getDisposition().getDownload() == "fixture.txt");

    auto emptyRequest = session.getRequest();
    emptyRequest.setPath("/empty");
    emptyRequest.setIgnoreBody(false);
    auto emptyContext = emptyRequest.initContext();
    emptyContext.setResponseStream(kj::heap<IgnoreByteStream>());
    emptyContext.initCookies(0);
    emptyContext.initAccept(0);
    emptyContext.initAcceptEncoding(0);
    emptyContext.initAdditionalHeaders(0);

    auto emptyResponse = emptyRequest.send().wait(io.waitScope);
    KJ_REQUIRE(emptyResponse.which() == WebSession::Response::NO_CONTENT,
        responseDebugBody(emptyResponse));
    KJ_REQUIRE(!emptyResponse.getNoContent().getShouldResetForm());
    KJ_REQUIRE(emptyResponse.getNoContent().hasETag());
    KJ_REQUIRE(emptyResponse.getNoContent().getETag().getValue() == "empty-etag");
    KJ_REQUIRE(emptyResponse.getNoContent().getETag().getWeak());

    auto notModifiedRequest = session.getRequest();
    notModifiedRequest.setPath("/not-modified");
    notModifiedRequest.setIgnoreBody(false);
    auto notModifiedContext = notModifiedRequest.initContext();
    notModifiedContext.setResponseStream(kj::heap<IgnoreByteStream>());
    notModifiedContext.initCookies(0);
    notModifiedContext.initAccept(0);
    notModifiedContext.initAcceptEncoding(0);
    notModifiedContext.initAdditionalHeaders(0);

    auto notModifiedResponse = notModifiedRequest.send().wait(io.waitScope);
    KJ_REQUIRE(notModifiedResponse.which() == WebSession::Response::PRECONDITION_FAILED,
        responseDebugBody(notModifiedResponse));
    KJ_REQUIRE(notModifiedResponse.getPreconditionFailed().hasMatchingETag());
    KJ_REQUIRE(notModifiedResponse.getPreconditionFailed().getMatchingETag().getValue() ==
        "not-modified-etag");
    KJ_REQUIRE(!notModifiedResponse.getPreconditionFailed().getMatchingETag().getWeak());

    auto errorRequest = session.getRequest();
    errorRequest.setPath("/error");
    errorRequest.setIgnoreBody(false);
    auto errorContext = errorRequest.initContext();
    errorContext.setResponseStream(kj::heap<IgnoreByteStream>());
    errorContext.initCookies(0);
    errorContext.initAccept(0);
    errorContext.initAcceptEncoding(0);
    errorContext.initAdditionalHeaders(0);

    auto errorResponse = errorRequest.send().wait(io.waitScope);
    KJ_REQUIRE(errorResponse.which() == WebSession::Response::CLIENT_ERROR,
        responseDebugBody(errorResponse));
    KJ_REQUIRE(errorResponse.getClientError().getStatusCode() ==
        WebSession::Response::ClientErrorCode::IM_A_TEAPOT);
    KJ_REQUIRE(errorResponse.getClientError().hasNonHtmlBody());
    KJ_REQUIRE(kj::str(errorResponse.getClientError().getNonHtmlBody().getData().asChars()) ==
        "fixture failure");

    auto claimRequest = session.getRequest();
    claimRequest.setPath(
        "/claim-powerbox?token=websession%2Ftest%2Btoken%3D%3D&requiredPermission=view"
        "&save=true&store=true&restore=true&storageKey=websession-saved-capability"
        "&fetch=true&sessionActions=true&dropSaved=true&label=WebSession%20saved%20capability");
    claimRequest.setIgnoreBody(false);
    auto claimContext = claimRequest.initContext();
    claimContext.setResponseStream(kj::heap<IgnoreByteStream>());
    claimContext.initCookies(0);
    claimContext.initAccept(0);
    claimContext.initAcceptEncoding(0);
    claimContext.initAdditionalHeaders(0);

    auto claimResponse = claimRequest.send().wait(io.waitScope);
    auto claimDebugBody = responseDebugBody(claimResponse);
    KJ_REQUIRE(claimResponse.which() == WebSession::Response::CONTENT, claimDebugBody);
    auto claimContent = claimResponse.getContent();
    KJ_REQUIRE(claimContent.getStatusCode() == WebSession::Response::SuccessCode::OK);
    KJ_REQUIRE(claimContent.getBody().which() == WebSession::Response::Content::Body::BYTES);
    auto claimBody = kj::str(claimContent.getBody().getBytes().asChars());
    KJ_REQUIRE(contains(claimBody, "\"ok\":true"), claimBody);
    KJ_REQUIRE(contains(claimBody, "\"type\":\"claimedCapability\""), claimBody);
    KJ_REQUIRE(contains(claimBody, "\"id\":\""), claimBody);
    KJ_REQUIRE(contains(claimBody, "\"claimType\":{\"claimedClass\":true"), claimBody);
    KJ_REQUIRE(contains(claimBody,
        "\"json\":{\"ok\":true,\"type\":\"claimedCapability\",\"id\":\""),
        claimBody);
    KJ_REQUIRE(contains(claimBody,
        "\"claimInfo\":{\"status\":200,\"body\":{\"ok\":true,"
        "\"type\":\"claimedCapabilityInfo\""),
        claimBody);
    KJ_REQUIRE(contains(claimBody, "\"kind\":\"powerboxClaim\""), claimBody);
    KJ_REQUIRE(contains(claimBody, "\"residence\":\"imported\""), claimBody);
    KJ_REQUIRE(contains(claimBody, "\"nativeInterface\":\"unknown\""), claimBody);
    KJ_REQUIRE(contains(claimBody, "\"supportsWebFetch\":true"), claimBody);
    KJ_REQUIRE(contains(claimBody, "\"supportsOutboundHttpFetch\":true"), claimBody);
    KJ_REQUIRE(contains(claimBody, "\"supportsNativeAppRpcTransport\":false"), claimBody);
    KJ_REQUIRE(contains(claimBody, "\"hasNativeCapability\":true"), claimBody);
    KJ_REQUIRE(contains(claimBody, "\"liveForwardable\":true"), claimBody);
    KJ_REQUIRE(contains(claimBody, "\"save\":{\"status\":200,\"body\":{\"ok\":true"), claimBody);
    KJ_REQUIRE(contains(claimBody, "\"type\":\"savedCapability\""), claimBody);
    KJ_REQUIRE(contains(claimBody, "\"tokenEncoding\":\"base64url\""), claimBody);
    KJ_REQUIRE(contains(claimBody, "\"typed\":{\"savedClass\":true"), claimBody);
    KJ_REQUIRE(contains(claimBody,
        "\"restore\":{\"status\":200,\"body\":{\"ok\":true,\"type\":\"claimedCapability\""),
        claimBody);
    KJ_REQUIRE(contains(claimBody,
        "\"info\":{\"status\":200,\"body\":{\"ok\":true,\"type\":\"claimedCapabilityInfo\""),
        claimBody);
    KJ_REQUIRE(contains(claimBody, "\"kind\":\"restored\""), claimBody);
    KJ_REQUIRE(contains(claimBody, "\"typed\":{\"restoredClass\":true"), claimBody);
    KJ_REQUIRE(contains(claimBody,
        "\"stored\":{\"key\":\"websession-saved-capability\",\"put\":{\"status\":200"),
        claimBody);
    KJ_REQUIRE(contains(claimBody, "\"token\":\"d2Vic2Vzc2lvbi1zYXZlZC10b2tlbg\""), claimBody);
    KJ_REQUIRE(contains(claimBody,
        "\"fetched\":{\"status\":200,\"body\":{\"ok\":true,"
        "\"source\":\"fake-claimed-capability\","
        "\"path\":\"capability-echo?source=claim\""),
        claimBody);
    KJ_REQUIRE(contains(claimBody, "\"offer\":{\"ok\":true}"), claimBody);
    KJ_REQUIRE(contains(claimBody, "\"fulfill\":{\"ok\":true}"), claimBody);
    KJ_REQUIRE(contains(claimBody, "\"tie\":{\"ok\":true,\"claimedClass\":true"), claimBody);
    KJ_REQUIRE(contains(claimBody, "\"kind\":\"tied\""), claimBody);
    KJ_REQUIRE(contains(claimBody,
        "\"dropTied\":{\"ok\":true}"),
        claimBody);
    KJ_REQUIRE(contains(claimBody, "\"dropRestored\":{\"status\":200,\"body\":{\"ok\":true}}"),
        claimBody);
    KJ_REQUIRE(contains(claimBody, "\"drop\":{\"status\":200,\"body\":{\"ok\":true}}"), claimBody);
    KJ_REQUIRE(contains(claimBody, "\"dropSaved\":{\"status\":200,\"body\":{\"ok\":true}}"),
        claimBody);
    KJ_REQUIRE(sessionContextRef.claimCount == 1, sessionContextRef.claimCount);
    KJ_REQUIRE(sessionContextRef.saveCount == 1, sessionContextRef.saveCount);
    KJ_REQUIRE(sessionContextRef.restoreCount == 1, sessionContextRef.restoreCount);
    KJ_REQUIRE(sessionContextRef.tokenDropCount == 1, sessionContextRef.tokenDropCount);
    KJ_REQUIRE(sessionContextRef.offerCount == 1, sessionContextRef.offerCount);
    KJ_REQUIRE(sessionContextRef.fulfillCount == 1, sessionContextRef.fulfillCount);
    KJ_REQUIRE(sessionContextRef.tieCount == 1, sessionContextRef.tieCount);

    auto outboundRequest = session.getRequest();
    outboundRequest.setPath("/outbound-http-helper-self-test");
    outboundRequest.setIgnoreBody(false);
    auto outboundContext = outboundRequest.initContext();
    outboundContext.setResponseStream(kj::heap<IgnoreByteStream>());
    outboundContext.initCookies(0);
    outboundContext.initAccept(0);
    outboundContext.initAcceptEncoding(0);
    outboundContext.initAdditionalHeaders(0);

    auto outboundResponse = outboundRequest.send().wait(io.waitScope);
    auto outboundDebugBody = responseDebugBody(outboundResponse);
    KJ_REQUIRE(outboundResponse.which() == WebSession::Response::CONTENT,
        outboundDebugBody);
    auto outboundContent = outboundResponse.getContent();
    KJ_REQUIRE(outboundContent.getStatusCode() == WebSession::Response::SuccessCode::OK);
    KJ_REQUIRE(outboundContent.getBody().which() ==
        WebSession::Response::Content::Body::BYTES);
    auto outboundBody = kj::str(outboundContent.getBody().getBytes().asChars());
    KJ_REQUIRE(contains(outboundBody, "\"ok\":true"), outboundBody);
    KJ_REQUIRE(contains(outboundBody, "\"capabilityInfo\":{\"ok\":true"), outboundBody);
    KJ_REQUIRE(contains(outboundBody, "\"kind\":\"powerboxClaim\""), outboundBody);
    KJ_REQUIRE(contains(outboundBody, "\"residence\":\"imported\""), outboundBody);
    KJ_REQUIRE(contains(outboundBody, "\"nativeInterface\":\"outboundHttpSession\""),
        outboundBody);
    KJ_REQUIRE(contains(outboundBody, "\"supportsWebFetch\":false"), outboundBody);
    KJ_REQUIRE(contains(outboundBody, "\"supportsOutboundHttpFetch\":true"), outboundBody);
    KJ_REQUIRE(contains(outboundBody, "\"supportsNativeAppRpcTransport\":false"), outboundBody);
    KJ_REQUIRE(contains(outboundBody,
        "\"message\":\"ClaimedCapability nativeInterface outboundHttpSession cannot be used "
        "with fetch(); use asOutboundHttp().fetch() instead\""),
        outboundBody);
    KJ_REQUIRE(contains(outboundBody, "\"outboundClass\":true"), outboundBody);
    KJ_REQUIRE(contains(outboundBody, "\"status\":201"), outboundBody);
    KJ_REQUIRE(contains(outboundBody, "\"statusText\":\"Created\""), outboundBody);
    KJ_REQUIRE(contains(outboundBody, "\"contentType\":\"application/json; charset=utf-8\""),
        outboundBody);
    KJ_REQUIRE(contains(outboundBody, "\"outboundHeader\":\"yes\""), outboundBody);
    KJ_REQUIRE(contains(outboundBody, "\"source\":\"fake-outbound-http\""), outboundBody);
    KJ_REQUIRE(contains(outboundBody, "\"path\":\"v1/chat/completions?model=test\""),
        outboundBody);
    KJ_REQUIRE(contains(outboundBody, "\"authorization\":\"Bearer isolate-test\""), outboundBody);
    KJ_REQUIRE(contains(outboundBody, "\"body\":\"hello\""), outboundBody);
    KJ_REQUIRE(contains(outboundBody, "\"drop\":{\"ok\":true}"), outboundBody);
    KJ_REQUIRE(sessionContextRef.claimCount == 2, sessionContextRef.claimCount);

    auto storageHelperRequest = session.getRequest();
    storageHelperRequest.setPath("/powerbox-storage-helper-self-test");
    storageHelperRequest.setIgnoreBody(false);
    auto storageHelperContext = storageHelperRequest.initContext();
    storageHelperContext.setResponseStream(kj::heap<IgnoreByteStream>());
    storageHelperContext.initCookies(0);
    storageHelperContext.initAccept(0);
    storageHelperContext.initAcceptEncoding(0);
    storageHelperContext.initAdditionalHeaders(0);

    auto storageHelperResponse = storageHelperRequest.send().wait(io.waitScope);
    auto storageHelperDebugBody = responseDebugBody(storageHelperResponse);
    KJ_REQUIRE(storageHelperResponse.which() == WebSession::Response::CONTENT,
        storageHelperDebugBody);
    auto storageHelperContent = storageHelperResponse.getContent();
    KJ_REQUIRE(storageHelperContent.getStatusCode() == WebSession::Response::SuccessCode::OK);
    KJ_REQUIRE(storageHelperContent.getBody().which() ==
        WebSession::Response::Content::Body::BYTES);
    auto storageHelperBody = kj::str(storageHelperContent.getBody().getBytes().asChars());
    KJ_REQUIRE(contains(storageHelperBody, "\"ok\":true"), storageHelperBody);
    KJ_REQUIRE(contains(storageHelperBody, "\"capabilityClass\":true"), storageHelperBody);
    KJ_REQUIRE(contains(storageHelperBody, "\"savedClass\":true"), storageHelperBody);
    KJ_REQUIRE(contains(storageHelperBody, "\"storageKey\":\"powerbox-storage-helper-token\""),
        storageHelperBody);
    KJ_REQUIRE(contains(storageHelperBody, "\"token\":\"d2Vic2Vzc2lvbi1zYXZlZC10b2tlbg\""),
        storageHelperBody);
    KJ_REQUIRE(contains(storageHelperBody,
        "\"source\":\"fake-claimed-capability\","
        "\"path\":\"capability-echo?source=helper-original\""),
        storageHelperBody);
    KJ_REQUIRE(contains(storageHelperBody,
        "\"source\":\"fake-claimed-capability\","
        "\"path\":\"capability-echo?source=helper-restored\""),
        storageHelperBody);
    KJ_REQUIRE(contains(storageHelperBody,
        "\"source\":\"fake-claimed-capability\","
        "\"path\":\"capability-echo?source=helper-fetch-saved\""),
        storageHelperBody);
    KJ_REQUIRE(contains(storageHelperBody,
        "\"storageKey\":\"powerbox-storage-helper-handle-token\""),
        storageHelperBody);
    KJ_REQUIRE(contains(storageHelperBody,
        "\"restored\":{\"ok\":true,\"found\":true,"
        "\"capabilityClass\":true"),
        storageHelperBody);
    KJ_REQUIRE(contains(storageHelperBody,
        "\"source\":\"exported-web-session\","
        "\"method\":\"GET\","
        "\"pathname\":\"/exported/capability-echo\","
        "\"search\":\"?source=helper-handle-fetch\""),
        storageHelperBody);
    KJ_REQUIRE(contains(storageHelperBody, "\"dropOriginal\":{\"ok\":true}"), storageHelperBody);
    KJ_REQUIRE(contains(storageHelperBody, "\"dropRestored\":{\"ok\":true}"), storageHelperBody);
    KJ_REQUIRE(contains(storageHelperBody, "\"dropHandleClaimed\":{\"ok\":true}"),
        storageHelperBody);
    KJ_REQUIRE(contains(storageHelperBody,
        "\"dropHandleSaved\":{\"ok\":true,"
        "\"storageKey\":\"powerbox-storage-helper-handle-token\","
        "\"dropped\":true"),
        storageHelperBody);
    KJ_REQUIRE(contains(storageHelperBody,
        "\"dropSaved\":{\"ok\":true,\"storageKey\":\"powerbox-storage-helper-token\","
        "\"dropped\":true"),
        storageHelperBody);
    KJ_REQUIRE(contains(storageHelperBody,
        "\"afterDrop\":{\"ok\":true,\"storageKey\":\"powerbox-storage-helper-token\","
        "\"found\":false"),
        storageHelperBody);
    KJ_REQUIRE(sessionContextRef.claimCount == 3, sessionContextRef.claimCount);
    KJ_REQUIRE(sessionContextRef.saveCount == 2, sessionContextRef.saveCount);
    KJ_REQUIRE(sessionContextRef.restoreCount == 4, sessionContextRef.restoreCount);
    KJ_REQUIRE(sessionContextRef.tokenDropCount == 3, sessionContextRef.tokenDropCount);

    auto exportRequest = session.getRequest();
    exportRequest.setPath("/export-web-session");
    exportRequest.setIgnoreBody(false);
    auto exportContext = exportRequest.initContext();
    exportContext.setResponseStream(kj::heap<IgnoreByteStream>());
    exportContext.initCookies(0);
    exportContext.initAccept(0);
    exportContext.initAcceptEncoding(0);
    exportContext.initAdditionalHeaders(0);

    auto exportResponse = exportRequest.send().wait(io.waitScope);
    auto exportDebugBody = responseDebugBody(exportResponse);
    KJ_REQUIRE(exportResponse.which() == WebSession::Response::CONTENT, exportDebugBody);
    auto exportContent = exportResponse.getContent();
    KJ_REQUIRE(exportContent.getStatusCode() == WebSession::Response::SuccessCode::OK);
    KJ_REQUIRE(exportContent.getBody().which() == WebSession::Response::Content::Body::BYTES);
    auto exportBody = kj::str(exportContent.getBody().getBytes().asChars());
    KJ_REQUIRE(contains(exportBody, "\"ok\":true"), exportBody);
    KJ_REQUIRE(contains(exportBody, "\"capabilityClass\":true"), exportBody);
    KJ_REQUIRE(contains(exportBody,
        "\"capability\":{\"ok\":true,\"type\":\"claimedCapability\",\"id\":\""),
        exportBody);

    auto objectActionsRequest = session.getRequest();
    objectActionsRequest.setPath("/object-capability-self-test?sessionActions=true");
    objectActionsRequest.setIgnoreBody(false);
    auto objectActionsContext = objectActionsRequest.initContext();
    objectActionsContext.setResponseStream(kj::heap<IgnoreByteStream>());
    objectActionsContext.initCookies(0);
    objectActionsContext.initAccept(0);
    objectActionsContext.initAcceptEncoding(0);
    objectActionsContext.initAdditionalHeaders(0);

    auto objectActionsResponse = objectActionsRequest.send().wait(io.waitScope);
    auto objectActionsDebugBody = responseDebugBody(objectActionsResponse);
    KJ_REQUIRE(objectActionsResponse.which() == WebSession::Response::CONTENT,
        objectActionsDebugBody);
    auto objectActionsContent = objectActionsResponse.getContent();
    KJ_REQUIRE(objectActionsContent.getStatusCode() == WebSession::Response::SuccessCode::OK);
    KJ_REQUIRE(objectActionsContent.getBody().which() ==
        WebSession::Response::Content::Body::BYTES);
    auto objectActionsBody = kj::str(objectActionsContent.getBody().getBytes().asChars());
    KJ_REQUIRE(contains(objectActionsBody, "\"ok\":true"), objectActionsBody);
    KJ_REQUIRE(contains(objectActionsBody, "\"childClass\":true"), objectActionsBody);
    KJ_REQUIRE(contains(objectActionsBody, "\"sessionActions\":{\"offer\":{\"ok\":true}"),
        objectActionsBody);
    KJ_REQUIRE(contains(objectActionsBody, "\"fulfill\":{\"ok\":true}"), objectActionsBody);
    KJ_REQUIRE(contains(objectActionsBody, "\"tie\":{\"ok\":true,\"claimedClass\":true"),
        objectActionsBody);
    KJ_REQUIRE(contains(objectActionsBody, "\"dropTied\":{\"ok\":true}"), objectActionsBody);
    KJ_REQUIRE(contains(objectActionsBody, "\"drop\":{\"ok\":true}"), objectActionsBody);
    KJ_REQUIRE(sessionContextRef.offerCount == 2, sessionContextRef.offerCount);
    KJ_REQUIRE(sessionContextRef.fulfillCount == 2, sessionContextRef.fulfillCount);
    KJ_REQUIRE(sessionContextRef.tieCount == 2, sessionContextRef.tieCount);

    auto descriptorActionsRequest = session.getRequest();
    descriptorActionsRequest.setPath(
        "/object-capability-self-test?sessionActions=true&apiDescriptor=true");
    descriptorActionsRequest.setIgnoreBody(false);
    auto descriptorActionsContext = descriptorActionsRequest.initContext();
    descriptorActionsContext.setResponseStream(kj::heap<IgnoreByteStream>());
    descriptorActionsContext.initCookies(0);
    descriptorActionsContext.initAccept(0);
    descriptorActionsContext.initAcceptEncoding(0);
    descriptorActionsContext.initAdditionalHeaders(0);

    auto descriptorActionsResponse = descriptorActionsRequest.send().wait(io.waitScope);
    auto descriptorActionsDebugBody = responseDebugBody(descriptorActionsResponse);
    KJ_REQUIRE(descriptorActionsResponse.which() == WebSession::Response::CONTENT,
        descriptorActionsDebugBody);
    auto descriptorActionsContent = descriptorActionsResponse.getContent();
    KJ_REQUIRE(descriptorActionsContent.getStatusCode() == WebSession::Response::SuccessCode::OK);
    KJ_REQUIRE(sessionContextRef.offerCount == 3, sessionContextRef.offerCount);
    KJ_REQUIRE(sessionContextRef.fulfillCount == 3, sessionContextRef.fulfillCount);
    KJ_REQUIRE(sessionContextRef.tieCount == 3, sessionContextRef.tieCount);
    KJ_REQUIRE(sessionContextRef.apiDescriptorCount == 2, sessionContextRef.apiDescriptorCount);

    auto providerDescriptorActionsRequest = session.getRequest();
    providerDescriptorActionsRequest.setPath(
        "/object-capability-self-test?sessionActions=true&providerDescriptor=true");
    providerDescriptorActionsRequest.setIgnoreBody(false);
    auto providerDescriptorActionsContext = providerDescriptorActionsRequest.initContext();
    providerDescriptorActionsContext.setResponseStream(kj::heap<IgnoreByteStream>());
    providerDescriptorActionsContext.initCookies(0);
    providerDescriptorActionsContext.initAccept(0);
    providerDescriptorActionsContext.initAcceptEncoding(0);
    providerDescriptorActionsContext.initAdditionalHeaders(0);

    auto providerDescriptorActionsResponse =
        providerDescriptorActionsRequest.send().wait(io.waitScope);
    auto providerDescriptorActionsDebugBody =
        responseDebugBody(providerDescriptorActionsResponse);
    KJ_REQUIRE(providerDescriptorActionsResponse.which() == WebSession::Response::CONTENT,
        providerDescriptorActionsDebugBody);
    auto providerDescriptorActionsContent = providerDescriptorActionsResponse.getContent();
    KJ_REQUIRE(providerDescriptorActionsContent.getStatusCode() ==
        WebSession::Response::SuccessCode::OK);
    KJ_REQUIRE(sessionContextRef.offerCount == 4, sessionContextRef.offerCount);
    KJ_REQUIRE(sessionContextRef.fulfillCount == 4, sessionContextRef.fulfillCount);
    KJ_REQUIRE(sessionContextRef.tieCount == 4, sessionContextRef.tieCount);
    KJ_REQUIRE(sessionContextRef.providerDescriptorCount == 2,
        sessionContextRef.providerDescriptorCount);

    auto offerSessionContext = kj::heap<FakeSessionContext>();
    auto& offerSessionContextRef = *offerSessionContext;
    auto offerSessionRequest = view.newOfferSessionRequest();
    auto offerUserInfo = offerSessionRequest.initUserInfo();
    offerUserInfo.initDisplayName().setDefaultText("Offer Session Test User");
    offerUserInfo.setPreferredHandle("offer-session-test");
    offerUserInfo.initPermissions(1).set(0, true);
    offerSessionRequest.setContext(kj::mv(offerSessionContext));
    offerSessionRequest.setSessionType(capnp::typeId<WebSession>());
    auto offerSessionParams = offerSessionRequest.getSessionParams().initAs<WebSession::Params>();
    offerSessionParams.setBasePath("https://ui-offer-test.invalid");
    offerSessionParams.setUserAgent("isolate-websession-offer-client");
    offerSessionRequest.setOffer(kj::heap<FakeClaimedCapability>(offerSessionContextRef.saveCount));
    auto offerDescriptorTag = offerSessionRequest.initDescriptor().initTags(1)[0];
    offerDescriptorTag.setId(capnp::typeId<ApiSession>());
    auto offerApiTag = offerDescriptorTag.initValue().initAs<ApiSession::PowerboxTag>();
    offerApiTag.setCanonicalUrl("https://api.offer-session.test/v1");
    offerApiTag.initOauthScopes(2);
    offerApiTag.getOauthScopes()[0].setName("offer.read");
    offerApiTag.getOauthScopes()[1].setName("offer.write");
    offerSessionRequest.setTabId(kj::StringPtr("offer-session-tab").asBytes());

    auto offerSession = offerSessionRequest.send().wait(io.waitScope)
        .getSession().castAs<WebSession>();
    auto offerGetRequest = offerSession.getRequest();
    offerGetRequest.setPath("/offer-session");
    offerGetRequest.setIgnoreBody(false);
    auto offerGetContext = offerGetRequest.initContext();
    offerGetContext.setResponseStream(kj::heap<IgnoreByteStream>());
    offerGetContext.initCookies(0);
    offerGetContext.initAccept(0);
    offerGetContext.initAcceptEncoding(0);
    offerGetContext.initAdditionalHeaders(0);

    auto offerResponse = offerGetRequest.send().wait(io.waitScope);
    auto offerDebugBody = responseDebugBody(offerResponse);
    KJ_REQUIRE(offerResponse.which() == WebSession::Response::CONTENT, offerDebugBody);
    auto offerContent = offerResponse.getContent();
    KJ_REQUIRE(offerContent.getStatusCode() == WebSession::Response::SuccessCode::OK);
    KJ_REQUIRE(offerContent.getBody().which() == WebSession::Response::Content::Body::BYTES);
    auto offerBody = kj::str(offerContent.getBody().getBytes().asChars());
    KJ_REQUIRE(contains(offerBody, "\"ok\":true"), offerBody);
    KJ_REQUIRE(contains(offerBody, "\"sessionType\":\"offer\""), offerBody);
    KJ_REQUIRE(contains(offerBody, "\"offeredCapabilityId\":\""), offerBody);
    KJ_REQUIRE(contains(offerBody, "\"offeredClass\":true"), offerBody);
    KJ_REQUIRE(contains(offerBody,
        "\"descriptor\":{\"type\":\"apiSession\","
        "\"canonicalUrl\":\"https://api.offer-session.test/v1\","
        "\"oauthScopes\":[\"offer.read\",\"offer.write\"]}"),
        offerBody);
    KJ_REQUIRE(contains(offerBody, "\"capabilityClass\":true"), offerBody);
    KJ_REQUIRE(contains(offerBody,
        "\"claimedInfo\":{\"ok\":true,\"type\":\"claimedCapabilityInfo\""),
        offerBody);
    KJ_REQUIRE(contains(offerBody, "\"kind\":\"powerboxOffer\""), offerBody);
    KJ_REQUIRE(contains(offerBody, "\"residence\":\"imported\""), offerBody);
    KJ_REQUIRE(contains(offerBody, "\"nativeInterface\":\"apiSession\""), offerBody);
    KJ_REQUIRE(contains(offerBody, "\"supportsWebFetch\":true"), offerBody);
    KJ_REQUIRE(contains(offerBody, "\"supportsOutboundHttpFetch\":false"), offerBody);
    KJ_REQUIRE(contains(offerBody, "\"supportsNativeAppRpcTransport\":false"), offerBody);
    KJ_REQUIRE(contains(offerBody,
        "\"fetched\":{\"status\":200,\"body\":{\"ok\":true,"
        "\"source\":\"fake-claimed-capability\","
        "\"path\":\"capability-echo?source=offer-session\""),
        offerBody);
    KJ_REQUIRE(contains(offerBody, "\"drop\":{\"ok\":true}"), offerBody);

    auto badClaimRequest = session.getRequest();
    badClaimRequest.setPath(
        "/claim-powerbox?token=websession%2Ftest%2Btoken%3D%3D"
        "&requiredPermission=not-a-permission");
    badClaimRequest.setIgnoreBody(false);
    auto badClaimContext = badClaimRequest.initContext();
    badClaimContext.setResponseStream(kj::heap<IgnoreByteStream>());
    badClaimContext.initCookies(0);
    badClaimContext.initAccept(0);
    badClaimContext.initAcceptEncoding(0);
    badClaimContext.initAdditionalHeaders(0);

    auto badClaimResponse = badClaimRequest.send().wait(io.waitScope);
    KJ_REQUIRE(badClaimResponse.which() == WebSession::Response::CLIENT_ERROR);
    auto badClaim = badClaimResponse.getClientError();
    KJ_REQUIRE(badClaim.getStatusCode() == WebSession::Response::ClientErrorCode::BAD_REQUEST);
    KJ_REQUIRE(badClaim.hasNonHtmlBody());
    auto badClaimBody = kj::str(badClaim.getNonHtmlBody().getData().asChars());
    KJ_REQUIRE(contains(badClaimBody,
        "unknown required permission: not-a-permission; this app defines permissions: view"),
        badClaimBody);
    KJ_REQUIRE(contains(badClaimBody,
        "requiredPermissions must use names from this app's viewInfo.permissions"),
        badClaimBody);
    KJ_REQUIRE(sessionContextRef.claimCount == 3, sessionContextRef.claimCount);
    KJ_REQUIRE(sessionContextRef.saveCount == 2, sessionContextRef.saveCount);
    KJ_REQUIRE(sessionContextRef.restoreCount == 10, sessionContextRef.restoreCount);
    KJ_REQUIRE(sessionContextRef.tokenDropCount == 6, sessionContextRef.tokenDropCount);

    auto standardClaimRequest = session.postRequest();
    standardClaimRequest.setPath("/__sandstorm/powerbox/claim");
    auto standardClaimContentRequest = standardClaimRequest.initContent();
    standardClaimContentRequest.setMimeType("application/json; charset=utf-8");
    standardClaimContentRequest.setEncoding("");
    standardClaimContentRequest.setContent(kj::StringPtr(
        "{\"token\":\"websession/test+token==\",\"requiredPermissions\":[\"view\"]}").asBytes());
    auto standardClaimContext = standardClaimRequest.initContext();
    standardClaimContext.setResponseStream(kj::heap<IgnoreByteStream>());
    standardClaimContext.initCookies(0);
    standardClaimContext.initAccept(0);
    standardClaimContext.initAcceptEncoding(0);
    standardClaimContext.initAdditionalHeaders(0);

    auto standardClaimResponse = standardClaimRequest.send().wait(io.waitScope);
    auto standardClaimDebugBody = responseDebugBody(standardClaimResponse);
    KJ_REQUIRE(standardClaimResponse.which() == WebSession::Response::CONTENT,
        standardClaimDebugBody);
    auto standardClaimContent = standardClaimResponse.getContent();
    KJ_REQUIRE(standardClaimContent.getStatusCode() == WebSession::Response::SuccessCode::OK);
    KJ_REQUIRE(standardClaimContent.getBody().which() ==
        WebSession::Response::Content::Body::BYTES);
    auto standardClaimBody = kj::str(standardClaimContent.getBody().getBytes().asChars());
    KJ_REQUIRE(contains(standardClaimBody, "\"ok\":true"), standardClaimBody);
    KJ_REQUIRE(contains(standardClaimBody, "\"capability\":{\"ok\":true"), standardClaimBody);
    KJ_REQUIRE(contains(standardClaimBody, "\"type\":\"claimedCapability\""), standardClaimBody);
    KJ_REQUIRE(sessionContextRef.claimCount == 4, sessionContextRef.claimCount);

    supervisor.syncStorageRequest().send().wait(io.waitScope);
    KJ_REQUIRE(sessionContextRef.grainSizeReportCount == 1,
        sessionContextRef.grainSizeReportCount);
    KJ_REQUIRE(sessionContextRef.lastGrainSizeBytes > 0, sessionContextRef.lastGrainSizeBytes);

    auto logStreamServer = kj::heap<CollectByteStream>();
    auto& logStream = *logStreamServer;
    auto watchLogRequest = supervisor.watchLogRequest();
    watchLogRequest.setBacklogAmount(65536);
    watchLogRequest.setStream(kj::mv(logStreamServer));
    auto logHandle = watchLogRequest.send().wait(io.waitScope).getHandle();
    auto logText = logStream.waitForText(io, "isolate integration watchLog fixture");
    KJ_REQUIRE(contains(logText, "isolate integration watchLog fixture"), logText);

    return true;
  }

private:
  kj::ProcessContext& context;
  kj::AsyncIoContext io;
  kj::String socketPath;
  bool coreServerMode = false;
};

}  // namespace sandstorm

KJ_MAIN(sandstorm::IsolateWebSessionClientMain)
