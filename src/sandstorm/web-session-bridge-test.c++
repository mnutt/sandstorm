#include "web-session-bridge.h"
#include <kj/test.h>
#include <kj/timer.h>

namespace sandstorm {
namespace {

class ErrorSession final: public WebSession::Server {
public:
  explicit ErrorSession(uint status): status(status) {}
  kj::Promise<void> get(GetContext context) override {
    auto result = context.getResults();
    if (status < 500) {
      auto error = result.initClientError();
      error.setStatusCode(status == 401 ? WebSession::Response::ClientErrorCode::UNAUTHORIZED
          : WebSession::Response::ClientErrorCode::TOO_MANY_REQUESTS);
      if (status == 499) {
        error.setStatusCode(static_cast<WebSession::Response::ClientErrorCode>(999));
      }
      auto body = error.initNonHtmlBody();
      body.setMimeType("application/json");
      body.setData(kj::StringPtr("{\"error\":\"test\"}").asBytes());
    } else {
      auto error = result.initServerError();
      error.setStatusCode(static_cast<WebSession::Response::ServerErrorCode>(status - 500));
      auto body = error.initNonHtmlBody();
      body.setMimeType("application/json");
      body.setData(kj::StringPtr("{\"error\":\"test\"}").asBytes());
    }
    auto headers = result.initAdditionalHeaders(6);
    const char* names[] = { "retry-after", "x-request-id", "x-ratelimit-remaining-tokens",
      "www-authenticate", "set-cookie", "content-security-policy" };
    for (uint i = 0; i < 6; ++i) {
      headers[i].setName(names[i]);
      headers[i].setValue("untrusted-value");
    }
    return kj::READY_NOW;
  }
private:
  uint status;
};

KJ_TEST("API error statuses and JSON bodies survive the local HTTP bridge without auth challenges") {
  kj::EventLoop loop;
  kj::WaitScope waitScope(loop);
  kj::TimerImpl timer(kj::origin<kj::TimePoint>());
  kj::HttpHeaderTable::Builder builder;
  WebSessionBridge::Tables tables(builder);
  auto headerTable = builder.build();
  for (bool localApi: {false, true}) {
    for (uint status: {401, 429, 499, 500, 502, 503, 504, 599}) {
      WebSessionBridge::Options options;
      options.allowApiResponseHeaders = localApi;
      WebSessionBridge bridge(timer, kj::heap<ErrorSession>(status), nullptr, tables, options);
      auto client = kj::newHttpClient(bridge);
      kj::HttpHeaders requestHeaders(*headerTable);
      auto request = client->request(kj::HttpMethod::GET, "/responses", requestHeaders);
      auto response = request.response.wait(waitScope);
      KJ_EXPECT(response.statusCode == (status == 599 ? 500 : status == 499 ? 400 : status));
      KJ_EXPECT(response.body->readAllText().wait(waitScope) == "{\"error\":\"test\"}");
      KJ_EXPECT(KJ_ASSERT_NONNULL(response.headers->get(kj::HttpHeaderId::CONTENT_TYPE)) == "application/json");
      bool operational = false;
      response.headers->forEach([&](kj::StringPtr name, kj::StringPtr value) {
        KJ_EXPECT(name != "www-authenticate");
        KJ_EXPECT(name != "set-cookie");
        if (name == "retry-after" || name == "x-request-id" ||
            name == "x-ratelimit-remaining-tokens") {
          operational = true;
          KJ_EXPECT(localApi);
        }
        if (name == "Content-Security-Policy") { KJ_EXPECT(value != "untrusted-value"); }
      });
      KJ_EXPECT(operational == localApi);
    }
  }
}

}  // namespace
}  // namespace sandstorm
