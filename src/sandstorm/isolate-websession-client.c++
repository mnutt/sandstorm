// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2026 Sandstorm contributors
// All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

#include <capnp/rpc-twoparty.h>
#include <kj/async-io.h>
#include <kj/debug.h>
#include <kj/main.h>
#include <sandstorm/util.h>
#include <sandstorm/grain.capnp.h>
#include <sandstorm/identity.capnp.h>
#include <sandstorm/supervisor.capnp.h>
#include <sandstorm/util.capnp.h>
#include <sandstorm/web-session.capnp.h>

namespace sandstorm {

bool contains(kj::StringPtr haystack, kj::StringPtr needle) {
  if (needle.size() > haystack.size()) {
    return false;
  }

  for (size_t i = 0; i <= haystack.size() - needle.size(); ++i) {
    if (haystack.slice(i).startsWith(needle)) {
      return true;
    }
  }

  return false;
}

class IgnoreByteStream final: public ByteStream::Server {
public:
  kj::Promise<void> write(WriteContext context) override {
    (void)context;
    return kj::READY_NOW;
  }
};

class FakeSessionContext final: public SessionContext::Server {
public:
  kj::Promise<void> claimRequest(ClaimRequestContext context) override {
    auto params = context.getParams();
    KJ_REQUIRE(params.getRequestToken() == "websession-test-token");
    auto requiredPermissions = params.getRequiredPermissions();
    KJ_REQUIRE(requiredPermissions.size() == 1);
    KJ_REQUIRE(requiredPermissions[0]);
    claimCount++;
    context.getResults().setCap(kj::heap<CapRedirector>());
    return kj::READY_NOW;
  }

  uint claimCount = 0;
};

class IsolateWebSessionClientMain {
public:
  explicit IsolateWebSessionClientMain(kj::ProcessContext& context)
      : context(context), io(kj::setupAsyncIo()) {}

  kj::MainFunc getMain() {
    return kj::MainBuilder(context, "Sandstorm isolate WebSession integration client",
        "Connects to an isolate supervisor socket and validates the WebSession path.")
        .expectArg("<supervisor-socket>", KJ_BIND_METHOD(*this, setSocketPath))
        .callAfterParsing(KJ_BIND_METHOD(*this, run))
        .build();
  }

  kj::MainBuilder::Validity setSocketPath(kj::StringPtr path) {
    socketPath = kj::heapString(path);
    return true;
  }

  kj::MainBuilder::Validity run() {
    KJ_REQUIRE(socketPath != nullptr);

    auto address = io.provider->getNetwork()
        .parseAddress(kj::str("unix:", socketPath), 0)
        .wait(io.waitScope);
    auto stream = address->connect().wait(io.waitScope);

    capnp::TwoPartyVatNetwork network(*stream, capnp::rpc::twoparty::Side::CLIENT);
    auto rpcSystem = capnp::makeRpcClient(network);

    capnp::MallocMessageBuilder vatMessage;
    auto hostId = vatMessage.initRoot<capnp::rpc::twoparty::VatId>();
    hostId.setSide(capnp::rpc::twoparty::Side::SERVER);

    auto supervisor = rpcSystem.bootstrap(hostId).castAs<Supervisor>();
    auto view = supervisor.getMainViewRequest().send().wait(io.waitScope).getView();

    auto sessionRequest = view.newSessionRequest();
    auto userInfo = sessionRequest.initUserInfo();
    userInfo.initDisplayName().setDefaultText("WebSession Test User");
    userInfo.setPreferredHandle("websession-test");
    userInfo.setPictureUrl("https://static.invalid/user.png");
    userInfo.setPronouns(Profile::Pronouns::ROBOT);
    userInfo.initPermissions(1).set(0, true);
    userInfo.setIdentityId(
        kj::StringPtr("0123456789abcdef0123456789abcdef").asBytes());
    auto sessionContext = kj::heap<FakeSessionContext>();
    auto& sessionContextRef = *sessionContext;
    sessionRequest.setContext(kj::mv(sessionContext));
    sessionRequest.setSessionType(capnp::typeId<WebSession>());
    auto sessionParams = sessionRequest.getSessionParams().initAs<WebSession::Params>();
    sessionParams.setBasePath("https://ui-test.invalid");
    sessionParams.setUserAgent("isolate-websession-client");
    auto languages = sessionParams.initAcceptableLanguages(2);
    languages.set(0, "en-US");
    languages.set(1, "en");
    sessionRequest.setTabId(kj::StringPtr("websession-tab").asBytes());

    auto session = sessionRequest.send().wait(io.waitScope).getSession().castAs<WebSession>();

    auto getRequest = session.getRequest();
    getRequest.setPath("/");
    getRequest.setIgnoreBody(false);
    auto getContext = getRequest.initContext();
    getContext.setResponseStream(kj::heap<IgnoreByteStream>());
    getContext.initCookies(0);
    getContext.initAccept(0);
    getContext.initAcceptEncoding(0);
    getContext.initAdditionalHeaders(1);
    getContext.getAdditionalHeaders()[0].setName("x-sandstorm-app-test-websession");
    getContext.getAdditionalHeaders()[0].setValue("present");

    auto response = getRequest.send().wait(io.waitScope);
    KJ_REQUIRE(response.which() == WebSession::Response::CONTENT);
    auto content = response.getContent();
    KJ_REQUIRE(content.getStatusCode() == WebSession::Response::SuccessCode::OK);
    KJ_REQUIRE(content.getMimeType().startsWith("application/json"));
    KJ_REQUIRE(content.getBody().which() == WebSession::Response::Content::Body::BYTES);

    auto body = kj::str(content.getBody().getBytes().asChars());
    KJ_REQUIRE(contains(body, "\"ok\":true"), body);
    KJ_REQUIRE(contains(body, "\"pathname\":\"/\""), body);
    KJ_REQUIRE(contains(body, "\"x-sandstorm-session-id\":\""), body);
    KJ_REQUIRE(!contains(body, "\"x-sandstorm-session-id\":\"0\""), body);
    KJ_REQUIRE(contains(body, "\"x-sandstorm-username\":\"WebSession Test User\""), body);
    KJ_REQUIRE(contains(body, "\"x-sandstorm-preferred-handle\":\"websession-test\""), body);
    KJ_REQUIRE(contains(body, "\"x-sandstorm-tab-id\":\"77656273657373696f6e2d746162\""), body);

    auto claimRequest = session.getRequest();
    claimRequest.setPath("/claim-powerbox?token=websession-test-token&requiredPermissions=view");
    claimRequest.setIgnoreBody(false);
    auto claimContext = claimRequest.initContext();
    claimContext.setResponseStream(kj::heap<IgnoreByteStream>());
    claimContext.initCookies(0);
    claimContext.initAccept(0);
    claimContext.initAcceptEncoding(0);
    claimContext.initAdditionalHeaders(0);

    auto claimResponse = claimRequest.send().wait(io.waitScope);
    KJ_REQUIRE(claimResponse.which() == WebSession::Response::CONTENT);
    auto claimContent = claimResponse.getContent();
    KJ_REQUIRE(claimContent.getStatusCode() == WebSession::Response::SuccessCode::OK);
    KJ_REQUIRE(claimContent.getBody().which() == WebSession::Response::Content::Body::BYTES);
    auto claimBody = kj::str(claimContent.getBody().getBytes().asChars());
    KJ_REQUIRE(contains(claimBody, "\"ok\":true"), claimBody);
    KJ_REQUIRE(contains(claimBody, "\"type\":\"claimedCapability\""), claimBody);
    KJ_REQUIRE(contains(claimBody, "\"id\":\""), claimBody);
    KJ_REQUIRE(contains(claimBody, "\"drop\":{\"status\":200,\"body\":{\"ok\":true}}"), claimBody);
    KJ_REQUIRE(sessionContextRef.claimCount == 1, sessionContextRef.claimCount);

    auto badClaimRequest = session.getRequest();
    badClaimRequest.setPath(
        "/claim-powerbox?token=websession-test-token&requiredPermissions=not-a-permission");
    badClaimRequest.setIgnoreBody(false);
    auto badClaimContext = badClaimRequest.initContext();
    badClaimContext.setResponseStream(kj::heap<IgnoreByteStream>());
    badClaimContext.initCookies(0);
    badClaimContext.initAccept(0);
    badClaimContext.initAcceptEncoding(0);
    badClaimContext.initAdditionalHeaders(0);

    auto badClaimResponse = badClaimRequest.send().wait(io.waitScope);
    KJ_REQUIRE(badClaimResponse.which() == WebSession::Response::CLIENT_ERROR);
    auto badClaim = badClaimResponse.getClientError();
    KJ_REQUIRE(badClaim.getStatusCode() == WebSession::Response::ClientErrorCode::BAD_REQUEST);
    KJ_REQUIRE(badClaim.hasNonHtmlBody());
    auto badClaimBody = kj::str(badClaim.getNonHtmlBody().getData().asChars());
    KJ_REQUIRE(contains(badClaimBody, "unknown required permission"), badClaimBody);
    KJ_REQUIRE(sessionContextRef.claimCount == 1, sessionContextRef.claimCount);

    return true;
  }

private:
  kj::ProcessContext& context;
  kj::AsyncIoContext io;
  kj::String socketPath;
};

}  // namespace sandstorm

KJ_MAIN(sandstorm::IsolateWebSessionClientMain)
