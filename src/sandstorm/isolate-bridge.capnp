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

  getClaimedCapability @2 (id :Text) -> (cap :Capability);
  # Transitional helper while id-backed Capability handles still exist.
  # Resolves a same-grain claimed-capability ID into a real capnp reference on
  # this RPC connection so trusted JS can pass it to standard Sandstorm APIs.

  storeImportedCapability @3 (cap :Capability) -> (id :Text);
  # Transitional helper while id-backed Capability handles still exist.
  # Stores a capability received over the RPC connection in the same temporary
  # claimed-capability registry used by fetch-shaped handles.

  dropClaimedCapability @4 (id :Text) -> (released :Bool);
  # Transitional helper while id-backed Capability handles still exist.
  # Drops a temporary claimed-capability registry entry.

  createRouteBackedCapability @5 (
      nativeInterface :Text,
      pathPrefix :Text,
      persistent :Bool) -> (id :Text);
  # Transitional helper while id-backed Capability handles still exist.
  # Creates a route-backed WebSession or ApiSession capability without
  # exposing creation as an authority-bearing local HTTP route.
}
