@0xfefb0ea2ec329109;

$import "/capnp/c++.capnp".namespace("sandstorm");

using WebSession = import "web-session.capnp".WebSession;
using ApiSession = import "api-session.capnp".ApiSession;
using SystemPersistent = import "supervisor.capnp".SystemPersistent;
using Json = import "/capnp/compat/json.capnp";
using NativeCapnpBridgeRequest =
    import "isolate-native-capnp-bridge.capnp".NativeCapnpBridgeRequest;
using NativeCapnpBridgeResponse =
    import "isolate-native-capnp-bridge.capnp".NativeCapnpBridgeResponse;
using NativeCapnpBridgeCall = import "isolate-native-capnp-bridge.capnp".NativeCapnpBridgeCall;
using NativeCapnpBridgeResult = import "isolate-native-capnp-bridge.capnp".NativeCapnpBridgeResult;
using NativeCapnpBridgeDrop = import "isolate-native-capnp-bridge.capnp".NativeCapnpBridgeDrop;
using NativeCapnpBridgeSave = import "isolate-native-capnp-bridge.capnp".NativeCapnpBridgeSave;
using NativeCapnpBridgeRestore =
    import "isolate-native-capnp-bridge.capnp".NativeCapnpBridgeRestore;
using NativeCapnpBridgeSaved = import "isolate-native-capnp-bridge.capnp".NativeCapnpBridgeSaved;
using NativeCapnpPayload = import "isolate-native-capnp-bridge.capnp".NativeCapnpPayload;
using NativeCapnpCapabilitySlot =
    import "isolate-native-capnp-bridge.capnp".NativeCapnpCapabilitySlot;
using NativeCapnpCapabilitySlotKind =
    import "isolate-native-capnp-bridge.capnp".NativeCapnpCapabilitySlotKind;
using NativeCapnpBridgeException =
    import "isolate-native-capnp-bridge.capnp".NativeCapnpBridgeException;

interface IsolateWebSession @0xa8e9655582dcde6f extends(WebSession, SystemPersistent) {
  # Internal session interface returned by isolate-supervisor.
  #
  # The shell opens grains as WebSession, then immediately casts the returned session to
  # SystemPersistent to add membrane requirements, then casts back to WebSession. Isolate sessions
  # therefore need one concrete capability that dispatches both interfaces.
}

interface IsolateApiSession @0x8a6e6d3fbd442b6a extends(ApiSession, SystemPersistent) {
  # Internal API-session interface returned by isolate-supervisor.
  #
  # ApiSession extends WebSession but has its own type ID for Powerbox matching. Route-backed
  # isolate API capabilities therefore need a concrete capability that dispatches ApiSession's
  # interface while still supporting SystemPersistent save/restore.
}

interface IsolateObjectCapability @0xd7a322498a996313 {
  # Internal app-defined object-capability transport used between isolate supervisors.
  #
  # JavaScript continues to use the current HTTP /call compatibility path until the supervisor has
  # server/client wrappers for this interface. This interface is intentionally generic: method
  # names are late-bound, values are JSON-like, and live capability references travel as native
  # Cap'n Proto capabilities rather than local JS handle IDs.

  call @0 (method :Text, args :List(IsolateObjectCallValue))
      -> (result :IsolateObjectCallResult);

  drop @1 () -> (released :Bool);
  # Releases this reference. `released` is true when this drop released the final supervisor-side
  # reference to the exported object.
  # Signals that the receiver no longer needs this object. Cap'n Proto disconnects still matter;
  # this hook exists for explicit JS disposal/drop semantics.

  dup @2 () -> (capability :IsolateObjectCapability);
  # Creates another live reference to this object. Receivers use this when app code explicitly
  # retains a passed callback beyond the current call, so exporters can safely release temporary
  # argument handles after the call completes.
}

interface IsolatePersistentObjectCapability @0xc81a6f7df4d0eec2
    extends(IsolateObjectCapability, SystemPersistent) {
  # Route-backed app-defined object capability that can also be saved.
}

struct IsolateObjectCallValue @0x976b1fa67593b262
    $Json.discriminator(name = "type", valueName = "value") {
  union {
    null @0 :Void;
    bool @1 :Bool;
    number @2 :Float64;
    text @3 :Text;
    data @4 :Data;
    list @5 :List(IsolateObjectCallValue);
    object @6 :List(Field);
    capability @7 :IsolateObjectCapability;
  }

  struct Field @0xb1333a98c0c1f15d {
    name @0 :Text;
    value @1 :IsolateObjectCallValue;
  }
}

struct IsolateObjectCallResult @0xdaea7034fe7730f4
    $Json.discriminator(name = "type", valueName = "value") {
  union {
    value @0 :IsolateObjectCallValue;
    exception @1 :IsolateObjectCallException;
  }
}

struct IsolateObjectCallException @0x87ea2642fe430c6b {
  name @0 :Text;
  message @1 :Text;
  stack @2 :Text;
}

struct NativeAppRpcCall @0x9455759453b44c9a {
  method @0 :Text;
  args @1 :List(IsolateObjectCallValue);
}
