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

#ifndef SANDSTORM_ISOLATE_SUPERVISOR_H_
#define SANDSTORM_ISOLATE_SUPERVISOR_H_

#include "abstract-main.h"

#include <kj/main.h>
#include <kj/vector.h>
#include <sys/types.h>

namespace sandstorm {

class IsolateSupervisorMain final: public AbstractMain {
  // Minimal supervisor entrypoint for isolate grains.
  //
  // It exposes the normal Supervisor bootstrap interface over the usual grain socket and routes
  // WebSession traffic through the workerd-shaped runtime adapter seam.

public:
  explicit IsolateSupervisorMain(kj::ProcessContext& context);

  kj::MainFunc getMain() override;

  kj::MainBuilder::Validity setAppName(kj::StringPtr name);
  kj::MainBuilder::Validity setGrainId(kj::StringPtr id);
  kj::MainBuilder::Validity setPkg(kj::StringPtr path);
  kj::MainBuilder::Validity setVar(kj::StringPtr path);
  kj::MainBuilder::Validity setUid(kj::StringPtr arg);
  kj::MainBuilder::Validity setIsolateMainModule(kj::StringPtr mainModule);
  kj::MainBuilder::Validity setIsolateCompatibilityDate(kj::StringPtr compatibilityDate);
  kj::MainBuilder::Validity setIsolateTrustDomain(kj::StringPtr trustDomain);
  kj::MainBuilder::Validity addEnv(kj::StringPtr arg);
  kj::MainBuilder::Validity addRuntimeArg(kj::StringPtr arg);
  kj::MainBuilder::Validity run();

private:
  kj::ProcessContext& context;

  kj::String appName;
  kj::String grainId;
  kj::String pkgPath;
  kj::String varPath;
  kj::String isolateMainModule;
  kj::String isolateCompatibilityDate;
  kj::String isolateTrustDomain;
  kj::Vector<kj::String> environment;
  kj::Vector<kj::String> runtimeArgs;
  bool isNew = false;
  bool keepStdio = false;
  bool logSeccompViolations = false;
  kj::Maybe<uid_t> sandboxUid;

  kj::String realPath(kj::StringPtr path);
};

class IsolateDevSidecarMain final: public AbstractMain {
  // Minimal built-in HTTP sidecar used to validate the isolate-supervisor sidecar/proxy path.
  //
  // It is intentionally not a JavaScript runtime. It serves the generated runtime bundle metadata
  // over the same Unix socket contract that a workerd sidecar uses.

public:
  explicit IsolateDevSidecarMain(kj::ProcessContext& context);

  kj::MainFunc getMain() override;

private:
  kj::ProcessContext& context;

  kj::MainBuilder::Validity run();
};

}  // namespace sandstorm

#endif  // SANDSTORM_ISOLATE_SUPERVISOR_H_
