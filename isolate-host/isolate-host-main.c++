// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2026 Sandstorm contributors
// Licensed under the Apache License, Version 2.0.

#include "server.h"

#include <workerd/server/sandstorm-isolate-host.capnp.h>

#include <capnp/rpc-twoparty.h>
#include <kj/async-io.h>
#include <kj/map.h>

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

namespace sandstorm {
namespace {

bool isValidGrainId(kj::StringPtr id) {
  return id.size() >= 8 && !id.startsWith(".") && id.findFirst('/') == kj::none;
}

struct HostedState final: public kj::Refcounted {
  explicit HostedState(int grainDirFd): grainDirFd(grainDirFd) {}

  ~HostedState() noexcept { close(grainDirFd); }

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
    state->running = false;
    return kj::READY_NOW;
  }

 private:
  kj::Rc<HostedState> state;
};

class IsolateHostImpl final: public IsolateHost::Server {
 public:
  explicit IsolateHostImpl(int grainRootFd): grainRootFd(grainRootFd) {}

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

      return {kj::heapString(grainId), kj::rc<HostedState>(grainDir.release())};
    });
    state->running = true;
    context.getResults().setGrain(kj::heap<HostedIsolateImpl>(state.addRef()));
    return kj::READY_NOW;
  }

 private:
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
  capnp::TwoPartyServer server(kj::heap<sandstorm::IsolateHostImpl>(grainRootFd));
  server.listen(*listener).wait(io.waitScope);
}
