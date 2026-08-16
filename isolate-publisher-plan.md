# Isolate Preview and Publishing Plan

## Summary

Sandstorm should support lightweight isolate authoring through two deliberately
separate authorities:

- `IsolatePreviewer` may validate and run arbitrary isolate source in hidden
  preview grains.
- `IsolatePublisher` may promote one exact, previously validated candidate into
  an installed Sandstorm app revision.

Possession of a preview capability must not imply permission to install an app,
update an app, or create an ordinary reusable app action. Publishing is a
separate user decision, normally represented by a fresh, one-shot Powerbox
grant.

Both the built-in Sandstorm UI and an authoring app should use the same trusted
server-side implementation:

```text
/apps/create UI --------------------+
                                     +--> normalize/validate --> candidate artifact
App Studio or AI authoring grain ---+                              |
       |                                                            +--> preview grain
       |                                                            |
       +-- IsolatePreviewer capability -----------------------------+
                                                                    |
       +-- one-shot IsolatePublisher capability --> publish exact --+
                                                         candidate
                                                            |
                                                            +--> package revision
                                                            +--> user action
                                                            +--> normal future grains
```

The isolate runtime itself does not need a parallel grain model. A preview and
a published instance remain normal Sandstorm grains backed by
`Manifest.Command.isolate`. The current account-shared isolate host continues
to provide separate workers, storage roots, capabilities, limits, and logs.

This document supersedes any older plan that assumes a per-grain workerd
sidecar or treats `devPackages` as suitable browser-authored package storage.

## Goals

- Let a user quickly edit and run a small Worker-style JavaScript app from the
  Sandstorm UI.
- Let a Sandstorm app, such as an App Studio or AI coding tool, preview isolate
  code through a user-granted capability.
- Require a distinct authorization to publish a candidate as a reusable app.
- Guarantee that the published runtime code is exactly the normalized candidate
  that was previewed and reviewed.
- Represent published revisions as ordinary immutable Sandstorm packages so
  existing grain, sharing, backup, cleanup, quota, and app-list behavior can be
  reused.
- Keep existing grains pinned to the revision from which they were created.
- Make retries idempotent and make partial failures recoverable.
- Leave a clean path to richer multi-file projects, package export, signing,
  collaboration, and general Powerbox offer actions.

## Non-goals for the first release

- General npm dependency installation or server-side package-manager access.
- TypeScript transpilation in the shell.
- Arbitrary command lines, executables, or traditional Linux-process apps.
- Arbitrary workerd service bindings or ambient network access.
- Publishing to a public app market.
- Exporting a signed SPK.
- Automatically upgrading existing grains when a new revision is published.
- Collaborative source editing.
- Completing the general manifest capability-input action mechanism.
- Giving an authoring grain unlimited delegated authority to publish or create
  grains on behalf of an account.

## Product decisions

- Preview grains are hidden from the normal grain list. They remain reachable
  through the authoring UI and continue to participate in quota, cleanup, logs,
  and the normal grain lifecycle.
- Preview grains use the ordinary grain sleep and wake rules. Previewing does
  not imply a special keep-awake policy.
- A candidate does not require a stable draft app ID. A stable app ID is
  allocated when a candidate is first published as a new app. An implementation
  may use an internal preview identity if required by the package machinery,
  but that identity is not the published app identity or a user-visible
  promise.
- Publishing installs or updates the app action but does not create a first
  ordinary grain.
- Mutable source belongs to the authoring surface. Sandstorm's preview and
  publishing service stores only the immutable normalized candidate snapshot
  needed to preview, review, reproduce, and publish it.
- The candidate input protocol may stream a bundle rather than embedding every
  module in one Cap'n Proto message.
- Exact preview grant limits and any special preview feature restrictions are
  deferred until the corresponding implementation work makes the tradeoffs
  concrete.

## Core concepts

### Isolate bundle

An `IsolateBundle` is the portable, caller-supplied description of source code
and safe runtime configuration. It is not a Sandstorm package manifest. The
caller cannot supply commands, package paths, package IDs, or arbitrary
bindings.

The public protocol should permit streaming module contents so a multi-file
candidate does not have to fit in one Cap'n Proto message. One possible shape
is a bundle capability that reports metadata and streams modules into a
platform-provided receiver:

```capnp
interface IsolateBundle {
  getInfo @0 () -> (info :BundleInfo);
  transfer @1 (receiver :BundleReceiver);
}

struct BundleInfo {
  formatVersion @0 :UInt16;
  mainModule @1 :Text;
  compatibilityDate @2 :Text;
  compatibilityFlags @3 :List(Text);
  modules @4 :List(ModuleInfo);
}

interface BundleReceiver {
  beginModule @0 (info :ModuleInfo) -> (stream :Util.ByteStream);
  finish @1 () -> (digest :Data);
}
```

The exact streaming protocol can be chosen with the schema implementation. It
must authenticate module metadata, reject duplicate or undeclared modules,
apply per-module and aggregate size limits while streaming, require every
opened stream to finish, and calculate its own normalized digest rather than
trusting a caller-supplied digest.

The MVP UI may expose only one `worker.js` ES module even if the internal format
is designed for a small list of modules. This avoids baking a single-file
limitation into the capability protocol.

The factory supplies the documented Sandstorm runtime modules and the
`SANDSTORM_API`, `POWERBOX`, and `STORAGE` bindings. Caller-provided text and
JSON bindings can be added later, but they must be treated as non-secret
package data.

### Candidate

An `IsolateCandidate` is an immutable, system-minted reference to a normalized
bundle and its generated runtime artifact. It is the handoff between previewing
and publishing.

A candidate records:

- its owning account;
- the requesting/authoring grain, if any;
- the normalized bundle digest;
- the exact normalized source and configuration;
- validation results and warnings;
- the private package artifact used by preview;
- its creation time and reference/cleanup state;
- the preview grain identity and installation time as audit data;
- publication state, if promoted.

The capability does not allow its holder to edit the candidate. Editing source
creates another candidate.

Publishing accepts a live `IsolateCandidate` capability or a server-authenticated
candidate reference, not another copy of the source bundle. This prevents a
caller from previewing one revision and substituting different source during
publication.

### Published app and revision

A created app has a stable app ID and mutable metadata pointing to a current
published revision. Each revision is immutable and has its own package ID.

Publishing a revision does not mutate existing grains. New grains use the
current published package; existing grains retain their current package ID
until an explicit future upgrade operation changes it.

## Capability separation

### IsolatePreviewer

`IsolatePreviewer` is the lower-authority capability. It may be durable and
reused by a trusted authoring grain, subject to account, rate, storage, and
concurrency limits.

An illustrative interface is:

```capnp
interface IsolatePreviewer {
  preview @0 (
    requestId :Text,
    bundle :IsolateBundle,
    options :PreviewOptions
  ) -> (
    candidate :IsolateCandidate,
    view :Grain.UiView
  );
}
```

Preview authority permits:

- validating an isolate bundle;
- materializing a private preview package artifact;
- creating or updating a preview grain;
- returning a persistent `UiView` for the preview grain;
- returning the immutable candidate capability;
- reading structured validation and build diagnostics.

Preview authority does not permit:

- adding an app to the Apps list;
- creating a normal `UserAction`;
- updating an already-published app;
- exporting or publicly publishing a package;
- choosing an arbitrary app ID or package ID;
- changing another account's candidate or preview grain.

The grant should eventually encode bounds rather than relying only on global
policy. The exact limits and presentation are deferred. This does not remove
the need for basic defensive input bounds in the first implementation.

### IsolatePublisher

`IsolatePublisher` is the higher-authority capability. The normal grant is
one-shot and obtained through a fresh Powerbox interaction initiated by an
explicit Publish action.

An illustrative interface is:

```capnp
interface IsolatePublisher {
  publish @0 (
    requestId :Text,
    candidate :IsolateCandidate,
    target :PublishTarget,
    metadata :AppMetadata
  ) -> (
    result :PublishedRevision
  );
}

struct PublishTarget {
  union {
    newApp @0 :Void;
    existingApp @1 :Text;
  }
}
```

The actual grant should be attenuated before the call:

- a new-app grant may publish one candidate as one new app;
- an update grant names the one existing created app it may update;
- the grant identifies the owning account;
- the grant has a server-side consumption record;
- the grant may have a short expiration as an additional safeguard, with the
  exact lifetime deferred alongside the other grant-limit policy;
- the grant cannot be reset merely by saving and restoring its Powerbox token.

The publisher rechecks candidate ownership, package/source quotas, account
eligibility, and target-app ownership. It then promotes the exact candidate,
creates or updates the installed action, and records the published revision.

Publishing does not automatically upgrade existing grains and does not create a
first grain. After publication, the user creates grains through the app's
ordinary action.

### Candidate capability

`IsolateCandidate` should provide only immutable inspection and identity. It
need not expose raw package filesystem paths or package IDs to app code.

Potential methods are:

```capnp
interface IsolateCandidate {
  getInfo @0 () -> (info :CandidateInfo);
}
```

The server should authenticate the capability itself when publishing. Fields
returned by `getInfo()` are informational and must not be accepted back as
proof of candidate identity. The preview operation returns the `UiView`
separately because a reusable authoring session may later move that same hidden
preview grain to another candidate while preserving its storage. A candidate's
audit record proves what was installed at preview time; it does not promise
that the preview grain still runs that revision forever.

## Built-in UI flow

Add a route under Apps, initially `/apps/create`, with:

- title;
- noun phrase;
- short description;
- compatibility date;
- a `worker.js` editor;
- Preview;
- Publish as new app;
- Publish update, when editing an existing created app;
- validation diagnostics;
- runtime logs;
- Reset preview data.

The publishing service is not the mutable source repository. An external App
Studio keeps source in its own grain storage. If a built-in editor is provided,
its draft persistence must remain an editor concern, separate from candidates
and publication records. For the MVP this can be browser-local, or it can live
in a dedicated authoring grain. The factory receives a snapshot only when
Preview is invoked.

The built-in UI calls the same internal preview and publish services as the
capability implementations, but it does not need to round-trip through
Powerbox for its own trusted calls. It must nevertheless preserve the same
authorization separation in server code: the preview handler cannot call
publication internals without a distinct publish operation and ownership
check.

Suggested UI behavior:

1. Editing changes only the authoring surface's draft.
2. Preview snapshots the current draft into a new immutable candidate.
3. The app's existing preview grain is moved to the candidate package and
   restarted, preserving preview storage.
4. The UI opens the preview in a grain tab or embedded preview surface.
5. Reset preview data explicitly replaces the preview grain rather than
   silently clearing state on every code edit.
6. Publish displays the candidate digest, compatibility date, bindings,
   warnings, and target app before confirmation.
7. A successful publish returns to the app details page or offers the ordinary
   New Grain action.

Preview grains are hidden from the normal grain list. They are reachable from
the authoring UI and remain subject to normal quota accounting, logs, cleanup,
sleep, and wake behavior. They should still be visibly labeled as previews when
opened.

## Authoring-app Powerbox flow

An App Studio or AI authoring grain uses two different Powerbox requests.

### Preview grant flow

1. The authoring UI requests an `IsolatePreviewer` descriptor through the
   browser-first Powerbox API.
2. Sandstorm shows a built-in option identifying the account to which preview
   usage will be charged. Detailed limit presentation is deferred.
3. The authoring worker claims and saves the returned capability.
4. Repeated Preview actions call `preview()` through the saved capability.
5. The worker saves the returned candidate capability if the user may publish
   it later.
6. The returned preview `UiView` is offered to the current user; the existing
   shell `UiView` offer behavior opens it.

The preview capability should normally only be grantable by the owner of the
authoring grain. A shared user must not be able to cause grain-wide saved
authority to be charged to themselves or silently replace the owner's grant.

### Publish grant flow

1. The user selects a specific candidate and presses Publish.
2. The browser requests an `IsolatePublisher` descriptor identifying new-app
   or one specific existing-app intent.
3. The Powerbox card presents the candidate summary and target.
4. The worker immediately claims the one-shot publisher capability.
5. The worker invokes `publish()` with the live candidate capability.
6. The publisher consumes the grant atomically and records the idempotent
   result.
7. The authoring app displays the published app/revision result.

The requesting grain never receives ambient access to the Packages collection,
the backend, arbitrary grain creation, or another app's publishing authority.

## Server-side architecture

### Shared service layer

Implement preview and publication in server modules that do not depend on a
Meteor method invocation context. Both Meteor methods and Cap'n Proto
capability implementations should call these functions with an explicit actor:

```js
previewIsolateBundle({ accountId, requestingGrainId, grantId }, bundle, options)
publishIsolateCandidate({ accountId, requestingGrainId, grantId }, candidate, target, metadata)
```

This avoids having the Powerbox implementation call public client methods and
keeps authorization inputs explicit.

### Grain creation helper

Refactor grain creation into a server-internal helper that accepts a
server-resolved action or package revision. The generated-app path must not
accept a caller-supplied `Manifest.Command`.

For ordinary app launches, a longer-term cleanup can make the client send an
action ID and title, after which the server resolves the package and command.
The isolate authoring feature should use the safe internal form from its first
version.

### Generated package installation

Generated revisions should be ordinary packages rather than `devPackages` or
indefinite package-like Mongo records.

Add a narrowly typed backend operation for locally-generated isolate packages.
It should:

1. Accept the normalized manifest and bounded module data.
2. Independently require an isolate-only manifest.
3. Reject arbitrary argv, executable paths, filesystem paths, and unsupported
   binding variants.
4. Calculate a deterministic content digest/package ID.
5. Write to a new temporary directory under the package store.
6. Write the binary `sandstorm-manifest` and module files.
7. Atomically rename the directory into place.
8. Return the normalized package ID and manifest.

The operation should not invoke `spk dev-isolate`, FUSE, `mongosh`, or a package
manager. Code from `spk dev-isolate` remains useful as a reference for module
discovery, manifest construction, helper injection, and compatibility fields.

For the MVP, package generation may duplicate the small isolate runtime helper
modules in each artifact. Refactoring helpers into a platform-owned base layer
can be considered later if measured storage makes it worthwhile.

### App identity

A candidate does not need a stable draft app ID. Preview machinery may assign
an internal synthetic identity if the existing package layout requires one,
but that identity is temporary and has no user-visible stability guarantee.

Publishing a candidate as a new app allocates the stable random app ID.
Publishing an update uses the stable app ID of the specifically authorized
target. Each published revision gets a content-derived package ID. Because the
app ID is packaging metadata rather than worker source, publication may need to
materialize a final package from the normalized candidate snapshot. It must not
change modules, bindings, compatibility settings, or other runtime behavior
that the preview exercised.

SPK signing keys and export semantics are deferred. A future export feature may
generate or import a per-app signing key and create a conventional signed SPK
from a published revision.

## Persistence model

Suggested collections follow. Names are provisional.

### `createdIsolateApps`

- `_id`
- `ownerId`
- `appId`
- `title`
- `nounPhrase`
- `shortDescription`
- `publishedRevisionId`, optional
- `createdAt`
- `updatedAt`
- `deletedAt`, optional

This collection represents published app identity and metadata, not editable
source. The authoring application remains the mutable source of truth.

### `isolateCandidates`

- `_id`
- `ownerId`
- `requestingGrainId`, optional
- `operationScope` and `requestId`, for idempotent reservation
- `normalizedDigest`
- `normalizedBundle`
- `totalModuleBytes`
- `previewPackageId`
- `previewGrainId`
- `validationWarnings`
- `createdAt`
- `publishedRevisionId`, optional
- `status`: `preparing`, `ready`, `failed`, or `published`
- `error`, optional

Candidate source must not be included in broad publications. The capability and
owner-scoped editor publication expose only what each caller needs.

`normalizedBundle` is the immutable candidate snapshot, not a mutable project
workspace. For small MVP bundles it may live directly in owner-scoped storage;
for streamed or larger bundles it may instead be a descriptor pointing to a
server-owned immutable blob or generated package. In either case, the authoring
surface remains responsible for the editable project.

### `createdIsolateRevisions`

- `_id`
- `ownerId`
- `createdAppId`
- `appId`
- `candidateId`
- `normalizedDigest`
- `packageId`
- `compatibilityDate`
- `compatibilityFlags`
- `publishedAt`
- `supersedesRevisionId`, optional
- `metadataSnapshot`

Revision records are immutable after successful publication.

### `isolateFactoryGrants`

- `_id`
- `kind`: `preview` or `publish`
- `ownerId`
- `requestingGrainId`
- `targetCreatedAppId`, optional
- `bounds`, for preview grants
- `createdAt`
- `expiresAt`, optional
- `consumedAt`, for one-shot grants
- `consumedRequestId`, optional
- `result`, optional
- `revokedAt`, optional

The live capability object consults this record. Restoring a token must not
reset consumption or usage limits.

## Idempotency and failure handling

Preview and publish operations may succeed server-side immediately before the
RPC connection disconnects. Both operations therefore require a caller-chosen
`requestId` scoped to the factory grant.

For each operation:

1. Atomically create or find an operation record keyed by grant and request ID.
2. If complete, return the recorded candidate, grain, or revision.
3. If running, join or report the existing operation rather than starting a
   duplicate.
4. If failed safely, return the recorded error or allow an explicit retry state.

Publication should use a state machine rather than an assumed Mongo
transaction spanning backend filesystem work:

```text
authorized
  -> package-ready
  -> revision-recorded
  -> user-action-installed
  -> published
```

Each transition is idempotent. Cleanup may remove an unreferenced temporary
package after a failed attempt, but it must never delete a package referenced
by a preview grain, revision, user action, or ordinary grain.

The one-shot grant is considered consumed once its operation is durably
reserved, not only after the last step. A retry with the same request ID joins
the reserved operation; a different request ID is rejected.

## Validation and security invariants

### Bundle validation

- Enforce a supported format version.
- Enforce total bytes, module count, per-module bytes, and name-length limits.
- Require canonical relative module names with no empty, `.` or `..` segments.
- Reject duplicate module names and duplicate binding names.
- Require exactly one matching main module.
- Scan ES module imports and require each relative import to resolve inside the
  submitted bundle.
- Allow only documented platform imports.
- Validate JSON module contents before storing them as JSON modules.
- Validate compatibility dates and allow only supported compatibility flags.
- Initially reject CommonJS, Wasm, arbitrary Cap'n Proto compilation, and
  service bindings unless explicitly added to the policy.

### Derived manifest

- The platform, not the caller, constructs `Manifest.Command.isolate`.
- The platform injects runtime helper modules.
- The platform chooses the built-in bindings.
- No command argv, executable path, environment variable, package path, or
  service target comes from caller data.
- Preview and published manifests use the same normalized runtime code and
  compatibility settings.

### Authority and ownership

- Only a signed-up account allowed to create grains may receive either factory
  capability.
- A preview or publish grant records the account charged for its activity.
- A durable grain-wide preview capability should normally be granted only by
  the authoring grain's owner.
- A publisher update grant is attenuated to exactly one owned created app.
- Candidates cannot cross accounts merely because an opaque candidate ID is
  known.
- Generated private packages cannot be installed or launched by another
  account that happens to learn a package ID.
- All factory capabilities remain visible and revocable through the normal
  saved-capability mechanisms.

### Resource controls

- Check account quota before artifact creation, preview grain creation, and
  publication.
- Do not expire or trash a preview grain merely because it is inactive. It
  follows the ordinary grain sleep, wake, trash, and deletion lifecycle.
- Keep candidate artifacts while referenced by a candidate capability, preview
  grain, publication operation, or revision. Cleanup may reclaim only artifacts
  proven to be unreferenced.
- Preserve the isolate runtime's existing CPU, memory, request, stream, and
  storage limits.
- Do not treat text/JSON package bindings as secret storage.
- New grains obtain external authority only through their own Powerbox flows;
  publishing does not transfer the authoring grain's saved capabilities.
- Apply conservative defensive bounds needed to protect parsing, storage, and
  admission paths. Defer the product policy for preview counts, rates, bundle
  sizes, grant duration, and how those limits are presented.

### Preview labeling and restrictions

Preview code is still untrusted code presented to a user. Preview grains should
have a clear title and top-bar indication and must be hidden from the normal
grain list. Otherwise they use regular grain sleep and wake rules.

No additional feature restrictions are selected by this plan. Sharing,
standalone publication, scheduled work, background work, and durable offers
should be discussed when their interaction with previews becomes relevant to
implementation. Any eventual restriction should be explicit and testable,
rather than an accidental consequence of preview packaging.

## Package, app-list, and backup behavior

Publishing should create an ordinary `UserAction` for the owner, allowing the
existing Apps page and new-grain path to work normally. Generated package
records need private ownership/visibility metadata, and `addUserActions()` must
enforce it.

Preview packages remain referenced by their preview grains and candidates.
Published packages are referenced by revisions, user actions, and grains. The
package collector must treat each of those as a reference.

Backups of published-app grains should restore using the owner's installed
action as today. Preview-grain backups do not need to be portable in the MVP;
the UI may disable backup or document that the associated unpublished app must
still exist. Publishing before backup makes the app identity and action
durable.

## Testing plan

### Unit tests

- Bundle normalization is deterministic.
- Equivalent input produces the same digest.
- Streamed and in-message representations of the same bundle normalize to the
  same digest.
- Incomplete streams, undeclared or duplicate modules, and bundles that exceed
  defensive streaming bounds are rejected without retaining a partial
  candidate.
- Invalid paths, duplicate names, missing imports, bad JSON, bad dates,
  unsupported flags, and oversized inputs are rejected.
- Generated manifests contain only the permitted isolate command and bindings.
- Candidate capability identity cannot be forged from `CandidateInfo`.
- Publisher refuses raw source in place of a candidate capability.

### Server integration tests

- Create a candidate and launch a preview grain.
- Update the preview grain to a second candidate while retaining preview data.
- Reset preview data.
- Publish a candidate as a new app.
- Confirm the installed user action launches a normal grain.
- Publish a later revision and confirm old grains remain on the old package.
- Publish an update only with a grant attenuated to the target app.
- Reject cross-user reads, previews, publication, action installation, and
  package launch.
- Remove an unreferenced candidate without deleting a still-referenced preview
  or published package.
- Confirm the created-app record contains publication metadata but no mutable
  authoring project or draft.
- Restore a published grain backup.

### Capability and retry tests

- Save and restore a previewer grant without resetting its bounds.
- Save and restore a consumed publisher token and confirm it remains consumed.
- Retry preview after a simulated disconnect and receive the same candidate and
  preview grain.
- Retry publication after each state transition and receive one revision and
  one user action.
- Reject a second publisher request ID on a consumed one-shot grant.
- Revoke a grant and confirm later calls fail.
- Confirm a shared non-owner cannot install a grain-wide previewer grant.

### Browser tests

- Create UI: edit, preview, view result, inspect logs, reset data, and publish.
- Confirm preview grains are absent from the normal grain list but remain
  reachable from the authoring surface.
- Confirm a preview grain follows ordinary sleep and wake behavior.
- Saved app appears in Apps and starts a new grain.
- Confirm publishing alone does not create a grain.
- An App Studio requests a previewer through Powerbox and previews code.
- The same App Studio cannot publish with the previewer capability.
- A separate publisher Powerbox flow publishes the selected candidate.
- The Powerbox review shows new-app versus update intent and the correct target.
- Offering the returned preview `UiView` opens the preview grain.

### Release validation

- Run focused Meteor/server tests for package installation, app actions, and
  authorization.
- Run the isolate browser tests.
- Run `make isolate-ci` before merging changes to the public isolate schemas or
  helper surface.
- Add Cap'n Proto ABI fixtures for the new public capability schemas.

## Implementation milestones

### Milestone 1: Normalized candidates and local preview

- Define the internal `IsolateBundle` and candidate representation.
- Implement validation and deterministic digesting.
- Add generated isolate package installation to the backend.
- Add the owner-scoped immutable candidate collection. Keep mutable draft
  persistence outside the factory service.
- Add safe server-internal grain creation.
- Launch one preview grain from one `worker.js` file.
- Hide preview grains from the normal grain list while preserving ordinary
  grain sleep, wake, trash, and deletion behavior.
- Add reference-aware candidate and package cleanup.

This milestone has no app publishing and no Powerbox capability.

### Milestone 2: Built-in publishing

- Add created-app and immutable revision records.
- Add the internal publisher state machine.
- Install owner-scoped ordinary user actions.
- Add Publish as new app and Publish update UI.
- Ensure existing grains remain pinned.
- Add ownership, retry, package cleanup, and backup tests.

The server-internal preview and publisher authorities are separate even though
both are reached from the trusted shell UI.

### Milestone 3: Previewer Powerbox capability

- Define the public `IsolatePreviewer` and `IsolateCandidate` schemas.
- Register a frontend-ref Powerbox provider and card.
- Store preview grant ownership, accounting, revocation, and idempotency state;
  leave quantitative product limits configurable until policy is selected.
- Implement save, restore, revoke, and idempotent preview calls.
- Add a minimal App Studio example and end-to-end browser test.

### Milestone 4: Publisher Powerbox capability

- Define the public `IsolatePublisher` schema.
- Add new-app and existing-app-specific Powerbox requests.
- Implement one-shot persistent grant consumption.
- Accept the candidate capability directly across Cap'n Proto.
- Add review UI, revocation, retry, and cross-user tests.

### Milestone 5: Product expansion

- Multi-file editor and static assets.
- TypeScript as an app-local or trusted build-service step.
- Typed `capnp:` schema authoring.
- Revision history and rollback UI.
- Explicit upgrade of selected existing grains.
- Signed SPK export and optional market publication.
- General Powerbox offer actions, allowing an authoring app to offer an
  `IsolateCandidate` to the current human rather than requesting delegated
  publishing authority.

## Deferred decisions

The following choices should be made when implementation makes their costs and
security consequences concrete:

- Whether previews need restrictions beyond being clearly labeled and hidden
  from the normal grain list, particularly for sharing, scheduled/background
  work, and durable Powerbox offers.
- Quantitative policy for preview grant duration, counts, rates, concurrency,
  bundle sizes, and how those limits are presented to users. Defensive parser,
  storage, quota, and admission bounds are still required from the beginning.
- Whether private generated-package ownership belongs directly on `Packages`,
  or in a separate grants/visibility collection consulted by action
  installation and grain creation.

These deferred choices do not change the primary security boundary: previewing
arbitrary isolate code and publishing an installed app are separate
capabilities, and publishing operates on the exact immutable candidate that was
previewed.
