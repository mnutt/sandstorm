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

  getOfferedCapability @2 (sessionId :Text) -> (found :Bool, cap :Capability);
  # Returns the capability offered to a live offer session, if this session is
  # an offer session. This deliberately uses the existing same-grain session ID
  # rather than a second capability ID namespace.

  createBrowserHandoff @3 (cap :Capability, sessionId :Text) -> (id :Text);
  # Stores a capability explicitly handed to the current browser session so a
  # browser-scoped bridge can resolve it later. This is not a worker-side
  # authority lookup; it exists only for JSON-safe browser handoff slots.

  dropBrowserHandoff @4 (id :Text) -> (released :Bool);
  # Releases a browser handoff slot created by createBrowserHandoff().

  createRouteBackedCapability @5 (
      nativeInterface :Text,
      pathPrefix :Text,
      persistent :Bool) -> (cap :Capability);
  # Creates a route-backed WebSession or ApiSession capability without
  # exposing creation as an authority-bearing local HTTP route.

  wrapAppPersistentCapability @6 (cap :Capability) -> (cap :Capability);
  # Wraps an app-realm capability that implements Grain.AppPersistent as a
  # Sandstorm-internal SystemPersistent capability. App JS should continue to
  # implement AppPersistent; this bridge performs the realm translation needed
  # when passing app-hosted capabilities to legacy SessionContext APIs.

  registerMainView @7 (view :Grain.MainView, registrationId :Text) -> ();
  # Publishes the worker's MainView over the native bridge for one supervisor-initiated
  # restore/drop operation. The call remains pending for the lifetime of the registration so the
  # request-scoped worker RPC connection stays alive while returned capabilities are in use.
}

interface BrowserIsolateBridge @0x93fb2746c97b5bea {
  # Bootstrap capability for browser-originated native Cap'n Proto sessions.
  #
  # This intentionally exposes only capabilities that the worker already handed
  # to the current browser session by opaque id. It does not expose the worker
  # SandstormApi or SessionContext authority.

  getHandoffCapability @0 (id :Text) -> (cap :Capability);
  # Resolves a capability that the worker explicitly handed to this browser
  # session as a JSON-safe handoff slot.

  claimPowerboxRequest @1 (requestToken :Text, requiredPermissions :List(Text))
      -> (cap :Capability);
  # Claims a browser Powerbox token against the current browser session. The
  # supervisor resolves permission names against this app's ViewInfo and calls
  # the standard SessionContext.claimRequest(); the browser never receives the
  # full SessionContext authority.
}
