# Isolates: Detailed Roadmap To The Target Architecture

**Status:** Draft for architecture review.

**Audience:** Reviewers evaluating the proposed direction before the isolate
runtime becomes a stable Sandstorm contract.

**Relationship to other docs:** This expands `docs/isolates-roadmap.md` with
more design detail, sequencing, migration mechanics, security invariants, and
review questions. `docs/isolates-architecture-review.md` describes the current
prototype state; this document describes the desired end state and the path
from the prototype to that end state.

## Executive Summary

The current isolate prototype has the right outer seam: an isolate grain is
still an ordinary Sandstorm grain. The shell still talks to a `Supervisor`,
opens `UiView` and `WebSession` capabilities, applies membranes, saves and
restores sturdy refs, and mediates Powerbox. The new code lives below that
boundary by running app code in a workerd-style `fetch(request, env)` runtime.

The part that should change before stabilization is the worker-to-supervisor
authority bridge. Today authority crosses that boundary through several
overlapping mechanisms:

- HTTP POST routes on the `SANDSTORM_API` binding that manipulate capabilities
  by opaque string IDs.
- A binary lifecycle envelope for native Cap'n Proto save, restore, and drop.
- A WebSocket Cap'n Proto RPC session for generated method calls.
- Per-export callback sessions from the supervisor back into the worker.
- A same-supervisor local-dispatch lease and trusted JS WeakMap fast path.

Each mechanism is defensible in isolation, but together they duplicate pieces
of Cap'n Proto RPC: cap tables, release, persistence, export/import identity,
revocation, and eventually path shortening. The roadmap consolidates authority
onto one logical Cap'n Proto RPC authority channel per isolate grain. In the
initial JS implementation, concrete live connections are scoped to a workerd
request context; the long-term native workerd binding can own a persistent
connection outside request JS. The bootstrap capability on that channel exposes
the Sandstorm API and session-context operations. Live capabilities are RPC
references, not registry IDs. Durable authority remains token strings returned
by the platform. Transport choice becomes an implementation detail selected by
trusted runtime code.

The final performance story is not "share JavaScript objects between
isolates." V8 isolates have separate heaps. The final fast path is a
transferred-`ArrayBuffer` Cap'n Proto transport between colocated isolates:
same message format, same generated code, no supervisor socket hop, and
host-owned cap-table translation and revocation.

## Non-Goals

- Do not change the public Sandstorm grain boundary in this work. `Supervisor`,
  `UiView`, `WebSession`, `ApiSession`, `SandstormCore`, membrane requirements,
  and saved tokens remain the platform boundary.
- Do not preserve compatibility with prototype isolate apps. Nothing has been
  released as stable.
- Do not expose the raw Cap'n Proto vat network to app code.
- Do not make service binding names authority. Authority is a capability
  reference or a durable token.
- Do not depend on app JS to enforce revocation or storage isolation.
- Do not optimize the temporary multi-transport design further except where it
  directly supports deletion.

## Reviewer Questions

Reviewers should focus on these questions:

1. Does the single-RPC-channel design correctly preserve Sandstorm's
   object-capability model?
2. Is the proposed bootstrap surface the right shape, or should it reuse more
   of `grain.capnp` directly?
3. Are any authority-bearing HTTP routes still justified after Phase 1?
4. Is there a simpler way to represent isolate-export persistence while staying
   compatible with classic supervisor restore/drop semantics?
5. Does the shared-workerd phase preserve an acceptable isolation story?
6. Is the transferred-buffer fast path sound with respect to cap tables,
   revocation, e-order, and handoff to non-colocated peers?
7. Are the phase boundaries correct, or should browser unification,
   persistence hardening, or shared workerd move earlier?

## Terminology

**Trusted layer:** Supervisor-owned C++ plus supervisor-injected helper JS. App
code can call the helper APIs, but should not be able to forge authority by
constructing helper internals.

**Authority channel:** A channel on which possession of a reference confers the
right to call it. The target design has one authority channel per isolate: a
Cap'n Proto RPC connection.

**Durable token:** A Sandstorm saved-capability token. It can outlive process
or isolate eviction and can be restored later by the owning grain.

**Live handle:** An in-memory RPC capability reference. It dies when the
connection or isolate dies.

**Fetch-shaped capability:** A capability whose useful data-plane operation is
well represented by HTTP-style `fetch()`, typically `WebSession`,
`ApiSession`, or outbound HTTP. Fetch is syntax sugar over a capability, not
the authority primitive.

**Colocated:** Two isolate workers are hosted in the same trusted workerd host
process and can use an in-process transport chosen by the host.

## Design Invariants

These invariants must hold after every phase, not just at the end:

1. **Unchanged grain boundary.** To the Sandstorm shell, isolate grains remain
   ordinary grains.
2. **Reference authority.** A live capability is authority by possession of an
   RPC cap-table entry. The only other authority form is a durable token string
   issued by Sandstorm. Opaque local IDs are not authority, except for
   explicitly-scoped join keys like WebSession `sessionId`, which merely select
   an already-existing same-grain session context and expire with that session.
3. **Ephemeral live handles.** Live handles die with the isolate or RPC
   connection. In the JS implementation they also die with the current workerd
   request context. Durable tokens and app object IDs survive and must be
   explicitly restored.
4. **No app-visible transport choice.** WebSocket, native vat path, browser
   WebSocket, or transferred-buffer local transport must be invisible to app
   code.
5. **External revocation.** Revocation must be enforceable from outside both
   endpoints' JS heaps.
6. **No live transport migration.** A live capability's transport is bound when
   the handle is created. Fast-path binding may only happen for settled
   references materialized by claim/restore/import. Promise-resolved
   capabilities inherit the binding of the connection they resolved on. If
   later work wants to migrate live caps, it must implement Cap'n Proto
   embargo/e-order semantics correctly.
7. **Schema-first public protocols.** Public typed protocols are Cap'n Proto
   interfaces imported with `capnp:`. The browser, isolate workers, and legacy
   grains should all speak the same schema where possible.
8. **HTTP remains data-plane and ingress.** HTTP is still the right shape for
   inbound web UI requests, storage-like fetches, and fetch-shaped capabilities.
   It should not be the authority protocol.

## Target Architecture

Every caller of a grain's typed capabilities is a Cap'n Proto peer:

| Caller | Transport | Authority root |
| --- | --- | --- |
| Isolate worker to supervisor | One logical Cap'n Proto RPC authority channel; request-scoped JS connections until native workerd support exists | Bootstrap Sandstorm isolate API |
| Isolate worker to legacy grain | Same connection, supervisor/native vat bridge | Restored or claimed capability reference |
| Legacy grain to isolate worker | Sandstorm native Cap'n Proto path | Capability exported by isolate over the worker connection |
| Browser to isolate or legacy grain | Restricted browser WebSocket Cap'n Proto session | Browser/session-scoped bootstrap |
| Colocated isolate to colocated isolate | Transferred-`ArrayBuffer` Cap'n Proto transport | Host-bound capability reference |
| Web UI request into isolate | WebSession to HTTP fetch adapter | User's session capability |

The isolate worker sees a normal Workers-style `env` object:

```js
export default {
  async fetch(request, env) {
    const session = env.SANDSTORM.session(request);
    const token = await env.SANDSTORM.save(someCap, {
      label: "calendar used for reminders",
    });
    return new Response("ok");
  },
};
```

But internally, `env.SANDSTORM` is a wrapper over the Cap'n Proto RPC authority
channel available to the current request context. It does not issue
authority-bearing HTTP requests to local binding routes. Capabilities held by
app code are wrappers around capnp-es client objects, not `{ id: "..." }`
records looked up in a supervisor registry.

## Bootstrap Surface

The bootstrap should be minimal and should prefer existing Sandstorm schemas.
It should not grow a parallel isolate-specific authority API.

```capnp
@0x...;

using Grain = import "grain.capnp";

interface IsolateBridge {
  # Bootstrap capability for an isolate worker's authority connection.
  #
  # This is supervisor-private: it is not an app protocol. App JS sees the
  # ergonomic `sandstorm:api` facade.

  getSandstormApi @0 () -> (api :Grain.SandstormApi);
  # Returns the standard Sandstorm API capability for this grain. This is the
  # home for save/restore/drop of durable tokens.

  getSessionContext @1 (sessionId :Text) -> (context :Grain.SessionContext);
  # Returns the standard session context for a live WebSession/ApiSession.
  # Session-specific operations like offer(), fulfillRequest(), tieToUser(),
  # and claimRequest() should be ordinary calls on this capability.
}
```

Important vocabulary correction: app code should use `Grain.SandstormApi.save`,
`restore`, and `drop` for durable tokens. App-hosted persistent objects
implement `Grain.AppPersistent.save`. The roadmap should not imply that all
app-facing save/restore should literally become Cap'n Proto's generic
`Persistent` interface. The internal supervisor may cast to `SystemPersistent`
when implementing `SandstormApi.save`, as classic Sandstorm already does.

Session lookup is the one deliberate local-ID seam. The `sessionId` comes from
headers on the WebSession/ApiSession ingress request and is used only to join
that HTTP request to its already-existing `SessionContext`. It must be
unguessable, grain-scoped, expire with the session, and fail after session
close. It must never authorize cross-grain access.

There should be no `restoreForInterface()` bootstrap method. Expected-interface
checks are developer experience, not a security boundary; using the wrong
generated client should fail as an ordinary unimplemented/wrong-interface
Cap'n Proto call. If trusted metadata can produce a clearer local error, that
can live in the JS facade without adding a new supervisor authority method.

There should be no `exportNative()` registration method. Exporting a capability
means passing a live capability over RPC. Persistence should use classic
Sandstorm semantics:

- App-provided durable objects implement `Grain.AppPersistent.save()` and
  return an app object ID.
- The supervisor stores that as `SupervisorObjectId.appRef`, just like classic
  grains.
- Later restore calls the worker's `Grain.MainView.restore(objectId)` hook and
  receives a fresh live capability.
- `Grain.MainView.drop(objectId)` and `SandstormApi.deleted()` carry the
  classic deletion semantics.

This makes isolate exports compatible with the classic supervisor model rather
than merely compatible-looking. Route-backed WebSession/ApiSession
capabilities are supervisor-implemented, so they may remain supervisor object
variants, but they should also use one explicit schema format rather than a
string-prefixed app-ref envelope.

## What Gets Deleted

The main benefit of Phase 1 is deletion. The target architecture removes these
prototype mechanisms:

| Current mechanism | Replacement |
| --- | --- |
| Done: `/powerbox/claim-request` POST route | `SessionContext.claimRequest()` over RPC |
| Done: `/powerbox/save` POST route | `SandstormApi.save()` over RPC |
| Done: `/powerbox/restore` POST route | `SandstormApi.restore()` over RPC |
| Done: `/powerbox/drop-saved` POST route | `SandstormApi.drop()` over RPC |
| Done: `/powerbox/drop` POST route for live handles | Cap'n Proto release/drop of the live reference |
| Done: `/powerbox/dup` POST route | Ordinary JS references to the same client; RPC cap table handles lifetime |
| Done: `/powerbox/offer` POST route | `SessionContext.offer()` over RPC |
| Done: `/powerbox/fulfill-request` POST route | `SessionContext.fulfillRequest()` over RPC |
| Done: `/powerbox/tie-to-user` POST route | `SessionContext.tieToUser()` over RPC |
| Done: `/powerbox/fetch` POST route | Fetch sugar over a live `WebSession`/`ApiSession` RPC reference |
| Done: `/powerbox/outbound-http-fetch` POST route | Fetch sugar over a live `OutboundHttpSession` RPC reference |
| Done: `/capabilities/web-session` and `/capabilities/api-session` POST routes | Route-backed capability creation over IsolateBridge RPC |
| `/capnp/lifecycle` binary envelope | Ordinary methods over the authority RPC connection |
| `NativeCapnpBridgeRequest/Response` lifecycle structs | Deleted or replaced by small bootstrap schema |
| `IsolateSessionRegistry` claimed-capability string IDs | RPC cap-table references |
| Done: drop groups and drop-notify for live handle release | RPC release protocol and host-owned revokers |
| Per-export callback RPC sessions | Worker passes server capability over the same connection |
| Local-dispatch lease and trusted WeakMap | RPC reference identity now; transferred-buffer fast path later |

HTTP that should remain:

- WebSession to worker `fetch()` ingress.
- Storage binding, as a data-plane service over a local trusted endpoint.
- Read-only metadata/debug GET endpoints, if still useful.
- Fetch sugar for fetch-shaped capabilities, implemented by calling the held
  capability over RPC rather than by looking up an ID in a local registry.

## Phase 1: Consolidate Authority Onto One RPC Channel

### Goal

Make the worker-supervisor Cap'n Proto RPC connection the only authority
channel for live capabilities. After this phase, app code no longer receives or
sends capability IDs as authority. It receives wrapper objects around live RPC
clients.

### Workerd IoContext Constraint

Stock workerd owns I/O objects in a per-request `IoContext`. A WebSocket opened
from one request handler cannot be safely retained and used from later request
handlers; workerd will reject I/O performed on behalf of a different request.
This is a blocking implementation constraint, not an optimization detail.

Therefore Phase 1 must not be implemented as "trusted JS opens one lazy
persistent WebSocket and shares it across all requests." The semantics should
be request-scoped first:

- Live handles obtained inside a request are valid for that request/context.
- Durable authority is represented by Sandstorm tokens and app object IDs.
- App-hosted durable capabilities are re-materialized through
  `MainView.restore(objectId)`, matching the classic restore-hook model.
- Export dispatch should be expressed as "restore or receive a live capability
  in the current context," not "call a JS object kept alive globally from a
  previous request."

The long-term implementation should move the authority connection into trusted
native workerd support, outside any app request's JS heap and outside any
single request `IoContext`. That native binding can later provide the same
logical API without per-request handshakes. Until that exists, per-request
connections are acceptable, honest, and easier to reason about than a JS-held
global connection.

### Phase 1A: Add The Bootstrap Connection

Implementation steps:

1. Add `src/sandstorm/isolate-bridge.capnp`.
2. Generate it into the isolate runtime support bundle as a `capnp:` module.
3. Extend the existing WebSocket RPC session endpoint so it can open a
   bootstrap session for the worker, not only a target-specific session for one
   capability ID.
4. Bootstrap with an `IsolateBridge` server implemented by the supervisor.
5. Add trusted JS that opens authority connections only within the current
   request context, unless/until a native workerd binding owns the connection
   outside request JS.

During migration the endpoint may temporarily support both modes:

```text
GET /capnp/rpc-session?connectionId=...&bootstrap=worker
GET /capnp/rpc-session?id=...&interfaceId=...&connectionId=...
```

The final state should delete the target-specific mode. The temporary dual
mode should be tracked as migration debt.

Progress: worker-side `connectNativeCapnp()` now resolves id-backed
capabilities through the bootstrap connection and uses capnp-es pipelining for
the returned capability slot. The target-specific mode remains for the browser
bridge and as a fallback while Phase 2 is pending.

Security checks:

- The bootstrap WebSocket is reachable only through the supervisor-injected
  `SANDSTORM_API` binding or the equivalent trusted workerd binding.
- App code cannot choose a different grain, supervisor, or user context.
- One connection is scoped to one grain worker and, in the JS implementation,
  to one request context.
- Closing the connection breaks all live handles on it.
- No live I/O object created in one workerd request context is used from
  another request context.

Tests:

- Worker can open the bootstrap and call a harmless method.
- Two workers cannot use each other's bootstrap connection.
- Connection close breaks live clients with a deterministic error.
- Reconnect creates a fresh live-handle universe; old handles stay broken.
- Attempting to use a request-scoped live handle after its context is closed
  fails deterministically.
- Connection churn under many simultaneous requests does not leak handles or
  confuse session contexts.

### Phase 1B: Rebuild `sandstorm:api` Around RPC References

Today `sandstorm:api` wraps JSON returned by HTTP routes. The new helper should
wrap capnp-es clients.

Desired JS shape:

```js
const cap = await env.SANDSTORM.restore(token, Greeter);
const client = cap.as(Greeter);
await client.hello({ name: "Ada" });

const saved = await env.SANDSTORM.save(cap, {
  label: "greeter for nightly jobs",
});
```

Internal representation:

```js
class Capability {
  #client;
  #metadata;

  as(InterfaceClass) {
    return new InterfaceClass.Client(this.#client);
  }

  async save(options) {
    return env.SANDSTORM.save(this, options);
  }

  fetch(input, init) {
    return fetchCapability(this.#client, input, init);
  }
}
```

The exact API can differ, but the invariant is that `#client` is a live
capability reference. There is no `id` string that the worker later presents
back to the supervisor as authority.

Migration order:

1. Add the new representation beside the old one.
2. Move native restore to the new representation.
3. Move native save/drop.
4. Move Powerbox claim/offer/fulfill/tieToUser.
5. Move fetch-shaped capabilities.
6. Delete the old string-ID representation.

### Phase 1C: Move Save, Restore, And Drop

Restore:

- App passes a durable token.
- Trusted JS calls `SandstormApi.restore(token)`.
- Result is a live RPC capability reference.
- Generated clients are created directly over that reference.
- Optional expected-interface arguments are helper-side diagnostics only. They
  are not a security boundary and should not require a separate supervisor
  restore method.

Save:

- App passes a live capability reference plus label text.
- Trusted JS calls `SandstormApi.save(cap, label)`.
- Supervisor applies the normal Sandstorm save path, including owner and
  display metadata.
- Result is a durable token.

Drop:

- Dropping a durable token calls `SandstormApi.drop(token)`.
- Dropping a live handle releases the local JS reference and lets the Cap'n
  Proto RPC release protocol do the live-handle cleanup.
- If an explicit app-facing `cap.close()` exists, it should mean "stop using
  this live wrapper"; it should not be an authority-bearing route.

Tests:

- Save and restore a legacy capability.
- Save and restore an isolate-exported capability.
- Restoring a token and using it through the wrong generated interface fails
  cleanly with an ordinary Cap'n Proto method/interface error or helper-side
  diagnostic.
- Dropping a durable token prevents future restore.
- Dropping a live wrapper does not delete the durable token.
- Releasing the last live reference frees supervisor resources.

### Phase 1D: Move Powerbox Operations

Powerbox still has a browser-mediated picker. This phase does not redesign the
UI. It changes the server-side claim and follow-up operations.

Flow:

1. Browser initiates Powerbox via the shell's existing `postMessage` protocol.
2. Shell returns a short-lived request token to the browser.
3. Browser sends that token to the worker or claims it over its own restricted
   browser peer in Phase 2.
4. Worker calls `SessionContext.claimRequest()` over the authority RPC channel.
5. Returned live cap is a normal RPC reference.
6. Worker may save it through `SandstormApi.save()`.

Session operations:

- `offer(cap, requiredPermissions, descriptor, displayInfo)`
- `fulfillRequest(cap, requiredPermissions, descriptor, displayInfo)`
- `tieToUser(cap, requiredPermissions, displayInfo)`

These should be ordinary calls on `Grain.SessionContext`. The isolate bridge
may include convenience methods only if fetching the session context is too
awkward, but the semantics should remain exactly those of `grain.capnp`.

Tests:

- Claim with required permissions.
- Claim fails after session expires.
- Claim fails with missing required permission.
- Offered capability can be accepted and restored.
- `tieToUser()` revokes when permissions change.
- Powerbox-only binding cannot access non-Powerbox authority.

### Phase 1E: Move Exports To Passed Capabilities

Today native isolate exports are registered by ID, then the supervisor opens a
callback session to call back into the worker. This should become the classic
Sandstorm persistence model over the worker RPC connection:

1. App creates a capnp-es server object.
2. Passing that live capability in an RPC result or argument exports it for
   the lifetime of the current connection/context.
3. If the capability should be durable, it implements `Grain.AppPersistent`.
4. `AppPersistent.save()` returns an app-defined object ID.
5. The supervisor stores `SupervisorObjectId.appRef`, as it does for classic
   grains.
6. Later restore calls the worker's `Grain.MainView.restore(objectId)` hook to
   re-materialize a fresh live capability in the current request/dispatch
   context.
7. Drop and deletion use `MainView.drop(objectId)` and
   `SandstormApi.deleted()`.

Desired app code:

```js
import { Greeter } from "capnp:./greeter.capnp";

export default {
  async fetch(request, env) {
    const offered = env.SANDSTORM.persistent(new Greeter.Server({
      async hello({ name }) {
        return { message: `hello ${name}` };
      },
    }).client(), {
      objectId: { type: "greeter", id: "default" },
      label: "Greeter",
    });

    await env.SANDSTORM.session(request).offer(offered, {
      descriptor: await env.SANDSTORM.descriptor(Greeter),
      displayInfo: { title: { defaultText: "Greeter" } },
    });

    return new Response("offered");
  },
};
```

The app-visible API can be polished later. The important point is that the live
exported value is an RPC capability reference, and the durable identity is an
app object ID protected by Sandstorm, not a bearer export ID. A helper like
`env.SANDSTORM.persistent()` may make `AppPersistent.save()` ergonomic, but it
must compile down to the classic `AppPersistent`/`MainView.restore` contract.

Tests:

- Legacy C++ client calls isolate-defined capability.
- Isolate client calls isolate-defined capability through the normal RPC path.
- Export can be saved and restored.
- Worker eviction breaks live export references; durable restore re-enters the
  worker through `MainView.restore(objectId)` and re-materializes the target.
- `MainView.drop(objectId)` is called when the last saved reference is dropped.
- No per-export callback path is opened.

### Phase 1F: Delete Old Authority Paths

Deletion should be explicit and verified by grep/tests.

Must delete or stop compiling:

- Done: `/capnp/lifecycle`
- Done: lifecycle request/response structs
- Done: `/capabilities/native-capnp-export`
- Done: JS per-export callback session routes
- authority-bearing `/powerbox/*` POST routes, except `/powerbox/claim-request`,
  `/powerbox/dup`, `/powerbox/save`, `/powerbox/restore`, `/powerbox/drop-saved`,
  `/powerbox/offer`, `/powerbox/fulfill-request`, `/powerbox/tie-to-user`,
  `/powerbox/drop`, `/powerbox/fetch`, and `/powerbox/outbound-http-fetch`
  which are deleted
- Done: `/capabilities/web-session` and `/capabilities/api-session`
- claimed-capability table used as authority
- Done: drop groups and live-handle drop-notify machinery
- remaining C++ per-export callback/session plumbing
- local-dispatch lease structs, authorization minting, and WeakMap fast path

May keep:

- Read-only metadata endpoints.
- Browser module serving.
- WebSession ingress to worker fetch.
- Storage binding.
- Data-plane fetch helpers for fetch-shaped capabilities, once backed by live
  cap references.

Exit criteria:

- Integration tests pass.
- Examples pass.
- `rg "/capnp/lifecycle|NativeCapnpBridgeRequest|native-capnp-export|localDispatch"` returns no
  authority path, except non-authority test names or migration notes while the
  current phase is in progress.
- There is one worker-supervisor authority connection.
- Hostile-worker fuzzing covers WebSocket frame parsing, Cap'n Proto segment
  framing, and bootstrap parameter validation.
- Stress tests cover many simultaneous sessions, connection churn under load,
  and eviction or context close during in-flight calls.
- Architecture review security concerns around confused deputy and stale lease
  replay are removed because the mechanisms no longer exist.

## Phase 2: Browser As An Ordinary Cap'n Proto Peer

### Goal

Make browser-side generated clients use the same schema and same authority
model. The browser is a less-trusted peer with a session-scoped bootstrap, not
a caller of bespoke fetch-to-supervisor authority routes.

### Browser Bootstrap

The browser bootstrap should be narrower than the worker bootstrap:

- It can claim a Powerbox request token associated with the current browser
  session.
- It can use capabilities explicitly handed to that browser session by the
  worker, shell, or offer flow.
- It can call generated clients over Cap'n Proto RPC.
- It should not be able to register arbitrary exports or access worker-only
  session internals.
- It should not have blanket restore access to the grain's durable saved
  tokens. An app XSS must not be able to exercise all saved authority owned by
  the worker.

Authentication should remain shell/session based. The browser should not learn
ambient service binding names or local supervisor socket paths.

### Powerbox Flow

The picker remains browser-first:

1. Browser calls shell `postMessage` to request a descriptor.
2. User chooses a capability.
3. Shell returns a short-lived claim token.
4. Browser either claims over its own browser Cap'n Proto peer or sends the
   token to the worker, depending on the app flow.
5. Claimed cap becomes a normal live reference on that peer.

Worker-initiated Powerbox UI can later be exposed as a method on a
session-context-shaped capability, but it should not introduce another HTTP
authority surface.

### Module Serving

The browser still needs generated modules:

- `capnp-es` runtime modules.
- Generated app schema modules.
- Generated Sandstorm schema modules.
- A small browser helper.

But the helper should connect to a browser RPC session and produce capnp-es
clients. It should not duplicate lifecycle envelope logic.

Tests:

- Browser can call an isolate-defined schema capability.
- Browser can call a legacy schema capability.
- Browser Powerbox claim returns a live schema client.
- Browser helper contains no save/restore/drop lifecycle envelope code.
- Origin/source checks remain strict for shell `postMessage`.

Exit criteria:

- Browser and worker generated clients share schema modules and call shape.
- Browser authority flows through a restricted Cap'n Proto peer.
- No browser fetch-to-supervisor authority routes remain.

## Phase 3: Persistence And Toolchain Hardening

### Persistence Format

Pick one serialization format per persistent family before release.

Recommendation:

- Native schema-defined isolate exports persist as classic
  `SupervisorObjectId.appRef` values. The worker implements
  `AppPersistent.save()` and `MainView.restore/drop()` for app-defined object
  IDs; no separate `nativeCapnpExport` object family is needed for
  app-provided capabilities.
- Route-backed WebSession/ApiSession capabilities are supervisor-implemented
  and should use explicit `SupervisorObjectId` variants, not a string-prefixed
  app-ref envelope.
- Durable external capabilities continue to be Sandstorm API tokens.

Questions for review:

- What exact app object ID helper should isolate authors use for common
  durable exports?
- What schema variant should route-backed supervisor capabilities use?
- What migration story is needed before any public release if prototype users
  exist?

### capnp-es Custody

The schema runtime is load-bearing. It should not depend on an individual's
personal npm namespace for a stable platform release.

Acceptable end states:

- Upstream the needed changes to a maintained package with governance the
  project accepts.
- Vendor the runtime/compiler into the Sandstorm tree with clear update
  procedure.
- Move to a Sandstorm-owned package namespace with pinned integrity hashes and
  reproducible vendoring.

Hardening:

- Pin exact package versions and integrity hashes.
- Document how generated code is produced.
- Make builds reproducible without ad hoc network access.
- Treat runtime changes as platform changes subject to review.
- Add differential testing against the C++ implementation: shared message
  corpora round-tripped through capnp-es and KJ, plus RPC conformance between a
  capnp-es peer and a KJ peer.

### ABI Discipline

Extend existing ABI checks:

- App schemas imported with `capnp:`.
- Sandstorm-provided schemas exposed to apps.
- The new isolate bridge bootstrap schema.
- Generated browser helper API surface, if treated as stable.

Rules:

- Interface IDs are stable.
- Method ordinals are stable.
- Field ordinals and types are stable.
- Changes are additive unless guarded by compatibility date.

### Fuzzing

Fuzz hostile-worker inputs:

- WebSocket frame parsing.
- Cap'n Proto message segment framing.
- Bootstrap method parameter validation.
- Capability slot/cap-table translation.
- Browser RPC session authentication boundary.

Exit criteria:

- One persistence format per family.
- Reproducible capnp-es dependency story.
- ABI checks cover platform bootstrap schemas.
- Fuzz harnesses run in CI for the boundary parsers.

## Phase 4: Shared workerd For Density

### Goal

Get the resource benefit of isolates by running many grain workers in a small
number of workerd host processes, while preserving the unchanged Sandstorm
grain boundary.

The current per-grain supervisor plus per-grain workerd process adopts the
Workers programming model but not the density model. That is a reasonable
initial security posture, but the architecture should not bake it in.

### Host Model

Introduce an `isolate-host` service:

- Long-lived process.
- Owns one workerd instance or a small pool.
- Instantiates many grain workers.
- Presents one `Supervisor` object per grain to the rest of Sandstorm.
- Mediates per-grain storage, sockets, runtime config, logs, and lifecycle.

The shell/backend still sees a `Supervisor` per grain. The implementation of
that supervisor moves from one process per grain to one host process serving
many supervisor objects.

### Trust Domains

Putting mutually distrustful grains in one V8 process changes the blast radius
of a V8 escape. That must be a conscious policy decision.

Initial recommendation:

- Group by user/account as the default trust domain.
- Keep per-grain sidecar mode as a paranoid/admin option.
- Make the grouping policy explicit in server configuration.
- Document the security tradeoff plainly.

Possible policies:

| Policy | Density | Blast radius |
| --- | --- | --- |
| Per grain | Worst | One grain |
| Per user/account | Good | One user's grains |
| Per app package | Good | Same app across users |
| Whole server | Best | Whole server |

Per-user is likely the best first shared mode because it improves density while
limiting cross-user risk.

Availability is a separate risk from confidentiality. One grain that spins,
allocates aggressively, or triggers pathological workerd behavior can affect
other grains in the same host. OSS workerd's per-isolate resource limits are
not equivalent to Cloudflare's production controls. The shared host design must
include watchdogs, restart policy, memory headroom, and overload behavior, and
must keep per-grain sidecar mode available when operators prefer stronger
failure isolation.

The `isolate-host` sandbox profile is also a design task. A shared host
aggregates many grains' storage file descriptors and SandstormCore
connections, so the host's filesystem, network, and syscall restrictions must
be reviewed as a new multi-grain trusted component.

### Storage Mediation

Storage must remain per-grain:

- Each worker gets a storage binding rooted at that grain's directory.
- The root is bound by host C++, not by a JS-provided grain ID.
- Symlink/path traversal defenses stay in the storage service.
- Quota/reporting remains per grain.
- `syncStorage` and `reportGrainSize` map to the correct grain.

Tests:

- Two grains in the same workerd cannot read each other's storage.
- Storage survives worker eviction.
- Quota/reporting remains per grain.
- Path traversal tests pass in shared mode.

### Lifecycle

Map classic lifecycle calls to host operations:

- Grain start instantiates a worker.
- Grain shutdown evicts that worker and severs its live RPC handles.
- Keepalive tracks grain activity.
- Eviction breaks live handles; durable tokens remain restorable.
- Logs are tagged by grain.

Exit criteria:

- Multiple example grains for one user run in one workerd host.
- Per-grain sidecar mode still passes the full suite.
- Storage isolation tests pass.
- Memory and startup costs are measured and documented.

## Phase 5: Colocated Fast Path

### Goal

Provide the same generated Cap'n Proto API with much lower latency when caller
and callee are colocated in the same workerd host.

This phase depends on:

- Phase 1: authority is already one Cap'n Proto reference model.
- Phase 4: there are real colocated cross-grain pairs.

### Transport

The fast path is a native workerd extension implementing a Cap'n Proto
transport over transferred `ArrayBuffer`s. Cap tables and revokers must live in
trusted C++ outside both app isolates. A broker isolate is not the target
architecture because it adds another transfer hop and puts enforcement back in
a JS heap.

The transport flow:

1. Caller generated client builds a Cap'n Proto message.
2. Trusted runtime transfers the message backing buffer to the callee isolate.
3. Callee generated server reads fields lazily from the buffer.
4. Response follows the same path back.

The message format is identical to WebSocket/native RPC. The generated code is
identical. Only the transport binding differs.

This avoids:

- WebSocket framing.
- Unix socket hop to supervisor.
- Supervisor event-loop dispatch.
- Re-encoding into a per-export callback session.
- Decode/re-encode layers.

It does not require sharing JS objects between isolates.

### Cap Tables

The hard part is capability slots. Message bytes transfer easily; capability
descriptors are indices into a cap table owned by a connection.

The trusted host must own, per colocated link:

- Import table.
- Export table.
- Promise/answer table.
- Release accounting.
- Cap-table translation when messages cross from one isolate link to another.
- Flow-control state and bounded queues.

Rules:

- App JS never constructs cap descriptors directly.
- A capability can cross a fast link only if it is present in the source link's
  cap table.
- Passing a fast-path capability to a non-colocated party re-materializes it as
  a host/supervisor-mediated capability.
- Refcount/release semantics must match the WebSocket path.
- Transfer queues must apply backpressure. An unbounded queue lets one grain
  consume host memory by sending faster than a colocated peer can receive.

### Revocation

The host owns revokers outside both JS heaps:

- Fast-path links are revocable forwarders.
- Permission/membrane revocation severs the forwarder.
- Calls after revocation fail the same way as slow-path calls.
- In-flight calls must either fail deterministically or complete according to
  the same semantics as the slow path.

Neither caller JS nor callee JS can be trusted to enforce revocation.

### E-Order And Embargoes

Do not migrate live capabilities from slow to fast transport.

Binding rule:

- At claim/restore/import time, the trusted host decides whether the target is
  colocated.
- It creates either a fast-path binding or a normal binding.
- That live handle never changes transports.
- Capabilities resolved from promised answers inherit the transport binding of
  the connection they resolved on. They are not promoted to a new fast path
  merely because the final target is colocated.

This avoids calls overtaking earlier calls queued on a different transport. If
future work wants mid-stream promotion, it must implement Cap'n Proto embargo
semantics properly.

### App Observability

Apps must not be able to observe or depend on colocation:

- Same API.
- Same schemas.
- Same generated classes.
- Same errors, modulo timing.
- Same revocation behavior.
- Same persistence behavior.

Performance counters may exist in debug/metrics surfaces, but not as a
capability semantic.

### Benchmarks

Benchmark both forced modes:

- Fast path disabled: WebSocket/supervisor path.
- Fast path enabled: transferred-buffer path.

Cases:

- Small unary calls.
- Medium payload structs.
- Large byte payloads, with guidance that large streaming data should still use
  fetch/data-plane protocols where appropriate.
- Capability return and pipelined call.
- Multiple outstanding calls.
- Revocation during load.

Target:

- At least 10x lower small-call latency compared with the WebSocket path.
- Equal semantics in the integration suite with fast path forced on/off.

Exit criteria:

- Full native-capnp integration suite passes with fast path on and off.
- Cap-table translation tests cover capability passing in both directions.
- Revocation tests prove host-side kill switch works.
- Benchmarks meet target or explain why not.

## Phase 6: Stabilization

Only after Phases 1 through 5 meet exit criteria:

- Freeze `isolate-bridge.capnp`.
- Freeze app-facing `sandstorm:api` surface.
- Freeze `IsolateConfig` manifest fields.
- Freeze persistence formats.
- Adopt compatibility-date policy for runtime behavior.
- Enforce additive schema evolution with ABI checks.
- Rewrite `docs/developing/isolate-grains.md` as the primary public doc.
- Retire or clearly label interim working docs.
- Remove "experimental/not stable" warnings.

## Security Review Checklist

### Authority

- Can app code acquire authority without receiving a capability or token?
- Can app code forge an authority-bearing local ID?
- Does any HTTP route still mutate authority?
- Are durable tokens scoped to the owning grain as in classic Sandstorm?
- Are request tokens still short-lived and session-bound?

### Revocation

- Who owns each revoker?
- Is the revoker outside both app JS heaps?
- Does permission revocation break restored and fast-path capabilities?
- Are in-flight calls handled consistently?
- Are release/drop semantics observable and tested?

### Confused Deputy

- Does the worker ever supply a grain ID, supervisor ID, session ID, or export
  ID that the supervisor trusts as authority?
- Are session-specific operations routed through the actual `SessionContext`
  capability?
- Does browser Powerbox claim validate source/session?

### Cap Tables

- Are capability descriptors always derived from an existing table entry?
- Are imported/exported caps released exactly once?
- Are promised answers and pipelined capabilities preserved across transports?
- Does handoff from fast path to slow path preserve authority and revocation?

### Shared Runtime

- What is the configured trust domain?
- Can one worker access another worker's storage?
- Can one worker reach another worker's bindings by name?
- What happens after a V8 escape?
- Is per-grain sidecar mode still available?

### Supply Chain

- Is capnp-es pinned and reproducible?
- Is generated code deterministic?
- Are runtime updates reviewed like platform code?
- Are bootstrap schema ABI changes checked?

## Testing Matrix

| Area | Tests |
| --- | --- |
| Bootstrap RPC | open, reconnect, close, broken old handles |
| Save/restore/drop | legacy cap, isolate export, wrong interface, dropped token |
| Powerbox | claim, required permissions, expired token, offer, fulfill, tieToUser |
| Fetch sugar | WebSession, ApiSession, outbound HTTP, headers, streaming |
| Exports | isolate to legacy, legacy to isolate, isolate to isolate |
| Browser peer | generated client, Powerbox claim, session auth, origin checks |
| Persistence | native export format, route-backed format, migration |
| Request/context churn | many simultaneous sessions, reconnect, context close mid-call, eviction mid-call |
| Shared workerd | storage isolation, lifecycle, logs, quotas, watchdogs, host restart, memory pressure |
| Fast path | forced on/off parity, cap passing, revocation, pipelining, backpressure |
| Fuzz | frame parser, bootstrap params, cap-table translation |

## Implementation Sequencing

Suggested commit-sized chunks:

1. Write the workerd `IoContext` design note and choose the Phase 1
   implementation mode: request-scoped JS connections now, native workerd
   binding later.
2. Add the minimal bootstrap needed to obtain `Grain.SandstormApi` and
   same-session `Grain.SessionContext`, keeping it request-context scoped in
   the JS implementation.
3. Add worker-side classic persistence hooks: app-provided capabilities can
   implement `AppPersistent.save()`, and the worker exposes
   `MainView.restore/drop()` semantics to the supervisor.
4. Rebuild trusted JS `Capability` wrappers around live RPC references in the
   current request context.
5. Move native restore to `SandstormApi.restore()` over the request-scoped RPC
   channel.
6. Move native save/drop to `SandstormApi.save/drop()` over the same channel.
7. Move Powerbox claim to `SessionContext.claimRequest()`.
8. Move offer/fulfill/tieToUser to direct `SessionContext` RPC calls.
9. Move exports to passed capabilities plus `AppPersistent`/`MainView`
   persistence; remove export-registration as an app-facing concept.
10. Move fetch sugar to live `WebSession`/`ApiSession`/`OutboundHttpSession`
   references.
11. Delete lifecycle envelope.
12. Delete authority POST routes, including fetch-shaped `/powerbox/fetch`
   routes.
13. Delete claimed-capability string-ID authority table.
14. Delete per-export callback sessions.
15. Delete local-dispatch lease and temporary direct-client fast path.
16. Add Phase 1 boundary fuzzing and concurrency/churn stress tests.
17. Update public docs and architecture review to describe the simplified
   model.

Each chunk should keep the integration suite passing. Temporary dual paths are
acceptable only when the commit message and roadmap identify the deletion
target.

## Open Design Decisions

### Bootstrap Schema Minimalism

Should the bootstrap be a small `IsolateBridge` that returns existing
`Grain.SandstormApi` and `Grain.SessionContext` capabilities, or a larger
isolate-specific API that wraps common operations?

Decision: start small. Prefer existing schemas unless the wrapper removes real
complexity without creating new authority semantics. The bootstrap returns
`Grain.SandstormApi` and same-session `Grain.SessionContext`; app persistence
uses classic `AppPersistent` and `MainView.restore/drop`.

### Typed Restore Validation

Should expected interface ID/name be validated in supervisor restore, or should
the generated client simply fail if the restored cap does not implement the
interface?

Decision: do not add `restoreForInterface()` as a supervisor authority method.
Wrong-interface use is not an escalation; it should fail as a normal Cap'n
Proto call or as a helper-side diagnostic.

### Export Persistence

Should `exportNative()` return a live cap only, requiring explicit
`SandstormApi.save()` for durability, or return a capability already wrapped as
persistent?

Decision: no `exportNative()` registration concept in the target model.
Passing a live capability exports it for the current connection/context.
Durability is classic `AppPersistent.save()` plus `MainView.restore/drop()`.

### Browser Export Support

Should browser peers ever be allowed to export capabilities?

Bias: not in the first stable version. Browser bootstrap should be
session-scoped and narrower than worker bootstrap.

### Shared workerd Trust Domain

What grouping policy should be default?

Bias: per-user/account first, with per-grain sidecar as paranoid mode.

### Fast Path Timing

Should a self-colocated fast path be prototyped before shared workerd?

Bias: only after Phase 1, and only if it uses the same future transport model.
Do not resurrect leases or JS object shortcuts.

### Workerd IoContext Mode

Should Phase 1 use per-request JS connections, a long-lived inbound worker
session, or a native workerd binding?

Decision: define Phase 1 semantics around request-scoped live handles and
classic restore-hook dispatch. Implement with per-request JS connections until
native workerd support exists. The native workerd binding is the long-term
optimization and the right home for shared cap tables, revokers, and
transferred-buffer fast paths.

## Reviewer Critique Prompts

Please critique:

- Whether the minimal bootstrap plus classic `AppPersistent`/`MainView`
  persistence is sufficient for isolate authoring ergonomics.
- Whether the request-scoped JS implementation is acceptable until native
  workerd support exists.
- Whether Phase 2 should happen before all Phase 1 deletion is complete.
- Whether shared workerd per-user grouping is acceptable for Sandstorm.
- Whether transferred-buffer fast path should be implemented as a workerd C++
  extension exactly as proposed.
- Whether the no-live-migration plus promise-resolution inheritance rule is
  sufficient to avoid embargo complexity.
- Whether capnp-es is mature enough to be the authority runtime after the
  proposed hardening.
