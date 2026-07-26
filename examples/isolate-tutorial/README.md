# Sandstorm Isolates Capability Example: Object Store + Upload App

This tutorial shows the app-author shape for two isolate apps:

- an **Object Store** app that owns files, exposes a schema-defined capability, and has a UI for browsing objects
- a **Dropbox Upload** app that asks the user for an upload-only capability and uploads a file to it

The snippets focus on Sandstorm concepts: `capnp:` schemas, Powerbox, generated clients, browser handoff, and saved tokens. They intentionally omit package boilerplate, CSS, and robust validation.

This version keeps the upload API deliberately small: `putObject()` takes a Cap'n Proto `Data` value. Because Sandstorm isolate storage is currently a simple key/value store and does not accept streaming request bodies directly, the example rejects uploads that are 1 MiB or larger.

## The Model

There are three different things in play:

- **UI routes**: an optional Fetch facade inside a typed `MainView` export, used for the app's normal browser UI.
- **Cap'n Proto capabilities**: typed app-to-app APIs generated from `.capnp` schemas.
- **Powerbox**: the user-mediated picker that gives one app a capability implemented by another app.

Authority arrives as a capability: through Powerbox, restore, or as a capability argument/result in Cap'n Proto RPC. Fetch is only a UI convenience in this example; calls to `ObjectUploadTarget` remain Cap'n Proto end to end.

## Shared Schema

Both apps use the same schema file, `object-store.capnp`. Matching is by Cap'n Proto interface ID, not by filename, so copy/import the same schema definition and evolve it with normal Cap'n Proto compatibility rules.

```capnp
@0x9db00f2d4d7c0a51;

using Grain = import "/sandstorm/grain.capnp";

struct ObjectStoreObjectId {
  type @0 :Text;
  bucket @1 :Text;
  prefix @2 :Text;
}

interface ObjectStore {
  listObjects @0 (bucket :Text, prefix :Text, cursor :Text)
      -> (objects :List(ObjectInfo), nextCursor :Text);

  uploadTarget @1 (bucket :Text, prefix :Text)
      -> (target :ObjectUploadTarget);

  struct ObjectInfo {
    key @0 :Text;
    size @1 :UInt64;
    contentType @2 :Text;
  }
}

interface ObjectUploadTarget extends(Grain.AppPersistent(ObjectStoreObjectId)) {
  putObject @0 (key :Text, contentType :Text, data :Data) -> (size :UInt64);
}
```

`ObjectUploadTarget` extends `Grain.AppPersistent` because the Dropbox app will save the capability. Its `save()` method returns an `ObjectStoreObjectId` such as `{ type: "uploadTarget", bucket: "inbox", prefix: "demo/" }`. Later, Sandstorm gives that object ID back to the Object Store grain's `MainView.restore()` hook, and the grain re-creates the same upload-only authority.

## App 1: Object Store

Run it in development:

```sh
spk dev-isolate \
  --title "Object Store" \
  object-store.js
```

`dev-isolate` is a wrapper around `spk dev` which handles generating the pkgdef for you. The worker advertises `ObjectUploadTarget` directly through `ViewInfo.matchRequests` on its typed `MainView` export. That is how Sandstorm knows this app can appear in Powerbox results for requests matching `ObjectUploadTarget`; advertising the interface does not itself create or fulfill a capability.

If you want to inspect the descriptor, you can generate it with:

```sh
spk powerbox-descriptor --format capnp capnp:./object-store.capnp#ObjectUploadTarget
```

### Worker Imports

```js
import {
  createCapnpStruct,
  defineWorker,
  exportCapnp,
  mainViewFromFetch,
  readCapnpStruct,
  sandstorm,
  storage,
} from "sandstorm:api";
import {
  ObjectStore,
  ObjectStoreObjectId,
  ObjectUploadTarget,
} from "capnp:./object-store.capnp";
```

`sandstorm:api` contains the helper utilities available to isolate grains.

`capnp:./object-store.capnp` is resolved by Sandstorm tooling. App authors do not need to install `capnpc` themselves.

The storage app implements both generated interfaces:

- `ObjectUploadTarget`: the narrow upload-only authority handed to other apps.
- `ObjectStore`: the broader control-plane API used by owner/admin callers.

In capnp-es, implementing the interface means providing a plain JavaScript method object to the generated `Server` class:

```js
const target = new ObjectUploadTarget.Server(methods).client();
```

or exporting that method object through Sandstorm:

```js
const exported = await exportCapnp(api, ObjectUploadTarget, methods);
```

### Typed MainView and Powerbox Matching

Workers that need explicit Cap'n Proto exports declare them with
`defineWorker()`. This app needs Powerbox matching and durable restore hooks,
so it chooses an explicit typed `MainView` with a Fetch facade for its UI:

```js
const VIEW_INFO = {
  matchRequests: [{
    tags: [{
      id: ObjectUploadTarget._capnp.typeId,
    }],
  }],
};

export default defineWorker({
  capabilities: {
    ui: mainViewFromFetch({
      fetch: objectStoreFetch,
      viewInfo: VIEW_INFO,
      restore: restoreObjectStoreObject,
      drop: dropObjectStoreObject,
    }),
  },
});
```

`ViewInfo.matchRequests` contains an interface tag using the generated interface's stable type ID. This replaces the removed `spk dev-isolate --app-interface` and `bridgeConfig.viewInfo.matchRequests` paths. The worker implements `MainView` in capnp-es; only the selected UI is translated to `Request` and `Response`.

### Storage Helpers

Sandstorm provides a simple key/value storage capability to isolates through `sandstorm:api`. Storage keys are flat keys, not paths: use only letters, digits, `_`, `.`, and `-`, keep them short, and do not use `/`.

This tutorial stores each object body as one storage value and stores metadata in a JSON index. Since the storage API is not streaming here, the example rejects uploads that are 1 MiB or larger.

```js
const INDEX_KEY = "object-index";
const MAX_OBJECT_BYTES = 1024 * 1024;

async function putStorageBytes(store, key, bytes) {
  const result = await store.put(key, bytes);
  if (!result?.ok) {
    throw new Error(`storage put ${key} failed with ${result?.status || "unknown status"}`);
  }
  return result;
}

async function putObject(store, { bucket, key, contentType, data }) {
  const bytes = data.toUint8Array();
  if (bytes.byteLength >= MAX_OBJECT_BYTES) {
    throw new Error("object is too large");
  }

  const storageKey = objectStorageKey();
  await putStorageBytes(store, storageKey, bytes);
  await addToIndex({ bucket, key, contentType, storageKey, size: bytes.byteLength });
  return { size: BigInt(bytes.byteLength) };
}
```

The real example includes small helpers for key validation, index loading/saving, and serialized index updates. The Sandstorm-specific point is that app code receives a generated `Data` value, converts it to bytes with `data.toUint8Array()`, and writes it to isolate storage.

`ObjectStoreObjectId` is also part of the Sandstorm contract: it is the provider-defined object identity that `save()` returns and `restore()` receives later.

```js
function makeObjectStoreObjectId(type, bucket, prefix = "") {
  return createCapnpStruct(ObjectStoreObjectId, { type, bucket, prefix });
}

function readObjectStoreObjectId(objectId) {
  const decoded = readCapnpStruct(ObjectStoreObjectId, objectId);
  return {
    type: decoded.type,
    bucket: decoded.bucket,
    prefix: decoded.prefix,
  };
}
```

### The Upload-Only Capability

This plain JavaScript object is the storage app's implementation of the generated `ObjectUploadTarget` interface. It can write under a fixed bucket/prefix, but cannot list or read.

```js
function makeUploadTarget(store, bucket, prefix = "") {
  const objects = createObjectStorage(store);

  return {
    async putObject({ key, contentType = "application/octet-stream", data }) {
      const fullKey = `${prefix}${validateObjectKey(key)}`;
      return await objects.putObject({
        bucket,
        key: fullKey,
        contentType,
        data,
        overwrite: false,
      });
    },

    async save() {
      return {
        objectId: makeObjectStoreObjectId("uploadTarget", bucket, prefix),
        label: { defaultText: `upload to ${bucket}/${prefix || ""}` },
      };
    },
  };
}
```

This is where least authority happens. The Dropbox app gets only `ObjectUploadTarget`, not `ObjectStore`, so it cannot browse or read. Upload-only is still write authority, so this example makes uploads no-clobber; otherwise a buggy uploader could overwrite data under its prefix.

The `save()` method is the `Grain.AppPersistent.save()` implementation inherited by `ObjectUploadTarget`. It serializes the closure state (`bucket` and `prefix`) into an app-defined object ID that Sandstorm can hand back to the provider on restore.

When another Cap'n Proto method needs to return this upload-only authority, wrap the implementation in the generated server class and return the resulting client:

```js
function makeUploadTargetClient(store, bucket, prefix = "") {
  return new ObjectUploadTarget.Server(
    makeUploadTarget(store, bucket, prefix)).client();
}
```

### The Full Object Store Capability

This method object is the storage app's implementation of the generated `ObjectStore` interface. It can list objects and create narrower upload targets.

```js
function makeObjectStore(store) {
  const objects = createObjectStorage(store);

  return {
    async listObjects({ bucket = "inbox", prefix = "", cursor = "" }) {
      return await objects.list({ bucket, prefix, cursor });
    },

    async uploadTarget({ bucket = "inbox", prefix = "" }) {
      return {
        target: makeUploadTargetClient(store, bucket, prefix),
      };
    },
  };
}
```

Notice the capability relationship: `ObjectStore.uploadTarget()` returns a live capability implementing `ObjectUploadTarget`, allowing the recipient to call `putObject()` but not `listObjects()`.

### Export Capabilities

`exportCapnp()` turns a local server object into a live Cap'n Proto capability. Do this when you need to hand the object across a capability boundary: Powerbox fulfillment, browser handoff, saving, or returning a capability from another Cap'n Proto method.

```js
async function exportUploader(api, store, bucket, prefix) {
  return exportCapnp(
    api,
    ObjectUploadTarget,
    makeUploadTarget(store, bucket, prefix),
  );
}
```

The returned object owns the local server and has helper methods like `.save()`, `.drop()`, and `.browserHandoff()`. JSON output is metadata only, not authority. Do not add a normal UI route that exports your broadest capability; route access through Powerbox or an explicit browser handoff.

### Powerbox Request Session

When another app requests `ObjectUploadTarget`, Sandstorm opens your app in a request session. Your request-session UI might let the user choose a bucket/prefix and then fulfill the request with an upload-only capability.

The exact picker can be as small as one form:

```js
function renderPowerboxPicker() {
  return `<!doctype html>
    <h1>Choose upload destination</h1>
    <form method="post" action="/powerbox/fulfill-upload">
      <input name="bucket" value="inbox">
      <input name="prefix" value="">
      <button type="submit">Allow uploads here</button>
    </form>`;
}
```

The fulfillment call is:

```js
async function fulfillUploadRequest(request, env, bucket, prefix) {
  const api = sandstorm(request, env);
  const uploader = await exportUploader(
    api, api.storage(), bucket, prefix);
  const descriptor = await api.powerbox().appInterfaceDescriptor(ObjectUploadTarget);

  await api.powerbox().fulfillRequest(uploader, {
    descriptor,
    title: { defaultText: `Upload to ${bucket}/${prefix || ""}` },
  });
}
```

`api.powerbox().fulfillRequest()` fulfills the current request-session Powerbox request with a capability, the matching descriptor, and display info. The provider does not decide which other grain receives access. The user chooses the provider and destination through Powerbox, and the provider fulfills with the narrow capability.

### Persistent Restore

When Dropbox later calls `.save()` on the upload target, Sandstorm invokes the target's `save()` method and stores the returned `ObjectStoreObjectId`. After the Object Store grain restarts, Sandstorm restores the saved token by calling the grain's typed `MainView.restore()` hook. `mainViewFromFetch()` exposes this as an explicit `restore` callback.

```js
async function restoreObjectStoreObject(objectId, { env }) {
  const decoded = readObjectStoreObjectId(objectId);

  if (decoded.type === "uploadTarget") {
    return makeUploadTargetClient(
      storage(env), decoded.bucket, decoded.prefix);
  }

  throw new Error("unknown object store capability");
}

async function dropObjectStoreObject(objectId) {
  const decoded = readObjectStoreObjectId(objectId);
  if (decoded.type !== "uploadTarget") {
    throw new Error("unknown object store capability");
  }
}
```

This is the missing persistence step in many Powerbox examples: Sandstorm persists an app-defined object ID, not a JavaScript closure. The closure is re-created by the typed restore handler. The callback receives a workerd call context, so it can access the typed storage capability through `storage(env)` without inventing an HTTP request.

### Object Store Worker Skeleton

```js
async function objectStoreFetch(request, env) {
  const api = sandstorm(request, env);
  const url = new URL(request.url);

  if (api.session().sessionType === "request" && url.pathname === "/") {
    return new Response(renderPowerboxPicker(), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  if (api.session().sessionType === "request" &&
      url.pathname === "/powerbox/fulfill-upload" &&
      request.method === "POST") {
    const form = await request.formData();
    return fulfillUploadRequest(
      request,
      env,
      String(form.get("bucket") || "inbox"),
      String(form.get("prefix") || ""),
    );
  }

  if (url.pathname === "/" && request.method === "GET") {
    return new Response(await renderBrowser(api.storage()), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  return new Response("not found", { status: 404 });
}

export default defineWorker({
  capabilities: {
    ui: mainViewFromFetch({
      fetch: objectStoreFetch,
      viewInfo: VIEW_INFO,
      restore: restoreObjectStoreObject,
      drop: dropObjectStoreObject,
    }),
  },
});
```

The worker does not expose a top-level Fetch handler. `defineWorker()` exports a typed `MainView`, and `mainViewFromFetch()` performs the UI-only conversion between WebSession calls and `Request`/`Response`. Sandstorm's generated browser schema modules and native browser Cap'n Proto helper routes are served by the shell, not by application-defined system routes.

## App 2: Dropbox Upload

The upload app does not know the object store grain ID or URL. It asks for "an object implementing `ObjectUploadTarget`".

It also imports the same schema:

```js
import {
  capnpClient,
  sandstorm,
} from "sandstorm:api";
import { ObjectUploadTarget } from "capnp:./object-store.capnp";
```

Run it normally; it does not provide the capability, it just consumes one:

```sh
spk dev-isolate --title "Dropbox Upload" dropbox-upload.js
```

### Browser: Live Session Capability

The browser owns the user gesture, so it can open Powerbox directly. This flow is useful when the UI needs a live capability only for the current browser session. Nothing durable is saved; reload the page and request again.

```html
<input id="file" type="file">
<button id="connect">Choose upload destination</button>
<button id="upload" disabled>Upload</button>
<pre id="status"></pre>

<script type="module">
  import { ObjectUploadTarget } from "/__sandstorm/capnp/object-store.capnp.js";
  import {
    requestBrowserNativeCapnp,
  } from "/__sandstorm/native-capnp/client.js";

  const MAX_UPLOAD_BYTES = 1024 * 1024;
  let uploader = null;

  document.querySelector("#connect").onclick = async () => {
    const granted = await requestBrowserNativeCapnp(ObjectUploadTarget);
    uploader = granted.client;
    document.querySelector("#upload").disabled = false;
  };

  document.querySelector("#upload").onclick = async () => {
    const file = document.querySelector("#file").files[0];
    if (!file || !uploader) return;
    if (file.size >= MAX_UPLOAD_BYTES) {
      throw new Error("choose a file smaller than 1 MiB");
    }

    const result = await uploader.putObject({
      key: file.name,
      contentType: file.type || "application/octet-stream",
      data: new Uint8Array(await file.arrayBuffer()),
    });
  };
</script>
```

This is the simplest live-capability flow:

1. Browser asks Powerbox for `ObjectUploadTarget`.
2. User chooses the Object Store grain and destination.
3. Browser receives a live generated client.
4. Browser calls `putObject()` with file bytes.

The Dropbox app never receives read/list authority.

The browser RPC connection is authorized by the current Sandstorm session and the handed-off capability ID. A browser-held live cap is not a durable token and dies with the session, revocation, or connection close. It is still real authority while the page is loaded: an XSS bug in your UI could call it, just as XSS could call your own UI endpoints.

### Worker Persistence: Save The Capability For Later

If the upload app should remember the destination, use the durable flow instead: the browser asks Powerbox for a claim token, sends that token to the worker, and the worker claims and saves the capability.

Browser:

```js
import { ObjectUploadTarget } from "/__sandstorm/capnp/object-store.capnp.js";
import {
  nativeCapnpPowerboxDescriptor,
  requestPowerbox,
} from "/__sandstorm/native-capnp/client.js";

const descriptor = await nativeCapnpPowerboxDescriptor(ObjectUploadTarget);
const requested = await requestPowerbox([descriptor], {
  saveLabel: { defaultText: "upload destination for Dropbox Upload" },
});

await fetch("/claim-upload-target", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(requested),
});
```

Worker claim route:

```js
async function claimUploadTarget(request, env) {
  const api = sandstorm(request, env);
  const body = await request.json();
  const descriptor = await api.powerbox().appInterfaceDescriptor(ObjectUploadTarget);

  const capability = await api.powerbox().claim(body, { descriptor });

  try {
    const token = await capability.save({
      label: "Dropbox Upload destination",
    });
    await api.storage().put(uploadTokenKey(api), token);
    return Response.json({ ok: true });
  } finally {
    await capability.drop();
  }
}
```

Later, upload from the worker by restoring the saved token:

```js
const MAX_UPLOAD_BYTES = 1024 * 1024;

async function fileData(file) {
  if (file.size >= MAX_UPLOAD_BYTES) {
    throw new Error("choose a file smaller than 1 MiB");
  }
  return new Uint8Array(await file.arrayBuffer());
}

async function uploadFromWorker(request, env) {
  const api = sandstorm(request, env);
  const form = await request.formData();
  const file = form.get("file");
  const token = await api.storage().get(uploadTokenKey(api));
  if (!token) throw new Error("No upload destination has been chosen.");

  const data = await fileData(file);
  return api.use(token, async (capability) => {
    const uploader = capnpClient(ObjectUploadTarget, capability);
    const result = await uploader.putObject({
      key: file.name,
      contentType: file.type || "application/octet-stream",
      data,
    });
    return Response.json({ ok: true, size: Number(result.size) });
  });
}
```

`api.use(token, callback)` restores the durable token for the duration of the callback and drops the live capability afterward. `capnpClient(ObjectUploadTarget, capability)` does not grant new authority; it gives a typed generated client view over the live Sandstorm capability so app code can call `putObject()`.

`requiredPermissions` is important when your package declares permissions. It ties the saved token to the user's current permission on the Dropbox grain; if that permission is revoked later, Sandstorm rejects restore. The runnable example only sends `requiredPermissions` when the current dev/package session actually has a `configure` permission, which keeps the no-custom-pkgdef tutorial runnable. This example stores one destination per user. For a grain-wide destination, require an admin/configuration permission before overwriting a shared token.

### Dropbox Worker Skeleton

```js
async function dropboxUploadFetch(request, env) {
  const api = sandstorm(request, env);
  const url = new URL(request.url);

  if (url.pathname === "/claim-upload-target" && request.method === "POST") {
    return claimUploadTarget(request, env);
  }

  if (url.pathname === "/upload" && request.method === "POST") {
    return uploadFromWorker(request, env);
  }

  return new Response(renderUploadPage(api), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export default {
  fetch: dropboxUploadFetch,
};
```

Because this app only consumes a capability and serves a normal browser UI,
its Cloudflare-style `fetch` export is enough. Sandstorm automatically adapts
it to the package's typed `ui: MainView` export. Use the explicit
`defineWorker()` form when an app needs additional named capabilities,
`ViewInfo` metadata, or durable restore/drop hooks, as the Object Store does.

## Summary

The object store implements two different authorities:

- `ObjectStore`: list and create narrower capabilities
- `ObjectUploadTarget`: upload-only

The Dropbox app requests only `ObjectUploadTarget`, so even bugs in Dropbox cannot read or list objects. It can still write, so the provider chooses no-clobber upload semantics. Sandstorm records the user's choice through Powerbox, and saved tokens remain revocable by Sandstorm. When the package declares a `configure` permission, the Dropbox worker can claim with `requiredPermissions: ["configure"]`, so restoring the saved token fails if that user later loses the required permission.

## Cap'n Proto Interop

This is normal Sandstorm Powerbox matching. An isolate advertises support by putting the same `PowerboxDescriptor` in `ViewInfo.matchRequests`. A traditional Cap'n Proto grain can request or fulfill the same interface by using the same descriptor and implementing the same interface ID. Neither side needs WebSession or HTTP for the typed capability call.

If the Powerbox UI offers creating a new grain for a provider app, an isolate provider works the same way as any other Sandstorm app once packaged with the right typed view info.

## Some Notes

- Keep schemas small and stable. Use `spk capnp-abi` in CI before changing public interfaces.
- Do not JSON-serialize generated capnp result objects directly when they contain `BigInt`; copy or coerce the fields you want to display.
- This tutorial uses `Data` for simplicity and rejects uploads that are 1 MiB or larger. Use a typed streaming capability such as `ByteStream` from `sandstorm/util.capnp` for real file uploads or large payloads.
- Declare Powerbox matches in the `viewInfo` passed to `mainViewFromFetch()`; `spk dev-isolate --app-interface` has been removed.
- Browser schema modules and native Powerbox helpers are served by Sandstorm; the worker does not implement private system routes.
- Handle disconnected/revoked capabilities. In real code, catch restore/call failures, clear stale saved tokens if appropriate, and ask the user to reconnect through Powerbox.
