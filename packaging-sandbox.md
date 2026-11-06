# Packaging Sandbox and sps implementation plan

Build a Sandstorm app called **Packaging Sandbox** and a separate CLI called **`sps`**. A user creates one sandbox grain per development project on their actual Sandstorm server, grants it isolate preview authority, and connects a local CLI using a restricted API token. A local coding agent builds JavaScript, uploads immutable revisions, exercises the remotely running preview, and reads logs without installing Sandstorm or running a VM locally. Publishing requires a separate human decision about an exact candidate.

This is an implementation handoff, based on the Sandstorm checkout at `03e28f425` (`app-creation-powerbox`), inspected October 6, 2026. Proposed app APIs and CLI commands below do not exist yet.

## Product decisions

- Implement this as an independent app and CLI. Do not add commands to `spk`, modify `spktool`, or expose the local devmode socket over the network.
- Start with **isolate applications only**. Local compilation/bundling produces the modules uploaded to the remote sandbox. No arbitrary build commands execute on the remote server.
- One Packaging Sandbox grain is one project, with one active preview slot. Multiple CLI clients must coordinate updates; they do not get independent implicit slots.
- Use existing Sandstorm API tokens and Powerbox grants. OAuth, automatic account login, and server-wide credentials are unnecessary for the first version.
- Separate development permission from management and publication permission. The token supplied to an agent must not be able to grant itself more authority.
- Treat source, candidate output, logs, and generated HTML as untrusted. Candidate code executes in the preview grain, never in the Packaging Sandbox controller grain.
- The production server must already run the required isolate authoring feature. This cannot run on an unmodified upstream release lacking `IsolatePreviewer` and `IsolatePublisher`.

The desired everyday loop is:

```text
local source → local build → sps upload → sandbox grain → IsolatePreviewer
                                 ↑                            ↓
                            logs/status ← remotely running preview

reviewed candidate → human Powerbox approval → IsolatePublisher → installed app
```

## What userspace can and cannot promise

The first version is a **controlled development workspace using normal Sandstorm grain isolation**, not a new platform security domain.

The controller can restrict its own API, hold a preview grant, retain source revisions, mediate test sessions, and prevent its developer token from invoking publication. It can deliberately avoid passing its own capabilities to candidate code. It cannot enforce a server-wide namespace of capabilities, change account-level workerd hosting, prevent every independently granted production connection, or guarantee host resource isolation beyond platform limits.

Current previews support Powerbox. If a human opens the preview in the ordinary shell and grants it production data or network access, subsequent candidate updates may use those saved grants. Updating code while preserving preview storage is also continuing that authority. Clearly show this in the UI; never describe such a preview as side-effect-free.

For unattended testing, use a mediated test session with **no ambient production capabilities**. Unsupported Powerbox requests must fail explicitly. Later test fixtures can implement selected interfaces; they must not silently fall back to real networking or production services. Browser tests must use a dedicated browser profile without the user's Sandstorm/admin cookies.

Platform-enforced capability confinement, separate runtime hosts per sandbox, enforced external-service budgets, and safe unrestricted testing of privileged networking are later platform projects. Do not claim those properties for the app MVP.

## Existing mechanisms to reuse

Read these sources before implementation; inspect current source again if the platform revision changes:

| Source | Relevant contract |
| --- | --- |
| [isolate-authoring.capnp](src/sandstorm/isolate-authoring.capnp) | `IsolateBundle`, sequential module transfer, `IsolateCandidate`, `IsolatePreviewer.preview`, `watchPreviewLog`, digest-bound `IsolatePublisher`. |
| [Authoring example](examples/isolate-authoring-powerbox/worker.js) | Current native Cap'n Proto clients, exported bundles, candidate persistence, browser Powerbox, preview drawer, publishing and log streaming. |
| [Isolate app guide](docs/developing/isolate-grains.md) | Supported helper surface, runtime behavior, module formats and packaging. |
| [API declarations](src/sandstorm/isolate/api.d.ts) and [native capability declarations](src/sandstorm/isolate/capnp.d.ts) | `api.kv()`, `api.files()`, session permissions, save/restore and wrapping derived capabilities. |
| [Preview capability implementation](shell/imports/server/isolate-previewer-capability.js) | Returned persistent UiView and candidate, grant lookup and authority requirements. |
| [Preview grant service](shell/imports/server/isolate-previewer-service.js) | Owner-only grant creation; saved-reference and revocation behavior. |
| [Preview lifecycle](shell/imports/server/isolate-preview-service.js) | One slot per operation scope; updates, coordination, reset and cleanup internals. |
| [Bundle validation](shell/imports/server/isolate-bundle.js) | Admission limits and validation. Current limits include 512 modules, 8 MiB per module, 15 MiB aggregate, 256-byte names. |
| [Grain schema](src/sandstorm/grain.capnp), [WebSession schema](src/sandstorm/web-session.capnp) and [web bridge](src/sandstorm/web-session-bridge.c++) | Opening and translating a test WebSession, request/response streaming, cookies, redirects and WebSockets. |
| [HTTP API guide](docs/developing/http-apis.md) | Bearer tokens, API hosts and offer-template role attenuation. |
| [Authoring tests](tests/apps/isolate-authoring.js) and [example tests](tests/apps/isolate-examples.js) | Platform behavior to preserve, including preview Powerbox and publication. |

Do not copy the old `api.storage()`, `RpcTarget`, or `ClaimedCapability` usage from the personal isolate builders/mail-agent. Use the current helper and native schema APIs.

Important constraints:

1. `IsolatePreviewer` currently exposes preview and log watching, **not reset, delete, list-grains, restart, or arbitrary grain creation**.
2. The preview grant is tied to its owning authoring grain and account. It is not a generic account factory credential.
3. `preview()` returns a candidate and a UiView. It does not return a stable public preview URL or a CLI HTTP endpoint.
4. Repeated preview calls update a slot and normally preserve its data. Source rollback does not roll back application data or external effects.
5. A publisher grant binds the candidate digest, target and metadata; `publish()` takes an operation ID, not another uploaded source bundle.
6. Runtime-injected bindings and package construction are platform-controlled. Uploaders cannot select an executable, filesystem mount, arbitrary service binding, or native process.

## Implementation layout and technology

Create a new standalone repository, preferably `/home/michael/p/personal/packaging-sandbox`, when implementation is requested. That path is a proposed destination, not authorization to bypass filesystem permissions. Do not place production app code inside the Sandstorm platform repository.

Use a TypeScript isolate for the controller, built to JavaScript with esbuild, and a Go CLI. This aligns with the current isolate examples and eventual reuse by the Go-based spktool. Prefer a small bundled browser UI; a frontend framework is optional. Keep Sandstorm adapters separate from transport-independent project logic.

```text
app/
  src/worker.ts                  request dispatch, system routes
  src/auth.ts                    permissions and route authorization
  src/store.ts                   revisions, uploads, operations, retention
  src/bundles.ts                 IsolateBundle producer and validation
  src/preview.ts                 preview/candidate/view lifecycle
  src/test-session.ts            constrained UiView session context
  src/web-session.ts             HTTP/WebSession translation
  src/logs.ts                    bounded streaming and disconnect cleanup
  src/publication.ts             proposals and browser-approved publication
  src/client/                    trusted controller UI
  sandstorm-pkgdef.capnp
cli/
  cmd/sps/
  internal/client/               versioned HTTP API client
  internal/project/              config, manifests, local build/watch
  internal/credentials/          token storage and redaction
  internal/previewproxy/         localhost test origin
protocol/                        JSON schemas and example transcripts
fixtures/                        small candidate applications
tests/                           protocol and full integration tests
docs/                            installation and agent workflow
```

Package/install the controller using normal isolate packaging tools as a maintainer. End users and their agents need only `sps`, their local build tools, and a compatible remote server. Pin compatible generated declarations/tooling; do not depend on undeclared local paths in distributed builds.

## First milestone must prove remote test access

Before building a polished UI or file watcher, prove this full vertical slice against a compatible server:

1. Install the controller, create a grain, and grant `IsolatePreviewer` in the browser.
2. Obtain a restricted developer API token; make an authenticated HTTP request to the controller.
3. Upload a two-module fixture and preview it using native Cap'n Proto.
4. Save and restore the candidate and returned view where supported. Verify restoration after controller restart, rather than assuming the live handle remains usable.
5. Open a WebSession on the returned UiView with a deliberately restricted session context; request its HTML and assets through the controller.
6. Access that session through an `sps` localhost proxy in an isolated browser profile; perform a UI action and see its remote persistent result.
7. Stream preview logs, disconnect, then restart the controller and reconnect.

The existing example only reads `view.getViewInfo()` and uses the trusted shell preview drawer. It does **not** prove the full CLI browser path. Treat translation, restoration, session lifetime and helper compatibility as a feasibility gate.

Inspect the generated native bindings and existing WebSession bridge before writing adapters. If necessary primitives cannot be used from an isolate, record the exact missing method/transport and evaluate a conventional controller app with native RPC. Do not claim an HTTP URL exists, scrape the shell, import Mongo internals, or silently require admin cookies. A browser-only preview is a useful intermediate milestone but does not complete the requested autonomous test loop.

## Human setup and permissions

Declare independent permission bits, in stable order: `develop`, `manage`, `publish`. Suggested roles:

| Role | Permissions | Purpose |
| --- | --- | --- |
| Developer | develop | Upload, preview, view logs, create constrained test sessions and release proposals. |
| Manager | develop, manage | Connect/revoke grants, configure retention, create connection instructions. |
| Owner workflow | develop, manage, publish | Browser-reviewed publication. Platform ownership checks still apply to granting preview authority. |

Use `api.session()` permissions supplied by the platform. Do not trust HTTP body flags, custom role headers, a caller-supplied grain/account ID, or possession of an operation ID as authorization. Every route, including downloads and stream reconnection, checks permission.

The controller UI should guide the grain owner through:

1. Grant preview authority through Powerbox; retain its saved token privately.
2. Render an offer template with an explicit **Developer** role assignment and a descriptive token label.
3. Display API endpoint and token in Sandstorm's trusted token iframe. The controller browser code does not need to read the generated token.
4. Explain `sps connect --endpoint <API_HOST> --token-stdin`; let the user securely paste the token. Never put it in a sample command argument or repository config.
5. Show connection status after `sps` successfully calls the handshake endpoint.

Offer-template tokens have a first-use expiry; consume them immediately during `connect` and test the actual lifecycle on the target server. Revocation should use Sandstorm's token management initially. Do not invent a controller API that lists or revokes every platform-issued API token without an exposed capability.

The server must reject publication and grant-management operations for Developer tokens even when a caller invokes their URLs directly. Browser Powerbox claim handlers require the relevant management/publication permissions. An agent may submit a publication proposal, but cannot mint/claim publisher authority or execute publication with its development credential.

## sps command surface

All commands below are proposed. Keep the implementation independent of `spk` and spktool; expose reusable Go client packages for possible future integration.

```sh
sps init
sps connect --endpoint https://<api-host>/ --token-stdin
sps status --json
sps push --json
sps dev --watch
sps logs --follow
sps preview
sps propose-release --title "My App" --version "0.1.0"
sps disconnect
```

- `init` creates `sps.toml` and optionally an isolate starter; never overwrite existing source without an explicit option.
- `connect` validates endpoint/protocol/features and stores credentials outside the project. It uses the grain API endpoint, not the server's shell root URL.
- `push` uploads and previews one immutable build snapshot, returning revision, platform digest, operation state and diagnostics.
- `dev` runs an explicitly configured local build, watches declared inputs, coalesces changes, waits for successful builds, and serializes preview updates. It must never upload half-written build output.
- `preview` starts a loopback-only browser proxy and prints its URL. Opening a browser is optional. The remote credential remains in the CLI process.
- `logs` follows a bounded stream with candidate/revision identity and explicit gap markers after reconnects. Logs go to stdout; CLI diagnostics go to stderr.
- `propose-release` records a fixed candidate proposal and returns instructions for reviewing it in the existing controller browser UI. No automatic publication.
- `disconnect` removes the local credential. Clearly distinguish this from remotely revoking a token or deleting remote data.

Do not advertise `reset`, arbitrary remote shell execution, or native SPK deployment in v1. Add commands only when their semantics are implemented using supported APIs.

Example project configuration:

```toml
protocol = 1
main = "worker.js"
compatibility_date = "2025-01-01"
output_dir = "dist"
build = ["npm", "run", "build"]
watch = ["src", "package.json", "package-lock.json"]

[[modules]]
name = "worker.js"
path = "worker.js"
type = "esModule"
```

Use argv arrays for local build commands, with an explicit working directory. No implicit shell evaluation. Execute only project-configured commands, never commands returned by the remote service. Select additional module paths/types explicitly; reject symlinks escaping the output root, traversal, duplicate module names and unexpected files. Do not upload the whole repository, `.env`, credentials, signing keys or `node_modules` by default.

Store credentials with OS credential storage where practical, otherwise owner-only files with owner-only parent directories. Redact tokens, authorization headers, saved capabilities and authenticated URLs from all output. Reject HTTPS downgrades and cross-origin redirects carrying authorization. Support explicit insecure HTTP only for intentional local development. Remote endpoints are sensitive configuration and must not be replaced by untrusted project content without a fresh connection decision.

## Versioned HTTP protocol

Expose the following logical routes through the controller's API session. Browser management routes use a separate namespace and permission checks. Confirm API-path mapping against the installed package.

| Method and route | Permission | Behavior |
| --- | --- | --- |
| `GET /v1/info` | develop | Protocol version, supported features, limits, project ID, current revision, grant readiness. No tokens. |
| `POST /v1/uploads` | develop | Validate manifest and reserve a bounded upload. Include expected project revision and client operation ID. |
| `PUT /v1/uploads/:id/modules/:index` | develop | Stream exactly one declared module; verify length and content hash before committing. |
| `POST /v1/uploads/:id/commit` | develop | Seal immutable upload, queue preview and return operation ID. |
| `GET /v1/operations/:id` | develop | State, structured diagnostics, revision/digest once ready. |
| `GET /v1/revisions/:id` | develop | Metadata and candidate state; never expose saved capability tokens. |
| `GET /v1/logs?revision=...` | develop | Bounded SSE/text events or polling fallback with explicit cursor/gap semantics. |
| `POST /v1/test-sessions` | develop | Open a constrained session for the active revision and requested permitted test persona. |
| `/v1/test-sessions/:id/http/...` | develop | Relay only that preview's requests; no arbitrary destination URL. |
| `DELETE /v1/test-sessions/:id` | develop | Release its session capabilities and handles. |
| `POST /v1/release-proposals` | develop | Pin a proposed candidate, target and metadata for human review. |

Use random opaque identifiers, but still check permissions and object ownership on every lookup. API requests remain authenticated even with a session ID. Test session IDs must not become standalone bearer credentials in URLs.

Standard error body:

```json
{
  "error": {
    "code": "revision_conflict",
    "message": "The active revision changed before this upload committed.",
    "retryable": false,
    "details": {"expectedRevision": 4, "actualRevision": 5}
  }
}
```

Define stable codes for missing permission, missing/revoked preview grant, invalid manifest/module, size/quota limit, conflict, unsupported platform feature, preview failure, stale test session and expired upload. Never return stack traces containing capabilities. Distinguish validation failure, preview installation failure, and runtime application failure; a valid installed candidate can still fail requests.

## Revision storage and operation lifecycle

Store small records in `api.kv()` and module bytes through `api.files()`. Use immutable completed module objects and atomically published record pointers; verify the actual API's atomicity/concurrency guarantees before relying on them. Do not assume multi-key KV transactions or cross-request serialization.

Persist:

- Project settings, current revision and generation counter.
- Saved preview grant, candidate and view tokens, private to the controller.
- Upload manifests, per-module completion/hash/length, expiry and byte accounting.
- Immutable revision records and references to source objects.
- Operations with request hash, client operation ID, stable platform request ID, state and error.
- Publication proposals with exact candidate digest, target and metadata snapshot.
- Publication results and bounded operational events without secrets.

Operation states: `uploading → sealed → previewing → ready`, or a recorded failure. The platform digest is authoritative for publication; a local manifest/content hash is only upload integrity and deduplication metadata. Do not reimplement or substitute the platform's normalized digest.

Serialize publication of project revisions, validate expected revision, and make retries idempotent. Reusing an operation ID with different content returns conflict. Write the stable platform request ID before calling preview. After disconnect/restart, reconcile or retry the same immutable request with the same ID; do not invent another preview operation. Reject older uploads arriving after newer revisions unless explicitly resubmitted against current state.

Resolve overlap between preview updates and browser tests: tests bind to a revision generation. Refuse updates while a bounded test lease is active, or explicitly invalidate existing sessions before switching. Never silently serve revision N+1 through a session reporting revision N.

Set app limits below or equal to platform limits and expose them in `/v1/info`. Include total retained bytes, upload expiry, completed revision count, log memory, concurrent sessions, queue length, and request duration. Account for in-progress uploads. Cleanup must preserve the active revision and pending publication proposals. No unbounded buffering of source or logs.

Dropping local candidate tokens is not a guaranteed immediate package deletion. Revoking all retained copies of a preview grant permits platform cleanup, which may be delayed. The UI must distinguish releasing controller references from confirmed destruction of preview data.

## Browser and HTTP testing boundary

The controller opens a test session on the preview UiView with a minimal session context. Implement only the methods needed for safe testing and return explicit unsupported/permission-denied errors otherwise. Do not pass the controller's real owner session context through to candidate code. Synthetic users/roles are test inputs scoped to the preview, not identities usable against other grains.

The CLI translates browser traffic to authenticated controller requests. Candidate HTML runs on a dedicated local origin, never under the controller UI origin. Controller management routes must not be reachable through the preview relay. Do not forward the controller bearer token or its cookies to candidate code or put them into HTML, JavaScript, query parameters, browser storage, HARs, or test reports.

The relay is a WebSession adapter, not a general HTTP proxy. Implement and test paths/query encoding, response status, content type, binary data, cookies, redirects, errors, request/response streaming and cancellation. Add WebSocket forwarding as a documented milestone. Audit the existing bridge's header/CSP/origin handling; do not indiscriminately forward authentication headers or rewrite arbitrary URLs. Browser Powerbox `postMessage` requires shell mediation; it will not work automatically through a localhost relay. Return a clear unsupported result or implement a narrowly scoped test bridge later.

Bind the local listener only to loopback, validate Host/Origin where appropriate, use a dedicated unpredictable local hostname/origin or equivalent validated session arrangement, and keep management APIs out of that listener. An arbitrary local web page must not be able to drive the relay as the developer. Verify this with hostile-origin tests. Preserve restrictive browser policy suitable for candidate testing; do not disable browser security to make the tests pass. State any browser-fidelity limitations explicitly.

Expose human shell preview through the existing digest-based preview drawer separately. Do not derive raw grain IDs or forge a shell URL from a digest. The first userspace release may require the human to reopen the sandbox from their grain list for review; a guessed deep link is not acceptable.

## Publication flow

1. `sps propose-release` chooses a ready revision and records its platform digest, target (new app or specific existing app), and metadata.
2. Freeze those values for the proposal. A later upload does not alter it. Initially allow one pending proposal and block preview replacement until it is published or explicitly abandoned if platform retention cannot keep it publishable.
3. A human with publication permission opens the trusted controller UI, inspects the candidate and metadata, and invokes the standard publisher Powerbox request for that exact descriptor.
4. A permission-checked browser route claims the returned publisher capability and calls `publish()` with a persisted operation ID. The capability never reaches the CLI or candidate.
5. Persist the result and reconcile retries. Replays cannot create an unintended extra revision or retarget publication.
6. Show the installed app result. Do not automatically create or upgrade production grains, transfer sandbox data, copy saved capabilities, sign an app-market release, or submit to the market.

Use the existing reference workflow and platform tests as the contract. Publishing an account-installed generated app is distinct from producing a distributable signed SPK or market listing.

## Reset and fixtures

Do not implement `sps reset` by calling private shell Meteor methods or deleting server files. The exposed preview capability has no reset method. For MVP, a fresh Packaging Sandbox grain plus a new grant is the reliable clean-workspace workflow. A manager may revoke preview authority, but asynchronous cleanup must not be presented as an immediate reset.

After MVP, investigate whether a deliberate fresh-grant lifecycle can give a safe fresh preview slot, with confirmed teardown and authority cleanup. If a public reset/lifecycle capability is required, propose it separately as a minimal platform change.

Future fixtures should expose real typed interfaces: deterministic LLM gateway, sample mail feed, message sink, email/notification capture. Initially they may live in a dedicated test provider implementation or be manually connected through Powerbox. Do not promise autonomous multi-grain fixture creation or arbitrary capability injection from the current single preview grant. Prove the required interfaces first. Explicit real-service grants remain separately authorized and are labeled as causing real external effects.

## Delivery milestones and acceptance criteria

### 1 Feasibility and compatibility

Complete the remote test-access vertical slice above. Record the exact platform revision and supported module/import forms. Prove that the existing authored-bundle path accepts required `sandstorm:`/`capnp:` dependencies; do not assume it has every local `spk dev-isolate` compilation feature. If necessary, constrain the starter to supported inputs and surface diagnostics. Publish a short compatibility note with any precise blocker before expanding scope.

### 2 Controller and CLI core

Implement package permissions, owner setup, Developer offer template, handshake, secure credentials, explicit module manifest, bounded uploads, persisted operations and preview updates. Acceptance: `sps push` from a machine with no Sandstorm/VM creates and updates a remote counter fixture; its value survives normal source updates; concurrent pushes conflict predictably; revoked credentials/grants fail cleanly.

### 3 Agent test loop

Implement logs, test-session lifecycle and loopback browser relay. Acceptance: Playwright in a clean profile can load assets, mutate the counter, assert state and read errors without any owner browser credentials. Candidate code cannot reach controller settings or discover its tokens. A long stream cancels on disconnect; a stale session reports the wrong revision rather than silently switching. Cover WebSockets explicitly if advertised; otherwise report them unsupported.

### 4 Reliable local iteration

Implement local build/watch, stable snapshots, JSON output and reconnection. Acceptance: failed builds never replace the last preview, rapid saves coalesce, interrupted uploads expire, and restart/retry cannot apply a stale revision. Provide an agent-facing recipe documenting permissions, output, and unsupported features.

### 5 Human publication

Implement proposal persistence and browser Powerbox publication. Acceptance: Developer token receives denial on every direct publication/claim route; changing source after proposal cannot change the approved bytes; publication does not create/upgrade production grains or copy test state. Test interruptions before and after a successful platform publication.

### 6 Packaging and maintenance

Produce the controller SPK and standalone `sps` releases, reproducible builds, protocol examples, and installation/upgrade documentation. Validate controller upgrades with existing saved capabilities and pending operations. Keep CLI protocol compatibility independent from app marketing version. Optional future spktool integration should consume the client package/protocol, not duplicate the implementation.

## Required verification

Use meaningful unit tests for module validation, role checks, state transitions, retry/conflict behavior, quota accounting, credential redaction and HTTP translation. Use real-server integration tests for capabilities, token attenuation/revocation, streaming, restart and publication; mocks alone cannot establish these properties.

Adversarial integration cases must include wrong-role and cross-project requests, arbitrary relay destinations, candidate HTML trying to call controller APIs, unexpected redirects, malformed/oversized uploads, hostile filenames, double commits, controller restart during preview, stale views, revoked grants, publication replay and publication of a digest other than the proposal. Verify that platform methods are actually denied rather than merely absent from the UI.

The release demonstration is: a human pairs once; an agent on a host without Sandstorm or a VM builds, uploads, browser-tests and iterates on an isolate; the agent proposes a release; a human approves the exact tested candidate; existing production grains and connections remain untouched. Record which server revision and browser paths were exercised, and clearly separate implemented userspace behavior from deferred platform isolation.
