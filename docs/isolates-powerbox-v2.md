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

Add support for generic capability slots:

- app-object capabilities
- fetch-shaped WebSession / ApiSession capabilities
- outbound HTTP capabilities
- future public Cap'n Proto interface capabilities
- capability lists and structs containing capabilities
- promise/pipelined capability results where feasible

This unlocks control-plane methods that return data-plane capabilities, such
as `openObject()` returning an object with `fetch()`.

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

Interop tests:

- legacy grain calls isolate-defined `Greeter`
- isolate calls legacy grain `Greeter`
- isolate calls another isolate through saved/restored capability
- legacy grain receives a capability returned by an isolate
- isolate receives a capability returned by a legacy grain
- permission membrane blocks a disallowed call
- revoked capability fails on later use
- durable token restore produces a live generated client

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
