@0xc3bd5bfe7541dc41;

$import "/capnp/c++.capnp".namespace("sandstorm");

struct NativeCapnpBridgeRequest @0xa9d7cd8e6cc2b4e9 {
  # Versioned isolate-to-supervisor native Cap'n Proto bridge envelope.
  #
  # Generated schema RPC uses the WebSocket Cap'n Proto RPC session transport.
  # This envelope is lifecycle-only: save, restore, and drop operations for
  # already-held Sandstorm capability handles.

  protocolVersion @0 :UInt32;

  union {
    drop @1 :NativeCapnpBridgeDrop;
    save @2 :NativeCapnpBridgeSave;
    restore @3 :NativeCapnpBridgeRestore;
  }
}

struct NativeCapnpBridgeResponse @0xc1ef5dce7db1a7f1 {
  protocolVersion @0 :UInt32;

  union {
    capability @1 :NativeCapnpCapabilitySlot;
    saved @2 :NativeCapnpBridgeSaved;
    acknowledged @3 :Void;
    exception @4 :NativeCapnpBridgeException;
  }
}

struct NativeCapnpBridgeDrop @0xd2a93fb3be7f688d {
  target @0 :NativeCapnpCapabilitySlot;
}

struct NativeCapnpBridgeSave @0x90f6b72cbec1e44d {
  target @0 :NativeCapnpCapabilitySlot;
}

struct NativeCapnpBridgeRestore @0xc35dd976b9efc866 {
  token @0 :Text;
  expectedInterfaceId @1 :UInt64;
  expectedInterfaceName @2 :Text;
}

struct NativeCapnpBridgeSaved @0xe7a0b85c446da212 {
  token @0 :Text;
}

struct NativeCapnpCapabilitySlot @0xf3fc15de30f50d47 {
  id @0 :Text;
  interfaceId @1 :UInt64;
  interfaceName @2 :Text;
  kind @3 :NativeCapnpCapabilitySlotKind;
  localDispatch @4 :NativeCapnpLocalDispatch;
}

struct NativeCapnpLocalDispatch @0x9c9d302760408885 {
  # Opaque same-supervisor dispatch lease. The supervisor only includes this
  # after restoring or otherwise validating an actual Sandstorm capability.
  #
  # Isolate runtimes must treat this as trusted metadata from the bridge, not
  # app-provided authority. Raw export IDs are not sufficient to dispatch.

  exportId @0 :Text;
  interfaceId @1 :UInt64;
  interfaceName @2 :Text;
  authorization @3 :Text;
}

enum NativeCapnpCapabilitySlotKind @0x874023c5caa9b3df {
  senderHosted @0;
  receiverHosted @1;
  savedToken @2;
}

struct NativeCapnpBridgeException @0xb4098ed814dc3f1b {
  type @0 :Text;
  reason @1 :Text;
  trace @2 :Text;
}
