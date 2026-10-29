#include "isolate-host-adapter.h"
#include <capnp/message.h>
#include <kj/test.h>

namespace sandstorm {
namespace {
KJ_TEST("host URL adapters preserve Sandstorm origin and escaped query semantics") {
  KJ_EXPECT(isolateHostServicePath("https://storage/a%2Fb//c?q=%2F&&q=x+y") ==
      "/a%2Fb//c?q=%2F&&q=x+y");
  KJ_EXPECT(isolateHostServicePath("http://sandstorm?path=capnp%3A%2Fsandstorm%2Fapi.capnp") ==
      "/?path=capnp%3A%2Fsandstorm%2Fapi.capnp");
  KJ_EXPECT(isolateHostServicePath("/relative?x=1") == "/relative?x=1");
  KJ_EXPECT(isolateHostIngressUrl("/foo?x=1") == "http://sandstorm/foo?x=1");
  KJ_EXPECT(isolateHostIngressUrl("https://example.com/foo") == "https://example.com/foo");
}

KJ_TEST("generated platform schema module aliases preserve content") {
  capnp::MallocMessageBuilder message;
  auto source = message.initRoot<IsolateWorkerSource>();
  auto modules = source.initModules(2);
  modules[0].setName("main.js");
  modules[0].setEsModule(kj::StringPtr("export default {};").asBytes());
  modules[1].setName("capnp:/sandstorm/api.capnp.js");
  auto content = kj::StringPtr("import './util.capnp.js';").asBytes();
  modules[1].setEsModule(content);
  addIsolateHostModuleAliases(source);
  KJ_EXPECT(source.getModules().size() == 3);
  KJ_EXPECT(source.asReader().getModules()[2].getName() == "sandstorm/api.capnp.js");
  KJ_EXPECT(source.asReader().getModules()[2].getEsModule() == content);
}

KJ_TEST("reject alias collisions and count aliases against host limits") {
  capnp::MallocMessageBuilder message;
  auto source = message.initRoot<IsolateWorkerSource>();
  auto modules = source.initModules(2);
  modules[0].setName("capnp:/sandstorm/api.capnp.js"); modules[0].setEsModule({});
  modules[1].setName("sandstorm/api.capnp.js"); modules[1].setEsModule({});
  KJ_EXPECT_THROW_MESSAGE("alias collision", addIsolateHostModuleAliases(source));
  modules = source.initModules(1024);
  for (auto i: kj::indices(modules)) {
    modules[i].setName(kj::str("capnp:/sandstorm/", i));
    modules[i].setEsModule({});
  }
  KJ_EXPECT_THROW_MESSAGE("including aliases exceed host count", addIsolateHostModuleAliases(source));
  modules = source.initModules(2);
  for (auto i: kj::indices(modules)) {
    modules[i].setName(kj::str("capnp:/sandstorm/", i));
    modules[i].initData(5 * 1024 * 1024);
  }
  KJ_EXPECT_THROW_MESSAGE("including aliases exceed host byte", addIsolateHostModuleAliases(source));
}
}
}
