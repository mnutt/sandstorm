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

From outside the app, the grain is still a normal Sandstorm grain: the shell
talks to a supervisor, opens `UiView` / `WebSession` sessions, uses Powerbox,
saves capabilities, and applies Sandstorm's usual object-capability model.

## Pre-Release Compatibility Policy

Isolate grains are not a stable app-runtime contract yet. Until Sandstorm
explicitly ships and documents isolate grains as a supported runtime, app
authors should treat the isolate API surface as experimental.

These pieces may change without a backwards-compatibility shim:

- the `spk dev-isolate` command and generated package layout
- `Manifest.Command.isolate` and related package schema fields
- injected helper modules such as `sandstorm:api` and `sandstorm:capnp`
- JavaScript helper names, method signatures, and return shapes
- supervisor-local helper endpoints behind `SANDSTORM_API`, `POWERBOX`, and
  `STORAGE`
- route-backed capability app-ref formats
- example app layouts and recommended project structure

This policy only applies to unreleased isolate-grain APIs. Existing
Linux/process grain behavior remains compatibility-sensitive.

During the pre-release period, Sandstorm should prefer clean API and protocol
changes over compatibility with earlier isolate prototypes.

## Current Authoring Guidance

For local experiments, start with:

```sh
spk dev-isolate --title "Isolate Hello" examples/isolate-hello/worker.js
```

For a fuller app shape, see `examples/isolate-app-skeleton/`. Its request
handler follows the current recommended order:

1. Create `const api = sandstorm(request, env)`.
2. Serve Sandstorm helper routes with `api.serveSystemRoutes()`.
3. Handle normal app routes.

Use ordinary `fetch()` routes for UI actions, app HTTP APIs, and large data
transfers. Use schema-first `capnp:` imports for public typed capability
protocols that other isolates, browser code, or legacy Cap'n Proto grains
should call.

The old private JavaScript object RPC helpers have been removed. Do not design
new isolate protocols around JavaScript class names, raw service binding names,
or hidden in-process object references.

## TypeScript Authoring

Sandstorm ships TypeScript declarations for the injected isolate helper
modules:

- `src/sandstorm/isolate/api.d.ts` for `sandstorm:api`
- `src/sandstorm/isolate/capnp.d.ts` for `sandstorm:capnp` native helpers

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
  --outfile=worker.js
spk dev-isolate --title "TypeScript isolate" worker.js
```

For a complete small example, see `examples/isolate-typescript/`.

Until Sandstorm publishes a package for isolate declarations, use a local
declaration shim in the app source tree:

```ts
/// <reference path="../../src/sandstorm/isolate/api.d.ts" />
/// <reference path="../../src/sandstorm/isolate/capnp.d.ts" />
```

Then import values and types from `sandstorm:api`:

```ts
import { sandstorm, validate } from "sandstorm:api";
import type { SandstormApi, SandstormEnv, SessionInfo } from "sandstorm:api";
```

Use `SandstormEnv` as the starting environment type, then extend it with
app-specific bindings:

```ts
interface Env extends SandstormEnv {
  STORAGE: SandstormEnv["STORAGE"];
}
```

For schema-specific native Cap'n Proto types, generate declarations from the
same `capnp:` schema imports that `spk dev-isolate` uses at runtime:

```sh
spk dev-isolate \
  --print-generated-declaration capnp:./greeter.capnp \
  worker.js > greeter.capnp.d.ts
```

Run this once for each schema module you want TypeScript to type-check. Keep
the emitted `.capnp.d.ts` files next to the corresponding `.capnp` files so
imports such as `capnp:./greeter.capnp` and generated relative schema imports
resolve consistently in editor and CI builds.

Do not point `spk dev-isolate` at `.ts` files. The command expects JavaScript
modules that `workerd` can load directly.

## Helper Surface

The preferred app-author entry point is:

```js
import { sandstorm, validate } from "sandstorm:api";
```

Create `const api = sandstorm(request, env)` once per request and prefer these
methods in application code:

- `api.session()` for Sandstorm session and user metadata
- `api.storage()` for isolate storage
- `api.powerbox()` for browser-mediated Powerbox claiming and offers
- `api.webSession()` and `api.apiSession()` for route-backed capabilities
- `api.restore(token)`, `api.revoke(token)`, and `api.use(token, fn)` for
  durable saved capability tokens
- `api.powerboxGrants()` for storage-backed Powerbox connection helpers
- `api.powerboxFulfillment()` for provider-side Powerbox fulfillment routes
- `api.serveSystemRoutes()` before normal app routes

The helper modules also expose lower-level functions for tests, framework
adapters, and internal plumbing. App code should prefer the `sandstorm()`
facade unless it has a specific integration reason to pass `request` and `env`
through manually.

Do not use versioned import paths such as `sandstorm:api/v1`. Sandstorm will
use the app's isolate compatibility date and compatibility flags to preserve
or intentionally change helper behavior once isolate grains become a supported
runtime.

## Native Cap'n Proto Modules

Use `capnp:` imports when the capability is a public schema-defined interface
that other isolate grains or legacy Cap'n Proto grains should call:

```js
import { sandstorm } from "sandstorm:api";
import { capnpClient, exportCapnp } from "sandstorm:capnp";
import { Greeter } from "capnp:./greeter.capnp";

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
      const exported = await exportCapnp(api, Greeter, greeterTarget);
      return Response.json({
        ok: true,
        token: await exported.save({ label: "Greeter" }),
      });
    }

    if (url.pathname === "/call-saved-greeter") {
      const token = url.searchParams.get("token");
      return api.use(token, async (capability) => {
        const client = capnpClient(Greeter, capability);
        const result = await client.hello({ name: "isolate" });
        return Response.json(result);
      });
    }

    return new Response("ok");
  },
};
```

Sandstorm `Capability` handles remain the authority source. `capnpClient()` is
a non-owning generated-schema view; save and drop the original capability, not
the generated client. `exportCapnp()` returns a dedicated handle whose
generated client is `.client`. Export handles cannot be serialized as JSON,
because JSON cannot transfer authority. Pass the handle through Powerbox,
pass `.client` through Cap'n Proto RPC, or save a durable string token with
`.save()` when the schema implements
`Grain.AppPersistent` and the app can restore the returned object ID through
`MainView.restore()`.

An isolate can connect to or restore only capabilities it already holds
through Powerbox, durable restore, or Cap'n Proto capability passing. It does
not get access to a raw Cap'n Proto vat network.

Connection negotiation, transport, token encoding, and RPC framing are runtime
details and are not exported by `sandstorm:capnp`.

To advertise a schema-defined capability from `spk dev-isolate`, pass the
schema and interface name:

```sh
spk dev-isolate \
  --app-interface capnp:./greeter.capnp#Greeter \
  worker.js
```

For packaged isolate apps, put the same descriptor in the normal
`bridgeConfig.viewInfo.matchRequests` field. `spk powerbox-descriptor` can
derive the descriptor from the schema:

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
spk capnp-abi --check greeter.capnp-abi.json capnp:./greeter.capnp
```

The check rejects removed interfaces, changed interface IDs, removed methods,
changed method ordinals, changed generated parameter/result struct IDs, and
changed or removed existing parameter/result fields. Adding new interfaces,
methods, or appended fields is allowed.

## Browser Schema Modules

Worker modules import public schemas with `capnp:`:

```js
import { Greeter } from "capnp:./greeter.capnp";
```

Browser modules should import the generated native module served by the
isolate helper routes, plus Sandstorm's native browser client helper:

```js
import { Greeter } from "/__sandstorm/capnp/greeter.capnp.js";
import { requestBrowserNativeCapnp } from "/__sandstorm/native-capnp/client.js";

const { client } = await requestBrowserNativeCapnp(Greeter, {
  saveLabel: { defaultText: "a greeter" },
});
const result = await client.hello({ name: "Ada" });
```

Serve those routes before normal app routes:

```js
const api = sandstorm(request, env);
const system = await api.serveSystemRoutes();
if (system) return system;
```

The native browser helper exposes descriptor, request, claim, connect, restore,
and one-shot request helpers. These helpers use Sandstorm's normal Powerbox
request/claim flow and then connect a generated `capnp-es` client over the
restricted native browser bridge.

If browser code is bundled, keep Sandstorm-served URLs external. A browser
bundler should not try to resolve `capnp:` or compile `.capnp` files itself
unless the app has its own matching plugin. For shared source that imports
`capnp:./greeter.capnp`, configure the browser build to rewrite that specifier
to `/__sandstorm/capnp/greeter.capnp.js`; keep `/capnp-es/...` runtime imports
and `/__sandstorm/native-capnp/client.js` external.

The served browser modules are generated from schemas discovered in the
isolate worker module graph. If a schema is used only by frontend code, import
it from the worker as well using `capnp:` or otherwise make it part of the
packaged isolate module graph so `spk dev-isolate` and `spk pack` know to
generate the native browser module.

## Browser-First Powerbox Requests

For now, isolate apps should open new Powerbox requests from the browser, then
claim the returned token in the worker. Treat this as a deliberate boundary:
the browser asks the user to choose authority, while the worker owns durable
app state and later use of that authority.

The recommended flow is:

1. The worker serves helper endpoints with `api.serveSystemRoutes()`.
2. Browser code imports request helpers from
   `/__sandstorm/native-capnp/client.js`.
3. The browser helper uses Sandstorm's existing `postMessage` Powerbox flow,
   so the shell can show the normal picker UI.
4. The browser sends the returned token to the worker in an app-defined
   request.
5. The worker claims the token, optionally saves it, stores the saved token in
   app storage, and uses the resulting `Capability`.
6. On later requests, the worker restores a saved token from storage before
   using it.
7. When the grant is no longer needed, the worker drops the live handle and
   revokes the saved token.

For the common browser-to-worker `ApiSession` flow:

```js
// Browser module.
import {
  apiSessionPowerboxDescriptor,
  requestPowerbox,
} from "/__sandstorm/native-capnp/client.js";

const requested = await requestPowerbox([
  await apiSessionPowerboxDescriptor({
    canonicalUrl: "https://api.example.test/v1",
    oauthScopes: ["read"],
  }),
], {
  saveLabel: { defaultText: "Chosen API" },
});

await fetch("/claim", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(requested),
});
```

The worker route that receives this request decides ownership. For a lasting
connection, claim the browser result, save the resulting capability, and store
that saved token in app-owned storage:

```js
// Worker route.
const api = sandstorm(request, env);
const requested = await request.json();
const cap = await api.powerbox().claim(requested);

try {
  const token = await cap.save({ label: "Chosen API" });
  await api.storage().put("chosen-api-token", token);
  const response = await cap.fetch("/status");
} finally {
  await cap.drop();
}
```

`cap.fetch()` supports WebSession, ApiSession, and OutboundHttpSession
capabilities. WebSession and ApiSession capabilities accept relative paths.
OutboundHttpSession capabilities also accept relative request paths under the
granted base URL.

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
import { inspectPowerboxQuery } from "/__sandstorm/native-capnp/client.js";

console.log(await inspectPowerboxQuery({
  canonicalUrl: "https://api.example.test/v1",
  oauthScopes: ["read"],
}));
```

Worker-side direct Powerbox UI requests are not the recommended author flow
yet. The current shell expects Powerbox UI requests to originate through the
browser `postMessage` path. Keeping the public author model browser-first also
makes the user gesture and UI boundary explicit.

## Capability and Token Ownership

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

Dropping a live handle with `cap.drop()` only releases that in-memory handle.
It does not revoke saved durable tokens. To revoke a saved token, call:

```js
await api.revoke(token);
await api.storage().delete("chosen-document-token");
```

## Service Bindings

Isolate manifests can define workerd-style service bindings. Today these are
same-workerd bindings: the service name resolves inside the generated workerd
config for the grain, such as a loopback binding to `main`.

Do not use raw service binding names as cross-grain authority. If an isolate
app needs to talk to another grain or an external provider, obtain a Sandstorm
capability through Powerbox, save the returned token if needed, and
restore/use that capability later. That keeps authority visible to
Sandstorm's existing object-capability model instead of creating an ambient
name service.

Development-only mocks can still use local service bindings, but production
cross-grain wiring should be represented as saved capabilities or explicit
future capability bindings, not as unresolved global service names.

## Compatibility Dates and Flags

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
be used as general app configuration. App configuration should live in
explicit bindings, storage, or app code.

While isolate grains are experimental, compatibility dates and flags are
recorded and forwarded to workerd, but they do not yet imply a stable public
compatibility guarantee for the Sandstorm-specific helper APIs. The
pre-release policy above still applies to `sandstorm:api`, `sandstorm:capnp`,
the generated package layout, and supervisor-local helper endpoints.
