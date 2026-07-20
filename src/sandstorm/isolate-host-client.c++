// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2026 Sandstorm contributors
// Licensed under the Apache License, Version 2.0.

#include "isolate-host.capnp.h"
#include "isolate-bridge.capnp.h"
#include "isolate-worker-source.capnp.h"

#include <sandstorm/isolate/capnp-es.js.h>
#include <sandstorm/isolate/capnp-runtime.js.h>
#include <sandstorm/isolate/platform-capnp-es.js.h>

#include <capnp/ez-rpc.h>
#include <capnp/compat/http-over-capnp.h>
#include <capnp/message.h>
#include <capnp/serialize-packed.h>
#include <kj/debug.h>
#include <kj/function.h>
#include <unistd.h>

namespace sandstorm {
namespace {

class TestStorageService final: public kj::HttpService {
public:
  TestStorageService(kj::HttpHeaderTable& headerTable, kj::String& stored)
      : headerTable(headerTable), stored(stored) {}

  kj::Promise<void> request(kj::HttpMethod method, kj::StringPtr,
      const kj::HttpHeaders&, kj::AsyncInputStream& requestBody,
      kj::HttpService::Response& response) override {
    if (method == kj::HttpMethod::PUT) {
      return requestBody.readAllText().then([this, &response](kj::String body) {
        stored = kj::mv(body);
        return send(response, stored);
      });
    }
    KJ_REQUIRE(method == kj::HttpMethod::GET, "unexpected test storage method");
    return send(response, stored);
  }

private:
  kj::HttpHeaderTable& headerTable;
  kj::String& stored;

  kj::Promise<void> send(kj::HttpService::Response& response, kj::StringPtr body) {
    kj::HttpHeaders headers(headerTable);
    auto stream = response.send(200, "OK", headers, body.size());
    return stream->write(body.begin(), body.size()).attach(kj::mv(stream));
  }
};

class BindingServicesImpl final: public IsolateBindingServices::Server {
public:
  BindingServicesImpl()
      : httpFactory(byteStreamFactory, headerTableBuilder),
        headerTable(headerTableBuilder.build()) {}

  kj::Promise<void> getService(GetServiceContext context) override {
    KJ_REQUIRE(context.getParams().getBinding() == IsolateBindingServices::Binding::STORAGE,
        "control test requested an unexpected binding service");
    context.getResults().setService(httpFactory.kjToCapnp(
        kj::heap<TestStorageService>(*headerTable, stored)));
    return kj::READY_NOW;
  }

private:
  capnp::ByteStreamFactory byteStreamFactory;
  kj::HttpHeaderTable::Builder headerTableBuilder;
  capnp::HttpOverCapnpFactory httpFactory;
  kj::Own<kj::HttpHeaderTable> headerTable;
  kj::String stored = kj::str("shared-storage-ok");
};

class RpcCallbackImpl final: public IsolateBridge::Server {
 public:
  kj::Promise<void> dropBrowserHandoff(DropBrowserHandoffContext context) override {
    KJ_REQUIRE(context.getParams().getId() == "first",
        "worker callback carried the wrong value", context.getParams().getId());
    context.getResults().setReleased(true);
    return kj::READY_NOW;
  }
};

void expectFailure(kj::Function<void()> operation) {
  auto exception = kj::runCatchingExceptions(kj::mv(operation));
  KJ_REQUIRE(exception != nullptr, "host operation unexpectedly succeeded");
}

kj::String capnpEsRuntimePath(kj::StringPtr moduleName) {
  if (moduleName == "@mnutt/capnp-es") return kj::str("capnp-es/index.mjs");

  kj::StringPtr capnpEsPrefix = "@mnutt/capnp-es/";
  if (moduleName.startsWith(capnpEsPrefix)) {
    auto relative = moduleName.slice(capnpEsPrefix.size());
    return relative.endsWith(".mjs")
        ? kj::str("capnp-es/", relative)
        : kj::str("capnp-es/", relative, ".mjs");
  }

  kj::StringPtr sharedPrefix = "@mnutt/shared/";
  KJ_REQUIRE(moduleName.startsWith(sharedPrefix),
      "unexpected capnp-es runtime module", moduleName);
  return kj::str("capnp-es/shared/", moduleName.slice(sharedPrefix.size()));
}

}  // namespace
}  // namespace sandstorm

int main(int argc, char** argv) {
  KJ_REQUIRE(argc == 2 || (argc == 3 && kj::StringPtr(argv[2]) == "--idle-eviction"_kj),
      "usage: isolate-host-client <control-socket-path> [--idle-eviction]");
  bool idleEvictionOnly = argc == 3;
  capnp::MallocMessageBuilder sourceMessage;
  auto source = sourceMessage.initRoot<sandstorm::IsolateWorkerSource>();
  source.setFormatVersion(2);
  source.setMainModule("main.js");
  source.setCompatibilityDate("2026-06-10");
  auto modules = source.initModules(2 + sandstorm::ISOLATE_CAPNP_ES_MODULE_COUNT +
      sandstorm::ISOLATE_PLATFORM_CAPNP_ES_MODULE_COUNT);
  uint moduleIndex = 0;
  auto module = modules[moduleIndex++];
  module.setName("main.js");
  auto script = kj::StringPtr(R"JS(
import { createCapnpWorkerExportDispatcher } from "sandstorm-internal:capnp-runtime";
import { Interface } from "capnp-es/index.mjs";
import { IsolateBridge } from "capnp:/sandstorm/isolate-bridge.capnp";

const rpcState = {
  previousContext: undefined,
  currentContext: undefined,
  callCount: 0,
  sameContext: false,
  delayNextExport: true,
  canceledPipelinedCallRan: false,
};
const rpcDispatcher = createCapnpWorkerExportDispatcher({
  bridge: {
    interface: IsolateBridge,
    target: {
      async createBrowserHandoff({ cap, sessionId }) {
        if (sessionId === "cancel-before-pipeline-dispatch") {
          rpcState.canceledPipelinedCallRan = true;
        } else if (rpcState.canceledPipelinedCallRan) {
          throw new Error("canceled promise-pipelined call was dispatched");
        }
        let callbackReleased = false;
        let callbackStayedInEvent = false;
        if (sessionId === "first") {
          const eventContext = rpcState.currentContext;
          const callback = new IsolateBridge.Client(Interface.fromPointer(cap).getClient());
          callbackReleased = (await callback.dropBrowserHandoff({ id: sessionId })).released;
          callbackStayedInEvent = rpcState.currentContext === eventContext;
        }
        return {
          id: `rpc-${rpcState.callCount}-${rpcState.sameContext ? 1 : 0}-${sessionId}` +
            `-${callbackReleased ? 1 : 0}-${callbackStayedInEvent ? 1 : 0}`,
        };
      },
    },
  },
}, {
  async beforeGetExport() {
    if (rpcState.delayNextExport) {
      rpcState.delayNextExport = false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  },
});

export default {
  async sandstormRpcEvent(request, send, receive, env, ctx) {
    rpcState.sameContext = rpcState.previousContext === ctx;
    rpcState.previousContext = ctx;
    rpcState.currentContext = ctx;
    rpcState.callCount++;
    await rpcDispatcher.handler(request, send, receive);
  },

  async fetch(request, env) {
    console.log("sandstorm-grain-log-marker");
    if (new URL(request.url).pathname === "/cpu-loop") {
      while (true) {}
    }
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

  auto workerExports = source.initExports(1);
  workerExports[0].setName("bridge");
  workerExports[0].setInterfaceId(capnp::typeId<sandstorm::IsolateBridge>());
  auto capnpRuntime = modules[moduleIndex++];
  capnpRuntime.setName("sandstorm-internal:capnp-runtime");
  capnpRuntime.setEsModule(kj::StringPtr(sandstorm::ISOLATE_CAPNP_RUNTIME_SOURCE).asBytes());
  for (auto& runtimeModule: sandstorm::ISOLATE_CAPNP_ES_MODULES) {
    auto output = modules[moduleIndex++];
    output.setName(sandstorm::capnpEsRuntimePath(runtimeModule.name));
    output.setEsModule(kj::StringPtr(runtimeModule.source).asBytes());
  }
  for (auto& platformModule: sandstorm::ISOLATE_PLATFORM_CAPNP_ES_MODULES) {
    auto output = modules[moduleIndex++];
    output.setName(platformModule.name);
    output.setEsModule(kj::StringPtr(platformModule.source).asBytes());
  }
  KJ_ASSERT(moduleIndex == modules.size());
  auto bindings = source.initBindings(3);
  bindings[0].setName("MESSAGE");
  bindings[0].setText(kj::StringPtr("hello").asBytes());
  bindings[1].setName("SETTINGS");
  bindings[1].setJson(kj::StringPtr("{\"enabled\":true}").asBytes());
  bindings[2].setName("STORAGE");
  bindings[2].setStorage();
  kj::VectorOutputStream sourceOutput;
  capnp::writePackedMessage(sourceOutput, sourceMessage);
  auto sourceBytes = sourceOutput.getArray();

  capnp::MallocMessageBuilder memorySourceMessage;
  auto memorySource = memorySourceMessage.initRoot<sandstorm::IsolateWorkerSource>();
  memorySource.setFormatVersion(1);
  memorySource.setMainModule("main.js");
  memorySource.setCompatibilityDate("2026-06-10");
  auto memoryModule = memorySource.initModules(1)[0];
  memoryModule.setName("main.js");
  memoryModule.setEsModule(kj::StringPtr(R"JS(
const allocations = [];
while (true) allocations.push(new Array(1024 * 1024).fill(allocations.length));
export default { fetch() { return new Response("memory limit failed"); } };
)JS").asBytes());
  kj::VectorOutputStream memoryOutput;
  capnp::writePackedMessage(memoryOutput, memorySourceMessage);
  auto memoryBytes = memoryOutput.getArray();

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
  kj::VectorOutputStream invalidOutput;
  capnp::writePackedMessage(invalidOutput, invalidMessage);
  auto invalidBytes = invalidOutput.getArray();

  source.setFormatVersion(3);
  kj::VectorOutputStream unsupportedOutput;
  capnp::writePackedMessage(unsupportedOutput, sourceMessage);
  auto unsupportedBytes = unsupportedOutput.getArray();

  capnp::EzRpcClient rpc(kj::str("unix:", argv[1]));
  auto& waitScope = rpc.getWaitScope();
  auto host = rpc.getMain<sandstorm::IsolateHost>();
  sandstorm::IsolateBindingServices::Client services =
      kj::heap<sandstorm::BindingServicesImpl>();

  auto start = host.startGrainRequest();
  start.setGrainId("testgrain123");
  start.setServices(services);
  start.setWorkerSource(sourceBytes);
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

  if (idleEvictionOnly) {
    // The host runs in another process, so its timer advances while this client sleeps without
    // driving its own event loop.
    usleep(120 * 1000);
    grain.keepAliveRequest().send().wait(waitScope);
    usleep(120 * 1000);
    kj::HttpHeaders refreshedHeaders(*headerTable);
    auto refreshedRequest = httpClient->request(
        kj::HttpMethod::GET, "https://grain.invalid/", refreshedHeaders);
    auto refreshedResponse = refreshedRequest.response.wait(waitScope);
    KJ_REQUIRE(refreshedResponse.statusCode == 200,
        "keepalive did not extend the hosted grain idle deadline",
        refreshedResponse.statusCode);
    KJ_REQUIRE(refreshedResponse.body->readAllText().wait(waitScope) == "ok",
        "hosted grain returned the wrong response after keepalive");

    usleep(220 * 1000);
    sandstorm::expectFailure([&]() {
      grain.keepAliveRequest().send().wait(waitScope);
    });
    sandstorm::expectFailure([&]() {
      kj::HttpHeaders staleHeaders(*headerTable);
      auto staleRequest = httpClient->request(
          kj::HttpMethod::GET, "https://grain.invalid/", staleHeaders);
      (void)staleRequest.response.wait(waitScope);
    });

    auto restart = host.startGrainRequest();
    restart.setGrainId("testgrain123");
    restart.setServices(services);
    restart.setWorkerSource(sourceBytes);
    auto restarted = restart.send().wait(waitScope).getGrain();
    auto restartedHttp = restarted.getHttpServiceRequest().send().wait(waitScope);
    auto restartedService = httpFactory.capnpToKj(restartedHttp.getService());
    auto restartedClient = kj::newHttpClient(*restartedService);
    kj::HttpHeaders restartedHeaders(*headerTable);
    auto restartedRequest = restartedClient->request(
        kj::HttpMethod::GET, "https://grain.invalid/", restartedHeaders);
    auto restartedResponse = restartedRequest.response.wait(waitScope);
    KJ_REQUIRE(restartedResponse.statusCode == 200,
        "idle-evicted grain did not restart", restartedResponse.statusCode);
    KJ_REQUIRE(restartedResponse.body->readAllText().wait(waitScope) == "ok",
        "idle-evicted grain returned the wrong response after restart");
    restarted.stopRequest().send().wait(waitScope);
    return 0;
  }

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

  sandstorm::expectFailure([&]() {
    auto undeclared = grain.getExportRequest();
    undeclared.setName("missing");
    undeclared.setInterfaceId(capnp::typeId<sandstorm::IsolateBridge>());
    undeclared.send().wait(waitScope);
  });
  sandstorm::expectFailure([&]() {
    auto wrongType = grain.getExportRequest();
    wrongType.setName("bridge");
    wrongType.setInterfaceId(1);
    wrongType.send().wait(waitScope);
  });
  auto canceledExportRequest = grain.getExportRequest();
  canceledExportRequest.setName("bridge");
  canceledExportRequest.setInterfaceId(capnp::typeId<sandstorm::IsolateBridge>());
  auto canceledExport = canceledExportRequest.send();
  auto canceledPipelinedRequest = canceledExport.getCap()
      .castAs<sandstorm::IsolateBridge>().createBrowserHandoffRequest();
  canceledPipelinedRequest.setCap(capnp::Capability::Client(nullptr));
  canceledPipelinedRequest.setSessionId("cancel-before-pipeline-dispatch");
  auto canceledPipelinedCall = canceledPipelinedRequest.send()
      .dropPipeline().eagerlyEvaluate(nullptr);
  canceledPipelinedCall = nullptr;
  canceledExport.wait(waitScope);

  auto exportRequest = grain.getExportRequest();
  exportRequest.setName("bridge");
  exportRequest.setInterfaceId(capnp::typeId<sandstorm::IsolateBridge>());
  auto exportPipeline = exportRequest.send();
  auto rpcBootstrap = exportPipeline.getCap().castAs<sandstorm::IsolateBridge>();
  auto firstRpc = rpcBootstrap.createBrowserHandoffRequest();
  firstRpc.setCap(kj::heap<sandstorm::RpcCallbackImpl>());
  firstRpc.setSessionId("first");
  auto firstRpcResponse = firstRpc.send().wait(waitScope);
  // Bootstrap and the export lookup precede the application Call. Bootstrap Finish and the
  // callback Return are delivered through their originating events' I/O sources, without
  // invoking another handler or replacing the Call's ExecutionContext.
  KJ_REQUIRE(firstRpcResponse.getId() == "rpc-7-0-first-1-1",
      "typed worker RPC callback did not stay in its originating event",
      firstRpcResponse.getId());

  auto secondRpc = rpcBootstrap.createBrowserHandoffRequest();
  secondRpc.setCap(capnp::Capability::Client(nullptr));
  secondRpc.setSessionId("second");
  auto secondRpcResponse = secondRpc.send().wait(waitScope);
  // The first answer's Finish is consumed by its original event before this second Call.
  KJ_REQUIRE(secondRpcResponse.getId() == "rpc-8-0-second-0-0",
      "worker-global RPC connection state was not preserved", secondRpcResponse.getId());

  auto cpuStart = host.startGrainRequest();
  cpuStart.setGrainId("cpugrain123");
  cpuStart.setServices(services);
  cpuStart.setWorkerSource(sourceBytes);
  auto cpuGrain = cpuStart.send().wait(waitScope).getGrain();
  auto cpuHttp = cpuGrain.getHttpServiceRequest().send().wait(waitScope);
  auto cpuService = httpFactory.capnpToKj(cpuHttp.getService());
  auto cpuClient = kj::newHttpClient(*cpuService);
  kj::HttpHeaders cpuHeaders(*headerTable);
  auto cpuRequest = cpuClient->request(
      kj::HttpMethod::GET, "https://grain.invalid/cpu-loop", cpuHeaders);
  bool cpuRejected = false;
  auto cpuFailure = kj::runCatchingExceptions([&]() {
    auto response = cpuRequest.response.wait(waitScope);
    cpuRejected = response.statusCode >= 500;
  });
  if (cpuFailure != nullptr) cpuRejected = true;
  KJ_REQUIRE(cpuRejected, "CPU watchdog did not terminate the worker request");

  // A condemned grain must not stall or poison unrelated isolates in the shared process.
  kj::HttpHeaders neighborHeaders(*headerTable);
  auto neighborRequest = httpClient->request(
      kj::HttpMethod::GET, "https://grain.invalid/", neighborHeaders);
  auto neighborResponse = neighborRequest.response.wait(waitScope);
  KJ_REQUIRE(neighborResponse.statusCode == 200,
      "CPU watchdog affected an unrelated worker", neighborResponse.statusCode);
  KJ_REQUIRE(neighborResponse.body->readAllText().wait(waitScope) == "ok",
      "unrelated worker returned the wrong response after watchdog termination");
  cpuGrain.stopRequest().send().wait(waitScope);

  sandstorm::expectFailure([&]() {
    auto memoryStart = host.startGrainRequest();
    memoryStart.setGrainId("memorygrain123");
    memoryStart.setServices(services);
    memoryStart.setWorkerSource(memoryBytes);
    auto memoryGrain = memoryStart.send().wait(waitScope).getGrain();
    auto memoryHttp = memoryGrain.getHttpServiceRequest().send().wait(waitScope);
    auto memoryService = httpFactory.capnpToKj(memoryHttp.getService());
    auto memoryClient = kj::newHttpClient(*memoryService);
    kj::HttpHeaders memoryHeaders(*headerTable);
    auto memoryRequest = memoryClient->request(
        kj::HttpMethod::GET, "https://grain.invalid/", memoryHeaders);
    auto memoryResponse = memoryRequest.response.wait(waitScope);
    KJ_REQUIRE(memoryResponse.statusCode < 500, "memory-bound worker request rejected");
  });

  kj::HttpHeaders postMemoryHeaders(*headerTable);
  auto postMemoryRequest = httpClient->request(
      kj::HttpMethod::GET, "https://grain.invalid/", postMemoryHeaders);
  auto postMemoryResponse = postMemoryRequest.response.wait(waitScope);
  KJ_REQUIRE(postMemoryResponse.statusCode == 200,
      "heap-limit termination affected an unrelated worker", postMemoryResponse.statusCode);
  grain.stopRequest().send().wait(waitScope);

  sandstorm::expectFailure([&]() {
    auto stoppedRpc = rpcBootstrap.createBrowserHandoffRequest();
    stoppedRpc.setCap(capnp::Capability::Client(nullptr));
    stoppedRpc.setSessionId("stopped");
    stoppedRpc.send().wait(waitScope);
  });
  sandstorm::expectFailure([&]() {
    grain.keepAliveRequest().send().wait(waitScope);
  });
  sandstorm::expectFailure([&]() {
    grain.invokeRpcEventRequest().send().wait(waitScope);
  });
  sandstorm::expectFailure([&]() {
    kj::HttpHeaders staleHeaders(*headerTable);
    auto staleRequest = httpClient->request(
        kj::HttpMethod::GET, "https://grain.invalid/", staleHeaders);
    (void)staleRequest.response.wait(waitScope);
  });

  auto restart = host.startGrainRequest();
  restart.setGrainId("testgrain123");
  restart.setServices(services);
  restart.setWorkerSource(sourceBytes);
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
    auto incomplete = host.startGrainRequest();
    incomplete.setGrainId("missingworker123");
    incomplete.setServices(services);
    incomplete.send().wait(waitScope);
  });
  sandstorm::expectFailure([&]() {
    auto invalid = host.startGrainRequest();
    invalid.setGrainId("invalidjson");
    invalid.setServices(services);
    invalid.setWorkerSource(invalidBytes);
    invalid.send().wait(waitScope);
  });
  sandstorm::expectFailure([&]() {
    auto unsupported = host.startGrainRequest();
    unsupported.setGrainId("unsupportedversion");
    unsupported.setServices(services);
    unsupported.setWorkerSource(unsupportedBytes);
    unsupported.send().wait(waitScope);
  });
  sandstorm::expectFailure([&]() {
    auto oversized = host.startGrainRequest();
    oversized.setGrainId("oversizedbundle");
    oversized.setServices(services);
    oversized.setWorkerSource(
        kj::heapArray<kj::byte>(16 * 1024 * 1024 + 1).asPtr());
    oversized.send().wait(waitScope);
  });

  return 0;
}
