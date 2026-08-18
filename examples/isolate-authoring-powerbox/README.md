# Isolate authoring Powerbox example

Run:

```sh
spk dev-isolate --title "Isolate Authoring Powerbox" \
  examples/isolate-authoring-powerbox/worker.js
```

Open the grain, edit the worker source, and choose **Grant and preview**. The
browser requests Sandstorm's `IsolatePreviewer` through Powerbox. The app saves
the grant, restores it, exports the current editor contents as an
`IsolateBundle`, and streams the module through `ByteStream` in multiple
chunks.

The preview call returns two capabilities:

- `IsolateCandidate` identifies the immutable normalized snapshot. The example
  calls `getInfo()` and displays its digest, module metadata, compatibility
  settings, warnings, and creation time.
- `UiView` identifies the hidden preview grain. The example calls
  `getViewInfo()`. After the HTTP response reaches the browser, the frontend
  sends the candidate digest to Sandstorm's shell, which verifies the current
  grant and opens the hidden preview in a shell-owned drawer. The grain remains
  absent from the normal grain list, and its grain ID is not exposed to the app.

After the first grant, **Preview with saved grant** creates later immutable
snapshots without another Powerbox interaction. **Revoke saved grant** removes
the saved capability; when its last saved copy is removed, Sandstorm also marks
the durable preview grant revoked.

**Read preview logs** uses that same saved preview capability to stream the
current candidate's debug log into the authoring worker. Sandstorm resolves the
candidate digest again under the grant's account and authoring grain, and
rejects stale candidates. The example reads an 8 KiB backlog briefly and then
drops the returned handle. A real authoring app can keep the handle alive to
analyze new output as it arrives. Sandstorm caps the requested backlog at 64
KiB.

The app's storage is the source of truth for editable source. Sandstorm's
authoring service stores immutable candidate snapshots only. **Publish reviewed
candidate** requests a fresh, one-shot `IsolatePublisher` capability whose
Powerbox tag commits to the displayed candidate digest, a new-app target, and
the displayed metadata.
When the user approves the request, Sandstorm binds the grant to the matching
preview-ready candidate in this authoring grain. The publisher installs an
ordinary app action without creating a first grain. The reusable
`IsolatePreviewer` still cannot publish anything by itself. The example stores
the `createdAppId` returned by the first publication; after previewing newer
source, its next publisher request targets that existing app and creates a new
revision instead of another app.

The important API pieces are:

```js
const descriptor = await api.powerbox().appInterfaceDescriptor(IsolatePreviewer);
const claimed = await api.powerbox().claim(powerboxResult);
const savedToken = await claimed.save({ label: "Isolate preview authority" });
const previewerCapability = await api.restore(savedToken);
const previewer = capnpClient(IsolatePreviewer, previewerCapability);

const result = await previewer.preview({
  requestId: crypto.randomUUID(),
  bundle: exportedBundle.client,
  metadata: { appTitle, nounPhrase, shortDescription },
});

const { info } = await result.candidate.getInfo({});
const candidateDigest = digestHex(info.normalizedDigest);
// Serialize candidateDigest into the returned browser page.
```

Programmatic log access uses a caller-provided `ByteStream`. Dropping the
returned handle stops the subscription:

```js
const receiver = byteStreamFromWritable(new WritableStream({
  write(data) {
    analyzeLogBytes(data);
  },
}));
const { handle } = await previewer.watchPreviewLog({
  normalizedDigest: info.normalizedDigest,
  backlogAmount: 8192,
  stream: receiver,
});

// Later, when the authoring app no longer wants log output:
handle.client.close();
receiver.client.close();
```

The browser page requests shell-owned presentation and waits for the matching
reply without receiving the hidden grain's ID:

```js
const rpcId = crypto.randomUUID();
window.parent.postMessage({
  showIsolatePreview: {
    rpcId,
    normalizedDigest: candidateDigest,
  },
}, "*");
```

Back in the worker, publication is separately authorized for that exact
candidate:

```js
const publishedApp = await api.storage().getJson("isolate-published-app");
const publishDescriptor = await api.powerbox().appInterfaceDescriptor(IsolatePublisher, {
  normalizedDigest: info.normalizedDigest,
  target: publishedApp
    ? { existingApp: publishedApp.createdAppId }
    : { newApp: undefined },
  metadata: { title, nounPhrase, shortDescription, marketingVersion: "1.0" },
});
const publisherCapability = await api.powerbox().claim(publisherPowerboxResult);
const publisher = capnpClient(IsolatePublisher, publisherCapability);
const { result: publication } = await publisher.publish({
  requestId: crypto.randomUUID(),
});
await api.storage().putJson("isolate-published-app", {
  createdAppId: publication.createdAppId,
});
```

The complete worker includes cleanup, exact `UInt64` handling, chunked
transfer, saved-grant restoration, digest-bound one-shot publication, and error
display, including cleanup of the preview log stream and subscription handle.
