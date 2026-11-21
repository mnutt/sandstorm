# Experimental Rust shell

A separate Rust/Axum process serving a static Svelte 5 / TypeScript frontend.
This is an initial spike for `~/docs/sandstorm/new-architecture.md`, using
real notifications and a grain menu through a narrowly scoped Meteor
bridge when installed.
Standalone runs use fixtures, including a separate C++ capability fixture for
browser → Rust → C++ RPC. Meteor remains the account and database authority.

## Run alongside Sandstorm

Prerequisites: Rust/Cargo, the `capnp` schema compiler, Node.js 22 and npm.
From the repository root:

```sh
make -C rust-shell build
make -C rust-shell run
```

Open **http://127.0.0.1:6082**. Use that exact origin; WebSocket admission checks
both Host and Origin. Port 6081 is already occupied on the development machine.
The main shell keeps its existing port (the UI links to
`http://sandstorm.localhost:6080` by default, or `RUST_SHELL_MAIN_URL`).
Standalone runs do not change existing service configuration.

Override the loopback listener or static asset directory if needed:

```sh
RUST_SHELL_ADDR=127.0.0.1:7082 make -C rust-shell run
RUST_SHELL_ASSETS=/absolute/path/to/dist make -C rust-shell run
```

Non-loopback binds are rejected. The compiled binary defaults to this checkout's
`frontend/dist`; set `RUST_SHELL_ASSETS` when moving it elsewhere. Stop with Ctrl-C.
Standalone fixture runs make no durable writes or grain lifecycle changes.

## Frontend hot reload against installed Sandstorm

Enable this once in `/opt/sandstorm/sandstorm.conf` alongside `RUST_SHELL_PORT`:

```ini
RUST_SHELL_DEV_PORT=5173
```

Install a bundle containing development-proxy support using the usual command:

```sh
sudo sandstorm update "$PWD/build/dev/packages/sandstorm-0-fast.tar.xz"
```

Then run this from the checkout **on the Sandstorm host** and leave it running:

```sh
make -C rust-shell dev
```

Open the existing Rust-shell HTTPS URL (on this machine,
`https://yertle.sandhost.org:7443`). Svelte, TypeScript, and CSS edits now go through
Vite hot reload. CSS updates preserve the page and component state; structural
component/module changes can remount affected components or trigger a reload.
No bundle rebuild or Sandstorm update is needed for these frontend edits. Vite binds to `127.0.0.1:5173` and refuses to silently choose a different
port. To change the port, set the same `RUST_SHELL_DEV_PORT` in the config and in
the environment when running `make -C rust-shell dev`.

The installed Rust process retains `/auth/*`, `/rpc`, and `/shared-rpc`. Frontend
HTTP and `/__vite_hmr` use a fixed loopback proxy under the same HTTPS origin, so
cookies, sign-in handoff, and iframe origin checks keep working. The proxy strips
cookies and authorization headers, checks the HMR Origin, preserves Vite's
WebSocket-token check, and blocks developer-control routes such as opening an
editor. Vite's filesystem access stays inside the frontend directory. The
isolated `/offer-template.html` and its script remain bundled assets, without
Vite injection. The production CSP remains in place.

If Vite is stopped, frontend pages return a clear 503 with the startup command;
authentication and RPC remain available. Open tabs detect a Vite restart and
reload automatically through its availability-ping protocol. There is no silent fallback to old
production assets. Remove `RUST_SHELL_DEV_PORT` and restart Sandstorm to return
to the bundled frontend. Development mode is opt-in; normal installations do not
proxy anything to Vite.

This loop covers frontend edits. Rust, Cap'n Proto schema, Meteor bridge, C++
gateway, and isolated offer-template changes still use the build/update workflow.
Run the normal tests and build a bundle at integration checkpoints. For the
focused hot-reload and authenticated-development checks:

```sh
cd rust-shell/frontend
node --test tests/dev.test.mjs
RUST_SHELL_TEST_DEV=1 node --test tests/auth.test.mjs
```

## Install alongside the main shell, with HTTPS

The repository's `make fast` now includes a release build of the Rust server and
its static assets. To omit it, configure CMake with
`-DSANDSTORM_BUILD_RUST_SHELL=OFF`. Packaging does not enable the service by itself.
The C++ fixture is test-only and is not included in the installed service.

For an existing `/opt/sandstorm` installation with working HTTPS:

```sh
make fast
sudo sandstorm update "$PWD/build/dev/packages/sandstorm-0-fast.tar.xz"
```

Use the normal updater; there is no separate Rust-shell installer. Updates preserve
`sandstorm.conf`. Enable the secondary listener once in that file, then restart
(or update) Sandstorm. For this development machine, use `100.89.147.5` as the
bind address to reach **https://yertle.sandhost.org:7443** over Tailscale.
For a loopback-only listener:

```ini
RUST_SHELL_PORT=7443
RUST_SHELL_BIND_IP=127.0.0.1
```

`RUST_SHELL_BIND_IP` defaults to the existing `BIND_IP` when omitted. The port
must differ from the main HTTP/HTTPS, Mongo, and SMTP ports. `HTTPS_PORT` and an
HTTPS `BASE_URL` are required. The secondary origin uses the `BASE_URL` hostname
with the new port, so the existing hostname certificate covers it.

**TLS terminates in Sandstorm's gateway.** Both HTTPS listeners share the existing
`GatewayTlsManager`, including its live certificate-update subscription. Existing
Sandcats/ACME renewal remains the sole owner of certificate acquisition and
renewal. Rust never receives certificate keys and has no separate ACME client.
There is no plaintext fallback on the secondary port. WebSockets use `wss:`.

The gateway proxies HTTP and WebSockets to a mode-0600 Unix socket at
`/var/sandstorm/socket/rust-shell-http` inside Sandstorm's chroot. The Rust process
runs as `SERVER_USER`, with unrelated inherited descriptors closed. Sandstorm's
monitor starts, restarts, and stops it independently of Meteor. `RUST_SHELL_SOCKET`,
`RUST_SHELL_ORIGIN`, `RUST_SHELL_ASSETS`, and `RUST_SHELL_MAIN_URL` are supplied by
the monitor. Incoming WebSocket Host and Origin must match that configured HTTPS
origin; arbitrary forwarded-header values do not establish trust.

To disable it, remove the two `RUST_SHELL_*` config entries and restart Sandstorm.
Remove those entries before rolling back to a bundle without this feature.

### Real notifications and sign-in

Choose **Sign in with Sandstorm**, then confirm your account in the main shell.
Meteor issues a one-use, 60-second grant bound to the browser's sign-in nonce.
The form posts it to Rust, which exchanges it through a private mode-0600 Unix
socket. The browser receives a Secure, HttpOnly, SameSite=Lax session cookie;
Meteor resume tokens never cross the bridge. Sessions last at most 12 hours and
are revalidated against the original Meteor login token on every bridge call.
Logging out that source session or suspending the account revokes access.
**Switch account** repeats the handoff and revokes the previous linked session.
Changing accounts elsewhere without revoking that login does not implicitly
change the Rust shell's selected account. **Disconnect** revokes the Rust session.
Linked sessions survive Meteor restarts and `sandstorm update`. A server-only,
unpublished `rustShellLinkedSessions` Mongo collection stores the SHA-256 hash of
the random bearer token, the account ID, the original Meteor login-token hash,
and a fixed expiry. It never stores the raw bearer or Meteor resume token. The
session-store interface is independent of Mongo so storage can migrate later;
Meteor remains the authentication authority. Expiry is enforced on reads, with
periodic pruning and a TTL index for cleanup. Restart does not extend the 12-hour
limit. Disconnect and account switching remove the persisted link; source logout
and suspension invalidate it on the next authorization check. Database outages
fail requests without deleting otherwise valid links.

Ordinary reloads retain the cookie. The HTTPS regression recreates the bridge over a shared store while
a grain and chooser are open, verifies waiting/recovery with the same cookie,
and verifies that neither UI operation is replayed. The real Mongo regression
checks bridge recreation, durable disconnect, and source-token revocation.

During a bridge outage the frontend displays **Waiting for the main shell…**
and retries. A live-update initialization timeout has its own message; a timeout
alone does not establish whether Meteor was still starting.

Installed mode reads up to 100 of the account's newest real notifications, with a
total count. Mongo observers wake a pending Rust request when notifications,
owned/shared grain titles, referenced sender names, or account authority change. Rust pushes changed snapshots
over Cap'n Proto. Dismiss, cancel ongoing activity, and mark-all-read delegate to the
same Meteor functions used by the main UI, including ownership and cleanup checks.
Dismiss and mark-as-read use the scoped `NotificationHandle`, returning typed
`Result(Empty)` failures. The root `Shell.markAllRead` explicitly marks the whole
account; an empty notice selector cannot select all notices. Foreign/missing
single-notice reads remain harmless no-ops, as in Meteor, while dismissal retains
canonical ownership checks. Handles are released on completion, timeout, or
connection change. Expected failures display their safe application message;
transport failures display an uncertain-outcome message and are never replayed.
The former root `dismissReal` and ID-taking `markRead` methods are removed.

Opening a notification marks only that account’s selected notice as read; the
explicit mark-all action remains separate. Rows share date and action columns,
so longer cancellation buttons do not shift the dates.
Grain activity links open in the Rust shell, preserving the app path, query, and
fragment; app-update links open the native installer. Usage-statistics choices,
referral details, and account-identity notices open native dialogs. Each dialog
owns a typed `NotificationHandle`; reads return a statistics/referrals/identity
union. Reporting preference preserves the distinction between unset and disabled.
Saving statistics preferences is an explicit typed method. Every operation
rechecks notice ownership/type; statistics operations also recheck current
administrator authority. Dismissing
a notice invalidates subsequent operations through retained handles. Expected
denials use structured results; transport failures never trigger mutation replay.
The formatted statistics sample is display text, not an encoded RPC response. Statistics
reads and writes require current administrator authority; the fixed reportStats
setting and notice cleanup match the legacy admin UI. Referral projections include
only the current account’s pending/completed names.
Other unsupported destinations retain an explicit main-shell link. Native paths are
projected separately from legacy URLs and validated to stay within the specified
grain route. Following a notification does not grant grain access: normal session
authorization still applies. Shared-grain titles use the recipient's token metadata
and the same upstream-title/personal-rename helper as the main UI; revoked tokens
are excluded. Sender names are fetched only for accounts referenced by the
recipient's own notifications. Title changes, token changes, and referenced sender
renames wake the projection. Anonymous activity has an explicit label. Ongoing
notifications preserve the app-provided message and confirm cancellation before stopping activity.
User avatars appear in the account menu, notification senders, sharing recipients,
referral lists, and shared-link identity choices. URLs come only from users already
visible to each account-scoped projection. The topbar and notification sender
pictures update through Mongo observation; anonymous senders expose no picture.
A shared avatar component supplies initials or a generic user icon when an image
is absent or fails to load. App icons and localized notification copy remain to be ported.
There is no test-notification button in this mode. Standalone runs without
`RUST_SHELL_BRIDGE_SOCKET` retain the isolated fixture UI.

The private bridge uses JSON HTTP over a Unix socket. It exposes only
session exchange/validation and account-scoped notification operations; it never
accepts browser-provided account IDs or Mongo selectors. Browser RPC remains
Cap'n Proto. Authentication failures close active RPC connections and clear old
UI state on reconnect. While idle, authority is checked every second without
rebuilding notification projections; account changes also wake the request.

The internal `watch` operation is a bounded long-poll, with one request in flight
per observation, with no bridge-wide watch quota. Observers are attached
before reading a snapshot. A content hash detects changes between requests, and
a dirty flag catches writes during a read without accumulating an event queue.
Every returned projection is reauthorized. Unchanged requests return after 20
seconds so Rust can establish a fresh watch (30-second HTTP deadline). Disconnects,
errors, completion, and cancellation release the request's Mongo observers.
This is ephemeral observation, not durable replay. Each browser connection owns
its projection observation until disconnect; the browser callback capability
separately controls delivery of those snapshots.

### Read-only grain menu

The **Grains** page shares the authenticated connection and revisioned account
snapshot with notifications. It shows grain and app titles, owned/shared labels, last-used times,
and links into the main shell. Search matches title or app within the loaded
preview; ownership filtering and sorting by title or recent use also stay local.
App names come from referenced packages for owned grains and recipient metadata
for shares. Package-name changes wake observation. Missing metadata displays an
unknown-app label. Refresh/reconnect clears old data and obtains a new authorized
snapshot; the initial session check has a timeout and is canceled on reconnect.
The menu remains read-only. **Open here** now requests an explicitly leased UI
session from Meteor; Rust does not own grain execution.

The projection includes at most 50 owned grains and 50 shared candidates. Mongo
groups recipient tokens by grain before limiting; the oldest token supplies the
recipient's title and the latest usage time determines ordering. Self-shares are
suppressed even for owned grains outside the preview or in the trash. Trashed,
suspended, and directly revoked records are excluded. A limit indicator links to
the complete main-shell list; this is not a paginated replacement yet.

Shared entries use recipient token metadata for display names and upstream
owner titles, matching the main shell’s title helper. Menu presence does not grant
access or resolve every upstream sharing-chain requirement: the main shell checks
those when opening the link. No privileged backend capabilities cross the API.
Mongo observation covers title, usage, trash, ownership, suspension, and token
changes. Account switching, disconnect, and logout clear both projections.

### Account profile

The **Account** page (`/account`) reads and edits display name, handle, and
pronouns for the linked account. Entering the page reads current values. The live
snapshot includes a version of the displayed profile fields; edits in another tab
or the legacy shell show “The profile was updated by someone else.” with a
**Refresh** button. Values and unsaved drafts remain untouched until Refresh is
chosen. Own saves and picture uploads acknowledge their returned version.
The page also displays and uploads profile pictures using the canonical static-asset
endpoint. Choose a PNG or JPEG and explicitly upload it. The browser
center-crops to 512×512, flattens transparency onto white, and encodes JPEG at 85%
quality, reducing quality if necessary to meet the 64 KiB server limit. The original
file is never uploaded. Selecting a file prepares a local thumbnail; Upload sends
those exact preview bytes, and Cancel discards the selection. Preparation, upload errors, and success messages appear
beside the image controls. The server checks image signatures and size, consumes the upload credential once,
and manages asset references. Unused credentials expire after five minutes;
issuing another Rust upload replaces that account’s previous unused Rust token.
Upload bytes bypass RPC and omit cookies. The CSP permits the configured static
host (`RUST_SHELL_WILDCARD_HOST`, supplied by the launcher), not arbitrary upload
origins. Account changes/disconnect abort client uploads and discard late results;
uncertain outcomes are never retried automatically. As in the legacy uploader,
a credential already issued remains usable until consumed, replaced, or expired.
Login methods and email use the native Account credential controls.

`Account.readProfile`, `Account.updateProfile`, and `Account.preparePictureUpload`
derive the account from the linked session, never
a browser-supplied account ID. Updates use the same `updateProfileForUser` helper
as Meteor's `updateProfile` method, preserving handle/pronoun validation and
signup completion. Only these three profile fields are writable through `updateProfile`; picture
uploads use their separate one-use credential. The bridge serializes updates per account and rechecks login/cancellation immediately before writes.
Profile reads are reauthorized before returning. Credentials and other profile
fields are preserved. All three operations return typed results; expected denials
are shown directly, while transport failures leave mutation outcomes uncertain.
Pronouns use an enum matching Meteor's existing neutral/male/female/robot choices.
Superseded root-level profile RPC methods and the unused main-shell URL field are removed.

The profile service owns request lifetimes and save outcomes across route changes.
Disconnect clears account data; an unconfirmed save displays an explicit warning
and is never replayed. Late reads cannot overwrite a save or a different account.
The displayed connected name updates after a successful save or profile refresh.
This is not full account-settings parity or conflict resolution: saves
retain the main shell's last-write-wins behavior.

### Native account credentials and sign-in

The account page lists linked login methods and verified email addresses, supports
primary-email selection, email-code verification, GitHub/Google/OIDC/SAML linking, and credential
removal/login toggles. Mutations are account-scoped and serialized; removing the
last login method is rejected. Credential-array updates compare the authorized
arrays to reject concurrent changes. Email codes are consumed atomically and
checked for expiry at consumption, using the same helper as the Meteor UI.

`/login` offers enabled development accounts, email codes, LDAP, GitHub, Google, OpenID Connect, and SAML.
The bridge invokes the real Meteor login methods using a temporary DDP connection
through a secret-protected loopback upgrade listener into Meteor’s existing DDP
handler. This avoids dependence on public DNS or gateway redirects. Existing login validators, organization checks,
account creation, and login-token ownership remain in Meteor. Rust receives the
linked session and sets its existing HttpOnly cookie; passwords and credential
resume tokens are never persisted in frontend state or browser storage. The login
exchange tracks temporary tokens before checking cancellation, revokes late results,
and transfers the account token only after the Rust session has been issued.
Starting sign-in refreshes the flow cookie, including on an idle login page.
OAuth and SAML share a five-minute attempt store with active expiry. Popup cleanup
uses its own short-lived signal so leaving the page does not cancel cancellation.
Native OAuth IDs remain recognizable after consumption, cancellation, or restart;
late callbacks discard their credentials and return HTTP 410 instead of invoking
Meteor's browser credential-delivery handler.

GitHub, Google, and OIDC use their existing configured callback URLs. An expiring, server-side
request map binds each flow to its provider and Rust sign-in cookie, linked account, or provider
session. Only those state tokens use the Rust callback adapter; other OAuth flows
retain Meteor's handler. The callback retains the OAuth secret on the server and
redirects its popup to `/oauth-complete`. The opener polls for completion; secrets
never pass through postMessage, query strings, or localStorage. Cancellation and
completion consume the request. Provider configuration is reused without changing
provider callback registration. OIDC shares Meteor's authorization URL builder,
including the configured issuer endpoint, client authentication, and requested
scopes. Its popup destination is server-selected; HTTP endpoints remain supported
for providers configured that way in Meteor. An explicit main-shell sign-in link
remains available for reusing an existing session. Email messages still include the canonical Meteor email link;
the code can be entered directly in the native form.

SAML uses the existing assertion validation endpoint and Meteor login handler.
Its server-side flow binds an opaque polling key to the sign-in cookie or account.
The AuthnRequest ID sent to the identity provider is separate from both
that polling key and the one-use DDP credential, which never reaches the browser.
Canceled, expired, disabled, and consumed native requests cannot accept callbacks;
pending requests expire after five minutes. Account linking revalidates account
authority before writing. Native logout also generates the existing SAML LogoutRequest for accounts with
SAML login credentials. It revokes the Rust session and grain leases before
returning the configured identity-provider URL. Missing or broken provider
configuration leaves the user locally signed out with a visible warning.
Provider-initiated single logout still uses Meteor's existing SAML logout route.


Lists now have native Previous/Next controls. Grains and notification pages remain
live through independent query-scoped subscriptions, with at most 100 entries per list.
Switching pages cancels the old long-poll and reads/observes the selected page;
reconnecting starts at page one. The notification bell reflects unread entries
across the entire account. Installed actions use bounded pages and app-specific
queries so direct app routes can find actions beyond the first page. Grain search, ownership/app filtering, and sorting happen in Mongo before pagination.
App-gallery search still applies to its displayed page. Concurrent writes may move rows between pages.

### Installed apps and grain creation

The **Apps** page lists installed account-owned actions in pages of 100. It refreshes
on entry/reconnect and page changes. Choose an action and title to create and open
a grain here. Installation and upgrades also have native UI; development-only app
actions remain in the main shell.

The browser supplies only an action ID and title. Meteor resolves the command
and package from that account's installed action, then uses the same
`createGrainForUser` implementation as the legacy `newGrain` method. Signup/demo,
quota, and package checks retain their existing owner. The Rust bridge rechecks
the linked login and request connection immediately before inserting the grain.
It admits one in-flight creation per account to prevent overlapping writes.

`Shell.action(key).create(title)` returns `Result(CreatedGrain)` and `GrainSession.rename`
returns `Result(GrainTitle)`. Policy denials carry typed failures and readable
messages. A rejected creation is retained as a distinct account-scoped outcome;
dismissing it allows an explicit new attempt without an unknown-outcome warning.
Rename errors preserve the title editor and do not expose RPC exception details.
Neither mutation retains its former unwrapped result API.

Creation is never automatically retried. A lost response may mean the grain was
created; the UI disables another submission and asks the user to check their
grains. Navigation or disconnect does not delete a grain that already committed.
Creation outcomes are retained in the account-scoped service when leaving and
returning to Apps, including pending, created, rejected, and unknown results. A successful
result offers reopening that grain or explicitly starting another; an unknown
result requires acknowledging that the grain list was checked. A stable opaque
account key from the session endpoint separates accounts with identical names.
This is in-memory state: a full browser reload loses it. It is not durable
idempotency or recovery of a creation result across restart.

The browser suite covers creation, route restoration, and a failed response
without replay. Bridge tests cover admission, cancellation and logout before
commit. The packaged test checks account-scoped actions and opens a real grain
created through the production adapter. Run it against the fast bundle with
`make -C rust-shell test-package`; it starts an isolated test server.

### Embedded grain UI sessions

**Open here** opens a persistent workspace tab, using the signed-in account's
Sandstorm identity. Meteor checks `mayOpenGrainAsync` and uses the existing
`createSession` path with the configured Rust HTTPS origin as `parentOrigin`.
The normal gateway supplies the app iframe, performs full permissions checks,
and retains its existing revocation observer. Rust never receives `Backend`.
The initialization URL goes only into the iframe and is not persisted in shell
history or storage. The shell CSP permits HTTPS frames; only Meteor's authorized
session response supplies the frame URL.

`Shell.grainView(grainId).open()` returns `Result(OpenedGrain)`: a successful value contains both the
view and its `GrainSession` capability. Expected access denials carry typed
failures and no capability. The UI displays their application message and hides
transport exception details. Late successes release their session; late failures
have nothing to release. Malformed iframe URLs also release the issued session.
There is no compatibility wrapper for the previous unwrapped result. Explicit close, capability
release and WebSocket disconnect close the UI session. Navigation hides established
iframes without unloading them; their independent sessions and app state stay live.
Each tab has its own Meteor scope. Rust
renews its lease every 10 seconds; Meteor expires abandoned leases after 45
seconds, checked every five seconds. Closing, logout, or cancellation while opening also
cleans up a session that finishes creation late. Old session handles cannot close
a replacement session. Closing removes the UI session record, never the grain.

A Rust crash clears the old iframe; reconnect does not replay the open operation.
The URL remains available for an explicit reopen or browser reload.
The user can explicitly reopen with the same linked Meteor login. Meteor restart
preserves valid linked logins and removes marked experimental UI sessions. Their
expiry is also recorded in Mongo. If Mongo is unavailable during cleanup, the
existing idle-session cleanup remains the fallback. Rolling back to a bundle
without this bridge leaves its existing three-minute idle-session cleanup in
charge; it does not stop the grain.

**Rename grain** uses the active `GrainSession` capability. Meteor keeps the same
owner/recipient naming rules as `updateGrainTitle`: owners change the grain and
upstream share titles; recipients change only their own share names. Renaming a
share to match the upstream title restores its default naming behavior. The
bridge permits one rename at a time per lease, checking
login, grain access, and lease lifetime again immediately before the write.
Failed requests are not automatically replayed or rolled back over later writes.

The response updates the active title, including for grains outside the menu
preview. For grains in the loaded menu, observed renames from the main shell or
other tabs update the open grain title too. These updates preserve the iframe
element and session. App-provided page titles remain separate from grain names.
Tests cover owner/shared naming, revocation, cancellation before writing, and
frame continuity across both Rust and legacy title changes.

Each grain exposes `GrainSession.whenClosed()` as a lifetime signal. A failed
renewal invalidates only that lease, removes its iframe, and offers an explicit
reopen; other grains keep their frame state. Renewals run concurrently across the
open grains. Account revocation or transport failure still closes
all account-scoped sessions. Pending lifetime calls do not retain the lease.

Iframe messages require both the exact session origin and the active frame's
source window. The first slice supports display-only `setTitle`, local `setPath`,
and `getGrainTitle` replies with optional `subscribe: true` updates. The app
receives the owner title, never the recipient’s personal alias; title
subscriptions live with the frame. Live updates currently cover grains in the
loaded menu. Sharing requests open a native shell dialog;
`renderTemplate` uses an isolated shell-origin display (below). Powerbox requests
use the native chooser described below.
This is not full postMessage API parity,
an incognito/sharing-link flow, or live-session restoration across reconnects.

The grain toolbar's **Share** and **Who has access** buttons open a native Bits UI
modal. App `startSharing` and `showConnectionGraph` requests open the same modal
only for the active, account-owned UI session after exact origin/source checks.
Paths and fragments are validated independently of the shell origin. Creating a
link requires an explicit user action; the new webkey is shown only in the trusted
shell, held in component memory until close, and never sent to the embedded app.
Links point at the Rust shell's existing anonymous/identity-aware shared viewer.

`GrainSession.sharing()` returns a grain-scoped `Sharing` capability. Its typed
`read`, `create`, `edit`, and `revoke` methods reach narrowly scoped
private bridge operations. Meteor rechecks the linked account, grain lease and
canonical grain authorization before and after operations. Creation uses
`SandstormPermissions.createNewApiToken`; edits share `updateApiTokenForAccount`
with the legacy Meteor method. A canceled creation removes its late token. Calls
are serialized per lease, with no lifetime issuance quota. Mutations
are never automatically replayed; an uncertain outcome asks the user to inspect
existing links before retrying.

The dialog supports labels, roles, copy, and confirmed revocation of the current
account's root sharing links and direct user grants. The access view projects the
canonical downstream graph, including link-derived recipients, without exporting
raw database documents. Other accounts' grants and child tokens are read-only;
revoking a source link explicitly warns that downstream recipients are affected.
This does not implement selective revocation of a person who can reuse a webkey.
Metadata loads on open, after mutations, and with **Refresh sharing**; it is not a
live subscription. Responses include the full visible grant graph and role definitions.
The main Meteor shell retains its own sharing route; the Rust UI uses the typed
Sharing capability. Public `SharedSession` capabilities still expose only `close`.

Validation includes capability release, close/reopen, late creation cancellation,
source-login revocation, logout with an active iframe, lease renewal/expiry,
iframe continuity during notification updates, forged messages, and Rust crash/
restart against an independent test grain host. `tests/tests/rust-grain-session.js`
opens the real Sandstorm test app through owned and shared UI sessions, verifies
keepalive and cleanup, revokes sharing while the iframe is active, checks that
subsequent gateway requests fail, and reopens as the owner. That test exercises
the real Meteor/C++ gateway with the main-shell parent origin; the browser/Rust
integration test exercises the secondary HTTPS origin with an isolated adapter.
The user confirmed grain opening on the deployed secondary HTTPS origin on yertle.
The user also confirmed the Powerbox handoff and Davros API templates on yertle.

### URL navigation

The shell has `/notifications`, `/grains`, `/apps`, and `/grain/<id>/<app-path>` routes.
Shared links (`/shared/<token>/<app-path>`) use a separate public SharedShell RPC
bootstrap. Anonymous visitors can open the link when guest policy permits it;
signed-in visitors explicitly choose anonymous viewing or revealing their identity.
Both choices use the webkey permission vertex, never broader account permissions.
The shared interface exposes only inspection, opening and closing its own session;
it cannot read account notifications/profile/grains or create API tokens. Shared
views retain the app path and can stay mounted in background sidebar tabs. They do
not redeem the token into permanent account access. Rename, sharing management,
Powerbox and API-template issuance are not exposed through this guest interface.
Shared viewers have no connection-count quota. Unopened
connections expire after 30 seconds for guests or 120 seconds after a validated
sign-in; active sessions renew their 45-second lease every ten seconds.

Sidebar navigation and opening/closing grains participate in browser history;
Back/Forward selects an existing tab or opens a new authorized session. Background
`setPath` messages update that tab’s link without changing the selected route. Valid
app `setPath` messages replace the current route, including query and fragment,
without replacing the iframe. Origin and source-window checks still apply.

Reloading or following a bookmark opens a fresh, authorized UI session at the
requested app path. The URL contains the grain ID and app path, never a UI session
ID or shell bearer token. Direct links do not depend on membership in the bounded
grain menu; Meteor checks access and supplies the account-scoped grain title.
Only explicit SPA routes serve the frontend index; unknown API and asset paths
remain errors. Invalid app paths cannot navigate to another origin.

A transient connection failure preserves the route but does not silently reopen
the grain. Use **Reopen grain** or reload to restore it. Returning from the main
shell's sign-in handoff restores the route from a short-lived, tab-local record;
only validated shell paths are accepted. Powerbox operations and API-token
issuance are never replayed by the router.

Browser coverage includes page and app-path reload, fresh session IDs, history
navigation, direct links beyond the menu, denied grain access, login return paths,
and navigation away during an in-flight grain opening.

### Native Powerbox chooser

An embedded app's `powerboxRequest` opens a native Bits UI dialog after exact
iframe origin/source validation. It offers a searchable list of matching grains
and built-in capabilities. Users can grant a UiView with selected permissions,
open a provider app inside the dialog to choose an object, use an existing
verified email/network capability, enter an HTTP(S) URL, or paste a local API
capability link. New email verification and GitHub/Google OAuth authorization are also native. Provider
iframes can request nested native Powerbox choosers.
Each child is bound to its provider session, not the outer requesting grain;
closing a parent closes its children. Unsupported shell
options (notably the optional Blackrock payment-provider cards) retain **More options
in main shell** only when the returned choices actually need it. Disabled OAuth
and email providers explain the required administrator configuration natively.

Identity requests show contact avatars and grant access to the requesting grain
before returning the selected person's identity capability. Role choices omit
obsolete roles and roles that cannot satisfy the requested permissions, preserving
the original role indices. The server selects the account from its private candidate
set and revalidates the role and requesting session before invoking the existing
identity driver. Arbitrary HTTP(S) URLs use the typed URL selection, including the
existing driver's basic/bearer credentials encoded in the URL; the input is cleared
on submission.

OAuth candidates carry a typed provider; selection supplies only the candidate key.
The server owns the target API URL and requested scopes. Google uses the same
email scope, offline access, and consent prompt as the Meteor chooser, so the
existing HTTP capability driver stores a refresh token when available.
Authorization state is isolated to each Powerbox request, including nested
requests. Provider credentials remain server-side, are consumed once by the
driver, and are discarded on cancellation or a failed exchange. The packaged
suite covers GitHub and Google capability issuance, target/session ownership,
provider mismatch, and cancellation with synthetic OAuth responses.


`GrainSession.powerbox` exposes only begin/select/poll/cancel operations. Each
request is bound to its account, grain lease, and random request ID, expires in
five minutes, and serializes operations. Meteor holds the candidate records and
provider session; the browser receives only bounded display metadata and option
keys. Clients cannot supply a frontendRef object, provider grain ID, receiving
grain ID, or session ID. Matching and issuance reuse the same exported functions
as the legacy publication and methods. All matching supported candidates and roles
are projected without a Rust-shell count or byte quota.

Provider sessions use the normal gateway's `powerboxRequest` machinery and the
Rust shell's parent origin. The trusted shell polls for fulfillment once a second
and posts the result only to the requesting iframe, preserving its rpcId. No
provider `postMessage` can inject a result. The provider closes after completion,
cancellation, expiry, disconnect, or parent-lease revocation. Undelivered tokens
are removed. Native provider fulfillment is conditional on a live, unclosed
session and can be published only once; a late or duplicate save removes its
new token. Mutations are never replayed automatically. Public shared-grain
capabilities do not expose Powerbox authority.

Pasted API capability links are exchanged with the canonical restore/save path;
the input URL is never fetched. Only local API hosts with matching token-specific
hostnames are accepted. The derived token is bound to the authenticated requesting
session and grain; the app never receives the original webkey. Raw links stay in
component memory, are cleared on submission/back/close, and are not persisted.
External webkeys and ordinary `/shared/` grain links are not accepted. The same
helper backs the legacy method and derives its receiving grain from the session.

The fallback retains its exact origin/window/nonce checks. Tests cover native
UiView and hosted-provider selection, cancellation, duplicate requests, forged
candidate keys, late-result cleanup, lease/account isolation, and the explicit
legacy fallback. The isolated package test fulfills a real app request in a
provider iframe, then redeems and calls the returned capability from the original
requesting app. It also checks UiView/HTTP token ownership and one-shot completion.

### API instruction templates

`renderTemplate` supports text containing `$API_TOKEN`, `$API_HOST`, and
`$GRAIN_TITLE_SLUG`, with `petname`, `roleAssignment`, `forSharing`, color, and
left/right copy buttons. `unauthenticated` discovery metadata uses Meteor’s
existing validation and API-host resources (including Davros status and DAV
options). `clientapp` renders a user-clicked desktop connection link using the
main shell's `clientapp-<name>:<protocol>//<host>#<token>` format. Names are
validated and normalized to lowercase; the credential-bearing link remains
inside the trusted display frame and is removed when the offer expires or is
cleared. Display options reuse the same token. HTML is displayed as text.

The scoped `GrainSession.renderTemplate` method takes `TemplateOptions` and
returns `Result(TemplateToken)`. Its role union includes the app-facing
add/remove permission masks; optional typed discovery fields preserve absent
versus empty metadata. No JSON-text RPC or compatibility method remains.
Expected policy errors are typed failures, while transport details stay out of
app-facing replies. The canonical 4 KiB discovery bound remains; token labels
have no additional Rust-shell length limit.

The capability asks Meteor to create a token using the existing
`createNewApiToken` permission path. The bridge checks linked-login
and grain access, permits one issuance at a time, and
revokes a late-created token if the lease closes or authorization ends. Tokens
retain the existing five-minute unused expiry. Issued API access is separate
from UI-session lifetime: an API token already copied and used remains subject
to the existing permission and revocation rules.

The frontend coalesces concurrent requests with identical token options and
memoizes their result for 2.5 minutes, matching the main-shell behavior. This is
necessary for Davros's separate URL, username, and password fields to agree on
the same token-specific API host. Different issuances are queued.
Closing the view clears both records and cache.

The trusted frontend stores the result in tab-local sessionStorage and gives the
app only a random fragment URL to `/offer-template.html`. That document renders
plain text on the Rust shell origin; the app cannot read its DOM or token. Only
this static renderer allows HTTPS framing; the shell itself retains
`frame-ancestors 'none'`. The renderer performs the existing token keepalive,
expires unavailable/revoked offers, and never posts token contents to its parent.
Closing a grain removes only its own stored offers. Shell initialization and
every connection reset clear all leftover offers, even on routes that open no
grain. Opening another workspace tab does not invalidate existing live offers. Direct top-level display is disabled. Clipboard permissions
may require selecting/copying text manually in an embedded app.

Browser tests check placeholder substitution, text-only rendering, origin
isolation, reply contents, and storage cleanup. Lease tests cover repeated issuance
and cancellation during creation; the real-grain test checks canonical token
ownership, expiry, gateway keepalive, and rejection after sharing revocation.
Davros regression coverage checks simultaneous field rendering, shared tokens,
public status/DAV discovery, denial of unlisted paths, and malformed metadata.

### Packaging audit policy

`make-bundle.sh` explicitly invokes `npm audit --omit=dev --audit-level=high`
and treats its nonzero exit as fatal. This is a project-selected build gate,
not npm making ordinary installation warnings fatal. Build helpers such as
`node-gyp` are installed for native rebuilds and then pruned as development
dependencies before the production audit and packaging. The audit gate remains
enabled; the Rust frontend's development-tool advisory below is separate.

## What the spike exercises

- Axum serves the frontend and admits an origin-checked `/rpc` WebSocket.
- The browser receives a connection-local `Shell` capability, never `Backend`.
- `watch(observer)` passes a browser callback capability to Rust and returns a
  subscription capability. Its first full snapshot marks the UI ready.
- Adding/dismissing test notifications changes only this connection's memory.
  Each connection starts with one welcome notification. Other tabs are isolated.
- Updates carry ordered, revisioned list deltas plus current scalar metadata. A slow
  callback gets changes from its last acknowledged state to the latest projection;
  intermediate source changes can coalesce. This is not a durable event log.
- The typed frontend service owns transport, handles, retries and state decoding.
  Components receive plain values. Disconnect clears old state; reconnect uses
  exponential backoff and a fresh authorized snapshot (or fixture). Mutations are never automatically replayed.
- Explicit cancel, capability release and disconnect end subscriptions. A connection
  owns a scope that explicitly cancels its observations on shutdown; a pending
  `whenClosed()` call does not retain the subscription. Multiple summary, query,
  and installation watches can coexist without a per-connection count quota.
- `Subscription.whenClosed()` stays pending while delivery is healthy, resolves
  on explicit cancellation, and rejects if a callback fails or exceeds its
  ten-second deadline. Failure remains observable after cleanup. The frontend
  monitors this capability and reconnects for a fresh authorized snapshot; it
  clears stale state and grain frames without replaying mutations or grain opens.
- An opt-in `interop()` capability forwards to a C++ fixture over a Unix socket.
  Tests cover returned counter capabilities, pipelined calls, reentrant browser
  callbacks, exceptions, streaming, backpressure and resource cleanup.

## C++ interoperability fixture

`make -C rust-shell test` builds and starts the C++ fixture automatically in a
private temporary directory. It requires a C++17 compiler, `pkg-config`, and
Cap'n Proto C++ development headers/libraries (`capnp-rpc`). The validated system
library here is 1.5.0. This fixture is independent of the main Sandstorm build.

For manual use, create a private directory and run the fixture in one terminal:

```sh
make -C rust-shell cpp-fixture
fixture_dir=$(mktemp -d /tmp/rust-shell-fixture.XXXXXX)
printf 'Fixture socket: %s/fixture.sock\n' "$fixture_dir"
rust-shell/target/cpp-fixture "$fixture_dir/fixture.sock"
```

In another terminal, pass the printed socket path to Rust:

```sh
RUST_SHELL_FIXTURE_SOCKET=/tmp/rust-shell-fixture.XXXXXX/fixture.sock make -C rust-shell run
```

The socket path is operator configuration, never browser input. An unset/empty
variable disables `interop()`. It only exposes the dedicated `fixture.capnp` API;
do not point it at Sandstorm's real backend. The notification UI remains the same;
the browser test probes exercise the C++ API. Stop both processes to end a manual
run, then remove your temporary directory. Existing socket paths are not overwritten.

Rust lazily opens one Unix connection per browser connection, with a two-second
connect timeout. The WebSocket task explicitly cancels its Unix RPC task when
closing, including while forwarded capabilities or callbacks are still alive.
Dropping a reference alone was insufficient in the disconnect test; the scope
guard is required to release C++ resources. A backend failure leaves existing
capabilities broken; it does not silently rebind them or replay mutations. A
fresh browser connection can connect after the fixture restarts. Rust notification
operations continue to work when C++ is unavailable.

The C++ service limits live counters to 64 and live stream capabilities to 16
across its clients. Streams send up to 64 chunks of at most 16 KiB, with exactly
one unacknowledged `ByteSink.write()` at a time. Slow receivers cannot cause a
growing stream queue. Cancellation/release stops the task; disconnect releases
all capabilities for that browser. Statistics are fixture-only diagnostics.

## Dependency baseline

Branch `rust-ui` is based on `sandcats-org` (`ce66be7ef`), which includes
the Sandhost DNS/certificate backend and starts from `0296814d0` on `meteor-3.5`. The proposal's inspected
`capnp-es` branch is `555d51a53`; its much broader shell/isolate changes have not
been merged. That branch used a vendored shell archive from fork commit
`6b427072da39beef24c8d391ba69d012706610af` and a separate `@mnutt` isolate runtime.

Per the spike's explicit dependency choice, this frontend uses exactly
**`@mnutt/capnp-es@0.5.0`**, installed through the npm alias
`"capnp-es": "npm:@mnutt/capnp-es@0.5.0"`. The alias matches the import emitted by
that compiler. Compiler and runtime therefore come from the same fork/version;
the public unscoped package and local personal checkouts are not dependencies.
The lockfile records the scoped tarball URL and integrity. Generated bindings
are built from `schema/shell.capnp` and `schema/fixture.capnp`, not checked in.
The fixture schema is compiled by Rust, TypeScript, and C++ toolchains.
The 0.5.0 generator specializes branded generic results: `Result(InstallationState)`
exposes an `InstallationState` value, verified by `frontend/tests/schema-types.ts`.

The native frontend uses typed `Installer`/`Installation`, `Account`, `Sharing`,
`NotificationHandle`, and `PowerboxRequest` capabilities. Grain and notification views own independent
query subscriptions. The experimental Rust API has no backward-compatibility
contract: superseded methods are removed, ordinals can change, and frontend/server
bindings must be deployed together. The private Meteor adapter still uses JSON
internally. Sharing roles, grants and edits cross the browser boundary as typed
structures; label-only edits explicitly preserve existing custom permissions.
Expected installation, account, sharing, notification, grain, app-list, shared-view,
and Powerbox denials use `Result.failure`, with
a typed code and a readable message. Unexpected transport/backend errors remain
RPC failures; these views display a generic outcome-uncertain message instead of
protocol details and never automatically retry a mutation. Grain and notification
query observers deliver `Result(Page)` and terminate after a policy failure;
the client preserves that reason when the terminal signal follows. Expired
resource operations have an explicit `expired` failure code; Meteor storage-quota
denials use `quotaExceeded` without introducing a new quota.

Installation factories remain pipelinable: `Installer.open` returns a selector
capability, while its typed operations validate package IDs and recheck policy.
App lists preserve the page returned by Meteor without a second Rust truncation.
Template role IDs match Meteor's signed 32-bit `Match.Integer` contract.

Installation catalog/status results include advisory `InstallPermissions`.
The UI explains invitation, demo, and free-account upload restrictions before
offering the corresponding action. These flags confer no authority: download URL
restrictions, package checks, and account authorization still run on every write.

Rust dependencies use `Cargo.lock`; Cap'n Proto is pinned to the 0.25 family.
The full baseline Meteor suite has **not** been run, so this is not completion
of the proposal's Phase 0 or Phase 1 exit gate.

## Completed browser RPC audit

The `shell.capnp` audit backlog is complete for the implemented Rust-shell
features. This is separate from completing the architecture proposal or porting
all remaining main-shell features.

| Area | Final contract |
| --- | --- |
| Wire payloads | Domain structs, enums, unions, and branded `Result(T)`; no JSON-text browser RPCs or superseded compatibility methods. Display reports, URLs, webkeys, and encoded app Powerbox descriptors remain text by design. |
| Capability authority | Account, installation, notification, sharing, grain, and Powerbox handles scope operations; IDs are selectors and Meteor rechecks authority. Public shared-view bootstrap cannot expose account Shell authority. |
| Application failures | Expected denials, validation errors, and expiry are typed values, including shared-link inspection/opening and app lists. Query observers deliver typed terminal failures. Transport/backend faults remain exceptions with safe UI messages. |
| Factories and pipelining | Pure capability factories remain immediately callable; installation input validation occurs in typed operations. Grain opens return metadata and their lease together on success only. |
| Observation | Per-view query subscriptions, acknowledged serialized callbacks, explicit cancellation/release, and terminal signals. Typed failure reasons survive subsequent closure; late callbacks after disposal are ignored. |
| Lifetimes | Late opens release capabilities; malformed grain projections/URLs clean up sessions. Client cancellation deadlines release handles even if the acknowledgment never arrives. Closed Powerbox state terminates instead of polling indefinitely. |
| Mutations | Follow-up read or authorization failures after a completed write are uncertain outcomes, never apparent policy rejections. No automatic replay. Definite policy rejections remain distinct from unknown outcomes; account/generation guards protect state during navigation and account changes. |
| Limits | No additional production RPC throughput, connection, question, capability, subscription, grain, or share quotas. Transport framing follows the existing Meteor default; canonical validation and page sizing remain with Meteor. |
| Bindings | Compiler/runtime pinned together at `@mnutt/capnp-es` 0.5.0; schema-type tests check branded payloads, including capability-bearing opens and observer arguments. Frontend and server deploy together. |

Intentional RPC exceptions remain for malformed protocol data, failed capability
factories on the wrong bootstrap (such as real-account operations in fixture
mode), entropy/internal projection failures, transport loss, observer delivery
failure, and best-effort close/cancel failures. These are not successful domain
results or reasons to retry a mutation. Connection recovery and root-summary
subscription failure trigger reauthentication/revalidation rather than retaining
stale account projections. Fixture-only methods and the C++ interoperability
fixture remain explicitly gated test surfaces.

Validation covers Rust unit/lifetime tests; frontend state and browser RPC tests;
public/shared versus account authority; typed failure and callback delivery;
post-write revocation across account and grain operations;
real packaged grain creation, permission revocation, sharing, templates, and
Powerbox; and packaged account/profile/list flows. The full baseline Meteor suite
is still a separate migration exit gate. The private Meteor adapter deliberately
continues using JSON over its Unix socket; direct Mongo access and provider
feature parity are not part of this audit.

Final verification for this audit: `make -C rust-shell test` passed 17 Rust tests
and 72 frontend/browser tests, along with formatting, Clippy, Svelte and TypeScript
checks. `make fast` produced the update bundle. `make -C rust-shell test-package`
passed 100 assertions; `TESTCASE=tests/rust-auth.js tests/run-local.sh
build/dev/packages/sandstorm-0-fast.tar.xz build/dev/packages/test-app.spk` passed
18 account/profile/list assertions. Both packaged suites use isolated servers.

## Grain management

Owned grains can prepare and download ZIP backups from the native toolbar.
`GrainHandle.prepareBackup()` uses Meteor's canonical backup creation and returns
a same-origin Rust `/download-backup/:id` URL. Collections retain the legacy
warning about missing linked grains. Archive creation has no additional UI or
bridge deadline; a revoked or disconnected creation request cannot receive its
download token.

The Rust HTTP handler checks the login and account-bound file token through the
private bridge, opens the completed archive, and atomically consumes the token
before sending bytes. The existing backend unlinks the archive while Rust streams
its open file with backpressure; cancellation closes that handle. HEAD requests
do not consume tokens. Native tokens cannot be downloaded through Meteor's legacy
endpoint. Unused archives retain the existing cleanup schedule.

The bundle sets `RUST_SHELL_BACKUP_DIR=/var/sandstorm/backups`. This uses the local
archive directory already accessible to the Rust process under Sandstorm's service
UID; no general backend capability is added. Creation, metadata, and authorization
still depend on Meteor, but archive bytes and the HTTP download response do not.

Owned grains have a native **Restart app** toolbar control that acts immediately,
matching the legacy shell.
`GrainHandle.restart()` uses the same owner check and session-preserving shutdown
as the legacy `shutdownGrain` method. The bridge checks login authority immediately
before shutdown and confirms it afterward. Only a confirmed success reloads the
caller's iframe, preserving its current path, query, fragment, and session. Failed
or uncertain operations are displayed beside the app and are never replayed.
The `GrainView.owned` field is an advisory UI hint, not authorization.

The Grains and Trash pages support page-local selection, bulk trash/restore, and
confirmed permanent deletion. Deleting an owned grain removes its data; deleting
a shared grain only forgets that account's saved access. Batches stop on the first
failure, report confirmed successes, and never automatically retry mutations.

`Shell.grain()` returns an account-scoped `GrainHandle` without opening an app.
Its typed read/trash/restore/remove operations reuse the canonical Meteor grain
methods through the private bridge. The bridge rechecks login authority before
writes. Grain-list subscriptions include Trash, and legacy trash operations close
affected native sessions. Closed workspaces query authoritative management state
before removing saved reload entries; absence from a paginated list is not proof
that a grain was deleted.

## Browser-tab workspace restoration

Open grain IDs and app paths are saved in `sessionStorage`, separately for each
account and browser tab. Reloading restores background grains as well as the
current route, including when the current page is Apps or Notifications. Shared
links are saved as their URLs in the same tab-scoped storage; anonymous shared
workspaces use a separate scope. Closing a grain removes it from the saved list.
Login and authorization-completion pages do not start background grains.

Restoration creates fresh, authorized sessions; session IDs, RPC capabilities,
rendered templates, and iframe contents are not persisted. Deleted or denied
grains are dropped after a failed restore. A transport reconnect still does not
replay grain opens or other operations; a full page reload is the user's request
to restore the saved workspace. Storage being unavailable does not prevent use.

## Installed restart and update recovery

After `make fast`, run `make -C rust-shell test-recovery`. This dedicated gate
uses `tests/run-local.sh` to install the bundle in `tests/tmp-sandstorm`, creates
a test account and grain, and enables the packaged HTTPS gateway and Rust shell
with a short-lived test certificate. It refuses any other installation directory
and is disabled in the ordinary Nightwatch suite.

A browser stays open through both `sandstorm restart` and `sandstorm update`.
The gate checks that the HttpOnly login cookie survives, old grain iframes close,
and the grain route offers an explicit **Reopen grain** after recovery. Reopening
gets a fresh lease. A real Meteor rename must reach the existing Rust browser's
title and grain-list subscriptions, and reloading must reopen without signing in
again. The test also exercises persisted TLS keys through both restarts.

The installed recovery gate passed against the fast bundle. This is a same-bundle
update smoke test, not a cross-version database migration test or a live-server
certificate renewal test. It does not modify the development installation.

## Executor and transport

A current-thread Tokio runtime runs a `LocalSet`. Axum transfers upgraded sockets
through a bounded channel into local RPC tasks. Non-`Send` capability state never
crosses onto a worker thread. A bounded 64 KiB duplex stream adapts WebSocket
messages to `capnp-rpc`'s two-party byte-stream transport.

Wire format: one **unpacked** Cap'n Proto message, including its segment table,
per binary WebSocket message. Multiple Cap'n Proto segments are supported.
Malformed/truncated frames, trailing bytes, text messages, and oversized messages
close the connection. Inbound messages allow `0x3ffffff` bytes (about 64 MiB),
matching the bundled Meteor default SockJS transport: `ddp-server` supplies no
`maxLength` override to faye, whose websocket-driver uses that `MAX_LENGTH`.
This describes the default transport, not Meteor's optional UWS backend or a
custom deployment override. Cap'n Proto uses its standard reader validation.

The Rust shell adds no rate, connection, in-flight call, capability-reference,
subscription, grain, sharing-link, or pending-sign-in quotas. Browser send/receive
queues have no extra application-level ceiling. Internal bridge responses are
not capped separately. Pagination controls the size of individual list pages,
not the total available records. Existing Meteor account policy and native DDP
login rate limiting remain authoritative. Profile image size restrictions come
from the existing Meteor upload handler.

Unsolicited and duplicate returns are still rejected before the pinned
capnp-rpc 0.25.1 runtime indexes its question table. This validates the protocol;
it does not limit how many questions may be outstanding. A canceled question
can receive its one late reply. Mutations are never automatically replayed.

Lifecycle deadlines remain: observer delivery has one call in flight and a
ten-second deadline; failed delivery ends that observation. Linked-session
expiry, account revocation, and transport failure still require revalidation.
Per-resource write guards prevent conflicting simultaneous mutations, while
unrelated accounts and sessions can operate concurrently. Host/Origin checks,
scoped capabilities and idempotent cleanup remain enforced.

### Rust server security review (2026-11-18)

Reviewed all handwritten Rust server modules, the generated-schema entry points,
private bridge boundary, session/lease cancellation, and supervisor launch/TLS
configuration. No account-authentication or shared-webkey permission bypass was
found in this review. The Rust process runs as the Sandstorm service user behind
the existing TLS gateway, with a mode-0600 Unix listener, operation deadlines, no general URL fetch interface, and no handwritten unsafe blocks.
That service UID is a broad trust boundary, not a separate privilege sandbox.

The review originally added resource quotas; these were subsequently removed
to avoid stricter limits than Meteor. Retained fixes address repeated close
amplification and an unchecked question-ID indexing path in capnp-rpc 0.25.1
(rejected at our transport boundary). The latter could panic a connection task,
not a confirmed whole-process crash or memory-corruption exploit. Added tests for
unauthenticated malformed replies/floods, aligned envelope parsing, cookie
ambiguity, and admission under actual concurrent Unix-socket requests. Existing
session/revocation and C++ capability-forwarding tests remain required.

The locked dependency audit scanned 137 crates against 1,533 RustSec advisories.
Updated transitive rand 0.9.2 to 0.9.3 for RUSTSEC-2026-0097 (custom-logger
reentrancy; that trigger is not configured here). The updated lockfile reports
no vulnerabilities or informational warnings in that database snapshot.

This is not a formal security certification or a full gateway/Meteor audit.
Per-source abuse controls at the gateway, sustained adversarial load testing,
protocol fuzzing, and explicit OS memory/CPU isolation remain outstanding. A
public visitor can consume resources through the shared-view endpoint. Origin
checking is not account authentication. There are no extra Rust-shell admission
quotas or claims of a formal upper bound on RPC allocations.

## Validation

```sh
make -C rust-shell test
```

Browser tests launch the compiled server on a temporary loopback port and use
`/usr/bin/chromium`; set `CHROMIUM=/path/to/chromium` for another installation.
They require permission to bind local sockets and launch Chromium.
The HTTPS test also requires `openssl`; it creates a short-lived local certificate
in its private test directory. It verifies the certificate with an explicit CA,
then tests HTTPS/WSS and origin rejection through a Unix-socket proxy. It does not
contact an ACME server or install a test CA in the system trust store.

Coverage includes UI add/dismiss/empty/reconnect flows, tab isolation, observer
callbacks, pipelined calls on returned capabilities, cancel/release/re-subscribe,
exceptions, foreign-origin rejection, malformed/oversized input and mobile width.
Rust tests cover framing boundaries, segmented frames and size limits.

Authentication tests use the production bridge core and HTTP handler with an
in-memory database adapter: one-use grants, account isolation, shared writes,
account switching across tabs, logout, expiration, and source-token revocation.
`tests/tests/rust-auth.js` exercises native development-account sign-in, GitHub/Google/OIDC/SAML
callback completion and credential linking, account settings, and atomic email-code
consumption against real Meteor methods and Mongo. Its OAuth credentials and SAML validation
results are synthetic; it does not exercise live provider consent or send
email. These checks also run in the packaged grain-session suite, alongside nested
Powerbox provider-session isolation. The browser suite mocks all four provider popups and
checks native pagination and account controls.

The actual Meteor notification regression (`tests/tests/notifications.js`) also
passed against the fast bundle in an isolated Sandstorm server, covering the
shared mutation functions and publication scoping. Native Sandstorm CTests pass.
The full `make test` target currently stops at an audit finding in the separate
Meteor test-app packaging step; the notification regression was run directly via
`tests/run-local.sh` because it does not need that app. The user confirmed the
deployed HTTPS handoff and shared notification behavior on yertle.sandhost.org.
Observation tests cover idle reads, burst coalescing, snapshot/read races, gaps
between requests, revocation, operation beyond former quotas, heartbeat deadlines, and cleanup.
`tests/tests/rust-shell.js` exercises the actual Meteor/Mongo adapter in an
isolated server, including legacy inserts, owned/shared grain renames, sender renames, read/dismiss,
recipient isolation, token revocation, and source-login revocation. Browser tests
also check that sender names render as text rather than HTML. Grain-menu checks
cover recipient isolation, shared/owned deduplication, trash/restore, limits, and
revocation; browser checks cover title/app filtering, ownership filtering, sorting, links,
reload persistence, account switching, and clearing the list on logout.

The C++ suite additionally checks pipelining across both connections, an observer
that calls back into C++ while C++ awaits its response, explicit counter release,
64 KiB of verified ordered stream data, a deliberately blocked reader, stream
cancellation, and zero live counters/streams after disconnect. It kills and
restarts the C++ fixture to verify old-capability failure and fresh-connection
recovery. Each test owns its child processes and socket directory; cleanup has a
deadline and removes only those artifacts.

The frontend dependency installation reported zero npm audit findings during this
change's validation. This is separate from the main Meteor dependency tree.

## Frontend organization and operation policy

`App.svelte` composes route pages and layout. `Notifications.svelte`, `Grains.svelte`,
`Apps.svelte`, and `GrainFrame.svelte` own their presentation and local form state.
`workspace.ts` owns the mounted tabs and their independent `GrainService` instances;
app callbacks address their own grain ID, never the currently selected tab.
Reload restores the browser tab's saved workspace, as described above.
`styles.css` holds semantic `--ss-*` tokens and a minimal document reset.
Shared controls live in `components/ui`; their styles are scoped to the component.
Bits UI supplies button and dialog behavior, while simple input/select controls
retain native semantics. See `frontend/src/components/ui/README.md` for the
component contract and visual direction. Navigation links support
normal browser modifiers/new tabs; client navigation updates the document title,
focuses the route content, and announces the page name.

`lib/shell.ts` composes the services into plain `ShellState`. `connection.ts` alone
owns authentication, the transport, subscriptions, and reconnect policy.
`grains.ts` owns the active capability and template lifetime; `apps.ts` owns
account-scoped creation outcomes. `navigation.ts` owns route intent, separately
from connection recovery. `protocol.ts` validates untrusted message payloads;
frame/popup owners still enforce exact origin, source window, and popup nonce.
`sharing.ts` defines sharing DTOs and validates app-requested link paths;
`SharingDialog.svelte` owns modal state and temporary bearer URLs.

Ordinary RPCs have a ten-second browser deadline and are aborted locally when
the connection changes. An ordinary operation timeout leaves the connection and
other capabilities intact; it never replays the operation. Transport or summary
subscription failure still reconnects the shell. Navigation detaches the frame immediately; remote cleanup is bounded,
and late open results are released. Connection errors are separate from
notification/grain operation errors so snapshots cannot erase an unknown-outcome
warning. A timeout does not prove a mutation failed on the server.

`npm run check` checks Svelte/TypeScript and the trusted public offer-template
script. Focused tests cover deadlines, late cleanup, account-scoped creation,
mutation-error retention, navigation, malformed structured clones, title
subscriptions, and popup blocking in addition to the browser integration suite.

## Ownership ledger and next steps

| Feature | Authority / storage | Owner | Validation / rollback |
| --- | --- | --- | --- |
| Fixture notifications | Connection-local memory; no account authority | Rust fixture service | Browser/Rust tests; stop Rust |
| C++ fixture capabilities | In-memory counters/streams; optional local socket | Separate C++ fixture; Rust owns connections | Three-language integration tests; unset fixture socket |
| Real notifications | Existing Meteor authentication and Mongo | Meteor bridge; Rust projection | Bridge/browser auth tests; disable secondary listener |
| Accounts, packages, sharing, Powerbox | Existing authority and storage | Existing shell/backend | Unchanged; baseline suite not rerun |
| HTTPS and certificate renewal | Existing TLS key subscription | Existing gateway and shell; secondary listener shares keys | HTTPS/WSS proxy test; deployment validation still required |
| Rust process lifecycle | Optional config, packaged executable and private Unix socket | Existing Sandstorm monitor | Config tests; remove secondary-port config to disable |
| Grain menu | Account-owned grains and recipient token metadata | Meteor projection; Rust/Svelte display | Mongo/browser tests; disable secondary listener |
| Grain UI sessions | Meteor account and permission checks; existing session records | Meteor creates/revokes; Rust owns lease lifetime; gateway serves frames | Real test-app and Rust/browser lifecycle tests |
| Grain execution | Existing backend/supervisors | Existing services | No new launcher or shutdown path |

Next useful slices:

1. Add notification app icons and localized copy.
2. Validate main-shell visual/behavioral parity before migrating production UI.
   Installed restart/update recovery now has the dedicated gate described above.
3. Extend embedded-app compatibility (Powerbox and other postMessage APIs), with
   existing services retaining authority and lifecycle ownership.

This preview establishes the executable stack and bounded three-language
interoperability evidence. It does not establish generic membrane behavior,
production Backend compatibility or production feature parity.

### Native app installation and updates

Choose **Apps → Install** to browse the configured app market, review updates
from the server's app index, or upload an `.spk`. Market links use the Rust origin
as their return host; `/install/:packageId?url=...` survives reload and sign-in.
Download is explicit, and installing the verified package requires confirmation.
Installing updates the account's app actions; **Upgrade existing grains** is a
separate action that restarts only that account's eligible grains. Newer grain
versions are never downgraded, and the native UI rejects downgrading installed
app actions.

The scoped `Installation` operations revalidate the linked account and serialize
mutations per account. They reuse the canonical download, verification, upload
credential, action installation and grain upgrade paths. Upload bytes stream to
the main shell's existing `/upload/:token` endpoint with no login cookies. The
shell CSP permits that configured upload path only, in addition to same-origin
connections. The upload credential is kept in memory and never saved in a route
or browser storage. Leaving the page or losing the connection aborts the upload;
mutations are never automatically replayed. The installation page owns an `Installation` capability and status subscription.
Rust currently polls the internal Meteor adapter every 1.5 seconds, delivering only
changed typed results to the browser. Closing the subscription stops observation,
not the durable package download. Reconnecting creates a fresh subscription.

Update discovery reflects the server's existing app index, which may be disabled
or out of date; the Rust shell does not independently refresh the external index.
Update discovery covers all installed actions and their app-index entries. The main
shell still owns package verification and account eligibility policy.

The app gallery's **Most used** section ranks up to six installed apps by their
number of owned and shared grains, with alphabetical ties. Multiple shared links
to the same grain count once; self-shares, trashed grains and suspended grains do
not add to the count. **All apps** has its own search field and starts with the
**Install / from App Market** tile, including when no apps are installed.

### Resource references and incremental lists

Installed action handles bind an account and action selector; `create(title)`
revalidates the installed action and permissions for each call. Obtaining a handle
has no side effects. Creation remains a durable operation with a typed result and
is never automatically replayed.

`ViewReference` is separate from `GrainSession`: obtaining a reference opens no
iframe, and every `open()` creates an independent session lease. Closing one
session does not invalidate the reference or other sessions. The current factory
resolves root grain views. Future sources can return the same interface for
non-root views without requiring a grain ID in the open operation; non-root
backend support and multiple tabs for one grain are not implemented here.
Metadata lists contain no capabilities or session credentials. Public shared-link
viewing retains its separate bootstrap and identity-choice boundary.

Grain and notification observers, including the shell summary, deliver changed
rows with removed keys and complete ordered page membership. Each subscription
starts with a reset at revision 1 and increments its own revision after each
acknowledged callback. Page boundaries, totals and query filters retain their
existing semantics. Reordering does not retransmit unchanged row data. The client
validates updates before committing its cache and starts a new cache on reconnect
or query changes. Typed query failures, explicit cancellation, and terminal
subscription failure reporting remain in place. The internal Meteor bridge still
projects full pages; this change reduces browser RPC traffic, not bridge traffic.
Streaming HTTP package and image uploads are unchanged.

Validation for this revision: the full Rust-shell suite passed 18 Rust and 73
frontend/browser tests; the subsequent focused run passed all 32 tests including
additional action-handle cleanup and reusable-view/cross-account regressions.
Svelte/TypeScript checks passed, `make fast` succeeded, and the isolated packaged
server passed 100 grain/session assertions and 18 authentication/query assertions.
Deploy the updated bundle and reload the frontend together; there is no wire
compatibility layer for the removed root creation/opening methods or full-list
observer payloads.

### Grain first-response readiness

`GrainSession.whenReady()` and `SharedSession.whenReady()` resolve when the
existing gateway loading indicator sets the leased Mongo session's `hasLoaded`
flag. The blocking overlay then disappears, allowing the app to render while
its remaining assets and JavaScript finish loading. The iframe `load` event
remains a fallback for browser/gateway error documents; the existing slow-load
message and manual “Show app” control remain available.

The private bridge observes only the session named by an authorized lease.
It revalidates account or shared-link authority before and after each observation,
renews a bounded long poll when necessary, and stops the Mongo observer on
completion, disconnect, or lease close. Pending readiness RPCs do not retain the
lease. Frontend generation checks prevent a late response from updating a closed
or replacement tab. No readiness signal is accepted from app postMessages.

Validated with 19 Rust tests and 78 frontend/browser tests, including signed-in
and anonymous frames whose scripts are deliberately stalled after the first
response. The fast bundle passed 100 grain-session assertions and 20 packaged
authentication/query/readiness assertions, including real Mongo observation,
initial-ready state, cancellation, and session removal.
