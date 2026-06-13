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

class FakeClaimedCapability final: public SystemPersistent::Server {
public:
  explicit FakeClaimedCapability(uint& saveCount): saveCount(saveCount) {}

  kj::Promise<void> save(SaveContext context) override {
    auto params = context.getParams();
    KJ_REQUIRE(params.getSealFor().which() == ApiTokenOwner::GRAIN);
    auto owner = params.getSealFor().getGrain();
    KJ_REQUIRE(owner.getGrainId().size() > 0);
    KJ_REQUIRE(owner.getSaveLabel().getDefaultText() == "WebSession saved capability");
    ++saveCount;
    context.getResults().setSturdyRef(kj::StringPtr("websession-saved-token").asBytes());
    return kj::READY_NOW;
  }

private:
  uint& saveCount;
};

class FakeSessionContext final: public SessionContext::Server {
public:
  kj::Promise<void> claimRequest(ClaimRequestContext context) override {
    auto params = context.getParams();
    KJ_REQUIRE(params.getRequestToken() == "websession/test+token==");
    auto requiredPermissions = params.getRequiredPermissions();
    KJ_REQUIRE(requiredPermissions.size() == 1);
    KJ_REQUIRE(requiredPermissions[0]);
    claimCount++;
    context.getResults().setCap(kj::heap<FakeClaimedCapability>(saveCount));
    return kj::READY_NOW;
  }

  uint claimCount = 0;
  uint saveCount = 0;
  uint restoreCount = 0;
  uint tokenDropCount = 0;
};

class FakeSandstormCore final: public SandstormCore::Server {
public:
  explicit FakeSandstormCore(FakeSessionContext& sessionContext)
      : sessionContext(sessionContext) {}

  kj::Promise<void> restore(RestoreContext context) override {
    auto token = context.getParams().getToken();
    auto tokenText = kj::heapString(token.asChars());
    KJ_REQUIRE(tokenText == "websession-saved-token");
    ++sessionContext.restoreCount;
    context.getResults().setCap(kj::heap<FakeClaimedCapability>(sessionContext.saveCount));
    return kj::READY_NOW;
  }

  kj::Promise<void> drop(DropContext context) override {
    auto token = context.getParams().getToken();
    auto tokenText = kj::heapString(token.asChars());
    KJ_REQUIRE(tokenText == "websession-saved-token");
    ++sessionContext.tokenDropCount;
    return kj::READY_NOW;
  }

private:
  FakeSessionContext& sessionContext;
};

kj::String responseDebugBody(WebSession::Response::Reader response) {
  switch (response.which()) {
    case WebSession::Response::CONTENT:
      if (response.getContent().getBody().which() ==
          WebSession::Response::Content::Body::BYTES) {
        return kj::str(response.getContent().getBody().getBytes().asChars());
      }
      return kj::str("<streaming content>");
    case WebSession::Response::CLIENT_ERROR:
      if (response.getClientError().hasNonHtmlBody()) {
        return kj::str(response.getClientError().getNonHtmlBody().getData().asChars());
      } else {
        return kj::str(response.getClientError().getDescriptionHtml());
      }
    case WebSession::Response::SERVER_ERROR:
      if (response.getServerError().hasNonHtmlBody()) {
        return kj::str(response.getServerError().getNonHtmlBody().getData().asChars());
      } else {
        return kj::str(response.getServerError().getDescriptionHtml());
      }
    default:
      return kj::str("<response kind ", static_cast<uint>(response.which()), ">");
  }
}

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
    auto sessionContext = kj::heap<FakeSessionContext>();
    auto& sessionContextRef = *sessionContext;

    capnp::TwoPartyVatNetwork network(*stream, capnp::rpc::twoparty::Side::CLIENT);
    auto rpcSystem = capnp::makeRpcServer(
        network, kj::heap<FakeSandstormCore>(sessionContextRef));

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
    auto preconditions = getContext.getETagPrecondition().initMatchesNoneOf(2);
    preconditions[0].setValue("cached-etag");
    preconditions[1].setValue("weak-cached-etag");
    preconditions[1].setWeak(true);

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
    KJ_REQUIRE(contains(body, "\"if-none-match\":\"\\\"cached-etag\\\", W/\\\"weak-cached-etag\\\"\""),
        body);

    auto headersRequest = session.getRequest();
    headersRequest.setPath("/headers");
    headersRequest.setIgnoreBody(false);
    auto headersContext = headersRequest.initContext();
    headersContext.setResponseStream(kj::heap<IgnoreByteStream>());
    headersContext.initCookies(0);
    headersContext.initAccept(0);
    headersContext.initAcceptEncoding(0);
    headersContext.initAdditionalHeaders(0);

    auto headersResponse = headersRequest.send().wait(io.waitScope);
    auto headersDebugBody = responseDebugBody(headersResponse);
    KJ_REQUIRE(headersResponse.which() == WebSession::Response::CONTENT, headersDebugBody);
    KJ_REQUIRE(headersResponse.getContent().getMimeType().startsWith("text/plain"));
    KJ_REQUIRE(headersResponse.getAdditionalHeaders().size() == 1,
        headersResponse.getAdditionalHeaders().size());
    KJ_REQUIRE(headersResponse.getAdditionalHeaders()[0].getName() ==
        "x-sandstorm-app-test-response");
    KJ_REQUIRE(headersResponse.getAdditionalHeaders()[0].getValue() == "present");

    auto attachmentRequest = session.getRequest();
    attachmentRequest.setPath("/attachment");
    attachmentRequest.setIgnoreBody(false);
    auto attachmentContext = attachmentRequest.initContext();
    attachmentContext.setResponseStream(kj::heap<IgnoreByteStream>());
    attachmentContext.initCookies(0);
    attachmentContext.initAccept(0);
    attachmentContext.initAcceptEncoding(0);
    attachmentContext.initAdditionalHeaders(0);

    auto attachmentResponse = attachmentRequest.send().wait(io.waitScope);
    auto attachmentDebugBody = responseDebugBody(attachmentResponse);
    KJ_REQUIRE(attachmentResponse.which() == WebSession::Response::CONTENT, attachmentDebugBody);
    auto attachmentContent = attachmentResponse.getContent();
    KJ_REQUIRE(attachmentContent.getMimeType().startsWith("text/plain"));
    KJ_REQUIRE(attachmentContent.hasETag());
    KJ_REQUIRE(attachmentContent.getETag().getValue() == "fixture-etag");
    KJ_REQUIRE(!attachmentContent.getETag().getWeak());
    KJ_REQUIRE(attachmentContent.getDisposition().which() ==
        WebSession::Response::Content::Disposition::DOWNLOAD);
    KJ_REQUIRE(attachmentContent.getDisposition().getDownload() == "fixture.txt");

    auto emptyRequest = session.getRequest();
    emptyRequest.setPath("/empty");
    emptyRequest.setIgnoreBody(false);
    auto emptyContext = emptyRequest.initContext();
    emptyContext.setResponseStream(kj::heap<IgnoreByteStream>());
    emptyContext.initCookies(0);
    emptyContext.initAccept(0);
    emptyContext.initAcceptEncoding(0);
    emptyContext.initAdditionalHeaders(0);

    auto emptyResponse = emptyRequest.send().wait(io.waitScope);
    KJ_REQUIRE(emptyResponse.which() == WebSession::Response::NO_CONTENT,
        responseDebugBody(emptyResponse));
    KJ_REQUIRE(!emptyResponse.getNoContent().getShouldResetForm());
    KJ_REQUIRE(emptyResponse.getNoContent().hasETag());
    KJ_REQUIRE(emptyResponse.getNoContent().getETag().getValue() == "empty-etag");
    KJ_REQUIRE(emptyResponse.getNoContent().getETag().getWeak());

    auto notModifiedRequest = session.getRequest();
    notModifiedRequest.setPath("/not-modified");
    notModifiedRequest.setIgnoreBody(false);
    auto notModifiedContext = notModifiedRequest.initContext();
    notModifiedContext.setResponseStream(kj::heap<IgnoreByteStream>());
    notModifiedContext.initCookies(0);
    notModifiedContext.initAccept(0);
    notModifiedContext.initAcceptEncoding(0);
    notModifiedContext.initAdditionalHeaders(0);

    auto notModifiedResponse = notModifiedRequest.send().wait(io.waitScope);
    KJ_REQUIRE(notModifiedResponse.which() == WebSession::Response::PRECONDITION_FAILED,
        responseDebugBody(notModifiedResponse));
    KJ_REQUIRE(notModifiedResponse.getPreconditionFailed().hasMatchingETag());
    KJ_REQUIRE(notModifiedResponse.getPreconditionFailed().getMatchingETag().getValue() ==
        "not-modified-etag");
    KJ_REQUIRE(!notModifiedResponse.getPreconditionFailed().getMatchingETag().getWeak());

    auto errorRequest = session.getRequest();
    errorRequest.setPath("/error");
    errorRequest.setIgnoreBody(false);
    auto errorContext = errorRequest.initContext();
    errorContext.setResponseStream(kj::heap<IgnoreByteStream>());
    errorContext.initCookies(0);
    errorContext.initAccept(0);
    errorContext.initAcceptEncoding(0);
    errorContext.initAdditionalHeaders(0);

    auto errorResponse = errorRequest.send().wait(io.waitScope);
    KJ_REQUIRE(errorResponse.which() == WebSession::Response::CLIENT_ERROR,
        responseDebugBody(errorResponse));
    KJ_REQUIRE(errorResponse.getClientError().getStatusCode() ==
        WebSession::Response::ClientErrorCode::IM_A_TEAPOT);
    KJ_REQUIRE(errorResponse.getClientError().hasNonHtmlBody());
    KJ_REQUIRE(kj::str(errorResponse.getClientError().getNonHtmlBody().getData().asChars()) ==
        "fixture failure");

    auto claimRequest = session.getRequest();
    claimRequest.setPath(
        "/claim-powerbox?token=websession%2Ftest%2Btoken%3D%3D&requiredPermission=view"
        "&save=true&store=true&restore=true&storageKey=websession-saved-capability"
        "&dropSaved=true&label=WebSession%20saved%20capability");
    claimRequest.setIgnoreBody(false);
    auto claimContext = claimRequest.initContext();
    claimContext.setResponseStream(kj::heap<IgnoreByteStream>());
    claimContext.initCookies(0);
    claimContext.initAccept(0);
    claimContext.initAcceptEncoding(0);
    claimContext.initAdditionalHeaders(0);

    auto claimResponse = claimRequest.send().wait(io.waitScope);
    auto claimDebugBody = responseDebugBody(claimResponse);
    KJ_REQUIRE(claimResponse.which() == WebSession::Response::CONTENT, claimDebugBody);
    auto claimContent = claimResponse.getContent();
    KJ_REQUIRE(claimContent.getStatusCode() == WebSession::Response::SuccessCode::OK);
    KJ_REQUIRE(claimContent.getBody().which() == WebSession::Response::Content::Body::BYTES);
    auto claimBody = kj::str(claimContent.getBody().getBytes().asChars());
    KJ_REQUIRE(contains(claimBody, "\"ok\":true"), claimBody);
    KJ_REQUIRE(contains(claimBody, "\"type\":\"claimedCapability\""), claimBody);
    KJ_REQUIRE(contains(claimBody, "\"id\":\""), claimBody);
    KJ_REQUIRE(contains(claimBody, "\"save\":{\"status\":200,\"body\":{\"ok\":true"), claimBody);
    KJ_REQUIRE(contains(claimBody, "\"type\":\"savedCapability\""), claimBody);
    KJ_REQUIRE(contains(claimBody, "\"tokenEncoding\":\"base64url\""), claimBody);
    KJ_REQUIRE(contains(claimBody,
        "\"stored\":{\"key\":\"websession-saved-capability\",\"put\":{\"status\":200"),
        claimBody);
    KJ_REQUIRE(contains(claimBody, "\"token\":\"d2Vic2Vzc2lvbi1zYXZlZC10b2tlbg\""), claimBody);
    KJ_REQUIRE(contains(claimBody, "\"restore\":{\"status\":200,\"body\":{\"ok\":true"), claimBody);
    KJ_REQUIRE(contains(claimBody, "\"dropRestored\":{\"status\":200,\"body\":{\"ok\":true}}"),
        claimBody);
    KJ_REQUIRE(contains(claimBody, "\"drop\":{\"status\":200,\"body\":{\"ok\":true}}"), claimBody);
    KJ_REQUIRE(contains(claimBody, "\"dropSaved\":{\"status\":200,\"body\":{\"ok\":true}}"),
        claimBody);
    KJ_REQUIRE(sessionContextRef.claimCount == 1, sessionContextRef.claimCount);
    KJ_REQUIRE(sessionContextRef.saveCount == 1, sessionContextRef.saveCount);
    KJ_REQUIRE(sessionContextRef.restoreCount == 1, sessionContextRef.restoreCount);
    KJ_REQUIRE(sessionContextRef.tokenDropCount == 1, sessionContextRef.tokenDropCount);

    auto badClaimRequest = session.getRequest();
    badClaimRequest.setPath(
        "/claim-powerbox?token=websession%2Ftest%2Btoken%3D%3D"
        "&requiredPermission=not-a-permission");
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
    KJ_REQUIRE(sessionContextRef.saveCount == 1, sessionContextRef.saveCount);
    KJ_REQUIRE(sessionContextRef.restoreCount == 1, sessionContextRef.restoreCount);
    KJ_REQUIRE(sessionContextRef.tokenDropCount == 1, sessionContextRef.tokenDropCount);

    return true;
  }

private:
  kj::ProcessContext& context;
  kj::AsyncIoContext io;
  kj::String socketPath;
};

}  // namespace sandstorm

KJ_MAIN(sandstorm::IsolateWebSessionClientMain)
