// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2026 Sandstorm contributors
// Licensed under the Apache License, Version 2.0.

#include "backend.h"

#include <capnp/message.h>
#include <kj/async-io.h>
#include <kj/debug.h>

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <string.h>
#include <unistd.h>

namespace sandstorm {
namespace {

class TestCore final: public SandstormCore::Server {};

class TestCoreFactory final: public SandstormCoreFactory::Server {
public:
  kj::Promise<void> getSandstormCore(GetSandstormCoreContext context) override {
    context.getResults().setCore(kj::heap<TestCore>());
    return kj::READY_NOW;
  }
};

pid_t readOnlyChildPid() {
  auto path = kj::str("/proc/self/task/", getpid(), "/children");
  int rawFd;
  KJ_SYSCALL(rawFd = open(path.cStr(), O_RDONLY | O_CLOEXEC));
  kj::AutoCloseFd fd(rawFd);
  char buffer[128];
  ssize_t count;
  KJ_SYSCALL(count = read(fd, buffer, sizeof(buffer) - 1));
  buffer[count] = '\0';

  char* end = nullptr;
  errno = 0;
  auto pid = strtol(buffer, &end, 10);
  KJ_REQUIRE(errno == 0 && end != buffer && pid > 0, "backend account host child is missing");
  while (*end == ' ') ++end;
  KJ_REQUIRE(*end == '\0', "backend recovery test unexpectedly has multiple children", buffer);
  return pid;
}

void waitUntilZombie(pid_t pid) {
  auto path = kj::str("/proc/", pid, "/stat");
  for (uint attempt = 0; attempt < 1000; ++attempt) {
    int rawFd = open(path.cStr(), O_RDONLY | O_CLOEXEC);
    if (rawFd >= 0) {
      kj::AutoCloseFd fd(rawFd);
      char buffer[512];
      ssize_t count;
      KJ_SYSCALL(count = read(fd, buffer, sizeof(buffer) - 1));
      buffer[count] = '\0';
      if (strstr(buffer, ") Z") != nullptr) return;
    }
    usleep(1000);
  }
  KJ_FAIL_REQUIRE("account host did not exit after SIGKILL", pid);
}

Supervisor::Client startGrain(kj::WaitScope& waitScope, Backend::Client backend,
    spk::Manifest::Command::Reader command, kj::StringPtr grainId, bool isNew) {
  auto request = backend.startGrainRequest();
  request.setOwnerId("testaccount123");
  request.setGrainId(grainId);
  request.setPackageId("testpackage123");
  request.setCommand(command);
  request.setIsNew(isNew);
  request.setDevMode(true);
  return request.send().wait(waitScope).getSupervisor();
}

void shutdown(kj::WaitScope& waitScope, Supervisor::Client supervisor) {
  supervisor.shutdownRequest().send().wait(waitScope);
}

void keepAlive(kj::WaitScope& waitScope, Supervisor::Client supervisor) {
  auto request = supervisor.keepAliveRequest();
  request.setCore(kj::heap<TestCore>());
  request.send().wait(waitScope);
}

}  // namespace
}  // namespace sandstorm

int main(int argc, char** argv) {
  KJ_REQUIRE(argc == 6,
      "usage: isolate-backend-recovery-test <sandstorm> <native-host> "
      "<app-root> <grain-root> <state-root>");

  auto io = kj::setupAsyncIo();
  sandstorm::SandstormCoreFactory::Client coreFactory = kj::heap<sandstorm::TestCoreFactory>();
  sandstorm::Backend::Client backend = kj::heap<sandstorm::BackendImpl>(
      *io.lowLevelProvider,
      io.provider->getNetwork(),
      kj::mv(coreFactory),
      nullptr,
      nullptr,
      false,
      false,
      sandstorm::IsolateAccountHostPaths{
        kj::str(argv[1]),
        kj::str(argv[2]),
        kj::str(argv[3]),
        kj::str(argv[4]),
        kj::str(argv[5]),
      });

  capnp::MallocMessageBuilder commandMessage;
  auto command = commandMessage.initRoot<sandstorm::spk::Manifest::Command>();
  auto isolate = command.initIsolate();
  isolate.setMainModule("worker.js");
  isolate.setCompatibilityDate("2025-01-01");

  // Development isolate packages use the same account/native-host path as installed packages.
  auto first = sandstorm::startGrain(
      io.waitScope, backend, command.asReader(), "testgrain123", true);
  sandstorm::keepAlive(io.waitScope, first);

  // A stopped grain leaves a stale supervisor capability in BackendImpl until the next start.
  // Its keepAlive failure is local to that grain and must not recycle the shared account host.
  auto sibling = sandstorm::startGrain(
      io.waitScope, backend, command.asReader(), "testgrain456", true);
  sandstorm::keepAlive(io.waitScope, sibling);
  auto originalAccountPid = sandstorm::readOnlyChildPid();
  sandstorm::shutdown(io.waitScope, first);
  auto restarted = sandstorm::startGrain(
      io.waitScope, backend, command.asReader(), "testgrain123", false);
  sandstorm::keepAlive(io.waitScope, restarted);
  KJ_REQUIRE(sandstorm::readOnlyChildPid() == originalAccountPid,
      "a grain-local keepAlive failure recycled the shared account host");
  sandstorm::keepAlive(io.waitScope, sibling);

  auto accountPid = sandstorm::readOnlyChildPid();
  KJ_SYSCALL(kill(accountPid, SIGKILL));
  sandstorm::waitUntilZombie(accountPid);

  // Issue the restart before BackendImpl has a chance to consume its disconnect notification.
  // Recovery must invalidate both the stale supervisor and the stale per-account host cache.
  auto recovered = sandstorm::startGrain(
      io.waitScope, backend, command.asReader(), "testgrain123", false);
  sandstorm::keepAlive(io.waitScope, recovered);
  return 0;
}
