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

class BindingServicesImpl final: public IsolateBindingServices::Server {};

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
  auto bindings = source.initBindings(3);
  bindings[0].setName("MESSAGE");
  bindings[0].setText(kj::StringPtr("hello").asBytes());
  bindings[1].setName("SETTINGS");
  bindings[1].setJson(kj::StringPtr("{\"enabled\":true}").asBytes());
  bindings[2].setName("STORAGE");
  bindings[2].setStorage();
  auto sourcePath = kj::str(argv[2], "/testgrain123/isolate-runtime/worker-source.capnp.bin");
  int sourceFd;
  KJ_SYSCALL(sourceFd = open(sourcePath.cStr(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600));
  capnp::writePackedMessageToFd(sourceFd, sourceMessage);
  close(sourceFd);

  capnp::MallocMessageBuilder invalidMessage;
  auto invalidSource = invalidMessage.initRoot<sandstorm::IsolateWorkerSource>();
  invalidSource.setMainModule("main.js");
  invalidSource.setCompatibilityDate("2026-06-10");
  auto invalidModule = invalidSource.initModules(1)[0];
  invalidModule.setName("main.js");
  invalidModule.setEsModule(script.asBytes());
  auto invalidBinding = invalidSource.initBindings(1)[0];
  invalidBinding.setName("BROKEN");
  invalidBinding.setJson(kj::StringPtr("{not-json}").asBytes());
  auto invalidPath = kj::str(argv[2], "/invalidjson/isolate-runtime/worker-source.capnp.bin");
  int invalidFd;
  KJ_SYSCALL(invalidFd = open(
      invalidPath.cStr(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600));
  capnp::writePackedMessageToFd(invalidFd, invalidMessage);
  close(invalidFd);
  capnp::EzRpcClient rpc(kj::str("unix:", argv[1]));
  auto& waitScope = rpc.getWaitScope();
  auto host = rpc.getMain<sandstorm::IsolateHost>();
  sandstorm::IsolateBindingServices::Client services =
      kj::heap<sandstorm::BindingServicesImpl>();

  auto start = host.startGrainRequest();
  start.setGrainId("testgrain123");
  start.setServices(services);
  auto grain = start.send().wait(waitScope).getGrain();
  grain.keepAliveRequest().send().wait(waitScope);
  grain.stopRequest().send().wait(waitScope);

  sandstorm::expectFailure([&]() {
    grain.keepAliveRequest().send().wait(waitScope);
  });

  auto restart = host.startGrainRequest();
  restart.setGrainId("testgrain123");
  restart.setServices(services);
  auto restartedGrain = restart.send().wait(waitScope).getGrain();
  restartedGrain.keepAliveRequest().send().wait(waitScope);
  sandstorm::expectFailure([&]() {
    grain.keepAliveRequest().send().wait(waitScope);
  });
  restartedGrain.stopRequest().send().wait(waitScope);
  sandstorm::expectFailure([&]() {
    auto invalid = host.startGrainRequest();
    invalid.setGrainId("../escape");
    invalid.setServices(services);
    invalid.send().wait(waitScope);
  });
  sandstorm::expectFailure([&]() {
    auto symlink = host.startGrainRequest();
    symlink.setGrainId("linkgrain123");
    symlink.setServices(services);
    symlink.send().wait(waitScope);
  });
  sandstorm::expectFailure([&]() {
    auto incomplete = host.startGrainRequest();
    incomplete.setGrainId("missingmanifest");
    incomplete.setServices(services);
    incomplete.send().wait(waitScope);
  });
  sandstorm::expectFailure([&]() {
    auto incomplete = host.startGrainRequest();
    incomplete.setGrainId("missingsource");
    incomplete.setServices(services);
    incomplete.send().wait(waitScope);
  });
  sandstorm::expectFailure([&]() {
    auto invalid = host.startGrainRequest();
    invalid.setGrainId("invalidjson");
    invalid.setServices(services);
    invalid.send().wait(waitScope);
  });

  return 0;
}
