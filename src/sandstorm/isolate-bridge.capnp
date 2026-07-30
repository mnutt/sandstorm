@0xac8351629ec2d535;

$import "/capnp/c++.capnp".namespace("sandstorm");

using Grain = import "grain.capnp";
using Powerbox = import "powerbox.capnp";
using Util = import "util.capnp";

interface IsolateSessionContext @0xc8b2a7f6dfd3c48a extends(Grain.SessionContext) {
  # Supervisor-private extension placed around SessionContext capabilities passed to a direct
  # isolate MainView export. It lets the worker's standard UI facade label its synthetic Fetch
  # requests with the opaque registry ID needed by the browser capability bridge. Ordinary
  # SessionContext authority continues to travel through the inherited interface.

  getSessionId @0 () -> (id :Text);
}

interface IsolateBridge @0xc4b06a6915ad0e3c {
  # Bootstrap capability for an isolate worker's request-scoped authority
  # connection to its supervisor.
  #
  # This is supervisor-private. App JS should use the ergonomic Sandstorm
  # helper facade, which wraps these existing Sandstorm capabilities.

  saveAppCapability @0 (
      cap :Capability,
      label :Util.LocalizedText) -> (token :Data);
  # Saves a worker-exported capability that implements Grain.AppPersistent. Imported
  # capabilities receive an IsolateCapabilitySaver from the operation that introduced them,
  # so this method does not confer ambient authority to save arbitrary external capabilities.

  restoreCapability @1 (
      token :Data) -> (cap :Capability, saver :IsolateCapabilitySaver);
  # Restores a token owned by this grain and returns narrowly-scoped authority to re-save the
  # resulting capability.

  dropCapability @2 (token :Data) -> ();
  # Revokes a token owned by this grain.

  getOfferedCapability @3 (
      sessionId :Text) -> (found :Bool, cap :Capability, saver :IsolateCapabilitySaver);
  # Returns the capability offered to a live offer session, if this session is
  # an offer session. This deliberately uses the existing same-grain session ID
  # rather than a second capability ID namespace.

  getWorkerExport @4 (
      name :Text,
      interfaceId :UInt64) -> (cap :Capability, saver :IsolateCapabilitySaver);
  # Resolves one capability registered by this worker. The supervisor wraps the named export so
  # persistence records its export name and application-defined object ID. Public callers still
  # resolve only exports declared by the package manifest.

  createBrowserHandoff @5 (
      cap :Capability,
      sessionId :Text,
      interfaceId :UInt64,
      interfaceName :Text) -> (id :Text);
  # Stores a capability explicitly handed to the current browser session so a
  # browser-scoped bridge can resolve it later. This is not a worker-side
  # authority lookup; it exists only for JSON-safe browser handoff slots.

  dropBrowserHandoff @6 (id :Text) -> (released :Bool);
  # Releases a browser handoff slot created by createBrowserHandoff().

  wrapAppPersistentCapability @7 (cap :Capability) -> (cap :Capability);
  # Wraps an app-realm capability that implements Grain.AppPersistent as a
  # Sandstorm-internal SystemPersistent capability. App JS should continue to
  # implement AppPersistent; this bridge performs the realm translation needed
  # when passing app-hosted capabilities to SessionContext APIs.

  getStorage @8 () -> (storage :IsolateStorage);
  # Returns the grain's private storage as a typed capability. The public JavaScript storage
  # facade uses this instead of an ambient Fetcher binding.

  getViewInfo @9 () -> (viewInfo :Grain.UiView.ViewInfo);
  # Returns the package-declared view metadata used by the worker facade for permission names
  # and other non-authority-bearing metadata.

  getRuntimeStatus @10 () -> (mainModule :Text);
  # Returns the small supervisor status payload exposed through sandstorm().unstable.status().

  claimPowerboxRequest @11 (
      sessionId :Text,
      requestToken :Text,
      requiredPermissions :List(Bool))
      -> (cap :Capability, saver :IsolateCapabilitySaver);
  # Claims a Powerbox token and returns both the requested capability and narrowly-scoped
  # authority to save exactly that capability for this grain.

  offerPowerboxCapability @12 (
      sessionId :Text,
      cap :Capability,
      requiredPermissions :List(Bool),
      descriptor :Powerbox.PowerboxDescriptor,
      displayInfo :Powerbox.PowerboxDisplayInfo);
  # Offers a capability through the real SessionContext without routing that capability through
  # the worker export membrane.

  fulfillPowerboxRequest @13 (
      sessionId :Text,
      cap :Capability,
      requiredPermissions :List(Bool),
      descriptor :Powerbox.PowerboxDescriptor,
      displayInfo :Powerbox.PowerboxDisplayInfo);
  # Fulfills the current Powerbox request through the real SessionContext.

  tieCapabilityToUser @14 (
      sessionId :Text,
      cap :Capability,
      requiredPermissions :List(Bool),
      displayInfo :Powerbox.PowerboxDisplayInfo)
      -> (cap :Capability, saver :IsolateCapabilitySaver);
  # Applies the session's user membrane and returns narrowly-scoped save authority for the result.
}

interface IsolateCapabilitySaver @0xdd105b03d66c3c67 {
  save @0 (label :Util.LocalizedText) -> (token :Data);
}

interface IsolateStorage @0xeeef9ad97721b1d2 {
  # Supervisor-private typed storage service for isolate workers.

  struct Entry {
    name @0 :Text;
    bytes @1 :UInt64;
  }

  put @0 (key :Text, value :Data) -> (bytes :UInt64);
  get @1 (key :Text) -> (found :Bool, value :Data);
  stat @2 (key :Text) -> (found :Bool, bytes :UInt64);
  remove @3 (key :Text);
  list @4 () -> (entries :List(Entry), totalBytes :UInt64);
  increment @5 (key :Text, delta :Int64) -> (value :Int64);
  # Atomically adds delta to a signed decimal integer. A missing key starts at zero.
}

interface BrowserIsolateBridge @0x93fb2746c97b5bea {
  # Bootstrap capability for browser-originated native Cap'n Proto sessions.
  #
  # This intentionally exposes only capabilities that the worker already handed
  # to the current browser session by opaque id. It does not expose the worker
  # SandstormApi or SessionContext authority.

  takeHandoffCapability @0 (id :Text, interfaceId :UInt64) -> (cap :Capability);
  # Consumes a capability that the worker explicitly handed to this browser
  # session as a JSON-safe handoff slot. The declared interface ID must match;
  # a slot can be consumed only once and therefore cannot pin authority for the
  # rest of a long-lived tab.

  claimPowerboxRequest @1 (requestToken :Text, requiredPermissions :List(Text))
      -> (cap :Capability);
  # Claims a browser Powerbox token against the current browser session. The
  # supervisor resolves permission names against this app's ViewInfo and calls
  # the standard SessionContext.claimRequest(); the browser never receives the
  # full SessionContext authority.

  getApplicationBootstrap @2 ()
      -> (found :Bool, interfaceId :UInt64, interfaceName :Text, cap :Capability);
  # Returns the worker's optional typed application capability for this exact
  # MainView session. This is the normal browser entry point; it carries no
  # WebSession or HTTP vocabulary.
}
