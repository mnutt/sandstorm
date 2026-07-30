# Isolate Object Store Example

Run:

```sh
spk dev-isolate \
  --title "Isolate Object Store" \
  examples/isolate-object-store/worker.js
```

This example uses native Cap'n Proto RPC for both the object-store control
plane and returned object data:

```js
const object = await storage.openObject({ bucket, key });
const response = await object.object.read({});
```

The isolate imports `ObjectStore` and `StoredObject` with `capnp:`. No
`WebSession`, HTTP route, or Fetch ingress is involved in object capability
calls.

The root route runs an in-process self-test. `GET /export-object-store` exports
the same object-store server as a Sandstorm native Cap'n Proto capability with
`exportCapnp()` and returns a durable string token. Once
another isolate, browser generated client, or traditional grain receives that
capability through Sandstorm's capability system, it can call `listObjects()`
and `openObject()` with the same generated schema bindings.
