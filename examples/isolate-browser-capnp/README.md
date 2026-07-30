# Isolate Browser Cap'n Proto Example

Run:

```sh
spk dev-isolate --title "Browser Capnp Counter" examples/isolate-browser-capnp/worker.js
```

This example uses generated `capnp:` code in both the isolate worker and the
browser UI. The worker declares `BrowserCounter` as its UI session's typed
application bootstrap, and the browser calls it over the shared native Cap'n
Proto connection.

The worker defines and exports a `BrowserCounter` capability with:

```js
import { serveCapnp } from "sandstorm:api";
import { BrowserCounter } from "capnp:./browser-counter.capnp";
```

The browser imports:

```js
import { BrowserCounter } from "/__sandstorm/capnp/browser-counter.capnp.js";
import {
  connectBrowserNativeCapnpApplication,
} from "/__sandstorm/native-capnp/client.js";
```

The default worker export supplies `browser: serveCapnp(BrowserCounter, target)`.
`connectBrowserNativeCapnpApplication()` verifies the requested interface ID
against that declaration and returns its generated client. Calls to `read()`,
`increment()`, and `reset()` contain no HTTP handoff route or JSON capability
identifier.
