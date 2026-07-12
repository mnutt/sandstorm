// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2026 Sandstorm contributors
// Licensed under the Apache License, Version 2.0.

#include "isolate-host.capnp.h"

#include <capnp/ez-rpc.h>
#include <kj/debug.h>
#include <kj/function.h>

namespace sandstorm {
namespace {

void expectFailure(kj::Function<void()> operation) {
  auto exception = kj::runCatchingExceptions(kj::mv(operation));
  KJ_REQUIRE(exception != nullptr, "host operation unexpectedly succeeded");
}

}  // namespace
}  // namespace sandstorm

int main(int argc, char** argv) {
  KJ_REQUIRE(argc == 2, "usage: isolate-host-client <control-socket-path>");
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
  sandstorm::expectFailure([&]() {
    auto invalid = host.startGrainRequest();
    invalid.setGrainId("../escape");
    invalid.send().wait(waitScope);
  });

  return 0;
}
