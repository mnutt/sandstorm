// Regression for an oversized forwarded email breaking unrelated backend calls.
#include "email-rpc-test.capnp.h"
#include <capnp/rpc-twoparty.h>
#include <kj/async-io.h>
#include <kj/test.h>
#include <cstring>

namespace sandstorm {
namespace {

class Inbox final: public EmailSendPort::Server {
public:
  unsigned deliveries = 0;
  size_t lastSize = 0;

  kj::Promise<void> send(SendContext context) override {
    auto attachments = context.getParams().getEmail().getAttachments();
    KJ_REQUIRE(attachments.size() == 1);
    lastSize = attachments[0].getContent().size();
    ++deliveries;
    return kj::READY_NOW;
  }
};

class Backend final: public test::EmailRpcProbe::Server {
public:
  explicit Backend(EmailSendPort::Client port): port(kj::mv(port)) {}

  kj::Promise<void> getMail(GetMailContext context) override {
    context.getResults().setPort(port);
    return kj::READY_NOW;
  }

  kj::Promise<void> ping(PingContext) override {
    return kj::READY_NOW;
  }

private:
  EmailSendPort::Client port;
};

struct Fixture {
  static capnp::ReaderOptions readerOptions(int nestingLimit) {
    capnp::ReaderOptions result;
    result.nestingLimit = nestingLimit;
    return result;
  }

  explicit Fixture(int nestingLimit = 64)
      : backendNetwork(*shellPipe.ends[1], capnp::rpc::twoparty::Side::SERVER,
                       readerOptions(nestingLimit)),
        backend(capnp::makeRpcServer(backendNetwork,
            kj::heap<Backend>(backendToGrain.bootstrap().castAs<EmailSendPort>()))) {}

  kj::EventLoop loop;
  kj::WaitScope waitScope{loop};
  kj::TwoWayPipe grainPipe = kj::newTwoWayPipe();
  kj::TwoWayPipe shellPipe = kj::newTwoWayPipe();
  kj::Own<Inbox> inbox = kj::heap<Inbox>();
  Inbox& inboxRef = *inbox;
  capnp::TwoPartyClient grain{*grainPipe.ends[1], kj::mv(inbox),
      capnp::rpc::twoparty::Side::SERVER};
  capnp::TwoPartyClient backendToGrain{*grainPipe.ends[0]};
  capnp::TwoPartyVatNetwork backendNetwork;
  capnp::RpcSystem<capnp::rpc::twoparty::VatId> backend;
  capnp::TwoPartyClient shell{*shellPipe.ends[0]};
  test::EmailRpcProbe::Client root = shell.bootstrap().castAs<test::EmailRpcProbe>();

  EmailSendPort::Client getMail() {
    return root.getMailRequest().send().wait(waitScope).getPort();
  }

  void deliver(EmailSendPort::Client& port, size_t bytes) {
    auto request = port.sendRequest();
    request.initEmail().initAttachments(1)[0].initContent(bytes);
    request.send().wait(waitScope);
  }
};

constexpr size_t LARGE_ATTACHMENT = 40 * 1024 * 1024;

KJ_TEST("small forwarded email leaves unrelated backend calls working") {
  Fixture f;
  auto port = f.getMail();
  f.root.pingRequest().send().wait(f.waitScope);
  f.deliver(port, 1024);
  f.root.pingRequest().send().wait(f.waitScope);
  KJ_EXPECT(f.inboxRef.deliveries == 1);
  KJ_EXPECT(f.inboxRef.lastSize == 1024);
}

KJ_TEST("40 MiB email works on a direct RPC connection") {
  Fixture f;
  // Same email and default reader limits, but no intermediate RPC forwarding copy.
  auto direct = f.backendToGrain.bootstrap().castAs<EmailSendPort>();
  f.deliver(direct, LARGE_ATTACHMENT);
  KJ_EXPECT(f.inboxRef.deliveries == 1);
  KJ_EXPECT(f.inboxRef.lastSize == LARGE_ATTACHMENT);
  f.root.pingRequest().send().wait(f.waitScope);
}

KJ_TEST("40 MiB forwarded email is delivered and leaves backend calls working") {
  Fixture f;
  auto port = f.getMail();
  f.deliver(port, LARGE_ATTACHMENT);
  KJ_EXPECT(f.inboxRef.deliveries == 1);
  KJ_EXPECT(f.inboxRef.lastSize == LARGE_ATTACHMENT);
  f.root.pingRequest().send().wait(f.waitScope);
  f.deliver(port, 1024);
  KJ_EXPECT(f.inboxRef.deliveries == 2);
}

KJ_TEST("70 MiB email is rejected without breaking the connection") {
  Fixture f;
  auto port = f.getMail();
  f.deliver(port, 1024);
  f.root.pingRequest().send().wait(f.waitScope);

  // This exceeds the default outgoing single-message size limit. Rejection
  // happens at the sending endpoint, before the forwarding copy is attempted.
  auto deliveryError = kj::runCatchingExceptions([&]() {
    f.deliver(port, 70 * 1024 * 1024);
  });
  KJ_EXPECT(deliveryError != nullptr);
  KJ_IF_MAYBE(error, deliveryError) {
    KJ_EXPECT(error->getType() == kj::Exception::Type::FAILED, *error);
    KJ_EXPECT(std::strstr(error->getDescription().cStr(),
        "single-message size limit") != nullptr, *error);
  }
  KJ_EXPECT(f.inboxRef.deliveries == 1);

  f.root.pingRequest().send().wait(f.waitScope);
  f.deliver(port, 1024);
  KJ_EXPECT(f.inboxRef.deliveries == 2);
  KJ_EXPECT(f.inboxRef.lastSize == 1024);
}

KJ_TEST("forwarding failure must not break unrelated backend calls") {
  // Constrain nesting only on the forwarding connection to provoke a real
  // parameter-copy failure with a small message, independent of size hints.
  Fixture f(5);
  auto port = f.getMail();
  f.root.pingRequest().send().wait(f.waitScope);

  auto deliveryError = kj::runCatchingExceptions([&]() {
    f.deliver(port, 1024);
  });
  KJ_EXPECT(deliveryError != nullptr);
  KJ_IF_MAYBE(error, deliveryError) {
    KJ_EXPECT(error->getType() == kj::Exception::Type::FAILED, *error);
    KJ_EXPECT(std::strstr(error->getDescription().cStr(),
        "nesting") != nullptr, *error);
  }
  KJ_EXPECT(f.inboxRef.deliveries == 0);

  // These must work even if the large delivery failed. In the broken version
  // both instead report "Return message falsely claims call was canceled."
  auto pingError = kj::runCatchingExceptions([&]() {
    f.root.pingRequest().send().wait(f.waitScope);
  });
  KJ_IF_MAYBE(error, pingError) { KJ_FAIL_EXPECT("Unrelated backend call failed", *error); }
  // The independent connection to the grain must also remain usable.
  auto direct = f.backendToGrain.bootstrap().castAs<EmailSendPort>();
  f.deliver(direct, 1024);
  KJ_EXPECT(f.inboxRef.deliveries == 1);
}

}  // namespace
}  // namespace sandstorm
