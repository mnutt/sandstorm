# Inline Isolate Preview Plan

## Summary

Sandstorm should display the live `UiView` of an isolate candidate without making
the user leave the authoring interface. The built-in `/apps/create` editor should
show the preview beside the draft, while an ordinary authoring app should be able
to ask the shell to show the same kind of preview in a shell-owned drawer.

The first implementation should remain specific to isolate candidates. It should
reuse the existing hidden preview grain and `GrainView` session machinery rather
than introduce a second HTTP proxy, expose a grain session URL to app code, or add
a general nested-`UiView` API to `SessionContext`.

```text
built-in editor -- preview result contains grainId --------+
                                                        |
authoring app -- candidate digest -- shell resolver -----+--> IsolatePreviewPane
                                                        |          |
                                                        |          +--> detached GrainView
                                                        |          +--> hidden preview grain
                                                        |          +--> shell toolbar
                                                        |
                                                        +--> exact candidate/grain check
```

## Goals

- Keep source editing and a live preview visible in one authoring workflow.
- Preserve the authoring interface's browser state while a preview opens or
  refreshes.
- Reuse one hidden preview grain per authoring scope, including its persistent
  storage, ordinary sleep behavior, logs, and runtime limits.
- Reload the embedded view immediately when that preview grain moves to a new
  immutable candidate.
- Give built-in authoring and app-based authoring the same shell-owned preview
  presentation.
- Avoid giving an authoring app a grain ID, session ID, iframe origin, or other
  browser credential merely so it can display a preview.
- Keep preview grains hidden from the normal grain list and non-shareable.
- Leave a clean route to a future general auxiliary-`UiView` API if other use
  cases justify the extra platform surface.

## Non-goals for the first implementation

- Letting arbitrary applications embed arbitrary `UiView` capabilities.
- Allowing app HTML to construct or position a privileged Sandstorm grain iframe.
- A multi-pane window manager or persistent user-configurable workspace layout.
- Multiple simultaneous preview panes in one shell tab.
- Mobile device emulation, network throttling, or browser developer-tool
  integration.
- Changing isolate candidate, preview-grain, or publication semantics.
- Automatically granting authority requested by the previewed application.

## Product behavior

### Built-in authoring

On desktop, `/apps/create` uses a two-column workspace when a preview is open:

- the existing metadata and source form remains on the left;
- the live preview occupies the right side;
- before the first preview, the editor may use the full available width;
- the divider does not need to be resizable in the first version.

On narrow screens, the preview is a shell page section or full-size sheet with a
clear return-to-editor action. It must not force an unusably narrow editor and
preview side by side.

Submitting Preview should:

1. snapshot and validate the current draft as it does today;
2. create or update the hidden preview grain;
3. show that grain in the preview pane;
4. replace the pane's browser session when the candidate digest changes;
5. leave preview storage intact;
6. keep the draft form and its focus/state mounted.

Reset preview data continues to replace the hidden grain. If the preview pane is
open, it moves to the replacement grain and starts a fresh browser session.

### Authoring apps

An authoring app continues to call `IsolatePreviewer.preview()` and receive an
immutable candidate plus a `UiView`. To request inline presentation, its browser
frontend sends a new client API message containing the exact normalized digest:

```js
window.parent.postMessage({
  showIsolatePreview: {
    rpcId: "caller-generated-id",
    normalizedDigest: "64 lowercase hexadecimal characters",
  },
}, "*");
```

The shell maps `event.origin` to the sending authoring grain, resolves the digest
within that grain's preview grant, and opens the corresponding hidden preview in
a shell-owned drawer. A successful reply contains the same `rpcId` and a simple
success indication. It does not return the resolved grain ID.

The current `UiView` return remains part of the capability contract. Applications
which do not use the browser message can continue to offer or otherwise present
the view using existing behavior.

Repeated requests for a newer candidate in the same authoring scope reuse the
open drawer and replace its embedded browser session. Closing the drawer affects
only presentation; it does not delete the candidate, preview grain, or preview
storage.

## Shared preview-pane component

Add one client-side component, provisionally `IsolatePreviewPane`, responsible
for the lifecycle of a detached `GrainView`.

Its small interface should be conceptually equivalent to:

```js
pane.show({ grainId, normalizedDigest });
pane.reload();
pane.close();
pane.destroy();
```

Responsibilities:

- mount a `GrainView` under a supplied shell-owned DOM element;
- open an owner-authenticated session for the hidden preview grain;
- keep the same session while asked to show the same grain and digest;
- call `reset()` and `openSession()` when the digest changes on the same grain;
- destroy the old view before moving to a replacement grain;
- destroy subscriptions, observers, and Blaze views with the containing template;
- expose reactive state needed for loading, errors, and toolbar controls;
- never add the detached view to the sidebar's `GrainViewList`;
- never update the top-level route from preview navigation;
- give its iframe a unique testing ID prefix.

The component should use the existing `GrainView` rather than duplicate session
creation or manually construct `/_sandstorm-init` URLs. The existing detached
Powerbox view is useful precedent, but the new component should own its cleanup
explicitly rather than spread lifecycle calls across template helpers.

### Toolbar

The shell-owned toolbar should initially provide:

- a visible Preview label;
- a shortened candidate digest when available;
- Reload, which resets only the browser session;
- Open in full tab, which uses `/grain/<grainId>`;
- View logs, which uses `/grainlog/<grainId>`;
- Close.

Resetting preview storage remains an authoring action, not a toolbar reload.

## Built-in integration

The built-in authoring client already receives both `result.grainId` and the
candidate summary. It therefore needs no new server method.

Changes:

- add a preview-pane mount and toolbar to the authoring template;
- create and destroy the pane with the Blaze template lifecycle;
- remove the pre-opened `about:blank` window from Preview;
- after a successful preview, call `pane.show()` with the grain ID and digest;
- after Reset preview data, move the pane to the returned replacement grain;
- preserve the current status and publication UI;
- retain Open in full tab as an explicit toolbar action.

The local draft may continue recording `preview.grainId`; this is browser-local
shell state and is not exposed to an authoring app.

## Authoring-app resolver

Add a narrowly scoped server function and Meteor method which resolve an exact
candidate into a current preview grain for the shell client.

Inputs:

- authenticated account ID from the method context;
- sending authoring grain ID supplied by the trusted shell message handler;
- normalized candidate digest supplied by the authoring app.

Required checks:

1. The digest is canonical lowercase hexadecimal and exactly 32 bytes.
2. The account is signed in and eligible.
3. The sending grain exists, is active, and is owned by that account.
4. A preview grant exists for that owner and requesting grain.
5. The candidate belongs to the same owner and requesting grain.
6. The candidate digest matches exactly and the candidate is preview-ready.
7. The candidate has a `previewGrainId`.
8. The grain exists, is owned by the account, is not trashed, and has
   `isolatePreview.candidateId` equal to that candidate ID.
9. The grain's preview scope corresponds to the grant which authorized the
   authoring grain.

The result returned to shell client code may contain the preview grain ID and
digest. The postMessage response returned to app-origin code must not contain the
grain ID.

A digest is a locator, not authority. All ownership and grant relationships are
derived again on the server.

## Browser message handling

Extend Sandstorm's existing grain postMessage listener rather than adding a
second global listener.

The handler should:

- accept requests only from an origin belonging to a currently open GrainView;
- validate the complete request shape and digest before calling the server;
- require the sending view to be the active authoring view;
- pass `senderGrain.grainId()` rather than trusting a grain ID from app data;
- resolve and open the preview through a shell-level pane controller;
- respond directly to `event.source` and `event.origin` using the caller's
  `rpcId`;
- return sanitized errors;
- coalesce or order rapid requests so an older response cannot replace a newer
  preview.

The pane controller is scoped to the current browser tab. Navigation to another
top-level route or destruction of the authoring GrainView closes the drawer and
its embedded browser session.

## Embedded-view fidelity

The first version must support normal HTTP rendering, JavaScript, storage,
worker requests, and logs because these all run through the ordinary GrainView
session.

Some shell postMessage actions from the preview iframe require special care:

- the current global dispatcher recognizes only GrainViews in the primary
  `GrainViewList`;
- adding the preview to that list would incorrectly create a normal shell tab;
- general nested-view Powerbox and topbar ownership would expand the scope
  considerably.

For the first implementation, add only the minimal auxiliary-origin registration
needed for safe path/title messages if it remains small. If a previewed app asks
for an interaction which cannot be represented correctly inside the pane, show
an explicit instruction to use Open in full tab. Do not silently grant, drop, or
misroute the request.

Once real authoring use demonstrates the need, a follow-up can introduce a
registry of all visible GrainViews and route Powerbox/topbar interactions to the
currently focused view. That work should be reviewed as general shell UI
composition, not hidden inside isolate authoring.

## Security properties

- The preview iframe remains a normal random Sandstorm UI origin.
- The shell alone constructs and owns the iframe and browser session.
- App code never sees `/_sandstorm-init`, a session ID, host ID, or resolved
  preview grain ID.
- Cross-origin isolation prevents the authoring app from reading or scripting
  the preview iframe.
- The shell retains visible close/open/log controls which the app cannot cover.
- A shared user cannot use another user's authoring grain or preview grant to
  open account-owned previews.
- An authoring grain cannot select another grain merely by learning a digest.
- A stale candidate cannot resolve after the shared preview grain has moved to a
  newer candidate.
- Opening the pane does not create a share token or durable saved capability.
- Existing preview sharing restrictions remain in force.

## Lifecycle and failure handling

- Opening the same grain and digest is a no-op unless Reload was requested.
- A new digest for the same grain resets the embedded GrainView session.
- A replacement grain destroys the old GrainView before opening the new one.
- Closing the drawer destroys only its browser session.
- Logging out, switching accounts, leaving the authoring route, or closing the
  source grain destroys the pane.
- A failed preview leaves the last successful view visible and reports the build
  error in the authoring UI.
- A failed pane session shows a contained error with Reload and Open in full tab
  where applicable.
- Rapid app requests are sequenced by a monotonically increasing local request
  generation so only the latest resolution is displayed.

## Testing plan

### Unit and server tests

- Resolve the current candidate for its owning authoring grain.
- Reject malformed and non-canonical digests.
- Reject another owner's candidate.
- Reject a candidate created by a different authoring grain.
- Reject a candidate whose preview grant is revoked.
- Reject a stale candidate after the preview grain moves to another revision.
- Reject a trashed or replacement-mismatched preview grain.
- Return no browser credential from the resolver.

### Client/component tests

- Showing a first preview creates one detached GrainView.
- Showing the same grain and digest does not reopen its session.
- Showing a new digest resets the same grain view.
- Moving to a replacement grain destroys the previous view.
- Closing and template destruction clean up observers and subscriptions.
- Reload does not reset grain storage.

### Browser tests

- Built-in Preview opens inline and does not create another browser tab.
- Editing and previewing revision two updates the pane without a page reload.
- The editor remains mounted and retains its draft.
- Reset preview data moves the pane to a fresh grain.
- Open in full tab and View logs work.
- The authoring example uses the saved preview grant and opens a shell drawer.
- A second app-authored preview updates the existing drawer immediately.
- Closing the drawer leaves the authoring app active.
- Preview grains remain absent from the normal grain list.

## Implementation sequence

### Chunk 1: Shared pane and built-in editor

- Add the preview-pane component and contained styles.
- Add the embedded GrainView lifecycle option(s) needed to avoid route changes
  and duplicate iframe IDs.
- Integrate it into `/apps/create`.
- Update built-in browser tests for inline display, refresh, reset, logs, and
  explicit full-tab opening.

This chunk has no new server authority or public API.

### Chunk 2: Candidate resolver and browser bridge

- Add the owner/grant/candidate/grain resolver.
- Add focused authorization tests.
- Add the `showIsolatePreview` postMessage request and response.
- Add a shell-level drawer controller using the shared pane.
- Define navigation and teardown behavior.

This chunk does not change the public Cap'n Proto capability ABI.

### Chunk 3: Authoring example and fidelity

- Replace the example's automatic `UiView` offer with the browser presentation
  request.
- Keep an explicit full-tab fallback.
- Extend the browser test to verify same-tab authoring and immediate revision
  refresh.
- Add minimal auxiliary-origin handling required by demonstrated preview apps.

### Chunk 4: Optional generalization

Only after evaluating the isolate-specific experience, decide whether to design
a general session-scoped auxiliary `UiView` API. Such an API would need explicit
token lifetime, nested Powerbox, focus, topbar, navigation, spam, and cleanup
semantics. It should reuse `IsolatePreviewPane` internally but remain outside the
MVP critical path.

## Completion criteria

The work is complete when both built-in authoring and the Powerbox authoring
example can preview and refresh the current candidate without leaving or
reloading their authoring interface, while the shell remains the only component
which knows how to open the hidden preview grain's browser session.
