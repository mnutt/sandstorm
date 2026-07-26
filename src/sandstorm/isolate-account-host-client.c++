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
#include <sandstorm/test-app/isolate-test/native-greeter.capnp.h>
#include <sandstorm/util.capnp.h>
#include <sandstorm/web-session.capnp.h>

#include <stdio.h>
#include <string.h>

namespace sandstorm {
namespace {

class TestSessionContext final: public SessionContext::Server {
public:
  kj::Promise<void> offer(OfferContext context) override {
    ++offerCount;
    return kj::READY_NOW;
  }

  static uint getOfferCount() { return offerCount; }

private:
  static uint offerCount;
};

uint TestSessionContext::offerCount = 0;

class BlockingNativeGreeter final: public NativeGreeter::Server {
public:
  BlockingNativeGreeter(kj::String expectedName,
      kj::Own<kj::PromiseFulfiller<void>> startedFulfiller,
      kj::Promise<void> releasePromise)
      : expectedName(kj::mv(expectedName)),
        startedFulfiller(kj::mv(startedFulfiller)),
        releasePromise(kj::mv(releasePromise)) {}

  kj::Promise<void> hello(HelloContext context) override {
    KJ_REQUIRE(context.getParams().getName() == expectedName,
        "worker concurrency callback carried the wrong value",
        context.getParams().getName(), expectedName);
    KJ_REQUIRE(startedFulfiller.get() != nullptr,
        "worker concurrency callback was called more than once");
    startedFulfiller->fulfill();
    startedFulfiller = nullptr;
    return kj::mv(releasePromise).then(
        [context, expectedName = kj::mv(expectedName)]() mutable {
      context.getResults().setMessage(kj::str("released ", expectedName));
    });
  }

private:
  kj::String expectedName;
  kj::Own<kj::PromiseFulfiller<void>> startedFulfiller;
  kj::Promise<void> releasePromise;
};

class CapturingRevocationObserver final: public SystemPersistent::RevocationObserver::Server {
public:
  explicit CapturingRevocationObserver(
      kj::Own<kj::PromiseFulfiller<capnp::Capability::Client>> handleFulfiller)
      : handleFulfiller(kj::mv(handleFulfiller)) {}

  kj::Promise<void> dropWhenRevoked(DropWhenRevokedContext context) override {
    KJ_REQUIRE(handleFulfiller.get() != nullptr,
        "worker requirement observer received more than one revoker handle");
    handleFulfiller->fulfill(context.getParams().getHandle());
    handleFulfiller = nullptr;
    return kj::READY_NOW;
  }

private:
  kj::Own<kj::PromiseFulfiller<capnp::Capability::Client>> handleFulfiller;
};

bool contains(kj::StringPtr haystack, kj::StringPtr needle) {
  if (needle.size() > haystack.size()) return false;
  for (size_t i = 0; i <= haystack.size() - needle.size(); ++i) {
    if (haystack.slice(i).startsWith(needle)) return true;
  }
  return false;
}

void expectShutdown(kj::WaitScope& waitScope, Supervisor::Client supervisor) {
  try {
    supervisor.shutdownRequest().send().wait(waitScope);
    KJ_FAIL_REQUIRE("Supervisor.shutdown() returned successfully");
  } catch (const kj::Exception& exception) {
    KJ_REQUIRE(exception.getType() == kj::Exception::Type::DISCONNECTED,
        "Supervisor.shutdown() returned the wrong exception", exception);
  }
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
  struct TokenRecord {
    TokenRecord(bool app, kj::Array<capnp::word> ref, kj::String ownerGrainId)
        : app(app), ref(kj::mv(ref)), ownerGrainId(kj::mv(ownerGrainId)) {}

    bool app;
    kj::Array<capnp::word> ref;
    kj::String ownerGrainId;
    bool live = true;
  };

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
    capnp::MallocMessageBuilder message;
    bool app;
    if (ref.which() == SupervisorObjectId<>::APP_REF) {
      message.setRoot(ref.getAppRef());
      app = true;
    } else {
      KJ_REQUIRE(ref.which() == SupervisorObjectId<>::ISOLATE_WORKER_REF,
          "account-host test received an unsupported persistent object type");
      message.setRoot(ref.getIsolateWorkerRef());
      app = false;
    }
    auto token = kj::str("account-", app ? "app" : "worker", "-token-", nextToken++);
    context.getResults().setToken(token.asBytes());
    tokens.insert(kj::mv(token), TokenRecord(
        app, capnp::messageToFlatArray(message), kj::mv(ownerGrainId)));
    return kj::READY_NOW;
  }

  kj::Promise<void> restore(RestoreContext context) override {
    auto token = kj::str(context.getParams().getToken().asChars());
    if (token == "outbound-http-saved-token") {
      context.getResults().setCap(kj::heap<FakeOutboundHttpSession>());
      return kj::READY_NOW;
    }
    auto& record = KJ_REQUIRE_NONNULL(
        tokens.find(token), "unknown account-host test token", token);
    KJ_REQUIRE(record.live, "dropped account-host token was restored", token);
    KJ_IF_MAYBE(currentSupervisor, supervisors.find(record.ownerGrainId)) {
      auto request = currentSupervisor->restoreRequest();
      capnp::FlatArrayMessageReader reader(record.ref.asPtr());
      if (record.app) {
        request.getRef().setAppRef(reader.getRoot<capnp::AnyPointer>());
      } else {
        request.getRef().setIsolateWorkerRef(
            reader.getRoot<SupervisorObjectId<>::IsolateWorkerRef>());
      }
      request.setParentToken(token.asBytes());
      return request.send().then([context, token = kj::mv(token)](auto result) mutable {
        context.getResults().setCap(result.getCap());
      });
    }
    KJ_FAIL_REQUIRE(
        "no supervisor registered for token-owning grain", record.ownerGrainId);
  }

  kj::Promise<void> drop(DropContext context) override {
    auto token = kj::str(context.getParams().getToken().asChars());
    if (token == "outbound-http-saved-token") {
      return kj::READY_NOW;
    }
    auto& record = KJ_REQUIRE_NONNULL(
        tokens.find(token), "unknown account-host test token", token);
    KJ_REQUIRE(record.live, "account-host token dropped twice", token);
    record.live = false;
    if (record.app) {
      return kj::READY_NOW;
    }
    KJ_IF_MAYBE(currentSupervisor, supervisors.find(record.ownerGrainId)) {
      auto request = currentSupervisor->dropRequest();
      capnp::FlatArrayMessageReader reader(record.ref.asPtr());
      request.getRef().setIsolateWorkerRef(
          reader.getRoot<SupervisorObjectId<>::IsolateWorkerRef>());
      return request.send().ignoreResult();
    }
    KJ_FAIL_REQUIRE(
        "no supervisor registered for worker token's grain", record.ownerGrainId);
  }

  kj::Promise<void> reportGrainSize(ReportGrainSizeContext context) override {
    KJ_REQUIRE(context.getParams().getBytes() > 0);
    return kj::READY_NOW;
  }

private:
  kj::HashMap<kj::String, Supervisor::Client> supervisors;
  kj::HashMap<kj::String, TokenRecord> tokens;
  uint nextToken = 0;
};

class IgnoreByteStream final: public ByteStream::Server {
public:
  kj::Promise<void> write(WriteContext context) override {
    (void)context;
    return kj::READY_NOW;
  }

  kj::Promise<void> done(DoneContext context) override {
    (void)context;
    return kj::READY_NOW;
  }
};

class IgnoreWebSocketMessageStream final:
    public WebSession::WebSocketMessageStream::Server {
public:
  kj::Promise<void> sendText(SendTextContext context) override {
    (void)context;
    return kj::READY_NOW;
  }

  kj::Promise<void> sendData(SendDataContext context) override {
    (void)context;
    return kj::READY_NOW;
  }

  kj::Promise<void> close(CloseContext context) override {
    (void)context;
    return kj::READY_NOW;
  }
};

class CapturingWebSocketMessageStream final:
    public WebSession::WebSocketMessageStream::Server {
public:
  explicit CapturingWebSocketMessageStream(
      kj::Own<kj::PromiseFulfiller<kj::String>> messageFulfiller)
      : messageFulfiller(kj::mv(messageFulfiller)) {}

  CapturingWebSocketMessageStream(
      kj::Own<kj::PromiseFulfiller<kj::String>> messageFulfiller,
      kj::Own<kj::PromiseFulfiller<kj::String>> closeFulfiller)
      : messageFulfiller(kj::mv(messageFulfiller)),
        closeFulfiller(kj::mv(closeFulfiller)) {}

  kj::Promise<void> sendText(SendTextContext context) override {
    KJ_REQUIRE(messageFulfiller.get() != nullptr,
        "direct WebSocket sent more than one message");
    messageFulfiller->fulfill(kj::str(context.getParams().getMessage()));
    messageFulfiller = nullptr;
    return kj::READY_NOW;
  }

  kj::Promise<void> sendData(SendDataContext context) override {
    KJ_FAIL_REQUIRE("direct WebSocket returned binary data",
        context.getParams().getMessage().size());
  }

  kj::Promise<void> close(CloseContext context) override {
    if (closeFulfiller.get() != nullptr) {
      auto params = context.getParams();
      closeFulfiller->fulfill(kj::str(params.getCode(), ":", params.getReason()));
      closeFulfiller = nullptr;
    }
    return kj::READY_NOW;
  }

private:
  kj::Own<kj::PromiseFulfiller<kj::String>> messageFulfiller;
  kj::Own<kj::PromiseFulfiller<kj::String>> closeFulfiller;
};

class CapturingWebSocketCloseStream final:
    public WebSession::WebSocketMessageStream::Server {
public:
  explicit CapturingWebSocketCloseStream(
      kj::Own<kj::PromiseFulfiller<kj::String>> closeFulfiller)
      : closeFulfiller(kj::mv(closeFulfiller)) {}

  kj::Promise<void> sendText(SendTextContext context) override {
    KJ_FAIL_REQUIRE("direct WebSocket unexpectedly returned text",
        context.getParams().getMessage());
  }

  kj::Promise<void> sendData(SendDataContext context) override {
    KJ_FAIL_REQUIRE("direct WebSocket unexpectedly returned binary data",
        context.getParams().getMessage().size());
  }

  kj::Promise<void> close(CloseContext context) override {
    KJ_REQUIRE(closeFulfiller.get() != nullptr,
        "direct WebSocket closed more than once");
    auto params = context.getParams();
    closeFulfiller->fulfill(kj::str(params.getCode(), ":", params.getReason()));
    closeFulfiller = nullptr;
    return kj::READY_NOW;
  }

private:
  kj::Own<kj::PromiseFulfiller<kj::String>> closeFulfiller;
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

class FixedByteStreamSource final: public ByteStreamSource::Server {
public:
  explicit FixedByteStreamSource(kj::String data): data(kj::mv(data)) {}

  kj::Promise<void> read(ReadContext context) override {
    auto maxBytes = context.getParams().getMaxBytes();
    KJ_REQUIRE(maxBytes > 0);
    auto result = context.getResults().initResult();
    if (offset == data.size()) {
      result.setDone();
    } else {
      auto size = kj::min(static_cast<size_t>(maxBytes), data.size() - offset);
      result.setData(data.asBytes().slice(offset, offset + size));
      offset += size;
    }
    return kj::READY_NOW;
  }

  kj::Promise<void> cancel(CancelContext context) override {
    (void)context;
    return kj::READY_NOW;
  }

private:
  kj::String data;
  size_t offset = 0;
};

class CancelAfterFirstByteStreamSource final: public ByteStreamSource::Server {
public:
  explicit CancelAfterFirstByteStreamSource(
      kj::Own<kj::PromiseFulfiller<void>> cancelFulfiller)
      : cancelFulfiller(kj::mv(cancelFulfiller)) {}

  kj::Promise<void> read(ReadContext context) override {
    KJ_REQUIRE(!readCalled, "duplex upload source was read past its first chunk");
    readCalled = true;
    context.getResults().initResult().setData(kj::StringPtr("first-chunk").asBytes());
    return kj::READY_NOW;
  }

  kj::Promise<void> cancel(CancelContext context) override {
    (void)context;
    if (!cancelled) {
      cancelled = true;
      cancelFulfiller->fulfill();
    }
    return kj::READY_NOW;
  }

private:
  kj::Own<kj::PromiseFulfiller<void>> cancelFulfiller;
  bool readCalled = false;
  bool cancelled = false;
};

class GatedCountingByteStream final: public ByteStream::Server {
public:
  GatedCountingByteStream(kj::Promise<void> firstWriteGate,
      kj::Own<kj::PromiseFulfiller<uint64_t>> doneFulfiller)
      : firstWriteGate(kj::mv(firstWriteGate)), doneFulfiller(kj::mv(doneFulfiller)) {}

  kj::Promise<void> write(WriteContext context) override {
    byteCount += context.getParams().getData().size();
    if (!firstWriteSeen) {
      firstWriteSeen = true;
      return kj::mv(firstWriteGate);
    }
    return kj::READY_NOW;
  }

  kj::Promise<void> done(DoneContext context) override {
    doneFulfiller->fulfill(kj::mv(byteCount));
    return kj::READY_NOW;
  }

private:
  kj::Promise<void> firstWriteGate;
  kj::Own<kj::PromiseFulfiller<uint64_t>> doneFulfiller;
  uint64_t byteCount = 0;
  bool firstWriteSeen = false;
};

Supervisor::Client startGrain(kj::WaitScope& waitScope, IsolateAccountHost::Client account,
    SandstormCore::Client core, kj::StringPtr grainId, kj::StringPtr packageId, bool isNew,
    kj::StringPtr mainModule = "worker.js") {
  auto request = account.startGrainRequest();
  request.setGrainId(grainId);
  request.setPackageId(packageId);
  request.setMainModule(mainModule);
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

WebSession::Client newWebSessionFromView(
    kj::WaitScope& waitScope, UiView::Client view) {
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

WebSession::Client newWebSession(kj::WaitScope& waitScope, Supervisor::Client supervisor) {
  auto view = supervisor.getMainViewRequest().send().wait(waitScope).getView();
  return newWebSessionFromView(waitScope, view);
}

template <typename ContextBuilder>
void initIgnoredWebSessionContext(ContextBuilder context) {
  context.setResponseStream(kj::heap<IgnoreByteStream>());
  context.initCookies(0);
  context.initAccept(0);
  context.initAcceptEncoding(0);
  context.initAdditionalHeaders(0);
}

kj::StringPtr requireAdditionalHeader(
    WebSession::Response::Reader response, kj::StringPtr expectedName) {
  for (auto header: response.getAdditionalHeaders()) {
    if (header.getName() == expectedName) return header.getValue();
  }
  KJ_FAIL_REQUIRE("worker UI response omitted expected additional header", expectedName);
}

kj::String fetchViewPath(
    kj::WaitScope& waitScope, UiView::Client view, kj::StringPtr path) {
  auto session = newWebSessionFromView(waitScope, view);
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
    auto body = response.getServerError().getNonHtmlBody().getData();
    KJ_FAIL_REQUIRE("worker UI facade returned a server error",
        kj::heapString(body.asChars()));
  }
  KJ_REQUIRE(response.which() == WebSession::Response::CONTENT,
      "account-host request returned a non-content response", path, response.which());
  auto body = response.getContent().getBody();
  if (body.isBytes()) return kj::str(body.getBytes().asChars());
  KJ_REQUIRE(body.isStream(), "worker UI facade response had an unknown body shape");
  return streamedBody.promise.wait(waitScope);
}

void testWorkerUiStreaming(kj::WaitScope& waitScope, UiView::Client view) {
  auto session = newWebSessionFromView(waitScope, view);
  auto request = session.postStreamingPullRequest();
  request.setPath("upload-stream");
  request.setMimeType("application/octet-stream");
  request.setEncoding("");
  request.setExpectedSize(17);
  request.setBody(kj::heap<FixedByteStreamSource>(kj::str("worker-ui-stream!")));
  auto context = request.initContext();
  auto streamedBody = kj::newPromiseAndFulfiller<kj::String>();
  context.setResponseStream(kj::heap<CollectByteStream>(kj::mv(streamedBody.fulfiller)));
  context.initCookies(0);
  context.initAccept(0);
  context.initAcceptEncoding(0);
  context.initAdditionalHeaders(0);
  auto response = request.send().wait(waitScope);
  KJ_REQUIRE(response.which() == WebSession::Response::CONTENT, response.which());
  auto body = response.getContent().getBody();
  auto text = body.isBytes()
      ? kj::str(body.getBytes().asChars())
      : streamedBody.promise.wait(waitScope);
  KJ_REQUIRE(contains(text, "\"bodyBytes\":17"),
      "JS WebSession facade did not stream a request body", text);

  auto duplex = session.postStreamingPullRequest();
  duplex.setPath("upload-duplex");
  duplex.setMimeType("application/octet-stream");
  duplex.setEncoding("");
  duplex.setExpectedSize(0);
  auto cancelled = kj::newPromiseAndFulfiller<void>();
  duplex.setBody(kj::heap<CancelAfterFirstByteStreamSource>(kj::mv(cancelled.fulfiller)));
  auto duplexContext = duplex.initContext();
  auto duplexStreamedBody = kj::newPromiseAndFulfiller<kj::String>();
  duplexContext.setResponseStream(
      kj::heap<CollectByteStream>(kj::mv(duplexStreamedBody.fulfiller)));
  duplexContext.initCookies(0);
  duplexContext.initAccept(0);
  duplexContext.initAcceptEncoding(0);
  duplexContext.initAdditionalHeaders(0);
  auto duplexResponse = duplex.send().wait(waitScope);
  KJ_REQUIRE(duplexResponse.which() == WebSession::Response::CONTENT,
      duplexResponse.which());
  auto duplexBody = duplexResponse.getContent().getBody();
  auto duplexText = duplexBody.isBytes()
      ? kj::str(duplexBody.getBytes().asChars())
      : duplexStreamedBody.promise.wait(waitScope);
  KJ_REQUIRE(contains(duplexText, "\"firstChunkBytes\":11"),
      "worker did not respond before consuming the whole upload", duplexText);
  cancelled.promise.wait(waitScope);

  auto download = session.getRequest();
  download.setPath("download-stream?bytes=2097169");
  download.setIgnoreBody(false);
  auto downloadContext = download.initContext();
  auto firstWriteGate = kj::newPromiseAndFulfiller<void>();
  auto counted = kj::newPromiseAndFulfiller<uint64_t>();
  downloadContext.setResponseStream(kj::heap<GatedCountingByteStream>(
      kj::mv(firstWriteGate.promise), kj::mv(counted.fulfiller)));
  downloadContext.initCookies(0);
  downloadContext.initAccept(0);
  downloadContext.initAcceptEncoding(0);
  downloadContext.initAdditionalHeaders(0);
  // The first ByteStream write cannot finish yet. Receiving the response proves the method Return
  // is independent of its event-scoped waitUntil() body pump.
  auto downloadResponse = download.send().wait(waitScope);
  KJ_REQUIRE(downloadResponse.which() == WebSession::Response::CONTENT,
      downloadResponse.which());
  KJ_REQUIRE(downloadResponse.getContent().getBody().isStream());
  firstWriteGate.fulfiller->fulfill();
  KJ_REQUIRE(counted.promise.wait(waitScope) == 2097169,
      "JS WebSession facade truncated a streamed response");
}

void testWorkerUiHttpParity(kj::WaitScope& waitScope, UiView::Client view) {
  auto session = newWebSessionFromView(waitScope, view);
  auto metadataRequest = session.getRequest();
  metadataRequest.setPath("direct-ui-metadata");
  metadataRequest.setIgnoreBody(false);
  initIgnoredWebSessionContext(metadataRequest.initContext());
  auto metadata = metadataRequest.send().wait(waitScope);
  KJ_REQUIRE(metadata.which() == WebSession::Response::CONTENT, metadata.which());
  KJ_REQUIRE(metadata.getSetCookies().size() == 1,
      "JS WebSession facade did not translate Set-Cookie");
  auto cookie = metadata.getSetCookies()[0];
  KJ_REQUIRE(cookie.getName() == "workerSession" && cookie.getValue() == "alpha");
  KJ_REQUIRE(cookie.getExpires().isRelative() && cookie.getExpires().getRelative() == 120);
  KJ_REQUIRE(cookie.getHttpOnly() && cookie.getPath() == "/scope");
  auto cachePolicy = metadata.getCachePolicy();
  KJ_REQUIRE(cachePolicy.getPermanent() == WebSession::CachePolicy::Scope::PER_SESSION);
  KJ_REQUIRE(cachePolicy.getWithCheck() == WebSession::CachePolicy::Scope::NONE);
  KJ_REQUIRE(cachePolicy.getVariesOnCookie() && cachePolicy.getVariesOnAccept());
  auto content = metadata.getContent();
  KJ_REQUIRE(content.getETag().getWeak() &&
      content.getETag().getValue() == "worker-ui-metadata");
  KJ_REQUIRE(content.getLanguage() == "en-CA");
  KJ_REQUIRE(content.getDisposition().isDownload() &&
      content.getDisposition().getDownload() == "worker-report.txt");
  KJ_REQUIRE(requireAdditionalHeader(metadata, "x-sandstorm-app-metadata") == "present");

  auto propfind = session.propfindRequest();
  propfind.setPath("direct-ui-webdav");
  propfind.setXmlContent("<propfind/>");
  propfind.setDepth(WebSession::PropfindDepth::ONE);
  initIgnoredWebSessionContext(propfind.initContext());
  auto propfindResponse = propfind.send().wait(waitScope);
  KJ_REQUIRE(requireAdditionalHeader(propfindResponse, "x-sandstorm-app-dav-method") ==
      "PROPFIND");
  KJ_REQUIRE(requireAdditionalHeader(propfindResponse, "x-sandstorm-app-dav-depth") == "1");
  KJ_REQUIRE(requireAdditionalHeader(propfindResponse, "x-sandstorm-app-dav-type") ==
      "application/xml;charset=utf-8");

  auto copy = session.copyRequest();
  copy.setPath("direct-ui-webdav");
  copy.setDestination("copied");
  copy.setNoOverwrite(true);
  copy.setShallow(true);
  initIgnoredWebSessionContext(copy.initContext());
  auto copyResponse = copy.send().wait(waitScope);
  KJ_REQUIRE(requireAdditionalHeader(copyResponse, "x-sandstorm-app-dav-method") == "COPY");
  KJ_REQUIRE(requireAdditionalHeader(copyResponse, "x-sandstorm-app-dav-destination") ==
      "https://account-host-test.invalid/copied");
  KJ_REQUIRE(requireAdditionalHeader(copyResponse, "x-sandstorm-app-dav-overwrite") == "F");
  KJ_REQUIRE(requireAdditionalHeader(copyResponse, "x-sandstorm-app-dav-depth") == "0");

  auto move = session.moveRequest();
  move.setPath("direct-ui-webdav");
  move.setDestination("moved");
  move.setNoOverwrite(false);
  initIgnoredWebSessionContext(move.initContext());
  auto moveResponse = move.send().wait(waitScope);
  KJ_REQUIRE(requireAdditionalHeader(moveResponse, "x-sandstorm-app-dav-method") == "MOVE");
  KJ_REQUIRE(requireAdditionalHeader(moveResponse, "x-sandstorm-app-dav-destination") ==
      "https://account-host-test.invalid/moved");
  KJ_REQUIRE(requireAdditionalHeader(moveResponse, "x-sandstorm-app-dav-overwrite") == "T");

  auto lock = session.lockRequest();
  lock.setPath("direct-ui-webdav");
  lock.setXmlContent("<lock/>");
  lock.setShallow(false);
  initIgnoredWebSessionContext(lock.initContext());
  auto lockResponse = lock.send().wait(waitScope);
  KJ_REQUIRE(requireAdditionalHeader(lockResponse, "x-sandstorm-app-dav-method") == "LOCK");
  KJ_REQUIRE(requireAdditionalHeader(lockResponse, "x-sandstorm-app-dav-depth") == "infinity");
  KJ_REQUIRE(requireAdditionalHeader(lockResponse, "x-sandstorm-app-dav-type") ==
      "application/xml;charset=utf-8");

  auto unlock = session.unlockRequest();
  unlock.setPath("direct-ui-webdav");
  unlock.setLockToken("<worker-lock-token>");
  initIgnoredWebSessionContext(unlock.initContext());
  auto unlockResponse = unlock.send().wait(waitScope);
  KJ_REQUIRE(requireAdditionalHeader(unlockResponse, "x-sandstorm-app-dav-method") == "UNLOCK");
  KJ_REQUIRE(requireAdditionalHeader(unlockResponse, "x-sandstorm-app-dav-lock-token") ==
      "<worker-lock-token>");
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
  KJ_REQUIRE(response.which() == WebSession::Response::CONTENT,
      "account-host request returned a non-content response", path, response.which());
  auto content = response.getContent();
  KJ_REQUIRE(content.getStatusCode() == WebSession::Response::SuccessCode::OK);
  auto body = content.getBody();
  if (body.isBytes()) {
    return kj::str(body.getBytes().asChars());
  }
  KJ_REQUIRE(body.isStream(), "account-host test response had an unknown body shape");
  return streamedBody.promise.wait(waitScope);
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

void testLogicalWebSocket(kj::WaitScope& waitScope, Supervisor::Client supervisor) {
  auto session = newWebSession(waitScope, supervisor);
  auto received = kj::newPromiseAndFulfiller<kj::String>();

  auto request = session.openWebSocketMessagesRequest();
  request.setPath("websocket-echo");
  request.initProtocol(0);
  request.setClientStream(kj::heap<CapturingWebSocketMessageStream>(
      kj::mv(received.fulfiller)));
  auto context = request.initContext();
  context.setResponseStream(kj::heap<IgnoreByteStream>());
  context.initCookies(0);
  context.initAccept(0);
  context.initAcceptEncoding(0);
  context.initAdditionalHeaders(0);

  auto response = request.send().wait(waitScope);
  KJ_REQUIRE(response.getProtocol().size() == 0);
  auto serverStream = response.getServerStream();
  auto send = serverStream.sendTextRequest();
  send.setMessage("direct");
  send.send().wait(waitScope);
  KJ_REQUIRE(received.promise.wait(waitScope) == "capnp:direct",
      "logical worker WebSocket returned wrong payload");

  auto close = serverStream.closeRequest();
  close.setCode(1000);
  close.setReason("test complete");
  close.send().wait(waitScope);

  auto failedReceived = kj::newPromiseAndFulfiller<kj::String>();
  auto failedClose = kj::newPromiseAndFulfiller<kj::String>();
  auto failedRequest = session.openWebSocketMessagesRequest();
  failedRequest.setPath("websocket-echo");
  failedRequest.initProtocol(0);
  failedRequest.setClientStream(kj::heap<CapturingWebSocketMessageStream>(
      kj::mv(failedReceived.fulfiller), kj::mv(failedClose.fulfiller)));
  auto failedContext = failedRequest.initContext();
  failedContext.setResponseStream(kj::heap<IgnoreByteStream>());
  failedContext.initCookies(0);
  failedContext.initAccept(0);
  failedContext.initAcceptEncoding(0);
  failedContext.initAdditionalHeaders(0);

  auto failedResponse = failedRequest.send().wait(waitScope);
  auto failedStream = failedResponse.getServerStream();
  auto failedSend = failedStream.sendTextRequest();
  failedSend.setMessage("fail");
  failedSend.send().wait(waitScope);
  KJ_REQUIRE(failedReceived.promise.wait(waitScope) ==
      "error:message:intentional direct WebSocket failure",
      "direct WebSocket error callback returned the wrong payload");
  KJ_REQUIRE(failedClose.promise.wait(waitScope) ==
      "1011:WebSocket handler failed",
      "direct WebSocket handler failure returned the wrong close status");

  auto workerClose = kj::newPromiseAndFulfiller<kj::String>();
  auto workerCloseRequest = session.openWebSocketMessagesRequest();
  workerCloseRequest.setPath("websocket-echo");
  workerCloseRequest.initProtocol(0);
  workerCloseRequest.setClientStream(kj::heap<CapturingWebSocketCloseStream>(
      kj::mv(workerClose.fulfiller)));
  auto workerCloseContext = workerCloseRequest.initContext();
  workerCloseContext.setResponseStream(kj::heap<IgnoreByteStream>());
  workerCloseContext.initCookies(0);
  workerCloseContext.initAccept(0);
  workerCloseContext.initAcceptEncoding(0);
  workerCloseContext.initAdditionalHeaders(0);

  auto workerCloseResponse = workerCloseRequest.send().wait(waitScope);
  auto workerCloseStream = workerCloseResponse.getServerStream();
  auto workerCloseSend = workerCloseStream.sendTextRequest();
  workerCloseSend.setMessage("close-from-worker");
  workerCloseSend.send().wait(waitScope);
  KJ_REQUIRE(workerClose.promise.wait(waitScope) == "4001:worker complete",
      "direct WebSocket worker close returned the wrong status");
}

void testBrowserBootstrap(kj::WaitScope& waitScope, Supervisor::Client supervisor) {
  auto session = newWebSession(waitScope, supervisor);
  auto request = session.openWebSocketMessagesRequest();
  request.setPath("/__sandstorm/native-capnp/rpc-session");
  request.initProtocol(0);
  request.setClientStream(kj::heap<IgnoreWebSocketMessageStream>());
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
  bool mainViewRoleMode = argc == 5 && kj::StringPtr(argv[4]) == "--main-view-role";
  bool serviceOnlyMode = argc == 5 && kj::StringPtr(argv[4]) == "--service-only";
  KJ_REQUIRE(argc == 4 || benchmarkMode || mainViewRoleMode || serviceOnlyMode,
      "usage: isolate-account-host-client <control-socket> <grain-id> <package-id> "
      "[--main-view-role | --service-only | "
      "--benchmark [--samples N] [--concurrency N] [--small-iterations N] "
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

  if (serviceOnlyMode) {
    auto supervisor = sandstorm::startGrain(
        io.waitScope, account, core, argv[2], argv[3], true, "service-worker.js");
    coreImpl.setSupervisor(argv[2], supervisor);
    auto exportRequest = supervisor.getExportRequest();
    exportRequest.setName("greeter");
    exportRequest.setInterfaceId(capnp::typeId<NativeGreeter>());
    auto greeter = exportRequest.send().wait(io.waitScope).getCap().castAs<NativeGreeter>();
    auto hello = greeter.helloRequest();
    hello.setName("without UI");
    KJ_REQUIRE(hello.send().wait(io.waitScope).getMessage() ==
        "service-only hello without UI",
        "service-only worker export did not answer directly");

    auto storage = greeter.storageRoundTripRequest();
    storage.setKey("service-only-typed-storage");
    storage.setValue(kj::StringPtr("typed storage without Fetch").asBytes());
    auto storageResult = storage.send().wait(io.waitScope);
    KJ_REQUIRE(storageResult.getValue() ==
        kj::StringPtr("typed storage without Fetch").asBytes(),
        "service-only typed storage returned the wrong value");
    KJ_REQUIRE(storageResult.getListed(),
        "service-only typed storage did not list the stored value");

    auto saveRequest = greeter.castAs<sandstorm::SystemPersistent>().saveRequest();
    auto tokenOwner = saveRequest.getSealFor().initGrain();
    tokenOwner.setGrainId(argv[2]);
    tokenOwner.getSaveLabel().setDefaultText("service-only greeter");
    auto token = kj::heapArray<kj::byte>(
        saveRequest.send().wait(io.waitScope).getSturdyRef());

    auto restoreRequest = core.restoreRequest();
    restoreRequest.setToken(token);
    auto restored = restoreRequest.send().wait(io.waitScope).getCap()
        .castAs<NativeGreeter>();
    auto restoredHello = restored.helloRequest();
    restoredHello.setName("after save and restore");
    KJ_REQUIRE(restoredHello.send().wait(io.waitScope).getMessage() ==
        "service-only hello after save and restore",
        "service-only worker export did not restore without a UI path");

    auto dropRequest = core.dropRequest();
    dropRequest.setToken(token);
    dropRequest.send().wait(io.waitScope);
    bool revokedTokenRejected = false;
    try {
      auto restoreRevokedRequest = core.restoreRequest();
      restoreRevokedRequest.setToken(token);
      restoreRevokedRequest.send().wait(io.waitScope);
    } catch (const kj::Exception&) {
      revokedTokenRejected = true;
    }
    KJ_REQUIRE(revokedTokenRejected,
        "revoked service-only worker export remained restorable");

    bool mainViewRejected = false;
    try {
      supervisor.getMainViewRequest().send().wait(io.waitScope);
    } catch (const kj::Exception& exception) {
      mainViewRejected = exception.getType() == kj::Exception::Type::UNIMPLEMENTED;
    }
    KJ_REQUIRE(mainViewRejected,
        "service-only worker did not reject getMainView() as unimplemented");
    sandstorm::expectShutdown(io.waitScope, supervisor);
    return 0;
  }

  if (mainViewRoleMode) {
    auto supervisor = sandstorm::startGrain(
        io.waitScope, account, core, argv[2], argv[3], true, "main-view-worker.js");
    coreImpl.setSupervisor(argv[2], supervisor);
    auto view = supervisor.getMainViewRequest().send().wait(io.waitScope).getView();
    auto echo = sandstorm::fetchViewPath(io.waitScope, view, "echo");
    KJ_REQUIRE(sandstorm::contains(echo, "\"ok\":true"),
        "Supervisor.getMainView() did not resolve the worker export assigned the mainView role",
        echo);
    auto browserHandoff = sandstorm::fetchViewPath(
        io.waitScope, view, "direct-browser-handoff");
    KJ_REQUIRE(sandstorm::contains(browserHandoff, "\"ok\":true") &&
        sandstorm::contains(browserHandoff, "\"residence\":\"browserHandoff\"") &&
        sandstorm::contains(browserHandoff, "\"handoffId\":"),
        "mainView-role worker session did not support browser capability handoff",
        browserHandoff);
    sandstorm::testLogicalWebSocket(io.waitScope, supervisor);
    sandstorm::expectShutdown(io.waitScope, supervisor);

    auto objectWorker = sandstorm::startGrain(
        io.waitScope, account, core, "simpleobjectgrain", argv[3], true,
        "simple-object-worker.js");
    coreImpl.setSupervisor("simpleobjectgrain", objectWorker);
    auto objectView =
        objectWorker.getMainViewRequest().send().wait(io.waitScope).getView();
    auto objectResponse = sandstorm::fetchViewPath(io.waitScope, objectView, "simple-object");
    KJ_REQUIRE(sandstorm::contains(objectResponse, "\"ok\":true") &&
        sandstorm::contains(objectResponse, "\"style\":\"object\"") &&
        sandstorm::contains(objectResponse, "\"pathname\":\"/simple-object\"") &&
        sandstorm::contains(objectResponse, "\"hasEnv\":true"),
        "Cloudflare-style object worker was not adapted to MainView", objectResponse);
    sandstorm::expectShutdown(io.waitScope, objectWorker);

    auto functionWorker = sandstorm::startGrain(
        io.waitScope, account, core, "simplefunctiongrain", argv[3], true,
        "simple-function-worker.js");
    coreImpl.setSupervisor("simplefunctiongrain", functionWorker);
    auto functionView =
        functionWorker.getMainViewRequest().send().wait(io.waitScope).getView();
    auto functionResponse = sandstorm::fetchViewPath(
        io.waitScope, functionView, "simple-function");
    KJ_REQUIRE(sandstorm::contains(functionResponse, "\"ok\":true") &&
        sandstorm::contains(functionResponse, "\"style\":\"function\"") &&
        sandstorm::contains(functionResponse, "\"pathname\":\"/simple-function\"") &&
        sandstorm::contains(functionResponse, "\"hasEnv\":true"),
        "default function worker was not adapted to MainView", functionResponse);
    sandstorm::expectShutdown(io.waitScope, functionWorker);
    return 0;
  }

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
  sandstorm::expectShutdown(io.waitScope, concurrentSupervisor1);

  auto supervisor = sandstorm::startGrain(
      io.waitScope, account, core, argv[2], argv[3], true);
  coreImpl.setSupervisor(argv[2], supervisor);
  auto workerExportRequest = supervisor.getExportRequest();
  workerExportRequest.setName("greeter");
  workerExportRequest.setInterfaceId(capnp::typeId<NativeGreeter>());
  auto workerGreeter = workerExportRequest.send().wait(io.waitScope).getCap()
      .castAs<NativeGreeter>();
  auto greetingRequest = workerGreeter.helloRequest();
  greetingRequest.setName("account host");
  auto greeting = greetingRequest.send().wait(io.waitScope).getMessage();
  KJ_REQUIRE(greeting == "classic native greeter supervisor-export hello account host",
      "Supervisor did not proxy the named worker export", greeting);

  auto workerUiRequest = supervisor.getExportRequest();
  workerUiRequest.setName("ui");
  workerUiRequest.setInterfaceId(capnp::typeId<sandstorm::MainView<>>());
  auto workerUiCap = workerUiRequest.send().wait(io.waitScope).getCap();
  auto workerUi = workerUiCap.castAs<sandstorm::UiView>();
  auto workerUiEcho = sandstorm::fetchViewPath(io.waitScope, workerUi, "echo");
  KJ_REQUIRE(sandstorm::contains(workerUiEcho, "\"ok\":true"),
      "JS MainView/WebSession Fetch facade did not serve a request", workerUiEcho);
  sandstorm::testWorkerUiStreaming(io.waitScope, workerUi);
  sandstorm::testWorkerUiHttpParity(io.waitScope, workerUi);
  auto offersBefore = sandstorm::TestSessionContext::getOfferCount();
  auto directSessionContext = sandstorm::fetchViewPath(
      io.waitScope, workerUi, "direct-session-context-offer");
  KJ_REQUIRE(sandstorm::contains(directSessionContext, "\"directSessionContext\":true"),
      "JS MainView facade did not complete its direct SessionContext operation",
      directSessionContext);
  KJ_REQUIRE(sandstorm::TestSessionContext::getOfferCount() == offersBefore + 1,
      "JS MainView facade did not call the SessionContext capability passed to newSession()");
  auto directBrowserHandoff = sandstorm::fetchViewPath(
      io.waitScope, workerUi, "direct-browser-handoff");
  KJ_REQUIRE(sandstorm::contains(directBrowserHandoff, "\"ok\":true") &&
      sandstorm::contains(directBrowserHandoff, "\"residence\":\"browserHandoff\"") &&
      sandstorm::contains(directBrowserHandoff, "\"handoffId\":"),
      "direct JS MainView session was not registered for browser capability handoff",
      directBrowserHandoff);

  auto restoreUiChildRequest = workerUiCap.castAs<sandstorm::MainView<>>().restoreRequest();
  restoreUiChildRequest.getObjectId().initAs<NativeGreeterObjectId>().setId("ui-child");
  auto workerUiChild = restoreUiChildRequest.send().wait(io.waitScope).getCap()
      .castAs<NativeGreeter>();
  auto saveUiChildRequest = workerUiChild.castAs<sandstorm::SystemPersistent>().saveRequest();
  auto uiChildOwner = saveUiChildRequest.getSealFor().initGrain();
  uiChildOwner.setGrainId(argv[2]);
  uiChildOwner.getSaveLabel().setDefaultText("worker UI child with a different interface");
  auto uiChildToken = kj::heapArray<kj::byte>(
      saveUiChildRequest.send().wait(io.waitScope).getSturdyRef());
  auto restoreSavedUiChild = core.restoreRequest();
  restoreSavedUiChild.setToken(uiChildToken);
  auto restoredUiChild = restoreSavedUiChild.send().wait(io.waitScope).getCap()
      .castAs<NativeGreeter>();
  auto restoredUiChildHello = restoredUiChild.helloRequest();
  restoredUiChildHello.setName("different interface registry");
  KJ_REQUIRE(restoredUiChildHello.send().wait(io.waitScope).getMessage() ==
      "classic native greeter ui-child hello different interface registry",
      "durable worker registry did not restore a child with a different interface");

  auto saveWorkerExportRequest =
      workerGreeter.castAs<sandstorm::SystemPersistent>().saveRequest();
  auto workerTokenOwner = saveWorkerExportRequest.getSealFor().initGrain();
  workerTokenOwner.setGrainId(argv[2]);
  workerTokenOwner.getSaveLabel().setDefaultText("named isolate worker export");
  auto savedWorkerExport = saveWorkerExportRequest.send().wait(io.waitScope);
  auto workerExportToken = kj::heapArray<kj::byte>(savedWorkerExport.getSturdyRef());

  auto restoreWorkerExportRequest = core.restoreRequest();
  restoreWorkerExportRequest.setToken(workerExportToken);
  auto restoredWorkerGreeter = restoreWorkerExportRequest.send().wait(io.waitScope)
      .getCap().castAs<NativeGreeter>();
  auto restoredGreetingRequest = restoredWorkerGreeter.helloRequest();
  restoredGreetingRequest.setName("restored account host");
  auto restoredGreeting = restoredGreetingRequest.send().wait(io.waitScope).getMessage();
  KJ_REQUIRE(restoredGreeting ==
      "classic native greeter supervisor-export hello restored account host",
      "named worker export did not restore through its durable registry", restoredGreeting);

  auto makePipelinedGreeterRequest = workerGreeter.makeGreeterRequest();
  makePipelinedGreeterRequest.setPrefix("pipelined worker greeter");
  auto makePipelinedGreeter = makePipelinedGreeterRequest.send();
  auto pipelinedHelloRequest = makePipelinedGreeter.getGreeter().helloRequest();
  pipelinedHelloRequest.setName("account host");
  auto pipelinedGreeting = pipelinedHelloRequest.send().wait(io.waitScope).getMessage();
  KJ_REQUIRE(pipelinedGreeting == "pipelined worker greeter account host",
      "worker promise-pipelined capability call failed", pipelinedGreeting);

  auto callbackStarted = kj::newPromiseAndFulfiller<void>();
  auto callbackRelease = kj::newPromiseAndFulfiller<void>();
  auto concurrentFirstRequest = workerGreeter.greetWithRequest();
  concurrentFirstRequest.setGreeter(kj::heap<sandstorm::BlockingNativeGreeter>(
      kj::str("concurrent first from classic native greeter supervisor-export"),
      kj::mv(callbackStarted.fulfiller), kj::mv(callbackRelease.promise)));
  concurrentFirstRequest.setName("concurrent first");
  auto concurrentFirst = concurrentFirstRequest.send();
  callbackStarted.promise.wait(io.waitScope);

  auto concurrentSecondRequest = workerGreeter.helloRequest();
  concurrentSecondRequest.setName("concurrent second");
  auto concurrentSecond = concurrentSecondRequest.send().wait(io.waitScope).getMessage();
  KJ_REQUIRE(concurrentSecond ==
      "classic native greeter supervisor-export hello concurrent second",
      "concurrent worker RPC did not run in an independent event", concurrentSecond);

  callbackRelease.fulfiller->fulfill();
  auto concurrentFirstMessage = concurrentFirst.wait(io.waitScope).getMessage();
  KJ_REQUIRE(concurrentFirstMessage ==
      "classic native greeter supervisor-export called released "
      "concurrent first from classic native greeter supervisor-export",
      "blocked worker RPC did not resume after its callback", concurrentFirstMessage);

  {
    auto cancellationRequest = workerGreeter.helloRequest();
    cancellationRequest.setName("cancel cooperative");
    auto canceledCall = cancellationRequest.send().dropPipeline().eagerlyEvaluate(nullptr);
    auto startedRequest = workerGreeter.helloRequest();
    startedRequest.setName("cancellation started");
    auto started = startedRequest.send().wait(io.waitScope).getMessage();
    KJ_REQUIRE(started ==
        "classic native greeter supervisor-export hello cancellation started",
        "worker cancellation probe did not start", started);
    // Cancel the only response promise. This sends Finish for the outstanding worker question.
    canceledCall = nullptr;
  }
  bool cancellationObserved = false;
  for (uint attempt = 0; attempt < 100; ++attempt) {
    auto statusRequest = workerGreeter.helloRequest();
    statusRequest.setName("cancellation status");
    auto status = statusRequest.send().wait(io.waitScope).getMessage();
    if (status == "cancellation observed") {
      cancellationObserved = true;
      break;
    }
    KJ_REQUIRE(status == "cancellation pending", "unexpected cancellation status", status);
    io.provider->getTimer().afterDelay(10 * kj::MILLISECONDS).wait(io.waitScope);
  }
  KJ_REQUIRE(cancellationObserved, "worker did not receive client-initiated RPC cancellation");
  auto afterCancellationRequest = workerGreeter.helloRequest();
  afterCancellationRequest.setName("after cancellation");
  auto afterCancellation = afterCancellationRequest.send().wait(io.waitScope).getMessage();
  KJ_REQUIRE(afterCancellation ==
      "classic native greeter supervisor-export hello after cancellation",
      "worker did not observe client-initiated RPC cancellation", afterCancellation);

  auto membraneExportRequest = supervisor.getExportRequest();
  membraneExportRequest.setName("greeter");
  membraneExportRequest.setInterfaceId(capnp::typeId<NativeGreeter>());
  auto membraneExport = membraneExportRequest.send().wait(io.waitScope).getCap()
      .castAs<sandstorm::SystemPersistent>();
  auto revokerHandle = kj::newPromiseAndFulfiller<capnp::Capability::Client>();
  auto addRequirementsRequest = membraneExport.addRequirementsRequest();
  addRequirementsRequest.setObserver(kj::heap<sandstorm::CapturingRevocationObserver>(
      kj::mv(revokerHandle.fulfiller)));
  auto attenuatedGreeter = addRequirementsRequest.send().wait(io.waitScope).getCap()
      .castAs<NativeGreeter>();
  auto revoker = revokerHandle.promise.wait(io.waitScope);
  auto beforeRequirementRevocationRequest = attenuatedGreeter.helloRequest();
  beforeRequirementRevocationRequest.setName("before requirement revocation");
  KJ_REQUIRE(beforeRequirementRevocationRequest.send().wait(io.waitScope).getMessage() ==
      "classic native greeter supervisor-export hello before requirement revocation");
  auto makeAttenuatedChildRequest = attenuatedGreeter.makeGreeterRequest();
  makeAttenuatedChildRequest.setPrefix("attenuated returned worker greeter");
  auto attenuatedChild = makeAttenuatedChildRequest.send().wait(io.waitScope).getGreeter();
  auto beforeChildRevocationRequest = attenuatedChild.helloRequest();
  beforeChildRevocationRequest.setName("before child revocation");
  KJ_REQUIRE(beforeChildRevocationRequest.send().wait(io.waitScope).getMessage() ==
      "attenuated returned worker greeter before child revocation");
  revoker = nullptr;
  bool requirementRevoked = false;
  for (uint attempt = 0; attempt < 100; ++attempt) {
    try {
      auto revokedRequest = attenuatedChild.helloRequest();
      revokedRequest.setName("after requirement revocation");
      revokedRequest.send().wait(io.waitScope);
    } catch (const kj::Exception&) {
      requirementRevoked = true;
      break;
    }
    io.provider->getTimer().afterDelay(10 * kj::MILLISECONDS).wait(io.waitScope);
  }
  KJ_REQUIRE(requirementRevoked,
      "worker export remained callable after its membrane requirements were revoked");
  sandstorm::fetchPath(io.waitScope, supervisor, core, "echo");
  sandstorm::testLogicalWebSocket(io.waitScope, supervisor);
  sandstorm::testBrowserBootstrap(io.waitScope, supervisor);
  sandstorm::testStreamingResponse(io.waitScope, supervisor);
  auto routePersistence = sandstorm::fetchPath(
      io.waitScope, supervisor, core, "web-session-save-restore-self-test");
  KJ_REQUIRE(sandstorm::contains(routePersistence, "\"ok\":true"), routePersistence);
  auto outboundRestore = sandstorm::fetchPath(
      io.waitScope, supervisor, core, "outbound-http-restore-self-test");
  KJ_REQUIRE(sandstorm::contains(outboundRestore, "\"ok\":true"), outboundRestore);
  KJ_REQUIRE(sandstorm::contains(outboundRestore, "\"source\":\"fake-outbound-http\""),
      outboundRestore);
  auto appPersistence = sandstorm::fetchPath(
      io.waitScope, supervisor, core, "app-persistent-save-restore-self-test");
  KJ_REQUIRE(sandstorm::contains(appPersistence, "\"ok\":true"), appPersistence);
  KJ_REQUIRE(sandstorm::contains(appPersistence,
      "\"message\":\"classic native greeter account-host-app-persistent hello parity\""),
      appPersistence);
  sandstorm::fetchPath(io.waitScope, supervisor, core, "typed-platform-probe");
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
  auto shutdownCallbackStarted = kj::newPromiseAndFulfiller<void>();
  auto shutdownCallbackRelease = kj::newPromiseAndFulfiller<void>();
  auto pendingShutdownRequest = workerGreeter.greetWithRequest();
  pendingShutdownRequest.setGreeter(kj::heap<sandstorm::BlockingNativeGreeter>(
      kj::str("shutdown pending from classic native greeter supervisor-export"),
      kj::mv(shutdownCallbackStarted.fulfiller), kj::mv(shutdownCallbackRelease.promise)));
  pendingShutdownRequest.setName("shutdown pending");
  auto pendingShutdownCall = pendingShutdownRequest.send();
  shutdownCallbackStarted.promise.wait(io.waitScope);

  sandstorm::expectShutdown(io.waitScope, supervisor);

  bool pendingCallRejectedAfterShutdown = false;
  try {
    pendingShutdownCall.wait(io.waitScope);
  } catch (const kj::Exception&) {
    pendingCallRejectedAfterShutdown = true;
  }
  KJ_REQUIRE(pendingCallRejectedAfterShutdown,
      "in-flight worker export call remained pending after grain shutdown");

  bool exportRejectedAfterShutdown = false;
  try {
    auto stoppedGreeting = workerGreeter.helloRequest();
    stoppedGreeting.setName("after shutdown");
    stoppedGreeting.send().wait(io.waitScope);
  } catch (const kj::Exception&) {
    exportRejectedAfterShutdown = true;
  }
  KJ_REQUIRE(exportRejectedAfterShutdown,
      "worker export capability remained usable after grain shutdown");

  bool rejectedAfterShutdown = false;
  try {
    supervisor.keepAliveRequest().send().wait(io.waitScope);
  } catch (const kj::Exception&) {
    rejectedAfterShutdown = true;
  }
  KJ_REQUIRE(rejectedAfterShutdown, "shut-down Supervisor capability remained usable");

  auto restarted = sandstorm::startGrain(
      io.waitScope, account, core, argv[2], argv[3], false);
  coreImpl.setSupervisor(argv[2], restarted);
  sandstorm::fetchPath(io.waitScope, restarted, core, "echo");
  sandstorm::fetchPath(io.waitScope, restarted, core, "typed-platform-probe");
  sandstorm::fetchPath(io.waitScope, restarted, core, "storage-helper-self-test");
  sandstorm::fetchPath(io.waitScope, restarted, core, "binding-values-probe");
  sandstorm::fetchPath(io.waitScope, restarted, core, "data-binding-probe");
  auto restartedStorage = sandstorm::fetchPath(
      io.waitScope, restarted, core, "shared-storage-isolation");
  KJ_REQUIRE(restartedStorage == "{\"ok\":true,\"value\":\"first\"}",
      "shared grain restart lost or crossed storage authority", restartedStorage);

  auto restoreRestartedWorkerRequest = core.restoreRequest();
  restoreRestartedWorkerRequest.setToken(workerExportToken);
  auto restartedWorkerGreeter = restoreRestartedWorkerRequest.send().wait(io.waitScope)
      .getCap().castAs<NativeGreeter>();
  auto restartedWorkerGreetingRequest = restartedWorkerGreeter.helloRequest();
  restartedWorkerGreetingRequest.setName("after worker restart");
  auto restartedWorkerGreeting =
      restartedWorkerGreetingRequest.send().wait(io.waitScope).getMessage();
  KJ_REQUIRE(restartedWorkerGreeting ==
      "classic native greeter supervisor-export hello after worker restart",
      "durable worker export did not restore into a new worker incarnation",
      restartedWorkerGreeting);

  auto makeDurableChildRequest = restartedWorkerGreeter.makeGreeterRequest();
  makeDurableChildRequest.setPrefix("durable returned worker greeter");
  auto durableChild = makeDurableChildRequest.send().wait(io.waitScope).getGreeter();
  auto saveDurableChildRequest = durableChild.castAs<sandstorm::SystemPersistent>().saveRequest();
  auto durableChildOwner = saveDurableChildRequest.getSealFor().initGrain();
  durableChildOwner.setGrainId(argv[2]);
  durableChildOwner.getSaveLabel().setDefaultText("returned isolate worker capability");
  auto savedDurableChild = saveDurableChildRequest.send().wait(io.waitScope);
  auto durableChildToken = kj::heapArray<kj::byte>(savedDurableChild.getSturdyRef());
  auto restoreDurableChildRequest = core.restoreRequest();
  restoreDurableChildRequest.setToken(durableChildToken);
  auto restoredDurableChild = restoreDurableChildRequest.send().wait(io.waitScope)
      .getCap().castAs<NativeGreeter>();
  auto durableChildGreetingRequest = restoredDurableChild.helloRequest();
  durableChildGreetingRequest.setName("after child restore");
  auto durableChildGreeting = durableChildGreetingRequest.send().wait(io.waitScope).getMessage();
  KJ_REQUIRE(durableChildGreeting ==
      "durable returned worker greeter after child restore",
      "returned worker capability bypassed durable realm translation", durableChildGreeting);

  auto dropWorkerTokenRequest = core.dropRequest();
  dropWorkerTokenRequest.setToken(durableChildToken);
  dropWorkerTokenRequest.send().wait(io.waitScope);
  bool droppedWorkerTokenRejected = false;
  try {
    auto restoreDroppedWorkerRequest = core.restoreRequest();
    restoreDroppedWorkerRequest.setToken(durableChildToken);
    restoreDroppedWorkerRequest.send().wait(io.waitScope);
  } catch (const kj::Exception&) {
    droppedWorkerTokenRejected = true;
  }
  KJ_REQUIRE(droppedWorkerTokenRejected,
      "revoked durable worker export token remained restorable");
  auto isolatedSecondStorage = sandstorm::fetchPath(
      io.waitScope, second, core, "shared-storage-isolation");
  KJ_REQUIRE(isolatedSecondStorage == "{\"ok\":true,\"value\":\"second\"}",
      "first shared grain restart changed the second grain's storage", isolatedSecondStorage);
  sandstorm::fetchPath(io.waitScope, second, core, "echo");
  return 0;
}
