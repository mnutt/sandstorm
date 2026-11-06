# Isolate Publisher/Authoring Branch — Review Summary

Scope: `git diff isolates-rebased..HEAD` on `app-creation-powerbox` — **18 commits, 86 files changed, +11,494/-50 lines.** This is a single, tightly-scoped feature arc implementing `isolate-publisher-plan.md` (807 lines, committed as part of this same range). It builds on top of the much larger pre-existing isolates runtime (native workerd hosting, capnp RPC, account-shared hosts), which is *not* part of this diff and should be treated as already-reviewed infrastructure.

Commits, in order:
```
ae71f3a2c validate isolate candidate bundles
0ec4bf750 persist isolate candidates
595db4a83 generate isolate packages
a2731369b materialize isolate candidates
8257b58fa run hidden preview grains
bab560766 reset and clean preview artifacts
31f53d120 publish isolate revisions
59c445ad2 expose isolate authoring api
600b072e7 add isolate authoring ui
8163a8f18 add isolate authoring powerbox
1ff1bb9fa add isolate publisher capability
567147a69 separate isolate publisher grants
76c1290bb add inline isolate preview
f93cb0349 add authoring preview bridge
b9a16f159 add preview log drawer
8318390a2 refine authoring workspace
7f22338ce surface authoring syntax errors
7e259d062 add authoring syntax highlighting
```
The first 12 commits build the system bottom-up (bundle validation → candidates → packages → preview grains → publishing → capabilities → grants). The last 6 iterate the browser UI on top and are the least-settled part of the branch.

## Read this alongside

`isolate-publisher-plan.md` (repo root) is the design doc this branch implements. Its key invariant, restated because every layer below is checked against it:

> Possession of a preview capability must not imply permission to install an app... Publishing is a separate user decision... Sandstorm resolves its committed digest within the owning authoring grain and stores the matching server-side candidate ID in the grant. Publication never accepts another copy of the source bundle.

---

## 1. Architecture as implemented

```
IsolateBundle (validated, caller-supplied)
   │  normalizeIsolateBundle()            shell/imports/server/isolate-bundle.js
   ▼
IsolateCandidate (immutable, digest-identified)
   │  reserveIsolateCandidate()           shell/imports/server/isolate-candidates.js
   ▼
generated package (backend-materialized)
   │  materializeIsolateCandidate()       shell/imports/server/isolate-package-service.js
   │  buildGeneratedIsolatePackage()      src/sandstorm/generated-isolate-package.c++
   ▼
        ┌───────────────────────────┬───────────────────────────┐
        ▼ preview                                                ▼ publish
previewIsolateBundle()                                  publishIsolateCandidate()
shell/imports/server/isolate-preview-service.js          shell/imports/server/isolate-publisher-service.js
  → hidden preview grain                                   → createdIsolateApps / createdIsolateRevisions
                                                             → ordinary UserAction
```

Three callers share the same `previewIsolateBundle`/`publishIsolateCandidate` service functions, each supplying an explicit `actor {accountId, requestingGrainId, operationScope}` — never a Meteor method context, per the plan's "Shared service layer" requirement:

1. **Trusted shell UI** — `shell/imports/server/isolate-authoring-server.js`, Meteor methods `isolateAuthoringPreview`/`isolateAuthoringPublish`/`isolateAuthoringResetPreview`. Scope is account-bound (`shell-isolate-authoring:<accountId>:<sessionId>`) even though the session ID is caller-supplied, so a forged session ID can't reach another account's candidates.
2. **`IsolatePreviewer` Powerbox capability** — `shell/imports/server/isolate-previewer-capability.js` + `isolate-previewer-service.js`.
3. **`IsolatePublisher` Powerbox capability** — `shell/imports/server/isolate-publisher-capability.js` + `isolate-publisher-grants.js`.

### New Cap'n Proto schema (`src/sandstorm/isolate-authoring.capnp`, `isolate-authoring-impl.capnp`)

| Plan sketch | Actual schema | Note |
|---|---|---|
| `IsolateBundle.transfer(receiver)` → `BundleReceiver.beginModule(info)→stream`, `finish()→digest` | `beginModule(index:UInt16)→stream` (index into `BundleInfo.modules`), `finish()` returns **nothing** | Even stricter than the plan: no caller-supplied digest is accepted at all, anywhere. |
| `IsolatePreviewer.preview(requestId, bundle, options:PreviewOptions)` | `preview(requestId, bundle, metadata:PreviewMetadata{appTitle,nounPhrase,shortDescription})` | No bounds/options struct — matches plan's explicit deferral of exact limits. |
| `IsolatePublisher.publish(requestId)` | Matches exactly. `PowerboxTag{normalizedDigest, target, metadata}` lives in the *Powerbox descriptor tag*, i.e. baked in at grant-mint time, not passed to `publish()`. |
| `IsolateCandidate.getInfo()→CandidateInfo` | Matches. |
| — | `isolate-authoring-impl.capnp` adds `PersistentIsolatePreviewer`/`PersistentIsolateCandidate`/`PersistentIsolatePublisher` extending `SystemPersistent` for save/restore. |

`IsolatePreviewer`'s `PowerboxTag` is empty (grain-wide, owner-only grant, no attenuation fields yet).

---

## 2. Native layer: `generated-isolate-package.{h,c++}` (new, 422 lines)

Implements the plan's "Generated package installation" section: build a `spk::Manifest` for an isolate-only app and atomically install it under `/var/sandstorm/apps`, without `spk dev-isolate`, FUSE, or `mongosh`.

```c++
// generated-isolate-package.c++:290-316 (buildGeneratedIsolatePackage), abridged
validateMetadata(metadata);
auto order = validateSource(source);           // sorts modules, enforces limits
auto sourceHash = sourceDigest(source, order);  // order-independent SHA-256
auto appId = resolveAppId(requestedAppId, sourceHash);
// ... build spk::Manifest, call populateIsolateCommand() for action + continueCommand
auto packageId = packageIdFor(appId, manifestWords.asPtr(), sourceHash);
```

- **`validateSource` (:127-176)** enforces format version ==1, valid main-module name, valid compat date, **`compatibilityFlags.size()==0`** (none supported yet), **`bindings.size()==0`** (caller cannot supply *any* binding), module count ≤512, per-module ≤8MiB, aggregate ≤16MiB, canonical relative names, no duplicates, exactly one ES-module main.
- **`populateIsolateCommand` (:206-246)** hardcodes exactly 3 bindings — `SANDSTORM_API`, `POWERBOX`, `STORAGE` — never from caller data.
- Argv/executable-path are **structurally unreachable**, not just runtime-rejected: `command.initIsolate()` is the only union branch ever set; the `argv`/`executablePath` branches of `Manifest.Command` are never touched by this code path.
- `sourceDigest` (:190-204): domain-separated SHA-256 (`"sandstorm-generated-isolate-source-v1"`) over `mainModule`, `compatibilityDate`, and each module's `(name, type, content)` in name-sorted order. Confirmed order-independent by test.
- **`resolveAppId` (:248-257)**: when `requestedAppId` is empty (preview path), the app ID is *deterministically derived from the source digest* — this is documented in `backend.capnp:78-80` but reads differently from the plan's "internal preview identity if required... not the published app identity." Worth a quick cross-check that the JS caller always supplies a genuinely random `requestedAppId` on the publish path (it does, per `isolate-publisher-service.js`'s `generateAppId()`).

```c++
// generated-isolate-package.c++:318-368, abridged — atomic install
auto tempPath = kj::str(tempRoot, "/generated-isolate.", getpid(), ".", time(nullptr), ".", counter++);
mkdir(tempPath); write manifest + modules under tempPath;
// .appid marker written via O_CREAT|O_EXCL, OUTSIDE tempPath, BEFORE the rename below
rename(tempPath, finalPath);   // atomic within appRoot's filesystem
```

**Reviewer flag:** the `.appid` marker file and the package directory are installed in two separate non-atomic steps. A crash between them leaves an orphaned marker (retry recovers fine). Under genuine *concurrent* installs of the same `packageId`, the loser's `O_EXCL` open can fail with `EEXIST` before the winner has finished writing/flushing, so the loser's `verifyInstalledAppId` (read+compare) can transiently see an empty file and throw. Not a security issue (fails closed, retryable), but the idempotent-retry design in the plan implies concurrent duplicate installs are a real scenario worth a dedicated test.

`Backend.generateIsolatePackage @16` (`backend.capnp:76-84`, impl `backend.c++:723-745`) just forwards to `installGeneratedIsolatePackage` — no authorization logic here, relying on the existing trust boundary (Backend reachable only by the trusted Meteor process).

`generated-isolate-package-test.c++` (175 lines) covers: derived manifest shape, 3 hardcoded bindings, digest/appId/packageId stability under module reordering, atomic+idempotent double-install, requested-vs-derived appId distinction, rejection of caller-supplied service bindings and path-traversal names. **Not tested**: module-count/size-limit rejection, duplicate names, non-ES-module main, unsupported module types, malformed compat date/flags, metadata length limits, the concurrent-install race above, or the `Backend.generateIsolatePackage` RPC boundary itself.

### Adjacent runtime hardening bundled into this range

Not strictly part of the publisher plan but touches the same preview-restart flow ("the app's existing preview grain is moved to the candidate package and restarted, preserving preview storage"):
- `supervisor.capnp:47-52` — `Supervisor.shutdown()` may now return successfully instead of always disconnecting the process.
- `isolate-supervisor.c++:4576-4581` — shutdown now explicitly disconnects the hosted worker so in-flight HTTP clients see `DISCONNECTED` instead of hanging.
- `web-session-bridge.c++:140-165` — GET/HEAD requests retry once on `DISCONNECTED`, smoothing over the reconnect race right after a preview-grain restart.
- `isolate-supervisor.c++:4805-4933` (new `NativeLogRouter`) — parses JSON log lines from the shared native workerd host and routes them per-grain with 512KB rotation, feeding the new preview log drawer.

### `src/sandstorm/isolate/{api.js,api.d.ts,capnp-runtime.js}` (small diffs)

- `CAPNP_EXPORT_SYMBOL` marker + `sessionActionCapability()` throwing when a returned capability lacks it (`api.js:465-468`) — guards against isolate app code treating an arbitrary object as a live capability without going through export bookkeeping.
- `Capability#wrapDerived()` (`api.js:588-594`) — how authoring-app worker code turns the `IsolateCandidate` returned by `preview()` into something it can `.save()`/`.offer()`.
- `powerbox().appInterfaceDescriptor(InterfaceClass, tagValue)` (`api.js:1154-1183`) — lets authoring-app code construct the `IsolatePublisher.PowerboxTag{normalizedDigest, target, metadata}` client-side when requesting the one-shot publish grant.
- No runtime test found (in this diff slice) exercising the new `ValidationError` throw path or `wrapDerived` directly — only a packaging/toolchain-level test that the authoring example builds and its manifest contains the right bindings.

---

## 3. Server-side services (`shell/imports/server/isolate-*.js`)

### `isolate-bundle.js` (+`.tests.js`) — pure normalizer, no DB access
`normalizeIsolateBundle(input, options)` → `{bundle, canonicalText, digest, totalModuleBytes}`. Enforces the plan's full "Bundle validation" checklist: format version, size/count/name limits, canonical relative names, no duplicates, exactly one ES main, import scanning via `acorn`/`acorn-walk` (including dynamic `import()`, string-literal-only), platform-import allowlist (`sandstorm:api`), JSON canonicalization with depth limit, real-calendar-date compat-date check. Digest = `sha256("sandstorm-isolate-candidate-v1\0" + canonicalJSON)` over name-sorted modules — order/whitespace-independent, confirmed by test.

Minor note: `stableJson` doesn't special-case `__proto__`-shaped keys or non-finite numbers (silently becomes `null` via `JSON.stringify`) — low risk since input is already `JSON.parse`d, but worth a glance.

### `isolate-candidates.js` (+`.tests.js`)
`reserveIsolateCandidate()` is idempotent via `findOneAndUpdate` upsert on `{operationScope, requestId}`; a retry with the same requestId but different owner/digest throws `idempotency-conflict` rather than returning someone else's candidate. `findOwnedIsolateCandidate` scopes strictly by `ownerId` (cross-account → `null`, not error). `removeOwnedIsolateCandidate` refuses removal if referenced by a preview grain, revision, in-flight publish op, live grant, or saved frontendRef token, and marks the package `shouldCleanup: true` rather than deleting directly (isolate-candidates.js:150-191).

### `isolate-preview-service.js` (+`.tests.js`, the most heavily tested file in the set, 373 lines of tests)
Two-level concurrency guard: in-process promise chain per `(accountId, operationScope)` (`enqueuePreview`, :207-215) plus a DB-backed lease with 5-minute staleness timeout for cross-replica coordination (`claimPreviewSlot`, :63-92). First preview creates the grain (`createGrainFromResolvedAction`, phase `"new"`); moving to a new candidate calls `updatePreviewGrainPackage` (phase `"continue"`), preserving `identityId` while swapping `packageId`. `resetIsolatePreview` explicitly deletes+recreates the grain (new `identityId`).

**Flag for reviewer:** `updatePreviewGrainPackage` (in `grain-creation.js`) resets `packageSalt: Random.secret()` on *every* candidate swap within the same grain (grain-creation.js:172). If `packageSalt` feeds storage/encryption key derivation, "moving to a new candidate" could silently reset grain storage even though the plan says preview storage should persist across an in-place swap (only explicit `resetIsolatePreview` should clear it). Where `packageSalt` is actually consumed wasn't in scope of the files reviewed here — worth a direct check.

Strong retry-test coverage: simulated `startGrainInternal` failure cleans up and retries with the same requestId; stale cross-replica lock is recovered; fresh lock blocks a second concurrent call with `preview-in-progress`.

### `isolate-previewer-capability.js` + `isolate-previewer-service.js` (+`.tests.js`)
`createPreviewGrant` enforces owner-only minting: `grain.userId !== session.userId` → 403 (a shared non-owner user cannot mint a grant charged to the owner). `IsolateBundleReceiver`/`ModuleByteStream` implement the streaming protocol from scratch — tracks declared-vs-received bytes per module, enforces size consistency, requires every opened module to `done()`, enforces the aggregate limit **while streaming**, never accepts a caller digest. `requirePreviewGrant` re-validates on every call that the grant isn't revoked/expired and the requesting grain still exists/isn't trashed. `preview()` calls `requirePreviewGrant` twice — before and after the (potentially large) bundle transfer — closing a TOCTOU window at the cost of doing the streaming work before the second check can fail it (minor).

### `isolate-publisher-service.js` (+`.tests.js`) — the core state machine
Matches the plan's `authorized → package-ready → revision-recorded → user-action-installed → published` transitions directly (`runPublication`, :~390-470). Same two-level idempotency pattern as preview (in-process map + DB upsert keyed by `operationScope+requestId`), with an `inputKey` guard rejecting request-ID reuse with different intent. `bindCandidate` atomically claims a candidate for exactly one publish operation via a conditional `$or` update; `claimCreatedApp` does the analogous compare-and-set on `createdIsolateApps` for both `newApp` (upsert) and `existingApp` (update) targets, serializing concurrent revisions to the same app.

`generateAppId()` uses a private base32-ish alphabet (`0123456789acdefghjkmnpqrstuvwxyz`, no `b/i/l/o`) — worth confirming this matches whatever app-ID format `spk`/app-market tooling expects elsewhere; not cross-checked in this diff.

Tests directly cover the plan's key invariants: publish never creates a grain, concurrent identical calls coalesce, deterministic package-gen failure is retryable, resuming after action-install failure doesn't double-install, a later revision leaves existing grains pinned, generated package IDs can't bypass ownership, cross-account substitution is rejected.

### `isolate-publisher-capability.js` + `isolate-publisher-grants.js` (+`.tests.js`) — the plan's central invariant, implemented here
`createPublishGrant` requires `session.userId === request.accountId`, requires the requesting grain to be owned/active, resolves `requireGrantCandidate` (an existing `status:"ready"` candidate matching owner+grain+digest) **at grant-mint time**, and stores `candidateId`/`candidateDigest`/`target`/`metadata` on the grant row. The live `publish(requestId)` capability method's *only* caller-supplied input is the idempotency request ID — matching the plan's "publisher accepts neither raw source nor a caller-supplied candidate ID" exactly.

One-shot consumption: conditional update requiring `consumedAt` unset, then a second distinct requestId on an already-consumed grant is rejected while the *same* requestId replays the cached `grant.result`. Consumption state lives in the DB grant record, not the restorable token, so save/restore cannot reset it.

Test gap noted by the research fork: the underlying grant logic is unit-tested, but no test was found exercising "second distinct requestId rejected" through the actual Cap'n Proto `publish()` RPC surface (only through the grants module directly).

### `isolate-package-service.js`, `isolate-preview-presentation.js`, `isolate-authoring-server.js`, `grain-creation.js`, `package-references.js` — supporting pieces
- `isolate-package-service.js`: bridges candidates to backend packages; reuses the **existing** `packages` collection (`generatedIsolate: true` flag) rather than a parallel table, matching the plan's "ordinary packages, not devPackages" requirement; rejects package-ID collision with a differently-owned/appId'd package.
- `isolate-preview-presentation.js`: `resolveIsolatePreviewForAuthoring` re-derives grant validity live rather than trusting stored fields; test explicitly checks a stale digest whose preview grain has since moved correctly 404s.
- `isolate-authoring-server.js`: trusted-shell entry point; `makeShellIsolateActor` derives an account-bound operation scope even from a caller-supplied session ID (test: "derives an account-bound scope from a non-authoritative session namespace"). No visible rate/count limiting for shell-session preview calls — plan explicitly defers quantitative limits, but worth confirming a bound exists somewhere.
- `grain-creation.js`: `createGrainFromResolvedAction` — server resolves the package/command, caller cannot supply a raw `Manifest.Command`, matching the plan's "Grain creation helper" section verbatim.
- `package-references.js`: package-cleanup reference check now also covers `isolateCandidates.previewPackageId`, `createdIsolateRevisions.packageId`, `isolatePublishOperations.packageId` — matches the plan's package-collector requirement.

### `shell/imports/sandstorm-db/db.js`
Six new collections (`isolateCandidates`, `isolatePreviewSlots`, `createdIsolateApps`, `createdIsolateRevisions`, `isolatePublishOperations`, `isolateFactoryGrants`) matching the plan's persistence model closely; unique indexes enforce one candidate/op per `(operationScope, requestId)`, one preview grain per `(userId, isolatePreview.scope)`, etc. `addUserActions` gains an ownership gate so a leaked `packageId` for someone else's generated app can't be self-installed (db.js:1900-1918) — directly implements the plan's "generated private packages cannot be installed by another account" requirement. Account-deletion cleanup marks generated packages `shouldCleanup: true` without going through the same reference-check function used elsewhere — minor inconsistency flagged, not obviously a bug given per-account package generation.

### Cross-cutting infra touches
- `backend.js`: `shutdownGrain` now tolerates a **successful** return from `shutdown()`, not just "always disconnects." This is a shared code path used by *all* grain types, not just isolates — worth a regression check on non-isolate shutdown behavior.
- `permissions.js`: `createNewApiToken` rejects `forSharing` for any `isolatePreview` grain — closes the "share it around the normal sharing UI" bypass of "preview grains must be hidden."
- `grain-visibility.js`/`shell-server.js`: `grainsMenuSelector` excludes `isolatePreview` grains at the **query** level, not just client-side filtering.
- `grain-server.js`: `grainLog` pub/sub ID scheme changed from bare integer to `${grainId}:${id}` — needed so the new preview-log UI can subscribe to a grain that isn't the "current" one.

---

## 4. Client/UI layer (newest, least-settled — last 6 commits)

### `shell/imports/client/apps/isolate-authoring-client.js` (new, 504 lines) — `/apps/create` controller
- Draft persisted to `localStorage` per-account (:35-70). `snapshotKey()` (:88-95) hashes title/nounPhrase/description/compatDate/source and invalidates any cached preview the moment a field changes — implements "editing changes only the draft" without an explicit dirty flag.
- Preview handler (:379-410) calls `Meteor.callAsync("isolateAuthoringPreview", sessionId, requestId, bundle, metadata)`; `requestId` is cached on the draft keyed by an input hash so retrying the *same* draft reuses the same request ID — a direct client-side implementation of the plan's idempotent-retry design.
- `publish()` (:161-193) same memoization pattern; target is `{newApp: null}` or `{existingApp: createdAppId}` (:465-469).
- `highlightedSource()` (:239-246) pipes source through `sugar-high`'s `highlight()`, injected as raw HTML via triple-brace in the template — text is the user's own source rendered in their own browser (self-XSS territory at most, not cross-user), but worth confirming `sugar-high` escapes token content rather than assuming safety.

### `isolate-authoring.html` (161 lines)
Classic highlighted-textarea pattern: transparent `<textarea>` over a `<pre>{{{highlightedSource}}}</pre>`, scroll-synced. Publish modal shows digest and target (new app / version N) — but **not** compatibility date/flags, bindings, or validation warnings, which the plan's step 6 explicitly calls for ("displays the candidate digest, compatibility date, bindings, and warnings"). **This is the most consequential UI gap** since publishing is the higher-authority, harder-to-undo action.

### `isolate-preview-pane.js`, `isolate-preview-drawer.js`/`.html`, `isolate-preview-log.js`/`.html`
Shared `GrainView`-based embed used both inline (create page) and in a drawer (external authoring grain via `postMessage`). Log view uses `AnsiUp.ansi_to_html(...)` into `{{{logHtml}}}` — reuses an existing pattern already shipped elsewhere for grain logs, not new risk. Auto-scroll-to-bottom unless the user has scrolled up.

### `shell/imports/client/grain-client.js` (+64/-1) — the App Studio integration seam
`postMessage` handler for `showIsolatePreview` (:1739-1791) validates `rpcId` is a string, `normalizedDigest` matches `/^[0-9a-f]{64}$/`, and `senderGrain === activeGrain` (only the focused grain can request the drawer). Uses a monotonic generation counter to discard stale responses from superseded requests — real race-condition handling for rapid repeated preview requests. Calls `resolveIsolatePreviewForAuthoring` server-side, then opens the drawer.

**Note:** this file also contains a `GrainLog.find({grainId: this.params.grainId}, ...)` scoping fix (:2147-2153) for the standalone log-page route that looks like a **pre-existing bug fix unrelated to isolates** (previously the page showed all grains' log lines unscoped), bundled silently into this branch. Worth confirming with the author whether that's intentional scope or should be split out.

### `powerbox-builtins.html` (+16)
Adds `isolatePreviewerPowerboxCard` / `isolatePublisherPowerboxCard` templates. The publisher card states "This one-shot grant publishes only this reviewed candidate and target" and shows the candidate digest — good alignment with the plan's grant-review requirement.

### Mapping to plan's "Built-in UI flow" §1–7

| Step | Status |
|---|---|
| 1. Editing → draft only | ✅ |
| 2. Preview → new candidate | ✅ |
| 3. Preview grain moved/restarted, storage preserved | ✅ (server-side; see `packageSalt` flag above) |
| 4. Preview opened in tab/embedded surface | ✅ (inline pane + drawer) |
| 5. Reset preview data is explicit | ✅ |
| 6. Publish shows digest/compat/bindings/warnings/target before confirm | ⚠️ digest+target only; compat/bindings/warnings missing |
| 7. Post-publish returns to app / offers New Grain | ⚠️ only a success message; no navigation or "create a grain" CTA |

### Test coverage: `tests/apps/isolate-authoring.js` (built-in UI) + `tests/apps/isolate-examples.js` (Powerbox App Studio flow)

Both are solid end-to-end browser suites. Notable deliberate security assertions:
- `isolate-authoring.js:77-92` — injects a `console.log('<img id="isolate-log-injection-probe" ...>')` payload and asserts it never renders as a real DOM element in the log drawer, before or after rendering — real coverage of untrusted-log-as-HTML risk.
- `isolate-authoring.js:139-140` — after publish, asserts **no** grain appears in `/grain` — directly checks "publishing does not create a first grain."
- `isolate-examples.js:157-179` — confirms the grain ID never crosses into app JS; only the digest does, via the `postMessage` bridge.
- `isolate-examples.js:199-238` — confirms the Powerbox card text switches from "Publish a new app" to "Publish an update to ... Current app: ..." once `createdAppId` is known.

**Plan checklist items not found covered anywhere in this diff slice** (may exist in files outside the 86 changed here, but should be confirmed, not assumed):
- Preview grains are absent from the normal grain list *and* remain reachable from the authoring surface (browser-level assertion) — covered at the query/data level (`grain-visibility.js`) but not asserted in either browser test.
- Preview grain follows ordinary sleep/wake behavior — not exercised anywhere in this diff.
- "The same App Studio cannot publish with the previewer capability" — this is an explicit named checklist item in the plan; no test (browser or server-capability-level) was found attempting to call `publish()` with a previewer-only capability and asserting rejection.
- "Restore a published grain backup" — no backup-specific test found.

### `examples/isolate-authoring-powerbox/worker.js` + README (new, reference implementation)
Cleanly separates the two capabilities: previewer descriptor requested once and saved; publisher descriptor rebuilt fresh from the current candidate digest + target on every publish click, never saved. Revokes the previous previewer token when granting a new one. Streams its single module in two chunks specifically to exercise the multi-chunk `ByteStream` path. No conflation of preview/publish authority found — good example for reviewers to sanity-check the intended flow narrative against.

`src/sandstorm/test-app/isolate-api-powerbox/worker.js` (the automated test's app, distinct from the README example) reuses the pre-existing generic `TOKEN_KEY` storage key for the previewer token rather than a dedicated key — functionally fine (flows are mutually exclusive per test) but a naming inconsistency worth a comment if this file is meant as a reference beyond pure test scaffolding.

---

## 5. Summary of things worth a reviewer's direct attention

Roughly in priority order:

1. **`packageSalt` reset on every in-place candidate swap** (`grain-creation.js:172`, used by `isolate-preview-service.js`) — confirm this doesn't silently reset preview grain storage on every "move to next candidate," which would contradict the plan's storage-preservation requirement. Only `resetIsolatePreview` should clear storage.
2. **Publish confirmation UI omits compatibility date/flags/bindings/warnings** (`isolate-authoring.html:79-99`) — plan step 6 explicitly requires showing these before the user grants the higher-authority one-shot publish action.
3. **`.appid` marker and package directory install non-atomically** in `generated-isolate-package.c++:318-368` — orphaned-marker recovery is fine, but concurrent identical installs can transiently throw; add a targeted test given the plan's emphasis on idempotent retry.
4. **Missing negative test: previewer-only capability attempting `publish()`.** This is a named item in the plan's own testing checklist and appears absent from both the capability-level and browser-level test suites reviewed.
5. **`shutdownGrain` behavioral change in `backend.js`** now accepts a successful return from `shutdown()` — this is a shared path for all grain types, not just isolates; check for regressions outside the isolate code paths.
6. **`grain-client.js:2147-2153`** — an apparently unrelated `GrainLog` query-scoping bug fix bundled into this branch; confirm intentional/in-scope.
7. **`generateAppId()`'s custom base32 alphabet** (`isolate-publisher-service.js`) — confirm consistency with whatever app-ID format the rest of the codebase (`spk.c++`, app market/signing tooling) expects.
8. **No visible rate/count limiting** for shell-session preview calls in `isolate-authoring-server.js` — plan defers this explicitly, but worth confirming *some* defensive bound exists rather than none.

## 6. What's well covered / lower-risk

- The core security invariant of the whole plan — a publisher grant is bound to a specific digest at *mint* time, and `publish()` accepts no caller-supplied source or candidate ID — is implemented consistently at the schema level (capnp `PowerboxTag`), the grant-minting level (`isolate-publisher-grants.js`), and the capability level (`isolate-publisher-capability.js`), with unit tests at each layer.
- Idempotency/retry is implemented uniformly (in-process coalescing + DB-level upsert-by-`{operationScope,requestId}`) across candidates, preview, and publish, matching the plan's state-machine design, with good test coverage of crash/resume at multiple transition points.
- Cross-account isolation is checked and tested at nearly every layer: candidate lookup, grant minting, package installation/ownership, user-action installation, package cleanup.
- Argv/executable-path/service-binding injection from caller data is not just rejected but structurally unreachable in the C++ manifest-building code.
- The example app and both test suites correctly demonstrate the two-capability separation (preview vs. publish) with no conflation found.
