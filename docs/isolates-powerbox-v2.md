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
 native capnp     native capnp     native capnp-es
 capability       bridge transport browser bridge
 adapter
```

The interface is shared. Schema RPC should converge on native Cap'n Proto
semantics in every runtime; `fetch()` remains the separate data-plane shape for
HTTP and large streaming capabilities.

| Runtime | Transport |
| --- | --- |
| Legacy grain to legacy grain | native Cap'n Proto RPC |
| Legacy grain to isolate | native Cap'n Proto RPC to supervisor adapter |
| Isolate to legacy grain | generated JS stub over restricted native bridge |
| Isolate to isolate | same restricted native bridge, with local fast paths where safe |
| Browser to isolate or legacy grain | generated browser client over restricted native capnp-es bridge |
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
import { sandstorm } from "sandstorm:api";
import { exportNativeCapnp } from "sandstorm:capnp";
import { Greeter } from "capnp-es:./greeter.capnp";

const greeter = {
  async hello({ name }) {
    return { message: `Hello, ${name}` };
  },
};

export default {
  async fetch(request, env) {
    const api = sandstorm(request, env);
    if (new URL(request.url).pathname === "/export-greeter") {
      return Response.json(await exportNativeCapnp(api, Greeter, greeter, {
        interfaceName: "Greeter",
      }));
    }

    return new Response(`
      <button id="hello">Say hello</button>
      <pre id="out"></pre>
      <script type="module" src="/ui.js"></script>
    `, {
      headers: { "content-type": "text/html" },
    });
  },
};
```

The `capabilities` block is the public export table for app-defined object
capabilities. It should produce real Sandstorm capability objects, not raw
local names.

### Frontend Calls It

```js
// ui.js
import { Greeter } from "/__sandstorm/capnp-es/greeter.capnp.js";
import { requestBrowserNativeCapnp } from "/__sandstorm/native-capnp/client.js";

const { client: greeter } = await requestBrowserNativeCapnp(Greeter, {
  saveLabel: { defaultText: "Greeter service" },
});

document.querySelector("#hello").onclick = async () => {
  const { message } = await greeter.hello({ name: "Ada" });
  document.querySelector("#out").textContent = message;
};
```

The browser sees the generated `Greeter` API. Under the hood, schema RPC should
use the restricted native browser `capnp-es` bridge; app-defined HTTP and large
streaming APIs should stay fetch-shaped instead of becoming RPC calls.

### Another Isolate Calls It

```js
// caller-worker.js
import { sandstorm } from "sandstorm:api";
import { restoreNativeCapnp } from "sandstorm:capnp";
import { Greeter } from "capnp-es:./greeter.capnp";

export default {
  async fetch(request, env) {
    const token = await env.STORAGE.get("greeter-token");
    if (!token) {
      return new Response("Greeter is not connected", { status: 409 });
    }

    const greeter = await restoreNativeCapnp(sandstorm(request, env), token, Greeter, {
      interfaceName: "Greeter",
    });
    try {
      const { message } = await greeter.hello({ name: "other isolate" });
      return Response.json({ message });
    } finally {
      await greeter.drop();
    }
  },
};
```

The token is durable authority obtained through Powerbox. The restored live
capability handle is what the generated `Greeter` stub calls.

### Obtaining And Saving The Capability

```js
import { connectNativeCapnp, nativeCapnpPowerboxDescriptor } from "sandstorm:capnp";
import { Greeter } from "capnp-es:./greeter.capnp";

const descriptor = await nativeCapnpPowerboxDescriptor(env, Greeter, {
  interfaceName: "Greeter",
});

const cap = await api.powerbox().claim(requestTokenFromBrowser, {
  descriptor,
  requiredPermissions: ["view"],
});
try {
  const greeter = connectNativeCapnp(api, cap, Greeter, { interfaceName: "Greeter" });
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
import { Greeter } from "capnp-es:./greeter.capnp";

test("hello", async () => {
  const greeter = new Greeter.Server({
    async hello({ name }) {
      return { message: `Hello, ${name}` };
    },
  }).client();

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
import { ObjectStore } from "capnp-es:./object-store.capnp";
import { restoreNativeCapnp } from "sandstorm:capnp";

const store = await restoreNativeCapnp(api, token, ObjectStore, {
  interfaceName: "ObjectStore",
});

const listing = await store.listObjects({
  bucket: "photos",
  prefix: "2026/",
  cursor: "",
});

const object = await store.openObject({
  bucket: "photos",
  key: "2026/cover.jpg",
});

const response = await object.object.get({ path: "", context: {}, ignoreBody: false });
```

For this to work cleanly, typed RPC needs generic capability slots: a method
must be able to return a capability whose native interface is fetch-shaped,
app-object-shaped, or another public Cap'n Proto interface. The current
prototype is narrower than that.

## `capnp-es:` Imports

Authors should be able to write:

```js
import { Greeter } from "capnp-es:./greeter.capnp";
```

The import is package-time syntax. Workerd does not need to parse `.capnp`
files at runtime.

The `spk dev-isolate` and package build flow should:

1. scan JavaScript imports
2. detect `capnp-es:` specifiers
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
import {
  connectNativeCapnp,
  exportNativeCapnp,
  nativeCapnpPowerboxDescriptor,
} from "sandstorm:capnp";
import { Greeter } from "capnp-es:./greeter.capnp";

const exported = await exportNativeCapnp(api, Greeter, methods);
const client = connectNativeCapnp(api, capability, Greeter);
const localClient = new Greeter.Server(methods).client();
const descriptor = await nativeCapnpPowerboxDescriptor(env, Greeter);
const interfaceId = Greeter._capnp.typeIdHex;
```

`exportNativeCapnp()` creates a Sandstorm capability from a generated
`capnp-es` server class and app-supplied method object.

`connectNativeCapnp()` wraps an existing Sandstorm capability handle with a
generated client.

`new Interface.Server(methods).client()` creates an in-memory client for tests.

`nativeCapnpPowerboxDescriptor()` creates the descriptor needed to request a
compatible capability from generated metadata.

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

Browsers should share the schema, generated client API, and native Cap'n Proto
semantics with isolates. Because isolate browser APIs have not shipped, there is
no backwards-compatibility requirement for the current Cap'n Web/app-object
prototype paths.

Browser schema RPC should use:

- generated `capnp-es` modules
- a restricted Sandstorm browser bridge rooted in an already-held Powerbox
  capability handle
- native Cap'n Proto RPC envelopes and cap tables, matching the isolate bridge

Browser data-plane access should use:

- `fetch()` for intentionally HTTP-shaped capabilities
- stream-capable native/fetch capabilities for large byte flows

The frontend author should still write:

```js
const greeter = Greeter.connect(capabilityFromShell);
await greeter.hello({ name: "Ada" });
```

The generated client should not silently choose a public fallback transport.
Internal diagnostics and in-memory fakes are fine, but public schema RPC should
fail clearly if the native browser bridge is unavailable.

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

### Removed Prototype Slice: Fetch-Shaped App-Object Bindings

The first prototype slice proved part of the schema-authoring shape over the
existing fetch-shaped app-object RPC transport, not over native Cap'n Proto
transport. Since the native `capnp-es` path now works and isolates have not
shipped with the prototype API, this slice is no longer part of the supported
surface.

Previously implemented, then removed or superseded:

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

The limitations that motivated removal:

- the `.capnp` scanner is conservative and not a full compiler
- generated bindings still serialize through current app-object RPC helpers
- there is no native Cap'n Proto wire encoding for isolate calls yet
- generated modules do not yet emit full TypeScript server/client types
- Powerbox descriptors are not generated from schema
- legacy non-isolate grains cannot yet call these isolate-defined interfaces
- browsers cannot yet import the same generated schema module

### Phase 1: Real Schema Compilation

Replace the conservative scanner with real schema compilation/generation.
The final direction uses native `capnp-es` generated modules instead of keeping
the prototype app-object transport.

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
- schema code is generated through the selected native `capnp-es` compiler
- generated app-object compatibility bindings are no longer part of the public
  schema path

### Phase 2: Stable Public Generated API

Stabilize the app-facing generated API around native `capnp-es` classes and
Sandstorm helper functions.

Progress:

- generated `capnp-es:` modules expose native `Interface.Client` and
  `Interface.Server` classes plus `_capnp` metadata such as `typeIdHex`
- `sandstorm:capnp` exposes native helper functions for exporting, connecting,
  saving, restoring, and deriving Powerbox descriptors from generated
  interfaces
- the hand-written `makeCapnpInterfaceBinding()` API and `capnp:*` declaration
  surface have been removed; schema-defined protocols use `capnp-es:` only

Deliverables:

- finalize `exportNativeCapnp()`
- finalize `connectNativeCapnp()`
- finalize `restoreNativeCapnp()`
- finalize `nativeCapnpPowerboxDescriptor()`
- expose generated interface IDs through `_capnp` metadata
- document the generated `capnp-es` metadata shape consumed by Sandstorm
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
- the API uses native Cap'n Proto transport for schema-defined protocols

### Phase 3: Generic Capability Slots

Generalize current capability slot support so typed methods can pass and
return all Sandstorm capability kinds that matter to isolate apps.

Progress:

- native `capnp-es` generated clients and servers can pass capability slots
  through Sandstorm's native bridge
- generated modules can import Sandstorm schemas such as
  `capnp-es:/sandstorm/web-session.capnp`
- the object-store example shows an RPC control plane returning a generated
  `WebSession` client for fetch-shaped data-plane reads

Add support for generic capability slots:

- fetch-shaped WebSession / ApiSession capabilities
- outbound HTTP capabilities
- future public Cap'n Proto interface capabilities
- capability lists and structs containing capabilities
- promise/pipelined capability results where feasible

This unlocks control-plane methods that return data-plane capabilities, such
as `openObject()` returning an object with `fetch()`.

Scope note: schema-defined capability slots should ride the native Cap'n Proto
bridge, where the transport can preserve the actual public interface instead
of forcing every slot through `IsolateObjectCapability`.

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
  - typed native capabilities passing other typed native capabilities
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

Progress:

- supervisor exposes `/capnp/bridge-info`, and `sandstorm:api` exposes
  `capnpBridgeInfo()`, so helper code can feature-detect the native bridge
  protocol
- the bridge info advertises protocol version `0` and turns on feature flags
  only as paths become real; native RPC, native calls, native exports, and
  capability slots are now implemented for the supported schema path
- `isolate-native-capnp-bridge.capnp` defines the first native bridge request,
  response, payload, exception, lifecycle, and capability-slot envelopes, while
  `isolate-supervisor-internal.capnp` continues to own the app-object
  compatibility transport
- `sandstorm:capnp` exposes `negotiateNativeCapnpBridge()` so helper code has
  one conservative feature-detection path for native transport availability
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
- browser calls use the native browser `capnp-es` bridge for schema RPC
- Powerbox request descriptors can be generated from schema metadata
- browser-side tests can use the in-memory transport

Implementation work:

- define browser capability handle representation
- implement native browser `capnp-es` transport over a restricted Sandstorm
  capability bridge
- remove Cap'n Web/app-object browser RPC prototype transports once native
  browser RPC reaches feature parity
- generate browser-safe modules from the same schema
- expose the same client method names and TypeScript types
- map browser Powerbox results to generated clients
- support local/in-memory browser tests
- document frontend bundler behavior for `capnp:` imports

Progress:

- the supervisor and browser system routes can now serve native browser
  `capnp-es` schema modules through `/__sandstorm/capnp-es/...` and the bundled
  `@mnutt/capnp-es` runtime imports through `/capnp-es/...`, giving browser
  code loadable native modules before Powerbox/browser transport wiring
- browser system routes now expose `/__sandstorm/native-capnp/bridge-info` and
  `/__sandstorm/native-capnp/call`, forwarding negotiation metadata and binary
  native bridge envelopes to the supervisor without exposing service bindings
  directly to browser code; when the `capnp-es` compiler is configured, `spk`
  also generates the native bridge schema as a platform module
- browser system routes now serve `/__sandstorm/native-capnp/client.js`, a
  native-only browser helper that imports the served `capnp-es` runtime and
  native bridge schema, exposes generated-client helpers such as
  `connectBrowserNativeCapnp()` and `restoreBrowserNativeCapnp()`, and can
  save/drop Sandstorm capability handles through the binary supervisor bridge
- the native browser helper now exposes schema-derived Powerbox descriptor
  helpers plus `requestBrowserNativeCapnp()` / `claimBrowserNativeCapnpToken()`;
  browser code can request a user-mediated app-interface capability, claim the
  returned token through Sandstorm's normal claim route, and receive a generated
  `capnp-es` client without going through the old app-object browser transport
- the unreleased `sandstorm:browser-capnp:*` companion module generator,
  `__sandstorm_isolate_runtime/capnp-browser` package output,
  `/capnp/browser-module` supervisor route, and `/__sandstorm/capnp/...`
  browser route have been removed; browser schema RPC now uses served
  `capnp-es` modules plus `/__sandstorm/native-capnp/client.js`

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
- the isolate test app now exposes an ad hoc
  `/native-capnp-performance-benchmark` route comparing generic JavaScript
  object RPC against native `capnp-es` generated clients in the same
  supervisor. Generic JavaScript object RPC is reported both with the
  same-isolate shortcut and with an explicit supervisor-routed transport so
  local dispatch savings are visible separately. It reports direct in-memory calls, live exported calls,
  restore-once/live-handle reuse, restore-per-call, concurrent outstanding
  calls, capability results, capability arguments, generated `WebSession`
  calls, typed stream-capability return, and fetch data-plane throughput. The
  route intentionally returns characterization data rather than CI timing
  assertions. Useful query knobs are `iterations`, `warmup`, `rounds`,
  `concurrency`, `batches`, `warmupBatches`, `restoreIterations`,
  `restoreWarmup`, `payloadRounds`, `payloadWarmup`, and comma-separated
  `bytes`. RPC percentile fields are computed over per-round batch averages,
  not individual call samples, to keep timing overhead from dominating
  sub-millisecond calls.
- current characterization boundary: generated `capnp-es` calls can have
  multiple outstanding calls in flight, but the helper layer does not expose a
  JavaScript promise-pipelining API yet. Large binary payloads should continue
  to use fetch/data-plane paths; typed RPC can carry byte bodies, but fetch is
  the measured streaming path.
- native `capnp-es` RPC now defaults to a persistent WebSocket-backed Cap'n
  Proto RPC session instead of routing every RPC message through
  `/capnp/call`; callers can still force the previous fetch transport with
  `transport: "fetch"` for comparison/debugging. Browser generated clients use
  the same WebSocket RPC session through
  `/__sandstorm/native-capnp/rpc-session`, while keeping the browser-facing
  authority boundary rooted in Sandstorm capability handles instead of service
  binding names. An ad hoc 10k-call, 1k-warmup, 5-round benchmark measured live
  native WebSocket RPC at about 0.13ms/call, old native fetch RPC at about
  0.34ms/call, and generic JavaScript RPC via supervisor at about 0.26ms/call;
  with 16 outstanding calls, native WebSocket RPC measured about 0.085ms/call
  vs old native fetch RPC at about 0.31ms/call.

### Phase 7: Packaging, Publishing, And Migration

Make schema-defined isolate capabilities publishable and maintainable.

Deliverables:

- schema-defined exports materialize normal `UiView.ViewInfo.matchRequests`
- packaged generated code includes the schemas needed by isolate and browser
  bindings
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
- generated `capnp:` app-object compatibility modules have been removed:
  `spk dev-isolate` and `spk pack` now materialize schema code only for
  `capnp-es:` imports, reject old `capnp:` isolate imports with a clear error,
  and no longer include the virtual `capnp:/...` wrapper support modules
- native worker helpers now expose `nativeCapnpPowerboxDescriptor(env,
  InterfaceClass)` and `nativeCapnpPowerboxDescriptorInfo(...)`, backed by the
  same supervisor descriptor route as browser bindings
- `examples/isolate-file-store-rpc` documents and exercises a schema-defined
  native Cap'n Proto capability that can be offered or used to fulfill Powerbox
  requests, keeping directory listing and small file reads in RPC while calling
  out that large byte streams should use a fetch/data-plane capability
- the package-level `Manifest.publicInterfaces` prototype was removed; public
  schema-defined isolate capabilities should advertise through Sandstorm's
  existing `UiView.ViewInfo.matchRequests` descriptor path instead of creating a
  second package-manifest discovery mechanism
- `spk dev-isolate --app-interface <capnp-specifier>#<Interface>` now resolves
  the named Cap'n Proto interface ID and materializes a normal
  `PowerboxDescriptor` tag in the generated `bridgeConfig.viewInfo.matchRequests`
- `spk powerbox-descriptor <capnp-specifier>#<Interface>` now emits the same
  single-tag packed `PowerboxDescriptor` used by browser Powerbox requests, with
  `--format=capnp` for package authors who want a pasteable
  `viewInfo.matchRequests` descriptor and `--format=json` for tooling/tests
- the packaged-isolate integration test now exercises schema-defined provider
  advertisement through `bridgeConfig.viewInfo.matchRequests`, and
  `docs/developing/isolate-grains.md` plus `examples/isolate-file-store-rpc`
  document the dev-mode and packaged-app flows
- `spk capnp-abi [--interface <name>] <schema.capnp>` now emits a stable JSON
  dump of public interface IDs, method ordinals, generated parameter/result
  struct IDs, and source-level parameter/result fields so CI can snapshot or
  diff schema-defined public protocols without involving package build state
- `spk capnp-abi --check <baseline.json> <schema.capnp>` now compares the
  current schema against a committed ABI dump, rejecting removed/changed
  interfaces, methods, ordinals, generated struct IDs, and existing fields while
  allowing additive interfaces, methods, and appended fields

Exit criteria:

- an app can publish a schema-defined capability as part of its package
- other apps can discover/request it through Powerbox using normal
  `PowerboxDescriptor` matching against cached `ViewInfo.matchRequests`
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

Progress:

- `docs/developing/isolate-grains.md` now presents `capnp-es:` generated
  modules plus `exportNativeCapnp()` / `restoreNativeCapnp()` as the schema
  authoring path for native cross-grain and legacy interop
- generated `capnp:` schema-shaped app-object bindings are removed instead of
  retained as a compatibility fallback; JavaScript-defined app-object RPC
  remains only for current helper/UI internals pending a separate cleanup
- the hand-written `makeCapnpInterfaceBinding()` helper and `capnp:*`
  TypeScript declaration surface have also been removed, so app authors do not
  have a second schema-shaped app-object API alongside native `capnp-es`
- unreleased Cap'n Web and app-object browser RPC prototype schema transports
  have been removed instead of kept as compatibility fallbacks; `fetch()`
  remains supported for HTTP-shaped and large data-plane capabilities

## Open Questions

- How much Cap'n Proto pipelining can be exposed cleanly in JavaScript?

## Decisions

- `.capnp` is the source of truth for public cross-grain protocols. TypeScript
  classes may still be useful for local/private adapters, but they should not
  define public Powerbox protocols.
- `@mnutt/capnp-es` is the selected isolate-side native Cap'n Proto runtime,
  with Sandstorm-owned helper modules layered around it.
- Apps advertise offered public interfaces through Sandstorm's existing
  `UiView.ViewInfo.matchRequests` / `PowerboxDescriptor` path. There is no
  separate isolate package-metadata discovery mechanism.
- Schema evolution is surfaced through `spk capnp-abi` dumps and
  `spk capnp-abi --check` for CI.
- The default browser schema RPC transport is native `capnp-es` over a
  restricted Sandstorm capability bridge. Since isolate browser RPC has not
  shipped, there is no fallback/backwards-compatibility transport to preserve.
- `fetch()` remains the right public surface for HTTP-shaped APIs and large
  data-plane flows.

## Recommended Direction

Use schema-first public protocols:

- `.capnp` is the source of truth for cross-grain interfaces.
- `capnp-es:` imports provide native generated clients and servers for public
  cross-grain interfaces.
- `capnp:` generated app-object schema imports are removed; use `capnp-es:`.
- Sandstorm tooling bundles the compiler/generator used by packaged isolates.
- Isolates receive typed generated stubs and server adapters.
- Legacy grains see ordinary Cap'n Proto interfaces.
- Browsers use the same generated interface API over a browser-appropriate
  native `capnp-es` bridge.
- Fetch remains the preferred data plane for HTTP and large byte streams.

This provides one authoring model without weakening Sandstorm's object-
capability security model.
