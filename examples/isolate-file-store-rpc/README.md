# Isolate File Store RPC Example

Run:

```sh
spk dev-isolate \
  --title "File Store RPC" \
  --app-interface capnp-es:./file-store.capnp#FileStore \
  examples/isolate-file-store-rpc/worker.js
```

This example models a small directory/file API as a schema-defined native
Cap'n Proto capability:

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
import { File, FileStore } from "capnp-es:./file-store.capnp";
```

For a packaged app, advertise the same provider through the normal
`bridgeConfig.viewInfo.matchRequests` field. Generate the descriptor snippet
from the schema:

```sh
spk powerbox-descriptor --format capnp capnp-es:./file-store.capnp#FileStore
# (tags = [(id = 0x9e13c3025dcd3d36)])
```

and put that descriptor in `ViewInfo.matchRequests`.

This example keeps directory listing and small file reads in typed RPC. For
large file contents, prefer the object-store pattern in
`examples/isolate-object-store`, where Cap'n Proto RPC selects the object and a
returned `WebSession` capability carries the byte stream.
