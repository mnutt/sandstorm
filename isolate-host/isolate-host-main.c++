// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2026 Sandstorm contributors
// Licensed under the Apache License, Version 2.0.

#include "server.h"
#include "v8-platform-impl.h"

#include <workerd/server/sandstorm-isolate-host.capnp.h>
#include <workerd/server/sandstorm-isolate-exports.capnp.h>
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
#include <capnp/rpc.capnp.h>
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
constexpr size_t MAX_DEFERRED_RPC_CALLS_PER_ANSWER = 64;
constexpr size_t MAX_DEFERRED_RPC_CALLS = 1024;
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

struct DecodedExport {
  kj::String name;
  uint64_t interfaceId;
};

struct DecodedWorkerBundle final: public kj::AtomicRefcounted {
  kj::String mainModule;
  kj::String compatibilityDate;
  kj::Array<kj::String> compatibilityFlags;
  kj::Array<DecodedModule> modules;
  kj::Array<DecodedBinding> bindings;
  kj::Array<DecodedExport> exports;
};

struct BundleBacking final: public kj::AtomicRefcounted {
  kj::Own<DecodedWorkerBundle> decoded;
  capnp::MallocMessageBuilder compatibility;
};

struct LoadedWorkerSource {
  workerd::DynamicWorkerSource source;
  kj::Own<BundleBacking> backing;
};

class SandstormEnvCompiler final: public workerd::DynamicWorkerEnvCompiler {
 public:
  explicit SandstormEnvCompiler(kj::Own<BundleBacking> backing)
      : backing(kj::mv(backing)) {}

  void compile(workerd::jsg::Lock& js,
      const workerd::Worker::Api& api,
      workerd::Frankenvalue& env,
      v8::Local<v8::Object> target) override {
    (void)api;
    env.populateJsObject(js, workerd::jsg::JsObject(target));

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

class SandstormRpcEventInputQueue final: public kj::Refcounted {
 public:
  kj::Promise<kj::Array<kj::byte>> receive() {
    if (!frames.empty()) {
      auto result = kj::mv(frames.front());
      for (size_t i = 1; i < frames.size(); ++i) {
        frames[i - 1] = kj::mv(frames[i]);
      }
      frames.removeLast();
      return kj::mv(result);
    }
    if (closed) {
      return KJ_EXCEPTION(DISCONNECTED, "worker RPC event input is closed");
    }
    KJ_REQUIRE(waitingReceiver == kj::none,
        "only one receive may be pending for a worker RPC event");
    auto paf = kj::newPromiseAndFulfiller<kj::Array<kj::byte>>();
    waitingReceiver = kj::mv(paf.fulfiller);
    return kj::mv(paf.promise);
  }

  bool push(kj::Array<kj::byte> frame) {
    if (closed) return false;
    KJ_IF_SOME(receiver, waitingReceiver) {
      receiver->fulfill(kj::mv(frame));
      waitingReceiver = kj::none;
    } else {
      frames.add(kj::mv(frame));
    }
    return true;
  }

  kj::Promise<void> whenClosed() {
    if (closed) return kj::READY_NOW;
    auto paf = kj::newPromiseAndFulfiller<void>();
    closeWaiters.add(kj::mv(paf.fulfiller));
    return kj::mv(paf.promise);
  }

  void close() {
    if (closed) return;
    closed = true;
    frames.clear();
    KJ_IF_SOME(receiver, waitingReceiver) {
      receiver->reject(KJ_EXCEPTION(DISCONNECTED, "worker RPC event input was closed"));
      waitingReceiver = kj::none;
    }
    for (auto& waiter: closeWaiters) {
      waiter->fulfill();
    }
    closeWaiters.clear();
  }

 private:
  kj::Vector<kj::Array<kj::byte>> frames;
  kj::Maybe<kj::Own<kj::PromiseFulfiller<kj::Array<kj::byte>>>> waitingReceiver;
  kj::Vector<kj::Own<kj::PromiseFulfiller<void>>> closeWaiters;
  bool closed = false;
};

class SandstormRpcEventControl final: public kj::Refcounted {
 public:
  void start(workerd::IoContext& context) {
    KJ_REQUIRE(ioContext == nullptr && !completed,
        "worker RPC event control started more than once");
    ioContext = &context;
    if (cancellationRequested) {
      abortContext();
    }
  }

  void finish() {
    ioContext = nullptr;
    completed = true;
  }

  void cancel() {
    if (completed || cancellationRequested) return;
    cancellationRequested = true;
    if (ioContext != nullptr) {
      abortContext();
    }
  }

  bool wasCanceled() const { return cancellationRequested; }
  bool hasStarted() const { return ioContext != nullptr || completed; }

 private:
  void abortContext() {
    KJ_ASSERT(ioContext != nullptr);
    ioContext->abort(KJ_EXCEPTION(DISCONNECTED,
        "worker RPC event was canceled by its Cap'n Proto caller"));
  }

  workerd::IoContext* ioContext = nullptr;
  bool cancellationRequested = false;
  bool completed = false;
};

class SandstormRpcEvent final: public workerd::WorkerInterface::CustomEvent {
 public:
  SandstormRpcEvent(kj::Array<kj::byte> request,
      kj::Function<void(kj::Array<kj::byte>)> send,
      kj::Own<SandstormRpcEventInputQueue> inputQueue,
      kj::Own<SandstormRpcEventControl> control)
      : request(kj::mv(request)), send(kj::mv(send)), inputQueue(kj::mv(inputQueue)),
        control(kj::mv(control)) {}

  kj::Promise<Result> run(kj::Own<workerd::IoContext::IncomingRequest> incomingRequest,
      kj::Maybe<kj::StringPtr> entrypointName,
      kj::Maybe<workerd::Worker::VersionInfo> versionInfo,
      workerd::Frankenvalue props,
      kj::TaskSet& waitUntilTasks,
      bool isDynamicDispatch) override {
    auto& ioContext = incomingRequest->getContext();
    incomingRequest->delivered();
    control->start(ioContext);

    KJ_DEFER({
      control->finish();
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
      auto sendToHost = workerd::jsg::Function<void(workerd::jsg::BufferSource)>(
          [send = kj::mv(send)](
              workerd::jsg::Lock&, workerd::jsg::BufferSource output) mutable {
        KJ_REQUIRE(output.size() > 0 && output.size() <= MAX_RPC_EVENT_BYTES,
            "worker RPC frame exceeds size limit", output.size(), MAX_RPC_EVENT_BYTES);
        send(kj::heapArray(output.asArrayPtr()));
      });
      auto receiveFromHost = workerd::jsg::Function<
          workerd::jsg::Promise<workerd::jsg::BufferSource>()>(
          [inputQueue = kj::addRef(*inputQueue), &ioContext](workerd::jsg::Lock& lock) mutable {
        return ioContext.awaitIo(lock, inputQueue->receive(),
            [](workerd::jsg::Lock& lock, kj::Array<kj::byte> frame) {
          return workerd::jsg::BufferSource(
              lock, workerd::jsg::BackingStore::from(lock, kj::mv(frame)));
        });
      });
      auto promise = function(lock, kj::mv(input), kj::mv(sendToHost), kj::mv(receiveFromHost),
          workerd::jsg::JsValue(handler->env.getHandle(lock)).addRef(lock), handler->getCtx());
      return ioContext.awaitJs(lock, kj::mv(promise));
    }).exclusiveJoin(ioContext.onAbort()).attach(
        kj::defer([inputQueue = kj::addRef(*inputQueue)]() mutable { inputQueue->close(); }));

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
  kj::Function<void(kj::Array<kj::byte>)> send;
  kj::Own<SandstormRpcEventInputQueue> inputQueue;
  kj::Own<SandstormRpcEventControl> control;
};

kj::Own<DecodedWorkerBundle> decodeWorkerBundle(kj::ArrayPtr<const kj::byte> workerSource) {
  static constexpr uint64_t MAX_TRAVERSAL_WORDS = 4 * 1024 * 1024;
  static constexpr size_t MAX_MODULES = 1024;
  static constexpr size_t MAX_MODULE_BYTES = 8 * 1024 * 1024;
  static constexpr size_t MAX_TOTAL_MODULE_BYTES = 16 * 1024 * 1024;
  static constexpr size_t MAX_BINDINGS = 1024;
  static constexpr size_t MAX_EXPORTS = 256;
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
  KJ_REQUIRE(bundle.getFormatVersion() == 2,
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
        value = binding.getData();
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
  auto inputExports = bundle.getExports();
  KJ_REQUIRE(inputExports.size() <= MAX_EXPORTS,
      "worker export count exceeds limit", inputExports.size(), MAX_EXPORTS);
  kj::HashSet<kj::String> exportNames;
  auto exports = kj::heapArrayBuilder<DecodedExport>(inputExports.size());
  for (auto input: inputExports) {
    KJ_REQUIRE(input.getName().size() > 0 && input.getName().size() <= MAX_NAME_BYTES,
        "invalid worker export name length", input.getName().size());
    KJ_REQUIRE(input.getInterfaceId() != 0,
        "worker export interface ID must be nonzero", input.getName());
    KJ_REQUIRE(exportNames.find(input.getName()) == kj::none,
        "worker bundle has a duplicate export name", input.getName());
    exportNames.insert(kj::str(input.getName()));
    exports.add(DecodedExport{
      .name = kj::str(input.getName()),
      .interfaceId = input.getInterfaceId(),
    });
  }
  result->exports = exports.finish();
  return result;
}

LoadedWorkerSource buildWorkerSource(kj::Own<DecodedWorkerBundle> decoded) {
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
      case IsolateWorkerSource::Binding::DATA:
        // SandstormEnvCompiler materializes binary data after Frankenvalue has populated the
        // ordinary JSON and capability bindings.
        break;
    }
  }
  auto compatibility = backing->compatibility.initRoot<workerd::CompatibilityFlags>();
  auto flagsBuilder = kj::heapArrayBuilder<kj::String>(bundle.compatibilityFlags.size() + 1);
  bool hasNodeJsAls = false;
  for (auto& flag: bundle.compatibilityFlags) {
    KJ_REQUIRE(flag != "no_nodejs_als",
        "isolate workers cannot disable AsyncLocalStorage required by the Cap'n Proto runtime");
    if (flag == "nodejs_als" || flag == "nodejs_compat") hasNodeJsAls = true;
    flagsBuilder.add(kj::str(flag));
  }
  if (!hasNodeJsAls) flagsBuilder.add(kj::str("nodejs_als"));
  auto flags = flagsBuilder.finish();
  BundleErrorReporter reporter;
  workerd::compileCompatibilityFlags(bundle.compatibilityDate, flags, compatibility,
      reporter, true, workerd::CompatibilityDateValidation::CODE_VERSION);
  reporter.requireValid();

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
  config.setStructuredLogging(true);
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

class WorkerRpcConnection;

struct HostedState final: public kj::Refcounted {
  HostedState(workerd::server::Server& runtime,
      kj::String grainId,
      IsolateBindingServices::Client bindingServices,
      kj::Own<BundleBacking> backing,
      kj::Own<workerd::WorkerStubChannel> worker);

  ~HostedState() noexcept;

  void stop();

  workerd::server::Server& runtime;
  kj::String grainId;
  IsolateBindingServices::Client bindingServices;
  kj::Own<BundleBacking> backing;
  kj::Own<workerd::WorkerStubChannel> worker;
  kj::Maybe<kj::Own<WorkerRpcConnection>> rpcConnection;
  kj::Canceler idleTimerCanceler;
  bool running = true;
};

kj::Promise<void> dispatchWorkerRpcEvent(kj::Rc<HostedState> state,
    kj::Array<kj::byte> input,
    kj::Function<void(kj::Array<kj::byte>)> send,
    kj::Own<SandstormRpcEventInputQueue> inputQueue,
    kj::Own<SandstormRpcEventControl> control) {
  KJ_REQUIRE(state->running, "hosted isolate has been stopped");
  KJ_REQUIRE(input.size() <= MAX_RPC_EVENT_BYTES,
      "worker RPC event request exceeds size limit", input.size(), MAX_RPC_EVENT_BYTES);

  auto ingress = state->worker->getEntrypoint(kj::none, workerd::Frankenvalue(), kj::none);
  auto request = ingress->startRequest({});
  auto promise = request->customEvent(kj::heap<SandstormRpcEvent>(
      kj::mv(input), kj::mv(send), kj::mv(inputQueue), kj::mv(control)));
  return promise.then([state = kj::mv(state), request = kj::mv(request),
                          ingress = kj::mv(ingress)](auto eventResult) mutable {
    KJ_REQUIRE(eventResult.outcome == workerd::EventOutcome::OK,
        "worker RPC event failed", eventResult.outcome);
  });
}

class WorkerRpcResponseQueue final: public kj::Refcounted {
 public:
  kj::Promise<kj::Maybe<capnp::MessageReaderAndFds>> read(capnp::ReaderOptions options) {
    if (!responses.empty()) {
      auto response = kj::mv(responses.front());
      for (size_t i = 1; i < responses.size(); ++i) {
        responses[i - 1] = kj::mv(responses[i]);
      }
      responses.removeLast();
      return readMessage(kj::mv(response), options);
    }
    if (closed) return kj::Maybe<capnp::MessageReaderAndFds>(kj::none);
    KJ_REQUIRE(waitingReader == kj::none, "only one worker RPC read may be pending");
    auto paf = kj::newPromiseAndFulfiller<kj::Maybe<kj::Array<kj::byte>>>();
    waitingReader = kj::mv(paf.fulfiller);
    return paf.promise.then([options](kj::Maybe<kj::Array<kj::byte>> response)
        -> kj::Maybe<capnp::MessageReaderAndFds> {
      KJ_IF_SOME(bytes, response) {
        return readMessage(kj::mv(bytes), options);
      }
      return kj::none;
    });
  }

  void push(kj::Array<kj::byte> response) {
    KJ_REQUIRE(!closed, "worker RPC connection is closed");
    KJ_IF_SOME(reader, waitingReader) {
      reader->fulfill(kj::mv(response));
      waitingReader = kj::none;
    } else {
      responses.add(kj::mv(response));
    }
  }

  void close() {
    if (closed) return;
    closed = true;
    responses.clear();
    KJ_IF_SOME(reader, waitingReader) {
      reader->fulfill(kj::none);
      waitingReader = kj::none;
    }
  }

 private:
  static kj::Maybe<capnp::MessageReaderAndFds> readMessage(
      kj::Array<kj::byte> bytes, capnp::ReaderOptions options) {
    KJ_REQUIRE(bytes.size() % sizeof(capnp::word) == 0,
        "worker returned a Cap'n Proto message that is not word-aligned", bytes.size());
    auto words = kj::heapArray<capnp::word>(bytes.size() / sizeof(capnp::word));
    memcpy(words.begin(), bytes.begin(), bytes.size());
    auto reader = kj::heap<capnp::FlatArrayMessageReader>(words.asPtr(), options);
    kj::Own<capnp::MessageReader> owned =
        kj::attachRef(*reader, kj::mv(reader), kj::mv(words));
    return capnp::MessageReaderAndFds { kj::mv(owned), nullptr };
  }

  kj::Vector<kj::Array<kj::byte>> responses;
  kj::Maybe<kj::Own<kj::PromiseFulfiller<kj::Maybe<kj::Array<kj::byte>>>>> waitingReader;
  bool closed = false;
};

class WorkerRpcFrameRouter final: public kj::Refcounted {
 public:
  WorkerRpcFrameRouter(): responses(kj::refcounted<WorkerRpcResponseQueue>()) {}

  kj::Promise<kj::Maybe<capnp::MessageReaderAndFds>> read(capnp::ReaderOptions options) {
    return responses->read(options);
  }

  kj::Maybe<uint32_t> receiveWorkerFrame(SandstormRpcEventInputQueue& event,
      kj::Array<kj::byte> frame) {
    KJ_REQUIRE(frame.size() % sizeof(capnp::word) == 0,
        "worker returned a Cap'n Proto message that is not word-aligned", frame.size());
    auto words = kj::heapArray<capnp::word>(frame.size() / sizeof(capnp::word));
    memcpy(words.begin(), frame.begin(), frame.size());
    capnp::FlatArrayMessageReader reader(words.asPtr());
    auto message = reader.getRoot<capnp::rpc::Message>();
    if (message.which() == capnp::rpc::Message::CALL) {
      auto questionId = message.getCall().getQuestionId();
      callbackEvents.insert(questionId, kj::addRef(event));
    }
    kj::Maybe<uint32_t> returnedAnswer;
    if (message.which() == capnp::rpc::Message::RETURN) {
      auto answerId = message.getReturn().getAnswerId();
      returnedAnswer = answerId;
      if (callEvents.find(answerId) != kj::none) {
        returnedCallAnswers.insert(answerId, true);
      }
    }
    responses->push(kj::mv(frame));
    return returnedAnswer;
  }

  bool routeHostReturn(kj::ArrayPtr<const capnp::word> words,
      kj::ArrayPtr<const kj::byte> frame) {
    capnp::FlatArrayMessageReader reader(words);
    auto message = reader.getRoot<capnp::rpc::Message>();
    if (message.which() != capnp::rpc::Message::RETURN) return false;

    auto answerId = message.getReturn().getAnswerId();
    KJ_IF_SOME(event, callbackEvents.find(answerId)) {
      auto eventRef = kj::addRef(*event);
      callbackEvents.erase(answerId);
      return eventRef->push(kj::heapArray(frame));
    }
    return false;
  }

  void registerCallEvent(uint32_t questionId,
      SandstormRpcEventInputQueue& inputQueue,
      SandstormRpcEventControl& control) {
    KJ_REQUIRE(callEvents.find(questionId) == kj::none,
        "duplicate active worker RPC question", questionId);
    callEvents.insert(questionId, kj::addRef(inputQueue));
    callEventControls.insert(questionId, kj::addRef(control));
  }

  kj::Maybe<kj::Promise<void>> routeHostFinish(kj::ArrayPtr<const capnp::word> words,
      kj::ArrayPtr<const kj::byte> frame) {
    capnp::FlatArrayMessageReader reader(words);
    auto message = reader.getRoot<capnp::rpc::Message>();
    if (message.which() != capnp::rpc::Message::FINISH) return kj::none;

    auto questionId = message.getFinish().getQuestionId();
    KJ_IF_SOME(event, callEvents.find(questionId)) {
      auto eventRef = kj::addRef(*event);
      auto controlRef = kj::addRef(*KJ_REQUIRE_NONNULL(callEventControls.find(questionId)));
      callEvents.erase(questionId);
      callEventControls.erase(questionId);
      if (returnedCallAnswers.erase(questionId)) {
        // A normal Finish may arrive while the completed method's waitUntil() work is still
        // issuing callbacks. Do not serialize those callback Returns behind event completion.
        // Schedule Finish as its own protocol-control event; the answer has already returned, so
        // this cannot abort application code in a foreign IoContext.
        return kj::none;
      }
      // Finish must run in the same workerd IoContext as the Call. In particular, aborting an
      // AbortController created by one request from a second custom event is prohibited by
      // workerd's request-context isolation. The original event is already waiting on this queue
      // for callback traffic, so deliver Finish there too. Handling it settles the answer and
      // lets that event return. Hold the MessageStream write until the event closes so a later
      // Call cannot overtake its cancellation cleanup.
      auto completion = eventRef->whenClosed();
      if (controlRef->hasStarted()) {
        if (!eventRef->push(kj::heapArray(frame))) {
          // A normal Finish commonly arrives after the Call has returned and its input queue has
          // closed. Fall through so MessageStream schedules the Finish as a protocol-control
          // event. The JS dispatcher handles it without invoking an application server method.
          // This is required before KJ may safely reuse the question ID on a long-lived broker.
          return kj::none;
        }
      } else {
        // A promise-pipelined Call can wait for its target answer before it is dispatched. It has
        // no JS AbortController yet, so cancellation closes it without starting a throwaway event.
        controlRef->cancel();
        eventRef->close();
      }
      return kj::mv(completion);
    }
    return kj::none;
  }

  void close() {
    for (auto& entry: callbackEvents) {
      entry.value->close();
    }
    callbackEvents.clear();
    for (auto& entry: callEvents) {
      entry.value->close();
    }
    for (auto& entry: callEventControls) {
      entry.value->cancel();
    }
    callEvents.clear();
    callEventControls.clear();
    returnedCallAnswers.clear();
    responses->close();
  }

 private:
  kj::Own<WorkerRpcResponseQueue> responses;
  kj::HashMap<uint32_t, kj::Own<SandstormRpcEventInputQueue>> callbackEvents;
  kj::HashMap<uint32_t, kj::Own<SandstormRpcEventInputQueue>> callEvents;
  kj::HashMap<uint32_t, kj::Own<SandstormRpcEventControl>> callEventControls;
  kj::HashMap<uint32_t, bool> returnedCallAnswers;
};

class WorkerRpcMessageStream final: public capnp::MessageStream,
                                   private kj::TaskSet::ErrorHandler {
 public:
  explicit WorkerRpcMessageStream(kj::Rc<HostedState> state)
      : state(kj::mv(state)), router(kj::refcounted<WorkerRpcFrameRouter>()), tasks(*this) {}

  kj::Promise<kj::Maybe<capnp::MessageReaderAndFds>> tryReadMessage(
      kj::ArrayPtr<kj::AutoCloseFd> fdSpace,
      capnp::ReaderOptions options,
      kj::ArrayPtr<capnp::word>) override {
    KJ_REQUIRE(fdSpace.size() == 0, "worker RPC connections do not carry file descriptors");
    return router->read(options);
  }

  kj::Promise<void> writeMessage(kj::ArrayPtr<const int> fds,
      kj::ArrayPtr<const kj::ArrayPtr<const capnp::word>> segments) override {
    KJ_REQUIRE(fds.size() == 0, "worker RPC connections do not carry file descriptors");
    return sendMessage(capnp::messageToFlatArray(segments));
  }

  kj::Promise<void> writeMessages(
      kj::ArrayPtr<kj::ArrayPtr<const kj::ArrayPtr<const capnp::word>>> messages) override {
    kj::Promise<void> result = kj::READY_NOW;
    for (auto message: messages) {
      auto words = capnp::messageToFlatArray(message);
      result = result.then([this, words = kj::mv(words)]() mutable {
        return sendMessage(kj::mv(words));
      });
    }
    return result;
  }

  kj::Maybe<int> getSendBufferSize() override { return kj::none; }

  kj::Promise<void> end() override {
    close();
    return kj::READY_NOW;
  }

  void close() {
    router->close();
    for (auto& entry: deferredCalls) {
      for (auto& event: entry.value) {
        event.inputQueue->close();
        event.control->cancel();
      }
    }
    deferredCalls.clear();
    deferredCallCount = 0;
    unresolvedAnswers.clear();
  }

 private:
  struct PendingWorkerRpcEvent {
    kj::Array<kj::byte> bytes;
    kj::Own<SandstormRpcEventInputQueue> inputQueue;
    kj::Own<SandstormRpcEventControl> control;
    kj::Maybe<uint32_t> answerId;
  };

  void taskFailed(kj::Exception&& exception) override {
    KJ_LOG(ERROR, "worker RPC event failed", exception);
    router->close();
  }

  void answerSettled(uint32_t answerId) {
    if (unresolvedAnswers.find(answerId) == kj::none) return;
    unresolvedAnswers.erase(answerId);

    KJ_IF_SOME(events, deferredCalls.find(answerId)) {
      KJ_ASSERT(deferredCallCount >= events.size());
      deferredCallCount -= events.size();
      auto readyEvents = kj::mv(events);
      deferredCalls.erase(answerId);
      for (auto& event: readyEvents) {
        scheduleEvent(kj::mv(event));
      }
    }
  }

  void receiveWorkerFrame(SandstormRpcEventInputQueue& event,
      kj::Array<kj::byte> frame) {
    KJ_IF_SOME(answerId, router->receiveWorkerFrame(event, kj::mv(frame))) {
      // A promised-answer target must not be dispatched until capnp-es has completed the parent
      // answer. Deferring in the native host means the child still runs as its own workerd event,
      // rather than being flushed synchronously under the parent's IoContext by capnp-es.
      answerSettled(answerId);
    }
  }

  void scheduleEvent(PendingWorkerRpcEvent event) {
    if (event.control->wasCanceled()) {
      event.inputQueue->close();
      KJ_IF_SOME(answerId, event.answerId) {
        answerSettled(answerId);
      }
      return;
    }

    auto answerId = event.answerId;
    auto control = kj::addRef(*event.control);
    auto eventTask = dispatchWorkerRpcEvent(state.addRef(), kj::mv(event.bytes),
        [this, inputQueue = kj::addRef(*event.inputQueue)](
            kj::Array<kj::byte> response) mutable {
      receiveWorkerFrame(*inputQueue, kj::mv(response));
    }, kj::mv(event.inputQueue), kj::mv(event.control));

    eventTask = eventTask.then([this, answerId]() mutable -> kj::Promise<void> {
      KJ_IF_SOME(id, answerId) {
        answerSettled(id);
      }
      return kj::READY_NOW;
    }, [this, answerId, control = kj::mv(control)](kj::Exception&& exception) mutable
        -> kj::Promise<void> {
      KJ_IF_SOME(id, answerId) {
        answerSettled(id);
      }
      if (control->wasCanceled()) return kj::READY_NOW;
      return kj::mv(exception);
    });
    tasks.add(kj::mv(eventTask));
  }

  kj::Promise<void> sendMessage(kj::Array<capnp::word> words) {
    auto bytes = kj::heapArray<kj::byte>(words.asBytes());
    capnp::FlatArrayMessageReader reader(words.asPtr());
    auto message = reader.getRoot<capnp::rpc::Message>();
    if (message.which() == capnp::rpc::Message::RETURN &&
        router->routeHostReturn(words.asPtr(), bytes.asPtr())) {
      return kj::READY_NOW;
    }
    if (message.which() == capnp::rpc::Message::FINISH) {
      KJ_IF_SOME(completion, router->routeHostFinish(words.asPtr(), bytes.asPtr())) {
        return kj::mv(completion);
      }
    }

    auto inputQueue = kj::refcounted<SandstormRpcEventInputQueue>();
    auto eventControl = kj::refcounted<SandstormRpcEventControl>();
    bool isCall = message.which() == capnp::rpc::Message::CALL;
    kj::Maybe<uint32_t> answerId;
    if (isCall) {
      answerId = message.getCall().getQuestionId();
      router->registerCallEvent(
          KJ_ASSERT_NONNULL(answerId), *inputQueue, *eventControl);
    } else if (message.which() == capnp::rpc::Message::BOOTSTRAP) {
      answerId = message.getBootstrap().getQuestionId();
    }
    KJ_IF_SOME(id, answerId) {
      KJ_REQUIRE(unresolvedAnswers.find(id) == kj::none,
          "duplicate unresolved worker RPC question", id);
      unresolvedAnswers.insert(id, true);
    }

    PendingWorkerRpcEvent event{
      kj::mv(bytes), kj::mv(inputQueue), kj::mv(eventControl), answerId
    };

    if (isCall) {
      auto target = message.getCall().getTarget();
      if (target.which() == capnp::rpc::MessageTarget::PROMISED_ANSWER) {
        auto parentId = target.getPromisedAnswer().getQuestionId();
        if (unresolvedAnswers.find(parentId) != kj::none) {
          KJ_REQUIRE(deferredCallCount < MAX_DEFERRED_RPC_CALLS,
              "too many deferred worker RPC calls", deferredCallCount,
              MAX_DEFERRED_RPC_CALLS);
          KJ_IF_SOME(events, deferredCalls.find(parentId)) {
            KJ_REQUIRE(events.size() < MAX_DEFERRED_RPC_CALLS_PER_ANSWER,
                "too many worker RPC calls pipelined on one answer", parentId,
                events.size(), MAX_DEFERRED_RPC_CALLS_PER_ANSWER);
            events.add(kj::mv(event));
          } else {
            kj::Vector<PendingWorkerRpcEvent> events;
            events.add(kj::mv(event));
            deferredCalls.insert(parentId, kj::mv(events));
          }
          ++deferredCallCount;
          return kj::READY_NOW;
        }
      }
    }

    // Cap'n Proto serializes MessageStream writes until the returned promise resolves. An
    // incoming worker Call can itself issue a callback whose Return must be written while the
    // original event is still pending, so acknowledge the frame after scheduling its event and
    // retain the event separately for the connection lifetime.
    scheduleEvent(kj::mv(event));
    return kj::READY_NOW;
  }

  kj::Rc<HostedState> state;
  kj::Own<WorkerRpcFrameRouter> router;
  kj::TaskSet tasks;
  kj::HashMap<uint32_t, bool> unresolvedAnswers;
  kj::HashMap<uint32_t, kj::Vector<PendingWorkerRpcEvent>> deferredCalls;
  size_t deferredCallCount = 0;
};

class WorkerRpcConnection final {
 public:
  explicit WorkerRpcConnection(kj::Rc<HostedState> state)
      : stream(kj::mv(state)),
        network(stream, capnp::rpc::twoparty::Side::CLIENT),
        rpcSystem(capnp::makeRpcClient(network)) {}

  ~WorkerRpcConnection() noexcept { stream.close(); }

  capnp::Capability::Client bootstrap() {
    capnp::word scratch[4] = {};
    capnp::MallocMessageBuilder message(scratch);
    auto vatId = message.getRoot<capnp::rpc::twoparty::VatId>();
    vatId.setSide(capnp::rpc::twoparty::Side::SERVER);
    return rpcSystem.bootstrap(vatId);
  }

 private:
  WorkerRpcMessageStream stream;
  capnp::TwoPartyVatNetwork network;
  capnp::RpcSystem<capnp::rpc::twoparty::VatId> rpcSystem;
};

HostedState::HostedState(workerd::server::Server& runtime,
    kj::String grainId,
    IsolateBindingServices::Client bindingServices,
    kj::Own<BundleBacking> backing,
    kj::Own<workerd::WorkerStubChannel> worker)
    : runtime(runtime), grainId(kj::mv(grainId)),
      bindingServices(kj::mv(bindingServices)), backing(kj::mv(backing)),
      worker(kj::mv(worker)) {}

HostedState::~HostedState() noexcept = default;

void HostedState::stop() {
  if (!running) return;
  if (!idleTimerCanceler.isEmpty()) {
    idleTimerCanceler.cancel("hosted isolate stopped");
  }
  rpcConnection = kj::none;
  runtime.evictDynamicWorker(LOADER_NAMESPACE, grainId);
  bindingServices = IsolateBindingServices::Client(nullptr);
  worker = nullptr;
  backing = nullptr;
  running = false;
}

class HostedIsolateImpl final: public HostedIsolate::Server {
 public:
  HostedIsolateImpl(kj::Rc<HostedState> state,
      kj::Function<void(kj::Rc<HostedState>)> refreshIdleTimer)
      : state(kj::mv(state)), refreshIdleTimer(kj::mv(refreshIdleTimer)) {}

  kj::Promise<void> keepAlive(KeepAliveContext context) override {
    KJ_REQUIRE(state->running, "hosted isolate has been stopped");
    refreshIdleTimer(state.addRef());
    return kj::READY_NOW;
  }

  kj::Promise<void> stop(StopContext context) override {
    state->stop();
    return kj::READY_NOW;
  }

  kj::Promise<void> getRpcBootstrap(GetRpcBootstrapContext context) override {
    KJ_REQUIRE(state->running, "hosted isolate has been stopped");
    context.getResults().setCap(rpcBootstrap());
    return kj::READY_NOW;
  }

  kj::Promise<void> getExport(GetExportContext context) override {
    KJ_REQUIRE(state->running, "hosted isolate has been stopped");
    auto name = context.getParams().getName();
    auto interfaceId = context.getParams().getInterfaceId();
    bool declared = false;
    for (auto& workerExport: state->backing->decoded->exports) {
      if (workerExport.name == name && workerExport.interfaceId == interfaceId) {
        declared = true;
        break;
      }
    }
    KJ_REQUIRE(declared, "worker export was not declared with this interface ID", name,
        kj::hex(interfaceId));

    auto request = rpcBootstrap().castAs<IsolateExportBroker>().getExportRequest();
    request.setName(name);
    request.setInterfaceId(interfaceId);
    request.setPlatform(state->bindingServices.getBridgeRequest().send().getBridge());
    return request.send().then([context](auto response) mutable {
      context.getResults().setCap(response.getCap());
    });
  }

 private:
  capnp::Capability::Client rpcBootstrap() {
    KJ_IF_SOME(connection, state->rpcConnection) {
      return connection->bootstrap();
    } else {
      auto connection = kj::heap<WorkerRpcConnection>(state.addRef());
      auto result = connection->bootstrap();
      state->rpcConnection = kj::mv(connection);
      return result;
    }
  }

  kj::Rc<HostedState> state;
  kj::Function<void(kj::Rc<HostedState>)> refreshIdleTimer;
};

class IsolateHostImpl final: public IsolateHost::Server, private kj::TaskSet::ErrorHandler {
 public:
  IsolateHostImpl(workerd::server::Server& runtime,
      kj::Timer& timer,
      kj::Duration idleTimeout)
      : runtime(runtime), timer(timer),
        idleTimeout(idleTimeout), tasks(*this) {}

  ~IsolateHostImpl() noexcept {
    for (auto& entry: grains) entry.value->stop();
  }

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

      auto source = buildWorkerSource(kj::mv(decoded));
      auto backing = kj::atomicAddRef(*source.backing);
      auto worker = runtime.loadDynamicWorker(LOADER_NAMESPACE, kj::str(grainId),
          [source = kj::mv(source.source), backing = kj::mv(source.backing)]() mutable {
        return source.clone(kj::atomicAddRef(*backing));
      });
      auto state = kj::rc<HostedState>(runtime, kj::str(grainId),
          kj::mv(services), kj::mv(backing), kj::mv(worker));
      refreshIdleTimer(state.addRef());
      context.getResults().setGrain(makeHostedIsolate(state.addRef()));
      grains.insert(kj::mv(grainId), kj::mv(state));
    });
  }

 private:
  kj::Own<HostedIsolateImpl> makeHostedIsolate(kj::Rc<HostedState> state) {
    return kj::heap<HostedIsolateImpl>(kj::mv(state),
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
  workerd::server::Server runtime(*filesystem,
      io.provider->getTimer(),
      kj::systemPreciseMonotonicClock(),
      io.provider->getNetwork(),
      entropy,
      workerd::Worker::LoggingOptions(workerd::Worker::ConsoleMode::STDOUT),
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

  capnp::TwoPartyServer controlServer(
      kj::heap<sandstorm::IsolateHostImpl>(runtime,
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
