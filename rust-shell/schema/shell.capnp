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

# Every list update is atomic: reset on the first delivery, then consecutive
# revisions. Rows contain only upserts; order is the complete ordered membership
# of this page. Removed keys leave the page, not necessarily the underlying DB.
struct ListDelta {
  revision @0 :UInt64;
  reset @1 :Bool;
  removed @2 :List(Text);
  order @3 :List(Text);
}

struct Snapshot {
  revision @0 :UInt32;
  entries @1 :NotificationPage;
  grains @2 :GrainPage;
  profileVersion @3 :Text;
  accountPictureUrl @4 :Text;
  hasUnread @5 :Bool;
  # Each callback replaces scalar fields and applies both list deltas atomically.
  # First callback means ready.
  # Reconnecting replaces state with an authorized snapshot and a new revision sequence.
}

interface Observer {
  replace @0 (snapshot :Snapshot) -> ();
}

interface Subscription {
  cancel @0 () -> ();
  # Dropping this capability also cancels observation.
  whenClosed @1 () -> ();
  # Pending while observation is healthy. Resolves on explicit cancellation or
  # after a terminal application failure has been delivered to the observer.
  # Rejects on delivery/transport failure. Reconnect for a fresh authorized snapshot.
}

struct GrainView {
  grainId @0 :Text;
  origin @1 :Text;
  url @2 :Text;
  title @3 :Text;
  mainHref @4 :Text;
  ownerTitle @5 :Text;
  iconSrc @6 :Text;
  owned @7 :Bool; # Advisory UI hint; management operations recheck ownership.
}
interface GrainSession {
  sharing @0 () -> (sharing :Sharing);
  whenClosed @1 () -> ();
  # Lifetime signal: revocation or lease failure closes only this grain.
  # Waiting does not retain the lease. Reopening always requires a new session.
  beginPowerbox @2 (query :List(Text)) -> (request :PowerboxRequest, result :Result(PowerboxState));
  close @3 () -> ();
  renderTemplate @4 (options :TemplateOptions) -> (result :Result(TemplateToken));
  rename @5 (title :Text) -> (result :Result(GrainTitle));
  whenReady @6 () -> (result :Result(Empty));
  # Resolves on the gateway first response, including error responses.
  # Waiting does not retain the lease and ends when the session closes.
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
enum ProfilePronoun { neutral @0; male @1; female @2; robot @3; }
struct ProfileEdit {
  name @0 :Text;
  handle @1 :Text;
  pronoun @2 :ProfilePronoun;
}
struct AccountProfile {
  name @0 :Text;
  handle @1 :Text;
  pronoun @2 :ProfilePronoun;
  pictureUrl @3 :Text;
  version @4 :Text;
}

interface Shell {
  watchGrains @0 (query :GrainQuery, observer :GrainObserver) -> (subscription :Subscription);
  watchNotifications @1 (page :UInt32, observer :NotificationObserver) -> (subscription :Subscription);

  installer @2 () -> (installer :Installer);
  account @3 () -> (account :Account);

  notification @4 (key :Text) -> (notice :NotificationHandle);
  watch @5 (observer :Observer) -> (subscription :Subscription);
  dismiss @6 (id :UInt32) -> ();
  addFixture @7 () -> ();
  # Fixture state is private to this connection.
  interop @8 () -> (fixture :Fixture);
  # Available only when the operator sets RUST_SHELL_FIXTURE_SOCKET.
  # The browser never chooses a socket or receives Sandstorm Backend authority.
  markAllRead @9 () -> (result :Result(Empty));
  grainView @10 (grainId :Text) -> (view :ViewReference);
  listApps @11 (page :UInt32, appId :Text) -> (result :Result(AppPage));
  action @12 (key :Text) -> (action :AppActionHandle);
  grain @13 (grainId :Text) -> (handle :GrainHandle);
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
  whenReady @1 () -> (result :Result(Empty));
}
interface SharedShell {
  inspect @0 (webkey :Text) -> (result :Result(SharedInfo));
  open @1 (webkey :Text, revealIdentity :Bool) -> (result :Result(OpenedSharedGrain));
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
  expired @6;
  quotaExceeded @7;
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
struct AuthorizationState {
  request @0 :Text;
  url @1 :Text;
  pending @2 :Bool;
}
enum OAuthProvider { github @0; google @1; oidc @2; }
struct AccountState {
  emailEnabled @0 :Bool;
  githubEnabled @1 :Bool;
  emails @2 :List(EmailAddress);
  credentials @3 :List(Credential);
  authorization @4 :AuthorizationState;
  googleEnabled @5 :Bool;
  oidcEnabled @6 :Bool;
  samlEnabled @7 :Bool;
}
interface Account {
  readProfile @9 () -> (result :Result(AccountProfile));
  updateProfile @10 (profile :ProfileEdit) -> (result :Result(AccountProfile));
  preparePictureUpload @11 () -> (result :Result(Url));
  # The one-use upload URL targets the existing streaming image validator.
  # Account authority is revalidated for every operation. Never replay mutations.

  read @0 () -> (result :Result(AccountState));
  setPrimaryEmail @1 (email :Text) -> (result :Result(AccountState));
  sendEmail @2 (email :Text, allowLogin :Bool) -> (result :Result(AccountState));
  verifyEmail @3 (email :Text, code :Text, allowLogin :Bool) -> (result :Result(AccountState));
  unlink @4 (credentialId :Text) -> (result :Result(AccountState));
  setLoginAllowed @5 (credentialId :Text, allowed :Bool) -> (result :Result(AccountState));
  startSaml @12 () -> (result :Result(AccountState));
  finishSaml @13 (request :Text) -> (result :Result(AccountState));
  cancelSaml @14 (request :Text) -> (result :Result(AccountState));
  startOAuth @6 (provider :OAuthProvider) -> (result :Result(AccountState));
  finishOAuth @7 (provider :OAuthProvider, request :Text) -> (result :Result(AccountState));
  cancelOAuth @8 (provider :OAuthProvider, request :Text) -> (result :Result(AccountState));
}


struct PowerboxRole { key @0 :Text; title @1 :Text; }
enum HttpOAuthProvider { none @0; github @1; google @2; }
struct PowerboxCandidate {
  key @0 :Text;
  title @1 :Text;
  detail @2 :Text;
  iconSrc @3 :Text;
  uiView @4 :Bool;
  hostedObject @5 :Bool;
  urlInput @6 :Bool;
  emailInput @7 :Bool;
  oauthProvider @8 :HttpOAuthProvider;
  roles @9 :List(PowerboxRole);
  identity @10 :Bool;
  disabledReason @11 :Text;
}
struct PowerboxChoices { candidates @0 :List(PowerboxCandidate); limited @1 :Bool; legacy @2 :Bool; }
struct PowerboxProvider { title @0 :Text; origin @1 :Text; url @2 :Text; }
struct PowerboxCompletion { token @0 :Text; descriptor @1 :Text; }
struct PowerboxState {
  union {
    waiting @0 :Void;
    choices @1 :PowerboxChoices;
    provider @2 :PowerboxProvider;
    oauth @3 :AuthorizationState;
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
    startOAuth @8 :Void;
    finishOAuth @9 :Void;
    identity @10 :Text; # Permission role for sharing the requesting grain with a person.
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
  trash @5 :Bool;
  # Live offset pages of 100 rows. Membership may shift as data changes.
}
struct GrainPage { upserts @0 :List(Grain); hasMore @1 :Bool; page @2 :UInt32; delta @3 :ListDelta; }
struct NotificationPage { upserts @0 :List(Notification); total @1 :UInt32; page @2 :UInt32; delta @3 :ListDelta; }
interface GrainObserver { update @0 (result :Result(GrainPage)) -> (); }
interface NotificationObserver { update @0 (result :Result(NotificationPage)) -> (); }

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
# Every call rechecks the linked account and applies Meteor's notice policy.
# Details and reporting preferences also check notice type and administrator authority.
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
  dismiss @2 () -> (result :Result(Empty));
  markRead @3 () -> (result :Result(Empty));
  # These act only on this notice. Missing/foreign markRead is a harmless no-op,
  # matching Meteor; an empty selector never means all notices.
}

# Options for app-requested API credentials. Pointer presence preserves optional
# discovery fields; canonical validation and token policy remain in Meteor.
struct TemplateOptions {
  petname @0 :Text;
  role @1 :TemplateRole;
  forSharing @2 :Bool;
  unauthenticated @3 :TemplateDiscovery;
}
struct TemplateRole {
  union {
    none @0 :Void;
    allAccess @1 :Void;
    roleId @2 :Int32;
    # Matches Meteor roleAssignmentPattern (Match.Integer).
  }
  addPermissions @3 :List(Bool);
  removePermissions @4 :List(Bool);
}
struct TemplateDiscovery {
  options @0 :Options;
  resources @1 :List(Resource);
  struct Options { dav @0 :List(Text); }
  struct Resource {
    path @0 :Text;
    type @1 :Text;
    language @2 :Text;
    encoding @3 :Text;
    body @4 :Text;
  }
}
struct TemplateToken {
  token @0 :Text;
  host @1 :Text;
}

struct CreatedGrain { grainId @0 :Text; }
struct GrainTitle { title @0 :Text; ownerTitle @1 :Text; }

# The view and its lease are issued together only on success. Release late
# successes after cancellation; a failure carries no session capability.
struct OpenedGrain {
  view @0 :GrainView;
  session @1 :GrainSession;
}

struct AppPage { actions @0 :List(AppAction); limited @1 :Bool; }
struct OpenedSharedGrain { view @0 :GrainView; session @1 :SharedSession; }

# Metadata lists carry no capabilities or live session credentials. These
# selectors are account-bound; each operation revalidates Meteor authority.
interface AppActionHandle {
  create @0 (title :Text) -> (result :Result(CreatedGrain));
  # Durable creation is separate from opening a UI session. Never replay.
}
interface ViewReference {
  open @0 () -> (result :Result(OpenedGrain));
  # A reference is independent of a particular iframe lease and route ID.
  # Each open creates a separately owned session. Closing it keeps this
  # reference usable, subject to current authorization. The grainView factory
  # currently resolves root views; future view sources can implement this API.
}

# Account-owned management selector; never requires opening a grain session.
enum GrainDisposition { active @0; trashed @1; unavailable @2; }
struct GrainManagementState { disposition @0 :GrainDisposition; }
interface GrainHandle {
  read @0 () -> (result :Result(GrainManagementState));
  trash @1 () -> (result :Result(Empty));
  restore @2 () -> (result :Result(Empty));
  remove @3 () -> (result :Result(Empty));
  # Permanently deletes owned trashed grains; forgets the caller's trashed shares.
  restart @4 () -> (result :Result(Empty));
  # Owner-only shutdown preserving sessions; caller reloads its iframe on success.
}
