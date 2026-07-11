# Isolate Browser Cap'n Proto Example

Run:

```sh
spk dev-isolate --title "Browser Capnp Counter" examples/isolate-browser-capnp/worker.js
```

This example uses generated `capnp:` code in both the isolate worker and the
browser UI. The worker exports a `BrowserCounter` capability, hands the browser
an id-backed capability slot, and the browser calls that capability over the
browser native Cap'n Proto WebSocket bridge.

The worker defines and exports a `BrowserCounter` capability with:

```js
import { exportCapnp } from "sandstorm:api";
import { BrowserCounter } from "capnp:./browser-counter.capnp";
```

The browser imports:

```js
import { BrowserCounter } from "/__sandstorm/capnp/browser-counter.capnp.js";
import { connectBrowserNativeCapnp } from "/__sandstorm/native-capnp/client.js";
```

`POST /counter-capability` exports the server-side counter once per isolate
instance and calls `exported.browserHandoff(request)`. The browser passes that slot to
`connectBrowserNativeCapnp()` and then calls `read()`, `increment()`, and
`reset()` directly as Cap'n Proto RPC methods.
