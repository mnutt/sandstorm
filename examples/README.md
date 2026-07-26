# Isolate Examples

These examples are organized around the current isolate capability model:

- ordinary app UI and same-grain browser calls use Worker `fetch()`
- HTTP-shaped Sandstorm capabilities use `WebSession` or `ApiSession`
- public typed cross-grain protocols use schema-defined native Cap'n Proto
  RPC with `capnp:` imports and helpers from `sandstorm:api`
- browser Powerbox code uses `/__sandstorm/native-capnp/client.js` for
  descriptor/request helpers
- browser RPC clients use `/__sandstorm/native-capnp/client.js` plus generated
  `/__sandstorm/capnp/*.capnp.js` schema modules when the browser has been
  handed a live Sandstorm capability
- manifest bindings are inert text, data, or JSON configuration values, not
  service authority

Use `examples/isolate-capnp-rpc` and `examples/isolate-object-store` when
starting a typed public capability. Use
`examples/isolate-app-skeleton`, `examples/isolate-counter`, and
`examples/isolate-streaming` for HTTP-shaped app routes. Use
`examples/isolate-websockets` for a durable counter whose open browser views
receive live updates through typed callback capabilities. Use
`examples/isolate-browser-capnp` for a smaller browser-native Cap'n Proto
request/response example.
Use `examples/isolate-capability-provider` and `examples/isolate-api-powerbox`
for WebSession/ApiSession lifecycle and Powerbox flows.
