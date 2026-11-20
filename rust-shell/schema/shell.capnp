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
  hasUnread @7 :Bool;
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
  sharing @0 () -> (sharing :Sharing);
  whenClosed @1 () -> ();
  # Lifetime signal: revocation or lease failure closes only this grain.
  # Waiting does not retain the lease. Reopening always requires a new session.
  beginPowerbox @2 (query :List(Text)) -> (request :PowerboxRequest, result :Result(PowerboxState));
  close @3 () -> ();
  renderTemplate @4 (options :Text) -> (token :Text, host :Text);
  rename @5 (title :Text) -> (title :Text, ownerTitle :Text);
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
  watchGrains @0 (query :GrainQuery, observer :GrainObserver) -> (subscription :Subscription);
  watchNotifications @1 (page :UInt32, observer :NotificationObserver) -> (subscription :Subscription);

  installer @2 () -> (installer :Installer);
  account @3 () -> (account :Account);

  uploadPicture @4 () -> (uploadUrl :Text);
  notification @5 (key :Text) -> (notice :NotificationHandle);
  watch @6 (observer :Observer) -> (subscription :Subscription);
  dismiss @7 (id :UInt32) -> ();
  addFixture @8 () -> ();
  # Fixture state is private to this connection.
  interop @9 () -> (fixture :Fixture);
  # Available only when the operator sets RUST_SHELL_FIXTURE_SOCKET.
  # The browser never chooses a socket or receives Sandstorm Backend authority.
  dismissReal @10 (key :Text) -> ();
  markRead @11 (key :Text) -> ();
  openGrain @12 (grainId :Text) -> (view :GrainView, session :GrainSession);
  listApps @13 (page :UInt32, appId :Text) -> (actions :List(AppAction), limited :Bool);
  createGrain @14 (actionId :Text, title :Text) -> (grainId :Text);
  getProfile @15 () -> (profile :AccountProfile);
  updateProfile @16 (name :Text, handle :Text, pronoun :Text) -> (profile :AccountProfile);
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
  open @0 (packageId :Text, url :Text) -> (installation :Installation);
  # Opening observes a package; it does not initiate a download or installation.

  catalog @1 () -> (result :Result(InstallCatalog));
  upload @2 () -> (result :Result(Url));
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

# Sharing authority is restricted to the parent grain lease. Closing that lease
# invalidates retained Sharing capabilities. Grant IDs are scoped selectors,
# never authority by themselves; Meteor revalidates every operation.
struct ShareRole {
  union {
    none @0 :Void;
    all @1 :Void;
    roleId @2 :UInt32;
  }
}
struct ShareRoleChange {
  union {
    unchanged @0 :Void;
    set @1 :ShareRole;
  }
}
struct ShareRoleDefinition {
  id @0 :UInt32;
  title @1 :Text;
  description @2 :Text;
}
enum ShareGrantKind { link @0; person @1; grain @2; }
struct ShareGrant {
  id @0 :Text;
  label @1 :Text;
  union {
    role @2 :ShareRole;
    custom @3 :Void;
  }
  kind @4 :ShareGrantKind;
  recipient @5 :Text;
  recipientPictureUrl @6 :Text;
  editable @7 :Bool;
  inherited @8 :Bool;
  created @9 :Text;
}
struct SharingState {
  roles @0 :List(ShareRoleDefinition);
  defaultRole @1 :ShareRole;
  grants @2 :List(ShareGrant);
  owner @3 :Bool;
  private @4 :Bool;
}
struct ShareLink { token @0 :Text; }
interface Sharing {
  read @0 () -> (result :Result(SharingState));
  create @1 (label :Text, role :ShareRole) -> (result :Result(ShareLink));
  # This bearer token is for trusted shell UI only; never forward it to the app.
  edit @2 (id :Text, label :Text, role :ShareRoleChange) -> (result :Result(Empty));
  # Unchanged preserves custom permissions during label-only edits.
  revoke @3 (id :Text) -> (result :Result(Empty));
  # Mutation outcomes must not be replayed automatically after transport failure.
}


# An account-bound notice handle is a selector, not an enduring permission grant.
# Every read/write rechecks notice ownership, type, and administrator authority.
enum ReportingPreference { unset @0; disabled @1; enabled @2; }
struct StatisticsDetails {
  preference @0 :ReportingPreference;
  sample @1 :Text;
  # A formatted report for display, not a JSON-encoded RPC result.
}
struct ReferralPerson { name @0 :Text; pictureUrl @1 :Text; }
struct ReferralDetails {
  enabled @0 :Bool;
  pending @1 :List(ReferralPerson);
  completed @2 :List(ReferralPerson);
}
struct NotificationDetails {
  union {
    statistics @0 :StatisticsDetails;
    referrals @1 :ReferralDetails;
    identity @2 :Void;
  }
}
interface NotificationHandle {
  read @0 () -> (result :Result(NotificationDetails));
  setStatisticsReporting @1 (enabled :Bool) -> (result :Result(StatisticsDetails));
  # Only valid for a statistics notice owned by a current administrator.
  # Success deletes reporting notices. Never replay an uncertain write.
}
