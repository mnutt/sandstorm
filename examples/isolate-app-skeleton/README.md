# Isolate app skeleton

Run:

```sh
spk dev-isolate --title "Isolate App Skeleton" examples/isolate-app-skeleton/worker.js
```

This example is the current recommended structure for an isolate app that wants
normal page routes plus Sandstorm helpers:

1. Import `sandstorm` from `sandstorm:api`.
2. Default-export the `fetch()` function.
3. Create `const api = sandstorm(request, env)` inside the fetch facade.
4. Handle normal app routes.

The example exposes small fetch endpoints for session metadata and storage,
then renders a browser UI that calls those endpoints with ordinary `fetch()`.
Public cross-grain protocols should use schema-first `capnp:` imports; this
example is intentionally just a minimal browser-facing app skeleton. Browser
routes are adapted to a typed `MainView` capability automatically, while
Sandstorm helpers call the typed supervisor bridge directly. Use
`defineWorker()` when the worker needs explicit Cap'n Proto exports, Powerbox
matching, permissions, or durable capability restoration.
