// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
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

#include "util.h"
#include "web-session-bridge.h"
#include "gateway.h"
#include "backend.h"
#include "spk.h"
#include <sodium/crypto_sign.h>
#include <sodium/crypto_hash_sha512.h>
#include "app-index/keybase.h"
#include "app-index/indexer.h"
#include <kj/encoding.h>
#include <kj/compat/gzip.h>
#include <kj/test.h>
#include <sys/wait.h>
#include <kj/async-io.h>

namespace sandstorm {
namespace {

KJ_TEST("Backup RPCs reject invalid object IDs before accessing files") {
  auto io = kj::setupAsyncIo();
  Backend::Client backend = kj::heap<BackendImpl>(*io.lowLevelProvider,
      io.provider->getNetwork(), nullptr, nullptr, nullptr, false, false);
  const char embeddedNul[] = "abcdefgh\0suffix";
  for (auto invalid: {""_kj, "short"_kj, ".abcdefgh"_kj, "abcdefgh/child"_kj,
                     kj::StringPtr(embeddedNul, sizeof(embeddedNul) - 1)}) {
    auto upload = backend.uploadBackupRequest();
    upload.setBackupId(invalid);
    KJ_EXPECT_THROW_MESSAGE("invalid object ID", upload.send().wait(io.waitScope));
    auto download = backend.downloadBackupRequest();
    download.setBackupId(invalid);
    KJ_EXPECT_THROW_MESSAGE("invalid object ID", download.send().wait(io.waitScope));
    auto remove = backend.deleteBackupRequest();
    remove.setBackupId(invalid);
    KJ_EXPECT_THROW_MESSAGE("invalid object ID", remove.send().wait(io.waitScope));
    for (bool invalidGrain: {false, true}) {
      auto backup = backend.backupGrainRequest();
      backup.setBackupId(invalidGrain ? "abcdefgh"_kj : invalid);
      backup.setGrainId(invalidGrain ? invalid : "abcdefgh"_kj);
      KJ_EXPECT_THROW_MESSAGE("invalid object ID", backup.send().wait(io.waitScope));
      auto restore = backend.restoreGrainRequest();
      restore.setBackupId(invalidGrain ? "abcdefgh"_kj : invalid);
      restore.setGrainId(invalidGrain ? invalid : "abcdefgh"_kj);
      KJ_EXPECT_THROW_MESSAGE("invalid object ID", restore.send().wait(io.waitScope));
    }
  }
}

class PackageFixture {
public:
  PackageFixture() {
    KJ_REQUIRE(mkdtemp(directory) != nullptr);
  }
  ~PackageFixture() noexcept(false) { recursivelyDelete(directory); }
  kj::String path(kj::StringPtr name) { return kj::str(directory, "/", name); }

  kj::AutoCloseFd pack(capnp::MessageBuilder& archive, uint signaturePadding = 0) {
    auto words = capnp::messageToFlatArray(archive);
    auto bytes = words.asBytes();
    byte hash[crypto_hash_sha512_BYTES];
    crypto_hash_sha512(hash, bytes.begin(), bytes.size());
    byte publicKey[crypto_sign_PUBLICKEYBYTES];
    byte secretKey[crypto_sign_SECRETKEYBYTES];
    KJ_ASSERT(crypto_sign_keypair(publicKey, secretKey) == 0);
    byte signature[crypto_hash_sha512_BYTES + crypto_sign_BYTES];
    unsigned long long signatureSize;
    KJ_ASSERT(crypto_sign(signature, &signatureSize, hash, sizeof(hash), secretKey) == 0);
    capnp::MallocMessageBuilder signatureMessage;
    auto root = signatureMessage.initRoot<spk::Signature>();
    root.setPublicKey(kj::arrayPtr(publicKey, sizeof(publicKey)));
    root.setSignature(kj::arrayPtr(signature, size_t(signatureSize)));
    // Padding is unreachable data, useful for testing the outer message size limit.
    if (signaturePadding > 0) signatureMessage.getOrphanage().newOrphan<capnp::Data>(signaturePadding);
    auto raw = raiiOpen(path("raw"), O_CREAT | O_TRUNC | O_RDWR, 0600);
    capnp::writeMessageToFd(raw, signatureMessage);
    kj::FdOutputStream(raw.get()).write(bytes.begin(), bytes.size());
    KJ_SYSCALL(lseek(raw, 0, SEEK_SET));
    auto packed = raiiOpen(path("package.spk"), O_CREAT | O_TRUNC | O_RDWR, 0600);
    auto magic = spk::MAGIC_NUMBER.get();
    kj::FdOutputStream(packed.get()).write(magic.begin(), magic.size());
    Subprocess::Options options({"xz", "-c"});
    options.stdin = raw;
    options.stdout = packed;
    Subprocess(kj::mv(options)).waitForSuccess();
    KJ_SYSCALL(lseek(packed, 0, SEEK_SET));
    return packed;
  }
  char directory[40] = "/tmp/sandstorm-package.XXXXXX";
};

KJ_TEST("Package unpacking requires a regular root manifest") {
  for (uint type = 0; type < 5; ++type) {
    PackageFixture fixture;
    capnp::MallocMessageBuilder manifest;
    manifest.initRoot<spk::Manifest>();
    auto manifestWords = capnp::messageToFlatArray(manifest);
    capnp::MallocMessageBuilder archive;
    auto files = archive.initRoot<spk::Archive>().initFiles(type == 4 ? 0 : 1);
    if (type != 4) {
      files[0].setName("sandstorm-manifest");
      switch (type) {
        case 0: files[0].setRegular(manifestWords.asBytes()); break;
        case 1: files[0].setSymlink("other-file"); break;
        case 2: files[0].initDirectory(0); break;
        case 3: files[0].setExecutable(manifestWords.asBytes()); break;
      }
    }
    auto packed = fixture.pack(archive);
    auto output = fixture.path("output");
    KJ_SYSCALL(mkdir(output.cStr(), 0700));
    if (type == 0) {
      KJ_EXPECT(unpackSpk(packed, output, fixture.directory).size() > 0);
      auto file = tryOpenPackageManifest(output);
      KJ_EXPECT(file != nullptr);
    } else {
      KJ_EXPECT_THROW_MESSAGE(type == 4 ? "no sandstorm-manifest" : "not a regular file",
          unpackSpk(packed, output, fixture.directory));
      KJ_EXPECT(listDirectory(output).size() == 0);
    }
  }
}

KJ_TEST("Installed manifests must be regular files and are opened without following links") {
  PackageFixture fixture;
  auto name = fixture.path("sandstorm-manifest");
  KJ_EXPECT(tryOpenPackageManifest(fixture.directory) == nullptr);
  {
    auto fd = raiiOpen(name, O_CREAT | O_WRONLY, 0600);
    kj::FdOutputStream(fd.get()).write("manifest", 8);
  }
  {
    auto fd = tryOpenPackageManifest(fixture.directory);
    KJ_EXPECT(kj::FdInputStream(KJ_REQUIRE_NONNULL(fd).get()).readAllText() == "manifest");
  }
  auto target = fixture.path("target");
  KJ_SYSCALL(rename(name.cStr(), target.cStr()));
  KJ_SYSCALL(symlink("target", name.cStr()));
  KJ_EXPECT_THROW(FAILED, tryOpenPackageManifest(fixture.directory));
  KJ_SYSCALL(unlink(name.cStr()));
  KJ_SYSCALL(mkdir(name.cStr(), 0700));
  KJ_EXPECT_THROW_MESSAGE("not a regular file", tryOpenPackageManifest(fixture.directory));
  KJ_SYSCALL(rmdir(name.cStr()));
  KJ_SYSCALL(mkfifo(name.cStr(), 0600));
  KJ_EXPECT_THROW_MESSAGE("not a regular file", tryOpenPackageManifest(fixture.directory));
}

class ProfileApi final: public ApiSession::Server {
public:
  ProfileApi(kj::String& path): path(path) {}
  kj::Promise<void> get(GetContext context) override {
    path = kj::str(context.getParams().getPath());
    context.getResults().initContent().initBody().setBytes(
        "{\"status\":{\"code\":0,\"name\":\"OK\"},\"them\":[]}"_kj.asBytes());
    return kj::READY_NOW;
  }
private:
  kj::String& path;
};

KJ_TEST("Profile lookups and saved profiles require hexadecimal fingerprints") {
  auto io = kj::setupAsyncIo();
  kj::String path;
  appindex::keybase::Endpoint endpoint(kj::heap<ProfileApi>(path));
  appindex::Indexer indexer;
  capnp::MallocMessageBuilder message;
  for (size_t length: {32, 40, 64}) {
    auto fingerprint = kj::heapString(length);
    memset(fingerprint.begin(), 'a', length);
    fingerprint[0] = 'F';
    fingerprint[1] = '0';
    KJ_EXPECT(endpoint.getFingerPrintIdentity(fingerprint).wait(io.waitScope) == nullptr);
    KJ_EXPECT(path == kj::str("user/lookup.json?key_fingerprint=", fingerprint,
                             "&fields=pictures,profile,proofs_summary"));
  }
  auto reject = [&](kj::StringPtr fingerprint) {
    path = nullptr;
    KJ_EXPECT_THROW_MESSAGE("invalid PGP fingerprint",
        endpoint.getFingerPrintIdentity(fingerprint).wait(io.waitScope));
    KJ_EXPECT(path.size() == 0);
    KJ_EXPECT_THROW_MESSAGE("invalid PGP fingerprint", indexer.addKeybaseProfile(fingerprint, message));
  };
  for (auto invalid: {""_kj, "abc"_kj, "../profile"_kj,
      "012345678901234567890123456789012345678"_kj,
      "01234567890123456789012345678901234567890"_kj}) {
    reject(invalid);
  }
  for (uint value = 0; value < 256; ++value) {
    char c = value;
    if ((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) continue;
    auto fingerprint = kj::str("0123456789012345678901234567890123456789");
    fingerprint[20] = c;
    reject(fingerprint);
  }
}

class BodyInput final: public kj::AsyncInputStream {
public:
  BodyInput(kj::ArrayPtr<const byte> data, bool knownLength): data(data), knownLength(knownLength) {}
  kj::Promise<size_t> tryRead(void* buffer, size_t, size_t maxBytes) override {
    auto size = kj::min(maxBytes, data.size());
    memcpy(buffer, data.begin(), size);
    data = data.slice(size, data.size());
    consumed += size;
    return size;
  }
  kj::Maybe<uint64_t> tryGetLength() override {
    if (knownLength) return data.size();
    return nullptr;
  }
  size_t consumed = 0;
private:
  kj::ArrayPtr<const byte> data;
  bool knownLength;
};

class DiscardBody final: public kj::AsyncOutputStream {
public:
  kj::Promise<void> write(const void*, size_t) override { return kj::READY_NOW; }
  kj::Promise<void> write(kj::ArrayPtr<const kj::ArrayPtr<const byte>>) override {
    return kj::READY_NOW;
  }
  kj::Promise<void> whenWriteDisconnected() override { return kj::NEVER_DONE; }
};

class BodyResponse final: public kj::HttpService::Response {
public:
  uint status = 0;
  kj::Own<kj::AsyncOutputStream> send(uint code, kj::StringPtr, const kj::HttpHeaders&,
                                    kj::Maybe<uint64_t>) override {
    KJ_REQUIRE(status == 0);
    status = code;
    return kj::heap<DiscardBody>();
  }
  kj::Own<kj::WebSocket> acceptWebSocket(const kj::HttpHeaders&) override {
    KJ_FAIL_REQUIRE("unexpected websocket");
  }
};

class BufferedSession final: public WebSession::Server {
public:
  BufferedSession(size_t& received): received(received) {}
  kj::Promise<void> post(PostContext context) override {
    received = context.getParams().getContent().getContent().size();
    context.getResults().initNoContent();
    return kj::READY_NOW;
  }
  kj::Promise<void> put(PutContext context) override {
    received = context.getParams().getContent().getContent().size();
    context.getResults().initNoContent();
    return kj::READY_NOW;
  }
  kj::Promise<void> patch(PatchContext context) override {
    received = context.getParams().getContent().getContent().size();
    context.getResults().initNoContent();
    return kj::READY_NOW;
  }
  kj::Promise<void> mkcol(MkcolContext context) override {
    received = context.getParams().getContent().getContent().size();
    context.getResults().initNoContent();
    return kj::READY_NOW;
  }
  kj::Promise<void> report(ReportContext context) override {
    received = context.getParams().getContent().getContent().size();
    context.getResults().initNoContent();
    return kj::READY_NOW;
  }
  kj::Promise<void> proppatch(ProppatchContext context) override {
    received = context.getParams().getXmlContent().size();
    context.getResults().initNoContent();
    return kj::READY_NOW;
  }
  kj::Promise<void> propfind(PropfindContext context) override {
    received = context.getParams().getXmlContent().size();
    context.getResults().initNoContent();
    return kj::READY_NOW;
  }
  kj::Promise<void> lock(LockContext context) override {
    received = context.getParams().getXmlContent().size();
    context.getResults().initNoContent();
    return kj::READY_NOW;
  }
  kj::Promise<void> acl(AclContext context) override {
    received = context.getParams().getXmlContent().size();
    context.getResults().initNoContent();
    return kj::READY_NOW;
  }
private:
  size_t& received;
};

class UploadStream final: public WebSession::RequestStream::Server {
public:
  UploadStream(size_t& received): received(received) {}
  kj::Promise<void> write(WriteContext context) override {
    received += context.getParams().getData().size();
    return kj::READY_NOW;
  }
  kj::Promise<void> expectSize(ExpectSizeContext) override { return kj::READY_NOW; }
  kj::Promise<void> done(DoneContext) override {
    complete.fulfiller->fulfill();
    return kj::READY_NOW;
  }
  kj::Promise<void> getResponse(GetResponseContext context) override {
    return complete.promise.then([context = kj::mv(context)]() mutable {
      context.getResults().initNoContent();
    });
  }
private:
  size_t& received;
  kj::PromiseFulfillerPair<void> complete = kj::newPromiseAndFulfiller<void>();
};

class StreamingSession final: public WebSession::Server {
public:
  StreamingSession(size_t& received): received(received) {}
  kj::Promise<void> postStreaming(PostStreamingContext context) override {
    context.getResults().setStream(kj::heap<UploadStream>(received));
    return kj::READY_NOW;
  }
  kj::Promise<void> putStreaming(PutStreamingContext context) override {
    context.getResults().setStream(kj::heap<UploadStream>(received));
    return kj::READY_NOW;
  }
private:
  size_t& received;
};

KJ_TEST("Buffered HTTP bodies have an inclusive limit, including decoded WebDAV content") {
  auto io = kj::setupAsyncIo();
  kj::HttpHeaderTable::Builder builder;
  WebSessionBridge::Tables tables(builder);
  auto contentEncoding = builder.add("Content-Encoding");
  auto headerTable = builder.build();
  WebSessionBridge::Options options;
  options.maxBufferedBodySize = 1024;
  size_t received = kj::maxValue;
  WebSessionBridge bridge(io.provider->getTimer(), kj::heap<BufferedSession>(received),
                          nullptr, tables, options);
  kj::HttpHeaders headers(*headerTable);
  for (auto method: {kj::HttpMethod::POST, kj::HttpMethod::PUT, kj::HttpMethod::PATCH,
                    kj::HttpMethod::MKCOL, kj::HttpMethod::REPORT, kj::HttpMethod::PROPPATCH,
                    kj::HttpMethod::PROPFIND, kj::HttpMethod::LOCK, kj::HttpMethod::ACL}) {
    for (bool knownLength: {false, true}) {
      for (size_t size: {0, 1024, 1025, 4096}) {
        auto data = kj::heapArray<byte>(size);
        memset(data.begin(), 'x', size);
        BodyInput input(data, knownLength);
        BodyResponse response;
        received = kj::maxValue;
        bridge.request(method, "/body", headers, input, response).wait(io.waitScope);
        KJ_EXPECT(response.status == (size <= 1024 ? 204 : 413), method, size, knownLength);
        KJ_EXPECT(received == (size <= 1024 ? size : size_t(kj::maxValue)));
        KJ_EXPECT(input.consumed <= 1025);
      }
    }
  }
  WebSessionBridge streamingBridge(io.provider->getTimer(), kj::heap<StreamingSession>(received),
                                   nullptr, tables, options);
  for (auto method: {kj::HttpMethod::POST, kj::HttpMethod::PUT}) {
    for (bool knownLength: {false, true}) {
      auto data = kj::heapArray<byte>(65536);
      memset(data.begin(), 'x', data.size());
      BodyInput input(data, knownLength);
      BodyResponse response;
      received = 0;
      streamingBridge.request(method, "/body", headers, input, response).wait(io.waitScope);
      KJ_EXPECT(response.status == 204);
      KJ_EXPECT(received == data.size());
    }
  }
  headers.set(contentEncoding, "gzip");
  for (size_t size: {1024, 1025, 65536}) {
    auto data = kj::heapArray<byte>(size);
    memset(data.begin(), 'x', size);
    kj::VectorOutputStream compressed;
    {
      kj::GzipOutputStream gzip(compressed);
      gzip.write(data.begin(), data.size());
    }
    KJ_EXPECT(compressed.getArray().size() < 1024);
    BodyInput input(compressed.getArray(), false);
    BodyResponse response;
    received = kj::maxValue;
    bridge.request(kj::HttpMethod::PROPPATCH, "/body", headers, input, response).wait(io.waitScope);
    KJ_EXPECT(response.status == (size <= 1024 ? 204 : 413), size);
    KJ_EXPECT(received == (size <= 1024 ? size : size_t(kj::maxValue)));
  }
}

KJ_TEST("Legacy uploads larger than eight MiB still work with the default buffer limit") {
  auto io = kj::setupAsyncIo();
  kj::HttpHeaderTable::Builder builder;
  WebSessionBridge::Tables tables(builder);
  auto headerTable = builder.build();
  size_t received = 0;
  WebSessionBridge bridge(io.provider->getTimer(), kj::heap<BufferedSession>(received),
                          nullptr, tables, WebSessionBridge::Options());
  kj::HttpHeaders headers(*headerTable);
  auto data = kj::heapArray<byte>(9 * 1024 * 1024);
  memset(data.begin(), 'x', data.size());
  BodyInput input(data, true);
  BodyResponse response;
  bridge.request(kj::HttpMethod::POST, "/body", headers, input, response).wait(io.waitScope);
  KJ_EXPECT(response.status == 204);
  KJ_EXPECT(received == data.size());
}

class FailingBodyInput final: public kj::AsyncInputStream {
public:
  kj::Promise<size_t> tryRead(void*, size_t, size_t) override {
    return KJ_EXCEPTION(FAILED, "Reached limit before EOF.");
  }
};

class FailingBodySession final: public WebSession::Server {
public:
  kj::Promise<void> post(PostContext) override {
    return KJ_EXCEPTION(FAILED, "Reached limit before EOF.");
  }
};

KJ_TEST("Application errors are not mistaken for oversized request bodies") {
  auto io = kj::setupAsyncIo();
  kj::HttpHeaderTable::Builder builder;
  WebSessionBridge::Tables tables(builder);
  auto headerTable = builder.build();
  WebSessionBridge bridge(io.provider->getTimer(), kj::heap<FailingBodySession>(),
                          nullptr, tables, WebSessionBridge::Options());
  kj::HttpHeaders headers(*headerTable);
  BodyInput input(kj::arrayPtr(reinterpret_cast<const byte*>("ok"), 2), true);
  BodyResponse response;
  KJ_EXPECT_THROW_MESSAGE("Reached limit before EOF.",
      bridge.request(kj::HttpMethod::POST, "/body", headers, input, response).wait(io.waitScope));
  KJ_EXPECT(response.status == 0);
  for (auto method: {kj::HttpMethod::POST, kj::HttpMethod::PROPPATCH}) {
    FailingBodyInput failedInput;
    BodyResponse failedResponse;
    KJ_EXPECT_THROW_MESSAGE("Reached limit before EOF.",
        bridge.request(method, "/body", headers, failedInput, failedResponse).wait(io.waitScope));
    KJ_EXPECT(failedResponse.status == 0);
  }
}

struct GatewayFixture {
  kj::AsyncIoContext io = kj::setupAsyncIo();
  kj::HttpHeaderTable::Builder builder;
  GatewayService::Tables tables{builder};
  kj::HttpHeaderId location = builder.add("Location");
  kj::HttpHeaderId cookie = builder.add("Set-Cookie");
  kj::Own<kj::HttpHeaderTable> headerTable = builder.build();
  kj::Own<kj::HttpClient> shell = kj::newHttpClient(
      io.provider->getTimer(), *headerTable, io.provider->getNetwork(), nullptr);
  GatewayService gateway{io.provider->getTimer(), *shell, nullptr, tables,
      "http://shell.example", "*.example", nullptr, false};
  kj::Promise<void> cleanup = gateway.cleanupLoop();
  kj::Own<kj::HttpClient> client = kj::newHttpClient(gateway);
};

KJ_TEST("UI init redirects remain local and session cookies contain only valid IDs") {
  GatewayFixture fixture;
  kj::HttpHeaders headers(*fixture.headerTable);
  headers.set(kj::HttpHeaderId::HOST, "ui-test.example");
  auto check = [&](kj::StringPtr token, kj::StringPtr path, uint status,
                   kj::StringPtr expectedPath = "") {
    auto url = kj::str("/_sandstorm-init?sessionid=", kj::encodeUriComponent(token),
                      "&path=", kj::encodeUriComponent(path));
    auto request = fixture.client->request(kj::HttpMethod::GET, url, headers);
    auto response = request.response.wait(fixture.io.waitScope);
    KJ_EXPECT(response.statusCode == status, path, token);
    if (status == 303) {
      KJ_EXPECT(response.headers->get(fixture.location).orDefault("") == expectedPath);
      KJ_EXPECT(response.headers->get(fixture.cookie).orDefault("") ==
          kj::str("sandstorm-sid=", token, "; HttpOnly"));
    } else {
      KJ_EXPECT(response.headers->get(fixture.cookie) == nullptr);
      KJ_EXPECT(response.headers->get(fixture.location) == nullptr);
    }
    response.body->readAllText().wait(fixture.io.waitScope);
  };
  auto token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"_kj;
  check(token, "/documents?q=1", 303, "/documents?q=1");
  check(token, "legacy", 303, "/legacy");
  for (auto path: {"//other.example", "/\\other.example", "\\other.example", "/a\r\nLocation: x", "/a\t"}) {
    check(token, path, 400);
  }
  check("", "/", 400);
  check("short", "/", 400);
  check(kj::str(token, "a"), "/", 400);
  check(kj::str(token.slice(1), ";"), "/", 400);
}

KJ_TEST("HTTP entity-tag lists preserve values and handle large headers") {
  capnp::MallocMessageBuilder message;
  auto parsed = parseETagList(message.getOrphanage(), " \"first\", W/\"second\",\"\"");
  auto tags = parsed.getReader();
  KJ_ASSERT(tags.size() == 3);
  KJ_EXPECT(tags[0].getValue() == "first" && !tags[0].getWeak());
  KJ_EXPECT(tags[1].getValue() == "second" && tags[1].getWeak());
  KJ_EXPECT(tags[2].getValue() == "" && !tags[2].getWeak());
  KJ_EXPECT_THROW_MESSAGE("etag must be followed by comma",
      parseETagList(message.getOrphanage(), "\"a\";\"b\""));
  KJ_EXPECT_THROW_MESSAGE("invalid ETag", parseETagList(message.getOrphanage(), "\"a\","));

  for (auto empty: {""_kj, "   "_kj, kj::StringPtr(nullptr)}) {
    KJ_EXPECT_THROW_MESSAGE("invalid ETag", parseETagList(message.getOrphanage(), empty));
  }

  auto text = kj::heapString(3 * 40000 - 1);
  for (size_t i = 0; i < text.size(); ++i) text[i] = i % 3 == 2 ? ',' : '"';
  auto large = parseETagList(message.getOrphanage(), text);
  KJ_ASSERT(large.getReader().size() == 40000);
  for (auto tag: large.getReader()) KJ_EXPECT(tag.getValue() == "" && !tag.getWeak());
}

KJ_TEST("HeaderWhitelist") {
  const char* WHITELIST[] = {
    "bar-baz",
    "corge",
    "foo-*",
    "grault",
    "qux-*",
  };

  HeaderWhitelist whitelist((kj::ArrayPtr<const char*>(WHITELIST)));

  KJ_ASSERT(whitelist.matches("bar-baz"));
  KJ_ASSERT(whitelist.matches("bar-BAZ"));
  KJ_ASSERT(!whitelist.matches("bar-qux"));
  KJ_ASSERT(whitelist.matches("foo-abcd"));
  KJ_ASSERT(whitelist.matches("grault"));
  KJ_ASSERT(whitelist.matches("Grault"));
  KJ_ASSERT(!whitelist.matches("grault-abcd"));
  KJ_ASSERT(whitelist.matches("QUX-abcd"));
  KJ_ASSERT(!whitelist.matches("quxqux"));
}

bool hasSubstring(kj::StringPtr haystack, kj::StringPtr needle) {
  if (needle.size() <= haystack.size()) {
    for (size_t i = 0; i <= haystack.size() - needle.size(); i++) {
      if (haystack.slice(i).startsWith(needle)) {
        return true;
      }
    }
  }
  return false;
}

KJ_TEST("Subprocess") {
  {
    Subprocess child({"true"});
    child.waitForSuccess();
  }

  {
    Subprocess child({"false"});
    KJ_EXPECT(child.waitForExit() != 0);
  }

  {
    Subprocess child({"false"});
    KJ_EXPECT_THROW_MESSAGE("child process failed", child.waitForSuccess());
  }

  {
    Subprocess child({"cat"});
    // Will be killed by destructor.
  }

  {
    Subprocess child({"cat"});
    child.signal(SIGKILL);
    int status = child.waitForExitOrSignal();
    KJ_EXPECT(WIFSIGNALED(status));
    KJ_EXPECT(WTERMSIG(status) == SIGKILL);
  }

  {
    Subprocess child({"cat"});
    child.signal(SIGKILL);
    KJ_EXPECT_THROW_MESSAGE("child process killed by signal", (void)child.waitForExit());
  }

  {
    Subprocess child([&]() {
      return 0;
    });
    child.waitForSuccess();
  }

  {
    Subprocess child([&]() {
      return 123;
    });
    KJ_EXPECT(child.waitForExit() == 123);
  }

  {
    Pipe pipe = Pipe::make();
    Subprocess child([&]() {
      KJ_SYSCALL(write(pipe.writeEnd, "foo", 3));
      pipe.writeEnd = nullptr;
      return 0;
    });
    pipe.writeEnd = nullptr;
    KJ_EXPECT(readAll(pipe.readEnd) == "foo");
  }

  {
    Pipe pipe = Pipe::make();
    Subprocess::Options options({"echo", "foo"});
    options.stdout = pipe.writeEnd;
    Subprocess child(kj::mv(options));
    pipe.writeEnd = nullptr;
    KJ_EXPECT(readAll(pipe.readEnd) == "foo\n");
    child.waitForSuccess();
  }

  {
    Pipe inPipe = Pipe::make();
    Pipe outPipe = Pipe::make();
    Subprocess::Options options({"cat"});
    options.stdin = inPipe.readEnd;
    options.stdout = outPipe.writeEnd;
    Subprocess child(kj::mv(options));
    inPipe.readEnd = nullptr;
    outPipe.writeEnd = nullptr;
    KJ_SYSCALL(write(inPipe.writeEnd, "foo", 3));
    inPipe.writeEnd = nullptr;
    KJ_EXPECT(readAll(outPipe.readEnd) == "foo");
    child.waitForSuccess();
  }

  {
    Pipe pipe = Pipe::make();
    Subprocess::Options options({"no-such-file-eb8c433f35f3063e"});
    options.stderr = pipe.writeEnd;
    Subprocess child(kj::mv(options));
    pipe.writeEnd = nullptr;
    KJ_EXPECT(hasSubstring(readAll(pipe.readEnd), "execvp("));
    KJ_EXPECT(child.waitForExit() != 0);
  }

  {
    Pipe pipe = Pipe::make();
    Subprocess::Options options({"true"});
    options.stderr = pipe.writeEnd;
    options.searchPath = false;
    Subprocess child(kj::mv(options));
    pipe.writeEnd = nullptr;
    KJ_EXPECT(hasSubstring(readAll(pipe.readEnd), "execv("));
    KJ_EXPECT(child.waitForExit() != 0);
  }

  {
    Subprocess::Options options({"/bin/true"});
    options.searchPath = false;
    Subprocess child(kj::mv(options));
    child.waitForSuccess();
  }

  {
    Pipe pipe = Pipe::make();
    Subprocess::Options options({"sh", "-c", "echo $UTIL_TEST_ENV"});
    auto env = kj::heapArray<const kj::StringPtr>({"PATH=/bin:/usr/bin", "UTIL_TEST_ENV=foo"});
    options.environment = env.asPtr();
    options.stdout = pipe.writeEnd;
    Subprocess child(kj::mv(options));
    pipe.writeEnd = nullptr;
    KJ_EXPECT(readAll(pipe.readEnd) == "foo\n");
    child.waitForSuccess();
  }

  {
    Pipe pipe3 = Pipe::make();
    Pipe pipe4 = Pipe::make();
    Subprocess::Options options({"sh", "-c", "echo foo >&3; echo bar >&4"});
    auto fds = kj::heapArray<int>({pipe3.writeEnd, pipe4.writeEnd});
    options.moreFds = fds;

    // We override the environment here in order to clear Ekam's LD_PRELOAD which otherwise expects
    // FD 3 and 4 to belong to it.
    auto env = kj::heapArray<const kj::StringPtr>({"PATH=/bin:/usr/bin"});
    options.environment = env.asPtr();

    Subprocess child(kj::mv(options));
    pipe3.writeEnd = nullptr;
    pipe4.writeEnd = nullptr;
    KJ_EXPECT(readAll(pipe3.readEnd) == "foo\n");
    KJ_EXPECT(readAll(pipe4.readEnd) == "bar\n");
    child.waitForSuccess();
  }
}

KJ_TEST("SubprocessSet") {
  auto io = kj::setupAsyncIo();

  SubprocessSet set(io.unixEventPort);

  Subprocess::Options catOptions("cat");
  Pipe catPipe = Pipe::make();
  catOptions.stdin = catPipe.readEnd;
  Subprocess childCat(kj::mv(catOptions));
  catPipe.readEnd = nullptr;

  Subprocess childTrue({"true"});

  bool catDone = false;

  auto promiseCat = set.waitForSuccess(childCat).then([&]() { catDone = true; });
  auto promiseTrue = set.waitForSuccess(childTrue);
  auto promiseFalse = set.waitForExit({"false"});

  promiseTrue.wait(io.waitScope);
  KJ_EXPECT(promiseFalse.wait(io.waitScope) != 0);
  KJ_EXPECT(!catDone);

  catPipe.writeEnd = nullptr;
  promiseCat.wait(io.waitScope);
}

KJ_TEST("raiiOpenAtIfExistsContained") {
  {
    char tempdir[] = "/tmp/sandstorm-test.XXXXXX";
    KJ_REQUIRE(mkdtemp(tempdir) != nullptr);
    KJ_DEFER(KJ_SYSCALL(rmdir(tempdir)));

    auto dir = raiiOpen(tempdir, O_DIRECTORY);

    auto writeFileAt = [&](int fd, kj::StringPtr path, kj::StringPtr data) {
      auto file = raiiOpenAt(fd, path, O_CREAT | O_RDWR);
      KJ_SYSCALL(write(file.get(), data.cStr(), data.size()));
    };

    writeFileAt(dir.get(), "file", "file");
    KJ_DEFER(KJ_SYSCALL(unlinkat(dir.get(), "file", 0)));

    KJ_SYSCALL(symlinkat("file", dir.get(), "link-to-file"));
    KJ_DEFER(KJ_SYSCALL(unlinkat(dir.get(), "link-to-file", 0)));

    KJ_SYSCALL(symlinkat("..", dir.get(), "link-to-parent"));
    KJ_DEFER(KJ_SYSCALL(unlinkat(dir.get(), "link-to-parent", 0)));

    KJ_SYSCALL(symlinkat("/", dir.get(), "link-to-root"));
    KJ_DEFER(KJ_SYSCALL(unlinkat(dir.get(), "link-to-root", 0)));

    KJ_SYSCALL(mkdirat(dir.get(), "subdir", 0700));
    KJ_DEFER(KJ_SYSCALL(unlinkat(dir.get(), "subdir", AT_REMOVEDIR)));

    KJ_SYSCALL(symlinkat("..", dir.get(), "subdir/link-to-parent"));
    KJ_DEFER(KJ_SYSCALL(unlinkat(dir.get(), "subdir/link-to-parent", 0)));

    KJ_SYSCALL(symlinkat("../file", dir.get(), "subdir/link-to-parent-file"));
    KJ_DEFER(KJ_SYSCALL(unlinkat(dir.get(), "subdir/link-to-parent-file", 0)));

    writeFileAt(dir.get(), "subdir/file", "subdir/file");
    KJ_DEFER(KJ_SYSCALL(unlinkat(dir.get(), "subdir/file", 0)));

    KJ_SYSCALL(symlinkat("file", dir.get(), "subdir/link-to-subdir-file"));
    KJ_DEFER(KJ_SYSCALL(unlinkat(dir.get(), "subdir/link-to-subdir-file", 0)));

    KJ_SYSCALL(symlinkat("../..", dir.get(), "subdir/link-to-grandparent"));
    KJ_DEFER(KJ_SYSCALL(unlinkat(dir.get(), "subdir/link-to-grandparent", 0)));

    KJ_SYSCALL(symlinkat("/", dir.get(), "subdir/link-to-root"));
    KJ_DEFER(KJ_SYSCALL(unlinkat(dir.get(), "subdir/link-to-root", 0)));

    KJ_SYSCALL(mkdirat(dir.get(), "subdir/a", 0700));
    KJ_DEFER(KJ_SYSCALL(unlinkat(dir.get(), "subdir/a", AT_REMOVEDIR)));

    KJ_SYSCALL(mkdirat(dir.get(), "subdir/a/b", 0700));
    KJ_DEFER(KJ_SYSCALL(unlinkat(dir.get(), "subdir/a/b", AT_REMOVEDIR)));

    writeFileAt(dir.get(), "subdir/a/b/c", "subdir/a/b/c");
    KJ_DEFER(KJ_SYSCALL(unlinkat(dir.get(), "subdir/a/b/c", 0)));

    KJ_SYSCALL(symlinkat("c", dir.get(), "subdir/a/b/link-to-c"));
    KJ_DEFER(KJ_SYSCALL(unlinkat(dir.get(), "subdir/a/b/link-to-c", 0)));

    KJ_SYSCALL(symlinkat("b", dir.get(), "subdir/a/link-to-b"));
    KJ_DEFER(KJ_SYSCALL(unlinkat(dir.get(), "subdir/a/link-to-b", 0)));

    KJ_SYSCALL(symlinkat("..", dir.get(), "subdir/a/b/link-to-a"));
    KJ_DEFER(KJ_SYSCALL(unlinkat(dir.get(), "subdir/a/b/link-to-a", 0)));

    auto expectSucceed = [&](kj::StringPtr path) -> kj::AutoCloseFd {
      KJ_IF_MAYBE(fd, raiiOpenAtIfExistsContained(dir.get(), kj::Path::parse(path), O_RDONLY)) {
        return kj::mv(*fd);
      } else {
        KJ_FAIL_ASSERT("Opening ", path, " should have succeeded.");
      }
    };

    auto expectFail = [&](kj::StringPtr path) {
      auto maybeExn = kj::runCatchingExceptions([&]() {
        raiiOpenAtIfExistsContained(dir.get(), kj::Path::parse(path), O_RDONLY);
      });
      KJ_IF_MAYBE(exn, maybeExn) {
      } else {
        KJ_FAIL_ASSERT("Opening ", path, " should have failed.");
      }
    };

    auto expectRootTruncated = [&](kj::StringPtr path) {
      auto root = expectSucceed(path);
      int result = faccessat(root.get(), "tmp", F_OK, AT_SYMLINK_NOFOLLOW);
      KJ_ASSERT(result < 0, "shouldn't have gotten access to /");
    };

    auto readFile = [&](kj::StringPtr path) -> kj::String {
      return kj::FdInputStream(expectSucceed(path)).readAllText();
    };

    auto expectContents = [&](kj::StringPtr path, kj::StringPtr expected) {
      auto actual = readFile(path);
      if(actual != expected) {
        KJ_FAIL_ASSERT("unexpected contents", expected, actual);
      }
    };

    expectContents("link-to-file", "file");
    expectFail("link-to-parent");
    expectRootTruncated("link-to-root");
    expectSucceed("subdir/link-to-parent");
    expectContents("subdir/link-to-parent-file", "file");
    expectContents("subdir/link-to-subdir-file", "subdir/file");
    expectFail("subdir/link-to-grandparent");
    expectRootTruncated("subdir/link-to-root");
    expectContents("subdir/a/b/link-to-c", "subdir/a/b/c");
    expectContents("subdir/a/link-to-b/c", "subdir/a/b/c");
    expectContents("subdir/a/link-to-b/link-to-c", "subdir/a/b/c");
    expectContents("subdir/a/b/link-to-a/b/c", "subdir/a/b/c");
  }
}

}  // namespace
}  // namespace sandstorm
