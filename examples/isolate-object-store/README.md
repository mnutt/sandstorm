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

The isolate imports `ObjectStore` with `capnp-es:` and imports Sandstorm's
`WebSession` schema with `capnp-es:/sandstorm/web-session.capnp`. In browser or
HTTP-shaped flows, the same object route can still be served over ordinary
`fetch()`.
