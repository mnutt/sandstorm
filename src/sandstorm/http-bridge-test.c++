#define SANDSTORM_HTTP_BRIDGE_TEST
#include "sandstorm-http-bridge.c++"
#include <kj/test.h>

namespace sandstorm {
class DiscardStream final: public ByteStream::Server {
  kj::Promise<void> expectSize(ExpectSizeContext) override { return kj::READY_NOW; }
  kj::Promise<void> write(WriteContext) override { return kj::READY_NOW; }
  kj::Promise<void> done(DoneContext) override { return kj::READY_NOW; }
};
KJ_TEST("only complete persistent buffered responses are reusable") {
  auto io = kj::setupAsyncIo();
  for (auto response: {
      "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok",
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n0\r\n\r\n",
      "HTTP/1.1 204 No Content\r\n\r\n"}) {
    auto pipe = kj::newTwoWayPipe();
    auto write = pipe.ends[1]->write(response, strlen(response));
    HttpParser parser(kj::heap<DiscardStream>(), false, true);
    parser.readResponse(*pipe.ends[0]).wait(io.waitScope);
    write.wait(io.waitScope);
    KJ_EXPECT(parser.canReuse());
  }
  for (auto response: {
      "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
      "HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nok"}) {
    auto pipe = kj::newTwoWayPipe();
    auto write = pipe.ends[1]->write(response, strlen(response));
    HttpParser parser(kj::heap<DiscardStream>(), false, true);
    parser.readResponse(*pipe.ends[0]).wait(io.waitScope);
    write.wait(io.waitScope);
    KJ_EXPECT(!parser.canReuse());
  }
}

KJ_TEST("persistent parser rejects bytes after a completed response") {
  auto io = kj::setupAsyncIo();
  auto pipe = kj::newTwoWayPipe();
  auto response = kj::str("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nokunexpected");
  auto write = pipe.ends[1]->write(response.begin(), response.size());
  HttpParser parser(kj::heap<DiscardStream>(), false, true);
  KJ_EXPECT_THROW_MESSAGE("Failed to parse HTTP response", parser.readResponse(*pipe.ends[0]).wait(io.waitScope));
  write.wait(io.waitScope);
}

KJ_TEST("incomplete streaming responses are not eligible for reuse") {
  auto io = kj::setupAsyncIo();
  auto pipe = kj::newTwoWayPipe();
  auto response = kj::str("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n");
  auto write = pipe.ends[1]->write(response.begin(), response.size());
  HttpParser parser(kj::heap<DiscardStream>(), false, true);
  parser.readResponse(*pipe.ends[0]).wait(io.waitScope);
  write.wait(io.waitScope);
  KJ_EXPECT(!parser.canReuse());
}

KJ_TEST("successive buffered responses reuse one stream without mixing bodies") {
  auto io = kj::setupAsyncIo();
  auto pipe = kj::newTwoWayPipe();
  HttpConnectionPool pool;
  auto original = pipe.ends[0].get();
  pool.put(kj::mv(pipe.ends[0]));
  for (auto body: {"one", "two", "three"}) {
    auto stream = KJ_ASSERT_NONNULL(pool.take());
    KJ_EXPECT(stream.get() == original);
    auto response = kj::str("HTTP/1.1 200 OK\r\nContent-Length: ", strlen(body), "\r\n\r\n", body);
    auto write = pipe.ends[1]->write(response.begin(), response.size());
    HttpParser parser(kj::heap<DiscardStream>(), false, true);
    parser.readResponse(*stream).wait(io.waitScope);
    write.wait(io.waitScope);
    capnp::MallocMessageBuilder message;
    auto result = message.initRoot<WebSession::Response>();
    parser.build(result, nullptr);
    KJ_EXPECT(kj::str(result.getContent().getBody().getBytes().asChars()) == body);
    KJ_EXPECT(parser.canReuse());
    pool.put(kj::mv(stream));
  }
}

class CollectStream final: public ByteStream::Server {
public:
  CollectStream(kj::Vector<byte>& bytes, kj::Own<kj::PromiseFulfiller<void>> done)
      : bytes(bytes), finished(kj::mv(done)) {}
  kj::Promise<void> expectSize(ExpectSizeContext) override { return kj::READY_NOW; }
  kj::Promise<void> write(WriteContext context) override {
    bytes.addAll(context.getParams().getData());
    return kj::READY_NOW;
  }
  kj::Promise<void> done(DoneContext) override {
    finished->fulfill();
    return kj::READY_NOW;
  }
private:
  kj::Vector<byte>& bytes;
  kj::Own<kj::PromiseFulfiller<void>> finished;
};

KJ_TEST("fragmented streaming responses recycle only after the complete body") {
  auto io = kj::setupAsyncIo();
  for (bool chunked: {false, true}) {
    auto pipe = kj::newTwoWayPipe();
    auto original = pipe.ends[0].get();
    auto pool = kj::refcounted<HttpConnectionPool>();
    kj::Vector<byte> bytes;
    auto done = kj::newPromiseAndFulfiller<void>();
    HttpParser parser(kj::heap<CollectStream>(bytes, kj::mv(done.fulfiller)), false, true);
    parser.setReusePool(kj::addRef(*pool));
    auto header = kj::str("HTTP/1.1 200 OK\r\n",
        chunked ? "Transfer-Encoding: chunked" : "Content-Length: 6", "\r\n\r\n");
    auto write = pipe.ends[1]->write(header.begin(), header.size());
    parser.readResponse(*pipe.ends[0]).wait(io.waitScope);
    write.wait(io.waitScope);
    parser.pumpStream(kj::mv(pipe.ends[0]));
    KJ_EXPECT(pool->take() == nullptr);
    auto first = kj::str(chunked ? "3\r\none\r\n" : "one");
    pipe.ends[1]->write(first.begin(), first.size()).wait(io.waitScope);
    KJ_EXPECT(pool->take() == nullptr);
    auto last = kj::str(chunked ? "3\r\ntwo\r\n0\r\n\r\n" : "two");
    pipe.ends[1]->write(last.begin(), last.size()).wait(io.waitScope);
    done.promise.wait(io.waitScope);
    KJ_EXPECT(kj::str(bytes.asPtr().asChars()) == "onetwo");
    auto reused = KJ_ASSERT_NONNULL(pool->take());
    KJ_EXPECT(reused.get() == original);
  }
}

KJ_TEST("canceling an incomplete streamed response closes rather than recycles its socket") {
  auto io = kj::setupAsyncIo();
  auto pipe = kj::newTwoWayPipe();
  auto pool = kj::refcounted<HttpConnectionPool>();
  {
    HttpParser parser(kj::heap<DiscardStream>(), false, true);
    parser.setReusePool(kj::addRef(*pool));
    auto header = kj::str("HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\n");
    auto write = pipe.ends[1]->write(header.begin(), header.size());
    parser.readResponse(*pipe.ends[0]).wait(io.waitScope);
    write.wait(io.waitScope);
    parser.pumpStream(kj::mv(pipe.ends[0]));
  }
  pipe.ends[1]->whenWriteDisconnected().wait(io.waitScope);
  KJ_EXPECT(pool->take() == nullptr);
}

class RejectStream final: public ByteStream::Server {
public:
  explicit RejectStream(kj::Own<kj::PromiseFulfiller<void>> called): called(kj::mv(called)) {}
  kj::Promise<void> expectSize(ExpectSizeContext) override { return kj::READY_NOW; }
  kj::Promise<void> write(WriteContext) override {
    called->fulfill();
    return KJ_EXCEPTION(DISCONNECTED, "client canceled delivery");
  }
private:
  kj::Own<kj::PromiseFulfiller<void>> called;
};

KJ_TEST("downstream failure after recycling cannot abort the next request's socket") {
  auto io = kj::setupAsyncIo();
  auto pipe = kj::newTwoWayPipe();
  auto pool = kj::refcounted<HttpConnectionPool>();
  auto called = kj::newPromiseAndFulfiller<void>();
  HttpParser parser(kj::heap<RejectStream>(kj::mv(called.fulfiller)), false, true);
  parser.setReusePool(kj::addRef(*pool));
  auto header = kj::str("HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\n");
  auto write = pipe.ends[1]->write(header.begin(), header.size());
  parser.readResponse(*pipe.ends[0]).wait(io.waitScope);
  write.wait(io.waitScope);
  parser.pumpStream(kj::mv(pipe.ends[0]));
  pipe.ends[1]->write("one", 3).wait(io.waitScope);
  called.promise.wait(io.waitScope);
  auto reused = KJ_ASSERT_NONNULL(pool->take());
  auto nextWrite = pipe.ends[1]->write("two", 3);
  char buffer[3];
  reused->read(buffer, 3).wait(io.waitScope);
  nextWrite.wait(io.waitScope);
  KJ_EXPECT(kj::arrayPtr(buffer, 3) == kj::arrayPtr("two", 3));
}

KJ_TEST("idle pool is bounded and discards disconnected connections") {
  auto io = kj::setupAsyncIo();
  HttpConnectionPool pool(1);
  auto first = kj::newTwoWayPipe();
  auto second = kj::newTwoWayPipe();
  pool.put(kj::mv(first.ends[0]));
  pool.put(kj::mv(second.ends[0]));
  KJ_EXPECT(pool.take() != nullptr);
  KJ_EXPECT(pool.take() == nullptr);
  auto closed = kj::newTwoWayPipe();
  pool.put(kj::mv(closed.ends[0]));
  closed.ends[1] = nullptr;
  kj::evalLater([]() {}).wait(io.waitScope);
  KJ_EXPECT(pool.take() == nullptr);
}
}  // namespace sandstorm
