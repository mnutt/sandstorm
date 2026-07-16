// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2026 Sandstorm contributors
// Licensed under the Apache License, Version 2.0.

#include "isolate-host.capnp.h"
#include "isolate-worker-source.capnp.h"

#include <capnp/ez-rpc.h>
#include <capnp/compat/http-over-capnp.h>
#include <capnp/message.h>
#include <capnp/rpc.capnp.h>
#include <capnp/serialize.h>
#include <capnp/serialize-packed.h>
#include <kj/debug.h>
#include <kj/function.h>
#include <unistd.h>

#include <initializer_list>
#include <limits>

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

void expectFailure(kj::Function<void()> operation) {
  auto exception = kj::runCatchingExceptions(kj::mv(operation));
  KJ_REQUIRE(exception != nullptr, "host operation unexpectedly succeeded");
}

kj::Array<capnp::word> makeBootstrapFrame(uint32_t questionId) {
  capnp::MallocMessageBuilder message;
  message.initRoot<capnp::rpc::Message>().initBootstrap().setQuestionId(questionId);
  return capnp::messageToFlatArray(message);
}

kj::Array<capnp::word> makeFinishFrame(uint32_t questionId, bool releaseResultCaps) {
  capnp::MallocMessageBuilder message;
  auto finish = message.initRoot<capnp::rpc::Message>().initFinish();
  finish.setQuestionId(questionId);
  finish.setReleaseResultCaps(releaseResultCaps);
  return capnp::messageToFlatArray(message);
}

kj::Array<capnp::word> makeCallFrame(uint32_t questionId, uint32_t importedCap) {
  capnp::MallocMessageBuilder message;
  auto call = message.initRoot<capnp::rpc::Message>().initCall();
  call.setQuestionId(questionId);
  call.initTarget().setImportedCap(importedCap);
  call.initSendResultsTo().setCaller();
  call.initParams();
  return capnp::messageToFlatArray(message);
}

kj::Array<capnp::word> makeCallWithSenderHostedParamFrame(
    uint32_t questionId, uint32_t importedCap, uint32_t senderHosted) {
  capnp::MallocMessageBuilder message;
  auto call = message.initRoot<capnp::rpc::Message>().initCall();
  call.setQuestionId(questionId);
  call.initTarget().setImportedCap(importedCap);
  call.initSendResultsTo().setCaller();
  call.initParams().initCapTable(1)[0].setSenderHosted(senderHosted);
  return capnp::messageToFlatArray(message);
}

kj::Array<capnp::word> makeReturnFrame(
    uint32_t answerId, kj::Maybe<uint32_t> senderHosted = nullptr) {
  capnp::MallocMessageBuilder message;
  auto result = message.initRoot<capnp::rpc::Message>().initReturn();
  result.setAnswerId(answerId);
  result.setReleaseParamCaps(true);
  auto payload = result.initResults();
  KJ_IF_MAYBE(exportId, senderHosted) {
    payload.initCapTable(1)[0].setSenderHosted(*exportId);
  }
  return capnp::messageToFlatArray(message);
}

kj::Array<capnp::word> makePromiseReturnFrame(uint32_t answerId, uint32_t senderPromise) {
  capnp::MallocMessageBuilder message;
  auto result = message.initRoot<capnp::rpc::Message>().initReturn();
  result.setAnswerId(answerId);
  result.setReleaseParamCaps(true);
  result.initResults().initCapTable(1)[0].setSenderPromise(senderPromise);
  return capnp::messageToFlatArray(message);
}

kj::Array<capnp::word> makeReceiverAnswerReturnFrame(
    uint32_t answerId, uint32_t questionId) {
  capnp::MallocMessageBuilder message;
  auto result = message.initRoot<capnp::rpc::Message>().initReturn();
  result.setAnswerId(answerId);
  result.setReleaseParamCaps(true);
  auto answer = result.initResults().initCapTable(1)[0].initReceiverAnswer();
  answer.setQuestionId(questionId);
  answer.initTransform(0);
  return capnp::messageToFlatArray(message);
}

kj::Array<capnp::word> makeThirdPartyReturnFrame(uint32_t answerId) {
  capnp::MallocMessageBuilder message;
  auto result = message.initRoot<capnp::rpc::Message>().initReturn();
  result.setAnswerId(answerId);
  result.setReleaseParamCaps(true);
  result.initResults().initCapTable(1)[0].initThirdPartyHosted();
  return capnp::messageToFlatArray(message);
}

kj::Array<capnp::word> makeResolveHostedFrame(uint32_t promiseId, uint32_t senderHosted) {
  capnp::MallocMessageBuilder message;
  auto resolve = message.initRoot<capnp::rpc::Message>().initResolve();
  resolve.setPromiseId(promiseId);
  resolve.initCap().setSenderHosted(senderHosted);
  return capnp::messageToFlatArray(message);
}

kj::Array<capnp::word> makeReleaseFrame(uint32_t id, uint32_t referenceCount) {
  capnp::MallocMessageBuilder message;
  auto release = message.initRoot<capnp::rpc::Message>().initRelease();
  release.setId(id);
  release.setReferenceCount(referenceCount);
  return capnp::messageToFlatArray(message);
}

kj::Array<kj::byte> packRpcFrames(
    std::initializer_list<kj::ArrayPtr<const capnp::word>> frames) {
  kj::Vector<kj::byte> packed;
  for (auto frame: frames) {
    auto bytes = frame.asBytes();
    KJ_REQUIRE(bytes.size() <= std::numeric_limits<uint32_t>::max());
    uint32_t size = bytes.size();
    packed.add(static_cast<kj::byte>(size));
    packed.add(static_cast<kj::byte>(size >> 8));
    packed.add(static_cast<kj::byte>(size >> 16));
    packed.add(static_cast<kj::byte>(size >> 24));
    packed.addAll(bytes);
  }
  return packed.releaseAsArray();
}

}  // namespace
}  // namespace sandstorm

int main(int argc, char** argv) {
  KJ_REQUIRE(argc == 2 || (argc == 3 && kj::StringPtr(argv[2]) == "--idle-eviction"_kj),
      "usage: isolate-host-client <control-socket-path> [--idle-eviction]");
  bool idleEvictionOnly = argc == 3;
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
    console.log("sandstorm-grain-log-marker");
    const url = new URL(request.url);
    if (url.pathname === "/cpu-loop") {
      while (true) {}
    }
    if (url.pathname === "/local-buffer-source") {
      const channel = env.__SANDSTORM_NATIVE_BUFFER_LINKS.accept(
        url.searchParams.get("name"));
      const payload = new Uint8Array([1, 2, 3, 4]);
      const buffer = payload.buffer;
      channel.send(buffer);
      const secondBuffer = new Uint8Array([5, 6]).buffer;
      channel.send(secondBuffer);
      const detached = buffer.byteLength === 0 && secondBuffer.byteLength === 0;
      const reply = Array.from(new Uint8Array(await channel.receive()));
      return Response.json({ detached, reply });
    }
    if (url.pathname === "/local-buffer-target") {
      const channel = env.__SANDSTORM_NATIVE_BUFFER_LINKS.accept(
        url.searchParams.get("name"));
      const payload = new Uint8Array(await channel.receive());
      const received = Array.from(payload);
      const receivedSecond = Array.from(new Uint8Array(await channel.receive()));
      payload[0] = 9;
      const buffer = payload.buffer;
      channel.send(buffer);
      return Response.json({ received, receivedSecond, detached: buffer.byteLength === 0 });
    }
    if (url.pathname === "/local-buffer-wait-for-close") {
      const channel = env.__SANDSTORM_NATIVE_BUFFER_LINKS.accept(
        url.searchParams.get("name"));
      try {
        await channel.receive();
        return new Response("unexpected message", { status: 500 });
      } catch (_) {
        return new Response("revoked", { status: 410 });
      }
    }
    if (url.pathname === "/local-buffer-close") {
      const channel = env.__SANDSTORM_NATIVE_BUFFER_LINKS.accept(
        url.searchParams.get("name"));
      channel.close();
      return new Response("closed");
    }
    if (url.pathname === "/local-capnp-source") {
      const channel = env.__SANDSTORM_NATIVE_BUFFER_LINKS.accept(
        url.searchParams.get("name"));
      const bytes = new Uint8Array(await request.arrayBuffer());
      const view = new DataView(bytes.buffer);
      const frames = [];
      for (let offset = 0; offset < bytes.byteLength;) {
        const size = view.getUint32(offset, true);
        offset += 4;
        frames.push(bytes.slice(offset, offset + size).buffer);
        offset += size;
      }
      channel.send(frames[0]);
      await channel.receive();
      channel.send(frames[1]);
      channel.send(frames[2]);
      await channel.receive();
      channel.send(frames[3]);
      channel.send(frames[4]);
      return new Response(frames.every((frame) => frame.byteLength === 0) ? "detached" : "live");
    }
    if (url.pathname === "/local-capnp-target") {
      const channel = env.__SANDSTORM_NATIVE_BUFFER_LINKS.accept(
        url.searchParams.get("name"));
      const bytes = new Uint8Array(await request.arrayBuffer());
      const view = new DataView(bytes.buffer);
      const frames = [];
      for (let offset = 0; offset < bytes.byteLength;) {
        const size = view.getUint32(offset, true);
        offset += 4;
        frames.push(bytes.slice(offset, offset + size).buffer);
        offset += size;
      }
      await channel.receive();
      channel.send(frames[0]);
      await channel.receive();
      await channel.receive();
      channel.send(frames[1]);
      await channel.receive();
      await channel.receive();
      return new Response(frames.every((frame) => frame.byteLength === 0) ? "detached" : "live");
    }
    if (url.pathname === "/local-capnp-reject") {
      const channel = env.__SANDSTORM_NATIVE_BUFFER_LINKS.accept(
        url.searchParams.get("name"));
      const frame = await request.arrayBuffer();
      try {
        channel.send(frame);
        return new Response("accepted", { status: 500 });
      } catch (_) {
        try {
          await channel.receive();
          return new Response("still open", { status: 500 });
        } catch (_) {
          return new Response("rejected", { status: 409 });
        }
      }
    }
    if (url.pathname === "/local-capnp-script") {
      const channel = env.__SANDSTORM_NATIVE_BUFFER_LINKS.accept(
        url.searchParams.get("name"));
      const bytes = new Uint8Array(await request.arrayBuffer());
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const frames = [];
      for (let offset = 0; offset < bytes.byteLength;) {
        if (offset + 4 > bytes.byteLength) throw new Error("truncated frame size");
        const size = view.getUint32(offset, true);
        offset += 4;
        if (offset + size > bytes.byteLength) throw new Error("truncated frame");
        frames.push(bytes.slice(offset, offset + size).buffer);
        offset += size;
      }

      let nextFrame = 0;
      let rejected = false;
      let revoked = false;
      for (const step of url.searchParams.get("steps") || "") {
        if (step === "s") {
          channel.send(frames[nextFrame++]);
        } else if (step === "r") {
          await channel.receive();
        } else if (step === "x") {
          try {
            channel.send(frames[nextFrame++]);
            return new Response("invalid frame was accepted", { status: 500 });
          } catch (_) {
            rejected = true;
          }
        } else if (step === "c") {
          try {
            await channel.receive();
            return new Response("revoked link delivered a frame", { status: 500 });
          } catch (_) {
            revoked = true;
          }
        } else {
          throw new Error(`unknown protocol script step: ${step}`);
        }
      }
      if (nextFrame !== frames.length) throw new Error("unused protocol script frame");
      return Response.json({ rejected, revoked });
    }
    if (url.pathname === "/storage-test") {
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

  source.setFormatVersion(2);
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

  auto peerStart = host.startGrainRequest();
  peerStart.setGrainId("peergrain123");
  peerStart.setServices(services);
  peerStart.setWorkerSource(sourceBytes);
  auto peerGrain = peerStart.send().wait(waitScope).getGrain();
  auto peerHttp = peerGrain.getHttpServiceRequest().send().wait(waitScope);
  auto peerService = httpFactory.capnpToKj(peerHttp.getService());
  auto peerClient = kj::newHttpClient(*peerService);

  auto openLink = host.openLocalBufferChannelRequest();
  openLink.setFirstGrainId("testgrain123");
  openLink.setFirstName("roundtrip-source");
  openLink.setSecondGrainId("peergrain123");
  openLink.setSecondName("roundtrip-target");
  auto localLinkRevoker = openLink.send().wait(waitScope).getRevoker();

  kj::HttpHeaders localSourceHeaders(*headerTable);
  auto localSourceRequest = httpClient->request(kj::HttpMethod::GET,
      "https://grain.invalid/local-buffer-source?name=roundtrip-source", localSourceHeaders);
  kj::HttpHeaders localTargetHeaders(*headerTable);
  auto localTargetRequest = peerClient->request(kj::HttpMethod::GET,
      "https://grain.invalid/local-buffer-target?name=roundtrip-target", localTargetHeaders);
  auto localTargetResponse = localTargetRequest.response.wait(waitScope);
  KJ_REQUIRE(localTargetResponse.statusCode == 200,
      "local buffer target request failed", localTargetResponse.statusCode);
  KJ_REQUIRE(localTargetResponse.body->readAllText().wait(waitScope) ==
          "{\"received\":[1,2,3,4],\"receivedSecond\":[5,6],\"detached\":true}",
      "local buffer target did not receive FIFO messages and detach the returned backing store");
  auto localSourceResponse = localSourceRequest.response.wait(waitScope);
  KJ_REQUIRE(localSourceResponse.statusCode == 200,
      "local buffer source request failed", localSourceResponse.statusCode);
  KJ_REQUIRE(localSourceResponse.body->readAllText().wait(waitScope) ==
          "{\"detached\":true,\"reply\":[9,2,3,4]}",
      "local buffer source did not receive the returned backing store");

  auto runProtocolScript = [&](kj::StringPtr label,
      kj::ArrayPtr<const kj::byte> firstBody, kj::StringPtr firstSteps,
      kj::ArrayPtr<const kj::byte> secondBody, kj::StringPtr secondSteps,
      kj::StringPtr expectedFirst, kj::StringPtr expectedSecond) {
    auto open = host.openLocalCapnpChannelRequest();
    open.setFirstGrainId("testgrain123");
    open.setFirstName(kj::str(label, "-first"));
    open.setSecondGrainId("peergrain123");
    open.setSecondName(kj::str(label, "-second"));
    auto revoker = open.send().wait(waitScope).getRevoker();

    kj::HttpHeaders firstHeaders(*headerTable);
    auto firstRequest = httpClient->request(kj::HttpMethod::POST,
        kj::str("https://grain.invalid/local-capnp-script?name=", label,
            "-first&steps=", firstSteps),
        firstHeaders, firstBody.size());
    firstRequest.body->write(firstBody.begin(), firstBody.size()).wait(waitScope);
    firstRequest.body = nullptr;
    kj::HttpHeaders secondHeaders(*headerTable);
    auto secondRequest = peerClient->request(kj::HttpMethod::POST,
        kj::str("https://grain.invalid/local-capnp-script?name=", label,
            "-second&steps=", secondSteps),
        secondHeaders, secondBody.size());
    secondRequest.body->write(secondBody.begin(), secondBody.size()).wait(waitScope);
    secondRequest.body = nullptr;

    auto secondResponse = secondRequest.response.wait(waitScope);
    KJ_REQUIRE(secondResponse.statusCode == 200,
        "second local Cap'n Proto protocol script failed", label, secondResponse.statusCode);
    KJ_REQUIRE(secondResponse.body->readAllText().wait(waitScope) == expectedSecond,
        "second local Cap'n Proto protocol script returned the wrong result", label);
    auto firstResponse = firstRequest.response.wait(waitScope);
    KJ_REQUIRE(firstResponse.statusCode == 200,
        "first local Cap'n Proto protocol script failed", label, firstResponse.statusCode);
    KJ_REQUIRE(firstResponse.body->readAllText().wait(waitScope) == expectedFirst,
        "first local Cap'n Proto protocol script returned the wrong result", label);
  };

  // A receiverAnswer is valid only when it names an unfinished question posed by the descriptor
  // sender. This sequence also exercises capabilities in params, pipelined answers, and releases
  // from both Call and Finish.
  auto receiverBootstrap = sandstorm::makeBootstrapFrame(0);
  auto receiverCallWithCap = sandstorm::makeCallWithSenderHostedParamFrame(1, 0, 0);
  auto receiverNestedReturn = sandstorm::makeReturnFrame(0);
  auto receiverFinishBootstrap = sandstorm::makeFinishFrame(0, true);
  auto receiverFinishCall = sandstorm::makeFinishFrame(1, true);
  auto receiverFirstBody = sandstorm::packRpcFrames({receiverBootstrap.asPtr(),
      receiverCallWithCap.asPtr(), receiverNestedReturn.asPtr(),
      receiverFinishBootstrap.asPtr(), receiverFinishCall.asPtr()});
  auto receiverBootstrapReturn = sandstorm::makeReturnFrame(0, uint32_t(0));
  auto receiverNestedCall = sandstorm::makeCallFrame(0, 0);
  auto receiverAnswerReturn = sandstorm::makeReceiverAnswerReturnFrame(1, 0);
  auto receiverFinishNested = sandstorm::makeFinishFrame(0, true);
  auto receiverSecondBody = sandstorm::packRpcFrames({receiverBootstrapReturn.asPtr(),
      receiverNestedCall.asPtr(), receiverAnswerReturn.asPtr(), receiverFinishNested.asPtr()});
  runProtocolScript("receiver-answer", receiverFirstBody, "srsrsrssr",
      receiverSecondBody, "rsrsrsrrs",
      "{\"rejected\":false,\"revoked\":false}",
      "{\"rejected\":false,\"revoked\":false}");

  // Promise exports remain authoritative after resolution and until both the promise and its
  // resolved capability have been explicitly released.
  auto promiseBootstrap = sandstorm::makeBootstrapFrame(0);
  auto promiseCall = sandstorm::makeCallFrame(1, 0);
  auto promiseRelease = sandstorm::makeReleaseFrame(0, 1);
  auto promiseResolvedRelease = sandstorm::makeReleaseFrame(1, 1);
  auto promiseFinishBootstrap = sandstorm::makeFinishFrame(0, false);
  auto promiseFinishCall = sandstorm::makeFinishFrame(1, true);
  auto promiseFirstBody = sandstorm::packRpcFrames({promiseBootstrap.asPtr(),
      promiseCall.asPtr(), promiseRelease.asPtr(), promiseResolvedRelease.asPtr(),
      promiseFinishBootstrap.asPtr(), promiseFinishCall.asPtr()});
  auto promiseReturn = sandstorm::makePromiseReturnFrame(0, 0);
  auto promiseResolve = sandstorm::makeResolveHostedFrame(0, 1);
  auto promiseCallReturn = sandstorm::makeReturnFrame(1);
  auto promiseSecondBody = sandstorm::packRpcFrames(
      {promiseReturn.asPtr(), promiseResolve.asPtr(), promiseCallReturn.asPtr()});
  runProtocolScript("promise-resolution", promiseFirstBody, "srsrrssss",
      promiseSecondBody, "rsrssrrrr",
      "{\"rejected\":false,\"revoked\":false}",
      "{\"rejected\":false,\"revoked\":false}");

  auto overReleaseBootstrap = sandstorm::makeBootstrapFrame(0);
  auto overRelease = sandstorm::makeReleaseFrame(0, 2);
  auto overReleaseFirstBody = sandstorm::packRpcFrames(
      {overReleaseBootstrap.asPtr(), overRelease.asPtr()});
  auto overReleaseReturn = sandstorm::makeReturnFrame(0, uint32_t(0));
  auto overReleaseSecondBody = sandstorm::packRpcFrames({overReleaseReturn.asPtr()});
  runProtocolScript("over-release", overReleaseFirstBody, "srx",
      overReleaseSecondBody, "rsc",
      "{\"rejected\":true,\"revoked\":false}",
      "{\"rejected\":false,\"revoked\":true}");

  auto unknownAnswerBootstrap = sandstorm::makeBootstrapFrame(0);
  auto unknownAnswerFirstBody = sandstorm::packRpcFrames({unknownAnswerBootstrap.asPtr()});
  auto unknownAnswerReturn = sandstorm::makeReceiverAnswerReturnFrame(0, 999);
  auto unknownAnswerSecondBody = sandstorm::packRpcFrames({unknownAnswerReturn.asPtr()});
  runProtocolScript("unknown-receiver-answer", unknownAnswerFirstBody, "sc",
      unknownAnswerSecondBody, "rx",
      "{\"rejected\":false,\"revoked\":true}",
      "{\"rejected\":true,\"revoked\":false}");

  auto thirdPartyBootstrap = sandstorm::makeBootstrapFrame(0);
  auto thirdPartyFirstBody = sandstorm::packRpcFrames({thirdPartyBootstrap.asPtr()});
  auto thirdPartyReturn = sandstorm::makeThirdPartyReturnFrame(0);
  auto thirdPartySecondBody = sandstorm::packRpcFrames({thirdPartyReturn.asPtr()});
  runProtocolScript("third-party-descriptor", thirdPartyFirstBody, "sc",
      thirdPartySecondBody, "rx",
      "{\"rejected\":false,\"revoked\":true}",
      "{\"rejected\":true,\"revoked\":false}");

  auto bootstrapFrame = sandstorm::makeBootstrapFrame(0);
  auto finishBootstrapFrame = sandstorm::makeFinishFrame(0, false);
  auto callFrame = sandstorm::makeCallFrame(1, 0);
  auto finishCallFrame = sandstorm::makeFinishFrame(1, true);
  auto releaseFrame = sandstorm::makeReleaseFrame(0, 1);
  auto bootstrapReturnFrame = sandstorm::makeReturnFrame(0, uint32_t(0));
  auto callReturnFrame = sandstorm::makeReturnFrame(1);
  auto capnpSourceBody = sandstorm::packRpcFrames({bootstrapFrame.asPtr(),
      finishBootstrapFrame.asPtr(), callFrame.asPtr(), finishCallFrame.asPtr(),
      releaseFrame.asPtr()});
  auto capnpTargetBody = sandstorm::packRpcFrames(
      {bootstrapReturnFrame.asPtr(), callReturnFrame.asPtr()});

  auto openCapnpLink = host.openLocalCapnpChannelRequest();
  openCapnpLink.setFirstGrainId("testgrain123");
  openCapnpLink.setFirstName("capnp-source");
  openCapnpLink.setSecondGrainId("peergrain123");
  openCapnpLink.setSecondName("capnp-target");
  auto capnpLinkRevoker = openCapnpLink.send().wait(waitScope).getRevoker();

  kj::HttpHeaders capnpSourceHeaders(*headerTable);
  auto capnpSourceRequest = httpClient->request(kj::HttpMethod::POST,
      "https://grain.invalid/local-capnp-source?name=capnp-source",
      capnpSourceHeaders, capnpSourceBody.size());
  capnpSourceRequest.body->write(capnpSourceBody.begin(), capnpSourceBody.size()).wait(waitScope);
  capnpSourceRequest.body = nullptr;
  kj::HttpHeaders capnpTargetHeaders(*headerTable);
  auto capnpTargetRequest = peerClient->request(kj::HttpMethod::POST,
      "https://grain.invalid/local-capnp-target?name=capnp-target",
      capnpTargetHeaders, capnpTargetBody.size());
  capnpTargetRequest.body->write(capnpTargetBody.begin(), capnpTargetBody.size()).wait(waitScope);
  capnpTargetRequest.body = nullptr;

  auto capnpTargetResponse = capnpTargetRequest.response.wait(waitScope);
  KJ_REQUIRE(capnpTargetResponse.statusCode == 200,
      "local Cap'n Proto target request failed", capnpTargetResponse.statusCode);
  KJ_REQUIRE(capnpTargetResponse.body->readAllText().wait(waitScope) == "detached",
      "local Cap'n Proto target frames were not transferred");
  auto capnpSourceResponse = capnpSourceRequest.response.wait(waitScope);
  KJ_REQUIRE(capnpSourceResponse.statusCode == 200,
      "local Cap'n Proto source request failed", capnpSourceResponse.statusCode);
  KJ_REQUIRE(capnpSourceResponse.body->readAllText().wait(waitScope) == "detached",
      "local Cap'n Proto source frames were not transferred");

  auto openForgedLink = host.openLocalCapnpChannelRequest();
  openForgedLink.setFirstGrainId("testgrain123");
  openForgedLink.setFirstName("capnp-forged-source");
  openForgedLink.setSecondGrainId("peergrain123");
  openForgedLink.setSecondName("capnp-forged-target");
  auto forgedLinkRevoker = openForgedLink.send().wait(waitScope).getRevoker();
  kj::HttpHeaders forgedTargetHeaders(*headerTable);
  auto forgedTargetRequest = peerClient->request(kj::HttpMethod::POST,
      "https://grain.invalid/local-buffer-wait-for-close?name=capnp-forged-target",
      forgedTargetHeaders, uint64_t(0));
  forgedTargetRequest.body = nullptr;
  auto forgedFrame = sandstorm::makeCallFrame(0, 999);
  auto forgedBytes = forgedFrame.asBytes();
  kj::HttpHeaders forgedHeaders(*headerTable);
  auto forgedRequest = httpClient->request(kj::HttpMethod::POST,
      "https://grain.invalid/local-capnp-reject?name=capnp-forged-source",
      forgedHeaders, forgedBytes.size());
  forgedRequest.body->write(forgedBytes.begin(), forgedBytes.size()).wait(waitScope);
  forgedRequest.body = nullptr;
  auto forgedResponse = forgedRequest.response.wait(waitScope);
  KJ_REQUIRE(forgedResponse.statusCode == 409,
      "local Cap'n Proto authority gate accepted an ungranted import",
      forgedResponse.statusCode);
  KJ_REQUIRE(forgedResponse.body->readAllText().wait(waitScope) == "rejected",
      "local Cap'n Proto authority rejection returned the wrong response");
  auto forgedTargetResponse = forgedTargetRequest.response.wait(waitScope);
  KJ_REQUIRE(forgedTargetResponse.statusCode == 410,
      "local Cap'n Proto authority rejection did not revoke the peer endpoint",
      forgedTargetResponse.statusCode);
  KJ_REQUIRE(forgedTargetResponse.body->readAllText().wait(waitScope) == "revoked",
      "local Cap'n Proto peer revocation returned the wrong response");

  auto openRevokedLink = host.openLocalBufferChannelRequest();
  openRevokedLink.setFirstGrainId("testgrain123");
  openRevokedLink.setFirstName("revoked-source");
  openRevokedLink.setSecondGrainId("peergrain123");
  openRevokedLink.setSecondName("revoked-target");
  auto revokedLinkRevoker = openRevokedLink.send().wait(waitScope).getRevoker();

  kj::HttpHeaders revokedSourceHeaders(*headerTable);
  auto revokedSourceRequest = httpClient->request(kj::HttpMethod::GET,
      "https://grain.invalid/local-buffer-wait-for-close?name=revoked-source",
      revokedSourceHeaders);
  kj::HttpHeaders revokedTargetHeaders(*headerTable);
  auto revokedTargetRequest = peerClient->request(kj::HttpMethod::GET,
      "https://grain.invalid/local-buffer-close?name=revoked-target", revokedTargetHeaders);
  auto revokedTargetResponse = revokedTargetRequest.response.wait(waitScope);
  KJ_REQUIRE(revokedTargetResponse.statusCode == 200,
      "local buffer close request failed", revokedTargetResponse.statusCode);
  KJ_REQUIRE(revokedTargetResponse.body->readAllText().wait(waitScope) == "closed",
      "local buffer target did not close its endpoint");
  auto revokedSourceResponse = revokedSourceRequest.response.wait(waitScope);
  KJ_REQUIRE(revokedSourceResponse.statusCode == 410,
      "local buffer revocation did not reject an in-flight receive",
      revokedSourceResponse.statusCode);
  KJ_REQUIRE(revokedSourceResponse.body->readAllText().wait(waitScope) == "revoked",
      "local buffer revocation returned the wrong error response");

  auto openExplicitlyRevokedLink = host.openLocalBufferChannelRequest();
  openExplicitlyRevokedLink.setFirstGrainId("testgrain123");
  openExplicitlyRevokedLink.setFirstName("explicitly-revoked-source");
  openExplicitlyRevokedLink.setSecondGrainId("peergrain123");
  openExplicitlyRevokedLink.setSecondName("explicitly-revoked-target");
  auto explicitLinkRevoker =
      openExplicitlyRevokedLink.send().wait(waitScope).getRevoker();

  kj::HttpHeaders explicitlyRevokedHeaders(*headerTable);
  auto explicitlyRevokedRequest = httpClient->request(kj::HttpMethod::GET,
      "https://grain.invalid/local-buffer-wait-for-close?name=explicitly-revoked-source",
      explicitlyRevokedHeaders);
  explicitLinkRevoker = nullptr;
  auto explicitlyRevokedResponse = explicitlyRevokedRequest.response.wait(waitScope);
  KJ_REQUIRE(explicitlyRevokedResponse.statusCode == 410,
      "dropping the local-link revoker did not reject an in-flight receive",
      explicitlyRevokedResponse.statusCode);
  KJ_REQUIRE(explicitlyRevokedResponse.body->readAllText().wait(waitScope) == "revoked",
      "explicit local-link revocation returned the wrong response");
  peerGrain.stopRequest().send().wait(waitScope);

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
