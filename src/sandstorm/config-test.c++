// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2026 Sandstorm contributors
// All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

#include "util.h"
#include "config.h"

#include <fcntl.h>
#include <kj/debug.h>
#include <kj/test.h>
#include <stdlib.h>
#include <unistd.h>

namespace sandstorm {
namespace {

class TempConfig {
public:
  TempConfig() {
    KJ_SYSCALL(fd = mkstemp(path));
  }

  ~TempConfig() noexcept {
    close(fd);
    unlink(path);
  }

  void set(kj::StringPtr content) {
    KJ_SYSCALL(ftruncate(fd, 0));
    KJ_SYSCALL(lseek(fd, 0, SEEK_SET));
    auto remaining = content.asBytes();
    while (remaining.size() > 0) {
      ssize_t count;
      KJ_SYSCALL(count = write(fd, remaining.begin(), remaining.size()));
      remaining = remaining.slice(count, remaining.size());
    }
  }

  const char* getPath() const { return path; }

private:
  char path[sizeof("/tmp/sandstorm-config-test-XXXXXX")] =
      "/tmp/sandstorm-config-test-XXXXXX";
  int fd;
};

KJ_TEST("account-shared isolate hosting is the default") {
  TempConfig file;
  auto config = readConfig(file.getPath(), false);
  KJ_EXPECT(config.isolateHostingMode == IsolateHostingMode::ACCOUNT);
}

KJ_TEST("per-grain isolate hosting remains an explicit fallback") {
  TempConfig file;
  file.set("ISOLATE_HOSTING_MODE=per-grain\n");
  auto config = readConfig(file.getPath(), false);
  KJ_EXPECT(config.isolateHostingMode == IsolateHostingMode::PER_GRAIN);
}

}  // namespace
}  // namespace sandstorm
