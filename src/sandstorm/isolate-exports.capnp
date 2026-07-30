@0xab4d15da1d48c032;

$import "/capnp/c++.capnp".namespace("sandstorm");

# Schema-opaque bootstrap for capabilities implemented by an isolate worker.
#
# The native host understands only this broker. Application interface schemas remain end-to-end
# between the worker and the caller; interfaceId prevents a name from being interpreted as the
# wrong Cap'n Proto type.
interface IsolateExportBroker @0xf65d14118e8e227b {
  getExport @0 (name :Text, interfaceId :UInt64, platform :Capability) -> (cap :Capability);
  # `platform` is the grain-scoped supervisor bridge. Supplying it on the worker's event-driven
  # connection lets returned worker capabilities call back into Sandstorm without opening a
  # request-scoped side channel.

  restoreExport @1 (
      name :Text, interfaceId :UInt64, objectId :AnyPointer, platform :Capability)
      -> (cap :Capability);
  # Recreates a durable capability previously saved by this named export. The object ID remains
  # application-defined and opaque to the native host and supervisor.

  dropExport @2 (
      name :Text, interfaceId :UInt64, objectId :AnyPointer, platform :Capability);
  # Notifies the export that all durable references to the application object have been dropped.
}
