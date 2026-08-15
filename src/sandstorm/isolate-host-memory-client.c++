// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2026 Sandstorm contributors
// Licensed under the Apache License, Version 2.0.

#include "sandstorm/isolate-host.capnp.h"
#include "sandstorm/isolate-worker-source.capnp.h"

#include <capnp/compat/http-over-capnp.h>
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
  kj::Promise<void> getService(GetServiceContext) override {
    KJ_FAIL_REQUIRE("memory benchmark worker unexpectedly requested a binding service");
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
  source.setFormatVersion(1);
  source.setMainModule("main.js");
  source.setCompatibilityDate("2026-06-10");
  auto module = source.initModules(1)[0];
  module.setName("main.js");
  module.setEsModule(kj::StringPtr(R"JS(
export default { fetch() { return new Response("memory-benchmark-ready"); } };
)JS").asBytes());
  kj::VectorOutputStream sourceOutput;
  capnp::writePackedMessage(sourceOutput, sourceMessage);
  auto sourceBytes = sourceOutput.getArray();

  capnp::EzRpcClient rpc(kj::str("unix:", argv[1]));
  auto& waitScope = rpc.getWaitScope();
  auto host = rpc.getMain<sandstorm::IsolateHost>();
  sandstorm::IsolateBindingServices::Client services = kj::heap<NoBindingServices>();

  capnp::ByteStreamFactory byteStreamFactory;
  kj::HttpHeaderTable::Builder headerTableBuilder;
  capnp::HttpOverCapnpFactory httpFactory(byteStreamFactory, headerTableBuilder);
  auto headerTable = headerTableBuilder.build();
  kj::Vector<sandstorm::HostedIsolate::Client> grains(workerCount);

  for (auto i: kj::zeroTo(workerCount)) {
    auto start = host.startGrainRequest();
    start.setGrainId(kj::str("benchmark", i + 10000000));
    start.setServices(services);
    start.setWorkerSource(sourceBytes);
    auto grain = start.send().wait(waitScope).getGrain();

    auto getHttp = grain.getHttpServiceRequest().send().wait(waitScope);
    auto service = httpFactory.capnpToKj(getHttp.getService());
    auto client = kj::newHttpClient(*service);
    kj::HttpHeaders headers(*headerTable);
    auto request = client->request(kj::HttpMethod::GET, "https://grain.invalid/", headers);
    auto response = request.response.wait(waitScope);
    KJ_REQUIRE(response.statusCode == 200,
        "benchmark worker warmup failed", i, response.statusCode);
    KJ_REQUIRE(response.body->readAllText().wait(waitScope) == "memory-benchmark-ready",
        "benchmark worker warmup returned the wrong body", i);
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
