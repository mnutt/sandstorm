@0xb7f2e6f16c82ad91;

using Cxx = import "/capnp/c++.capnp";
$Cxx.namespace("sandstorm");

# Sandstorm-owned, binary handoff from the per-grain supervisor bundle builder to the shared
# workerd host. Paths and worker identity are deliberately absent.
struct IsolateWorkerSource {
  formatVersion @5 :UInt16;
  # Persisted handoff format version. The current and only accepted value is 2.

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
    }
  }

  exports @6 :List(Export);
  # Capabilities the worker promises to publish through IsolateExportBroker. This declaration lets
  # the native host reject accidental name/type mismatches without knowing application schemas.
  # It does not grant authority: the worker still has to return the capability over its RPC link.
  struct Export {
    name @0 :Text;
    interfaceId @1 :UInt64;
  }
}
