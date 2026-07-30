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

#ifndef SANDSTORM_WEB_SESSION_WEBSOCKET_H_
#define SANDSTORM_WEB_SESSION_WEBSOCKET_H_

#include <kj/async-io.h>
#include <kj/debug.h>
#include <kj/refcount.h>
#include <sandstorm/web-session.capnp.h>
#include <string.h>

namespace sandstorm {

class WebSessionWebSocketPipe final : public kj::AsyncIoStream, public kj::Refcounted {
  // Adapts a WebSession::WebSocketStream pair into an AsyncIoStream that can be wrapped by
  // kj::newWebSocket().
  //
  // TODO(apibump): WebSession::WebSocketStream currently transports raw WebSocket protocol bytes,
  // not parsed WebSocket messages. Once the Sandstorm API grows a message-shaped WebSocket stream,
  // this adapter can go away.

public:
  explicit WebSessionWebSocketPipe(WebSession::WebSocketStream::Client outgoing)
      : outgoing(kj::mv(outgoing)) {}

  WebSession::WebSocketStream::Client getIncomingStreamCapability() {
    return kj::heap<WebSocketStreamImpl>(kj::addRef(*this));
  }

  void shutdownWrite() override {
    outgoing = nullptr;
  }

  kj::Promise<void> write(const void* buffer, size_t size) override {
    auto req = KJ_REQUIRE_NONNULL(outgoing, "already called shutdownWrite()").sendBytesRequest();
    req.setMessage(kj::arrayPtr(reinterpret_cast<const kj::byte*>(buffer), size));
    return req.send();
  }

  kj::Promise<void> write(kj::ArrayPtr<const kj::ArrayPtr<const kj::byte>> pieces) override {
    size_t size = 0;
    for (auto piece: pieces) {
      size += piece.size();
    }

    auto req = KJ_REQUIRE_NONNULL(outgoing, "already called shutdownWrite()").sendBytesRequest();
    auto builder = req.initMessage(size);

    kj::byte* pos = builder.begin();
    for (auto piece: pieces) {
      memcpy(pos, piece.begin(), piece.size());
      pos += piece.size();
    }
    KJ_ASSERT(pos == builder.end());

    return req.send();
  }

  kj::Promise<void> whenWriteDisconnected() override {
    return kj::NEVER_DONE;
  }

  kj::Promise<size_t> tryRead(void* buffer, size_t minBytes, size_t maxBytes) override {
    KJ_SWITCH_ONEOF(current) {
      KJ_CASE_ONEOF(w, CurrentWrite) {
        if (maxBytes < w.buffer.size()) {
          memcpy(buffer, w.buffer.begin(), maxBytes);
          w.buffer = w.buffer.slice(maxBytes, w.buffer.size());
          return maxBytes;
        } else if (minBytes <= w.buffer.size()) {
          size_t result = w.buffer.size();
          memcpy(buffer, w.buffer.begin(), result);
          w.fulfiller->fulfill();
          current = None();
          return result;
        } else {
          size_t alreadyRead = w.buffer.size();
          memcpy(buffer, w.buffer.begin(), alreadyRead);
          w.fulfiller->fulfill();
          auto paf = kj::newPromiseAndFulfiller<size_t>();
          current = CurrentRead {
            kj::arrayPtr(reinterpret_cast<kj::byte*>(buffer) + alreadyRead, maxBytes - alreadyRead),
            minBytes - alreadyRead,
            alreadyRead,
            kj::mv(paf.fulfiller)
          };
          return kj::mv(paf.promise);
        }
      }
      KJ_CASE_ONEOF(r, CurrentRead) {
        KJ_FAIL_REQUIRE("can only call read() once at a time");
      }
      KJ_CASE_ONEOF(e, Eof) {
        return size_t(0);
      }
      KJ_CASE_ONEOF(n, None) {
        auto paf = kj::newPromiseAndFulfiller<size_t>();
        current = CurrentRead {
          kj::arrayPtr(reinterpret_cast<kj::byte*>(buffer), maxBytes),
          minBytes,
          0,
          kj::mv(paf.fulfiller)
        };
        return kj::mv(paf.promise);
      }
    }
    KJ_UNREACHABLE;
  }

  kj::Promise<void> fulfillRead(kj::ArrayPtr<const kj::byte> data) {
    KJ_SWITCH_ONEOF(current) {
      KJ_CASE_ONEOF(w, CurrentWrite) {
        KJ_FAIL_REQUIRE("can only call fulfillRead() once at a time");
      }
      KJ_CASE_ONEOF(r, CurrentRead) {
        if (data.size() < r.minBytes) {
          memcpy(r.buffer.begin(), data.begin(), data.size());
          r.minBytes -= data.size();
          r.alreadyRead += data.size();
          r.buffer = r.buffer.slice(data.size(), r.buffer.size());
          return kj::READY_NOW;
        } else if (data.size() <= r.buffer.size()) {
          memcpy(r.buffer.begin(), data.begin(), data.size());
          r.fulfiller->fulfill(r.alreadyRead + data.size());
          current = None();
          return kj::READY_NOW;
        } else {
          size_t amount = r.buffer.size();
          memcpy(r.buffer.begin(), data.begin(), amount);
          r.fulfiller->fulfill(amount + r.alreadyRead);
          auto paf = kj::newPromiseAndFulfiller<void>();
          current = CurrentWrite { data.slice(amount, data.size()), kj::mv(paf.fulfiller) };
          return kj::mv(paf.promise);
        }
      }
      KJ_CASE_ONEOF(e, Eof) {
        KJ_FAIL_REQUIRE("write after EOF");
      }
      KJ_CASE_ONEOF(n, None) {
        auto paf = kj::newPromiseAndFulfiller<void>();
        current = CurrentWrite { data, kj::mv(paf.fulfiller) };
        return kj::mv(paf.promise);
      }
    }
    KJ_UNREACHABLE;
  }

  void fulfillReadEof() {
    KJ_SWITCH_ONEOF(current) {
      KJ_CASE_ONEOF(w, CurrentWrite) {
        KJ_LOG(ERROR, "can only call fulfillRead() once at a time");
      }
      KJ_CASE_ONEOF(r, CurrentRead) {
        r.fulfiller->fulfill(kj::cp(r.alreadyRead));
        current = Eof();
      }
      KJ_CASE_ONEOF(e, Eof) {
        KJ_LOG(ERROR, "double EOF");
      }
      KJ_CASE_ONEOF(n, None) {
        current = Eof();
      }
    }
  }

private:
  kj::Maybe<WebSession::WebSocketStream::Client> outgoing;

  struct CurrentWrite {
    kj::ArrayPtr<const kj::byte> buffer;
    kj::Own<kj::PromiseFulfiller<void>> fulfiller;
  };
  struct CurrentRead {
    kj::ArrayPtr<kj::byte> buffer;
    size_t minBytes;
    size_t alreadyRead;
    kj::Own<kj::PromiseFulfiller<size_t>> fulfiller;
  };
  struct Eof {};
  struct None {};

  kj::OneOf<CurrentWrite, CurrentRead, Eof, None> current = None();

  class WebSocketStreamImpl final: public WebSession::WebSocketStream::Server {
  public:
    explicit WebSocketStreamImpl(kj::Own<WebSessionWebSocketPipe> pipe)
        : pipe(kj::mv(pipe)) {}

    ~WebSocketStreamImpl() noexcept(false) {
      pipe->fulfillReadEof();
    }

  protected:
    kj::Promise<void> sendBytes(SendBytesContext context) override {
      auto fork = queue.then([this, context]() mutable {
        return pipe->fulfillRead(context.getParams().getMessage());
      }).fork();
      queue = fork.addBranch();
      return fork.addBranch();
    }

  private:
    kj::Own<WebSessionWebSocketPipe> pipe;
    kj::Promise<void> queue = kj::READY_NOW;
  };
};

}  // namespace sandstorm

#endif  // SANDSTORM_WEB_SESSION_WEBSOCKET_H_
