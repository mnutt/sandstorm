#include "isolate-native-host-launch.h"

#include "sandbox.h"
#include "util.h"

#include <kj/debug.h>

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <seccomp.h>
#include <signal.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef PR_SET_NO_NEW_PRIVS
#define PR_SET_NO_NEW_PRIVS 38
#endif
#ifndef PR_SET_VMA
#define PR_SET_VMA 0x53564d41
#endif

namespace sandstorm {
namespace {

void resetSignalHandlersForExec() {
  for (uint i = 0; i < NSIG; i++) {
    ::signal(i, SIG_DFL);
  }

  sigset_t sigmask;
  sigemptyset(&sigmask);
  KJ_SYSCALL(sigprocmask(SIG_SETMASK, &sigmask, nullptr));
}

void setupNativeHostParentDeathSignal() {
  KJ_SYSCALL(prctl(PR_SET_PDEATHSIG, SIGTERM));
  if (getppid() == 1) {
    _exit(1);
  }
}

void setupNativeHostProcessGroup() {
  KJ_SYSCALL(setpgid(0, 0));
}

void closeUnexpectedNativeHostFds(kj::ArrayPtr<const int> preservedFds = nullptr) {
  kj::Vector<int> fds;
  DIR* dir = opendir("/proc/self/fd");
  if (dir == nullptr) {
    KJ_FAIL_SYSCALL("opendir(/proc/self/fd)", errno);
  }
  KJ_DEFER(KJ_SYSCALL(closedir(dir)) { break; });

  for (;;) {
    errno = 0;
    auto entry = readdir(dir);
    if (entry == nullptr) {
      if (errno != 0) {
        KJ_FAIL_SYSCALL("readdir(/proc/self/fd)", errno);
      }
      break;
    }

    if (entry->d_name[0] != '.') {
      char* end;
      int fd = strtoul(entry->d_name, &end, 10);
      if (*end == '\0' && end > entry->d_name && fd > STDERR_FILENO && fd != dirfd(dir)) {
        bool preserve = false;
        for (auto preserved: preservedFds) {
          if (fd == preserved) preserve = true;
        }
        if (!preserve) fds.add(fd);
      }
    }
  }

  for (auto fd: fds) {
    close(fd);
  }
}

void setupNativeHostResourceLimits() {
  struct rlimit nofile;
  memset(&nofile, 0, sizeof(nofile));
  nofile.rlim_cur = 1024;
  nofile.rlim_max = 4096;
  KJ_SYSCALL(setrlimit(RLIMIT_NOFILE, &nofile));

  struct rlimit core;
  memset(&core, 0, sizeof(core));
  KJ_SYSCALL(setrlimit(RLIMIT_CORE, &core));
}

void finishNativeHostNamespaceSetup() {
  KJ_SYSCALL(mount("none", "/", nullptr, MS_REC | MS_PRIVATE, nullptr));
  KJ_SYSCALL(sethostname("sandbox", 7));
  KJ_SYSCALL(setdomainname("sandbox", 7));
}

void nativeHostBind(kj::StringPtr src, kj::StringPtr dst, unsigned long flags) {
  KJ_SYSCALL(mount(src.cStr(), dst.cStr(), nullptr, MS_BIND | MS_REC, nullptr), src, dst);
  KJ_SYSCALL(mount(src.cStr(), dst.cStr(), nullptr,
      MS_BIND | MS_REC | MS_REMOUNT | flags, nullptr), src, dst);
}

kj::String nativeHostRootPath(kj::StringPtr absolutePath) {
  KJ_REQUIRE(absolutePath.startsWith("/"), "Expected absolute native-host path.", absolutePath);
  if (absolutePath == "/") {
    return kj::heapString("/tmp");
  } else {
    return kj::str("/tmp", absolutePath);
  }
}

void ensureNativeHostDirectory(kj::StringPtr path, mode_t mode = 0755) {
  if (mkdir(path.cStr(), mode) != 0) {
    int error = errno;
    if (error != EEXIST) {
      KJ_FAIL_SYSCALL("mkdir", error, path);
    }
  }
}

void bindNativeHostDirectory(kj::StringPtr src, unsigned long flags) {
  if (access(src.cStr(), F_OK) != 0) {
    int error = errno;
    if (error == ENOENT || error == ENOTDIR) {
      return;
    }
    KJ_FAIL_SYSCALL("access", error, src);
  }

  auto dst = nativeHostRootPath(src);
  recursivelyCreateParent(dst);
  ensureNativeHostDirectory(dst);
  nativeHostBind(src, dst, flags);
}

void bindNativeHostFile(kj::StringPtr src, unsigned long flags, mode_t mode = 0644) {
  if (access(src.cStr(), F_OK) != 0) {
    int error = errno;
    if (error == ENOENT || error == ENOTDIR) {
      return;
    }
    KJ_FAIL_SYSCALL("access", error, src);
  }

  auto dst = nativeHostRootPath(src);
  recursivelyCreateParent(dst);
  KJ_SYSCALL(mknod(dst.cStr(), S_IFREG | mode, 0), dst);
  nativeHostBind(src, dst, flags);
}

void bindNativeHostRuntimeLibraryFile(kj::StringPtr src) {
  bindNativeHostFile(src, MS_RDONLY | MS_NOSUID | MS_NODEV, 0755);
}

void bindNativeHostRuntimeLibraryCandidates(kj::StringPtr name) {
  bindNativeHostRuntimeLibraryFile(kj::str("/lib/", name));
  bindNativeHostRuntimeLibraryFile(kj::str("/lib64/", name));
  bindNativeHostRuntimeLibraryFile(kj::str("/usr/lib/", name));
  bindNativeHostRuntimeLibraryFile(kj::str("/usr/lib64/", name));
  bindNativeHostRuntimeLibraryFile(kj::str("/lib/x86_64-linux-gnu/", name));
  bindNativeHostRuntimeLibraryFile(kj::str("/usr/lib/x86_64-linux-gnu/", name));
}

void bindNativeHostRuntimeLibraries() {
  bindNativeHostRuntimeLibraryFile("/lib64/ld-linux-x86-64.so.2");
  bindNativeHostRuntimeLibraryFile("/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2");

  bindNativeHostRuntimeLibraryCandidates("libc.so.6");
  bindNativeHostRuntimeLibraryCandidates("libm.so.6");

  // These are not needed by the current embedded workerd build on all distros, but
  // are common C/C++ runtime dependencies. Keep this list file-based rather
  // than mounting whole library directories.
  bindNativeHostRuntimeLibraryCandidates("libdl.so.2");
  bindNativeHostRuntimeLibraryCandidates("libpthread.so.0");
  bindNativeHostRuntimeLibraryCandidates("librt.so.1");
  bindNativeHostRuntimeLibraryCandidates("libstdc++.so.6");
  bindNativeHostRuntimeLibraryCandidates("libgcc_s.so.1");
}

void setupConfinedRuntimeMountRoot(
    kj::StringPtr trustedExecutable, kj::Maybe<kj::StringPtr> runtimeBundleDir) {
  auto oldUmask = umask(0);
  KJ_DEFER(umask(oldUmask));

  KJ_SYSCALL(mount("sandstorm-isolate-native-host-root", "/tmp", "tmpfs",
      MS_NOSUID | MS_NODEV, "size=64m,nr_inodes=4096,mode=755"));

  ensureNativeHostDirectory("/tmp/tmp", 0777);
  ensureNativeHostDirectory("/tmp/dev", 0755);
  KJ_SYSCALL(mount("sandstorm-isolate-native-host-dev", "/tmp/dev", "tmpfs",
      MS_NOATIME | MS_NOSUID | MS_NOEXEC, "size=1m,nr_inodes=16,mode=755"));
  bindNativeHostFile("/dev/null", MS_NOSUID | MS_NOEXEC);
  bindNativeHostFile("/dev/zero", MS_NOSUID | MS_NOEXEC);
  bindNativeHostFile("/dev/random", MS_NOSUID | MS_NOEXEC);
  bindNativeHostFile("/dev/urandom", MS_NOSUID | MS_NOEXEC);
  KJ_SYSCALL(mount("/tmp/dev", "/tmp/dev", nullptr,
      MS_BIND | MS_REMOUNT | MS_RDONLY | MS_NOSUID | MS_NOEXEC, nullptr));

  KJ_IF_MAYBE(bundleDir, runtimeBundleDir) {
    bindNativeHostDirectory(*bundleDir, MS_NOSUID | MS_NODEV);
  }
  bindNativeHostFile(trustedExecutable, MS_RDONLY | MS_NOSUID | MS_NODEV, 0755);
  bindNativeHostRuntimeLibraries();
  bindNativeHostFile("/etc/ld.so.cache", MS_RDONLY | MS_NOSUID | MS_NOEXEC | MS_NODEV);

  KJ_SYSCALL(chroot("/tmp"));
  KJ_SYSCALL(chdir("/"));
  KJ_LOG(INFO, "Native isolate host entered minimal mount root.", trustedExecutable);
}

bool trySetupNativeHostNamespaces(kj::Maybe<uid_t> sandboxUid) {
  KJ_IF_MAYBE(u, sandboxUid) {
    if (unshare(CLONE_NEWNET | CLONE_NEWNS | CLONE_NEWIPC | CLONE_NEWUTS) < 0) {
      int error = errno;
      KJ_FAIL_SYSCALL("unshare(CLONE_NEWNET | CLONE_NEWNS | CLONE_NEWIPC | CLONE_NEWUTS)",
          error);
    } else {
      finishNativeHostNamespaceSetup();
      KJ_LOG(INFO, "Native isolate host entered private network/mount/ipc/uts namespaces.");
      return true;
    }
  }

  uid_t realUid = getuid();
  gid_t realGid = getgid();

  if (unshare(CLONE_NEWUSER | CLONE_NEWNET | CLONE_NEWNS | CLONE_NEWIPC | CLONE_NEWUTS) < 0) {
    int error = errno;
    KJ_FAIL_SYSCALL(
        "unshare(CLONE_NEWUSER | CLONE_NEWNET | CLONE_NEWNS | CLONE_NEWIPC | CLONE_NEWUTS)",
        error);
  }

  sandbox::hideUserGroupIds(realUid, realGid, false);
  finishNativeHostNamespaceSetup();
  KJ_LOG(INFO, "Native isolate host entered private user/network/mount/ipc/uts namespaces.");
  return true;
}

void setupNativeHostSeccomp(bool logSeccompViolations) {
  scmp_filter_ctx ctx = seccomp_init(SCMP_ACT_ERRNO(ENOSYS));
  if (ctx == nullptr) {
    KJ_FAIL_SYSCALL("seccomp_init", 0);
  }
  KJ_DEFER(seccomp_release(ctx));

#define CHECK_SECCOMP(call)                   \
  do {                                        \
    if (auto result = (call)) {               \
      KJ_FAIL_SYSCALL(#call, -result);        \
    }                                         \
  } while (0)

  CHECK_SECCOMP(seccomp_attr_set(ctx, SCMP_FLTATR_CTL_NNP, 1));
  CHECK_SECCOMP(seccomp_attr_set(ctx, SCMP_FLTATR_ACT_BADARCH, SCMP_ACT_ERRNO(ENOSYS)));
  if (logSeccompViolations) {
    CHECK_SECCOMP(seccomp_attr_set(ctx, SCMP_FLTATR_CTL_LOG, 1));
  }

#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wmissing-field-initializers"
  // This allowlist is based on post-exec native-host workerd traces. Calls used only while setting up
  // namespaces, mounts, credential drops, or seccomp itself intentionally stay
  // unavailable after the filter is loaded.
  int allowedSyscalls[] = {
    SCMP_SYS(accept4),
    SCMP_SYS(access),
    SCMP_SYS(arch_prctl),
    SCMP_SYS(bind),
    SCMP_SYS(brk),
    SCMP_SYS(clock_nanosleep),
    SCMP_SYS(close),
    SCMP_SYS(connect),
    SCMP_SYS(dup),
    SCMP_SYS(dup2),
    SCMP_SYS(epoll_create1),
    SCMP_SYS(epoll_ctl),
    SCMP_SYS(epoll_pwait),
    SCMP_SYS(epoll_wait),
    SCMP_SYS(eventfd2),
    SCMP_SYS(execve),
    SCMP_SYS(exit),
    SCMP_SYS(exit_group),
    SCMP_SYS(fcntl),
    SCMP_SYS(fstat),
    SCMP_SYS(futex),
    SCMP_SYS(getcwd),
    SCMP_SYS(getpid),
    SCMP_SYS(getrandom),
    SCMP_SYS(getsockopt),
    SCMP_SYS(gettid),
    SCMP_SYS(ioctl),
    SCMP_SYS(listen),
    SCMP_SYS(lseek),
    SCMP_SYS(madvise),
    SCMP_SYS(mmap),
    SCMP_SYS(mprotect),
    SCMP_SYS(munmap),
    SCMP_SYS(newfstatat),
    SCMP_SYS(openat),
    SCMP_SYS(pipe2),
    SCMP_SYS(pkey_alloc),
    SCMP_SYS(poll),
    SCMP_SYS(pread64),
    SCMP_SYS(prlimit64),
    SCMP_SYS(read),
    SCMP_SYS(readlink),
    SCMP_SYS(readlinkat),
    SCMP_SYS(readv),
    SCMP_SYS(rt_sigaction),
    SCMP_SYS(rt_sigprocmask),
    SCMP_SYS(rt_sigreturn),
    SCMP_SYS(sched_getaffinity),
    SCMP_SYS(sched_getparam),
    SCMP_SYS(sched_getscheduler),
    SCMP_SYS(set_tid_address),
    SCMP_SYS(setsockopt),
    SCMP_SYS(sigaltstack),
    SCMP_SYS(splice),
    SCMP_SYS(umask),
    SCMP_SYS(uname),
    SCMP_SYS(write),
    SCMP_SYS(writev),
  };

  for (auto syscall: allowedSyscalls) {
    CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ALLOW, syscall, 0));
  }

  // Do not allow clone3(): libseccomp cannot inspect the pointed-to clone_args
  // flags. Returning ENOSYS makes glibc fall back to clone(), where we can at
  // least reject namespace-creating flags.
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(clone), 1,
      SCMP_A0(SCMP_CMP_MASKED_EQ,
          CLONE_NEWNS | CLONE_NEWUTS | CLONE_NEWIPC | CLONE_NEWUSER |
          CLONE_NEWPID | CLONE_NEWNET, 0)));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(prctl), 1,
      SCMP_A0(SCMP_CMP_EQ, PR_SET_NAME)));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(prctl), 1,
      SCMP_A0(SCMP_CMP_EQ, PR_SET_VMA)));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(socket), 1,
      SCMP_A0(SCMP_CMP_EQ, AF_UNIX)));

  CHECK_SECCOMP(seccomp_load(ctx));
#pragma GCC diagnostic pop
#undef CHECK_SECCOMP
}

}  // namespace

int runConfinedNativeIsolateHost(
    kj::String trustedHost,
    kj::AutoCloseFd controlSocket,
    kj::Maybe<uid_t> sandboxUid,
    bool logSeccompViolations) {
  static constexpr int CONTROL_FD = 3;
  resetSignalHandlersForExec();
  setupNativeHostParentDeathSignal();
  setupNativeHostProcessGroup();

  int sourceFd = controlSocket.release();
  if (sourceFd != CONTROL_FD) {
    KJ_SYSCALL(dup2(sourceFd, CONTROL_FD));
    KJ_SYSCALL(close(sourceFd));
  } else {
    KJ_SYSCALL(fcntl(CONTROL_FD, F_SETFD, 0));
  }

  auto devNull = raiiOpen("/dev/null", O_RDONLY | O_CLOEXEC);
  KJ_SYSCALL(dup2(devNull, STDIN_FILENO));
  devNull = nullptr;
  int preservedFd = CONTROL_FD;
  closeUnexpectedNativeHostFds(kj::arrayPtr(&preservedFd, 1));

  bool hasPrivateNamespaces = trySetupNativeHostNamespaces(sandboxUid);
  if (hasPrivateNamespaces) {
    setupConfinedRuntimeMountRoot(trustedHost, nullptr);
  }
  KJ_IF_MAYBE(u, sandboxUid) {
    KJ_SYSCALL(setresuid(*u, *u, *u));
  }
  setupNativeHostResourceLimits();
  KJ_SYSCALL(prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0));
  setupNativeHostSeccomp(logSeccompViolations);

  char* argv[] = {
    const_cast<char*>(trustedHost.cStr()),
    const_cast<char*>("--control-fd"),
    const_cast<char*>("3"),
    nullptr,
  };
  char* environment[] = {
    const_cast<char*>("LANG=C.UTF-8"),
    nullptr,
  };
  KJ_SYSCALL(execve(trustedHost.cStr(), argv, environment), trustedHost);
  KJ_UNREACHABLE;
}

}  // namespace sandstorm
