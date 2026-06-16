# Isolate object capability example

Run:

```sh
spk dev-isolate --title "Isolate Object Capability" examples/isolate-object-capability/worker.js
```

Open the grain, then use the buttons to create and call a JavaScript object
capability.

At the top of `fetch()`, the worker calls
`sandstorm(request, env).serveRpc(...)`. This serves Sandstorm's internal
object-capability callback routes before the worker's normal page/API routes,
so exported `RpcTarget` objects can be called later without adding a separate
`serveObjectCapabilities()` route check.

The worker defines a `CounterCapability extends RpcTarget`, exports it with:

```js
const cap = await sandstorm(request, env).capability(new CounterCapability(), {
  id: "demo-counter",
});
```

The returned `ClaimedCapability` is backed by a route inside the same isolate
worker. Calls like:

```js
const counter = cap.asRpc();
await counter.increment(5);
```

travel through the supervisor's claimed-capability bridge, re-enter the worker,
invoke the target method, and return JSON-compatible results. The lower-level
`cap.call("increment", 5)` form is still available when a dynamic method name is
more convenient.

Anonymous and default object capabilities are transient. Attempting to
`save()` one fails clearly because the target only exists in the current worker
process. To opt into persistence, provide a stable ID and `persistent: true`:

```js
const cap = await sandstorm(request, env).capability(new CounterCapability(), {
  id: "demo-counter",
  persistent: true,
});
const saved = await cap.save({ label: "Persistent JS counter" });
const restored = await saved.restore();
```

The restored handle routes back to the same stable object-capability path. The
app should register that stable ID during request setup or startup before
restored capabilities are expected to work:

```js
const counter = new CounterCapability();

export default {
  async fetch(request, env) {
    const api = sandstorm(request, env);
    api.registerCapability(counter, { id: "demo-counter" });

    const internal = api.serveRpc(() => new AppApi());
    if (internal) return internal;

    // Normal app routes...
  },
};
```

Registering the same target and ID repeatedly is idempotent. Registering a
different target with the same ID fails, which prevents accidental replacement
of saved capability routes.

For the common case where the app wants to register a stable target, save a
claimed handle once, store the saved token in isolate storage, and restore it on
later requests, use `persistentCapability()`:

```js
const counter = new CounterCapability();

export default {
  async fetch(request, env) {
    const durable = await sandstorm(request, env).persistentCapability(counter, {
      id: "demo-counter",
      storageKey: "demo-counter-capability",
      label: "Persistent JS counter",
    });

    const counterStub = durable.capability.asRpc();
    return Response.json(await counterStub.get());
  },
};
```

The first call mints and saves the claimed handle. Later calls restore from the
stored token after registering the same target ID.

This example intentionally covers the first narrow object-capability slice:

- method name plus JSON-compatible arguments
- JSON-compatible return values
- state retained by the exported target
- returned `RpcTarget` objects becoming new claimed capabilities
- capability handles passed back as method arguments
- `ClaimedCapability.asRpc()` Proxy stubs for method-call ergonomics
- explicit stable object route IDs
- opt-in persistent object capabilities with stable IDs
- explicit stable-ID registration for restored object capabilities
- storage-backed `persistentCapability()` helper for common durable handles
- structured missing-method errors
- explicit `drop()` cleanup
- clear rejection when attempting to `save()` a transient JS object capability

This is not the full Cap'n Web object model yet. Passing stubs as arguments or
promise pipelining and stream arguments are future work. Persistent object
capabilities are intentionally explicit because stable IDs become part of the
app's compatibility contract.
