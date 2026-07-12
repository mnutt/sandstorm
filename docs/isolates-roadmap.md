# Isolates: Roadmap to the Target Architecture

**Status:** Plan. Complements `docs/isolates-architecture-review.md`, which
describes the current state on branch `isolates-v2`; this document describes
where the feature needs to go and in what order.

Dated progress entries retain prototype API names as superseded history; see
`docs/developing/isolate-grains.md` for the current application API.

## Target state

Agreed direction, in one paragraph: every caller of a grain's native
capabilities — the grain's own worker, another isolate grain, a legacy grain,
the browser — is a Cap'n Proto two-party peer. Each isolate has **one logical
capnp RPC authority channel** to its trusted layer. In the initial JS
implementation, concrete live connections are request-scoped because workerd
I/O belongs to a per-request `IoContext`; the long-term native workerd binding
can own the persistent channel outside request JS. The bootstrap exposes the
standard Sandstorm API and same-session `SessionContext`. All authority
operations (claim, save, restore, drop, offer, fulfill, powerbox) are methods
on capabilities carried by that channel; there is no capability registry
addressed by string IDs, no lifecycle envelope, no per-export callback RPC
sessions, and no local-dispatch lease mechanism. Per-grain workerd sidecars
are replaced by a small number of shared workerd processes. When caller and
callee are colocated in the same workerd, a native workerd extension binds the
capability to a **transferred-ArrayBuffer transport** (zero-copy capnp messages
between isolates) instead of the WebSocket transport — same message format,
same generated code, same semantics, ~1–2 orders of magnitude faster.

Invariants that hold at every phase:

1. The grain-boundary protocol (`Supervisor`, `UiView`, `WebSession`,
   `SturdyRef`, membranes) is unchanged. Isolates remain a runtime backend.
2. Authority is possession of a reference (RPC cap table entry) or a durable
   token string. Never a looked-up local ID, except scoped session IDs used
   only to join a request to its same-grain `SessionContext`.
3. Live handles are ephemeral (die with the connection / request context /
   isolate eviction); tokens and app object IDs are durable.
4. Transport choice (WebSocket vs. local transfer) is made by trusted runtime
   code at capability-bind time and is invisible to app code.
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
- Make `GET /capnp/rpc-session` (the existing WebSocket RPC session,
  `isolate-supervisor.c++:4673`) the single authority channel, carrying this
  bootstrap. JS connections are request-scoped until a native workerd binding
  can own the persistent channel outside `IoContext`.
- Exports become ordinary capability passing. Durable app-provided exports use
  classic `AppPersistent.save()` plus `MainView.restore/drop()` and
  `SupervisorObjectId.appRef`; route-backed supervisor capabilities use
  explicit supervisor object variants.
- Rebuild `Capability` in `sandstorm:api` on top of RPC imports: `drop()` is
  RPC release; `save()` is `SandstormApi.save()`; `fetch()` remains the sugar
  for WebSession/ApiSession/outbound-HTTP-shaped caps, implemented over the
  channel. Merge `sandstorm:api` and `sandstorm:capnp` into one module while
  we're at it — the split reflects the transport split we're removing.

**Progress, 2026-07-08:** `isolate-bridge.capnp` now defines the minimal
request-scoped bootstrap (`getSandstormApi()` and `getSessionContext()`), and
`GET /capnp/rpc-session?bootstrap=worker` serves it over the existing native
Cap'n Proto WebSocket RPC session. `sandstorm:capnp` exposes
`connectIsolateBridge()` for trusted helper code, and the isolate integration
suite covers successful `SandstormApi` bootstrap plus a rejected missing
session-context lookup.

**Progress, 2026-07-08:** `sandstorm:capnp` also exposes
`restoreNativeCapnpViaBootstrap()`, an explicit migration helper that restores
durable native capability tokens by calling `SandstormApi.restore()` over the
isolate bridge bootstrap and wraps the returned RPC import with the generated
capnp-es client. The isolate integration suite now runs native Greeter
conformance through this path, verifies pipelining/returned capabilities, and
checks that the restored live handle can be saved again.

**Progress, 2026-07-08:** `restoreNativeCapnp()` now defaults to the isolate
bridge bootstrap restore path, so normal durable native capability restores
return RPC imports carried by the single WebSocket RPC channel.

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
drops now call the worker's `MainView.restore/drop()` over a native capnp
WebSocket session, so isolate-defined `AppPersistent` capabilities can be
saved, restored, called, re-saved, and dropped through the classic app object
model. The integration fixture now covers a schema-defined `NativeGreeter`
object ID through that path; route-backed WebSession/ApiSession app refs still
use their existing supervisor-owned compatibility path.

**Progress, 2026-07-08:** The native Cap'n Proto lifecycle envelope is
deleted. `POST /capnp/lifecycle`, the browser-forwarded
`/__sandstorm/native-capnp/lifecycle` route, the
`NativeCapnpBridgeRequest/Response/Drop/Save/Restore/Saved` schema, and the
generated `sandstorm:native-capnp-bridge` helper module are gone.
`connectNativeCapnp()` now works with live RPC imports from the WebSocket
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
- Done: the misleading per-export HTTP-transport names on the worker
  `MainView` RPC socket plumbing. The native-export registration endpoint and
  JS export-session paths were already gone; the remaining C++ session classes
  are now named for `MainView` RPC.
**Keep as HTTP:** inbound WebSession→sidecar fetch (workerd's native
ingress), `STORAGE` binding, and non-authority runtime/module/binding metadata
GETs.

**Test/migrate:** port the dev sidecar (§3.4 of the review) to speak the new
bootstrap so the seam stays testable without workerd; migrate
`isolate-websession-client.c++`, the JS integration tests, and the
`examples/isolate-*` apps. Static-assert the new schema IDs as the old ones
are today.

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
- Done: real `WebSession.openWebSocket()` calls now forward to the workerd
  sidecar as raw WebSocket upgrade streams, so browser-native capnp RPC works
  through the normal Sandstorm WebSession boundary rather than only through
  direct supervisor binding routes.
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
    SandstormCore used by `isolate-websession-client` preserves app refs and
    route-backed refs as separate token kinds.
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
    and `make isolate-supervisor-integration-test` runs
    `make isolate-capnp-abi-check` before the JS fixture.
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
  - Progress: the isolate integration fixture now opens native Cap'n Proto
    WebSocket RPC sessions, sends malformed binary/text frames, verifies that
    the session closes, and checks that the supervisor remains responsive.
    The two supervisor MessageStream implementations now share the parser
    exercised by a native KJ test. That test round-trips a valid RPC bootstrap
    frame, checks explicit malformed segment tables, and deterministically
    feeds 4,096 generated malformed frames through the production parser with
    bounded traversal and nesting limits.
  - Done: the WebSession client fixture opens a browser-scoped native capnp
    WebSocket through `WebSession.openWebSocket()` and then tears it down
    without sending RPC frames, covering the upgrade path and no-frame
    disconnect cleanup.
  - Done: `make isolate-capnp-corpus-test` replays deterministic capnp-es/KJ
    encode/decode corpus cases for common struct field shapes, and
    `make isolate-supervisor-integration-test` runs it before the real bridge
    fixture. The bridge fixture is the RPC conformance path for pipelining,
    returned capabilities, capability arguments, save/restore, browser calls,
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
(per-grain cost drops from two processes to one isolate) and it is a
prerequisite for the cross-grain fast path.

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
  meaningful version of Sandstorm's isolation story. Make the grouping policy
  a server setting, and keep per-grain workerd available as a paranoid mode
  (the runtime-adapter seam already supports both).
- **Storage mediation.** Per-grain storage stays per-grain on disk; the
  `STORAGE` binding in the shared host must be bound per-worker to the right
  grain directory, enforced in the host's C++ layer, never by worker identity
  strings.
- **Lifecycle.** Grain start/shutdown/keepAlive map to worker
  instantiation/eviction in the host; `syncStorage`/`reportGrainSize` per
  grain as today. Isolate eviction severs that grain's RPC connections, which
  by invariant 3 is already well-defined (live handles die, tokens survive).

Progress:

- The embedded-host implementation is pinned to the official workerd source
  release matching the packaged `workerd@1.20260610.1` executable. The source
  lives in `deps/workerd` at commit `ea5e86d2`, and
  `make verify-workerd-source` prevents the native host and packaged runtime
  from silently drifting to different releases.
- `make isolate-host` now builds a Sandstorm-owned native executable against
  workerd's in-process `Server` library. The build uses a checksum-pinned Bazel
  binary and a patched copy under `tmp`, leaving the upstream source submodule
  pristine; the resulting `bin/isolate-host` has no Bazel runtime dependency.
- The proxy migration stage has a minimal, ABI-tracked Cap'n Proto control
  contract: an account-scoped host accepts only a server-validated grain ID
  and returns a `HostedIsolate` lifecycle capability with `keepAlive()` and
  `stop()`. Package, runtime, socket, and storage paths are derived by the host
  from trusted roots rather than supplied over the per-grain control call.
- `bin/isolate-host` now serves that lifecycle contract over a Unix socket and
  keeps account-local grain state in one long-lived process. A client built by
  Sandstorm's existing toolchain verifies cross-toolchain wire compatibility,
  start/keepAlive/stop behavior, stopped-handle rejection, and rejection of a
  path-traversal grain ID via `make isolate-host-control-test`.
- The host receives the grain root once at process startup and resolves each
  validated grain beneath an open root directory descriptor. It retains a
  descriptor for the selected grain and requires a regular runtime manifest,
  using `openat()` plus `O_NOFOLLOW` at trust boundaries so neither RPC input
  nor a grain-directory symlink can redirect worker loading outside that root.
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
  `stop()` calls workerd's explicit eviction path, so the remaining bridge to
  real grain execution is runtime-bundle translation and request routing, not
  process or V8 lifecycle setup.
- The supervisor now emits a Sandstorm-owned packed Cap'n Proto worker-source
  bundle alongside its human-readable manifest and per-grain workerd config.
  The shared host reads that file through the already-confined grain directory,
  compiles compatibility flags, translates every supported module kind into a
  `DynamicWorkerSource`, and enters workerd's named isolate cache. Module-only
  workers load without expanding the upstream patch; binding translation and
  routing remain before the shared topology can replace the sidecar.
- Loader source ownership follows workerd's repeatable-callback contract: the
  host retains atomic backing storage and returns a fresh
  `DynamicWorkerSource::clone()` on every callback. Eviction now only removes
  the cache entry, matching upstream restart semantics; restarting a stopped
  grain creates a new stub while capabilities to the old hosted-grain wrapper
  remain stopped.
- Worker-source translation now validates non-empty and unique module/binding
  names, requires the declared main module to exist, and translates text and
  strictly parsed JSON bindings into the dynamic worker environment. Malformed
  JSON is rejected synchronously by `startGrain()`; binary-data and generic
  service bindings remain explicitly fail-closed.
- Sandstorm API, storage, and powerbox bindings now materialize as ordinary
  workerd `Fetcher` objects backed by per-grain Unix-socket channels. The host
  derives each socket beneath a duplicated, channel-owned grain descriptor, so
  eviction cannot turn a reused descriptor number into cross-grain authority.
  The path transport is transitional: dispatch adapters will instead be
  host-owned in-process HTTP services tied to grain state, avoiding repeated
  filesystem traversal and preserving the Phase 4 density goal. A
  narrow non-serializable `Frankenvalue` capability constructor lets the
  dynamic loader preserve the typed channel until the destination worker's V8
  context exists. This establishes the native per-worker routing primitive;
  end-to-end request dispatch and the supervisor protocol adapters remain.
- The shared-host trust domain is explicitly per account. The trusted backend
  now carries `Backend.startGrain.ownerId` through isolate startup as a
  required `--isolate-trust-domain` value; the supervisor validates it instead
  of deriving grouping from app or grain metadata. Runtime topology remains
  `perGrainSidecar` until the host process takes custody of workers.
- Added integration coverage that runs two isolate instances from the same app
  package at once and verifies identical `STORAGE` keys resolve to distinct
  per-grain directories and values. This guards the storage-mediation invariant
  before the runtime topology changes.
- The runtime manifest and `/runtime` Sandstorm API metadata now report the
  current topology as `perGrainSidecar`, giving shared-host work an explicit
  mode bit to assert against without changing launch behavior.
- Still deferred but required before the shared topology exits Phase 4:
  per-grain worker limits and watchdog policy, grain-tagged logs rather than
  global stdout-only attribution, keepalive-driven eviction, and published
  per-grain memory measurements.

**Exit criteria:** N example grains for one user run in one workerd with
correct storage isolation; per-grain memory overhead measured and published;
per-grain sidecar mode still passes the full suite.

---

## Phase 5 — Colocated fast path

Now both prerequisites exist: one authority channel (Phase 1) and colocated
grains (Phase 4).

- **Transport:** a native workerd extension provides a transferred-`ArrayBuffer`
  capnp transport between isolates in the same workerd. The caller builds the
  capnp message once (the only serialization that ever happens); the backing
  buffer transfers zero-copy to the callee, which reads fields in place.
  Identical message format and generated code as the WebSocket path; only the
  transport binding differs (invariant 4).
- **Cap-table translation:** each colocated pair gets a link with its own cap
  table, owned by trusted workerd C++, translating capability slots on
  transfer. This is the real engineering in this phase; it never lives in app
  code or either app isolate's JS heap.
- **Binding rule:** the host resolves "is the target colocated?" at
  claim/restore time and mints the fast-path binding then or never. **Live
  capabilities never migrate transports.** Promise-resolved capabilities
  inherit the connection binding they resolved on. This sidesteps the
  e-order/embargo problem; mid-stream promotion is out of scope unless we later
  implement proper embargoes.
- **Revocation:** every fast-path link is held through a revoker in the host's
  C++ layer (outside both JS heaps, invariant 5). Membrane-requirement
  revocation severs the link; the capability breaks with the same observable
  error as the slow path.
- **Hand-off:** passing a fast-path capability to a non-colocated party
  re-materializes it as a host-mediated capability (three-party handoff in
  miniature). Apps must not be able to observe or depend on colocation.
- **Proof:** microbenchmark in CI comparing colocated call latency/throughput
  vs. WebSocket path; target ≥10x on small messages, more on large payloads.
  Semantics parity: run the full native-capnp integration suite with fast
  path forced on and forced off; identical results required.

**Exit criteria:** benchmark target met; suite passes in both modes; revoking
a requirement kills in-flight fast-path use.

---

## Phase 6 — Stabilization

- Freeze `isolate-bridge.capnp`, the `sandstorm:api` surface, the manifest
  `IsolateConfig`, and the persistence formats; adopt a compatibility policy
  (compat dates for runtime behavior, additive-only schema evolution enforced
  by `spk capnp-abi`).
- Rewrite `docs/developing/isolate-grains.md` against the final model; retire
  the interim `docs/isolates-*.md` working notes into it.
- Remove the "not a stable contract" warnings only when Phases 1–5 exit
  criteria are all met.

---

## Sequencing rationale and risks

- **Phase 1 before everything:** every later phase gets simpler on one channel
  (Phase 4's host serves one WebSocket per grain instead of a route zoo;
  Phase 5 binds transports for real RPC caps instead of registry IDs).
  Deleting ~20 authority routes also shrinks the attack surface before the
  multi-tenant host raises the stakes.
- **Phase 4 before Phase 5:** per-grain workerd has no colocated pairs except
  a grain restoring its own export. If early de-risking of the
  transferred-buffer machinery is wanted, that self-colocated case can be
  prototyped after Phase 1 — but don't let it re-grow a lease mechanism.
- **Biggest risk, Phase 1:** capnp-es becomes fully load-bearing for all
  authority operations (hence Phase 3 custody/fuzzing). Second: WebSocket
  connection lifecycle under worker eviction — mitigated by invariant 3 and
  explicit reconnect semantics in the trusted layer.
- **Biggest risk, Phase 4:** quietly weakening the isolation story. The
  blast-radius policy must be a documented, deliberate choice, not an
  emergent property of the implementation.
- **Biggest risk, Phase 5:** cap-table translation bugs enabling authority
  leaks between colocated grains. The forced-on/forced-off parity suite and
  host-side revokers are the guardrails; any capability crossing a colocated
  link must be provably present in the source link's cap table.
