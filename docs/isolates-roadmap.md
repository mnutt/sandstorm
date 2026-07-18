# Isolates: Roadmap to the Target Architecture

**Status:** Phases 1–4 and the Phase 6 stabilization work are complete. Phase 5
is deliberately deferred after measurement and is not a release prerequisite.
Complements `docs/isolates-architecture-review.md`, which describes the current
state on branch `isolates-v2`; this document records the target, implementation
history, and compatibility boundary.

Dated progress entries retain prototype API names as superseded history; see
`docs/developing/isolate-grains.md` for the current application API.

## Target state

Agreed direction, in one paragraph: every caller of a grain's native
capabilities — the grain's own worker, another isolate grain, a legacy grain,
the browser — is a Cap'n Proto two-party peer. Each isolate has **one logical
capnp RPC authority channel** to its trusted layer. The workerd embedding
provides a native binary message channel whose bootstrap is supplied by the
trusted account host. A private worker request may establish the workerd
execution context that owns the native channel, but it is not an RPC transport
and carries no capability authority. The bootstrap exposes the
standard Sandstorm API and same-session `SessionContext`. All authority
operations (claim, save, restore, drop, offer, fulfill, powerbox) are methods
on capabilities carried by that channel; there is no capability registry
addressed by string IDs, no lifecycle envelope, no per-export callback RPC
sessions, and no local-dispatch lease mechanism. Per-grain workerd sidecars
are replaced by account-scoped shared workerd processes. HTTP-shaped fetch,
streaming, and WebSocket operations are application-layer capability calls on
that binary process connection; no raw HTTP socket or second worker transport
is introduced. Browser peers still use WebSocket at the browser boundary.

Invariants that hold at every phase:

1. The grain-boundary protocol (`Supervisor`, `UiView`, `WebSession`,
   `SturdyRef`, membranes) is unchanged. Isolates remain a runtime backend.
2. Authority is possession of a reference (RPC cap table entry) or a durable
   token string. Never a looked-up local ID, except scoped session IDs used
   only to join a request to its same-grain `SessionContext`.
3. Live handles are ephemeral (die with the connection / request context /
   isolate eviction); tokens and app object IDs are durable.
4. Transport choice is made by trusted runtime code and is invisible to app
   code. Worker authority and ingress use the native Cap'n Proto connection;
   WebSocket is used only where the browser boundary requires it.
5. Revocation is enforceable from outside both endpoints' JS heaps.

---

## Phase 1 — Consolidate all authority onto the capnp RPC channel

Everything else builds on this; do it before any fast-path or density work so
we don't optimize transports that are about to be deleted. Backward
compatibility with current prototype apps is explicitly a non-goal.

**Build:**

- Define the minimal bootstrap for the worker's RPC authority channel:
  `getSandstormApi() -> Grain.SandstormApi` and
  `getSessionContext(sessionId) -> Grain.SessionContext`. Do not add
  `restoreForInterface()` or `exportNative()` authority methods.
- Make a native binary Cap'n Proto channel the single worker authority channel.
  When workerd requires a request-scoped `IoContext`, keep that request alive
  for the lifetime of capabilities exported over its native channel.
- Exports become ordinary capability passing. Durable app-provided exports use
  classic `AppPersistent.save()` plus `MainView.restore/drop()` and
  `SupervisorObjectId.appRef`; route-backed supervisor capabilities use
  explicit supervisor object variants.
- Rebuild `Capability` in `sandstorm:api` on top of RPC imports: `drop()` is
  RPC release; `save()` is `SandstormApi.save()`; `fetch()` remains the sugar
  for WebSession/ApiSession/outbound-HTTP-shaped caps, implemented over the
  channel. Merge `sandstorm:api` and `sandstorm:capnp` into one module while
  we're at it — the split reflects the transport split we're removing.

**Progress, 2026-07-17:** `isolate-bridge.capnp` defines the worker bootstrap
(`getSandstormApi()` and `getSessionContext()`), and the native host injects a
binary Cap'n Proto channel directly into each worker. Worker authority RPC no
longer uses HTTP or WebSocket; WebSocket remains only at the browser boundary.

**Progress, 2026-07-18:** supervisor-initiated `MainView.restore/drop()` now
acquires the worker's `MainView` capability over the native bridge. The private
registration request only creates and retains the worker execution context;
all capability passing and calls use binary Cap'n Proto. The former MainView
Cap'n Proto-over-WebSocket transport and worker server session are deleted.

**Progress, 2026-07-08:** `sandstorm:capnp` also exposes
`restoreNativeCapnpViaBootstrap()`, an explicit migration helper that restores
durable native capability tokens by calling `SandstormApi.restore()` over the
isolate bridge bootstrap and wraps the returned RPC import with the generated
capnp-es client. The isolate integration suite now runs native Greeter
conformance through this path, verifies pipelining/returned capabilities, and
checks that the restored live handle can be saved again.

**Progress, 2026-07-08:** `restoreNativeCapnp()` now defaults to the isolate
bridge bootstrap restore path, so normal durable native capability restores
return RPC imports carried by the native RPC channel.

**Progress, 2026-07-08:** `connectNativeCapnp()` no longer consumes
`NativeCapnpLocalDispatch` metadata or exposes a `localDirect` transport. Even
same-supervisor native capability slots now use the same capnp RPC framing as
cross-supervisor slots.

**Progress, 2026-07-08:** The local-dispatch lease is deleted from the
lifecycle bridge schema and supervisor implementation. The
`NativeCapnpLocalDispatch` struct, generated JS/DTS accessors,
`issueNativeCapnpLocalDispatchAuthorization()`, and per-capability lease-token
cache are gone; lifecycle restore fixtures now assert that restored capability
slots are plain slots with no hidden local-dispatch property.

**Progress, 2026-07-08:** `SandstormApi.save()` on the isolate bridge now
tries the classic `AppPersistent.save()` path first and mints normal
`SupervisorObjectId.appRef` tokens through `SandstormCore.makeToken()`. It
falls back to `SystemPersistent.save()` only for the existing supervisor-owned
route-backed/native capabilities while their persistence formats are migrated
to `MainView.restore/drop()` or explicit supervisor object variants.

**Progress, 2026-07-08:** Non-route `SupervisorObjectId.appRef` restores and
drops now call the worker's `MainView.restore/drop()` over the native Cap'n
Proto bridge, so isolate-defined `AppPersistent` capabilities can be
saved, restored, called, re-saved, and dropped through the classic app object
model. The integration fixture now covers a schema-defined `NativeGreeter`
object ID through that path; route-backed WebSession/ApiSession app refs still
use their existing supervisor-owned compatibility path.

**Progress, 2026-07-08:** The native Cap'n Proto lifecycle envelope is
deleted. `POST /capnp/lifecycle`, the browser-forwarded
`/__sandstorm/native-capnp/lifecycle` route, the
`NativeCapnpBridgeRequest/Response/Drop/Save/Restore/Saved` schema, and the
generated `sandstorm:native-capnp-bridge` helper module are gone.
`connectNativeCapnp()` now works with live RPC imports from the native
channel and delegates save/drop to capability methods when present. The
integration suite asserts that lifecycle is no longer advertised, old
lifecycle calls are rejected, and the removed browser schema module is absent.

**Progress, 2026-07-08:** `exportNativeCapnp()` no longer registers a
supervisor export ID or opens a per-export callback session. It now returns a
local capnp-es server client; `.save()` passes that client over the isolate
bridge to `SandstormApi.save()`, which persists app-defined exports through
the classic `AppPersistent.save()` / `MainView.restore/drop()` app-ref model.
The `/capabilities/native-capnp-export` route,
`SupervisorObjectId.nativeCapnpExport`, and JS export-session routes are gone.
Integration tests cover direct local calls, save/restore through app refs,
re-save, bootstrap restore, explicit drop, and C++ interop for the saved
export.

**Progress, 2026-07-08:** Per-grain isolate sidecars now follow the classic
supervisor warm-reuse lifecycle while that backend still exists. Startup first
probes an existing supervisor socket and sends `keepAlive()` instead of
launching another workerd; `keepAlive()` resets the idle timer and refreshes
the core redirector from backend connections. This removes the accidental
full workerd cold start on repeated WebSession requests before Phase 4
replaces per-grain sidecars entirely.

**Progress, 2026-07-08:** Sandstorm platform capnp-es modules are now part of
the embedded isolate support bundle. `spk dev-isolate` and `spk pack` seed
`capnp:/sandstorm/...` imports from build-generated sources instead of
running `capnpc` and the capnp-es compiler for every dev package. Simple
isolate apps that only import `sandstorm:api` no longer need the capnp-es
compiler on the dev-startup path.

**Progress, 2026-07-11:** The application-facing `sandstorm:capnp` module is
merged into `sandstorm:api`. Cap'n Proto export, client-view, struct, and byte
stream helpers are re-exported by `sandstorm:api`; dev and packaged manifests
no longer inject a second public helper module. Examples, TypeScript contracts,
and integration fixtures use the unified import while transport internals
remain isolated in `sandstorm-internal:capnp-runtime`.

**Delete** (all anchors per the architecture review):

- Done: the lifecycle envelope: `POST /capnp/lifecycle` and the
  `NativeCapnpBridgeRequest/Response/Drop/Save/Restore/Saved` structs.
- Done: the native export registration and persistence family:
  `/capabilities/native-capnp-export`,
  `SupervisorObjectId.nativeCapnpExport`, and the JS
  `/__sandstorm/native-capnp/export-sessions/...` callback routes.
- Done: `/powerbox/dup`; apps can keep ordinary JS references to the same live
  handle instead of asking the supervisor to mint another string ID.
- Done: drop groups and live-handle drop-notify machinery. Dropping a live
  claimed capability now releases the worker's owned RPC reference/bridge;
  remote release semantics come from the RPC release protocol.
- Done: `/powerbox/drop-saved`; `sandstorm(...).revoke(token)` now calls
  `SandstormApi.drop()` over the IsolateBridge bootstrap RPC connection.
- Done: `/powerbox/save` and `/powerbox/restore`; helper handles now carry
  live RPC references and call `SandstormApi.save()` / `SandstormApi.restore()`
  through the private IsolateBridge RPC connection.
- Done: `/powerbox/claim-request`; `powerbox(request, env).claim(...)` now gets
  the session context through IsolateBridge and calls
  `SessionContext.claimRequest()` over Cap'n Proto RPC.
- Done: `/powerbox/offer`, `/powerbox/fulfill-request`, and
  `/powerbox/tie-to-user`; capability session actions now resolve the live
  capability and call the corresponding `SessionContext` method over the
  IsolateBridge RPC connection.
- Done: `sandstorm:api` Powerbox session actions now accept generated native
  capnp clients returned by `exportNativeCapnp()` in addition to generic
  `Capability` handles. App code can fulfill a request with
  `api.powerbox().fulfillRequest(exportedClient, ...)`; the helper opens only
  the trusted `SessionContext` bridge and passes the existing capnp reference.
- Done: raw isolate-native session action capabilities are wrapped by the
  supervisor as Sandstorm-internal `SystemPersistent` capabilities before they
  are handed to legacy `SessionContext.offer()` / `fulfillRequest()`. The
  wrapper translates legacy saves into the app's `AppPersistent.save()` plus
  `SandstormCore.makeToken()` while blocking direct external calls to
  `AppPersistent.save()`.
- Done: `/powerbox/drop`; `Capability.drop()` now releases the worker's live
  RPC handle and its retained IsolateBridge connection. Worker-side id-backed
  helper handles are gone; browser handoff ids are explicit browser slots.
- Done: `/powerbox/fetch` and `/powerbox/outbound-http-fetch`; `cap.fetch()`
  now calls `WebSession` / `OutboundHttpSession` methods directly on the live
  RPC capability.
- Done: `/capabilities/web-session` and `/capabilities/api-session`;
  route-backed capability creation now happens through the private
  IsolateBridge RPC connection instead of local HTTP POST routes.
- Done: worker-side `connectNativeCapnp()` now accepts live capability refs and
  uses capnp-es directly; the worker fallback target-specific WebSocket opener
  is gone.
- Done: browser-side `connectBrowserNativeCapnp()` now uses a browser-scoped
  `BrowserIsolateBridge` bootstrap and capnp-es pipelining to call
  capabilities explicitly handed to the browser session. The target-specific
  `/capnp/rpc-session?id=...` authority path is gone.
- Done: `/capabilities/claimed` and `/capabilities/claimed-stats`; helper
  handles now carry user-facing metadata locally instead of exposing the
  temporary claimed-capability registry through read-only HTTP lookups.
- Done: `IsolateSessionRegistry`'s worker string-ID claimed-capability table.
  Worker capabilities now hold live RPC refs; the registry only keeps scoped
  browser handoff slots and session-scoped offer state.
- Done: the worker `MainView` capability is registered directly over the native
  bridge. Its former private Cap'n Proto-over-WebSocket client/server stack is
  deleted rather than renamed or retained as a fallback.
**Keep as an HTTP-shaped capability API:** inbound WebSession fetch,
`STORAGE`, and non-authority metadata operations. These are transported by
`HttpService` capabilities over the same binary Cap'n Proto connection, not by
a Unix HTTP socket. The worker authority bootstrap uses the native message
channel directly.

**Exit criteria:** all examples and integration tests pass with the POST
routes and envelope deleted (not deprecated — deleted); grep shows no
authority operation outside the RPC channel; §13 of the architecture review
rewritten with the confused-deputy and lease-replay items removed as
structurally impossible.

---

## Phase 2 — Browser as an ordinary capnp peer

Mostly alignment work: the browser-native-capnp client (§11.6) already runs
Powerbox via `postMessage` and connects a capnp-es client over a restricted
bridge. Rebase it onto the Phase 1 channel:

- Browser connects a WebSocket capnp session (authenticated by session
  cookie/token through the shell as today) whose bootstrap is a *browser-scoped*
  subset: claim Powerbox tokens for the current session and use capabilities
  explicitly handed to that session. No blanket durable-token restore and no
  export registration.
- Done: the browser WebSocket capnp session now uses `bootstrap=browser` and a
  `BrowserIsolateBridge` subset to resolve only previously handed capability
  IDs; it no longer opens a target-specific RPC session by URL.
- Done: browser-native Powerbox token claim now uses
  `BrowserIsolateBridge.claimPowerboxRequest()` over the same capnp WebSocket.
  The worker browser system route forwards only the supervisor-injected
  session ID header to bind that claim to the current browser session.
- Done: local `exportNativeCapnp()` handles now keep a live capnp client for
  worker-side use and expose `browserHandoff({ request })` for explicit,
  session-scoped browser slots. No browser slot is minted until a request
  hands one to that browser session.
- Done: `examples/isolate-browser-capnp` now imports the generated browser
  schema module plus `/__sandstorm/native-capnp/client.js`, fetches one
  handoff slot, and calls `read()`, `increment()`, and `reset()` over the
  browser-scoped capnp WebSocket bridge.
- Done: real `WebSession.openWebSocket()` calls use the hosted worker's
  capability-backed HTTP client directly. Browser-native capnp RPC works
  through the normal Sandstorm WebSession boundary without a raw HTTP upgrade
  parser or a worker-side bootstrap WebSocket.
- Powerbox flow stays browser-first: shell `postMessage` picker → token →
  browser (or worker) claims over its own channel. Worker-initiated Powerbox
  UI becomes a `SessionContext` method call whenever the shell supports it —
  no new transport needed.
- Done: the bespoke restricted-bridge plumbing that Phase 1 didn't already
  subsume is gone. The old `/__sandstorm/rpc-client.js` surface is tested as
  absent, browser Powerbox claims use the browser capnp bootstrap, and the
  browser client has no fetch-to-supervisor authority calls.

**Exit criteria:** `examples/isolate-browser-capnp` and
`isolate-browser-powerbox` run on the unified channel; the browser client
module contains no fetch-to-supervisor authority calls.

---

## Phase 3 — Persistence and toolchain hardening

Do this while surface area is small and before any stability promise.

- **One serialization per persistent family.** App-provided isolate exports
  should use classic `SupervisorObjectId.appRef` via `AppPersistent.save()` and
  `MainView.restore/drop()`. Route-backed WebSession/ApiSession capabilities
  are supervisor-implemented and should use explicit supervisor object
  variants, not string-prefixed app-ref envelopes.
  - Done: `SupervisorObjectId.routeBackedSession` now stores route-backed
    WebSession/ApiSession tokens as supervisor-owned typed object IDs.
    `appRef` restores are reserved for app-defined objects, while route-backed
    restore/drop dispatch directly in the isolate supervisor. The fake
    The account-host integration fixture preserves app refs and route-backed
    refs as separate token kinds.
- **capnp-es custody.** `@mnutt/capnp-es` must stop being a personal-fork npm
  dependency: upstream, vendor into the tree, or move to a `sandstorm-org`
  namespace with pinned integrity hashes in the build. The runtime is
  supervisor-injected trusted-adjacent code; treat it like one.
  - Deferred: keep the exact pinned `@mnutt/capnp-es@0.3.0` npm package and
    lockfile integrity for now. The real fix is to move the package under
    Sandstorm organizational custody when that is available.
- **ABI discipline.** Extend `spk capnp-abi` checks to any new platform
  bootstrap schemas, not just app schemas.
  - Done: `spk capnp-abi` now records immediate interface superclasses and
    handles explicitly numbered interfaces, so platform schemas with
    `interface Foo @... extends(...)` are checked accurately. The tracked
    isolate platform ABI snapshots cover `isolate-bridge.capnp`,
    `isolate-supervisor-internal.capnp`, and `outbound-http-session.capnp`,
    and `make isolate-capnp-toolchain-test` includes
    `make isolate-capnp-abi-check`.
- **Dev tooling:** `spk dev-isolate --app-interface` must work from ordinary
  app directories and fail cleanly on invalid paths.
  - Done: app-interface metadata parsing now uses the same Sandstorm schema
    include discovery as generated capnp modules, so tutorial-style schemas
    importing `/sandstorm/grain.capnp` work outside the Sandstorm repo. Failed
    `realpath()` lookups now report validation errors instead of formatting a
    null pointer, and the toolchain suite covers both paths.
- **App-author streaming ergonomics:** schema-defined upload/download
  capabilities should not require hand-written `Util.ByteStream` method loops
  for ordinary Web Stream sources and sinks.
  - Done: `sandstorm:api` now exposes `writableFromByteStream()`,
    `byteStreamFromWritable()`, and `pipeReadableToByteStream()`. The isolate
    integration fixture covers all three helpers, and the external
    object-store/upload tutorial uses them for provider-side `WritableStream`
    implementation and worker-side file uploads.
- Fuzz the supervisor-side `MessageStream` framing parsers and add
  differential capnp-es/KJ corpus and RPC conformance tests.
  - Progress: the browser integration fixture opens browser-scoped native
    Cap'n Proto WebSocket RPC sessions and covers upgrade and disconnect
    cleanup. The remaining supervisor WebSocket `MessageStream` uses the parser
    exercised by a native KJ test. That test round-trips a valid RPC bootstrap
    frame, checks explicit malformed segment tables, and deterministically
    feeds 4,096 generated malformed frames through the production parser with
    bounded traversal and nesting limits.
  - Done: `make isolate-capnp-corpus-test` replays deterministic capnp-es/KJ
    encode/decode corpus cases for common struct field shapes, and
    `make isolate-capnp-toolchain-test` runs it with the generated-type checks.
    The account-host integration fixture is the RPC conformance path for
    pipelining, returned capabilities, capability arguments, save/restore, browser calls,
    and legacy C++ interop. `make isolate-capnp-fuzz` is the opt-in generated
    corpus target for local or scheduled runs outside normal PR CI.

**Exit criteria:** one persistence format per family with a migration note;
build reproducible without reaching into a personal npm namespace once
Sandstorm-owned capnp-es custody is available; deterministic malformed-frame,
capnp-es/KJ corpus, and RPC conformance tests in CI; opt-in generated-case
fuzz target available outside normal CI.

---

## Phase 4 — Shared workerd (density)

Replace per-grain sidecars with a small number of multi-tenant workerd
processes. This is the phase that actually delivers isolate economics
(per-grain cost drops from two processes to one isolate). It also supplied the
colocation needed to evaluate the now-deferred Phase 5 optimization.

- **Isolate host service.** A long-lived `isolate-host` process (per trust
  domain — see below) runs one workerd hosting N grain workers. The backend
  stops spawning a supervisor per isolate grain; instead it asks the host to
  instantiate the grain and connects the grain's socket to a per-grain
  `Supervisor` object served by the host. The `Supervisor` bootstrap contract
  per grain is unchanged (invariant 1); what changes is that one process
  implements many of them.
- **Blast-radius policy.** Grains in one workerd are separated by V8 isolation
  only. Group workerds by trust domain — per-user is the natural starting
  policy — so a V8 escape is contained to one user's grains, preserving a
  meaningful version of Sandstorm's isolation story. The released topology is
  account-scoped; there is no parallel per-grain workerd mode.
- **Storage mediation.** Per-grain storage stays per-grain on disk; the
  `STORAGE` binding in the shared host must be bound per-worker to the right
  grain directory, enforced in the host's C++ layer, never by worker identity
  strings.
- **Lifecycle.** Grain start/shutdown/keepAlive map to worker
  instantiation/eviction in the host; `syncStorage`/`reportGrainSize` per
  grain as today. Isolate eviction severs that grain's RPC connections, which
  by invariant 3 is already well-defined (live handles die, tokens survive).
- **Non-blocking admission.** Bundle lookup, packed-message decoding, and
  module loading must not perform unbounded synchronous filesystem work on the
  shared host event loop. Admission runs asynchronously or on bounded worker
  threads, with cancellation and per-stage size/time limits, so starting one
  grain cannot stall unrelated grains in the same trust domain.
- **Resource bounds.** Every admitted worker has explicit memory, CPU/watchdog,
  bundle/module-size, and concurrent-admission limits. The host defines
  overload behavior and preserves enough headroom to evict or report a faulty
  grain rather than letting one grain deny service to its neighbors.
- **Bundle compatibility.** `worker-source.capnp.bin` is a persisted handoff
  format, not an incidental cache file. Give it an explicit format version and
  compatibility policy, retain ABI fixtures, and reject unsupported versions
  before interpreting modules or bindings.

Progress:

- The embedded-host implementation is pinned to the official workerd source
  release in `deps/workerd` at commit `ea5e86d2`. `isolate-host` is the only
  workerd runtime executable shipped in the bundle; the former standalone npm
  `workerd` binary and package lock are gone. `make verify-workerd-source`
  prevents the native host and downstream patch from silently drifting.
- `make isolate-host` now builds a Sandstorm-owned native executable against
  workerd's in-process `Server` library. The build uses a checksum-pinned Bazel
  binary and a patched copy under `tmp`, leaving the upstream source submodule
  pristine; the resulting `bin/isolate-host` has no Bazel runtime dependency.
- The host has a minimal, ABI-tracked Cap'n Proto control contract: an
  account-scoped host accepts a server-validated grain ID, a bounded packed
  worker-source bundle, and per-grain binding capabilities, then returns a
  `HostedIsolate` lifecycle capability with `keepAlive()` and `stop()`.
- `bin/isolate-host` now serves that lifecycle contract over a Unix socket and
  keeps account-local grain state in one long-lived process. A client built by
  Sandstorm's existing toolchain verifies cross-toolchain wire compatibility,
  start/keepAlive/stop behavior, stopped-handle rejection, and rejection of a
  path-traversal grain ID via `make isolate-host-control-test`.
- Worker code and configuration cross the existing host control connection as
  bounded Cap'n Proto data. The native host never receives package, grain,
  runtime, or socket paths, so worker admission cannot redirect loading through
  a grain-directory symlink or a caller-selected filesystem location.
- The embedded workerd patch now exposes a deliberately small native loader
  seam: load a named worker from an already-configured loader namespace, or
  explicitly unlink and evict that worker. This reuses workerd's existing
  isolate cache and startup machinery while giving Sandstorm lifecycle RPC a
  real per-grain eviction operation; no general workerd configuration API is
  made public.
- Treat the downstream workerd patch as a staging area for upstream embedding
  APIs, not as Sandstorm's policy layer. Propose the loader/eviction seam and
  non-serializable native `Frankenvalue` capability seam upstream, prioritizing
  review or simplification of the `compileBindings` channel materializer. Keep
  limits, watchdogs, logging, and eviction policy in Sandstorm-owned code or
  general upstream APIs. Reassess the embedding boundary if those features
  require continued semantic edits to workerd internals or patch growth stops
  being small relative to the runtime being reused.
- `isolate-host` now initializes one in-process V8/workerd `Server` with a
  private named-worker loader namespace and keeps it alive alongside the
  Cap'n Proto control listener. The bootstrap service is reachable only on an
  ephemeral loopback listener; Sandstorm requests do not traverse it. Host
  `stop()` calls workerd's explicit eviction path, and production grain
  requests enter through a per-grain `HostedIsolate` HTTP capability.
- The supervisor now serializes a Sandstorm-owned packed Cap'n Proto
  worker-source bundle for the `startGrain()` call and persists a copy alongside
  its human-readable manifest for diagnostics. It does not generate an external
  workerd configuration or runtime ingress sockets. The shared host decodes the
  bytes received on the control capability, compiles compatibility flags,
  translates every supported module kind into a
  `DynamicWorkerSource`, materializes every supported binding kind, and enters
  workerd's named isolate cache. Real worker ingress and binding dispatch now
  run end to end without expanding the upstream patch into a general workerd
  configuration API.
- Bundle filesystem work and packed-message decoding run on bounded admission
  worker pools rather than either shared host's common event loop. Readers cap
  the bundle, module, binding, name, and collection sizes before retaining
  decoded content; both account and native-host admission have five-second
  deadlines, two workers, and a maximum of 16 outstanding starts.
- Loader source ownership follows workerd's repeatable-callback contract: the
  host retains atomic backing storage and returns a fresh
  `DynamicWorkerSource::clone()` on every callback. Eviction now only removes
  the cache entry, matching upstream restart semantics; restarting a stopped
  grain creates a new stub while capabilities to the old hosted-grain wrapper
  remain stopped.
- Worker-source translation validates non-empty and unique module/binding
  names, requires the declared main module to exist, and supports text,
  strictly parsed JSON, binary `ArrayBuffer`, service, Sandstorm API, storage,
  and powerbox bindings. The account-host integration test sends real requests
  through every supported binding and repeats them after worker eviction and
  restart.
- Sandstorm API, storage, and powerbox bindings now materialize as ordinary
  workerd `Fetcher` objects backed by host-owned in-process HTTP services; no
  filesystem socket lookup or reusable descriptor number participates in the
  request path. The storage service owns its opened storage-root descriptor
  and performs per-request file operations relative to it with `*at()` APIs.
  A narrow non-serializable `Frankenvalue` capability constructor lets the
  dynamic loader preserve each typed channel until the destination worker's V8
  context exists.
- The shared-host trust domain is explicitly per account. The trusted backend
  now carries `Backend.startGrain.ownerId` through isolate startup as a
  required trust-domain value; the host validates it instead of deriving
  grouping from app or grain metadata. Account-shared hosting is the isolate
  runtime topology for both installed and development packages.
- Account-mode integration coverage runs two live grains from the same package
  in one workerd, verifies that identical `STORAGE` keys retain distinct
  per-grain values, and repeats the supported binding and storage checks after
  stopping and restarting one grain. Runtime manifests and `/runtime` metadata
  report `accountSharedHost`.
- Sandstorm-owned limit enforcers apply a 64 MiB old-generation heap limit,
  16 MiB young-generation and buffering limits, a 250 ms per-request JS
  watchdog, a five-second startup watchdog, and 64 subrequests. Integration
  tests force CPU and heap failures and verify that neighboring workers remain
  responsive.
- Grain-tagged workerd console logs, keepalive-driven idle eviction with clean
  restart semantics, and an explicitly versioned worker-source format with ABI
  fixtures are implemented and tested.
- The published 32-worker memory benchmark measures 1.18 MiB incremental PSS
  per shared worker versus 8.11 MiB per one-worker process; total host PSS at
  32 workers is 70.0 MiB versus 277.1 MiB. See
  `docs/isolates-memory-benchmark.md`.
- The backend caches account hosts by generation and discards a dead generation
  on disconnect. A real backend/account-host/native-host integration test kills
  the account host and proves that the next grain start recovers through a new
  host generation.

**Exit criteria:** N example grains for one user run in one workerd with
correct storage isolation; a real worker request traverses each supported
binding and receives the expected response; stop/restart with capability
bindings proves clone and eviction behavior end to end; large or malformed
bundles cannot block unrelated grains and are rejected within documented
size/time bounds; explicit worker, admission, watchdog, and overload limits
are exercised in integration tests; logs identify the responsible grain;
keepalive eviction is active; the worker-source format has version/ABI
coverage; per-grain memory overhead is measured and published; the obsolete
per-grain process topology and its test harness are absent.

Account-shared mode satisfies these technical criteria and is the only isolate
runtime topology.

---

## Phase 5 — Colocated fast path (deferred)

The prerequisites exist — one authority channel (Phase 1) and colocated grains
(Phase 4) — but measurements do not justify shipping this optimization.

Status: a complete prototype established host-authorized local links,
revocation, durable restore, three-party handoff, and forced-on/forced-off
semantic parity. End-to-end measurements showed only about 1.8x improvement
for small sequential and pipelined calls and about 1.3–1.6x for 256 KiB calls,
far short of the 10x goal. Profiling showed that buffer transfer, frame
validation, and the host-side authority ledger consumed only a small fraction
of call time; promise scheduling, isolate dispatch, and application work
dominated. Moving the ledger into a deeper native router therefore would not
plausibly close the gap.

The prototype's production machinery has been removed to avoid maintaining a
second transport and a duplicate security-critical RPC state machine for a
modest gain. Cross-grain capabilities use the ordinary native binary Cap'n
Proto bridge; WebSocket remains only at the browser boundary. Revisit this
phase only if workerd or capnp-es gains a substantially
simpler upstream facility, or new workload measurements demonstrate a larger
benefit. Phase 5 is an optional optimization and does not block stabilization.

If this phase is revisited, begin with a simpler upstream transport or routing
facility instead of restoring the removed private state machine. Require a
representative workload to demonstrate at least a 10x benefit before accepting
the complexity, then re-establish forced-on/forced-off semantic parity,
host-enforced revocation outside both JS heaps, and correct three-party
hand-off before enabling it in production.

---

## Phase 6 — Stabilization

- Freeze `isolate-bridge.capnp`, the `sandstorm:api` surface, the manifest
  `IsolateConfig`, and the persistence formats; adopt a compatibility policy
  (compat dates for runtime behavior, additive-only schema evolution enforced
  by `spk capnp-abi`).
- Rewrite `docs/developing/isolate-grains.md` against the final model; retire
  the interim `docs/isolates-*.md` working notes into it.
- Remove the "not a stable contract" warnings only when Phases 1–4 and the
  Phase 6 compatibility criteria are met. Deferred Phase 5 is not part of the
  stable contract.

**Progress, 2026-07-16:** The intentional app-authoring surface is now the
stable boundary. `sandstorm()` exposes sessions, storage, Powerbox, capability
lifecycles, and system routes; operational inspection lives below
`api.unstable`, while native bridge negotiation hooks remain non-enumerable
private runtime glue. Undocumented module exports used only by route serving
were removed. Integration coverage asserts the exact enumerable facade so a
future helper cannot accidentally become public API.

`spk capnp-abi` can select a struct and its nested structs, and now ignores
ordinal-free group containers while checking their numbered fields. A checked-
in `Manifest.IsolateConfig` baseline therefore protects the manifest ABI in
addition to the existing `isolate-bridge.capnp` and internal protocol
baselines. The authoring guide documents additive schema evolution,
compatibility-date behavior, persistence migration requirements, and the
private diagnostics/transport/host boundary; the pre-release warning has been
retired. The superseded Powerbox V2 and detailed architecture-review drafts
have also been retired; the authoring guide, this roadmap, and the published
memory benchmark are the maintained isolate documentation.

Release CI now runs the composite `make isolate-ci` gate. It verifies a clean,
pinned workerd tree and zero-fuzz private patch; checks the packaged native
host, workerd runtime, schema compiler, and public schemas; then runs the ABI,
corpus, TypeScript, account-shared isolation, native-host
lifecycle, and backend-recovery suites.

---

## Sequencing rationale and risks

- **Phase 1 before everything:** every later phase gets simpler on one channel
  (Phase 4's host serves one native Cap'n Proto channel per grain;
  the Phase 5 evaluation used real RPC caps instead of registry IDs).
  Deleting ~20 authority routes also shrinks the attack surface before the
  multi-tenant host raises the stakes.
- **Phase 4 before evaluating Phase 5:** per-grain workerd had no representative
  colocated pairs. The resulting shared host made the measurement realistic;
  that measurement now supports deferral rather than a second production
  transport.
- **Biggest risk, Phase 1:** capnp-es becomes fully load-bearing for all
  authority operations (hence Phase 3 custody/fuzzing). Native-channel
  lifetime under request completion and worker eviction is covered by the
  registration lease and explicit reconnect semantics in the trusted layer.
- **Biggest risk, Phase 4:** quietly weakening the isolation story. The
  blast-radius policy must be a documented, deliberate choice, not an
  emergent property of the implementation.
- **Risk if Phase 5 is revived:** cap-table translation bugs can leak authority
  between colocated grains. Any future design must keep translation and
  revocation outside app heaps and prove parity with the native RPC path.
