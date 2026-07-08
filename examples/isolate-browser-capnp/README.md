# Isolate Browser Cap'n Proto Example

Run:

```sh
spk dev-isolate --title "Browser Capnp Counter" examples/isolate-browser-capnp/worker.js
```

This example is a work-in-progress test case for browser code speaking native
Cap'n Proto RPC directly to a Sandstorm capability.

The worker defines and exports a `BrowserCounter` capability with:

```js
import { exportNativeCapnp } from "sandstorm:capnp";
import { BrowserCounter } from "capnp:./browser-counter.capnp";
```

The page then imports the browser bridge and generated schema module:

```js
import { connectBrowserNativeCapnp } from "/__sandstorm/native-capnp/client.js";
import { BrowserCounter } from "/__sandstorm/capnp/browser-counter.capnp.js";
```

`POST /counter-capability` exports the server-side counter and returns a native
capability slot with the generated interface id and name. The browser passes
that slot to `connectBrowserNativeCapnp()` and calls `read()`, `increment()`,
and `reset()` over the native WebSocket-backed Cap'n Proto bridge.
