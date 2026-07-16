// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2026 Sandstorm contributors
// Licensed under the Apache License, Version 2.0.

#include <capnp/rpc-twoparty.h>
#include <kj/async-io.h>
#include <kj/debug.h>
#include <sandstorm/isolate-account-host.capnp.h>
#include <sandstorm/supervisor.capnp.h>
#include <sandstorm/test-app/isolate-test/native-greeter.capnp.h>
#include <sandstorm/util.capnp.h>
#include <sandstorm/web-session.capnp.h>

namespace sandstorm {
namespace {

class TestRevocationObserver final: public SystemPersistent::RevocationObserver::Server {
public:
  kj::Promise<void> dropWhenRevoked(DropWhenRevokedContext context) override {
    revokers.add(context.getParams().getHandle());
    return kj::READY_NOW;
  }

private:
  kj::Vector<Handle::Client> revokers;
};

class TestFallbackGreeter final: public NativeGreeter::Server {
public:
  kj::Promise<void> hello(HelloContext context) override {
    context.getResults().setMessage(kj::str(
        "fallback greeter hello ", context.getParams().getName()));
    return kj::READY_NOW;
  }
};

class TestHandoffReceiver final: public NativeGreeter::Server {
public:
  kj::Promise<void> hello(HelloContext context) override {
    auto request = KJ_REQUIRE_NONNULL(heldGreeter,
        "handoff receiver has not received a capability").helloRequest();
    request.setName(context.getParams().getName());
    return request.send().then([context](auto result) mutable {
      context.getResults().setMessage(kj::str(
          "handoff receiver relayed ", result.getMessage()));
    });
  }

  kj::Promise<void> greetWith(GreetWithContext context) override {
    auto params = context.getParams();
    heldGreeter = params.getGreeter();
    auto request = KJ_ASSERT_NONNULL(heldGreeter).helloRequest();
    request.setName(params.getName());
    return request.send().then([context](auto result) mutable {
      context.getResults().setMessage(kj::str(
          "handoff receiver called ", result.getMessage()));
    });
  }

private:
  kj::Maybe<NativeGreeter::Client> heldGreeter;
};

class TestCore final: public SandstormCore::Server {
public:
  void setProvider(Supervisor::Client provider) {
    this->provider = kj::mv(provider);
  }

  kj::Promise<void> restoreForIsolate(RestoreForIsolateContext context) override {
    auto params = context.getParams();
    if (params.getToken() == kj::StringPtr("fallback-restore-token").asBytes()) {
      context.getResults().setCap(kj::heap<TestFallbackGreeter>());
      return kj::READY_NOW;
    }
    if (params.getToken() == kj::StringPtr("handoff-receiver-token").asBytes()) {
      context.getResults().setCap(kj::heap<TestHandoffReceiver>());
      return kj::READY_NOW;
    }
    KJ_REQUIRE(params.getToken() == kj::StringPtr("local-app-restore-token").asBytes(),
        "unexpected local app restore token");
    auto request = params.getRequester().prepareRequest();
    request.setProviderGrainId("testgrain456");
    request.getAppRef().initAs<NativeGreeterObjectId>().setId("account-local-app-ref");
    request.setObserver(kj::heap<TestRevocationObserver>());
    return request.send().then([context](auto prepared) mutable -> kj::Promise<void> {
      context.getResults().setLocalEndpoint(prepared.getEndpointName());
      context.getResults().setLocalLifetime(prepared.getLifetime());
      return kj::READY_NOW;
    }, [this, context](kj::Exception&&) mutable -> kj::Promise<void> {
      // Forced-off coverage follows the same provider-supervisor fallback as the real front-end.
      auto restore = KJ_REQUIRE_NONNULL(provider).restoreRequest();
      capnp::MallocMessageBuilder appRefMessage;
      auto appRef = appRefMessage.initRoot<capnp::AnyPointer>();
      appRef.initAs<NativeGreeterObjectId>().setId("account-local-app-ref");
      restore.getRef().setAppRef(appRef);
      restore.initObsolete(0);
      restore.setParentToken(kj::StringPtr("local-app-restore-token").asBytes());
      return restore.send().then([context](auto restored) mutable {
        context.getResults().setCap(restored.getCap());
      });
    });
  }

  kj::Promise<void> makeChildToken(MakeChildTokenContext context) override {
    auto params = context.getParams();
    KJ_REQUIRE(params.getParent() == kj::StringPtr("local-app-restore-token").asBytes(),
        "local restore resave lost its parent token");
    KJ_REQUIRE(params.getOwner().isGrain(),
        "local restore resave did not create a grain-owned token");
    context.getResults().setToken(kj::StringPtr("resaved-local-token").asBytes());
    return kj::READY_NOW;
  }

private:
  kj::Maybe<Supervisor::Client> provider;
};
class TestSessionContext final: public SessionContext::Server {};

class IgnoreByteStream final: public ByteStream::Server {
public:
  kj::Promise<void> write(WriteContext context) override {
    (void)context;
    return kj::READY_NOW;
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

capnp::RemotePromise<WebSession::Response> startFetchPath(
    kj::WaitScope& waitScope, Supervisor::Client supervisor,
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
  context.setResponseStream(kj::heap<IgnoreByteStream>());
  context.initCookies(0);
  context.initAccept(0);
  context.initAcceptEncoding(0);
  context.initAdditionalHeaders(0);
  return get.send();
}

kj::String requireFetchOk(WebSession::Response::Reader response) {
  KJ_REQUIRE(response.which() == WebSession::Response::CONTENT);
  auto content = response.getContent();
  KJ_REQUIRE(content.getStatusCode() == WebSession::Response::SuccessCode::OK);
  auto body = content.getBody();
  KJ_REQUIRE(body.isBytes(), "account-host test response was unexpectedly streamed");
  return kj::str(body.getBytes().asChars());
}

void fetchPath(kj::WaitScope& waitScope, Supervisor::Client supervisor,
    SandstormCore::Client core, kj::StringPtr path) {
  (void)requireFetchOk(startFetchPath(waitScope, kj::mv(supervisor), kj::mv(core), path)
      .wait(waitScope));
}

}  // namespace
}  // namespace sandstorm

int main(int argc, char** argv) {
  KJ_REQUIRE(argc == 5,
      "usage: isolate-account-host-client <control-socket> <grain-id> <package-id> "
      "<local|fallback>");
  bool expectLocalFastPath;
  if (kj::StringPtr(argv[4]) == "local") {
    expectLocalFastPath = true;
  } else {
    KJ_REQUIRE(kj::StringPtr(argv[4]) == "fallback", "invalid expected transport", argv[4]);
    expectLocalFastPath = false;
  }
  auto io = kj::setupAsyncIo();
  auto address = io.provider->getNetwork()
      .parseAddress(kj::str("unix:", argv[1]), 0).wait(io.waitScope);
  auto stream = address->connect().wait(io.waitScope);
  auto coreServer = kj::heap<sandstorm::TestCore>();
  auto* coreServerPtr = coreServer.get();
  sandstorm::SandstormCore::Client core = kj::mv(coreServer);
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
  sandstorm::fetchPath(io.waitScope, supervisor, core, "sandstorm-api-binding-probe");
  sandstorm::fetchPath(io.waitScope, supervisor, core, "powerbox-binding-probe");
  sandstorm::fetchPath(io.waitScope, supervisor, core, "storage-helper-self-test");
  auto dataBinding = sandstorm::requireFetchOk(sandstorm::startFetchPath(
      io.waitScope, supervisor, core, "data-binding-probe").wait(io.waitScope));
  KJ_REQUIRE(dataBinding ==
      "{\"ok\":true,\"isArrayBuffer\":true,\"byteCount\":14,\"checksum\":1466,"
      "\"firstEightHex\":\"00017f80ff53616e\"}",
      "shared host did not materialize the binary data binding as an ArrayBuffer", dataBinding);

  // A second live grain proves that the account control plane and native workerd host are
  // genuinely multi-tenant rather than merely a different one-process-per-grain launcher.
  auto second = sandstorm::startGrain(
      io.waitScope, account, core, "testgrain456", argv[3], true);
  coreServerPtr->setProvider(second);
  sandstorm::fetchPath(io.waitScope, second, core, "echo");

  auto localRestore = sandstorm::requireFetchOk(sandstorm::startFetchPath(
      io.waitScope, supervisor, core, "local-app-restore-self-test").wait(io.waitScope));
  auto expectedLocalRestore = expectLocalFastPath
      ? "{\"ok\":true,\"message\":\"classic native greeter account-local-app-ref hello "
        "durable local restore\",\"residence\":\"sameAccountLocal\","
        "\"transportKind\":\"nativeLocalBuffer\",\"resavedTokenType\":\"string\","
        "\"resavedTokenLength\":26,\"revokedAfterDrop\":true}"
      : "{\"ok\":true,\"message\":\"classic native greeter account-local-app-ref hello "
        "durable local restore\",\"residence\":\"imported\","
        "\"resavedTokenType\":\"string\",\"resavedTokenLength\":26,"
        "\"revokedAfterDrop\":true}";
  KJ_REQUIRE(localRestore == expectedLocalRestore,
      "durable appRef restore did not use the forced transport", expectLocalFastPath,
      localRestore);
  if (expectLocalFastPath) {
    auto handoff = sandstorm::requireFetchOk(sandstorm::startFetchPath(
        io.waitScope, supervisor, core, "local-app-handoff-self-test").wait(io.waitScope));
    KJ_REQUIRE(handoff ==
        "{\"ok\":true,\"message\":\"handoff receiver called classic native greeter "
        "account-local-app-ref hello non-colocated handoff\","
        "\"providerResidence\":\"sameAccountLocal\","
        "\"receiverResidence\":\"imported\",\"revokedAfterDrop\":true}",
        "local capability handoff did not preserve authority and revocation", handoff);
  }
  auto fallbackRestore = sandstorm::requireFetchOk(sandstorm::startFetchPath(
      io.waitScope, supervisor, core, "restore-fallback-self-test").wait(io.waitScope));
  KJ_REQUIRE(fallbackRestore ==
      "{\"ok\":true,\"message\":\"fallback greeter hello ordinary restore\","
      "\"residence\":\"imported\"}",
      "ordinary capability restore did not preserve the supervisor fallback path",
      fallbackRestore);

  if (expectLocalFastPath) {
    auto openLocalCapnp = account.openLocalCapnpChannelRequest();
    openLocalCapnp.setFirstGrainId(argv[2]);
    openLocalCapnp.setFirstName("account-e2e-client");
    openLocalCapnp.setSecondGrainId("testgrain456");
    openLocalCapnp.setSecondName("account-e2e-server");
    auto localCapnpRevoker = openLocalCapnp.send().wait(io.waitScope).getRevoker();
    auto localServerRequest = sandstorm::startFetchPath(io.waitScope, second, core,
        "native-local-capnp-server?name=account-e2e-server");
    auto localClientRequest = sandstorm::startFetchPath(io.waitScope, supervisor, core,
        "native-local-capnp-client?name=account-e2e-client");
    KJ_REQUIRE(sandstorm::requireFetchOk(localClientRequest.wait(io.waitScope)) ==
        "{\"ok\":true,\"message\":\"native local hello cross-grain\","
        "\"transportKind\":\"nativeLocalBuffer\"}",
        "cross-grain local Cap'n Proto client returned the wrong result");
    KJ_REQUIRE(sandstorm::requireFetchOk(localServerRequest.wait(io.waitScope)) ==
        "{\"ok\":true,\"name\":\"cross-grain\",\"transportKind\":\"nativeLocalBuffer\"}",
        "cross-grain local Cap'n Proto server returned the wrong result");
  }

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
  sandstorm::fetchPath(io.waitScope, restarted, core, "data-binding-probe");
  sandstorm::fetchPath(io.waitScope, second, core, "echo");
  return 0;
}
