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

`worker.ts` imports values and types from `sandstorm:api`. The build script
marks Sandstorm-provided modules as external, so imports such as
`sandstorm:api` remain in `worker.js` for the isolate runtime to resolve.
Typed public capabilities can also import `sandstorm:capnp` and generated
`capnp:` schema modules; keep those imports external in the same way.

The checked-in `worker.js` is the generated output for convenience. Rebuild it
after editing `worker.ts`.
