# Experimental Rust shell

A separate Rust/Axum process serving a static Svelte 5 / TypeScript frontend.
This is an initial spike for `~/docs/sandstorm/new-architecture.md`, using a
real notifications and a read-only grain menu through a narrowly scoped Meteor
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

Upgrading from an older memory-only bridge requires one final handoff; existing
in-memory links cannot be recovered after that old process exits. Rolling back
to a memory-only bridge also requires a fresh handoff. Ordinary reloads retain
the cookie. The HTTPS regression recreates the bridge over a shared store while
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
Links open the main shell. Shared-grain titles use the recipient's token metadata
and the same upstream-title/personal-rename helper as the main UI; revoked tokens
are excluded. Sender names are fetched only for accounts referenced by the
recipient's own notifications. Title changes, token changes, and referenced sender
renames wake the projection. Anonymous activity has an explicit label. Ongoing
notifications preserve the app-provided message and explain cancellation separately.
Avatars, app icons, and localized notification copy remain to be ported.
There is no test-notification button in this mode. Standalone runs without
`RUST_SHELL_BRIDGE_SOCKET` retain the isolated fixture UI.

The private bridge uses bounded JSON HTTP over a Unix socket. It exposes only
session exchange/validation and account-scoped notification operations; it never
accepts browser-provided account IDs or Mongo selectors. Browser RPC remains
Cap'n Proto. Authentication failures close active RPC connections and clear old
UI state on reconnect. While idle, authority is checked every second without
rebuilding notification projections; account changes also wake the request.

The internal `watch` operation is a bounded long-poll, with one request in flight
per Rust connection and at most 32 active watches in Meteor. Observers are attached
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

Shared entries use only recipient token metadata. Menu presence does not grant
access or resolve every upstream sharing-chain requirement: the main shell checks
those when opening the link. No privileged backend capabilities cross the API.
Mongo observation covers title, usage, trash, ownership, suspension, and token
changes. Account switching, disconnect, and logout clear both projections.

### Embedded grain UI sessions

**Open here** opens one grain per browser connection, using the signed-in account's
Sandstorm identity. Meteor checks `mayOpenGrainAsync` and uses the existing
`createSession` path with the configured Rust HTTPS origin as `parentOrigin`.
The normal gateway supplies the app iframe, performs full permissions checks,
and retains its existing revocation observer. Rust never receives `Backend`.
The initialization URL goes only into the iframe and is not persisted in shell
history or storage. The shell CSP permits HTTPS frames; only Meteor's authorized
session response supplies the frame URL.

`openGrain()` returns a `GrainSession` capability. Explicit close, capability
release, navigation away, and WebSocket disconnect close the UI session. Rust
renews its lease every 10 seconds; Meteor expires abandoned leases after 45
seconds, checked every five seconds. Admission is limited to 32 leases globally
and eight per linked login. Closing, logout, or cancellation while opening also
cleans up a session that finishes creation late. Old session handles cannot close
a replacement session. Closing removes the UI session record, never the grain.

A Rust crash clears the old iframe; reconnect does not replay the open operation.
The user can explicitly reopen with the same linked Meteor login. Meteor restart
preserves valid linked logins and removes marked experimental UI sessions. Their
expiry is also recorded in Mongo. If Mongo is unavailable during cleanup, the
existing idle-session cleanup remains the fallback. Rolling back to a bundle
without this bridge leaves its existing three-minute idle-session cleanup in
charge; it does not stop the grain.

Iframe messages require both the exact session origin and the active frame's
source window. The first slice supports display-only `setTitle`, local `setPath`,
and a one-shot `getGrainTitle` reply. Sharing requests show a main-shell link;
`renderTemplate` requests receive an explicit unsupported error and
a link to continue in the main shell. Powerbox requests use the handoff below.
This is not full postMessage API parity,
an incognito/sharing-link flow, or session restoration across shell reconnects.

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
The new Powerbox handoff still needs a deployed-origin check.

### Powerbox chooser handoff

An embedded app's `powerboxRequest` shows **Choose in Sandstorm** and **Cancel
request**. The button opens the existing Meteor Powerbox chooser in a separate
window; the requesting iframe stays alive in the Rust shell. This reuses the
existing providers, permission choices, provider-grain sessions, and capability
issuance rather than introducing a second Powerbox authority.

The opener and chooser check both message origin and source window. A random
request nonce correlates the reply. Request data, session IDs, and returned tokens
travel in messages, never in popup URLs. Meteor derives the requesting grain from
an owned, marked Rust UI session, checks its lease and current grain access, and
requires the same signed-in account. The chooser revalidates while open and before
returning a capability. Only one request is accepted per frame at a time; requests
expire after five minutes. Canceling, closing either view, changing accounts, or
losing the grain session ends the handoff and disposes provider UI sessions.

This is a migration bridge, not a native Svelte Powerbox chooser. A user click is
required to open the chooser window. `renderTemplate`, sharing controls, and
incognito flows still need the main shell. Browser tests cover a successful reply,
duplicate requests, forged replies, explicit cancellation, and window closure.
The real-grain integration test checks account/expiry/revocation scoping and drives
the Meteor chooser through an embedded provider to return a capability to an app.

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
- Updates are ordered, revisioned **full replacement snapshots**. A slow callback
  gets the latest state after acknowledgment; intermediate revisions can coalesce.
  This is not a delta stream or durable event log.
- The typed frontend service owns transport, handles, retries and state decoding.
  Components receive plain values. Disconnect clears old state; reconnect uses
  exponential backoff and a fresh authorized snapshot (or fixture). Mutations are never automatically replayed.
- Explicit cancel, capability release and disconnect end subscriptions.
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
**`@mnutt/capnp-es@0.4.0`**, installed through the npm alias
`"capnp-es": "npm:@mnutt/capnp-es@0.4.0"`. The alias matches the import emitted by
that compiler. Compiler and runtime therefore come from the same fork/version;
the public unscoped package and local personal checkouts are not dependencies.
The lockfile records the scoped tarball URL and integrity. Generated bindings
are built from `schema/shell.capnp` and `schema/fixture.capnp`, not checked in.
The fixture schema is compiled by Rust, TypeScript, and C++ toolchains.

Rust dependencies use `Cargo.lock`; Cap'n Proto is pinned to the 0.25 family.
The full baseline Meteor suite has **not** been run, so this is not completion
of the proposal's Phase 0 or Phase 1 exit gate.

## Executor and transport

A current-thread Tokio runtime runs a `LocalSet`. Axum transfers upgraded sockets
through a bounded channel into local RPC tasks. Non-`Send` capability state never
crosses onto a worker thread. A bounded 64 KiB duplex stream adapts WebSocket
messages to `capnp-rpc`'s two-party byte-stream transport.

Wire format: one **unpacked** Cap'n Proto message, including its segment table,
per binary WebSocket message. Multiple Cap'n Proto segments are supported.
Malformed/truncated frames, trailing bytes, text messages, and oversized messages
close the connection. Reader traversal/nesting budgets are explicit. Current
limits are 256 KiB/message, 16 connections, one subscription/connection, and 50
fixture notifications. Browser queues are bounded. Observer delivery has one
call in flight and a ten-second deadline; timeout/error drops the observer task.
Connections expire after an hour and reconnect with revalidated authority.

These limits bound the fixture and adapter, not all possible internal RPC
allocations under hostile pipelining. Aggregate admission, call budgets, heartbeat,
subscription-failure signaling, and load testing remain necessary before exposure
outside a local experiment. Origin checking is not account authentication.

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
The actual Meteor notification regression (`tests/tests/notifications.js`) also
passed against the fast bundle in an isolated Sandstorm server, covering the
shared mutation functions and publication scoping. Native Sandstorm CTests pass.
The full `make test` target currently stops at an audit finding in the separate
Meteor test-app packaging step; the notification regression was run directly via
`tests/run-local.sh` because it does not need that app. The user confirmed the
deployed HTTPS handoff and shared notification behavior on yertle.sandhost.org.
Observation tests cover idle reads, burst coalescing, snapshot/read races, gaps
between requests, revocation, admission limits, heartbeat deadlines, and cleanup.
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

Known dependency audit finding: npm currently reports a high-severity picomatch
ReDoS advisory through the **development** file-discovery tools (Vite and
svelte-check). No Vite development server is run or exposed; Axum serves static
output. Recheck upstream fixes before expanding this spike's use.

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

1. Finish notification presentation parity: avatars, app icons, and localized copy.
2. Validate full installed-server update recovery and main-shell visual/behavioral
   parity before migrating production UI.
3. Extend embedded-app compatibility (Powerbox and other postMessage APIs), with
   existing services retaining authority and lifecycle ownership.

This preview establishes the executable stack and bounded three-language
interoperability evidence. It does not establish generic membrane behavior,
production Backend compatibility or production feature parity.
