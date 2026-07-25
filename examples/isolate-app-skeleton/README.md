# Isolate app skeleton

Run:

```sh
spk dev-isolate --title "Isolate App Skeleton" examples/isolate-app-skeleton/worker.js
```

This example is the current recommended structure for an isolate app that wants
normal page routes plus Sandstorm helpers:

1. Import `sandstorm` from `sandstorm:api`.
2. Export a typed `MainView` capability with `mainViewFromFetch()`.
3. Create `const api = sandstorm(request, env)` inside the fetch facade.
4. Handle normal app routes.

The example exposes small fetch endpoints for session metadata and storage,
then renders a browser UI that calls those endpoints with ordinary `fetch()`.
Public cross-grain protocols should use schema-first `capnp:` imports; this
example is intentionally just a minimal browser-facing app skeleton. Browser
routes reach the `MainView` capability through the fetch facade, while
Sandstorm helpers call the typed supervisor bridge directly.
