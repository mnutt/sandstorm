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

#include <kj/test.h>

namespace sandstorm {
namespace {

KJ_TEST("isolate package paths must be canonical and package-relative") {
  KJ_EXPECT(isCanonicalPackagePath("worker.js"));
  KJ_EXPECT(isCanonicalPackagePath("modules/worker.js"));
  KJ_EXPECT(isCanonicalPackagePath("a.b/c-d_e/file.json"));

  KJ_EXPECT(!isCanonicalPackagePath(""));
  KJ_EXPECT(!isCanonicalPackagePath("/worker.js"));
  KJ_EXPECT(!isCanonicalPackagePath("worker.js/"));
  KJ_EXPECT(!isCanonicalPackagePath("./worker.js"));
  KJ_EXPECT(!isCanonicalPackagePath("modules/../worker.js"));
  KJ_EXPECT(!isCanonicalPackagePath("modules//worker.js"));
  KJ_EXPECT(!isCanonicalPackagePath("modules/./worker.js"));
}

KJ_TEST("isolate storage keys are extracted and validated") {
  KJ_EXPECT(isolateStorageKeyFromUrl("/") == "");
  KJ_EXPECT(isolateStorageKeyFromUrl("/counter") == "counter");
  KJ_EXPECT(isolateStorageKeyFromUrl("///counter?ignored=true") == "counter");
  KJ_EXPECT(isolateStorageKeyFromUrl("/nested/path") == "nested/path");

  KJ_EXPECT(isValidIsolateStorageKey("counter"));
  KJ_EXPECT(isValidIsolateStorageKey("counter-1_2.name"));
  KJ_EXPECT(isValidIsolateStorageKey("ABCxyz012"));

  KJ_EXPECT(!isValidIsolateStorageKey(""));
  KJ_EXPECT(!isValidIsolateStorageKey(".hidden"));
  KJ_EXPECT(!isValidIsolateStorageKey("a..b"));
  KJ_EXPECT(!isValidIsolateStorageKey("../bad"));
  KJ_EXPECT(!isValidIsolateStorageKey("bad/key"));
  KJ_EXPECT(!isValidIsolateStorageKey("bad key"));

  kj::Vector<char> longKeyChars;
  for (size_t i = 0; i < 129; ++i) {
    longKeyChars.add('a');
  }
  longKeyChars.add('\0');
  auto longKey = kj::String(longKeyChars.releaseAsArray());
  KJ_EXPECT(!isValidIsolateStorageKey(longKey));
}

KJ_TEST("isolate query parameters are percent-decoded") {
  KJ_EXPECT(decodeIsolateQueryComponent("simple") == "simple");
  KJ_EXPECT(decodeIsolateQueryComponent("a%20b+c") == "a b c");
  KJ_EXPECT(decodeIsolateQueryComponent("view%2Cedit") == "view,edit");
  KJ_EXPECT_THROW_MESSAGE(
      "malformed isolate query parameter encoding", decodeIsolateQueryComponent("bad%xxescape"));

  auto token = findIsolateQueryParam(
      "/powerbox/claim-request?sessionId=session%2Fone&token=req%2Btoken%3D%3D",
      "token");
  KJ_IF_MAYBE(value, token) {
    KJ_EXPECT(*value == "req+token==");
  } else {
    KJ_FAIL_ASSERT("expected token query parameter");
  }

  auto encodedValue = findIsolateQueryParam(
      "/powerbox/claim-request?encoded=view%2Cedit&token=ignored",
      "encoded");
  KJ_IF_MAYBE(value, encodedValue) {
    KJ_EXPECT(*value == "view,edit");
  } else {
    KJ_FAIL_ASSERT("expected encoded query parameter");
  }

  auto repeatedPermissions = findIsolateQueryParams(
      "/powerbox/claim-request?requiredPermission=view&requiredPermission=edit%2Bshare",
      "requiredPermission");
  KJ_EXPECT(repeatedPermissions.size() == 2);
  KJ_EXPECT(repeatedPermissions[0] == "view");
  KJ_EXPECT(repeatedPermissions[1] == "edit+share");

  KJ_EXPECT(findIsolateQueryParam("/powerbox/claim-request?token=present", "missing") == nullptr);
  KJ_EXPECT_THROW_MESSAGE(
      "invalid URL", findIsolateQueryParam("/powerbox/claim-request?token=bad%xxescape", "token"));
}

KJ_TEST("isolate response helper detects structured headers") {
  KJ_EXPECT(isolateEqualsIgnoreCase("Content-Type", "content-type"));
  KJ_EXPECT(!isolateEqualsIgnoreCase("Content-Type", "content-length"));

  KJ_EXPECT(isStructuredIsolateResponseHeader("Content-Type"));
  KJ_EXPECT(isStructuredIsolateResponseHeader("Content-Encoding"));
  KJ_EXPECT(isStructuredIsolateResponseHeader("Content-Disposition"));
  KJ_EXPECT(isStructuredIsolateResponseHeader("content-length"));
  KJ_EXPECT(isStructuredIsolateResponseHeader("Transfer-Encoding"));
  KJ_EXPECT(isStructuredIsolateResponseHeader("Connection"));
  KJ_EXPECT(isStructuredIsolateResponseHeader("Cache-Control"));
  KJ_EXPECT(isStructuredIsolateResponseHeader("ETag"));
  KJ_EXPECT(!isStructuredIsolateResponseHeader("X-Frame-Options"));
}

KJ_TEST("isolate response helper detects HTML MIME type") {
  KJ_EXPECT(isHtmlMimeType("text/html"));
  KJ_EXPECT(isHtmlMimeType("Text/HTML"));
  KJ_EXPECT(isHtmlMimeType(" text/html ; charset=utf-8 "));

  KJ_EXPECT(!isHtmlMimeType("application/json"));
  KJ_EXPECT(!isHtmlMimeType("application/xhtml+xml"));
  KJ_EXPECT(!isHtmlMimeType("text/plain; charset=utf-8"));
}

}  // namespace
}  // namespace sandstorm
