@0xab4d15da1d48c032;

$import "/capnp/c++.capnp".namespace("sandstorm");

# Schema-opaque bootstrap for capabilities implemented by an isolate worker.
#
# The native host understands only this broker. Application interface schemas remain end-to-end
# between the worker and the caller; interfaceId prevents a name from being interpreted as the
# wrong Cap'n Proto type.
interface IsolateExportBroker @0xf65d14118e8e227b {
  getExport @0 (name :Text, interfaceId :UInt64) -> (cap :Capability);
}
