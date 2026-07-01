# Isolate Cap'n Proto RPC Example

Run:

```sh
spk dev-isolate --title "Isolate Capnp RPC" examples/isolate-capnp-rpc/worker.js
```

This example uses a `capnp:` import:

```js
import { Greeter } from "capnp:./greeter.capnp";
```

In the current implementation, `spk dev-isolate` generates JavaScript bindings
for simple schema-first app-object RPC. The generated binding can:

- create a local test client with `Greeter.local(methods)`
- create an exportable app-object target with `Greeter.implement(methods)`
- cast an existing app-object capability with `Greeter.cast(capability)`

This is an authoring bridge over today's app-object RPC transport. It is not
native Cap'n Proto RPC transport yet.

TypeScript can import the default schema object with the shared declaration in
`src/sandstorm/isolate/capnp.d.ts`:

```ts
import schema, { type CapnpInterfaceBinding } from "capnp:./greeter.capnp";

interface GreeterMethods {
  hello(request?: { name?: string }): Promise<{ message: string }>;
}

const Greeter = schema.Greeter as CapnpInterfaceBinding<GreeterMethods>;
```

Schema-specific named export declarations are not generated yet, so TypeScript
apps that want `import { Greeter } from "capnp:./greeter.capnp"` should add a
small app-local declaration until `spk dev-isolate` can emit `.d.ts` files.
