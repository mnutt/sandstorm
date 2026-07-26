# Isolate Cap'n Proto Subscription Counter

Run:

```sh
spk dev-isolate \
  --title "Isolate Cap'n Proto Counter" \
  examples/isolate-websockets/worker.js
```

Open the same grain in two browser tabs. Press `+` or `−` in either tab and
both views update to the counter value stored by the worker.

Despite the historical directory name, this example does not define an
application WebSocket protocol. It demonstrates the preferred native browser
Cap'n Proto path:

- `Counter` is the UI session's typed application bootstrap;
- button presses call `Counter.change()` directly;
- each view passes a browser-hosted `CounterListener` callback capability to
  `Counter.subscribe()`;
- the worker calls `CounterListener.update()` after each durable change; and
- the browser helper shares one RPC connection per page, detects disconnects,
  reconnects, reacquires the application bootstrap, and subscribes again.

The `CounterSubscription` capability permits prompt explicit unsubscribe.
Disconnected callbacks are also removed when a notification fails. Only the
counter value is durable; subscription capabilities are deliberately
connection-scoped.

The WebSocket visible in browser developer tools frames Cap'n Proto RPC. It is
not an application WebSocket, and neither the schema nor worker methods contain
HTTP or WebSocket concepts.
