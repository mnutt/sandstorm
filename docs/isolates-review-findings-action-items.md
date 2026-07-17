# Isolates review: findings and action items

Findings from an architecture and implementation review of the isolates feature
(diff `efe0d64a` → `c20d3886`), conducted against
[`isolates-review.md`](isolates-review.md). Security-focused review was
explicitly out of scope. Line references point at the checkout reviewed
(`c20d3886` plus working tree) and will drift; symbol names are given for
relocation.

Items are ordered by priority within each section. Each item states the
finding, the evidence, and the recommended action.

## Resolution status (2026-07-17)

All action items except the explicitly deferred workerd-upstreaming discussion
have been resolved in the implementation or superseded by the direct-host
cutover:

| Item | Resolution |
| --- | --- |
| 1 | Superseded. The sidecar and legacy HTTP adapters were removed; application and private-bridge WebSockets use the single account-hosted path. |
| 2 | Account-host integration now covers streaming and 64 MiB pumping/caps, cancellation/error recovery, application WebSockets, worker bridge and browser native-RPC session establishment, route-backed and app-defined persistence, outbound-HTTP restore, restart, isolation, and concurrent start. |
| 3 | Superseded. Supervisor and native host communicate over one binary Cap'n Proto connection carrying `HttpService` capabilities; the in-process HTTP/1 text round-trip no longer exists. |
| 4 | The maintained authoring guide now defines API versions, feature bits, additive schema evolution, public generated modules, and the release-review checklist. |
| 5 | Deferred by project direction. No upstreaming work is part of this change. |
| 6 | The authoring guide records http-over-Cap'n-Proto as the long-term shell boundary and `WebSession` as a compatibility layer. |
| 7 | Session unregister now sweeps browser handoffs and releases their capabilities; a unit test verifies release. |
| 8 | Non-disconnect grain keepalive failures retry on the same account host; the recovery test verifies a healthy sibling and account PID survive. |
| 9 | Account-host startups publish a forked promise before yielding, so concurrent starts join one admission; integration coverage issues two simultaneous calls. |
| 10 | Each hosted worker owns one cancel-and-replace idle timer. |
| 11 | Upload spool reads, writes, rewind, and fsync run on one account-host I/O worker; parity tests cover cancellation, error recovery, and the 64 MiB boundary. |
| 12 | One native-host watchdog scheduler thread services all active JS scopes. |
| 13 | The subrequest counter is atomic. |
| 14 | Superseded. The sidecar availability probe and placeholder response were deleted with the sidecar topology. |
| 15 | Normal request, response, WebSocket, binding, storage, and lifecycle messages are INFO; WARNING remains for failures. |
| 16 | Session-registry and confined-launch C++ responsibilities are separate translation units; the browser client and shared validation primitives are separate JavaScript sources assembled into the generated helper. |
| 17 | Streaming response completion is shared by the direct and spooled branches. |

The deliberate decisions at the end of this document are ratified in
`docs/developing/isolate-grains.md`: normal grain accounting is the aggregate
storage policy; the account process is the accepted crash/contention domain;
route-backed and app-defined persistence remain distinct; and service bindings
are worker-local `main` loopbacks. Both `spk` and runtime admission reject any
other service target.

The complete release gate (`make isolate-ci`) passes with these resolutions.

## P0 — Release blockers

### 1. WebSockets do not work in the default (account-shared) topology

**Finding.** The native Cap'n Proto bridge is standardized on WebSockets as its
only transport: `openNativeCapnpBridgeRpcSession` returns
`426 Upgrade Required` for non-upgrade requests
(`src/sandstorm/isolate-supervisor.c++:5345-5349`), and the worker opens it via
`env.SANDSTORM_API.fetch(..., { headers: { Upgrade: "websocket" } })`
(`src/sandstorm/isolate/api.js:275-278`). In account-shared mode — the
production default (`src/sandstorm/config.c++:271-279`) — every WebSocket path
traverses one of two hand-rolled HTTP-over-Cap'n-Proto adapters in the embedded
host, and both reject upgrades:

- Bindings direction (worker → supervisor, carries `/capnp/rpc-session`):
  `SANDSTORM_API`/`STORAGE`/`POWERBOX` bindings are materialized as
  `LegacyCapnpHttpService` (`isolate-host/isolate-host-main.c++:994-998`),
  whose `LegacyClientRequestContext::startWebSocket` throws
  ("legacy shared-host bindings do not yet support WebSockets",
  `isolate-host/isolate-host-main.c++:582-584`).
- Ingress direction (supervisor → worker, carries application WebSockets and
  the supervisor-initiated `/__sandstorm/main-view/rpc-session` used for
  app-persistent restore): `LegacyHttpRequestContext::acceptWebSocket` throws
  (`isolate-host/isolate-host-main.c++:709-711`).

There is no route around these adapters in shared mode. Consequently
`Capability`, Powerbox over the bridge, browser handoff, app-persistent
save/restore, and application WebSockets all fail at runtime in the default
topology, while packaging and admission succeed. The broad behavioral test
matrix runs only against per-grain mode, so CI does not catch this.

**Action.** Either:

- (a) implement the WebSocket leg in both adapter directions — capnp's own
  `HttpOverCapnpFactory` already translates WebSockets in both directions, and
  the supervisor side already uses `kjToCapnp`/`capnpToKj` from it; finish the
  hand-rolled stubs or replace them with the library factory if the
  compatibility constraint behind "legacy" allows; **or**
- (b) flip the default `ISOLATE_HOSTING_MODE` to `per-grain` until (a) lands.

Documenting the gap as an "intentional limitation" is not viable: it would mean
the flagship capability API does not work in the default configuration.

### 2. Account-shared topology lacks parity test coverage

**Finding.** The 3,381-line runtime integration suite
(`tests/isolate-supervisor-integration.test.js`) and the strongest semantic
oracle (`src/sandstorm/isolate-websession-client.c++`) exercise the per-grain
fallback. The default production topology gets only the focused
`isolate-account-host-client.c++` coverage. The item-1 gap would have been a
red CI job rather than a doc footnote if streaming, WebSocket, persistence, and
browser-RPC clusters ran against `HostedRuntimeAdapterFactory`.

**Action.** Run at minimum these test clusters against the account-shared
factory: streaming uploads/responses, application WebSockets, private-bridge
RPC (worker and browser bootstrap), route-backed and app-persistent
save/restore/drop, and outbound HTTP restore. Parameterize the existing
fixtures by topology rather than duplicating them where possible.

## P1 — Architecture: fix before the surface ossifies

### 3. Collapse the in-process HTTP round-trip in `HostedRuntimeAdapterFactory`

**Finding.** In hosted mode a request path is: `WebSession` →
`FetchRequest` struct → **serialized to HTTP/1.1 text over an in-memory pipe
and re-parsed** (a full `kj::HttpServer` is constructed per connection in
`HostedRuntimeAdapterFactory::connect`,
`src/sandstorm/isolate-supervisor.c++:3063-3075`) → hand-rolled
http-over-capnp → `kj::HttpService` in the host → workerd. The text
serialization round-trip within one address space is pure overhead and a
semantic hazard (header normalization, chunked encoding, connection reuse,
cancellation/backpressure/half-close differences vs. the Unix-socket path —
none of which are tested for parity).

**Cause.** `WorkerdRuntimeAdapter` is written against
`kj::AsyncIoStream` + `kj::HttpClient`; the hosted factory retrofits a stream.

**Action.** Re-plumb the adapter abstraction onto `kj::HttpService` /
`kj::HttpClient`:

- sidecar path: wrap the Unix socket via `kj::newHttpClient` as today, behind
  the interface;
- hosted path: use `httpFactory.capnpToKj()` output directly, deleting the
  pipe and per-connection `HttpServer`.

This is also the natural place where WebSocket support (item 1) falls out,
because `kj::HttpService` models upgrades.

### 4. Define the API/protocol versioning policy before third-party packages ship

**Finding.** `SANDSTORM_API_VERSION = 0`
(`src/sandstorm/isolate/api.js:34-37`) and
`SANDSTORM_CAPNP_NATIVE_BRIDGE_PROTOCOL_VERSION = 0` with a features array
(`src/sandstorm/isolate/capnp-runtime.js:12-19`). Once one external SPK ships,
this contract is frozen in practice regardless of what the number says.

**Action.** Write down, as a release-checklist item: what a version bump
means, what the features list gates, the compatibility promise for generated
platform schema modules, and which changes require schema evolution vs. a
protocol feature bit. Treat additions to
`src/sandstorm/isolate/capnp-es/runtime-modules.txt` and
`src/sandstorm/isolate/platform-capnp-es/schemas.txt` as public-surface
changes (the review guide already says this; enforce it in review practice).

### 5. Start the workerd upstreaming conversation

**Finding.** The 584-line pinned patch
(`patches/workerd/0001-add-sandstorm-isolate-host-target.patch`) is small and
well-scoped (dynamic worker loading, direct-capability `Frankenvalue` that
refuses serialization, limit-enforcer factories), but a patched fork of
workerd is the largest long-term maintenance liability in the feature. Every
workerd pin update requires re-validating the patch and the seccomp allowlist.

**Action.** Propose the dynamic-load seam and limit-enforcer factory hooks
upstream. The direct-capability `Frankenvalue` variant is generically useful
for embedders. Track which hunks are Sandstorm-specific (likely only the Bazel
target) versus generic embedding API.

### 6. State the `WebSession` end-game

**Finding.** The request path pays twice for `WebSession`'s lossy re-encoding
of HTTP; this change grows whitelists (`expectedSize`, Range headers,
`src/sandstorm/web-session.capnp:64-84,153-166,443-455`) to claw back
fidelity, and that whitelist will keep accreting.

**Action.** No code change now (correctly scoped out of this diff), but
document the direction: the shell should eventually speak http-over-capnp to
supervisors, with `WebSession` becoming a compatibility shim. This prevents
further per-header schema surgery from being treated as the permanent plan.

## P2 — Lifetime and ownership correctness

### 7. Browser handoff entries leak on session unregister

**Finding.** `IsolateSessionRegistry::unregisterSession` removes only the
session record (`src/sandstorm/isolate-supervisor.c++:337-344`);
`browserHandoffCapabilities` entries scoped to that session are never
reclaimed. They become unclaimable but stay pinned — holding live capability
references — for the supervisor's lifetime unless the app explicitly calls
`dropBrowserHandoff`. Unbounded per-supervisor retention channel.

**Action.** Index handoff records by session ID and sweep them in
`unregisterSession`. Add a registry test: register session → create handoff →
unregister session → assert the handoff entry and its capability ref are
released.

### 8. Single-grain keepalive failure recycles the entire account host

**Finding.** In `BackendImpl::bootGrain`, *any* keepalive exception on an
account-hosted grain — including a plain `FAILED` from a stopped
`HostedIsolate` (`isolate-host/isolate-host-main.c++:1205`) — erases both the
grain entry and the account-host cache entry
(`src/sandstorm/backend.c++:262-277`). `eraseAccountHost` also removes the
account cgroup (`src/sandstorm/backend.c++:123-131`), whose cleanup path kills
remaining processes. One idle-evicted worker racing a revisit can therefore
restart every isolate grain the account has running. It self-heals, but it is
a hammer where tweezers were indicated.

**Action.** Distinguish failure classes: on a non-`DISCONNECTED` keepalive
failure, retry `startGrain` against the *same* account host (host-side
`startGrain` is idempotent and revives evicted workers,
`isolate-host/isolate-host-main.c++:1246-1253`) before tearing down the host
connection and cgroup. Reserve full teardown for `DISCONNECTED`.

### 9. `IsolateAccountHostImpl::startGrain` is not concurrency-safe with itself

**Finding.** Two in-flight calls for the same grain can both pass the
post-admission recheck (`src/sandstorm/isolate-supervisor.c++:6868-6871`),
both send `nativeHost.startGrain`, and the second `supervisors.insert` will
fail on the duplicate key after results were already set
(`src/sandstorm/isolate-supervisor.c++:6899-6900`). Latent today because the
backend serializes per grain, but the interface is documented idempotent and
should not depend on caller discipline.

**Action.** Store a forked promise in the `supervisors` map *before* admission
(the same pattern `BackendImpl` uses with `StartingGrain`), so concurrent
callers join one startup.

### 10. `refreshIdleTimer` accumulates one task per keepalive

**Finding.** Every keepalive adds a new 180-second timer task to the
`TaskSet`; superseded tasks linger until they fire
(`isolate-host/isolate-host-main.c++:1295-1305`). With per-minute keepalives
that is ~180 zombie tasks per active grain. Bounded, but wasteful and
misleading in diagnostics.

**Action.** Keep one reschedulable timer (or a `kj::Canceler`) per
`HostedState` instead of a task per refresh. The generation counter can then
be deleted.

## P2 — Event-loop and resource behavior

### 11. Blocking file I/O on the shared event loop in the upload spool path

**Finding.** The unknown-length upload spool performs synchronous
`writeAllToFd`, `read`, and `fsync` directly on the event loop
(`src/sandstorm/isolate-supervisor.c++:2721-2724`, `2745-2747`, `2891-2896`).
In per-grain mode this stalls one grain; in account-shared mode this code runs
inside the account host, so one slow chunked upload stalls **every grain the
account owns**.

**Action.** Move spool I/O off the shared loop (dedicated thread or
`kj::Thread`-backed file streams). Additionally add tests for spool-file
cleanup on cancellation/error and for the 64 MiB cap being enforced while
pumping (the review guide's open question).

### 12. A watchdog thread is created and joined per JS execution scope

**Finding.** `JsWatchdogScope` spawns and joins a `std::thread` on every
`enterJs` (`isolate-host/isolate-host-main.c++:54-98`), potentially several
times per request. Under concurrency this is measurable overhead and an
FD/stack multiplier across an account's workers.

**Action.** Replace with a single shared timer/watchdog thread servicing all
active scopes (workerd upstream has this pattern). Bound and measure thread
count under high per-account concurrency as an acceptance criterion.

### 13. Confirm `SandstormRequestLimitEnforcer::subrequests` is isolate-locked

**Finding.** `subrequests` is a plain `uint` incremented in
`newSubrequest` (`isolate-host/isolate-host-main.c++:208-210`) while sibling
state uses atomics, suggesting cross-thread access was considered. Fine if all
increments happen under the isolate lock; undefined otherwise.

**Action.** Verify the calling contract; either document why plain `uint` is
safe or make it atomic for consistency.

## P3 — Implementation quality

### 14. Remove the "V8 execution is not implemented yet" placeholder page

**Finding.** `fetchPlaceholder` still renders a 200 HTML page reading "V8
execution is not implemented yet" — including bundle directory, workerd config
path, and socket path — whenever the sidecar socket is not yet listening
(`src/sandstorm/isolate-supervisor.c++:2969-3015`). A grain racing its sidecar
startup shows users an internal debug page.

**Action.** Replace with a plain 503 (optionally `Retry-After`). Drop the
per-request `access(2)` liveness probe in
`WorkerdRuntimeAdapterFactory::isAvailable`
(`src/sandstorm/isolate-supervisor.c++:3024-3026`) — just attempt the connect
and map failure to 503.

### 15. Demote per-request logging from WARNING

**Finding.** Every forwarded request, buffered response, streaming response,
and WebSocket logs at `KJ_LOG(WARNING)`
(`src/sandstorm/isolate-supervisor.c++:2660`, `2671`, `2907`, `2943`). On any
loaded server this buries real warnings.

**Action.** Demote to INFO/verbose or remove; keep WARNING for the actual
error path (`fetchRuntimeError`).

### 16. Split the two monolith files

**Finding.** `src/sandstorm/isolate-supervisor.c++` is ~7,000 lines containing
a coordinator, two supervisor variants, session implementations, HTTP
conversion, sandbox launcher, binding services, and admission pools.
`src/sandstorm/isolate/api.js` is ~4,300 lines mixing the worker facade,
browser client, validation, and Powerbox helpers. The review guide itself has
to hand out line ranges like map coordinates.

**Action.** Split along the seams the review guide already names: request
conversion, runtime adapters, session/bridge implementations, sandbox/launch,
account coordinator; and for `api.js`: worker API, browser client, shared
validation. Mechanical, but do it before the next feature lands in each.

### 17. Deduplicate the streaming response continuations

**Finding.** `sendSpooledRequest` duplicates its response-handling
continuation in both branches
(`src/sandstorm/isolate-supervisor.c++:2856-2882`), and `fetchFromSidecar`
repeats the same lambda pyramid again (`2906-2938`).

**Action.** Extract one helper taking the response promise and the state ref;
three copies become one.

## Deliberate decisions to ratify (no action unless disagreed)

These were flagged during review as *choices* that look intentional and
defensible; they should be confirmed as policy rather than rediscovered later.

- **No aggregate storage quota** in the isolate storage service: 1 MiB per
  value, key count and total bytes bounded only by existing grain storage
  accounting (`src/sandstorm/isolate-supervisor.c++:5982-6131`).
- **Account-shared blast radius**: one process per account is an accepted
  failure/contention domain, documented in
  `docs/administering/config-file.md:189-203`. (Item 2's parity tests and
  item 8's narrower recovery reduce the operational cost of this choice.)
- **Dual persistence model** (route-backed platform objects vs. `AppPersistent`
  via the main-view RPC route): more mechanism than ideal, but each half is
  justified — route-backed refs survive app-code changes; app-defined refs
  allow real object semantics.
- **Shared-host service bindings restricted to worker-local `main` loopbacks**
  (`isolate-host/isolate-host-main.c++:1001-1008`): fine, but ensure `spk`
  rejects at packaging time every service graph the shared host cannot
  represent, so apps cannot pass tooling and fail only at production admission
  (review-guide open question; belongs with item 2's parity work).

## What was reviewed and found sound (no action)

For the record, these areas were examined and are in good shape: the
`Supervisor`-seam architecture (shell needs no new concepts); the path-free,
version-checked `IsolateWorkerSource` handoff with independent producer and
consumer validation; the `IsolateBindingServices` enum-scoped attenuation and
possession-based `HostedIsolate.getHttpService()` ingress; the small,
well-scoped workerd patch with its serialization-refusing direct-capability
`Frankenvalue`; generation counters on account hosts and idle eviction;
startup-pipe cgroup race handling and parent-death signals; atomic
`O_NOFOLLOW`/rename/dir-fsync storage writes; and the pinned
workerd-binary/source/patch verification release gates.
