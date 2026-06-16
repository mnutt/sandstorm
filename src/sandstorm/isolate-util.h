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

#ifndef SANDSTORM_ISOLATE_UTIL_H_
#define SANDSTORM_ISOLATE_UTIL_H_

#include <kj/string.h>

namespace sandstorm {

bool isCanonicalPackagePath(kj::StringPtr path);
kj::String isolateStorageKeyFromUrl(kj::StringPtr url);
bool isValidIsolateStorageKey(kj::StringPtr key);
kj::String decodeIsolateQueryComponent(kj::StringPtr value);
kj::Maybe<kj::String> findIsolateQueryParam(kj::StringPtr url, kj::StringPtr name);
kj::Array<kj::String> findIsolateQueryParams(kj::StringPtr url, kj::StringPtr name);
bool isolateEqualsIgnoreCase(kj::StringPtr a, kj::StringPtr b);
bool isStructuredIsolateResponseHeader(kj::StringPtr name);
bool isHtmlMimeType(kj::StringPtr mimeType);

}  // namespace sandstorm

#endif  // SANDSTORM_ISOLATE_UTIL_H_
