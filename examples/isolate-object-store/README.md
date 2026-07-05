# Isolate Object Store Example

Run:

```sh
spk dev-isolate --title "Isolate Object Store" examples/isolate-object-store/worker.js
```

This example uses Cap'n Proto-style RPC for the object-store control plane and
fetch-shaped `WebSession` capabilities for object data:

```js
const object = await storage.rpc.openObject({ bucket, key });
const response = await object.fetch("", { method: "GET" });
```

The generated `capnp:` binding recognizes the imported Sandstorm `WebSession`
result and casts it as an opaque fetch-capable Sandstorm capability instead of
an app-object RPC client.
