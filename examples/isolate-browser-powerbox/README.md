# Isolate browser Powerbox lifecycle

Run:

```sh
spk dev-isolate --title "Browser Powerbox Lifecycle" examples/isolate-browser-powerbox/worker.js
```

This example shows the recommended browser-first Powerbox lifecycle for
isolate grains:

1. Browser code builds and opens the Powerbox request.
2. The browser sends the returned request token to the worker.
3. The worker calls `api.powerbox().claim(...)`, then saves the resulting
   capability and stores the saved token in isolate storage.
4. Later requests call `api.use(...)`, which restores the saved token, uses the
   restored live capability, and drops the live handle.
5. The app can call `api.revoke(...)` and delete the stored copy.

The example requests an `ApiSession` for `https://api.example.test/v1`. On a
test/dev Sandstorm shell, the built-in API provider card may satisfy this
request. On a shell without a matching provider, the Powerbox picker will show
no matching card and, in dev/test mode, display diagnostics.

The important pattern is that the browser owns the user gesture and picker UI,
while the worker owns durable token storage and later capability use.
