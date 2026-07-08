# Isolate Browser Cap'n Proto Example

Run:

```sh
spk dev-isolate --title "Browser Capnp Counter" examples/isolate-browser-capnp/worker.js
```

This example is a work-in-progress test case for generated `capnp:` code in an
isolate with a browser UI. The browser drives the counter through ordinary HTTP
routes, and those routes call a server-side native Cap'n Proto client.

The worker defines and exports a `BrowserCounter` capability with:

```js
import { exportNativeCapnp } from "sandstorm:capnp";
import { BrowserCounter } from "capnp:./browser-counter.capnp";
```

`POST /counter-capability` exports the server-side counter and returns metadata
for the local export. Direct browser-to-local-export RPC is intentionally not
used here while native exports are being normalized around AppPersistent
app-ref persistence and the single capnp RPC channel.
