// Integration peer for tests/http-api-stream-rpc.test.cjs. Exercises the actual Node binding
// against the C++ HTTP receiver, including release without ByteStream.done().
#include "web-session-bridge.h"
#include <capnp/rpc-twoparty.h>
#include <kj/async-io.h>
#include <kj/debug.h>
#include <iostream>

int main(int argc, char** argv) {
  KJ_REQUIRE(argc == 3, "expected socket address and test mode");
  auto io = kj::setupAsyncIo();
  auto address = io.provider->getNetwork().parseAddress(argv[1]).wait(io.waitScope);
  auto listener = address->listen();
  std::cout << "ready" << std::endl;
  auto socket = listener->accept().wait(io.waitScope);
  capnp::TwoPartyClient rpc(*socket, nullptr, capnp::rpc::twoparty::Side::SERVER);
  auto session = rpc.bootstrap().castAs<sandstorm::WebSession>();
  kj::HttpHeaderTable::Builder builder;
  sandstorm::WebSessionBridge::Tables tables(builder);
  auto headerTable = builder.build();
  sandstorm::WebSessionBridge::Options options;
  options.allowApiResponseHeaders = true;
  auto& timer = io.provider->getTimer();
  sandstorm::WebSessionBridge bridge(timer, session, nullptr, tables, options);
  auto client = kj::newHttpClient(bridge);
  kj::HttpHeaders headers(*headerTable);
  auto request = client->request(kj::HttpMethod::GET, "/responses", headers);
  auto response = timer.timeoutAfter(3 * kj::SECONDS, kj::mv(request.response)).wait(io.waitScope);
  KJ_REQUIRE(response.statusCode == 200);
  KJ_REQUIRE(KJ_ASSERT_NONNULL(response.headers->get(kj::HttpHeaderId::CONTENT_TYPE)) ==
      "text/event-stream");
  std::cout << "headers" << std::endl;
  kj::StringPtr mode = argv[2];
  if (mode == "cancel") {
    response.body = nullptr;
    timer.afterDelay(500 * kj::MILLISECONDS).wait(io.waitScope);
  } else if (mode == "success") {
    auto body = timer.timeoutAfter(3 * kj::SECONDS, response.body->readAllText()).wait(io.waitScope);
    KJ_REQUIRE(body == "data: one\n\ndata: two\n\n", body);
  } else {
    if (mode == "stalled") timer.afterDelay(350 * kj::MILLISECONDS).wait(io.waitScope);
    bool failed = false;
    try {
      timer.timeoutAfter(3 * kj::SECONDS, response.body->readAllText()).wait(io.waitScope);
    } catch (const kj::Exception& e) {
      KJ_REQUIRE(e.getType() != kj::Exception::Type::OVERLOADED, "stream failure hung", e);
      failed = true;
    }
    KJ_REQUIRE(failed, "incomplete stream reported success");
  }
  std::cout << "passed" << std::endl;
}
