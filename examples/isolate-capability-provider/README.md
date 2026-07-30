# Isolate capability provider example

Run:

```sh
spk dev-isolate --title "Isolate Capability Provider" examples/isolate-capability-provider/worker.js
```

Open the grain and press either button.

This example demonstrates the provider side of Sandstorm capabilities from an
isolate Worker. The app declares named Cap'n Proto session exports and chooses
Fetch only as their application-facing facade:

```js
const shared = webSessionFromFetch({
  fetch: capabilityProviderFetch,
  pathPrefix: "/shared",
});

const service = apiSessionFromFetch({
  fetch: capabilityProviderFetch,
  pathPrefix: "/api/v1",
});

export default defineWorker({
  capabilities: { shared, service, /* typed MainView omitted */ },
});
```

`sandstorm(request, env).capability(shared)` resolves the named export to a
`Capability`. It can be called with
`cap.fetch()`, saved with `cap.save()`, restored from the resulting token with
`api.restore(token)`, revoked with `api.revoke(token)`, and explicitly dropped.

The WebSession button exercises:

- a named `webSessionFromFetch({ pathPrefix: "/shared" })` export
- local `cap.fetch("/info?source=direct")`
- whitelisted `x-sandstorm-app-*` request header forwarding
- `save()`, `drop()`, `api.restore()`, `api.revoke()`, and a restored fetch

The ApiSession button exercises the same lifecycle for:

- a named `apiSessionFromFetch({ pathPrefix: "/api/v1" })` export
- local `cap.fetch("/status?source=direct")`
- named-export ApiSession save and restore

Other holders see a normal `WebSession` or `ApiSession`. The native capability
travels end-to-end through the supervisor; the explicit helper at the worker
edge performs the only Fetch translation. For a typed public app protocol,
define a `.capnp` interface and export it with `serveCapnp()` or
`exportCapnp()` without any Fetch translation.
