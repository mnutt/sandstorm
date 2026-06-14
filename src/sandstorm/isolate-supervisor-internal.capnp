@0xfefb0ea2ec329109;

$import "/capnp/c++.capnp".namespace("sandstorm");

using WebSession = import "web-session.capnp".WebSession;
using ApiSession = import "api-session.capnp".ApiSession;
using SystemPersistent = import "supervisor.capnp".SystemPersistent;

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
