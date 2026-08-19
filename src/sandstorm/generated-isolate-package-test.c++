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

#include "generated-isolate-package.h"

#include <capnp/serialize.h>
#include <kj/test.h>
#include <sandstorm/package.capnp.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <sys/wait.h>

#include "util.h"

namespace sandstorm {
namespace {

GeneratedIsolateMetadata testMetadata() {
  return {
      "Candidate app", "workspace", "Small isolate app", 3, "revision 3",
  };
}

IsolateWorkerSource::Reader initSource(capnp::MallocMessageBuilder& message,
                                       bool reverseModules = false) {
  auto source = message.initRoot<IsolateWorkerSource>();
  source.setFormatVersion(1);
  source.setMainModule("worker.js");
  source.setCompatibilityDate("2025-01-01");
  source.initCompatibilityFlags(0);
  source.initBindings(0);
  auto modules = source.initModules(2);
  auto workerIndex = reverseModules ? 0 : 1;
  auto dataIndex = reverseModules ? 1 : 0;
  modules[workerIndex].setName("worker.js");
  modules[workerIndex].setEsModule(
      kj::StringPtr("import data from './data.json'; export default { fetch() "
                    "{ return data; } };")
          .asBytes());
  modules[dataIndex].setName("data.json");
  modules[dataIndex].setJson(kj::StringPtr("{\"ok\":true}").asBytes());
  return source.asReader();
}

KJ_TEST("generated isolate package has a derived manifest and stable identity") {
  capnp::MallocMessageBuilder firstMessage;
  auto first = buildGeneratedIsolatePackage("", testMetadata(), initSource(firstMessage));
  capnp::FlatArrayMessageReader firstReader(first.manifest.asPtr());
  auto manifest = firstReader.getRoot<spk::Manifest>();

  KJ_EXPECT(first.appId.size() == 52);
  KJ_EXPECT(first.packageId.size() == 32);
  KJ_EXPECT(manifest.getAppTitle().getDefaultText() == "Candidate app");
  KJ_EXPECT(manifest.getAppVersion() == 3);
  KJ_EXPECT(manifest.getAppMarketingVersion().getDefaultText() == "revision 3");
  KJ_EXPECT(manifest.getMetadata().getShortDescription().getDefaultText() == "Small isolate app");
  auto actions = manifest.getActions();
  KJ_REQUIRE(actions.size() == 1);
  KJ_EXPECT(actions[0].getInput().which() == spk::Manifest::Action::Input::NONE);
  KJ_EXPECT(actions[0].getNounPhrase().getDefaultText() == "workspace");

  auto isolate = actions[0].getCommand().getIsolate();
  KJ_EXPECT(isolate.getMainModule() == "worker.js");
  KJ_EXPECT(isolate.getCompatibilityDate() == "2025-01-01");
  auto modules = isolate.getModules();
  KJ_REQUIRE(modules.size() == 2);
  KJ_EXPECT(modules[0].getName() == "data.json");
  KJ_EXPECT(modules[0].getJsonPath() == "modules/0");
  KJ_EXPECT(modules[1].getName() == "worker.js");
  KJ_EXPECT(modules[1].getEsModulePath() == "modules/1");
  auto bindings = isolate.getBindings();
  KJ_REQUIRE(bindings.size() == 3);
  KJ_EXPECT(bindings[0].getName() == "SANDSTORM_API");
  KJ_EXPECT(bindings[0].which() == spk::Manifest::IsolateConfig::Binding::SANDSTORM_API);
  KJ_EXPECT(bindings[1].getName() == "POWERBOX");
  KJ_EXPECT(bindings[1].which() == spk::Manifest::IsolateConfig::Binding::POWERBOX);
  KJ_EXPECT(bindings[2].getName() == "STORAGE");
  KJ_EXPECT(bindings[2].which() == spk::Manifest::IsolateConfig::Binding::STORAGE);

  capnp::MallocMessageBuilder reorderedMessage;
  auto reordered =
      buildGeneratedIsolatePackage("", testMetadata(), initSource(reorderedMessage, true));
  KJ_EXPECT(reordered.appId == first.appId);
  KJ_EXPECT(reordered.packageId == first.packageId);
}

KJ_TEST("generated isolate package installs atomically and idempotently") {
  auto root = kj::heapString("/tmp/sandstorm-generated-isolate-test-XXXXXX");
  KJ_REQUIRE(mkdtemp(root.begin()) != nullptr, root);
  KJ_DEFER(recursivelyDelete(root));
  auto apps = kj::str(root, "/apps");
  auto temp = kj::str(root, "/tmp");
  KJ_SYSCALL(mkdir(apps.cStr(), 0700), apps);
  KJ_SYSCALL(mkdir(temp.cStr(), 0700), temp);

  capnp::MallocMessageBuilder message;
  auto source = initSource(message);
  auto installed = installGeneratedIsolatePackage(apps, temp, "", testMetadata(), source);
  auto packagePath = kj::str(apps, "/", installed.packageId);
  KJ_EXPECT(readAll(kj::str(packagePath, ".appid")) == installed.appId);
  KJ_EXPECT(readAll(kj::str(packagePath, "/modules/0")) == "{\"ok\":true}");
  KJ_EXPECT(readAll(kj::str(packagePath, "/modules/1")) ==
            "import data from './data.json'; export default { fetch() { return "
            "data; } };");

  auto repeated = installGeneratedIsolatePackage(apps, temp, "", testMetadata(), source);
  KJ_EXPECT(repeated.packageId == installed.packageId);
  KJ_EXPECT(repeated.appId == installed.appId);
}

KJ_TEST("concurrent generated isolate package installs converge") {
  auto root = kj::heapString("/tmp/sandstorm-generated-isolate-race-test-XXXXXX");
  KJ_REQUIRE(mkdtemp(root.begin()) != nullptr, root);
  KJ_DEFER(recursivelyDelete(root));
  auto apps = kj::str(root, "/apps");
  auto temp = kj::str(root, "/tmp");
  KJ_SYSCALL(mkdir(apps.cStr(), 0700), apps);
  KJ_SYSCALL(mkdir(temp.cStr(), 0700), temp);

  capnp::MallocMessageBuilder message;
  auto source = initSource(message);
  constexpr size_t CHILD_COUNT = 8;
  pid_t children[CHILD_COUNT];
  int startPipe[2];
  KJ_SYSCALL(pipe(startPipe));
  for (size_t i = 0; i < CHILD_COUNT; ++i) {
    KJ_SYSCALL(children[i] = fork());
    if (children[i] == 0) {
      close(startPipe[1]);
      char ignored;
      ssize_t readResult;
      do {
        readResult = read(startPipe[0], &ignored, 1);
      } while (readResult < 0 && errno == EINTR);
      close(startPipe[0]);
      if (readResult < 0) _exit(2);

      auto exception = kj::runCatchingExceptions([&]() {
        installGeneratedIsolatePackage(apps, temp, "", testMetadata(), source);
      });
      _exit(exception == nullptr ? 0 : 1);
    }
  }

  close(startPipe[0]);
  close(startPipe[1]);
  for (auto child: children) {
    int status;
    KJ_SYSCALL(waitpid(child, &status, 0));
    KJ_EXPECT(WIFEXITED(status) && WEXITSTATUS(status) == 0, status);
  }

  auto installed = buildGeneratedIsolatePackage("", testMetadata(), source);
  auto packagePath = kj::str(apps, "/", installed.packageId);
  KJ_EXPECT(readAll(kj::str(packagePath, ".appid")) == installed.appId);
  KJ_EXPECT(readAll(kj::str(packagePath, "/modules/0")) == "{\"ok\":true}");
}

KJ_TEST("generated isolate package uses a requested published app identity") {
  const kj::StringPtr PUBLISHED_APP_ID =
      "000h40s40n30f209185hs38f1w8124hm2hajd5ss34e1q70x3sgh";
  capnp::MallocMessageBuilder previewMessage;
  auto preview = buildGeneratedIsolatePackage("", testMetadata(), initSource(previewMessage));
  capnp::MallocMessageBuilder publishedMessage;
  auto published = buildGeneratedIsolatePackage(
      PUBLISHED_APP_ID, testMetadata(), initSource(publishedMessage));
  capnp::MallocMessageBuilder repeatedMessage;
  auto repeated = buildGeneratedIsolatePackage(
      PUBLISHED_APP_ID, testMetadata(), initSource(repeatedMessage));

  KJ_EXPECT(published.appId == PUBLISHED_APP_ID);
  KJ_EXPECT(published.appId != preview.appId);
  KJ_EXPECT(published.packageId != preview.packageId);
  KJ_EXPECT(repeated.packageId == published.packageId);
}

KJ_TEST("generated isolate package derives publication from installed source") {
  auto root = kj::heapString("/tmp/sandstorm-derived-isolate-test-XXXXXX");
  KJ_REQUIRE(mkdtemp(root.begin()) != nullptr, root);
  KJ_DEFER(recursivelyDelete(root));
  auto apps = kj::str(root, "/apps");
  auto temp = kj::str(root, "/tmp");
  KJ_SYSCALL(mkdir(apps.cStr(), 0700), apps);
  KJ_SYSCALL(mkdir(temp.cStr(), 0700), temp);

  capnp::MallocMessageBuilder sourceMessage;
  auto preview = installGeneratedIsolatePackage(
      apps, temp, "", testMetadata(), initSource(sourceMessage));
  const kj::StringPtr PUBLISHED_APP_ID =
      "000h40s40n30f209185hs38f1w8124hm2hajd5ss34e1q70x3sgh";
  GeneratedIsolateMetadata publishedMetadata = {
    "Published app", "document", "Published from preview source", 4, "revision 4",
  };
  auto published = deriveGeneratedIsolatePackage(
      apps, temp, preview.packageId, PUBLISHED_APP_ID, publishedMetadata);
  capnp::MallocMessageBuilder expectedMessage;
  auto expected = buildGeneratedIsolatePackage(
      PUBLISHED_APP_ID, publishedMetadata, initSource(expectedMessage));

  KJ_EXPECT(published.appId == PUBLISHED_APP_ID);
  KJ_EXPECT(published.packageId != preview.packageId);
  KJ_EXPECT(published.packageId == expected.packageId);
  auto publishedPath = kj::str(apps, "/", published.packageId);
  KJ_EXPECT(readAll(kj::str(publishedPath, "/modules/0")) == "{\"ok\":true}");
  KJ_EXPECT(readAll(kj::str(publishedPath, "/modules/1")) ==
            "import data from './data.json'; export default { fetch() { return "
            "data; } };");
  struct stat previewModuleStats;
  struct stat publishedModuleStats;
  KJ_SYSCALL(stat(kj::str(apps, "/", preview.packageId, "/modules/1").cStr(),
                  &previewModuleStats));
  KJ_SYSCALL(stat(kj::str(publishedPath, "/modules/1").cStr(), &publishedModuleStats));
  KJ_EXPECT(previewModuleStats.st_dev == publishedModuleStats.st_dev);
  KJ_EXPECT(previewModuleStats.st_ino == publishedModuleStats.st_ino);

  capnp::FlatArrayMessageReader manifestReader(published.manifest.asPtr());
  auto manifest = manifestReader.getRoot<spk::Manifest>();
  KJ_EXPECT(manifest.getAppTitle().getDefaultText() == "Published app");
  KJ_EXPECT(manifest.getAppVersion() == 4);
}

KJ_TEST("generated isolate package rejects caller-controlled authority and paths") {
  capnp::MallocMessageBuilder bindingMessage;
  auto bindingSource = bindingMessage.initRoot<IsolateWorkerSource>();
  bindingSource.setFormatVersion(1);
  bindingSource.setMainModule("worker.js");
  bindingSource.setCompatibilityDate("2025-01-01");
  auto bindingModules = bindingSource.initModules(1);
  bindingModules[0].setName("worker.js");
  bindingModules[0].setEsModule(kj::StringPtr("export default {};").asBytes());
  auto bindings = bindingSource.initBindings(1);
  bindings[0].setName("ESCAPE");
  bindings[0].setService("arbitrary-service");
  KJ_EXPECT_THROW_MESSAGE(
      "bindings are supplied by the platform",
      buildGeneratedIsolatePackage("", testMetadata(), bindingSource.asReader()));

  capnp::MallocMessageBuilder pathMessage;
  auto pathSource = pathMessage.initRoot<IsolateWorkerSource>();
  pathSource.setFormatVersion(1);
  pathSource.setMainModule("../worker.js");
  pathSource.setCompatibilityDate("2025-01-01");
  auto pathModules = pathSource.initModules(1);
  pathModules[0].setName("../worker.js");
  pathModules[0].setEsModule(kj::StringPtr("export default {};").asBytes());
  KJ_EXPECT_THROW_MESSAGE("invalid main module name",
                          buildGeneratedIsolatePackage("", testMetadata(), pathSource.asReader()));

  capnp::MallocMessageBuilder appIdMessage;
  KJ_EXPECT_THROW_MESSAGE(
      "app ID is invalid",
      buildGeneratedIsolatePackage("not-an-app-id", testMetadata(), initSource(appIdMessage)));
}

}  // namespace
}  // namespace sandstorm
