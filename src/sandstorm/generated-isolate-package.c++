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

#include <errno.h>
#include <fcntl.h>
#include <sandstorm/package.capnp.h>
#include <sodium/crypto_hash_sha256.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#include <algorithm>
#include <set>
#include <string>
#include <vector>

#include "id-to-text.h"
#include "isolate-util.h"
#include "util.h"

namespace sandstorm {
namespace {

using byte = kj::byte;

constexpr size_t MAX_GENERATED_MODULES = 512;
constexpr size_t MAX_GENERATED_MODULE_BYTES = 8 * 1024 * 1024;
constexpr size_t MAX_GENERATED_TOTAL_MODULE_BYTES = 16 * 1024 * 1024;
constexpr size_t MAX_GENERATED_NAME_BYTES = 256;
constexpr size_t MAX_APP_TITLE_BYTES = 256;
constexpr size_t MAX_NOUN_PHRASE_BYTES = 128;
constexpr size_t MAX_SHORT_DESCRIPTION_BYTES = 1024;
constexpr size_t MAX_MARKETING_VERSION_BYTES = 64;

class Sha256 {
public:
  Sha256() { KJ_ASSERT(crypto_hash_sha256_init(&state) == 0); }

  void add(kj::ArrayPtr<const byte> value) {
    byte length[8];
    uint64_t size = value.size();
    for (size_t i = 0; i < sizeof(length); ++i) {
      length[sizeof(length) - i - 1] = size & 0xff;
      size >>= 8;
    }
    KJ_ASSERT(crypto_hash_sha256_update(&state, length, sizeof(length)) == 0);
    KJ_ASSERT(crypto_hash_sha256_update(&state, value.begin(), value.size()) == 0);
  }

  void add(kj::StringPtr value) { add(value.asBytes()); }

  kj::Array<byte> finish() {
    auto result = kj::heapArray<byte>(crypto_hash_sha256_BYTES);
    KJ_ASSERT(crypto_hash_sha256_final(&state, result.begin()) == 0);
    return result;
  }

private:
  crypto_hash_sha256_state state;
};

bool isLeapYear(uint year) { return year % 4 == 0 && (year % 100 != 0 || year % 400 == 0); }

bool isValidCompatibilityDate(kj::StringPtr date) {
  if (date.size() != 10 || date[4] != '-' || date[7] != '-') return false;
  for (size_t i = 0; i < date.size(); ++i) {
    if (i == 4 || i == 7) continue;
    if (date[i] < '0' || date[i] > '9') return false;
  }

  auto digit = [&](size_t index) { return static_cast<uint>(date[index] - '0'); };
  uint year = digit(0) * 1000 + digit(1) * 100 + digit(2) * 10 + digit(3);
  uint month = digit(5) * 10 + digit(6);
  uint day = digit(8) * 10 + digit(9);
  if (year == 0 || month == 0 || month > 12 || day == 0) return false;
  static constexpr uint daysPerMonth[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
  uint maxDay = daysPerMonth[month - 1];
  if (month == 2 && isLeapYear(year)) maxDay = 29;
  return day <= maxDay;
}

bool isValidModuleName(kj::StringPtr name) {
  if (name.size() == 0 || name.size() > MAX_GENERATED_NAME_BYTES || !isCanonicalPackagePath(name)) {
    return false;
  }

  for (char c: name) {
    if (c == ':' || c == '\\' || c == '\0') return false;
  }
  return true;
}

kj::ArrayPtr<const byte> moduleContent(IsolateWorkerSource::Module::Reader module) {
  switch (module.which()) {
    case IsolateWorkerSource::Module::ES_MODULE:
      return module.getEsModule();
    case IsolateWorkerSource::Module::TEXT:
      return module.getText();
    case IsolateWorkerSource::Module::JSON:
      return module.getJson();
    case IsolateWorkerSource::Module::COMMON_JS_MODULE:
    case IsolateWorkerSource::Module::DATA:
    case IsolateWorkerSource::Module::WASM:
      KJ_FAIL_REQUIRE("Generated isolate package contains an unsupported module type.",
                      module.getName());
  }

  KJ_UNREACHABLE;
}

std::vector<size_t> validateSource(IsolateWorkerSource::Reader source) {
  KJ_REQUIRE(source.getFormatVersion() == 1,
             "Generated isolate package has an unsupported source format version.");
  auto mainModule = source.getMainModule();
  KJ_REQUIRE(isValidModuleName(mainModule),
             "Generated isolate package has an invalid main module name.", mainModule);
  KJ_REQUIRE(isValidCompatibilityDate(source.getCompatibilityDate()),
             "Generated isolate package has an invalid compatibility date.");
  KJ_REQUIRE(source.getCompatibilityFlags().size() == 0,
             "Generated isolate compatibility flags are not enabled.");
  KJ_REQUIRE(source.getBindings().size() == 0,
             "Generated isolate bindings are supplied by the platform.");

  auto modules = source.getModules();
  KJ_REQUIRE(modules.size() > 0 && modules.size() <= MAX_GENERATED_MODULES,
             "Generated isolate package has an invalid module count.", modules.size());
  std::set<std::string> names;
  std::vector<size_t> order;
  size_t totalBytes = 0;
  bool foundMain = false;
  for (auto i: kj::indices(modules)) {
    auto module = modules[i];
    auto name = module.getName();
    KJ_REQUIRE(isValidModuleName(name), "Generated isolate package has an invalid module name.",
               name);
    KJ_REQUIRE(names.insert(std::string(name.begin(), name.size())).second,
               "Generated isolate package has a duplicate module name.", name);
    auto content = moduleContent(module);
    KJ_REQUIRE(content.size() <= MAX_GENERATED_MODULE_BYTES,
               "Generated isolate module exceeds its size limit.", name, content.size());
    KJ_REQUIRE(content.size() <= MAX_GENERATED_TOTAL_MODULE_BYTES - totalBytes,
               "Generated isolate modules exceed their aggregate size limit.");
    totalBytes += content.size();
    if (name == mainModule) {
      KJ_REQUIRE(module.which() == IsolateWorkerSource::Module::ES_MODULE,
                 "Generated isolate main module must be an ES module.", name);
      foundMain = true;
    }
    order.push_back(i);
  }
  KJ_REQUIRE(foundMain, "Generated isolate main module is missing.", mainModule);

  std::sort(order.begin(), order.end(), [&](size_t left, size_t right) {
    auto leftName = modules[left].getName();
    auto rightName = modules[right].getName();
    return std::lexicographical_compare(leftName.begin(), leftName.end(), rightName.begin(),
                                        rightName.end());
  });
  return order;
}

void validateMetadata(GeneratedIsolateMetadata metadata) {
  KJ_REQUIRE(metadata.appTitle.size() > 0 && metadata.appTitle.size() <= MAX_APP_TITLE_BYTES,
             "Generated isolate app title is empty or too long.");
  KJ_REQUIRE(metadata.nounPhrase.size() > 0 && metadata.nounPhrase.size() <= MAX_NOUN_PHRASE_BYTES,
             "Generated isolate noun phrase is empty or too long.");
  KJ_REQUIRE(metadata.shortDescription.size() <= MAX_SHORT_DESCRIPTION_BYTES,
             "Generated isolate short description is too long.");
  KJ_REQUIRE(metadata.marketingVersion.size() > 0 &&
                 metadata.marketingVersion.size() <= MAX_MARKETING_VERSION_BYTES,
             "Generated isolate marketing version is empty or too long.");
}

kj::Array<byte> sourceDigest(IsolateWorkerSource::Reader source, const std::vector<size_t>& order) {
  Sha256 hash;
  hash.add("sandstorm-generated-isolate-source-v1");
  hash.add(source.getMainModule());
  hash.add(source.getCompatibilityDate());
  auto modules = source.getModules();
  for (auto index: order) {
    auto module = modules[index];
    hash.add(module.getName());
    byte type = static_cast<byte>(module.which());
    hash.add(kj::arrayPtr(&type, 1));
    hash.add(moduleContent(module));
  }
  return hash.finish();
}

void populateIsolateCommand(spk::Manifest::Command::Builder command,
                            IsolateWorkerSource::Reader source, const std::vector<size_t>& order,
                            kj::StringPtr appTitle) {
  auto isolate = command.initIsolate();
  isolate.setMainModule(source.getMainModule());
  isolate.setCompatibilityDate(source.getCompatibilityDate());
  isolate.initCompatibilityFlags(0);

  auto sourceModules = source.getModules();
  auto modules = isolate.initModules(order.size());
  for (auto outputIndex: kj::indices(modules)) {
    auto input = sourceModules[order[outputIndex]];
    auto output = modules[outputIndex];
    output.setName(input.getName());
    auto path = kj::str("modules/", outputIndex);
    switch (input.which()) {
      case IsolateWorkerSource::Module::ES_MODULE:
        output.setEsModulePath(path);
        break;
      case IsolateWorkerSource::Module::TEXT:
        output.setTextPath(path);
        break;
      case IsolateWorkerSource::Module::JSON:
        output.setJsonPath(path);
        break;
      case IsolateWorkerSource::Module::COMMON_JS_MODULE:
      case IsolateWorkerSource::Module::DATA:
      case IsolateWorkerSource::Module::WASM:
        KJ_UNREACHABLE;
    }
  }

  auto bindings = isolate.initBindings(3);
  bindings[0].setName("SANDSTORM_API");
  bindings[0].setSandstormApi();
  bindings[1].setName("POWERBOX");
  bindings[1].setPowerbox();
  bindings[2].setName("STORAGE");
  bindings[2].setStorage();
  isolate.initBridgeConfig().initViewInfo().initAppTitle().setDefaultText(appTitle);
}

kj::String resolveAppId(kj::StringPtr requestedAppId, kj::ArrayPtr<const byte> digest) {
  if (requestedAppId.size() == 0) {
    return appIdString(digest);
  }

  byte parsed[APP_ID_BYTE_SIZE];
  KJ_REQUIRE(tryParseAppId(requestedAppId, kj::arrayPtr(parsed, sizeof(parsed))),
             "Requested generated isolate app ID is invalid.");
  return kj::str(requestedAppId);
}

kj::String packageIdFor(kj::StringPtr appId, kj::ArrayPtr<const capnp::word> manifest,
                        kj::ArrayPtr<const byte> sourceHash) {
  Sha256 hash;
  hash.add("sandstorm-generated-isolate-package-v1");
  hash.add(appId);
  hash.add(manifest.asBytes());
  hash.add(sourceHash);
  auto digest = hash.finish();
  return packageIdString(digest.slice(0, PACKAGE_ID_BYTE_SIZE));
}

void writeFile(kj::StringPtr path, kj::ArrayPtr<const byte> content) {
  kj::FdOutputStream output(
      raiiOpen(path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0644));
  output.write(content.begin(), content.size());
}

void verifyDirectory(kj::StringPtr path) {
  struct stat stats;
  KJ_SYSCALL(lstat(path.cStr(), &stats), path);
  KJ_REQUIRE(S_ISDIR(stats.st_mode) && !S_ISLNK(stats.st_mode),
             "Generated isolate package root is not a directory.", path);
}

void verifyInstalledAppId(kj::StringPtr path, kj::StringPtr appId) {
  KJ_REQUIRE(trim(readAll(path)) == appId,
             "Generated isolate package ID collision has a different app ID.", path);
}

}  // namespace

GeneratedIsolatePackage buildGeneratedIsolatePackage(kj::StringPtr requestedAppId,
                                                     GeneratedIsolateMetadata metadata,
                                                     IsolateWorkerSource::Reader source) {
  validateMetadata(metadata);
  auto order = validateSource(source);
  auto sourceHash = sourceDigest(source, order);
  auto appId = resolveAppId(requestedAppId, sourceHash);

  capnp::MallocMessageBuilder message;
  auto manifest = message.initRoot<spk::Manifest>();
  manifest.initAppTitle().setDefaultText(metadata.appTitle);
  manifest.setAppVersion(metadata.appVersion);
  manifest.initAppMarketingVersion().setDefaultText(metadata.marketingVersion);
  auto manifestMetadata = manifest.initMetadata();
  manifestMetadata.initShortDescription().setDefaultText(metadata.shortDescription);

  auto actions = manifest.initActions(1);
  auto action = actions[0];
  action.getInput().setNone();
  action.initNounPhrase().setDefaultText(metadata.nounPhrase);
  populateIsolateCommand(action.initCommand(), source, order, metadata.appTitle);
  populateIsolateCommand(manifest.initContinueCommand(), source, order, metadata.appTitle);

  auto manifestWords = capnp::messageToFlatArray(message);
  auto packageId = packageIdFor(appId, manifestWords.asPtr(), sourceHash);
  return {kj::mv(packageId), kj::mv(appId), kj::mv(manifestWords)};
}

GeneratedIsolatePackage installGeneratedIsolatePackage(kj::StringPtr appRoot,
                                                       kj::StringPtr tempRoot,
                                                       kj::StringPtr requestedAppId,
                                                       GeneratedIsolateMetadata metadata,
                                                       IsolateWorkerSource::Reader source) {
  verifyDirectory(appRoot);
  verifyDirectory(tempRoot);
  auto result = buildGeneratedIsolatePackage(requestedAppId, metadata, source);
  auto finalPath = kj::str(appRoot, "/", result.packageId);
  auto appIdPath = kj::str(finalPath, ".appid");
  if (access(finalPath.cStr(), F_OK) == 0) {
    verifyInstalledAppId(appIdPath, result.appId);
    return result;
  }

  static uint counter = 0;
  auto tempPath =
      kj::str(tempRoot, "/generated-isolate.", getpid(), ".", time(nullptr), ".", counter++);
  KJ_SYSCALL(mkdir(tempPath.cStr(), 0700), tempPath);
  bool moved = false;
  KJ_DEFER(if (!moved && access(tempPath.cStr(), F_OK) == 0) {
    kj::runCatchingExceptions([&]() { recursivelyDelete(tempPath); });
  });
  auto modulesPath = kj::str(tempPath, "/modules");
  KJ_SYSCALL(mkdir(modulesPath.cStr(), 0700), modulesPath);
  writeFile(kj::str(tempPath, "/sandstorm-manifest"), result.manifest.asBytes());

  auto order = validateSource(source);
  auto modules = source.getModules();
  for (auto outputIndex: kj::indices(order)) {
    writeFile(kj::str(modulesPath, "/", outputIndex), moduleContent(modules[order[outputIndex]]));
  }

  // Publish only a fully-written marker. O_EXCL on the final path would let a
  // concurrent installer observe the file between open() and write(). A hard
  // link makes the completed temporary file visible atomically without
  // replacing a marker installed by another process.
  auto tempAppIdPath = kj::str(tempPath, ".appid");
  writeFile(tempAppIdPath, result.appId.asBytes());
  KJ_DEFER(if (access(tempAppIdPath.cStr(), F_OK) == 0) { unlink(tempAppIdPath.cStr()); });
  bool createdAppId = false;
  KJ_ON_SCOPE_FAILURE(if (createdAppId && access(finalPath.cStr(), F_OK) != 0) {
    unlink(appIdPath.cStr());
  });
  if (link(tempAppIdPath.cStr(), appIdPath.cStr()) < 0) {
    int error = errno;
    KJ_REQUIRE(error == EEXIST, "Could not create generated isolate app ID file.", appIdPath,
               strerror(error));
    verifyInstalledAppId(appIdPath, result.appId);
  } else {
    createdAppId = true;
  }

  if (rename(tempPath.cStr(), finalPath.cStr()) < 0) {
    int error = errno;
    KJ_REQUIRE((error == EEXIST || error == ENOTEMPTY) &&
                   access(finalPath.cStr(), F_OK) == 0,
               "Could not install generated isolate package.", tempPath, finalPath,
               strerror(error));
    verifyInstalledAppId(appIdPath, result.appId);
  } else {
    moved = true;
  }
  return result;
}

GeneratedIsolatePackage deriveGeneratedIsolatePackage(kj::StringPtr appRoot,
                                                      kj::StringPtr tempRoot,
                                                      kj::StringPtr sourcePackageId,
                                                      kj::StringPtr requestedAppId,
                                                      GeneratedIsolateMetadata metadata) {
  byte parsedPackageId[PACKAGE_ID_BYTE_SIZE];
  KJ_REQUIRE(tryParsePackageId(
      sourcePackageId, kj::arrayPtr(parsedPackageId, sizeof(parsedPackageId))),
      "Generated isolate source package ID is invalid.");

  auto packagePath = kj::str(appRoot, "/", sourcePackageId);
  capnp::ReaderOptions manifestLimits;
  manifestLimits.traversalLimitInWords = spk::Manifest::SIZE_LIMIT_IN_WORDS;
  capnp::StreamFdMessageReader manifestReader(
      raiiOpen(kj::str(packagePath, "/sandstorm-manifest"), O_RDONLY | O_CLOEXEC | O_NOFOLLOW),
      manifestLimits);
  auto manifest = manifestReader.getRoot<spk::Manifest>();
  auto actions = manifest.getActions();
  KJ_REQUIRE(actions.size() == 1 && actions[0].getCommand().hasIsolate(),
      "Generated isolate source package has an invalid action.");
  auto isolate = actions[0].getCommand().getIsolate();

  capnp::MallocMessageBuilder sourceMessage;
  auto source = sourceMessage.initRoot<IsolateWorkerSource>();
  source.setFormatVersion(1);
  source.setMainModule(isolate.getMainModule());
  source.setCompatibilityDate(isolate.getCompatibilityDate());
  source.setCompatibilityFlags(isolate.getCompatibilityFlags());
  source.initBindings(0);

  auto inputModules = isolate.getModules();
  auto outputModules = source.initModules(inputModules.size());
  for (auto i: kj::indices(inputModules)) {
    auto input = inputModules[i];
    auto output = outputModules[i];
    output.setName(input.getName());
    kj::StringPtr relativePath;
    switch (input.which()) {
      case spk::Manifest::IsolateConfig::Module::ES_MODULE_PATH:
        relativePath = input.getEsModulePath();
        break;
      case spk::Manifest::IsolateConfig::Module::TEXT_PATH:
        relativePath = input.getTextPath();
        break;
      case spk::Manifest::IsolateConfig::Module::JSON_PATH:
        relativePath = input.getJsonPath();
        break;
      case spk::Manifest::IsolateConfig::Module::COMMON_JS_MODULE_PATH:
      case spk::Manifest::IsolateConfig::Module::DATA_PATH:
      case spk::Manifest::IsolateConfig::Module::WASM_PATH:
        KJ_FAIL_REQUIRE("Generated isolate source package has an unsupported module type.");
    }

    KJ_REQUIRE(relativePath.startsWith("modules/") && isCanonicalPackagePath(relativePath),
        "Generated isolate source package has an invalid module path.", relativePath);
    auto moduleFd = raiiOpen(
        kj::str(packagePath, "/", relativePath), O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    auto content = readAll(moduleFd.get());
    switch (input.which()) {
      case spk::Manifest::IsolateConfig::Module::ES_MODULE_PATH:
        output.setEsModule(content.asBytes());
        break;
      case spk::Manifest::IsolateConfig::Module::TEXT_PATH:
        output.setText(content.asBytes());
        break;
      case spk::Manifest::IsolateConfig::Module::JSON_PATH:
        output.setJson(content.asBytes());
        break;
      case spk::Manifest::IsolateConfig::Module::COMMON_JS_MODULE_PATH:
      case spk::Manifest::IsolateConfig::Module::DATA_PATH:
      case spk::Manifest::IsolateConfig::Module::WASM_PATH:
        KJ_UNREACHABLE;
    }
  }

  return installGeneratedIsolatePackage(
      appRoot, tempRoot, requestedAppId, metadata, source.asReader());
}

}  // namespace sandstorm
