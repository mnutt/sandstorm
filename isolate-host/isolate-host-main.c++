// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2026 Sandstorm contributors
// Licensed under the Apache License, Version 2.0.

#include "server.h"
#include "v8-platform-impl.h"

#include <workerd/server/sandstorm-isolate-host.capnp.h>
#include <workerd/server/sandstorm-isolate-worker-source.capnp.h>
#include <workerd/io/compatibility-date.h>
#include <workerd/jsg/setup.h>

#include <capnp/rpc-twoparty.h>
#include <capnp/serialize-packed.h>
#include <kj/async-io.h>
#include <kj/map.h>

#include <fcntl.h>
#include <sys/random.h>
#include <sys/stat.h>
#include <unistd.h>

namespace sandstorm {
namespace {

constexpr kj::StringPtr LOADER_NAMESPACE = "sandstorm-grains"_kj;

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

struct BundleBacking final {
  kj::Own<capnp::PackedFdMessageReader> source;
  capnp::MallocMessageBuilder compatibility;
};

workerd::DynamicWorkerSource loadWorkerSource(int grainDirFd) {
  int runtimeFd;
  KJ_SYSCALL(runtimeFd = openat(grainDirFd, "isolate-runtime",
      O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
  kj::AutoCloseFd runtimeDir(runtimeFd);
  int sourceFd;
  KJ_SYSCALL(sourceFd = openat(runtimeDir, "worker-source.capnp.bin",
      O_RDONLY | O_NOFOLLOW | O_CLOEXEC));

  auto backing = kj::heap<BundleBacking>();
  backing->source = kj::heap<capnp::PackedFdMessageReader>(kj::AutoCloseFd(sourceFd));
  auto bundle = backing->source->getRoot<IsolateWorkerSource>();
  auto inputModules = bundle.getModules();
  auto modules = kj::heapArrayBuilder<workerd::WorkerSource::Module>(inputModules.size());
  for (auto input: inputModules) {
    workerd::WorkerSource::Module output{.name = input.getName()};
    switch (input.which()) {
      case IsolateWorkerSource::Module::ES_MODULE:
        output.content = workerd::WorkerSource::EsModule{input.getEsModule().asChars(), kj::none};
        break;
      case IsolateWorkerSource::Module::COMMON_JS_MODULE:
        {
        auto body = input.getCommonJsModule().asChars();
        output.content = workerd::WorkerSource::CommonJsModule{
          kj::StringPtr(body.begin(), body.size()), kj::none};
        break;
        }
      case IsolateWorkerSource::Module::TEXT:
        {
        auto body = input.getText().asChars();
        output.content = workerd::WorkerSource::TextModule{
          kj::StringPtr(body.begin(), body.size())};
        break;
        }
      case IsolateWorkerSource::Module::DATA:
        output.content = workerd::WorkerSource::DataModule{input.getData()};
        break;
      case IsolateWorkerSource::Module::WASM:
        output.content = workerd::WorkerSource::WasmModule{input.getWasm()};
        break;
      case IsolateWorkerSource::Module::JSON:
        {
        auto body = input.getJson().asChars();
        output.content = workerd::WorkerSource::JsonModule{
          kj::StringPtr(body.begin(), body.size())};
        break;
        }
    }
    modules.add(kj::mv(output));
  }

  KJ_REQUIRE(bundle.getBindings().size() == 0,
      "shared host does not yet support runtime bindings");
  auto compatibility = backing->compatibility.initRoot<workerd::CompatibilityFlags>();
  auto inputFlags = bundle.getCompatibilityFlags();
  auto flags = KJ_MAP(flag, inputFlags) { return kj::str(flag); };
  BundleErrorReporter reporter;
  workerd::compileCompatibilityFlags(bundle.getCompatibilityDate(), flags, compatibility,
      reporter, true, workerd::CompatibilityDateValidation::CODE_VERSION);
  reporter.requireValid();

  workerd::WorkerSource source(workerd::WorkerSource::ModulesSource{
    .mainModule = bundle.getMainModule(),
    .modules = modules.finish(),
    .capnpSchemas = {},
    .isPython = false,
    .pythonMemorySnapshot = kj::none,
  });
  return {
    .source = kj::mv(source),
    .compatibilityFlags = compatibility.asReader(),
    .limits = kj::none,
    .env = workerd::Frankenvalue(),
    .globalOutbound = kj::none,
    .tails = {},
    .streamingTails = {},
    .ownContent = kj::mv(backing),
    .ownContentIsRpcResponse = false,
  };
}

void initRuntimeConfig(capnp::MallocMessageBuilder& message) {
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

  // Server::run() lives for the lifetime of its listeners. Keep one loopback-only listener so
  // the embedded runtime remains active; Sandstorm traffic never enters through this socket.
  auto socket = config.initSockets(1)[0];
  socket.setName("loader-bootstrap");
  socket.setAddress("127.0.0.1:0");
  socket.initHttp();
  socket.getService().setName("sandstorm-loader-bootstrap");
}

bool isValidGrainId(kj::StringPtr id) {
  return id.size() >= 8 && !id.startsWith(".") && id.findFirst('/') == kj::none;
}

struct HostedState final: public kj::Refcounted {
  HostedState(workerd::server::Server& runtime,
      kj::String grainId,
      int grainDirFd,
      kj::Own<workerd::WorkerStubChannel> worker)
      : runtime(runtime), grainId(kj::mv(grainId)), grainDirFd(grainDirFd),
        worker(kj::mv(worker)) {}

  ~HostedState() noexcept { close(grainDirFd); }

  workerd::server::Server& runtime;
  kj::String grainId;
  int grainDirFd;
  kj::Own<workerd::WorkerStubChannel> worker;
  bool running = true;
};

class HostedIsolateImpl final: public HostedIsolate::Server {
 public:
  explicit HostedIsolateImpl(kj::Rc<HostedState> state): state(kj::mv(state)) {}

  kj::Promise<void> keepAlive(KeepAliveContext context) override {
    KJ_REQUIRE(state->running, "hosted isolate has been stopped");
    return kj::READY_NOW;
  }

  kj::Promise<void> stop(StopContext context) override {
    state->runtime.evictDynamicWorker(LOADER_NAMESPACE, state->grainId);
    state->running = false;
    return kj::READY_NOW;
  }

 private:
  kj::Rc<HostedState> state;
};

class IsolateHostImpl final: public IsolateHost::Server {
 public:
  IsolateHostImpl(workerd::server::Server& runtime, int grainRootFd)
      : runtime(runtime), grainRootFd(grainRootFd) {}

  ~IsolateHostImpl() noexcept { close(grainRootFd); }

  kj::Promise<void> startGrain(StartGrainContext context) override {
    auto grainId = context.getParams().getGrainId();
    KJ_REQUIRE(isValidGrainId(grainId), "invalid grain ID");

    auto& state = grains.findOrCreate(grainId, [&]() -> decltype(grains)::Entry {
      int grainFd;
      KJ_SYSCALL(grainFd = openat(grainRootFd, grainId.cStr(),
          O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC), grainId);
      kj::AutoCloseFd grainDir(grainFd);

      int runtimeFd;
      KJ_SYSCALL(runtimeFd = openat(grainDir, "isolate-runtime",
          O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC), grainId);
      kj::AutoCloseFd runtimeDir(runtimeFd);

      int manifestFd;
      KJ_SYSCALL(manifestFd = openat(runtimeDir, "runtime-manifest.json",
          O_RDONLY | O_NOFOLLOW | O_CLOEXEC), grainId);
      kj::AutoCloseFd manifest(manifestFd);
      struct stat manifestStat;
      KJ_SYSCALL(fstat(manifest, &manifestStat), grainId);
      KJ_REQUIRE(S_ISREG(manifestStat.st_mode), "runtime manifest is not a regular file", grainId);

      auto ownedGrainId = kj::heapString(grainId);
      auto source = loadWorkerSource(grainDir.get());
      auto worker = runtime.loadDynamicWorker(LOADER_NAMESPACE, kj::str(grainId),
          [source = kj::mv(source)]() mutable { return kj::mv(source); });
      return {kj::heapString(grainId),
        kj::rc<HostedState>(runtime, kj::mv(ownedGrainId), grainDir.release(), kj::mv(worker))};
    });
    state->running = true;
    context.getResults().setGrain(kj::heap<HostedIsolateImpl>(state.addRef()));
    return kj::READY_NOW;
  }

 private:
  workerd::server::Server& runtime;
  int grainRootFd;
  kj::HashMap<kj::String, kj::Rc<HostedState>> grains;
};

}  // namespace
}  // namespace sandstorm

int main(int argc, char** argv) {
  KJ_REQUIRE(argc == 3, "usage: isolate-host <control-socket-path> <grain-root-path>");
  int grainRootFd;
  KJ_SYSCALL(grainRootFd = open(argv[2], O_RDONLY | O_DIRECTORY | O_CLOEXEC), argv[2]);
  auto address = kj::str("unix:", argv[1]);
  unlink(argv[1]);
  auto io = kj::setupAsyncIo();
  auto parsed = io.provider->getNetwork().parseAddress(address, 0).wait(io.waitScope);
  auto listener = parsed->listen();

  auto filesystem = kj::newDiskFilesystem();
  sandstorm::SystemEntropySource entropy;
  auto defaultPlatform = workerd::jsg::defaultPlatform(0);
  workerd::server::WorkerdPlatform v8Platform(*defaultPlatform);
  workerd::jsg::V8System v8System(v8Platform, {}, defaultPlatform.get());
  workerd::server::Server runtime(*filesystem,
      io.provider->getTimer(),
      kj::systemPreciseMonotonicClock(),
      io.provider->getNetwork(),
      entropy,
      workerd::Worker::LoggingOptions(workerd::Worker::ConsoleMode::STDOUT),
      [](kj::String error) { KJ_FAIL_REQUIRE("embedded workerd configuration error", error); });
  runtime.allowExperimental();
  capnp::MallocMessageBuilder runtimeConfig;
  sandstorm::initRuntimeConfig(runtimeConfig);
  auto runtimeTask = runtime.run(v8System, runtimeConfig.getRoot<workerd::server::config::Config>())
      .eagerlyEvaluate([](kj::Exception&& error) {
    KJ_LOG(FATAL, "embedded workerd runtime failed", error);
  });
  KJ_REQUIRE(!runtimeTask.poll(io.waitScope), "embedded workerd runtime stopped during startup");

  capnp::TwoPartyServer controlServer(
      kj::heap<sandstorm::IsolateHostImpl>(runtime, grainRootFd));
  controlServer.listen(*listener).exclusiveJoin(kj::mv(runtimeTask)).wait(io.waitScope);
}
