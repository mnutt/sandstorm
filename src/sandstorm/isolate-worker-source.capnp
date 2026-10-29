@0xe641693c74a19b1d;

using Cxx = import "/capnp/c++.capnp";
$Cxx.namespace("sandstorm");

# Packed worker bundle supplied by the controller. No filesystem paths or worker identity.
struct IsolateWorkerSource {
  formatVersion @5 :UInt16;
  # Persisted handoff format version. Writers currently emit 1; readers reject every other value
  # before interpreting modules or bindings.

  mainModule @0 :Text;
  compatibilityDate @1 :Text;
  compatibilityFlags @2 :List(Text);

  modules @3 :List(Module);
  struct Module {
    name @0 :Text;
    union {
      esModule @1 :Data;
      commonJsModule @2 :Data;
      text @3 :Data;
      data @4 :Data;
      wasm @5 :Data;
      json @6 :Data;
    }
  }

  bindings @4 :List(Binding);
  struct Binding {
    name @0 :Text;
    union {
      text @1 :Data;
      data @2 :Data;
      json @3 :Data;
      httpService @4 :Text; # Name resolved through IsolateBindingServices.getService.
      capnp @5 :Text; # Name resolved through IsolateBindingServices.getBridge.
      service @6 :Text; # Worker-local Fetcher; currently only "main" is supported.
    }
  }
}
