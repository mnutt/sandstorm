# Isolate hello example

Run:

```sh
spk dev-isolate --title "Isolate Hello" examples/isolate-hello/worker.js
```

This is the smallest useful isolate app shape: a Worker-style module exporting
`fetch(request, env)`. It is intentionally HTTP-only; typed public
cross-grain protocols should use a `capnp:` schema and the helpers in `sandstorm:api`
helpers as shown in `examples/isolate-capnp-rpc`.
