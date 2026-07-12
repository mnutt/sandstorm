// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2026 Sandstorm contributors
// Licensed under the Apache License, Version 2.0.

#include "isolate-host.capnp.h"
#include "isolate-worker-source.capnp.h"

#include <capnp/ez-rpc.h>
#include <capnp/compat/http-over-capnp.h>
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
  source.setFormatVersion(1);
  source.setMainModule("main.js");
  source.setCompatibilityDate("2026-06-10");
  auto module = source.initModules(1)[0];
  module.setName("main.js");
  auto script = kj::StringPtr(R"JS(
export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/storage-test") {
      if (request.headers.get("X-Sandstorm-Ingress-Test") !== "ingress-ok") {
        return new Response("missing ingress header", { status: 400 });
      }
      const put = await env.STORAGE.fetch("http://storage/shared-host-test", {
        method: "PUT",
        body: "shared-storage-ok",
      });
      if (!put.ok) return new Response(`storage PUT failed: ${put.status}`, { status: 500 });
      const get = await env.STORAGE.fetch("http://storage/shared-host-test");
      const headers = new Headers(get.headers);
      headers.set("X-Sandstorm-Egress-Test", "egress-ok");
      return new Response(get.body, { status: get.status, headers });
    }
    return new Response("ok");
  },
};
)JS");
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
  invalidSource.setFormatVersion(1);
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

  source.setFormatVersion(2);
  auto unsupportedPath = kj::str(
      argv[2], "/unsupportedversion/isolate-runtime/worker-source.capnp.bin");
  int unsupportedFd;
  KJ_SYSCALL(unsupportedFd = open(
      unsupportedPath.cStr(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600));
  capnp::writePackedMessageToFd(unsupportedFd, sourceMessage);
  close(unsupportedFd);

  auto oversizedPath = kj::str(
      argv[2], "/oversizedbundle/isolate-runtime/worker-source.capnp.bin");
  int oversizedFd;
  KJ_SYSCALL(oversizedFd = open(
      oversizedPath.cStr(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600));
  KJ_SYSCALL(ftruncate(oversizedFd, 16 * 1024 * 1024 + 1));
  close(oversizedFd);
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

  capnp::ByteStreamFactory byteStreamFactory;
  kj::HttpHeaderTable::Builder headerTableBuilder;
  capnp::HttpOverCapnpFactory httpFactory(byteStreamFactory, headerTableBuilder);
  auto ingressTestHeader = headerTableBuilder.add("X-Sandstorm-Ingress-Test");
  auto egressTestHeader = headerTableBuilder.add("X-Sandstorm-Egress-Test");
  auto headerTable = headerTableBuilder.build();
  auto getHttp = grain.getHttpServiceRequest().send().wait(waitScope);
  auto service = httpFactory.capnpToKj(getHttp.getService());
  auto httpClient = kj::newHttpClient(*service);
  kj::HttpHeaders requestHeaders(*headerTable);
  requestHeaders.set(ingressTestHeader, "ingress-ok"_kj);
  auto httpRequest = httpClient->request(
      kj::HttpMethod::GET, "https://grain.invalid/storage-test", requestHeaders);
  auto httpResponse = httpRequest.response.wait(waitScope);
  KJ_REQUIRE(httpResponse.statusCode == 200, "hosted worker request failed", httpResponse.statusCode);
  KJ_REQUIRE(httpResponse.headers->get(egressTestHeader) == "egress-ok"_kj,
      "hosted worker response header was not preserved");
  KJ_REQUIRE(httpResponse.body->readAllText().wait(waitScope) == "shared-storage-ok",
      "hosted worker did not round-trip through its storage binding");
  grain.stopRequest().send().wait(waitScope);

  sandstorm::expectFailure([&]() {
    grain.keepAliveRequest().send().wait(waitScope);
  });

  auto restart = host.startGrainRequest();
  restart.setGrainId("testgrain123");
  restart.setServices(services);
  auto restartedGrain = restart.send().wait(waitScope).getGrain();
  restartedGrain.keepAliveRequest().send().wait(waitScope);
  auto restartedHttp = restartedGrain.getHttpServiceRequest().send().wait(waitScope);
  auto restartedService = httpFactory.capnpToKj(restartedHttp.getService());
  auto restartedClient = kj::newHttpClient(*restartedService);
  kj::HttpHeaders restartedHeaders(*headerTable);
  restartedHeaders.set(ingressTestHeader, "ingress-ok"_kj);
  auto restartedRequest = restartedClient->request(
      kj::HttpMethod::GET, "https://grain.invalid/storage-test", restartedHeaders);
  auto restartedResponse = restartedRequest.response.wait(waitScope);
  KJ_REQUIRE(restartedResponse.statusCode == 200,
      "restarted hosted worker request failed", restartedResponse.statusCode);
  KJ_REQUIRE(restartedResponse.headers->get(egressTestHeader) == "egress-ok"_kj,
      "restarted hosted worker response header was not preserved");
  KJ_REQUIRE(restartedResponse.body->readAllText().wait(waitScope) == "shared-storage-ok",
      "restarted worker lost its STORAGE capability");
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
  sandstorm::expectFailure([&]() {
    auto unsupported = host.startGrainRequest();
    unsupported.setGrainId("unsupportedversion");
    unsupported.setServices(services);
    unsupported.send().wait(waitScope);
  });
  sandstorm::expectFailure([&]() {
    auto oversized = host.startGrainRequest();
    oversized.setGrainId("oversizedbundle");
    oversized.setServices(services);
    oversized.send().wait(waitScope);
  });

  kj::Vector<kj::Promise<void>> pendingAdmissions;
  for (auto i: kj::zeroTo(16)) {
    auto request = host.startGrainRequest();
    request.setGrainId(kj::str("admission", i < 10 ? "0" : "", i));
    request.setServices(services);
    pendingAdmissions.add(request.send().ignoreResult());
  }
  sandstorm::expectFailure([&]() {
    auto overloaded = host.startGrainRequest();
    overloaded.setGrainId("admission-overload");
    overloaded.setServices(services);
    overloaded.send().wait(waitScope);
  });
  for (auto i: kj::zeroTo(16)) {
    auto fifoPath = kj::str(argv[2], "/admission", i < 10 ? "0" : "", i,
        "/isolate-runtime/worker-source.capnp.bin");
    int fifoFd;
    KJ_SYSCALL(fifoFd = open(fifoPath.cStr(), O_WRONLY | O_CLOEXEC));
    KJ_SYSCALL(write(fifoFd, "x", 1));
    close(fifoFd);
  }
  for (auto& admission: pendingAdmissions) {
    sandstorm::expectFailure([&]() { kj::mv(admission).wait(waitScope); });
  }

  return 0;
}
