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

#include "isolate-util.h"
#include "util.h"

namespace sandstorm {

bool isCanonicalPackagePath(kj::StringPtr path) {
  if (path.size() == 0 || path.startsWith("/") || path.endsWith("/")) {
    return false;
  }

  size_t start = 0;
  for (size_t i = 0; i <= path.size(); ++i) {
    if (i == path.size() || path[i] == '/') {
      auto part = path.slice(start, i);
      if (part.size() == 0 ||
          (part.size() == 1 && part[0] == '.') ||
          (part.size() == 2 && part[0] == '.' && part[1] == '.')) {
        return false;
      }
      start = i + 1;
    }
  }

  return true;
}

kj::String isolateStorageKeyFromUrl(kj::StringPtr url) {
  size_t begin = 0;
  size_t end = url.size();
  KJ_IF_MAYBE(query, url.findFirst('?')) {
    end = *query;
  }
  while (begin < end && url[begin] == '/') {
    ++begin;
  }
  return kj::str(url.slice(begin, end));
}

bool isValidIsolateStorageKey(kj::StringPtr key) {
  if (key.size() == 0 || key.size() > 128 || key.startsWith(".")) {
    return false;
  }

  for (char c: key) {
    if (!(c >= 'a' && c <= 'z') &&
        !(c >= 'A' && c <= 'Z') &&
        !(c >= '0' && c <= '9') &&
        c != '-' && c != '_' && c != '.') {
      return false;
    }
  }

  for (size_t i = 1; i < key.size(); ++i) {
    if (key[i - 1] == '.' && key[i] == '.') {
      return false;
    }
  }
  return true;
}

kj::Maybe<uint> isolateHexValue(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return nullptr;
}

kj::String decodeIsolateQueryComponent(kj::StringPtr value) {
  kj::Vector<char> result;
  for (size_t i = 0; i < value.size(); ++i) {
    if (value[i] == '+') {
      result.add(' ');
    } else if (value[i] == '%' && i + 2 < value.size()) {
      KJ_IF_MAYBE(high, isolateHexValue(value[i + 1])) {
        KJ_IF_MAYBE(low, isolateHexValue(value[i + 2])) {
          result.add(static_cast<char>((*high << 4) | *low));
          i += 2;
        } else {
          result.add(value[i]);
        }
      } else {
        result.add(value[i]);
      }
    } else {
      result.add(value[i]);
    }
  }

  result.add('\0');
  return kj::String(result.releaseAsArray());
}

kj::Array<kj::String> findIsolateQueryParams(kj::StringPtr url, kj::StringPtr name) {
  kj::Vector<kj::String> results;
  KJ_IF_MAYBE(query, url.findFirst('?')) {
    size_t start = *query + 1;
    while (start <= url.size()) {
      auto remaining = url.slice(start, url.size());
      size_t end = url.size();
      KJ_IF_MAYBE(amp, remaining.findFirst('&')) {
        end = start + *amp;
      }

      auto part = url.slice(start, end);
      KJ_IF_MAYBE(eq, part.findFirst('=')) {
        auto keySlice = part.slice(0, *eq);
        auto key = decodeIsolateQueryComponent(kj::StringPtr(keySlice.begin(), keySlice.size()));
        if (key == name) {
          auto valueSlice = part.slice(*eq + 1, part.size());
          results.add(decodeIsolateQueryComponent(
              kj::StringPtr(valueSlice.begin(), valueSlice.size())));
        }
      }

      if (end == url.size()) {
        break;
      }
      start = end + 1;
    }
  }

  return results.releaseAsArray();
}

kj::Maybe<kj::String> findIsolateQueryParam(kj::StringPtr url, kj::StringPtr name) {
  auto params = findIsolateQueryParams(url, name);
  if (params.size() > 0) {
    return kj::mv(params[0]);
  }

  return nullptr;
}

bool isolateEqualsIgnoreCase(kj::StringPtr a, kj::StringPtr b) {
  if (a.size() != b.size()) {
    return false;
  }

  for (auto i: kj::indices(a)) {
    char ca = a[i];
    char cb = b[i];
    if (ca >= 'A' && ca <= 'Z') {
      ca += 'a' - 'A';
    }
    if (cb >= 'A' && cb <= 'Z') {
      cb += 'a' - 'A';
    }
    if (ca != cb) {
      return false;
    }
  }

  return true;
}

bool isStructuredIsolateResponseHeader(kj::StringPtr name) {
  return isolateEqualsIgnoreCase(name, "content-type") ||
      isolateEqualsIgnoreCase(name, "content-encoding") ||
      isolateEqualsIgnoreCase(name, "content-language") ||
      isolateEqualsIgnoreCase(name, "content-disposition") ||
      isolateEqualsIgnoreCase(name, "etag") ||
      isolateEqualsIgnoreCase(name, "location") ||
      isolateEqualsIgnoreCase(name, "content-length") ||
      isolateEqualsIgnoreCase(name, "transfer-encoding") ||
      isolateEqualsIgnoreCase(name, "connection") ||
      isolateEqualsIgnoreCase(name, "keep-alive") ||
      isolateEqualsIgnoreCase(name, "te") ||
      isolateEqualsIgnoreCase(name, "trailer") ||
      isolateEqualsIgnoreCase(name, "upgrade");
}

bool isHtmlMimeType(kj::StringPtr mimeType) {
  auto trimmed = trim(mimeType);
  kj::StringPtr type = trimmed;
  KJ_IF_MAYBE(semi, type.findFirst(';')) {
    type = kj::StringPtr(type.begin(), *semi);
  }
  auto lower = kj::str(trim(type));
  toLower(lower);
  return lower == "text/html";
}

}  // namespace sandstorm
