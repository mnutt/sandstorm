# Cap'n Proto-First Isolate Interface Migration Plan

## Status

This document is a design and migration plan, not a description of the current
runtime contract. It proposes making Cap'n Proto capabilities the foundational
interface to isolate workers. `UiView`, `WebSession`, and Fetch remain useful
application-level interfaces, but they stop being mandatory layers for workers
that export some other Cap'n Proto interface.

The existing isolate APIs are compatibility-sensitive. The migration should be
additive until the replacement path has equivalent lifecycle, security,
observability, and performance coverage. Existing fetch-style isolate apps and
saved capabilities must continue to work throughout the transition.

Implementation checkpoint (2026-07-19): the native host now exposes a hidden
worker-global Cap'n Proto bootstrap and schedules top-level RPC messages as
workerd custom events. The event ABI has a native frame sink plus an
`awaitIo()`-backed source for callback replies, so a JS server can call a native
capability parameter and resume in the originating event context without a
synthetic Fetch request. Serial typed calls and a bidirectional callback are
covered by the host integration test. At this checkpoint it was still a Phase
1 prototype: named exports, concurrent-call routing, cancellation,
promise-capability resolution, pipelining, and public SDK syntax remained to be
implemented.

Implementation checkpoint (2026-07-20): the additive Phase 2 native-host path
now has a schema-opaque `IsolateExportBroker`. Version 2 worker handoffs declare
`(name, interfaceId)` exports, `HostedIsolate.getExport()` rejects undeclared or
mismatched lookups, and the worker runtime can register arbitrary generated
server interfaces behind one broker connection. The native-host integration
test resolves `IsolateBridge` by name and exercises a typed callback without an
HTTP adapter. Version 1 handoffs remain accepted.

Implementation checkpoint (2026-07-20): package manifests can now declare
named `(name, interfaceId)` exports, and the per-grain `Supervisor.getExport()`
capability forwards their lookup opaquely through the account host. The
account-host integration test calls a worker `NativeGreeter` directly, runs a
second grain in the same workerd process, and verifies that grain shutdown
revokes the returned capability. Public SDK syntax, concurrency, cancellation,
and full Cap'n Proto protocol routing are not yet implemented.

Implementation checkpoint (2026-07-20): the public isolate SDK now provides
`defineWorker()` and `serveCapnp()`. Applications declare named generated
servers without importing the private frame transport or implementing the
reserved workerd event. Each eager, worker-global server target is constructed
during module evaluation. Its methods receive event-scoped
`{ env, ctx, signal }` as a second argument; the generated results builder
remains an optional third argument. Fetch remains an independent, optional
worker handler. Lazy export factories can be added later without changing the
registry shape if measurements justify them.

Implementation checkpoint (2026-07-20): the account-host integration test now
holds one public worker RPC event open on a callback while a second call runs,
proving that overlapping calls receive distinct workerd execution contexts and
that the first call resumes after its callback. It also shuts down a grain with
a call still blocked and verifies that the caller is rejected.

Implementation checkpoint (2026-07-20): client-initiated cancellation now
works end-to-end for top-level worker calls. The supervisor's schema-opaque
export forwarder opts into KJ cancellation so `Finish` propagates across the
account-host boundary. The native host routes that `Finish` into the original
call's event input queue rather than scheduling a second workerd event. The JS
transport aborts the call's `AbortSignal`, settles capnp-es's server answer,
suppresses its synthetic stale `Return`, and lets the original event close
before a subsequent stream write proceeds. The account-host integration test
cancels an eagerly evaluated native call, observes signal-driven cleanup, and
then successfully reuses the export.

Implementation checkpoint (2026-07-20): promise-pipelined calls now preserve
the protocol pipeline without borrowing their parent call's workerd context.
The native host holds a `Call` whose target is an unresolved `promisedAnswer`
until the worker emits the parent `Return`, then schedules the child as its own
RPC event. A child canceled while waiting is closed without starting a JS
event. Deferred calls are bounded both per parent answer and per connection.
The native-host test covers unresolved export pipelining, cancellation before
dispatch, callback traffic, and subsequent connection reuse; the account-host
test pipelines a call onto a worker-returned capability through the supervisor.

## Summary

The target model is:

```text
                              named Cap'n Proto export
client capability  <------------------------------------------>  worker JS
                         Sandstorm membranes and workerd
                              per-call RPC event

browser/shell  <->  UiView / WebSession  <->  optional JS UI adapter  <->  fetch handler
```

A worker is a host for named, schema-defined Cap'n Proto capabilities. An app
may export a `UiView` or `WebSession` capability for its normal grain UI, a
domain-specific capability such as `SearchIndex`, both, or neither. A typed
`SearchIndex` call does not pass through `WebSession`, HTTP-over-Cap'n-Proto,
KJ HTTP, `Request`, or `Response`.

For conventional browser applications, Sandstorm should provide a library
adapter that implements the standard UI interfaces and presents the familiar
Worker `fetch(request, env, ctx)` API. In that path the UI-to-Fetch translation
still exists, but it is local to the worker and is used only because the app
selected the Fetch facade.

This is more than a change to the JavaScript helper API. It requires a
first-class workerd event source for incoming capability calls, generic worker
exports in the Sandstorm host protocol, lifecycle rules for exported
capabilities, and eventually shell/package support for grains that have no
`UiView` at all.

## Goals

- Make arbitrary Cap'n Proto capabilities the base worker interface.
- Allow typed RPC from a client to worker JavaScript without HTTP or
  `WebSession` translation.
- Schedule every top-level inbound RPC call with its own workerd request
  context, limits, cancellation, tracing, and `waitUntil()` lifetime.
- Let capability objects and Cap'n Proto connections live at worker scope
  without keeping a synthetic Fetch request open.
- Preserve Sandstorm's existing capability membranes, save/restore behavior,
  revocation, Powerbox mediation, and browser handoff rules.
- Retain the current account-shared workerd process topology and grain
  isolation boundaries.
- Keep Fetch ergonomics for UI apps through an optional facade rather than
  making Fetch the transport for every capability.
- Provide an incremental migration path with measurable parity at each stage.

## Non-goals

- Replacing Cap'n Proto RPC with a JavaScript-object or JSON RPC protocol.
- Making `WebSession` the universal worker bootstrap interface.
- Exposing grain IDs, account-wide service locators, or ambient authority to
  workers.
- Moving persistence, membrane enforcement, Powerbox policy, or token minting
  into untrusted JavaScript.
- Replacing the shell's browser-serving behavior in the first implementation
  phase.
- Requiring every Sandstorm platform API to become a typed worker binding
  before arbitrary app-defined capabilities can use the new path.
- Changing the one-workerd-host-per-account, one-worker-per-grain process
  model.

## Current State

Today the account host starts a dynamic workerd worker with three
supervisor-backed Fetcher bindings and a private
`__SANDSTORM_NATIVE_CAPNP` byte-channel factory. The native host exposes the
worker itself through `HostedIsolate.getHttpService()`.

The normal inbound path is therefore:

```text
shell WebSession call
  -> isolate account host converts the method to a Fetch-shaped request
  -> KJ HttpClient
  -> HttpService capability over the account-host/native-host socketpair
  -> native host converts back to KJ HTTP
  -> workerd fetch event
  -> worker fetch(request, env)
```

The KJ HTTP objects are in-memory C++ request abstractions, not textual HTTP/1
or TCP traffic, but the path still imposes HTTP semantics on every primary
worker interaction.

Typed Cap'n Proto between isolates already avoids HTTP after a connection is
established. capnp-es runs over the private native byte channel and the trusted
account host proxies capabilities to the rest of Sandstorm. However, the
channel is opened from request-scoped JavaScript. Long-lived server
capabilities currently depend on keeping a synthetic system Fetch request and
its RPC connection alive. `IsolateBridge.registerMainView()` makes this
explicit: its call remains pending for the registration lifetime.

That is a useful proof that JavaScript can implement and export generated
interfaces, but it is not the desired worker lifecycle. It associates many RPC
calls with one Fetch event's `IoContext` and limit enforcer, and makes worker
capability availability depend on a hidden HTTP route.

The shell-facing boundary is also still fixed. `Supervisor.getMainView()`
returns `UiView`; opening a grain creates a `WebSession` or `ApiSession`; and
the account host implements those session capabilities in C++ by forwarding
to Fetch. Package actions and the shell's grain-opening flow assume that a
grain has a main view.

The main current implementation points are:

- `patches/workerd/0001-add-sandstorm-isolate-host-target.patch` for the
  workerd embedding hooks;
- `isolate-host/isolate-host-main.c++` for the native dynamic-worker host,
  HTTP ingress, and native byte channel;
- `src/sandstorm/isolate-host.capnp` and
  `src/sandstorm/isolate-worker-source.capnp` for the account-host/native-host
  control and handoff protocols;
- `src/sandstorm/isolate-supervisor.c++` for worker lifecycle, route-backed
  sessions, trusted capability proxying, and MainView registration;
- `src/sandstorm/isolate-bridge.capnp` for the current worker bootstrap;
- `src/sandstorm/isolate/capnp-runtime.js` for the capnp-es transport and
  export helpers; and
- `src/sandstorm/supervisor.capnp`, `src/sandstorm/grain.capnp`, and
  `src/sandstorm/package.capnp` for the shell-facing and package contracts.

## Target Architecture

### Worker capability exports

A worker module declares a set of named Cap'n Proto exports. Each declaration
has:

- a stable export name;
- a generated interface class, including its 64-bit type ID;
- a server target or a factory for one;
- lifecycle metadata, where needed; and
- an optional platform role such as `mainView`.

The exact JavaScript syntax should be selected during the SDK phase, but the
intended shape is approximately:

```js
import { defineWorker, serveCapnp, webSessionFromFetch } from "sandstorm:api";
import { SearchIndex } from "capnp:./search.capnp";

export default defineWorker({
  capabilities: {
    search: serveCapnp(SearchIndex, new SearchIndexImpl()),

    // Optional. Only this export carries UI and Fetch semantics.
    ui: webSessionFromFetch({
      async fetch(request, env, ctx) {
        return new Response("hello");
      },
    }),
  },
});
```

`defineWorker()` and `serveCapnp()` are now the implemented SDK names. The UI
facade remains illustrative; the important contract is the named capability
registry rather than JavaScript module introspection.

The package manifest declares the public identity and role of exports so that
Sandstorm can validate them without running untrusted code. Runtime
registration must match the manifest's export name and interface ID. A worker
cannot gain authority by claiming an interface; this declaration only says
which capabilities the worker provides.

### Generic host bootstrap

`HostedIsolate` should gain a generic export operation, conceptually:

```capnp
getExport @N (name :Text, interfaceId :UInt64) -> (cap :Capability);
```

The exact schema may return a dedicated lease capability or export metadata as
well. Authorization comes from possession of the grain-scoped
`HostedIsolate`, not from the export name. The native host must not offer a
global `grainId -> capability` lookup.

The native host resolves the named export inside the already-loaded dynamic
worker and returns the resulting capability through the account host. Once
obtained, calls use ordinary Cap'n Proto capability routing. The host does not
need to know the application's schema beyond checking the declared interface
ID.

The current `getHttpService()` remains during migration. Eventually it becomes
an implementation detail of a compatibility Fetch adapter rather than the
only worker ingress.

### First-class RPC events in workerd

The central workerd change is not merely a longer-lived `NativeByteChannel`.
The runtime needs a worker-scoped Cap'n Proto endpoint whose inbound calls are
scheduled as first-class events.

For each top-level inbound call, workerd must:

1. select and enter the target worker;
2. create a fresh `IoContext` and Sandstorm `LimitEnforcer` scope;
3. establish cancellation and disconnect propagation;
4. run the capnp-es server dispatch under that context;
5. account for CPU, subrequests, memory, logging, and tracing to the grain and
   call;
6. keep the event alive for its returned promise and explicit `waitUntil()`
   work; and
7. release the per-call context without destroying worker-scoped capability
   objects or the RPC connection.

The implementation must define “top-level call” carefully. Cap'n Proto allows
pipelining, callbacks, promise capabilities, cancellation, and concurrent
messages on one connection. A transport-message callback is not necessarily
the correct accounting boundary. The workerd prototype should prove that an
inbound `Call` and its asynchronous dispatch receive one event context while
`Return`, `Resolve`, and protocol bookkeeping do not accidentally create or
inherit unrelated request budgets.

The capnp-es connection, export table, and server objects live at worker scope.
They may schedule work only through the event mechanism; they must not retain
an expired `IoContext` between calls. This removes the current need for a
permanently pending Fetch response.

Cancellation is deliberately delivered through the original event. workerd
does not permit an `AbortController` created in request context A to be aborted
from request context B. The native router therefore associates each inbound
`Call.questionId` with that call's event input queue. Callback `Return` frames
and the call's eventual `Finish` are fed through this queue, so capnp-es and the
application-visible signal resume under the same `IoContext` that created
them. A `Finish` write remains pending until the event closes, preventing the
next call on the connection from overtaking cancellation cleanup. Connection
shutdown is the stronger fallback: native event controls abort every remaining
`IoContext` and reject outstanding calls.

### Capability lifecycle

The new path needs explicit rules for three different lifetimes:

1. **Named exports.** Resolving a manifest-declared export starts or wakes the
   worker. The name remains valid across worker eviction, but a particular live
   capability incarnation may disconnect when the worker crashes or is
   forcibly evicted.
2. **Transient child capabilities.** Capabilities returned from calls pin the
   worker or a lightweight worker lease while they remain reachable. They are
   released by Cap'n Proto reference lifetime and explicit application
   cleanup. They are not silently reconstructible after a crash.
3. **Durable capabilities.** Saving still goes through trusted Sandstorm
   persistence machinery. A saved object contains a stable app object ID, not
   V8 identity. Restoring starts the worker and asks its durable-object
   registry or `AppPersistent` implementation to recreate the capability.

An idle worker may be evicted only when it has no active calls, `waitUntil()`
work, live connection lease requiring it to stay resident, or other host pin.
The implementation should avoid pinning a worker merely because a remote vat
retains a bootstrap connection with no live exported references. Exact lease
and idle timeout behavior must be documented and tested.

Sandstorm remains responsible for wrapping app-realm persistence in
`SystemPersistent`, applying membrane requirements, revoking saved tokens,
and reconnecting after supervisor restarts. JavaScript implements application
interfaces and application object restoration; it does not mint or interpret
Sandstorm's durable authority format.

### Optional UI and Fetch facade

UI support should be built on the generic capability path rather than wired
into it.

The full-fidelity form is a worker-exported `MainView`/`UiView` whose methods
and returned session capabilities are implemented with capnp-es. Session
parameters and `SessionContext` arrive as typed Cap'n Proto values and
capabilities. Sandstorm may wrap returned sessions where legacy shell code
requires the same object to implement `SystemPersistent`.

Most app authors should not have to implement `WebSession` methods manually.
A Sandstorm library should provide a facade that:

- implements `MainView`, `UiView`, `WebSession`, and optionally `ApiSession`;
- maps session methods to Fetch `Request` objects;
- maps Fetch `Response` objects, streams, and WebSockets back to session
  results;
- exposes session metadata through the normal `sandstorm:api` facade; and
- preserves a separate event context for each incoming session call.

This translation occurs inside the worker because the app chose the Fetch
facade. A worker exporting only `SearchIndex` never loads the UI facade and has
no `WebSession`, KJ HTTP, or Fetch request in its call path.

### Typed platform bindings

The initial implementation can retain the existing `SANDSTORM_API`, `STORAGE`,
and `POWERBOX` Fetcher bindings while changing inbound app-defined RPC. They
are explicit capabilities and remain confined to the grain, but they still
carry private HTTP routing baggage.

After the generic event path is stable, expose platform services as typed
Cap'n Proto clients where schemas exist or can be defined cleanly. At minimum:

- expose the grain's `SandstormApi` capability directly;
- expose Powerbox and session-context capabilities through typed APIs;
- define a typed storage interface before replacing the storage Fetcher; and
- keep an optional Fetcher adapter for outbound HTTP and compatibility.

This later phase makes a fully typed, headless worker free of HTTP on both its
inbound and platform-service paths. It should not block the core export work.

### Shell and package model

Traditional supervisors and existing shell code continue to provide
`Supervisor.getMainView()`. For isolate workers, the supervisor can implement
that method by resolving the export assigned the `mainView` role. This allows
the shell to use the generic worker capability without changing immediately.

To support genuinely headless or service-only grains, Sandstorm later needs a
generic supervisor operation and package metadata for named exports. The shell,
Powerbox, and package actions must stop assuming every action result is a
`UiView`. A package should be able to declare:

- an optional primary UI export;
- one or more named typed service exports;
- Powerbox descriptors derived from their interface IDs; and
- actions that create a grain and return a selected typed export without first
  opening a browser session.

The current `bridgeConfig` remains relevant only to UI/fetch exports. It should
become optional for a service-only isolate command.

## Security Invariants

The migration must preserve these properties:

- The native workerd host still receives no grain filesystem root.
- The account host supplies only freshly attenuated, grain-scoped services.
- Export resolution requires possession of the grain's host/supervisor
  capability; names and grain IDs are not bearer credentials.
- Manifest interface IDs are checked against worker registrations, but type
  IDs never grant authority.
- All worker-originated capabilities pass through Sandstorm's trusted
  capability proxy and membrane logic before crossing grain/account realms.
- Saving, restoring, revoking, and browser handoff remain mediated by trusted
  Sandstorm code.
- Browser RPC receives only capabilities explicitly handed to that browser
  session; it never receives the worker's full bridge bootstrap.
- Each inbound call receives independent resource accounting and cannot reuse
  an expired request context.
- Message sizes, nesting, stream buffering, concurrent calls, and outstanding
  promises have enforced limits.
- Worker crash, forced eviction, token revocation, client disconnect, and
  account-host death promptly reject affected calls and release leases.

## Migration Phases

### Phase 0: Lock down the current baseline

Before changing transport ownership, add or preserve integration coverage for:

- same-worker and cross-grain typed calls, callbacks, pipelining, cancellation,
  and large payloads;
- current WebSession streaming and WebSocket behavior;
- save, restore, revoke, drop, and browser handoff;
- worker idle eviction and restart;
- native-host and account-host crash recovery;
- per-grain CPU, subrequest, memory, and log attribution; and
- attempts to cross grain or account capability boundaries.

Record latency and throughput for direct typed RPC and the current UI path.
These tests become the acceptance baseline rather than tests of a particular
private bridge implementation.

### Phase 1: Prototype a workerd RPC event source

Add the smallest generic workerd embedding API that can host a worker-scoped
binary RPC endpoint and schedule independently accounted events into a dynamic
worker. Keep Sandstorm schema policy and capability routing in the embedding
binary, not in workerd.

Prototype capnp-es dispatch with concurrent calls, callbacks, pipelining,
cancellation, `waitUntil()`, exceptions, and worker shutdown. Prove that no
handler observes another call's `IoContext` or budget. Add focused workerd
tests before connecting the feature to the shell.

Where possible, design this as an upstreamable generic event-source/embedding
hook. Sandstorm's current patches for dynamic worker loading, per-worker limit
enforcers, direct environment capabilities, and worker-tagged logs remain
necessary; the request-scoped `NativeByteChannel` patch can then be narrowed or
replaced by the worker-scoped RPC event primitive.

Exit criteria:

- an arbitrary generated interface is served from JS with no synthetic Fetch
  request;
- two concurrent calls have separate limits and cancellation;
- capability parameters, results, callbacks, and promise pipelining work; and
- worker teardown closes every outstanding call and connection cleanly.

### Phase 2: Add generic named exports to the native host protocol

Extend `IsolateWorkerSource` with versioned export declarations and extend
`HostedIsolate` with generic export resolution. Reject undeclared names,
duplicate names, interface mismatches, and incompatible handoff versions.

The account host should proxy returned capabilities opaquely. It may attach
leases, logging identity, and membrane wrappers, but must not translate
application method calls into HTTP. Retain `getHttpService()` unchanged for
existing fetch workers.

Exit criteria:

- an account host can resolve and call an arbitrary worker export by
  capability possession, name, and expected interface ID;
- the typed call path contains no HttpService or KJ HTTP adapter; and
- workers in the same workerd process cannot resolve one another's exports.

### Phase 3: Introduce the worker export SDK

Add the public JavaScript/TypeScript API for declaring named generated
interfaces. Generate types from capnp-es metadata and avoid exposing transport,
connection, or capability-table internals.

Decide and document:

- the exact registry syntax and initialization timing;
- whether server targets are eager or factory-created;
- duplicate-name and interface-mismatch diagnostics;
- how worker-global state is separated from per-call context;
- how handlers access `env`, event context, and `waitUntil()`;
- transient export disposal; and
- durable export registry and migration rules.

The current `capnpClient()` and `exportCapnp()` helpers should converge on this
one worker-scoped connection and capability lifecycle instead of opening
parallel request-scoped sessions.

Exit criteria:

- a TypeScript app can export and consume an arbitrary generated interface
  without raw transport APIs;
- type checking catches missing methods and interface mismatches; and
- worker-global server objects cannot accidentally retain a prior call's
  request context.

### Phase 4: Integrate persistence, membranes, and worker leases

Route named and returned worker capabilities through the existing Sandstorm
save/restore and realm-translation machinery. Add new persisted object variants
additively; do not reinterpret existing token payloads. Existing saved
capabilities must continue to restore through their original path.

Define eviction behavior for live transient capabilities and add an explicit
host lease if Cap'n Proto reference tracking alone cannot safely decide worker
residency. Test restoration after worker eviction, native-host restart, account
host restart, app upgrade, and missing durable registry entries.

Exit criteria:

- live references have deterministic disconnect/lease behavior;
- durable references restore into a new worker incarnation;
- revocation and membrane requirements behave identically to traditional grain
  capabilities; and
- no idle connection keeps an account's workers resident forever.

### Phase 5: Build the UI/WebSession facade on generic exports

Implement the standard UI capability stack in JavaScript/capnp-es and layer the
Fetch facade over it. Initially run it in dual-path integration tests against
the current C++ route-backed session adapter.

The facade must cover all currently supported behavior, including session
types, identity and permission metadata, request/offer sessions,
`SessionContext`, streaming request and response bodies, ETags/range metadata,
cookies, redirects, WebSockets, cancellation, and session persistence.

Once parity is demonstrated, make new compatibility dates use the generic
Cap'n Proto UI export. Keep the old Fetch ingress for existing apps and as a
rollback path until its compatibility window ends.

Exit criteria:

- shell UI conformance tests pass through the JS-exported capability path;
- each WebSession method receives its own RPC event budget;
- streaming and WebSocket performance is acceptably close to or better than
  the current adapter; and
- a non-UI export does not instantiate any UI or Fetch adapter code.

### Phase 6: Support service-only grains in packages and the shell

Add manifest declarations and supervisor APIs for generic named exports.
Teach package actions and Powerbox flows to request a typed export directly.
Make `bridgeConfig` and `mainView` optional when no browser UI is declared.

The shell should continue to treat `UiView` specially for tabs, sharing roles,
and human-session policy. Generic service exports should appear only where an
action, Powerbox request, saved capability, or explicit API asks for their
interface. They must not be disguised as views.

Exit criteria:

- a grain with no `UiView`, `WebSession`, Fetch handler, or HTTP binding can be
  created, selected through Powerbox, called, saved, restored, and revoked; and
- traditional and Fetch-style grains remain unchanged from the user's
  perspective.

### Phase 7: Add typed platform services

Replace private Fetcher bindings incrementally with typed Cap'n Proto clients.
Keep compatibility adapters where Fetch semantics are intrinsic, especially
outbound HTTP. Remove private routes only after all supported compatibility
dates and development tooling no longer require them.

Exit criteria:

- a fully typed service worker can operate without constructing a `Request` or
  `Response`; and
- the only HTTP present in a UI worker is HTTP the app intentionally uses,
  such as its Fetch facade or outbound network access.

### Phase 8: Consolidate and remove obsolete paths

After compatibility and rollback requirements are satisfied:

- remove the synthetic MainView registration request;
- remove request-scoped native Cap'n Proto server sessions;
- reduce `HostedIsolate.getHttpService()` to a compatibility adapter or remove
  it when no supported app requires it;
- delete duplicate WebSocket/native bridge transports where browser handoff
  does not require them;
- narrow the workerd patch to generic embedding hooks; and
- update architecture and app-author documentation to describe capability
  exports as the primary model.

Do not remove old persisted-object readers merely because new writers no longer
emit those forms. Token compatibility is a data migration concern, not only an
API cleanup concern.

## Compatibility and Rollout

Use additive Cap'n Proto schema evolution throughout. New fields and methods
receive new ordinals, old union variants retain their meanings, and
`IsolateWorkerSource.formatVersion` rejects data it cannot safely interpret.

Gate app-visible behavior by compatibility date or an explicit compatibility
flag. A reasonable rollout order is:

1. hidden runtime flag for tests and examples;
2. opt-in manifest export declarations;
3. default capability path for newly packaged typed exports;
4. opt-in JS UI facade;
5. default JS UI facade for a new compatibility date; and
6. removal only after supported old dates and saved-object formats are covered.

The runtime should negotiate native bridge features independently of the
public JavaScript API version. A feature bit may advertise a new additive
transport operation; it must not silently change the meaning of an existing
operation.

## Validation and Performance Gates

Every phase should be covered at three levels:

- **workerd unit tests:** event context, cancellation, limits, shutdown, and
  dynamic-worker isolation;
- **native host/account host tests:** export resolution, capability proxying,
  eviction, crash behavior, and hostile worker inputs; and
- **end-to-end Sandstorm tests:** Powerbox, save/restore, browser handoff,
  shell UI, package actions, and cross-grain calls.

Track at least:

- zero-byte serial call latency;
- concurrent call throughput;
- large request/result and streaming throughput;
- per-call CPU and memory accounting accuracy;
- worker startup and export-resolution latency;
- idle worker/process memory; and
- capability and connection counts after drop, cancellation, eviction, and
  crash.

The generic typed path should have no HTTP adapters in a trace. The UI facade
may show a WebSession-to-Fetch conversion inside JavaScript, but it should not
round-trip through supervisor HTTP bindings merely to reach the same worker.

## Open Design Decisions

The following questions should be answered by prototypes rather than fixed by
the first schema sketch:

- Does a live exported capability pin the worker directly, or should the host
  issue a separate reference-counted lease?
- Should the UI facade export `MainView`, `UiView`, or a Sandstorm-owned
  bootstrap that produces the correct view capability?
- Which export metadata belongs in `Manifest.IsolateConfig`, and which belongs
  in action/Powerbox declarations?
- How are compatible schema upgrades advertised when an export retains its
  name but implements additional interfaces?
- Which platform Fetcher bindings are genuinely HTTP-shaped and should remain
  adapters?

These choices affect ergonomics and implementation size, but not the central
architecture: arbitrary Cap'n Proto capabilities are the worker boundary;
workerd schedules their calls as isolated events; and WebSession/Fetch is one
optional capability facade.
