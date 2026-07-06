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
- injected helper modules such as `sandstorm:api`, `sandstorm:rpc`,
  `sandstorm:capnp`, and `capnweb`
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
- `src/sandstorm/isolate/capnp.d.ts` for `sandstorm:capnp` and generated
  `capnp:` imports

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

Eventually, we will publish a sandstorm-isolates package. Until then, you
will need to use a local declaration shim in the app source tree:

```ts
/// <reference path="../../src/sandstorm/isolate/capnweb.d.ts" />
/// <reference path="../../src/sandstorm/isolate/api.d.ts" />
/// <reference path="../../src/sandstorm/isolate/rpc.d.ts" />
/// <reference path="../../src/sandstorm/isolate/capnp.d.ts" />
```

Then import normal values and types from `sandstorm:api`:

```ts
import { AppRpcTarget, sandstorm } from "sandstorm:api";
import type { SandstormEnv, SessionInfo } from "sandstorm:api";
```

Use `SandstormEnv` as the starting environment type, then extend it with
app-specific bindings:

```ts
interface Env extends SandstormEnv {
  STORAGE: SandstormEnv["STORAGE"];
}
```

The `AppRpcTarget` base class is exported from `sandstorm:api` for RPC targets
that need per-request Sandstorm authority. It stores `request` and `env` as
protected fields and exposes `this.api` as a cached `sandstorm(request, env)`
helper:

```ts
class AppApi extends AppRpcTarget<Env> {
  session(): SessionInfo {
    return this.api.session();
  }
}
```

Use `RpcTarget` directly for stateless targets, callbacks, and local objects
whose behavior does not need `request`, `env`, or `this.api`.

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

`spk dev-isolate` supports two schema import forms:

- `capnp:` imports generate Sandstorm's schema-shaped app-object compatibility
  binding. Use this for local tests, browser companion modules, Powerbox
  descriptor helpers, and app-object control-plane RPC.
- `capnp-es:` imports generate native `@mnutt/capnp-es` classes. Use this for
  public cross-grain Cap'n Proto interfaces, legacy grain interop, and typed
  calls over Sandstorm's native bridge.

### App-object compatibility modules

Use `capnp:` imports for simple schema-first app-object RPC:

```js
import { Greeter } from "capnp:./greeter.capnp";
```

The generated JavaScript module exports one binding per Cap'n Proto interface
name, plus a default schema object. The binding can expose a server target with
`Greeter.implement(methods)`, cast a Sandstorm capability with
`Greeter.cast(capability)`, or create an in-memory test client with
`Greeter.local(methods)`.

Generated `capnp:` modules use the injected `sandstorm:capnp` helper for their
runtime binding logic. App code should normally import generated schemas
through `capnp:` rather than hand-writing `makeCapnpInterfaceBinding()` calls,
but the helper is available for tests and generated-code plumbing.

The shared `capnp.d.ts` declaration can describe the default schema object and
generic helper shape, but it cannot infer schema-specific named exports from a
wildcard module by itself. TypeScript code should either add an app-local
declaration for named imports or use the default schema import with a local
type assertion:

```ts
import schema, { type CapnpInterfaceBinding } from "capnp:./greeter.capnp";

interface GreeterMethods {
  hello(request: { name?: string }): Promise<{ message: string }>;
}

const Greeter = schema.Greeter as CapnpInterfaceBinding<GreeterMethods>;
```

The `capnp:` binding is an authoring bridge over Sandstorm's app-object RPC
transport. It is useful for private/local app APIs and browser helper modules,
but it is not the native Cap'n Proto transport that legacy grains speak
directly.

### Native Cap'n Proto modules

Use `capnp-es:` imports when the capability is a public schema-defined
interface that other isolate grains or legacy Cap'n Proto grains should call:

```js
import { sandstorm } from "sandstorm:api";
import { exportNativeCapnp, restoreNativeCapnp } from "sandstorm:capnp";
import { Greeter } from "capnp-es:./greeter.capnp";

const greeterTarget = {
  async hello({ name = "world" } = {}) {
    return { message: `hello ${name}` };
  },
};

export default {
  async fetch(request, env) {
    const api = sandstorm(request, env);
    const system = await api.serveSystemRoutes();
    if (system) return system;

    const url = new URL(request.url);

    if (url.pathname === "/export-greeter") {
      const capability = await exportNativeCapnp(api, Greeter, greeterTarget, {
        interfaceName: "Greeter",
      });
      return Response.json({ capability });
    }

    if (url.pathname === "/call-saved-greeter") {
      const token = url.searchParams.get("token");
      const client = await restoreNativeCapnp(api, token, Greeter, {
        interfaceName: "Greeter",
      });
      const result = await client.hello({ name: "isolate" });
      await client.drop();
      return Response.json(result);
    }

    return new Response("ok");
  },
};
```

The native bridge still uses Sandstorm capability handles as the authority
source. An isolate can connect to or restore only capabilities it already
holds through Powerbox, durable restore, or an explicit export result; it does
not get access to a raw Cap'n Proto vat network.

Low-level helpers such as `NativeCapnpBridgeTransport`,
`createNativeCapnpBridgeConnection()`, and bridge envelope encoders are
available in `sandstorm:capnp` for generated-code plumbing and tests. App code
should prefer `exportNativeCapnp()`, `restoreNativeCapnp()`,
`connectNativeCapnp()`, `saveNativeCapnp()`, and client `.drop()` / `.save()`
methods.

To advertise a schema-defined capability from `spk dev-isolate`, pass the
schema and interface name:

```sh
spk dev-isolate \
  --app-interface capnp:./greeter.capnp#Greeter \
  worker.js
```

For packaged isolate apps, put the same descriptor in the normal
`bridgeConfig.viewInfo.matchRequests` field. `spk powerbox-descriptor` can
derive the pasteable descriptor from the schema, avoiding hand-copied type IDs:

```sh
spk powerbox-descriptor --format capnp capnp:./greeter.capnp#Greeter
# (tags = [(id = 0x85d0f155d6c54b6d)])
```

Then include it in the package definition:

```capnp
const viewInfo :Grain.UiView.ViewInfo = (
  appTitle = (defaultText = "Greeter"),
  matchRequests = [
    (tags = [(id = 0x85d0f155d6c54b6d)])
  ]
);
```

For CI, `spk capnp-abi` dumps the public interface metadata that should remain
stable across compatible app updates:

```sh
spk capnp-abi capnp:./greeter.capnp > greeter.capnp-abi.json
```

The JSON includes interface IDs, method ordinals, generated parameter/result
struct IDs, and source-level parameter/result field names and types. Commit the
dump, then check future schema changes in CI:

```sh
spk capnp-abi --check greeter.capnp-abi.json capnp:./greeter.capnp
```

The check rejects removed interfaces, changed interface IDs, removed methods,
changed method ordinals, changed generated parameter/result struct IDs, and
changed or removed existing parameter/result fields. Adding new interfaces,
methods, or appended fields is allowed.

### Browser schema modules

Worker modules import schemas with `capnp:`:

```js
import { Greeter } from "capnp:./greeter.capnp";
```

Browser modules should import the browser companion module served by the
isolate helper routes:

```js
import { Greeter } from "/__sandstorm/capnp/greeter.capnp.js";
```

Serve those routes before normal app routes:

```js
const api = sandstorm(request, env);
const system = await api.serveSystemRoutes();
if (system) return system;
```

The browser companion module imports `/__sandstorm/rpc-client.js` internally
and exposes the same schema-shaped binding surface: `Greeter.cast(...)`,
`Greeter.local(...)`, `Greeter.powerboxDescriptor(...)`,
`Greeter.powerboxDescriptorInfo(...)`, and `Greeter.requestCapability(...)`.

If browser code is bundled, keep Sandstorm-served URLs external. A browser
bundler should not try to resolve `capnp:` or compile `.capnp` files itself
unless the app has its own matching plugin. For shared source that imports
`capnp:./greeter.capnp`, configure the browser build to rewrite that specifier
to `/__sandstorm/capnp/greeter.capnp.js`; keep `/__sandstorm/rpc-client.js`
as a runtime import.

The served browser modules are generated from schemas discovered in the
isolate worker module graph. If a schema is used only by frontend code, import
it from the worker as well or otherwise make it part of the packaged isolate
module graph so `spk dev-isolate` and `spk pack` know to generate the browser
companion module.

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

During the experimental pre-release period, `SANDSTORM_API_VERSION` and
`SANDSTORM_RPC_VERSION` are `0`. Treat `0` as "not stable yet", not as a
supported v0 compatibility line. When Sandstorm promotes isolate grains to a
supported runtime, the public helper surface should move to version `1`, and
future breaking behavior changes should be gated by compatibility dates or
explicit flags rather than by changing import paths.

`SANDSTORM_CAPNWEB_VERSION` reports the pinned `capnweb` package version
injected by Sandstorm. The `capnweb` import should still be treated as the
Cap'n Web API surface, with Sandstorm deciding which package version is
available for a given isolate runtime.

## Current public helper surface

The preferred app-author entry point is:

```js
import { AppRpcTarget, RpcTarget, sandstorm, validate } from "sandstorm:api";
```

Create `const api = sandstorm(request, env)` once per request and prefer these
methods in application code:

- `api.session()` for Sandstorm session and user metadata
- `api.storage()` for isolate storage
- `api.powerbox()` for browser-mediated Powerbox claiming and offers
- `api.webSession()` and `api.apiSession()` for route-backed capabilities
- `api.restore(token)`, `api.revoke(token)`, and `api.use(token, fn)` for
  durable saved capability tokens
- `api.export(target)` and `api.withExport(target, fn)` for transient local
  object capabilities
- `api.exportDurable(targetOrId, options)` for durable local object
  capabilities
- `api.powerboxGrants()` for storage-backed Powerbox connection helpers
- `api.powerboxFulfillment()` for provider-side Powerbox fulfillment routes
- `api.serveSystemRoutes()` before normal app routes
- `api.serveRpc()` for Cap'n Web RPC endpoints

For app-defined RPC endpoints that need Sandstorm context, extend
`AppRpcTarget` and serve a fresh instance per request:

```js
class AppApi extends AppRpcTarget {
  hello() {
    return {
      user: this.api.session().user.displayName || "anonymous user",
    };
  }
}
```

Keep using `RpcTarget` for targets that are stateless, only hold their own
local state, or only interact with capabilities passed as method arguments.

For durable object routes, pass a registry when creating the request helper:

```js
const durableCapabilities = {
  "main-counter": () => new Counter(),
};

export default {
  async fetch(request, env) {
    const api = sandstorm(request, env, {
      capabilities: durableCapabilities,
    });

    const system = await api.serveSystemRoutes();
    if (system) return system;

    return api.serveRpc(() => new AppApi(request, env));
  },
};
```

The helper modules also expose lower-level functions for tests, framework
adapters, and internal plumbing. App code should prefer the `sandstorm()`
facade unless it has a specific integration reason to pass `request` and `env`
through manually.

## Capability and token ownership

Isolate apps receive Sandstorm authority through Powerbox, route-backed helpers
such as `webSession()` and `apiSession()`, restored saved tokens, or explicitly
exported local objects.

A `Capability` is a live, process-local handle. It should be dropped when the
app is done with it:

```js
await cap.drop();
```

Saving a live handle creates a durable Sandstorm saved capability token:

```js
const token = await cap.save({ label: "Chosen document" });
```

The returned token is a string. Sandstorm creates and validates the underlying
durable token, but the isolate app decides where to store that string. The
usual choices are:

- isolate storage, through `api.storage()`
- an app-defined data file or database
- not storing it at all, if the grant should be used only during the current
  interaction

For the common storage-backed pattern:

```js
const api = sandstorm(request, env);
const cap = await api.powerbox().claim(requested);

try {
  const token = await cap.save({ label: "Chosen document" });
  await api.storage().put("chosen-document-token", token);
} finally {
  await cap.drop();
}
```

On a later request, the app reads the token and restores a fresh live handle:

```js
const api = sandstorm(request, env);
const token = await api.storage().get("chosen-document-token");

if (token) {
  await api.use(token, cap => cap.fetch("/status"));
}
```

Restoration returns a live `Capability`, not a guessed interface stub. The app
that saved the token owns the context needed to decide how to use it: call
`cap.fetch()` for fetch-shaped capabilities or `cap.rpc.method()` for
app-defined object protocols that the app expects. Tokens alone should not
imply that the runtime can safely infer a JavaScript protocol type.

Dropping a live handle with `cap.drop()` only releases that in-memory handle.
It does not revoke saved durable tokens. To revoke a saved token, call:

```js
await api.revoke(token);
await api.storage().delete("chosen-document-token");
```

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

When using app-defined RPC over a restored cross-grain capability, pass
capability handles, durable token strings, or other plain JSON values. Do not
pass raw `RpcTarget` callback objects as method arguments; raw local objects
are not portable authority. For cross-grain callbacks, first export the object
with `api.export()` or `api.exportDurable()`, then pass the resulting
capability or saved token through RPC.

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
   app storage, and uses the resulting `Capability`.
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
For a schema-defined app interface, generated `capnp:` browser modules expose
`Interface.powerboxDescriptor(env)`, and `spk powerbox-descriptor` can produce
the same packed descriptor at package/development time.

Worker code cannot directly open the Powerbox picker. Sandstorm's underlying
`SessionContext.request()` operation is not implemented; use browser
`postMessage` helpers from `/rpc-client.js`, then send the returned token or
claimed handle to the worker for `api.powerbox().claim(...)`.

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
Send it to the worker and use `api.powerbox().claim(...)` exactly as in the
API-session flow.

The worker route that receives this request should decide ownership. For a
lasting connection, claim the browser result, save the resulting capability,
and store that saved token in app-owned storage:

```js
// Worker route.
const api = sandstorm(request, env);
const requested = await request.json();
const cap = await api.powerbox().claim(requested);

try {
  const token = await cap.save({ label: "Chosen API" });
  await api.storage().put("chosen-api-token", token);

  const response = await cap.fetch("status", {
    headers: {
      authorization: `Bearer ${apiToken}`,
    },
  });
} finally {
  await cap.drop();
}
```

`cap.fetch()` supports WebSession, ApiSession, and OutboundHttpSession
capabilities. WebSession and ApiSession capabilities accept relative paths.
OutboundHttpSession capabilities also accept relative request paths under the
granted base URL, so normal API headers such as `Authorization` are preserved
and routed through Sandstorm's OutboundHttpSession interface.

`api.powerbox().claim(...)` accepts either the full browser result object or a
raw Powerbox request token. If browser code uses `requestApiCapability()` or
`requestAndClaimPowerbox()`, the helper wraps the already-claimed capability
handle. If browser code uses `requestApiPowerbox()` or `requestPowerbox()`, the
helper claims the request token first.

For a short-lived action that should not be saved, claim and use the token
directly:

```js
const { token } = await request.json();
const cap = await api.powerbox().claim(token);

try {
  const response = await cap.fetch("/status");
} finally {
  await cap.drop();
}
```

Later, restore the saved token, use the restored live handle, and drop it
automatically with `api.use()`:

```js
const api = sandstorm(request, env);
const token = await api.storage().get("chosen-api-token");

if (token) {
  const response = await api.use(token, cap => cap.fetch("/status"));
}
```

Use `api.restore(token)` directly when code needs the live handle for more than
one call or for streaming response bodies.

To revoke the stored grant, drop both the durable token and the app's stored
copy:

```js
const token = await api.storage().get("chosen-api-token");
if (token) await api.revoke(token);
await api.storage().delete("chosen-api-token");
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

const cap = await sandstorm(request, env).export(new Counter());
```

Anonymous object capabilities are transient. They exist only while the current
worker process has the exported target registered. They are useful for short
interactions, callbacks, and returned child objects, but they should not be
saved.

To make an app-defined object capability restorable, the app must give it a
stable ID:

```js
export default {
  async fetch(request, env) {
    const api = sandstorm(request, env, {
      capabilities: {
        "main-counter": () => new Counter(),
      },
    });

    const durable = await api.exportDurable("main-counter", {
      label: "Main counter",
      storageKey: "main-counter-token",
    });

    try {
      return Response.json({ token: durable.token });
    } finally {
      await durable.capability.drop();
    }
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
const api = sandstorm(request, env, {
  capabilities: {
    "project-settings-v1": () => new ProjectSettingsV1Adapter(),
    "project-settings-v2": () => new ProjectSettingsV2(),
  },
});
```

`api.exportDurable(id, options)` restores a saved token from storage if one
exists, or mints and saves a new durable object capability on first use when a
`storageKey` is provided. If the app deploys without a previously saved ID in
the durable registry, restored callbacks for that token will fail with a clear
missing-registry error. Restore the registry entry, migrate the token, or
revoke the old token.
