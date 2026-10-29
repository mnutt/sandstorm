#pragma once

#include "sandstorm/isolate-worker-source.capnp.h"
#include <kj/string.h>

namespace sandstorm {
// Supply both module names used by Sandstorm's generated schema imports.
void addIsolateHostModuleAliases(IsolateWorkerSource::Builder source);
kj::String isolateHostServicePath(kj::StringPtr url);
kj::String isolateHostIngressUrl(kj::StringPtr url);
}
