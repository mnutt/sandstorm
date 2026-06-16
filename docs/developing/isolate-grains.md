# Isolate grains

Isolate grains are an experimental Sandstorm app runtime backed by a
Worker-style JavaScript entry point and a per-grain `workerd` sidecar.

An isolate app exports a module like:

```js
export default {
  async fetch(request, env) {
    return new Response("hello");
  },
};
```

The runtime exposes explicit bindings through `env` and helper modules such as
`sandstorm:api`. From outside the app, the grain is still a normal Sandstorm
grain: the shell talks to a supervisor, opens `UiView` / `WebSession` sessions,
uses Powerbox, saves capabilities, and applies Sandstorm's usual capability
model.

## Pre-release compatibility policy

Isolate grains are not a stable app-runtime contract yet. Until Sandstorm
explicitly ships and documents isolate grains as a supported runtime, app
authors should treat the isolate API surface as experimental.

This means the following pieces may change without a backwards-compatibility
shim:

- the `spk dev-isolate` command and generated package layout
- `Manifest.Command.isolate` and related package schema fields
- injected helper modules such as `sandstorm:api`, `sandstorm:rpc`, and
  `capnweb`
- JavaScript helper names, method signatures, and return shapes
- supervisor-local helper endpoints behind `SANDSTORM_API`, `POWERBOX`, and
  `STORAGE`
- route-backed capability app-ref formats
- example app layouts and recommended project structure

This policy only applies to unreleased isolate-grain APIs. Existing
Linux/process grain behavior remains compatibility-sensitive.

During the pre-release period, Sandstorm should prefer clean API and protocol
changes over compatibility with earlier isolate prototypes. If an isolate API
shape is awkward, misleading, or too narrow, fix it before release instead of
preserving it.

## Current authoring guidance

For local experiments, start with:

```sh
spk dev-isolate --title "Isolate Hello" examples/isolate-hello/worker.js
```

For a fuller app shape, see `examples/isolate-app-skeleton/`. Its request
handler follows the current recommended order:

1. Create `const api = sandstorm(request, env)`.
2. Serve conventional Sandstorm helper routes with `api.serveSystemRoutes()`.
3. Serve Cap'n Web RPC routes with
   `api.serveRpc(...)`.
4. Handle normal app routes.

Expect this guidance to evolve while isolate grains remain experimental.

## TypeScript authoring

Sandstorm ships TypeScript declarations for the injected isolate helper
modules:

- `src/sandstorm/isolate/api.d.ts` for `sandstorm:api`
- `src/sandstorm/isolate/rpc.d.ts` for `sandstorm:rpc`
- `src/sandstorm/isolate/capnweb.d.ts` for the injected `capnweb`

These declarations describe the runtime APIs that `workerd` receives from
Sandstorm. They do not imply that Sandstorm transpiles TypeScript source yet.
For now, TypeScript isolate apps should build to JavaScript before running
`spk dev-isolate` or packing an app.

The recommended current tool is `esbuild`, with Sandstorm-provided modules
marked external so imports such as `sandstorm:api` stay in the generated
worker:

```sh
npm install --save-dev esbuild typescript
npx tsc --noEmit
npx esbuild worker.ts \
  --bundle \
  --format=esm \
  --platform=browser \
  --target=es2022 \
  --external:sandstorm:api \
  --external:sandstorm:rpc \
  --external:capnweb \
  --outfile=worker.js
spk dev-isolate --title "TypeScript isolate" worker.js
```

For a complete small example, see `examples/isolate-typescript/`.

Use a local declaration shim in the app source tree:

```ts
/// <reference path="../../src/sandstorm/isolate/capnweb.d.ts" />
/// <reference path="../../src/sandstorm/isolate/api.d.ts" />
/// <reference path="../../src/sandstorm/isolate/rpc.d.ts" />
```

Then import normal values and types from `sandstorm:api`:

```ts
import { RpcTarget, sandstorm } from "sandstorm:api";
import type { SandstormEnv, SessionInfo } from "sandstorm:api";
```

Use `SandstormEnv` as the starting environment type, then extend it with
app-specific bindings:

```ts
interface Env extends SandstormEnv {
  STORAGE: SandstormEnv["STORAGE"];
}
```

The `RpcTarget` base class is also exported from `sandstorm:api`, so app code
does not need to import `capnweb` directly for common RPC targets:

```ts
class AppApi extends RpcTarget {
  session(): SessionInfo {
    return sandstorm(this.request, this.env).session();
  }
}
```

When browser code uses `newSandstormRpcSession()` with JavaScript's `using`
declaration, await RPC calls before leaving the `using` scope:

```js
using rpc = newSandstormRpcSession();
return await rpc.session();
```

Do not return the raw RPC promise from inside the `using` scope:

```js
using rpc = newSandstormRpcSession();
return rpc.session(); // Wrong: the session is disposed before the call resolves.
```

Do not point `spk dev-isolate` at `.ts` files. The command expects JavaScript
modules that `workerd` can load directly. For the first isolate runtime
iteration, TypeScript transpilation is intentionally outside `spk
dev-isolate`; use an app-local build step such as the `esbuild` example above
and pass the generated `.js` file to `spk`.

## Compatibility dates and flags

Isolate manifests include a `compatibilityDate` and optional
`compatibilityFlags`, modeled after the Workers/workerd compatibility model.

For `spk dev-isolate`, the default compatibility date is currently
`2025-01-01`:

```sh
spk dev-isolate --compatibility-date 2025-01-01 worker.js
```

Packaged isolate apps should set a compatibility date explicitly in their
manifest. The date is part of the app's runtime contract: future Sandstorm or
workerd changes can use it to preserve behavior for existing apps while newer
apps opt into newer semantics.

Compatibility flags are for narrow runtime behavior switches. They should not
be used as general app configuration. App configuration should live in explicit
bindings, storage, or app code.

While isolate grains are experimental, compatibility dates and flags are
recorded and forwarded to workerd, but they do not yet imply a stable public
compatibility guarantee for the Sandstorm-specific helper APIs. The
pre-release policy above still applies to `sandstorm:api`, `sandstorm:rpc`,
the generated package layout, and supervisor-local helper endpoints.

## Helper module versioning

Isolate apps should import Sandstorm-provided helpers through stable,
unversioned module specifiers:

```js
import { sandstorm } from "sandstorm:api";
import { newSandstormRpcSession } from "sandstorm:rpc";
import { RpcTarget } from "sandstorm:api";
```

Do not use versioned import paths such as `sandstorm:api/v1`. Sandstorm will
use the app's isolate compatibility date and compatibility flags to preserve
or intentionally change helper behavior once isolate grains become a supported
runtime.

For diagnostics and conditional code, the helpers export explicit version
constants:

```js
import {
  SANDSTORM_API_VERSION,
  SANDSTORM_RPC_VERSION,
  SANDSTORM_CAPNWEB_VERSION,
  SANDSTORM_HELPER_VERSIONS,
} from "sandstorm:api";
```

During the experimental pre-release period, the Sandstorm helper surface
versions are `0`. Treat `0` as "not stable yet", not as a supported v0
compatibility line. When Sandstorm promotes isolate grains to a supported
runtime, the public helper surface should move to version `1`, and future
breaking behavior changes should be gated by compatibility dates or explicit
flags rather than by changing import paths.

`SANDSTORM_CAPNWEB_VERSION` reports the pinned `capnweb` package version
injected by Sandstorm. The `capnweb` import should still be treated as the
Cap'n Web API surface, with Sandstorm deciding which package version is
available for a given isolate runtime.

## Current public helper surface

The preferred app-author entry point is:

```js
import { RpcTarget, sandstorm, validate } from "sandstorm:api";
```

Create `const api = sandstorm(request, env)` once per request and prefer these
methods in application code:

- `api.session()` for Sandstorm session and user metadata
- `api.storage()` for isolate storage
- `api.powerbox()` for Powerbox claim, save, restore, offer, and drop helpers
- `api.webSession()` and `api.apiSession()` for route-backed capabilities
- `api.capability()`, `api.registerCapability()`, `api.unregisterCapability()`,
  and `api.persistentCapability()` for JavaScript object capabilities
- `api.serveSystemRoutes()` before normal app routes
- `api.serveRpc()` for Cap'n Web RPC endpoints

The preferred Powerbox lifecycle names are:

- `claimRequest(token)` for claiming a browser-returned Powerbox token
- `claimAndStore(token, options)` and `claimAndStoreRequest(result, options)`
  for the common claim, save, and store pattern
- `restoreSaved(token)` and `dropSaved(token)` for durable Sandstorm tokens the
  app already has
- `restoreStored(options)`, `fetchStored(options, input, init)`, and
  `dropStored(options)` for token strings stored in isolate storage
- `claimedCapability(handle)` for wrapping a browser-returned claimed handle
- `apiSessionDescriptor(options)` and `outboundHttpDescriptor(options)` for
  generating packed descriptors used by browser-mediated Powerbox requests
- `offer()`, `fulfillRequest()`, and `tieToUser()` accept `descriptor` or
  `powerboxDescriptor` when passing an app-defined packed `PowerboxDescriptor`
  for custom Powerbox protocols

The following exports are public but low-level. Prefer the `sandstorm()`
facade unless a custom framework or test needs direct access:

- `storage(env)`
- `powerbox(request, env)`
- `getSession(request)`
- `apiTarget(request, env)`
- `serveSystemRoutes(request, env)`
- `servePowerboxDescriptors(request, env)`
- `rpcClientScript()`
- `rpcResponse(request, target, options)`
- `serveRpc(request, target, options)`
- `ClaimedCapability` and `SavedCapability`

Do not construct `ClaimedCapability` directly in application code unless you
are writing low-level adapter code. Use `api.powerbox().claimedCapability(...)`
for browser-returned handles and `api.powerbox().restoreSaved(...)` for saved
tokens.

## Saved capability token ownership

Isolate apps can receive Sandstorm capabilities through Powerbox or by minting
route-backed capabilities with helpers such as `webSession()`, `apiSession()`,
or `capability()`.

Route-backed `webSession()` and `apiSession()` capabilities are intended for
other holders: Powerbox offers, saved tokens, restored capabilities, and calls
from another session or grain. Do not rely on recursively fetching a
route-backed WebSession capability from the same worker request that created
it. If code in the same worker needs the same behavior, call a local function
or route shared logic directly. The helper may support some direct calls for
tests and simple cases, but same-request self-fetch is not a compatibility
contract before isolate APIs are released.

A live capability handle is represented in JavaScript as a `ClaimedCapability`.
It is process-local supervisor state. It should be dropped when the app is done
with it:

```js
await cap.drop();
```

Saving a live handle creates a durable Sandstorm API token:

```js
const saved = await cap.save({ label: "Chosen document" });
```

The returned `SavedCapability` contains a token string. That string is app
state. Sandstorm creates and validates the underlying durable token, but the
isolate app decides where to store the token string. The usual choices are:

- isolate storage, through `sandstorm(request, env).storage()`
- an app-defined data file or database
- not storing it at all, if the grant should be used only during the current
  interaction

For the common storage-backed pattern:

```js
const saved = await cap.save({ label: "Chosen document" });
await sandstorm(request, env).storage().put("chosen-document-token", saved.token);
```

On a later request, the app reads the token and restores a new live handle:

```js
const token = await sandstorm(request, env).storage().get("chosen-document-token");
const restored = await sandstorm(request, env).powerbox().restoreSaved(token);
```

Restoration returns a `ClaimedCapability` handle, not a guessed interface
stub. The app that saved the token owns the context needed to decide how to use
it: call `restored.fetch()` for WebSession-shaped HTTP capabilities,
`restored.asRpc<T>()` for app-defined object-capability protocols that the app
expects, or wrap it in a typed adapter such as
`api.powerbox().outboundHttpCapability(restored)` for OutboundHttpSession
capabilities. Future typed restoration can add explicit metadata, but tokens
alone should not imply that the runtime can safely infer a JavaScript type.

Dropping a live handle with `cap.drop()` only releases that in-memory claimed
handle. It does not revoke saved durable tokens. To revoke a saved token, call:

```js
await saved.drop();
```

or:

```js
await sandstorm(request, env).powerbox().dropSaved(token);
```

If the token string is stored in isolate storage, the app should also delete
that stored copy after revocation. The helper
`powerbox().dropStored({ storageKey })` performs both steps for the
common case.

The helper `powerbox().claimAndStoreRequest()` handles the common browser
Powerbox flow: accept the browser result, claim it if needed, save it, store
the saved token string, and return the live and saved handles.
`powerbox().fetchStored()` handles the common later-use path: restore a saved
token from storage, fetch through it, buffer the response, and drop the live
handle. Use `claimAndStore()` and `restoreSaved()` directly when code needs
lower-level control, multiple calls, or streaming response bodies.
Storage-backed helpers use non-throwing result shapes for expected absence:
`restoreStored()` returns `{ ok: true, found: false, ... }` when no token is
stored, and `dropStored()` returns `{ ok: true, dropped: false, ... }` when
there is nothing to revoke.
`persistentCapability()` does the analogous storage-backed setup for
app-defined stable object capabilities.

## Service bindings

Isolate manifests can define workerd-style service bindings. Today these are
same-workerd bindings: the service name resolves inside the generated workerd
config for the grain, such as a loopback binding to `main`.

Do not use raw service binding names as cross-grain authority. If an isolate app
needs to talk to another grain or an external provider, obtain a Sandstorm
capability through Powerbox, save the returned token if needed, and restore/use
that capability later. That keeps authority visible to Sandstorm's existing
object-capability model instead of creating an ambient name service.

Development-only mocks can still use local service bindings, but production
cross-grain wiring should be represented as saved capabilities or explicit
future capability bindings, not as unresolved global service names.

## Browser-first Powerbox requests

For now, isolate apps should open new Powerbox requests from the browser, then
claim the returned token in the worker. Treat this as a deliberate boundary:
the browser asks the user to choose authority, while the worker owns durable
app state and later use of that authority.

The recommended flow is:

1. The worker serves the conventional helper endpoints with
   `api.serveSystemRoutes()`.
2. Browser code imports `requestPowerbox()`, `requestApiPowerbox()`,
   `requestOutboundHttpPowerbox()`, `requestAndClaimPowerbox()`,
   `requestApiCapability()`, or `requestOutboundHttpCapability()` from
   `/rpc-client.js`.
3. The browser helper uses Sandstorm's existing `postMessage` Powerbox flow, so
   the shell can show the normal picker UI.
4. The browser sends the returned token or claimed handle to the worker in an
   app-defined request.
5. The worker claims the token, optionally saves it, stores the saved token in
   app storage, and uses the resulting `ClaimedCapability`.
6. On later requests, the worker restores a saved token from storage before
   using it.
7. When the grant is no longer needed, the worker drops the live handle and
   revokes the saved token.

Pass `null` or omit the query argument to `requestPowerbox()` and
`requestAndClaimPowerbox()` when asking the user to paste an offered webkey.
Pass an array of packed descriptors when asking the shell to show matching
Powerbox cards.

Custom app-to-app protocols should use a real Sandstorm Powerbox descriptor,
not just a JavaScript or TypeScript interface name. Define the protocol tag in
Cap'n Proto, pack its `PowerboxDescriptor`, request that packed descriptor from
browser code, and pass the same packed descriptor as `descriptor` when the
provider calls `fulfillRequest()` with the capability it wants to return.

Worker code cannot directly open the Powerbox picker. Sandstorm's underlying
`SessionContext.request()` operation is not implemented; use browser
`postMessage` helpers from `/rpc-client.js`, then send the returned token or
claimed handle to the worker for `claimRequest()`, `claimAndStoreRequest()`,
or `claimedCapability()`.

For the common browser-to-worker flow:

```js
// Browser module.
import { requestApiCapability } from "./rpc-client.js";

const requested = await requestApiCapability({
  canonicalUrl: "https://api.example.test/v1",
  oauthScopes: ["read"],
});

await fetch("/claim", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(requested),
});
```

To request outbound HTTPS authority, use the outbound HTTP helper instead of
constructing a provider descriptor manually:

```js
// Browser module.
import { requestOutboundHttpCapability } from "./rpc-client.js";

const requested = await requestOutboundHttpCapability({
  baseUrl: "https://api.example.test/",
  methods: ["GET", "POST"],
});
```

The browser receives the same request result shape as other Powerbox helpers.
Send it to the worker and use `claimAndStoreRequest()`, `claimRequest()`, or
`claimedCapability()` exactly as in the API-session flow.

The worker route that receives this request should decide ownership. For a
lasting connection, save the returned request result into app-owned storage:

```js
// Worker route.
const api = sandstorm(request, env);
const requested = await request.json();
const claimed = await api.powerbox().claimAndStoreRequest(requested, {
  storageKey: "chosen-api-token",
  label: "Chosen API",
});

const outbound = api.powerbox().outboundHttpCapability(claimed.capability);
const response = await outbound.fetch("status", {
  headers: {
    authorization: `Bearer ${apiToken}`,
  },
});
await claimed.capability.drop();
```

`ClaimedCapability.fetch()` is for WebSession-shaped capabilities. Use
`powerbox().outboundHttpCapability(capability).fetch(...)` for outbound HTTP
grants so normal API headers such as `Authorization` are preserved and routed
through Sandstorm's OutboundHttpSession interface.

`claimAndStoreRequest()` accepts either the full browser result object or a raw
Powerbox request token. If browser code uses `requestApiCapability()` or
`requestAndClaimPowerbox()`, the helper saves the already-claimed capability
handle. If browser code uses `requestApiPowerbox()` or `requestPowerbox()`, the
helper claims the request token first.

For a short-lived action that should not be saved, claim and use the token
directly:

```js
const { token } = await request.json();
const claimed = await api.powerbox().claimRequest(token);
const response = await claimed.fetch("/status");
await claimed.drop();
```

If worker code receives an already-claimed handle and wants to use it without
saving it, wrap it with the request-local helper instead of constructing a
capability directly:

```js
const { capability: handle } = await request.json();
const claimed = api.powerbox().claimedCapability(handle);
```

Later, restore the saved token, use the restored live handle, and drop it
automatically with `fetchStored()`:

```js
const api = sandstorm(request, env);
const response = await api.powerbox().fetchStored(
  { storageKey: "chosen-api-token" },
  "/status",
);
```

`fetchStored()` buffers the response before dropping the live handle. Use
`restoreSaved()` when code needs the live handle for more than one call or for
streaming response bodies.

To revoke the stored grant, drop both the durable token and the app's stored
copy:

```js
await api.powerbox().dropStored({ storageKey: "chosen-api-token" });
```

Use `inspectPowerboxQuery()` while developing if a query does not show the
Powerbox cards you expect:

```js
import { inspectPowerboxQuery } from "./rpc-client.js";

console.log(await inspectPowerboxQuery({
  canonicalUrl: "https://api.example.test/v1",
  oauthScopes: ["read"],
}));
```

In dev/test mode, the shell also shows a Powerbox diagnostics block when a
query has no matching cards.

Worker-side direct request helpers are not the recommended author flow yet.
The current real shell expects Powerbox UI requests to originate through the
browser `postMessage` path. Keeping the public author model browser-first also
makes the user gesture and UI boundary explicit.

## Stable object-capability IDs

Isolate apps can export JavaScript objects as Sandstorm capabilities:

```js
import { RpcTarget, sandstorm } from "sandstorm:api";

class Counter extends RpcTarget {
  get() {
    return { value: 0 };
  }
}

const cap = await sandstorm(request, env).capability(new Counter());
```

Anonymous object capabilities are transient. They exist only while the current
worker process has the exported target registered. They are useful for short
interactions, callbacks, and returned child objects, but they should not be
saved.

To make an app-defined object capability restorable, the app must give it a
stable ID:

```js
const counter = new Counter();

export default {
  async fetch(request, env) {
    const api = sandstorm(request, env);
    api.registerCapability(counter, { id: "main-counter" });

    const cap = await api.capability(counter, {
      id: "main-counter",
      persistent: true,
    });

    return Response.json(await cap.save({ label: "Main counter" }));
  },
};
```

Stable IDs are app-owned route names. Once an app saves a capability with a
stable ID, that ID becomes part of the app's compatibility contract. Future
versions of the app should keep registering the same ID for a compatible
target, or deliberately handle old saved capabilities before changing the ID.

Use URL-safe, descriptive IDs such as:

- `main-document`
- `project-settings-v1`
- `folder.2026-view`

Do not derive stable IDs from secrets. Do not use user-provided strings without
validation and namespacing. The ID is not the authority; the Sandstorm token is
the authority. The ID is the app's local restore route for a capability that
Sandstorm has already authorized.

If a target's behavior changes incompatibly, use a new stable ID or keep a
compatibility adapter registered under the old ID. For example:

```js
api.registerCapability(new ProjectSettingsV1Adapter(), {
  id: "project-settings-v1",
});
api.registerCapability(new ProjectSettingsV2(), {
  id: "project-settings-v2",
});
```

For the common case, prefer `persistentCapability()`:

```js
const durable = await sandstorm(request, env).persistentCapability(counter, {
  id: "main-counter",
  storageKey: "main-counter-token",
  label: "Main counter",
});
```

This registers the target under the stable ID, restores a saved token from
storage if one exists, or mints and saves a new persistent capability on first
use.
