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
  senderPictureUrl @11 :Text;
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
  accountPictureUrl @6 :Text;
  grainPage @7 :UInt32;
  notificationPage @8 :UInt32;
  hasUnread @9 :Bool;
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
  beginPowerbox @7 (query :List(Text)) -> (request :PowerboxRequest, result :Result(PowerboxState));
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
  watchGrains @18 (query :GrainQuery, observer :GrainObserver) -> (subscription :Subscription);
  watchNotifications @19 (page :UInt32, observer :NotificationObserver) -> (subscription :Subscription);

  installer @16 () -> (installer :Installer);
  account @17 () -> (account :Account);

  selectPage @15 (kind :Text, page :UInt32) -> ();
  accountSettings @14 (operation :Text, input :Text) -> (state :Text);
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
  listApps @7 (page :UInt32, appId :Text) -> (actions :List(AppAction), limited :Bool);
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
  accountPictureUrl @4 :Text;
}
interface SharedSession {
  close @0 () -> ();
}
interface SharedShell {
  inspect @0 (webkey :Text) -> (info :SharedInfo);
  open @1 (webkey :Text, revealIdentity :Bool) -> (view :GrainView, session :SharedSession);
}

# Expected application failures are values. Transport/internal failures remain
# RPC exceptions: callers must not infer that an interrupted mutation rolled back.
enum FailureCode {
  invalidInput @0;
  signInRequired @1;
  permissionDenied @2;
  notFound @3;
  conflict @4;
  rateLimited @5;
  unavailable @6;
}
struct Failure {
  code @0 :FailureCode;
  message @1 :Text;
  # Safe fallback text. UI behavior must use code, not parse message.
}
struct Empty {}
struct Url { url @0 :Text; }

# Advisory account policy, not a grant. Every mutation revalidates authority.
struct InstallPermissions {
  canInstall @0 :Bool;
  canUpload @1 :Bool;
  installReason @2 :Text;
  uploadReason @3 :Text;
}
struct InstallCatalog {
  marketUrl @0 :Text;
  updates @1 :List(AppUpdate);
  permissions @2 :InstallPermissions;
}
struct AppUpdate {
  packageId @0 :Text;
  title @1 :Text;
  version @2 :Text;
  url @3 :Text;
}
enum PackageStage {
  unknown @0;
  missing @1;
  download @2;
  verify @3;
  unpack @4;
  analyze @5;
  ready @6;
  failed @7;
  delete @8;
}
struct InstallationState {
  packageId @0 :Text;
  stage @1 :PackageStage;
  progress @2 :Float64;
  # Legacy installer progress: fraction (0,1], or bytes when greater than one.
  error @3 :Text;
  appId @4 :Text;
  title @5 :Text;
  description @6 :Text;
  version @7 :Text;
  fingerprint @8 :Text;
  iconSrc @9 :Text;
  installed @10 :Bool;
  newerInstalled @11 :Bool;
  olderGrains @12 :UInt32;
  permissions @13 :InstallPermissions;
}
interface Installer {
  open @6 (packageId :Text, url :Text) -> (installation :Installation);
  # Opening observes a package; it does not initiate a download or installation.

  catalog @0 () -> (result :Result(InstallCatalog));
  status @1 (packageId :Text) -> (result :Result(InstallationState));
  download @2 (packageId :Text, url :Text, retry :Bool = false) -> (result :Result(InstallationState));
  confirm @3 (packageId :Text) -> (result :Result(InstallationState));
  upgrade @4 (packageId :Text) -> (result :Result(InstallationState));
  upload @5 () -> (result :Result(Url));
}
struct EmailAddress {
  email @0 :Text;
  verified @1 :Bool;
  primary @2 :Bool;
}
struct Credential {
  id @0 :Text;
  service @1 :Text;
  name @2 :Text;
  pictureUrl @3 :Text;
  login @4 :Bool;
}
struct OAuthState {
  request @0 :Text;
  url @1 :Text;
  pending @2 :Bool;
}
struct AccountState {
  emailEnabled @0 :Bool;
  githubEnabled @1 :Bool;
  emails @2 :List(EmailAddress);
  credentials @3 :List(Credential);
  oauth @4 :OAuthState;
}
interface Account {
  read @0 () -> (result :Result(AccountState));
  setPrimaryEmail @1 (email :Text) -> (result :Result(AccountState));
  sendEmail @2 (email :Text, allowLogin :Bool) -> (result :Result(AccountState));
  verifyEmail @3 (email :Text, code :Text, allowLogin :Bool) -> (result :Result(AccountState));
  unlink @4 (credentialId :Text) -> (result :Result(AccountState));
  setLoginAllowed @5 (credentialId :Text, allowed :Bool) -> (result :Result(AccountState));
  startGithub @6 () -> (result :Result(AccountState));
  finishGithub @7 (request :Text) -> (result :Result(AccountState));
  cancelGithub @8 (request :Text) -> (result :Result(AccountState));
}





struct PowerboxRole { key @0 :Text; title @1 :Text; }
struct PowerboxCandidate {
  key @0 :Text;
  title @1 :Text;
  detail @2 :Text;
  iconSrc @3 :Text;
  uiView @4 :Bool;
  hostedObject @5 :Bool;
  urlInput @6 :Bool;
  emailInput @7 :Bool;
  github @8 :Bool;
  roles @9 :List(PowerboxRole);
}
struct PowerboxChoices { candidates @0 :List(PowerboxCandidate); limited @1 :Bool; legacy @2 :Bool; }
struct PowerboxProvider { title @0 :Text; origin @1 :Text; url @2 :Text; }
struct PowerboxCompletion { token @0 :Text; descriptor @1 :Text; }
struct PowerboxState {
  union {
    waiting @0 :Void;
    choices @1 :PowerboxChoices;
    provider @2 :PowerboxProvider;
    oauth @3 :OAuthState;
    email @4 :Text;
    complete @5 :PowerboxCompletion;
    closed @6 :Void;
  }
}
struct PowerboxSelection {
  key @0 :Text;
  union {
    direct @1 :Void;
    view @2 :Text;
    # Permission role key supplied by the selected candidate; "all" grants all access.
    hosted @3 :Void;
    webkey @4 :Text;
    url @5 :Text;
    sendEmail @6 :Text;
    verifyEmail @7 :Text;
    startGithub @8 :Void;
    finishGithub @9 :Void;
  }
}
interface PowerboxRequest {
  select @0 (selection :PowerboxSelection) -> (result :Result(PowerboxState));
  poll @1 () -> (result :Result(PowerboxState));
  cancel @2 () -> ();
  nested @3 (query :List(Text)) -> (request :PowerboxRequest, result :Result(PowerboxState));
  # Child authority is derived from the active provider session, never a browser ID.
  # Explicit cancellation invalidates descendants. Release also cleans up when
  # there are no in-flight calls or child capabilities retaining this object.
}

struct Result(T) {
  union {
    unset @0 :Void;
    value @1 :T;
    failure @2 :Failure;
  }
}

interface InstallationObserver { changed @0 (result :Result(InstallationState)) -> (); }
interface Installation {
  read @0 () -> (result :Result(InstallationState));
  download @1 (retry :Bool = false) -> (result :Result(InstallationState));
  confirm @2 () -> (result :Result(InstallationState));
  upgrade @3 () -> (result :Result(InstallationState));
  watch @4 (observer :InstallationObserver) -> (subscription :Subscription);
  # Release/cancel ends observation only. Confirmed installations and shared
  # package downloads persist. There is deliberately no cancel-download method.
}

enum GrainSort { recent @0; title @1; }
enum GrainOwnership { all @0; owned @1; shared @2; }
struct GrainQuery {
  search @0 :Text;
  appId @1 :Text;
  sort @2 :GrainSort;
  ownership @3 :GrainOwnership;
  page @4 :UInt32;
  # Live offset pages of 100 rows. Membership may shift as data changes.
}
struct GrainPage { grains @0 :List(Grain); hasMore @1 :Bool; page @2 :UInt32; }
struct NotificationPage { entries @0 :List(Notification); total @1 :UInt32; page @2 :UInt32; }
interface GrainObserver { replace @0 (page :GrainPage) -> (); }
interface NotificationObserver { replace @0 (page :NotificationPage) -> (); }
