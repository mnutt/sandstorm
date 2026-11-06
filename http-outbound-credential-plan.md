# Outbound HTTP credentials through ApiSession

## Objective

Let a grain call an external HTTP API while Sandstorm holds and injects the remote
credential. The user enters the credential in Powerbox, and the grain receives a
persistent, revocable `ApiSession` capability scoped to the approved service.

Use the OpenAI Platform API as the first complete example. Extend the existing
Powerbox connection flow and shore up the existing external HTTP driver without
introducing a second public request API.

This is an implementation plan, not a description of functionality already
delivered. The source review established the existing behavior below; no live
OpenAI requests were made.

## Decisions and scope

- Keep `ApiSession` and its inherited `WebSession` methods: `get()`, `post()`,
  `put()`, and the existing streaming methods and response-stream mechanism.
- Keep the existing local proxy convention: the grain's `Authorization: Bearer`
  header selects its Sandstorm capability. The external driver supplies the
  separate remote `Authorization` header.
- Make platform-managed credentials the initial integration path. Caller-supplied
  remote authentication and a new `Proxy-Authorization` convention are not needed
  for this work.
- Add declarative authentication configuration and Powerbox UI, not executable
  authentication templates.
- Reuse useful transport, validation, disclosure, and test work from
  `OutboundHttpSession`. Do not maintain two independent external HTTP transports.
- Preserve browser-facing security policy and grain identity-header protections.
  Do not broadly relax the shared `WebSession` header whitelists.
- Keep credentials attached to individual grants initially. A reusable credential
  library, shared rotation across grants, and additional OAuth providers are
  follow-up features.

The two implementation workstreams are Powerbox credential acquisition and
external-driver correctness. Streaming belongs to the second workstream and can
land after a usable non-streaming integration.

## Existing implementation

The Node driver in `shell/imports/server/drivers/external-ui-view.js` already:

- Registers external HTTP capabilities under `ApiSession` and `frontendRef.http`.
- Accepts bearer, Basic, and OAuth credential submissions.
- Injects remote bearer or Basic authentication into outgoing HTTP requests.
- Supports Google/GitHub OAuth acquisition through the existing Powerbox flow.
- Implements buffered GET, POST, PUT, and DELETE requests.
- Uses SSRF-safe address resolution and returns redirects without following them.

`shell/imports/server/persistent.js` already encrypts the bearer token, Basic
password, and OAuth refresh token in saved HTTP frontend references. This is
specific handling for known fields; adding new secret fields will require
explicit persistence changes and tests.

The missing and incomplete pieces include:

- The ordinary Powerbox URL form always submits `auth: { none: null }`.
- The driver's handling of `ApiSession.PowerboxTag.authentication` is a TODO.
- Additional request and response headers are restricted by shared whitelists.
- The external driver's status mapping rejects useful statuses such as 401 and
  429 and collapses supported server errors into one response variant.
- Responses are buffered; upload streaming is unimplemented in this driver.
- The driver has a 15-second socket timeout and incomplete stream/error cleanup.
- It caches address resolution and authorization for the session instance.
- Its shallow copy of request options can share the mutable header map between
  requests. New per-connection headers must not extend that pattern.

## OpenAI reference integration

For the API-key path, OpenAI uses:

```http
Authorization: Bearer <OPENAI_API_KEY>
```

The approved base URL is `https://api.openai.com/v1`. Organization and project
selection can use `OpenAI-Organization` and `OpenAI-Project` where applicable.
These are connection settings rather than secrets supplied by the grain.

The intended sequence is:

1. The grain requests an `ApiSession` for the OpenAI API with bearer authentication.
2. Powerbox displays the destination, credential fields, and authority being granted.
3. The user enters an API key in Sandstorm's UI and approves the connection.
4. Sandstorm persists the credential and returns a capability, not the key.
5. The grain calls `post("responses", ...)`, or makes an equivalent request through
   its local HTTP proxy.
6. Sandstorm sends the request to OpenAI with the saved credential injected.

For an HTTP-based app, the two requests are conceptually:

```http
# Grain to its local bridge proxy
POST http://api-placeholder/responses
Authorization: Bearer <SANDSTORM_CAPABILITY_TOKEN>
Content-Type: application/json

{"model":"<model-id>","input":"Hello","stream":false}
```

```http
# External driver to the approved service
POST https://api.openai.com/v1/responses
Authorization: Bearer <OPENAI_API_KEY>
Content-Type: application/json

{"model":"<model-id>","input":"Hello","stream":false}
```

The placeholder hostname does not select the destination; the capability does.
The remote key is never returned to the grain by the connection flow. A native RPC
caller already holds the capability and needs no HTTP routing credential.

This grant allows the grain to make billable requests within the granted API
authority. Concealing the key does not impose a spending limit or guarantee that
every operation exposed by the remote API is harmless.

## Workstream A: Powerbox credential acquisition

### A1. Support existing authentication hints

Implement the `authentication` hint in `ApiSession.PowerboxTag`. Preserve the
existing text field and recognize documented values for Basic and bearer
authentication. Add bearer to the schema documentation; no new HTTP request
methods are required.

The canonical URL card must open a configuration form when credentials are
requested rather than immediately completing an unauthenticated grant. The
arbitrary-URL form should allow the user to choose no authentication, bearer, or
Basic authentication.

Unsupported authentication hints must not silently produce an unauthenticated
connection. Existing requests with no authentication hint retain their behavior.
Preserve the existing OAuth scope flow.

### A2. Add declarative connection profiles

Start with generic bearer and Basic forms and an OpenAI profile. A profile defines:

| Field | OpenAI example |
| --- | --- |
| Display name | OpenAI API |
| Suggested base URL | `https://api.openai.com/v1` |
| Authentication kind | Bearer |
| Secret field | API key |
| Optional non-secret fields | Organization ID, project ID |
| Header bindings | Authorization, OpenAI-Organization, OpenAI-Project |

The profile supplies metadata and bindings, never credential values. Prefer
structured bindings to arbitrary string interpolation: for example, a bearer
binding references a secret field, and a fixed-header binding references a
non-secret field. Reject transport-controlled header names and invalid values.

A Sandstorm-owned profile registry can provide provider-specific labels and help
links. Generic bearer/Basic authentication must work without adding every service
to that registry. An arbitrary app-provided label or canonical URL is not proof of
the provider's identity.

Keep secret-in-a-custom-header support as a small subsequent extension unless it
is needed by another initial integration. It must use the same secret handling,
not store a secret as an ordinary fixed-header value.

### A3. Store connection policy with the grant

Continue using `frontendRef.http`. Reuse `auth.bearer` and `auth.basic` for the
initial authentication mechanisms. Add validated, non-secret connection headers
for organization/project selection.

Conceptual shape, with final field names chosen during implementation:

```js
{
  http: {
    url: "https://api.openai.com/v1",
    auth: { bearer: "<secret; encrypted by persistence>" },
    connectionHeaders: [
      { name: "openai-project", value: "<project-id>" }
    ],
    methodRestriction: { allowed: ["POST"] }
  }
}
```

An absent method restriction preserves existing unrestricted behavior. An explicit
empty allowed set means no methods, not all methods. If method restrictions are
exposed in this milestone, persist them and enforce them on every inherited
method. Otherwise omit the field and do not claim a verb-restricted grant.

Keep API identity (`canonicalUrl`) distinct from the actual destination the user
approved. Bind credentials to the approved destination. Changing the destination
must not silently carry a saved credential to a different origin.

Server-side validation must check every submitted field. Client UI and Powerbox
matching are not enforcement. Return a descriptor describing the actual grant,
without including any credential values.

### A4. Consent, secret handling, and lifecycle

- Render credential forms in Sandstorm's trusted UI, not inside the requesting
  grain. Send submissions directly to the existing shell-side completion method.
- Show the destination, path scope, authentication mechanism, and any method
  restriction. Do not label GET-only grants as inherently read-only.
- Do not put secrets in descriptors, card data, URLs, logs, publications, or error
  messages. Clear secret input state after completion or cancellation.
- Reject conflicting caller headers for fields managed by the connection. The
  grain cannot override the saved Authorization or selected project headers.
- Preserve permission requirements, save/restore behavior, and grant revocation.
- Extend the admin network view with explicitly projected destination and policy
  metadata. Do not publish the complete HTTP authentication record.
- Revoking the Sandstorm grant stops that connection; it does not automatically
  revoke the API key at the remote provider.

## Workstream B: external-driver shore-up

### B1. Share transport without adding a public API

Extract transport utilities from `outbound-http-session.js` into a shared internal
module used by the external `ApiSession` driver. Keep the credential acquisition,
persistence, and registry integration associated with `frontendRef.http`.

The driver should have clear internal stages:

```text
existing ApiSession method
  -> validate grant, method, relative path, and request data
  -> build fresh request headers and inject managed credentials
  -> resolve approved destination / select configured proxy
  -> perform HTTP request with bounded lifetime
  -> translate response into the existing WebSession representation
```

Use a fresh header map for every request. Normalize names before checking for
duplicates or managed-header conflicts. Neither credentials nor request-specific
headers may leak across concurrent calls.

### B2. Preserve destination and network boundaries

- Port the outbound driver's origin/path validation and associated adversarial
  tests. Reject absolute request URLs, traversal, ambiguous encoded separators,
  and malformed escapes according to a documented path contract.
- Specify empty-path and trailing-slash behavior and test compatibility with
  existing API base URLs. Do not accidentally duplicate `/v1` or introduce `//`.
- Keep authority checks before credential injection and network activity.
- Continue SSRF-safe DNS resolution, address pinning for the connection, and
  correct Host/TLS hostname handling. Recheck policy for new connections rather
  than retaining an indefinitely stale authorization to a resolved address.
- Honor the configured HTTP/HTTPS proxies through the existing networking helper.
  Document that upstream proxies are responsible for address filtering when they
  perform DNS resolution.
- Return redirects without following them. In particular, never automatically
  forward a managed credential to a redirect destination.
- Keep framing, Host, proxy, and hop-by-hop headers under transport control.

Do not copy the external header policy into grain-to-grain bridges. Those bridges
must continue rejecting forged Sandstorm identity and permission headers.

### B3. Preserve useful API response information

Support OpenAI's authentication and rate-limit failures without converting them
into generic RPC exceptions. The first required statuses are 401 and 429, with
their original JSON error bodies. Preserve useful distinctions among retryable
server errors such as 502, 503, and 504 where the current representation loses them.

Use additive changes to the existing response schema rather than introducing a
parallel response API. A concrete starting point is appended client-error enum
values for 401 and 429 and, if needed, an additive server-error status field whose
default preserves today's 500 behavior. Audit old-reader behavior before choosing
the final encoding.

Update the Node mapping and both C++ HTTP conversion directions together. Verify
that newly representable statuses do not alter gateway authentication decisions
or allow remote authentication challenges to control a browser-facing session.

Expose the useful non-secret response metadata needed by API clients, including
request IDs, rate-limit headers, and Retry-After. Review each header's handling at
both the external driver and the local proxy; passing it through only one layer
does not deliver it to an HTTP app. Keep CSP, CORS, cookies, and other browser
policy under the gateway's existing control.

Broader arbitrary response-header support and caller-supplied authentication are
not prerequisites for the OpenAI milestone.

### B4. Make timeouts and failures reliable

Replace the current socket-timeout-only behavior with an explicit request
lifecycle that includes DNS/proxy setup, request upload, response headers, and
response transfer. Ensure all terminal paths release sockets, timers, streams,
and outstanding promises exactly once.

Use named, server-controlled timeout settings. The outbound driver's 120-second
overall deadline is a starting point for buffered calls; decide and document
separate streaming lifetime/idle behavior before enabling long-running SSE.
Tests should inject short deadlines instead of waiting minutes.

Handle DNS failure, connection refusal, TLS failure, premature response close,
upload failure, downstream write rejection, and caller cancellation. Do not treat
truncated response bodies as successful completion. Do not automatically retry
mutating requests after ambiguous network failures.

### B5. Implement streaming through the existing contract

For SSE, implement the existing `Context.responseStream` and streamed-content
response path. Return headers promptly, propagate backpressure, and tie the
underlying request to the response lifetime handle. The existing ByteStream
contract defines dropping the stream without `done()` as failure/incomplete data.
Release the stream on upstream failure and verify that both the Node binding and
the C++ receiver observe that lifecycle promptly. Do not merely log the error and
leave the caller waiting for `done()` forever.

Implement the already-declared `postStreaming()` and `putStreaming()` methods in
a later driver patch if needed. OpenAI's basic JSON/SSE request needs response
streaming, not streaming request upload, so upload streaming need not block it.

The existing driver also lacks implementations for some inherited methods.
Implement PATCH, proper HEAD handling, and OPTIONS deliberately, with method-policy
checks. Do not advertise WebDAV or WebSocket support unless implemented and tested.

### B6. Preserve and improve managed OAuth separately

Keep Google/GitHub behavior working while restructuring the transport. Replace
indefinite cached authorization with expiry-aware handling where expiry metadata
is available. Coalesce concurrent refreshes and handle refresh failures clearly.

If a provider rotates refresh tokens, persistence must support updating them
without exposing plaintext or weakening revocation; resolve that lifecycle before
claiming robust rotation support. Do not add automatic replay of a possibly
executed mutation as a token-refresh strategy.

This OAuth maintenance is useful driver work, but API-key authentication to OpenAI
does not depend on a new OAuth provider or token-refresh implementation.

## Compatibility and retirement of OutboundHttpSession

- Existing ApiSession callers keep their method signatures and proxy convention.
- Existing saved HTTP references restore without the new optional fields.
- Existing header behavior does not silently expand to arbitrary caller headers.
- New managed connection headers are explicitly approved and persisted with the
  new grant. They do not require new generic request methods.
- Preserve stricter restrictions when capabilities are saved, restored, or wrapped.
- Port the outbound regression cases before removing the duplicate transport.
- If saved OutboundHttpSession capabilities or consumers exist, retain a thin
  compatibility adapter over the shared transport with the existing interface ID
  and reference format. Otherwise remove its schema, registration, UI, and imports
  once the replacement integration is verified.

The existing shared `WebSession` response representation means some improvements
will require coordinated schema and bridge updates. Packaged HTTP bridges may be
older than the server. Document which improvements require rebuilt packages and
test graceful behavior with an older bridge; do not introduce a hidden second
request API to avoid that compatibility work.

## Files and responsibilities

| Area | Primary files |
| --- | --- |
| Powerbox hints and response schema | `src/sandstorm/api-session.capnp`, `src/sandstorm/web-session.capnp` |
| Credential forms and disclosure | `shell/imports/client/powerbox-builtins.js`, `shell/imports/client/powerbox-builtins.html`, translation files |
| HTTP registration, validation, and driver | `shell/imports/server/drivers/external-ui-view.js` |
| Transport code to reuse | `shell/imports/server/drivers/outbound-http-session.js`, `shell/imports/server/networking.js` |
| Persistence and documented record shape | `shell/imports/server/persistent.js`, `shell/imports/sandstorm-db/db.js` |
| Node response mapping | `shell/imports/server/web-session.ts` |
| Local HTTP conversion | `src/sandstorm/bridge-proxy.c++`, `src/sandstorm/web-session-bridge.c++` |
| Receiving grain HTTP conversion | `src/sandstorm/sandstorm-http-bridge.c++` |
| Powerbox restriction combination | `shell/imports/sandstorm-ui-powerbox/powerbox-server.js` |
| Admin visibility | `shell/imports/server/admin-server.js`, network-capabilities client/server files |
| Regression coverage | `shell/imports/server/testing.js`, `tests/tests/outbound-http-session.js`, Powerbox/bridge integration fixtures |
| Developer documentation | `docs/developing/powerbox.md`, `docs/developing/http-apis.md` |

## Delivery sequence

1. **Managed bearer credentials in Powerbox.** Implement authentication hints,
   generic bearer/Basic forms, and the OpenAI profile. Reuse existing bearer
   persistence and injection. Add optional approved project/organization headers.
2. **Driver lifecycle and confinement.** Consolidate transport, isolate request
   headers, port URL restrictions, honor proxy settings, and fix deadlines and
   failure cleanup. Preserve grant requirements and revocation.
3. **Usable non-streaming OpenAI integration.** Preserve required statuses, JSON
   error bodies, and operational response headers through the local bridge.
   Document the app-side request and complete the integration tests.
4. **Streaming responses.** Implement SSE delivery with backpressure, cancellation,
   failure propagation, and explicit timeout behavior using the existing schema.
5. **Compatibility cleanup and remaining driver work.** Retire or adapt
   OutboundHttpSession, add admin visibility, complete selected missing methods,
   and address OAuth expiry/rotation separately from the API-key milestone.

## Validation and acceptance criteria

Use a local fake HTTP service for deterministic regression tests. It should check
the received destination, method, path, authentication, connection headers, and
body, and return controlled statuses and stream failures. No real API key is
needed for automated tests.

Required cases:

- A user completes the Powerbox bearer form and the grain receives a usable cap.
- The external service receives the saved remote token, never the Sandstorm
  capability token. The grain receives neither the remote key nor form contents.
- Authorization and project headers cannot be overridden, duplicated with
  different casing, or contaminated by concurrent requests.
- Saved records use existing secret encryption; publications and descriptors omit
  credential material. Save/restore and permission revocation still work.
- Requests cannot escape the approved destination or path. Redirects do not
  trigger additional requests or credential forwarding.
- SSRF filtering, configured proxy behavior, and TLS hostname handling survive
  the transport refactor.
- 200 JSON, 401 JSON, 429 JSON with Retry-After, and selected 5xx responses reach
  an ordinary HTTP client with the intended semantics.
- Timeouts and cancellation terminate network work; truncated bodies fail.
- SSE events reach the grain before the upstream response completes, and slow or
  disconnected consumers do not cause unbounded buffering or orphaned requests.
- Existing unauthenticated, Basic, bearer, and OAuth paths retain their supported
  behavior. Existing packaged bridges get documented compatibility behavior.
- Shared browser and receiving-grain protections still reject forged identity
  headers and unsafe response-policy headers.

A successful non-streaming milestone lets a grain call OpenAI's Responses API
using a user-approved capability, with Sandstorm holding the key and with useful
authentication/rate-limit errors. The streaming milestone additionally delivers
incremental output using the same public ApiSession API.

An optional live smoke test can follow with an explicitly supplied test credential
and a small request. Keep secrets out of commands, logs, fixtures, and commits.

## Official OpenAI references

Checked during planning on 2026-10-28:

- [API authentication and request metadata](https://developers.openai.com/api/reference/overview)
- [Developer quickstart and Responses requests](https://developers.openai.com/api/docs/quickstart)
- [API error codes](https://developers.openai.com/api/docs/guides/error-codes)
- [Streaming responses over SSE](https://developers.openai.com/api/docs/guides/streaming-responses)
