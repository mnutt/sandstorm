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
  nativePath @9 :Text;
  nativeAction @10 :Text;
  # Only supported, validated Rust-shell destinations; empty uses legacy href.
}

struct Grain {
  key @0 :Text;
  title @1 :Text;
  href @2 :Text;
  owned @3 :Bool;
  lastUsed @4 :Text;
  appTitle @5 :Text;
  ownerTitle @6 :Text;
  iconSrc @7 :Text;
  appId @8 :Text;
}

struct Snapshot {
  revision @0 :UInt32;
  entries @1 :List(Notification);
  total @2 :UInt32;
  grains @3 :List(Grain);
  grainsLimited @4 :Bool;
  profileVersion @5 :Text;
  # Each callback replaces the entire projection. First callback means ready.
  # Reconnecting replaces state with an authorized snapshot and a new revision sequence.
}

interface Observer {
  replace @0 (snapshot :Snapshot) -> ();
}

interface Subscription {
  cancel @0 () -> ();
  # Dropping this capability also cancels observation.
  whenClosed @1 () -> ();
  # Pending while observation is healthy. Resolves on explicit cancellation;
  # rejects on delivery failure. Reconnect for a fresh authorized snapshot.
}

struct GrainView {
  grainId @0 :Text;
  origin @1 :Text;
  url @2 :Text;
  title @3 :Text;
  mainHref @4 :Text;
  ownerTitle @5 :Text;
  iconSrc @6 :Text;
}
interface GrainSession {
  close @0 () -> ();
  renderTemplate @1 (options :Text) -> (token :Text, host :Text);
  rename @2 (title :Text) -> (title :Text, ownerTitle :Text);
  powerbox @6 (request :Text, operation :Text, input :Text) -> (state :Text);
  # Request IDs identify child lifetimes, never authority outside this grain.
  getSharing @3 () -> (state :Text);
  createShare @4 (label :Text, role :Text) -> (token :Text);
  updateShare @5 (id :Text, changes :Text) -> ();
  # Bounded sharing projection and strictly validated changes, scoped to this grain.
  # A freshly created webkey is returned only to trusted shell UI, never the app.
  # Owners rename the grain; recipients rename their own share. No automatic replay.
  # Sensitive result for the trusted shell only. Apps receive an opaque frame URL.
  # Explicit close, release, or browser disconnect ends the UI session lease.
}
struct AppAction {
  key @0 :Text;
  title @1 :Text;
  appTitle @2 :Text;
  appId @3 :Text;
  iconSrc @4 :Text;
  lastUsed @5 :Text;
  shortDescription @6 :Text;
  grainCount @7 :UInt32;
}
struct AccountProfile {
  name @0 :Text;
  handle @1 :Text;
  pronoun @2 :Text;
  mainHref @3 :Text;
  pictureUrl @4 :Text;
  version @5 :Text;
}
interface Shell {
  uploadPicture @13 () -> (uploadUrl :Text);
  install @11 (operation :Text, input :Text) -> (state :Text);
  notification @12 (key :Text, operation :Text, enabled :Bool) -> (state :Text);
  # Fixed installation operations; package and account authority stays server-side.
  watch @0 (observer :Observer) -> (subscription :Subscription);
  dismiss @1 (id :UInt32) -> ();
  addFixture @2 () -> ();
  # State is private to this connection; at most 50 entries and one observer.
  interop @3 () -> (fixture :Fixture);
  # Available only when the operator sets RUST_SHELL_FIXTURE_SOCKET.
  # The browser never chooses a socket or receives Sandstorm Backend authority.
  dismissReal @4 (key :Text) -> ();
  markRead @5 (key :Text) -> ();
  openGrain @6 (grainId :Text) -> (view :GrainView, session :GrainSession);
  listApps @7 () -> (actions :List(AppAction), limited :Bool);
  createGrain @8 (actionId :Text, title :Text) -> (grainId :Text);
  getProfile @9 () -> (profile :AccountProfile);
  updateProfile @10 (name :Text, handle :Text, pronoun :Text) -> (profile :AccountProfile);
  # Profile authority remains in Meteor; updates are never automatically replayed.
  # Never replay creation after a transport failure. The outcome may be unknown.
}

# Separate public bootstrap. Possession of a shared webkey never exposes Shell.
struct SharedInfo {
  title @0 :Text;
  guestsAllowed @1 :Bool;
  signedIn @2 :Bool;
  accountName @3 :Text;
}
interface SharedSession {
  close @0 () -> ();
}
interface SharedShell {
  inspect @0 (webkey :Text) -> (info :SharedInfo);
  open @1 (webkey :Text, revealIdentity :Bool) -> (view :GrainView, session :SharedSession);
}
