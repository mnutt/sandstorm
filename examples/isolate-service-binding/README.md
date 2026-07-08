# Isolate service binding example

Run:

```sh
spk dev-isolate --title "Isolate Service Binding" \
  --text-binding MESSAGE="hello from a text binding" \
  --json-binding SETTINGS='{"mode":"dev"}' \
  --data-binding PAYLOAD=examples/isolate-service-binding/payload.bin \
  --service-binding LOOPBACK=main \
  examples/isolate-service-binding/worker.js
```

Open the grain. The root route calls `env.LOOPBACK.fetch()` to reach the same
worker's `/target` route through workerd's native service-binding mechanism.
It also displays `env.MESSAGE` and `env.SETTINGS`, which come from the generated
text and JSON bindings, plus the byte count and checksum of the binary
`env.PAYLOAD` data binding.

This example uses `LOOPBACK=main` as a local development stand-in for
same-workerd services and mocks. Do not use service binding names as
cross-grain authority; production cross-grain access should go through
Sandstorm capabilities such as Powerbox grants or saved capability tokens. For
typed cross-grain calls, restore or claim a `capnp:` capability and use the
generated native client rather than calling a raw binding name.
