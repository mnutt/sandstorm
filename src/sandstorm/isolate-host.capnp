@0xe912b22cf61cd218;

$import "/capnp/c++.capnp".namespace("sandstorm");

interface IsolateHost @0xb15098c984fb8f32 {
  # Account-scoped control plane for the shared workerd host.
  #
  # The backend creates one host per account trust domain and gives its control capability only to
  # isolate supervisors in that domain. The host derives package, runtime, socket, and storage paths
  # from its server-configured roots plus this grain ID; callers never supply filesystem paths.

  startGrain @0 (grainId :Text) -> (grain :HostedIsolate);
  # Instantiate or retain the named grain's worker. Repeated calls for the same grain are idempotent.
}

interface HostedIsolate @0xae62f18e41ff24cb {
  keepAlive @0 ();
  # Refresh the eviction deadline without changing the worker or its transport bindings.

  stop @1 ();
  # Evict this worker. Existing live RPC and HTTP connections fail; durable tokens remain valid.
}
