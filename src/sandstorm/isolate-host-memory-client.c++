// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2026 Sandstorm contributors
// Licensed under the Apache License, Version 2.0.

#include "isolate-host.capnp.h"
#include "isolate-worker-source.capnp.h"

#include <capnp/ez-rpc.h>
#include <capnp/message.h>
#include <capnp/serialize-packed.h>
#include <kj/debug.h>

#include <cerrno>
#include <climits>
#include <cstdio>
#include <cstdlib>
#include <unistd.h>

namespace {

class NoBindingServices final: public sandstorm::IsolateBindingServices::Server {
 public:
  kj::Promise<void> getBridge(GetBridgeContext context) override {
    context.getResults().setBridge(capnp::Capability::Client(nullptr));
    return kj::READY_NOW;
  }
};

}  // namespace

int main(int argc, char** argv) {
  KJ_REQUIRE(argc == 3, "usage: isolate-host-memory-client <control-socket-path> <worker-count>");

  char* end = nullptr;
  errno = 0;
  auto parsedCount = strtoul(argv[2], &end, 10);
  KJ_REQUIRE(errno == 0 && end != argv[2] && *end == '\0' &&
          parsedCount > 0 && parsedCount <= 256,
      "invalid worker count", argv[2]);
  auto workerCount = static_cast<uint>(parsedCount);

  capnp::MallocMessageBuilder sourceMessage;
  auto source = sourceMessage.initRoot<sandstorm::IsolateWorkerSource>();
  source.setFormatVersion(2);
  source.setMainModule("main.js");
  source.setCompatibilityDate("2026-06-10");
  auto module = source.initModules(1)[0];
  module.setName("main.js");
  module.setEsModule(kj::StringPtr(R"JS(
export default {};
)JS").asBytes());
  kj::VectorOutputStream sourceOutput;
  capnp::writePackedMessage(sourceOutput, sourceMessage);
  auto sourceBytes = sourceOutput.getArray();

  capnp::EzRpcClient rpc(kj::str("unix:", argv[1]));
  auto& waitScope = rpc.getWaitScope();
  auto host = rpc.getMain<sandstorm::IsolateHost>();
  sandstorm::IsolateBindingServices::Client services = kj::heap<NoBindingServices>();

  kj::Vector<sandstorm::HostedIsolate::Client> grains(workerCount);

  for (auto i: kj::zeroTo(workerCount)) {
    auto start = host.startGrainRequest();
    start.setGrainId(kj::str("benchmark", i + 10000000));
    start.setServices(services);
    start.setWorkerSource(sourceBytes);
    auto grain = start.send().wait(waitScope).getGrain();

    grain.keepAliveRequest().send().wait(waitScope);
    grains.add(kj::mv(grain));
  }

  fputs("READY\n", stdout);
  fflush(stdout);
  char ignored;
  while (read(STDIN_FILENO, &ignored, 1) < 0 && errno == EINTR) {}

  for (auto& grain: grains) {
    grain.stopRequest().send().wait(waitScope);
  }
  return 0;
}
