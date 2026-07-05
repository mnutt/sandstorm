@0xc3bd5bfe7541dc41;

$import "/capnp/c++.capnp".namespace("sandstorm");

struct NativeCapnpBridgeRequest @0xa9d7cd8e6cc2b4e9 {
  # Versioned isolate-to-supervisor native Cap'n Proto bridge envelope.
  #
  # This is intentionally separate from IsolateObjectCapability: app-object RPC
  # remains the compatibility fallback, while this envelope is for generated
  # schema bindings that can encode real Cap'n Proto params/results.

  protocolVersion @0 :UInt32;

  union {
    call @1 :NativeCapnpBridgeCall;
    drop @2 :NativeCapnpBridgeDrop;
    save @3 :NativeCapnpBridgeSave;
    restore @4 :NativeCapnpBridgeRestore;
  }
}

struct NativeCapnpBridgeResponse @0xc1ef5dce7db1a7f1 {
  protocolVersion @0 :UInt32;

  union {
    result @1 :NativeCapnpBridgeResult;
    capability @2 :NativeCapnpCapabilitySlot;
    saved @3 :NativeCapnpBridgeSaved;
    acknowledged @4 :Void;
    exception @5 :NativeCapnpBridgeException;
  }
}

struct NativeCapnpBridgeCall @0xaed23d9f61f0f103 {
  target @0 :NativeCapnpCapabilitySlot;
  interfaceId @1 :UInt64;
  methodOrdinal @2 :UInt16;
  methodName @3 :Text;
  params @4 :NativeCapnpPayload;
}

struct NativeCapnpBridgeResult @0x86b05ed9b18ef1ce {
  union {
    value @0 :NativeCapnpPayload;
    exception @1 :NativeCapnpBridgeException;
    canceled @2 :Void;
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

struct NativeCapnpPayload @0xb146c9fcd6929328 {
  # Encoded Cap'n Proto message bytes plus the ordered capability table used by
  # that message. The supervisor, not isolate JS, owns the live native handles.
  message @0 :Data;
  capabilities @1 :List(NativeCapnpCapabilitySlot);
}

struct NativeCapnpCapabilitySlot @0xf3fc15de30f50d47 {
  id @0 :Text;
  interfaceId @1 :UInt64;
  interfaceName @2 :Text;
  kind @3 :NativeCapnpCapabilitySlotKind;
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
