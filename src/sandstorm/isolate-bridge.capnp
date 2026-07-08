@0xac8351629ec2d535;

$import "/capnp/c++.capnp".namespace("sandstorm");

using Grain = import "grain.capnp";

interface IsolateBridge @0xc4b06a6915ad0e3c {
  # Bootstrap capability for an isolate worker's request-scoped authority
  # connection to its supervisor.
  #
  # This is supervisor-private. App JS should use the ergonomic Sandstorm
  # helper facade, which wraps these existing Sandstorm capabilities.

  getSandstormApi @0 () -> (api :Grain.SandstormApi);
  # Returns the standard Sandstorm API capability for this grain.

  getSessionContext @1 (sessionId :Text) -> (context :Grain.SessionContext);
  # Returns the standard SessionContext for a live same-grain session.
}
