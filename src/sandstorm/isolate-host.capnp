@0xe912b22cf61cd218;

$import "/capnp/c++.capnp".namespace("sandstorm");

interface IsolateHost @0xb15098c984fb8f32 {
  # Account-scoped control plane for the shared workerd host.
  #
  # The backend creates one host per account trust domain and gives its control capability only to
  # the trusted account host in that domain. The account host supplies a bounded worker bundle and
  # freshly-attenuated services; the V8-bearing host receives no grain filesystem root.

  startGrain @0 (
      grainId :Text,
      services :IsolateBindingServices,
      workerSource :Data) -> (grain :HostedIsolate);
  # Instantiate or retain the named grain's worker. Repeated calls for the same grain are idempotent.
  # `services` is a freshly attenuated capability for this grain, never a backend-wide interface.
}

interface IsolateBindingServices @0xd8b8ffcb9dbf83ea {
  getBridge @0 () -> (bridge :Capability);
  # Returns the grain-scoped native capability bootstrap. The embedded host exposes this through
  # a direct binary message channel; worker code does not discover it through HTTP or WebSockets.
}

interface HostedIsolate @0xae62f18e41ff24cb {
  keepAlive @0 ();
  # Refresh the eviction deadline without changing the worker or its transport bindings.

  stop @1 ();
  # Evict this worker. Existing live RPC connections fail; durable tokens remain valid.

  getRpcBootstrap @2 () -> (cap :Capability);
  # Exposes the bootstrap of the worker-global, event-driven Cap'n Proto RPC connection.
  # Application schemas and capability tables remain opaque to the native host.

  getExport @3 (name :Text, interfaceId :UInt64) -> (cap :Capability);
  # Resolves one capability declared by the worker bundle. The native host validates only the
  # export name and interface ID, then forwards the capability without application-schema logic.
}
