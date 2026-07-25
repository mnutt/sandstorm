@0xf3d5633f50de9604;

$import "/capnp/c++.capnp".namespace("sandstorm");

using Grain = import "grain.capnp";
using WebSession = import "web-session.capnp".WebSession;
using ApiSession = import "api-session.capnp".ApiSession;

# Concrete persistent interfaces used by the optional Fetch facade. These are platform SDK
# details, not part of the schema-opaque native host protocol in isolate-exports.capnp.
struct WorkerSessionRef {
  singleton @0 :Void;
}

interface WorkerWebSession @0xa0dcf62fa4965d72
    extends(WebSession, Grain.AppPersistent(WorkerSessionRef)) {
  # The public authority is still a WebSession; AppPersistent lets the supervisor represent this
  # named worker export as a durable capability.
}

interface WorkerApiSession @0xb67a196b3d6556b1
    extends(ApiSession, Grain.AppPersistent(WorkerSessionRef)) {
  # ApiSession counterpart to WorkerWebSession.
}
