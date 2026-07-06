# Isolate Cap'n Proto RPC Example

Run:

```sh
spk dev-isolate --title "Isolate Capnp RPC" examples/isolate-capnp-rpc/worker.js
```

This example uses a native `capnp-es:` import:

```js
import { Greeter } from "capnp-es:./greeter.capnp";
```

`spk dev-isolate` generates `@mnutt/capnp-es` classes from the schema. The
worker uses those classes to:

- create a local test client with `new Greeter.Server(methods).client()`
- export a Sandstorm capability with `exportNativeCapnp(api, Greeter, methods)`
- pass returned capabilities through normal Cap'n Proto RPC cap tables

This is the native Cap'n Proto RPC path used for schema-defined isolate
protocols and legacy grain interop.

TypeScript declarations for the native helpers live in
`src/sandstorm/isolate/capnp.d.ts`. Schema-specific declarations come from the
generated `capnp-es` module:

```ts
import { exportNativeCapnp } from "sandstorm:capnp";
import { Greeter } from "capnp-es:./greeter.capnp";

interface GreeterMethods {
  hello(request?: { name?: string }): Promise<{ message: string }>;
}

const client = new Greeter.Server({
  async hello({ name = "world" } = {}) {
    return { message: `Hello, ${name}` };
  },
} satisfies GreeterMethods).client();
```
