# Isolate Counter Example

Run:

```sh
spk dev-isolate --title "Isolate Counter" examples/isolate-counter/worker.js
```

This is a small multi-file HTTP-shaped isolate app. It imports a local UI
module, JSON metadata, and text data, then persists a counter with
`sandstorm(request, env).storage()`.

It does not expose a public cross-grain protocol. If another grain should call
an app-defined typed API, define that API in a `.capnp` file and export it with
the Cap'n Proto helpers in `sandstorm:api` as shown in `examples/isolate-capnp-rpc`.
