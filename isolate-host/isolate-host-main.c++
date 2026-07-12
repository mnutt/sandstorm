// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2026 Sandstorm contributors
// Licensed under the Apache License, Version 2.0.

#include "server.h"
#include "v8-platform-impl.h"

#include <workerd/server/sandstorm-isolate-host.capnp.h>
#include <workerd/jsg/setup.h>

#include <capnp/rpc-twoparty.h>
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
  HostedState(workerd::server::Server& runtime, kj::String grainId, int grainDirFd)
      : runtime(runtime), grainId(kj::mv(grainId)), grainDirFd(grainDirFd) {}

  ~HostedState() noexcept { close(grainDirFd); }

  workerd::server::Server& runtime;
  kj::String grainId;
  int grainDirFd;
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
      return {kj::heapString(grainId),
        kj::rc<HostedState>(runtime, kj::mv(ownedGrainId), grainDir.release())};
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
