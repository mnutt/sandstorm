# TypeScript isolate example

This example shows the current recommended TypeScript workflow for isolate
apps: typecheck and bundle with `esbuild`, then run the generated JavaScript
with `spk dev-isolate`.

```sh
cd examples/isolate-typescript
npm install
npm run typecheck
npm run build
cd ../..
spk dev-isolate --title "TypeScript Isolate" examples/isolate-typescript/worker.js
```

`worker.ts` imports values and types from `sandstorm:api`, implements the
generated `TypedCounter` with `ServerTargetFor<typeof TypedCounter>`, and
typechecks its default Fetch export as `SandstormFetchWorker`. Sandstorm
automatically adapts that simple export to the package's typed `MainView`.
The build script marks Sandstorm-provided modules as external, so imports such
as `sandstorm:api` remain in `worker.js` for the isolate runtime to resolve.
The checked-in `typed-counter.d.ts` is generated from `typed-counter.capnp` by
the pinned capnp-es compiler, so strict typechecking validates RPC parameters,
results, and the complete server implementation.

The checked-in `worker.js` is the generated output for convenience. Rebuild it
after editing `worker.ts`.
