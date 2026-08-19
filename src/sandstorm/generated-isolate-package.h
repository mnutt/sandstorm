// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2026 Sandstorm Development Group, Inc. and contributors
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

#ifndef SANDSTORM_GENERATED_ISOLATE_PACKAGE_H_
#define SANDSTORM_GENERATED_ISOLATE_PACKAGE_H_

#include <capnp/serialize.h>
#include <kj/string.h>
#include <sandstorm/isolate-worker-source.capnp.h>

namespace sandstorm {

struct GeneratedIsolateMetadata {
  kj::StringPtr appTitle;
  kj::StringPtr nounPhrase;
  kj::StringPtr shortDescription;
  uint32_t appVersion;
  kj::StringPtr marketingVersion;
};

struct GeneratedIsolatePackage {
  kj::String packageId;
  kj::String appId;
  kj::Array<capnp::word> manifest;
};

GeneratedIsolatePackage buildGeneratedIsolatePackage(kj::StringPtr requestedAppId,
                                                     GeneratedIsolateMetadata metadata,
                                                     IsolateWorkerSource::Reader source);

GeneratedIsolatePackage installGeneratedIsolatePackage(kj::StringPtr appRoot,
                                                       kj::StringPtr tempRoot,
                                                       kj::StringPtr requestedAppId,
                                                       GeneratedIsolateMetadata metadata,
                                                       IsolateWorkerSource::Reader source);

GeneratedIsolatePackage deriveGeneratedIsolatePackage(kj::StringPtr appRoot,
                                                      kj::StringPtr tempRoot,
                                                      kj::StringPtr sourcePackageId,
                                                      kj::StringPtr requestedAppId,
                                                      GeneratedIsolateMetadata metadata);

}  // namespace sandstorm

#endif  // SANDSTORM_GENERATED_ISOLATE_PACKAGE_H_
