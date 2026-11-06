# Sandstorm architecture migration

Status: proposed migration plan, not an implementation commitment.

This plan describes a path from the current Meteor shell and C++ services to a
Svelte/TypeScript frontend, a Rust control server using Axum and Cap'n Proto RPC,
SQL metadata storage, and separately isolated grain and worker processes. It
preserves compatibility with existing Sandstorm applications and installations
throughout the migration.

The central architectural change is to organize boundaries around authority,
resource ownership, and process lifetime. The current JavaScript/C++ boundary is
useful for incremental replacement, but does not need to define the final system.

## 1. Starting point and evidence

This document was prepared from the `isolates-rebased` checkout and inspection of
the `capnp-es` worktree at `/tmp/sandstorm-capnp-es` and Tempest at
`/home/michael/src/tempest`. The inspected `capnp-es` HEAD was `555d51a53`.
Paths below are repository-relative unless explicitly identified as Tempest paths.
Branch integration and current test results must be checked before implementation;
the existence of code is not a claim that its behavior has been validated here.

### Current Sandstorm responsibilities

The Meteor shell combines:

- Account authentication, account/credential linking, administration, and settings.
- Grain, package, sharing, Powerbox, notification, and application-management logic.
- Mongo persistence and reactive query observation.
- DDP methods and publications, including publications with lifecycle side effects.
- Blaze templates, Tracker, client collections, routing, and frontend asset builds.
- Implementations of platform capabilities called by C++ services and grains.

The C++ side is substantial and independently valuable. It includes the gateway,
container orchestration, supervisors, sandbox setup, package/storage operations,
capability enforcement, and isolate/workerd integration. Replacing Meteor does
not require replacing those components at the same time.

Useful existing boundaries include:

- `src/sandstorm/backend.capnp`: `Backend`, `GatewayRouter`, and
  `SandstormCoreFactory` connect shell policy to backend and gateway services.
- `src/sandstorm/supervisor.capnp` and `src/sandstorm/grain.capnp`: supervisor and
  application-facing interfaces.
- `shell/imports/server/gateway-router.js`: the `sessions` publication creates
  sessions and maintains keepalives, rather than merely publishing records.
- `src/sandstorm/supervisor.c++`: capability membranes enforce requirements and
  propagate revocation. These semantics must survive any supervisor replacement.

### What the capnp-es branch contributes

The branch uses `capnp-es` in the shell's native RPC integration and in the
browser/worker path. The latter includes generated interfaces, a session-bound
single-use capability handoff, and a bidirectional RPC WebSocket connection.

Relevant files are:

- `src/sandstorm/isolate/browser-client.js`
- `src/sandstorm/isolate/capnp-runtime.js`
- `shell/imports/server/capnp.js`
- `examples/isolate-browser-capnp/`

This proves out a useful transport pattern. It is not yet a shell API or a
replacement for authentication, publications, client state, or session recovery.
The worker handoff relies on an existing grain session. Shell authentication must
establish its own authority before granting browser-facing capabilities.

### What to borrow from Tempest

Tempest combines HTTP handling, shell policy, SQLite access, and container
orchestration in one Go server. It launches a small C sandbox helper, which starts
an agent and application inside a separate sandbox. The agent's stated policy is
to implement functionality inside the sandbox whenever it needs no additional
authority.

Its `capnp/external.capnp` defines a browser-facing capability API with
authentication and role-scoped sessions. Its `capnp/collection.capnp` defines
`Puller.sync(observer)`, `Pusher.upsert/remove/clear/ready`, and a subscription
handle whose release ends observation.

Borrow these architectural ideas, not an assumption of implementation parity:

- Tempest's current `viewsPuller.Sync()` sends an initial snapshot but does not
  implement the continuing subscription promised by the schema.
- Several grain-facing APIs, including capability save/restore and sharing, are
  stubs in the inspected checkout.
- Normal server shutdown kills its managed containers. Sandstorm's intended
  restart behavior must be specified separately.
- Tempest's `BLOCKERS` lists outstanding isolation, resource-limit, and session
  validation work.

## 2. Destination and explicit decisions

```text
Browser: Svelte + TypeScript + capnp-es
    |
    | authenticated Cap'n Proto RPC over WebSocket
    v
Rust control server
    Axum HTTP handling and static assets
    browser-facing capability services
    accounts, permissions, sharing, Powerbox, administration
    metadata persistence and subscription coordination
    gateway routing and grain/package orchestration
    |
    +---- SQL metadata database
    |
    +---- sandbox launcher / lifecycle helper
    |         |
    |         +---- separate native grain processes and support agents
    |
    +---- separate workerd hosts / isolate supervision

Control server <---- capability RPC ----> grain and worker services
```

The target is one Rust workspace and, where appropriate, one control-server
process. It is not one process containing every grain, worker, and sandbox setup
operation. Workerd remains a C++ dependency even if Sandstorm's own orchestration
is rewritten in Rust.

Proposed defaults:

| Area | Proposed choice | Decision still required |
| --- | --- | --- |
| Browser UI | Svelte, TypeScript, ordinary static build | Routing and component conventions |
| Browser API | capnp-es and explicit domain capabilities | Subscription/recovery contract |
| Control server | Rust, Axum, capnp-rpc | Executor topology and connection limits |
| Metadata | SQLite for standalone installations | Whether clustered hosting is a first-release requirement |
| Clustered metadata | PostgreSQL if clustering is required | Supported deployment model before schema implementation |
| Sandbox setup | Small separate launcher | Retain C initially; consider a dedicated Rust executable later |
| Grain lifecycle | Separate execution with explicit ownership | Reattachment across control-server restart |
| Workerd | Separate host processes | Host allocation and restart policy |

If multiple control servers sharing metadata are a requirement for the first
replacement release, select PostgreSQL instead of SQLite. Do not implement two
SQL backends initially. Keep Mongo during the early migration regardless of the
eventual SQL choice.

The architecture should permit a separate host service later without requiring a
distributed deployment now. Internal module boundaries and capability interfaces
should be maintained even when their implementations share a process.

## 3. Invariants throughout the migration

1. Existing applications retain their public Cap'n Proto interfaces, sandbox
   expectations, grain storage, and package compatibility.
2. Browser capabilities never expose the privileged `Backend` bootstrap directly.
   Browser services translate authenticated authority into narrowly scoped actions.
3. Sharing, permission changes, and revocation remain effective for active sessions
   and capabilities already obtained through those sessions.
4. A transport reconnect does not imply that an interrupted mutation failed.
   Non-idempotent operations are not replayed blindly.
5. At every phase, one named component owns each durable mutation and lifecycle
   operation. Coexistence must not produce competing grain launchers, schedulers,
   migration runners, or session authorities.
6. User data is not converted irreversibly merely to test a new frontend or server.
7. Sandboxed code remains separately isolated. Memory safety does not replace
   namespace, filesystem, privilege, resource, and capability boundaries.
8. Feature switches have a documented rollback scope. After an incompatible data
   migration, switching a binary back is not a complete rollback procedure.

## 4. Shared contracts to design before broad migration

### Browser service model

Define a new versioned schema namespace for shell-facing APIs. Preserve existing
grain APIs independently. Use additive Cap'n Proto evolution: stable type IDs and
ordinals, no ordinal reuse, and explicit feature negotiation where behavior differs.

A possible capability hierarchy is:

```text
ShellBootstrap
    -> authentication flow / authenticated account session
AccountSession
    -> grain list subscription
    -> package management
    -> notifications
    -> individual grain access / controllers
    -> administrative capability, only when authorized
GrainAccess
    -> UI session lifecycle
    -> permitted grain operations
    -> sharing operations allowed by the caller's authority
```

This is a design sketch, not a schema to copy literally. Login transitions,
anonymous sharing access, multiple credentials, and administrator authentication
need explicit models. A new session must not inherit authority from stale browser
state after logout or account switching.

Define origin checks, cookie scope, session expiration, WebSocket admission, and
logout behavior at the HTTP-to-capability boundary. A previously issued capability
must not retain authority indefinitely just because a cookie has expired or been
deleted. Use server-side invalidation and connection/capability revocation as needed.

Keep ordinary HTTP endpoints for flows that require them: OAuth redirects, static
assets, app traffic, and appropriate upload/download paths. RPC need not replace
every byte-transfer mechanism.

### Subscription model

Use explicit domain projections rather than exposing arbitrary database queries.
For example, publish a user's grain-list entries, not a generic Mongo selector.

Specify:

- An initial snapshot and a readiness marker.
- Ordered changes with a subscription generation and revision or sequence.
- A race-free transition from snapshot to subsequent changes.
- Cancellation by an explicit method or capability release, with disconnect cleanup.
- Bounded buffers and a slow-client policy, such as dropping the subscription and
  requiring a new snapshot rather than accumulating unbounded updates.
- Recovery after a gap: resume only when retained history supports it; otherwise
  replace state with a fresh snapshot.
- Permission-filtered updates and removal/invalidation when authority changes.

For the first implementation, fresh snapshots after reconnect are acceptable.
Durable event replay is optional unless the feature needs it. Do not accidentally
promise durable delivery for an ephemeral UI subscription.

Where an operation requires reliable post-commit notification, record an event or
outbox entry in the same transaction as its state change. Dispatch after commit.
For ephemeral state, a revisioned snapshot plus invalidation may suffice. If there
are multiple writers during coexistence, all relevant writes must feed the update
mechanism; events emitted only by the Rust process are insufficient.

Permission revocation must have its own correctness path. A delayed UI update is
not an acceptable substitute for enforcing access on the server.

### Frontend service layer

Own connections, capabilities, subscriptions, reconnects, and mutation outcomes in
typed frontend services. Components consume domain state and invoke operations.
They do not create independent WebSocket connections or duplicate retry policies.

Keep decoded UI data separate from live capability handles. Never persist a live
connection's capability IDs as durable references. Explicitly release subscriptions
and handles when their owner disappears; do not depend only on JavaScript GC.

During migration, a small Tracker adapter can expose the same service state to
Blaze. New Svelte components use their own reactive adapter. Neither adapter should
contain authorization or persistence logic.

### Rust runtime and RPC compatibility

The Rust library documents Level 1 RPC support: capability references and promise
pipelining. This makes it a plausible shell implementation, not proof of parity
with every C++ helper used by the supervisor.

Choose and test an execution model for non-`Send` RPC systems, using a local
executor and bounded channels to other Tokio work where necessary. Do not assume
that every RPC client or connection can move freely among Axum worker tasks.

Implement a WebSocket transport adapter that matches the browser's actual message
format. Verify segmented messages, size limits, malformed input, close behavior,
backpressure, and cancellation. Compile schemas and test the same interfaces across
JavaScript, Rust, and C++; matching schema names alone is not an interoperability test.

## 5. Migration phases

Each phase should leave a deployable system. The order below separates frontend,
server, database, gateway, and sandbox changes so failures have a limited scope.

### Phase 0: Establish the baseline and feature ledger

**Work**

- Reconcile the current branch with the capnp-es work. Record which commits and
  runtime artifacts the migration actually depends on.
- Inventory methods, publications, HTTP handlers, background tasks, and exported
  capabilities. Count behavior, not just declarations.
- For each feature, identify its durable records, mutation owner, observers,
  authorization rules, lifecycle side effects, and tests.
- Inventory standalone and hosted/clustered requirements, including payments,
  external identity providers, custom domains, mail, transfers, and scheduled jobs.
- Record baseline behavior and performance for grain opening, sharing, Powerbox,
  package installation, reconnects, and control-server restarts.
- Build representative test data and backup/restore fixtures with linked accounts,
  sharing chains, revoked tokens, installed packages, and existing grains.

**Deliverable / exit gate**

A feature ledger with ownership and coverage, an agreed deployment target, and a
passing baseline suite on the branch that will receive the migration. Existing
failures are recorded rather than silently attributed to the rewrite.

**Rollback**

No runtime change yet.

### Phase 1: Prove Rust interoperability before committing to the port

**Work**

- Add a small Rust workspace with schema generation and a test-only Axum endpoint.
- Connect a capnp-es browser client to Rust and pass a browser observer capability.
- Connect Rust to the existing C++ backend over a Unix socket.
- Exercise returned capabilities, pipelined calls, callbacks, cross-connection
  forwarding, exceptions, cancellation, and resource release.
- Exercise a representative stream with slow readers and abrupt disconnects.
- Separate ordinary generated-interface compatibility from the more difficult
  generic membrane/proxy behavior needed for a future supervisor port.

**Deliverable / exit gate**

A repeatable browser-to-Rust-to-C++ integration test, plus documented executor and
transport choices. No leaked connections or unbounded queues in the tested cases.
Record library gaps with a concrete mitigation or a decision to retain C++ for
that responsibility.

**Rollback**

Remove or disable the experimental endpoint; no production feature depends on it.

### Phase 2: Introduce the shell capability API alongside Meteor

**Work**

- Implement the first production shell API in the existing shell process or a
  narrow adapter over its services. Retain Meteor login, Mongo, and business logic.
- Choose a bounded feature such as notifications. Expose its list, updates, and a
  mutation such as dismissal through the new API.
- Authenticate the new endpoint using the existing session authority. The bridge
  validates sessions server-side and propagates logout; the browser cannot merely
  supply a trusted account ID.
- Implement subscription cleanup, reconnect snapshots, and explicit mutation error
  states. Avoid inventing a universal DDP compatibility layer.
- Add frontend services and let the existing Blaze feature use them through a
  Tracker adapter.

**Deliverable / exit gate**

One complete feature no longer depends on DDP, with equivalent authorization and
UI behavior. Verify account switching, two browser tabs, updates from legacy code,
revocation where relevant, disconnects, and server restart.

**Rollback**

Route that feature back to its original implementation. There is still only one
durable mutation owner and one database representation.

### Phase 3: Establish Svelte and migrate bounded UI surfaces

**Work**

- Introduce a Svelte/TypeScript build producing static assets that can be served
  by the existing deployment and later by Axum.
- Port the first RPC-backed feature, reusing markup, CSS classes, assets, wording,
  and behavior. Keep visual redesign separate.
- Establish component conventions for loading, errors, accessibility, focus,
  dialogs, navigation, and subscription lifetime.
- Migrate complete routes or isolated components with a single DOM owner. Define
  explicit mount/unmount boundaries where Blaze and Svelte coexist.
- Preserve the grain iframe's identity and lifetime across unrelated UI updates.
  Test postMessage handling, origin validation, and Powerbox/offer frames.

**Deliverable / exit gate**

Svelte and Blaze can coexist without duplicate routing, event handling, or session
ownership. The frontend service layer works with both. Keyboard and focus behavior
and representative visual flows remain correct.

**Rollback**

Serve the Blaze surface again while retaining the same RPC service contract.

### Phase 4: Move domain services into Rust while retaining Mongo

**Work**

- Deploy Rust alongside the existing shell, initially behind the current gateway.
- Keep a single browser API entry point; route or proxy feature implementations
  internally during the transition instead of exposing inconsistent login domains.
- Transfer one feature's mutation ownership to Rust. Legacy callers delegate to
  that service once ownership moves.
- Use the existing Mongo representation through a repository layer. Preserve date,
  integer, missing/null, unique-index, and atomic-update semantics intentionally.
- Retain existing Mongo observers or introduce a validated change-feed bridge so
  both old and new clients see writes from either implementation.
- Implement platform callbacks in Rust incrementally while the existing shell
  continues supplying those not yet migrated.
- Use read-only shadow comparisons for derived state where useful. Never shadow
  execution of mutations that send mail, start grains, install packages, or mint tokens.

Suggested feature progression:

1. Notifications and read-only projections.
2. Preferences and selected administration operations.
3. Package browsing and installation coordination.
4. Grain listing, creation, and explicit UI session lifecycle.
5. Sharing, access requests, Powerbox, and persistent-capability coordination.
6. Remaining background tasks, transfers, mail, scheduled jobs, and hosted features.

Dependency analysis may change this order. Authentication and permission checks
must be available before moving a dependent feature, even if login UI migration
comes later.

**Deliverable / exit gate**

For each feature: a named Rust owner, differential behavior checks, authorization
tests, failure/retry tests, and no legacy direct writes that bypass its invariants.

**Rollback**

Return ownership to the legacy service only while its storage and behavioral
contracts remain compatible. Drain in-flight mutations and avoid overlapping owners.

### Phase 5: Replace authentication and remove Meteor

**Work**

- Port login providers, email tokens, credential linking, account switching,
  administrator authentication, logout, and expiration policies.
- Decide whether existing sessions can be securely imported or users must log in
  again. Document that decision; preserve accounts and credentials either way.
- Complete RPC replacement for every publication and method, including lifecycle
  effects such as grain-session creation and keepalive.
- Complete Svelte migration and remove Blaze, Tracker, Minimongo, and client-side
  Meteor account dependencies.
- Replace server startup hooks, configuration, routing, asset generation, and
  background-task registration currently supplied by Meteor.
- Verify locale handling, URLs, custom domains, browser security headers, and
  embedding behavior.

**Deliverable / exit gate**

The installation runs with the Rust control server, Mongo, and existing C++
services, with no Meteor process or build requirement. Every ledger feature is
implemented, explicitly unsupported by product decision, or blocks this gate.

**Rollback**

Retain a compatible previous release and documented session consequences. If new
credential formats cannot be read by the old release, a backup-based rollback or
explicit conversion is required.

### Phase 6: Migrate metadata from Mongo to the selected SQL database

**Work**

- Select SQLite or PostgreSQL based on the deployment decision from Phase 0.
- Design relational tables for identities, credential relationships, ownership,
  grants/tokens, notifications, jobs, packages, and grain metadata.
- Use flexible payload columns for appropriate manifests or cached metadata, not
  opaque blobs for all relationships and authorization state.
- Preserve externally visible IDs and secrets. Validate sharing chains, token
  ownership, expiry, and permission semantics explicitly.
- Implement transactions and recovery records for domain operations. Database
  transactions do not make filesystem changes or grain launches atomic.
- Replace Mongo observation with the defined subscription/event mechanism.
- Provide a repeatable offline import: stop writers, take a backup, convert, check
  invariants, then start the new server. Prefer a maintenance window to permanent
  dual writes for the first migration.
- Include schema versioning, migration failure recovery, integrity checks, and
  supported backup/restore procedures. Validate restoration, not just backup creation.

For SQLite, measure write contention using realistic session, activity, and job
loads. Use short transactions, an explicit write-concurrency policy, and a tested
backup procedure for the selected journal mode. For PostgreSQL, define connection
limits and cross-instance invalidation; notifications are a wake-up mechanism,
not durable event history.

**Deliverable / exit gate**

Representative production-shaped snapshots migrate with matching domain results,
including permissions. Backup restoration and interrupted migration are tested.
The original Mongo data remains available until acceptance is complete.

**Rollback**

Before accepting new SQL writes, restart from the preserved Mongo snapshot. After
accepting writes, rollback requires reverse conversion or restoring the pre-cutover
backup with an explicitly accepted loss window. Do not describe this as a simple
feature toggle.

### Phase 7: Consolidate gateway and host orchestration where useful

**Work**

- Port C++ gateway behavior into Rust feature by feature: grain HTTP adaptation,
  WebSocket proxying, request/response streams, static publishing, API sessions,
  custom origins, and relevant mail/TLS routing responsibilities.
- Compare protocol behavior, not just successful page loads. Cover headers,
  cookies, redirects, caching, cancellation, uploads, downloads, and unusual app
  HTTP features that existing Sandstorm interfaces support.
- Move suitable backend orchestration into Rust modules while retaining the
  launcher and existing supervisors as separate executables.
- Keep filesystem/package verification helpers in C++ until their own replacement
  is justified and tested. A Rust control server may invoke existing helpers.
- Define recovery for incomplete installations, launches, backups, and transfers.
- Benchmark before removing an IPC boundary for performance reasons.

**Deliverable / exit gate**

Rust owns external routing and selected lifecycle coordination with parity against
the existing gateway/backend tests. Remaining C++ components have explicit narrow
interfaces and documented ownership.

**Rollback**

Restore the old gateway or orchestration owner while its protocols and state remain
compatible. Never let old and new orchestrators independently manage the same grain.

### Phase 8: Decide restart semantics and finish the lifecycle boundary

This decision must precede removal of any existing process that provides restart
independence. It may need implementation earlier if Phase 7 changes that behavior.

Recommended target: a control-server restart should not unnecessarily terminate
healthy grains. Browser RPC sessions may reconnect, but application execution
should survive when the lifecycle architecture permits it.

**Work**

- Define ownership of process handles, logs, resource accounting, active RPC
  connections, and persistent capability restoration.
- Choose retained per-grain supervisors or a small persistent host service if
  reattachment cannot be implemented safely in the control server alone.
- Authenticate reattachment using stable identities and appropriate local access
  controls. Do not identify a grain solely by a reusable PID.
- Ensure exactly one lifecycle owner can launch, stop, or adopt a given grain.
- Specify behavior when control services disappear, restart, or are upgraded.
- Distinguish application survival from UI-session survival; test both explicitly.

**Deliverable / exit gate**

Tested crash/restart and upgrade behavior with no duplicate grains, orphaned
resources, or stale authority. If initial releases instead stop grains on restart,
document that as an intentional behavioral change rather than inheriting Tempest's
policy accidentally.

### Phase 9: Port supervisors and sandbox support only after semantic proof

**Work**

- Prototype Rust capability forwarding and membranes against existing applications.
- Verify revocation of already-derived capabilities, capabilities passed in both
  directions, pipelined calls, and capabilities embedded in arbitrary messages.
- Specify treatment of in-flight calls during revocation and match the existing
  security contract; checking only new top-level calls is insufficient.
- Test saved capability restoration, sharing requirements, owner checks, and
  behavior after process restart.
- Resolve Rust RPC library gaps through upstream work, explicit adapters, or
  continued C++ ownership. Avoid ad hoc proxies that cover only known interfaces.
- Port the launcher separately as a minimal executable if worthwhile. Preserve
  descriptor hygiene, namespace setup, privilege handling, mounts, seccomp,
  resource limits, signal state, and PID reaping.
- Keep sandbox setup outside a multithreaded async server process.
- Adapt the workerd host boundary separately; do not equate porting orchestration
  with rewriting workerd.

**Deliverable / exit gate**

Compatibility, isolation, revocation, and resource-lifecycle tests pass against real
applications and adversarial fixtures. Review the resulting authority boundary
before replacing the established supervisor. Retaining C++ here indefinitely is an
acceptable outcome if the rewrite lacks a concrete benefit.

**Rollback**

Select the previous launcher/supervisor for newly started grains. Existing running
grains may require draining or restart; define mixed-version compatibility before
rollout. Preserve storage formats or provide explicit conversions.

### Phase 10: Remove obsolete machinery and stabilize operations

Remove compatibility endpoints, old mutation paths, obsolete schemas, unused build
dependencies, and migration-only observers after the supported rollback window.
Keep import tools and documented version compatibility as needed for upgrades from
older installations.

Finish packaging, installer upgrades, service management, logs, diagnostics,
resource metrics, backup/restore, and operational documentation. The final product
must be easier to run, not merely have fewer source languages.

## 6. Validation strategy

Validation should follow the responsibility being moved. Add tests for contracts
and failure modes, not assertions that simply mirror new implementation details.

| Area | Required evidence |
| --- | --- |
| RPC | JS/Rust/C++ calls, capability passing, pipelining, forwarding, errors, release, limits |
| Subscriptions | Snapshot/update races, reconnect, slow clients, cancellation, authorization changes |
| Accounts | Login providers, linking, logout, expiry, account switching, anonymous sharing |
| Permissions | Sharing chains, revocation, active sessions, derived and restored capabilities |
| UI | Grain iframe continuity, navigation, keyboard/focus behavior, dialogs, Powerbox |
| Storage | Import invariants, transaction failures, concurrent changes, backup restoration |
| Lifecycle | Launch races, crash/restart, adoption, cleanup, interrupted package operations |
| Gateway | Streaming, app WebSockets, headers, cookies, origins, downloads, custom domains |
| Isolation | Descriptor leaks, namespace/mount behavior, limits, signals, process reaping |
| Operations | Upgrade/downgrade rules, service restart, diagnostics, supported deployment modes |

Use representative existing apps as well as small fixtures. Include native grains
and isolate workers. Keep a benchmark set for first grain open, warm grain open,
subscription startup, steady-state updates, concurrent streams, and memory per
connection. Set acceptance thresholds from measurements in Phase 0 rather than
inventing performance targets before a baseline exists.

## 7. Work organization and scope control

A useful Rust workspace could separate crates/modules for protocol bindings,
domain services, persistence, subscriptions, HTTP adaptation, host orchestration,
and the launcher. The exact directory structure is secondary to preventing HTTP
handlers and UI components from becoming the owners of domain invariants.

Keep the feature ledger current with these columns:

```text
feature | API | authorization | storage | mutation owner | background owner
        | legacy callers | new callers | validation | rollback restriction
```

Do not combine the following in a single feature cutover:

- New UI framework and visual redesign.
- New server implementation and new database representation.
- New gateway and new supervisor.
- New sandbox implementation and new process-restart policy.

These changes may be developed independently, but each production transition
should have an understandable failure and rollback scope.

The early phases are bounded experiments. Full behavioral parity is a multi-month
program, and replacing supervisor/security infrastructure is a separate project
with substantial uncertainty. Estimate later phases after completing the feature
ledger and interoperability prototypes; do not extrapolate from a working counter
demo or initial browser subscription.

## 8. First concrete milestone

The first useful milestone is deliberately smaller than replacing Meteor:

1. Reconcile and validate the capnp-es baseline.
2. Define a small notifications API and its subscription lifecycle.
3. Prove browser-to-Rust-to-C++ interoperability in an isolated fixture.
4. Implement the production notifications API over existing shell services and
   authentication, with Mongo unchanged.
5. Make the existing notifications UI consume the typed service.
6. Port that UI surface to Svelte and compare behavior.
7. Move its domain service to Rust when the authentication/observation bridge is
   ready, keeping one mutation owner.

This tests the transport, API style, browser state model, frontend migration,
authentication boundary, and Rust deployment without making accounts, Powerbox,
storage conversion, or sandbox replacement prerequisites.

## 9. Open decisions and stopping conditions

- **Deployment scope:** standalone first, or clustered/hosted parity immediately?
  This determines SQL choice and affects lifecycle ownership.
- **Restart guarantees:** must grains survive a control-server update? Prefer yes;
  decide before consolidating away the existing lifetime boundary.
- **Rust capability infrastructure:** are generic membranes and forwarding adequate
  for Sandstorm's semantics? Failure here blocks supervisor migration, not the
  Svelte frontend or Rust shell.
- **Session continuity:** import existing login sessions or require reauthentication?
- **Persistent reference compatibility:** which identifiers/formats must remain
  readable indefinitely, and which need explicit versioned migration?
- **Workerd hosting:** retain the current host boundary or change its allocation
  model? Treat this independently from browser API migration.
- **Hosted-only features:** implement, retain behind adapters, or explicitly retire?
  No feature disappears merely because the standalone prototype does not use it.

It is valid to stop at a Rust shell with C++ supervisors, or a Rust control server
with a small C launcher. Success is improved maintainability with preserved
behavior and clearer authority boundaries, not eliminating every line of C++.

## References

- [Rust Cap'n Proto RPC documentation](https://docs.rs/capnp-rpc/latest/capnp_rpc/)
- [Rust RpcSystem execution model](https://docs.rs/capnp-rpc/latest/capnp_rpc/struct.RpcSystem.html)
- [Cap'n Proto protocol features](https://capnproto.org/rpc.html)
- [Axum WebSocket API](https://docs.rs/axum/latest/axum/extract/ws/)
- [Svelte documentation](https://svelte.dev/docs/svelte/overview)
- [SQLite deployment guidance](https://www.sqlite.org/whentouse.html)
- [MongoDB change streams](https://www.mongodb.com/docs/manual/changestreams/)
- [PostgreSQL NOTIFY semantics](https://www.postgresql.org/docs/current/sql-notify.html)

Library references describe the APIs inspected while preparing the proposal.
Pin and revalidate actual dependency versions when implementing the prototypes.
