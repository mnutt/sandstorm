// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2026 Sandstorm contributors
// Licensed under the Apache License, Version 2.0.

#include "server.h"
#include "v8-platform-impl.h"

#include <workerd/server/sandstorm-isolate-host.capnp.h>
#include <workerd/server/sandstorm-isolate-worker-source.capnp.h>
#include <workerd/io/compatibility-date.h>
#include <workerd/jsg/setup.h>

#include <capnp/rpc-twoparty.h>
#include <capnp/compat/json.h>
#include <capnp/serialize-packed.h>
#include <kj/async-io.h>
#include <kj/map.h>

#include <fcntl.h>
#include <sys/random.h>
#include <sys/stat.h>
#include <unistd.h>

namespace sandstorm {
namespace {

constexpr kj::StringPtr LOADER_NAMESPACE = "sandstorm-grains"_kj;

class SystemEntropySource final: public kj::EntropySource {
 public:
  void generate(kj::ArrayPtr<kj::byte> buffer) override {
    while (buffer.size() > 0) {
      ssize_t count;
      KJ_SYSCALL(count = getrandom(buffer.begin(), buffer.size(), 0));
      buffer = buffer.slice(count);
    }
  }
};

class BundleErrorReporter final: public workerd::Worker::ValidationErrorReporter {
 public:
  void addError(kj::String error) override { errors.add(kj::mv(error)); }
  void addEntrypoint(kj::Maybe<kj::StringPtr>, kj::Array<kj::String>) override {}
  void addActorClass(kj::StringPtr) override {}
  void addWorkflowClass(kj::StringPtr, kj::Array<kj::String>) override {}

  void requireValid() {
    KJ_REQUIRE(errors.empty(), "invalid worker compatibility settings",
        kj::strArray(errors, "; "));
  }

 private:
  kj::Vector<kj::String> errors;
};

struct BundleBacking final: public kj::AtomicRefcounted {
  kj::Own<capnp::PackedFdMessageReader> source;
  capnp::MallocMessageBuilder compatibility;
};

struct LoadedWorkerSource {
  workerd::DynamicWorkerSource source;
  kj::Own<BundleBacking> backing;
};

class SharedHttpService: public kj::HttpService, public kj::AtomicRefcounted {
 public:
  virtual ~SharedHttpService() noexcept = default;
};

class BindingHttpService final: public SharedHttpService {
 public:
  BindingHttpService(int sourceGrainDirFd, kj::String bindingName)
      : bindingName(kj::mv(bindingName)), headerTable(headerTableBuilder.build()) {
    KJ_SYSCALL(grainDirFd = fcntl(sourceGrainDirFd, F_DUPFD_CLOEXEC, 0));
  }

  ~BindingHttpService() noexcept { close(grainDirFd); }

  kj::Promise<void> request(kj::HttpMethod method, kj::StringPtr url,
      const kj::HttpHeaders& headers, kj::AsyncInputStream& requestBody,
      kj::HttpService::Response& response) override {
    auto body = kj::str("{\n  \"ok\": false,\n  \"error\": \"shared-host ",
        bindingName, " adapter is not connected\"\n}\n");
    kj::HttpHeaders responseHeaders(*headerTable);
    responseHeaders.setPtr(
        kj::HttpHeaderId::CONTENT_TYPE, "application/json; charset=utf-8"_kj);
    auto stream = response.send(501, "Not Implemented", responseHeaders, body.size());
    return stream->write(body.asBytes()).attach(kj::mv(stream), kj::mv(body));
  }

 private:
  int grainDirFd;
  kj::String bindingName;
  kj::HttpHeaderTable::Builder headerTableBuilder;
  kj::Own<kj::HttpHeaderTable> headerTable;
};

class HttpServiceWorkerInterface final: public workerd::WorkerInterface {
 public:
  explicit HttpServiceWorkerInterface(kj::Own<SharedHttpService> service)
      : service(kj::mv(service)) {}

  kj::Promise<void> request(kj::HttpMethod method, kj::StringPtr url,
      const kj::HttpHeaders& headers, kj::AsyncInputStream& requestBody,
      kj::HttpService::Response& response) override {
    return service->request(method, url, headers, requestBody, response);
  }
  kj::Promise<void> connect(kj::StringPtr host, const kj::HttpHeaders& headers,
      kj::AsyncIoStream& connection, ConnectResponse& response,
      kj::HttpConnectSettings settings) override {
    return service->connect(host, headers, connection, response, kj::mv(settings));
  }
  kj::Promise<void> prewarm(kj::StringPtr) override { return kj::READY_NOW; }
  kj::Promise<ScheduledResult> runScheduled(kj::Date, kj::StringPtr) override {
    KJ_FAIL_REQUIRE("Unix HTTP bindings do not support scheduled events");
  }
  kj::Promise<AlarmResult> runAlarm(kj::Date, uint32_t) override {
    KJ_FAIL_REQUIRE("Unix HTTP bindings do not support alarm events");
  }
  kj::Promise<CustomEvent::Result> customEvent(kj::Own<CustomEvent> event) override {
    return event->notSupported().attach(kj::mv(event));
  }

 private:
  kj::Own<SharedHttpService> service;
};

class HttpServiceChannel final: public workerd::IoChannelFactory::SubrequestChannel,
                                public kj::AtomicRefcounted {
 public:
  explicit HttpServiceChannel(kj::Own<SharedHttpService> service)
      : service(kj::mv(service)) {}

  kj::Own<workerd::WorkerInterface> startRequest(
      workerd::IoChannelFactory::SubrequestMetadata) override {
    return kj::heap<HttpServiceWorkerInterface>(kj::atomicAddRef(*service));
  }

  void requireAllowsTransfer() override {
    KJ_FAIL_REQUIRE("Sandstorm in-process HTTP bindings cannot be transferred");
  }
  kj::OneOf<kj::Array<kj::byte>, kj::Promise<kj::Array<kj::byte>>> getTokenMaybeSync(
      workerd::IoChannelFactory::ChannelTokenUsage) override {
    KJ_FAIL_REQUIRE("Sandstorm in-process HTTP bindings cannot be tokenized");
  }

 private:
  kj::Own<SharedHttpService> service;
};

LoadedWorkerSource loadWorkerSource(int grainDirFd) {
  int runtimeFd;
  KJ_SYSCALL(runtimeFd = openat(grainDirFd, "isolate-runtime",
      O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
  kj::AutoCloseFd runtimeDir(runtimeFd);
  int sourceFd;
  KJ_SYSCALL(sourceFd = openat(runtimeDir, "worker-source.capnp.bin",
      O_RDONLY | O_NOFOLLOW | O_CLOEXEC));

  auto backing = kj::atomicRefcounted<BundleBacking>();
  backing->source = kj::heap<capnp::PackedFdMessageReader>(kj::AutoCloseFd(sourceFd));
  auto bundle = backing->source->getRoot<IsolateWorkerSource>();
  auto inputModules = bundle.getModules();
  KJ_REQUIRE(inputModules.size() > 0, "worker bundle has no modules");
  kj::HashSet<kj::String> moduleNames;
  bool foundMainModule = false;
  auto modules = kj::heapArrayBuilder<workerd::WorkerSource::Module>(inputModules.size());
  for (auto input: inputModules) {
    KJ_REQUIRE(input.getName().size() > 0, "worker bundle has an empty module name");
    KJ_REQUIRE(moduleNames.find(input.getName()) == kj::none,
        "worker bundle has a duplicate module name", input.getName());
    moduleNames.insert(kj::str(input.getName()));
    if (input.getName() == bundle.getMainModule()) foundMainModule = true;
    workerd::WorkerSource::Module output{.name = input.getName()};
    switch (input.which()) {
      case IsolateWorkerSource::Module::ES_MODULE:
        output.content = workerd::WorkerSource::EsModule{input.getEsModule().asChars(), kj::none};
        break;
      case IsolateWorkerSource::Module::COMMON_JS_MODULE:
        {
        auto body = input.getCommonJsModule().asChars();
        output.content = workerd::WorkerSource::CommonJsModule{
          kj::StringPtr(body.begin(), body.size()), kj::none};
        break;
        }
      case IsolateWorkerSource::Module::TEXT:
        {
        auto body = input.getText().asChars();
        output.content = workerd::WorkerSource::TextModule{
          kj::StringPtr(body.begin(), body.size())};
        break;
        }
      case IsolateWorkerSource::Module::DATA:
        output.content = workerd::WorkerSource::DataModule{input.getData()};
        break;
      case IsolateWorkerSource::Module::WASM:
        output.content = workerd::WorkerSource::WasmModule{input.getWasm()};
        break;
      case IsolateWorkerSource::Module::JSON:
        {
        auto body = input.getJson().asChars();
        output.content = workerd::WorkerSource::JsonModule{
          kj::StringPtr(body.begin(), body.size())};
        break;
        }
    }
    modules.add(kj::mv(output));
  }
  KJ_REQUIRE(foundMainModule, "worker bundle main module is not present", bundle.getMainModule());

  workerd::Frankenvalue env;
  kj::HashSet<kj::String> bindingNames;
  capnp::JsonCodec json;
  for (auto binding: bundle.getBindings()) {
    KJ_REQUIRE(binding.getName().size() > 0, "worker bundle has an empty binding name");
    KJ_REQUIRE(bindingNames.find(binding.getName()) == kj::none,
        "worker bundle has a duplicate binding name", binding.getName());
    bindingNames.insert(kj::str(binding.getName()));
    capnp::MallocMessageBuilder jsonMessage;
    auto jsonValue = jsonMessage.initRoot<capnp::json::Value>();
    switch (binding.which()) {
      case IsolateWorkerSource::Binding::TEXT: {
        auto text = binding.getText().asChars();
        jsonValue.setString(kj::StringPtr(text.begin(), text.size()));
        env.setProperty(kj::str(binding.getName()),
            workerd::Frankenvalue::fromJson(json.encode(jsonValue.asReader())));
        break;
      }
      case IsolateWorkerSource::Binding::JSON: {
        auto text = binding.getJson().asChars();
        json.decode(text, jsonValue);
        env.setProperty(kj::str(binding.getName()),
            workerd::Frankenvalue::fromJson(json.encode(jsonValue.asReader())));
        break;
      }
      case IsolateWorkerSource::Binding::DATA:
        KJ_FAIL_REQUIRE("shared host does not yet support data bindings", binding.getName());
      case IsolateWorkerSource::Binding::SANDSTORM_API:
      case IsolateWorkerSource::Binding::STORAGE:
      case IsolateWorkerSource::Binding::POWERBOX: {
        env.setProperty(kj::str(binding.getName()),
            workerd::Frankenvalue::fromDirectCapability(
                kj::atomicRefcounted<HttpServiceChannel>(
                    kj::atomicRefcounted<BindingHttpService>(
                        grainDirFd, kj::str(binding.getName())))));
        break;
      }
      case IsolateWorkerSource::Binding::SERVICE:
        KJ_FAIL_REQUIRE("shared host does not yet support service bindings", binding.getName());
    }
  }
  auto compatibility = backing->compatibility.initRoot<workerd::CompatibilityFlags>();
  auto inputFlags = bundle.getCompatibilityFlags();
  auto flags = KJ_MAP(flag, inputFlags) { return kj::str(flag); };
  BundleErrorReporter reporter;
  workerd::compileCompatibilityFlags(bundle.getCompatibilityDate(), flags, compatibility,
      reporter, true, workerd::CompatibilityDateValidation::CODE_VERSION);
  reporter.requireValid();

  workerd::WorkerSource source(workerd::WorkerSource::ModulesSource{
    .mainModule = bundle.getMainModule(),
    .modules = modules.finish(),
    .capnpSchemas = {},
    .isPython = false,
    .pythonMemorySnapshot = kj::none,
  });
  workerd::DynamicWorkerSource sourceResult{
    .source = kj::mv(source),
    .compatibilityFlags = compatibility.asReader(),
    .limits = kj::none,
    .env = kj::mv(env),
    .globalOutbound = kj::none,
    .tails = {},
    .streamingTails = {},
    .ownContent = kj::atomicAddRef(*backing),
    .ownContentIsRpcResponse = false,
  };
  return {kj::mv(sourceResult), kj::mv(backing)};
}

void initRuntimeConfig(capnp::MallocMessageBuilder& message) {
  auto config = message.initRoot<workerd::server::config::Config>();
  auto service = config.initServices(1)[0];
  service.setName("sandstorm-loader-bootstrap");
  auto worker = service.initWorker();
  worker.setCompatibilityDate("2026-06-10");
  auto module = worker.initModules(1)[0];
  module.setName("bootstrap.js");
  module.setEsModule("export default { fetch() { return new Response('not exposed'); } };");
  auto binding = worker.initBindings(1)[0];
  binding.setName("GRAIN_LOADER");
  binding.initWorkerLoader().setId(LOADER_NAMESPACE);

  // Server::run() lives for the lifetime of its listeners. Keep one loopback-only listener so
  // the embedded runtime remains active; Sandstorm traffic never enters through this socket.
  auto socket = config.initSockets(1)[0];
  socket.setName("loader-bootstrap");
  socket.setAddress("127.0.0.1:0");
  socket.initHttp();
  socket.getService().setName("sandstorm-loader-bootstrap");
}

bool isValidGrainId(kj::StringPtr id) {
  return id.size() >= 8 && !id.startsWith(".") && id.findFirst('/') == kj::none;
}

struct HostedState final: public kj::Refcounted {
  HostedState(workerd::server::Server& runtime,
      kj::String grainId,
      int grainDirFd,
      kj::Own<workerd::WorkerStubChannel> worker)
      : runtime(runtime), grainId(kj::mv(grainId)), grainDirFd(grainDirFd),
        worker(kj::mv(worker)) {}

  ~HostedState() noexcept { close(grainDirFd); }

  workerd::server::Server& runtime;
  kj::String grainId;
  int grainDirFd;
  kj::Own<workerd::WorkerStubChannel> worker;
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
    state->runtime.evictDynamicWorker(LOADER_NAMESPACE, state->grainId);
    state->running = false;
    return kj::READY_NOW;
  }

 private:
  kj::Rc<HostedState> state;
};

class IsolateHostImpl final: public IsolateHost::Server {
 public:
  IsolateHostImpl(workerd::server::Server& runtime, int grainRootFd)
      : runtime(runtime), grainRootFd(grainRootFd) {}

  ~IsolateHostImpl() noexcept { close(grainRootFd); }

  kj::Promise<void> startGrain(StartGrainContext context) override {
    auto grainId = context.getParams().getGrainId();
    KJ_REQUIRE(isValidGrainId(grainId), "invalid grain ID");

    KJ_IF_SOME(existing, grains.find(grainId)) {
      if (!existing->running) grains.erase(grainId);
    }

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

      auto ownedGrainId = kj::heapString(grainId);
      auto source = loadWorkerSource(grainDir.get());
      auto worker = runtime.loadDynamicWorker(LOADER_NAMESPACE, kj::str(grainId),
          [source = kj::mv(source.source), backing = kj::mv(source.backing)]() mutable {
        return source.clone(kj::atomicAddRef(*backing));
      });
      return {kj::heapString(grainId),
        kj::rc<HostedState>(runtime, kj::mv(ownedGrainId), grainDir.release(), kj::mv(worker))};
    });
    state->running = true;
    context.getResults().setGrain(kj::heap<HostedIsolateImpl>(state.addRef()));
    return kj::READY_NOW;
  }

 private:
  workerd::server::Server& runtime;
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

  auto filesystem = kj::newDiskFilesystem();
  sandstorm::SystemEntropySource entropy;
  auto defaultPlatform = workerd::jsg::defaultPlatform(0);
  workerd::server::WorkerdPlatform v8Platform(*defaultPlatform);
  workerd::jsg::V8System v8System(v8Platform, {}, defaultPlatform.get());
  workerd::server::Server runtime(*filesystem,
      io.provider->getTimer(),
      kj::systemPreciseMonotonicClock(),
      io.provider->getNetwork(),
      entropy,
      workerd::Worker::LoggingOptions(workerd::Worker::ConsoleMode::STDOUT),
      [](kj::String error) { KJ_FAIL_REQUIRE("embedded workerd configuration error", error); });
  runtime.allowExperimental();
  capnp::MallocMessageBuilder runtimeConfig;
  sandstorm::initRuntimeConfig(runtimeConfig);
  auto runtimeTask = runtime.run(v8System, runtimeConfig.getRoot<workerd::server::config::Config>())
      .eagerlyEvaluate([](kj::Exception&& error) {
    KJ_LOG(FATAL, "embedded workerd runtime failed", error);
  });
  KJ_REQUIRE(!runtimeTask.poll(io.waitScope), "embedded workerd runtime stopped during startup");

  capnp::TwoPartyServer controlServer(
      kj::heap<sandstorm::IsolateHostImpl>(runtime, grainRootFd));
  controlServer.listen(*listener).exclusiveJoin(kj::mv(runtimeTask)).wait(io.waitScope);
}
