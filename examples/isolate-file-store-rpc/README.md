# Isolate File Store RPC Example

Run:

```sh
spk dev-isolate \
  --title "File Store RPC" \
  --app-interface capnp:./file-store.capnp#FileStore \
  examples/isolate-file-store-rpc/worker.js
```

This example models a small directory/file API as a schema-defined native
Cap'n Proto capability:

```js
const listing = await store.listDirectory({ path: "docs" });
const opened = await store.openFile({ path: "docs/intro.txt" });
const bytes = await opened.file.read();
```

The app exposes the local capability metadata for inspection:

- `GET /self-test` exercises the generated `FileStore` and returned `File`
  clients locally.
- `POST /export-file-store` exports a local `FileStore` capnp-es client and
  returns its metadata plus the generated Powerbox descriptor.

The public protocol is in `file-store.capnp`; the isolate code imports it with:

```js
import { File, FileStore } from "capnp:./file-store.capnp";
```

For a packaged app, advertise the same provider through the normal
`bridgeConfig.viewInfo.matchRequests` field. Generate the descriptor snippet
from the schema:

```sh
spk powerbox-descriptor --format capnp capnp:./file-store.capnp#FileStore
# (tags = [(id = 0x9e13c3025dcd3d36)])
```

and put that descriptor in `ViewInfo.matchRequests`. Native Powerbox
fulfillment for local capnp-es exports is intentionally not shown here while the
isolate native bridge is being collapsed onto the single capnp RPC channel.

This example keeps directory listing and small file reads in typed RPC. For
large file contents, prefer the object-store pattern in
`examples/isolate-object-store`, where Cap'n Proto RPC selects the object and a
returned `WebSession` capability carries the byte stream. The same `FileStore`
schema can be imported by isolate code, browser code served by Sandstorm's
native client helper, or legacy Cap'n Proto grains once the holder has received
the capability through Sandstorm's normal capability flow.
