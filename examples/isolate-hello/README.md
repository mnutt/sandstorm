# Isolate hello example

Run:

```sh
spk dev-isolate --title "Isolate Hello" examples/isolate-hello/worker.js
```

This is the smallest useful isolate app shape: a Worker-style module
default-exporting its `fetch(request, env)` function. It is intentionally
HTTP-only; typed public cross-grain protocols should use a `capnp:` schema and
the helpers in `sandstorm:api` as shown in `examples/isolate-capnp-rpc`.
