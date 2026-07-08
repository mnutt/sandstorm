# Isolate Cap'n Proto RPC Example

Run:

```sh
spk dev-isolate --title "Isolate Capnp RPC" examples/isolate-capnp-rpc/worker.js
```

This example uses a native `capnp:` import:

```js
import { Greeter } from "capnp:./greeter.capnp";
```

`spk dev-isolate` generates native `capnp:` schema modules backed by the
bundled `capnp-es` runtime and Sandstorm's restricted native RPC bridge. The
worker uses those generated classes to:

- create a local test client with `new Greeter.Server(methods).client()`
- export a Sandstorm capability with `exportNativeCapnp(api, Greeter, methods)`
- pass returned capabilities through normal Cap'n Proto RPC cap tables

This is the native Cap'n Proto RPC path used for schema-defined isolate
protocols, isolate-to-isolate calls, browser generated clients, and legacy
grain interop. Authority still comes from Sandstorm capabilities: exported
objects are held, offered, saved, restored, or claimed through the normal
capability/Powerbox lifecycle.

TypeScript declarations for the native helpers live in
`src/sandstorm/isolate/capnp.d.ts`. Schema-specific declarations come from the
generated `capnp:` schema module:

```ts
import { exportNativeCapnp } from "sandstorm:capnp";
import { Greeter } from "capnp:./greeter.capnp";

interface GreeterMethods {
  hello(request?: { name?: string }): Promise<{ message: string }>;
}

const client = new Greeter.Server({
  async hello({ name = "world" } = {}) {
    return { message: `Hello, ${name}` };
  },
} satisfies GreeterMethods).client();
```
