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

class IsolateAccountHostMain final: public AbstractMain {
public:
  explicit IsolateAccountHostMain(kj::ProcessContext& context);

  kj::MainFunc getMain() override;

private:
  kj::ProcessContext& context;
  kj::String trustDomain;
  kj::String controlSocket;
  kj::String nativeHostPath = kj::str("/bin/isolate-host");
  kj::String appRoot = kj::str("/var/sandstorm/apps");
  kj::String grainRoot = kj::str("/var/sandstorm/grains");
  kj::Maybe<uid_t> sandboxUid;
  bool logSeccompViolations = false;
  bool waitForStartup = false;

  kj::MainBuilder::Validity setTrustDomain(kj::StringPtr value);
  kj::MainBuilder::Validity setControlSocket(kj::StringPtr value);
  kj::MainBuilder::Validity setNativeHostPath(kj::StringPtr value);
  kj::MainBuilder::Validity setUid(kj::StringPtr value);
  kj::MainBuilder::Validity setAppRoot(kj::StringPtr value);
  kj::MainBuilder::Validity setGrainRoot(kj::StringPtr value);
  kj::MainBuilder::Validity run();
};

}  // namespace sandstorm

#endif  // SANDSTORM_ISOLATE_SUPERVISOR_H_
