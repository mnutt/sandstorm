// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2026 Sandstorm contributors
// Licensed under the Apache License, Version 2.0.

#include "server.h"
#include "v8-platform-impl.h"

#include <workerd/server/sandstorm-isolate-host.capnp.h>
#include <workerd/server/sandstorm-isolate-worker-source.capnp.h>
#include <workerd/server/workerd-api.h>
#include <workerd/api/global-scope.h>
#include <workerd/api/http.h>
#include <workerd/api/worker-loader.h>
#include <workerd/io/actor-cache.h>
#include <workerd/io/compatibility-date.h>
#include <workerd/io/io-context.h>
#include <workerd/io/limit-enforcer.h>
#include <workerd/io/tracer.h>
#include <workerd/io/worker-interface.h>
#include <workerd/jsg/buffersource.h>
#include <workerd/jsg/setup.h>
#include <workerd/util/stream-utils.h>

#include <capnp/rpc-twoparty.h>
#include <capnp/compat/json.h>
#include <capnp/compat/http-over-capnp.h>
#include <capnp/serialize.h>
#include <capnp/serialize-async.h>
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
#include <vector>

namespace sandstorm {
namespace {

constexpr kj::StringPtr LOADER_NAMESPACE = "sandstorm-grains"_kj;

// These are host policy rather than workerd embedding API. Keep them conservative until the
// Phase 4 measurements give us enough data to make them configurable per account/app.
constexpr size_t ISOLATE_OLD_HEAP_LIMIT = 64 * 1024 * 1024;
constexpr size_t ISOLATE_YOUNG_HEAP_LIMIT = 16 * 1024 * 1024;
constexpr size_t BUFFERING_LIMIT = 16 * 1024 * 1024;
constexpr size_t MAX_WORKER_SOURCE_BYTES = 16 * 1024 * 1024;
constexpr size_t MAX_RPC_EVENT_BYTES = 16 * 1024 * 1024;
constexpr uint MAX_SUBREQUESTS = 64;
constexpr auto REQUEST_JS_LIMIT = std::chrono::milliseconds(250);
constexpr auto STARTUP_JS_LIMIT = std::chrono::seconds(5);
constexpr auto DEFAULT_IDLE_TIMEOUT = 180 * kj::SECONDS;

class JsWatchdogScheduler final {
 public:
  JsWatchdogScheduler(): thread([this]() { run(); }) {}

  ~JsWatchdogScheduler() noexcept {
    {
      std::lock_guard lock(mutex);
      shuttingDown = true;
    }
    wake.notify_one();
    thread.join();
  }

  uint64_t schedule(v8::Isolate& isolate,
      std::atomic<bool>& exceeded,
      std::chrono::steady_clock::time_point deadline) {
    std::lock_guard lock(mutex);
    auto id = nextId++;
    entries.push_back(Entry{ id, deadline, &isolate, &exceeded });
    wake.notify_one();
    return id;
  }

  void cancel(uint64_t id) {
    std::lock_guard lock(mutex);
    for (size_t i = 0; i < entries.size(); ++i) {
      if (entries[i].id == id) {
        entries[i] = entries.back();
        entries.pop_back();
        wake.notify_one();
        return;
      }
    }
  }

 private:
  struct Entry {
    uint64_t id;
    std::chrono::steady_clock::time_point deadline;
    v8::Isolate* isolate;
    std::atomic<bool>* exceeded;
  };

  std::mutex mutex;
  std::condition_variable wake;
  std::vector<Entry> entries;
  uint64_t nextId = 1;
  bool shuttingDown = false;
  std::thread thread;

  void run() {
    std::unique_lock lock(mutex);
    for (;;) {
      if (shuttingDown) return;
      if (entries.empty()) {
        wake.wait(lock, [this]() { return shuttingDown || !entries.empty(); });
        continue;
      }

      auto next = entries.front().deadline;
      for (auto& entry: entries) next = std::min(next, entry.deadline);
      wake.wait_until(lock, next);
      if (shuttingDown) return;

      auto now = std::chrono::steady_clock::now();
      for (size_t i = entries.size(); i > 0; --i) {
        auto& entry = entries[i - 1];
        if (entry.deadline > now) continue;
        // Keep the scheduler lock while touching the registered pointers. cancel() therefore does
        // not return until a concurrent timeout is finished, so scope destruction is race-free.
        entry.exceeded->store(true, std::memory_order_release);
        entry.isolate->TerminateExecution();
        entry = entries.back();
        entries.pop_back();
      }
    }
  }
};

class JsWatchdogScope final {
 public:
  JsWatchdogScope(JsWatchdogScheduler& scheduler,
      v8::Isolate& isolate,
      std::atomic<int64_t>& remainingNanos,
      std::atomic<bool>& exceeded)
      : scheduler(scheduler),
        remainingNanos(remainingNanos),
        started(std::chrono::steady_clock::now()) {
    auto budget = std::chrono::nanoseconds(
        kj::max<int64_t>(0, remainingNanos.load(std::memory_order_relaxed)));
    registration = scheduler.schedule(isolate, exceeded, started + budget);
  }

  ~JsWatchdogScope() noexcept {
    scheduler.cancel(registration);

    auto elapsed = std::chrono::steady_clock::now() - started;
    remainingNanos.fetch_sub(
        std::chrono::duration_cast<std::chrono::nanoseconds>(elapsed).count(),
        std::memory_order_relaxed);
  }

 private:
  JsWatchdogScheduler& scheduler;
  std::atomic<int64_t>& remainingNanos;
  std::chrono::steady_clock::time_point started;
  uint64_t registration;
};

class SandstormIsolateLimitEnforcer final: public workerd::IsolateLimitEnforcer {
 public:
  explicit SandstormIsolateLimitEnforcer(JsWatchdogScheduler& watchdogs)
      : watchdogs(watchdogs) {}

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
    StartupScope(JsWatchdogScheduler& watchdogs,
        v8::Isolate& isolate,
        kj::OneOf<kj::Exception, kj::Duration>& result,
        std::chrono::nanoseconds limit)
        : result(result),
          remainingNanos(limit.count()),
          watchdog(kj::heap<JsWatchdogScope>(
              watchdogs, isolate, remainingNanos, exceeded)) {}
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

  kj::Own<void> enterLimitedJs(workerd::jsg::Lock& lock,
      kj::OneOf<kj::Exception, kj::Duration>& result,
      std::chrono::nanoseconds limit) const {
    return kj::heap<StartupScope>(watchdogs, *lock.v8Isolate, result, limit);
  }

  JsWatchdogScheduler& watchdogs;
  workerd::TrackedWasmInstanceList trackedWasmInstances;
  std::atomic<bool> heapLimitExceeded = false;
  v8::Isolate* isolateForHeapLimit = nullptr;
};

class SandstormRequestLimitEnforcer final: public workerd::LimitEnforcer {
 public:
  SandstormRequestLimitEnforcer(kj::Timer& timer, JsWatchdogScheduler& watchdogs)
      : timer(timer), watchdogs(watchdogs), remainingNanos(
          std::chrono::duration_cast<std::chrono::nanoseconds>(REQUEST_JS_LIMIT).count()) {}

  kj::Own<void> enterJs(workerd::jsg::Lock& lock, workerd::IoContext&) override {
    requireLimitsNotExceeded();
    return kj::heap<JsWatchdogScope>(watchdogs, *lock.v8Isolate, remainingNanos, exceeded);
  }
  void topUpActor() override {}
  void newSubrequest(bool) override {
    auto count = subrequests.fetch_add(1, std::memory_order_relaxed) + 1;
    JSG_REQUIRE(count <= MAX_SUBREQUESTS, Error, "subrequest limit exceeded");
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
  JsWatchdogScheduler& watchdogs;
  std::atomic<int64_t> remainingNanos;
  std::atomic<bool> exceeded = false;
  std::atomic<uint> subrequests = 0;
};

class SandstormLimitEnforcerFactory final:
    public workerd::server::Server::LimitEnforcerFactory {
 public:
  explicit SandstormLimitEnforcerFactory(kj::Timer& timer): timer(timer) {}

  kj::Maybe<kj::Own<workerd::IsolateLimitEnforcer>> newIsolateLimitEnforcer(
      kj::StringPtr, bool isDynamic) override {
    if (!isDynamic) return kj::none;
    return kj::heap<SandstormIsolateLimitEnforcer>(watchdogs);
  }

  kj::Maybe<kj::Own<workerd::LimitEnforcer>> newRequestLimitEnforcer(
      kj::StringPtr, bool isDynamic) override {
    if (!isDynamic) return kj::none;
    return kj::heap<SandstormRequestLimitEnforcer>(timer, watchdogs);
  }

 private:
  kj::Timer& timer;
  JsWatchdogScheduler watchdogs;
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

class NativeCapnpChannelState final: public kj::AtomicRefcounted {
 public:
  void send(bool fromWorker, kj::Array<kj::byte> message) {
    KJ_REQUIRE(message.size() > 0 && message.size() <= MAX_CAPNP_FRAME_BYTES,
        "native Cap'n Proto message exceeds size limit", message.size(), MAX_CAPNP_FRAME_BYTES);
    kj::Maybe<kj::Own<kj::CrossThreadPromiseFulfiller<kj::Array<kj::byte>>>> waiter;
    {
      auto lock = state.lockExclusive();
      KJ_REQUIRE(!lock->closed, "native Cap'n Proto channel is closed");
      auto& inbox = fromWorker ? lock->nativeInbox : lock->workerInbox;
      if (inbox.queued.empty()) {
        KJ_IF_SOME(pending, inbox.waitingReceiver) {
          waiter = kj::mv(pending);
          inbox.waitingReceiver = kj::none;
        }
      }
      if (waiter == kj::none) {
        KJ_REQUIRE(message.size() <= MAX_CAPNP_FRAME_BYTES - inbox.queuedBytes,
            "native Cap'n Proto channel queue exceeds size limit");
        inbox.queuedBytes += message.size();
        inbox.queued.add(kj::mv(message));
      }
    }
    KJ_IF_SOME(pending, waiter) {
      pending->fulfill(kj::mv(message));
    }
  }

  kj::Promise<kj::Array<kj::byte>> receive(bool workerSide) {
    auto lock = state.lockExclusive();
    if (lock->closed) {
      return kj::Promise<kj::Array<kj::byte>>(
          KJ_EXCEPTION(DISCONNECTED, "native Cap'n Proto channel is closed"));
    }
    auto& inbox = workerSide ? lock->workerInbox : lock->nativeInbox;
    KJ_REQUIRE(inbox.waitingReceiver == kj::none,
        "only one native Cap'n Proto receive may be pending");
    if (!inbox.queued.empty()) {
      auto message = kj::mv(inbox.queued.front());
      inbox.queuedBytes -= message.size();
      for (size_t i = 1; i < inbox.queued.size(); ++i) {
        inbox.queued[i - 1] = kj::mv(inbox.queued[i]);
      }
      inbox.queued.removeLast();
      return kj::mv(message);
    }
    auto paf = kj::newPromiseAndCrossThreadFulfiller<kj::Array<kj::byte>>();
    inbox.waitingReceiver = kj::mv(paf.fulfiller);
    return kj::mv(paf.promise);
  }

  void close() {
    kj::Maybe<kj::Own<kj::CrossThreadPromiseFulfiller<kj::Array<kj::byte>>>> workerWaiter;
    kj::Maybe<kj::Own<kj::CrossThreadPromiseFulfiller<kj::Array<kj::byte>>>> nativeWaiter;
    {
      auto lock = state.lockExclusive();
      if (lock->closed) return;
      lock->closed = true;
      workerWaiter = kj::mv(lock->workerInbox.waitingReceiver);
      nativeWaiter = kj::mv(lock->nativeInbox.waitingReceiver);
      lock->workerInbox.waitingReceiver = kj::none;
      lock->nativeInbox.waitingReceiver = kj::none;
      lock->workerInbox.queued.clear();
      lock->nativeInbox.queued.clear();
    }
    auto exception = KJ_EXCEPTION(DISCONNECTED, "native Cap'n Proto channel was closed");
    KJ_IF_SOME(waiter, workerWaiter) { waiter->reject(exception.clone()); }
    KJ_IF_SOME(waiter, nativeWaiter) { waiter->reject(exception.clone()); }
  }

 private:
  static constexpr size_t MAX_CAPNP_FRAME_BYTES = 64 * 1024 * 1024 + 64 * 1024;

  struct Inbox {
    kj::Vector<kj::Array<kj::byte>> queued;
    kj::Maybe<kj::Own<kj::CrossThreadPromiseFulfiller<kj::Array<kj::byte>>>> waitingReceiver;
    size_t queuedBytes = 0;
  };

  struct State {
    Inbox workerInbox;
    Inbox nativeInbox;
    bool closed = false;
  };

  kj::MutexGuarded<State> state;
};

class NativeCapnpMessageStream final: public capnp::MessageStream {
 public:
  explicit NativeCapnpMessageStream(kj::Own<NativeCapnpChannelState> state)
      : state(kj::mv(state)) {}

  kj::Promise<kj::Maybe<capnp::MessageReaderAndFds>> tryReadMessage(
      kj::ArrayPtr<kj::AutoCloseFd> fdSpace,
      capnp::ReaderOptions options,
      kj::ArrayPtr<capnp::word>) override {
    KJ_REQUIRE(fdSpace.size() == 0, "native Cap'n Proto channels do not carry file descriptors");
    return state->receive(false).then([options](kj::Array<kj::byte> bytes)
        -> kj::Maybe<capnp::MessageReaderAndFds> {
      KJ_REQUIRE(bytes.size() % sizeof(capnp::word) == 0,
          "native Cap'n Proto message is not word-aligned", bytes.size());
      auto words = kj::heapArray<capnp::word>(bytes.size() / sizeof(capnp::word));
      memcpy(words.begin(), bytes.begin(), bytes.size());
      auto reader = kj::heap<capnp::FlatArrayMessageReader>(words.asPtr(), options);
      kj::Own<capnp::MessageReader> owned =
          kj::attachRef(*reader, kj::mv(reader), kj::mv(words));
      return capnp::MessageReaderAndFds { kj::mv(owned), nullptr };
    });
  }

  kj::Promise<void> writeMessage(kj::ArrayPtr<const int> fds,
      kj::ArrayPtr<const kj::ArrayPtr<const capnp::word>> segments) override {
    KJ_REQUIRE(fds.size() == 0, "native Cap'n Proto channels do not carry file descriptors");
    auto words = capnp::messageToFlatArray(segments);
    auto bytes = kj::heapArray<kj::byte>(words.asBytes());
    state->send(false, kj::mv(bytes));
    return kj::READY_NOW;
  }

  kj::Promise<void> writeMessages(
      kj::ArrayPtr<kj::ArrayPtr<const kj::ArrayPtr<const capnp::word>>> messages) override {
    for (auto message: messages) {
      auto words = capnp::messageToFlatArray(message);
      auto bytes = kj::heapArray<kj::byte>(words.asBytes());
      state->send(false, kj::mv(bytes));
    }
    return kj::READY_NOW;
  }

  kj::Maybe<int> getSendBufferSize() override { return kj::none; }
  kj::Promise<void> end() override {
    state->close();
    return kj::READY_NOW;
  }

 private:
  kj::Own<NativeCapnpChannelState> state;
};

class NativeCapnpRpcSession final {
 public:
  NativeCapnpRpcSession(
      kj::Own<NativeCapnpChannelState> state, capnp::Capability::Client bootstrap)
      : stream(kj::mv(state)),
        network(stream, capnp::rpc::twoparty::Side::SERVER),
        rpcSystem(capnp::makeRpcServer(network, kj::mv(bootstrap))) {}

 private:
  NativeCapnpMessageStream stream;
  capnp::TwoPartyVatNetwork network;
  capnp::RpcSystem<capnp::rpc::twoparty::VatId> rpcSystem;
};

class NativeCapnpChannelEndpoint final: public workerd::api::NativeByteChannelEndpoint {
 public:
  NativeCapnpChannelEndpoint(
      kj::Own<NativeCapnpChannelState> state, kj::Own<NativeCapnpRpcSession> session)
      : state(kj::mv(state)), session(kj::mv(session)) {}
  ~NativeCapnpChannelEndpoint() noexcept override { state->close(); }

  void send(kj::Array<kj::byte> message) override {
    state->send(true, kj::mv(message));
  }
  kj::Promise<kj::Array<kj::byte>> receive() override { return state->receive(true); }
  void close() override { state->close(); }

 private:
  kj::Own<NativeCapnpChannelState> state;
  kj::Own<NativeCapnpRpcSession> session;
};

class NativeCapnpChannelProvider final: public workerd::api::NativeByteChannelProvider {
 public:
  explicit NativeCapnpChannelProvider(capnp::Capability::Client bootstrap)
      : bootstrap(kj::mv(bootstrap)) {}

  kj::Own<workerd::api::NativeByteChannelEndpoint> open() override {
    auto state = kj::atomicRefcounted<NativeCapnpChannelState>();
    auto session = kj::heap<NativeCapnpRpcSession>(kj::atomicAddRef(*state), bootstrap);
    return kj::heap<NativeCapnpChannelEndpoint>(kj::mv(state), kj::mv(session));
  }

 private:
  capnp::Capability::Client bootstrap;
};

class NativeCapnpChannelCapTableEntry final: public workerd::DynamicWorkerEnvCapability {
 public:
  explicit NativeCapnpChannelCapTableEntry(kj::Own<NativeCapnpChannelProvider> provider)
      : provider(kj::mv(provider)) {}

  kj::Own<CapTableEntry> clone() override {
    return kj::heap<NativeCapnpChannelCapTableEntry>(kj::atomicAddRef(*provider));
  }
  kj::Own<CapTableEntry> threadSafeClone() const override {
    return kj::heap<NativeCapnpChannelCapTableEntry>(
        kj::atomicAddRef(const_cast<NativeCapnpChannelProvider&>(*provider)));
  }
  kj::Own<NativeCapnpChannelProvider> addRefProvider() {
    return kj::atomicAddRef(*provider);
  }

 private:
  kj::Own<NativeCapnpChannelProvider> provider;
};

class SandstormEnvCompiler final: public workerd::DynamicWorkerEnvCompiler {
 public:
  explicit SandstormEnvCompiler(kj::Own<BundleBacking> backing)
      : backing(kj::mv(backing)) {}

  void compile(workerd::jsg::Lock& js,
      const workerd::Worker::Api& api,
      workerd::Frankenvalue& env,
      v8::Local<v8::Object> target) override {
    workerd::Frankenvalue::DirectCapabilityMaterializer materialize =
        [&js, &api](workerd::Frankenvalue::CapTableEntry& entry) {
      KJ_IF_SOME(channel, kj::tryDowncast<NativeCapnpChannelCapTableEntry>(entry)) {
        return workerd::server::WorkerdApi::from(api).wrapNativeByteChannelFactory(
            js, channel.addRefProvider());
      }
      // Sandstorm's bundle translation creates only Fetcher capabilities. Keep this policy and
      // the corresponding IoChannel downcast in the embedding binary rather than workerd's
      // dynamic loader.
      auto& channel = kj::downcast<workerd::IoChannelCapTableEntry>(entry);
      workerd::server::WorkerdApi::Global global{
        .name = kj::str("capability"),
        .value = workerd::server::WorkerdApi::Global::Fetcher{
          .channel = channel.getChannelNumber(
              workerd::IoChannelCapTableEntry::Type::SUBREQUEST),
          .requiresHost = true,
          .isInHouse = false,
        },
      };
      auto holder = js.obj();
      workerd::server::WorkerdApi::from(api).compileGlobals(
          js, kj::arrayPtr(&global, 1), holder, 1);
      return holder.get(js, "capability");
    };
    env.populateJsObject(js, workerd::jsg::JsObject(target), materialize);

    // Frankenvalue intentionally has no byte-string representation. Materialize immutable data
    // bindings directly in the destination context, matching workerd's configured-binding
    // behavior without extending the embedding patch or treating raw bytes as a capability.
    auto targetObject = workerd::jsg::JsObject(target);
    for (auto& binding: backing->decoded->bindings) {
      if (binding.type != IsolateWorkerSource::Binding::DATA) continue;
      auto bytes = kj::heapArray<kj::byte>(binding.value.size());
      bytes.asPtr().copyFrom(binding.value.asBytes());
      auto buffer = js.arrayBuffer(kj::mv(bytes));
      targetObject.set(js, binding.name,
          workerd::jsg::JsValue(buffer.getHandle(js)));
    }
  }

 private:
  kj::Own<BundleBacking> backing;
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

struct SandstormRpcEventResult final: public kj::Refcounted {
  kj::Maybe<kj::Array<kj::byte>> response;
};

class SandstormRpcEvent final: public workerd::WorkerInterface::CustomEvent {
 public:
  SandstormRpcEvent(kj::Array<kj::byte> request, kj::Own<SandstormRpcEventResult> result)
      : request(kj::mv(request)), result(kj::mv(result)) {}

  kj::Promise<Result> run(kj::Own<workerd::IoContext::IncomingRequest> incomingRequest,
      kj::Maybe<kj::StringPtr> entrypointName,
      kj::Maybe<workerd::Worker::VersionInfo> versionInfo,
      workerd::Frankenvalue props,
      kj::TaskSet& waitUntilTasks,
      bool isDynamicDispatch) override {
    auto& ioContext = incomingRequest->getContext();
    incomingRequest->delivered();

    KJ_DEFER({
      waitUntilTasks.add(incomingRequest->drain().attach(kj::mv(incomingRequest)));
    });

    co_await ioContext.run(
        [this, &ioContext, entrypointName, versionInfo = kj::mv(versionInfo),
            props = kj::mv(props), isDynamicDispatch](workerd::Worker::Lock& lock) mutable {
      workerd::jsg::AsyncContextFrame::StorageScope traceScope =
          ioContext.makeAsyncTraceScope(lock);
      workerd::jsg::AsyncContextFrame::StorageScope userTraceScope =
          ioContext.makeUserAsyncTraceScope(lock);

      auto handler = KJ_REQUIRE_NONNULL(
          lock.getExportedHandler(entrypointName, kj::mv(versionInfo), kj::mv(props),
              ioContext.getActor(), isDynamicDispatch),
          "sandstorm RPC events require a module-syntax worker");
      auto& function = JSG_REQUIRE_NONNULL(handler->sandstormRpcEvent, TypeError,
          "worker does not export a sandstormRpcEvent() handler");
      auto input = workerd::jsg::BufferSource(
          lock, workerd::jsg::BackingStore::from(lock, kj::mv(request)));
      auto promise = function(lock, kj::mv(input),
          workerd::jsg::JsValue(handler->env.getHandle(lock)).addRef(lock), handler->getCtx());

      return ioContext.awaitJs(lock, kj::mv(promise)).then(
          [result = kj::addRef(*result)](workerd::jsg::BufferSource output) mutable {
        KJ_REQUIRE(output.size() <= MAX_RPC_EVENT_BYTES,
            "worker RPC event response exceeds size limit", output.size(), MAX_RPC_EVENT_BYTES);
        result->response = kj::heapArray(output.asArrayPtr());
      });
    }).exclusiveJoin(ioContext.onAbort());

    KJ_IF_SOME(tracer, ioContext.getWorkerTracer()) {
      tracer.setReturn(ioContext.now());
    }
    co_return Result{.outcome = workerd::EventOutcome::OK};
  }

  kj::Promise<Result> sendRpc(capnp::HttpOverCapnpFactory&,
      capnp::ByteStreamFactory&, workerd::rpc::EventDispatcher::Client) override {
    KJ_UNIMPLEMENTED("sandstorm RPC events are local to the embedded workerd host");
  }

  kj::Promise<Result> notSupported() override {
    KJ_UNIMPLEMENTED("sandstorm RPC events are not supported by this worker channel");
  }

  uint16_t getType() override {
    // Report this as the existing workerd JS-RPC event category for metrics and tracing.
    return 9;
  }

  workerd::tracing::EventInfo getEventInfo() const override {
    return workerd::tracing::JsRpcEventInfo(nullptr);
  }

 private:
  kj::Array<kj::byte> request;
  kj::Own<SandstormRpcEventResult> result;
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

class CompatibleWebSocketBridge final: public kj::Refcounted,
                                       private kj::TaskSet::ErrorHandler {
 public:
  CompatibleWebSocketBridge(kj::Own<kj::WebSocket> socket,
      capnp::WebSocket::Client outgoing,
      kj::Maybe<kj::Own<kj::PromiseFulfiller<void>>> doneFulfiller = kj::none)
      : socket(kj::mv(socket)), outgoing(kj::mv(outgoing)), tasks(*this),
        doneFulfiller(kj::mv(doneFulfiller)) {}

  explicit CompatibleWebSocketBridge(kj::Own<kj::WebSocket> socket)
      : socket(kj::mv(socket)), outgoing(nullptr), tasks(*this) {}

  void setOutgoing(capnp::WebSocket::Client value) {
    outgoing = kj::mv(value);
  }

  void start() {
    tasks.add(pumpToCapnp());
  }

  capnp::WebSocket::Client makeIncomingCapability() {
    return kj::heap<Incoming>(kj::addRef(*this));
  }

 private:
  class Incoming final: public capnp::WebSocket::Server {
   public:
    explicit Incoming(kj::Own<CompatibleWebSocketBridge> bridge)
        : bridge(kj::mv(bridge)) {}

    kj::Promise<void> sendText(SendTextContext context) override {
      auto text = context.getParams().getText();
      return bridge->socket->send(kj::arrayPtr(text.begin(), text.size()));
    }

    kj::Promise<void> sendData(SendDataContext context) override {
      return bridge->socket->send(context.getParams().getData());
    }

    kj::Promise<void> close(CloseContext context) override {
      auto params = context.getParams();
      return bridge->socket->close(params.getCode(), params.getReason())
          .then([bridge = kj::addRef(*bridge)]() mutable { bridge->complete(); });
    }

   private:
    kj::Own<CompatibleWebSocketBridge> bridge;
  };

  kj::Promise<void> pumpToCapnp() {
    return socket->receive(BUFFERING_LIMIT).then(
        [this](kj::WebSocket::Message message) -> kj::Promise<void> {
      KJ_SWITCH_ONEOF(message) {
        KJ_CASE_ONEOF(text, kj::String) {
          auto request = outgoing.sendTextRequest();
          request.setText(text);
          return request.send().then([this]() { return pumpToCapnp(); });
        }
        KJ_CASE_ONEOF(data, kj::Array<kj::byte>) {
          auto request = outgoing.sendDataRequest();
          request.setData(data);
          return request.send().then([this]() { return pumpToCapnp(); });
        }
        KJ_CASE_ONEOF(close, kj::WebSocket::Close) {
          auto request = outgoing.closeRequest();
          request.setCode(close.code);
          request.setReason(close.reason);
          return request.send().then([this](auto&&) { complete(); });
        }
      }
      KJ_UNREACHABLE;
    });
  }

  void complete() {
    KJ_IF_SOME(fulfiller, doneFulfiller) {
      fulfiller->fulfill();
      doneFulfiller = kj::none;
    }
  }

  void taskFailed(kj::Exception&& exception) override {
    if (exception.getType() != kj::Exception::Type::DISCONNECTED) {
      KJ_LOG(WARNING, "HTTP-over-Cap'n-Proto WebSocket bridge failed", exception);
    }
    KJ_IF_SOME(fulfiller, doneFulfiller) {
      fulfiller->reject(kj::mv(exception));
      doneFulfiller = kj::none;
    }
  }

  kj::Own<kj::WebSocket> socket;
  capnp::WebSocket::Client outgoing;
  kj::TaskSet tasks;
  kj::Maybe<kj::Own<kj::PromiseFulfiller<void>>> doneFulfiller;
};

class CompletedCompatibleHttpRequest final: public capnp::HttpService::ServerRequestContext::Server {};

static constexpr kj::StringPtr COMPATIBLE_COMMON_HEADER_NAMES[] = {
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

kj::HttpHeaders decodeCompatibleHeaders(kj::HttpHeaderTable& table,
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
        KJ_REQUIRE(nameIndex > 0 && nameIndex < kj::size(COMPATIBLE_COMMON_HEADER_NAMES),
            "invalid compatible HTTP header name", nameIndex);
        kj::String value;
        switch (common.which()) {
          case capnp::HttpHeader::Common::VALUE:
            value = kj::str(common.getValue());
            break;
          case capnp::HttpHeader::Common::COMMON_VALUE:
            KJ_REQUIRE(common.getCommonValue() == capnp::CommonHeaderValue::GZIP_DEFLATE,
                "invalid compatible HTTP header value");
            value = kj::str("gzip, deflate");
            break;
        }
        result.add(kj::str(COMPATIBLE_COMMON_HEADER_NAMES[nameIndex]), kj::mv(value));
        break;
      }
    }
  }
  return result;
}

void encodeCompatibleHeaders(const kj::HttpHeaders& input,
    capnp::List<capnp::HttpHeader>::Builder output) {
  size_t index = 0;
  input.forEach([&](kj::StringPtr name, kj::StringPtr value) {
    auto uncommon = output[index++].initUncommon();
    uncommon.setName(name);
    uncommon.setValue(value);
  });
}

class CompatibleClientRequestContext final:
    public capnp::HttpService::ClientRequestContext::Server {
 public:
  CompatibleClientRequestContext(capnp::ByteStreamFactory& streamFactory,
      kj::HttpHeaderTable& headerTable,
      kj::HttpService::Response& response,
      kj::Own<kj::PromiseFulfiller<kj::Promise<void>>> responseFulfiller)
      : streamFactory(streamFactory), headerTable(headerTable), response(response),
        responseFulfiller(kj::mv(responseFulfiller)) {}

  kj::Promise<void> startResponse(StartResponseContext context) override {
    KJ_REQUIRE(responseFulfiller.get() != nullptr, "compatible HTTP response already started");
    auto input = context.getParams().getResponse();
    auto bodySize = input.getBodySize();
    kj::Maybe<uint64_t> expectedSize;
    bool hasBody = true;
    if (bodySize.isFixed()) {
      expectedSize = bodySize.getFixed();
      hasBody = bodySize.getFixed() > 0;
    }
    auto output = response.send(input.getStatusCode(), input.getStatusText(),
        decodeCompatibleHeaders(headerTable, input.getHeaders()), expectedSize);
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

  kj::Promise<void> startWebSocket(StartWebSocketContext context) override {
    KJ_REQUIRE(responseFulfiller.get() != nullptr, "HTTP response already started");
    auto params = context.getParams();
    auto socket = response.acceptWebSocket(
        decodeCompatibleHeaders(headerTable, params.getHeaders()));
    auto done = kj::newPromiseAndFulfiller<void>();
    auto bridge = kj::refcounted<CompatibleWebSocketBridge>(
        kj::mv(socket), params.getUpSocket(), kj::mv(done.fulfiller));
    bridge->start();
    context.getResults().setDownSocket(bridge->makeIncomingCapability());
    responseFulfiller->fulfill(done.promise.attach(kj::mv(bridge)));
    responseFulfiller = nullptr;
    return kj::READY_NOW;
  }

 private:
  capnp::ByteStreamFactory& streamFactory;
  kj::HttpHeaderTable& headerTable;
  kj::HttpService::Response& response;
  kj::Own<kj::PromiseFulfiller<kj::Promise<void>>> responseFulfiller;
};

class CompatibleCapnpHttpService final: public SharedHttpService {
 public:
  CompatibleCapnpHttpService(capnp::ByteStreamFactory& streamFactory,
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
    encodeCompatibleHeaders(headers, metadata.initHeaders(headers.size()));

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
    request.setContext(kj::heap<CompatibleClientRequestContext>(streamFactory, headerTable,
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

class CompatibleHttpRequestContext final:
    public capnp::HttpService::ServerRequestContext::Server,
    public kj::HttpService::Response {
 public:
  CompatibleHttpRequestContext(capnp::ByteStreamFactory& streamFactory,
      capnp::HttpRequest::Reader request,
      capnp::HttpService::ClientRequestContext::Client clientContext,
      kj::Own<kj::AsyncInputStream> requestBody,
      kj::HttpHeaderTable& headerTable,
      kj::HttpService& service)
      : streamFactory(streamFactory),
        method(static_cast<kj::HttpMethod>(request.getMethod())), url(kj::str(request.getUrl())),
        headers(decodeCompatibleHeaders(headerTable, request.getHeaders())),
        clientContext(kj::mv(clientContext)),
        task(service.request(method, url, headers, *requestBody, *this)
            .attach(kj::mv(requestBody))
            .eagerlyEvaluate([](kj::Exception&& error) { throw kj::mv(error); })) {}

  kj::Maybe<kj::Promise<capnp::Capability::Client>> shortenPath() override {
    return task.then([]() -> capnp::Capability::Client {
      return kj::heap<CompletedCompatibleHttpRequest>();
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

  kj::Own<kj::WebSocket> acceptWebSocket(const kj::HttpHeaders& headers) override {
    KJ_REQUIRE(replyTask == kj::none, "HTTP response already started");
    auto request = clientContext.startWebSocketRequest();
    encodeCompatibleHeaders(headers, request.initHeaders(headers.size()));
    auto pipe = kj::newWebSocketPipe();
    auto bridge = kj::refcounted<CompatibleWebSocketBridge>(kj::mv(pipe.ends[1]));
    request.setUpSocket(bridge->makeIncomingCapability());
    auto pipeline = request.send();
    bridge->setOutgoing(pipeline.getDownSocket());
    bridge->start();
    replyTask = pipeline.ignoreResult().attach(kj::mv(bridge));
    return kj::mv(pipe.ends[0]);
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

class CompatibleHttpServiceAdapter final: public capnp::HttpService::Server {
 public:
  CompatibleHttpServiceAdapter(
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
    results.setContext(kj::heap<CompatibleHttpRequestContext>(streamFactory,
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
    KJ_REQUIRE(binding.getName() != "__SANDSTORM_NATIVE_CAPNP",
        "worker binding name is reserved by the native runtime", binding.getName());
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
        value = binding.getData();
        accountBindingBytes(value.size());
        break;
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
  bool needsNativeBridge = false;
  for (auto& binding: bundle.bindings) {
    switch (binding.type) {
      case IsolateWorkerSource::Binding::TEXT: {
        capnp::MallocMessageBuilder jsonMessage;
        auto jsonValue = jsonMessage.initRoot<capnp::json::Value>();
        jsonValue.setString(binding.value);
        env.setProperty(kj::str(binding.name),
            workerd::Frankenvalue::fromJson(json.encodeRaw(jsonValue.asReader())));
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
            needsNativeBridge = true;
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
                    kj::refcounted<CompatibleCapnpHttpService>(streamFactory, headerTable,
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
        // SandstormEnvCompiler materializes binary data after Frankenvalue has populated the
        // ordinary JSON and capability bindings.
        break;
    }
  }
  if (needsNativeBridge) {
    auto request = services.getBridgeRequest();
    env.setProperty(kj::str("__SANDSTORM_NATIVE_CAPNP"),
        workerd::Frankenvalue::fromDirectCapability(
            kj::heap<NativeCapnpChannelCapTableEntry>(
                kj::atomicRefcounted<NativeCapnpChannelProvider>(
                    request.send().getBridge()))));
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
    .envCompiler = kj::atomicRefcounted<SandstormEnvCompiler>(
        kj::atomicAddRef(*backing)),
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
    if (!idleTimerCanceler.isEmpty()) {
      idleTimerCanceler.cancel("hosted isolate stopped");
    }
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
  kj::Canceler idleTimerCanceler;
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
    context.getResults().setService(kj::heap<CompatibleHttpServiceAdapter>(streamFactory,
        state->runtime.getHttpHeaderTableForEmbedding(),
        kj::heap<WorkerIngressService>(kj::atomicAddRef(*state->ingressTarget))));
    return kj::READY_NOW;
  }

  kj::Promise<void> invokeRpcEvent(InvokeRpcEventContext context) override {
    KJ_REQUIRE(state->running, "hosted isolate has been stopped");
    auto input = context.getParams().getRequest();
    KJ_REQUIRE(input.size() <= MAX_RPC_EVENT_BYTES,
        "worker RPC event request exceeds size limit", input.size(), MAX_RPC_EVENT_BYTES);

    auto ingress = state->worker->getEntrypoint(
        kj::none, workerd::Frankenvalue(), kj::none);
    auto request = ingress->startRequest({});
    auto result = kj::refcounted<SandstormRpcEventResult>();
    auto promise = request->customEvent(kj::heap<SandstormRpcEvent>(
        kj::heapArray(input.asBytes()), kj::addRef(*result)));
    return promise.then([context, result = kj::mv(result), request = kj::mv(request),
                            ingress = kj::mv(ingress)](auto eventResult) mutable {
      KJ_REQUIRE(eventResult.outcome == workerd::EventOutcome::OK,
          "worker RPC event failed", eventResult.outcome);
      context.getResults().setResponse(
          KJ_REQUIRE_NONNULL(result->response, "worker RPC event returned no response"));
    });
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
    if (!state->idleTimerCanceler.isEmpty()) {
      state->idleTimerCanceler.cancel("hosted isolate idle timer refreshed");
    }
    auto timerTask = state->idleTimerCanceler.wrap(timer.afterDelay(idleTimeout).then(
        [this, state = kj::mv(state)]() mutable {
      // Detach the currently-running timer before stop() cancels any outstanding timer.
      state->idleTimerCanceler.release();
      if (!state->running) return;
      auto grainId = kj::str(state->grainId);
      state->stop();
      grains.erase(grainId);
    })).catch_([](kj::Exception&& exception) -> kj::Promise<void> {
      if (exception.getType() == kj::Exception::Type::DISCONNECTED) {
        return kj::READY_NOW;
      }
      return kj::mv(exception);
    });
    tasks.add(kj::mv(timerTask));
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
