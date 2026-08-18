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
  `getViewInfo()` and offers the view to the user so it can be opened without
  making the preview appear in the normal grain list.

After the first grant, **Preview with saved grant** creates later immutable
snapshots without another Powerbox interaction. **Revoke saved grant** removes
the saved capability; when its last saved copy is removed, Sandstorm also marks
the durable preview grant revoked.

The app's storage is the source of truth for editable source. Sandstorm's
authoring service stores immutable candidate snapshots only. This example does
not request or receive app-publishing authority: an `IsolatePreviewer` cannot
install an app or publish a revision.

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
const uiViewDescriptor = await api.powerbox().uiViewDescriptor({
  title: "Isolate Authoring Example Preview",
});
const offeredView = previewerCapability.wrapDerived(result.view);
await api.powerbox().offer(offeredView, { descriptor: uiViewDescriptor });
await offeredView.drop();
```

The complete worker includes cleanup, exact `UInt64` handling, chunked
transfer, saved-grant restoration, and error display.
