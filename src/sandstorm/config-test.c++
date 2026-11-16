#include "config.h"
#include <kj/debug.h>
#include <kj/test.h>
#include <cstdio>

namespace sandstorm {
namespace {

Config parseTestConfig(kj::StringPtr text) {
  auto file = tmpfile();
  KJ_REQUIRE(file != nullptr);
  KJ_DEFER(fclose(file));
  KJ_REQUIRE(fwrite(text.begin(), 1, text.size(), file) == text.size());
  KJ_REQUIRE(fflush(file) == 0);
  return readConfig(kj::str("/proc/self/fd/", fileno(file)).cStr(), false);
}

KJ_TEST("Sandcats backend is explicit and preserves legacy configuration") {
  auto disabled = parseTestConfig("PORT=6080\n");
  KJ_EXPECT(disabled.sandcatsBackend == "legacy");
  KJ_EXPECT(disabled.sandcatsHostname.size() == 0);
  auto legacy = parseTestConfig("SANDCATS_BASE_DOMAIN=sandcats.io\n");
  KJ_EXPECT(legacy.sandcatsBackend == "legacy");
  KJ_EXPECT(legacy.sandcatsHostname == "sandcats.io");
  auto modern = parseTestConfig("SANDCATS_BACKEND=sandhost\n");
  KJ_EXPECT(modern.sandcatsHostname == "sandcats.org");
  KJ_EXPECT(modern.sandcatsAddressMode == "observed");
  auto custom = parseTestConfig("SANDCATS_BASE_DOMAIN=sandhost.org\n"
      "SANDCATS_IP_ADDRESS=100.64.1.2\nSANDCATS_ADDRESS_MODE=explicit\n"
      "SANDCATS_BACKEND=sandhost\n");
  KJ_EXPECT(custom.sandcatsHostname == "sandhost.org");
  KJ_EXPECT(custom.sandcatsAddressMode == "explicit");
  KJ_EXPECT(custom.sandcatsIpAddress == "100.64.1.2");
}

KJ_TEST("Invalid Sandcats backend and address mode combinations fail closed") {
  KJ_EXPECT_THROW_MESSAGE("Invalid SANDCATS_BACKEND", parseTestConfig("SANDCATS_BACKEND=typo\n"));
  KJ_EXPECT_THROW_MESSAGE("Invalid SANDCATS_ADDRESS_MODE",
      parseTestConfig("SANDCATS_BACKEND=sandhost\nSANDCATS_ADDRESS_MODE=typo\n"));
  KJ_EXPECT_THROW_MESSAGE("requires SANDCATS_BACKEND=sandhost",
      parseTestConfig("SANDCATS_ADDRESS_MODE=explicit\n"));
  KJ_EXPECT_THROW_MESSAGE("must be a Tailscale IPv4",
      parseTestConfig("SANDCATS_BACKEND=sandhost\nSANDCATS_ADDRESS_MODE=explicit\n"
          "SANDCATS_IP_ADDRESS=8.8.8.8\n"));
  KJ_EXPECT_THROW_MESSAGE("requires SANDCATS_ADDRESS_MODE=explicit",
      parseTestConfig("SANDCATS_BACKEND=sandhost\nSANDCATS_IP_ADDRESS=100.64.1.2\n"));
}

}  // namespace
}  // namespace sandstorm
