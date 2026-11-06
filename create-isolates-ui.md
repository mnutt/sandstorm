# Create Isolate Apps UI Plan

## Summary

Adding a UI under Apps for creating isolate-backed apps is feasible. The isolate
runtime work already fits Sandstorm's normal app/grain model: isolate commands
are regular package commands with `Command.isolate`, and isolate grains appear
to the shell, backend, gateway, sharing system, and Powerbox plumbing as normal
`Supervisor`, `UiView`, and `WebSession` grains.

The main implementation work is not the runtime launch path. It is productizing
app authoring around:

- editable source storage;
- per-user ownership and access control;
- manifest/package generation;
- preview grain lifecycle;
- saved app revisioning;
- eventual packaging/export semantics.

This should be a Sandstorm-native app-authoring feature that generates isolate
packages or package-like records. It should not be a browser wrapper around the
current `spk dev-isolate` command.

## Existing Runtime Fit

The current isolate architecture already provides the core execution path:

- `Manifest.Command.isolate` selects the isolate runtime.
- The backend launches `isolate-supervisor` for isolate commands.
- The isolate supervisor materializes a workerd runtime bundle, starts the
  bundled workerd sidecar, and proxies Sandstorm `WebSession` requests into
  Worker `fetch()` calls.
- The shell and gateway continue to see ordinary Sandstorm grains.
- The runtime already supports useful MVP bindings: `SANDSTORM_API`, `STORAGE`,
  text/json/data bindings, injected `sandstorm:api`, `sandstorm:rpc`, and
  `capnweb` helper modules.

The existing `newGrain(packageId, command, title)` method already accepts both
installed packages and dev packages, then starts the selected manifest command
through the existing backend path. This is enough to launch preview grains once
the editor produces a package-like record with an isolate command.

## Product Shape

Add a `/apps/create` route reachable from the Apps page. The Apps page can show
a "Create App" pseudo-app or a button near the existing install/upload controls.

The Create App page should be a real app-building workspace, not a marketing or
intro page. MVP controls:

- App title.
- Noun phrase.
- Short description.
- Compatibility date.
- Source editor for `worker.js`.
- Binding picker with only supported bindings enabled initially.
- Preview action.
- Save action.
- Runtime/build error display.

MVP source should be a single `worker.js` file. Multi-file support can come
after the server-side package generator and revision model are stable.

The editor should provide a starter worker like:

```js
import { sandstorm } from "sandstorm:api";

export default {
  async fetch(request, env) {
    const api = sandstorm(request, env);
    const count = Number(await api.storage().getText("count") || "0") + 1;
    await api.storage().put("count", String(count));

    return new Response(`<!doctype html>
<html>
  <body>
    <h1>Hello from an isolate app</h1>
    <p>This grain has handled ${count} request(s).</p>
  </body>
</html>`, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};
```

## Data Model

Do not store user-authored source in global `devPackages`. Today,
`devPackages` are development-session records and are published broadly to
clients. A web editor needs owner-scoped records.

Suggested collections:

### `isolateApps`

One logical app owned by one user.

Fields:

- `_id`
- `ownerId`
- `appId`
- `title`
- `nounPhrase`
- `shortDescription`
- `createdAt`
- `updatedAt`
- `draftRevisionId`
- `savedRevisionId`
- `previewGrainId`, optional

### `isolateAppRevisions`

Immutable source snapshots.

Fields:

- `_id`
- `appId`
- `ownerId`
- `createdAt`
- `sourceFiles`
- `mainModule`
- `compatibilityDate`
- `bindings`
- `manifest`
- `packageId`
- `status`: `draft`, `saved`, `failed`
- `error`, optional

For MVP, `sourceFiles` can be a small embedded object:

```js
{
  "worker.js": {
    type: "esModule",
    content: "..."
  }
}
```

If source grows beyond comfortable Mongo document size, move file contents to
server-owned package storage or a blob/static-asset style collection.

## Package Generation

Reuse the shape of `spk dev-isolate`, but move the generation logic into
server-side code or a small backend helper.

The generator should:

1. Validate app metadata.
2. Validate filenames and module names.
3. Validate source size and file count.
4. Validate compatibility date.
5. Validate selected bindings.
6. Build a `Manifest` with:
   - one action;
   - `continueCommand`;
   - `Command.argv = ["workerd", "serve",
     "${SANDSTORM_ISOLATE_WORKERD_CONFIG}", "sandstormConfig"]`;
   - `Command.isolate.mainModule`;
   - module path entries;
   - `SANDSTORM_API` and `STORAGE` bindings;
   - `bridgeConfig.viewInfo.appTitle`.
7. Materialize package files into a server-owned package directory.
8. Insert or update an owner-scoped package-like record usable by grain launch.

The current `spk dev-isolate` code is useful reference material because it
already:

- generates an isolate manifest;
- injects `capnweb`, `sandstorm:api`, and `sandstorm:rpc`;
- maps module files under package paths;
- adds `SANDSTORM_API` and `STORAGE`;
- derives stable app IDs for development apps.

However, the current `spk dev` path depends on local filesystem access, FUSE,
and daemon-side `devpackages` insertion. Those are wrong assumptions for a
multi-user browser feature.

## Preview Lifecycle

For MVP, preview should create a normal grain from the generated revision.

Preview flow:

1. User clicks Preview.
2. Client calls `previewIsolateAppDraft(appId, draftContents)`.
3. Server validates and saves a new draft revision.
4. Server generates or updates a preview package.
5. Server shuts down the previous preview grain if one exists.
6. Server launches a new grain through the existing backend path.
7. Client routes to `/grain/:grainId`.

Hot reload can come later. Restarting the preview grain is simpler and matches
the current isolate sidecar lifecycle.

Preview grains should be clearly associated with the app draft. They can either:

- be real private grains with a generated title such as
  `Preview: <app title>`; or
- be marked with metadata so they can be hidden from normal grain lists later.

The first option is simpler. The second option is better product polish.

## Saving Apps

"Save as app" should mean the current draft appears under Apps and can create
future grains. It does not need to mean "signed public SPK" in the first
iteration.

Recommended semantics:

- Draft revisions are editable.
- Saved revisions are immutable.
- New grains use the latest saved revision.
- Existing grains keep the revision/package they were created with.
- Upgrading existing grains is an explicit future action.

This avoids surprising users by changing already-created grains when they edit
source.

Possible future actions:

- Export as SPK.
- Publish to an app market.
- Install for other users on the server.
- Promote revision to a signed package.
- Upgrade existing grains to a chosen revision.

## Apps List Integration

Saved isolate apps should appear in `/apps` for their owner.

Implementation options:

1. Convert saved isolate revisions into real package records and user actions.
2. Extend the app list query to merge owner-scoped isolate apps beside installed
   apps and dev packages.
3. Add a separate "Created apps" section.

For MVP, option 2 is probably the least invasive if carefully scoped by
publication. Long term, option 1 is cleaner because saved isolate apps behave
more like ordinary installed apps.

Avoid putting editor-created apps into global `devPackages` unless
`devPackages` first gains owner scoping and publication filtering. Current
development package behavior intentionally masks installed packages by app ID,
which is useful for local dev but risky for user-authored web apps.

## Server Methods

Suggested Meteor methods:

- `createIsolateApp(metadata)`
- `saveIsolateAppDraft(appId, metadata, sourceFiles, options)`
- `previewIsolateAppDraft(appId, metadata, sourceFiles, options)`
- `saveIsolateAppRevision(appId, revisionId)`
- `deleteIsolateApp(appId)`
- `listIsolateAppRevisions(appId)`

All methods must enforce:

- logged-in user;
- signed-up account or demo policy, matching app creation rules;
- ownership of the app;
- quota checks for generated package/source storage;
- source and generated package size limits;
- binding policy checks.

## Security Constraints

Primary risks:

- source leakage between users;
- arbitrary package/sidecar command execution;
- writing generated runtime files into app-controlled paths;
- broad network access from Worker code;
- unbounded CPU/memory/storage use;
- source payloads large enough to stress Mongo or the shell.

MVP restrictions:

- Owner-scoped publications only.
- No global `devPackages` source publication.
- Server-owned generated package directories.
- Single JavaScript module with strict size cap.
- No arbitrary sidecar commands.
- Only allow the existing workerd command shape.
- Enable only `SANDSTORM_API` and `STORAGE` bindings at first.
- Keep `PUBLIC_FETCH`, generic `service`, and broad Powerbox bindings disabled
  until there is an explicit admin/review policy.
- Retain isolate supervisor request/body size limits.
- Surface runtime errors through grain logs and editor error panels.

## Testing Plan

Fast tests:

- Manifest generation from a minimal source file.
- Rejection of invalid filenames, unsupported bindings, empty titles, oversized
  source, and malformed compatibility dates.
- Owner-scoped publication filtering.

Server integration tests:

- Create app draft.
- Preview app draft.
- Verify preview package has `Command.isolate`.
- Launch preview grain.
- Save revision.
- Launch a grain from saved app.
- Confirm another user cannot read source or launch unpublished drafts.

Browser/E2E tests:

- Apps page shows Create App.
- Create App opens editor.
- Preview opens a grain.
- Grain serves expected HTML.
- Storage binding persists across preview grain restart.
- Saved app appears in Apps.
- New grain from saved app opens normally.

Security/lifecycle tests:

- Generated package cannot request non-allowlisted sidecar argv.
- Unsupported bindings fail validation.
- Source edits do not mutate saved revisions.
- Existing grains remain pinned to their creation revision.

## Suggested MVP Milestone

1. Add `/apps/create` route and basic editor UI.
2. Add owner-scoped `isolateApps` and `isolateAppRevisions` collections.
3. Add server-side manifest/package generation for one `worker.js`.
4. Add `previewIsolateAppDraft()`.
5. Launch preview grains through existing `newGrain`/backend path.
6. Add `saveIsolateAppRevision()`.
7. Show saved isolate apps in `/apps` for the owner.
8. Add auth, generation, preview, and saved-app tests.

This milestone proves the user-facing authoring loop without solving package
export, collaboration, hot reload, multi-file editing, or admin publication.

## Open Questions

- Should editor-created apps become true package records immediately, or stay
  in a separate owner-scoped app collection until export/publish?
- Should preview grains be hidden from normal grain lists?
- Should demo users be allowed to create isolate drafts?
- How should source storage count against quota?
- Do saved app revisions need rollback UI in MVP?
- Should the first editor support only JavaScript, or also TypeScript with a
  server-side transpile step?
- How much app metadata is required before save?
- What is the policy boundary for enabling `PUBLIC_FETCH`?
- Should app authors be able to define multiple actions in the first version?

