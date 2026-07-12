// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2026 Sandstorm contributors
// Licensed under the Apache License, Version 2.0.

#include "server.h"
#include "v8-platform-impl.h"

#include <workerd/server/sandstorm-isolate-host.capnp.h>
#include <workerd/server/sandstorm-isolate-worker-source.capnp.h>
#include <workerd/io/compatibility-date.h>
#include <workerd/jsg/setup.h>
#include <workerd/util/stream-utils.h>

#include <capnp/rpc-twoparty.h>
#include <capnp/compat/json.h>
#include <capnp/compat/http-over-capnp.h>
#include <capnp/serialize-packed.h>
#include <kj/async-io.h>
#include <kj/map.h>

#include <fcntl.h>
#include <dirent.h>
#include <sys/random.h>
#include <sys/stat.h>
#include <unistd.h>

namespace sandstorm {
namespace {

constexpr kj::StringPtr LOADER_NAMESPACE = "sandstorm-grains"_kj;

class SystemEntropySource final: public kj::EntropySource {
 public:
  void generate(kj::ArrayPtr<kj::byte> buffer) override {
    while (buffer.size() > 0) {
      ssize_t count;
      KJ_SYSCALL(count = getrandom(buffer.begin(), buffer.size(), 0));
      buffer = buffer.slice(count);
    }
  }
};

class BundleErrorReporter final: public workerd::Worker::ValidationErrorReporter {
 public:
  void addError(kj::String error) override { errors.add(kj::mv(error)); }
  void addEntrypoint(kj::Maybe<kj::StringPtr>, kj::Array<kj::String>) override {}
  void addActorClass(kj::StringPtr) override {}
  void addWorkflowClass(kj::StringPtr, kj::Array<kj::String>) override {}

  void requireValid() {
    KJ_REQUIRE(errors.empty(), "invalid worker compatibility settings",
        kj::strArray(errors, "; "));
  }

 private:
  kj::Vector<kj::String> errors;
};

struct BundleBacking final: public kj::AtomicRefcounted {
  kj::Own<capnp::PackedFdMessageReader> source;
  capnp::MallocMessageBuilder compatibility;
};

struct LoadedWorkerSource {
  workerd::DynamicWorkerSource source;
  kj::Own<BundleBacking> backing;
};

class SharedHttpService: public kj::HttpService, public kj::Refcounted {
 public:
  virtual ~SharedHttpService() noexcept = default;
};

class BindingHttpService final: public SharedHttpService {
 public:
  BindingHttpService(int sourceGrainDirFd,
      kj::HttpHeaderTable& headerTable,
      kj::String bindingName,
      bool storage)
      : bindingName(kj::mv(bindingName)), storage(storage),
        headerTable(headerTable) {
    KJ_SYSCALL(grainDirFd = fcntl(sourceGrainDirFd, F_DUPFD_CLOEXEC, 0));
    if (storage) {
      if (mkdirat(grainDirFd, "isolate-storage", 0770) < 0) {
        KJ_REQUIRE(errno == EEXIST, "failed to create isolate storage directory", strerror(errno));
      }
      KJ_SYSCALL(storageDirFd = openat(grainDirFd, "isolate-storage",
          O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
    }
  }

  ~BindingHttpService() noexcept {
    if (storageDirFd >= 0) close(storageDirFd);
    close(grainDirFd);
  }

  kj::Promise<void> request(kj::HttpMethod method, kj::StringPtr url,
      const kj::HttpHeaders& headers, kj::AsyncInputStream& requestBody,
      kj::HttpService::Response& response) override {
    if (storage) return requestStorage(method, url, requestBody, response);
    auto body = kj::str("{\n  \"ok\": false,\n  \"error\": \"shared-host ",
        bindingName, " adapter is not connected\"\n}\n");
    return sendJson(response, 501, "Not Implemented", kj::mv(body));
  }

 private:
  static constexpr size_t MAX_STORAGE_VALUE_BYTES = 1024 * 1024;

  kj::Promise<void> sendJson(kj::HttpService::Response& response,
      uint statusCode, kj::StringPtr statusText, kj::String body) {
    kj::HttpHeaders responseHeaders(headerTable);
    responseHeaders.setPtr(
        kj::HttpHeaderId::CONTENT_TYPE, "application/json; charset=utf-8"_kj);
    auto stream = response.send(statusCode, statusText, responseHeaders, body.size());
    return stream->write(body.asBytes()).attach(kj::mv(stream), kj::mv(body));
  }

  static kj::String storageKey(kj::StringPtr url) {
    size_t begin = 0;
    size_t end = url.size();
    KJ_IF_SOME(query, url.findFirst('?')) { end = query; }
    size_t authorityBegin = 0;
    if (url.slice(0, end).startsWith("http://"_kj)) authorityBegin = 7;
    if (url.slice(0, end).startsWith("https://"_kj)) authorityBegin = 8;
    if (authorityBegin > 0) {
      auto authorityEnd = url.slice(authorityBegin, end).findFirst('/');
      KJ_IF_SOME(slash, authorityEnd) {
        begin = authorityBegin + slash;
      } else {
        begin = end;
      }
    }
    while (begin < end && url[begin] == '/') ++begin;
    return kj::str(url.slice(begin, end));
  }

  static bool validStorageKey(kj::StringPtr key) {
    if (key.size() == 0 || key.size() > 128 || key.startsWith(".")) return false;
    for (char c: key) {
      if (!(c >= 'a' && c <= 'z') && !(c >= 'A' && c <= 'Z') &&
          !(c >= '0' && c <= '9') && c != '-' && c != '_' && c != '.') return false;
    }
    for (size_t i = 1; i < key.size(); ++i) {
      if (key[i - 1] == '.' && key[i] == '.') return false;
    }
    return true;
  }

  kj::Maybe<kj::AutoCloseFd> openStorageFile(kj::StringPtr key) {
    int fd = openat(storageDirFd, key.cStr(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) {
      KJ_REQUIRE(errno == ENOENT || errno == ELOOP, "failed to open storage value", strerror(errno));
      return kj::none;
    }
    kj::AutoCloseFd result(fd);
    struct stat stats;
    KJ_SYSCALL(fstat(result, &stats));
    if (!S_ISREG(stats.st_mode)) return kj::none;
    return kj::mv(result);
  }

  kj::Promise<void> getStorage(kj::String key, kj::HttpService::Response& response) {
    KJ_IF_SOME(fd, openStorageFile(key)) {
      struct stat stats;
      KJ_SYSCALL(fstat(fd, &stats));
      auto body = kj::heapArray<kj::byte>(stats.st_size);
      size_t offset = 0;
      while (offset < body.size()) {
        ssize_t count;
        KJ_SYSCALL(count = read(fd, body.begin() + offset, body.size() - offset));
        KJ_REQUIRE(count > 0, "storage value ended before its declared size", key);
        offset += count;
      }
      kj::HttpHeaders responseHeaders(headerTable);
      responseHeaders.setPtr(kj::HttpHeaderId::CONTENT_TYPE, "application/octet-stream"_kj);
      auto stream = response.send(200, "OK", responseHeaders, body.size());
      return stream->write(body).attach(kj::mv(stream), kj::mv(body));
    }
    return sendJson(response, 404, "Not Found", kj::heapString(
        "{\n  \"ok\": false,\n  \"error\": \"storage key not found\"\n}\n"));
  }

  kj::Promise<void> headStorage(kj::StringPtr key, kj::HttpService::Response& response) {
    KJ_IF_SOME(fd, openStorageFile(key)) {
      struct stat stats;
      KJ_SYSCALL(fstat(fd, &stats));
      kj::HttpHeaders responseHeaders(headerTable);
      auto sizeHeader = kj::str(stats.st_size);
      responseHeaders.addPtr("X-Sandstorm-Storage-Bytes"_kj, kj::mv(sizeHeader));
      response.send(200, "OK", responseHeaders, uint64_t(0));
      return kj::READY_NOW;
    }
    kj::HttpHeaders responseHeaders(headerTable);
    response.send(404, "Not Found", responseHeaders, uint64_t(0));
    return kj::READY_NOW;
  }

  kj::Promise<void> putStorage(kj::String key, kj::AsyncInputStream& requestBody,
      kj::HttpService::Response& response) {
    return requestBody.readAllBytes(MAX_STORAGE_VALUE_BYTES + 1).then(
        [this, key = kj::mv(key), &response](kj::Array<kj::byte> body) mutable {
      if (body.size() > MAX_STORAGE_VALUE_BYTES) {
        return sendJson(response, 413, "Payload Too Large", kj::str(
            "{\n  \"ok\": false,\n  \"error\": \"storage value exceeds maximum size\",\n",
            "  \"maxBytes\": ", MAX_STORAGE_VALUE_BYTES, "\n}\n"));
      }
      struct stat existing;
      if (fstatat(storageDirFd, key.cStr(), &existing, AT_SYMLINK_NOFOLLOW) == 0) {
        if (!S_ISREG(existing.st_mode)) return sendJson(response, 409, "Conflict",
            kj::heapString("{\n  \"ok\": false,\n  \"error\": \"storage key is blocked\"\n}\n"));
      } else KJ_REQUIRE(errno == ENOENT, "failed to inspect storage key", strerror(errno));

      auto temporary = kj::str(".tmp-", getpid(), "-", key);
      struct stat temporaryStats;
      if (fstatat(storageDirFd, temporary.cStr(),
          &temporaryStats, AT_SYMLINK_NOFOLLOW) == 0) {
        KJ_REQUIRE(S_ISREG(temporaryStats.st_mode),
            "refusing to replace non-regular temporary storage file", temporary);
        KJ_SYSCALL(unlinkat(storageDirFd, temporary.cStr(), 0));
      } else KJ_REQUIRE(errno == ENOENT,
          "failed to inspect temporary storage file", strerror(errno));
      int fd;
      KJ_SYSCALL(fd = openat(storageDirFd, temporary.cStr(),
          O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0660));
      kj::AutoCloseFd output(fd);
      size_t offset = 0;
      while (offset < body.size()) {
        ssize_t count;
        KJ_SYSCALL(count = write(output, body.begin() + offset, body.size() - offset));
        KJ_REQUIRE(count > 0, "storage write made no progress", key);
        offset += count;
      }
      KJ_SYSCALL(fsync(output));
      KJ_SYSCALL(renameat(storageDirFd, temporary.cStr(), storageDirFd, key.cStr()));
      KJ_SYSCALL(fsync(storageDirFd));
      return sendJson(response, 200, "OK", kj::str(
          "{\n  \"ok\": true,\n  \"bytes\": ", body.size(), "\n}\n"));
    });
  }

  kj::Promise<void> deleteStorage(kj::StringPtr key, kj::HttpService::Response& response) {
    struct stat existing;
    if (fstatat(storageDirFd, key.cStr(), &existing, AT_SYMLINK_NOFOLLOW) < 0) {
      KJ_REQUIRE(errno == ENOENT, "failed to inspect storage key", strerror(errno));
    } else if (!S_ISREG(existing.st_mode)) {
      return sendJson(response, 409, "Conflict", kj::heapString(
          "{\n  \"ok\": false,\n  \"error\": \"storage key is blocked\"\n}\n"));
    } else {
      KJ_SYSCALL(unlinkat(storageDirFd, key.cStr(), 0));
      KJ_SYSCALL(fsync(storageDirFd));
    }
    return sendJson(response, 200, "OK", kj::heapString("{\n  \"ok\": true\n}\n"));
  }

  kj::Promise<void> indexStorage(kj::HttpService::Response& response) {
    int listingFd;
    KJ_SYSCALL(listingFd = fcntl(storageDirFd, F_DUPFD_CLOEXEC, 0));
    DIR* directory = fdopendir(listingFd);
    if (directory == nullptr) {
      int error = errno;
      close(listingFd);
      KJ_FAIL_SYSCALL("fdopendir", error);
    }
    KJ_DEFER(closedir(directory));

    kj::Vector<char> json;
    json.addAll("{\n  \"ok\": true,\n  \"keys\": ["_kj);
    bool first = true;
    uint64_t totalBytes = 0;
    while (true) {
      errno = 0;
      auto entry = readdir(directory);
      if (entry == nullptr) {
        KJ_REQUIRE(errno == 0, "failed to read storage directory", strerror(errno));
        break;
      }
      kj::StringPtr name(entry->d_name);
      if (!validStorageKey(name)) continue;
      struct stat stats;
      if (fstatat(storageDirFd, name.cStr(), &stats, AT_SYMLINK_NOFOLLOW) < 0) {
        KJ_REQUIRE(errno == ENOENT, "failed to inspect storage index entry", strerror(errno));
        continue;
      }
      if (!S_ISREG(stats.st_mode)) continue;
      if (!first) json.addAll(", "_kj);
      first = false;
      json.addAll(kj::str("{ \"name\": \"", name, "\", \"bytes\": ", stats.st_size, " }"));
      totalBytes += stats.st_size;
    }
    json.addAll(kj::str("],\n  \"totalBytes\": ", totalBytes, "\n}\n"));
    json.add('\0');
    return sendJson(response, 200, "OK", kj::String(json.releaseAsArray()));
  }

  kj::Promise<void> requestStorage(kj::HttpMethod method, kj::StringPtr url,
      kj::AsyncInputStream& requestBody, kj::HttpService::Response& response) {
    auto key = storageKey(url);
    if (method == kj::HttpMethod::GET && key.size() == 0) return indexStorage(response);
    if (!validStorageKey(key)) return sendJson(response, 400, "Bad Request", kj::heapString(
        "{\n  \"ok\": false,\n  \"error\": \"invalid storage key\"\n}\n"));
    switch (method) {
      case kj::HttpMethod::GET: return getStorage(kj::mv(key), response);
      case kj::HttpMethod::HEAD: return headStorage(key, response);
      case kj::HttpMethod::PUT: return putStorage(kj::mv(key), requestBody, response);
      case kj::HttpMethod::DELETE: return deleteStorage(key, response);
      default: return sendJson(response, 405, "Method Not Allowed", kj::heapString(
          "{\n  \"ok\": false,\n  \"error\": \"method not allowed\"\n}\n"));
    }
  }

  int grainDirFd;
  int storageDirFd = -1;
  kj::String bindingName;
  bool storage;
  kj::HttpHeaderTable& headerTable;
};

class HttpServiceWorkerInterface final: public workerd::WorkerInterface {
 public:
  explicit HttpServiceWorkerInterface(kj::Own<SharedHttpService> service)
      : service(kj::mv(service)) {}

  kj::Promise<void> request(kj::HttpMethod method, kj::StringPtr url,
      const kj::HttpHeaders& headers, kj::AsyncInputStream& requestBody,
      kj::HttpService::Response& response) override {
    return service->request(method, url, headers, requestBody, response);
  }
  kj::Promise<void> connect(kj::StringPtr host, const kj::HttpHeaders& headers,
      kj::AsyncIoStream& connection, ConnectResponse& response,
      kj::HttpConnectSettings settings) override {
    return service->connect(host, headers, connection, response, kj::mv(settings));
  }
  kj::Promise<void> prewarm(kj::StringPtr) override { return kj::READY_NOW; }
  kj::Promise<ScheduledResult> runScheduled(kj::Date, kj::StringPtr) override {
    KJ_FAIL_REQUIRE("Unix HTTP bindings do not support scheduled events");
  }
  kj::Promise<AlarmResult> runAlarm(kj::Date, uint32_t) override {
    KJ_FAIL_REQUIRE("Unix HTTP bindings do not support alarm events");
  }
  kj::Promise<CustomEvent::Result> customEvent(kj::Own<CustomEvent> event) override {
    return event->notSupported().attach(kj::mv(event));
  }

 private:
  kj::Own<SharedHttpService> service;
};

class HttpServiceChannel final: public workerd::IoChannelFactory::SubrequestChannel {
 public:
  explicit HttpServiceChannel(kj::Own<SharedHttpService> service)
      : service(kj::mv(service)) {}

  kj::Own<workerd::WorkerInterface> startRequest(
      workerd::IoChannelFactory::SubrequestMetadata) override {
    return kj::heap<HttpServiceWorkerInterface>(kj::addRef(*service));
  }

  void requireAllowsTransfer() override {
    KJ_FAIL_REQUIRE("Sandstorm in-process HTTP bindings cannot be transferred");
  }
  kj::OneOf<kj::Array<kj::byte>, kj::Promise<kj::Array<kj::byte>>> getTokenMaybeSync(
      workerd::IoChannelFactory::ChannelTokenUsage) override {
    KJ_FAIL_REQUIRE("Sandstorm in-process HTTP bindings cannot be tokenized");
  }

 private:
  kj::Own<SharedHttpService> service;
};

class WorkerIngressService final: public kj::HttpService {
 public:
  explicit WorkerIngressService(
      kj::Own<workerd::IoChannelFactory::SubrequestChannel> ingress)
      : ingress(kj::mv(ingress)) {}

  kj::Promise<void> request(kj::HttpMethod method, kj::StringPtr url,
      const kj::HttpHeaders& headers, kj::AsyncInputStream& requestBody,
      kj::HttpService::Response& response) override {
    KJ_CONTEXT("dispatching hosted worker HTTP request", url);
    auto request = ingress->startRequest({});
    return request->request(method, url, headers, requestBody, response).attach(kj::mv(request));
  }

  kj::Promise<void> connect(kj::StringPtr host, const kj::HttpHeaders& headers,
      kj::AsyncIoStream& connection, ConnectResponse& response,
      kj::HttpConnectSettings settings) override {
    auto request = ingress->startRequest({});
    return request->connect(host, headers, connection, response, kj::mv(settings))
        .attach(kj::mv(request));
  }

 private:
  kj::Own<workerd::IoChannelFactory::SubrequestChannel> ingress;
};

class CompletedLegacyHttpRequest final: public capnp::HttpService::ServerRequestContext::Server {};

static constexpr kj::StringPtr LEGACY_COMMON_HEADER_NAMES[] = {
  ""_kj,
  "Accept-Charset"_kj, "Accept-Encoding"_kj, "Accept-Language"_kj,
  "Accept-Ranges"_kj, "Accept"_kj, "Access-Control-Allow-Origin"_kj,
  "Age"_kj, "Allow"_kj, "Authorization"_kj, "Cache-Control"_kj,
  "Content-Disposition"_kj, "Content-Encoding"_kj, "Content-Language"_kj,
  "Content-Length"_kj, "Content-Location"_kj, "Content-Range"_kj,
  "Content-Type"_kj, "Cookie"_kj, "Date"_kj, "ETag"_kj, "Expect"_kj,
  "Expires"_kj, "From"_kj, "Host"_kj, "If-Match"_kj,
  "If-Modified-Since"_kj, "If-None-Match"_kj, "If-Range"_kj,
  "If-Unmodified-Since"_kj, "Last-Modified"_kj, "Link"_kj, "Location"_kj,
  "Max-Forwards"_kj, "Proxy-Authenticate"_kj, "Proxy-Authorization"_kj,
  "Range"_kj, "Referer"_kj, "Refresh"_kj, "Retry-After"_kj, "Server"_kj,
  "Set-Cookie"_kj, "Strict-Transport-Security"_kj, "Transfer-Encoding"_kj,
  "User-Agent"_kj, "Vary"_kj, "Via"_kj, "WWW-Authenticate"_kj,
};

kj::HttpHeaders decodeLegacyHeaders(kj::HttpHeaderTable& table,
    capnp::List<capnp::HttpHeader>::Reader input) {
  kj::HttpHeaders result(table);
  for (auto header: input) {
    switch (header.which()) {
      case capnp::HttpHeader::UNCOMMON: {
        auto uncommon = header.getUncommon();
        result.add(kj::str(uncommon.getName()), kj::str(uncommon.getValue()));
        break;
      }
      case capnp::HttpHeader::COMMON: {
        auto common = header.getCommon();
        auto nameIndex = static_cast<uint>(common.getName());
        KJ_REQUIRE(nameIndex > 0 && nameIndex < kj::size(LEGACY_COMMON_HEADER_NAMES),
            "invalid legacy common HTTP header name", nameIndex);
        kj::String value;
        switch (common.which()) {
          case capnp::HttpHeader::Common::VALUE:
            value = kj::str(common.getValue());
            break;
          case capnp::HttpHeader::Common::COMMON_VALUE:
            KJ_REQUIRE(common.getCommonValue() == capnp::CommonHeaderValue::GZIP_DEFLATE,
                "invalid legacy common HTTP header value");
            value = kj::str("gzip, deflate");
            break;
        }
        result.add(kj::str(LEGACY_COMMON_HEADER_NAMES[nameIndex]), kj::mv(value));
        break;
      }
    }
  }
  return result;
}

class LegacyHttpRequestContext final:
    public capnp::HttpService::ServerRequestContext::Server,
    public kj::HttpService::Response {
 public:
  LegacyHttpRequestContext(capnp::ByteStreamFactory& streamFactory,
      capnp::HttpRequest::Reader request,
      capnp::HttpService::ClientRequestContext::Client clientContext,
      kj::Own<kj::AsyncInputStream> requestBody,
      kj::HttpHeaderTable& headerTable,
      kj::HttpService& service)
      : streamFactory(streamFactory),
        method(static_cast<kj::HttpMethod>(request.getMethod())), url(kj::str(request.getUrl())),
        headers(decodeLegacyHeaders(headerTable, request.getHeaders())),
        clientContext(kj::mv(clientContext)),
        task(service.request(method, url, headers, *requestBody, *this)
            .attach(kj::mv(requestBody))
            .eagerlyEvaluate([](kj::Exception&& error) { throw kj::mv(error); })) {}

  kj::Maybe<kj::Promise<capnp::Capability::Client>> shortenPath() override {
    return task.then([]() -> capnp::Capability::Client {
      return kj::heap<CompletedLegacyHttpRequest>();
    });
  }

  kj::Own<kj::AsyncOutputStream> send(uint statusCode, kj::StringPtr statusText,
      const kj::HttpHeaders& headers,
      kj::Maybe<uint64_t> expectedBodySize = kj::none) override {
    KJ_REQUIRE(replyTask == kj::none, "HTTP response already started");
    auto request = clientContext.startResponseRequest();
    auto response = request.initResponse();
    response.setStatusCode(statusCode);
    response.setStatusText(statusText);
    auto outputHeaders = response.initHeaders(headers.size());
    size_t headerIndex = 0;
    headers.forEach([&](kj::StringPtr name, kj::StringPtr value) {
      auto uncommon = outputHeaders[headerIndex++].initUncommon();
      uncommon.setName(name);
      uncommon.setValue(value);
    });
    bool hasBody = true;
    KJ_IF_SOME(size, expectedBodySize) {
      response.getBodySize().setFixed(size);
      hasBody = size > 0;
    }
    if (!hasBody) {
      replyTask = request.send().ignoreResult();
      return workerd::newNullOutputStream();
    }
    auto pipeline = request.send();
    auto output = streamFactory.capnpToKj(pipeline.getBody());
    replyTask = pipeline.ignoreResult();
    return output;
  }

  kj::Own<kj::WebSocket> acceptWebSocket(const kj::HttpHeaders&) override {
    KJ_FAIL_REQUIRE("legacy shared-host ingress does not yet support WebSockets");
  }

 private:
  capnp::ByteStreamFactory& streamFactory;
  kj::HttpMethod method;
  kj::String url;
  kj::HttpHeaders headers;
  capnp::HttpService::ClientRequestContext::Client clientContext;
  kj::Maybe<kj::Promise<void>> replyTask;
  kj::Promise<void> task;
};

class LegacyHttpServiceAdapter final: public capnp::HttpService::Server {
 public:
  LegacyHttpServiceAdapter(
      capnp::ByteStreamFactory& streamFactory,
      kj::HttpHeaderTable& headerTable,
      kj::Own<kj::HttpService> service)
      : streamFactory(streamFactory), headerTable(headerTable), service(kj::mv(service)) {}

  kj::Promise<void> startRequest(StartRequestContext context) override {
    KJ_CONTEXT("adapting Cap'n Proto 1.x HTTP ingress");
    auto params = context.getParams();
    auto request = params.getRequest();
    auto bodySize = request.getBodySize();
    kj::Maybe<uint64_t> expectedSize;
    bool hasBody = true;
    if (bodySize.isFixed()) {
      expectedSize = bodySize.getFixed();
      hasBody = bodySize.getFixed() > 0;
    }
    auto results = context.getResults();
    kj::Own<kj::AsyncInputStream> input;
    if (hasBody) {
      auto pipe = kj::newOneWayPipe(expectedSize);
      results.setRequestBody(streamFactory.kjToCapnp(kj::mv(pipe.out)));
      input = kj::mv(pipe.in);
    } else {
      input = workerd::newNullInputStream();
    }
    results.setContext(kj::heap<LegacyHttpRequestContext>(streamFactory,
        request, params.getContext(), kj::mv(input), headerTable, *service));
    return kj::READY_NOW;
  }

 private:
  capnp::ByteStreamFactory& streamFactory;
  kj::HttpHeaderTable& headerTable;
  kj::Own<kj::HttpService> service;
};

LoadedWorkerSource loadWorkerSource(int grainDirFd, kj::HttpHeaderTable& headerTable) {
  static constexpr uint64_t MAX_BUNDLE_FILE_BYTES = 16 * 1024 * 1024;
  static constexpr uint64_t MAX_TRAVERSAL_WORDS = 4 * 1024 * 1024;
  static constexpr size_t MAX_MODULES = 1024;
  static constexpr size_t MAX_MODULE_BYTES = 8 * 1024 * 1024;
  static constexpr size_t MAX_TOTAL_MODULE_BYTES = 16 * 1024 * 1024;
  static constexpr size_t MAX_BINDINGS = 1024;
  static constexpr size_t MAX_TOTAL_BINDING_BYTES = 4 * 1024 * 1024;
  static constexpr size_t MAX_NAME_BYTES = 256;

  int runtimeFd;
  KJ_SYSCALL(runtimeFd = openat(grainDirFd, "isolate-runtime",
      O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
  kj::AutoCloseFd runtimeDir(runtimeFd);
  int sourceFd;
  KJ_SYSCALL(sourceFd = openat(runtimeDir, "worker-source.capnp.bin",
      O_RDONLY | O_NOFOLLOW | O_CLOEXEC));

  struct stat sourceStats;
  KJ_SYSCALL(fstat(sourceFd, &sourceStats));
  KJ_REQUIRE(S_ISREG(sourceStats.st_mode), "worker source bundle is not a regular file");
  KJ_REQUIRE(sourceStats.st_size > 0 && sourceStats.st_size <= MAX_BUNDLE_FILE_BYTES,
      "worker source bundle exceeds size limit", sourceStats.st_size, MAX_BUNDLE_FILE_BYTES);

  auto backing = kj::atomicRefcounted<BundleBacking>();
  capnp::ReaderOptions readerOptions;
  readerOptions.traversalLimitInWords = MAX_TRAVERSAL_WORDS;
  readerOptions.nestingLimit = 32;
  backing->source = kj::heap<capnp::PackedFdMessageReader>(
      kj::AutoCloseFd(sourceFd), readerOptions);
  auto bundle = backing->source->getRoot<IsolateWorkerSource>();
  KJ_REQUIRE(bundle.getFormatVersion() == 1,
      "unsupported worker source format version", bundle.getFormatVersion());
  KJ_REQUIRE(bundle.getMainModule().size() > 0 &&
          bundle.getMainModule().size() <= MAX_NAME_BYTES,
      "invalid worker main module name length", bundle.getMainModule().size());
  KJ_REQUIRE(bundle.getCompatibilityDate().size() <= 32,
      "worker compatibility date exceeds size limit");
  KJ_REQUIRE(bundle.getCompatibilityFlags().size() <= 64,
      "worker compatibility flag count exceeds limit");
  for (auto flag: bundle.getCompatibilityFlags()) {
    KJ_REQUIRE(flag.size() <= 128, "worker compatibility flag exceeds size limit");
  }
  auto inputModules = bundle.getModules();
  KJ_REQUIRE(inputModules.size() > 0 && inputModules.size() <= MAX_MODULES,
      "invalid worker module count", inputModules.size(), MAX_MODULES);
  kj::HashSet<kj::String> moduleNames;
  bool foundMainModule = false;
  size_t totalModuleBytes = 0;
  auto modules = kj::heapArrayBuilder<workerd::WorkerSource::Module>(inputModules.size());
  for (auto input: inputModules) {
    KJ_REQUIRE(input.getName().size() > 0 && input.getName().size() <= MAX_NAME_BYTES,
        "invalid worker module name length", input.getName().size());
    KJ_REQUIRE(moduleNames.find(input.getName()) == kj::none,
        "worker bundle has a duplicate module name", input.getName());
    moduleNames.insert(kj::str(input.getName()));
    if (input.getName() == bundle.getMainModule()) foundMainModule = true;
    workerd::WorkerSource::Module output{.name = input.getName()};
    size_t moduleBytes = 0;
    switch (input.which()) {
      case IsolateWorkerSource::Module::ES_MODULE:
        moduleBytes = input.getEsModule().size();
        output.content = workerd::WorkerSource::EsModule{input.getEsModule().asChars(), kj::none};
        break;
      case IsolateWorkerSource::Module::COMMON_JS_MODULE:
        {
        auto body = input.getCommonJsModule().asChars();
        moduleBytes = body.size();
        output.content = workerd::WorkerSource::CommonJsModule{
          kj::StringPtr(body.begin(), body.size()), kj::none};
        break;
        }
      case IsolateWorkerSource::Module::TEXT:
        {
        auto body = input.getText().asChars();
        moduleBytes = body.size();
        output.content = workerd::WorkerSource::TextModule{
          kj::StringPtr(body.begin(), body.size())};
        break;
        }
      case IsolateWorkerSource::Module::DATA:
        moduleBytes = input.getData().size();
        output.content = workerd::WorkerSource::DataModule{input.getData()};
        break;
      case IsolateWorkerSource::Module::WASM:
        moduleBytes = input.getWasm().size();
        output.content = workerd::WorkerSource::WasmModule{input.getWasm()};
        break;
      case IsolateWorkerSource::Module::JSON:
        {
        auto body = input.getJson().asChars();
        moduleBytes = body.size();
        output.content = workerd::WorkerSource::JsonModule{
          kj::StringPtr(body.begin(), body.size())};
        break;
        }
    }
    KJ_REQUIRE(moduleBytes <= MAX_MODULE_BYTES,
        "worker module exceeds size limit", input.getName(), moduleBytes, MAX_MODULE_BYTES);
    totalModuleBytes += moduleBytes;
    KJ_REQUIRE(totalModuleBytes <= MAX_TOTAL_MODULE_BYTES,
        "worker modules exceed aggregate size limit", totalModuleBytes, MAX_TOTAL_MODULE_BYTES);
    modules.add(kj::mv(output));
  }
  KJ_REQUIRE(foundMainModule, "worker bundle main module is not present", bundle.getMainModule());

  workerd::Frankenvalue env;
  kj::HashSet<kj::String> bindingNames;
  auto inputBindings = bundle.getBindings();
  KJ_REQUIRE(inputBindings.size() <= MAX_BINDINGS,
      "worker binding count exceeds limit", inputBindings.size(), MAX_BINDINGS);
  size_t totalBindingBytes = 0;
  auto accountBindingBytes = [&](size_t bytes) {
    totalBindingBytes += bytes;
    KJ_REQUIRE(totalBindingBytes <= MAX_TOTAL_BINDING_BYTES,
        "worker bindings exceed aggregate size limit",
        totalBindingBytes, MAX_TOTAL_BINDING_BYTES);
  };
  capnp::JsonCodec json;
  for (auto binding: inputBindings) {
    KJ_REQUIRE(binding.getName().size() > 0 && binding.getName().size() <= MAX_NAME_BYTES,
        "invalid worker binding name length", binding.getName().size());
    KJ_REQUIRE(bindingNames.find(binding.getName()) == kj::none,
        "worker bundle has a duplicate binding name", binding.getName());
    bindingNames.insert(kj::str(binding.getName()));
    capnp::MallocMessageBuilder jsonMessage;
    auto jsonValue = jsonMessage.initRoot<capnp::json::Value>();
    switch (binding.which()) {
      case IsolateWorkerSource::Binding::TEXT: {
        auto text = binding.getText().asChars();
        accountBindingBytes(text.size());
        jsonValue.setString(kj::StringPtr(text.begin(), text.size()));
        env.setProperty(kj::str(binding.getName()),
            workerd::Frankenvalue::fromJson(json.encode(jsonValue.asReader())));
        break;
      }
      case IsolateWorkerSource::Binding::JSON: {
        auto text = binding.getJson().asChars();
        accountBindingBytes(text.size());
        json.decode(text, jsonValue);
        env.setProperty(kj::str(binding.getName()),
            workerd::Frankenvalue::fromJson(json.encode(jsonValue.asReader())));
        break;
      }
      case IsolateWorkerSource::Binding::DATA:
        KJ_FAIL_REQUIRE("shared host does not yet support data bindings", binding.getName());
      case IsolateWorkerSource::Binding::SANDSTORM_API:
      case IsolateWorkerSource::Binding::STORAGE:
      case IsolateWorkerSource::Binding::POWERBOX: {
        env.setProperty(kj::str(binding.getName()),
            workerd::Frankenvalue::fromDirectCapability(
                kj::refcounted<HttpServiceChannel>(
                    kj::refcounted<BindingHttpService>(
                        grainDirFd, headerTable, kj::str(binding.getName()),
                        binding.which() == IsolateWorkerSource::Binding::STORAGE))));
        break;
      }
      case IsolateWorkerSource::Binding::SERVICE:
        KJ_FAIL_REQUIRE("shared host does not yet support service bindings", binding.getName());
    }
  }
  auto compatibility = backing->compatibility.initRoot<workerd::CompatibilityFlags>();
  auto inputFlags = bundle.getCompatibilityFlags();
  auto flags = KJ_MAP(flag, inputFlags) { return kj::str(flag); };
  BundleErrorReporter reporter;
  workerd::compileCompatibilityFlags(bundle.getCompatibilityDate(), flags, compatibility,
      reporter, true, workerd::CompatibilityDateValidation::CODE_VERSION);
  reporter.requireValid();

  workerd::WorkerSource source(workerd::WorkerSource::ModulesSource{
    .mainModule = bundle.getMainModule(),
    .modules = modules.finish(),
    .capnpSchemas = {},
    .isPython = false,
    .pythonMemorySnapshot = kj::none,
  });
  workerd::DynamicWorkerSource sourceResult{
    .source = kj::mv(source),
    .compatibilityFlags = compatibility.asReader(),
    .limits = kj::none,
    .env = kj::mv(env),
    .globalOutbound = kj::none,
    .tails = {},
    .streamingTails = {},
    .ownContent = kj::atomicAddRef(*backing),
    .ownContentIsRpcResponse = false,
  };
  return {kj::mv(sourceResult), kj::mv(backing)};
}

void initRuntimeConfig(capnp::MallocMessageBuilder& message) {
  auto config = message.initRoot<workerd::server::config::Config>();
  auto service = config.initServices(1)[0];
  service.setName("sandstorm-loader-bootstrap");
  auto worker = service.initWorker();
  worker.setCompatibilityDate("2026-06-10");
  auto module = worker.initModules(1)[0];
  module.setName("bootstrap.js");
  module.setEsModule("export default { fetch() { return new Response('not exposed'); } };");
  auto binding = worker.initBindings(1)[0];
  binding.setName("GRAIN_LOADER");
  binding.initWorkerLoader().setId(LOADER_NAMESPACE);

  // Server::run() lives for the lifetime of its listeners. Keep one loopback-only listener so
  // the embedded runtime remains active; Sandstorm traffic never enters through this socket.
  auto socket = config.initSockets(1)[0];
  socket.setName("loader-bootstrap");
  socket.setAddress("127.0.0.1:0");
  socket.initHttp();
  socket.getService().setName("sandstorm-loader-bootstrap");
}

bool isValidGrainId(kj::StringPtr id) {
  return id.size() >= 8 && !id.startsWith(".") && id.findFirst('/') == kj::none;
}

struct HostedState final: public kj::Refcounted {
  HostedState(workerd::server::Server& runtime,
      kj::String grainId,
      int grainDirFd,
      IsolateBindingServices::Client bindingServices,
      kj::Own<workerd::WorkerStubChannel> worker)
      : runtime(runtime), grainId(kj::mv(grainId)), grainDirFd(grainDirFd),
        bindingServices(kj::mv(bindingServices)), worker(kj::mv(worker)) {}

  ~HostedState() noexcept { close(grainDirFd); }

  workerd::server::Server& runtime;
  kj::String grainId;
  int grainDirFd;
  IsolateBindingServices::Client bindingServices;
  kj::Own<workerd::WorkerStubChannel> worker;
  bool running = true;
};

class HostedIsolateImpl final: public HostedIsolate::Server {
 public:
  HostedIsolateImpl(kj::Rc<HostedState> state, capnp::ByteStreamFactory& streamFactory)
      : state(kj::mv(state)), streamFactory(streamFactory) {}

  kj::Promise<void> keepAlive(KeepAliveContext context) override {
    KJ_REQUIRE(state->running, "hosted isolate has been stopped");
    return kj::READY_NOW;
  }

  kj::Promise<void> stop(StopContext context) override {
    state->runtime.evictDynamicWorker(LOADER_NAMESPACE, state->grainId);
    state->bindingServices = IsolateBindingServices::Client(nullptr);
    state->running = false;
    return kj::READY_NOW;
  }

  kj::Promise<void> getHttpService(GetHttpServiceContext context) override {
    KJ_REQUIRE(state->running, "hosted isolate has been stopped");
    auto ingress = state->worker->getEntrypoint(
        kj::none, workerd::Frankenvalue(), kj::none);
    context.getResults().setService(kj::heap<LegacyHttpServiceAdapter>(streamFactory,
        state->runtime.getHttpHeaderTableForEmbedding(),
        kj::heap<WorkerIngressService>(kj::mv(ingress))));
    return kj::READY_NOW;
  }

 private:
  kj::Rc<HostedState> state;
  capnp::ByteStreamFactory& streamFactory;
};

class IsolateHostImpl final: public IsolateHost::Server {
 public:
  IsolateHostImpl(workerd::server::Server& runtime,
      capnp::ByteStreamFactory& streamFactory, int grainRootFd)
      : runtime(runtime), streamFactory(streamFactory), grainRootFd(grainRootFd) {}

  ~IsolateHostImpl() noexcept { close(grainRootFd); }

  kj::Promise<void> startGrain(StartGrainContext context) override {
    auto grainId = context.getParams().getGrainId();
    KJ_REQUIRE(isValidGrainId(grainId), "invalid grain ID");
    KJ_REQUIRE(context.getParams().hasServices(), "missing per-grain binding services");

    KJ_IF_SOME(existing, grains.find(grainId)) {
      if (!existing->running) grains.erase(grainId);
    }

    auto& state = grains.findOrCreate(grainId, [&]() -> decltype(grains)::Entry {
      int grainFd;
      KJ_SYSCALL(grainFd = openat(grainRootFd, grainId.cStr(),
          O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC), grainId);
      kj::AutoCloseFd grainDir(grainFd);

      int runtimeFd;
      KJ_SYSCALL(runtimeFd = openat(grainDir, "isolate-runtime",
          O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC), grainId);
      kj::AutoCloseFd runtimeDir(runtimeFd);

      int manifestFd;
      KJ_SYSCALL(manifestFd = openat(runtimeDir, "runtime-manifest.json",
          O_RDONLY | O_NOFOLLOW | O_CLOEXEC), grainId);
      kj::AutoCloseFd manifest(manifestFd);
      struct stat manifestStat;
      KJ_SYSCALL(fstat(manifest, &manifestStat), grainId);
      KJ_REQUIRE(S_ISREG(manifestStat.st_mode), "runtime manifest is not a regular file", grainId);

      auto ownedGrainId = kj::heapString(grainId);
      auto source = loadWorkerSource(
          grainDir.get(), runtime.getHttpHeaderTableForEmbedding());
      auto worker = runtime.loadDynamicWorker(LOADER_NAMESPACE, kj::str(grainId),
          [source = kj::mv(source.source), backing = kj::mv(source.backing)]() mutable {
        return source.clone(kj::atomicAddRef(*backing));
      });
      return {kj::heapString(grainId),
        kj::rc<HostedState>(runtime, kj::mv(ownedGrainId), grainDir.release(),
            context.getParams().getServices(), kj::mv(worker))};
    });
    state->running = true;
    context.getResults().setGrain(kj::heap<HostedIsolateImpl>(state.addRef(), streamFactory));
    return kj::READY_NOW;
  }

 private:
  workerd::server::Server& runtime;
  capnp::ByteStreamFactory& streamFactory;
  int grainRootFd;
  kj::HashMap<kj::String, kj::Rc<HostedState>> grains;
};

}  // namespace
}  // namespace sandstorm

int main(int argc, char** argv) {
  KJ_REQUIRE(argc == 3, "usage: isolate-host <control-socket-path> <grain-root-path>");
  int grainRootFd;
  KJ_SYSCALL(grainRootFd = open(argv[2], O_RDONLY | O_DIRECTORY | O_CLOEXEC), argv[2]);
  auto address = kj::str("unix:", argv[1]);
  unlink(argv[1]);
  auto io = kj::setupAsyncIo();
  auto parsed = io.provider->getNetwork().parseAddress(address, 0).wait(io.waitScope);
  auto listener = parsed->listen();

  auto filesystem = kj::newDiskFilesystem();
  sandstorm::SystemEntropySource entropy;
  auto defaultPlatform = workerd::jsg::defaultPlatform(0);
  workerd::server::WorkerdPlatform v8Platform(*defaultPlatform);
  workerd::jsg::V8System v8System(v8Platform, {}, defaultPlatform.get());
  workerd::server::Server runtime(*filesystem,
      io.provider->getTimer(),
      kj::systemPreciseMonotonicClock(),
      io.provider->getNetwork(),
      entropy,
      workerd::Worker::LoggingOptions(workerd::Worker::ConsoleMode::STDOUT),
      [](kj::String error) { KJ_FAIL_REQUIRE("embedded workerd configuration error", error); });
  runtime.allowExperimental();
  capnp::MallocMessageBuilder runtimeConfig;
  sandstorm::initRuntimeConfig(runtimeConfig);
  auto runtimeTask = runtime.run(v8System, runtimeConfig.getRoot<workerd::server::config::Config>())
      .eagerlyEvaluate([](kj::Exception&& error) {
    KJ_LOG(FATAL, "embedded workerd runtime failed", error);
  });
  KJ_REQUIRE(!runtimeTask.poll(io.waitScope), "embedded workerd runtime stopped during startup");

  capnp::ByteStreamFactory byteStreamFactory;

  capnp::TwoPartyServer controlServer(
      kj::heap<sandstorm::IsolateHostImpl>(runtime, byteStreamFactory, grainRootFd));
  controlServer.listen(*listener).exclusiveJoin(kj::mv(runtimeTask)).wait(io.waitScope);
}
