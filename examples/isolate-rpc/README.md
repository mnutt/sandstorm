# Isolate RPC example

Run:

```sh
spk dev-isolate --title "Isolate RPC" examples/isolate-rpc/worker.js
```

Open the grain, then use the buttons to call the grain through the injected
`capnweb` package and `sandstorm(request, env).serveRpc()`.
The browser imports `newSandstormRpcSession()` from `/rpc-client.js`, which
defaults to the `/rpc` endpoint served by `serveRpc()`.
The worker passes a target factory to `serveRpc()`, so the API object is only
created for RPC requests. `serveRpc()` also serves Sandstorm's internal
app-defined object-capability routes, so apps that export `RpcTarget` objects
through `sandstorm(request, env).capability()` can use the same helper as their
front door.

The "Sandstorm target" button calls an app-defined RPC method that returns the
Sandstorm helper's own `RpcTarget`, then calls session/runtime methods and a
nested storage target through Cap'n Web stubs.
The "Powerbox request + claim" button demonstrates the browser-mediated
Powerbox bridge shape. The browser imports `requestAndClaimPowerbox()` from
`/rpc-client.js`, asks the Sandstorm shell to show the existing Powerbox prompt,
then posts the returned temporary token to the conventional
`/__sandstorm/powerbox/claim` route served by `serveRpc()`. That route claims
the token against the current live session context in the isolate supervisor and
returns an opaque claimed-capability handle. The example then sends that handle
through app RPC so the worker can save it, write the returned durable token into
`sandstorm(request, env).storage()`, read it back, restore it into a second live
handle, and finally drop both live handles and the saved token. Sandstorm stores
the token's server-side authority in its API-token store; the isolate app is
responsible for storing the returned token string if it wants to restore the
capability later, and for dropping that saved token when it is no longer needed.
Full typed Cap'n Web stubs for arbitrary Sandstorm capabilities are still
ongoing work.

HTTP batch sessions are single-use: queue all calls for a batch before awaiting
them, or create a new `newSandstormRpcSession()` for later calls.

TypeScript declarations for the injected isolate modules live in
`src/sandstorm/isolate/*.d.ts`. This example includes
`sandstorm-isolate.d.ts`, which references those declarations for editors and
TypeScript projects.

The RPC methods use `validate` from `sandstorm:api` for small runtime checks.
TypeScript types help authors, but RPC inputs can still come from untrusted
callers and must be checked at runtime. The "bad input" button deliberately
calls a target method with an invalid storage key so you can see how validation
errors propagate through Cap'n Web.
