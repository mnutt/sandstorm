# Review: isolate publisher/authoring feature

**Overall verdict:** The architecture is faithful to the plan and the core security invariant — preview and publish as separate authorities, with the publish grant bound to a server-resolved candidate at mint time — is implemented consistently and defensively at every layer I checked. The code quality is high and uniform. The real problems are not in the security design but in **lifecycle/cleanup**: the feature creates durable server-side artifacts (candidates, generated packages, hidden grains) and currently has no working path to ever reclaim them. There's also meaningful duplicated infrastructure that could be consolidated.

## Resolving the summary's open flags first

1. **`packageSalt` reset (summary flag #1) — non-issue.** `packageSalt` feeds only session-ID generation (`gateway-router.js:1105-1112`), not storage keys, and the pre-existing app-upgrade path does exactly the same reset on every package change (`db.js:3232`). Preview storage is untouched by the swap. This matches existing idiom.
2. **`generateAppId()` alphabet (flag #7) — correct.** The JS alphabet matches `BASE32_ENCODE_TABLE` in `src/sandstorm/id-to-text.c++:37` exactly, `encodeAppId` implements the same bit-packing as the C++ encoder, and the C++ side validates via `tryParseAppId` (`generated-isolate-package.c++:248-256`). Consistent end to end.
3. **`shutdownGrain` change (flag #5) — safe.** The change only *widens* acceptance (`backend.js:45-62`): legacy supervisors always disconnect, which is still handled; a clean return was previously impossible for them. Low regression risk.
4. **"Previewer can't publish" missing test (flag #4) — lower priority than the summary implies.** The previewer schema has no `publish()` method, and the frontendRef paths are structurally separated: `restore` for publisher goes through `requirePublishGrant` which requires `kind: "publish"` (`isolate-publisher-grants.js:185-189`), so a preview grant ID can't be laundered into a publisher. The test would be nice, but the boundary isn't just untested convention — it's typed.

The summary's flags #2 (publish confirmation UI missing compat date/bindings/warnings), #3 (`.appid` non-atomic install race), and #6 (bundled `GrainLog` fix) stand as written; I didn't re-litigate them.

## New findings

### 1. Candidate cleanup is dead code — unbounded, unreclaim­able server-side growth

`removeOwnedIsolateCandidate` (`isolate-candidates.js:146`) is exported and unit-tested but **has zero production callers** — no Meteor method, no capability method, no periodic job. Consequences:

- Every Preview click with changed source permanently stores a full normalized bundle (up to 16 MiB) in `isolateCandidates`, plus an installed package directory under `/var/sandstorm/apps`. Nothing ever flags superseded preview packages `shouldCleanup`, so the installer's collector (`installer.js:132`) never sees them.
- The plan explicitly requires reference-aware cleanup ("Cleanup may reclaim only artifacts proven to be unreferenced" — the *may reclaim* half is entirely missing).

Related, same theme:

- **No quota check before candidate persistence.** `previewIsolateBundle` calls `reserveIsolateCandidate` (which writes the full bundle to Mongo) *before* `requireEligibleAccount` runs (`isolate-preview-service.js:244-248`). The plan says "Check account quota before artifact creation." Any logged-in account — including one over quota or no-longer-eligible — can persist unlimited multi-MB candidate documents, and (per the finding above) they're never reclaimed. Also, nothing suggests candidate bytes count toward user storage quota at all.
- **The 16 MiB bundle limit collides with Mongo's 16 MB BSON document cap.** `maxTotalModuleBytes` = 16 MiB and the whole normalized bundle is embedded in one `isolateCandidates` document. A bundle near the limit will fail with a raw Mongo `BSONObjectTooLarge` error instead of a clean validation error. The plan anticipated this ("for streamed or larger bundles it may instead be a descriptor pointing to a server-owned immutable blob"). Either lower the JS-side limit well below 16 MB or store large bundles out of the document.

**Recommendation:** wire up cleanup (e.g., when a new candidate becomes the active preview for a scope, remove superseded unreferenced candidates in that scope and flag their packages), move the eligibility check ahead of reservation, and cap the in-document bundle size.

### 2. `publishLock` on `createdIsolateApps` has no staleness recovery — an abandoned publish can permanently wedge an app

`claimOperation` and `claimPreviewSlot` both allow stealing a lock older than 5 minutes. `claimCreatedApp` records `acquiredAt` but **never checks it** (`isolate-publisher-service.js:301-344`), and on failure `abandonOperation` releases only the operation lock, not the app's `publishLock` (`releaseCreatedApp` runs only on the published path).

Failure scenario: a publish to an existing app claims the `publishLock`, then fails (or the replica dies). Recovery requires retrying the *same* requestId — which the shell client only remembers while the draft input is unchanged, in localStorage. If the user edits metadata, clears localStorage, or switches devices, every future publish to that app fails `app-publish-in-progress` forever. Unlike a wedged candidate (user can edit source to mint a new one), the app identity cannot be recreated.

Same pattern, lower severity: `bindCandidate` permanently sets `publishingOperationId` with no release on abandonment — consistent with one-shot grant semantics on the Powerbox path, but on the shell path it means a candidate touched by a failed publish can never be published under a new requestId.

**Recommendation:** make `claimCreatedApp`'s steal condition mirror the operation lock (stale `acquiredAt`, ideally also verifying the owning operation isn't actively locked), or release the app lock in `abandonOperation`.

### 3. Orphaned hidden preview grains have no lifecycle

The preview grain is keyed by `operationScope`, and scopes are ephemeral: the shell scope embeds a random `authoringSessionId` stored in localStorage (`isolate-authoring-client.js:49`, `defaultDraft`), and the Powerbox scope is per-grant (`isolate-preview-grant:<grantId>`). Clearing localStorage, switching browsers/devices, or an app revoking and re-requesting its previewer grant (which the reference example explicitly does) each strand a hidden grain that:

- consumes real storage and counts against quota,
- is excluded from the grain list at the query level, so the user has no way to see or delete it,
- is never touched by any GC.

The plan says preview grains "remain reachable through the authoring UI" — that reachability is exactly what's lost when the scope key is lost. **Recommendation:** at minimum, delete the preview grain when its grant is revoked (`revokePreviewGrantIfUnreferenced`) and give the shell either a stable per-account session ID or a server-side listing of preview slots (the data is already published in `isolateAuthoringState`) with a delete affordance.

### 4. Minor

- `removeOwnedIsolateCandidate`'s reference checks are check-then-act; the final conditional remove re-verifies only revision/operation references, so a concurrently-minted grant or preview install can race it (`isolate-candidates.js:155-199`). Fails closed downstream (`candidate-mismatch`), so low priority — worth a comment when the function gains a caller.
- `previewIsolateBundle` runs `requireEligibleAccount` twice per call (once at `isolate-preview-service.js:248`, again inside `installCandidateInPreviewGrainLocked:166`). Harmless but redundant — drop the outer one.

## Complexity reduction (idiomatic concerns)

The per-file discipline is excellent, but the same infrastructure is hand-rolled in file after file. Consolidating would remove roughly 250–300 lines and, more importantly, make the concurrency story auditable in one place:

1. **Six identical error classes** (`IsolatePublisherError`, `IsolatePreviewError`, `IsolateCandidateError`, `IsolatePreviewGrantError`, `IsolatePublisherGrantError`, `GrainCreationError`), each with its own `fail()` helper. `runAuthoringMethod` then has to enumerate four of them for instanceof filtering (`isolate-authoring-server.js:133`). One shared `IsolateError` with a `code` field would serve every use site.
2. **Three in-process coalescing maps** with the identical `get → compare key → join promise → set → finally-delete` dance: `runningPublications` (`isolate-publisher-service.js:546-566`), `runningMaterializations` (`isolate-package-service.js:264-284`), `previewQueues` (`isolate-preview-service.js:228-237`). One `coalesce(map, key, inputKey, fn)` helper.
3. **Two parallel DB lease implementations** — claim/refresh/release/abandon with 5-minute staleness exist once for preview slots and once for publish operations, nearly line-for-line. A shared lease module would also have made the missing staleness check in `claimCreatedApp` (finding #2) impossible to miss.
4. **Small duplicates:** `requireIdentifier`/`normalizeActor` (candidates vs. publisher-service), `resultValue` (three copies), `ownKeys`/`requireOwnKeys` (previewer vs. publisher grants), and `publicResult` vs. `publicationSummary` (identical field lists in `isolate-publisher-capability.js:53` and `isolate-authoring-server.js:72`).
5. The preview path stacks **three** concurrency mechanisms (in-process queue → DB slot lease → candidate idempotent upsert). Each is individually justified (join semantics, cross-replica, retry identity), but nothing in the code says so — a short comment at `previewIsolateBundle` explaining which layer exists for which failure mode would save the next reader the archaeology I just did.

## What's genuinely good

- The one-shot grant consumption (`consumePublishGrant`: conditional update, re-read, compare `consumedRequestId`) is a correct atomic pattern, and consumption living in the DB record rather than the token makes save/restore-resistance structural.
- `IsolateBundleReceiver` is a model streaming validator: per-module and aggregate limits enforced *during* streaming, declared-vs-received accounting, no caller digest accepted anywhere.
- The publish state machine's crash-recovery paths (early return + lock release on already-published, `$setOnInsert` upserts with post-verification everywhere) are consistently correct; I probed several resume interleavings and found no double-install or cross-account hole.
- `grain-creation.js` is exactly the narrow helper the plan asked for — caller can't supply a command, and the initializing-flag recovery path is clean.

The top three findings (dead cleanup path + pre-quota persistence, `publishLock` wedge, orphaned preview grains) are all in the "operate this for six months and it hurts" category rather than security holes — I'd want #1 and #2 addressed before merge, #3 at least tracked.
