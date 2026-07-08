# Isolate Examples

These examples are organized around the current isolate capability model:

- ordinary app UI and same-grain browser calls use Worker `fetch()`
- HTTP-shaped Sandstorm capabilities use `WebSession` or `ApiSession`
- public typed cross-grain protocols use schema-defined native Cap'n Proto
  RPC with `capnp:` imports and helpers from `sandstorm:capnp`
- browser Powerbox code uses `/__sandstorm/native-capnp/client.js` for
  descriptor/request helpers
- browser RPC clients use `/__sandstorm/native-capnp/client.js` plus generated
  `/__sandstorm/capnp/*.capnp.js` schema modules
- service bindings are for local development wiring and mocks, not cross-grain
  authority

Use `examples/isolate-capnp-rpc`, `examples/isolate-file-store-rpc`, and
`examples/isolate-object-store` when starting a typed public capability. Use
`examples/isolate-app-skeleton`, `examples/isolate-counter`, and
`examples/isolate-streaming` for HTTP-shaped app routes. Use
`examples/isolate-browser-capnp` for direct browser-to-capability native RPC.
Use `examples/isolate-capability-provider`, `examples/isolate-api-powerbox`,
and `examples/isolate-browser-powerbox` for WebSession/ApiSession lifecycle
and Powerbox flows.
