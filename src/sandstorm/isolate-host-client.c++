// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2026 Sandstorm contributors
// Licensed under the Apache License, Version 2.0.

#include "isolate-host.capnp.h"
#include "isolate-bridge.capnp.h"
#include "isolate-exports.capnp.h"
#include "isolate-worker-source.capnp.h"

#include <sandstorm/isolate/capnp-es.js.h>
#include <sandstorm/isolate/capnp-runtime.js.h>
#include <sandstorm/isolate/platform-capnp-es.js.h>

#include <capnp/ez-rpc.h>
#include <capnp/message.h>
#include <capnp/serialize-packed.h>
#include <kj/debug.h>
#include <kj/function.h>
#include <unistd.h>

namespace sandstorm {
namespace {

class RpcCallbackImpl final: public IsolateBridge::Server {
 public:
  kj::Promise<void> dropBrowserHandoff(DropBrowserHandoffContext context) override {
    KJ_REQUIRE(context.getParams().getId() == "first",
        "worker callback carried the wrong value", context.getParams().getId());
    context.getResults().setReleased(true);
    return kj::READY_NOW;
  }
};

class BindingServicesImpl final: public IsolateBindingServices::Server {
public:
  kj::Promise<void> getBridge(GetBridgeContext context) override {
    context.getResults().setBridge(kj::heap<RpcCallbackImpl>());
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
import { AsyncLocalStorage } from "node:async_hooks";

const rpcEventContext = new AsyncLocalStorage();
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
        console.log("sandstorm-grain-log-marker");
        if (sessionId === "cpu-loop") {
          while (true) {}
        }
        if (sessionId === "memory-loop") {
          const allocations = [];
          while (true) allocations.push(new Array(1024 * 1024).fill(allocations.length));
        }
        if (sessionId === "cancel-before-pipeline-dispatch") {
          rpcState.canceledPipelinedCallRan = true;
        } else if (rpcState.canceledPipelinedCallRan) {
          throw new Error("canceled promise-pipelined call was dispatched");
        }
        let callbackReleased = false;
        let callbackStayedInEvent = false;
        if (sessionId === "first") {
          const eventContext = rpcEventContext.getStore();
          const callback = new IsolateBridge.Client(Interface.fromPointer(cap).getClient());
          callbackReleased = (await callback.dropBrowserHandoff({ id: sessionId })).released;
          callbackStayedInEvent = rpcEventContext.getStore() === eventContext;
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
    await rpcEventContext.run(ctx, () => rpcDispatcher.handler(request, send, receive));
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
  auto bindings = source.initBindings(2);
  bindings[0].setName("MESSAGE");
  bindings[0].setText(kj::StringPtr("hello").asBytes());
  bindings[1].setName("SETTINGS");
  bindings[1].setJson(kj::StringPtr("{\"enabled\":true}").asBytes());
  kj::VectorOutputStream sourceOutput;
  capnp::writePackedMessage(sourceOutput, sourceMessage);
  auto sourceBytes = sourceOutput.getArray();

  capnp::MallocMessageBuilder invalidMessage;
  auto invalidSource = invalidMessage.initRoot<sandstorm::IsolateWorkerSource>();
  invalidSource.setFormatVersion(2);
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

  auto resolveBridge = [&](sandstorm::HostedIsolate::Client hosted) {
    auto request = hosted.getExportRequest();
    request.setName("bridge");
    request.setInterfaceId(capnp::typeId<sandstorm::IsolateBridge>());
    return request.send().wait(waitScope).getCap().castAs<sandstorm::IsolateBridge>();
  };

  if (idleEvictionOnly) {
    // The host runs in another process, so its timer advances while this client sleeps without
    // driving its own event loop.
    usleep(120 * 1000);
    grain.keepAliveRequest().send().wait(waitScope);
    usleep(120 * 1000);
    auto refreshed = resolveBridge(grain);
    auto refreshedCall = refreshed.createBrowserHandoffRequest();
    refreshedCall.setSessionId("refreshed");
    refreshedCall.send().wait(waitScope);

    usleep(220 * 1000);
    sandstorm::expectFailure([&]() {
      grain.keepAliveRequest().send().wait(waitScope);
    });
    sandstorm::expectFailure([&]() {
      auto staleCall = refreshed.createBrowserHandoffRequest();
      staleCall.setSessionId("stale");
      staleCall.send().wait(waitScope);
    });

    auto restart = host.startGrainRequest();
    restart.setGrainId("testgrain123");
    restart.setServices(services);
    restart.setWorkerSource(sourceBytes);
    auto restarted = restart.send().wait(waitScope).getGrain();
    auto restartedBridge = resolveBridge(restarted);
    auto restartedCall = restartedBridge.createBrowserHandoffRequest();
    restartedCall.setSessionId("restarted");
    restartedCall.send().wait(waitScope);
    restarted.stopRequest().send().wait(waitScope);
    return 0;
  }

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
  // Protocol-control events may change the absolute event ordinal. The suffix proves that the
  // callback Return used the Call's original ExecutionContext and returned the expected value.
  KJ_REQUIRE(firstRpcResponse.getId().endsWith("-0-first-1-1"),
      "typed worker RPC callback did not stay in its originating event",
      firstRpcResponse.getId());

  auto secondRpc = rpcBootstrap.createBrowserHandoffRequest();
  secondRpc.setCap(capnp::Capability::Client(nullptr));
  secondRpc.setSessionId("second");
  auto secondRpcResponse = secondRpc.send().wait(waitScope);
  KJ_REQUIRE(secondRpcResponse.getId().endsWith("-0-second-0-0"),
      "worker-global RPC connection state was not preserved", secondRpcResponse.getId());

  sandstorm::expectFailure([&]() {
    auto bootstrap = grain.getRpcBootstrapRequest().send().wait(waitScope).getCap()
        .castAs<sandstorm::IsolateExportBroker>();
    auto restore = bootstrap.restoreExportRequest();
    restore.setName("bridge");
    restore.setInterfaceId(capnp::typeId<sandstorm::IsolateBridge>());
    restore.getObjectId().setAs<capnp::Text>("missing durable registry");
    restore.setPlatform(kj::heap<sandstorm::RpcCallbackImpl>());
    restore.send().wait(waitScope);
  });

  auto cpuStart = host.startGrainRequest();
  cpuStart.setGrainId("cpugrain123");
  cpuStart.setServices(services);
  cpuStart.setWorkerSource(sourceBytes);
  auto cpuGrain = cpuStart.send().wait(waitScope).getGrain();
  auto cpuBridge = resolveBridge(cpuGrain);
  auto cpuFailure = kj::runCatchingExceptions([&]() {
    auto request = cpuBridge.createBrowserHandoffRequest();
    request.setSessionId("cpu-loop");
    request.send().wait(waitScope);
  });
  KJ_REQUIRE(cpuFailure != nullptr, "CPU watchdog did not terminate the worker RPC");

  // A condemned grain must not stall or poison unrelated isolates in the shared process.
  auto neighborRequest = rpcBootstrap.createBrowserHandoffRequest();
  neighborRequest.setSessionId("neighbor");
  neighborRequest.send().wait(waitScope);
  cpuGrain.stopRequest().send().wait(waitScope);

  sandstorm::expectFailure([&]() {
    auto memoryStart = host.startGrainRequest();
    memoryStart.setGrainId("memorygrain123");
    memoryStart.setServices(services);
    memoryStart.setWorkerSource(sourceBytes);
    auto memoryGrain = memoryStart.send().wait(waitScope).getGrain();
    auto memoryBridge = resolveBridge(memoryGrain);
    auto memoryRequest = memoryBridge.createBrowserHandoffRequest();
    memoryRequest.setSessionId("memory-loop");
    memoryRequest.send().wait(waitScope);
  });

  auto postMemoryRequest = rpcBootstrap.createBrowserHandoffRequest();
  postMemoryRequest.setSessionId("post-memory");
  postMemoryRequest.send().wait(waitScope);
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
  auto restart = host.startGrainRequest();
  restart.setGrainId("testgrain123");
  restart.setServices(services);
  restart.setWorkerSource(sourceBytes);
  auto restartedGrain = restart.send().wait(waitScope).getGrain();
  restartedGrain.keepAliveRequest().send().wait(waitScope);
  auto restartedBridge = resolveBridge(restartedGrain);
  auto restartedRequest = restartedBridge.createBrowserHandoffRequest();
  restartedRequest.setSessionId("restarted");
  restartedRequest.send().wait(waitScope);
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
