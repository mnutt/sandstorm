// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2026 Sandstorm contributors
// Licensed under the Apache License, Version 2.0.

#include <capnp/rpc-twoparty.h>
#include <kj/async-io.h>
#include <kj/compat/http.h>
#include <kj/debug.h>
#include <sandstorm/isolate-account-host.capnp.h>
#include <sandstorm/supervisor.capnp.h>
#include <sandstorm/util.capnp.h>
#include <sandstorm/web-session.capnp.h>

#include "web-session-websocket.h"

namespace sandstorm {
namespace {

class TestCore final: public SandstormCore::Server {};
class TestSessionContext final: public SessionContext::Server {};

class IgnoreByteStream final: public ByteStream::Server {
public:
  kj::Promise<void> write(WriteContext context) override {
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
    (void)startGrain(waitScope, account, core, grainId, packageId, true);
  } catch (const kj::Exception&) {
    rejected = true;
  }
  KJ_REQUIRE(rejected, "oversized worker package was admitted");
}

kj::String fetchPath(kj::WaitScope& waitScope, Supervisor::Client supervisor,
    SandstormCore::Client core, kj::StringPtr path) {
  auto keepAlive = supervisor.keepAliveRequest();
  keepAlive.setCore(core);
  keepAlive.send().wait(waitScope);

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
  auto session = sessionRequest.send().wait(waitScope).getSession().castAs<WebSession>();

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

void testWebSocket(kj::WaitScope& waitScope, Supervisor::Client supervisor) {
  auto view = supervisor.getMainViewRequest().send().wait(waitScope).getView();
  auto sessionRequest = view.newSessionRequest();
  auto userInfo = sessionRequest.initUserInfo();
  userInfo.initDisplayName().setDefaultText("Account host WebSocket test user");
  userInfo.setPreferredHandle("account-host-websocket-test");
  userInfo.initPermissions(1).set(0, true);
  sessionRequest.setContext(kj::heap<TestSessionContext>());
  sessionRequest.setSessionType(capnp::typeId<WebSession>());
  auto sessionParams = sessionRequest.getSessionParams().initAs<WebSession::Params>();
  sessionParams.setBasePath("https://account-host-test.invalid");
  sessionParams.setUserAgent("isolate-account-host-client");
  sessionRequest.setTabId(kj::StringPtr("account-host-websocket-tab").asBytes());
  auto session = sessionRequest.send().wait(waitScope).getSession().castAs<WebSession>();

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

}  // namespace
}  // namespace sandstorm

int main(int argc, char** argv) {
  KJ_REQUIRE(argc == 4,
      "usage: isolate-account-host-client <control-socket> <grain-id> <package-id>");
  auto io = kj::setupAsyncIo();
  auto address = io.provider->getNetwork()
      .parseAddress(kj::str("unix:", argv[1]), 0).wait(io.waitScope);
  auto stream = address->connect().wait(io.waitScope);
  sandstorm::SandstormCore::Client core = kj::heap<sandstorm::TestCore>();
  capnp::TwoPartyVatNetwork network(*stream, capnp::rpc::twoparty::Side::CLIENT);
  auto rpcSystem = capnp::makeRpcServer(network, core);
  capnp::MallocMessageBuilder vatMessage;
  auto hostId = vatMessage.initRoot<capnp::rpc::twoparty::VatId>();
  hostId.setSide(capnp::rpc::twoparty::Side::SERVER);
  auto account = rpcSystem.bootstrap(hostId).castAs<sandstorm::IsolateAccountHost>();

  sandstorm::expectStartRejected(
      io.waitScope, account, core, "oversizedgrain", "oversizedpackage");

  auto supervisor = sandstorm::startGrain(
      io.waitScope, account, core, argv[2], argv[3], true);
  sandstorm::fetchPath(io.waitScope, supervisor, core, "echo");
  sandstorm::testWebSocket(io.waitScope, supervisor);
  auto nativeBridge = sandstorm::fetchPath(
      io.waitScope, supervisor, core, "native-capnp-direct-probe");
  KJ_REQUIRE(nativeBridge ==
      "{\"ok\":true,\"transportKind\":\"isolateBridgeNative\",\"hasSave\":true,"
      "\"hasRestore\":true,\"hasDrop\":true}",
      "shared host did not complete a direct native Cap'n Proto bridge call", nativeBridge);
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
  sandstorm::fetchPath(io.waitScope, second, core, "echo");
  auto secondStorage = sandstorm::fetchPath(
      io.waitScope, second, core, "shared-storage-isolation?value=second");
  KJ_REQUIRE(secondStorage == "{\"ok\":true,\"value\":\"second\"}",
      "second shared grain did not retain its storage value", secondStorage);
  auto isolatedFirstStorage = sandstorm::fetchPath(
      io.waitScope, supervisor, core, "shared-storage-isolation");
  KJ_REQUIRE(isolatedFirstStorage == "{\"ok\":true,\"value\":\"first\"}",
      "second shared grain overwrote the first grain's storage", isolatedFirstStorage);
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
