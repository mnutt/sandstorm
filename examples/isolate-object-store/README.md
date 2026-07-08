# Isolate Object Store Example

Run:

```sh
spk dev-isolate --title "Isolate Object Store" examples/isolate-object-store/worker.js
```

This example uses native Cap'n Proto RPC for the object-store control plane and
a returned Sandstorm `WebSession` capability for object data:

```js
const object = await storage.openObject({ bucket, key });
const response = await object.object.get({
  path: "",
  context: {},
  ignoreBody: false,
});
```

The isolate imports `ObjectStore` with `capnp:` and imports Sandstorm's
`WebSession` schema with `capnp:/sandstorm/web-session.capnp`. In browser or
HTTP-shaped flows, the same object route can still be served over ordinary
`fetch()`.

The root route runs an in-process self-test. `GET /export-object-store` exports
the same object-store server as a Sandstorm native Cap'n Proto capability with
`exportNativeCapnp()`, so another isolate, browser generated client, or legacy
grain can call `listObjects()` and `openObject()` through the capability
system.
