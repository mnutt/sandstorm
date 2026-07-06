# Isolate Powerbox V2

This document sketches a target architecture for isolate capabilities,
Powerbox, and app-defined protocols. It is a design plan, not a description of
the current isolate API.

The goal is to let isolate app authors define a capability protocol once and
use it from:

- the app frontend
- another isolate grain
- a legacy Sandstorm grain
- local tests outside Sandstorm

At the same time, cross-grain authority should continue to flow through
Sandstorm capabilities and Powerbox, not through ambient service names.

## Goals

- Isolates can define Cap'n Proto capabilities that legacy non-isolate grains
  can call.
- Isolates can define Cap'n Proto capabilities that other isolates can call.
- App authors do not need to install a separate Cap'n Proto C++ compiler.
- Isolates can be stubbed and tested outside Sandstorm.
- Calls are as inexpensive as practical.
- Isolates can call legacy Sandstorm grain capabilities.
- Isolates define a capability once and both frontend code and other isolates
  can call it.
- Fetch remains available for HTTP UI and large data-plane transfers.

## Non-Goals

- Let isolates call other grains by raw workerd service binding name.
- Expose a raw unrestricted native Cap'n Proto vat connection to isolate code.
- Make browsers speak the exact same transport as grains.
- Replace fetch for ordinary HTTP, static assets, streaming responses, or
  app-specific data-plane endpoints.
- Preserve compatibility with unreleased isolate prototypes.

## Current Model

Current isolate app-object RPC is JavaScript-defined and fetch-shaped at the
runtime boundary:

- App code exports JavaScript objects.
- Calls are serialized by Sandstorm's isolate helper code.
- The isolate calls supervisor helper routes such as
  `/powerbox/native-app-rpc-call`.
- The supervisor owns native capability handles.
- App-object RPC can dispatch locally for some local object capabilities.

This model is useful, but it is not yet a public Cap'n Proto protocol model.
The JavaScript class shape is not a stable schema that a legacy grain can
compile against. It also means the app-object RPC path carries JSON-shaped
values rather than native Cap'n Proto messages.

## Target Model

Use `.capnp` files as the public protocol source of truth. Generated bindings
provide the same authoring model over different transports.

```text
        one .capnp schema
              |
              v
  generated JS/TS bindings and metadata
              |
      +-------+--------+----------------+
      |                |                |
 isolate server   isolate client   browser client
      |                |                |
      v                v                v
 native capnp     native capnp     Cap'n Web or
 capability       bridge transport HTTP gateway
 adapter
```

The interface is shared. The transport is allowed to differ by runtime.

| Runtime | Transport |
| --- | --- |
| Legacy grain to legacy grain | native Cap'n Proto RPC |
| Legacy grain to isolate | native Cap'n Proto RPC to supervisor adapter |
| Isolate to legacy grain | generated JS stub over restricted native bridge |
| Isolate to isolate | same restricted native bridge, with local fast paths where safe |
| Browser to isolate or legacy grain | Cap'n Web or Sandstorm HTTP gateway |
| Tests | in-memory generated transport |

The security invariant is that a caller must hold a Sandstorm capability
handle before it can call the target. Optimizations may happen after authority
has been established, but service names are not authority.

## Example Capability

The app author defines one schema:

```capnp
# greeter.capnp
@0xb9b1b70b7e2b8c01;

interface Greeter {
  hello @0 (name :Text) -> (message :Text);
}
```

### Isolate Defines And Exposes It

```js
// worker.js
import { app } from "sandstorm:api";
import { Greeter } from "capnp:./greeter.capnp";

const greeter = Greeter.implement({
  async hello({ name }) {
    return { message: `Hello, ${name}` };
  },
});

export default app({
  capabilities: {
    greeter,
  },

  async fetch(request, env) {
    return new Response(`
      <button id="hello">Say hello</button>
      <pre id="out"></pre>
      <script type="module" src="/ui.js"></script>
    `, {
      headers: { "content-type": "text/html" },
    });
  },
});
```

The `capabilities` block is the public export table for app-defined object
capabilities. It should produce real Sandstorm capability objects, not raw
local names.

### Frontend Calls It

```js
// ui.js
import { Greeter } from "capnp:./greeter.capnp";
import { currentGrain } from "sandstorm:browser";

const root = await currentGrain.capability("greeter");
const greeter = Greeter.cast(root);

document.querySelector("#hello").onclick = async () => {
  const { message } = await greeter.hello({ name: "Ada" });
  document.querySelector("#out").textContent = message;
};
```

The browser sees the generated `Greeter` API. Under the hood, this can use
Cap'n Web or a Sandstorm HTTP gateway. It does not need the same wire transport
as isolate-to-isolate calls.

### Another Isolate Calls It

```js
// caller-worker.js
import { app } from "sandstorm:api";
import { Greeter } from "capnp:./greeter.capnp";

export default app({
  async fetch(request, env) {
    const token = await env.STORAGE.get("greeter-token");
    if (!token) {
      return new Response("Greeter is not connected", { status: 409 });
    }

    const cap = await env.SANDSTORM.restore(token);
    try {
      const greeter = Greeter.cast(cap);
      const { message } = await greeter.hello({ name: "other isolate" });
      return Response.json({ message });
    } finally {
      await cap.drop();
    }
  },
});
```

The token is durable authority obtained through Powerbox. The restored live
capability handle is what the generated `Greeter` stub calls.

### Obtaining And Saving The Capability

```js
import { Greeter } from "capnp:./greeter.capnp";

const request = Greeter.powerboxDescriptor({
  title: "Greeter service",
  verbPhrase: "say hello",
});

const cap = await env.POWERBOX.request(request);
try {
  const greeter = Greeter.cast(cap);
  const { message } = await greeter.hello({ name: "setup check" });

  const token = await cap.save({ label: "Greeter service" });
  await env.STORAGE.put("greeter-token", token);
} finally {
  await cap.drop();
}
```

The user grants authority through Powerbox once. Later calls restore the saved
token into a live handle and reuse that handle for repeated calls.

### Legacy Grain Calls It

A non-isolate grain imports the same schema:

```capnp
using Greeter = import "/app/greeter.capnp".Greeter;
```

From the legacy grain's point of view, the capability is an ordinary
`Greeter::Client`. The isolate supervisor adapts the isolate JavaScript
implementation to a native Cap'n Proto server object.

### Local Test

Generated bindings should also provide an in-memory transport:

```js
import { Greeter } from "capnp:./greeter.capnp";

test("hello", async () => {
  const greeter = Greeter.local({
    async hello({ name }) {
      return { message: `Hello, ${name}` };
    },
  });

  await expect(greeter.hello({ name: "Ada" }))
      .resolves.toEqual({ message: "Hello, Ada" });
});
```

This lets app authors test protocol logic without Sandstorm, workerd, or the
native supervisor.

## Data Plane Example

Use Cap'n Proto for the typed control plane and fetch for large data.

```capnp
# object-store.capnp
@0xf212915ce76fd001;

using WebSession = import "/sandstorm/web-session.capnp".WebSession;

interface ObjectStore {
  listObjects @0 (bucket :Text, prefix :Text, cursor :Text)
      -> (objects :List(ObjectInfo), nextCursor :Text);

  openObject @1 (bucket :Text, key :Text)
      -> (object :WebSession);

  struct ObjectInfo {
    key @0 :Text;
    size @1 :UInt64;
    contentType @2 :Text;
  }
}
```

Isolate caller:

```js
import { ObjectStore } from "capnp:./object-store.capnp";

const store = ObjectStore.cast(await env.SANDSTORM.restore(token));

const listing = await store.listObjects({
  bucket: "photos",
  prefix: "2026/",
  cursor: "",
});

const object = await store.openObject({
  bucket: "photos",
  key: "2026/cover.jpg",
});

const response = await object.fetch("", { method: "GET" });
```

For this to work cleanly, typed RPC needs generic capability slots: a method
must be able to return a capability whose native interface is fetch-shaped,
app-object-shaped, or another public Cap'n Proto interface. The current
prototype is narrower than that.

## `capnp:` Imports

Authors should be able to write:

```js
import { Greeter } from "capnp:./greeter.capnp";
```

The import is package-time syntax. Workerd does not need to parse `.capnp`
files at runtime.

The `spk dev-isolate` and package build flow should:

1. scan JavaScript imports
2. detect `capnp:` specifiers
3. resolve the `.capnp` file relative to the importing module
4. run Sandstorm-bundled schema/codegen tooling
5. add generated ES modules to the isolate module list
6. preserve stable module names or rewrite imports to canonical generated names

App authors should not need to install a separate `capnp` binary. Sandstorm
tooling can bundle either:

- the native Cap'n Proto compiler plus a JS generator, or
- a high-fidelity JS/WASM schema compiler and generator.

Using the official compiler semantics is preferable if practical, because it
avoids a second partial parser for `.capnp`.

## Generated API Shape

Generated bindings should expose a small, predictable surface:

```js
Greeter.implement(methods);
Greeter.cast(capability);
Greeter.local(methods);
Greeter.powerboxDescriptor(options);
Greeter.interfaceId;
Greeter.schema;
```

`implement()` creates an object suitable for the isolate export table.

`cast()` wraps an existing Sandstorm capability handle with typed methods.

`local()` creates an in-memory client for tests.

`powerboxDescriptor()` creates the descriptor needed to request a compatible
capability.

Generated TypeScript types should be emitted from the same schema:

```ts
type GreeterClient = Greeter.Client;
type GreeterServer = Greeter.Server;
type HelloParams = Greeter.HelloParams;
type HelloResults = Greeter.HelloResults;
```

## Native Bridge

The native bridge is the core implementation work.

The isolate should receive opaque capability handles, not a raw vat network.
Generated stubs use those handles to ask the supervisor to send native Cap'n
Proto calls. The supervisor maps capability slots and applies Sandstorm's
existing membranes, revocation, save, and restore behavior.

Required properties:

- No global lookup by grain ID, service name, or interface name.
- No raw bootstrap capability exposed to app code.
- Capability slots are explicit values in calls and results.
- Revocation and requirement membranes continue to apply.
- Save/restore goes through Sandstorm's existing durable token model.
- Returned capabilities remain live handles until saved or dropped.

The native bridge can still have fast paths. The important distinction is that
the fast path is based on an already-authorized live capability handle, not on
an ambient name service.

## Browser Bridge

Browsers should share the schema and generated client API, but not necessarily
the isolate native transport.

Browser clients can use:

- Cap'n Web
- a Sandstorm HTTP gateway
- generated fetch-based stubs for selected interfaces

The frontend author should still write:

```js
const greeter = Greeter.cast(capabilityFromShell);
await greeter.hello({ name: "Ada" });
```

The generated client can choose the browser transport internally.

## Performance Model

The desired hot path after restore is:

```text
isolate JS generated stub
  -> binary Cap'n Proto call encoding
  -> restricted supervisor capability transport
  -> native Cap'n Proto call
  -> target grain or local isolate adapter
```

Compared with today's app-object RPC, this should avoid:

- JSON parsing for typed structured values
- base64 wrapping for binary data
- HTTP-shaped app-object call routing for typed RPC
- repeated durable token restores

Costs that remain:

- isolate-to-supervisor boundary
- capability table lookup
- membrane/revocation machinery
- cross-process or cross-grain dispatch
- JS method invocation for isolate-implemented servers

Caching can remove durable restore overhead and repeated metadata lookups. It
cannot remove the authority boundary, revocation semantics, or the need to
dispatch through a live capability handle.

## Staged Plan

### Completed Slice: Fetch-Shaped App-Object Bindings

The current implementation has completed the first narrow slice of this plan.
It proves the authoring shape over the existing fetch-shaped app-object RPC
transport, not over native Cap'n Proto transport.

Implemented:

- import scanner recognizes `capnp:` specifiers
- `.capnp` files are resolved for `spk dev-isolate`
- generated ES modules expose interface bindings
- `sandstorm:capnp` provides shared generated-binding runtime helpers
- generated client/server wrappers work over current app-object RPC
- generated local clients work for in-memory tests
- durable export, save, restore, cast, call, drop, and revoke are covered for
  generated object capabilities
- simple same-schema capability result metadata is generated
- simple same-schema capability argument metadata is generated
- typed returned capabilities can be used as typed clients
- typed capability clients can be passed back as arguments
- examples show a schema-defined isolate capability

Known limitations of this completed slice:

- the `.capnp` scanner is conservative and not a full compiler
- generated bindings still serialize through current app-object RPC helpers
- there is no native Cap'n Proto wire encoding for isolate calls yet
- generated modules do not yet emit full TypeScript server/client types
- Powerbox descriptors are not generated from schema
- legacy non-isolate grains cannot yet call these isolate-defined interfaces
- browsers cannot yet import the same generated schema module

### Phase 1: Real Schema Compilation

Replace the conservative scanner with real schema compilation/generation.
This phase keeps the current transport but removes the largest correctness
risk in the authoring model.

Progress:

- `spk dev-isolate` now follows relative imports between `.capnp` files for
  generated `capnp:` modules.
- generated modules can reference imported interface bindings for simple
  capability parameters and single-capability results.
- the isolate Cap'n Proto RPC example is split across imported schemas, and
  the isolate supervisor integration test covers generated cross-schema
  metadata.
- `spk dev-isolate` can now discover `capnp-es:` schema imports and generate
  raw `@mnutt/capnp-es` JavaScript modules through a configured compiler
  module, preserving source-relative module paths for schema imports.

Deliverables:

- bundle or expose Sandstorm-owned Cap'n Proto schema tooling for isolate
  package builds
- support imports between `.capnp` files
- preserve official Cap'n Proto name resolution, annotations, type IDs, nested
  interfaces, structs, enums, lists, generics where supported, and constants
- generate stable JS module names and package paths
- generate complete interface metadata:
  - interface IDs
  - method IDs
  - parameter/result structs
  - capability parameters
  - capability results
  - imported interface references
- generate TypeScript declarations from the same schema
- add direct unit tests for generated output from representative schemas
- add integration tests for schemas with imports, nested types, lists, enums,
  and multiple capability parameters/results

Exit criteria:

- app authors do not need a separately installed `capnp` binary
- the current scanner can be deleted
- generated app-object bindings remain behaviorally compatible with the
  completed slice

### Phase 2: Stable Public Generated API

Stabilize the app-facing generated API before adding a native transport.

Progress:

- generated and hand-written bindings expose `Interface.schema`, a stable
  metadata object containing the import specifier, interface name/id,
  schema path/text, method names, and generated capability metadata.
- generated `capnp:` bindings expose parser-derived `Interface.interfaceId`;
  hand-written bindings can still pass `interfaceId` explicitly, and default to
  an empty string when they do not.
- generated `capnp:` bindings expose parser-derived method ordinals plus
  parameter/result struct ids in `Interface.schema`.
- `sandstorm:capnp` supports top-level named result capability fields in
  `Interface.schema.resultCapabilities`, so methods can return structs that
  contain more than one capability-valued field.

Deliverables:

- finalize `Interface.implement()`
- finalize `Interface.cast()`
- finalize `Interface.local()`
- finalize `Interface.powerboxDescriptor()`
- expose `Interface.interfaceId`
- expose schema/interface/method metadata in a documented shape
- define client and server TypeScript types
- define error mapping between JS exceptions and Cap'n Proto exceptions
- define lifecycle behavior for returned capabilities:
  - live handle ownership
  - `drop()`
  - `save()`
  - durable restore
  - revocation
- define how local test doubles represent capability arguments/results
- document unsupported schema features, if any
- add compatibility tests so future generators preserve this surface

Exit criteria:

- examples and tests use only the documented API
- app authors can write and test schema-defined isolate capabilities without
  relying on private helper details
- the API is ready to support more than one transport under the same generated
  client/server shape

### Phase 3: Generic Capability Slots

Generalize current capability slot support so typed methods can pass and
return all Sandstorm capability kinds that matter to isolate apps.

Progress:

- generated `capnp:` modules emit structured result capability slot metadata
  for methods whose result structs contain multiple top-level capability
  fields.
- local app-object RPC dispatch can carry non-appObject Sandstorm capabilities
  as opaque values, and `sandstorm:capnp` can declare fetch-shaped result
  slots by native interface. The supervisor native app-RPC route still rejects
  non-appObject slots; cross-supervisor transport for those slots is deferred
  to Phase 4's native Cap'n Proto bridge rather than expanding the temporary
  app-object route.
- `sandstorm:capnp` supports nested capability paths for local/generated
  argument normalization and result casting while preserving the older shallow
  `fields` metadata shape.
- generated binding metadata can declare expected argument slot interfaces, and
  `sandstorm:capnp` validates `cap.info().nativeInterface` before dispatch when
  a live capability handle exposes metadata.
- `spk dev-isolate` recognizes Sandstorm native `capnp:` imports for
  `WebSession`, `ApiSession`, and `OutboundHttpSession`, emits fetch-shaped
  slot metadata for them, and includes an object-store example where
  `openObject()` returns a fetch-capable object.

Add support for generic capability slots:

- app-object capabilities
- fetch-shaped WebSession / ApiSession capabilities
- outbound HTTP capabilities
- future public Cap'n Proto interface capabilities
- capability lists and structs containing capabilities
- promise/pipelined capability results where feasible

This unlocks control-plane methods that return data-plane capabilities, such
as `openObject()` returning an object with `fetch()`.

Scope note: Phase 3 covers local/generated binding behavior and authoring
examples. Non-appObject capability slots crossing supervisor boundaries will
ride the native Cap'n Proto bridge in Phase 4, where the transport can preserve
the actual public interface instead of forcing every slot through
`IsolateObjectCapability`.

Deliverables:

- structured slot metadata for capability-valued fields, not just simple
  top-level parameters/results
- generated client argument normalization for nested capability fields
- generated result casting for nested capability fields
- explicit native interface metadata on slot values
- validation that a passed capability satisfies the declared interface when
  metadata is available
- support for fetch-shaped capabilities in generated bindings:
  - `WebSession`
  - `ApiSession`
  - data-plane object capabilities
- integration tests for:
  - object-store control plane returning fetch-shaped objects
  - typed app-object capabilities passing other typed app-object capabilities
  - saved/restored capabilities with declared native interfaces
  - revoked capability calls failing cleanly

Exit criteria:

- an isolate can expose an S3-like control plane where `openObject()` returns
  a fetch-capable object
- generated RPC users do not manually unwrap capability handles except for
  explicit lifecycle operations

### Phase 4: Native Cap'n Proto Bridge

Add the restricted isolate-to-native capability transport.

Deliverables:

- generated JS clients can call native Cap'n Proto capabilities
- generated JS server adapters expose isolate objects as native capabilities
- legacy grains can call isolate-defined capabilities
- isolates can call legacy grain capabilities
- capability slots cross the bridge safely
- non-appObject capability slots returned by app-object compatibility calls can
  cross supervisor boundaries through the native bridge, rather than the
  temporary `IsolateObjectCapability` JSON route
- membranes, save, restore, drop, and revocation continue to work

This is the main interop milestone.

Transport requirements:

- isolate JS never receives a raw vat network or unrestricted bootstrap
  capability
- every native call is rooted in an already-held Sandstorm capability handle
- capability slots are tracked by the supervisor
- save/restore still uses Sandstorm's durable token model
- revocation and permission membranes remain enforced by native capability
  wrappers
- exported isolate objects are adapted to native Cap'n Proto server objects
- imported native capabilities are adapted to generated JS clients

Implementation work:

- define the isolate-to-supervisor native call protocol
- choose the JS-side encoder/runtime:
  - generated JS around a Sandstorm-bundled encoder, or
  - a high-quality JS/WASM Cap'n Proto RPC implementation
- implement JS-to-native request encoding
- implement native-to-JS result decoding
- implement capability table import/export across the bridge
- implement JS server dispatch from native Cap'n Proto calls
- implement exception mapping both directions
- implement cancellation/drop semantics
- implement save/restore/drop/revoke against native handles
- add protocol version negotiation between generated bindings and supervisor
- keep current app-object RPC transport as a compatibility fallback until the
  native bridge is mature

Progress:

- supervisor exposes `/capnp/bridge-info`, and `sandstorm:api` exposes
  `capnpBridgeInfo()`, so generated bindings can feature-detect the native
  bridge protocol before switching away from the app-object RPC fallback
- the bridge info advertises protocol version `0` and turns on feature flags
  only as paths become real; `nativeRpc` is available, while direct native
  method calls, native exports, and cross-envelope capability slots remain off
- `isolate-native-capnp-bridge.capnp` defines the first native bridge request,
  response, payload, exception, lifecycle, and capability-slot envelopes, while
  `isolate-supervisor-internal.capnp` continues to own the app-object
  compatibility transport
- `sandstorm:capnp` exposes `negotiateNativeCapnpBridge()` so generated
  bindings have one conservative feature-detection path for native transport
  vs. app-object RPC fallback
- isolate runtime bundles the browser-safe `@mnutt/capnp-es` ESM runtime as
  built-in modules; this is the selected JS-side Cap'n Proto encoder/runtime
  for native bridge work
- `sandstorm:capnp` exposes native bridge client scaffolding and Cap'n
  Proto payload normalization around `@mnutt/capnp-es`, while still failing
  calls with a stable unavailable error until the supervisor transport exists
- supervisor exposes a disabled `POST /capnp/call` route with a structured
  native bridge response envelope, giving JS clients a stable endpoint before
  native dispatch is enabled
- `sandstorm:api` exposes `nativeCapnpBridgeCall()` as the narrow JS helper
  for posting to that route, and the native bridge client will use it once
  negotiation enables native calls
- isolate runtime bundles generated `@mnutt/capnp-es` bindings for the native
  bridge envelope as `sandstorm:native-capnp-bridge`; `sandstorm:capnp` can now
  encode and test-decode full native bridge call request messages containing
  the target capability slot, interface ID, method ordinal/name, params bytes,
  and payload capability slots
- the disabled supervisor `/capnp/call` route now parses and validates the
  native bridge request envelope before returning its stable unimplemented
  response, so C++ and isolate JS agree on the initial wire format before any
  native capability dispatch is enabled
- the disabled supervisor `/capnp/call` route now rejects bridge calls whose
  target id is not an already-claimed Sandstorm capability handle, preserving
  the object-capability authority boundary before native dispatch is enabled
- `sandstorm:capnp` can now encode and decode native bridge response envelopes
  for result payloads and exceptions, giving generated clients a typed response
  format to target before `/capnp/call` returns binary native results
- `/capnp/call` now has an opt-in binary response path using
  `Accept: application/octet-stream`; disabled/failed bridge calls can return a
  serialized `NativeCapnpBridgeResponse.exception` envelope, while the default
  JSON diagnostics remain available
- `createNativeCapnpBridge().call()` now uses the binary API helper when bridge
  negotiation succeeds and returns decoded result payloads, or maps response
  exception/canceled envelopes to JS errors
- `sandstorm:capnp` can encode save, restore, and drop native bridge lifecycle
  requests plus acknowledged/saved/capability responses; the disabled
  supervisor route now parses and validates those lifecycle variants before
  returning the stable unimplemented response
- binary native bridge save, restore, and drop lifecycle requests now execute
  against claimed Sandstorm capability handles using the existing durable token
  format and capability table, while ordinary native method calls remain
  disabled in bridge negotiation
- `isolate-native-capnp-bridge.capnp` now has a separate `rpc` envelope for
  carrying `@mnutt/capnp-es` two-party RPC messages addressed to an
  already-held Sandstorm capability handle; this moves the next bridge step
  from ad hoc method-call envelopes toward the actual Cap'n Proto RPC protocol
- `sandstorm:capnp` exposes `NativeCapnpBridgeTransport` and
  `createNativeCapnpBridgeConnection()` so generated `@mnutt/capnp-es` clients
  can be wired to the restricted supervisor endpoint; while native dispatch is
  disabled, this transport reports the supervisor's structured unimplemented
  exception instead of silently falling back
- the supervisor parses and validates native bridge `rpc` requests, including
  target capability lookup and payload metadata, then returns a binary
  unimplemented response; native RPC message translation to Sandstorm's C++
  Cap'n Proto transport remains the next Phase 4 implementation step
- the disabled supervisor endpoint now parses the embedded `capnp::rpc::Message`
  and reports its RPC message kind plus key bootstrap/call/release metadata in
  diagnostics, so the native adapter can branch on real Cap'n Proto RPC
  messages instead of treating the payload as opaque bytes
- native bridge `rpc` envelopes now carry an explicit `connectionId` generated
  by `NativeCapnpBridgeTransport`, and the supervisor validates/reports it;
  this gives the future native adapter a stable key for per-connection
  question/import/export state while preserving the target Sandstorm capability
  as the actual authority for every message
- the supervisor now creates a per-connection native bridge RPC session record
  after validating the target and embedded `capnp::rpc::Message`, rejects reuse
  of the same connection id for a different target, and reports the session's
  received message count in diagnostics; the session is still only scaffolding
  until the C++ RPC adapter starts dispatching messages
- each native bridge RPC session now owns a C++ in-memory `MessageStream`,
  `TwoPartyVatNetwork`, and `RpcSystem` bootstrapped with the target Sandstorm
  capability; binary `bootstrap` RPC envelopes now dispatch through that native
  stack and return real Cap'n Proto RPC `return` messages to `@mnutt/capnp-es`,
  while ordinary method-call envelopes remain disabled in bridge negotiation
- `NativeCapnpBridgeTransport` now serializes outgoing HTTP bridge requests per
  connection, matching the current one-response-per-request bridge shape; the
  integration fixture also sends a real RPC `call` after bootstrap and receives
  the native C++ exception `return`, proving calls are reaching the target
  Sandstorm capability through the per-connection RPC session
- `spk dev-isolate` now has an explicit raw `capnp-es:` import path backed by
  `SANDSTORM_CAPNP_ES_COMPILER_MODULE`, so isolate tooling can materialize the
  generated JS classes that the native bridge will use without replacing the
  current `capnp:` app-object compatibility wrapper yet
- `sandstorm:capnp` exposes `connectNativeCapnp(api, target, InterfaceClass)`
  as the first raw generated-client helper: it creates the restricted bridge
  transport, bootstraps a `@mnutt/capnp-es` generated interface class, and
  returns the generated client with the underlying Sandstorm capability handle
  plus connection metadata attached
- the bundled `@mnutt/capnp-es` runtime has been refreshed to the local runtime
  shape used by the compiler hook, including standard generated schema modules
  such as `@mnutt/capnp-es/capnp/stream` while preserving the older
  `@mnutt/capnp/rpc.mjs` alias used by existing tests
- raw `capnp-es:` generated modules now rewrite generated schema imports to
  stable workerd module specifiers, follow relative app schemas, skip bundled
  `/capnp/*` runtime schemas, and generate Sandstorm-owned `/sandstorm/*`
  schema dependencies under explicit `capnp-es:/sandstorm/...` module names
- bridge feature negotiation now distinguishes the working binary `rpc`
  transport from the still-disabled direct method-call envelope:
  `/capnp/bridge-info` advertises `nativeTransport` and `nativeRpc`, while
  `nativeCalls`, `nativeExports`, and cross-envelope `capabilitySlots` remain
  false until those paths are implemented
- `sandstorm:capnp` now exposes `saveNativeCapnp()` and `restoreNativeCapnp()`;
  restore negotiates the native RPC bridge, restores a durable token through
  Sandstorm's lifecycle route, and returns a live generated `@mnutt/capnp-es`
  client connected to the restored capability
- generated clients returned by `connectNativeCapnp()` now fall back to native
  lifecycle save/drop requests when their underlying Sandstorm capability is a
  bare restored bridge slot rather than a richer JS capability object
- packaged isolates can now import `capnp-es:/sandstorm/web-session.capnp`,
  connect a generated `WebSession` client to a route-backed Sandstorm
  capability with `connectNativeCapnp()`, call `get()`, and decode the typed
  `Response.content.body.bytes` result across the restricted native RPC bridge
- generated clients can now receive a returned native capability through the
  RPC result cap table: the integration fixture forces a streamed WebSession
  response, observes `Response.content.body.stream`, and calls the returned
  generated `Handle.ping()` client over the same restricted native RPC bridge
- dropping a claimed native bridge capability now also tears down supervisor
  RPC sessions bound to that target, and the integration fixture verifies that
  generated calls and raw bridge RPC envelopes for the dropped target are
  rejected instead of continuing through a stale per-connection session
- `sandstorm:capnp` now has the JS half of native isolate exports:
  `NativeCapnpStreamTransport` pumps standard stream-framed Cap'n Proto RPC
  messages over Web Streams, `createNativeCapnpExportSession()` hosts a
  generated `@mnutt/capnp-es` server with `Conn.initMain()`, and
  `exportNativeCapnp()` exposes the intended public helper while correctly
  refusing until the supervisor advertises `nativeExports`
- `sandstorm:api` now routes
  `/__sandstorm/native-capnp/export-sessions/:id` through the native export
  registry, so the supervisor has a reserved binary Web Streams endpoint for
  the next C++ session-pump chunk
- the supervisor can now mint a claimed native capability for a registered
  isolate export: `exportNativeCapnp()` registers the JS server target, calls
  `/capabilities/native-capnp-export`, and the C++ side keeps a live
  `TwoPartyVatNetwork` client over the reserved Web Streams endpoint; bridge
  negotiation now advertises `nativeExports`
- minted isolate exports now use a C++ WebSocket transport on the normal native
  capability path: the supervisor opens the isolate export session, reaches the
  generated `@mnutt/capnp-es` server, and the integration fixture exports a
  generated `WebSession` implementation that can be fetched through the claimed
  Sandstorm capability
- generated `capnp-es:` modules and Sandstorm's native bridge helpers now share
  the same bundled `@mnutt/capnp-es` runtime module identity, so generated
  server registrations populate the `Registry` instance used by native RPC
  dispatch
- generated schema runtime imports now canonicalize through `/capnp-es/...`
  module specifiers, avoiding workerd's `capnp-es:` scheme-relative resolution
  split; the integration fixture exports an isolate-defined `NativeGreeter`
  server and calls it back over the native supervisor bridge
- native isolate exports can now be saved as durable supervisor-owned
  `nativeCapnpExport` object IDs, restored later as live generated
  `@mnutt/capnp-es` clients, and called across two isolate supervisors through
  the restricted native RPC bridge; the fake-core test harness now registers its
  SandstormCore capability explicitly so cross-supervisor client connections do
  not replace the grain's core authority target
- the integration suite now restores the same saved isolate-defined
  `NativeGreeter` token from a C++ harness and calls it through the ordinary
  generated Cap'n Proto client API, covering the first legacy/native client path
  without routing the call through isolate JS
- the reverse path is also covered: the fake C++ SandstormCore can restore a
  legacy `NativeGreeter::Server` from a saved token, and isolate JS calls it
  through `restoreNativeCapnp()` plus generated `@mnutt/capnp-es` bindings
- native RPC cap tables now have focused interop coverage on the test
  `NativeGreeter` interface: legacy C++ calls a greeter capability returned by
  an isolate export, and isolate JS calls a greeter capability returned by the
  fake legacy C++ greeter; this is separate from the still-disabled direct
  bridge-envelope `capabilitySlots` feature
- native export saved tokens are now covered through restore and revocation:
  after a saved isolate-defined `NativeGreeter` token is used from isolate JS
  and from the C++ harness, the integration suite revokes the token and asserts
  that a later generated-client restore fails through the native bridge

Interop tests:

- legacy grain calls isolate-defined `Greeter` (covered by the C++ native
  restore harness for `NativeGreeter`)
- isolate calls legacy grain `Greeter` (covered by the fake C++ `NativeGreeter`
  restore fixture)
- isolate calls another isolate through saved/restored capability
- legacy grain receives a capability returned by an isolate (covered by
  `NativeGreeter.makeGreeter()`)
- isolate receives a capability returned by a legacy grain (covered by
  `NativeGreeter.makeGreeter()`)
- permission membrane blocks a disallowed call
- revoked saved token fails on later restore (covered by the cross-supervisor
  `NativeGreeter` revoke check)
- durable token restore produces a live generated client (covered by
  `restoreNativeCapnp()` calls for route-backed `WebSession` and
  isolate-defined `NativeGreeter`)

Exit criteria:

- a `.capnp` interface defined by an isolate is a real public Cap'n Proto
  interface to legacy grains
- an isolate can call an existing legacy Sandstorm capability through generated
  bindings
- current app-object RPC is no longer the only path for schema-defined calls

### Phase 5: Browser Schema Bridge

Generate browser clients from the same `.capnp` schemas.

Deliverables:

- frontend code can import the same schema-generated module
- browser calls use Cap'n Web or a Sandstorm HTTP gateway
- Powerbox request descriptors can be generated from schema metadata
- browser-side tests can use the in-memory transport

Implementation work:

- define browser capability handle representation
- decide default browser transport:
  - Cap'n Web where available
  - Sandstorm HTTP gateway for compatibility
  - generated fetch-based bridge for selected app-object interfaces
- generate browser-safe modules from the same schema
- expose the same client method names and TypeScript types
- map browser Powerbox results to generated clients
- support local/in-memory browser tests
- document frontend bundler behavior for `capnp:` imports

Progress:

- the browser RPC helper now exposes `makeBrowserCapnpInterfaceBinding()` and
  `connectBrowserCapnp()`, giving browser code a schema-shaped client facade
  over Cap'n Web stubs; the isolate browser RPC fixture imports a generated-like
  `NativeGreeter` module, calls schema-named methods, casts a returned
  capability, and passes that capability back as an argument
- `spk dev-isolate` now emits a Sandstorm-owned browser companion module for
  each `capnp:` schema import under `sandstorm:browser-capnp:...`; the isolate
  API serves those modules from `/__sandstorm/capnp/...`, so frontend code can
  import the same schema by URL without app code hand-serving generated JS
- generated browser modules share the same schema metadata as isolate modules
  but bind through `makeBrowserCapnpInterfaceBinding()` and
  `/__sandstorm/rpc-client.js`, keeping the transport decision inside the
  Sandstorm browser helper
- generated browser bindings now expose `powerboxDescriptor()` and
  `powerboxDescriptorInfo()` for schema-defined interfaces; the helper asks
  Sandstorm to pack a real `PowerboxDescriptor` whose boolean tag is the
  schema interface id
- generated browser bindings now expose `local(methods)` for in-memory tests
  and browser-local fakes, using the same argument/result capability metadata
  as browser RPC clients
- generated browser bindings now accept either a direct Cap'n Web-style stub or
  a Sandstorm browser capability handle; handle-backed clients dispatch through
  `/__sandstorm/object-capabilities/:id/native-app-rpc-call`, hydrate returned
  capability slots, and can be requested with `Interface.requestCapability()`
- `docs/developing/isolate-grains.md` now documents frontend bundler behavior:
  worker code imports `capnp:` schemas, browser code imports served
  `/__sandstorm/capnp/...` companion modules, and browser bundlers should
  alias or externalize those runtime URLs rather than compiling `.capnp` files

Powerbox work:

- generate request descriptors from interface metadata
- include interface IDs and human-readable labels
- support app-provided title, noun phrase, verb phrase, and icon hints
- let apps request capabilities by declared public interface
- preserve visible user-mediated authority grant flow

Exit criteria:

- frontend code and isolate code import the same schema and call the same
  logical client API
- browser-side Powerbox can request a schema-defined capability and return a
  generated client

### Phase 6: Performance And Fast Paths

After the semantics are correct, optimize:

- reuse restored live handles
- cache interface metadata
- avoid JSON/base64 in typed calls
- support pipelining where practical
- support streaming and large binary data through fetch or stream-capable caps
- add direct local dispatch when a live capability resolves to a local isolate
  target

Fast paths must preserve the rule that authority comes from the capability
handle, not from a name.

Performance work:

- benchmark current app-object RPC against native bridge calls
- measure restore-once/reuse-live-handle behavior
- cache generated schema/interface metadata
- cache native interface descriptors in the supervisor
- eliminate JSON serialization for typed calls on the native path
- avoid base64 for binary data on typed/native paths
- preserve fetch/data-plane streaming for large objects
- add direct local dispatch when both endpoints are in the same supervisor and
  the caller already holds the authorized live capability
- add optional pipelining support where the JS API can expose it cleanly
- add latency and throughput tests for:
  - small typed RPC
  - capability arguments/results
  - repeated calls over a restored live handle
  - isolate-to-isolate local dispatch
  - isolate-to-legacy native dispatch
  - control-plane RPC plus fetch data-plane calls

Exit criteria:

- repeated calls over a restored live handle do not repeat Powerbox/durable
  restore work
- native typed calls avoid avoidable JSON/base64 overhead
- local fast paths are demonstrably faster but do not bypass capability
  authority checks

Progress:

- app-interface, API-session, and outbound-HTTP Powerbox descriptor info is
  cached by descriptor endpoint/options in the isolate API helper; generated
  worker and browser bindings also cache schema-derived app-interface
  descriptors and return cloned results so app code cannot mutate cached state

### Phase 7: Packaging, Publishing, And Migration

Make schema-defined isolate capabilities publishable and maintainable.

Deliverables:

- package metadata advertises exported public interfaces
- package metadata includes schema files or stable schema references
- Powerbox discovery can match requested interfaces to providers
- app updates preserve interface compatibility or report breaking changes
- generated code is reproducible during package build
- documentation explains schema evolution rules for isolate authors
- migration path from current JavaScript-defined app-object capabilities
- compatibility story for grains packed before the native bridge exists

Progress:

- normal `spk pack` now scans packaged isolate ES modules for `capnp-es:`
  schema imports, generates the same rewritten `@mnutt/capnp-es` support
  modules as `spk dev-isolate`, stores them under
  `__sandstorm_isolate_runtime/capnp-es-generated`, and serializes an
  augmented isolate module list into `sandstorm-manifest`
- normal `spk pack` also scans packaged isolate ES modules for `capnp:`
  imports, generates app-object compatibility modules under
  `__sandstorm_isolate_runtime/capnp`, generates browser companion modules
  under `__sandstorm_isolate_runtime/capnp-browser`, and records both worker
  and browser schema modules in `sandstorm-manifest`
- isolate generated bindings now expose `powerboxDescriptor(env)` and
  `powerboxDescriptorInfo(env)` for schema-defined interfaces, backed by the
  same supervisor descriptor route as browser bindings
- `examples/isolate-file-store-rpc` documents and exercises a schema-defined
  app-object capability that can be offered or used to fulfill Powerbox
  requests, keeping directory listing and small file reads in RPC while calling
  out that large byte streams should use a fetch-shaped data plane
- `Manifest.publicInterfaces` now provides a package-level metadata section
  for public schema-defined capabilities; `spk pack` validates each declared
  schema/interface pair, fills the canonical Cap'n Proto interface ID when it is
  omitted, rejects mismatches, and preserves the enriched declaration in
  `sandstorm-manifest`
- the shell Powerbox option query now treats `Manifest.publicInterfaces` as
  hosted-object provider metadata: app-interface descriptors match accessible
  grains whose installed or dev package advertises the requested interface ID,
  and the result still flows through the normal capability request/fulfillment
  path
- `spk pack` now includes each declared public interface schema file and its
  local `.capnp` imports in the package archive automatically, so
  `schemaPath` is a stable package-local reference rather than metadata that
  can point at an omitted source file

Exit criteria:

- an app can publish a schema-defined capability as part of its package
- other apps can discover/request it through Powerbox
- legacy grains and isolate grains can both depend on the published schema

### Phase 8: De-Risking And Cleanup

After the native and browser paths exist, decide what to keep from the
prototype layers.

Deliverables:

- decide whether current JavaScript-defined app-object RPC remains supported
  as a private/local convenience
- remove obsolete scanner/generator code
- remove compatibility shims that are no longer needed
- document which transports are stable public API
- add conformance tests shared by:
  - local transport
  - current app-object transport, if retained
  - native bridge
  - browser bridge

Exit criteria:

- public protocols are schema-first
- private helper APIs are clearly separated from stable authoring APIs
- tests cover each supported transport against the same generated interface

## Open Questions

- Should `.capnp` be the only source of truth for public protocols, or should
  TypeScript classes be allowed to generate draft schemas?
- Should generated JS use a third-party library such as `capnp-es`, a
  Sandstorm-maintained generator, or both?
- How should package metadata advertise exported public interfaces for
  Powerbox discovery?
- How should schema evolution be surfaced to JS authors?
- How much Cap'n Proto pipelining can be exposed cleanly in JavaScript?
- What browser transport should be the default for frontend clients?

## Recommended Direction

Use schema-first public protocols:

- `.capnp` is the source of truth for cross-grain interfaces.
- `capnp:` imports provide simple JS authoring.
- Sandstorm tooling bundles the compiler/generator.
- Isolates receive typed generated stubs and server adapters.
- Legacy grains see ordinary Cap'n Proto interfaces.
- Browsers use the same generated interface API over a browser-appropriate
  transport.
- Fetch remains the preferred data plane for HTTP and large byte streams.

This provides one authoring model without weakening Sandstorm's object-
capability security model.
