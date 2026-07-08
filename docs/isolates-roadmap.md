# Isolates: Roadmap to the Target Architecture

**Status:** Plan. Complements `docs/isolates-architecture-review.md`, which
describes the current state on branch `isolates-v2`; this document describes
where the feature needs to go and in what order.

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
session-context lookup. The old lifecycle envelope and authority POST routes
still exist and remain the next Phase 1 deletion/migration work.

**Progress, 2026-07-08:** `sandstorm:capnp` also exposes
`restoreNativeCapnpViaBootstrap()`, an explicit migration helper that restores
durable native capability tokens by calling `SandstormApi.restore()` over the
isolate bridge bootstrap and wraps the returned RPC import with the generated
capnp-es client. The isolate integration suite now runs native Greeter
conformance through this path, verifies pipelining/returned capabilities, and
checks that the restored live handle can be saved again.

**Progress, 2026-07-08:** `restoreNativeCapnp()` now defaults to the isolate
bridge bootstrap restore path, so normal durable native capability restores
return RPC imports carried by the single WebSocket RPC channel. The raw
lifecycle envelope restore helper is now exercised only by the explicit
lifecycle compatibility fixture while the remaining save/drop/export
migration work is still in progress.

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

**Delete** (all anchors per the architecture review):

- The lifecycle envelope: `POST /capnp/lifecycle` and the
  `NativeCapnpBridgeRequest/Response/Drop/Save/Restore/Saved` structs.
- The authority-bearing POST routes on `SandstormApiBindingService`
  (`/powerbox/claim-request`, `/powerbox/save`, `/powerbox/restore`,
  `/powerbox/dup`, `/powerbox/drop`, `/powerbox/drop-saved`,
  `/powerbox/offer`, `/powerbox/fulfill-request`, `/powerbox/tie-to-user`,
  `/powerbox/fetch`, `/powerbox/outbound-http-fetch`,
  `/capabilities/native-capnp-export`).
  Read-only GET metadata routes stay.
- `IsolateSessionRegistry`'s string-ID claimed-capability table, drop groups,
  and drop-notify machinery (the RPC release protocol replaces them).
- Per-export HTTP-transport RPC sessions (`NativeCapnpExportRpcSession`,
  `NativeCapnpExportHttpMessageStream`, per-export session paths).
**Keep as HTTP:** inbound WebSession→sidecar fetch (workerd's native
ingress), `STORAGE` binding, read-only metadata GETs.

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
- Powerbox flow stays browser-first: shell `postMessage` picker → token →
  browser (or worker) claims over its own channel. Worker-initiated Powerbox
  UI becomes a `SessionContext` method call whenever the shell supports it —
  no new transport needed.
- Delete the bespoke restricted-bridge plumbing that Phase 1 didn't already
  subsume.

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
- **capnp-es custody.** `@mnutt/capnp-es` must stop being a personal-fork npm
  dependency: upstream, vendor into the tree, or move to a `sandstorm-org`
  namespace with pinned integrity hashes in the build. The runtime is
  supervisor-injected trusted-adjacent code; treat it like one.
- **ABI discipline.** Extend `spk capnp-abi` checks to any new platform
  bootstrap schemas, not just app schemas.
- Fuzz the supervisor-side `MessageStream` framing parsers and add
  differential capnp-es/KJ corpus and RPC conformance tests.

**Exit criteria:** one persistence format per family with a migration note;
build reproducible without reaching into a personal npm namespace; fuzz
harness in CI.

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
