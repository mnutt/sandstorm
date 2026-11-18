@0xf912e784d076ea86;

using Fixture = import "fixture.capnp".Fixture;

# Experimental, fixture-only API. No account or Backend authority is exported.
struct Notification {
  id @0 :UInt32;
  title @1 :Text;
  body @2 :Text;
  key @3 :Text;
  unread @4 :Bool;
  ongoing @5 :Bool;
  href @6 :Text;
  timestamp @7 :Text;
}

struct Snapshot {
  revision @0 :UInt32;
  entries @1 :List(Notification);
  total @2 :UInt32;
  # Each callback replaces the entire projection. First callback means ready.
  # Reconnecting creates a new fixture and starts a new revision sequence.
}

interface Observer {
  replace @0 (snapshot :Snapshot) -> ();
}

interface Subscription {
  cancel @0 () -> ();
  # Dropping this capability also cancels observation.
}

interface Shell {
  watch @0 (observer :Observer) -> (subscription :Subscription);
  dismiss @1 (id :UInt32) -> ();
  addFixture @2 () -> ();
  # State is private to this connection; at most 50 entries and one observer.
  interop @3 () -> (fixture :Fixture);
  # Available only when the operator sets RUST_SHELL_FIXTURE_SOCKET.
  # The browser never chooses a socket or receives Sandstorm Backend authority.
  dismissReal @4 (key :Text) -> ();
  markRead @5 () -> ();
}
