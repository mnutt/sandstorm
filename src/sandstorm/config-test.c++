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

KJ_TEST("Rust shell origin uses BASE_URL hostname and its own port") {
  Config config;
  config.rustShellPort = 7443;
  config.rootUrl = kj::str("https://example.test");
  KJ_EXPECT(rustShellOrigin(config) == "https://example.test:7443");
  config.rootUrl = kj::str("https://example.test:8443/");
  KJ_EXPECT(rustShellOrigin(config) == "https://example.test:7443");
  config.rootUrl = kj::str("https://[::1]:8443");
  KJ_EXPECT(rustShellOrigin(config) == "https://[::1]:7443");
  config.rustShellPort = 443;
  KJ_EXPECT(rustShellOrigin(config) == "https://[::1]");
}

Config parse(kj::StringPtr extra) {
  return parseTestConfig(kj::str("PORT=6080\nHTTPS_PORT=443\nBASE_URL=https://example.test\n",
      "MONGO_PORT=6081\n", extra, "\n"));
}

KJ_TEST("Rust shell listener is opt-in and rejects conflicting ports or HTTP") {
  KJ_EXPECT(parse("").rustShellPort == nullptr);
  auto valid = parse("RUST_SHELL_PORT=7443");
  KJ_EXPECT(KJ_REQUIRE_NONNULL(valid.rustShellPort) == 7443);
  KJ_EXPECT_THROW_MESSAGE("conflicts", parse("RUST_SHELL_PORT=6081"));
  KJ_EXPECT_THROW_MESSAGE("conflicts", parse("RUST_SHELL_PORT=443"));
  KJ_EXPECT_THROW_MESSAGE("conflicts", parse("RUST_SHELL_PORT=6080"));
  KJ_EXPECT_THROW_MESSAGE("invalid", parse("RUST_SHELL_PORT=65536"));
  KJ_EXPECT_THROW_MESSAGE("invalid", parse("RUST_SHELL_PORT=0"));
  KJ_EXPECT_THROW_MESSAGE("requires", parse("BASE_URL=http://example.test\nRUST_SHELL_PORT=7443"));
}

KJ_TEST("Rust frontend development proxy is opt-in and rejects conflicting ports") {
  KJ_EXPECT(parse("RUST_SHELL_PORT=7443").rustShellDevPort == nullptr);
  auto config = parse("RUST_SHELL_PORT=7443\nRUST_SHELL_DEV_PORT=5173");
  KJ_EXPECT(KJ_REQUIRE_NONNULL(config.rustShellDevPort) == 5173);
  KJ_EXPECT_THROW_MESSAGE("requires", parse("RUST_SHELL_DEV_PORT=5173"));
  KJ_EXPECT_THROW_MESSAGE("invalid", parse("RUST_SHELL_PORT=7443\nRUST_SHELL_DEV_PORT=0"));
  KJ_EXPECT_THROW_MESSAGE("conflicts", parse("RUST_SHELL_PORT=7443\nRUST_SHELL_DEV_PORT=7443"));
  KJ_EXPECT_THROW_MESSAGE("conflicts", parse("RUST_SHELL_PORT=7443\nRUST_SHELL_DEV_PORT=443"));
}

KJ_TEST("Sandhost explicit addressing and Rust HTTPS listener coexist") {
  auto config = parse("SANDCATS_BACKEND=sandhost\nSANDCATS_BASE_DOMAIN=sandhost.org\n"
      "SANDCATS_ADDRESS_MODE=explicit\nSANDCATS_IP_ADDRESS=100.89.147.5\n"
      "BASE_URL=https://yertle.sandhost.org\nRUST_SHELL_PORT=7443\n"
      "RUST_SHELL_BIND_IP=100.89.147.5");
  KJ_EXPECT(config.sandcatsBackend == "sandhost");
  KJ_EXPECT(config.sandcatsHostname == "sandhost.org");
  KJ_EXPECT(config.sandcatsIpAddress == "100.89.147.5");
  KJ_EXPECT(rustShellOrigin(config) == "https://yertle.sandhost.org:7443");
}

}  // namespace
}  // namespace sandstorm
