@0xe912b22cf61cd218;

$import "/capnp/c++.capnp".namespace("sandstorm");
using Http = import "/capnp/compat/http-over-capnp.capnp";

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
  enum Binding {
    sandstormApi @0;
    storage @1;
    powerbox @2;
  }

  getService @0 (binding :Binding) -> (service :Http.HttpService);
  # Returns one service already confined to this grain. The native host can route requests through
  # the capability but cannot derive another grain's service or storage path.

  getBridge @1 () -> (bridge :Capability);
  # Returns the grain-scoped native capability bootstrap. The embedded host exposes this through
  # a direct binary message channel; worker code does not discover it through HTTP or WebSockets.
}

interface HostedIsolate @0xae62f18e41ff24cb {
  keepAlive @0 ();
  # Refresh the eviction deadline without changing the worker or its transport bindings.

  stop @1 ();
  # Evict this worker. Existing live RPC and HTTP connections fail; durable tokens remain valid.

  getHttpService @2 () -> (service :Http.HttpService);
  # Returns this grain's worker ingress as a streaming HTTP capability. Possession of this
  # HostedIsolate capability, rather than a grain ID or bearer token, authorizes ingress.
}
