// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2026 Sandstorm contributors
// Licensed under the Apache License, Version 2.0.

#include "server.h"
#include "v8-platform-impl.h"

#include <workerd/server/sandstorm-isolate-host.capnp.h>
#include <workerd/server/sandstorm-isolate-worker-source.capnp.h>
#include <workerd/io/actor-cache.h>
#include <workerd/io/compatibility-date.h>
#include <workerd/io/limit-enforcer.h>
#include <workerd/jsg/setup.h>
#include <workerd/util/stream-utils.h>

#include <capnp/rpc-twoparty.h>
#include <capnp/compat/json.h>
#include <capnp/compat/http-over-capnp.h>
#include <capnp/serialize-packed.h>
#include <kj/async-io.h>
#include <kj/map.h>
#include <kj/mutex.h>
#include <kj/thread.h>

#include <sys/random.h>
#include <unistd.h>

#include <atomic>
#include <climits>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <mutex>
#include <thread>

namespace sandstorm {
namespace {

constexpr kj::StringPtr LOADER_NAMESPACE = "sandstorm-grains"_kj;

// These are host policy rather than workerd embedding API. Keep them conservative until the
// Phase 4 measurements give us enough data to make them configurable per account/app.
constexpr size_t ISOLATE_OLD_HEAP_LIMIT = 64 * 1024 * 1024;
constexpr size_t ISOLATE_YOUNG_HEAP_LIMIT = 16 * 1024 * 1024;
constexpr size_t BUFFERING_LIMIT = 16 * 1024 * 1024;
constexpr size_t MAX_WORKER_SOURCE_BYTES = 16 * 1024 * 1024;
constexpr uint MAX_SUBREQUESTS = 64;
constexpr auto REQUEST_JS_LIMIT = std::chrono::milliseconds(250);
constexpr auto STARTUP_JS_LIMIT = std::chrono::seconds(5);
constexpr auto DEFAULT_IDLE_TIMEOUT = 180 * kj::SECONDS;

class JsWatchdogScope final {
 public:
  JsWatchdogScope(v8::Isolate& isolate,
      std::atomic<int64_t>& remainingNanos,
      std::atomic<bool>& exceeded)
      : isolate(isolate),
        remainingNanos(remainingNanos),
        exceeded(exceeded),
        started(std::chrono::steady_clock::now()),
        watchdog([this]() { run(); }) {}

  ~JsWatchdogScope() noexcept {
    {
      std::lock_guard lock(mutex);
      canceled = true;
    }
    wake.notify_one();
    watchdog.join();

    auto elapsed = std::chrono::steady_clock::now() - started;
    remainingNanos.fetch_sub(
        std::chrono::duration_cast<std::chrono::nanoseconds>(elapsed).count(),
        std::memory_order_relaxed);
  }

 private:
  void run() {
    auto budget = std::chrono::nanoseconds(
        kj::max<int64_t>(0, remainingNanos.load(std::memory_order_relaxed)));
    std::unique_lock lock(mutex);
    if (!wake.wait_for(lock, budget, [this]() { return canceled; })) {
      exceeded.store(true, std::memory_order_release);
      isolate.TerminateExecution();
    }
  }

  v8::Isolate& isolate;
  std::atomic<int64_t>& remainingNanos;
  std::atomic<bool>& exceeded;
  std::chrono::steady_clock::time_point started;
  std::mutex mutex;
  std::condition_variable wake;
  bool canceled = false;
  std::thread watchdog;
};

class SandstormIsolateLimitEnforcer final: public workerd::IsolateLimitEnforcer {
 public:
  v8::Isolate::CreateParams getCreateParams() override {
    v8::Isolate::CreateParams result;
    result.constraints.set_max_old_generation_size_in_bytes(ISOLATE_OLD_HEAP_LIMIT);
    result.constraints.set_max_young_generation_size_in_bytes(ISOLATE_YOUNG_HEAP_LIMIT);
    return result;
  }

  void customizeIsolate(v8::Isolate* isolate) override {
    isolateForHeapLimit = isolate;
    isolate->AddNearHeapLimitCallback(onNearHeapLimit, this);
  }

  workerd::ActorCacheSharedLruOptions getActorCacheLruOptions() override {
    return {.softLimit = 16 * (1ull << 20),
      .hardLimit = 128 * (1ull << 20),
      .staleTimeout = 30 * kj::SECONDS,
      .dirtyListByteLimit = 8 * (1ull << 20),
      .maxKeysPerRpc = 128,
      .neverFlush = true};
  }

  kj::Own<void> enterStartupJs(workerd::jsg::Lock& lock,
      kj::OneOf<kj::Exception, kj::Duration>& limitErrorOrTime) const override {
    return enterLimitedJs(lock, limitErrorOrTime, STARTUP_JS_LIMIT);
  }
  kj::Own<void> enterStartupPython(workerd::jsg::Lock& lock,
      kj::OneOf<kj::Exception, kj::Duration>& limitErrorOrTime) const override {
    return enterLimitedJs(lock, limitErrorOrTime, STARTUP_JS_LIMIT);
  }
  kj::Own<void> enterDynamicImportJs(workerd::jsg::Lock& lock,
      kj::OneOf<kj::Exception, kj::Duration>& limitErrorOrTime) const override {
    return enterLimitedJs(lock, limitErrorOrTime, STARTUP_JS_LIMIT);
  }
  kj::Own<void> enterLoggingJs(workerd::jsg::Lock&,
      kj::OneOf<kj::Exception, kj::Duration>&) const override {
    return {};
  }
  kj::Own<void> enterInspectorJs(workerd::jsg::Lock&,
      kj::OneOf<kj::Exception, kj::Duration>&) const override {
    return {};
  }
  void completedRequest(kj::StringPtr) const override {}
  bool exitJs(workerd::jsg::Lock&) const override {
    return heapLimitExceeded.load(std::memory_order_acquire);
  }
  void reportMetrics(workerd::IsolateObserver&) const override {}
  bool hasExcessivelyExceededHeapLimit() const override {
    return heapLimitExceeded.load(std::memory_order_acquire);
  }
  const workerd::TrackedWasmInstanceList& getTrackedWasmInstances() const override {
    return trackedWasmInstances;
  }
  size_t getBlobSizeLimit() const override { return BUFFERING_LIMIT; }

 private:
  static size_t onNearHeapLimit(void* data, size_t currentLimit, size_t) {
    auto& self = *static_cast<SandstormIsolateLimitEnforcer*>(data);
    self.heapLimitExceeded.store(true, std::memory_order_release);
    self.isolateForHeapLimit->TerminateExecution();
    // Give V8 enough headroom to unwind the terminated execution without turning this into a
    // process-fatal OOM. exitJs() then condemns this isolate.
    return currentLimit + 8 * 1024 * 1024;
  }

  class StartupScope final {
   public:
    StartupScope(v8::Isolate& isolate,
        kj::OneOf<kj::Exception, kj::Duration>& result,
        std::chrono::nanoseconds limit)
        : result(result),
          remainingNanos(limit.count()),
          watchdog(kj::heap<JsWatchdogScope>(isolate, remainingNanos, exceeded)) {}
    ~StartupScope() noexcept {
      watchdog = nullptr;
      if (exceeded.load(std::memory_order_acquire)) {
        result = 5 * kj::SECONDS;
      }
    }
   private:
    kj::OneOf<kj::Exception, kj::Duration>& result;
    std::atomic<int64_t> remainingNanos;
    std::atomic<bool> exceeded = false;
    kj::Own<JsWatchdogScope> watchdog;
  };

  static kj::Own<void> enterLimitedJs(workerd::jsg::Lock& lock,
      kj::OneOf<kj::Exception, kj::Duration>& result,
      std::chrono::nanoseconds limit) {
    return kj::heap<StartupScope>(*lock.v8Isolate, result, limit);
  }

  workerd::TrackedWasmInstanceList trackedWasmInstances;
  std::atomic<bool> heapLimitExceeded = false;
  v8::Isolate* isolateForHeapLimit = nullptr;
};

class SandstormRequestLimitEnforcer final: public workerd::LimitEnforcer {
 public:
  explicit SandstormRequestLimitEnforcer(kj::Timer& timer): timer(timer), remainingNanos(
      std::chrono::duration_cast<std::chrono::nanoseconds>(REQUEST_JS_LIMIT).count()) {}

  kj::Own<void> enterJs(workerd::jsg::Lock& lock, workerd::IoContext&) override {
    requireLimitsNotExceeded();
    return kj::heap<JsWatchdogScope>(*lock.v8Isolate, remainingNanos, exceeded);
  }
  void topUpActor() override {}
  void newSubrequest(bool) override {
    JSG_REQUIRE(++subrequests <= MAX_SUBREQUESTS, Error, "subrequest limit exceeded");
  }
  void newKvRequest(KvOpType) override { newSubrequest(false); }
  void newAnalyticsEngineRequest() override { newSubrequest(false); }
  kj::Promise<void> limitDrain() override { return timer.afterDelay(30 * kj::SECONDS); }
  kj::Promise<void> limitScheduled() override { return timer.afterDelay(15 * kj::MINUTES); }
  kj::Duration getAlarmLimit() override { return 15 * kj::MINUTES; }
  size_t getBufferingLimit() override { return BUFFERING_LIMIT; }
  kj::Maybe<workerd::EventOutcome> getLimitsExceeded() override {
    if (exceeded.load(std::memory_order_acquire)) return workerd::EventOutcome::EXCEEDED_CPU;
    return kj::none;
  }
  kj::Promise<void> onLimitsExceeded() override { return kj::NEVER_DONE; }
  void setCpuLimitNearlyExceededCallback(kj::Function<void(void)>) override {}
  void requireLimitsNotExceeded() override {
    JSG_REQUIRE(!exceeded.load(std::memory_order_acquire), Error, "CPU limit exceeded");
  }
  void reportMetrics(workerd::RequestObserver&) override {}
  kj::Duration consumeTimeElapsedForPeriodicLogging() override { return 0 * kj::SECONDS; }
  size_t getSqliteMemoryUsage() const override { return 0; }

 private:
  kj::Timer& timer;
  std::atomic<int64_t> remainingNanos;
  std::atomic<bool> exceeded = false;
  uint subrequests = 0;
};

class SandstormLimitEnforcerFactory final:
    public workerd::server::Server::LimitEnforcerFactory {
 public:
  explicit SandstormLimitEnforcerFactory(kj::Timer& timer): timer(timer) {}

  kj::Maybe<kj::Own<workerd::IsolateLimitEnforcer>> newIsolateLimitEnforcer(
      kj::StringPtr, bool isDynamic) override {
    if (!isDynamic) return kj::none;
    return kj::heap<SandstormIsolateLimitEnforcer>();
  }

  kj::Maybe<kj::Own<workerd::LimitEnforcer>> newRequestLimitEnforcer(
      kj::StringPtr, bool isDynamic) override {
    if (!isDynamic) return kj::none;
    return kj::heap<SandstormRequestLimitEnforcer>(timer);
  }

 private:
  kj::Timer& timer;
};

class SystemEntropySource final: public kj::EntropySource {
 public:
  void generate(kj::ArrayPtr<kj::byte> buffer) override {
    while (buffer.size() > 0) {
      ssize_t count;
      KJ_SYSCALL(count = getrandom(buffer.begin(), buffer.size(), 0));
      buffer = buffer.slice(count);
    }
  }
};

class BundleErrorReporter final: public workerd::Worker::ValidationErrorReporter {
 public:
  void addError(kj::String error) override { errors.add(kj::mv(error)); }
  void addEntrypoint(kj::Maybe<kj::StringPtr>, kj::Array<kj::String>) override {}
  void addActorClass(kj::StringPtr) override {}
  void addWorkflowClass(kj::StringPtr, kj::Array<kj::String>) override {}

  void requireValid() {
    KJ_REQUIRE(errors.empty(), "invalid worker compatibility settings",
        kj::strArray(errors, "; "));
  }

 private:
  kj::Vector<kj::String> errors;
};

struct DecodedModule {
  kj::String name;
  IsolateWorkerSource::Module::Which type;
  size_t contentSize;
  kj::Array<kj::byte> content;
};

struct DecodedBinding {
  kj::String name;
  IsolateWorkerSource::Binding::Which type;
  kj::String value;
};

struct DecodedWorkerBundle final: public kj::AtomicRefcounted {
  kj::String mainModule;
  kj::String compatibilityDate;
  kj::Array<kj::String> compatibilityFlags;
  kj::Array<DecodedModule> modules;
  kj::Array<DecodedBinding> bindings;
};

struct SelfServiceTarget final: public kj::AtomicRefcounted {
  workerd::WorkerStubChannel* worker = nullptr;
};

struct BundleBacking final: public kj::AtomicRefcounted {
  kj::Own<DecodedWorkerBundle> decoded;
  capnp::MallocMessageBuilder compatibility;
  kj::Array<kj::Own<SelfServiceTarget>> selfServices;
};

struct LoadedWorkerSource {
  workerd::DynamicWorkerSource source;
  kj::Own<BundleBacking> backing;
};

class SharedHttpService: public kj::HttpService, public kj::Refcounted {
 public:
  virtual ~SharedHttpService() noexcept(false) = default;
};


class HttpServiceWorkerInterface final: public workerd::WorkerInterface {
 public:
  explicit HttpServiceWorkerInterface(kj::Own<SharedHttpService> service)
      : service(kj::mv(service)) {}

  kj::Promise<void> request(kj::HttpMethod method, kj::StringPtr url,
      const kj::HttpHeaders& headers, kj::AsyncInputStream& requestBody,
      kj::HttpService::Response& response) override {
    return service->request(method, url, headers, requestBody, response);
  }
  kj::Promise<void> connect(kj::StringPtr host, const kj::HttpHeaders& headers,
      kj::AsyncIoStream& connection, ConnectResponse& response,
      kj::HttpConnectSettings settings) override {
    return service->connect(host, headers, connection, response, kj::mv(settings));
  }
  kj::Promise<void> prewarm(kj::StringPtr) override { return kj::READY_NOW; }
  kj::Promise<ScheduledResult> runScheduled(kj::Date, kj::StringPtr) override {
    KJ_FAIL_REQUIRE("Unix HTTP bindings do not support scheduled events");
  }
  kj::Promise<AlarmResult> runAlarm(kj::Date, uint32_t) override {
    KJ_FAIL_REQUIRE("Unix HTTP bindings do not support alarm events");
  }
  kj::Promise<CustomEvent::Result> customEvent(kj::Own<CustomEvent> event) override {
    return event->notSupported().attach(kj::mv(event));
  }

 private:
  kj::Own<SharedHttpService> service;
};

class HttpServiceChannel final: public workerd::IoChannelFactory::SubrequestChannel {
 public:
  explicit HttpServiceChannel(kj::Own<SharedHttpService> service)
      : service(kj::mv(service)) {}

  kj::Own<workerd::WorkerInterface> startRequest(
      workerd::IoChannelFactory::SubrequestMetadata) override {
    return kj::heap<HttpServiceWorkerInterface>(kj::addRef(*service));
  }

  void requireAllowsTransfer() override {
    KJ_FAIL_REQUIRE("Sandstorm in-process HTTP bindings cannot be transferred");
  }
  kj::OneOf<kj::Array<kj::byte>, kj::Promise<kj::Array<kj::byte>>> getTokenMaybeSync(
      workerd::IoChannelFactory::ChannelTokenUsage) override {
    KJ_FAIL_REQUIRE("Sandstorm in-process HTTP bindings cannot be tokenized");
  }

 private:
  kj::Own<SharedHttpService> service;
};

class WorkerIngressService final: public kj::HttpService {
 public:
  explicit WorkerIngressService(
      kj::Own<SelfServiceTarget> target)
      : target(kj::mv(target)) {}

  kj::Promise<void> request(kj::HttpMethod method, kj::StringPtr url,
      const kj::HttpHeaders& headers, kj::AsyncInputStream& requestBody,
      kj::HttpService::Response& response) override {
    KJ_CONTEXT("dispatching hosted worker HTTP request", url);
    auto& worker = KJ_REQUIRE_NONNULL(target->worker,
        "hosted worker ingress used after grain eviction");
    auto ingress = worker.getEntrypoint(kj::none, workerd::Frankenvalue(), kj::none);
    auto normalizedUrl = url.startsWith("/")
        ? kj::str("http://sandstorm", url)
        : kj::str(url);
    auto request = ingress->startRequest({});
    return request->request(method, normalizedUrl, headers, requestBody, response)
        .attach(kj::mv(request), kj::mv(ingress), kj::mv(normalizedUrl));
  }

  kj::Promise<void> connect(kj::StringPtr host, const kj::HttpHeaders& headers,
      kj::AsyncIoStream& connection, ConnectResponse& response,
      kj::HttpConnectSettings settings) override {
    auto& worker = KJ_REQUIRE_NONNULL(target->worker,
        "hosted worker ingress used after grain eviction");
    auto ingress = worker.getEntrypoint(kj::none, workerd::Frankenvalue(), kj::none);
    auto request = ingress->startRequest({});
    return request->connect(host, headers, connection, response, kj::mv(settings))
        .attach(kj::mv(request), kj::mv(ingress));
  }

 private:
  kj::Own<SelfServiceTarget> target;
};

class SelfBindingHttpService final: public SharedHttpService {
 public:
  explicit SelfBindingHttpService(kj::Own<SelfServiceTarget> target)
      : target(kj::mv(target)) {}
  ~SelfBindingHttpService() noexcept override = default;

  kj::Promise<void> request(kj::HttpMethod method, kj::StringPtr url,
      const kj::HttpHeaders& headers, kj::AsyncInputStream& requestBody,
      kj::HttpService::Response& response) override {
    auto& worker = KJ_REQUIRE_NONNULL(target->worker,
        "worker-local service binding used after grain shutdown");
    auto ingress = worker.getEntrypoint(kj::none, workerd::Frankenvalue(), kj::none);
    auto request = ingress->startRequest({});
    return request->request(method, url, headers, requestBody, response)
        .attach(kj::mv(request), kj::mv(ingress));
  }

 private:
  kj::Own<SelfServiceTarget> target;
};

class CompletedLegacyHttpRequest final: public capnp::HttpService::ServerRequestContext::Server {};

static constexpr kj::StringPtr LEGACY_COMMON_HEADER_NAMES[] = {
  ""_kj,
  "Accept-Charset"_kj, "Accept-Encoding"_kj, "Accept-Language"_kj,
  "Accept-Ranges"_kj, "Accept"_kj, "Access-Control-Allow-Origin"_kj,
  "Age"_kj, "Allow"_kj, "Authorization"_kj, "Cache-Control"_kj,
  "Content-Disposition"_kj, "Content-Encoding"_kj, "Content-Language"_kj,
  "Content-Length"_kj, "Content-Location"_kj, "Content-Range"_kj,
  "Content-Type"_kj, "Cookie"_kj, "Date"_kj, "ETag"_kj, "Expect"_kj,
  "Expires"_kj, "From"_kj, "Host"_kj, "If-Match"_kj,
  "If-Modified-Since"_kj, "If-None-Match"_kj, "If-Range"_kj,
  "If-Unmodified-Since"_kj, "Last-Modified"_kj, "Link"_kj, "Location"_kj,
  "Max-Forwards"_kj, "Proxy-Authenticate"_kj, "Proxy-Authorization"_kj,
  "Range"_kj, "Referer"_kj, "Refresh"_kj, "Retry-After"_kj, "Server"_kj,
  "Set-Cookie"_kj, "Strict-Transport-Security"_kj, "Transfer-Encoding"_kj,
  "User-Agent"_kj, "Vary"_kj, "Via"_kj, "WWW-Authenticate"_kj,
};

kj::HttpHeaders decodeLegacyHeaders(kj::HttpHeaderTable& table,
    capnp::List<capnp::HttpHeader>::Reader input) {
  kj::HttpHeaders result(table);
  for (auto header: input) {
    switch (header.which()) {
      case capnp::HttpHeader::UNCOMMON: {
        auto uncommon = header.getUncommon();
        result.add(kj::str(uncommon.getName()), kj::str(uncommon.getValue()));
        break;
      }
      case capnp::HttpHeader::COMMON: {
        auto common = header.getCommon();
        auto nameIndex = static_cast<uint>(common.getName());
        KJ_REQUIRE(nameIndex > 0 && nameIndex < kj::size(LEGACY_COMMON_HEADER_NAMES),
            "invalid legacy common HTTP header name", nameIndex);
        kj::String value;
        switch (common.which()) {
          case capnp::HttpHeader::Common::VALUE:
            value = kj::str(common.getValue());
            break;
          case capnp::HttpHeader::Common::COMMON_VALUE:
            KJ_REQUIRE(common.getCommonValue() == capnp::CommonHeaderValue::GZIP_DEFLATE,
                "invalid legacy common HTTP header value");
            value = kj::str("gzip, deflate");
            break;
        }
        result.add(kj::str(LEGACY_COMMON_HEADER_NAMES[nameIndex]), kj::mv(value));
        break;
      }
    }
  }
  return result;
}

void encodeLegacyHeaders(const kj::HttpHeaders& input,
    capnp::List<capnp::HttpHeader>::Builder output) {
  size_t index = 0;
  input.forEach([&](kj::StringPtr name, kj::StringPtr value) {
    auto uncommon = output[index++].initUncommon();
    uncommon.setName(name);
    uncommon.setValue(value);
  });
}

class LegacyClientRequestContext final:
    public capnp::HttpService::ClientRequestContext::Server {
 public:
  LegacyClientRequestContext(capnp::ByteStreamFactory& streamFactory,
      kj::HttpHeaderTable& headerTable,
      kj::HttpService::Response& response,
      kj::Own<kj::PromiseFulfiller<kj::Promise<void>>> responseFulfiller)
      : streamFactory(streamFactory), headerTable(headerTable), response(response),
        responseFulfiller(kj::mv(responseFulfiller)) {}

  kj::Promise<void> startResponse(StartResponseContext context) override {
    KJ_REQUIRE(responseFulfiller.get() != nullptr, "legacy HTTP response already started");
    auto input = context.getParams().getResponse();
    auto bodySize = input.getBodySize();
    kj::Maybe<uint64_t> expectedSize;
    bool hasBody = true;
    if (bodySize.isFixed()) {
      expectedSize = bodySize.getFixed();
      hasBody = bodySize.getFixed() > 0;
    }
    auto output = response.send(input.getStatusCode(), input.getStatusText(),
        decodeLegacyHeaders(headerTable, input.getHeaders()), expectedSize);
    if (hasBody) {
      auto pipe = kj::newOneWayPipe(expectedSize);
      context.getResults().setBody(streamFactory.kjToCapnp(kj::mv(pipe.out)));
      responseFulfiller->fulfill(pipe.in->pumpTo(*output).ignoreResult()
          .attach(kj::mv(pipe.in), kj::mv(output)));
    } else {
      responseFulfiller->fulfill(kj::READY_NOW);
    }
    responseFulfiller = nullptr;
    return kj::READY_NOW;
  }

  kj::Promise<void> startWebSocket(StartWebSocketContext) override {
    KJ_FAIL_REQUIRE("legacy shared-host bindings do not yet support WebSockets");
  }

 private:
  capnp::ByteStreamFactory& streamFactory;
  kj::HttpHeaderTable& headerTable;
  kj::HttpService::Response& response;
  kj::Own<kj::PromiseFulfiller<kj::Promise<void>>> responseFulfiller;
};

class LegacyCapnpHttpService final: public SharedHttpService {
 public:
  LegacyCapnpHttpService(capnp::ByteStreamFactory& streamFactory,
      kj::HttpHeaderTable& headerTable,
      capnp::HttpService::Client service)
      : streamFactory(streamFactory), headerTable(headerTable), service(kj::mv(service)) {}

  kj::Promise<void> request(kj::HttpMethod method, kj::StringPtr url,
      const kj::HttpHeaders& headers, kj::AsyncInputStream& requestBody,
      kj::HttpService::Response& response) override {
    auto request = service.startRequestRequest();
    auto metadata = request.initRequest();
    metadata.setMethod(static_cast<capnp::HttpMethod>(method));
    size_t pathStart = 0;
    if (url.startsWith("http://"_kj)) pathStart = 7;
    if (url.startsWith("https://"_kj)) pathStart = 8;
    if (pathStart > 0) {
      KJ_IF_SOME(slash, url.slice(pathStart).findFirst('/')) {
        pathStart += slash;
      } else {
        pathStart = url.size();
      }
    }
    metadata.setUrl(pathStart < url.size() ? url.slice(pathStart) : "/"_kj);
    encodeLegacyHeaders(headers, metadata.initHeaders(headers.size()));

    bool hasBody = true;
    kj::Maybe<uint64_t> expectedSize;
    KJ_IF_SOME(size, requestBody.tryGetLength()) {
      expectedSize = size;
      metadata.getBodySize().setFixed(size);
      hasBody = size > 0;
    } else if ((method == kj::HttpMethod::GET || method == kj::HttpMethod::HEAD) &&
        headers.get(kj::HttpHeaderId::TRANSFER_ENCODING) == kj::none) {
      metadata.getBodySize().setFixed(0);
      hasBody = false;
    } else {
      metadata.getBodySize().setUnknown();
    }

    auto responsePair = kj::newPromiseAndFulfiller<kj::Promise<void>>();
    request.setContext(kj::heap<LegacyClientRequestContext>(streamFactory, headerTable,
        response, kj::mv(responsePair.fulfiller)));
    auto pipeline = request.send();
    kj::Promise<void> requestBodyTask = kj::READY_NOW;
    if (hasBody) {
      auto output = streamFactory.capnpToKj(pipeline.getRequestBody());
      requestBodyTask = requestBody.pumpTo(*output).ignoreResult().attach(kj::mv(output));
    }
    auto tasks = kj::heapArrayBuilder<kj::Promise<void>>(3);
    tasks.add(pipeline.getContext().whenResolved());
    tasks.add(kj::mv(responsePair.promise));
    tasks.add(kj::mv(requestBodyTask));
    return kj::joinPromisesFailFast(tasks.finish());
  }

 private:
  capnp::ByteStreamFactory& streamFactory;
  kj::HttpHeaderTable& headerTable;
  capnp::HttpService::Client service;
};

class LegacyHttpRequestContext final:
    public capnp::HttpService::ServerRequestContext::Server,
    public kj::HttpService::Response {
 public:
  LegacyHttpRequestContext(capnp::ByteStreamFactory& streamFactory,
      capnp::HttpRequest::Reader request,
      capnp::HttpService::ClientRequestContext::Client clientContext,
      kj::Own<kj::AsyncInputStream> requestBody,
      kj::HttpHeaderTable& headerTable,
      kj::HttpService& service)
      : streamFactory(streamFactory),
        method(static_cast<kj::HttpMethod>(request.getMethod())), url(kj::str(request.getUrl())),
        headers(decodeLegacyHeaders(headerTable, request.getHeaders())),
        clientContext(kj::mv(clientContext)),
        task(service.request(method, url, headers, *requestBody, *this)
            .attach(kj::mv(requestBody))
            .eagerlyEvaluate([](kj::Exception&& error) { throw kj::mv(error); })) {}

  kj::Maybe<kj::Promise<capnp::Capability::Client>> shortenPath() override {
    return task.then([]() -> capnp::Capability::Client {
      return kj::heap<CompletedLegacyHttpRequest>();
    });
  }

  kj::Own<kj::AsyncOutputStream> send(uint statusCode, kj::StringPtr statusText,
      const kj::HttpHeaders& headers,
      kj::Maybe<uint64_t> expectedBodySize = kj::none) override {
    KJ_REQUIRE(replyTask == kj::none, "HTTP response already started");
    auto request = clientContext.startResponseRequest();
    auto response = request.initResponse();
    response.setStatusCode(statusCode);
    response.setStatusText(statusText);
    auto outputHeaders = response.initHeaders(headers.size());
    size_t headerIndex = 0;
    headers.forEach([&](kj::StringPtr name, kj::StringPtr value) {
      auto uncommon = outputHeaders[headerIndex++].initUncommon();
      uncommon.setName(name);
      uncommon.setValue(value);
    });
    bool hasBody = true;
    KJ_IF_SOME(size, expectedBodySize) {
      response.getBodySize().setFixed(size);
      hasBody = size > 0;
    }
    if (!hasBody) {
      replyTask = request.send().ignoreResult();
      return workerd::newNullOutputStream();
    }
    auto pipeline = request.send();
    auto output = streamFactory.capnpToKj(pipeline.getBody());
    replyTask = pipeline.ignoreResult();
    return output;
  }

  kj::Own<kj::WebSocket> acceptWebSocket(const kj::HttpHeaders&) override {
    KJ_FAIL_REQUIRE("legacy shared-host ingress does not yet support WebSockets");
  }

 private:
  capnp::ByteStreamFactory& streamFactory;
  kj::HttpMethod method;
  kj::String url;
  kj::HttpHeaders headers;
  capnp::HttpService::ClientRequestContext::Client clientContext;
  kj::Maybe<kj::Promise<void>> replyTask;
  kj::Promise<void> task;
};

class LegacyHttpServiceAdapter final: public capnp::HttpService::Server {
 public:
  LegacyHttpServiceAdapter(
      capnp::ByteStreamFactory& streamFactory,
      kj::HttpHeaderTable& headerTable,
      kj::Own<kj::HttpService> service)
      : streamFactory(streamFactory), headerTable(headerTable), service(kj::mv(service)) {}

  kj::Promise<void> startRequest(StartRequestContext context) override {
    KJ_CONTEXT("adapting Cap'n Proto 1.x HTTP ingress");
    auto params = context.getParams();
    auto request = params.getRequest();
    auto bodySize = request.getBodySize();
    kj::Maybe<uint64_t> expectedSize;
    bool hasBody = true;
    if (bodySize.isFixed()) {
      expectedSize = bodySize.getFixed();
      hasBody = bodySize.getFixed() > 0;
    }
    auto results = context.getResults();
    kj::Own<kj::AsyncInputStream> input;
    if (hasBody) {
      auto pipe = kj::newOneWayPipe(expectedSize);
      results.setRequestBody(streamFactory.kjToCapnp(kj::mv(pipe.out)));
      input = kj::mv(pipe.in);
    } else {
      input = workerd::newNullInputStream();
    }
    results.setContext(kj::heap<LegacyHttpRequestContext>(streamFactory,
        request, params.getContext(), kj::mv(input), headerTable, *service));
    return kj::READY_NOW;
  }

 private:
  capnp::ByteStreamFactory& streamFactory;
  kj::HttpHeaderTable& headerTable;
  kj::Own<kj::HttpService> service;
};

kj::Own<DecodedWorkerBundle> decodeWorkerBundle(kj::ArrayPtr<const kj::byte> workerSource) {
  static constexpr uint64_t MAX_TRAVERSAL_WORDS = 4 * 1024 * 1024;
  static constexpr size_t MAX_MODULES = 1024;
  static constexpr size_t MAX_MODULE_BYTES = 8 * 1024 * 1024;
  static constexpr size_t MAX_TOTAL_MODULE_BYTES = 16 * 1024 * 1024;
  static constexpr size_t MAX_BINDINGS = 1024;
  static constexpr size_t MAX_TOTAL_BINDING_BYTES = 4 * 1024 * 1024;
  static constexpr size_t MAX_NAME_BYTES = 256;

  KJ_REQUIRE(workerSource.size() > 0 && workerSource.size() <= MAX_WORKER_SOURCE_BYTES,
      "worker source bundle exceeds size limit", workerSource.size(), MAX_WORKER_SOURCE_BYTES);

  capnp::ReaderOptions readerOptions;
  readerOptions.traversalLimitInWords = MAX_TRAVERSAL_WORDS;
  readerOptions.nestingLimit = 32;
  kj::ArrayInputStream input(workerSource);
  capnp::PackedMessageReader reader(input, readerOptions);
  auto bundle = reader.getRoot<IsolateWorkerSource>();
  KJ_REQUIRE(bundle.getFormatVersion() == 1,
      "unsupported worker source format version", bundle.getFormatVersion());
  KJ_REQUIRE(bundle.getMainModule().size() > 0 &&
          bundle.getMainModule().size() <= MAX_NAME_BYTES,
      "invalid worker main module name length", bundle.getMainModule().size());
  KJ_REQUIRE(bundle.getCompatibilityDate().size() <= 32,
      "worker compatibility date exceeds size limit");
  KJ_REQUIRE(bundle.getCompatibilityFlags().size() <= 64,
      "worker compatibility flag count exceeds limit");
  for (auto flag: bundle.getCompatibilityFlags()) {
    KJ_REQUIRE(flag.size() <= 128, "worker compatibility flag exceeds size limit");
  }
  auto inputModules = bundle.getModules();
  KJ_REQUIRE(inputModules.size() > 0 && inputModules.size() <= MAX_MODULES,
      "invalid worker module count", inputModules.size(), MAX_MODULES);
  auto result = kj::atomicRefcounted<DecodedWorkerBundle>();
  result->mainModule = kj::str(bundle.getMainModule());
  result->compatibilityDate = kj::str(bundle.getCompatibilityDate());
  result->compatibilityFlags = KJ_MAP(flag, bundle.getCompatibilityFlags()) {
    return kj::str(flag);
  };

  kj::HashSet<kj::String> moduleNames;
  bool foundMainModule = false;
  size_t totalModuleBytes = 0;
  auto modules = kj::heapArrayBuilder<DecodedModule>(inputModules.size());
  for (auto input: inputModules) {
    KJ_REQUIRE(input.getName().size() > 0 && input.getName().size() <= MAX_NAME_BYTES,
        "invalid worker module name length", input.getName().size());
    KJ_REQUIRE(moduleNames.find(input.getName()) == kj::none,
        "worker bundle has a duplicate module name", input.getName());
    moduleNames.insert(kj::str(input.getName()));
    if (input.getName() == bundle.getMainModule()) foundMainModule = true;
    capnp::Data::Reader content;
    switch (input.which()) {
      case IsolateWorkerSource::Module::ES_MODULE:
        content = input.getEsModule();
        break;
      case IsolateWorkerSource::Module::COMMON_JS_MODULE:
        content = input.getCommonJsModule();
        break;
      case IsolateWorkerSource::Module::TEXT:
        content = input.getText();
        break;
      case IsolateWorkerSource::Module::DATA:
        content = input.getData();
        break;
      case IsolateWorkerSource::Module::WASM:
        content = input.getWasm();
        break;
      case IsolateWorkerSource::Module::JSON:
        content = input.getJson();
        break;
    }
    size_t moduleBytes = content.size();
    KJ_REQUIRE(moduleBytes <= MAX_MODULE_BYTES,
        "worker module exceeds size limit", input.getName(), moduleBytes, MAX_MODULE_BYTES);
    totalModuleBytes += moduleBytes;
    KJ_REQUIRE(totalModuleBytes <= MAX_TOTAL_MODULE_BYTES,
        "worker modules exceed aggregate size limit", totalModuleBytes, MAX_TOTAL_MODULE_BYTES);
    auto ownedContent = kj::heapArray<kj::byte>(content.size() + 1);
    ownedContent.slice(0, content.size()).copyFrom(content);
    ownedContent[content.size()] = 0;
    modules.add(DecodedModule{
      .name = kj::str(input.getName()),
      .type = input.which(),
      .contentSize = content.size(),
      .content = kj::mv(ownedContent),
    });
  }
  KJ_REQUIRE(foundMainModule, "worker bundle main module is not present", bundle.getMainModule());

  kj::HashSet<kj::String> bindingNames;
  auto inputBindings = bundle.getBindings();
  KJ_REQUIRE(inputBindings.size() <= MAX_BINDINGS,
      "worker binding count exceeds limit", inputBindings.size(), MAX_BINDINGS);
  size_t totalBindingBytes = 0;
  auto accountBindingBytes = [&](size_t bytes) {
    totalBindingBytes += bytes;
    KJ_REQUIRE(totalBindingBytes <= MAX_TOTAL_BINDING_BYTES,
        "worker bindings exceed aggregate size limit",
        totalBindingBytes, MAX_TOTAL_BINDING_BYTES);
  };
  capnp::JsonCodec json;
  auto bindings = kj::heapArrayBuilder<DecodedBinding>(inputBindings.size());
  for (auto binding: inputBindings) {
    KJ_REQUIRE(binding.getName().size() > 0 && binding.getName().size() <= MAX_NAME_BYTES,
        "invalid worker binding name length", binding.getName().size());
    KJ_REQUIRE(bindingNames.find(binding.getName()) == kj::none,
        "worker bundle has a duplicate binding name", binding.getName());
    bindingNames.insert(kj::str(binding.getName()));
    capnp::Data::Reader value;
    switch (binding.which()) {
      case IsolateWorkerSource::Binding::TEXT: {
        value = binding.getText();
        accountBindingBytes(value.size());
        break;
      }
      case IsolateWorkerSource::Binding::JSON: {
        value = binding.getJson();
        accountBindingBytes(value.size());
        capnp::MallocMessageBuilder jsonMessage;
        json.decode(value.asChars(), jsonMessage.initRoot<capnp::json::Value>());
        break;
      }
      case IsolateWorkerSource::Binding::DATA:
        KJ_FAIL_REQUIRE("shared host does not yet support data bindings", binding.getName());
      case IsolateWorkerSource::Binding::SANDSTORM_API:
      case IsolateWorkerSource::Binding::STORAGE:
      case IsolateWorkerSource::Binding::POWERBOX:
        break;
      case IsolateWorkerSource::Binding::SERVICE:
        KJ_REQUIRE(binding.getService() == "main",
            "shared host only supports worker-local service bindings",
            binding.getName(), binding.getService());
        value = binding.getService().asBytes();
        accountBindingBytes(value.size());
        break;
    }
    bindings.add(DecodedBinding{
      .name = kj::str(binding.getName()),
      .type = binding.which(),
      .value = kj::heapString(value.asChars()),
    });
  }
  result->modules = modules.finish();
  result->bindings = bindings.finish();
  return result;
}

LoadedWorkerSource buildWorkerSource(IsolateBindingServices::Client services,
    capnp::ByteStreamFactory& streamFactory,
    kj::HttpHeaderTable& headerTable,
    kj::Own<DecodedWorkerBundle> decoded) {
  auto backing = kj::atomicRefcounted<BundleBacking>();
  backing->decoded = kj::mv(decoded);
  auto& bundle = *backing->decoded;

  size_t moduleCount = bundle.modules.size();
  for (auto& input: bundle.modules) {
    if (input.name.startsWith("capnp:/sandstorm/")) ++moduleCount;
  }
  auto modules = kj::heapArrayBuilder<workerd::WorkerSource::Module>(moduleCount);
  for (auto& input: bundle.modules) {
    auto appendModule = [&](kj::StringPtr name) {
      workerd::WorkerSource::Module output{.name = name};
      kj::StringPtr chars(
          reinterpret_cast<const char*>(input.content.begin()), input.contentSize);
      switch (input.type) {
        case IsolateWorkerSource::Module::ES_MODULE:
          output.content = workerd::WorkerSource::EsModule{chars, kj::none};
          break;
        case IsolateWorkerSource::Module::COMMON_JS_MODULE:
          output.content = workerd::WorkerSource::CommonJsModule{chars, kj::none};
          break;
        case IsolateWorkerSource::Module::TEXT:
          output.content = workerd::WorkerSource::TextModule{chars};
          break;
        case IsolateWorkerSource::Module::DATA:
          output.content = workerd::WorkerSource::DataModule{
            input.content.slice(0, input.contentSize)};
          break;
        case IsolateWorkerSource::Module::WASM:
          output.content = workerd::WorkerSource::WasmModule{
            input.content.slice(0, input.contentSize)};
          break;
        case IsolateWorkerSource::Module::JSON:
          output.content = workerd::WorkerSource::JsonModule{chars};
          break;
      }
      modules.add(kj::mv(output));
    };
    appendModule(input.name);
    if (input.name.startsWith("capnp:/sandstorm/")) {
      appendModule(input.name.slice(strlen("capnp:/")));
    }
  }

  workerd::Frankenvalue env;
  capnp::JsonCodec json;
  kj::Vector<kj::Own<SelfServiceTarget>> selfServices;
  for (auto& binding: bundle.bindings) {
    switch (binding.type) {
      case IsolateWorkerSource::Binding::TEXT: {
        capnp::MallocMessageBuilder jsonMessage;
        auto jsonValue = jsonMessage.initRoot<capnp::json::Value>();
        jsonValue.setString(binding.value);
        env.setProperty(kj::str(binding.name),
            workerd::Frankenvalue::fromJson(json.encode(jsonValue.asReader())));
        break;
      }
      case IsolateWorkerSource::Binding::JSON:
        env.setProperty(kj::str(binding.name),
            workerd::Frankenvalue::fromJson(kj::str(binding.value)));
        break;
      case IsolateWorkerSource::Binding::SANDSTORM_API:
      case IsolateWorkerSource::Binding::STORAGE:
      case IsolateWorkerSource::Binding::POWERBOX: {
        auto request = services.getServiceRequest();
        switch (binding.type) {
          case IsolateWorkerSource::Binding::SANDSTORM_API:
            request.setBinding(IsolateBindingServices::Binding::SANDSTORM_API);
            break;
          case IsolateWorkerSource::Binding::STORAGE:
            request.setBinding(IsolateBindingServices::Binding::STORAGE);
            break;
          case IsolateWorkerSource::Binding::POWERBOX:
            request.setBinding(IsolateBindingServices::Binding::POWERBOX);
            break;
          default:
            KJ_UNREACHABLE;
        }
        env.setProperty(kj::str(binding.name),
            workerd::Frankenvalue::fromDirectCapability(
                kj::refcounted<HttpServiceChannel>(
                    kj::refcounted<LegacyCapnpHttpService>(streamFactory, headerTable,
                        request.send().getService()))));
        break;
      }
      case IsolateWorkerSource::Binding::SERVICE: {
        auto target = kj::atomicRefcounted<SelfServiceTarget>();
        env.setProperty(kj::str(binding.name),
            workerd::Frankenvalue::fromDirectCapability(
                kj::refcounted<HttpServiceChannel>(
                    kj::refcounted<SelfBindingHttpService>(kj::atomicAddRef(*target)))));
        selfServices.add(kj::mv(target));
        break;
      }
      case IsolateWorkerSource::Binding::DATA:
        KJ_UNREACHABLE;
    }
  }
  auto compatibility = backing->compatibility.initRoot<workerd::CompatibilityFlags>();
  auto flags = KJ_MAP(flag, bundle.compatibilityFlags) { return kj::str(flag); };
  BundleErrorReporter reporter;
  workerd::compileCompatibilityFlags(bundle.compatibilityDate, flags, compatibility,
      reporter, true, workerd::CompatibilityDateValidation::CODE_VERSION);
  reporter.requireValid();
  backing->selfServices = selfServices.releaseAsArray();

  workerd::WorkerSource source(workerd::WorkerSource::ModulesSource{
    .mainModule = bundle.mainModule,
    .modules = modules.finish(),
    .capnpSchemas = {},
    .isPython = false,
    .pythonMemorySnapshot = kj::none,
  });
  workerd::DynamicWorkerSource sourceResult{
    .source = kj::mv(source),
    .compatibilityFlags = compatibility.asReader(),
    .limits = kj::none,
    .env = kj::mv(env),
    .globalOutbound = kj::none,
    .tails = {},
    .streamingTails = {},
    .ownContent = kj::atomicAddRef(*backing),
    .ownContentIsRpcResponse = false,
  };
  return {kj::mv(sourceResult), kj::mv(backing)};
}

class AdmissionWorker {
 public:
  AdmissionWorker(): thread([this]() noexcept { run(); }) {
    auto lock = shared.lockExclusive();
    lock.wait([](const Shared& state) { return state.executor != kj::none; });
  }

  ~AdmissionWorker() noexcept(false) {
    auto executor = getExecutor();
    executor->executeSync([this]() {
      auto lock = shared.lockExclusive();
      KJ_ASSERT(lock->shutdownFulfiller != nullptr);
      lock->shutdownFulfiller->fulfill();
      lock->shutdownFulfiller = nullptr;
    });
  }

  kj::Promise<kj::Own<DecodedWorkerBundle>> admit(kj::Array<kj::byte> workerSource) {
    auto executor = getExecutor();
    return executor->executeAsync(
        [workerSource = kj::mv(workerSource)]() mutable {
      auto& clock = kj::systemPreciseMonotonicClock();
      auto started = clock.now();
      auto result = decodeWorkerBundle(workerSource);
      KJ_REQUIRE(clock.now() - started <= 5 * kj::SECONDS,
          "worker admission exceeded its five-second deadline");
      return result;
    });
  }

 private:
  struct Shared {
    kj::Maybe<kj::Own<const kj::Executor>> executor;
    kj::PromiseFulfiller<void>* shutdownFulfiller = nullptr;
  };

  kj::MutexGuarded<Shared> shared;
  kj::Thread thread;

  kj::Own<const kj::Executor> getExecutor() {
    auto lock = shared.lockExclusive();
    return KJ_ASSERT_NONNULL(lock->executor)->addRef();
  }

  void run() noexcept {
    kj::EventLoop eventLoop;
    kj::WaitScope waitScope(eventLoop);
    auto shutdown = kj::newPromiseAndFulfiller<void>();
    {
      auto lock = shared.lockExclusive();
      lock->executor = kj::getCurrentThreadExecutor().addRef();
      lock->shutdownFulfiller = shutdown.fulfiller.get();
    }
    shutdown.promise.wait(waitScope);
    auto lock = shared.lockExclusive();
    lock->executor = kj::none;
  }
};

class AdmissionPool {
 public:
  AdmissionPool() {
    workers.add(kj::heap<AdmissionWorker>());
    workers.add(kj::heap<AdmissionWorker>());
  }

  kj::Promise<kj::Own<DecodedWorkerBundle>> admit(kj::Array<kj::byte> workerSource) {
    KJ_REQUIRE(outstanding < MAX_OUTSTANDING,
        "worker admission queue is full", outstanding, MAX_OUTSTANDING);
    ++outstanding;
    auto& worker = *workers[nextWorker++ % workers.size()];
    return worker.admit(kj::mv(workerSource))
        .attach(kj::defer([this]() { --outstanding; }));
  }

 private:
  static constexpr size_t MAX_OUTSTANDING = 16;
  kj::Vector<kj::Own<AdmissionWorker>> workers;
  size_t nextWorker = 0;
  size_t outstanding = 0;
};

void initRuntimeConfig(capnp::MallocMessageBuilder& message, kj::StringPtr bootstrapAddress) {
  auto config = message.initRoot<workerd::server::config::Config>();
  auto service = config.initServices(1)[0];
  service.setName("sandstorm-loader-bootstrap");
  auto worker = service.initWorker();
  worker.setCompatibilityDate("2026-06-10");
  auto module = worker.initModules(1)[0];
  module.setName("bootstrap.js");
  module.setEsModule("export default { fetch() { return new Response('not exposed'); } };");
  auto binding = worker.initBindings(1)[0];
  binding.setName("GRAIN_LOADER");
  binding.initWorkerLoader().setId(LOADER_NAMESPACE);

  // Server::run() lives for the lifetime of its listeners. Keep one private Unix listener so the
  // embedded runtime remains active; Sandstorm traffic never enters through this socket.
  auto socket = config.initSockets(1)[0];
  socket.setName("loader-bootstrap");
  socket.setAddress(bootstrapAddress);
  socket.initHttp();
  socket.getService().setName("sandstorm-loader-bootstrap");
}

bool isValidGrainId(kj::StringPtr id) {
  return id.size() >= 8 && !id.startsWith(".") && id.findFirst('/') == kj::none;
}

struct HostedState final: public kj::Refcounted {
  HostedState(workerd::server::Server& runtime,
      kj::String grainId,
      IsolateBindingServices::Client bindingServices,
      kj::Own<BundleBacking> backing,
      kj::Own<workerd::WorkerStubChannel> worker,
      kj::Own<SelfServiceTarget> ingressTarget)
      : runtime(runtime), grainId(kj::mv(grainId)),
        bindingServices(kj::mv(bindingServices)), backing(kj::mv(backing)),
        worker(kj::mv(worker)), ingressTarget(kj::mv(ingressTarget)) {}

  ~HostedState() noexcept {
    revokeSelfServices();
  }

  void revokeSelfServices() {
    if (backing.get() != nullptr) {
      for (auto& target: backing->selfServices) target->worker = nullptr;
    }
  }

  void stop() {
    if (!running) return;
    runtime.evictDynamicWorker(LOADER_NAMESPACE, grainId);
    ingressTarget->worker = nullptr;
    revokeSelfServices();
    bindingServices = IsolateBindingServices::Client(nullptr);
    worker = nullptr;
    backing = nullptr;
    running = false;
  }

  workerd::server::Server& runtime;
  kj::String grainId;
  IsolateBindingServices::Client bindingServices;
  kj::Own<BundleBacking> backing;
  kj::Own<workerd::WorkerStubChannel> worker;
  kj::Own<SelfServiceTarget> ingressTarget;
  uint64_t keepAliveGeneration = 0;
  bool running = true;
};

class HostedIsolateImpl final: public HostedIsolate::Server {
 public:
  HostedIsolateImpl(kj::Rc<HostedState> state, capnp::ByteStreamFactory& streamFactory,
      kj::Function<void(kj::Rc<HostedState>)> refreshIdleTimer)
      : state(kj::mv(state)), streamFactory(streamFactory),
        refreshIdleTimer(kj::mv(refreshIdleTimer)) {}

  kj::Promise<void> keepAlive(KeepAliveContext context) override {
    KJ_REQUIRE(state->running, "hosted isolate has been stopped");
    refreshIdleTimer(state.addRef());
    return kj::READY_NOW;
  }

  kj::Promise<void> stop(StopContext context) override {
    state->stop();
    return kj::READY_NOW;
  }

  kj::Promise<void> getHttpService(GetHttpServiceContext context) override {
    KJ_REQUIRE(state->running, "hosted isolate has been stopped");
    context.getResults().setService(kj::heap<LegacyHttpServiceAdapter>(streamFactory,
        state->runtime.getHttpHeaderTableForEmbedding(),
        kj::heap<WorkerIngressService>(kj::atomicAddRef(*state->ingressTarget))));
    return kj::READY_NOW;
  }

 private:
  kj::Rc<HostedState> state;
  capnp::ByteStreamFactory& streamFactory;
  kj::Function<void(kj::Rc<HostedState>)> refreshIdleTimer;
};

class IsolateHostImpl final: public IsolateHost::Server, private kj::TaskSet::ErrorHandler {
 public:
  IsolateHostImpl(workerd::server::Server& runtime,
      capnp::ByteStreamFactory& streamFactory,
      kj::Timer& timer,
      kj::Duration idleTimeout)
      : runtime(runtime), streamFactory(streamFactory), timer(timer),
        idleTimeout(idleTimeout), tasks(*this) {}

  kj::Promise<void> startGrain(StartGrainContext context) override {
    auto grainId = context.getParams().getGrainId();
    KJ_REQUIRE(isValidGrainId(grainId), "invalid grain ID");
    KJ_REQUIRE(context.getParams().hasServices(), "missing per-grain binding services");
    auto sourceData = context.getParams().getWorkerSource();
    KJ_REQUIRE(sourceData.size() > 0 && sourceData.size() <= MAX_WORKER_SOURCE_BYTES,
        "worker source bundle exceeds size limit", sourceData.size(), MAX_WORKER_SOURCE_BYTES);

    KJ_IF_SOME(existing, grains.find(grainId)) {
      if (existing->running) {
        refreshIdleTimer(existing.addRef());
        context.getResults().setGrain(makeHostedIsolate(existing.addRef()));
        return kj::READY_NOW;
      }
      grains.erase(grainId);
    }

    auto services = context.getParams().getServices();
    auto workerSource = kj::heapArray<kj::byte>(sourceData.size());
    workerSource.asPtr().copyFrom(sourceData);

    return admissionPool.admit(kj::mv(workerSource)).then(
        [this, context, grainId = kj::str(grainId),
            services = kj::mv(services)](kj::Own<DecodedWorkerBundle> decoded) mutable {
      KJ_IF_SOME(existing, grains.find(grainId)) {
        if (existing->running) {
          refreshIdleTimer(existing.addRef());
          context.getResults().setGrain(makeHostedIsolate(existing.addRef()));
          return;
        }
        grains.erase(grainId);
      }

      auto source = buildWorkerSource(services, streamFactory,
          runtime.getHttpHeaderTableForEmbedding(), kj::mv(decoded));
      auto backing = kj::atomicAddRef(*source.backing);
      auto worker = runtime.loadDynamicWorker(LOADER_NAMESPACE, kj::str(grainId),
          [source = kj::mv(source.source), backing = kj::mv(source.backing)]() mutable {
        return source.clone(kj::atomicAddRef(*backing));
      });
      for (auto& target: backing->selfServices) target->worker = worker.get();
      auto ingressTarget = kj::atomicRefcounted<SelfServiceTarget>();
      ingressTarget->worker = worker.get();
      auto state = kj::rc<HostedState>(runtime, kj::str(grainId),
          kj::mv(services), kj::mv(backing), kj::mv(worker), kj::mv(ingressTarget));
      refreshIdleTimer(state.addRef());
      context.getResults().setGrain(makeHostedIsolate(state.addRef()));
      grains.insert(kj::mv(grainId), kj::mv(state));
    });
  }

 private:
  kj::Own<HostedIsolateImpl> makeHostedIsolate(kj::Rc<HostedState> state) {
    return kj::heap<HostedIsolateImpl>(kj::mv(state), streamFactory,
        [this](kj::Rc<HostedState> state) { refreshIdleTimer(kj::mv(state)); });
  }

  void refreshIdleTimer(kj::Rc<HostedState> state) {
    KJ_REQUIRE(state->running, "cannot refresh a stopped hosted isolate");
    auto generation = ++state->keepAliveGeneration;
    tasks.add(timer.afterDelay(idleTimeout).then(
        [this, state = kj::mv(state), generation]() mutable {
      if (!state->running || state->keepAliveGeneration != generation) return;
      auto grainId = kj::str(state->grainId);
      state->stop();
      grains.erase(grainId);
    }));
  }

  void taskFailed(kj::Exception&& exception) override {
    KJ_LOG(ERROR, "hosted isolate idle-eviction task failed", exception);
  }

  workerd::server::Server& runtime;
  capnp::ByteStreamFactory& streamFactory;
  kj::Timer& timer;
  kj::Duration idleTimeout;
  kj::TaskSet tasks;
  AdmissionPool admissionPool;
  kj::HashMap<kj::String, kj::Rc<HostedState>> grains;
};

kj::Duration getIdleTimeout() {
  auto value = getenv("SANDSTORM_ISOLATE_HOST_IDLE_TIMEOUT_MS");
  if (value == nullptr) return DEFAULT_IDLE_TIMEOUT;

  char* end = nullptr;
  errno = 0;
  auto milliseconds = strtoul(value, &end, 10);
  KJ_REQUIRE(errno == 0 && end != value && *end == '\0' &&
          milliseconds > 0 && milliseconds <= 24 * 60 * 60 * 1000,
      "invalid SANDSTORM_ISOLATE_HOST_IDLE_TIMEOUT_MS", value);
  return milliseconds * kj::MILLISECONDS;
}

}  // namespace
}  // namespace sandstorm

int main(int argc, char** argv) {
  bool inheritedControl = argc == 3 && kj::StringPtr(argv[1]) == "--control-fd"_kj;
  KJ_REQUIRE(inheritedControl || argc == 2,
      "usage: isolate-host <control-socket-path> | --control-fd <fd>");
  int controlFd = -1;
  if (inheritedControl) {
    char* end = nullptr;
    long parsed = strtol(argv[2], &end, 10);
    KJ_REQUIRE(end != argv[2] && *end == '\0' && parsed >= 0 && parsed <= INT_MAX,
        "invalid inherited control FD", argv[2]);
    controlFd = parsed;
    errno = 0;
    KJ_REQUIRE(access("/var/sandstorm/grains", F_OK) < 0 && errno == ENOENT,
        "inherited control mode requires the native host's minimal mount root");
  }

  auto io = kj::setupAsyncIo();
  kj::Own<kj::ConnectionReceiver> listener;
  kj::Own<kj::AsyncIoStream> controlStream;
  if (inheritedControl) {
    controlStream = io.lowLevelProvider->wrapSocketFd(controlFd,
        kj::LowLevelAsyncIoProvider::TAKE_OWNERSHIP);
  } else {
    auto address = kj::str("unix:", argv[1]);
    unlink(argv[1]);
    auto parsed = io.provider->getNetwork().parseAddress(address, 0).wait(io.waitScope);
    listener = parsed->listen();
  }

  auto filesystem = kj::newDiskFilesystem();
  sandstorm::SystemEntropySource entropy;
  auto defaultPlatform = workerd::jsg::defaultPlatform(0);
  workerd::server::WorkerdPlatform v8Platform(*defaultPlatform);
  workerd::jsg::V8System v8System(v8Platform, {}, defaultPlatform.get());
  sandstorm::SandstormLimitEnforcerFactory limitEnforcers(io.provider->getTimer());
  auto loggingOptions = workerd::Worker::LoggingOptions(workerd::Worker::ConsoleMode::STDOUT);
  loggingOptions.structuredLogging = workerd::StructuredLogging::YES;
  workerd::server::Server runtime(*filesystem,
      io.provider->getTimer(),
      kj::systemPreciseMonotonicClock(),
      io.provider->getNetwork(),
      entropy,
      kj::mv(loggingOptions),
      [](kj::String error) { KJ_FAIL_REQUIRE("embedded workerd configuration error", error); });
  runtime.setLimitEnforcerFactory(limitEnforcers);
  runtime.allowExperimental();
  capnp::MallocMessageBuilder runtimeConfig;
  auto bootstrapPath = kj::str("/tmp/sandstorm-loader-", getpid(), ".sock");
  if (!inheritedControl) unlink(bootstrapPath.cStr());
  sandstorm::initRuntimeConfig(runtimeConfig, kj::str("unix:", bootstrapPath));
  auto runtimeTask = runtime.run(v8System, runtimeConfig.getRoot<workerd::server::config::Config>())
      .eagerlyEvaluate([](kj::Exception&& error) {
    KJ_LOG(FATAL, "embedded workerd runtime failed", error);
  });
  KJ_REQUIRE(!runtimeTask.poll(io.waitScope), "embedded workerd runtime stopped during startup");

  capnp::ByteStreamFactory byteStreamFactory;

  capnp::TwoPartyServer controlServer(
      kj::heap<sandstorm::IsolateHostImpl>(runtime, byteStreamFactory,
          io.provider->getTimer(), sandstorm::getIdleTimeout()));
  if (inheritedControl) {
    controlServer.accept(*controlStream)
        .attach(kj::mv(controlStream))
        .exclusiveJoin(kj::mv(runtimeTask))
        .wait(io.waitScope);
  } else {
    controlServer.listen(*listener).exclusiveJoin(kj::mv(runtimeTask)).wait(io.waitScope);
  }
}
