// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
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

// This is a tool for manipulating Sandstorm .spk files.

#include "spk.h"
#include <kj/debug.h>
#include <kj/io.h>
#include <kj/encoding.h>
#include <capnp/serialize.h>
#include <capnp/serialize-packed.h>
#include <capnp/compat/json.h>
#include <sodium/crypto_sign.h>
#include <sodium/crypto_hash_sha256.h>
#include <sodium/crypto_hash_sha512.h>
#include <unistd.h>
#include <fcntl.h>
#include <stdio.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <sys/mman.h>
#include <errno.h>
#include <sandstorm/package.capnp.h>
#include <sandstorm/powerbox.capnp.h>
#include <sandstorm/appid-replacements.capnp.h>
#include <sandstorm/isolate/api.js.h>
#include <sandstorm/isolate/capnp-es.js.h>
#include <sandstorm/isolate/capnp.js.h>
#include <sandstorm/isolate/native-capnp-bridge.js.h>
#include <stdlib.h>
#include <dirent.h>
#include <set>
#include <map>
#include <vector>
#include <string>
#include <sys/xattr.h>
#include <capnp/schema-parser.h>
#include <capnp/dynamic.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <kj/async-unix.h>
#include <ctype.h>
#include <time.h>
#include <poll.h>
#include <inttypes.h>
#include <sandstorm/app-index/submit.capnp.h>
#include <sodium/crypto_generichash_blake2b.h>

#include "version.h"
#include "fuse.h"
#include "union-fs.h"
#include "send-fd.h"
#include "util.h"
#include "id-to-text.h"
#include "appid-replacements.h"
#include "config.h"

namespace sandstorm {

typedef kj::byte byte;

static const uint64_t APP_SIZE_LIMIT = 1ull << 30;
// For now, we will refuse to unpack an app over 1 GB (decompressed size).

static const uint32_t MAX_DEFINED_APIVERSION = 0;
// The maximum API version that has been defined, as of this source code's compilation.  We should
// outright refuse to pack an app claiming compatibility with a newer API version than this, because
// we can't possibly know what the constraints are on that API.

// =======================================================================================
// JSON handlers for very large data or text blobs, which we don't want to print along with
// `spk verify`. Also base64's data blobs (if they are small enough).

class OversizeDataHandler: public capnp::JsonCodec::Handler<capnp::Data> {
public:
  void encode(const capnp::JsonCodec& codec, capnp::Data::Reader input,
              capnp::JsonValue::Builder output) const override {
    if (input.size() > 256) {
      auto call = output.initCall();
      call.setFunction("LargeDataBlob");
      call.initParams(1)[0].setNumber(input.size());
    } else {
      auto call = output.initCall();
      call.setFunction("Base64");
      call.initParams(1)[0].setString(kj::encodeBase64(input, false));
    }
  }

  capnp::Orphan<capnp::Data> decode(
      const capnp::JsonCodec& codec, capnp::JsonValue::Reader input,
      capnp::Orphanage orphanage) const override {
    KJ_UNIMPLEMENTED("OversizeDataHandler::decode");
  }
};

class OversizeTextHandler: public capnp::JsonCodec::Handler<capnp::Text> {
public:
  void encode(const capnp::JsonCodec& codec, capnp::Text::Reader input,
              capnp::JsonValue::Builder output) const override {
    if (input.size() > 256) {
      auto call = output.initCall();
      call.setFunction("LargeTextBlob");
      call.initParams(1)[0].setNumber(input.size());
    } else {
      output.setString(input);
    }
  }

  capnp::Orphan<capnp::Text> decode(
      const capnp::JsonCodec& codec, capnp::JsonValue::Reader input,
      capnp::Orphanage orphanage) const override {
    KJ_UNIMPLEMENTED("OversizeTextHandler::decode");
  }
};

// =======================================================================================

class ReplacementFile {
  // Encapsulates writing a file to a temporary location and then using it to atomically
  // replace some existing file.

public:
  explicit ReplacementFile(kj::StringPtr name): name(name) {
    int fd_;
    replacementName = kj::str(name, ".XXXXXX");
    KJ_SYSCALL(fd_ = mkstemp(replacementName.begin()));
    fd = kj::AutoCloseFd(fd_);
  }
  ~ReplacementFile() {
    if (!committed) {
      // We never wrote the file. Attempt to clean up, but don't complain if this goes wrong
      // because we are probably in an exception unwind already.
      unlink(replacementName.cStr());
    }
  }

  KJ_DISALLOW_COPY(ReplacementFile);

  inline int getFd() { return fd; }

  void commit() {
    fd = nullptr;
    KJ_SYSCALL(rename(replacementName.cStr(), name.cStr()));
    committed = true;
  }

private:
  kj::StringPtr name;
  kj::AutoCloseFd fd;
  kj::String replacementName;
  bool committed = false;
};

class SpkTool final: public AbstractMain {
  // Main class for the Sandstorm spk tool.

public:
  SpkTool(kj::ProcessContext& context): context(context) {
    char buf[PATH_MAX + 1];
    ssize_t n;
    KJ_SYSCALL(n = readlink("/proc/self/exe", buf, sizeof(buf)));
    buf[n] = '\0';
    exePath = kj::heapString(buf, n);
    if (exePath.endsWith("/sandstorm")) {
      installHome = kj::heapString(buf, n - strlen("/sandstorm"));
    } else if (exePath.endsWith("/bin/spk")) {
      installHome = kj::heapString(buf, n - strlen("/bin/spk"));
    }
  }

  kj::MainFunc getMain() override {
    return addCommonOptions(OptionSet::ALL,
        kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
          "Tool for building and checking Sandstorm package files.",
          "Sandstorm packages are compressed archives cryptographically signed in order to prove "
          "that upgrades came from the same source. This tool will help you create and sign "
          "packages. This tool can also let you run an app in development mode on a local "
          "Sandstorm instance, without actually building a package, and can automatically "
          "determine your app's dependencies.\n"
          "\n"
          "This tool should be run inside your app's source directory. It expects to find a file "
          "in the current directory called `sandstorm-pkgdef.capnp` which should define a "
          "constant named `pkgdef` of type `PackageDefinition` as defined in "
          "`/sandstorm/package.capnp`. You can usually find `package.capnp` in your Sandstorm "
          "installation, e.g.:\n"
          "  /opt/sandstorm/latest/usr/include/sandstorm/package.capnp\n"
          "The file contains comments describing the package definition format, which is based "
          "on Cap'n Proto (https://capnproto.org). You can also use the `init` command to "
          "generate a sample definition file in the current directory.\n"
          "\n"
          "App signing keys are not stored in your source directory; they are instead placed "
          "on a keyring, currently stored at `~/.sandstorm-keyring`. It is important that you "
          "protect this file. If you lose it, you won't be able to update your app. If someone "
          "else steals it, they will be able to publish updates to your app. Keep a backup! "
          "(In the future, we plan to add features to better protect your keyring.)\n"
          "\n"
          "Note that you may combine two keyring files by simply concatenating them.")
        .addSubCommand("keygen", KJ_BIND_METHOD(*this, getKeygenMain),
                       "Generate a new app ID and private key.")
        .addSubCommand("listkeys", KJ_BIND_METHOD(*this, getListkeysMain),
                       "List all keys on your keyring.")
        .addSubCommand("getkey", KJ_BIND_METHOD(*this, getGetkeyMain),
                       "Get a single key from your keyring, e.g. to send to someone.")
        .addSubCommand("init", KJ_BIND_METHOD(*this, getInitMain),
                       "Create a sample package definition for a new app.")
        .addSubCommand("pack", KJ_BIND_METHOD(*this, getPackMain),
                       "Create an spk from a directory tree and a signing key.")
        .addSubCommand("unpack", KJ_BIND_METHOD(*this, getUnpackMain),
                       "Unpack an spk to a directory, verifying its signature.")
        .addSubCommand("verify", KJ_BIND_METHOD(*this, getVerifyMain),
                       "Verify signature on an spk and output the app ID (without unpacking).")
        .addSubCommand("dev", KJ_BIND_METHOD(*this, getDevMain),
                       "Run an app in dev mode.")
        .addSubCommand("dev-isolate", KJ_BIND_METHOD(*this, getDevIsolateMain),
                       "Run a JavaScript module as an isolate app in dev mode.")
        .addSubCommand("capnp-abi", KJ_BIND_METHOD(*this, getCapnpAbiMain),
                       "Dump public Cap'n Proto interface ABI metadata as JSON.")
        .addSubCommand("powerbox-descriptor", KJ_BIND_METHOD(*this, getPowerboxDescriptorMain),
                       "Generate a packed PowerboxDescriptor for a Cap'n Proto interface.")
        .addSubCommand("publish", KJ_BIND_METHOD(*this, getPublishMain),
                       "Publish a package to the app market."))
        .build();
  }

private:
  kj::ProcessContext& context;
  kj::String exePath;
  kj::Maybe<kj::String> installHome;

  // Used to parse package def.
  capnp::SchemaParser parser;
  kj::Vector<kj::String> importPath;
  spk::PackageDefinition::Reader packageDef;
  kj::String sourceDir;
  bool sawPkgDef = false;
  kj::Maybe<kj::Array<capnp::word>> packManifestOverride;

  enum class PowerboxDescriptorOutputFormat {
    BASE64URL,
    CAPNP,
    JSON,
  };
  PowerboxDescriptorOutputFormat powerboxDescriptorOutputFormat =
      PowerboxDescriptorOutputFormat::BASE64URL;
  kj::String capnpAbiInterfaceFilter = nullptr;
  kj::String capnpAbiBaselinePath = nullptr;

  kj::StringPtr keyringPath = nullptr;
  bool quiet = false;

  kj::Maybe<kj::Own<MemoryMapping>> keyringMapping;
  std::map<kj::String, kj::Own<capnp::FlatArrayMessageReader>> keyMap;

  enum class OptionSet {
    ALL, ALL_READONLY, KEYS, KEYS_READONLY
  };

  kj::MainBuilder& addCommonOptions(OptionSet options, kj::MainBuilder& builder) {
    if (options == OptionSet::ALL || options == OptionSet::ALL_READONLY) {
      builder.addOptionWithArg({'I', "import-path"}, KJ_BIND_METHOD(*this, addImportPath), "<path>",
              "Additionally search for Cap'n Proto schemas in <path>. (This allows your package "
              "definition file to import files from that directory -- this is rarely useful.)")
          .addOptionWithArg({'p', "pkg-def"}, KJ_BIND_METHOD(*this, setPackageDef),
                            "<def-file>:<name>",
              "Don't read the package definition from ./sandstorm-pkgdef.capnp. Instead, read "
              "from <def-file>, and expect the constant to be named <name>.");
    }
    builder.addOptionWithArg({'k', "keyring"}, KJ_BIND_METHOD(*this, setKeyringPath), "<path>",
            "Use <path> as the keyring file, rather than $HOME/.sandstorm-keyring.");
    if (options != OptionSet::KEYS_READONLY && options != OptionSet::ALL_READONLY) {
      builder.addOption({'q', "quiet"}, KJ_BIND_METHOD(*this, setQuiet),
              "Don't write the keyring warning to stderr.");
    }
    return builder;
  }

  kj::MainBuilder::Validity setPackageDef(kj::StringPtr arg) {
    KJ_IF_MAYBE(colonPos, arg.findFirst(':')) {
      auto filename = kj::heapString(arg.slice(0, *colonPos));
      auto constantName = arg.slice(*colonPos + 1);

      if (access(filename.cStr(), F_OK) != 0) {
        return "not found";
      }

      KJ_IF_MAYBE(slashPos, filename.findLast('/')) {
        sourceDir = kj::heapString(filename.slice(0, *slashPos));
      } else {
        sourceDir = nullptr;
      }

      KJ_IF_MAYBE(i, installHome) {
        if (*i != "/usr/local" && *i != "/usr") {
          auto candidate = kj::str(*i, "/usr/include");
          if (access(candidate.cStr(), F_OK) == 0) {
            importPath.add(kj::mv(candidate));
          }
        }
      }

      importPath.add(kj::heapString("/usr/local/include"));
      importPath.add(kj::heapString("/usr/include"));

      auto importPathPtrs = KJ_MAP(p, importPath) -> kj::StringPtr { return p; };

      parser.loadCompiledTypeAndDependencies<spk::PackageDefinition>();

      auto schema = parser.parseDiskFile(filename, filename, importPathPtrs);
      KJ_IF_MAYBE(symbol, schema.findNested(constantName)) {
        if (!symbol->getProto().isConst()) {
          return kj::str("\"", constantName, "\" is not a constant");
        }

        packageDef = symbol->asConst().as<spk::PackageDefinition>();
        sawPkgDef = true;

        auto manifest = packageDef.getManifest();
        if (!manifest.hasAppTitle()) {
          return kj::str("missing `appTitle`\n"
                         "Under ", constantName, ".manifest, add something like ",
                         "`appTitle = (defaultText = \"My App\")`.");
        }

        if (!manifest.hasAppMarketingVersion()) {
          return kj::str("missing `appMarketingVersion`\n"
                         "Under ", constantName, ".manifest, add something like ",
                         "`appMarketingVersion = (defaultText = \"0.0.0\")`.");
        }

        if (manifest.getMinApiVersion() > MAX_DEFINED_APIVERSION) {
          return kj::str("The minimum API version this app claims it can run on is ",
                         manifest.getMinApiVersion(), ", but the maximum API version "
                         "known to this version of spk is ", MAX_DEFINED_APIVERSION, ".\n"
                         "Please upgrade sandstorm to the latest version to pack this app.");
        }

        if (manifest.getMaxApiVersion() > MAX_DEFINED_APIVERSION) {
          return kj::str("The maximum API version this app claims it can run on is ",
                         manifest.getMaxApiVersion(), ", but the maximum API version known "
                         "to this version of spk is ", MAX_DEFINED_APIVERSION, ".\n"
                         "Please upgrade sandstorm to the latest version.");
        }

        if (manifest.getMinApiVersion() > manifest.getMaxApiVersion()) {
          return kj::str("Your manifest specifies a maxApiVersion of ", manifest.getMaxApiVersion(),
                         " which is less than its minApiVersion of ", manifest.getMinApiVersion(),
                         ".\nPlease correct this.");
        }

        if (manifest.totalSize().wordCount > spk::Manifest::SIZE_LIMIT_IN_WORDS) {
          return kj::str(
              "Your app metadata is too large. Metadata must be less than 8MB in total -- "
              "including icons, screenshots, licenses, etc. -- and should be much smaller than "
              "that in order to ensure an acceptable experience for users browsing the app store "
              "on slow connections.");
        }

        return true;
      } else {
        return kj::str("\"", constantName, "\" not defined in schema file");
      }
    } else {
      return "argument missing constant name";
    }
  }

  void ensurePackageDefParsed() {
    if (!sawPkgDef) {
      auto valid = setPackageDef("sandstorm-pkgdef.capnp:pkgdef");
      KJ_IF_MAYBE(e, valid.getError()) {
        context.exitError(kj::str("sandstorm-pkgdef.capnp: ", *e));
      }
    }
  }

  void printAppId(kj::StringPtr appId) {
    kj::String msg = kj::str(appId, "\n");
    kj::FdOutputStream out(STDOUT_FILENO);
    out.write(msg.begin(), msg.size());
  }

  void printAppId(kj::ArrayPtr<const byte> publicKey) {
    static_assert(crypto_sign_PUBLICKEYBYTES == 32, "Signing algorithm changed?");
    KJ_REQUIRE(publicKey.size() == crypto_sign_PUBLICKEYBYTES);

    printAppId(appIdString(publicKey));
  }

  kj::MainBuilder::Validity setKeyringPath(kj::StringPtr arg) {
    if (access(arg.cStr(), F_OK) != 0) {
      return "not found";
    }
    keyringPath = arg;
    return true;
  }

  kj::MainBuilder::Validity setQuiet() {
    quiet = true;
    return true;
  }

  kj::AutoCloseFd openKeyring(int flags) {
    kj::StringPtr filename;
    kj::String ownFilename;
    if (keyringPath == nullptr) {
      const char* home = getenv("HOME");
      KJ_REQUIRE(home != nullptr, "$HOME is not set!");
      ownFilename = kj::str(home, "/.sandstorm-keyring");
      filename = ownFilename;
    } else {
      filename = keyringPath;
    }
    if (!quiet && (flags & O_ACCMODE) != O_RDONLY) {
      context.warning(kj::str(
          "** WARNING: Keys are being added to:\n",
          "**   ", filename, "\n"
          "** Please make a backup of this file and keep it safe. If you lose your keys,\n"
          "** you won't be able to update your app. If someone steals your keys, they\n"
          "** will be able to post updates for your app. (Use -q to quiet this warning.)"));
    }
    return raiiOpen(filename, flags, 0600);
  }

  spk::KeyFile::Reader lookupKey(kj::StringPtr appid, bool withReplacements = true) {
    // We actually want to sign packages using the current replacement key for the app ID.
    byte appidBytes[APP_ID_BYTE_SIZE];
    KJ_REQUIRE(tryParseAppId(appid, appidBytes), "invalid appid", appid);
    auto replacement = appIdString(getPublicKeyForApp(appidBytes));
    if (withReplacements) {
      appid = replacement;
    } else {
      if (appid != replacement) {
        KJ_LOG(WARNING, "the requested key is obsolete", appid, replacement);
      }
    }

    if (keyringMapping == nullptr) {
      auto mapping = kj::heap<MemoryMapping>(openKeyring(O_RDONLY), "(keyring)");
      kj::ArrayPtr<const capnp::word> words = *mapping;
      keyringMapping = kj::mv(mapping);

      while (words.size() > 0) {
        auto reader = kj::heap<capnp::FlatArrayMessageReader>(words);
        auto key = reader->getRoot<spk::KeyFile>();
        words = kj::arrayPtr(reader->getEnd(), words.end());
        keyMap.insert(std::make_pair(appIdString(key.getPublicKey()), kj::mv(reader)));
      }
    }

    auto iter = keyMap.find(kj::str(appid));
    if (iter == keyMap.end()) {
      context.exitError(kj::str(appid, ": key not found in keyring"));
    } else {
      auto key = iter->second->getRoot<spk::KeyFile>();
      KJ_REQUIRE(key.getPublicKey().size() == crypto_sign_PUBLICKEYBYTES &&
                 key.getPrivateKey().size() == crypto_sign_SECRETKEYBYTES,
                 "Invalid key in keyring.");
      return key;
    }
  }

  // =====================================================================================

  kj::MainFunc getKeygenMain() {
    return addCommonOptions(OptionSet::KEYS,
        kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
            "Create a new app ID and signing key and store it to your keyring. It will then be "
            "used by the `pack` command to sign your app package. Note that when starting a new "
            "app, it's better to use `spk init`. Only use `keygen` when you need to replace the "
            "key on an existing app, e.g. because you're forking it. See `spk help` for more "
            "info about keyrings.")
        .callAfterParsing(KJ_BIND_METHOD(*this, doKeygen)))
        .build();
  }

  kj::String generateKey() {
    capnp::MallocMessageBuilder message(32);
    spk::KeyFile::Builder builder = message.getRoot<spk::KeyFile>();

    int result = crypto_sign_keypair(
        builder.initPublicKey(crypto_sign_PUBLICKEYBYTES).begin(),
        builder.initPrivateKey(crypto_sign_SECRETKEYBYTES).begin());
    KJ_ASSERT(result == 0, "crypto_sign_keypair failed", result);

    capnp::writeMessageToFd(openKeyring(O_WRONLY | O_APPEND | O_CREAT), message);

    return appIdString(builder.getPublicKey());
  }

  kj::MainBuilder::Validity doKeygen() {
    printAppId(generateKey());

    return true;
  }

  kj::MainFunc getListkeysMain() {
    return addCommonOptions(OptionSet::KEYS_READONLY,
        kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
            "List the app IDs corresponding to each key on your keyring.")
        .callAfterParsing(KJ_BIND_METHOD(*this, doListkeys)))
        .build();
  }

  kj::MainBuilder::Validity doListkeys() {
    MemoryMapping mapping(openKeyring(O_RDONLY), "(keyring)");

    kj::ArrayPtr<const capnp::word> words = mapping;

    while (words.size() > 0) {
      capnp::FlatArrayMessageReader reader(words);
      printAppId(reader.getRoot<spk::KeyFile>().getPublicKey());
      words = kj::arrayPtr(reader.getEnd(), words.end());
    }

    return true;
  }

  kj::MainFunc getGetkeyMain() {
    return addCommonOptions(OptionSet::KEYS_READONLY,
        kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
            "Get the the keys with the given app IDs from your keyring and write them as "
            "Cap'n Proto message to stdout. The output is a valid keyring containing only the "
            "IDs requested. Note that keyrings can be combined via concatenation, so someone "
            "else can add these keys to their own keyring using a command like:\n"
            "    cat keys >> ~/.sandstorm-keyring")
        .expectOneOrMoreArgs("<appid>", KJ_BIND_METHOD(*this, getKey)))
        .build();
  }

  kj::MainBuilder::Validity getKey(kj::StringPtr appid) {
    if (isatty(STDOUT_FILENO)) {
      return "The output is binary. You want to redirect it to a file. Pipe through cat if you "
             "really intended to write it to your terminal. :)";
    }

    auto key = lookupKey(appid, false);  // Don't get a replacement; get the original.
    capnp::MallocMessageBuilder builder(key.totalSize().wordCount + 4);
    builder.setRoot(key);
    capnp::writeMessageToFd(STDOUT_FILENO, builder);

    return true;
  }

  // =====================================================================================

  kj::MainFunc getInitMain() {
    return addCommonOptions(OptionSet::KEYS,
        kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
            "Initialize the current directory as a Sandstorm package source directory by "
            "writing a `sandstorm-pkgdef.capnp` with a newly-created app ID. <command> "
            "specifies the command used to start your app.")
        .addOptionWithArg({'o', "output"}, KJ_BIND_METHOD(*this, setOutputFile), "<filename>",
            "Write to <filename> instead of `sandstorm-pkgdef.capnp`. Use `-o -` to write to "
            "standard output.")
        .addOptionWithArg({'i', "app-id"}, KJ_BIND_METHOD(*this, setAppIdForInit), "<app-id>",
            "Use <app-id> as the application ID rather than generate a new one.")
        .addOptionWithArg({'p', "port"}, KJ_BIND_METHOD(*this, setPortForInit), "<port>",
            "Set the HTTP port on which your server runs -- that is, the port which <command> "
            "will bind to. Your app will be set up to use Sandstorm's HTTP bridge instead of "
            "using the raw Sandstorm APIs.")
        .addOptionWithArg({'I', "source-path"}, KJ_BIND_METHOD(*this, addSourcePathForInit), "<path>",
            "Add <path> to the path from which files are pulled into the binary. You may "
            "specify this multiple times to set up a search path. If no paths are given, the "
            "default is to seach '.' (current directory) followed by '/' (root), with some "
            "sensitive directories hidden from '/'.")
        .addOption({'A', "include-all"}, KJ_BIND_METHOD(*this, setIncludeAllForInit),
            "Arrange to include all contents of the directories specified with -I rather than "
            "determine needed files dynamically while running in dev mode.")
        .addOption({'r', "raw"}, KJ_BIND_METHOD(*this, setUsesRawApi),
            "Specifies that your app directly implements the raw Sandstorm API and does "
            "not require the HTTP bridge.")
        .expectOneOrMoreArgs("-- <command>", KJ_BIND_METHOD(*this, addCommandArg))
        .callAfterParsing(KJ_BIND_METHOD(*this, doInit)))
        .build();
  }

  kj::StringPtr outputFile = nullptr;
  kj::StringPtr appIdForInit = nullptr;
  kj::Vector<kj::StringPtr> commandArgs;
  kj::Vector<kj::StringPtr> sourcePathForInit;
  uint16_t httpPort = 0;
  bool usesRawApi = false;
  bool includeAllForInit = false;

  kj::MainBuilder::Validity setOutputFile(kj::StringPtr arg) {
    outputFile = arg;
    return true;
  }

  kj::MainBuilder::Validity setAppIdForInit(kj::StringPtr arg) {
    for (char c: arg) {
      if (!isalnum(c)) {
        return "invalid app ID";
      }
    }
    appIdForInit = arg;
    return true;
  }

  kj::MainBuilder::Validity setPortForInit(kj::StringPtr arg) {
    if (usesRawApi) {
      return "You can't specify both -p and -r.";
    }
    KJ_IF_MAYBE(i, parseUInt(arg, 10)) {
      if (*i < 1 || *i > 65535) {
        return "port out-of-range";
      } else if (*i < 1024) {
        return "Ports under 1024 are priveleged and cannot be used by a Sandstorm app.";
      }
      httpPort = *i;
      return true;
    } else {
      return "invalid port";
    }
  }

  kj::MainBuilder::Validity addSourcePathForInit(kj::StringPtr arg) {
    sourcePathForInit.add(arg);
    return true;
  }

  kj::MainBuilder::Validity setIncludeAllForInit() {
    includeAllForInit = true;
    return true;
  }

  kj::MainBuilder::Validity setUsesRawApi() {
    if (httpPort != 0) {
      return "You can't specify both -p and -r.";
    }
    usesRawApi = true;
    return true;
  }

  kj::MainBuilder::Validity addCommandArg(kj::StringPtr arg) {
    commandArgs.add(arg);
    return true;
  }

  uint64_t generateCapnpId() {
    uint64_t result;

    int fd;
    KJ_SYSCALL(fd = open("/dev/urandom", O_RDONLY));

    ssize_t n;
    KJ_SYSCALL(n = read(fd, &result, sizeof(result)), "/dev/urandom");
    KJ_ASSERT(n == sizeof(result), "Incomplete read from /dev/urandom.", n);

    return result | (1ull << 63);
  }

  kj::MainBuilder::Validity doInit() {
    if (httpPort == 0 && !usesRawApi) {
      return "You must specify at least one of -p or -r.";
    }

    kj::String searchPath;
    if (sourcePathForInit.size() == 0) {
      if (includeAllForInit) {
        return "When using -A you must specify at least one -I.";
      }

      searchPath = kj::str(
          "      ( sourcePath = \".\" ),  # Search this directory first.\n"
          "      ( sourcePath = \"/\",    # Then search the system root directory.\n"
          "        hidePaths = [ \"home\", \"proc\", \"sys\",\n"
          "                      \"etc/passwd\", \"etc/hosts\", \"etc/host.conf\",\n"
          "                      \"etc/nsswitch.conf\", \"etc/resolv.conf\" ]\n"
          "        # You probably don't want the app pulling files from these places,\n"
          "        # so we hide them. Note that /dev, /var, and /tmp are implicitly\n"
          "        # hidden because Sandstorm itself provides them.\n"
          "      )\n");
    } else {
      searchPath = kj::str(
          "      ( sourcePath = \"",
          kj::strArray(sourcePathForInit, "\" ),\n      ( sourcePath = \""),
          "\" )\n"
          );
    }

    if (outputFile == nullptr) {
      outputFile = "sandstorm-pkgdef.capnp";
      if (access(outputFile.cStr(), F_OK) == 0) {
        return "`sandstorm-pkgdef.capnp` already exists";
      }
    }

    kj::String ownAppId;
    if (appIdForInit == nullptr) {
      ownAppId = generateKey();
      appIdForInit = ownAppId;
    }

    auto argv = kj::str("\"", kj::strArray(commandArgs, "\", \""), "\"");

    if (httpPort != 0) {
      argv = kj::str("\"/sandstorm-http-bridge\", \"", httpPort, "\", \"--\", ", kj::mv(argv));
    }

    kj::AutoCloseFd outFd;
    if (outputFile == "-") {
      int fd;
      KJ_SYSCALL(fd = dup(STDOUT_FILENO));
      outFd = kj::AutoCloseFd(fd);
    } else {
      outFd = raiiOpen(outputFile, O_WRONLY | O_TRUNC | O_CREAT);
    }

    kj::FdOutputStream out(kj::mv(outFd));

    auto content = kj::str(
        "@0x", kj::hex(generateCapnpId()), ";\n"
        "\n"
        "using Spk = import \"/sandstorm/package.capnp\";\n"
        "# This imports:\n"
        "#   $SANDSTORM_HOME/latest/usr/include/sandstorm/package.capnp\n"
        "# Check out that file to see the full, documented package definition format.\n"
        "\n"
        "const pkgdef :Spk.PackageDefinition = (\n"
        "  # The package definition. Note that the spk tool looks specifically for the\n"
        "  # \"pkgdef\" constant.\n"
        "\n"
        "  id = \"", appIdForInit, "\",\n"
        "  # Your app ID is actually its public key. The private key was placed in\n"
        "  # your keyring. All updates must be signed with the same key.\n"
        "\n"
        "  manifest = (\n"
        "    # This manifest is included in your app package to tell Sandstorm\n"
        "    # about your app.\n"
        "\n"
        "    appTitle = (defaultText = \"Example App\"),\n"
        "\n"
        "    appVersion = 0,  # Increment this for every release.\n"
        "\n"
        "    appMarketingVersion = (defaultText = \"0.0.0\"),\n"
        "    # Human-readable representation of appVersion. Should match the way you\n"
        "    # identify versions of your app in documentation and marketing.\n"
        "\n"
        "    actions = [\n"
        "      # Define your \"new document\" handlers here.\n"
        "      ( nounPhrase = (defaultText = \"instance\"),\n"
        "        command = .myCommand\n"
        "        # The command to run when starting for the first time. (\".myCommand\"\n"
        "        # is just a constant defined at the bottom of the file.)\n"
        "      )\n"
        "    ],\n"
        "\n"
        "    continueCommand = .myCommand,\n"
        "    # This is the command called to start your app back up after it has been\n"
        "    # shut down for inactivity. Here we're using the same command as for\n"
        "    # starting a new instance, but you could use different commands for each\n"
        "    # case.\n"
        "\n"
        "    metadata = (\n"
        "      # Data which is not needed specifically to execute the app, but is useful\n"
        "      # for purposes like marketing and display.  These fields are documented at\n"
        "      # https://docs.sandstorm.io/en/latest/developing/publishing-apps/#add-required-metadata\n"
        "      # and (in deeper detail) in the sandstorm source code, in the Metadata section of\n"
        "      # https://github.com/sandstorm-io/sandstorm/blob/master/src/sandstorm/package.capnp\n"
        "      icons = (\n"
        "        # Various icons to represent the app in various contexts.\n"
        "        #appGrid = (svg = embed \"path/to/appgrid-128x128.svg\"),\n"
        "        #grain = (svg = embed \"path/to/grain-24x24.svg\"),\n"
        "        #market = (svg = embed \"path/to/market-150x150.svg\"),\n"
        "        #marketBig = (svg = embed \"path/to/market-big-300x300.svg\"),\n"
        "      ),\n"
        "\n"
        "      website = \"http://example.com\",\n"
        "      # This should be the app's main website url.\n"
        "\n"
        "      codeUrl = \"http://example.com\",\n"
        "      # URL of the app's source code repository, e.g. a GitHub URL.\n"
        "      # Required if you specify a license requiring redistributing code, but optional otherwise.\n"
        "\n"
        "      license = (none = void),\n"
        "      # The license this package is distributed under.  See\n"
        "      # https://docs.sandstorm.io/en/latest/developing/publishing-apps/#license\n"
        "\n"
        "      categories = [],\n"
        "      # A list of categories/genres to which this app belongs, sorted with best fit first.\n"
        "      # See the list of categories at\n"
        "      # https://docs.sandstorm.io/en/latest/developing/publishing-apps/#categories\n"
        "\n"
        "      author = (\n"
        "        # Fields relating to the author of this app.\n"
        "\n"
        "        contactEmail = \"youremail@example.com\",\n"
        "        # Email address to contact for any issues with this app. This includes end-user support\n"
        "        # requests as well as app store administrator requests, so it is very important that this be a\n"
        "        # valid address with someone paying attention to it.\n"
        "\n"
        "        #pgpSignature = embed \"path/to/pgp-signature\",\n"
        "        # PGP signature attesting responsibility for the app ID. This is a binary-format detached\n"
        "        # signature of the following ASCII message (not including the quotes, no newlines, and\n"
        "        # replacing <app-id> with the standard base-32 text format of the app's ID):\n"
        "        #\n"
        "        # \"I am the author of the Sandstorm.io app with the following ID: <app-id>\"\n"
        "        #\n"
        "        # You can create a signature file using `gpg` like so:\n"
        "        #\n"
        "        #     echo -n \"I am the author of the Sandstorm.io app with the following ID: <app-id>\" | gpg --sign > pgp-signature\n"
        "        #\n"
        "        # Further details including how to set up GPG and how to use keybase.io can be found\n"
        "        # at https://docs.sandstorm.io/en/latest/developing/publishing-apps/#verify-your-identity\n"
        "\n"
        "        upstreamAuthor = \"Example App Team\",\n"
        "        # Name of the original primary author of this app, if it is different from the person who\n"
        "        # produced the Sandstorm package. Setting this implies that the author connected to the PGP\n"
        "        # signature only \"packaged\" the app for Sandstorm, rather than developing the app.\n"
        "        # Remove this line if you consider yourself as the author of the app.\n"
        "      ),\n"
        "\n"
        "      #pgpKeyring = embed \"path/to/pgp-keyring\",\n"
        "      # A keyring in GPG keyring format containing all public keys needed to verify PGP signatures in\n"
        "      # this manifest (as of this writing, there is only one: `author.pgpSignature`).\n"
        "      #\n"
        "      # To generate a keyring containing just your public key, do:\n"
        "      #\n"
        "      #     gpg --export <key-id> > keyring\n"
        "      #\n"
        "      # Where `<key-id>` is a PGP key ID or email address associated with the key.\n"
        "\n"
        "      #description = (defaultText = embed \"path/to/description.md\"),\n"
        "      # The app's description in Github-flavored Markdown format, to be displayed e.g.\n"
        "      # in an app store. Note that the Markdown is not permitted to contain HTML nor image tags (but\n"
        "      # you can include a list of screenshots separately).\n"
        "\n"
        "      shortDescription = (defaultText = \"one-to-three words\"),\n"
        "      # A very short (one-to-three words) description of what the app does. For example,\n"
        "      # \"Document editor\", or \"Notetaking\", or \"Email client\". This will be displayed under the app\n"
        "      # title in the grid view in the app market.\n"
        "\n"
        "      screenshots = [\n"
        "        # Screenshots to use for marketing purposes.  Examples below.\n"
        "        # Sizes are given in device-independent pixels, so if you took these\n"
        "        # screenshots on a Retina-style high DPI screen, divide each dimension by two.\n"
        "\n"
        "        #(width = 746, height = 795, jpeg = embed \"path/to/screenshot-1.jpeg\"),\n"
        "        #(width = 640, height = 480, png = embed \"path/to/screenshot-2.png\"),\n"
        "      ],\n"
        "      #changeLog = (defaultText = embed \"path/to/sandstorm-specific/changelog.md\"),\n"
        "      # Documents the history of changes in Github-flavored markdown format (with the same restrictions\n"
        "      # as govern `description`). We recommend formatting this with an H1 heading for each version\n"
        "      # followed by a bullet list of changes.\n"
        "    ),\n"
        "  ),\n"
        "\n"
        "  sourceMap = (\n",
        includeAllForInit
        ? "    # The following directories will be copied into your package.\n"
        : "    # Here we defined where to look for files to copy into your package. The\n"
          "    # `spk dev` command actually figures out what files your app needs\n"
          "    # automatically by running it on a FUSE filesystem. So, the mappings\n"
          "    # here are only to tell it where to find files that the app wants.\n",
        "    searchPath = [\n",
               searchPath,
        "    ]\n"
        "  ),\n"
        "\n",
        includeAllForInit
        ? "  alwaysInclude = [ \".\" ],\n"
          "  # This says that we always want to include all files from the source map.\n"
          "  # (An alternative is to automatically detect dependencies by watching what\n"
          "  # the app opens while running in dev mode. To see what that looks like,\n"
          "  # run `spk init` without the -A option.)\n"
        : "  fileList = \"sandstorm-files.list\",\n"
          "  # `spk dev` will write a list of all the files your app uses to this file.\n"
          "  # You should review it later, before shipping your app.\n"
          "\n"
          "  alwaysInclude = [],\n"
          "  # Fill this list with more names of files or directories that should be\n"
          "  # included in your package, even if not listed in sandstorm-files.list.\n"
          "  # Use this to force-include stuff that you know you need but which may\n"
          "  # not have been detected as a dependency during `spk dev`. If you list\n"
          "  # a directory here, its entire contents will be included recursively.\n",
          "\n"
          "  #bridgeConfig = (\n"
          "  #  # Used for integrating permissions and roles into the Sandstorm shell\n"
          "  #  # and for sandstorm-http-bridge to pass to your app.\n"
          "  #  # Uncomment this block and adjust the permissions and roles to make\n"
          "  #  # sense for your app.\n"
          "  #  # For more information, see high-level documentation at\n"
          "  #  # https://docs.sandstorm.io/en/latest/developing/auth/\n"
          "  #  # and advanced details in the \"BridgeConfig\" section of\n"
          "  #  # https://github.com/sandstorm-io/sandstorm/blob/master/src/sandstorm/package.capnp\n"
          "  #  viewInfo = (\n"
          "  #    # For details on the viewInfo field, consult \"ViewInfo\" in\n"
          "  #    # https://github.com/sandstorm-io/sandstorm/blob/master/src/sandstorm/grain.capnp\n"
          "  #\n"
          "  #    permissions = [\n"
          "  #    # Permissions which a user may or may not possess.  A user's current\n"
          "  #    # permissions are passed to the app as a comma-separated list of `name`\n"
          "  #    # fields in the X-Sandstorm-Permissions header with each request.\n"
          "  #    #\n"
          "  #    # IMPORTANT: only ever append to this list!  Reordering or removing fields\n"
          "  #    # will change behavior and permissions for existing grains!  To deprecate a\n"
          "  #    # permission, or for more information, see \"PermissionDef\" in\n"
          "  #    # https://github.com/sandstorm-io/sandstorm/blob/master/src/sandstorm/grain.capnp\n"
          "  #      (\n"
          "  #        name = \"editor\",\n"
          "  #        # Name of the permission, used as an identifier for the permission in cases where string\n"
          "  #        # names are preferred.  Used in sandstorm-http-bridge's X-Sandstorm-Permissions HTTP header.\n"
          "  #\n"
          "  #        title = (defaultText = \"editor\"),\n"
          "  #        # Display name of the permission, e.g. to display in a checklist of permissions\n"
          "  #        # that may be assigned when sharing.\n"
          "  #\n"
          "  #        description = (defaultText = \"grants ability to modify data\"),\n"
          "  #        # Prose describing what this role means, suitable for a tool tip or similar help text.\n"
          "  #      ),\n"
          "  #    ],\n"
          "  #    roles = [\n"
          "  #      # Roles are logical collections of permissions.  For instance, your app may have\n"
          "  #      # a \"viewer\" role and an \"editor\" role\n"
          "  #      (\n"
          "  #        title = (defaultText = \"editor\"),\n"
          "  #        # Name of the role.  Shown in the Sandstorm UI to indicate which users have which roles.\n"
          "  #\n"
          "  #        permissions  = [true],\n"
          "  #        # An array indicating which permissions this role carries.\n"
          "  #        # It should be the same length as the permissions array in\n"
          "  #        # viewInfo, and the order of the lists must match.\n"
          "  #\n"
          "  #        verbPhrase = (defaultText = \"can make changes to the document\"),\n"
          "  #        # Brief explanatory text to show in the sharing UI indicating\n"
          "  #        # what a user assigned this role will be able to do with the grain.\n"
          "  #\n"
          "  #        description = (defaultText = \"editors may view all site data and change settings.\"),\n"
          "  #        # Prose describing what this role means, suitable for a tool tip or similar help text.\n"
          "  #      ),\n"
          "  #      (\n"
          "  #        title = (defaultText = \"viewer\"),\n"
          "  #        permissions  = [false],\n"
          "  #        verbPhrase = (defaultText = \"can view the document\"),\n"
          "  #        description = (defaultText = \"viewers may view what other users have written.\"),\n"
          "  #      ),\n"
          "  #    ],\n"
          "  #  ),\n"
          "  #  #apiPath = \"/api\",\n"
          "  #  # Apps can export an API to the world.  The API is to be used primarily by Javascript\n"
          "  #  # code and native apps, so it can't serve out regular HTML to browsers.  If a request\n"
          "  #  # comes in to your app's API, sandstorm-http-bridge will prefix the request's path with\n"
          "  #  # this string, if specified.\n"
          "  #),\n"
        ");\n"
        "\n"
        "const myCommand :Spk.Manifest.Command = (\n"
        "  # Here we define the command used to start up your server.\n"
        "  argv = [", argv, "],\n"
        "  environ = [\n"
        "    # Note that this defines the *entire* environment seen by your app.\n"
        "    (key = \"PATH\", value = \"/usr/local/bin:/usr/bin:/bin\"),\n"
        "    (key = \"SANDSTORM\", value = \"1\"),\n"
        "    # Export SANDSTORM=1 into the environment, so that apps running within Sandstorm\n"
        "    # can detect if $SANDSTORM=\"1\" at runtime, switching UI and/or backend to use\n"
        "    # the app's Sandstorm-specific integration code.\n"
        "  ]\n"
        ");\n");

    out.write(content.begin(), content.size());

    context.exitInfo(kj::str("wrote: ", outputFile));
  }

  // =====================================================================================

  kj::String spkfile;

  kj::MainFunc getPackMain() {
    return addCommonOptions(OptionSet::ALL_READONLY,
        kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
            "Package the app as an spk, writing it to <output>.")
        .expectArg("<output>", KJ_BIND_METHOD(*this, setSpkfile))
        .callAfterParsing(KJ_BIND_METHOD(*this, doPack)))
        .build();
  }

  kj::MainBuilder::Validity setSpkfile(kj::StringPtr name) {
    spkfile = kj::heapString(name);
    return true;
  }

  kj::MainBuilder::Validity doPack() {
    ensurePackageDefParsed();

    spk::KeyFile::Reader key = lookupKey(packageDef.getId());

    kj::AutoCloseFd tmpfile = packToTempFile();

    // Map the temp file back in.
    MemoryMapping tmpMapping(tmpfile, spkfile);
    kj::ArrayPtr<const byte> tmpData = tmpMapping;

    if (tmpData.size() > APP_SIZE_LIMIT) {
      context.exitError(kj::str(
          "App exceeds uncompressed size limit of ", APP_SIZE_LIMIT >> 30, " GiB. This limit "
          "exists for the safety of hosts, but if you feel there is a strong case for allowing "
          "larger apps, please contact the Sandstorm developers."));
    }

    // Hash it.
    byte hash[crypto_hash_sha512_BYTES];
    crypto_hash_sha512(hash, tmpData.begin(), tmpData.size());

    // Generate the signature.
    capnp::MallocMessageBuilder signatureMessage;
    spk::Signature::Builder signature = signatureMessage.getRoot<spk::Signature>();
    signature.setPublicKey(key.getPublicKey());
    unsigned long long siglen = crypto_hash_sha512_BYTES + crypto_sign_BYTES;
    crypto_sign(signature.initSignature(siglen).begin(), &siglen,
                hash, sizeof(hash), key.getPrivateKey().begin());

    // Now write the whole thing out.
    {
      auto finalFile = raiiOpen(spkfile, O_WRONLY | O_CREAT | O_TRUNC);

      // Write magic number uncompressed.
      auto magic = spk::MAGIC_NUMBER.get();
      kj::FdOutputStream(finalFile.get()).write(magic.begin(), magic.size());

      // Pipe content through xz compressor.
      auto pipe = Pipe::make();
      Subprocess::Options childOptions({"xz", "--threads=0", "--compress", "--stdout"});
      childOptions.stdin = pipe.readEnd.get();
      childOptions.stdout = finalFile.get();
      Subprocess child(kj::mv(childOptions));
      pipe.readEnd = nullptr;

      // Write signature and archive out to the pipe, then close the pipe.
      {
        kj::FdOutputStream out(kj::mv(pipe.writeEnd));
        capnp::writeMessage(out, signatureMessage);
        out.write(tmpData.begin(), tmpData.size());
      }

      // Wait until xz is done compressing.
      child.waitForSuccess();
    }

    printAppId(key.getPublicKey());

    return true;
  }

  kj::AutoCloseFd packToTempFile() {
    // Read in the file list.
    ArchiveNode root;

    // Set up special files that will be over-mounted by the supervisor.
    root.followPath("dev");
    root.followPath("tmp");
    root.followPath("var");
    root.followPath("proc").followPath("cpuinfo").setData(nullptr);

    auto sourceMap = packageDef.getSourceMap();

    kj::String packIsolateSupportDir = nullptr;
    KJ_DEFER({
      if (packIsolateSupportDir != nullptr) {
        recursivelyDelete(packIsolateSupportDir);
      }
      packManifestOverride = nullptr;
    });
    preparePackIsolateSupport(root, packIsolateSupportDir);
    if (packageDef.hasFileList()) {
      auto fileListFile = packageDef.getFileList();
      if (access(fileListFile.cStr(), F_OK) != 0) {
        context.exitInfo(kj::str("\"", fileListFile,
            "\" does not exist. Have you run `spk dev` yet?"));
      }

      for (auto& line: splitLines(readAll(raiiOpen(fileListFile, O_RDONLY)))) {
        addNode(root, line, sourceMap, false);
      }
    }
    for (auto file: packageDef.getAlwaysInclude()) {
      addNode(root, file, sourceMap, true);
    }

    auto tmpfile = openTemporary(spkfile);

    // Write the archive.
    capnp::MallocMessageBuilder archiveMessage;
    auto archive = archiveMessage.getRoot<spk::Archive>();
    struct timespec defaultMTime;
    KJ_SYSCALL(clock_gettime(CLOCK_REALTIME, &defaultMTime));
    archive.adoptFiles(root.packChildren(archiveMessage.getOrphanage(), context, defaultMTime));
    capnp::writeMessageToFd(tmpfile, archiveMessage);

    return tmpfile;
  }

  class ArchiveNode {
    // A tree of files.
  public:
    ArchiveNode() {}

    inline void setTarget(kj::String&& target) { this->target = kj::mv(target); }
    inline void setData(kj::Array<capnp::word>&& data) { this->data = kj::mv(data); }

    ArchiveNode& followPath(kj::StringPtr path) {
      if (path == nullptr) return *this;

      kj::String pathPart;
      KJ_IF_MAYBE(slashPos, path.findFirst('/')) {
        pathPart = kj::heapString(path.slice(0, *slashPos));
        path = path.slice(*slashPos + 1);
      } else {
        pathPart = kj::heapString(path);
        path = nullptr;
      }

      return children[kj::mv(pathPart)].followPath(path);
    }

    void pack(spk::Archive::File::Builder builder, kj::ProcessContext& context,
              struct timespec defaultMTime) {
      auto orphanage = capnp::Orphanage::getForMessageContaining(builder);

      KJ_IF_MAYBE(d, data) {
        KJ_ASSERT(children.empty(), "got file, expected directory", target);
        auto bytes = kj::arrayPtr(reinterpret_cast<const kj::byte*>(d->begin()),
                                  d->size() * sizeof(capnp::word));
        builder.adoptRegular(orphanage.referenceExternalData(bytes));
        return;
      }

      struct stat stats;

      if (target == nullptr) {
        stats.st_mode = S_IFDIR;
        stats.st_mtim = defaultMTime;
      } else {
        KJ_SYSCALL(lstat(target.cStr(), &stats), target);
      }

      auto mtime = stats.st_mtim.tv_sec * kj::SECONDS + stats.st_mtim.tv_nsec * kj::NANOSECONDS;
      builder.setLastModificationTimeNs(mtime / kj::NANOSECONDS);

      if (S_ISREG(stats.st_mode)) {
        KJ_ASSERT(children.empty(), "got file, expected directory", target);

        kj::AutoCloseFd fd = raiiOpen(target, O_RDONLY);
        size_t size = getFileSize(fd, target);

        if (size >= (1ull << 29)) {
          context.exitError(kj::str(target, ": file too large. The spk format currently only "
            "supports files up to 512MB in size. Please let the Sandstorm developers know "
            "if you have a strong reason for needing larger files."));
        }

        // Reading the entirety of a file into memory can take up a sizable
        // chunk of RAM, so we'd prefer to not pay that cost if we don't need
        // it.
        //
        // MemoryMapping doesn't keep a copy in RAM, but it does keep an mmap()
        // to the file open until we clean up the whole arena, which can wind
        // up taking a lot of file table entries.  In particular, VirtualBox
        // shared folders cannot handle >4096 concurrent mmap()s of files from
        // the host.  So we have to be cautious using MemoryMapping for all files.
        //
        // It is generally the case that most files are small, but most of your
        // data is in large files.  This suggests the following heuristic as a
        // compromise: use MemoryMapping for files larger than 128k (specific
        // number adjustable) and read the whole file into memory for anything
        // smaller.  So we do that.
        if (size > 1ull << 17) {
          // File larger than 128k, mmap preferred
          mapping = MemoryMapping(kj::mv(fd), target);
          auto content = orphanage.referenceExternalData(mapping);
          if (stats.st_mode & S_IXUSR) {
            builder.adoptExecutable(kj::mv(content));
          } else {
            builder.adoptRegular(kj::mv(content));
          }
        } else {
          // Small file; direct read preferable.
          ::capnp::Data::Builder buf = nullptr;
          if (stats.st_mode & S_IXUSR) {
            buf = builder.initExecutable(size);
          } else {
            buf = builder.initRegular(size);
          }
          kj::FdInputStream stream(kj::mv(fd));
          stream.read(buf.begin(), size);
        }

      } else if (S_ISLNK(stats.st_mode)) {
        KJ_ASSERT(children.empty(), "got symlink, expected directory", target);

        auto symlink = builder.initSymlink(stats.st_size);

        ssize_t linkSize;
        KJ_SYSCALL(linkSize = readlink(target.cStr(), symlink.begin(), stats.st_size), target);
      } else if (S_ISDIR(stats.st_mode)) {
        builder.adoptDirectory(packChildren(orphanage, context, defaultMTime));
      } else {
        context.warning(kj::str("Cannot pack irregular file: ", target));
        builder.initRegular(0);
      }
    }

    capnp::Orphan<capnp::List<spk::Archive::File>> packChildren(
        capnp::Orphanage orphanage, kj::ProcessContext& context, struct timespec defaultMTime) {
      auto orphan = orphanage.newOrphan<capnp::List<spk::Archive::File>>(children.size());
      auto builder = orphan.get();

      uint i = 0;
      for (auto& child: children) {
        auto childBuilder = builder[i++];
        childBuilder.setName(child.first);
        child.second.pack(childBuilder, context, defaultMTime);
      }

      return orphan;
    }

  private:
    kj::String target;
    // The disk path which should be used to initialize this node.

    std::map<kj::String, ArchiveNode> children;
    // Contents of this node if it is a directory.

    MemoryMapping mapping;
    // May be initialized during pack().

    kj::Maybe<kj::Array<capnp::word>> data;
    // Raw data comprising this node. Mutually exclusive with all other members.
  };

  bool isHttpBridgeCommand(spk::Manifest::Command::Reader command) {
    // Hacky heuristic to decide if the package uses sandstorm-http-bridge.
    auto argv = command.getArgv();
    if (argv.size() == 0) return false;

    auto exe = argv[0];

    return exe == "/sandstorm-http-bridge" ||
           exe == "./sandstorm-http-bridge" ||
           exe == "sandstorm-http-bridge";
  }

  void addNode(ArchiveNode& root, kj::StringPtr path, const spk::SourceMap::Reader& sourceMap,
               bool recursive) {
    if (path.startsWith("/")) {
      context.exitError(kj::str("Destination (in-package) path must not start with '/': ", path));
    }
    if (path == ".") {
      path = "";
    }

    auto& node = root.followPath(path);
    if (path == "sandstorm-manifest") {
      // Serialize the manifest.
      KJ_IF_MAYBE(manifest, packManifestOverride) {
        node.setData(kj::mv(*manifest));
      } else {
        auto manifestReader = packageDef.getManifest();
        capnp::MallocMessageBuilder manifestMessage(manifestReader.totalSize().wordCount + 4);
        manifestMessage.setRoot(manifestReader);
        node.setData(capnp::messageToFlatArray(manifestMessage));
      }
    } else if (path == "sandstorm-http-bridge-config") {
      // Serialize the bridgeConfig.
      auto bridgeConfigReader = packageDef.getBridgeConfig();
      capnp::MallocMessageBuilder bridgeConfigMessage(bridgeConfigReader.totalSize().wordCount + 4);
      bridgeConfigMessage.setRoot(bridgeConfigReader);
      node.setData(capnp::messageToFlatArray(bridgeConfigMessage));
    } else if (path == "sandstorm-http-bridge") {
      node.setTarget(getHttpBridgeExe());
    } else if (path == "proc/cpuinfo") {
      // Empty /proc/cpuinfo will be overmounted by the supervisor.
      node.setData(nullptr);
    } else {
      if (path.size() == 0 && recursive) {
        addNode(root, "sandstorm-manifest", sourceMap, true);
        if (packageDef.hasBridgeConfig() ||
            isHttpBridgeCommand(packageDef.getManifest().getContinueCommand())) {
          addNode(root, "sandstorm-http-bridge-config", sourceMap, true);
          addNode(root, "sandstorm-http-bridge", sourceMap, true);
        }
      }

      auto mapping = mapFile(sourceDir, sourceMap, path);
      if (mapping.sourcePaths.size() == 0 && mapping.virtualChildren.size() == 0) {
        context.exitError(kj::str("No file found to satisfy requirement: ", path));
      } else {
        initNode(node, path, kj::mv(mapping), sourceMap, recursive);
      }
    }
  }

  void initNode(ArchiveNode& node, kj::StringPtr srcPath, FileMapping&& mapping,
                const spk::SourceMap::Reader& sourceMap, bool recursive) {
    if (mapping.sourcePaths.size() == 0 && mapping.virtualChildren.size() == 0) {
      // Nothing here.
      return;
    }

    if (recursive && (mapping.sourcePaths.size() == 0 || isDirectory(mapping.sourcePaths[0]))) {
      // Primary match is a directory, so merge all of the matching directories.
      std::set<kj::String> seen;
      for (auto& child: mapping.virtualChildren) {
        seen.insert(kj::mv(child));
      }
      for (auto& target: mapping.sourcePaths) {
        if (isDirectory(target)) {
          // This is one of the directories to be merged. List it.
          for (auto& child: listDirectory(target)) {
            if (child != "." && child != "..") {
              seen.insert(kj::mv(child));
            }
          }
        }
      }

      for (auto& child: seen) {
        // Note that this child node could be hidden. We need to use mapFile() on it directly
        // in order to make sure it maps to a real file.
        auto subPath = srcPath.size() == 0 ?
            kj::str(child) : kj::str(srcPath, '/', child);
        auto subMapping = mapFile(sourceDir, sourceMap, subPath);
        initNode(node.followPath(child), subPath, kj::mv(subMapping), sourceMap,
                 recursive);
      }
    }

    if (mapping.sourcePaths.size() > 0) {
      node.setTarget(kj::mv(mapping.sourcePaths[0]));
    }
  }

  kj::String getHttpBridgeExe() {
    KJ_IF_MAYBE(h, installHome) {
      return kj::str(*h, "/bin/sandstorm-http-bridge");
    } else {
      KJ_FAIL_ASSERT("don't know where to find sandstorm-http-bridge");
    }
  }

  // =====================================================================================

  kj::String dirname;

  kj::MainFunc getUnpackMain() {
    return kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
            "Check that <spkfile>'s signature is valid.  If so, unpack it to <outdir> and "
            "print the app ID.  If <outdir> is not specified, it will be "
            "chosen by removing the suffix \".spk\" from the input file name.")
        .expectArg("<spkfile>", KJ_BIND_METHOD(*this, setUnpackSpkfile))
        .expectOptionalArg("<outdir>", KJ_BIND_METHOD(*this, setUnpackDirname))
        .callAfterParsing(KJ_BIND_METHOD(*this, doUnpack))
        .build();
  }

  kj::MainBuilder::Validity setUnpackSpkfile(kj::StringPtr name) {
    if (name != "-" && access(name.cStr(), F_OK) < 0) {
      return "Not found.";
    }

    spkfile = kj::heapString(name);
    if (spkfile.endsWith(".spk")) {
      dirname = kj::heapString(spkfile.slice(0, spkfile.size() - 4));
    }

    return true;
  }

  kj::MainBuilder::Validity setUnpackDirname(kj::StringPtr name) {
    if (access(name.cStr(), F_OK) == 0) {
      return "Already exists.";
    }

    dirname = kj::heapString(name);
    return true;
  }

  [[noreturn]] void validationError(kj::StringPtr filename, kj::StringPtr problem) {
    context.exitError(kj::str("*** ", filename, ": ", problem));
  }

  kj::MainBuilder::Validity doUnpack() {
    if (dirname == nullptr) {
      return "must specify directory name when filename doesn't end with \".spk\"";
    }
    if (access(dirname.cStr(), F_OK) == 0) {
      return "output directory already exists";
    }
    KJ_SYSCALL(mkdir(dirname.cStr(), 0777), dirname);

    kj::AutoCloseFd ownFd;
    int spkfd;

    kj::StringPtr tmpNear;
    if (spkfile == "-") {
      spkfd = STDIN_FILENO;
      tmpNear = "/tmp/spk-unpack";
    } else {
      ownFd = raiiOpen(spkfile, O_RDONLY);
      spkfd = ownFd;
      tmpNear = spkfile;
    }

    printAppId(unpackImpl(spkfd, dirname, tmpNear,
        [&](kj::StringPtr problem) -> kj::String {
      rmdir(dirname.cStr());
      validationError(spkfile, problem);
    }));

    return true;
  }

  friend kj::String unpackSpk(int spkfd, kj::StringPtr outdir, kj::StringPtr tmpdir);
  friend void verifySpk(int spkfd, int tmpfile, spk::VerifiedInfo::Builder output);
  friend kj::Maybe<kj::String> checkPgpSignature(
      kj::StringPtr appIdString, spk::Metadata::Reader metadata, kj::Maybe<uid_t> sandboxUid);

  static kj::String verifyImpl(
      int spkfd, int tmpfile, kj::Maybe<spk::VerifiedInfo::Builder> maybeInfo,
      kj::Function<kj::String(kj::StringPtr problem)> validationError) {
    // Read package form spkfd, check the validity and signature, and return the appId. Also write
    // the uncompressed archive to `tmpfile`.

    // We need to compute the hash of the input. The input could be a pipe (not a file), therefore
    // we need to read it in chunks, hash the content, and write back out to the pipe that xz will
    // use as input below. We'll do all that in a thread to keep the code simple.
    byte packageHash[crypto_hash_sha256_BYTES];
    Pipe spkPipe = Pipe::make();
    auto hashThread = new kj::Thread([&]() {
      crypto_hash_sha256_state packageHashState;
      KJ_ASSERT(crypto_hash_sha256_init(&packageHashState) == 0);

      byte buffer[8192];
      kj::FdOutputStream out(kj::mv(spkPipe.writeEnd));
      for (;;) {
        ssize_t n;
        KJ_SYSCALL(n = read(spkfd, buffer, sizeof(buffer)));
        if (n == 0) break;
        KJ_ASSERT(crypto_hash_sha256_update(&packageHashState, buffer, n) == 0);
        out.write(buffer, n);
      }

      KJ_ASSERT(crypto_hash_sha256_final(&packageHashState, packageHash));
    });

    // Check the magic number.
    auto expectedMagic = spk::MAGIC_NUMBER.get();
    byte magic[expectedMagic.size()];
    kj::FdInputStream(spkPipe.readEnd.get()).read(magic, expectedMagic.size());
    for (uint i: kj::indices(expectedMagic)) {
      if (magic[i] != expectedMagic[i]) {
        return validationError("Does not appear to be an .spk (bad magic number).");
      }
    }

    // Decompress the remaining bytes in the SPK using xz.
    Pipe pipe = Pipe::make();

    Subprocess::Options childOptions({"xz", "-dc"});
    childOptions.stdin = spkPipe.readEnd;
    childOptions.stdout = pipe.writeEnd;
    Subprocess child(kj::mv(childOptions));

    spkPipe.readEnd = nullptr;
    pipe.writeEnd = nullptr;
    kj::FdInputStream in(kj::mv(pipe.readEnd));

    // Read in the signature.
    byte publicKey[crypto_sign_PUBLICKEYBYTES];
    byte sigBytes[crypto_hash_sha512_BYTES + crypto_sign_BYTES];
    {
      // TODO(security): Set a small limit on signature size?
      capnp::InputStreamMessageReader signatureMessage(in);
      auto signature = signatureMessage.getRoot<spk::Signature>();
      auto pkReader = signature.getPublicKey();
      if (pkReader.size() != sizeof(publicKey)) {
        return validationError("Invalid public key.");
      }
      memcpy(publicKey, pkReader.begin(), sizeof(publicKey));
      auto sigReader = signature.getSignature();
      if (sigReader.size() != sizeof(sigBytes)) {
        return validationError("Invalid signature format.");
      }
      memcpy(sigBytes, sigReader.begin(), sizeof(sigBytes));
    }

    // Verify the signature.
    byte expectedHash[sizeof(sigBytes)];
    unsigned long long hashLength = 0;  // will be overwritten later
    int result = crypto_sign_open(
        expectedHash, &hashLength, sigBytes, sizeof(sigBytes), publicKey);
    if (result != 0) {
      return validationError("Invalid signature.");
    }
    if (hashLength != crypto_hash_sha512_BYTES) {
      return validationError("Wrong signature size.");
    }

    // Copy archive part to a temp file, computing hash in the meantime.
    crypto_hash_sha512_state hashState;
    crypto_hash_sha512_init(&hashState);
    kj::FdOutputStream tmpOut(tmpfile);
    uint64_t totalRead = 0;
    for (;;) {
      byte buffer[8192];
      size_t n = in.tryRead(buffer, 1, sizeof(buffer));
      if (n == 0) break;
      crypto_hash_sha512_update(&hashState, buffer, n);
      totalRead += n;
      KJ_REQUIRE(totalRead <= APP_SIZE_LIMIT, "App too big after decompress.");
      tmpOut.write(buffer, n);
    }

    child.waitForSuccess();
    hashThread = nullptr;  // joins thread

    // The spk pipe thread should have exited now, completing the hash.
    static_assert(PACKAGE_ID_BYTE_SIZE <= crypto_hash_sha256_BYTES, "package ID size changed?");
    auto packageIdBytes = kj::arrayPtr(packageHash, PACKAGE_ID_BYTE_SIZE);

    // Check that hashes match.
    byte hash[crypto_hash_sha512_BYTES];
    crypto_hash_sha512_final(&hashState, hash);
    if (memcmp(expectedHash, hash, crypto_hash_sha512_BYTES) != 0) {
      return validationError("Signature didn't match package contents.");
    }

    // Get the canonical app ID based on the replacements table (see appid-replacements.capnp).
    // This also throws if the key is revoked.
    applyAppidReplacements(publicKey, packageIdBytes);

    auto appIdString = sandstorm::appIdString(publicKey);

    KJ_IF_MAYBE(info, maybeInfo) {
      // mmap the temp file.
      MemoryMapping tmpMapping(tmpfile, "(temp file)");

      // Set up archive reader.
      kj::ArrayPtr<const capnp::word> tmpWords = tmpMapping;
      capnp::ReaderOptions options;
      options.traversalLimitInWords = tmpWords.size();
      capnp::FlatArrayMessageReader archiveMessage(tmpWords, options);

      bool foundManifest = false;
      for (auto file: archiveMessage.getRoot<spk::Archive>().getFiles()) {
        if (file.getName() == "sandstorm-manifest") {
          if (!file.isRegular()) {
            return validationError("sandstorm-manifest is not a regular file");
          }

          auto data = file.getRegular();

          capnp::ReaderOptions manifestLimits;
          manifestLimits.traversalLimitInWords = spk::Manifest::SIZE_LIMIT_IN_WORDS;

          // Data fields are always word-aligned.
          capnp::FlatArrayMessageReader manifestMessage(
              kj::arrayPtr(reinterpret_cast<const capnp::word*>(data.begin()),
                           data.size() / sizeof(capnp::word)), manifestLimits);

          auto manifest = manifestMessage.getRoot<spk::Manifest>();

          // TODO(someday): Support localization properly?

          {
            auto appId = capnp::AnyStruct::Builder(info->initAppId()).getDataSection();
            KJ_ASSERT(appId.size() == sizeof(publicKey));
            memcpy(appId.begin(), publicKey, sizeof(publicKey));
          }
          {
            auto packageId = capnp::AnyStruct::Builder(info->initPackageId()).getDataSection();
            KJ_ASSERT(packageId.size() == packageIdBytes.size());
            memcpy(packageId.begin(), packageIdBytes.begin(), packageIdBytes.size());
          }

          info->setTitle(manifest.getAppTitle());
          info->setVersion(manifest.getAppVersion());
          info->setMarketingVersion(manifest.getAppMarketingVersion());
          auto metadata = manifest.getMetadata();
          info->setMetadata(metadata);
          // Validate some things.
          if (metadata.hasWebsite()) requireHttpUrl(metadata.getWebsite());
          if (metadata.hasCodeUrl()) requireHttpUrl(metadata.getCodeUrl());

          // Check author PGP key.
          auto author = metadata.getAuthor();
          if (author.hasPgpSignature()) {
            if (!metadata.hasPgpKeyring()) {
              return validationError(
                  "author's PGP signature is present but no PGP keyring is provided");
            }

            info->setAuthorPgpKeyFingerprint(checkPgpSignature(appIdString,
                author.getPgpSignature(), metadata.getPgpKeyring(), validationError));
          }

          foundManifest = true;
          break;
        }
      }

      if (!foundManifest) {
        return validationError("SPK contains no manifest file.");
      }
    }

    return appIdString;
  }

  static void requireHttpUrl(kj::StringPtr url) {
    KJ_REQUIRE(url.startsWith("http://") || url.startsWith("https://"),
               "web URLs must be HTTP", url);
  }

  static kj::String checkPgpSignature(
      kj::StringPtr appIdString, kj::ArrayPtr<const byte> sig, kj::ArrayPtr<const byte> key,
      kj::Function<kj::String(kj::StringPtr problem)>& validationError,
      kj::Maybe<uid_t> sandboxUid = nullptr) {
    auto expectedContent = kj::str(
        "I am the author of the Sandstorm.io app with the following ID: ",
        appIdString);

    char keyfile[] = "/tmp/spk-pgp-key.XXXXXX";
    int keyfd;
    KJ_SYSCALL(keyfd = mkstemp(keyfile));
    KJ_DEFER(unlink(keyfile));
    kj::FdOutputStream(kj::AutoCloseFd(keyfd)).write(key.begin(), key.size());

    char sigfile[] = "/tmp/spk-pgp-sig.XXXXXX";
    int sigfd;
    KJ_SYSCALL(sigfd = mkstemp(sigfile));
    KJ_DEFER(unlink(sigfile));
    kj::FdOutputStream(kj::AutoCloseFd(sigfd)).write(sig.begin(), sig.size());

    // GPG unfortunately DEMANDS to read from its "home directory", which is expected to contain
    // user configuration. We actively don't want this: we want it to run in a reproducible manner.
    // So we create a fake home.
    char gpghome[] = "/tmp/spk-fake-gpg-home.XXXXXX";
    if (mkdtemp(gpghome) == nullptr) {
      KJ_FAIL_SYSCALL("mkdtemp(gpghome)", errno, gpghome);
    }
    KJ_DEFER(recursivelyDelete(gpghome));

    auto outPipe = Pipe::make();       // stdout -> signed text
    auto messagePipe = Pipe::make();   // stderr -> human-readable messages
    auto statusPipe = Pipe::make();    // fd 3 -> machine-readable messages

    Subprocess::Options gpgOptions({
        "gpg", "--homedir", gpghome, "--status-fd", "3", "--no-default-keyring",
        "--keyring", keyfile, "--decrypt", sigfile});
    gpgOptions.uid = sandboxUid;
    gpgOptions.stdout = outPipe.writeEnd;
    gpgOptions.stderr = messagePipe.writeEnd;
    int moreFds[1] = { statusPipe.writeEnd };
    gpgOptions.moreFds = moreFds;
    Subprocess gpg(kj::mv(gpgOptions));

    outPipe.writeEnd = nullptr;
    messagePipe.writeEnd = nullptr;
    statusPipe.writeEnd = nullptr;

    // Gather output from GPG.
    // TODO(cleanup): This really belongs in a library, perhaps in `Subprocess`.
    kj::Vector<char> out, message, status;
    bool outDone = false, messageDone = false, statusDone = false;
    for (;;) {
      kj::Vector<struct pollfd> pollfds;
      typedef struct pollfd PollFd;
      if (!outDone) pollfds.add(PollFd {outPipe.readEnd, POLLIN, 0});
      if (!messageDone) pollfds.add(PollFd {messagePipe.readEnd, POLLIN, 0});
      if (!statusDone) pollfds.add(PollFd {statusPipe.readEnd, POLLIN, 0});
      if (pollfds.size() == 0) break;
      KJ_SYSCALL(poll(pollfds.begin(), pollfds.size(), -1));
      for (auto& item: pollfds) {
        if (item.revents & POLLIN) {
          // Data to read!
          char buffer[1024];
          size_t n = kj::FdInputStream(item.fd).read(buffer, 1, sizeof(buffer));
          if (item.fd == outPipe.readEnd.get()) {
            out.addAll(kj::arrayPtr(buffer, n));
          } else if (item.fd == messagePipe.readEnd.get()) {
            message.addAll(kj::arrayPtr(buffer, n));
          } else if (item.fd == statusPipe.readEnd.get()) {
            status.addAll(kj::arrayPtr(buffer, n));
          } else {
            KJ_FAIL_ASSERT("unexpected FD returned by poll()?");
          }
        } else if (item.revents != 0) {
          // Woke up with no data available; must be EOF.
          if (item.fd == outPipe.readEnd.get()) {
            outDone = true;
          } else if (item.fd == messagePipe.readEnd.get()) {
            messageDone = true;
          } else if (item.fd == statusPipe.readEnd.get()) {
            statusDone = true;
          } else {
            KJ_FAIL_ASSERT("unexpected FD returned by poll()?");
          }
        }
      }
    }

    if (gpg.waitForExitOrSignal() != 0) {
      return validationError(kj::str(
          "SPK PGP signature check validation failed. GPG output follows.\n",
          kj::implicitCast<kj::ArrayPtr<const char>>(message)));
    }

    auto content = trim(out);
    if (content != expectedContent) {
      return validationError(kj::str(
          "SPK PGP signature signed incorrect text."
          "\nExpected: ", expectedContent,
          "\nActual:   ", content));
    }

    // Look for the VALIDSIG line which provides the PGP key fingerprint.
    kj::String fingerprint;
    for (auto& statusLine: split(status, '\n')) {
      auto words = splitSpace(statusLine);
      if (words.size() >= 3 &&
          kj::heapString(words[0]) == "[GNUPG:]" &&
          kj::heapString(words[1]) == "VALIDSIG") {
        // This is the line we're looking for!

        // words[11] is privacy-key-fpr, i.e. the fingerprint of the user's main key rather than
        // the subkey used for this signature. The docs suggest it might not be present. words[2]
        // is always the fingerprint of the exact key that did the signing, so fall back to that
        // if needed.
        return kj::heapString(words.size() > 11 ? words[11] : words[2]);
      }
    }

    KJ_FAIL_ASSERT("couldn't find expected '[GNUPG:] VALIDSIG' line in GPG status output",
                   kj::str(status.asPtr()));
  }

  static kj::String unpackImpl(
      int spkfd, kj::StringPtr dirname, kj::StringPtr tmpNear,
      kj::Function<kj::String(kj::StringPtr problem)> validationError) {
    // TODO(security):  We could at this point chroot into the output directory and unshare
    //   various resources for extra security, if not for the fact that we need to invoke xz
    //   later on.  Maybe link against the xz library so that we don't have to exec it?

    auto tmpfile = openTemporary(tmpNear);
    auto appId = verifyImpl(spkfd, tmpfile, nullptr, kj::mv(validationError));

    // mmap the temp file.
    MemoryMapping tmpMapping(tmpfile, "(temp file)");
    tmpfile = nullptr;  // We have the mapping now; don't need the fd.

    // Set up archive reader.
    kj::ArrayPtr<const capnp::word> tmpWords = tmpMapping;
    capnp::ReaderOptions options;
    options.traversalLimitInWords = tmpWords.size();

    // We've observed that apps which use npm can have insanely deep directory trees due to npm's
    // insane approach to dependency management. We've seen at least one app creep over the default
    // nesting limit of 64, so we double it to 128. (We can't just set this to infinity for the
    // same security reasons this limit exists in the first place.)
    options.nestingLimit = 128;

    capnp::FlatArrayMessageReader archiveMessage(tmpWords, options);

    // Unpack.
    unpackDir(archiveMessage.getRoot<spk::Archive>().getFiles(), dirname);

    // Note the appid.
    return appId;
  }

  static void unpackDir(capnp::List<spk::Archive::File>::Reader files, kj::StringPtr dirname) {
    std::set<kj::StringPtr> seen;

    for (auto file: files) {
      kj::StringPtr name = file.getName();
      KJ_REQUIRE(name.size() != 0 && name != "." && name != ".." &&
                 name.findFirst('/') == nullptr && name.findFirst('\0') == nullptr,
                 "Archive contained invalid file name.", name);

      KJ_REQUIRE(seen.insert(name).second, "Archive contained duplicate file name.", name);

      auto path = kj::str(dirname, '/', name);

      KJ_ASSERT(access(path.cStr(), F_OK) != 0, "Unpacked file already exists.", path);

      switch (file.which()) {
        case spk::Archive::File::REGULAR: {
          auto bytes = file.getRegular();
          kj::FdOutputStream(raiiOpen(path, O_WRONLY | O_CREAT | O_EXCL, 0666))
              .write(bytes.begin(), bytes.size());
          break;
        }

        case spk::Archive::File::EXECUTABLE: {
          auto bytes = file.getExecutable();
          kj::FdOutputStream(raiiOpen(path, O_WRONLY | O_CREAT | O_EXCL, 0777))
              .write(bytes.begin(), bytes.size());
          break;
        }

        case spk::Archive::File::SYMLINK: {
          KJ_SYSCALL(symlink(file.getSymlink().cStr(), path.cStr()), path);
          break;
        }

        case spk::Archive::File::DIRECTORY: {
          KJ_SYSCALL(mkdir(path.cStr(), 0777), path);
          unpackDir(file.getDirectory(), path);
          break;
        }

        default:
          KJ_FAIL_REQUIRE("Unknown file type in archive.");
      }

      struct timespec times[2];
      auto ns = file.getLastModificationTimeNs();
      times[0].tv_sec = ns / 1000000000ll;
      times[0].tv_nsec = ns % 1000000000ll;
      if (times[0].tv_nsec < 0) {
        // C division rounds towards zero. :(
        ++times[0].tv_sec;
        times[0].tv_nsec += 1000000000ll;
      }
      times[1] = times[0];  // Also use mtime as atime.
      KJ_SYSCALL(utimensat(AT_FDCWD, path.cStr(), times, AT_SYMLINK_NOFOLLOW));
    }
  }

  // =====================================================================================
  // "verify" command

  kj::MainFunc getVerifyMain() {
    return kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
            "Check that <spkfile>'s signature is valid. If so, print the app ID to stdout.")
        .addOption({'d', "details"}, KJ_BIND_METHOD(*this, setDetailed),
            // `spk verify` now prints details by default, but the --details switch is left here for
            // backwards compatibility for callers.
            "Print detailed metadata extracted from the app manifest. The output is intended to "
            "be machine-parseable.  This flag is now enabled by default.")
        .expectArg("<spkfile>", KJ_BIND_METHOD(*this, setUnpackSpkfile))
        .callAfterParsing(KJ_BIND_METHOD(*this, doVerify))
        .build();
  }

  bool detailed = true;
  // Print verbose details by default when verifying, since that's the primary
  // reason anyone will call the verify subcommand.

  bool setDetailed() {
    detailed = true;
    return true;
  }

  kj::MainBuilder::Validity doVerify() {
    kj::AutoCloseFd ownFd;
    int spkfd;

    if (spkfile == "-") {
      spkfd = STDIN_FILENO;
    } else {
      ownFd = raiiOpen(spkfile, O_RDONLY);
      spkfd = ownFd;
    }

    if (detailed) {
      kj::AutoCloseFd tmpfile = openTemporary("/tmp/spk-verify-tmp");
      capnp::MallocMessageBuilder message;
      auto info = message.getRoot<spk::VerifiedInfo>();
      verifyImpl(spkfd, tmpfile, info, [&](kj::StringPtr problem) -> kj::String {
        validationError(spkfile, problem);
      });
      tmpfile = nullptr;

      AppIdJsonHandler appIdHandler;
      PackageIdJsonHandler packageIdHandler;
      OversizeDataHandler oversizeDataHandler;
      OversizeTextHandler oversizeTextHandler;
      capnp::JsonCodec json;
      json.addTypeHandler(appIdHandler);
      json.addTypeHandler(packageIdHandler);
      json.addTypeHandler(oversizeDataHandler);
      json.addTypeHandler(oversizeTextHandler);
      json.setPrettyPrint(true);

      auto text = json.encode(info);
      kj::FdOutputStream(STDOUT_FILENO).write(text.begin(), text.size());
      kj::FdOutputStream(STDOUT_FILENO).write("\n", 1);
      context.exit();
    } else {
      kj::AutoCloseFd tmpfile = raiiOpen("/dev/null", O_WRONLY | O_CLOEXEC);;
      auto appId = verifyImpl(spkfd, tmpfile, nullptr, [&](kj::StringPtr problem) -> kj::String {
        validationError(spkfile, problem);
      });
      printAppId(appId);
    }

    return true;
  }

  // =====================================================================================
  // "capnp-abi" command

  kj::MainFunc getCapnpAbiMain() {
    return kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
            "Dump public Cap'n Proto interface ABI metadata as JSON.")
        .addOptionWithArg({'I', "import-path"}, KJ_BIND_METHOD(*this, addImportPath), "<path>",
            "Additionally search for imported Cap'n Proto schemas in <path>.")
        .addOptionWithArg({"check"}, KJ_BIND_METHOD(*this, setCapnpAbiBaselinePath),
            "<baseline.json>",
            "Check <schema.capnp> for compatibility with a previous capnp-abi JSON dump.")
        .addOptionWithArg({"interface"}, KJ_BIND_METHOD(*this, setCapnpAbiInterfaceFilter),
            "<name>", "Only include the named interface.")
        .expectArg("<schema.capnp>", KJ_BIND_METHOD(*this, doCapnpAbi))
        .build();
  }

  kj::MainBuilder::Validity setCapnpAbiInterfaceFilter(kj::StringPtr name) {
    if (name.size() == 0) {
      return "interface name must not be empty";
    }
    capnpAbiInterfaceFilter = kj::heapString(name);
    return true;
  }

  kj::MainBuilder::Validity setCapnpAbiBaselinePath(kj::StringPtr path) {
    if (path.size() == 0) {
      return "baseline path must not be empty";
    }
    capnpAbiBaselinePath = kj::heapString(path);
    return true;
  }

  kj::MainBuilder::Validity doCapnpAbi(kj::StringPtr specifier) {
    if (capnpAbiBaselinePath != nullptr) {
      return checkCapnpAbiCompatibility(specifier);
    } else {
      auto output = renderCapnpAbiJson(specifier);
      kj::FdOutputStream(STDOUT_FILENO).write(output.begin(), output.size());
      kj::FdOutputStream(STDOUT_FILENO).write("\n", 1);
      return true;
    }
  }

  // =====================================================================================
  // "powerbox-descriptor" command

  kj::MainFunc getPowerboxDescriptorMain() {
    return kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
            "Generate a packed PowerboxDescriptor for a Cap'n Proto interface.")
        .addOptionWithArg({"format"}, KJ_BIND_METHOD(*this, setPowerboxDescriptorFormat),
            "base64url|capnp|json",
            "Choose the output format. base64url is suitable for browser Powerbox queries; "
            "capnp is suitable for bridgeConfig.viewInfo.matchRequests.")
        .expectArg("<capnp-specifier>#<Interface>",
            KJ_BIND_METHOD(*this, doPowerboxDescriptor))
        .build();
  }

  kj::MainBuilder::Validity setPowerboxDescriptorFormat(kj::StringPtr format) {
    if (format == "base64url") {
      powerboxDescriptorOutputFormat = PowerboxDescriptorOutputFormat::BASE64URL;
    } else if (format == "capnp") {
      powerboxDescriptorOutputFormat = PowerboxDescriptorOutputFormat::CAPNP;
    } else if (format == "json") {
      powerboxDescriptorOutputFormat = PowerboxDescriptorOutputFormat::JSON;
    } else {
      return "format must be base64url, capnp, or json";
    }
    return true;
  }

  kj::MainBuilder::Validity doPowerboxDescriptor(kj::StringPtr spec) {
    KJ_IF_MAYBE(appInterface, parseAppInterfaceSpec(spec)) {
      auto cwd = currentWorkingDirectory();
      auto resolved = resolveAppInterfaceId(cwd, *appInterface);
      auto output = renderPowerboxDescriptor(resolved);
      kj::FdOutputStream(STDOUT_FILENO).write(output.begin(), output.size());
      kj::FdOutputStream(STDOUT_FILENO).write("\n", 1);
      return true;
    } else {
      return "descriptor argument must be CAPNP-SPECIFIER#INTERFACE";
    }
  }

  // =====================================================================================
  // "dev" command

  kj::String serverBinary;
  kj::StringPtr mountDir;
  bool fuseCaching = false;
  bool mountProc = false;
  kj::String devIsolateWorkerPath;
  kj::String devIsolateTitle = kj::heapString("Ad hoc Isolate App");
  kj::String devIsolateCompatibilityDate = kj::heapString("2025-01-01");
  bool devIsolatePrintManifestJson = false;
  kj::String devIsolatePrintGeneratedModule = nullptr;
  kj::String devIsolatePrintGeneratedDeclaration = nullptr;
  struct DevIsolateServiceBinding {
    kj::String name;
    kj::String service;
  };
  struct DevIsolateValueBinding {
    kj::String name;
    kj::String value;
  };
  struct DevIsolateAppInterface {
    kj::String specifier;
    kj::String interfaceName;
  };
  struct ResolvedAppInterface {
    kj::String specifier;
    kj::String interfaceName;
    uint64_t interfaceId;
  };
  enum class DevIsolateCapnpEsOutputKind {
    JS,
    DTS,
  };
  kj::Vector<DevIsolateServiceBinding> devIsolateServiceBindings;
  kj::Vector<DevIsolateValueBinding> devIsolateTextBindings;
  kj::Vector<DevIsolateValueBinding> devIsolateJsonBindings;
  kj::Vector<DevIsolateValueBinding> devIsolateDataBindings;
  kj::Vector<DevIsolateAppInterface> devIsolateAppInterfaces;
  kj::String devIsolateSupportDir = nullptr;

  kj::MainFunc getDevMain() {
    return addCommonOptions(OptionSet::ALL_READONLY,
        kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
            "Register an under-development app with a local Sandstorm server for testing "
            "purposes, and optionally output a list of all files it depends on. While this "
            "command is running, the app will replace the current package for the app's ID "
            "installed on the server. Note that you do not need the private key corresponding "
            "to the app ID for this, so that the key need not be distributed to all developers. "
            "Your user account must be a member of the server's group, typically \"sandstorm\".")
        .addOptionWithArg({'s', "server"}, KJ_BIND_METHOD(*this, setServerDir), "<dir>",
            "Connect to the Sandstorm server installed in <dir>. Default is to detect based on "
            "the location of the spk executable or, failing that, the location pointed to by "
            "the installed init script.")
        .addOptionWithArg({'m', "mount"}, KJ_BIND_METHOD(*this, setMountDir), "<dir>",
            "Don't actually connect to the server. Mount the package at <dir>, so you can poke "
            "at it.")
        .addOption({'c', "cache"}, KJ_BIND_METHOD(*this, enableFuseCaching),
            "Enable aggressive caching over the FUSE filesystem used to detect dependencies. "
            "This may improve performance but means that you will have to restart `spk dev` "
            "any time you make a change to your code.")
        .addOption({"proc"}, KJ_BIND_METHOD(*this, enableMountProc),
            "Mount /proc inside the sandbox. This can be useful for debugging. For security "
            "reasons, this option is only available when you are developing an app; packaged "
            "apps do not get access to /proc.")
        .callAfterParsing(KJ_BIND_METHOD(*this, doDev)))
        .build();
  }

  kj::MainBuilder::Validity setServerDir(kj::StringPtr name) {
    if (access(name.cStr(), F_OK) != 0) {
      return "not found";
    }
    serverBinary = kj::str(name, "/sandstorm");
    return true;
  }

  kj::MainBuilder::Validity setMountDir(kj::StringPtr name) {
    if (access(name.cStr(), F_OK) != 0) {
      return "not found";
    }
    mountDir = name;
    return true;
  }

  kj::MainBuilder::Validity addImportPath(kj::StringPtr arg) {
    importPath.add(kj::heapString(arg));
    return true;
  }

  kj::MainBuilder::Validity enableFuseCaching() {
    fuseCaching = true;
    return true;
  }

  kj::MainBuilder::Validity enableMountProc() {
    mountProc = true;
    return true;
  }

  kj::MainFunc getDevIsolateMain() {
    return kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
        "Run a local JavaScript module as an isolate app on a local Sandstorm server. "
        "This generates a temporary package definition and then uses the normal `spk dev` "
        "machinery, so the app appears in Sandstorm as a development package.")
        .addOptionWithArg({'s', "server"}, KJ_BIND_METHOD(*this, setServerDir), "<dir>",
            "Connect to the Sandstorm server installed in <dir>. Default is to detect based on "
            "the location of the spk executable or, failing that, the location pointed to by "
            "the installed init script.")
        .addOptionWithArg({'m', "mount"}, KJ_BIND_METHOD(*this, setMountDir), "<dir>",
            "Don't actually connect to the server. Mount the generated package at <dir>, so you "
            "can inspect it.")
        .addOption({'c', "cache"}, KJ_BIND_METHOD(*this, enableFuseCaching),
            "Enable aggressive caching over the FUSE filesystem used to detect dependencies.")
        .addOption({"proc"}, KJ_BIND_METHOD(*this, enableMountProc),
            "Mount /proc inside the sandbox.")
        .addOptionWithArg({'t', "title"}, KJ_BIND_METHOD(*this, setDevIsolateTitle), "<title>",
            "Set the generated app title. Default: \"Ad hoc Isolate App\".")
        .addOptionWithArg({"compatibility-date"},
            KJ_BIND_METHOD(*this, setDevIsolateCompatibilityDate), "<date>",
            "Set the workerd compatibility date. Default: 2025-01-01.")
        .addOptionWithArg({"text-binding"}, KJ_BIND_METHOD(*this, addDevIsolateTextBinding),
            "<name>=<text>",
            "Add a text binding to the generated isolate manifest.")
        .addOptionWithArg({"json-binding"}, KJ_BIND_METHOD(*this, addDevIsolateJsonBinding),
            "<name>=<json>",
            "Add a JSON binding to the generated isolate manifest.")
        .addOptionWithArg({"data-binding"}, KJ_BIND_METHOD(*this, addDevIsolateDataBinding),
            "<name>=<path>",
            "Add a binary data binding from a file to the generated isolate manifest.")
        .addOptionWithArg({"service-binding"}, KJ_BIND_METHOD(*this, addDevIsolateServiceBinding),
            "<name>=<service>",
            "Add a workerd service binding to the generated isolate manifest. For example: "
            "--service-binding LOOPBACK=main")
        .addOptionWithArg({"app-interface"}, KJ_BIND_METHOD(*this, addDevIsolateAppInterface),
            "<capnp-specifier>#<Interface>",
            "Advertise a schema-defined app capability through ViewInfo.matchRequests. For "
            "example: --app-interface capnp:./greeter.capnp#Greeter")
        .addOption({"print-manifest-json"}, KJ_BIND_METHOD(*this, enableDevIsolatePrintManifestJson),
            "Print the generated dynamic isolate manifest as JSON and exit without mounting or "
            "connecting to a Sandstorm server.")
        .addOptionWithArg({"print-generated-module"},
            KJ_BIND_METHOD(*this, setDevIsolatePrintGeneratedModule), "<specifier>",
            "Print a generated isolate support module by import specifier and exit.")
        .addOptionWithArg({"print-generated-declaration"},
            KJ_BIND_METHOD(*this, setDevIsolatePrintGeneratedDeclaration), "<specifier>",
            "Print a generated TypeScript declaration for a capnp: schema import and exit.")
        .expectArg("<worker.js>", KJ_BIND_METHOD(*this, setDevIsolateWorkerPath))
        .callAfterParsing(KJ_BIND_METHOD(*this, doDevIsolate))
        .build();
  }

  kj::MainBuilder::Validity setDevIsolateTitle(kj::StringPtr title) {
    if (title.size() == 0) {
      return "title must not be empty";
    }
    devIsolateTitle = kj::heapString(title);
    return true;
  }

  kj::MainBuilder::Validity setDevIsolateCompatibilityDate(kj::StringPtr date) {
    if (date.size() == 0) {
      return "compatibility date must not be empty";
    }
    devIsolateCompatibilityDate = kj::heapString(date);
    return true;
  }

  kj::MainBuilder::Validity enableDevIsolatePrintManifestJson() {
    if (devIsolatePrintGeneratedModule != nullptr ||
        devIsolatePrintGeneratedDeclaration != nullptr) {
      return "cannot use --print-manifest-json with generated module output options";
    }
    devIsolatePrintManifestJson = true;
    return true;
  }

  kj::MainBuilder::Validity setDevIsolatePrintGeneratedModule(kj::StringPtr specifier) {
    if (devIsolatePrintManifestJson || devIsolatePrintGeneratedDeclaration != nullptr) {
      return "cannot combine generated module output options";
    }
    if (specifier.size() == 0) {
      return "generated module specifier must not be empty";
    }
    devIsolatePrintGeneratedModule = kj::heapString(specifier);
    return true;
  }

  kj::MainBuilder::Validity setDevIsolatePrintGeneratedDeclaration(kj::StringPtr specifier) {
    if (devIsolatePrintManifestJson || devIsolatePrintGeneratedModule != nullptr) {
      return "cannot combine generated module output options";
    }
    if (specifier.size() == 0) {
      return "generated declaration specifier must not be empty";
    }
    devIsolatePrintGeneratedDeclaration = kj::heapString(specifier);
    return true;
  }

  bool devIsolateBindingNameExists(kj::StringPtr name) {
    if (name == "SANDSTORM_API" || name == "POWERBOX" || name == "STORAGE") {
      return true;
    }
    for (auto& binding: devIsolateTextBindings) {
      if (binding.name == name) return true;
    }
    for (auto& binding: devIsolateJsonBindings) {
      if (binding.name == name) return true;
    }
    for (auto& binding: devIsolateDataBindings) {
      if (binding.name == name) return true;
    }
    for (auto& binding: devIsolateServiceBindings) {
      if (binding.name == name) return true;
    }
    return false;
  }

  kj::Maybe<DevIsolateValueBinding> parseDevIsolateValueBinding(kj::StringPtr spec) {
    KJ_IF_MAYBE(equals, spec.findFirst('=')) {
      auto name = kj::heapString(spec.slice(0, *equals));
      auto value = kj::heapString(spec.slice(*equals + 1, spec.size()));
      if (name.size() == 0 || value.size() == 0 || devIsolateBindingNameExists(name)) {
        return nullptr;
      }
      return DevIsolateValueBinding {
        kj::mv(name),
        kj::mv(value),
      };
    }

    return nullptr;
  }

  kj::MainBuilder::Validity addDevIsolateTextBinding(kj::StringPtr spec) {
    KJ_IF_MAYBE(binding, parseDevIsolateValueBinding(spec)) {
      devIsolateTextBindings.add(kj::mv(*binding));
      return true;
    }

    return "text binding must be NAME=TEXT with a unique non-built-in name and non-empty value";
  }

  kj::MainBuilder::Validity addDevIsolateJsonBinding(kj::StringPtr spec) {
    KJ_IF_MAYBE(binding, parseDevIsolateValueBinding(spec)) {
      capnp::MallocMessageBuilder message;
      auto jsonValue = message.initRoot<capnp::JsonValue>();
      capnp::JsonCodec json;
      try {
        json.decode(binding->value, jsonValue);
      } catch (kj::Exception& exception) {
        return kj::str("json binding value is not valid JSON: ", exception.getDescription());
      }
      devIsolateJsonBindings.add(kj::mv(*binding));
      return true;
    }

    return "json binding must be NAME=JSON with a unique non-built-in name and non-empty value";
  }

  kj::MainBuilder::Validity addDevIsolateDataBinding(kj::StringPtr spec) {
    KJ_IF_MAYBE(binding, parseDevIsolateValueBinding(spec)) {
      if (access(binding->value.cStr(), R_OK) != 0) {
        return "data binding file not found or not readable";
      }
      char* resolved = realpath(binding->value.cStr(), nullptr);
      if (resolved == nullptr) {
        int error = errno;
        return kj::str("could not resolve data binding file path: ", strerror(error));
      }
      KJ_DEFER(free(resolved));
      binding->value = kj::heapString(resolved);
      devIsolateDataBindings.add(kj::mv(*binding));
      return true;
    }

    return "data binding must be NAME=PATH with a unique non-built-in name and non-empty path";
  }

  kj::MainBuilder::Validity addDevIsolateServiceBinding(kj::StringPtr spec) {
    KJ_IF_MAYBE(binding, parseDevIsolateValueBinding(spec)) {
      devIsolateServiceBindings.add(DevIsolateServiceBinding {
        kj::mv(binding->name),
        kj::mv(binding->value),
      });
      return true;
    }

    return "service binding must be NAME=SERVICE with a unique non-built-in name and non-empty service";
  }

  kj::MainBuilder::Validity addDevIsolateAppInterface(kj::StringPtr spec) {
    KJ_IF_MAYBE(appInterface, parseAppInterfaceSpec(spec)) {
      devIsolateAppInterfaces.add(kj::mv(*appInterface));
      return true;
    } else {
      return "app interface must be CAPNP-SPECIFIER#INTERFACE";
    }
  }

  kj::Maybe<DevIsolateAppInterface> parseAppInterfaceSpec(kj::StringPtr spec) {
    auto specStd = toStdString(spec);
    auto hash = specStd.rfind('#');
    if (hash == std::string::npos || hash == 0 || hash + 1 == specStd.size()) {
      return nullptr;
    }

    auto schemaSpecifier = kj::heapString(spec.slice(0, hash));
    if (!schemaSpecifier.startsWith("capnp:") && !schemaSpecifier.startsWith("capnp-es:")) {
      schemaSpecifier = kj::str("capnp:", schemaSpecifier);
    }

    return DevIsolateAppInterface {
      kj::mv(schemaSpecifier),
      kj::heapString(spec.slice(hash + 1, spec.size())),
    };
  }

  static kj::String currentWorkingDirectory() {
    char* cwd = getcwd(nullptr, 0);
    if (cwd == nullptr) {
      KJ_FAIL_SYSCALL("getcwd", errno);
    }
    KJ_DEFER(free(cwd));
    return kj::heapString(cwd);
  }

  static kj::String resolveCapnpAbiSchemaPath(
      kj::StringPtr rootDir, kj::StringPtr specifier) {
    kj::StringPtr pathSpecifier = specifier;
    if (specifier.startsWith("capnp-es:")) {
      KJ_FAIL_REQUIRE("`capnp-es:` ABI schema specifiers have been renamed; use `capnp:` "
          "or a plain .capnp path.", specifier);
    } else if (specifier.startsWith("capnp:")) {
      pathSpecifier = specifier.slice(strlen("capnp:"));
    }

    KJ_REQUIRE(pathSpecifier.endsWith(".capnp"),
        "Cap'n Proto ABI dump input must point to a .capnp schema.", specifier);

    if (pathSpecifier.startsWith("/sandstorm/")) {
      return resolveDevIsolateSandstormSchemaImport(pathSpecifier);
    }

    auto candidate = pathSpecifier.startsWith("/")
        ? kj::heapString(pathSpecifier)
        : kj::str(rootDir, '/', pathSpecifier);
    char* resolved = realpath(candidate.cStr(), nullptr);
    KJ_REQUIRE(resolved != nullptr, "Could not resolve Cap'n Proto ABI dump schema.",
        specifier, candidate, strerror(errno));
    KJ_DEFER(free(resolved));
    return kj::heapString(resolved);
  }

  ResolvedAppInterface resolveAppInterfaceId(
      kj::StringPtr rootDir, const DevIsolateAppInterface& appInterface) {
    auto importerDir = rootDir;
    kj::String resolvedPath = nullptr;
    if (appInterface.specifier.startsWith("capnp-es:")) {
      KJ_FAIL_REQUIRE("`capnp-es:` app interfaces have been renamed; use `capnp:`.",
          appInterface.specifier);
    } else if (appInterface.specifier.startsWith("capnp:")) {
      resolvedPath = resolveDevIsolateCapnpEsImport(importerDir, rootDir, appInterface.specifier);
    } else {
      KJ_FAIL_REQUIRE("Internal error: unsupported app interface schema specifier.",
          appInterface.specifier);
    }

    auto source = readAll(raiiOpen(resolvedPath, O_RDONLY | O_CLOEXEC));
    auto interfaces = scanCapnpInterfaces(source);
    auto metadataRoot = isPathUnderRoot(resolvedPath, rootDir)
        ? kj::heapString(rootDir)
        : dirnameForPath(resolvedPath);
    auto metadata = parseCapnpInterfaceMetadata(
        resolvedPath, metadataRoot, interfaces.asPtr());
    auto found = metadata.find(toStdString(appInterface.interfaceName));
    KJ_REQUIRE(found != metadata.end(),
        "Advertised app interface schema does not define the requested interface.",
        appInterface.specifier, appInterface.interfaceName);

    auto interfaceId = kj::StringPtr(found->second.interfaceId);
    KJ_REQUIRE(interfaceId.startsWith("0x"),
        "Internal error: expected 0x-prefixed interface ID.", interfaceId);
    uint64_t parsedInterfaceId = 0;
    KJ_IF_MAYBE(parsed, parseUInt64(kj::str(interfaceId.slice(2)), 16)) {
      parsedInterfaceId = *parsed;
    } else {
      KJ_FAIL_REQUIRE("Internal error: could not parse interface ID.", interfaceId);
    }

    return ResolvedAppInterface {
      kj::heapString(appInterface.specifier),
      kj::heapString(appInterface.interfaceName),
      parsedInterfaceId,
    };
  }

  static kj::String encodePackedPowerboxDescriptor(uint64_t interfaceId) {
    capnp::MallocMessageBuilder message;
    auto descriptor = message.initRoot<PowerboxDescriptor>();
    auto tag = descriptor.initTags(1)[0];
    tag.setId(interfaceId);

    kj::VectorOutputStream output;
    capnp::writePackedMessage(output, message);
    return kj::encodeBase64Url(output.getArray());
  }

  static void appendJsonQuoted(kj::Vector<char>& output, kj::StringPtr text) {
    output.add('"');
    for (auto c: text) {
      switch (c) {
        case '"':
          output.addAll(kj::StringPtr("\\\""));
          break;
        case '\\':
          output.addAll(kj::StringPtr("\\\\"));
          break;
        case '\b':
          output.addAll(kj::StringPtr("\\b"));
          break;
        case '\f':
          output.addAll(kj::StringPtr("\\f"));
          break;
        case '\n':
          output.addAll(kj::StringPtr("\\n"));
          break;
        case '\r':
          output.addAll(kj::StringPtr("\\r"));
          break;
        case '\t':
          output.addAll(kj::StringPtr("\\t"));
          break;
        default: {
          auto byte = static_cast<unsigned char>(c);
          if (byte < 0x20) {
            const char hex[] = "0123456789abcdef";
            output.addAll(kj::StringPtr("\\u00"));
            output.add(hex[(byte >> 4) & 0xf]);
            output.add(hex[byte & 0xf]);
          } else {
            output.add(c);
          }
          break;
        }
      }
    }
    output.add('"');
  }

  kj::String renderPowerboxDescriptor(const ResolvedAppInterface& appInterface) {
    auto packed = encodePackedPowerboxDescriptor(appInterface.interfaceId);
    switch (powerboxDescriptorOutputFormat) {
      case PowerboxDescriptorOutputFormat::BASE64URL:
        return kj::mv(packed);
      case PowerboxDescriptorOutputFormat::CAPNP:
        return kj::str("(tags = [(id = 0x", kj::hex(appInterface.interfaceId), ")])");
      case PowerboxDescriptorOutputFormat::JSON: {
        auto interfaceId = kj::str("0x", kj::hex(appInterface.interfaceId));
        kj::Vector<char> json;
        json.addAll(kj::StringPtr("{\n  \"type\": \"packedPowerboxDescriptor\",\n  "
            "\"descriptor\": "));
        appendJsonQuoted(json, packed);
        json.addAll(kj::StringPtr(",\n  \"interfaceId\": "));
        appendJsonQuoted(json, interfaceId);
        json.addAll(kj::StringPtr(",\n  \"interfaceName\": "));
        appendJsonQuoted(json, appInterface.interfaceName);
        json.addAll(kj::StringPtr(",\n  \"schema\": "));
        appendJsonQuoted(json, appInterface.specifier);
        json.addAll(kj::StringPtr("\n}"));
        json.add('\0');
        return kj::String(json.releaseAsArray());
      }
    }
    KJ_UNREACHABLE;
  }

  kj::MainBuilder::Validity setDevIsolateWorkerPath(kj::StringPtr path) {
    if (access(path.cStr(), R_OK) != 0) {
      return "worker module not found or not readable";
    }
    char* resolved = realpath(path.cStr(), nullptr);
    if (resolved == nullptr) {
      int error = errno;
      return kj::str("could not resolve worker module path: ", strerror(error));
    }
    KJ_DEFER(free(resolved));
    devIsolateWorkerPath = kj::heapString(resolved);
    return true;
  }

  kj::MainBuilder::Validity doDevIsolate() {
    KJ_REQUIRE(devIsolateWorkerPath != nullptr);
    auto rootDir = dirnameForPath(devIsolateWorkerPath);
    devIsolateSupportDir = writeDevIsolateSupportDir();
    KJ_DEFER(recursivelyDelete(devIsolateSupportDir));

    if (devIsolatePrintGeneratedModule != nullptr) {
      return printDevIsolateGeneratedModule();
    }
    if (devIsolatePrintGeneratedDeclaration != nullptr) {
      return printDevIsolateGeneratedDeclaration(rootDir);
    }

    if (devIsolatePrintManifestJson) {
      return printDevIsolateManifestJson();
    }

    auto generatedPkgdef = writeDevIsolatePkgdef(rootDir, devIsolateSupportDir);
    KJ_DEFER(unlink(generatedPkgdef.cStr()));

    auto arg = kj::str(generatedPkgdef, ":pkgdef");
    KJ_IF_MAYBE(error, setPackageDef(arg).getError()) {
      return kj::str(generatedPkgdef, ": ", *error);
    }

    return doDev();
  }

  kj::MainBuilder::Validity printDevIsolateManifestJson() {
    auto manifestBytes = buildDevIsolateManifestBytes();
    capnp::FlatArrayMessageReader reader(manifestBytes.asPtr());
    auto manifest = reader.getRoot<spk::Manifest>();

    capnp::JsonCodec json;
    json.setPrettyPrint(true);
    auto text = json.encode(manifest);
    kj::FdOutputStream(STDOUT_FILENO).write(text.begin(), text.size());
    kj::FdOutputStream(STDOUT_FILENO).write("\n", 1);
    context.exit();
    return true;
  }

  kj::MainBuilder::Validity printDevIsolateGeneratedModule() {
    if (devIsolatePrintGeneratedModule.startsWith("capnp-es:")) {
      return "`capnp-es:` isolate schema imports have been renamed; use `capnp:`";
    }

    auto modules = collectDevIsolateModules();
    for (auto& module: modules) {
      if (module.name == devIsolatePrintGeneratedModule) {
        KJ_REQUIRE(module.sourcePath.startsWith("__sandstorm_isolate_runtime/"),
            "Requested module is not generated isolate runtime support.", module.name,
            module.sourcePath);
        auto relativePath = module.sourcePath.slice(strlen("__sandstorm_isolate_runtime/"));
        auto path = kj::str(devIsolateSupportDir, "/", relativePath);
        auto content = readAll(raiiOpen(path, O_RDONLY | O_CLOEXEC));
        kj::FdOutputStream(STDOUT_FILENO).write(content.begin(), content.size());
        context.exit();
        return true;
      }
    }

    return kj::str("generated module not found: ", devIsolatePrintGeneratedModule);
  }

  kj::MainBuilder::Validity printDevIsolateGeneratedDeclaration(kj::StringPtr rootDir) {
    if (devIsolatePrintGeneratedDeclaration.startsWith("capnp-es:")) {
      return "`capnp-es:` isolate schema imports have been renamed; use `capnp:`";
    }
    if (!devIsolatePrintGeneratedDeclaration.startsWith("capnp:")) {
      return "generated declaration specifier must be a capnp: schema import";
    }

    auto resolvedPath = resolveDevIsolateCapnpEsImport(
        rootDir, rootDir, devIsolatePrintGeneratedDeclaration);
    auto content = generateDevIsolateCapnpEsOutput(
        resolvedPath, rootDir, DevIsolateCapnpEsOutputKind::DTS);
    kj::FdOutputStream(STDOUT_FILENO).write(content.begin(), content.size());
    context.exit();
    return true;
  }

  enum class DevIsolateModuleType {
    ES_MODULE,
    COMMON_JS,
    TEXT,
    JSON,
    DATA,
    WASM
  };

  struct DevIsolateModule {
    kj::String name;
    kj::String sourcePath;
    DevIsolateModuleType type;
  };

  kj::Vector<DevIsolateModule> collectDevIsolateModules() {
    auto rootDir = dirnameForPath(devIsolateWorkerPath);
    kj::Vector<DevIsolateModule> modules;
    std::set<std::string> seen;
    std::map<std::string, std::string> capnpEsImports;
    collectDevIsolateModule(
        devIsolateWorkerPath, rootDir, modules, seen, capnpEsImports);
    addDevIsolatePlatformCapnpEsModules(rootDir, modules, capnpEsImports);
    return modules;
  }

  void collectDevIsolateModule(kj::StringPtr path, kj::StringPtr rootDir,
                               kj::Vector<DevIsolateModule>& modules,
                               std::set<std::string>& seen,
                               std::map<std::string, std::string>& capnpEsImports) {
    char* resolved = realpath(path.cStr(), nullptr);
    KJ_REQUIRE(resolved != nullptr, "Could not resolve isolate module path.", path, strerror(errno));
    KJ_DEFER(free(resolved));
    auto realPath = kj::heapString(resolved);
    auto realPathStd = toStdString(realPath);
    if (!seen.insert(realPathStd).second) {
      return;
    }

    KJ_REQUIRE(isPathUnderRoot(realPath, rootDir),
        "Isolate dev imports must stay under the entrypoint directory.", realPath, rootDir);

    auto type = devIsolateModuleTypeForPath(realPath);
    auto name = moduleNameForDevIsolatePath(realPath, rootDir);
    auto sourcePath = devIsolateAppPackagePath(name);

    if (type == DevIsolateModuleType::ES_MODULE) {
      auto source = readAll(raiiOpen(realPath, O_RDONLY | O_CLOEXEC));
      auto imports = scanDevIsolateImports(source);
      modules.add(DevIsolateModule {
        kj::mv(name),
        kj::mv(sourcePath),
        type
      });

      auto importerDir = dirnameForPath(realPath);
      for (auto& specifier: imports) {
        if (isCapnpEsImport(specifier)) {
          KJ_FAIL_REQUIRE("`capnp-es:` isolate schema imports have been renamed; use `capnp:`.",
              specifier);
        } else if (isCapnpImport(specifier)) {
          auto resolvedImport = resolveDevIsolateCapnpEsImport(
              importerDir, rootDir, specifier);
          addDevIsolateCapnpEsModule(
              specifier, resolvedImport, rootDir, modules, capnpEsImports);
        } else if (isRelativeImport(specifier)) {
          auto resolvedImport = resolveDevIsolateImport(importerDir, rootDir, specifier);
          collectDevIsolateModule(
              resolvedImport, rootDir, modules, seen, capnpEsImports);
        }
      }
    } else {
      modules.add(DevIsolateModule {
        kj::mv(name),
        kj::mv(sourcePath),
        type
      });
    }
  }

  kj::String writeDevIsolatePkgdef(kj::StringPtr rootDir, kj::StringPtr supportDir) {
    auto appId = appIdForDevIsolate(devIsolateWorkerPath);
    kj::Vector<char> capnp;
    capnp.addAll(kj::StringPtr(
        "@0xf0fa7edd08cd0aa9;\n\n"
        "using Spk = import \"/sandstorm/package.capnp\";\n\n"));
    capnp.addAll(kj::StringPtr("const placeholderCommand :Spk.Manifest.Command = (\n"));
    capnp.addAll(kj::StringPtr(
        "  argv = [ \"workerd\", \"serve\", \"${SANDSTORM_ISOLATE_WORKERD_CONFIG}\", "
        "\"sandstormConfig\" ],\n"
        "  isolate = (\n"
        "    mainModule = "));
    appendCapnpText(capnp, "__sandstorm_dev_isolate_placeholder__.js");
    capnp.addAll(kj::StringPtr(",\n    compatibilityDate = "));
    appendCapnpText(capnp, devIsolateCompatibilityDate);
    capnp.addAll(kj::StringPtr(
        ",\n    compatibilityFlags = [],\n"
        "    modules = [\n"
        "      ( name = \"__sandstorm_dev_isolate_placeholder__.js\",\n"
        "        esModulePath = \"__sandstorm_isolate_runtime/placeholder.js\" )\n"
        "    ],\n"));
    capnp.addAll(kj::StringPtr(
        "    bindings = [\n"
        "      ( name = \"SANDSTORM_API\", sandstormApi = void ),\n"
        "      ( name = \"STORAGE\", storage = void )\n"
        "    ],\n"
        "    bridgeConfig = ( viewInfo = ( appTitle = (defaultText = "));
    appendCapnpText(capnp, devIsolateTitle);
    capnp.addAll(kj::StringPtr(
        ") ) )\n"
        "  )\n"
        ");\n\n"
        "const pkgdef :Spk.PackageDefinition = (\n"
        "  id = "));
    appendCapnpText(capnp, appId);
    capnp.addAll(kj::StringPtr(
        ",\n"
        "  manifest = (\n"
        "    appTitle = (defaultText = "));
    appendCapnpText(capnp, devIsolateTitle);
    capnp.addAll(kj::StringPtr(
        "),\n"
        "    appVersion = 0,\n"
        "    appMarketingVersion = (defaultText = \"dev\"),\n"
        "    actions = [\n"
        "      ( title = (defaultText = \"New Ad hoc Isolate App\"),\n"
        "        nounPhrase = (defaultText = \"instance\"),\n"
        "        command = .placeholderCommand )\n"
        "    ],\n"
        "    continueCommand = .placeholderCommand\n"
        "  ),\n"
        "  sourceMap = (\n"
        "    searchPath = [\n"
        "      ( packagePath = \"__sandstorm_dev_isolate_app\", sourcePath = "));
    appendCapnpText(capnp, rootDir);
    capnp.addAll(kj::StringPtr(" ),\n      ( packagePath = \"__sandstorm_isolate_runtime\", "
        "sourcePath = "));
    appendCapnpText(capnp, supportDir);
    capnp.addAll(kj::StringPtr(
        " )\n"
        "    ]\n"
        "  ),\n"
        "  alwaysInclude = [ \"sandstorm-manifest\", \"__sandstorm_isolate_runtime\" ]\n"
        ");\n"));
    capnp.add('\0');

    kj::String path = kj::heapString("/tmp/sandstorm-dev-isolate-XXXXXX");
    int fd;
    KJ_SYSCALL(fd = mkstemp(path.begin()), path);
    kj::AutoCloseFd autoFd(fd);
    kj::FdOutputStream(autoFd.get()).write(capnp.begin(), capnp.size() - 1);
    return path;
  }

  kj::String writeDevIsolateSupportDir() {
    kj::String path = kj::heapString("/tmp/sandstorm-dev-isolate-runtime-XXXXXX");
    KJ_REQUIRE(mkdtemp(path.begin()) != nullptr, "mkdtemp() failed", path, strerror(errno));
    KJ_SYSCALL(mkdir(kj::str(path, "/capnp-es").cStr(), 0700));
    KJ_SYSCALL(mkdir(kj::str(path, "/capnp-es/capnp").cStr(), 0700));
    KJ_SYSCALL(mkdir(kj::str(path, "/capnp-es/shared").cStr(), 0700));
    KJ_SYSCALL(mkdir(kj::str(path, "/capnp-es-generated").cStr(), 0700));
    writeDevIsolateSupportFile(path, "placeholder.js",
        "export default { fetch() { return new Response(\"dev isolate manifest not mounted\", "
        "{ status: 500 }); } };\n");
    writeDevIsolateSupportFile(path, "capnp.js", ISOLATE_CAPNP_HELPER_SOURCE);
    writeDevIsolateSupportFile(path, "api.js", ISOLATE_API_HELPER_SOURCE);
    writeDevIsolateSupportFile(
        path, "native-capnp-bridge.js", ISOLATE_NATIVE_CAPNP_BRIDGE_SOURCE);
    std::set<std::string> writtenCapnpEsRuntimePaths;
    for (auto& module: ISOLATE_CAPNP_ES_MODULES) {
      auto runtimePath = capnpEsRuntimePath(module.name);
      if (writtenCapnpEsRuntimePaths.insert(toStdString(runtimePath)).second) {
        writeDevIsolateSupportFile(path, runtimePath, module.source);
      }
    }
    return path;
  }

  kj::String capnpEsRuntimePath(kj::StringPtr moduleName) {
    if (moduleName == "@mnutt/capnp-es") {
      return kj::heapString("capnp-es/index.mjs");
    }
    if (moduleName == "@mnutt/capnp/rpc.mjs") {
      return kj::heapString("capnp-es/capnp/rpc.mjs");
    }

    kj::StringPtr capnpEsPrefix = "@mnutt/capnp-es/";
    if (moduleName.startsWith(capnpEsPrefix)) {
      auto relative = moduleName.slice(capnpEsPrefix.size());
      if (relative.endsWith(".mjs")) {
        return kj::str("capnp-es/", relative);
      }
      return kj::str("capnp-es/", relative, ".mjs");
    }

    kj::StringPtr sharedPrefix = "@mnutt/shared/";
    if (moduleName.startsWith(sharedPrefix)) {
      return kj::str("capnp-es/shared/", moduleName.slice(sharedPrefix.size()));
    }

    kj::StringPtr prefix = "@mnutt/";
    KJ_REQUIRE(moduleName.startsWith(prefix), "Unexpected capnp-es runtime module.", moduleName);
    return kj::str("capnp-es/", moduleName.slice(prefix.size()));
  }

  kj::String capnpEsSchemeRuntimeSpecifier(kj::StringPtr moduleName) {
    return kj::str("capnp:/", capnpEsRuntimePath(moduleName));
  }

  kj::String capnpEsSchemeRelativeRuntimeSpecifier(kj::StringPtr moduleName) {
    return kj::str("capnp:./", capnpEsRuntimePath(moduleName));
  }

  void writeDevIsolateSupportFile(kj::StringPtr dir, kj::StringPtr name, kj::StringPtr content) {
    auto path = kj::str(dir, "/", name);
    kj::FdOutputStream(raiiOpen(path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600))
        .write(content.begin(), content.size());
  }

  void writeDevIsolateGeneratedSupportFile(
      kj::StringPtr dir, kj::StringPtr name, kj::StringPtr content) {
    auto path = kj::str(dir, "/", name);
    mkdirParentDirs(path);
    kj::FdOutputStream(raiiOpen(path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600))
        .write(content.begin(), content.size());
  }

  static void mkdirParentDirs(kj::StringPtr path) {
    auto pathStd = toStdString(path);
    size_t pos = 1;
    for (;;) {
      auto slash = pathStd.find('/', pos);
      if (slash == std::string::npos) {
        return;
      }
      auto parent = pathStd.substr(0, slash);
      if (mkdir(parent.c_str(), 0700) != 0) {
        KJ_REQUIRE(errno == EEXIST, "Could not create generated isolate runtime directory.",
            parent, strerror(errno));
      }
      pos = slash + 1;
    }
  }

  kj::Array<capnp::word> buildDevIsolateManifestBytes() {
    auto modules = collectDevIsolateModules();

    capnp::MallocMessageBuilder message;
    auto manifest = message.initRoot<spk::Manifest>();
    manifest.initAppTitle().setDefaultText(devIsolateTitle);
    manifest.setAppVersion(0);
    manifest.initAppMarketingVersion().setDefaultText("dev");

    initDevIsolateCommand(manifest.initContinueCommand(), modules.asPtr());

    auto actions = manifest.initActions(1);
    auto action = actions[0];
    action.initTitle().setDefaultText("New Ad hoc Isolate App");
    action.initNounPhrase().setDefaultText("instance");
    initDevIsolateCommand(action.initCommand(), modules.asPtr());

    return capnp::messageToFlatArray(message);
  }

  void initDevIsolateCommand(spk::Manifest::Command::Builder command,
                             kj::ArrayPtr<DevIsolateModule> modules) {
    KJ_REQUIRE(modules.size() > 0);

    auto argv = command.initArgv(4);
    argv.set(0, "workerd");
    argv.set(1, "serve");
    argv.set(2, "${SANDSTORM_ISOLATE_WORKERD_CONFIG}");
    argv.set(3, "sandstormConfig");

    auto isolate = command.initIsolate();
    isolate.setMainModule(modules[0].name);
    isolate.setCompatibilityDate(devIsolateCompatibilityDate);
    isolate.initCompatibilityFlags(0);

    auto moduleList = isolate.initModules(
        modules.size() + 3 + (4 * ISOLATE_CAPNP_ES_MODULE_COUNT));
    for (auto i: kj::indices(modules)) {
      auto module = moduleList[i];
      module.setName(modules[i].name);
      switch (modules[i].type) {
        case DevIsolateModuleType::ES_MODULE:
          module.setEsModulePath(modules[i].sourcePath);
          break;
        case DevIsolateModuleType::COMMON_JS:
          module.setCommonJsModulePath(modules[i].sourcePath);
          break;
        case DevIsolateModuleType::TEXT:
          module.setTextPath(modules[i].sourcePath);
          break;
        case DevIsolateModuleType::JSON:
          module.setJsonPath(modules[i].sourcePath);
          break;
        case DevIsolateModuleType::DATA:
          module.setDataPath(modules[i].sourcePath);
          break;
        case DevIsolateModuleType::WASM:
          module.setWasmPath(modules[i].sourcePath);
          break;
      }
    }
    auto helperIndex = modules.size();
    auto helperModule = moduleList[helperIndex++];
    helperModule.setName("sandstorm:api");
    helperModule.setEsModulePath("__sandstorm_isolate_runtime/api.js");
    auto capnpHelperModule = moduleList[helperIndex++];
    capnpHelperModule.setName("sandstorm:capnp");
    capnpHelperModule.setEsModulePath("__sandstorm_isolate_runtime/capnp.js");
    auto nativeCapnpBridgeModule = moduleList[helperIndex++];
    nativeCapnpBridgeModule.setName("sandstorm:native-capnp-bridge");
    nativeCapnpBridgeModule.setEsModulePath("__sandstorm_isolate_runtime/native-capnp-bridge.js");
    for (auto& runtimeModule: ISOLATE_CAPNP_ES_MODULES) {
      auto module = moduleList[helperIndex++];
      module.setName(runtimeModule.name);
      module.setEsModulePath(kj::str(
          "__sandstorm_isolate_runtime/", capnpEsRuntimePath(runtimeModule.name)));
    }
    for (auto& runtimeModule: ISOLATE_CAPNP_ES_MODULES) {
      auto module = moduleList[helperIndex++];
      module.setName(capnpEsSchemeRuntimeSpecifier(runtimeModule.name));
      module.setEsModulePath(kj::str(
          "__sandstorm_isolate_runtime/", capnpEsRuntimePath(runtimeModule.name)));
    }
    for (auto& runtimeModule: ISOLATE_CAPNP_ES_MODULES) {
      auto module = moduleList[helperIndex++];
      module.setName(capnpEsRuntimePath(runtimeModule.name));
      module.setEsModulePath(kj::str(
          "__sandstorm_isolate_runtime/", capnpEsRuntimePath(runtimeModule.name)));
    }
    for (auto& runtimeModule: ISOLATE_CAPNP_ES_MODULES) {
      auto module = moduleList[helperIndex++];
      module.setName(capnpEsSchemeRelativeRuntimeSpecifier(runtimeModule.name));
      module.setEsModulePath(kj::str(
          "__sandstorm_isolate_runtime/", capnpEsRuntimePath(runtimeModule.name)));
    }
    auto bindings = isolate.initBindings(
        3 + devIsolateTextBindings.size() + devIsolateJsonBindings.size() +
        devIsolateDataBindings.size() + devIsolateServiceBindings.size());
    bindings[0].setName("SANDSTORM_API");
    bindings[0].setSandstormApi();
    bindings[1].setName("POWERBOX");
    bindings[1].setPowerbox();
    bindings[2].setName("STORAGE");
    bindings[2].setStorage();
    size_t bindingIndex = 3;
    for (auto i: kj::indices(devIsolateTextBindings)) {
      auto binding = bindings[bindingIndex++];
      binding.setName(devIsolateTextBindings[i].name);
      binding.setText(devIsolateTextBindings[i].value);
    }
    for (auto i: kj::indices(devIsolateJsonBindings)) {
      auto binding = bindings[bindingIndex++];
      binding.setName(devIsolateJsonBindings[i].name);
      binding.setJson(devIsolateJsonBindings[i].value);
    }
    for (auto i: kj::indices(devIsolateDataBindings)) {
      auto binding = bindings[bindingIndex++];
      binding.setName(devIsolateDataBindings[i].name);
      auto data = readAll(raiiOpen(devIsolateDataBindings[i].value, O_RDONLY | O_CLOEXEC));
      binding.setData(data.asBytes());
    }
    for (auto i: kj::indices(devIsolateServiceBindings)) {
      auto binding = bindings[bindingIndex++];
      binding.setName(devIsolateServiceBindings[i].name);
      binding.setService(devIsolateServiceBindings[i].service);
    }

    initDevIsolateBridgeConfig(isolate.initBridgeConfig());
  }

  void initDevIsolateBridgeConfig(spk::BridgeConfig::Builder bridgeConfig) {
    auto viewInfo = bridgeConfig.initViewInfo();
    viewInfo.initAppTitle().setDefaultText(devIsolateTitle);

    if (devIsolateAppInterfaces.size() == 0) {
      return;
    }

    auto rootDir = dirnameForPath(devIsolateWorkerPath);
    auto matchRequests = viewInfo.initMatchRequests(devIsolateAppInterfaces.size());
    for (auto i: kj::indices(devIsolateAppInterfaces)) {
      auto tag = matchRequests[i].initTags(1)[0];
      tag.setId(resolveAppInterfaceId(rootDir, devIsolateAppInterfaces[i]).interfaceId);
    }
  }

  kj::String appIdForDevIsolate(kj::StringPtr workerPath) {
    byte digest[crypto_hash_sha256_BYTES];
    crypto_hash_sha256_state state;
    KJ_ASSERT(crypto_hash_sha256_init(&state) == 0);
    kj::StringPtr prefix = "sandstorm-dev-isolate:";
    KJ_ASSERT(crypto_hash_sha256_update(&state,
        reinterpret_cast<const unsigned char*>(prefix.begin()), prefix.size()) == 0);
    KJ_ASSERT(crypto_hash_sha256_update(&state,
        reinterpret_cast<const unsigned char*>(workerPath.begin()), workerPath.size()) == 0);
    KJ_ASSERT(crypto_hash_sha256_final(&state, digest) == 0);
    return appIdString(kj::arrayPtr(digest, crypto_sign_PUBLICKEYBYTES));
  }

  static std::string toStdString(kj::StringPtr text) {
    return std::string(text.begin(), text.size());
  }

  static kj::String dirnameForPath(kj::StringPtr path) {
    auto pathStd = toStdString(path);
    auto slash = pathStd.rfind('/');
    if (slash == std::string::npos) {
      return kj::heapString(".");
    } else if (slash == 0) {
      return kj::heapString("/");
    } else {
      return kj::heapString(pathStd.substr(0, slash).c_str());
    }
  }

  static bool isPathUnderRoot(kj::StringPtr path, kj::StringPtr rootDir) {
    auto pathStd = toStdString(path);
    auto rootStd = toStdString(rootDir);
    if (rootStd == "/") {
      return pathStd.size() > 1 && pathStd[0] == '/';
    }
    return pathStd.size() > rootStd.size() + 1 &&
        pathStd.compare(0, rootStd.size(), rootStd) == 0 &&
        pathStd[rootStd.size()] == '/';
  }

  static kj::String moduleNameForDevIsolatePath(kj::StringPtr path, kj::StringPtr rootDir) {
    auto pathStd = toStdString(path);
    auto rootStd = toStdString(rootDir);
    KJ_REQUIRE(isPathUnderRoot(path, rootDir), "Module path is outside isolate dev root.",
        path, rootDir);
    auto offset = rootStd == "/" ? 1 : rootStd.size() + 1;
    return kj::heapString(pathStd.substr(offset).c_str());
  }

  static kj::String devIsolateAppPackagePath(kj::StringPtr moduleName) {
    return kj::str("__sandstorm_dev_isolate_app/", moduleName);
  }

  static bool isRelativeImport(kj::StringPtr specifier) {
    return specifier.startsWith("./") || specifier.startsWith("../");
  }

  static bool isCapnpImport(kj::StringPtr specifier) {
    return specifier.startsWith("capnp:");
  }

  static bool isCapnpEsImport(kj::StringPtr specifier) {
    return specifier.startsWith("capnp-es:");
  }

  static kj::String resolveDevIsolateImport(
      kj::StringPtr importerDir, kj::StringPtr rootDir, kj::StringPtr specifier) {
    KJ_REQUIRE(specifier.findFirst('?') == nullptr && specifier.findFirst('#') == nullptr,
        "Isolate dev imports do not currently support query strings or fragments.", specifier);

    auto candidate = kj::str(importerDir, '/', specifier);
    char* resolved = realpath(candidate.cStr(), nullptr);
    KJ_REQUIRE(resolved != nullptr, "Could not resolve isolate import.", specifier, candidate,
        strerror(errno));
    KJ_DEFER(free(resolved));
    auto resolvedPath = kj::heapString(resolved);
    KJ_REQUIRE(isPathUnderRoot(resolvedPath, rootDir),
        "Isolate dev imports must stay under the entrypoint directory.", specifier, resolvedPath);
    return resolvedPath;
  }

  static kj::String resolveDevIsolateCapnpEsImport(
      kj::StringPtr importerDir, kj::StringPtr rootDir, kj::StringPtr specifier) {
    KJ_REQUIRE(specifier.startsWith("capnp:"), "Internal error: expected capnp import.",
        specifier);
    auto pathSpecifier = specifier.slice(strlen("capnp:"));
    KJ_REQUIRE(pathSpecifier.endsWith(".capnp"),
        "`capnp:` isolate imports must point to a .capnp schema.", specifier);

    if (pathSpecifier.startsWith("/sandstorm/")) {
      return resolveDevIsolateSandstormSchemaImport(pathSpecifier);
    }

    KJ_REQUIRE(isRelativeImport(pathSpecifier),
        "`capnp:` isolate imports must use a relative schema path or /sandstorm schema path.",
        specifier);
    return resolveDevIsolateImport(importerDir, rootDir, pathSpecifier);
  }

  static DevIsolateModuleType devIsolateModuleTypeForPath(kj::StringPtr path) {
    if (path.endsWith(".js") || path.endsWith(".mjs")) {
      return DevIsolateModuleType::ES_MODULE;
    } else if (path.endsWith(".cjs")) {
      return DevIsolateModuleType::COMMON_JS;
    } else if (path.endsWith(".json")) {
      return DevIsolateModuleType::JSON;
    } else if (path.endsWith(".txt") || path.endsWith(".text")) {
      return DevIsolateModuleType::TEXT;
    } else {
      KJ_FAIL_REQUIRE("Unsupported isolate dev module extension. Supported: .js, .mjs, .cjs, "
          ".json, .txt, .text", path);
    }
  }

  void addDevIsolateCapnpEsModule(
      kj::StringPtr specifier, kj::StringPtr resolvedPath, kj::StringPtr rootDir,
      kj::Vector<DevIsolateModule>& modules,
      std::map<std::string, std::string>& capnpEsImports) {
    auto specifierStd = toStdString(specifier);
    auto resolvedStd = toStdString(resolvedPath);
    auto existing = capnpEsImports.find(specifierStd);
    if (existing != capnpEsImports.end()) {
      KJ_REQUIRE(existing->second == resolvedStd,
          "`capnp:` isolate import specifier resolves to multiple schemas. "
          "Use distinct import specifiers until import rewriting is implemented.",
          specifier, existing->second, resolvedPath);
      return;
    }
    capnpEsImports.insert(std::make_pair(specifierStd, resolvedStd));

    KJ_REQUIRE(devIsolateSupportDir != nullptr,
        "`capnp:` isolate imports require the generated dev-isolate support directory.");

    auto source = readAll(raiiOpen(resolvedPath, O_RDONLY | O_CLOEXEC));
    auto schemaImports = scanCapnpImports(source);
    auto importerDir = dirnameForPath(resolvedPath);
    for (auto& schemaImport: schemaImports) {
      if (isDevIsolateCapnpEsRuntimeSchemaImport(schemaImport.specifier)) {
        continue;
      }
      auto importedPath = resolveDevIsolateCapnpEsSchemaImport(
          importerDir, rootDir, schemaImport.specifier);
      auto importedSpecifier = devIsolateCapnpEsSpecifierForSchemaImport(
          specifier, importedPath, rootDir, schemaImport.specifier);
      addDevIsolateCapnpEsModule(
          importedSpecifier, importedPath, rootDir, modules, capnpEsImports);
    }

    auto runtimePath = devIsolateCapnpEsRuntimePath(specifier, resolvedPath, rootDir);
    auto content = generateDevIsolateCapnpEsOutput(
        resolvedPath, rootDir, DevIsolateCapnpEsOutputKind::JS);
    writeDevIsolateGeneratedSupportFile(devIsolateSupportDir, runtimePath, content);

    modules.add(DevIsolateModule {
      kj::heapString(specifier),
      kj::str("__sandstorm_isolate_runtime/", runtimePath),
      DevIsolateModuleType::ES_MODULE
    });
  }

  void addDevIsolatePlatformCapnpEsModules(
      kj::StringPtr rootDir, kj::Vector<DevIsolateModule>& modules,
      std::map<std::string, std::string>& capnpEsImports) {
    auto compilerModule = getenv("SANDSTORM_CAPNP_ES_COMPILER_MODULE");
    if (compilerModule == nullptr || strlen(compilerModule) == 0) {
      return;
    }

    kj::StringPtr bridgeSpecifier = "capnp:/sandstorm/isolate-native-capnp-bridge.capnp";
    auto bridgePath = resolveDevIsolateCapnpEsImport(rootDir, rootDir, bridgeSpecifier);
    addDevIsolateCapnpEsModule(bridgeSpecifier, bridgePath, rootDir, modules, capnpEsImports);
  }

  static kj::String resolveDevIsolateCapnpSchemaImport(
      kj::StringPtr importerDir, kj::StringPtr rootDir, kj::StringPtr specifier) {
    KJ_REQUIRE(isRelativeImport(specifier),
        "`capnp:` isolate schema imports must use relative paths for now.", specifier);
    KJ_REQUIRE(specifier.endsWith(".capnp"),
        "`capnp:` isolate schema imports must point to .capnp files.", specifier);
    return resolveDevIsolateImport(importerDir, rootDir, specifier);
  }

  static bool isDevIsolateCapnpEsRuntimeSchemaImport(kj::StringPtr specifier) {
    return specifier.startsWith("/capnp/");
  }

  static bool isDevIsolateLocalCapnpSchemaImport(kj::StringPtr specifier) {
    return !specifier.startsWith("/") && specifier.findFirst(':') == nullptr;
  }

  struct DevCapnpImport {
    kj::String alias;
    kj::String specifier;
  };

  static kj::String resolveDevIsolateSandstormSchemaImport(kj::StringPtr specifier) {
    KJ_REQUIRE(specifier.startsWith("/sandstorm/"),
        "`capnp:` absolute schema imports must use /sandstorm or /capnp.",
        specifier);
    KJ_REQUIRE(specifier.endsWith(".capnp"),
        "`capnp:` isolate schema imports must point to .capnp files.", specifier);

    auto candidate = kj::str("src", specifier);
    char* resolved = realpath(candidate.cStr(), nullptr);
    KJ_REQUIRE(resolved != nullptr, "Could not resolve Sandstorm schema import.",
        specifier, candidate, strerror(errno));
    KJ_DEFER(free(resolved));
    return kj::heapString(resolved);
  }

  static kj::String resolveDevIsolateCapnpEsSchemaImport(
      kj::StringPtr importerDir, kj::StringPtr rootDir, kj::StringPtr specifier) {
    if (specifier.startsWith("/sandstorm/")) {
      return resolveDevIsolateSandstormSchemaImport(specifier);
    }

    KJ_REQUIRE(isDevIsolateLocalCapnpSchemaImport(specifier),
        "`capnp:` isolate schema imports must use local paths, /sandstorm, or /capnp.",
        specifier);
    KJ_REQUIRE(specifier.endsWith(".capnp"),
        "`capnp:` isolate schema imports must point to .capnp files.", specifier);

    auto candidate = kj::str(importerDir, '/', specifier);
    char* resolved = realpath(candidate.cStr(), nullptr);
    KJ_REQUIRE(resolved != nullptr, "Could not resolve capnp schema import.",
        specifier, candidate, strerror(errno));
    KJ_DEFER(free(resolved));
    auto resolvedPath = kj::heapString(resolved);
    if (isPathUnderRoot(resolvedPath, rootDir)) {
      return kj::mv(resolvedPath);
    }

    char* sandstormRootRaw = realpath("src/sandstorm", nullptr);
    KJ_REQUIRE(sandstormRootRaw != nullptr, "Could not resolve Sandstorm schema root.",
        strerror(errno));
    KJ_DEFER(free(sandstormRootRaw));
    auto sandstormRoot = kj::heapString(sandstormRootRaw);
    KJ_REQUIRE(isPathUnderRoot(resolvedPath, sandstormRoot),
        "`capnp:` isolate schema imports must stay under the entrypoint directory or "
        "Sandstorm's own schema tree.",
        specifier, resolvedPath);
    return kj::mv(resolvedPath);
  }

  static kj::String devIsolateCapnpSpecifierForPath(kj::StringPtr resolvedPath,
                                                    kj::StringPtr rootDir) {
    auto moduleName = moduleNameForDevIsolatePath(resolvedPath, rootDir);
    return kj::str("capnp:./", moduleName);
  }

  static kj::String devIsolateCapnpEsSpecifierForPath(kj::StringPtr resolvedPath,
                                                      kj::StringPtr rootDir) {
    auto moduleName = moduleNameForDevIsolatePath(resolvedPath, rootDir);
    return kj::str("capnp:./", moduleName);
  }

  static kj::String devIsolateCapnpEsSpecifierForSchemaImport(
      kj::StringPtr importerSpecifier, kj::StringPtr resolvedPath, kj::StringPtr rootDir,
      kj::StringPtr importSpecifier) {
    (void)resolvedPath;
    (void)rootDir;
    if (importSpecifier.startsWith("/sandstorm/")) {
      return kj::str("capnp:", importSpecifier);
    }

    KJ_REQUIRE(importerSpecifier.startsWith("capnp:"),
        "Internal error: expected capnp schema specifier.", importerSpecifier);
    auto importerPath = importerSpecifier.slice(strlen("capnp:"));
    auto slash = toStdString(importerPath).rfind('/');
    auto importerDir = slash == std::string::npos ? kj::heapString("") :
        kj::str(importerPath.slice(0, slash + 1));
    return kj::str("capnp:",
        normalizeDevIsolateSpecifierPath(kj::str(importerDir, importSpecifier)));
  }

  static kj::String devIsolateCapnpEsRuntimePath(
      kj::StringPtr specifier, kj::StringPtr resolvedPath, kj::StringPtr rootDir) {
    if (specifier.startsWith("capnp:/")) {
      auto schemaPath = specifier.slice(strlen("capnp:/"));
      KJ_REQUIRE(schemaPath.endsWith(".capnp"), "Internal error: expected .capnp module.",
          specifier);
      return kj::str("capnp-es-generated/",
          schemaPath.slice(0, schemaPath.size() - strlen(".capnp")), ".js");
    }

    auto moduleName = moduleNameForDevIsolatePath(resolvedPath, rootDir);
    KJ_REQUIRE(moduleName.endsWith(".capnp"), "Internal error: expected .capnp module.",
        moduleName);
    return kj::str("capnp-es-generated/",
        moduleName.slice(0, moduleName.size() - strlen(".capnp")), ".js");
  }

  static kj::String normalizeDevIsolatePath(kj::StringPtr path) {
    auto pathStd = toStdString(path);
    std::vector<std::string> parts;
    bool absolute = !pathStd.empty() && pathStd[0] == '/';
    size_t start = 0;
    while (start <= pathStd.size()) {
      auto slash = pathStd.find('/', start);
      auto end = slash == std::string::npos ? pathStd.size() : slash;
      auto part = pathStd.substr(start, end - start);
      if (part.empty() || part == ".") {
        // Skip.
      } else if (part == "..") {
        KJ_REQUIRE(!parts.empty(), "Schema import escaped its root.", path);
        parts.pop_back();
      } else {
        parts.push_back(part);
      }
      if (slash == std::string::npos) break;
      start = slash + 1;
    }

    std::string normalized = absolute ? "/" : "";
    for (size_t i = 0; i < parts.size(); ++i) {
      if (i > 0) normalized += "/";
      normalized += parts[i];
    }
    return kj::heapString(normalized.c_str());
  }

  static kj::String normalizeDevIsolateSpecifierPath(kj::StringPtr path) {
    auto pathStd = toStdString(path);
    std::vector<std::string> parts;
    uint leadingParents = 0;
    bool absolute = !pathStd.empty() && pathStd[0] == '/';
    size_t start = 0;
    while (start <= pathStd.size()) {
      auto slash = pathStd.find('/', start);
      auto end = slash == std::string::npos ? pathStd.size() : slash;
      auto part = pathStd.substr(start, end - start);
      if (part.empty() || part == ".") {
        // Skip.
      } else if (part == "..") {
        if (!parts.empty()) {
          parts.pop_back();
        } else {
          KJ_REQUIRE(!absolute, "Schema import escaped its root.", path);
          ++leadingParents;
        }
      } else {
        parts.push_back(part);
      }
      if (slash == std::string::npos) break;
      start = slash + 1;
    }

    std::string normalized;
    if (absolute) {
      normalized = "/";
    } else if (leadingParents == 0) {
      normalized = "./";
    } else {
      for (uint i = 0; i < leadingParents; ++i) {
        normalized += "../";
      }
    }

    for (size_t i = 0; i < parts.size(); ++i) {
      if ((absolute && i > 0) || (!absolute && normalized.size() > 0 &&
          normalized[normalized.size() - 1] != '/')) {
        normalized += "/";
      }
      normalized += parts[i];
    }
    return kj::heapString(normalized.c_str());
  }

  static kj::String devIsolateCapnpGeneratedFileName(kj::StringPtr resolvedPath) {
    byte digest[crypto_hash_sha256_BYTES];
    crypto_hash_sha256_state state;
    KJ_ASSERT(crypto_hash_sha256_init(&state) == 0);
    kj::StringPtr prefix = "sandstorm-dev-isolate-capnp:";
    KJ_ASSERT(crypto_hash_sha256_update(&state,
        reinterpret_cast<const unsigned char*>(prefix.begin()), prefix.size()) == 0);
    KJ_ASSERT(crypto_hash_sha256_update(&state,
        reinterpret_cast<const unsigned char*>(resolvedPath.begin()), resolvedPath.size()) == 0);
    KJ_ASSERT(crypto_hash_sha256_final(&state, digest) == 0);
    auto hex = kj::encodeHex(kj::arrayPtr(digest, 16));
    return kj::str(hex, ".js");
  }

  static kj::String capnpInterfaceIdString(uint64_t id) {
    char buffer[19];
    snprintf(buffer, sizeof(buffer), "0x%016" PRIx64, id);
    return kj::heapString(buffer);
  }

  static bool isJsIdentifierStart(char c) {
    return isalpha(static_cast<unsigned char>(c)) || c == '_' || c == '$';
  }

  static bool isJsIdentifierPart(char c) {
    return isalnum(static_cast<unsigned char>(c)) || c == '_' || c == '$';
  }

  static bool isJsExportIdentifier(kj::StringPtr name) {
    if (name.size() == 0 || !isJsIdentifierStart(name[0])) {
      return false;
    }
    for (char c: name.slice(1)) {
      if (!isJsIdentifierPart(c)) {
        return false;
      }
    }
    return true;
  }

  static void appendJsString(kj::Vector<char>& output, kj::StringPtr text) {
    output.add('"');
    for (char c: text) {
      switch (c) {
        case '"': output.addAll(kj::StringPtr("\\\"")); break;
        case '\\': output.addAll(kj::StringPtr("\\\\")); break;
        case '\n': output.addAll(kj::StringPtr("\\n")); break;
        case '\r': output.addAll(kj::StringPtr("\\r")); break;
        case '\t': output.addAll(kj::StringPtr("\\t")); break;
        default:
          output.add(static_cast<unsigned char>(c) < 0x20 ? ' ' : c);
          break;
      }
    }
    output.add('"');
  }

  static void skipCapnpString(std::string const& source, size_t& pos) {
    char quote = source[pos++];
    while (pos < source.size()) {
      char c = source[pos++];
      if (c == '\\' && pos < source.size()) {
        ++pos;
      } else if (c == quote) {
        break;
      }
    }
  }

  static kj::Maybe<kj::String> parseCapnpString(std::string const& source, size_t& pos) {
    if (pos >= source.size() || (source[pos] != '"' && source[pos] != '\'')) {
      return nullptr;
    }

    char quote = source[pos++];
    std::string value;
    while (pos < source.size()) {
      char c = source[pos++];
      if (c == '\\' && pos < source.size()) {
        value.push_back(source[pos++]);
      } else if (c == quote) {
        return kj::heapString(value.c_str());
      } else {
        value.push_back(c);
      }
    }
    return nullptr;
  }

  static void skipCapnpWhitespaceAndComments(std::string const& source, size_t& pos) {
    for (;;) {
      while (pos < source.size() && isspace(static_cast<unsigned char>(source[pos]))) {
        ++pos;
      }
      if (pos < source.size() && source[pos] == '#') {
        while (pos < source.size() && source[pos] != '\n') {
          ++pos;
        }
      } else if (pos + 1 < source.size() && source[pos] == '/' && source[pos + 1] == '/') {
        pos += 2;
        while (pos < source.size() && source[pos] != '\n') {
          ++pos;
        }
      } else if (pos + 1 < source.size() && source[pos] == '/' && source[pos + 1] == '*') {
        pos += 2;
        while (pos + 1 < source.size()) {
          if (source[pos] == '*' && source[pos + 1] == '/') {
            pos += 2;
            break;
          }
          ++pos;
        }
      } else {
        return;
      }
    }
  }

  static kj::Maybe<kj::String> scanCapnpIdentifier(std::string const& source, size_t& pos) {
    skipCapnpWhitespaceAndComments(source, pos);
    if (pos >= source.size() || !isalpha(static_cast<unsigned char>(source[pos]))) {
      return nullptr;
    }

    auto start = pos++;
    while (pos < source.size() &&
           (isalnum(static_cast<unsigned char>(source[pos])) || source[pos] == '_')) {
      ++pos;
    }
    return kj::heapString(source.substr(start, pos - start).c_str());
  }

  static kj::Maybe<kj::String> scanCapnpTypeName(std::string const& source, size_t& pos) {
    skipCapnpWhitespaceAndComments(source, pos);
    while (pos < source.size() && source[pos] == '.') {
      ++pos;
    }

    KJ_IF_MAYBE(firstPart, scanCapnpIdentifier(source, pos)) {
      std::string typeName = toStdString(*firstPart);
      for (;;) {
        skipCapnpWhitespaceAndComments(source, pos);
        if (pos >= source.size() || source[pos] != '.') {
          break;
        }
        ++pos;
        KJ_IF_MAYBE(nextPart, scanCapnpIdentifier(source, pos)) {
          typeName += ".";
          typeName += toStdString(*nextPart);
        } else {
          break;
        }
      }
      return kj::heapString(typeName.c_str());
    }

    return nullptr;
  }

  static kj::Vector<DevCapnpImport> scanCapnpImports(kj::StringPtr schemaSource) {
    auto source = toStdString(schemaSource);
    kj::Vector<DevCapnpImport> imports;
    size_t pos = 0;
    while (pos < source.size()) {
      skipCapnpWhitespaceAndComments(source, pos);
      if (pos >= source.size()) break;

      if (source[pos] == '"' || source[pos] == '\'') {
        skipCapnpString(source, pos);
      } else if (isalpha(static_cast<unsigned char>(source[pos]))) {
        auto start = pos++;
        while (pos < source.size() &&
               (isalnum(static_cast<unsigned char>(source[pos])) || source[pos] == '_')) {
          ++pos;
        }

        if (source.compare(start, pos - start, "using") == 0) {
          auto usingPos = pos;
          KJ_IF_MAYBE(alias, scanCapnpIdentifier(source, usingPos)) {
            skipCapnpWhitespaceAndComments(source, usingPos);
            if (usingPos < source.size() && source[usingPos] == '=') {
              ++usingPos;
              KJ_IF_MAYBE(importKeyword, scanCapnpIdentifier(source, usingPos)) {
                if (*importKeyword == "import") {
                  skipCapnpWhitespaceAndComments(source, usingPos);
                  KJ_IF_MAYBE(specifier, parseCapnpString(source, usingPos)) {
                    imports.add(DevCapnpImport {
                      kj::mv(*alias),
                      kj::mv(*specifier),
                    });
                    pos = usingPos;
                  }
                }
              }
            }
          }
        }
      } else {
        ++pos;
      }
    }

    return imports;
  }

  struct DevCapnpInterface {
    kj::String name;
    struct Field {
      kj::String name;
      kj::String type;
    };
    struct Method {
      kj::String name;
      kj::Vector<Field> params;
      kj::Vector<Field> results;
    };
    kj::Vector<Method> methods;
  };

  static size_t scanCapnpMethodEnd(std::string const& source, size_t pos) {
    uint parenDepth = 0;
    uint bracketDepth = 0;
    while (pos < source.size()) {
      if (source[pos] == '"' || source[pos] == '\'') {
        skipCapnpString(source, pos);
      } else if (source[pos] == '#') {
        while (pos < source.size() && source[pos] != '\n') {
          ++pos;
        }
      } else if (pos + 1 < source.size() && source[pos] == '/' && source[pos + 1] == '/') {
        pos += 2;
        while (pos < source.size() && source[pos] != '\n') {
          ++pos;
        }
      } else if (pos + 1 < source.size() && source[pos] == '/' && source[pos + 1] == '*') {
        pos += 2;
        while (pos + 1 < source.size()) {
          if (source[pos] == '*' && source[pos + 1] == '/') {
            pos += 2;
            break;
          }
          ++pos;
        }
      } else if (source[pos] == '(') {
        ++parenDepth;
        ++pos;
      } else if (source[pos] == ')' && parenDepth > 0) {
        --parenDepth;
        ++pos;
      } else if (source[pos] == '[') {
        ++bracketDepth;
        ++pos;
      } else if (source[pos] == ']' && bracketDepth > 0) {
        --bracketDepth;
        ++pos;
      } else if (source[pos] == ';' && parenDepth == 0 && bracketDepth == 0) {
        return pos + 1;
      } else if (source[pos] == '}' && parenDepth == 0 && bracketDepth == 0) {
        return pos;
      } else {
        ++pos;
      }
    }
    return pos;
  }

  static size_t findCapnpArrow(std::string const& source, size_t start, size_t end) {
    size_t arrow = end;
    uint parenDepth = 0;
    for (size_t pos = start; pos + 1 < end; ++pos) {
      if (source[pos] == '(') {
        ++parenDepth;
      } else if (source[pos] == ')' && parenDepth > 0) {
        --parenDepth;
      } else if (source[pos] == '-' && source[pos + 1] == '>' && parenDepth == 0) {
        arrow = pos + 2;
        break;
      }
    }
    return arrow;
  }

  static bool findFirstCapnpTuple(
      std::string const& source, size_t start, size_t end, size_t& tupleStart, size_t& tupleEnd) {
    auto pos = start;
    while (pos < end) {
      if (source[pos] == '"' || source[pos] == '\'') {
        skipCapnpString(source, pos);
      } else if (source[pos] == '(') {
        tupleStart = ++pos;
        uint parenDepth = 1;
        while (pos < end && parenDepth > 0) {
          if (source[pos] == '"' || source[pos] == '\'') {
            skipCapnpString(source, pos);
          } else if (source[pos] == '(') {
            ++parenDepth;
            ++pos;
          } else if (source[pos] == ')') {
            --parenDepth;
            ++pos;
          } else {
            ++pos;
          }
        }
        if (parenDepth == 0) {
          tupleEnd = pos - 1;
          return true;
        }
        return false;
      } else {
        ++pos;
      }
    }
    return false;
  }

  static kj::Vector<DevCapnpInterface::Field> scanCapnpTupleFields(
      std::string const& source, size_t start, size_t end) {
    kj::Vector<DevCapnpInterface::Field> fields;
    auto pos = start;
    while (pos < end) {
      skipCapnpWhitespaceAndComments(source, pos);
      if (pos >= end) break;

      if (source[pos] == '"' || source[pos] == '\'') {
        skipCapnpString(source, pos);
      } else if (isalpha(static_cast<unsigned char>(source[pos]))) {
        KJ_IF_MAYBE(fieldName, scanCapnpIdentifier(source, pos)) {
          skipCapnpWhitespaceAndComments(source, pos);
          if (pos < end && source[pos] == ':') {
            ++pos;
            skipCapnpWhitespaceAndComments(source, pos);
            KJ_IF_MAYBE(typeName, scanCapnpTypeName(source, pos)) {
              fields.add(DevCapnpInterface::Field {
                kj::mv(*fieldName),
                kj::mv(*typeName),
              });
            }
          }
        }
      } else {
        ++pos;
      }
    }

    return fields;
  }

  static kj::Vector<DevCapnpInterface::Field> scanCapnpMethodParams(
      std::string const& source, size_t start, size_t end) {
    size_t tupleStart = 0;
    size_t tupleEnd = 0;
    if (!findFirstCapnpTuple(source, start, end, tupleStart, tupleEnd)) {
      return kj::Vector<DevCapnpInterface::Field>();
    }
    return scanCapnpTupleFields(source, tupleStart, tupleEnd);
  }

  static kj::Vector<DevCapnpInterface::Field> scanCapnpMethodResults(
      std::string const& source, size_t start, size_t end) {
    auto arrow = findCapnpArrow(source, start, end);
    if (arrow == end) {
      return kj::Vector<DevCapnpInterface::Field>();
    }

    size_t tupleStart = 0;
    size_t tupleEnd = 0;
    if (!findFirstCapnpTuple(source, arrow, end, tupleStart, tupleEnd)) {
      return kj::Vector<DevCapnpInterface::Field>();
    }

    return scanCapnpTupleFields(source, tupleStart, tupleEnd);
  }

  static kj::Maybe<DevCapnpInterface::Method> scanCapnpMethodAt(
      std::string const& source, size_t& pos, kj::StringPtr interfaceName) {
    auto methodStart = pos;
    KJ_IF_MAYBE(name, scanCapnpIdentifier(source, pos)) {
      if (*name == interfaceName) {
        return nullptr;
      }
      skipCapnpWhitespaceAndComments(source, pos);
      if (pos < source.size() && source[pos] == '@') {
        auto methodEnd = scanCapnpMethodEnd(source, methodStart);
        auto params = scanCapnpMethodParams(
            source, methodStart, findCapnpArrow(source, methodStart, methodEnd));
        auto results = scanCapnpMethodResults(source, methodStart, methodEnd);
        pos = methodEnd;
        return DevCapnpInterface::Method {
          kj::mv(*name),
          kj::mv(params),
          kj::mv(results),
        };
      }
    }
    return nullptr;
  }

  static kj::Vector<DevCapnpInterface::Method> scanCapnpInterfaceMethods(
      std::string const& source, size_t& pos, kj::StringPtr interfaceName) {
    kj::Vector<DevCapnpInterface::Method> methods;
    std::set<std::string> seen;
    skipCapnpWhitespaceAndComments(source, pos);
    if (pos >= source.size() || source[pos] != '{') {
      return methods;
    }

    uint depth = 1;
    ++pos;
    while (pos < source.size() && depth > 0) {
      skipCapnpWhitespaceAndComments(source, pos);
      if (pos >= source.size()) {
        break;
      }

      if (source[pos] == '"' || source[pos] == '\'') {
        skipCapnpString(source, pos);
      } else if (source[pos] == '{') {
        ++depth;
        ++pos;
      } else if (source[pos] == '}') {
        --depth;
        ++pos;
      } else if (depth == 1 && isalpha(static_cast<unsigned char>(source[pos]))) {
        auto candidateStart = pos;
        KJ_IF_MAYBE(method, scanCapnpMethodAt(source, pos, interfaceName)) {
          auto methodStd = toStdString(method->name);
          if (seen.insert(methodStd).second) {
            methods.add(kj::mv(*method));
          }
        } else {
          pos = candidateStart + 1;
        }
      } else {
        ++pos;
      }
    }

    return methods;
  }

  static kj::Vector<DevCapnpInterface> scanCapnpInterfaces(kj::StringPtr schemaSource) {
    auto source = toStdString(schemaSource);
    kj::Vector<DevCapnpInterface> interfaces;
    std::set<std::string> seen;
    size_t pos = 0;
    while (pos < source.size()) {
      skipCapnpWhitespaceAndComments(source, pos);
      if (pos >= source.size()) {
        break;
      }

      if (source[pos] == '"' || source[pos] == '\'') {
        skipCapnpString(source, pos);
      } else if (isalpha(static_cast<unsigned char>(source[pos]))) {
        auto start = pos++;
        while (pos < source.size() &&
               (isalnum(static_cast<unsigned char>(source[pos])) || source[pos] == '_')) {
          ++pos;
        }

        if (source.compare(start, pos - start, "interface") == 0) {
          KJ_IF_MAYBE(name, scanCapnpIdentifier(source, pos)) {
            auto nameStd = toStdString(*name);
            if (seen.insert(nameStd).second) {
              auto methods = scanCapnpInterfaceMethods(source, pos, *name);
              interfaces.add(DevCapnpInterface {
                kj::mv(*name),
                kj::mv(methods),
              });
            }
          }
        }
      } else {
        ++pos;
      }
    }
    return interfaces;
  }

  struct DevCapnpParsedMethodMetadata {
    uint16_t id = 0;
    std::string paramStructId;
    std::string resultStructId;
  };

  struct DevCapnpParsedInterfaceMetadata {
    std::string interfaceId;
    std::map<std::string, DevCapnpParsedMethodMetadata> methods;
  };

  static std::map<std::string, DevCapnpParsedInterfaceMetadata> parseCapnpInterfaceMetadata(
      kj::StringPtr resolvedPath, kj::StringPtr rootDir,
      kj::ArrayPtr<DevCapnpInterface> interfaces,
      kj::ArrayPtr<kj::String> extraImportPath = nullptr) {
    std::map<std::string, DevCapnpParsedInterfaceMetadata> metadata;
    capnp::SchemaParser parser;

    kj::Vector<kj::String> importPath;
    importPath.add(kj::heapString(rootDir));
    for (auto& path: extraImportPath) {
      importPath.add(kj::heapString(path));
    }
    if (access("src/sandstorm/web-session.capnp", R_OK) == 0) {
      importPath.add(kj::heapString("src"));
    }
    importPath.add(kj::heapString("/usr/local/include"));
    importPath.add(kj::heapString("/usr/include"));
    auto importPathPtrs = KJ_MAP(p, importPath) -> kj::StringPtr { return p; };

    auto schema = parser.parseDiskFile(resolvedPath, resolvedPath, importPathPtrs);
    for (auto& interfaceDef: interfaces) {
      KJ_IF_MAYBE(symbol, schema.findNested(interfaceDef.name)) {
        if (symbol->getProto().isInterface()) {
          DevCapnpParsedInterfaceMetadata interfaceMetadata;
          interfaceMetadata.interfaceId =
              toStdString(capnpInterfaceIdString(symbol->getProto().getId()));
          auto interfaceSchema = symbol->asInterface();
          for (auto method: interfaceSchema.getMethods()) {
            auto proto = method.getProto();
            interfaceMetadata.methods.insert(std::make_pair(
                toStdString(proto.getName()),
                DevCapnpParsedMethodMetadata {
                  method.getOrdinal(),
                  toStdString(capnpInterfaceIdString(proto.getParamStructType())),
                  toStdString(capnpInterfaceIdString(proto.getResultStructType())),
                }));
          }

          metadata.insert(std::make_pair(toStdString(interfaceDef.name), kj::mv(interfaceMetadata)));
        }
      }
    }

    return metadata;
  }

  struct CapnpAbiField {
    std::string name;
    std::string type;
  };

  struct CapnpAbiMethod {
    std::string name;
    uint ordinal;
    std::string paramStructId;
    std::string resultStructId;
    std::vector<CapnpAbiField> params;
    std::vector<CapnpAbiField> results;
  };

  struct CapnpAbiInterface {
    std::string name;
    std::string interfaceId;
    std::vector<CapnpAbiMethod> methods;
  };

  struct CapnpAbiDump {
    std::string schema;
    std::vector<CapnpAbiInterface> interfaces;
  };

  static void appendCapnpAbiFieldsJson(
      kj::Vector<char>& json, const std::vector<CapnpAbiField>& fields) {
    json.add('[');
    for (size_t i = 0; i < fields.size(); ++i) {
      if (i > 0) {
        json.addAll(kj::StringPtr(", "));
      }
      json.addAll(kj::StringPtr("{\"name\": "));
      appendJsonQuoted(json, kj::StringPtr(fields[i].name));
      json.addAll(kj::StringPtr(", \"type\": "));
      appendJsonQuoted(json, kj::StringPtr(fields[i].type));
      json.add('}');
    }
    json.add(']');
  }

  static capnp::JsonValue::Reader requireJsonField(
      capnp::JsonValue::Reader value, kj::StringPtr name, kj::StringPtr context) {
    KJ_REQUIRE(value.which() == capnp::JsonValue::OBJECT,
        "Expected JSON object while reading Cap'n Proto ABI dump.", context);
    for (auto field: value.getObject()) {
      if (field.getName() == name) {
        return field.getValue();
      }
    }
    KJ_FAIL_REQUIRE("Missing field in Cap'n Proto ABI dump.", context, name);
  }

  static std::string requireJsonString(
      capnp::JsonValue::Reader value, kj::StringPtr context) {
    KJ_REQUIRE(value.which() == capnp::JsonValue::STRING,
        "Expected JSON string while reading Cap'n Proto ABI dump.", context);
    return toStdString(value.getString());
  }

  static uint requireJsonUInt(capnp::JsonValue::Reader value, kj::StringPtr context) {
    KJ_REQUIRE(value.which() == capnp::JsonValue::NUMBER,
        "Expected JSON number while reading Cap'n Proto ABI dump.", context);
    auto number = value.getNumber();
    auto ordinal = static_cast<uint>(number);
    KJ_REQUIRE(number >= 0 && static_cast<double>(ordinal) == number,
        "Expected non-negative integer while reading Cap'n Proto ABI dump.", context);
    return ordinal;
  }

  static capnp::List<capnp::JsonValue>::Reader requireJsonArray(
      capnp::JsonValue::Reader value, kj::StringPtr context) {
    KJ_REQUIRE(value.which() == capnp::JsonValue::ARRAY,
        "Expected JSON array while reading Cap'n Proto ABI dump.", context);
    return value.getArray();
  }

  static std::vector<CapnpAbiField> parseCapnpAbiFieldsJson(
      capnp::JsonValue::Reader value, kj::StringPtr context) {
    std::vector<CapnpAbiField> fields;
    for (auto fieldValue: requireJsonArray(value, context)) {
      fields.push_back(CapnpAbiField {
        requireJsonString(requireJsonField(fieldValue, "name", context), context),
        requireJsonString(requireJsonField(fieldValue, "type", context), context),
      });
    }
    return fields;
  }

  static CapnpAbiDump parseCapnpAbiJson(kj::StringPtr path) {
    auto text = readAll(raiiOpen(path, O_RDONLY | O_CLOEXEC));
    capnp::MallocMessageBuilder message;
    auto root = message.initRoot<capnp::JsonValue>();
    capnp::JsonCodec().decodeRaw(kj::arrayPtr(text.begin(), text.size()), root);
    auto rootReader = root.asReader();

    auto format = requireJsonString(requireJsonField(rootReader, "format", path), path);
    KJ_REQUIRE(format == "sandstorm-capnp-abi-v1",
        "Unsupported Cap'n Proto ABI dump format.", path, format);

    CapnpAbiDump dump;
    dump.schema = requireJsonString(requireJsonField(rootReader, "schema", path), path);

    for (auto interfaceValue:
        requireJsonArray(requireJsonField(rootReader, "interfaces", path), path)) {
      CapnpAbiInterface interfaceDef;
      interfaceDef.name = requireJsonString(requireJsonField(interfaceValue, "name", path), path);
      interfaceDef.interfaceId =
          requireJsonString(requireJsonField(interfaceValue, "interfaceId", path), path);

      for (auto methodValue:
          requireJsonArray(requireJsonField(interfaceValue, "methods", path), path)) {
        CapnpAbiMethod methodDef;
        methodDef.name = requireJsonString(requireJsonField(methodValue, "name", path), path);
        methodDef.ordinal = requireJsonUInt(requireJsonField(methodValue, "ordinal", path), path);
        methodDef.paramStructId =
            requireJsonString(requireJsonField(methodValue, "paramStructId", path), path);
        methodDef.resultStructId =
            requireJsonString(requireJsonField(methodValue, "resultStructId", path), path);
        methodDef.params = parseCapnpAbiFieldsJson(
            requireJsonField(methodValue, "params", path), path);
        methodDef.results = parseCapnpAbiFieldsJson(
            requireJsonField(methodValue, "results", path), path);
        interfaceDef.methods.push_back(kj::mv(methodDef));
      }

      dump.interfaces.push_back(kj::mv(interfaceDef));
    }

    return dump;
  }

  CapnpAbiDump buildCapnpAbiDump(kj::StringPtr specifier) {
    auto rootDir = currentWorkingDirectory();
    auto resolvedPath = resolveCapnpAbiSchemaPath(rootDir, specifier);
    auto source = readAll(raiiOpen(resolvedPath, O_RDONLY | O_CLOEXEC));
    auto interfaces = scanCapnpInterfaces(source);
    auto metadataRoot = isPathUnderRoot(resolvedPath, rootDir)
        ? kj::heapString(rootDir)
        : dirnameForPath(resolvedPath);
    auto metadata = parseCapnpInterfaceMetadata(
        resolvedPath, metadataRoot, interfaces.asPtr(), importPath.asPtr());

    if (capnpAbiInterfaceFilter != nullptr) {
      auto found = metadata.find(toStdString(capnpAbiInterfaceFilter));
      KJ_REQUIRE(found != metadata.end(),
          "Cap'n Proto ABI dump schema does not define the requested interface.",
          specifier, capnpAbiInterfaceFilter);
    }

    CapnpAbiDump dump;
    dump.schema = toStdString(specifier);

    for (auto& interfaceDef: interfaces) {
      if (capnpAbiInterfaceFilter != nullptr && interfaceDef.name != capnpAbiInterfaceFilter) {
        continue;
      }

      auto found = metadata.find(toStdString(interfaceDef.name));
      if (found == metadata.end()) {
        continue;
      }

      CapnpAbiInterface interfaceDump;
      interfaceDump.name = toStdString(interfaceDef.name);
      interfaceDump.interfaceId = found->second.interfaceId;

      for (auto& methodDef: interfaceDef.methods) {
        auto methodFound = found->second.methods.find(toStdString(methodDef.name));
        if (methodFound == found->second.methods.end()) {
          continue;
        }

        CapnpAbiMethod methodDump;
        methodDump.name = toStdString(methodDef.name);
        methodDump.ordinal = methodFound->second.id;
        methodDump.paramStructId = methodFound->second.paramStructId;
        methodDump.resultStructId = methodFound->second.resultStructId;
        for (auto& field: methodDef.params) {
          methodDump.params.push_back(CapnpAbiField {
            toStdString(field.name),
            toStdString(field.type),
          });
        }
        for (auto& field: methodDef.results) {
          methodDump.results.push_back(CapnpAbiField {
            toStdString(field.name),
            toStdString(field.type),
          });
        }
        interfaceDump.methods.push_back(kj::mv(methodDump));
      }

      dump.interfaces.push_back(kj::mv(interfaceDump));
    }

    return dump;
  }

  static kj::String renderCapnpAbiJson(const CapnpAbiDump& dump) {
    kj::Vector<char> json;
    json.addAll(kj::StringPtr("{\n  \"format\": \"sandstorm-capnp-abi-v1\",\n  "
        "\"schema\": "));
    appendJsonQuoted(json, kj::StringPtr(dump.schema));
    json.addAll(kj::StringPtr(",\n  \"interfaces\": ["));

    bool firstInterface = true;
    for (auto& interfaceDef: dump.interfaces) {
      if (!firstInterface) {
        json.add(',');
      }
      firstInterface = false;

      json.addAll(kj::StringPtr("\n    {\n      \"name\": "));
      appendJsonQuoted(json, kj::StringPtr(interfaceDef.name));
      json.addAll(kj::StringPtr(",\n      \"interfaceId\": "));
      appendJsonQuoted(json, kj::StringPtr(interfaceDef.interfaceId));
      json.addAll(kj::StringPtr(",\n      \"methods\": ["));

      bool firstMethod = true;
      for (auto& methodDef: interfaceDef.methods) {
        if (!firstMethod) {
          json.add(',');
        }
        firstMethod = false;

        json.addAll(kj::StringPtr("\n        {\n          \"name\": "));
        appendJsonQuoted(json, kj::StringPtr(methodDef.name));
        json.addAll(kj::StringPtr(",\n          \"ordinal\": "));
        json.addAll(kj::str(methodDef.ordinal));
        json.addAll(kj::StringPtr(",\n          \"paramStructId\": "));
        appendJsonQuoted(json, kj::StringPtr(methodDef.paramStructId));
        json.addAll(kj::StringPtr(",\n          \"resultStructId\": "));
        appendJsonQuoted(json, kj::StringPtr(methodDef.resultStructId));
        json.addAll(kj::StringPtr(",\n          \"params\": "));
        appendCapnpAbiFieldsJson(json, methodDef.params);
        json.addAll(kj::StringPtr(",\n          \"results\": "));
        appendCapnpAbiFieldsJson(json, methodDef.results);
        json.addAll(kj::StringPtr("\n        }"));
      }

      json.addAll(kj::StringPtr("\n      ]\n    }"));
    }

    json.addAll(kj::StringPtr("\n  ]\n}"));
    json.add('\0');
    return kj::String(json.releaseAsArray());
  }

  kj::String renderCapnpAbiJson(kj::StringPtr specifier) {
    return renderCapnpAbiJson(buildCapnpAbiDump(specifier));
  }

  static void compareCapnpAbiFields(
      kj::Vector<kj::String>& errors,
      kj::StringPtr methodContext,
      kj::StringPtr fieldKind,
      const std::vector<CapnpAbiField>& baselineFields,
      const std::vector<CapnpAbiField>& currentFields) {
    if (currentFields.size() < baselineFields.size()) {
      errors.add(kj::str(methodContext, " removed ", fieldKind, " fields: baseline had ",
          baselineFields.size(), ", current has ", currentFields.size()));
    }

    auto count = baselineFields.size() < currentFields.size()
        ? baselineFields.size()
        : currentFields.size();
    for (auto i = 0; i < count; ++i) {
      auto& baseline = baselineFields[i];
      auto& current = currentFields[i];
      if (baseline.name != current.name || baseline.type != current.type) {
        errors.add(kj::str(methodContext, " changed ", fieldKind, " field #", i, ": expected ",
            baseline.name, ": ", baseline.type, ", found ", current.name, ": ", current.type));
      }
    }
  }

  static kj::Vector<kj::String> compareCapnpAbiDumps(
      const CapnpAbiDump& baseline, const CapnpAbiDump& current) {
    kj::Vector<kj::String> errors;
    std::map<std::string, const CapnpAbiInterface*> currentInterfaces;
    for (auto& interfaceDef: current.interfaces) {
      currentInterfaces.insert(std::make_pair(interfaceDef.name, &interfaceDef));
    }

    for (auto& baselineInterface: baseline.interfaces) {
      auto currentInterface = currentInterfaces.find(baselineInterface.name);
      if (currentInterface == currentInterfaces.end()) {
        errors.add(kj::str("removed interface ", baselineInterface.name));
        continue;
      }

      if (baselineInterface.interfaceId != currentInterface->second->interfaceId) {
        errors.add(kj::str("interface ", baselineInterface.name, " changed ID: expected ",
            baselineInterface.interfaceId, ", found ", currentInterface->second->interfaceId));
      }

      std::map<std::string, const CapnpAbiMethod*> currentMethods;
      for (auto& methodDef: currentInterface->second->methods) {
        currentMethods.insert(std::make_pair(methodDef.name, &methodDef));
      }

      for (auto& baselineMethod: baselineInterface.methods) {
        auto currentMethod = currentMethods.find(baselineMethod.name);
        auto methodContext = kj::str("method ", baselineInterface.name, ".", baselineMethod.name);
        if (currentMethod == currentMethods.end()) {
          errors.add(kj::str("removed ", methodContext));
          continue;
        }

        if (baselineMethod.ordinal != currentMethod->second->ordinal) {
          errors.add(kj::str(methodContext, " changed ordinal: expected ",
              baselineMethod.ordinal, ", found ", currentMethod->second->ordinal));
        }
        if (baselineMethod.paramStructId != currentMethod->second->paramStructId) {
          errors.add(kj::str(methodContext, " changed parameter struct ID: expected ",
              baselineMethod.paramStructId, ", found ", currentMethod->second->paramStructId));
        }
        if (baselineMethod.resultStructId != currentMethod->second->resultStructId) {
          errors.add(kj::str(methodContext, " changed result struct ID: expected ",
              baselineMethod.resultStructId, ", found ", currentMethod->second->resultStructId));
        }
        compareCapnpAbiFields(errors, methodContext, "parameter",
            baselineMethod.params, currentMethod->second->params);
        compareCapnpAbiFields(errors, methodContext, "result",
            baselineMethod.results, currentMethod->second->results);
      }
    }

    return errors;
  }

  kj::MainBuilder::Validity checkCapnpAbiCompatibility(kj::StringPtr specifier) {
    auto baseline = parseCapnpAbiJson(capnpAbiBaselinePath);
    auto current = buildCapnpAbiDump(specifier);
    auto errors = compareCapnpAbiDumps(baseline, current);
    if (errors.size() == 0) {
      auto message = kj::str("Cap'n Proto ABI compatible: ", specifier, "\n");
      kj::FdOutputStream(STDOUT_FILENO).write(message.begin(), message.size());
      return true;
    }

    kj::FdOutputStream err(STDERR_FILENO);
    auto header = kj::str("Cap'n Proto ABI compatibility check failed for ", specifier, ":\n");
    err.write(header.begin(), header.size());
    for (auto& error: errors) {
      auto line = kj::str("  - ", error, "\n");
      err.write(line.begin(), line.size());
    }
    return "Cap'n Proto ABI compatibility check failed";
  }

  static kj::Maybe<kj::String> nativeCapnpCapabilitySpec(
      kj::StringPtr importSpecifier) {
    if (importSpecifier == "/sandstorm/web-session.capnp") {
      return kj::heapString("{ nativeInterface: \"webSession\", fetch: true }");
    } else if (importSpecifier == "/sandstorm/api-session.capnp") {
      return kj::heapString("{ nativeInterface: \"apiSession\", fetch: true }");
    } else if (importSpecifier == "/sandstorm/outbound-http-session.capnp") {
      return kj::heapString("{ nativeInterface: \"outboundHttpSession\", fetch: true }");
    } else {
      return nullptr;
    }
  }

  static kj::String generateDevIsolateCapnpEsOutput(
      kj::StringPtr resolvedPath, kj::StringPtr rootDir, DevIsolateCapnpEsOutputKind kind) {
    auto compilerModule = getenv("SANDSTORM_CAPNP_ES_COMPILER_MODULE");
    KJ_REQUIRE(compilerModule != nullptr && strlen(compilerModule) > 0,
        "`capnp-es:` isolate imports require SANDSTORM_CAPNP_ES_COMPILER_MODULE to point at "
        "the @mnutt/capnp-es compiler module.");

    auto capnpcOutPipe = Pipe::make();
    auto capnpcErrPipe = Pipe::make();
    auto rootInclude = kj::str("-I", rootDir);
    Subprocess::Options capnpcOptions({
        "capnpc", "-o-", rootInclude, "-Isrc", "-I/usr/include", resolvedPath});
    capnpcOptions.stdout = capnpcOutPipe.writeEnd;
    capnpcOptions.stderr = capnpcErrPipe.writeEnd;
    Subprocess capnpc(kj::mv(capnpcOptions));
    capnpcOutPipe.writeEnd = nullptr;
    capnpcErrPipe.writeEnd = nullptr;

    auto codegenRequest = readAllBytes(capnpcOutPipe.readEnd);
    auto capnpcStderr = readAll(capnpcErrPipe.readEnd);
    auto capnpcExit = capnpc.waitForExit();
    KJ_REQUIRE(capnpcExit == 0, "capnpc failed while generating capnp-es module.",
        resolvedPath, capnpcStderr);

    auto nodeInPipe = Pipe::make();
    auto nodeOutPipe = Pipe::make();
    auto nodeErrPipe = Pipe::make();
    auto compilerModulePtr = kj::StringPtr(compilerModule);
    auto extension = kind == DevIsolateCapnpEsOutputKind::DTS ? ".d.ts" : ".js";
    kj::StringPtr formatOption = kind == DevIsolateCapnpEsOutputKind::DTS ? "dts" : "js";
    kj::StringPtr script =
        "import path from 'node:path';\n"
        "const chunks = [];\n"
        "for await (const chunk of process.stdin) chunks.push(chunk);\n"
        "const { compileAll } = await import(process.argv[1]);\n"
        "const sourcePath = process.argv[2];\n"
        "const extension = process.argv[3];\n"
        "const format = process.argv[4];\n"
        "const rootDir = path.resolve(process.argv[5]);\n"
        "const basename = sourcePath.split('/').pop().replace(/\\.capnp$/, extension);\n"
        "const expectedPath = sourcePath.replace(/\\.capnp$/, extension);\n"
        "function runtimeModuleSpecifier(moduleName) {\n"
        "  if (moduleName === '@mnutt/capnp-es') return '/capnp-es/index.mjs';\n"
        "  if (moduleName === '@mnutt/capnp/rpc.mjs') return '/capnp-es/capnp/rpc.mjs';\n"
        "  if (moduleName.startsWith('@mnutt/capnp-es/')) {\n"
        "    const relative = moduleName.slice('@mnutt/capnp-es/'.length);\n"
        "    return '/capnp-es/' + relative + (relative.endsWith('.mjs') ? '' : '.mjs');\n"
        "  }\n"
        "  if (moduleName.startsWith('@mnutt/shared/')) {\n"
        "    return '/capnp-es/shared/' + moduleName.slice('@mnutt/shared/'.length);\n"
        "  }\n"
        "  if (moduleName.startsWith('@mnutt/')) {\n"
        "    return '/capnp-es/' + moduleName.slice('@mnutt/'.length);\n"
        "  }\n"
        "  return moduleName;\n"
        "}\n"
        "function capnpSpecifierKey(specifier) {\n"
        "  let key = specifier.startsWith('capnp:') ? specifier.slice('capnp:'.length) : specifier;\n"
        "  if (key.startsWith('/')) key = key.slice(1);\n"
        "  if (key.startsWith('./')) key = key.slice(2);\n"
        "  return key;\n"
        "}\n"
        "function capnpSpecifierForTsPath(tsPath) {\n"
        "  const capnpPath = tsPath.replace(/\\.ts$/, '.capnp');\n"
        "  const absolutePath = path.resolve(capnpPath);\n"
        "  const relativeToRoot = path.relative(rootDir, absolutePath);\n"
        "  if (relativeToRoot && !relativeToRoot.startsWith('..') && !path.isAbsolute(relativeToRoot)) {\n"
        "    return 'capnp:./' + relativeToRoot.split(path.sep).join('/');\n"
        "  }\n"
        "  if (capnpPath.startsWith('sandstorm/')) return 'capnp:/' + capnpPath;\n"
        "  if (capnpPath.startsWith('/sandstorm/')) return 'capnp:' + capnpPath;\n"
        "  if (path.isAbsolute(capnpPath)) return 'capnp:/' + path.basename(capnpPath);\n"
        "  return 'capnp:./' + capnpPath;\n"
        "}\n"
        "function relativeCapnpSpecifier(fromSpecifier, toSpecifier) {\n"
        "  const fromKey = capnpSpecifierKey(fromSpecifier);\n"
        "  const toKey = capnpSpecifierKey(toSpecifier);\n"
        "  let relative = path.posix.relative(path.posix.dirname(fromKey), toKey);\n"
        "  if (relative === '') relative = '.';\n"
        "  if (!relative.startsWith('.')) relative = './' + relative;\n"
        "  return relative;\n"
        "}\n"
        "const { files } = await compileAll(Buffer.concat(chunks), {\n"
        "  js: format === 'js',\n"
        "  dts: format === 'dts',\n"
        "  tsconfig: { noCheck: true },\n"
        "  moduleSpecifier(context) {\n"
        "    if (context.kind === 'runtime') return runtimeModuleSpecifier(context.originalSpecifier);\n"
        "    return relativeCapnpSpecifier(\n"
        "      capnpSpecifierForTsPath(context.fromPath),\n"
        "      capnpSpecifierForTsPath(context.toPath));\n"
        "  }\n"
        "});\n"
        "let content = files.get(expectedPath);\n"
        "if (content === undefined) {\n"
        "  for (const [name, value] of files) {\n"
        "    if (name === basename || name.endsWith('/' + basename)) {\n"
        "      content = value;\n"
        "      break;\n"
        "    }\n"
        "  }\n"
        "}\n"
        "if (content === undefined) {\n"
        "  console.error('capnp-es compiler did not emit expected JS file for ' + sourcePath);\n"
        "  console.error([...files.keys()].join('\\n'));\n"
        "  process.exit(1);\n"
        "}\n"
        "process.stdout.write(content);\n";
    Subprocess::Options nodeOptions({
        "node", "--input-type=module", "-e", script, compilerModulePtr, resolvedPath,
        extension, formatOption, rootDir});
    nodeOptions.stdin = nodeInPipe.readEnd;
    nodeOptions.stdout = nodeOutPipe.writeEnd;
    nodeOptions.stderr = nodeErrPipe.writeEnd;
    Subprocess node(kj::mv(nodeOptions));
    nodeInPipe.readEnd = nullptr;
    nodeOutPipe.writeEnd = nullptr;
    nodeErrPipe.writeEnd = nullptr;

    kj::FdOutputStream(nodeInPipe.writeEnd.get())
        .write(codegenRequest.begin(), codegenRequest.size());
    nodeInPipe.writeEnd = nullptr;
    auto generated = readAll(nodeOutPipe.readEnd);
    auto nodeStderr = readAll(nodeErrPipe.readEnd);
    auto nodeExit = node.waitForExit();
    KJ_REQUIRE(nodeExit == 0, "capnp-es compiler failed.", resolvedPath, nodeStderr);
    return generated;
  }

  static void skipJsString(std::string const& source, size_t& pos) {
    char quote = source[pos++];
    while (pos < source.size()) {
      char c = source[pos++];
      if (c == '\\' && pos < source.size()) {
        ++pos;
      } else if (c == quote) {
        break;
      }
    }
  }

  static void skipJsLineComment(std::string const& source, size_t& pos) {
    pos += 2;
    while (pos < source.size() && source[pos] != '\n') {
      ++pos;
    }
  }

  static void skipJsBlockComment(std::string const& source, size_t& pos) {
    pos += 2;
    while (pos + 1 < source.size()) {
      if (source[pos] == '*' && source[pos + 1] == '/') {
        pos += 2;
        return;
      }
      ++pos;
    }
    pos = source.size();
  }

  static void skipJsWhitespaceAndComments(std::string const& source, size_t& pos) {
    for (;;) {
      while (pos < source.size() && isspace(static_cast<unsigned char>(source[pos]))) {
        ++pos;
      }
      if (pos + 1 < source.size() && source[pos] == '/' && source[pos + 1] == '/') {
        skipJsLineComment(source, pos);
      } else if (pos + 1 < source.size() && source[pos] == '/' && source[pos + 1] == '*') {
        skipJsBlockComment(source, pos);
      } else {
        return;
      }
    }
  }

  static kj::Maybe<kj::String> parseJsStringLiteral(std::string const& source, size_t& pos) {
    if (pos >= source.size() || (source[pos] != '"' && source[pos] != '\'')) {
      return nullptr;
    }

    char quote = source[pos++];
    std::string result;
    while (pos < source.size()) {
      char c = source[pos++];
      if (c == quote) {
        return kj::heapString(result.c_str());
      } else if (c == '\\' && pos < source.size()) {
        result.push_back(source[pos++]);
      } else {
        result.push_back(c);
      }
    }

    return nullptr;
  }

  static kj::Maybe<kj::String> scanImportDeclarationSpecifier(
      std::string const& source, size_t& pos) {
    skipJsWhitespaceAndComments(source, pos);
    if (pos < source.size() && source[pos] == '(') {
      return nullptr;
    }

    KJ_IF_MAYBE(specifier, parseJsStringLiteral(source, pos)) {
      return kj::mv(*specifier);
    }

    while (pos < source.size()) {
      skipJsWhitespaceAndComments(source, pos);
      if (pos >= source.size() || source[pos] == ';') {
        return nullptr;
      }

      if (source[pos] == '"' || source[pos] == '\'') {
        skipJsString(source, pos);
      } else if (source[pos] == '`') {
        skipJsString(source, pos);
      } else if (isJsIdentifierStart(source[pos])) {
        auto start = pos++;
        while (pos < source.size() && isJsIdentifierPart(source[pos])) {
          ++pos;
        }
        if (source.compare(start, pos - start, "from") == 0) {
          skipJsWhitespaceAndComments(source, pos);
          return parseJsStringLiteral(source, pos);
        }
      } else {
        ++pos;
      }
    }

    return nullptr;
  }

  static kj::Maybe<kj::String> scanExportDeclarationSpecifier(
      std::string const& source, size_t& pos) {
    while (pos < source.size()) {
      skipJsWhitespaceAndComments(source, pos);
      if (pos >= source.size() || source[pos] == ';') {
        return nullptr;
      }

      if (source[pos] == '"' || source[pos] == '\'' || source[pos] == '`') {
        skipJsString(source, pos);
      } else if (isJsIdentifierStart(source[pos])) {
        auto start = pos++;
        while (pos < source.size() && isJsIdentifierPart(source[pos])) {
          ++pos;
        }
        if (source.compare(start, pos - start, "from") == 0) {
          skipJsWhitespaceAndComments(source, pos);
          return parseJsStringLiteral(source, pos);
        }
      } else {
        ++pos;
      }
    }

    return nullptr;
  }

  static kj::Vector<kj::String> scanDevIsolateImports(kj::StringPtr moduleSource) {
    auto source = toStdString(moduleSource);
    kj::Vector<kj::String> imports;
    size_t pos = 0;
    while (pos < source.size()) {
      skipJsWhitespaceAndComments(source, pos);
      if (pos >= source.size()) {
        break;
      }

      if (source[pos] == '"' || source[pos] == '\'' || source[pos] == '`') {
        skipJsString(source, pos);
      } else if (isJsIdentifierStart(source[pos])) {
        auto start = pos++;
        while (pos < source.size() && isJsIdentifierPart(source[pos])) {
          ++pos;
        }

        if (source.compare(start, pos - start, "import") == 0) {
          KJ_IF_MAYBE(specifier, scanImportDeclarationSpecifier(source, pos)) {
            imports.add(kj::mv(*specifier));
          }
        } else if (source.compare(start, pos - start, "export") == 0) {
          KJ_IF_MAYBE(specifier, scanExportDeclarationSpecifier(source, pos)) {
            imports.add(kj::mv(*specifier));
          }
        }
      } else {
        ++pos;
      }
    }

    return imports;
  }

  struct PackIsolateModuleSpec {
    kj::String name;
    kj::String sourcePath;
    DevIsolateModuleType type;
  };

  kj::String writePackIsolateSupportDir() {
    kj::String path = kj::heapString("/tmp/sandstorm-pack-isolate-runtime-XXXXXX");
    KJ_REQUIRE(mkdtemp(path.begin()) != nullptr, "mkdtemp() failed", path, strerror(errno));
    KJ_SYSCALL(mkdir(kj::str(path, "/capnp-es-generated").cStr(), 0700));
    return path;
  }

  void addArchiveDirectory(ArchiveNode& root, kj::StringPtr packagePath, kj::StringPtr sourcePath) {
    for (auto& child: listDirectory(sourcePath)) {
      if (child == "." || child == "..") {
        continue;
      }

      auto childPackagePath = packagePath.size() == 0 ? kj::str(child) :
          kj::str(packagePath, "/", child);
      auto childSourcePath = kj::str(sourcePath, "/", child);
      if (isDirectory(childSourcePath)) {
        addArchiveDirectory(root, childPackagePath, childSourcePath);
      } else {
        root.followPath(childPackagePath).setTarget(kj::mv(childSourcePath));
      }
    }
  }

  kj::Maybe<kj::String> trySourcePathForPackagePath(kj::StringPtr packagePath) {
    auto mapping = mapFile(sourceDir, packageDef.getSourceMap(), packagePath);
    if (mapping.sourcePaths.size() == 0 || isDirectory(mapping.sourcePaths[0])) {
      return nullptr;
    }
    return kj::str(mapping.sourcePaths[0]);
  }

  kj::String resolvePackSourceRoot() {
    auto candidate = sourceDir == nullptr ? kj::str(".") : kj::str(sourceDir);
    char* resolved = realpath(candidate.cStr(), nullptr);
    KJ_REQUIRE(resolved != nullptr, "Could not resolve package source root.",
        candidate, strerror(errno));
    KJ_DEFER(free(resolved));
    return kj::heapString(resolved);
  }

  PackIsolateModuleSpec copyPackIsolateModuleSpec(
      spk::Manifest::IsolateConfig::Module::Builder module) {
    PackIsolateModuleSpec result;
    result.name = kj::str(module.getName());
    switch (module.which()) {
      case spk::Manifest::IsolateConfig::Module::ES_MODULE_PATH:
        result.type = DevIsolateModuleType::ES_MODULE;
        result.sourcePath = kj::str(module.getEsModulePath());
        break;
      case spk::Manifest::IsolateConfig::Module::COMMON_JS_MODULE_PATH:
        result.type = DevIsolateModuleType::COMMON_JS;
        result.sourcePath = kj::str(module.getCommonJsModulePath());
        break;
      case spk::Manifest::IsolateConfig::Module::TEXT_PATH:
        result.type = DevIsolateModuleType::TEXT;
        result.sourcePath = kj::str(module.getTextPath());
        break;
      case spk::Manifest::IsolateConfig::Module::JSON_PATH:
        result.type = DevIsolateModuleType::JSON;
        result.sourcePath = kj::str(module.getJsonPath());
        break;
      case spk::Manifest::IsolateConfig::Module::DATA_PATH:
        result.type = DevIsolateModuleType::DATA;
        result.sourcePath = kj::str(module.getDataPath());
        break;
      case spk::Manifest::IsolateConfig::Module::WASM_PATH:
        result.type = DevIsolateModuleType::WASM;
        result.sourcePath = kj::str(module.getWasmPath());
        break;
    }
    return result;
  }

  void writePackIsolateModuleSpec(
      spk::Manifest::IsolateConfig::Module::Builder module,
      PackIsolateModuleSpec& spec) {
    module.setName(spec.name);
    switch (spec.type) {
      case DevIsolateModuleType::ES_MODULE:
        module.setEsModulePath(spec.sourcePath);
        break;
      case DevIsolateModuleType::COMMON_JS:
        module.setCommonJsModulePath(spec.sourcePath);
        break;
      case DevIsolateModuleType::TEXT:
        module.setTextPath(spec.sourcePath);
        break;
      case DevIsolateModuleType::JSON:
        module.setJsonPath(spec.sourcePath);
        break;
      case DevIsolateModuleType::DATA:
        module.setDataPath(spec.sourcePath);
        break;
      case DevIsolateModuleType::WASM:
        module.setWasmPath(spec.sourcePath);
        break;
    }
  }

  bool collectPackCapnpImportsFromModule(
      kj::StringPtr packagePath, kj::StringPtr rootDir,
      kj::Vector<DevIsolateModule>& generatedModules,
      std::map<std::string, std::string>& capnpEsImports) {
    auto maybeRealPath = trySourcePathForPackagePath(packagePath);
    KJ_IF_MAYBE(realPath, maybeRealPath) {
      char* resolvedModuleRaw = realpath(realPath->cStr(), nullptr);
      KJ_REQUIRE(resolvedModuleRaw != nullptr, "Could not resolve isolate module.",
          packagePath, *realPath, strerror(errno));
      KJ_DEFER(free(resolvedModuleRaw));
      auto resolvedModule = kj::StringPtr(resolvedModuleRaw);

      auto source = readAll(raiiOpen(resolvedModule, O_RDONLY | O_CLOEXEC));
      auto imports = scanDevIsolateImports(source);
      auto importerDir = dirnameForPath(resolvedModule);
      bool found = false;

      for (auto& specifier: imports) {
        if (isCapnpEsImport(specifier)) {
          KJ_FAIL_REQUIRE("`capnp-es:` isolate schema imports have been renamed; use `capnp:`.",
              specifier);
        } else if (isCapnpImport(specifier)) {
          auto resolvedImport = resolveDevIsolateCapnpEsImport(
              importerDir, rootDir, specifier);
          addDevIsolateCapnpEsModule(
              specifier, resolvedImport, rootDir, generatedModules, capnpEsImports);
          found = true;
        }
      }

      return found;
    }

    return false;
  }

  bool augmentPackIsolateConfig(spk::Manifest::IsolateConfig::Builder isolate) {
    auto oldModuleList = isolate.getModules();
    kj::Vector<PackIsolateModuleSpec> oldModules;
    std::set<std::string> existingModuleNames;
    kj::Vector<DevIsolateModule> generatedModules;
    std::map<std::string, std::string> capnpEsImports;
    auto rootDir = resolvePackSourceRoot();

    for (auto i: kj::indices(oldModuleList)) {
      auto module = oldModuleList[i];
      auto spec = copyPackIsolateModuleSpec(module);
      existingModuleNames.insert(toStdString(spec.name));
      if (spec.type == DevIsolateModuleType::ES_MODULE) {
        collectPackCapnpImportsFromModule(
            spec.sourcePath, rootDir, generatedModules, capnpEsImports);
      }
      oldModules.add(kj::mv(spec));
    }
    addDevIsolatePlatformCapnpEsModules(rootDir, generatedModules, capnpEsImports);

    kj::Vector<DevIsolateModule> modulesToAppend;
    for (auto& generated: generatedModules) {
      if (existingModuleNames.insert(toStdString(generated.name)).second) {
        modulesToAppend.add(DevIsolateModule {
          kj::str(generated.name),
          kj::str(generated.sourcePath),
          generated.type,
        });
      }
    }

    if (modulesToAppend.size() == 0) {
      return false;
    }

    auto newModuleList = isolate.initModules(oldModules.size() + modulesToAppend.size());
    size_t index = 0;
    for (auto& oldModule: oldModules) {
      writePackIsolateModuleSpec(newModuleList[index++], oldModule);
    }
    for (auto& generated: modulesToAppend) {
      PackIsolateModuleSpec spec {
        kj::str(generated.name),
        kj::str(generated.sourcePath),
        generated.type,
      };
      writePackIsolateModuleSpec(newModuleList[index++], spec);
    }

    return true;
  }

  void preparePackIsolateSupport(ArchiveNode& root, kj::String& packIsolateSupportDir) {
    auto manifestReader = packageDef.getManifest();
    capnp::MallocMessageBuilder manifestMessage(manifestReader.totalSize().wordCount + 64);
    manifestMessage.setRoot(manifestReader);
    auto manifest = manifestMessage.getRoot<spk::Manifest>();

    auto oldDevIsolateSupportDir = kj::mv(devIsolateSupportDir);
    packIsolateSupportDir = writePackIsolateSupportDir();
    devIsolateSupportDir = kj::heapString(packIsolateSupportDir);
    KJ_DEFER(devIsolateSupportDir = kj::mv(oldDevIsolateSupportDir));

    bool changed = false;
    bool isolateSupportChanged = false;
    if (manifest.getContinueCommand().hasIsolate()) {
      isolateSupportChanged =
          augmentPackIsolateConfig(manifest.getContinueCommand().getIsolate()) ||
          isolateSupportChanged;
    }

    auto actions = manifest.getActions();
    for (auto i: kj::indices(actions)) {
      auto command = actions[i].getCommand();
      if (command.hasIsolate()) {
        isolateSupportChanged =
            augmentPackIsolateConfig(command.getIsolate()) || isolateSupportChanged;
      }
    }
    changed = isolateSupportChanged || changed;

    if (!isolateSupportChanged) {
      recursivelyDelete(packIsolateSupportDir);
      packIsolateSupportDir = nullptr;
      if (changed) {
        packManifestOverride = capnp::messageToFlatArray(manifestMessage);
      }
      return;
    }

    addArchiveDirectory(root, "__sandstorm_isolate_runtime/capnp-es-generated",
        kj::str(packIsolateSupportDir, "/capnp-es-generated"));
    packManifestOverride = capnp::messageToFlatArray(manifestMessage);
  }

  static void appendCapnpText(kj::Vector<char>& output, kj::StringPtr text) {
    output.add('"');
    for (char c: text) {
      switch (c) {
        case '"': output.addAll(kj::StringPtr("\\\"")); break;
        case '\\': output.addAll(kj::StringPtr("\\\\")); break;
        case '\n': output.addAll(kj::StringPtr("\\n")); break;
        case '\r': output.addAll(kj::StringPtr("\\r")); break;
        case '\t': output.addAll(kj::StringPtr("\\t")); break;
        default:
          output.add(static_cast<unsigned char>(c) < 0x20 ? ' ' : c);
          break;
      }
    }
    output.add('"');
  }

  kj::MainBuilder::Validity doDev() {
    ensurePackageDefParsed();

    if (devIsolateWorkerPath != nullptr) {
      context.warning(kj::str(
          "Isolate dev app identity:\n"
          "    appId: ", packageDef.getId(), "\n"
          "    entrypoint: ", devIsolateWorkerPath, "\n\n"
          "Existing grains with this appId will run against the active dev package while this\n"
          "session is connected. To force a separate dev app identity, run dev-isolate from a\n"
          "different entrypoint path or delete the existing dev grain."));
    }

    if (serverBinary == nullptr) {
      // Try to find the server. First try looking where `spk` is installed.
      KJ_IF_MAYBE(i, installHome) {
        auto candidate = kj::str(*i, "/sandstorm");
        if (access(candidate.cStr(), F_OK) == 0) {
          struct stat stats;
          KJ_SYSCALL(stat(candidate.cStr(), &stats));
          if (S_ISREG(stats.st_mode) && stats.st_mode & S_IXUSR) {
            // Indeed!
            serverBinary = kj::mv(candidate);
          }
        }
      }

      if (serverBinary == nullptr) {
        // Try checking for an init script.
        kj::StringPtr candidate = "/etc/init.d/sandstorm";
        if (access(candidate.cStr(), F_OK) == 0) {
          serverBinary = kj::str(candidate);
        }
      }

      if (serverBinary == nullptr) {
        return "Couldn't find Sandstorm server installation. Please use -s to specify it.";
      }
    }

    kj::AutoCloseFd fuseFd;
    kj::Maybe<kj::AutoCloseFd> connection;
    kj::Maybe<kj::Own<FuseMount>> fuseMount;

    if (mountDir == nullptr) {
      // call "sandstorm dev"

      // Create a unix socket over which to receive the fuse FD.
      int serverSocket[2];
      KJ_SYSCALL(socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, serverSocket));
      kj::AutoCloseFd clientEnd(serverSocket[0]);
      kj::AutoCloseFd serverEnd(serverSocket[1]);

      // Run "sandstorm dev".
      pid_t sandstormPid = fork();
      if (sandstormPid == 0) {
        dup2(serverEnd, STDIN_FILENO);
        dup2(serverEnd, STDOUT_FILENO);

        KJ_SYSCALL(execl(serverBinary.cStr(), serverBinary.cStr(), "dev", (char*)nullptr),
                   serverBinary);
        KJ_UNREACHABLE;
      }

      serverEnd = nullptr;

      // Write the app ID to the socket.
      {
        auto msg = kj::str(packageDef.getId(), "\n");
        kj::FdOutputStream((int)clientEnd).write(msg.begin(), msg.size());
      }

      // Write the mountProc option to the socket.
      {
        auto msg = kj::str(mountProc ? "1" : "0", "\n");
        kj::FdOutputStream((int)clientEnd).write(msg.begin(), msg.size());
      }

      // The server connection starts by sending us the FUSE FD.
      fuseFd = receiveFd(clientEnd, [](kj::ArrayPtr<const kj::byte> bytes) {
        // Got some data. Pipe it to stdout.
        kj::FdOutputStream(STDOUT_FILENO).write(bytes.begin(), bytes.size());
      });

      // Switch connection to async I/O.
      {
        int flags;
        KJ_SYSCALL(flags = fcntl(clientEnd, F_GETFL));
        if ((flags & O_NONBLOCK) == 0) {
          KJ_SYSCALL(fcntl(clientEnd, F_SETFL, flags | O_NONBLOCK));
        }
      }

      connection = kj::mv(clientEnd);
    } else {
      // Just mount directly.

      auto mount = kj::heap<FuseMount>(mountDir, "");
      fuseFd = mount->disownFd();
      fuseMount = kj::mv(mount);
    }

    std::set<kj::String> usedFiles;

    {
      kj::UnixEventPort::captureSignal(SIGINT);
      kj::UnixEventPort::captureSignal(SIGQUIT);
      kj::UnixEventPort::captureSignal(SIGTERM);
      kj::UnixEventPort::captureSignal(SIGHUP);

      kj::UnixEventPort eventPort;
      kj::EventLoop eventLoop(eventPort);
      kj::WaitScope waitScope(eventLoop);

      kj::Function<void(kj::StringPtr)> callback = [&](kj::StringPtr path) {
        usedFiles.insert(kj::heapString(path));
      };
      kj::Maybe<kj::Function<kj::Array<capnp::word>()>> dynamicManifestContent;
      if (devIsolateWorkerPath != nullptr) {
        dynamicManifestContent = [&]() {
          return buildDevIsolateManifestBytes();
        };
      }
      kj::Function<kj::Array<capnp::word>()>* dynamicManifestContentPtr = nullptr;
      KJ_IF_MAYBE(content, dynamicManifestContent) {
        dynamicManifestContentPtr = content;
      }
      auto rootNode = makeUnionFs(sourceDir, packageDef.getSourceMap(), packageDef.getManifest(),
                                  packageDef.getBridgeConfig(), getHttpBridgeExe(), callback,
                                  dynamicManifestContentPtr);

      FuseOptions options;

      // Caching improves performance significantly... but the ability to update code and see those
      // updates live without restarting seems more important for this use case.
      // TODO(perf): Implement active cache invalidation. FUSE has protocol support for it. Use
      //   inotify at the other end to detect changes.
      options.cacheForever = fuseCaching;

      auto onSignal = eventPort.onSignal(SIGINT)
          .exclusiveJoin(eventPort.onSignal(SIGQUIT))
          .exclusiveJoin(eventPort.onSignal(SIGTERM))
          .exclusiveJoin(eventPort.onSignal(SIGHUP))
          .then([&](siginfo_t&& sig) {
        context.warning(kj::str("Requesting shutdown due to signal: ", strsignal(sig.si_signo)));

        KJ_IF_MAYBE(c, connection) {
          // Close pipe to request unmount.
          KJ_SYSCALL(shutdown(*c, SHUT_WR));
        }
        fuseMount = nullptr;

        return eventPort.onSignal(SIGINT)
            .exclusiveJoin(eventPort.onSignal(SIGQUIT))
            .exclusiveJoin(eventPort.onSignal(SIGTERM))
            .exclusiveJoin(eventPort.onSignal(SIGHUP))
            .then([&](siginfo_t&& sig) {
          context.exitError("Received second signal. Aborting. You may want to restart Sandstorm.");
        });
      }).eagerlyEvaluate(nullptr);

      kj::Maybe<kj::Promise<void>> logPipe;
      KJ_IF_MAYBE(c, connection) {
        kj::Own<kj::UnixEventPort::FdObserver> logObserver =
            kj::heap<kj::UnixEventPort::FdObserver>(eventPort, *c,
                kj::UnixEventPort::FdObserver::OBSERVE_READ);
        auto promise = pipeToStdout(*logObserver, *c);
        logPipe = promise.attach(kj::mv(logObserver)).eagerlyEvaluate(nullptr);
      }

      if (connection == nullptr) {
        context.warning("App mounted. Ctrl+C to disconnect.");
      } else {
        Config config = readConfig("/opt/sandstorm/sandstorm.conf", false);
        context.warning(kj::str(
              "App is now available from Sandstorm server at:\n\n",
              "    ", config.rootUrl,
              "\n\nCtrl+C to disconnect."));
      }

      bindFuse(eventPort, fuseFd, kj::mv(rootNode), options)
          .then([&]() {
            context.warning("Unmounted cleanly.");
            KJ_IF_MAYBE(m, fuseMount) {
              m->get()->dontUnmount();
            }
          })
          .wait(waitScope);

      KJ_IF_MAYBE(p, logPipe) {
        p->wait(waitScope);
      }
    }

    // OK, we're done running. Output the file list.
    if (packageDef.hasFileList()) {
      context.warning("Updating file list.");

      // Merge with the existing file list.
      auto path = packageDef.getFileList();
      if (access(path.cStr(), F_OK) == 0) {
        auto fileList = raiiOpen(packageDef.getFileList(), O_RDONLY);
        auto sourceMap = packageDef.getSourceMap();
        for (auto& line: splitLines(readAll(fileList))) {
          auto mapping = mapFile(sourceDir, sourceMap, line);
          if (mapping.sourcePaths.size() == 0 && mapping.virtualChildren.size() == 0 &&
              line != "sandstorm-manifest" &&
              line != "sandstorm-http-bridge" &&
              line != "sandstorm-http-bridge-config" &&
              line != "proc/cpuinfo") {
            context.warning(kj::str("No file found to satisfy requirement: ", line,
                                    ", removing from sandstorm-files.list"));
          } else {
            usedFiles.insert(kj::mv(line));
          }
        }
      }

      // Now write back out.
      ReplacementFile newFileList(path);
      auto content = kj::str(
          "# *** WARNING: GENERATED FILE ***\n"
          "# This file is automatically updated and rewritten in sorted order every time\n"
          "# the app runs in dev mode. You may manually add or remove files, but don't\n"
          "# expect comments or ordering to be retained.\n",
          kj::StringTree(KJ_MAP(file, usedFiles) { return kj::strTree(file); }, "\n"),
          "\n");
      kj::FdOutputStream(newFileList.getFd()).write(content.begin(), content.size());
      newFileList.commit();
    } else {
      // If alwaysInclude contains "." then the user doesn't care about the used files list, so
      // don't print in that case. Dev-isolate also uses a generated package definition with
      // implementation-detail source-map prefixes, so there is no useful fileList to suggest.
      bool includeAll = devIsolateWorkerPath != nullptr;
      for (auto alwaysInclude: packageDef.getAlwaysInclude()) {
        if (alwaysInclude == ".") {
          includeAll = true;
          break;
        }
      }

      if (!includeAll) {
        context.warning(
            "Your program used the following files. (If you would specify `fileList` in\n"
            "the package definition, I could write the list there.)\n\n");
        auto msg = kj::str(
            kj::StringTree(KJ_MAP(file, usedFiles) { return kj::strTree(file); }, "\n"), "\n");
        kj::FdOutputStream(STDOUT_FILENO).write(msg.begin(), msg.size());
      }
    }

    return true;
  }

  static kj::Promise<void> pipeToStdout(kj::UnixEventPort::FdObserver& observer, int fd) {
    // Asynchronously read all data from fd and write it to STDOUT.
    // TODO(cleanup): Use KJ I/O facilities. Requires making it possible to construct
    //   kj::LowLevelAsyncIoProvider directly from UnixEventPort.

    for (;;) {
      ssize_t n;
      char buffer[1024];
      KJ_NONBLOCKING_SYSCALL(n = read(fd, buffer, sizeof(buffer)));

      if (n < 0) {
        // Got EAGAIN.
        return observer.whenBecomesReadable().then([&observer, fd]() {
          return pipeToStdout(observer, fd);
        });
      } else if (n == 0) {
        return kj::READY_NOW;
      }

      kj::FdOutputStream(STDOUT_FILENO).write(buffer, n);
    }
  }

  // =====================================================================================
  // "publish" command

  kj::Maybe<appindex::SubmissionState> publishState = appindex::SubmissionState::PUBLISH;
  // By default `spk publish` publishes the package.

  // https://alpha-api.sandstorm.io/#Rs-0TT13YrNSbv7Fiz5K9bBkLaJn3E5TB0PU1GSn1HE
  kj::String appIndexEndpoint = kj::heapString("https://alpha-api.sandstorm.io");
  kj::String appIndexToken = kj::heapString("Rs-0TT13YrNSbv7Fiz5K9bBkLaJn3E5TB0PU1GSn1HE");

  kj::MainFunc getPublishMain() {
    return addCommonOptions(OptionSet::KEYS_READONLY,
        kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
            "Publish an SPK to the Sandstorm app index, or check the status of a "
            "previous submission.")
        .addOption({'s', "status"}, [this]() {publishState = nullptr; return true;},
            "Just check the review status of a previously-submitted SPK.")
        .addOption({'e', "embargo"},
            [this]() {publishState = appindex::SubmissionState::REVIEW; return true;},
            "Embargoes the package, preventing it from being published publicly. However, "
            "it will still be actively reviewed. You may run the command again later without "
            "this flag to mark the app for publishing. This allows you to submit an app for "
            "review in advance of a launch date but still control the exact time of launch.")
        .addOption({'r', "remove"},
            [this]() {publishState = appindex::SubmissionState::IGNORE; return true;},
            "Removes a package listing. If the package was published, it is un-published. If the "
            "package was still pending review, the review is canceled.")
        .addOptionWithArg({"webkey"}, KJ_BIND_METHOD(*this, setPublishWebkey), "<webkey>",
            "Submit to the index at the given webkey. If not specified, the main Sandstorm "
            "app index is assumed.")
        .expectArg("<spkfile>", KJ_BIND_METHOD(*this, doPublish)))
        .build();
  }

  kj::MainBuilder::Validity setPublishWebkey(kj::StringPtr webkey) {
    auto parts = split(webkey, '#');
    if (parts.size() != 2) return "invalid webkey format";

    // Strip trailing slashes from host.
    while (parts[0].size() > 0 && parts[0][parts[0].size() - 1] == '/') {
      parts[0] = parts[0].slice(0, parts[0].size() - 1);
    }

    appIndexEndpoint = kj::str(parts[0]);
    appIndexToken = kj::str(parts[1]);

    if (!appIndexEndpoint.startsWith("http://") && !appIndexEndpoint.startsWith("https://")) {
      return "invalid webkey format";
    }

    return true;
  }

  kj::MainBuilder::Validity doPublish(kj::StringPtr spkfile) {
    if (appIndexEndpoint == nullptr) {
      context.exitError(
          "Hello! The publishing tool isn't quite ready yet, but if you have an app "
          "you'd like to publish please email kenton@sandstorm.io with a link to the spk!");
    }

    if (access(spkfile.cStr(), F_OK) < 0) {
      return "no such file";
    }

    capnp::MallocMessageBuilder scratch;
    auto arena = scratch.getOrphanage();

    auto infoOrphan = arena.newOrphan<spk::VerifiedInfo>();
    auto info = infoOrphan.get();
    auto spkfd = raiiOpen(spkfile, O_RDONLY);
    verifyImpl(spkfd, openTemporary("/tmp/spk-verify"), info,
        [&](kj::StringPtr problem) -> kj::String {
      validationError(spkfile, problem);
    });

    auto key = lookupKey(appIdString(info.getAppId()));

    capnp::MallocMessageBuilder requestMessage;
    auto request = requestMessage.getRoot<appindex::SubmissionRequest>();
    request.setPackageId(info.getPackageId());
    KJ_IF_MAYBE(s, publishState) {
      auto mutation = request.initSetState();
      mutation.setNewState(*s);
      mutation.setSequenceNumber(time(nullptr));
    } else {
      request.setCheckStatus();
    }
    auto webkey = kj::str(appIndexEndpoint, '#', appIndexToken);
    auto webkeyHash = request.initAppIndexWebkeyHash(16);
    crypto_generichash_blake2b(webkeyHash.begin(), webkeyHash.size(),
                               webkey.asBytes().begin(), webkey.size(), nullptr, 0);

    // TODO(cleanup): Need a kj::VectorOutputStream or something which can dynamically grow.
    byte buffer[1024];
    byte* messageEnd;
    {
      kj::ArrayOutputStream stream(buffer);
      capnp::writePackedMessage(stream, requestMessage);
      messageEnd = stream.getArray().end();
    }

    KJ_ASSERT(buffer + sizeof(buffer) - messageEnd >= crypto_sign_BYTES);
    crypto_sign_detached(messageEnd, nullptr, buffer, messageEnd - buffer,
                         key.getPrivateKey().begin());
    auto encodedRequest = kj::arrayPtr(buffer, messageEnd + crypto_sign_BYTES);

    for (;;) {
      {
        context.warning("talking to index server...");

        auto inPipe = Pipe::make();
        auto outPipe = Pipe::make();

        auto authHeader = kj::str("Authorization: Bearer ", appIndexToken);
        auto url = kj::str(appIndexEndpoint, "/status");
        Subprocess::Options curlOptions({
            "curl", "-sS", "-X", "POST", "--data-binary", "@-", "-H", authHeader, url});
        curlOptions.stdin = inPipe.readEnd;
        curlOptions.stdout = outPipe.writeEnd;
        Subprocess curl(kj::mv(curlOptions));
        inPipe.readEnd = nullptr;
        outPipe.writeEnd = nullptr;

        kj::FdOutputStream(inPipe.writeEnd.get())
            .write(encodedRequest.begin(), encodedRequest.size());
        inPipe.writeEnd = nullptr;
        auto data = readAllBytes(outPipe.readEnd);
        if (curl.waitForExit() != 0) {
          context.exitError("curl failed");
        }

        if (data.size() > 0 && data[0] == '\0') {
          // Binary!
          kj::ArrayInputStream dataStream(data.slice(1, data.size()));
          capnp::PackedMessageReader messageReader(dataStream);
          auto status = messageReader.getRoot<appindex::SubmissionStatus>();
          switch (status.which()) {
            case appindex::SubmissionStatus::PENDING:
              switch (status.getRequestState()) {
                case appindex::SubmissionState::IGNORE:
                  context.exitInfo(
                      "Your submission has been removed. It was never reviewed nor published.");
                case appindex::SubmissionState::REVIEW:
                  context.exitInfo(
                      "Your submission is being reviewed. Since you've asked that it be embargoed, "
                      "it won't be published when approved; you will need to run `spk publish` "
                      "again without -e.");
                case appindex::SubmissionState::PUBLISH:
                  context.exitInfo(
                      "Thanks for your submission! A human will look at your submission to make "
                      "sure that everything is in order before it goes live. If we spot any mistakes "
                      "we'll let you know, otherwise your app will go live as soon as it has been "
                      "checked. Either way, we'll send you an email at the contact address you "
                      "provided in the metadata. (If you'd like to prevent this submission "
                      "from going live immediately, run `spk publish` again with -e.)");
              }
              KJ_UNREACHABLE;

            case appindex::SubmissionStatus::NEEDS_UPDATE:
              switch (status.getRequestState()) {
                case appindex::SubmissionState::IGNORE:
                  context.exitInfo(kj::str(
                      "Your submission has been removed. For reference, before removal, a human "
                      "had checked your submission and found a problem. If you decide to submit "
                      "again, please correct this problem first: ", status.getNeedsUpdate()));
                case appindex::SubmissionState::REVIEW:
                case appindex::SubmissionState::PUBLISH:
                  context.exitInfo(kj::str(
                      "A human checked your submission and found a problem. Please correct the "
                      "following problem and submit again: ", status.getNeedsUpdate()));
              }
              KJ_UNREACHABLE;

            case appindex::SubmissionStatus::APPROVED:
              switch (status.getRequestState()) {
                case appindex::SubmissionState::IGNORE:
                  context.exitInfo(
                      "Your submission has been removed. It had already been reviewed and "
                      "approved, so if you change your mind you can publish it at any time "
                      "by running `spk publish` again without flags.");
                case appindex::SubmissionState::REVIEW:
                  context.exitInfo(
                      "Your submission is approved and can be published whenever you are ready. "
                      "Run `spk publish` again without flags to make your app live.");
                case appindex::SubmissionState::PUBLISH:
                  // TODO(soon): Add link? Only for default app market.
                  context.exitInfo(
                      "Your submission is approved and is currently live!");
              }
              KJ_UNREACHABLE;

            case appindex::SubmissionStatus::NOT_UPLOADED:
              // Need to upload first...
              if (publishState == nullptr) {
                context.exitInfo("This package has not been uploaded to the index.");
              }
              break;
          }
        } else {
          // Error message. :(
          kj::FdOutputStream(STDERR_FILENO).write(data.begin(), data.size());
          context.exitError("failed to connect to app index");
        }
      }

      {
        // If we get here, the server indicated that the app had not been uploaded.
        context.warning("uploading package to index...");

        KJ_SYSCALL(lseek(spkfd, 0, SEEK_SET));
        auto outPipe = Pipe::make();

        auto authHeader = kj::str("Authorization: Bearer ", appIndexToken);
        auto url = kj::str(appIndexEndpoint, "/upload");
        Subprocess::Options curlOptions({
            "curl", "-sS", "-X", "POST", "--data-binary", "@-", "-H", authHeader, url});
        curlOptions.stdin = spkfd;
        curlOptions.stdout = outPipe.writeEnd;
        Subprocess curl(kj::mv(curlOptions));
        outPipe.writeEnd = nullptr;

        auto response = readAll(outPipe.readEnd);
        if (curl.waitForExit() != 0) {
          context.exitError("curl failed");
        }
        if (response.size() > 0) {
          context.exitError(kj::str(
              "server returned error on upload: ", response));
        }
      }
    }
  }
};

kj::Own<AbstractMain> getSpkMain(kj::ProcessContext& context) {
  return kj::heap<SpkTool>(context);
}

kj::String unpackSpk(int spkfd, kj::StringPtr outdir, kj::StringPtr tmpdir) {
  return SpkTool::unpackImpl(spkfd, outdir, kj::str(tmpdir, "/spk-unpack-tmp"),
      [](kj::StringPtr problem) -> kj::String {
    KJ_FAIL_ASSERT("spk unpack failed", problem);
  });
}

void verifySpk(int spkfd, int tmpfile, spk::VerifiedInfo::Builder output) {
  SpkTool::verifyImpl(spkfd, tmpfile, output, [](kj::StringPtr problem) -> kj::String {
    KJ_FAIL_ASSERT("spk verification failed", problem);
  });
}

kj::Maybe<kj::String> checkPgpSignature(kj::StringPtr appIdString, spk::Metadata::Reader metadata,
                                        kj::Maybe<uid_t> sandboxUid) {
  auto author = metadata.getAuthor();

  if (author.hasPgpSignature()) {
    KJ_REQUIRE(metadata.hasPgpKeyring(), "package metadata contains PGP signature but no keyring");

    kj::Function<kj::String(kj::StringPtr problem)> error =
        [](kj::StringPtr problem) -> kj::String {
      KJ_FAIL_ASSERT("PGP signature verification problem", problem);
    };
    return SpkTool::checkPgpSignature(appIdString,
        author.getPgpSignature(), metadata.getPgpKeyring(), error, sandboxUid);
  } else {
    return nullptr;
  }
}

}  // namespace sandstorm
