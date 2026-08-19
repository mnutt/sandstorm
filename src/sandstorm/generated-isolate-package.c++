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

  void addSize(uint64_t size) {
    byte length[8];
    for (size_t i = 0; i < sizeof(length); ++i) {
      length[sizeof(length) - i - 1] = size & 0xff;
      size >>= 8;
    }
    KJ_ASSERT(crypto_hash_sha256_update(&state, length, sizeof(length)) == 0);
  }

  void addRaw(kj::ArrayPtr<const byte> value) {
    KJ_ASSERT(crypto_hash_sha256_update(&state, value.begin(), value.size()) == 0);
  }

  void add(kj::ArrayPtr<const byte> value) {
    addSize(value.size());
    addRaw(value);
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

void populateIsolateCommandFromInstalled(spk::Manifest::Command::Builder command,
                                         spk::Manifest::IsolateConfig::Reader source,
                                         kj::StringPtr appTitle) {
  auto isolate = command.initIsolate();
  isolate.setMainModule(source.getMainModule());
  isolate.setCompatibilityDate(source.getCompatibilityDate());
  isolate.initCompatibilityFlags(0);
  auto sourceModules = source.getModules();
  auto modules = isolate.initModules(sourceModules.size());
  for (auto i: kj::indices(modules)) {
    auto input = sourceModules[i];
    auto output = modules[i];
    output.setName(input.getName());
    switch (input.which()) {
      case spk::Manifest::IsolateConfig::Module::ES_MODULE_PATH:
        output.setEsModulePath(input.getEsModulePath());
        break;
      case spk::Manifest::IsolateConfig::Module::TEXT_PATH:
        output.setTextPath(input.getTextPath());
        break;
      case spk::Manifest::IsolateConfig::Module::JSON_PATH:
        output.setJsonPath(input.getJsonPath());
        break;
      case spk::Manifest::IsolateConfig::Module::COMMON_JS_MODULE_PATH:
      case spk::Manifest::IsolateConfig::Module::DATA_PATH:
      case spk::Manifest::IsolateConfig::Module::WASM_PATH:
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

void addFileToHash(Sha256& hash, int fd, uint64_t size) {
  hash.addSize(size);
  byte buffer[64 * 1024];
  uint64_t remaining = size;
  while (remaining > 0) {
    size_t requested = kj::min(static_cast<uint64_t>(sizeof(buffer)), remaining);
    ssize_t amount;
    KJ_SYSCALL(amount = read(fd, buffer, requested));
    KJ_REQUIRE(amount > 0, "Generated isolate module ended before its declared file size.");
    hash.addRaw(kj::arrayPtr(buffer, static_cast<size_t>(amount)));
    remaining -= amount;
  }
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

void commitGeneratedPackage(kj::StringPtr appRoot, kj::StringPtr tempPath,
                            const GeneratedIsolatePackage& result) {
  auto finalPath = kj::str(appRoot, "/", result.packageId);
  auto appIdPath = kj::str(finalPath, ".appid");
  bool moved = false;
  KJ_DEFER(if (!moved && access(tempPath.cStr(), F_OK) == 0) {
    kj::runCatchingExceptions([&]() { recursivelyDelete(tempPath); });
  });
  if (access(finalPath.cStr(), F_OK) == 0) {
    verifyInstalledAppId(appIdPath, result.appId);
    return;
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
}

}  // namespace

struct GeneratedIsolatePackageUploadState::ModuleUpload {
  kj::String name;
  ModuleType type;
  uint64_t size;
  size_t outputIndex = 0;
  uint64_t received = 0;
  kj::Maybe<kj::AutoCloseFd> fd;
  bool opened = false;
  bool done = false;
};

GeneratedIsolatePackageUploadState::GeneratedIsolatePackageUploadState(
    kj::StringPtr appRoot,
    kj::StringPtr tempRoot,
    kj::StringPtr requestedAppId,
    GeneratedIsolateMetadata metadata,
    BundleInfo::Reader info)
    : appRoot(kj::str(appRoot)),
      requestedAppId(kj::str(requestedAppId)),
      appTitle(kj::str(metadata.appTitle)),
      nounPhrase(kj::str(metadata.nounPhrase)),
      shortDescription(kj::str(metadata.shortDescription)),
      appVersion(metadata.appVersion),
      marketingVersion(kj::str(metadata.marketingVersion)),
      mainModule(kj::str(info.getMainModule())),
      compatibilityDate(kj::str(info.getCompatibilityDate())) {
  verifyDirectory(this->appRoot);
  verifyDirectory(tempRoot);
  validateMetadata({this->appTitle, this->nounPhrase, this->shortDescription,
                    this->appVersion, this->marketingVersion});
  KJ_REQUIRE(info.getFormatVersion() == 1,
      "Generated isolate package has an unsupported source format version.");
  KJ_REQUIRE(isValidModuleName(this->mainModule),
      "Generated isolate package has an invalid main module name.", this->mainModule);
  KJ_REQUIRE(isValidCompatibilityDate(this->compatibilityDate),
      "Generated isolate package has an invalid compatibility date.");
  KJ_REQUIRE(info.getCompatibilityFlags().size() == 0,
      "Generated isolate compatibility flags are not enabled.");

  auto inputModules = info.getModules();
  KJ_REQUIRE(inputModules.size() > 0 && inputModules.size() <= MAX_GENERATED_MODULES,
      "Generated isolate package has an invalid module count.", inputModules.size());
  std::set<std::string> names;
  bool foundMain = false;
  modules.reserve(inputModules.size());
  order.reserve(inputModules.size());
  for (auto i: kj::indices(inputModules)) {
    auto input = inputModules[i];
    auto name = input.getName();
    KJ_REQUIRE(isValidModuleName(name),
        "Generated isolate package has an invalid module name.", name);
    KJ_REQUIRE(names.insert(std::string(name.begin(), name.size())).second,
        "Generated isolate package has a duplicate module name.", name);
    KJ_REQUIRE(input.getSize() <= MAX_GENERATED_MODULE_BYTES,
        "Generated isolate module exceeds its size limit.", name, input.getSize());
    KJ_REQUIRE(input.getType() == ModuleType::ES_MODULE ||
                   input.getType() == ModuleType::JSON || input.getType() == ModuleType::TEXT,
        "Generated isolate package contains an unsupported module type.", name);

    auto module = std::make_unique<ModuleUpload>();
    module->name = kj::str(name);
    module->type = input.getType();
    module->size = input.getSize();
    if (name == this->mainModule) {
      KJ_REQUIRE(module->type == ModuleType::ES_MODULE,
          "Generated isolate main module must be an ES module.", name);
      foundMain = true;
    }
    modules.push_back(std::move(module));
    order.push_back(i);
  }
  KJ_REQUIRE(foundMain, "Generated isolate main module is missing.", this->mainModule);
  std::sort(order.begin(), order.end(), [&](size_t left, size_t right) {
    return modules[left]->name < modules[right]->name;
  });
  for (auto outputIndex: kj::indices(order)) {
    modules[order[outputIndex]]->outputIndex = outputIndex;
  }

  static uint counter = 0;
  tempPath = kj::str(
      tempRoot, "/streamed-isolate.", getpid(), ".", time(nullptr), ".", counter++);
  bool created = false;
  KJ_DEFER(if (!created && tempPath.size() > 0 && access(tempPath.cStr(), F_OK) == 0) {
    kj::runCatchingExceptions([&]() { recursivelyDelete(tempPath); });
  });
  KJ_SYSCALL(mkdir(tempPath.cStr(), 0700), tempPath);
  KJ_SYSCALL(mkdir(kj::str(tempPath, "/modules").cStr(), 0700), tempPath);
  created = true;
}

GeneratedIsolatePackageUploadState::~GeneratedIsolatePackageUploadState() noexcept {
  if (!installed && tempPath.size() > 0 && access(tempPath.cStr(), F_OK) == 0) {
    KJ_IF_MAYBE(error, kj::runCatchingExceptions([&]() { recursivelyDelete(tempPath); })) {
      KJ_LOG(ERROR, "Could not remove abandoned generated isolate upload.", *error);
    }
  }
}

void GeneratedIsolatePackageUploadState::beginModule(uint16_t index) {
  KJ_REQUIRE(!transferFinished, "beginModule() called after finish().");
  KJ_REQUIRE(index < modules.size(), "Generated isolate module index is out of range.", index);
  auto& module = *modules[index];
  KJ_REQUIRE(!module.opened, "Generated isolate module was opened more than once.", index);
  module.fd = raiiOpen(kj::str(tempPath, "/modules/", module.outputIndex),
      O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0644);
  module.opened = true;
}

void GeneratedIsolatePackageUploadState::writeModule(
    uint16_t index, kj::ArrayPtr<const byte> data) {
  KJ_REQUIRE(index < modules.size(), "Generated isolate module index is out of range.", index);
  auto& module = *modules[index];
  KJ_REQUIRE(module.opened && !module.done,
      "Generated isolate module write occurred outside its stream lifetime.", index);
  KJ_REQUIRE(data.size() <= module.size - module.received,
      "Generated isolate module received more than its declared size.", module.name);
  auto& fd = KJ_REQUIRE_NONNULL(module.fd,
      "Generated isolate module stream has already been closed.", module.name);
  kj::FdOutputStream(fd.get()).write(data.begin(), data.size());
  module.received += data.size();
}

void GeneratedIsolatePackageUploadState::expectModuleSize(uint16_t index, uint64_t size) {
  KJ_REQUIRE(index < modules.size(), "Generated isolate module index is out of range.", index);
  auto& module = *modules[index];
  KJ_REQUIRE(module.opened && !module.done,
      "Generated isolate module size was declared outside its stream lifetime.", index);
  KJ_REQUIRE(size == module.size - module.received,
      "Generated isolate module stream size disagrees with BundleInfo.", module.name);
}

void GeneratedIsolatePackageUploadState::finishModule(uint16_t index) {
  KJ_REQUIRE(index < modules.size(), "Generated isolate module index is out of range.", index);
  auto& module = *modules[index];
  KJ_REQUIRE(module.opened && !module.done,
      "Generated isolate module stream done() was called more than once.", index);
  KJ_REQUIRE(module.received == module.size,
      "Generated isolate module ended before its declared size.", module.name,
      module.received, module.size);
  module.fd = nullptr;
  module.done = true;
}

void GeneratedIsolatePackageUploadState::finishTransfer() {
  KJ_REQUIRE(!transferFinished, "Generated isolate bundle finish() was called more than once.");
  for (auto& module: modules) {
    KJ_REQUIRE(module->done,
        "Generated isolate bundle finished before every module completed.", module->name);
  }
  transferFinished = true;
}

GeneratedIsolatePackage GeneratedIsolatePackageUploadState::save() {
  KJ_REQUIRE(transferFinished, "Generated isolate upload save() called before finish().");
  KJ_REQUIRE(!saveCalled, "Generated isolate upload save() called more than once.");
  saveCalled = true;

  Sha256 sourceHashBuilder;
  sourceHashBuilder.add("sandstorm-generated-isolate-source-v1");
  sourceHashBuilder.add(mainModule);
  sourceHashBuilder.add(compatibilityDate);
  for (auto inputIndex: order) {
    auto& module = *modules[inputIndex];
    sourceHashBuilder.add(module.name);
    byte type;
    switch (module.type) {
      case ModuleType::ES_MODULE:
        type = static_cast<byte>(IsolateWorkerSource::Module::ES_MODULE);
        break;
      case ModuleType::TEXT:
        type = static_cast<byte>(IsolateWorkerSource::Module::TEXT);
        break;
      case ModuleType::JSON:
        type = static_cast<byte>(IsolateWorkerSource::Module::JSON);
        break;
    }
    sourceHashBuilder.add(kj::arrayPtr(&type, 1));
    auto fd = raiiOpen(kj::str(tempPath, "/modules/", module.outputIndex),
        O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    struct stat stats;
    KJ_SYSCALL(fstat(fd.get(), &stats), module.name);
    KJ_REQUIRE(S_ISREG(stats.st_mode) && stats.st_size >= 0 &&
                   static_cast<uint64_t>(stats.st_size) == module.size,
        "Generated isolate module file changed during upload.", module.name);
    addFileToHash(sourceHashBuilder, fd.get(), module.size);
  }
  auto sourceHash = sourceHashBuilder.finish();
  auto appId = resolveAppId(requestedAppId, sourceHash);

  capnp::MallocMessageBuilder message;
  auto manifest = message.initRoot<spk::Manifest>();
  manifest.initAppTitle().setDefaultText(appTitle);
  manifest.setAppVersion(appVersion);
  manifest.initAppMarketingVersion().setDefaultText(marketingVersion);
  manifest.initMetadata().initShortDescription().setDefaultText(shortDescription);
  auto populateCommand = [&](spk::Manifest::Command::Builder command) {
    auto isolate = command.initIsolate();
    isolate.setMainModule(mainModule);
    isolate.setCompatibilityDate(compatibilityDate);
    isolate.initCompatibilityFlags(0);
    auto outputModules = isolate.initModules(order.size());
    for (auto outputIndex: kj::indices(order)) {
      auto& input = *modules[order[outputIndex]];
      auto output = outputModules[outputIndex];
      output.setName(input.name);
      auto path = kj::str("modules/", outputIndex);
      switch (input.type) {
        case ModuleType::ES_MODULE: output.setEsModulePath(path); break;
        case ModuleType::TEXT: output.setTextPath(path); break;
        case ModuleType::JSON: output.setJsonPath(path); break;
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
  };
  auto actions = manifest.initActions(1);
  actions[0].getInput().setNone();
  actions[0].initNounPhrase().setDefaultText(nounPhrase);
  populateCommand(actions[0].initCommand());
  populateCommand(manifest.initContinueCommand());

  auto manifestWords = capnp::messageToFlatArray(message);
  GeneratedIsolatePackage result = {
    packageIdFor(appId, manifestWords.asPtr(), sourceHash),
    kj::mv(appId),
    kj::mv(manifestWords),
  };
  writeFile(kj::str(tempPath, "/sandstorm-manifest"), result.manifest.asBytes());
  commitGeneratedPackage(appRoot, tempPath, result);
  installed = true;
  return result;
}

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
  bool commitStarted = false;
  KJ_DEFER(if (!commitStarted && access(tempPath.cStr(), F_OK) == 0) {
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

  commitStarted = true;
  commitGeneratedPackage(appRoot, tempPath, result);
  return result;
}

GeneratedIsolatePackage deriveGeneratedIsolatePackage(kj::StringPtr appRoot,
                                                      kj::StringPtr tempRoot,
                                                      kj::StringPtr sourcePackageId,
                                                      kj::StringPtr requestedAppId,
                                                      GeneratedIsolateMetadata metadata) {
  verifyDirectory(appRoot);
  verifyDirectory(tempRoot);
  validateMetadata(metadata);
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
  auto mainModule = isolate.getMainModule();
  KJ_REQUIRE(isValidModuleName(mainModule),
      "Generated isolate source package has an invalid main module name.");
  KJ_REQUIRE(isValidCompatibilityDate(isolate.getCompatibilityDate()),
      "Generated isolate source package has an invalid compatibility date.");
  KJ_REQUIRE(isolate.getCompatibilityFlags().size() == 0,
      "Generated isolate source package has unsupported compatibility flags.");

  auto inputModules = isolate.getModules();
  KJ_REQUIRE(inputModules.size() > 0 && inputModules.size() <= MAX_GENERATED_MODULES,
      "Generated isolate source package has an invalid module count.");
  std::set<std::string> names;
  std::vector<std::string> modulePaths;
  Sha256 sourceHashBuilder;
  sourceHashBuilder.add("sandstorm-generated-isolate-source-v1");
  sourceHashBuilder.add(mainModule);
  sourceHashBuilder.add(isolate.getCompatibilityDate());
  bool foundMain = false;
  for (auto i: kj::indices(inputModules)) {
    auto input = inputModules[i];
    auto name = input.getName();
    KJ_REQUIRE(isValidModuleName(name),
        "Generated isolate source package has an invalid module name.", name);
    KJ_REQUIRE(names.insert(std::string(name.begin(), name.size())).second,
        "Generated isolate source package has a duplicate module name.", name);
    if (i > 0) {
      auto previous = inputModules[i - 1].getName();
      KJ_REQUIRE(std::lexicographical_compare(
          previous.begin(), previous.end(), name.begin(), name.end()),
          "Generated isolate source package modules are not canonically ordered.");
    }

    kj::StringPtr relativePath;
    byte type;
    switch (input.which()) {
      case spk::Manifest::IsolateConfig::Module::ES_MODULE_PATH:
        relativePath = input.getEsModulePath();
        type = static_cast<byte>(IsolateWorkerSource::Module::ES_MODULE);
        break;
      case spk::Manifest::IsolateConfig::Module::TEXT_PATH:
        relativePath = input.getTextPath();
        type = static_cast<byte>(IsolateWorkerSource::Module::TEXT);
        break;
      case spk::Manifest::IsolateConfig::Module::JSON_PATH:
        relativePath = input.getJsonPath();
        type = static_cast<byte>(IsolateWorkerSource::Module::JSON);
        break;
      case spk::Manifest::IsolateConfig::Module::COMMON_JS_MODULE_PATH:
      case spk::Manifest::IsolateConfig::Module::DATA_PATH:
      case spk::Manifest::IsolateConfig::Module::WASM_PATH:
        KJ_FAIL_REQUIRE("Generated isolate source package has an unsupported module type.");
    }

    auto expectedPath = kj::str("modules/", i);
    KJ_REQUIRE(relativePath == expectedPath && isCanonicalPackagePath(relativePath),
        "Generated isolate source package has an invalid module path.", relativePath);
    auto moduleFd = raiiOpen(
        kj::str(packagePath, "/", relativePath), O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    struct stat stats;
    KJ_SYSCALL(fstat(moduleFd.get(), &stats), relativePath);
    KJ_REQUIRE(S_ISREG(stats.st_mode) && stats.st_size >= 0 &&
                   static_cast<uint64_t>(stats.st_size) <= MAX_GENERATED_MODULE_BYTES,
        "Generated isolate source package has an invalid module file.", relativePath);
    sourceHashBuilder.add(name);
    sourceHashBuilder.add(kj::arrayPtr(&type, 1));
    addFileToHash(sourceHashBuilder, moduleFd.get(), stats.st_size);
    modulePaths.emplace_back(relativePath.begin(), relativePath.size());
    if (name == mainModule) {
      KJ_REQUIRE(input.which() == spk::Manifest::IsolateConfig::Module::ES_MODULE_PATH,
          "Generated isolate source package main module is not an ES module.");
      foundMain = true;
    }
  }
  KJ_REQUIRE(foundMain, "Generated isolate source package main module is missing.");

  auto sourceHash = sourceHashBuilder.finish();
  auto appId = resolveAppId(requestedAppId, sourceHash);
  capnp::MallocMessageBuilder publishedMessage;
  auto publishedManifest = publishedMessage.initRoot<spk::Manifest>();
  publishedManifest.initAppTitle().setDefaultText(metadata.appTitle);
  publishedManifest.setAppVersion(metadata.appVersion);
  publishedManifest.initAppMarketingVersion().setDefaultText(metadata.marketingVersion);
  publishedManifest.initMetadata().initShortDescription().setDefaultText(metadata.shortDescription);
  auto publishedActions = publishedManifest.initActions(1);
  auto publishedAction = publishedActions[0];
  publishedAction.getInput().setNone();
  publishedAction.initNounPhrase().setDefaultText(metadata.nounPhrase);
  populateIsolateCommandFromInstalled(
      publishedAction.initCommand(), isolate, metadata.appTitle);
  populateIsolateCommandFromInstalled(
      publishedManifest.initContinueCommand(), isolate, metadata.appTitle);
  auto manifestWords = capnp::messageToFlatArray(publishedMessage);
  GeneratedIsolatePackage result = {
    packageIdFor(appId, manifestWords.asPtr(), sourceHash),
    kj::mv(appId),
    kj::mv(manifestWords),
  };

  auto finalPath = kj::str(appRoot, "/", result.packageId);
  if (access(finalPath.cStr(), F_OK) == 0) {
    verifyInstalledAppId(kj::str(finalPath, ".appid"), result.appId);
    return result;
  }

  static uint counter = 0;
  auto tempPath =
      kj::str(tempRoot, "/derived-isolate.", getpid(), ".", time(nullptr), ".", counter++);
  KJ_SYSCALL(mkdir(tempPath.cStr(), 0700), tempPath);
  bool commitStarted = false;
  KJ_DEFER(if (!commitStarted && access(tempPath.cStr(), F_OK) == 0) {
    kj::runCatchingExceptions([&]() { recursivelyDelete(tempPath); });
  });
  auto modulesPath = kj::str(tempPath, "/modules");
  KJ_SYSCALL(mkdir(modulesPath.cStr(), 0700), modulesPath);
  writeFile(kj::str(tempPath, "/sandstorm-manifest"), result.manifest.asBytes());
  for (auto i: kj::indices(modulePaths)) {
    auto sourcePath = kj::str(packagePath, "/", modulePaths[i]);
    auto destinationPath = kj::str(tempPath, "/", modulePaths[i]);
    KJ_SYSCALL(link(sourcePath.cStr(), destinationPath.cStr()), sourcePath, destinationPath);
  }

  commitStarted = true;
  commitGeneratedPackage(appRoot, tempPath, result);
  return result;
}

}  // namespace sandstorm
