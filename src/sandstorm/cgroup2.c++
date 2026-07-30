#include <sandstorm/cgroup2.h>
#include <sandstorm/util.h>

#include <kj/debug.h>
#include <errno.h>
#include <time.h>
#include <unistd.h>

namespace sandstorm {

namespace {

constexpr unsigned int CGROUP_REMOVE_ATTEMPTS = 50;
constexpr unsigned int CGROUP_REMOVE_RETRY_NANOS = 10 * 1000 * 1000;

void sleepBeforeRetryingCgroupRemove() {
  struct timespec request;
  request.tv_sec = 0;
  request.tv_nsec = CGROUP_REMOVE_RETRY_NANOS;

  while (nanosleep(&request, &request) != 0) {
    int error = errno;
    if (error != EINTR) {
      KJ_FAIL_SYSCALL("nanosleep", error);
    }
  }
}

void killCgroupProcesses(int dirfd, kj::StringPtr path) {
  int killFd = openat(dirfd, "cgroup.kill", O_WRONLY | O_CLOEXEC);
  if (killFd < 0) {
    int error = errno;
    if (error != ENOENT) {
      KJ_LOG(WARNING, "Could not open cgroup.kill while removing busy cgroup.", path, error);
    }
    return;
  }

  kj::AutoCloseFd killFile(killFd);
  if (write(killFile.get(), "1\n", 2) < 0) {
    KJ_LOG(WARNING, "Could not kill processes in busy cgroup.", path, errno);
  }
}

}  // namespace

Cgroup::Cgroup(kj::StringPtr path)
  : dirfd(raiiOpen(path, O_DIRECTORY|O_CLOEXEC))
{}

Cgroup::Cgroup(kj::AutoCloseFd&& dirfd)
  : dirfd(kj::mv(dirfd))
{}

Cgroup Cgroup::getOrMakeChild(kj::StringPtr path) {
  KJ_SYSCALL_HANDLE_ERRORS(mkdirat(dirfd.get(), path.cStr(), 0700)) {
    case EEXIST:
      break;
    default:
      KJ_FAIL_SYSCALL("mkdirat()", error);
  }

  return getChild(path);
}

Cgroup Cgroup::getChild(kj::StringPtr path) {
  return Cgroup(raiiOpenAt(dirfd.get(), path, O_DIRECTORY|O_CLOEXEC));
}

void Cgroup::removeChild(kj::StringPtr path) {
  bool triedKill = false;
  for (unsigned int attempt = 0; attempt < CGROUP_REMOVE_ATTEMPTS; attempt++) {
    if (unlinkat(dirfd.get(), path.cStr(), AT_REMOVEDIR) == 0) {
      return;
    }

    int error = errno;
    if (error == ENOENT) {
      return;
    }

    if (error == EBUSY) {
      if (!triedKill) {
        KJ_IF_MAYBE(child, raiiOpenAtIfExists(dirfd.get(), path, O_DIRECTORY | O_CLOEXEC)) {
          killCgroupProcesses(child->get(), path);
        }
        triedKill = true;
      }

      sleepBeforeRetryingCgroupRemove();
      continue;
    }

    KJ_FAIL_SYSCALL("unlinkat(..., AT_REMOVEDIR)", error, path);
  }

  KJ_LOG(WARNING, "Leaving busy cgroup behind after cleanup retries.", path);
}

void Cgroup::addPid(pid_t pid) {
  auto procsfd = raiiOpenAt(dirfd.get(), "cgroup.procs", O_WRONLY);
  auto pidStr = kj::str(pid);
  auto cStr = pidStr.cStr();
  KJ_SYSCALL(write(procsfd.get(), cStr, strlen(cStr)));
}

kj::Maybe<Cgroup::FreezeHandle> Cgroup::freeze() {
  KJ_IF_MAYBE(freezeFd, raiiOpenAtIfExists(dirfd.get(), "cgroup.freeze", O_WRONLY)) {
    KJ_SYSCALL(write(freezeFd->get(), "1\n", 2));
    return Cgroup::FreezeHandle(kj::mv(*freezeFd));
  } else {
    return nullptr;
  }
}

Cgroup::FreezeHandle::FreezeHandle(kj::AutoCloseFd&& fd) : fd(kj::mv(fd)) {}

Cgroup::FreezeHandle::~FreezeHandle() noexcept(false) {
  int freezeFd = fd.get();
  if(freezeFd >= 0) {
    KJ_SYSCALL(write(freezeFd, "0\n", 2));
  }
}

};
