// Integration peer for tests/http-api-stream-rpc.test.cjs. Exercises the actual Node binding
// against the C++ HTTP receiver, including release without ByteStream.done().
#include "web-session-bridge.h"
#include <sandstorm/outbound-http-session.capnp.h>
#include <capnp/rpc-twoparty.h>
#include <kj/async-io.h>
#include <kj/debug.h>
#include <iostream>

class UploadProbeSink final: public sandstorm::ByteStream::Server {
public:
  UploadProbeSink(std::string& body, kj::Own<kj::PromiseFulfiller<void>> completed)
      : body(body), completed(kj::mv(completed)) {}
  kj::Promise<void> write(WriteContext context) override {
    auto data = context.getParams().getData();
    body.append(reinterpret_cast<const char*>(data.begin()), data.size());
    return kj::READY_NOW;
  }
  kj::Promise<void> done(DoneContext context) override {
    completed->fulfill();
    return kj::READY_NOW;
  }
private:
  std::string& body;
  kj::Own<kj::PromiseFulfiller<void>> completed;
};

int main(int argc, char** argv) {
  KJ_REQUIRE(argc == 3, "expected socket address and test mode");
  auto io = kj::setupAsyncIo();
  auto address = io.provider->getNetwork().parseAddress(argv[1]).wait(io.waitScope);
  auto listener = address->listen();
  std::cout << "ready" << std::endl;
  auto socket = listener->accept().wait(io.waitScope);
  capnp::TwoPartyClient rpc(*socket, nullptr, capnp::rpc::twoparty::Side::SERVER);
  if (kj::StringPtr(argv[2]) == "upload") {
    auto outbound = rpc.bootstrap().castAs<sandstorm::OutboundHttpSession>();
    std::string body;
    auto completed = kj::newPromiseAndFulfiller<void>();
    auto request = outbound.requestStreamingRequest();
    request.setMethod(sandstorm::OutboundHttpSession::Method::PUT);
    request.setPath("upload");
    request.setResponseStream(kj::heap<UploadProbeSink>(body, kj::mv(completed.fulfiller)));
    auto stream = request.send().getRequestStream();
    auto response = stream.getResponseRequest().send();
    auto expected = stream.expectSizeRequest();
    expected.setSize(5);
    expected.send().wait(io.waitScope);
    auto write = stream.writeRequest();
    write.setData(kj::arrayPtr(reinterpret_cast<const kj::byte*>("hello"), 5));
    write.send().wait(io.waitScope);
    stream.doneRequest().send().wait(io.waitScope);
    KJ_REQUIRE(response.wait(io.waitScope).getStatusCode() == 201);
    io.provider->getTimer().timeoutAfter(3 * kj::SECONDS, kj::mv(completed.promise)).wait(io.waitScope);
    KJ_REQUIRE(body == "hello");
    std::cout << "passed" << std::endl;
    return 0;
  }
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
