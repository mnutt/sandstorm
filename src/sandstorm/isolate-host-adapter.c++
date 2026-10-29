#include "isolate-host-adapter.h"

#include <capnp/orphan.h>
#include <kj/debug.h>
#include <kj/compat/url.h>
#include <set>
#include <string>

namespace sandstorm {
kj::String isolateHostServicePath(kj::StringPtr url) {
  kj::UrlOptions options;
  options.percentDecode = false;
  options.allowEmpty = true;
  return kj::Url::parse(url, url.startsWith("/")
      ? kj::Url::HTTP_REQUEST : kj::Url::REMOTE_HREF, options)
      .toString(kj::Url::HTTP_REQUEST);
}

kj::String isolateHostIngressUrl(kj::StringPtr url) {
  return url.startsWith("/") ? kj::str("http://sandstorm", url) : kj::str(url);
}

void addIsolateHostModuleAliases(IsolateWorkerSource::Builder source) {
  auto original = source.disownModules();
  auto inputs = original.getReader();
  size_t count = inputs.size();
  size_t totalBytes = 0;
  std::set<std::string> names;
  auto addName = [&](kj::StringPtr name) {
    KJ_REQUIRE(names.insert(std::string(name.begin(), name.size())).second,
        "duplicate module name or alias collision", name);
  };
  for (auto module: inputs) addName(module.getName());
  for (auto module: inputs) {
    bool alias = module.getName().startsWith("capnp:/sandstorm/");
    if (alias) {
      addName(module.getName().slice(7));
      ++count;
    }
    size_t bytes;
    switch (module.which()) {
      case IsolateWorkerSource::Module::ES_MODULE: bytes = module.getEsModule().size(); break;
      case IsolateWorkerSource::Module::COMMON_JS_MODULE:
        bytes = module.getCommonJsModule().size(); break;
      case IsolateWorkerSource::Module::TEXT: bytes = module.getText().size(); break;
      case IsolateWorkerSource::Module::DATA: bytes = module.getData().size(); break;
      case IsolateWorkerSource::Module::WASM: bytes = module.getWasm().size(); break;
      case IsolateWorkerSource::Module::JSON: bytes = module.getJson().size(); break;
      default: KJ_FAIL_REQUIRE("unknown module type");
    }
    totalBytes += bytes * (alias ? 2 : 1);
  }
  KJ_REQUIRE(count > 0 && count <= 1024,
      "worker modules including aliases exceed host count limit");
  KJ_REQUIRE(totalBytes <= 16 * 1024 * 1024,
      "worker modules including aliases exceed host byte limit");
  auto modules = source.initModules(count);
  size_t index = 0;
  for (auto module: inputs) {
    modules.setWithCaveats(index++, module);
    if (module.getName().startsWith("capnp:/sandstorm/")) {
      modules.setWithCaveats(index, module);
      modules[index++].setName(module.getName().slice(7));
    }
  }
}
}
