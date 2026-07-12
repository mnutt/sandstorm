@0xb7f2e6f16c82ad91;

using Cxx = import "/capnp/c++.capnp";
$Cxx.namespace("sandstorm");

# Sandstorm-owned, binary handoff from the per-grain supervisor bundle builder to the shared
# workerd host. Paths and worker identity are deliberately absent.
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
      sandstormApi @4 :Void;
      storage @5 :Void;
      powerbox @6 :Void;
      service @7 :Text;
    }
  }
}
