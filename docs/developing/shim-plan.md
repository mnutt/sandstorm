# Outbound HTTP compatibility shim

## Goal

Provide a separately packaged Sandstorm driver app that implements the existing
`OutboundHttpSession` interface on servers without the native outbound HTTP
driver. Consumers such as OpenAI Gateway should use the same Powerbox descriptor,
RPC methods, and capability persistence flow with either provider.

This is a compatibility project, not a replacement for the native implementation.
The shim owns the HTTP implementation and holds credentials in its grain. The
consumer receives a scoped capability and does not receive the configured secret.

## Architecture

```text
Consumer grain
  | Powerbox request: OutboundHttpSession + endpoint + methods + auth declaration
  v
Sandstorm Powerbox
  | user selects a shim grain
  v
Shim request UI -> approve destination, enter credential -> persistent grant
  | HTTP parsing, credential injection, limits, cancellation
  v
IpNetwork -> IpRemoteHost -> TcpPort -> remote HTTPS API
```

Use one shim grain per configured endpoint/credential boundary initially. It can
issue multiple independently revocable grants without sharing a single global
network capability with its consumers. A multi-provider credential vault is not
required for the first release.

`IpNetwork` is sensitive authority and normally requires administrator approval.
Installing the shim does not make network access available to ordinary users
without that approval. Existing restrictions on the granted network capability
remain applicable.

The IP schema explicitly supports driver apps that re-export protocols as Cap'n
Proto capabilities. It also describes an optional HTTP-bridge network proxy.
Neither mechanism should be assumed to provide all of the native outbound
driver's security guarantees on every older release.

## Compatibility gate: prove this before building the driver

Choose and record the oldest supported Sandstorm release. Run it in an isolated
installation with the native `OutboundHttpSession` provider absent.

Build a minimal shim grain and consumer to verify:

1. An unknown interface ID can be advertised through
   `UiView.ViewInfo.matchRequests` and discovered by Powerbox.
2. `UiView.newRequestSession()` receives the descriptor and preserves its tag
   payload, including the authentication declaration.
3. The shim can fulfill the request through `SessionContext.fulfillRequest()`
   with a capability implementing the current outbound schema.
4. The consumer can call that capability, save it, and restore it after both
   grains restart. Exercise `AppPersistent` and `UiView.restore()` rather than
   relying on a live in-memory object.
5. The chosen Rust/RPC stack interoperates with the old supervisor for inherited
   ByteStream methods, pipelining, cancellation, and capability release.
6. The user can separately grant the shim network access and retain it across
   restarts using `SandstormApi.save()` and `restore()`.

Vendor the exact current outbound schema, including interface IDs and method
ordinals. A server should not need generated bindings for an app-defined
interface just to relay its capability, but this must be demonstrated on the
target version. Do not describe old-server compatibility as verified beforehand.

## Powerbox behavior

The consumer supplies a valid `baseUrl`, allowed methods, and exactly one
authentication mechanism. Require explicit `none` for unauthenticated APIs.
Never reinterpret an unsupported mechanism as anonymous or caller-managed access.

Advertise the shim using the outbound interface tag. Determine through the
compatibility spike whether matching can narrow candidates by the configured
endpoint. Regardless of matching behavior, validate the complete descriptor in
the shim before offering a grant. Powerbox discovery is not an authorization
check.

Respect descriptor composition: constrain conjunctions by intersection and keep
alternatives separate. Do not combine permissions from different authentication
or endpoint alternatives. Reject ambiguous declarations until their semantics
are explicitly supported.

The request UI should follow the native presentation:

- Show the requested endpoint read-only and the effective HTTP methods.
- Collect credentials inside the shim's UI, not the consumer's frame.
- Show credential placement, e.g. `Authorization: Bearer [value]` or
  `x-api-key: [value]`, without rendering the supplied secret.
- Identify the shim grain as the credential holder. Do not claim that the native
  Sandstorm credential store holds these secrets.
- Explain that revoking a connection does not revoke the provider credential or
  credentials already held by another app.

Do not offer arbitrary destination editing during this request. Configure a
different endpoint in the consuming app before issuing another Powerbox request.
The existing Powerbox selection step remains intact.

Only users with an explicit connector-management permission may configure or
delegate the shim's grants. A read-only share of its UI must not authorize secret
replacement, endpoint changes, or capability issuance.

## Transport choice

Start with a Rust app using the same Cap'n Proto crate generation as OpenAI
Gateway. Prototype an async I/O adapter over `TcpPort.connect()` and use a mature
HTTP client/parser over that transport. Do not implement an HTTP parser manually.

Evaluate two connection options during the spike:

1. TLS-enabled `IpNetwork`: the platform handles TLS, while the shim sends HTTP
   over the resulting byte stream. Verify hostname authentication, SNI, trust
   roots, error handling, and policy behavior on each supported server version.
2. Plain `IpNetwork` plus TLS inside the grain: wrap the capability stream in a
   maintained TLS implementation and verify the original endpoint hostname. This
   gives the shim control over TLS behavior but adds packaging and trust-store
   maintenance, and may complicate address-policy enforcement.

Prefer the first option if its verified guarantees are sufficient. Never double
wrap a TLS network capability, disable certificate verification, or fall back to
plaintext after a failed TLS connection. Do not assume ordinary grain sockets
have internet access. Using the HTTP bridge's network proxy is an alternative
only after its old-release behavior and authority boundaries are verified.

Begin with HTTP/1.1, no automatic redirects, no automatic retries, and no connection
pool shared across grants. Preserve response status, repeated headers, compressed
wire bytes, and arbitrary response content types, including SSE.

Implement both outbound methods:

- `request()` accepts a bounded buffered body and streams the response.
- `requestStreaming()` supplies a `RequestStream`; inherited `expectSize()`,
  `write()`, and `done()` implement upload framing and backpressure, while
  `getResponse()` exposes response headers even if an upload is still pending.

Retain the request-stream lifetime and cancellation semantics used by consumers.
Propagate receiver failures, release resources on cancellation, and call response
`done()` only after a complete response. A truncated stream must fail visibly.

## Grant and credential storage

Persist a versioned grant record containing:

- Opaque grant ID, enabled/revoked state, and generation.
- Canonical origin and path prefix, with allowed methods.
- Authentication declaration and private credential reference.
- Administrative owner/permission requirements and the saved network token.

Keep credential material separate from public grant descriptions and persistent
object IDs. Restoration must look up an existing authorized grant; it must never
construct authority from caller-supplied paths, methods, or credential IDs.

Store secrets only in the shim's private persistent storage. If encrypted at rest
inside the grain, use authenticated encryption, separate key handling, and
versioned records. A key stored in the same grain does not protect against a
compromised shim or a readable grain backup; encryption must not be advertised as
equivalent to the native credential-custody design.

Use independent grant IDs for separate delegations. Local revocation must prevent
new calls and restored capabilities, and cancel active requests for that grant.
Do not assume that dropping one consumer's saved reference revokes every other
reference. Provider-key rotation and local grant revocation are separate actions.

Verify platform permission revocation and upstream `IpNetwork` revocation on the
old server, including already-derived TCP capabilities and active connections.
Define and document the observed revocation boundary. If the old platform cannot
provide equivalent transitive revocation, treat that as a compatibility/security
limitation, not something the shim can silently promise to solve.

## Security requirements

- Bind every grant to an exact origin and a path prefix at a slash boundary.
  `/v1` may cover `/v1/responses`, but not `/v10` or another origin.
- Reuse the native driver's URL/path rejection rules and regression cases,
  including dot segments, encoded separators, userinfo, and malformed escapes.
- Validate header names/values and reject framing, hop-by-hop, cookie, and other
  reserved headers. Prevent consumers from overriding managed authentication.
- Credentials require HTTPS. Keep the first release HTTPS-only even for `none`.
- Never follow redirects with credentials. Do not return secret-bearing transport
  errors or include credentials in logs, object IDs, URLs, or diagnostics.
- Establish how the granted network capability handles private addresses, DNS
  rebinding, and address selection. Broad `IpNetwork` authority is not proof of
  SSRF safety. Default to public destinations; defer LAN access until an explicit
  policy can be enforced without DNS check/connect races.
- Bound request sizes, response buffering, queued writes, concurrent operations,
  total stream bytes, and setup/idle/overall deadlines. Apply limits across grants
  as well as per grant, and account for RPC decoding overhead.
- A remote API can echo a credential or issue another credential to the consumer.
  Secret custody does not imply that authorized consumers can never recover a
  usable secret. It also does not impose a provider spending limit.
- A compromised shim exposes its credentials and its granted network authority.
  Keep initial grains narrowly configured and avoid a shared administrator-owned
  vault serving unrelated users.

## Implementation phases

### 0. Compatibility spike

Complete the old-server tests above with an echo capability and one HTTPS request.
Select the transport adapter and TLS arrangement. Record supported release(s),
network policy, revocation behavior, and any protocol blockers. Stop and revise
the design if old Powerbox/persistence cannot carry the required capability.

### 1. Minimal usable shim

Implement the grant UI, persistent grants, and endpoint/method enforcement.
Support `bearer`, `apiKey` in an allowed header, and explicit `none`. Implement
buffered JSON requests, ordinary HTTP error responses, and streamed responses.
Implement the upload-stream interface needed by OpenAI Gateway, including known
length uploads and cancellation. Fail unsupported authentication explicitly.

### 2. Lifecycle and hardening

Finish restart/restore behavior, independent grant revocation, permission checks,
resource limits, DNS/TLS policy, and interrupted-stream handling. Test concurrent
consumers and ensure revoking one grant does not cancel unrelated grants.

### 3. Compatibility release

Package the app with clear administrator setup instructions and an explicit
support matrix. Run OpenAI Gateway unchanged on an older server using the shim,
then on a newer server using the native provider. Switching providers requires a
new Powerbox connection; do not automatically export credentials or translate
saved capability tokens between implementations.

### 4. Optional additional mechanisms

Add Basic, raw Authorization, and named Authorization schemes as needed. Query
credentials, S3 SigV4, OAuth acquisition/refresh, client certificates, WebSockets,
LAN endpoints, and provider-specific protocols are separate extensions. Do not
advertise native feature parity until each mechanism has conformance coverage.
Path-secret substitution remains deferred, matching the native project's scope.

## Validation and completion criteria

Use native-driver behavior as the contract, extracting reusable request/response
fixtures where practical rather than duplicating transport internals.

Required coverage includes old-server Powerbox discovery/fulfillment; grants that
survive both grain restarts; scoped URL/method/header rejection; hostname/certificate
failures; redirect refusal; JSON success and provider errors; SSE backpressure;
early responses during upload; length mismatch; truncation; timeout; cancellation;
grant isolation; and local/platform/network revocation behavior.

An initial end-to-end smoke test can use a deliberately invalid provider key and
verify its expected 401 response without a billable model request. Use controlled
fixtures for streaming, credential injection, and failure cases. Any paid-provider
test requires an explicitly supplied test credential and bounded usage.

The first release is complete when OpenAI Gateway works without a consumer-side
shim code path on the recorded old server, the supported mechanisms pass the
conformance cases, and all deviations from native security and lifecycle behavior
are documented. No native-server changes should be required merely to install or
select the shim.

## Local references

- [Outbound interface](../../src/sandstorm/outbound-http-session.capnp)
- [IP capabilities](../../src/sandstorm/ip.capnp)
- [Powerbox protocol](../../src/sandstorm/powerbox.capnp)
- [Grain and persistence interfaces](../../src/sandstorm/grain.capnp)
- [Native HTTP API documentation](http-apis.md)
- [Native security review](http-outbound-security-review.md)
- [Query credentials and S3 signing](outbound-query-and-sigv4.md)
