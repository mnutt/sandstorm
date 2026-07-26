# Cap'n Proto-First Isolate Interface

## Status

Implemented as of 2026-07-26.

Cap'n Proto is the foundational interface to isolate workers. A worker exports
named, schema-defined capabilities. `MainView`, `WebSession`, and `ApiSession`
are ordinary choices of interface for UI applications, not mandatory transport
layers. A worker that exports a domain-specific interface has no WebSession,
HTTP, `Request`, or `Response` involvement in calls to that interface.

The migration is complete. The isolate runtime does not retain its former
Fetcher bindings, service bindings, HTTP ingress, native byte-channel API,
route-based MainView registration, or C++ Fetch adapter. Isolate worker-source
handoffs accept only format version 2, and the one-shot RPC-event prototype has
been removed.

The traditional `sandstorm-http-bridge` process and the older methods on the
platform-wide `WebSession` schema still serve non-isolate applications. They
are not isolate compatibility paths.

## Result

The two important paths are now:

```text
typed client capability
  -> Sandstorm Supervisor.getExport(name, interfaceId)
  -> account-host membrane and persistence wrapper
  -> HostedIsolate / worker-global Cap'n Proto connection
  -> one workerd RPC event for this top-level call
  -> capnp-es generated server in worker JavaScript
```

and, only when an application chooses the Fetch facade:

```text
browser / shell
  -> MainView and WebSession Cap'n Proto calls
  -> capnp-es MainView/WebSession implementation in worker JavaScript
  -> Request
  -> application fetch(request, env, ctx)
  -> Response
```

The second path translates between WebSession and Fetch inside
`src/sandstorm/isolate/api.js`. It exists to provide familiar web-worker
ergonomics. The account host and native workerd host do not translate worker
traffic to KJ HTTP.

## Application Contract

### Package declarations

`Manifest.IsolateConfig.exports` declares each public worker export as:

- a stable name;
- a 64-bit Cap'n Proto interface ID; and
- an optional role.

The `mainView` role identifies the one export that satisfies
`Supervisor.getMainView()`. An ordinary export is available only by exact name
and interface ID. A command with no `mainView` role is a valid service-only
grain; `getMainView()` returns UNIMPLEMENTED.

Isolate bindings contain only inert text, data, or JSON configuration. They
cannot carry service authority.

Package actions may return either:

- the command's `mainView`, which opens a browser grain; or
- a named capability export, which creates a headless grain and fulfills a
  matching Powerbox request directly.

A capability action declares its export name, interface ID, descriptor, and
display information. Packaging verifies that the named export exists and that
the descriptor contains the declared interface ID.

### Worker declarations

Workers use generated `capnp:` modules and the public `sandstorm:api` helpers:

```js
import { defineWorker, serveCapnp } from "sandstorm:api";
import { SearchIndex } from "capnp:./search-index.capnp";

const index = {
  async search({ query }, { env, ctx, signal }) {
    return { results: await performSearch(query, { env, ctx, signal }) };
  },
};

export default defineWorker({
  capabilities: {
    search: serveCapnp(SearchIndex, index),
  },
});
```

The package and worker declarations must agree on name and interface ID.
`defineWorker()` owns the reserved `sandstormRpcEvent` handler. Fetch-only
workers do not call it; Sandstorm's generated main-view entry adapter wraps
their default export instead. Each incoming top-level RPC call receives:

- a distinct workerd execution context;
- the worker's inert `env` bindings;
- an `ExecutionContext` with `waitUntil()`; and
- an `AbortSignal` tied to Cap'n Proto cancellation and worker shutdown.

Capability parameters and results remain Cap'n Proto capabilities. Promise
pipelining, callbacks, cancellation, and disconnection use the normal Cap'n
Proto RPC protocol.

### Durable exports

`serveCapnp()` optionally takes `restore(objectId)` and `drop(objectId)`
callbacks. A server object that implements `Grain.AppPersistent` returns its
application-defined object ID from `save()`.

Sandstorm records:

- export name;
- interface ID; and
- opaque application object ID.

Restore re-enters the same named export through
`IsolateExportBroker.restoreExport()`. Drop calls
`IsolateExportBroker.dropExport()`. The native host never interprets the object
ID.

Capabilities imported from elsewhere receive a narrowly scoped saver. Workers
do not gain ambient authority to persist arbitrary external capabilities.
Sandstorm continues to own token creation, revocation, membrane requirements,
Powerbox policy, and user requirements.

## Optional UI and Fetch Facades

For a worker that only needs its normal browser UI, default-export a
Cloudflare-style object:

```js
export default {
  async fetch(request, env, ctx) {
    return new Response("hello");
  },
};
```

The default export may instead be the fetch function itself. The object form
may also supply the optional `webSocket()` handler accepted by
`mainViewFromFetch()`. When the package declares a `mainView` export,
Sandstorm's generated entry module recognizes either form and wraps it as:

```js
defineWorker({
  capabilities: {
    ui: mainViewFromFetch({ fetch, viewInfo: {} }),
  },
});
```

This shorthand declares no `ViewInfo` metadata, durable object restoration, or
additional named exports. Workers needing those features use
`defineWorker()` and `mainViewFromFetch()` explicitly. `mainViewFromFetch()`
returns a typed `MainView` export. Its sessions are capnp-es implementations
of `WorkerWebSession` or `WorkerApiSession`, which extend the standard
Sandstorm session interfaces and `Grain.AppPersistent`.

The facade performs these conversions in worker JavaScript:

- WebSession method parameters become a `Request`;
- the live `SessionContext` and request metadata become the request-scoped
  `sandstorm(request, env)` facade;
- a `Response` becomes a WebSession response union;
- response bodies use Cap'n Proto byte streams;
- streaming request bodies use `Util.ByteStreamSource`; and
- WebSockets use message-oriented Cap'n Proto streams carrying text, binary,
  and close messages.

There is no HTTP server, socket, KJ `HttpClient`, or HTTP-over-Cap'n-Proto hop
between Sandstorm and the worker. Fetch vocabulary appears only inside the
facade because the application selected that API.

`webSessionFromFetch()` and `apiSessionFromFetch()` provide the same optional
facade for exported session capabilities that are not the grain's main view.
Because these are ordinary named capability declarations, they can also be
offered or used to fulfill a Powerbox request without first converting them to
an HTTP handle.

## Runtime and Process Model

The process topology is account-shared:

```text
Sandstorm backend
  |
  | one account control connection
  v
isolate-account-host process (one per account trust domain)
  |
  | private Cap'n Proto socketpair
  v
isolate-host process (one confined embedded-workerd process per account)
  |
  +-- dynamic worker: grain A
  +-- dynamic worker: grain B
  `-- dynamic worker: grain C
```

There is no wrapper process per isolate. The backend starts or reuses an
account host. The account host starts one native workerd host child and asks it
to load one dynamic worker per running grain.

The trusted account host:

- reads package modules and grain storage;
- validates and bounds the worker bundle;
- creates grain-scoped platform capabilities;
- implements `Supervisor`;
- applies persistence and user membranes; and
- restarts an evicted worker when necessary.

The native host:

- runs in a minimal mount namespace and chroot;
- has no grain filesystem root;
- receives module bytes, inert bindings, export declarations, and a
  grain-scoped bridge over Cap'n Proto;
- owns V8/workerd worker creation, eviction, limits, and RPC event scheduling;
  and
- hosts many grain workers but identifies and limits each independently.

The account host wraps workerd at two levels. `IsolateRuntimeHost` wraps the
private `HostedIsolate` control capability for a grain, while
`IsolateDirectMainView` and the generic worker membrane adapt exported
capabilities to Sandstorm lifecycle, persistence, browser-session, and security
rules. These wrappers forward Cap'n Proto calls; they do not turn them into
HTTP.

Stopping a grain removes its dynamic worker from the shared host, then completes
`Supervisor.shutdown()` with `DISCONNECTED`. This preserves the Supervisor
contract that shutdown never returns successfully even though the account-host
and native-host processes continue running for neighboring grains.

## Host Protocol

`src/sandstorm/isolate-host.capnp` defines the account-host/native-host control
plane:

- `IsolateHost.startGrain()` loads a bounded worker bundle and attenuated
  grain services;
- `HostedIsolate.keepAlive()` refreshes eviction;
- `HostedIsolate.stop()` evicts the worker;
- `HostedIsolate.getRpcBootstrap()` exposes the worker-global Cap'n Proto
  connection; and
- `HostedIsolate.getExport()` validates a declared name/interface pair and
  resolves it.

`src/sandstorm/isolate-worker-source.capnp` is the binary worker handoff. It
contains only modules, compatibility settings, inert bindings, and export
declarations. Version 2 is the only accepted format.

`src/sandstorm/isolate-exports.capnp` defines the schema-opaque
`IsolateExportBroker`. Application schemas are not linked into the native host.
The broker accepts the grain-scoped platform bridge as a capability argument,
so worker callbacks into Sandstorm use the same RPC connection rather than an
ambient binding or side channel.

`src/sandstorm/isolate-session-exports.capnp` is deliberately separate. It
contains the concrete persistent session interfaces used by the optional Fetch
facade; those UI details do not belong in the native host's generic protocol.

## RPC Event Scheduling

The native host maintains one worker-global two-party Cap'n Proto connection
per hosted grain. It inspects only Cap'n Proto RPC protocol messages, never
application schemas.

For each top-level `Call`, it schedules a workerd custom event and invokes the
reserved JavaScript `sandstormRpcEvent(request, send, receive, env, ctx)`
handler installed by `defineWorker()` directly or by the generated simple
Fetch adapter. Replies and callback traffic are routed back to that event
through an `awaitIo()`-backed queue.

Important lifecycle rules:

- concurrent top-level calls receive separate workerd `IoContext`s;
- callback returns resume the event that issued the callback;
- a pipelined call on a promised answer waits for the parent answer and then
  receives its own event;
- `Finish` aborts the call's signal and cancels work in its original event;
- per-answer and per-connection deferred-call counts are bounded;
- worker stop or eviction closes the connection and rejects live calls; and
- durable tokens survive process and worker lifetimes because their state is
  owned by Sandstorm, not the V8 heap.

## Browser Cap'n Proto

Browser code can receive a live capability through an opaque handoff ID.
Sandstorm serves generated browser schema modules and a restricted browser
client. The browser's Cap'n Proto frames travel in binary, message-oriented
WebSocket messages through `BrowserIsolateBridge`.

The bridge can resolve only capabilities explicitly handed to that browser
session or claim a Powerbox request for that session. It does not expose the
worker platform bridge, full `SessionContext`, grain IDs, or an account-wide
service locator.

Browser RPC is still native Cap'n Proto at the application layer. The
WebSocket is a browser transport for Cap'n Proto frames, not a conversion to
WebSession or HTTP method calls.

## Typed Platform Services

Platform authority is exposed through the private `IsolateBridge` capability
passed to the worker export broker. The public `sandstorm(request, env)` facade
uses narrow typed methods for:

- grain storage;
- save, restore, and revoke;
- view metadata and runtime status;
- named worker capabilities;
- browser handoffs;
- Powerbox claim, offer, fulfill, and user tying; and
- outbound HTTP as an explicit `OutboundHttpSession` capability.

Storage is `IsolateStorage`, not a Fetcher. Outbound HTTP is explicit authority
represented by its own Cap'n Proto interface; it does not make HTTP the worker
transport.

## Workerd Patch

`patches/workerd/0001-add-sandstorm-isolate-host-target.patch` is necessary
because upstream workerd does not expose all embedding seams needed by an
account-shared, capability-first host.

The patch contains only these runtime hooks:

1. A Bazel target for the Sandstorm native host and its private schemas.
2. Public `Server.loadDynamicWorker()` and `evictDynamicWorker()` embedding
   methods over workerd's loader namespace.
3. A `sandstormRpcEvent` module handler and custom-event execution path with
   `send`, `receive`, `env`, and `ctx`.
4. An optional dynamic-worker environment compiler used to materialize inert
   binary data bindings, which `Frankenvalue` cannot represent.
5. Isolate- and request-level limit-enforcer factories for dynamically loaded
   workers.
6. Stable worker identity in structured console records, so logs from an
   account-shared process remain attributable to a grain.

The patch does not add an HTTP ingress, service binding, native byte channel,
or direct capability in `env`.

The host implementation lives at `isolate-host/isolate-host-main.c++` because
it is compiled inside the external workerd Bazel source tree, with workerd's
private C++ embedding APIs. Sandstorm's account-host and supervisor code lives
in `src/sandstorm/`. Moving the host source to `src/isolate-host/` would work
after mechanical Makefile path changes, but would not change this build or
trust boundary; the top-level directory makes the separate build universe
explicit.

## Security Invariants

- The account trust domain determines host sharing; arbitrary worker input
  cannot choose it.
- Export lookup requires an exact manifest-declared name and interface ID.
- Internal worker-to-worker export lookup still requires possession of the
  grain-scoped platform bridge.
- The native host receives no grain filesystem root.
- Worker bundles, modules, bindings, frames, deferred calls, and export counts
  are bounded.
- Each top-level call gets workerd resource accounting and cancellation.
- Platform authority arrives only as an attenuated Cap'n Proto capability.
- Browser access is session-scoped and requires an explicit handoff or
  Powerbox claim.
- Persistence and membrane policy remain outside untrusted JavaScript.
- Stopping one grain revokes its live worker capabilities without stopping
  neighboring grains in the same account host.

## Removed Paths

The completed migration removed:

- `Manifest.IsolateConfig.bridgeConfig`;
- isolate service bindings;
- ambient `SANDSTORM_API`, `POWERBOX`, and `STORAGE` Fetcher bindings;
- `HostedIsolate.getHttpService()`;
- native-host KJ HTTP ingress;
- worker-global Fetch ingress;
- the private `NativeByteChannel`;
- request-scoped capnp-es connections;
- route-based MainView registration;
- the account-host C++ WebSession-to-Fetch adapter;
- the one-shot `HostedIsolate.invokeRpcEvent()` prototype;
- worker-source handoff version 1; and
- example and test fixtures for the removed paths.

## Validation

The release gate covers:

- workerd patch application and native-host build;
- host control, limits, cancellation, pipelining, callbacks, eviction, memory,
  and structured-log attribution;
- account-shared multi-grain behavior and backend recovery;
- typed MainView browser fetch and message-oriented WebSockets;
- service-only grains with no UI or HTTP facade;
- durable named exports, save/restore/drop, Powerbox actions, and browser
  handoffs;
- native Cap'n Proto streams and schema corpus interop;
- generated TypeScript declarations and public API surface;
- packaged `capnp:` module generation; and
- ABI baselines for every isolate protocol schema.

The relevant aggregate target is `make isolate-ci`; the complete repository
regression target remains `make test`.
