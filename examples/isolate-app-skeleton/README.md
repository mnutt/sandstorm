# Isolate app skeleton

Run:

```sh
spk dev-isolate --title "Isolate App Skeleton" examples/isolate-app-skeleton/worker.js
```

This example is the current recommended structure for an isolate app that wants
normal page routes plus Sandstorm helpers:

1. Import `sandstorm` from `sandstorm:api`.
2. Create `const api = sandstorm(request, env)` at the top of `fetch()`.
3. Serve conventional Sandstorm helper routes first with
   `api.serveSystemRoutes()`.
4. Handle normal app routes.

The example exposes small fetch endpoints for session metadata and storage,
then renders a browser UI that calls those endpoints with ordinary `fetch()`.
Public cross-grain protocols should use schema-first `capnp:` imports; this
example is intentionally just a minimal HTTP-shaped app skeleton. Browser
routes call the worker with ordinary `fetch()`, while Sandstorm helper routes
are served by `api.serveSystemRoutes()`.
