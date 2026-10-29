@0xa2baaef09ab261af;
$import "/capnp/c++.capnp".namespace("sandstorm");
using Http = import "/capnp/compat/http-over-capnp.capnp";

# Trusted controller for a single process/trust domain. The caller supplies already
# attenuated services. This interface confers authority to create and retain workers.
interface IsolateHost @0xdcdaa5a88a3fd342 {
  startWorker @0 (workerId :Text, services :IsolateBindingServices, workerSource :Data)
      -> (worker :HostedIsolate);
  # An existing running ID is retained unchanged, including its source and services.
  # Stop it before replacing it. IDs are opaque, nonempty, at most 256 bytes.
  getInfo @1 () -> (protocolVersion :UInt16, sourceFormatVersion :UInt16);
}

interface IsolateBindingServices @0xa729f6e28d4b02ed {
  getService @0 (name :Text) -> (service :Http.HttpService);
  # Requests preserve the URL supplied by workerd, including scheme and authority.
  getBridge @1 (name :Text) -> (bridge :Capability);
  # Named capabilities are scoped to this worker. A bridge is an opaque Cap'n Proto
  # bootstrap exposed through a bounded native byte channel, without FD passing.
}

interface HostedIsolate @0xe07a19005d5be30c {
  keepAlive @0 ();
  stop @1 ();
  getHttpService @2 () -> (service :Http.HttpService);
  # Ingress authority comes from possession of this capability, not a worker ID.
  # Stop/idle eviction invalidates existing ingress and worker-local services,
  # cancels host HTTP operations, and closes native channels. It does not roll back
  # side effects already accepted by remote services.
}
