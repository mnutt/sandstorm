# Isolate Object Store Example

Run:

```sh
spk dev-isolate \
  --title "Isolate Object Store" \
  --app-interface capnp:./object-store.capnp#ObjectStore \
  examples/isolate-object-store/worker.js
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
`exportCapnp()` and returns a durable string token. Once
another isolate, browser generated client, or legacy grain receives that
capability through Sandstorm's capability system, it can call `listObjects()`
and `openObject()` with the same generated schema bindings.
