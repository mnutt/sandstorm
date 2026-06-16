# Isolate app skeleton

Run:

```sh
spk dev-isolate --title "Isolate App Skeleton" examples/isolate-app-skeleton/worker.js
```

This example is the current recommended structure for an isolate app that wants
normal page routes plus Sandstorm helpers:

1. Import `sandstorm`, `RpcTarget`, and `validate` from `sandstorm:api`.
2. Create `const api = sandstorm(request, env)` at the top of `fetch()`.
3. Serve conventional Sandstorm helper routes first with
   `api.serveSystemRoutes()`.
4. Serve Cap'n Web RPC routes with
   `api.serveRpc(...)`.
5. Handle normal app routes.

The example exposes a small RPC API at `/rpc`, serves the browser client at
`/rpc-client.js`, reads Sandstorm session metadata, and uses isolate storage.
