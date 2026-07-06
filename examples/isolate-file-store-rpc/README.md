# Isolate File Store RPC Example

Run:

```sh
spk dev-isolate --title "File Store RPC" examples/isolate-file-store-rpc/worker.js
```

This example models a small directory/file API as a schema-defined app-object
capability:

```js
const listing = await store.listDirectory({ path: "docs" });
const opened = await store.openFile({ path: "docs/intro.txt" });
const bytes = await opened.file.read();
```

The app exposes the same capability in two Sandstorm ways:

- `POST /offer-file-store` offers a `FileStore` capability to the current user.
- `/powerbox/file-store` serves a fulfillment page for incoming Powerbox
  requests.

The public protocol is in `file-store.capnp`; the isolate code imports it with:

```js
import { File, FileStore } from "capnp:./file-store.capnp";
```

Today this uses Sandstorm's schema-shaped app-object RPC bridge, not the native
Cap'n Proto RPC transport. It is suitable for control-plane calls and small
payloads. For large file contents, prefer the object-store pattern in
`examples/isolate-object-store`, where Cap'n Proto RPC selects the object and a
returned `WebSession` capability carries the byte stream over fetch.
