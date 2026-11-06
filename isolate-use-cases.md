# Isolate Grain Use Cases

This document describes the end-to-end scenarios the isolate-grain work is
trying to enable. The core goal is that an isolate grain should behave like a
normal Sandstorm grain from the outside, while feeling like a Cloudflare
Workers-style JavaScript app from the inside.

## Basic Isolate Grain UI

An app author writes a Worker-style module:

```js
export default {
  async fetch(request, env) {
    return new Response("hello");
  },
};
```

The package manifest declares an isolate command with a main module,
compatibility date, modules, and bindings.

When the grain starts:

1. Sandstorm backend sees the selected command is an isolate command.
2. Backend starts `isolate-supervisor` instead of the traditional Linux-process
   supervisor.
3. `isolate-supervisor` reads the package manifest and selected isolate config.
4. It materializes a per-grain workerd runtime bundle under the grain var
   directory.
5. It starts the bundled `workerd` sidecar under confinement.
6. The Sandstorm shell opens the grain through the normal `UiView` /
   `WebSession` Cap'n Proto path.
7. `isolate-supervisor` receives the `WebSession.get()` call.
8. It converts the Sandstorm request into a Fetch-shaped request, including
   method, path, request body, and Sandstorm session headers.
9. It forwards that request to workerd over the grain-local Unix socket.
10. The JavaScript worker receives a normal `fetch(request, env)` call.
11. The worker returns a Fetch `Response`.
12. `isolate-supervisor` converts that response back into
    `WebSession.Response`.
13. The browser displays the result.

This is the baseline: Sandstorm speaks its normal capability protocol, while
the app author writes Worker-style JavaScript.

The first release should keep this per-grain process model. It is less dense
than a shared isolate-host pool, but it preserves Sandstorm's existing grain
lifecycle and isolation boundaries while the JavaScript API surface is still
pre-release. A future host pool can optimize density after the single-grain
contract is stable enough to preserve across a different process topology.

## Durable Storage

An isolate app can use a service binding for grain-local durable storage:

```js
export default {
  async fetch(request, env) {
    const old = await env.STORAGE.fetch("http://storage/counter");
    const count = old.ok ? Number(await old.text()) : 0;

    await env.STORAGE.fetch("http://storage/counter", {
      method: "PUT",
      body: String(count + 1),
    });

    return Response.json({ count: count + 1 });
  },
};
```

The flow is:

1. The manifest declares a storage binding, for example `STORAGE`.
2. `isolate-supervisor` creates an internal Unix-socket HTTP service for that
   binding.
3. workerd exposes the binding to JavaScript as `env.STORAGE`.
4. The worker calls `env.STORAGE.fetch(...)`.
5. workerd sends the request to the supervisor's storage binding socket.
6. The supervisor maps storage keys to files under the grain's private storage
   directory.
7. The supervisor enforces key validation, size limits, and symlink/path
   traversal protections.
8. The supervisor returns an HTTP response to workerd.
9. JavaScript sees a normal Fetch `Response`.

The app gets Worker-native storage ergonomics while Sandstorm keeps ownership of
the security boundary and persistence model.

## Claim, Use, Save, And Restore A Powerbox Capability

An isolate app should be able to participate in Sandstorm's object-capability
workflows.

For example, a user clicks "Choose document" in the app UI. The browser or
worker asks Sandstorm to start a Powerbox request. Sandstorm shows the normal
Powerbox UI, the user selects a target, and the supervisor receives a Cap'n
Proto capability.

The intended JavaScript shape is:

```js
const cap = await sandstorm(request, env).powerbox.request({
  title: "Choose a document",
  requiredPermissions: ["view"],
});

const response = await cap.fetch("/some-path");
const saved = await cap.save({ label: "Chosen document" });
```

The end-to-end flow is:

1. The app starts a Powerbox request from JS.
2. The request crosses the app's RPC/API bridge to `isolate-supervisor`.
3. The supervisor invokes Sandstorm's real Powerbox/session machinery.
4. The Sandstorm shell shows the user the normal Powerbox picker.
5. The user selects an object.
6. The supervisor receives the selected Cap'n Proto capability.
7. The supervisor stores it in a claimed-capability table.
8. JavaScript receives a typed `ClaimedCapability` handle with methods like
   `fetch()`, `save()`, `offer()`, `fulfillRequest()`, `tieToUser()`, and
   `drop()`.
9. If the capability implements `WebSession`, JS can call it using
   `cap.fetch(...)`.
10. The helper sends the call to `/powerbox/fetch` on the `SANDSTORM_API`
    binding.
11. The supervisor resolves the claimed capability ID, casts it to
    `WebSession`, forwards the request, and maps the response back to a Fetch
    `Response`.
12. The app can save the capability with `cap.save(...)`.
13. The supervisor calls Sandstorm's real save flow and returns a persistent
    token.
14. The app can store that token in isolate storage.
15. Later, after restart, the app can restore the token and receive a new live
    `ClaimedCapability`.

This is the path from "isolate grains can serve HTTP" to "isolate grains can be
real Sandstorm apps."

## Export An App-Defined Capability

An isolate app should also be able to mint its own capabilities. For example,
an app may want to share one document view, expose an import endpoint, or
fulfill another app's Powerbox request with an app-defined resource.

The worker can define a route:

```js
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/shared/doc") {
      return new Response("shared document");
    }

    if (url.pathname === "/make-cap") {
      const cap = await sandstorm(request, env).webSession({
        pathPrefix: "/shared",
      });

      return Response.json(cap);
    }
  },
};
```

The flow is:

1. The user or app triggers `/make-cap`.
2. The worker calls `sandstorm(request, env).webSession({ pathPrefix:
   "/shared" })`.
3. The `sandstorm:api` helper calls the supervisor endpoint
   `/capabilities/web-session`.
4. The supervisor creates a new route-backed `WebSession` capability.
5. That capability is backed by the same isolate worker, but all requests
   through it are prefixed with `/shared`.
6. The supervisor stores the capability in the claimed-capability table.
7. JavaScript receives a `ClaimedCapability`.
8. The app can offer, save, fulfill a request with, tie to user, or drop that
   capability.
9. When an external holder invokes the capability, the supervisor receives a
   normal Cap'n Proto `WebSession` request.
10. The supervisor prefixes the path and forwards it to workerd.
11. The worker handles the prefixed route.
12. The response flows back to the external holder.

This lets isolate apps create Sandstorm-native object capabilities backed by
Worker routes.

Route-backed WebSession capabilities are primarily an external capability
surface. Same-worker code should share local functions or route handlers
directly instead of depending on recursive same-request self-fetch through the
exported capability. This keeps the app-defined capability contract focused on
other holders and avoids committing to reentrant workerd/supervisor behavior
before a concrete app needs it.

## Cap'n Web Direction

The first capability bridge is HTTP-shaped because `WebSession` maps naturally
to Fetch:

```js
await cap.fetch("/path");
```

But Sandstorm's capability model is richer than HTTP. Cap'n Web gives us a
JavaScript-native object-capability model that can eventually represent richer
interfaces:

```js
class MyApi extends RpcTarget {
  async getStatus() {
    return { ok: true };
  }

  async makeChildObject() {
    return new ChildApi();
  }
}
```

Long term, isolate apps should be able to:

1. Export JavaScript objects as Sandstorm capabilities.
2. Receive Sandstorm capabilities as JavaScript stubs.
3. Pass stubs back and forth.
4. Save and restore them.
5. Use promise pipelining where possible.
6. Let browser UI talk to the worker using the same object-capability style.

The architecture is moving from:

```text
Sandstorm Cap'n Proto capability
        |
    supervisor bridge
        |
       Fetch
        |
    JavaScript worker
```

toward:

```text
Sandstorm Cap'n Proto capability
        |
    supervisor / Cap'n Web bridge
        |
  JS object-capability stubs
        |
    JavaScript worker + browser UI
```

For the first release, the bridge should stay explicit rather than pretending
that every arbitrary Cap'n Proto interface can be reflected into JavaScript.
The supported surfaces are:

1. HTTP-shaped `WebSession` / `ApiSession` capabilities exposed as
   `ClaimedCapability.fetch()`.
2. App-defined JavaScript object capabilities exported with `RpcTarget` and
   consumed through `ClaimedCapability.call()` / `asRpc()`.
3. Saved/restored capability handles that preserve authority but do not yet
   promise interface-specific JavaScript methods beyond those explicit
   surfaces.

A fuller arbitrary Cap'n Proto bridge should be a later layer, not an implicit
behavior hidden inside `ClaimedCapability`. To make it robust, the supervisor
will need schema/type metadata for the requested interface, a clear mapping
from Cap'n Proto methods and structs to JavaScript calls and values, explicit
handling for capability-valued fields and arguments, and a pipelining model
that does not accidentally turn every remote property access into a blocking
round trip. Until those pieces exist, unknown capabilities should remain opaque
claimed/saved handles that apps can fetch, save, restore, pass through
Powerbox, or adapt through explicit app-level routes.

Promise pipelining should follow the same rule. Cap'n Web already supports
`RpcPromise` pipelining inside an actual Cap'n Web session, and isolate apps
can use that for browser-to-worker RPC. Sandstorm capability handles, however,
currently cross the supervisor through explicit operations like
`ClaimedCapability.fetch()` and `ClaimedCapability.call()`. Those operations
return normal JavaScript promises and should not claim cross-capability
pipelining semantics yet. Future pipelining should be introduced only with a
typed bridge that can keep an ordered call graph, preserve capability
lifetimes, bound pipeline depth and payload size, and map failures back to the
right pending JavaScript promises.

Typed restoration is also app-owned in the first release. A saved token
restores authority as a `ClaimedCapability`; it does not by itself identify a
safe JavaScript interface. The code that saved the token should know whether to
use `fetch()`, `asRpc<T>()`, or an app-specific adapter. A future typed restore
API can layer on top of this by storing explicit descriptor metadata next to
the token or by receiving trusted type metadata from the capability bridge.

## Practical Destination

A mature isolate app should be able to look roughly like this:

```js
import { sandstorm, RpcTarget } from "sandstorm:api";

class AppApi extends RpcTarget {
  async getSessionInfo(request) {
    return sandstorm(request).session;
  }

  async chooseFile(request) {
    const cap = await sandstorm(request).powerbox.request({
      title: "Choose a file",
      requiredPermissions: ["view"],
    });

    const saved = await cap.save({ label: "Chosen file" });
    return saved.token;
  }

  async shareCurrentView(request) {
    const cap = await sandstorm(request).webSession({
      pathPrefix: "/shared/current",
    });

    await cap.offer(request, { title: "Current view" });
    return { ok: true };
  }
}

export default {
  fetch(request, env) {
    return sandstorm.serve(request, env, new AppApi());
  },
};
```

From the user's perspective, this is just a Sandstorm app.

From the app author's perspective, it is a Worker with Sandstorm-native powers.

From the system's perspective, the supervisor remains the trusted mediator for:

- runtime confinement
- storage
- session identity
- Powerbox
- capability lifecycle
- persistence
- request/response correctness
- security boundaries
