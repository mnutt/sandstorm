#include "fixture.capnp.h"
#include <capnp/ez-rpc.h>
#include <kj/debug.h>
#include <cstdint>
#include <iostream>
#include <limits>
#include <memory>
#include <sys/stat.h>

namespace {
struct Stats {
  uint32_t counters = 0;
  uint32_t streams = 0;
  uint32_t sentChunks = 0;
};

class StreamImpl final: public Stream::Server, private kj::TaskSet::ErrorHandler {
public:
  StreamImpl(ByteSink::Client sink, uint32_t count, uint32_t bytes,
             std::shared_ptr<Stats> stats)
      : sink(kj::mv(sink)), count(count), bytes(bytes), stats(kj::mv(stats)), tasks(*this) {
    ++this->stats->streams;
    tasks.add(pump(0));
  }
  ~StreamImpl() noexcept { --stats->streams; }

private:
  ByteSink::Client sink;
  uint32_t count;
  uint32_t bytes;
  std::shared_ptr<Stats> stats;
  kj::TaskSet tasks;

  kj::Promise<void> pump(uint32_t sequence) {
    if (sequence == count) {
      auto request = sink.doneRequest();
      request.setCount(count);
      return request.send().ignoreResult();
    }
    auto request = sink.writeRequest();
    request.setSequence(sequence);
    auto data = request.initData(bytes);
    for (uint32_t i = 0; i < bytes; ++i) data[i] = (sequence + i) % 251;
    ++stats->sentChunks;
    return request.send().then([this, sequence](auto&&) { return pump(sequence + 1); });
  }
  kj::Promise<void> cancel(CancelContext) override {
    tasks.clear();
    return kj::READY_NOW;
  }
  void taskFailed(kj::Exception&&) override {
    // Browser callback failure/connection loss ends this ephemeral stream.
  }
};

class CounterImpl final: public Counter::Server {
public:
  CounterImpl(uint32_t value, std::shared_ptr<Stats> stats)
      : value(value), stats(kj::mv(stats)) { ++this->stats->counters; }
  ~CounterImpl() noexcept { --stats->counters; }

private:
  uint32_t value;
  std::shared_ptr<Stats> stats;

  kj::Promise<void> add(AddContext context) override {
    auto amount = context.getParams().getAmount();
    KJ_REQUIRE(amount <= std::numeric_limits<uint32_t>::max() - value, "counter overflow");
    value += amount;
    context.getResults().setValue(value);
    return kj::READY_NOW;
  }
  kj::Promise<void> report(ReportContext context) override {
    auto request = context.getParams().getObserver().changedRequest();
    request.setValue(value);
    return request.send().ignoreResult();
  }
  kj::Promise<void> fail(FailContext) override {
    return KJ_EXCEPTION(FAILED, "intentional C++ fixture exception");
  }
  kj::Promise<void> stream(StreamContext context) override {
    auto params = context.getParams();
    KJ_REQUIRE(params.getCount() <= 64, "at most 64 chunks");
    KJ_REQUIRE(params.getChunkBytes() <= 16384, "at most 16 KiB per chunk");
    KJ_REQUIRE(stats->streams < 16, "at most 16 stream capabilities");
    context.getResults().setStream(kj::heap<StreamImpl>(
        params.getSink(), params.getCount(), params.getChunkBytes(), stats));
    return kj::READY_NOW;
  }
};

class FixtureImpl final: public Fixture::Server {
  std::shared_ptr<Stats> stats = std::make_shared<Stats>();
  kj::Promise<void> newCounter(NewCounterContext context) override {
    KJ_REQUIRE(stats->counters < 64, "at most 64 counter capabilities");
    context.getResults().setCounter(kj::heap<CounterImpl>(context.getParams().getInitial(), stats));
    return kj::READY_NOW;
  }
  kj::Promise<void> inspect(InspectContext context) override {
    auto results = context.getResults();
    results.setLiveCounters(stats->counters);
    results.setLiveStreams(stats->streams);
    results.setSentChunks(stats->sentChunks);
    return kj::READY_NOW;
  }
};
}  // namespace

int main(int argc, char** argv) {
  if (argc != 2) {
    std::cerr << "Usage: rust-shell/target/cpp-fixture /absolute/path/to/fixture.sock\n";
    return 2;
  }
  // Never remove an existing socket: the caller owns the private directory.
  umask(0077);
  capnp::EzRpcServer server(kj::heap<FixtureImpl>(), kj::str("unix:", argv[1]));
  server.getPort().wait(server.getWaitScope());
  std::cout << "C++ fixture ready" << std::endl;
  kj::NEVER_DONE.wait(server.getWaitScope());
}
