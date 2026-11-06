// Integration peer for tests/http-outbound-stream-rpc.test.cjs. Exercises the actual Node binding
// against the C++ HTTP receiver, including release without ByteStream.done().
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
  KJ_FAIL_REQUIRE("unsupported probe mode");
}
