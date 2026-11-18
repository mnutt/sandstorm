@0xf912e784d076ea86;

using Fixture = import "fixture.capnp".Fixture;

# Experimental account-scoped projection API. Backend authority is never exported.
struct Notification {
  id @0 :UInt32;
  title @1 :Text;
  body @2 :Text;
  key @3 :Text;
  unread @4 :Bool;
  ongoing @5 :Bool;
  href @6 :Text;
  timestamp @7 :Text;
  senderName @8 :Text;
}

struct Grain {
  key @0 :Text;
  title @1 :Text;
  href @2 :Text;
  owned @3 :Bool;
  lastUsed @4 :Text;
  appTitle @5 :Text;
}

struct Snapshot {
  revision @0 :UInt32;
  entries @1 :List(Notification);
  total @2 :UInt32;
  grains @3 :List(Grain);
  grainsLimited @4 :Bool;
  # Each callback replaces the entire projection. First callback means ready.
  # Reconnecting replaces state with an authorized snapshot and a new revision sequence.
}

interface Observer {
  replace @0 (snapshot :Snapshot) -> ();
}

interface Subscription {
  cancel @0 () -> ();
  # Dropping this capability also cancels observation.
}

struct GrainView {
  grainId @0 :Text;
  origin @1 :Text;
  url @2 :Text;
}
interface GrainSession {
  close @0 () -> ();
  # Explicit close, release, or browser disconnect ends the UI session lease.
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
  openGrain @6 (grainId :Text) -> (view :GrainView, session :GrainSession);
}
