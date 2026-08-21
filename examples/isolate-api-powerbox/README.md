# Isolate API Powerbox example

Run:

```sh
spk dev-isolate --title "Isolate API Powerbox" examples/isolate-api-powerbox/worker.js
```

Open the grain and choose "Connect API". The browser calls Sandstorm's
native browser Cap'n Proto client, which builds a packed `ApiSession`
descriptor, runs Sandstorm's existing Powerbox `postMessage` flow, and sends
the returned request token back to the worker. The worker then saves the browser
result by calling `api.powerbox().claim(...)`, `cap.save(...)`, and
`api.kv().put(...)`. The URL and scopes are editable; the worker serves the
native client and claim route with `sandstorm(request, env).serveSystemRoutes()`,
so the descriptor and claim plumbing do not have to be hand-coded in browser
code.

The equivalent server-side claim step is:

```js
const cap = await sandstorm(request, env).powerbox().claim(token);
```

If the shell returns an `ApiSession`, the app saves the capability token in
isolate storage, calls the granted API with `cap.fetch()`, and can later use
`api.use(...)` to restore, fetch, and drop the live handle.
This is the intended replacement for ambient public network
fetches: the isolate app only gets outbound API access after the user grants an
`ApiSession` through Powerbox.

This is an HTTP-shaped capability example. For typed app protocols, import a
`.capnp` schema with `capnp:`, request or fulfill the generated descriptor, and
call the resulting generated native client over Sandstorm's capability bridge.

This example intentionally requests a placeholder API URL. On a development
server without a matching provider or shell support for this request path, the
page will show the returned platform error instead of a successful grant.
Apps with manifest-declared permissions can also pass `requiredPermissions`,
but those names must match the app's `ViewInfo.permissions` entries.
