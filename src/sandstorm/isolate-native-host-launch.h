// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2026 Sandstorm contributors
// Licensed under the Apache License, Version 2.0.

#ifndef SANDSTORM_ISOLATE_NATIVE_HOST_LAUNCH_H_
#define SANDSTORM_ISOLATE_NATIVE_HOST_LAUNCH_H_

#include <kj/io.h>
#include <kj/memory.h>
#include <kj/string.h>

#include <sys/types.h>

namespace sandstorm {

int runConfinedNativeIsolateHost(
    kj::String trustedHost,
    kj::AutoCloseFd controlSocket,
    kj::Maybe<uid_t> sandboxUid,
    bool logSeccompViolations);

}  // namespace sandstorm

#endif  // SANDSTORM_ISOLATE_NATIVE_HOST_LAUNCH_H_
