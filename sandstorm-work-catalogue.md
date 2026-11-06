# Sandstorm work catalogue

As of October 5, 2026, your Sandstorm work combines platform maintenance with a larger effort to make small, independently permissioned apps compose into useful systems. The clearest examples are mail processing, shared LLM access, and apps that create other apps. The isolate runtime supplies the execution model; Powerbox supplies the connections and authority; the applications exercise both.

This catalogue covers all **154 branch refs** present locally in the Sandstorm repository: **44 local branches, 58 `mnutt` remote-tracking branches, 30 `origin` branches, and 22 `ryansinger` branches**, excluding symbolic HEADs. It also covers all **22 immediate project directories** under `/home/michael/p/personal`, including uncommitted projects. Remote refs are the locally recorded snapshot, not a freshly fetched view. “Implemented” describes source present; it does not mean released, deployed, or freshly tested. Historical benchmark results are identified separately.

The [complete branch inventory](sandstorm-branch-inventory.md) records every ref, tip, attribution, and exact ancestry status. Branches that share or inherit work are grouped below rather than counted as separate features. In particular, a branch name is not evidence that its named feature exists.

## The main development lines

The current checkout, `app-creation-powerbox` at `03e28f425`, sits on a large modernization stack. These arrows represent verified Git ancestry:

```text
meteor-3-rebased
  → meteor-3.4-continuation
  → meteor-3.4-continuation-visual
  → ui-touchup
  → cmake
  → warnings-cleanup
  → meteor-3.5
  → isolates-rebased
  → app-creation-powerbox
```

An earlier isolate line runs through `workerd`, the `mnutt-all` integration work, `mnutt/full-isolates-capabilities`, and `isolates-v2`. The relationship between `isolates-v2` and `isolates-rebased` is a rebase and integration lineage, not direct tip ancestry. Outbound HTTP work was carried into the newer stack under new commit IDs. Several other experiments—Raw UDP, desktop mode, passkeys, the shell's capnp-es migration, and update signature replacement—remain separate lines.

There are local commits beyond the corresponding `mnutt` refs: one each on `app-creation-powerbox`, `cmake`, `mnutt-all`, and `meteor-3-no-globalthis`, and twelve on `workerd`. These are differences from the recorded remote refs, not a claim about the live server.

## Isolate runtime and native capabilities

**Branches:** `workerd`, `mnutt-all`, `mnutt/full-isolates-capabilities`, `isolates-v2`, `isolates-rebased`, then `app-creation-powerbox`.

You have built a Worker-style JavaScript runtime in which an isolate remains a normal Sandstorm grain: it has sessions, permissions, durable storage, Powerbox connections, saved capabilities, logs, and lifecycle management. `spk dev-isolate` makes a JavaScript module into a development app without a conventional app VM. TypeScript apps compile to JavaScript first; schema imports generate typed bindings.

The architecture has moved substantially beyond the original sidecar prototype. The current documented topology uses **one native workerd host per account**, sharing a process across that account's active workers while retaining per-grain authority, storage roots, limits, and logs. Supervisor-to-host transport is binary Cap'n Proto. Admission limits, idle eviction, host recovery, sandboxing, and grain-specific service bindings are part of the implementation.

The capability work is a major feature in its own right: schema-first `capnp:` imports, generated JS and TypeScript clients, browser capability handoffs, Powerbox claiming and fulfillment, durable exports, save/restore, streaming ByteStream adapters, and native cross-grain RPC. ABI baselines and schema corpus/type tests protect the app contract. The older private JavaScript object RPC and local claimed-capability-ID scheme are explicitly retired in the current documentation.

The [recorded memory benchmark](docs/isolates-memory-benchmark.md) measured a fitted **1.18 MiB PSS per additional shared worker**, versus **8.11 MiB** for one host process per worker; at 32 workers the reported totals were **70.0 versus 277.1 MiB**. These are results from the documented benchmark workload, not a general app memory guarantee. A separate isolate-to-isolate RPC benchmark measures native call latency and data transfer. The colocated RPC optimization was investigated and deferred; it should not be described as a fully shipped bypass of the authority machinery.

The latest API separates small durable values (`api.kv()`) from streaming files (`api.files()`). Isolate backup/export support and a browser Cap'n Proto RPC fix are among the newest commits. Source: [runtime guide](docs/developing/isolate-grains.md), [API implementation](src/sandstorm/isolate/api.js), [API declarations](src/sandstorm/isolate/api.d.ts), and [isolate browser tests](tests/apps/isolate.js).

## Creating and publishing apps from inside Sandstorm

**Branch:** `app-creation-powerbox`, with **50 commits beyond `isolates-rebased`** in this snapshot.

This work lets an app, or the shell's authoring UI, submit a source bundle, preview it as a hidden grain, and publish a reviewed revision as an installed app. The implementation includes immutable candidates, normalized source digests, generated packages, preview storage and reset, a preview/log drawer, syntax feedback, multi-file modules, binary/WASM module support, bounded streaming transfer, cleanup, quotas, and recovery of interrupted operations.

The central design is the separation of two authorities:

- **`IsolatePreviewer`** permits previewing submitted source and can be retained by an authoring app.
- **`IsolatePublisher`** is a separate grant bound to a reviewed candidate digest and publication target. It does not accept a replacement source bundle at publication time.

Publishing creates an app/revision and its normal launch action; it does not implicitly create the first ordinary grain. Later commits add publication lease binding, negative authority tests, concurrent installation handling, orphan reclamation, and fuller confirmation details. The older untracked `isolate-publisher-summary.md` covers an earlier 18-commit slice, so its checklist is historical rather than a current list of defects.

Two personal apps exercise this platform:

| App | Implemented work | Current boundary |
| --- | --- | --- |
| [Isolate Builder](/home/michael/p/personal/isolate-builder/README.md) | Svelte 5 and CodeMirror editor; one project per grain; module tree; create/rename/delete; optimistic revisions; immutable content chunks; saved preview grant; streamed `IsolateBundle`; pinned candidate and preview drawer. | Git repository has no commits. Text authoring only in the editor; binary upload UI and in-project TypeScript/npm builds are deferred. It still calls the removed `api.storage()` API. |
| [Isolate Agent Builder](/home/michael/p/personal/isolate-llm-builder/README.md) | Adds a separately granted typed `LlmGateway`; model sees a project snapshot and can write a text module, delete a module, or update settings; every tool action validates revisions; user can inspect/edit before preview. | No Git repository in this directory. Ten-turn bounded agent loop and snapshot limits are implemented. It also still calls `api.storage()`. The implemented personal-app workflow centers on preview; platform publication support does not imply a finished publish UI in these builders. |

The broader direction is clear: users can authorize an agent to create and test an app while retaining a separate decision about installing a particular revision. Source: [authoring schema](src/sandstorm/isolate-authoring.capnp), [publisher service](shell/imports/server/isolate-publisher-service.js), [authoring tests](tests/apps/isolate-authoring.js).

## Outbound HTTP and LLM capabilities

**Platform branch:** `outbound-http-session`; rebased implementations are present in the current isolate stack. The branch named `outgoing-http` is merely the same tip as `meteor-3-rebased` and contains no distinct outbound-HTTP feature delta.

`OutboundHttpSession` gives an app HTTP authority restricted to an approved base URL and methods. It supports provider authentication headers, streamed responses and, in the current schema, streaming requests. The work includes Powerbox UI, grant persistence and revocation, admin visibility, proxy configuration, relative-URL validation, and method attenuation. Network authority and provider credentials remain separate. Source: [schema](src/sandstorm/outbound-http-session.capnp), [regression tests](tests/tests/outbound-http-session.js).

There are **two distinct LLM gateway contracts**, and their consumers are not automatically interchangeable:

| Project | Role and features | Relationship |
| --- | --- | --- |
| [llm-proxy](/home/michael/p/personal/llm-proxy/src/main.rs) | Rust/Axum grain holding provider configuration, credentials, scoped egress authority, model allowlist/default, test chat, and request statistics. Exports an HTTP conversation API, including Responses. Operator and client permissions are separate. | Provider for `llm-example`, `pi-web`, Blender Maker, and the updated mail classifier. The latest committed change supplies a default model when a consumer omits it. Working changes add pricing/cost estimates, Responses handling, UI updates, and tests. |
| [llm-proxy-isolate](/home/michael/p/personal/llm-proxy-isolate/README.md) | Isolate-native typed `LlmGateway`: model discovery, unary and callback-streamed generation, multimodal content, tools, structured output, and usage. Separate session-bound `GatewayAdmin` capability. Uses `api.kv()`. | Gateway for Isolate Agent Builder. Its public contract is native RPC, not the HTTP conversation API. Git has no commits; a local SPK exists; README identifies app version 1 as unpublished. |
| [llm-example](/home/michael/p/personal/llm-example/src/server.js) | Small Node chat app that requests the conversation capability, saves it, and sends requests through the Sandstorm HTTP bridge proxy. | Demonstrates an app using LLM authority without owning provider credentials. Committed prototype. |
| [pi-web](/home/michael/p/personal/pi-web/server.js) | Browser terminal for the Pi coding agent, with xterm.js, WebSockets, persisted provider connection, and a local API adapter forwarding through the claimed capability. | Extends the same shared gateway pattern to a coding agent. Committed prototype. |
| [Blender Maker](/home/michael/p/personal/blender-maker/README.md) | React/assistant-ui chat, Pi agent, persistent Blender scene, tool execution, preview renders, GLB viewer and downloads. Supports image references and render/reference overlays, camera-aware rendering, transcript recovery, cancellation, and atomic scene replacement on successful edits. | Conventional packaged grain consuming streamed Responses from `llm-proxy`; a local loopback adapter connects Pi to the bridge. Repository has no commits. Packaging files and extensive tests exist; market metadata and distribution license remain unfinished. |

Blender Maker is a particularly substantial application: it combines delegated model access with a native toolchain, persistent files, editor/viewer roles, and visual feedback. It uses CPU Blender processes within the grain and preserves the previous scene after failed edits. Its tests cover permissions, streaming, recovery, and real Blender operations; this catalogue did not execute them or conduct a live-provider session.

## Mail as a system of cooperating apps

**Platform work:** `email-agent` adds managed email support beyond `HackSession`, with driver, persistence, Powerbox, and account-test changes. It is a separate platform branch; do not assume that exact feature is included simply because the current isolate stack includes outbound HTTP.

| Project | Implemented work | State and dependencies |
| --- | --- | --- |
| [mail-bridge](/home/michael/p/personal/mail-bridge/src/capnp/mail-feed.capnp) | TypeScript mail ingestion and SQLite storage; MIME parsing; Maildir/mbox imports; durable subscriptions, filters, pending delivery and backfill; WebSocket UI updates; persistent receiver capabilities. Exports `MailFeed` and `MailStore`, including attachment blobs and message lookup. | Committed through June 17; multiple local SPKs. Uses capnp-es and Sandstorm email/capability integration. Subscription modes distinguish future mail from historical backfill. |
| [mail-search](/home/michael/p/personal/mail-search/docs/search-design.md) | Rust/Tantivy search over subject, addresses, message text, and optional attachment text; fuzzy search; persistent feed connection; backfill selection; optional Extractous support behind a feature flag. | Committed through June 17. Connects to the mail feed. The stated million-message scale is a design target, not a measured result established here. |
| [mail-agent](/home/michael/p/personal/mail-agent/README.md) | Five isolate apps: LLM provider, classifier, dummy email producer, message store/inbox, and mobile notifications. Shared protocol package; sender rules; deduplication; generated inbox messages; APNs/FCM egress ownership in the notification app. | Initial committed workspace plus current uncommitted changes. Classifier now targets `llm-proxy` using stateless, non-streaming Responses; the standalone LLM app retains the earlier custom RPC protocol. |

The intended composition is ingestion → subscription/classification → message inbox, with LLM and push authority supplied by separate grains. The dummy producer provides a controlled source for development. The real bridge/search implementation and the early isolate protocol experiments should not be treated as a demonstrated, fully interoperable end-to-end deployment.

The mail-agent work also drove platform changes: browser-first Powerbox acquisition, custom packed descriptors, AnyPointer encoding in dev manifests, and checks preventing useless cross-grain serialization of local capability handles. Those are recorded in [the app's platform notes](/home/michael/p/personal/mail-agent/docs/sandstorm-improvements.md). The notes' saved-token workaround describes the old bridge; the current platform has native capability transport.

**Current integration gap:** the mail-agent source still imports `RpcTarget`/`ClaimedCapability` and calls `api.storage()`. Both personal isolate builders likewise use `api.storage()`. The checked-out platform exposes `api.kv()`/`api.files()` and has retired the old object-RPC model. These apps need API migration before compatibility with this checkout can be assumed. The recent Responses update fixes an LLM connection path, not that broader runtime mismatch.

## Networking across Sandstorm servers

**Branch:** `raw-udp`. **App:** [Iroh Tunnel](/home/michael/p/personal/iroh-tunnel/ARCHITECTURE.md).

The platform adds socket-shaped UDP capabilities carrying source/destination endpoints, ECN and truncation metadata, receiver registration, and socket characteristics. It moves packet handling to C++, persists public port mappings, and supports waking on incoming traffic. That supplies metadata unavailable through the older reply-capability-oriented `UdpPort` interface.

Iroh Tunnel uses this to connect grains on different Sandstorm servers. Its Rust implementation bootstraps raw Sandstorm RPC, claims and persists network capabilities, binds Raw UDP through `IpInterface`, supplies an Iroh custom transport, runs Cap'n Proto RPC over a bidirectional Iroh stream, and manages locally saved and remotely imported capabilities. Code includes generic capability forwarding and local restoration of imported objects.

This is an implemented transport/capability prototype, with further durability, reconnect, and lifecycle work described in its architecture plans. Its README is stale: it says custom transport and RPC forwarding are not implemented, while `src/main.rs`, `src/app.rs`, and the architecture document contain those paths. The March commit history itself calls the end-to-end state “semi-working”; there was no new two-server verification in this review. Raw UDP is not present in the current checkout's `ip.capnp`, so the app requires that separate platform feature.

## Davros and document previews

[Davros](/home/michael/p/personal/davros/README.md) remains the substantial file-management app behind several older and newer platform experiments.

- **Frontend modernization:** Ember 4 → 6 work, modern build/dependency configuration, Sandstorm route synchronization, reduced bundling overhead, preview and UI fixes.
- **Correctness:** concurrent upload handling, move/delete/mkdir error propagation, path validation, atomic cache writes, thumbnail bounds, source stream cleanup, and safer public-ID helper invocation.
- **Packaging and CI:** spktool migration, Debian Trixie, Lima build fixes, PR/test/release SPK workflows, and smaller package file lists.
- **Preview evolution:** embedded LibreOffice gave way to a Powerbox-connected file previewer, then the current `frontend-doc-previews` branch switched to lightweight frontend OOXML rendering (`7ae1475`). Earlier Powerbox preview branches remain historical experiments, not the current Davros default.

Two related directories capture that exploration:

| Project | Implementation | State |
| --- | --- | --- |
| [file-previewer](/home/michael/p/personal/file-previewer/app.js) | Packaged Node/Express service converting Word, PowerPoint, and Excel files to PDF through LibreOffice/unoserver, with upload limits, profile initialization, and conversion tuning. | Committed app plus local app/packaging changes and spktool configuration. |
| [document-previewer](/home/michael/p/personal/document-previewer/src/server.js) | OOXML/legacy-format preview experiment using Extend React components, WASM parser workers, and Cap'n Proto-encoded viewer data. | Git repository with no commits and no standalone `.sandstorm` package configuration. Related prototype, not a demonstrated installed Sandstorm app. |

The platform's `allow-web-workers` and `coop-coep` branches explore browser-worker support and cross-origin isolation/stricter CSP. These are relevant enabling experiments for rich browser/WASM apps; a requirement for each current preview app was not established.

## Other personal Sandstorm apps

| Project | What you built | Platform relationship and status |
| --- | --- | --- |
| [Pocket Binder](/home/michael/p/personal/pokemon-deck/README.md), directory `pokemon-deck` | Python/SQLite collection and deck app: validated atomic CSV imports, exact printing resolution, unresolved cards, locally cached faces, quantity-aware reservations across decks, exports, guided evolution lines, attack-cost-based suggestions, draft mode, and sample-hand/probability tools. | Requests separate outbound HTTP grants for TCGdex data and images and retains tokens server-side. Demonstrates scoped external data access with a same-grain browser UI. Local SPK exists; repository has no commits. Guidance does not claim tournament legality. |
| [MSI Workshop](/home/michael/p/personal/wix-builder/README.md), directory `wix-builder` | Turns a ZIP of prebuilt Windows application files into an MSI with Linux `wixl`; supports x86/x64, nested payloads, embedded cabinets, major upgrades, retained build outputs/logs, source ZIPs, validation, and builder/viewer roles. | Conventional offline Sandstorm grain using spktool and the HTTP bridge. No Git repository here. It packages binaries rather than compiling them; signing, custom actions, services, shortcuts, and arbitrary WiX project import are outside its current scope. Windows install/upgrade behavior still needs Windows validation. |

Three other directories were inspected and excluded from the Sandstorm-app count: `libvmod-lambda` is a Varnish-to-AWS-Lambda module; `3d-walkthrough` is a Matterport/local-viewer experiment; `39-vestry` contains scene, rendering, and lighting assets/scripts. They may provide personal context for Blender work, but no Sandstorm packaging or direct feature dependency was established for them.

## Packaging and JavaScript RPC infrastructure

[spktool](/home/michael/p/personal/spktool/README.md) is a Go rearchitecture of vagrant-spk/lima-spk. It separates VM providers from project/package/grain/key services, uses typed workflows and a structured command runner, keeps project configuration in `.sandstorm/box.toml`, and generates provider artifacts. It supports Lima/Vagrant conventions, lifecycle commands, packaging, utilities, and installation of Sandstorm app-author instructions for coding agents.

The current `normalize-commands` branch makes `vm up`, `vm start`, and `vm provision` explicit, building on timezone-inference and defensive provisioning changes. Uncommitted work includes an isolate-authoring reference and service tests. This tool is the common development substrate for Davros, the mail/LLM apps, Iroh Tunnel, and the newer conventional apps.

The Sandstorm-only `mnutt/app-harness` branch is another development experiment: `spk app serve` mounts a package source through FUSE, starts a supervisor, creates a local development WebSession, and serves it through an HTTP bridge. It is a standalone app harness, distinct from `spktool` and `spk dev-isolate`.

Two personal RPC repositories support the broader work:

- **[capnp-es](/home/michael/p/personal/capnp-es/README.md):** RPC-level branches, C++ interoperability tests, persistence and Powerbox flows, Node transport/error support, Sandstorm compatibility adapters, compiler coverage, and profiling/performance work. The current `sandstorm-compat-dist` branch includes distribution output for Git-based consumption. Its untracked `sandstorm-delta.md` is a design inventory; some listed items already have implementation commits and should not all be called outstanding.
- **[capnp-ts](/home/michael/p/personal/capnp-ts/README.md):** an older TypeScript Cap'n Proto codebase with February dependency, lint, and compiler-presence fixes. Relevant library maintenance, but not the current native isolate binding path.

The Sandstorm branch named `capnp-es` separately attempts to replace the shell's node-capnp integration, with compatibility wiring, benchmarks, and optimizations. It is important to distinguish that shell migration experiment from the newer isolate runtime's use of capnp-es-generated bindings.

## Platform modernization and operational maintenance

| Workstream | Branches | Concrete work and state |
| --- | --- | --- |
| MongoDB and Meteor 2 foundation | `mongo-upgrade-clean`; `mnutt/mongo-upgrade`, `mnutt/mn/mongo-upgrade-clean`, `mnutt/mongo-upgrade-fixes`; `meteor-2.16-upgrade-deps`, `meteor-2.16-upgrade-deps-rebased`; `default-mongo-7` | Meteor 2.16/Mongo driver compatibility, MongoDB 7 migration, integrity/permissions/readiness fixes, license updates, modern dependencies and ACME DNS forks, Mongo 7 default for new installs. Several final tips are ancestors of recorded `origin/dev`; older exploratory variants remain. |
| Async and Meteor 3 | `meteor-2-asyncify`, `meteor-3`, `meteor-3-rebased`, `meteor-3-no-globalthis`, `meteor-3.4-continuation`, `meteor-3.5` | Async database/call conversion, removal of synchronous/Fiber-era assumptions and global coupling, dependency and build updates, Meteor 3.4 continuation and 3.5.1 upgrade, regression coverage across sharing, transfers, accounts, and other shell behavior. The continuation includes substantial work by Harry Adel; it is not all solely authored by you. |
| Build system | `cmake` | Replaces ekam with CMake, including native/frontend builds, package generation, installer tests, CI, toolchain caching, and dependency tracking. Later rebased isolate work integrates the embedded runtime into this build. |
| CSS and UI structure | `ui-touchup` | Extensive decomposition of global Sass into owning components/features, palette/geometry/mixin APIs, explicit imports, scoped selectors, inventory and enforcement scripts, plus browser-selector fixes. This is a large maintainability refactor, beyond cosmetic touchups. |
| Visual and browser testing | `nightwatch-vrt-base`, `meteor-3.4-continuation-visual`, `mnutt/gha-tests`, `mnutt/fix-tests`, `flaky-trash-test` | Snapshot capture, sanitization, comparison reports and clickable differences, separate visual CI, Nightwatch/Chrome modernization, and flaky-test fixes. Recorded baseline images also exist untracked. |
| Warning and dependency cleanup | `warnings-cleanup` | C++ modernization (`readdir_r`, VLAs, parser API), hash-thread cleanup, test listener fixes, JS dependency refresh, integrity-checked archives, and targeted vendor-warning handling. The untracked warnings TODO predates several fixes. |
| Older host compatibility | `mnutt/bundle-mongo-openssl`, `mnutt/old-kernel-testing` | Bundle OpenSSL 1.1 needed by Mongo; old-Ubuntu container tests; then Lima-based old-kernel smoke tests and artifact-selection fixes. |
| Update signatures and release tooling | `replace-ed25519-with-gpg`, local `master` | Replace the updater's separate Ed25519 signature path with the existing GPG install-signature mechanism; latest key and non-expiring test-key fixes through October 3. `master` adds a manually triggered draft-release action. Neither should be conflated with an upstream release being published. |
| Installation and recovery | `apparmor-profile`, `mnutt/recover-sandcats`, `ci-apt-get` | Ubuntu 24.04 AppArmor profile installation, Sandcats certificate recovery, and reliable apt metadata updates in CI. Recovery is present in the master history even where dev ancestry differs. |
| Developer experience | `runtime-env-variable`, `dev-no-walkthrough` | `SERVER_RUNTIME` contract and dev-server setup/tour suppression. Both final tips are present in recorded `origin/dev` ancestry. |
| Authentication | `feat/passkey-auth`, `passkey-auth`, `saml-cert-fixes` | Ryan Singer's initial passkey implementation plus your happy-path fixes, credential uniqueness, name limits, login-contract and verification-policy changes. SAML work adds certificate validation, secure random IDs, and regression tests. |
| Demo flow | `fix/demo-login-launch-url-v2`, `mn/demo-login-launch-url-v2` | Same tip: Kunal Jaiswal's launch-URL/test fix plus your “Create account” label for demo users. |
| Desktop shell experiment | `os-interface` | WIP desktop mode with grain window state and controls, marketplace window behavior, shell styling, and test changes. Separate from the later CSS refactor and absent as a distinct integrated feature in the current stack. |
| Browser isolation | `allow-web-workers`, `coop-coep` | Worker CSP changes, service-worker loading restrictions, COOP/COEP headers, and stricter third-party-asset policy experiments. Separate branches. |

`ldap-fixes` and `surface-powerbox-app-providers` both point at `d00d4873d`, a Mongo readiness commit already in the dev line. `saml-fixes` points at an upstream merge, not the later certificate work. These names preserve intentions or bookmarks; they do not establish three additional implemented features.

## Earlier contributions and retained external branches

The older `mnutt` refs preserve your 2015–2016 WebDAV work: bridging DAV methods and headers, correct HEAD/OPTIONS handling, ETags/preconditions, MOVE/COPY destination and overwrite behavior, and compatibility with sync clients. Later `patch-3` extends ownCloud/Nextcloud client headers. This is the long-running platform side of Davros interoperability.

Other historical contributions include offer-template clipboard buttons and accessibility/docs, `$GRAIN_TITLE_SLUG`, decoding spaces in web-published URLs, and small offer-template/web-publishing documentation fixes. Exact old branches may not be ancestors of dev even when equivalent changes landed another way; the inventory deliberately distinguishes exact ancestry from feature inclusion.

The retained `origin` and `ryansinger` refs also cover upstream search, cron, range requests, inline Powerbox, app review docs, installer work, home-screen reorganization, build toolchains, and old experiments. Several `mnutt` refs likewise point primarily to other people's work (`applist`, `document-admin-stuff`, `fix-675-testjenkins`, `fix-disconnect-core-cap`, `windows-vagrant`). They are included in the inventory without attributing their features to you merely because the ref exists in your clone.

## Unfinished work and preservation state

The most consequential open seam is **app/platform API drift**: the mail-agent apps and both isolate builders lag the current runtime helper surface. The two LLM protocols also need to remain explicit in connection UX and documentation. Iroh's remaining work centers on durable peer/capability lifecycle, with its README requiring reconciliation against the code.

Five projects have initialized Git repositories but no commits: **Blender Maker, Pocket Binder, Isolate Builder, llm-proxy-isolate, and document-previewer**. **Isolate Agent Builder and MSI Workshop** have no Git repository in their project directories. This is substantial work that a branch-only catalogue would miss. Existing committed projects with relevant working changes include **llm-proxy, mail-agent, file-previewer, spktool**, and the untracked capnp-es design note.

The Sandstorm working tree contains earlier isolate plans/use-case sketches, mail-agent composition notes, publisher reviews, CSS/warnings plans, a test-app provenance catalogue, an isolate-worker prototype, a grain-launch helper, installer-test experiments, a Cap'n Web file, and visual baselines. These are useful design and development artifacts; old Cap'n Web/sidecar plans do not override the current native RPC architecture. The [test-app catalogue](test-app-catalogue.md) is a separate effort to trace test SPKs to source and preserve reproducibility, including unresolved historical app-ID matches.

The strongest through-line is that you are developing both sides of the platform at once: modernizing and maintaining Sandstorm itself, while building apps that test whether delegated authority, persistence, streaming, and app composition are practical. The resulting portfolio includes general infrastructure, developer tools, reusable service grains, and complete user-facing application prototypes.
