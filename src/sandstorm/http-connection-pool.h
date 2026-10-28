// Experimental, session-local pool for fully consumed HTTP responses.
#pragma once
#include <kj/async-io.h>
#include <kj/vector.h>
#include <kj/memory.h>
#include <kj/debug.h>
#include <time.h>

namespace sandstorm {
class HttpConnectionPool final: public kj::Refcounted {
public:
  explicit HttpConnectionPool(size_t limit = 20): limit(limit) {}

  kj::Maybe<kj::Own<kj::AsyncIoStream>> take() {
    while (idle.size() > 0) {
      auto entry = kj::mv(idle.back());
      idle.removeLast();
      if (!entry->disconnected && now() - entry->since < 5) {
        return kj::mv(entry->stream);
      }
    }
    return nullptr;
  }

  void put(kj::Own<kj::AsyncIoStream> stream) {
    if (idle.size() < limit) idle.add(kj::heap<Idle>(kj::mv(stream)));
  }

private:
  static uint64_t now() {
    timespec value;
    KJ_SYSCALL(clock_gettime(CLOCK_MONOTONIC, &value));
    return value.tv_sec;
  }
  struct Idle {
    kj::Own<kj::AsyncIoStream> stream;
    uint64_t since = now();
    bool disconnected = false;
    // Destroy the observer before its stream. Idle objects never move in memory.
    kj::Promise<void> observer;
    explicit Idle(kj::Own<kj::AsyncIoStream> stream): stream(kj::mv(stream)),
        observer(this->stream->whenWriteDisconnected().then([this]() {
          disconnected = true;
        }, [this](kj::Exception&&) {
          disconnected = true;
        }).eagerlyEvaluate(nullptr)) {}
  };
  size_t limit;
  kj::Vector<kj::Own<Idle>> idle;
};
}  // namespace sandstorm
