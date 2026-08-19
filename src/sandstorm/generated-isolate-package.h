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
#include <kj/refcount.h>
#include <kj/string.h>
#include <sandstorm/isolate-authoring.capnp.h>
#include <sandstorm/isolate-worker-source.capnp.h>

#include <memory>
#include <vector>

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

class GeneratedIsolatePackageUploadState final: public kj::Refcounted {
public:
  GeneratedIsolatePackageUploadState(kj::StringPtr appRoot,
                                     kj::StringPtr tempRoot,
                                     kj::StringPtr requestedAppId,
                                     GeneratedIsolateMetadata metadata,
                                     BundleInfo::Reader info);
  ~GeneratedIsolatePackageUploadState() noexcept;

  void beginModule(uint16_t index);
  void writeModule(uint16_t index, kj::ArrayPtr<const kj::byte> data);
  void expectModuleSize(uint16_t index, uint64_t size);
  void finishModule(uint16_t index);
  void finishTransfer();
  GeneratedIsolatePackage save();

private:
  struct ModuleUpload;

  kj::String appRoot;
  kj::String tempPath;
  kj::String requestedAppId;
  kj::String appTitle;
  kj::String nounPhrase;
  kj::String shortDescription;
  uint32_t appVersion;
  kj::String marketingVersion;
  kj::String mainModule;
  kj::String compatibilityDate;
  std::vector<std::unique_ptr<ModuleUpload>> modules;
  std::vector<size_t> order;
  bool transferFinished = false;
  bool saveCalled = false;
  bool installed = false;
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
