# True Capability Passing for Isolate Grains

This plan describes how to evolve isolate app-defined RPC from JSON helper
calls with local handle IDs into true cross-grain object-capability passing.
The goal is to make isolate APIs feel close to Cloudflare Workers RPC or
Cap'n Web while preserving Sandstorm's Powerbox, saved-token, and revocation
model.

## Current State

Isolate apps can already:

- request capabilities through browser-mediated Powerbox flows
- claim a Powerbox request token into a live `ClaimedCapability`
- save a live capability into a durable `SavedCapability` token
- restore saved tokens later
- expose route-backed `WebSession` and `ApiSession` capabilities
- expose JavaScript object capabilities with `RpcTarget`
- call app-defined object capabilities using `ClaimedCapability.call()` or
  `asRpc()`

The current app-defined RPC call path is roughly:

```text
worker JS
  ClaimedCapability.call(method, args)
    -> serialize args into JSON-ish helper values
    -> POST /call through ClaimedCapability.fetch()
    -> remote worker hydrates values and invokes target method
```

This works for JSON data and for local object-capability calls inside the same
isolate supervisor. It intentionally rejects remote app-defined RPC arguments
that are live local handles:

- raw `RpcTarget` callback objects
- live `ClaimedCapability` handles

Those objects are local to the sender's isolate supervisor. Serializing them as
`{ type: "claimedCapability", id }` across a grain boundary gives the receiver
an ID that only the sender's supervisor understands. The current safe pattern
for cross-grain callbacks is to pass a saved token and have the receiver
restore it.

## Target

Make this work for cross-grain isolate app-defined RPC:

```js
class MailEventReceiver extends RpcTarget {
  async onMailEvent(event) {
    // ...
  }
}

const feed = restoredFeed.asRpc();
await feed.subscribe(new MailEventReceiver());
```

The provider grain should receive a callable stub:

```js
class MailFeed extends RpcTarget {
  async subscribe(receiver) {
    await receiver.onMailEvent({ subject: "hello" });
  }
}
```

Under the hood, `receiver` must be a real Sandstorm/Cap'n Proto capability, not
a local helper ID. Calls from the provider must route back to the requester
grain while both live capabilities remain connected.

Saved tokens remain necessary for durable subscriptions:

```js
const receiver = await api.persistentCapability(new MailEventReceiver(), {
  id: "mail-event-receiver",
  storageKey: "mail-event-receiver-token",
});

await feed.subscribeSaved(receiver.saved.token);
```

Live capability passing is for ephemeral callback/object passing. Saved tokens
are for persistence across process lifetimes, restarts, and explicit durable
ownership transfer.

## Core Semantics

### Live Capabilities

A live passed capability is ephemeral authority:

- valid while the holder and provider remain connected
- lost on disconnect unless separately saved
- dropped when no holder retains it
- should fail predictably after disconnect

Live capability passing should not silently persist authority.

### Saved Capabilities

A saved capability token is durable authority:

- explicitly created with `save()`
- stored by app code
- restored later into a fresh live handle
- independently revoked with `dropSaved()`

Saved tokens remain the recommended pattern for durable cross-grain wiring.

### Powerbox

Powerbox still mediates initial user-granted authority:

```text
browser opens Powerbox
shell returns token or claimed handle
worker claims/saves/restores capability
worker uses live capability for calls
```

True live capability passing does not replace Powerbox. It improves what can be
sent through an already-authorized app-defined RPC connection.

### JavaScript API

The desired app author rule is:

- pass plain objects for data
- pass `RpcTarget` for live callbacks
- pass `ClaimedCapability` when live authority should be forwarded
- pass `SavedCapability` or saved token strings when durable authority is
  required

The implementation should reject unsupported forms with precise errors rather
than falling back to local ID serialization.

## Architecture

The long-term architecture should be:

```text
requester JS isolate
  RpcTarget / RpcStub / ClaimedCapability
    |
requester isolate supervisor
  JS object registry
  capability export table
  capability import table
    |
Sandstorm Cap'n Proto RPC
    |
provider isolate supervisor
  capability import table
  JS stub registry
  object-capability dispatch
    |
provider JS isolate
  RpcStub / RpcTarget
```

The JavaScript worker should not need a raw Cap'n Proto library. Native
Cap'n Proto capability bridging should live in the supervisor. JS can keep a
Cap'n Web-like object model.

## Major Pieces

### 1. Define A Capability-Aware App RPC Transport

The current `/call` transport is JSON over HTTP through route-backed
WebSession-like capabilities. It has no native capability table.

We need a transport that can carry:

- JSON-compatible data
- binary data
- streams, eventually
- imported live capabilities
- exported live capabilities
- errors
- disposal/lifetime messages

Two viable designs:

1. Add a generic Cap'n Proto interface for app-defined dynamic calls.
2. Keep a Cap'n Web-shaped protocol between JS and supervisor, but bridge all
   cross-grain references through Cap'n Proto in the supervisor.

The preferred direction is the second option for JS ergonomics:

```text
JS sees Cap'n Web-like calls
supervisor owns native Cap'n Proto capability plumbing
```

The C++ interface can still be generic. For example:

```capnp
interface IsolateObjectCapability {
  call @0 (method :Text, args :CallArgs) -> (result :CallResult);
  drop @1 ();
}
```

`CallArgs` / `CallResult` need a representation that can include capability
slots. The exact schema should be designed carefully; avoid baking in a
JavaScript-only JSON shape if a future Cap'n Web bridge wants richer values.

### 2. Add Supervisor Capability Export Tables

When JS passes a local `RpcTarget` to a remote call:

```js
await feed.subscribe(new Receiver());
```

the requester supervisor must:

1. assign it a local object ID
2. register it in an exported object table
3. expose it as a real Cap'n Proto capability server
4. attach that capability to the outgoing call argument

The exported entry must know:

- JS object ID
- target object
- whether it is temporary or persistent
- active holder count, if available
- drop/dispose behavior
- owning workerd session/generation

Temporary exports should be automatically disposed when no longer referenced.
Persistent exports should remain registered until explicitly unregistered or
until app policy says otherwise.

### 3. Add Supervisor Capability Import Tables

When a provider supervisor receives a live capability argument, it must expose a
JS stub object to the provider worker.

The imported entry should track:

- remote Cap'n Proto `Capability::Client`
- local JS stub ID
- expected object kind, if known
- lifecycle state
- disconnection/error state

JS should receive a stub compatible with `asRpc()` method calls:

```js
await receiver.onMailEvent(event);
```

Calls through the stub should route to the imported Cap'n Proto capability,
not to `/powerbox/fetch` with a local claimed-capability ID.

### 4. Preserve Local Fast Path

Calls within the same isolate supervisor should continue to work without
unnecessary remote plumbing:

```js
const cap = await api.capability(new Counter());
const child = await cap.call("child");
await cap.call("readOther", child);
await cap.call("readOther", new Counter());
```

The existing local JSON/helper path can remain as a fast path as long as it
obeys the same API rules. The important invariant is:

- local handles may be used locally
- remote calls must not serialize local IDs as if they were portable

### 5. Forward `ClaimedCapability` Correctly

A `ClaimedCapability` might represent several different things:

- local route-backed object capability
- restored cross-grain capability
- outbound HTTP session
- WebSession-shaped capability
- ApiSession-shaped capability
- offered/request-session capability

Forwarding should only be allowed when the supervisor has access to the real
underlying Cap'n Proto capability. If a handle is merely a local helper ID with
no transferable native capability, it should still be rejected.

Implementation requirement:

- the supervisor must retain the real `Capability::Client` for claimed handles
- JS handle IDs should become references into an import/export table, not the
  only representation of authority
- `drop()` should release the local reference, not necessarily revoke saved
  durable authority

### 6. Define Result Capability Passing

Capability passing must work in both directions:

```js
const child = await remote.makeChild();
await child.doThing();
```

If a method returns a JS `RpcTarget`, the callee supervisor exports it as a
live capability and the caller supervisor imports it as a JS stub.

If a method returns an existing `ClaimedCapability`, the callee supervisor
forwards the underlying real capability if transferable.

If a method returns `SavedCapability`, it remains data containing a durable
token.

### 7. Lifetime And Disposal

This is the most failure-prone part.

Needed semantics:

- temporary `RpcTarget` arguments are kept alive for as long as remote holders
  may call them
- dropping the remote stub releases the local export
- if the exporting grain exits, remote stubs fail with a clear disconnected
  error
- if the importing grain exits, the exporter eventually disposes temporary
  exports
- `Symbol.dispose` / `drop()` should release live references deterministically
  where possible

Open design questions:

- Can Cap'n Proto RPC reference counting/disconnect notifications do enough, or
  do we need explicit `drop()` messages at the helper layer?
- How do we handle abandoned JS stubs when user code never calls `drop()`?
- What timeout or GC policy should temporary callback exports use?

### 8. Error Mapping

Errors should preserve useful information across boundaries:

- validation errors
- method-not-found errors
- disconnect errors
- permission/claim/restore errors
- app-thrown errors

Avoid exposing raw C++ stack details as primary JS API errors. Prefer stable JS
error names:

- `CapabilityCallError`
- `DisconnectedCapabilityError`
- `ValidationError`
- `UnsupportedCapabilityError`

### 9. Persistence Boundary

Live capability passing must be documented as non-durable.

For durable callbacks, apps must still use:

```js
const receiver = await api.persistentCapability(target, {
  id: "receiver",
  storageKey: "receiver-token",
});

await feed.subscribeSaved(receiver.saved.token);
```

The API should avoid implying that live callback passing is sufficient for
background subscriptions that survive restarts.

Potential helper:

```js
const receiver = await api.powerbox().persistentCallback(new Receiver(), {
  id: "mail-event-receiver",
  storageKey: "mail-event-receiver-token",
  label: "Mail event receiver",
});
```

This would be sugar over persistent object capability + save + storage.

## Implementation Phases

### Phase 0: Preserve Current Safety

Already done / baseline:

- reject live `ClaimedCapability` arguments for remote app-defined RPC calls
- reject raw `RpcTarget` callback arguments for remote app-defined RPC calls
- support live callback/object arguments for local object-capability calls
- document saved-token pattern for cross-grain callbacks

This baseline prevents accidental local-ID leakage while true passing is not
implemented.

### Phase 1: Internal Capability Table Refactor

Goal: make current live handles retain native capability identity.

Tasks:

- audit every place that creates a `ClaimedCapability`
- ensure the supervisor stores the corresponding real `Capability::Client`
- distinguish local object exports from imported remote capabilities
- make JS handle IDs opaque references into the supervisor table
- add debug endpoints/tests for handle kind:
  - local export
  - remote import
  - route-backed WebSession
  - route-backed ApiSession
  - outbound HTTP

Expected result:

- no API behavior change
- better internal model for later forwarding

### Phase 2: Generic Native App-Object Capability

Goal: introduce a native Cap'n Proto interface that can represent app-defined
object calls between supervisors.

Tasks:

- define an internal Cap'n Proto interface for dynamic app calls
- implement C++ server wrapper for local JS object targets
- implement C++ client wrapper for imported remote dynamic capabilities
- keep current JS `/call` route as compatibility/local path while the native
  path is developed
- add supervisor-level tests using fake object targets before involving
  workerd

Expected result:

- C++ supervisors can call app-defined object capabilities through real
  capabilities
- JS may still use old helper path initially

### Phase 3: JS Stub/Target Bridge

Goal: connect JS `RpcTarget` and stubs to the native app-object capability.

Tasks:

- update JS serialization to represent `RpcTarget` as an exported live
  capability slot when the outgoing target is remote
- update JS hydration to represent imported live capabilities as callable stubs
- support returned capabilities
- preserve local fast path
- add explicit unsupported errors for types still not bridged

Expected result:

```js
await remote.call("subscribe", new Receiver());
```

works when `remote` is a cross-grain app-defined object capability.

### Phase 4: Cap'n Web-Compatible Ergonomics

Goal: make the API feel like Cloudflare Workers RPC / Cap'n Web.

Tasks:

- support `asRpc()` stubs for imported live object capabilities
- support direct method syntax:

  ```js
  const feed = cap.asRpc();
  await feed.subscribe(new Receiver());
  ```

- ensure `then` handling avoids accidental promise assimilation
- support functions as callback arguments if desired:

  ```js
  await feed.subscribe((event) => { ... });
  ```

- decide whether function callbacks should be sugar for an `RpcTarget` with a
  single method or should remain unsupported for clarity

Expected result:

- app authors mostly think in JS object-capability terms
- supervisor still handles real Sandstorm capability transport

### Phase 5: Lifetime, Drop, And Disconnect Semantics

Goal: make capability passing robust under real app behavior.

Tasks:

- implement explicit drop/release for imported stubs
- wire Cap'n Proto disconnects to JS errors
- dispose temporary JS exports when no longer referenced
- add leak checks in integration tests
- verify behavior when:
  - requester grain shuts down
  - provider grain shuts down
  - callback throws
  - callback is dropped
  - provider stores a live callback and calls it after original request returns

Expected result:

- no unbounded callback leaks in common flows
- remote calls fail cleanly after disconnect

### Phase 6: Durable Callback Helpers

Goal: make the durable pattern just as easy as the live pattern.

Tasks:

- add helper for persistent callback capability creation
- document when to use live callback vs saved callback token
- add examples:
  - live subscription callback
  - durable subscription callback
  - one-shot callback
  - unsubscribe/drop

Expected result:

- authors do not overuse live callbacks for durable subscriptions

### Phase 7: Powerbox And Custom Protocol Examples

Goal: prove the model in app-to-app scenarios.

Examples to build:

1. `isolate-feed-provider`
   - exposes `MailFeed`
   - accepts live callback subscriber
   - accepts saved-token subscriber

2. `isolate-feed-client`
   - requests feed through Powerbox custom descriptor
   - passes live callback
   - shows immediate event
   - creates durable callback and passes saved token

3. `isolate-llm-provider`
   - exposes `ConversationalLlm`
   - returns child/session capabilities

4. `isolate-llm-client`
   - requests provider through descriptor
   - receives returned child capability
   - calls child capability

### Phase 8: Nightwatch / Full Shell Tests

Goal: verify Powerbox, picker, package metadata, and real grain interactions.

Tests:

- provider appears in Powerbox for custom descriptor
- requester gets provider capability
- requester passes live callback capability
- provider calls callback
- requester passes saved callback token
- provider restores saved callback token
- provider calls callback after original request completes
- revoking saved token prevents future callback

Keep lower-level Node integration tests for fast iteration. Use Nightwatch only
for full shell/Powerbox behavior.

## API Sketch

### Live Callback

```js
class Receiver extends RpcTarget {
  async onEvent(event) {
    await storage.putJson("last-event", event);
  }
}

const feedCap = await api.powerbox().restoreSaved(feedToken);
const feed = feedCap.asRpc();
await feed.subscribe(new Receiver());
```

### Durable Callback

```js
class Receiver extends RpcTarget {
  async onEvent(event) {
    await storage.putJson("last-event", event);
  }
}

const receiver = await api.persistentCapability(new Receiver(), {
  id: "mail-event-receiver",
  storageKey: "mail-event-receiver-token",
});

await feed.subscribeSaved(receiver.saved.token);
```

### Returned Capability

```js
const session = await llm.startConversation({ model: "small" });
await session.send({ text: "hello" });
```

`session` should be a live imported capability stub if the provider returned a
live object capability.

### Forwarded Capability

```js
const tool = await api.powerbox().restoreSaved(toolToken);
await agent.registerTool(tool);
```

This should pass the underlying real capability if `tool` is transferable. If
it is only a local helper ID, reject with a precise error.

## Tests To Add

### Low-Level Unit Tests

- serializer rejects local IDs without native capability backing
- serializer exports `RpcTarget` as capability slot for remote calls
- hydration converts imported capability slot to stub
- returned `RpcTarget` becomes imported stub on caller side
- saved tokens remain JSON data, not live capability refs

### Supervisor Integration Tests

- Grain A passes live callback to Grain B
- Grain B calls callback immediately
- Grain B calls callback after A's original request returns
- callback throws and error propagates
- callback target is disposed after drop
- Grain A exits and Grain B sees disconnected error
- Grain B exits and Grain A releases temporary export
- returned child capability works
- forwarded restored capability works if native cap exists
- unsupported/nontransferable capability still fails clearly

### Shell/Nightwatch Tests

- custom descriptor provider appears in Powerbox
- browser-first request obtains provider
- worker claims/saves provider
- app-defined RPC live callback works through selected provider
- durable saved-token callback works after page reload/grain restart

## Compatibility Notes

Isolate APIs are not released yet, so we should prefer the clean long-term
model over backwards compatibility. Avoid preserving accidental behavior where
local handle IDs serialize across grains.

Do not expose raw service binding names as cross-grain authority. Service
bindings can remain local/development conveniences. Cross-grain authority must
come from Sandstorm capabilities.

Do not require app JS to use a raw Cap'n Proto library unless a future advanced
API explicitly opts into that. The default author API should remain JS-native.

## Risks

- Lifetime leaks from callbacks retained by remote grains.
- Premature disposal of callbacks still in use.
- Confusing distinction between live callbacks and durable saved callbacks.
- Hard-to-debug disconnection behavior.
- API mismatch between Cap'n Web semantics and Sandstorm saved-token semantics.
- Added complexity in the supervisor capability table.
- Security mistakes if a local helper ID is ever treated as portable authority.

## Open Questions

- Should function callbacks be supported, or only `RpcTarget` classes?
- Should live callback passing require an explicit wrapper such as
  `api.liveCallback(target)` for clarity?
- How should temporary callback lifetime interact with JavaScript GC?
- Should returned capabilities default to `asRpc()` stubs or remain
  `ClaimedCapability` handles with explicit `asRpc()`?
- How much Cap'n Web protocol should be reused verbatim versus treated as
  design inspiration?
- How should versioning work for app-defined RPC protocols without schemas?
- Can Cap'n Proto RPC's existing lifecycle machinery provide enough disposal
  signaling, or do we need explicit helper-layer release messages?

## Recommended Next Step

Start with Phase 1 and Phase 2 as one architectural slice:

1. Refactor supervisor live capability storage so every claimed handle records
   whether it has a transferable native capability.
2. Define the internal generic app-object Cap'n Proto interface.
3. Implement a minimal C++-level bridge for calling one exported app object
   through a real capability.
4. Add tests before changing the public JS serializer.

Only after that foundation is working should the JS helper allow
cross-grain `RpcTarget` arguments again.
