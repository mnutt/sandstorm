# Isolate capability provider example

Run:

```sh
spk dev-isolate --title "Isolate Capability Provider" examples/isolate-capability-provider/worker.js
```

Open the grain and press either button.

This example demonstrates the provider side of Sandstorm capabilities from an
isolate Worker. The app creates route-backed capabilities that re-enter the
same Worker under a path prefix:

```js
const web = await sandstorm(request, env).webSession({
  pathPrefix: "/shared",
});

const api = await sandstorm(request, env).apiSession({
  pathPrefix: "/api/v1",
});
```

The returned values are `Capability` objects. They can be called with
`cap.fetch()`, saved with `cap.save()`, restored from the resulting token with
`api.restore(token)`, revoked with `api.revoke(token)`, and explicitly dropped.

The WebSession button exercises:

- `webSession({ pathPrefix: "/shared" })`
- local `cap.fetch("/info?source=direct")`
- whitelisted `x-sandstorm-app-*` request header forwarding
- `save()`, `drop()`, `api.restore()`, `api.revoke()`, and a restored fetch

The ApiSession button exercises the same lifecycle for:

- `apiSession({ pathPrefix: "/api/v1" })`
- local `cap.fetch("/status?source=direct")`
- route-backed ApiSession save and restore

These route-backed capabilities are Sandstorm capabilities. Other holders see a
normal `WebSession` or `ApiSession`; the isolate supervisor translates calls
back into Worker `fetch()` requests. For a typed public app protocol, define a
`.capnp` interface and export it with `exportNativeCapnp()` instead of routing
method calls through HTTP paths.
