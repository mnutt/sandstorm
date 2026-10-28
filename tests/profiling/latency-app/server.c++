// Minimal HTTP workload for measuring the Sandstorm gateway/RPC/HTTP-bridge path.
// The same binary runs directly on the host for the control measurement.
#include <kj/async-io.h>
#include <kj/compat/http.h>
#include <kj/debug.h>
#include <time.h>
#include <unistd.h>

static uint64_t monotonicNs() {
  timespec time;
  KJ_SYSCALL(clock_gettime(CLOCK_MONOTONIC, &time));
  return uint64_t(time.tv_sec) * 1000000000 + time.tv_nsec;
}

class Service final: public kj::HttpService {
public:
  explicit Service(const kj::HttpHeaderTable& table): table(table) {}
  kj::Promise<void> request(kj::HttpMethod method, kj::StringPtr url,
      const kj::HttpHeaders&, kj::AsyncInputStream&, Response& response) override {
    auto received = monotonicNs();
    kj::HttpHeaders headers(table);
    headers.set(kj::HttpHeaderId::CONTENT_TYPE, "text/plain");
    headers.add("Cache-Control", "no-store");
    if (method != kj::HttpMethod::GET || (url != "/" && !url.startsWith("/ping?id="))) {
      auto body = kj::str("not found\n");
      auto stream = response.send(404, "Not Found", headers, body.size());
      return stream->write(body.begin(), body.size()).attach(kj::mv(stream), kj::mv(body));
    }
    auto id = url == "/" ? kj::StringPtr("ready") : url.slice(9);
    KJ_REQUIRE(id.size() <= 80, "request ID too long");
    for (char c: id) KJ_REQUIRE((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-',
        "invalid request ID");
    // These are application-boundary timestamps, not kernel send/receive timestamps.
    auto sending = monotonicNs();
    auto body = kj::str("sandstorm-latency-v1\n", id, "\n", getpid(), "\n",
                        received, "\n", sending, "\n", bootId, "\n");
    auto stream = response.send(200, "OK", headers, body.size());
    return stream->write(body.begin(), body.size()).attach(kj::mv(stream), kj::mv(body));
  }
private:
  const kj::HttpHeaderTable& table;
  const uint64_t bootId = monotonicNs();
};

int main(int argc, char** argv) {
  KJ_REQUIRE(argc == 2, "usage: latency-test-app PORT");
  auto io = kj::setupAsyncIo();
  kj::HttpHeaderTable table;
  Service service(table);
  kj::HttpServer server(io.provider->getTimer(), table, service);
  auto address = io.provider->getNetwork().parseAddress(kj::str("127.0.0.1:", argv[1])).wait(io.waitScope);
  auto listener = address->listen();
  server.listenHttp(*listener).wait(io.waitScope);
}
