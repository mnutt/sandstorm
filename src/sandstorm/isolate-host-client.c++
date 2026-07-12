// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2026 Sandstorm contributors
// Licensed under the Apache License, Version 2.0.

#include "isolate-host.capnp.h"
#include "isolate-worker-source.capnp.h"

#include <capnp/ez-rpc.h>
#include <capnp/message.h>
#include <capnp/serialize-packed.h>
#include <kj/debug.h>
#include <kj/function.h>

#include <fcntl.h>
#include <unistd.h>

namespace sandstorm {
namespace {

void expectFailure(kj::Function<void()> operation) {
  auto exception = kj::runCatchingExceptions(kj::mv(operation));
  KJ_REQUIRE(exception != nullptr, "host operation unexpectedly succeeded");
}

}  // namespace
}  // namespace sandstorm

int main(int argc, char** argv) {
  KJ_REQUIRE(argc == 3, "usage: isolate-host-client <control-socket-path> <grain-root-path>");
  capnp::MallocMessageBuilder sourceMessage;
  auto source = sourceMessage.initRoot<sandstorm::IsolateWorkerSource>();
  source.setMainModule("main.js");
  source.setCompatibilityDate("2026-06-10");
  auto module = source.initModules(1)[0];
  module.setName("main.js");
  auto script = kj::StringPtr("export default { fetch() { return new Response('ok'); } };");
  module.setEsModule(script.asBytes());
  auto sourcePath = kj::str(argv[2], "/testgrain123/isolate-runtime/worker-source.capnp.bin");
  int sourceFd;
  KJ_SYSCALL(sourceFd = open(sourcePath.cStr(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600));
  capnp::writePackedMessageToFd(sourceFd, sourceMessage);
  close(sourceFd);
  capnp::EzRpcClient rpc(kj::str("unix:", argv[1]));
  auto& waitScope = rpc.getWaitScope();
  auto host = rpc.getMain<sandstorm::IsolateHost>();

  auto start = host.startGrainRequest();
  start.setGrainId("testgrain123");
  auto grain = start.send().wait(waitScope).getGrain();
  grain.keepAliveRequest().send().wait(waitScope);
  grain.stopRequest().send().wait(waitScope);

  sandstorm::expectFailure([&]() {
    grain.keepAliveRequest().send().wait(waitScope);
  });

  auto restart = host.startGrainRequest();
  restart.setGrainId("testgrain123");
  auto restartedGrain = restart.send().wait(waitScope).getGrain();
  restartedGrain.keepAliveRequest().send().wait(waitScope);
  sandstorm::expectFailure([&]() {
    grain.keepAliveRequest().send().wait(waitScope);
  });
  restartedGrain.stopRequest().send().wait(waitScope);
  sandstorm::expectFailure([&]() {
    auto invalid = host.startGrainRequest();
    invalid.setGrainId("../escape");
    invalid.send().wait(waitScope);
  });
  sandstorm::expectFailure([&]() {
    auto symlink = host.startGrainRequest();
    symlink.setGrainId("linkgrain123");
    symlink.send().wait(waitScope);
  });
  sandstorm::expectFailure([&]() {
    auto incomplete = host.startGrainRequest();
    incomplete.setGrainId("missingmanifest");
    incomplete.send().wait(waitScope);
  });
  sandstorm::expectFailure([&]() {
    auto incomplete = host.startGrainRequest();
    incomplete.setGrainId("missingsource");
    incomplete.send().wait(waitScope);
  });

  return 0;
}
