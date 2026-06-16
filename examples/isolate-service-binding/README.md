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

This example uses `LOOPBACK=main` as a local development stand-in. The long-term
shape is the same for named services that resolve to other isolate grains,
process-backed grains, system services, or mocks.
