// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2026 Sandstorm contributors
// Licensed under the Apache License, Version 2.0.

#include <capnp/rpc-twoparty.h>
#include <capnp/serialize.h>
#include <kj/async-io.h>
#include <kj/compat/http.h>
#include <kj/debug.h>
#include <kj/map.h>
#include <sandstorm/isolate-account-host.capnp.h>
#include <sandstorm/isolate-supervisor-internal.capnp.h>
#include <sandstorm/outbound-http-session-impl.capnp.h>
#include <sandstorm/outbound-http-session.capnp.h>
#include <sandstorm/supervisor.capnp.h>
#include <sandstorm/util.capnp.h>
#include <sandstorm/web-session.capnp.h>

#include "web-session-websocket.h"

#include <stdio.h>
#include <string.h>

namespace sandstorm {
namespace {

class TestSessionContext final: public SessionContext::Server {};

bool contains(kj::StringPtr haystack, kj::StringPtr needle) {
  if (needle.size() > haystack.size()) return false;
  for (size_t i = 0; i <= haystack.size() - needle.size(); ++i) {
    if (haystack.slice(i).startsWith(needle)) return true;
  }
  return false;
}

class FakeOutboundHttpSession final: public PersistentOutboundHttpSession::Server {
public:
  kj::Promise<void> request(RequestContext context) override {
    auto params = context.getParams();
    KJ_REQUIRE(params.getMethod() == OutboundHttpSession::Method::POST);
    KJ_REQUIRE(params.getPath() == "v1/chat/completions?model=test", params.getPath());
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
        "\"method\":\"POST\",\"path\":\"", params.getPath(),
        "\",\"authorization\":\"Bearer isolate-test\",\"body\":\"hello\"}");
    auto stream = params.getResponseStream();
    auto write = stream.writeRequest();
    write.setData(body.asBytes());
    return write.send().then([stream = kj::mv(stream), body = kj::mv(body)]() mutable {
      return stream.doneRequest().send().then([](auto) {});
    });
  }

  kj::Promise<void> addRequirements(AddRequirementsContext context) override {
    context.getResults().setCap(thisCap().castAs<SystemPersistent>());
    return kj::READY_NOW;
  }
};

class TestCore final: public SandstormCore::Server {
public:
  void setSupervisor(kj::StringPtr grainId, Supervisor::Client supervisor) {
    KJ_IF_MAYBE(existing, supervisors.find(grainId)) {
      *existing = kj::mv(supervisor);
    } else {
      supervisors.insert(kj::str(grainId), kj::mv(supervisor));
    }
  }

  kj::Promise<void> makeToken(MakeTokenContext context) override {
    auto params = context.getParams();
    auto owner = params.getOwner();
    KJ_REQUIRE(owner.which() == ApiTokenOwner::GRAIN,
        "account-host test only supports grain-owned tokens");
    auto ownerGrainId = kj::str(owner.getGrain().getGrainId());
    auto ref = params.getRef();
    if (ref.which() == SupervisorObjectId<>::ROUTE_BACKED_SESSION) {
      auto route = ref.getRouteBackedSession();
      routeType = route.getType();
      routePathPrefix = kj::heapString(route.getPathPrefix());
      routeOwnerGrainId = kj::mv(ownerGrainId);
      routeTokenLive = true;
      context.getResults().setToken(kj::StringPtr("account-route-token").asBytes());
    } else {
      KJ_REQUIRE(ref.which() == SupervisorObjectId<>::APP_REF,
          "account-host test received an unsupported persistent object type");
      capnp::MallocMessageBuilder message;
      message.setRoot(ref.getAppRef());
      appRef = capnp::messageToFlatArray(message);
      appOwnerGrainId = kj::mv(ownerGrainId);
      appTokenLive = true;
      context.getResults().setToken(kj::StringPtr("account-app-token").asBytes());
    }
    return kj::READY_NOW;
  }

  kj::Promise<void> restore(RestoreContext context) override {
    auto token = kj::str(context.getParams().getToken().asChars());
    if (token == "outbound-http-saved-token") {
      context.getResults().setCap(kj::heap<FakeOutboundHttpSession>());
      return kj::READY_NOW;
    }
    kj::StringPtr ownerGrainId;
    if (token == "account-route-token") {
      KJ_REQUIRE(routeTokenLive, "dropped account-host route token was restored");
      ownerGrainId = routeOwnerGrainId;
    } else {
      KJ_REQUIRE(token == "account-app-token" && appTokenLive,
          "unknown account-host test token", token);
      ownerGrainId = appOwnerGrainId;
    }
    KJ_IF_MAYBE(currentSupervisor, supervisors.find(ownerGrainId)) {
      auto request = currentSupervisor->restoreRequest();
      if (token == "account-route-token") {
        auto route = request.getRef().initRouteBackedSession();
        route.setType(routeType);
        route.setPathPrefix(routePathPrefix);
      } else {
        capnp::FlatArrayMessageReader reader(appRef.asPtr());
        request.getRef().setAppRef(reader.getRoot<capnp::AnyPointer>());
      }
      request.setParentToken(token.asBytes());
      return request.send().then([context, token = kj::mv(token)](auto result) mutable {
        context.getResults().setCap(result.getCap());
      });
    }
    KJ_FAIL_REQUIRE("no supervisor registered for token-owning grain", ownerGrainId);
  }

  kj::Promise<void> drop(DropContext context) override {
    auto token = kj::str(context.getParams().getToken().asChars());
    if (token == "account-route-token") {
      KJ_REQUIRE(routeTokenLive, "route-backed token dropped twice");
      routeTokenLive = false;
      return kj::READY_NOW;
    }
    if (token == "account-app-token") {
      KJ_REQUIRE(appTokenLive, "app-persistent token dropped twice");
      appTokenLive = false;
      return kj::READY_NOW;
    }
    KJ_REQUIRE(token == "outbound-http-saved-token", "unknown account-host test token", token);
    return kj::READY_NOW;
  }

  kj::Promise<void> reportGrainSize(ReportGrainSizeContext context) override {
    KJ_REQUIRE(context.getParams().getBytes() > 0);
    return kj::READY_NOW;
  }

private:
  kj::HashMap<kj::String, Supervisor::Client> supervisors;
  SupervisorObjectId<>::RouteBackedSession::Type routeType =
      SupervisorObjectId<>::RouteBackedSession::Type::WEB;
  kj::String routePathPrefix;
  kj::String routeOwnerGrainId;
  bool routeTokenLive = false;
  kj::Array<capnp::word> appRef;
  kj::String appOwnerGrainId;
  bool appTokenLive = false;
};

class IgnoreByteStream final: public ByteStream::Server {
public:
  kj::Promise<void> write(WriteContext context) override {
    (void)context;
    return kj::READY_NOW;
  }
};

class IgnoreWebSocketStream final: public WebSession::WebSocketStream::Server {
public:
  kj::Promise<void> sendBytes(SendBytesContext context) override {
    (void)context;
    return kj::READY_NOW;
  }
};

class CollectByteStream final: public ByteStream::Server {
public:
  explicit CollectByteStream(kj::Own<kj::PromiseFulfiller<kj::String>> doneFulfiller)
      : doneFulfiller(kj::mv(doneFulfiller)) {}

  kj::Promise<void> write(WriteContext context) override {
    data.addAll(context.getParams().getData());
    return kj::READY_NOW;
  }

  kj::Promise<void> done(DoneContext context) override {
    doneFulfiller->fulfill(kj::str(data.asPtr().asChars()));
    return kj::READY_NOW;
  }

private:
  kj::Vector<kj::byte> data;
  kj::Own<kj::PromiseFulfiller<kj::String>> doneFulfiller;
};

class CountingByteStream final: public ByteStream::Server {
public:
  explicit CountingByteStream(kj::Own<kj::PromiseFulfiller<uint64_t>> doneFulfiller)
      : doneFulfiller(kj::mv(doneFulfiller)) {}

  kj::Promise<void> write(WriteContext context) override {
    byteCount += context.getParams().getData().size();
    return kj::READY_NOW;
  }

  kj::Promise<void> done(DoneContext context) override {
    doneFulfiller->fulfill(kj::mv(byteCount));
    return kj::READY_NOW;
  }

private:
  uint64_t byteCount = 0;
  kj::Own<kj::PromiseFulfiller<uint64_t>> doneFulfiller;
};

class TestEntropySource final: public kj::EntropySource {
public:
  void generate(kj::ArrayPtr<kj::byte> buffer) override {
    for (auto i: kj::indices(buffer)) buffer[i] = static_cast<kj::byte>(i * 37 + 11);
  }
};

Supervisor::Client startGrain(kj::WaitScope& waitScope, IsolateAccountHost::Client account,
    SandstormCore::Client core, kj::StringPtr grainId, kj::StringPtr packageId, bool isNew) {
  auto request = account.startGrainRequest();
  request.setGrainId(grainId);
  request.setPackageId(packageId);
  request.setMainModule("worker.js");
  request.setCompatibilityDate("2025-01-01");
  request.setIsNew(isNew);
  request.setCore(core);
  return request.send().wait(waitScope).getSupervisor();
}

void expectStartRejected(kj::WaitScope& waitScope, IsolateAccountHost::Client account,
    SandstormCore::Client core, kj::StringPtr grainId, kj::StringPtr packageId) {
  bool rejected = false;
  try {
    auto supervisor = startGrain(waitScope, account, core, grainId, packageId, true);
    auto keepAlive = supervisor.keepAliveRequest();
    keepAlive.setCore(core);
    keepAlive.send().wait(waitScope);
  } catch (const kj::Exception&) {
    rejected = true;
  }
  KJ_REQUIRE(rejected, "oversized worker package was admitted");
}

WebSession::Client newWebSession(kj::WaitScope& waitScope, Supervisor::Client supervisor) {
  auto view = supervisor.getMainViewRequest().send().wait(waitScope).getView();
  auto sessionRequest = view.newSessionRequest();
  auto userInfo = sessionRequest.initUserInfo();
  userInfo.initDisplayName().setDefaultText("Account host test user");
  userInfo.setPreferredHandle("account-host-test");
  userInfo.initPermissions(1).set(0, true);
  sessionRequest.setContext(kj::heap<TestSessionContext>());
  sessionRequest.setSessionType(capnp::typeId<WebSession>());
  auto sessionParams = sessionRequest.getSessionParams().initAs<WebSession::Params>();
  sessionParams.setBasePath("https://account-host-test.invalid");
  sessionParams.setUserAgent("isolate-account-host-client");
  sessionRequest.setTabId(kj::StringPtr("account-host-test-tab").asBytes());
  return sessionRequest.send().wait(waitScope).getSession().castAs<WebSession>();
}

kj::String fetchPath(kj::WaitScope& waitScope, Supervisor::Client supervisor,
    SandstormCore::Client core, kj::StringPtr path) {
  auto keepAlive = supervisor.keepAliveRequest();
  keepAlive.setCore(core);
  keepAlive.send().wait(waitScope);

  auto session = newWebSession(waitScope, supervisor);

  auto get = session.getRequest();
  get.setPath(path);
  get.setIgnoreBody(false);
  auto context = get.initContext();
  auto streamedBody = kj::newPromiseAndFulfiller<kj::String>();
  context.setResponseStream(kj::heap<CollectByteStream>(kj::mv(streamedBody.fulfiller)));
  context.initCookies(0);
  context.initAccept(0);
  context.initAcceptEncoding(0);
  context.initAdditionalHeaders(0);
  auto response = get.send().wait(waitScope);
  if (response.which() == WebSession::Response::SERVER_ERROR) {
    auto error = response.getServerError();
    KJ_FAIL_REQUIRE("account-host request returned a server error",
        error.getDescriptionHtml(), error.getNonHtmlBody().getData().asChars());
  }
  KJ_REQUIRE(response.which() == WebSession::Response::CONTENT, response.which());
  auto content = response.getContent();
  KJ_REQUIRE(content.getStatusCode() == WebSession::Response::SuccessCode::OK);
  auto body = content.getBody();
  if (body.isBytes()) {
    return kj::str(body.getBytes().asChars());
  }
  KJ_REQUIRE(body.isStream(), "account-host test response had an unknown body shape");
  return streamedBody.promise.wait(waitScope);
}

void testUnknownLengthUploads(kj::AsyncIoContext& io, Supervisor::Client supervisor,
    SandstormCore::Client core) {
  auto keepAlive = supervisor.keepAliveRequest();
  keepAlive.setCore(core);
  keepAlive.send().wait(io.waitScope);
  auto session = newWebSession(io.waitScope, supervisor);

  auto runUpload = [&](uint64_t size) {
    auto request = session.postStreamingRequest();
    request.setPath("upload-stream");
    request.setMimeType("application/octet-stream");
    request.setEncoding("");
    // expectedSize=0 deliberately selects the unknown-length, disk-spooled path.
    request.setExpectedSize(0);
    auto context = request.initContext();
    auto streamedBody = kj::newPromiseAndFulfiller<kj::String>();
    context.setResponseStream(kj::heap<CollectByteStream>(kj::mv(streamedBody.fulfiller)));
    context.initCookies(0);
    context.initAccept(0);
    context.initAcceptEncoding(0);
    context.initAdditionalHeaders(0);
    auto stream = request.send().wait(io.waitScope).getStream();
    auto responsePromise = stream.getResponseRequest().send();
    auto chunk = kj::heapArray<kj::byte>(1024 * 1024);
    memset(chunk.begin(), 0x5a, chunk.size());
    uint64_t written = 0;
    while (written < size) {
      auto count = static_cast<size_t>(
          kj::min(static_cast<uint64_t>(chunk.size()), size - written));
      auto write = stream.writeRequest();
      write.setData(chunk.asPtr().slice(0, count));
      write.send().wait(io.waitScope);
      written += count;
    }
    stream.doneRequest().send().wait(io.waitScope);
    auto response = responsePromise.wait(io.waitScope);
    KJ_REQUIRE(response.which() == WebSession::Response::CONTENT, response.which());
    auto body = response.getContent().getBody();
    KJ_REQUIRE(body.isBytes() || body.isStream(), "upload response had an unknown body shape");
    auto text = body.isBytes()
        ? kj::str(body.getBytes().asChars())
        : streamedBody.promise.wait(io.waitScope);
    KJ_REQUIRE(contains(text, kj::str("\"bodyBytes\":", size)), text);
  };

  runUpload(2 * 1024 * 1024 + 17);
  runUpload(64ull * 1024 * 1024);

  // Cancellation must release the unlinked spool file and leave the host usable.
  {
    auto request = session.postStreamingRequest();
    request.setPath("upload");
    request.setMimeType("application/octet-stream");
    request.setEncoding("");
    request.setExpectedSize(0);
    auto context = request.initContext();
    context.setResponseStream(kj::heap<IgnoreByteStream>());
    context.initCookies(0);
    context.initAccept(0);
    context.initAcceptEncoding(0);
    context.initAdditionalHeaders(0);
    auto stream = request.send().wait(io.waitScope).getStream();
    auto chunk = kj::heapArray<kj::byte>(1024 * 1024);
    auto write = stream.writeRequest();
    write.setData(chunk);
    write.send().wait(io.waitScope);
  }
  io.provider->getTimer().afterDelay(10 * kj::MILLISECONDS).wait(io.waitScope);
  fetchPath(io.waitScope, supervisor, core, "echo");

  // The same unknown-length path enforces the aggregate cap while receiving data.
  auto request = session.postStreamingRequest();
  request.setPath("upload");
  request.setMimeType("application/octet-stream");
  request.setEncoding("");
  request.setExpectedSize(0);
  auto context = request.initContext();
  context.setResponseStream(kj::heap<IgnoreByteStream>());
  context.initCookies(0);
  context.initAccept(0);
  context.initAcceptEncoding(0);
  context.initAdditionalHeaders(0);
  auto stream = request.send().wait(io.waitScope).getStream();
  auto responsePromise = stream.getResponseRequest().send();
  auto chunk = kj::heapArray<kj::byte>(1024 * 1024);
  for (uint i = 0; i < 64; ++i) {
    auto write = stream.writeRequest();
    write.setData(chunk);
    write.send().wait(io.waitScope);
  }
  bool rejected = false;
  try {
    kj::byte extra = 0;
    auto write = stream.writeRequest();
    write.setData(kj::arrayPtr(&extra, 1));
    write.send().wait(io.waitScope);
    stream.doneRequest().send().wait(io.waitScope);
    (void)responsePromise.wait(io.waitScope);
  } catch (const kj::Exception&) {
    rejected = true;
  }
  KJ_REQUIRE(rejected, "unknown-length upload exceeded 64 MiB without rejection");
  stream = nullptr;
  io.provider->getTimer().afterDelay(10 * kj::MILLISECONDS).wait(io.waitScope);
  fetchPath(io.waitScope, supervisor, core, "echo");
}

void testStreamingResponse(kj::WaitScope& waitScope, Supervisor::Client supervisor) {
  auto session = newWebSession(waitScope, supervisor);
  auto counted = kj::newPromiseAndFulfiller<uint64_t>();
  auto request = session.getRequest();
  request.setPath("download-stream?bytes=67108864");
  request.setIgnoreBody(false);
  auto context = request.initContext();
  context.setResponseStream(kj::heap<CountingByteStream>(kj::mv(counted.fulfiller)));
  context.initCookies(0);
  context.initAccept(0);
  context.initAcceptEncoding(0);
  context.initAdditionalHeaders(0);
  auto response = request.send().wait(waitScope);
  KJ_REQUIRE(response.which() == WebSession::Response::CONTENT, response.which());
  KJ_REQUIRE(response.getContent().getBody().isStream(),
      "64 MiB account-host response was not streamed");
  KJ_REQUIRE(counted.promise.wait(waitScope) == 64ull * 1024 * 1024,
      "64 MiB account-host response was truncated");

  auto tooLarge = session.getRequest();
  tooLarge.setPath("download-stream?bytes=67108865");
  tooLarge.setIgnoreBody(false);
  auto tooLargeContext = tooLarge.initContext();
  tooLargeContext.setResponseStream(kj::heap<IgnoreByteStream>());
  tooLargeContext.initCookies(0);
  tooLargeContext.initAccept(0);
  tooLargeContext.initAcceptEncoding(0);
  tooLargeContext.initAdditionalHeaders(0);
  auto rejected = tooLarge.send().wait(waitScope);
  KJ_REQUIRE(rejected.which() == WebSession::Response::SERVER_ERROR,
      "over-limit account-host response was accepted", rejected.which());
}

void testWebSocket(kj::WaitScope& waitScope, Supervisor::Client supervisor) {
  auto session = newWebSession(waitScope, supervisor);

  auto request = session.openWebSocketRequest();
  request.setPath("websocket-echo");
  request.initProtocol(0);
  auto context = request.initContext();
  context.setResponseStream(kj::heap<IgnoreByteStream>());
  context.initCookies(0);
  context.initAccept(0);
  context.initAcceptEncoding(0);
  context.initAdditionalHeaders(0);

  auto callerStream = kj::newPromiseAndFulfiller<WebSession::WebSocketStream::Client>();
  request.setClientStream(kj::mv(callerStream.promise));
  auto response = request.send().wait(waitScope);
  auto pipe = kj::refcounted<WebSessionWebSocketPipe>(response.getServerStream());
  callerStream.fulfiller->fulfill(pipe->getIncomingStreamCapability());
  static TestEntropySource entropy;
  auto webSocket = kj::newWebSocket(kj::mv(pipe), entropy);
  webSocket->send(kj::StringPtr("direct").asArray()).wait(waitScope);
  auto message = webSocket->receive(1024).wait(waitScope);
  KJ_SWITCH_ONEOF(message) {
    KJ_CASE_ONEOF(text, kj::String) {
      KJ_REQUIRE(text == "shared:direct", "shared WebSocket returned wrong payload", text);
    }
    KJ_CASE_ONEOF(bytes, kj::Array<kj::byte>) {
      KJ_FAIL_REQUIRE("shared WebSocket returned binary data", bytes.size());
    }
    KJ_CASE_ONEOF(close, kj::WebSocket::Close) {
      KJ_FAIL_REQUIRE("shared WebSocket closed before echo", close.code, close.reason);
    }
  }
  webSocket->close(1000, "test complete").wait(waitScope);
}

void testBrowserBootstrap(kj::WaitScope& waitScope, Supervisor::Client supervisor) {
  auto session = newWebSession(waitScope, supervisor);
  auto request = session.openWebSocketRequest();
  request.setPath(
      "/__sandstorm/native-capnp/rpc-session?connectionId=account-host-test");
  request.initProtocol(0);
  request.setClientStream(kj::heap<IgnoreWebSocketStream>());
  auto context = request.initContext();
  context.setResponseStream(kj::heap<IgnoreByteStream>());
  context.initCookies(0);
  context.initAccept(0);
  context.initAcceptEncoding(0);
  context.initAdditionalHeaders(0);
  auto response = request.send().wait(waitScope);
  KJ_REQUIRE(response.getProtocol().size() == 0);
  KJ_REQUIRE(response.hasServerStream(), "browser bootstrap did not return a native RPC stream");
}

}  // namespace
}  // namespace sandstorm

int main(int argc, char** argv) {
  bool benchmarkMode = argc >= 5 && kj::StringPtr(argv[4]) == "--benchmark";
  KJ_REQUIRE(argc == 4 || benchmarkMode,
      "usage: isolate-account-host-client <control-socket> <grain-id> <package-id> "
      "[--benchmark [--samples N] [--concurrency N] [--small-iterations N] "
      "[--small-warmup N] [--large-iterations N] [--large-warmup N] "
      "[--large-payload-bytes N]]");
  auto io = kj::setupAsyncIo();
  auto address = io.provider->getNetwork()
      .parseAddress(kj::str("unix:", argv[1]), 0).wait(io.waitScope);
  auto stream = address->connect().wait(io.waitScope);
  auto coreServer = kj::heap<sandstorm::TestCore>();
  auto& coreImpl = *coreServer;
  sandstorm::SandstormCore::Client core = kj::mv(coreServer);
  capnp::TwoPartyVatNetwork network(*stream, capnp::rpc::twoparty::Side::CLIENT);
  auto rpcSystem = capnp::makeRpcServer(network, core);
  capnp::MallocMessageBuilder vatMessage;
  auto hostId = vatMessage.initRoot<capnp::rpc::twoparty::VatId>();
  hostId.setSide(capnp::rpc::twoparty::Side::SERVER);
  auto account = rpcSystem.bootstrap(hostId).castAs<sandstorm::IsolateAccountHost>();

  if (benchmarkMode) {
    auto provider = sandstorm::startGrain(
        io.waitScope, account, core, argv[2], argv[3], true);
    coreImpl.setSupervisor(argv[2], provider);
    auto token = sandstorm::fetchPath(
        io.waitScope, provider, core, "cross-grain-capnp-benchmark-token");

    auto consumer = sandstorm::startGrain(
        io.waitScope, account, core, "isolatebenchmarkconsumer", argv[3], true);
    coreImpl.setSupervisor("isolatebenchmarkconsumer", consumer);
    auto path = kj::str("cross-grain-capnp-benchmark?token=", token);

    KJ_REQUIRE((argc - 5) % 2 == 0, "benchmark options require a numeric value");
    for (int i = 5; i < argc; i += 2) {
      auto option = kj::StringPtr(argv[i]);
      auto value = kj::StringPtr(argv[i + 1]);
      KJ_REQUIRE(value.size() > 0, "benchmark option has an empty value", option);
      for (char c: value) {
        KJ_REQUIRE(c >= '0' && c <= '9', "benchmark option must be an integer", option, value);
      }

      kj::StringPtr parameter;
      if (option == "--samples") {
        parameter = "samples";
      } else if (option == "--concurrency") {
        parameter = "concurrency";
      } else if (option == "--small-iterations") {
        parameter = "smallIterations";
      } else if (option == "--small-warmup") {
        parameter = "smallWarmup";
      } else if (option == "--large-iterations") {
        parameter = "largeIterations";
      } else if (option == "--large-warmup") {
        parameter = "largeWarmup";
      } else if (option == "--large-payload-bytes") {
        parameter = "largePayloadBytes";
      } else {
        KJ_FAIL_REQUIRE("unknown benchmark option", option);
      }
      path = kj::str(path, "&", parameter, "=", value);
    }

    auto result = sandstorm::fetchPath(io.waitScope, consumer, core, path);
    fwrite(result.begin(), 1, result.size(), stdout);
    fputc('\n', stdout);
    return 0;
  }

  sandstorm::expectStartRejected(
      io.waitScope, account, core, "oversizedgrain", "oversizedpackage");

  // Publish a single in-flight startup per grain. Both callers must join it instead of racing
  // two native-host admissions and contending on the supervisors map.
  auto concurrentRequest1 = account.startGrainRequest();
  concurrentRequest1.setGrainId("concurrentgrain789");
  concurrentRequest1.setPackageId(argv[3]);
  concurrentRequest1.setMainModule("worker.js");
  concurrentRequest1.setCompatibilityDate("2025-01-01");
  concurrentRequest1.setIsNew(true);
  concurrentRequest1.setCore(core);
  auto concurrentStart1 = concurrentRequest1.send();
  auto concurrentRequest2 = account.startGrainRequest();
  concurrentRequest2.setGrainId("concurrentgrain789");
  concurrentRequest2.setPackageId(argv[3]);
  concurrentRequest2.setMainModule("worker.js");
  concurrentRequest2.setCompatibilityDate("2025-01-01");
  concurrentRequest2.setIsNew(true);
  concurrentRequest2.setCore(core);
  auto concurrentStart2 = concurrentRequest2.send();
  auto concurrentSupervisor1 = concurrentStart1.wait(io.waitScope).getSupervisor();
  auto concurrentSupervisor2 = concurrentStart2.wait(io.waitScope).getSupervisor();
  sandstorm::fetchPath(io.waitScope, concurrentSupervisor1, core, "echo");
  sandstorm::fetchPath(io.waitScope, concurrentSupervisor2, core, "echo");
  concurrentSupervisor1.shutdownRequest().send().wait(io.waitScope);

  auto supervisor = sandstorm::startGrain(
      io.waitScope, account, core, argv[2], argv[3], true);
  coreImpl.setSupervisor(argv[2], supervisor);
  sandstorm::fetchPath(io.waitScope, supervisor, core, "echo");
  sandstorm::testWebSocket(io.waitScope, supervisor);
  sandstorm::testBrowserBootstrap(io.waitScope, supervisor);
  sandstorm::testUnknownLengthUploads(io, supervisor, core);
  sandstorm::testStreamingResponse(io.waitScope, supervisor);
  auto routePersistence = sandstorm::fetchPath(
      io.waitScope, supervisor, core, "web-session-save-restore-self-test");
  KJ_REQUIRE(sandstorm::contains(routePersistence, "\"ok\":true"), routePersistence);
  auto outboundRestore = sandstorm::fetchPath(
      io.waitScope, supervisor, core, "outbound-http-restore-self-test");
  KJ_REQUIRE(sandstorm::contains(outboundRestore, "\"ok\":true"), outboundRestore);
  KJ_REQUIRE(sandstorm::contains(outboundRestore, "\"source\":\"fake-outbound-http\""),
      outboundRestore);
  auto nativeBridge = sandstorm::fetchPath(
      io.waitScope, supervisor, core, "native-capnp-direct-probe");
  KJ_REQUIRE(nativeBridge ==
      "{\"ok\":true,\"transportKind\":\"isolateBridgeNative\",\"hasSave\":true,"
      "\"hasRestore\":true,\"hasDrop\":true}",
      "shared host did not complete a direct native Cap'n Proto bridge call", nativeBridge);
  auto appPersistence = sandstorm::fetchPath(
      io.waitScope, supervisor, core, "app-persistent-save-restore-self-test");
  KJ_REQUIRE(sandstorm::contains(appPersistence, "\"ok\":true"), appPersistence);
  KJ_REQUIRE(sandstorm::contains(appPersistence,
      "\"message\":\"classic native greeter account-host-app-persistent hello parity\""),
      appPersistence);
  sandstorm::fetchPath(io.waitScope, supervisor, core, "sandstorm-api-binding-probe");
  sandstorm::fetchPath(io.waitScope, supervisor, core, "powerbox-binding-probe");
  sandstorm::fetchPath(io.waitScope, supervisor, core, "storage-helper-self-test");
  auto bindingValues = sandstorm::fetchPath(
      io.waitScope, supervisor, core, "binding-values-probe");
  KJ_REQUIRE(bindingValues ==
      "{\"ok\":true,\"text\":\"hello from a text binding\",\"json\":{\"binding\":\"json\"}}",
      "shared host did not preserve text and JSON bindings", bindingValues);
  auto dataBinding = sandstorm::fetchPath(
      io.waitScope, supervisor, core, "data-binding-probe");
  KJ_REQUIRE(dataBinding ==
      "{\"ok\":true,\"isArrayBuffer\":true,\"byteCount\":14,\"checksum\":1466,"
      "\"firstEightHex\":\"00017f80ff53616e\"}",
      "shared host did not materialize the binary data binding as an ArrayBuffer", dataBinding);
  auto serviceBinding = sandstorm::fetchPath(
      io.waitScope, supervisor, core, "service-loopback");
  KJ_REQUIRE(serviceBinding ==
      "{\"ok\":true,\"status\":200,\"body\":{\"ok\":true,"
      "\"source\":\"loopback-service-target\",\"method\":\"POST\","
      "\"pathname\":\"/service-target\",\"search\":\"?source=service-binding\","
      "\"body\":\"hello through service binding\",\"customHeader\":\"present\"}}",
      "shared host did not route the service binding", serviceBinding);
  auto firstStorage = sandstorm::fetchPath(
      io.waitScope, supervisor, core, "shared-storage-isolation?value=first");
  KJ_REQUIRE(firstStorage == "{\"ok\":true,\"value\":\"first\"}",
      "first shared grain did not retain its storage value", firstStorage);

  // A second live grain proves that the account control plane and native workerd host are
  // genuinely multi-tenant rather than merely a different one-process-per-grain launcher.
  auto second = sandstorm::startGrain(
      io.waitScope, account, core, "testgrain456", argv[3], true);
  coreImpl.setSupervisor("testgrain456", second);
  sandstorm::fetchPath(io.waitScope, second, core, "echo");
  auto secondStorage = sandstorm::fetchPath(
      io.waitScope, second, core, "shared-storage-isolation?value=second");
  KJ_REQUIRE(secondStorage == "{\"ok\":true,\"value\":\"second\"}",
      "second shared grain did not retain its storage value", secondStorage);
  auto isolatedFirstStorage = sandstorm::fetchPath(
      io.waitScope, supervisor, core, "shared-storage-isolation");
  KJ_REQUIRE(isolatedFirstStorage == "{\"ok\":true,\"value\":\"first\"}",
      "second shared grain overwrote the first grain's storage", isolatedFirstStorage);

  auto crossGrainToken = sandstorm::fetchPath(
      io.waitScope, supervisor, core, "cross-grain-capnp-benchmark-token");
  auto crossGrainCall = sandstorm::fetchPath(io.waitScope, second, core,
      kj::str("cross-grain-native-greeter-self-test?token=", crossGrainToken));
  KJ_REQUIRE(sandstorm::contains(crossGrainCall, "\"ok\":true"), crossGrainCall);
  KJ_REQUIRE(sandstorm::contains(crossGrainCall,
      "\"message\":\"classic native greeter cross-grain-capnp-benchmark hello client isolate\""),
      "second isolate did not call the first isolate over Cap'n Proto RPC", crossGrainCall);
  supervisor.shutdownRequest().send().wait(io.waitScope);

  bool rejectedAfterShutdown = false;
  try {
    supervisor.keepAliveRequest().send().wait(io.waitScope);
  } catch (const kj::Exception&) {
    rejectedAfterShutdown = true;
  }
  KJ_REQUIRE(rejectedAfterShutdown, "shut-down Supervisor capability remained usable");

  auto restarted = sandstorm::startGrain(
      io.waitScope, account, core, argv[2], argv[3], false);
  sandstorm::fetchPath(io.waitScope, restarted, core, "echo");
  sandstorm::fetchPath(io.waitScope, restarted, core, "sandstorm-api-binding-probe");
  sandstorm::fetchPath(io.waitScope, restarted, core, "powerbox-binding-probe");
  sandstorm::fetchPath(io.waitScope, restarted, core, "storage-helper-self-test");
  sandstorm::fetchPath(io.waitScope, restarted, core, "binding-values-probe");
  sandstorm::fetchPath(io.waitScope, restarted, core, "data-binding-probe");
  sandstorm::fetchPath(io.waitScope, restarted, core, "service-loopback");
  auto restartedStorage = sandstorm::fetchPath(
      io.waitScope, restarted, core, "shared-storage-isolation");
  KJ_REQUIRE(restartedStorage == "{\"ok\":true,\"value\":\"first\"}",
      "shared grain restart lost or crossed storage authority", restartedStorage);
  auto isolatedSecondStorage = sandstorm::fetchPath(
      io.waitScope, second, core, "shared-storage-isolation");
  KJ_REQUIRE(isolatedSecondStorage == "{\"ok\":true,\"value\":\"second\"}",
      "first shared grain restart changed the second grain's storage", isolatedSecondStorage);
  sandstorm::fetchPath(io.waitScope, second, core, "echo");
  return 0;
}
