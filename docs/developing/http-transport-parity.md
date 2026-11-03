# Outbound HTTP implementation plan

Active plan, November 1, 2026. Generalized forms, sources and bindings are deferred;
see [the deferred declaration plan](http-credential-declaration-plan.md).

## Contract

OutboundHttpSession is the preferred interface for third-party HTTP APIs. ApiSession
remains the grain API contract; existing external ApiSession grants remain supported.
No new ExternalApiSession/HttpApiSession interface is introduced. ApiSession keeps its
inherited WebSession methods without adding request/requestStreaming.
The drivers remain independent. Both already use the low-level HTTP transport module,
but ApiSession does not inherit the outbound driver base or gain its new lifecycle behavior.
Uncommitted ApiSession enhancements are [parked for later work](api-session-deferred.md).

Sandstorm-managed credential custody is an opt-in facility that apps should prefer
where supported. Apps choose one explicit mode: managed authentication, `caller` for
app-managed credentials, or `none` for unauthenticated APIs. Powerbox explains custody
and access; the user supplies any requested credentials and approves the grant.
Managed custody reduces secret exposure but does not limit provider authority or spending.

Managed sessions inject credentials and reject attempts to override managed headers.
Explicit caller-auth grants accept grain-owned credentials within the approved HTTPS
URL and method scope. Legacy OutboundHttpSession grants retain their prior behavior,
including HTTP support. Token endpoints need separately scoped grants.

Ordinary organization, project and API-version metadata belong in grain request
headers. New outbound generalized field requests are rejected. ApiSession retains
its committed behavior, including its older provider-specific connection settings.

## Implementation status

| Capability | External ApiSession driver | OutboundHttpSession |
| --- | --- | --- |
| Requests | Existing get/post/put/delete | Existing request/requestStreaming |
| Status and response headers | WebSession response union and API metadata whitelist | Numeric status and end-to-end headers |
| Buffered uploads | Implemented | Implemented |
| Streaming uploads | Existing postStreaming/putStreaming declarations; implementation pending | Implemented |
| Streaming responses | SSE; other bodies buffered | Any MIME type |
| Backpressure and receiver failure | Implemented for SSE | Implemented |
| Grant revocation and session close | Session close cancels operations; live polling deferred | Cancel active operations |
| URL confinement, DNS/proxy/TLS policy | Shared transport | Shared transport |
| Redirects | Returned, never followed | Returned, never followed |

## Delivery sequence

1. Managed OutboundHttpSession authentication: reuse trusted credential UI and validation
   for Bearer, Basic, named-header keys and raw/named Authorization. Store the entire
   credential in a randomized authenticated envelope bound to URL/method scope; reject
   plaintext saved credentials. This slice is implemented with focused tests.
2. Undici Dispatcher migration: implemented behind the shared transport interface.
   Direct requests use a per-request Client with a connector restricted to the
   policy-approved IP and original-host TLS validation. ProxyAgent handles HTTP
   forwarding and HTTPS CONNECT. Bounded upload/response streams propagate backpressure.
   No fetch conversion, redirect/retry interceptors, connection pooling across requests,
   or HTTP/2 negotiation. Existing lifecycle deadlines remain in force.
   Tests cover TLS trust/hostname failures, early final responses during uploads,
   compressed wire bytes, duplicate headers, POST failures, proxies and RPC cancellation.
3. Known-length streaming uploads and phase deadlines: implemented. Existing ByteStream
   expectSize sets Content-Length before the first write; late announcements enforce the
   remaining byte count without changing headers. done waits for transport upload completion.
   Setup and response-header waits are bounded at 120 seconds each. Uploads have a
   ten-minute absolute limit and a sixty-second idle limit, reset by bytes sent. Response
   streaming retains its separate ten-minute/sixty-second bounds. Duplex response activity
   cannot keep a stalled upload alive.
4. Concurrency limits: implemented for outbound requests at sixteen per live session and
   sixteen per validated saved-token ancestry root, shared across restored/delegated sessions
   in a shell process. All shared-transport operations also have a process-wide cap of 256,
   including pending DNS/authorization. Slots are released on success, failure or cancellation.
   Unsaved grants have session/process caps. These are process-local admission limits, not
   distributed accounting or billing budgets.
   Byte limits are now implemented: 8 MiB buffered outbound requests, 16 MiB buffered
   responses, 1 MiB streaming write chunks, 4 MiB or 64 outstanding upload writes,
   and 8 GiB total upload/response bytes per request. The process has a shared 64 MiB
   budget for retained buffered requests, queued upload data and buffered-response assembly.
   Buffered requests are pumped in bounded chunks without delaying response headers.
   Cancellation/limits release reservations and fail the stream without done().
   Exact signed-path behavior remains separate work.
5. DAV methods, then WebSockets and provider-specific auth as integrations require them.

Managed query-parameter credentials and S3-compatible SigV4 are now implemented;
see [their scope and limitations](outbound-query-and-sigv4.md). Secret path placement,
signed streaming chunks and automatic temporary-credential renewal remain deferred.

Improving ApiSession's existing streaming implementations remains separate work.
The WebSession response model is not a lossless HTTP transport contract.

## Outbound security invariants

- Managed Bearer, Basic, named-header keys, raw Authorization, and named-scheme
  Authorization remain shell-collected, encrypted and destination-bound.
- Exactly one declared mechanism shows its credential controls; explicit `none` shows
  no credential fields. Missing, multiple and unknown mechanisms are rejected.
- HTTPS is mandatory for managed credentials, including restored grants.
- Hop-by-hop, Host, framing, proxy and forwarding headers remain platform-controlled.
- Each request repeats policy lookup/address pinning; proxy policy is the existing
  deployment boundary. No redirect forwards credentials.
- Transport failures do not return raw exception text containing credentials.
- Live token ancestry/requirements are checked; active requests poll every second
  plus database latency. Cancellation cannot undo upstream actions already accepted.
- Stream failure releases without done; pending RPC writes are canceled where supported.
- The setup timeout remains bounded; active streams have total and idle limits.
- Complex authorization in a grain means that grain holds its secrets. Prefer scoped
  provider tokens and separately scoped outbound capabilities; do not imply broker custody.

## Verification and remaining limitations

Standalone Node tests cover managed credentials, caller-auth scope, provider headers,
TLS/confinement, encryption and revocation. Existing Node/C++ RPC tests cover ApiSession
SSE completion, failures and cancellation. Raw request/upload tests cover the
OutboundHttpSession interface, including managed known-length uploads.

A deployed browser/Mongo integration is distinct from standalone VM-boundary tests.
The isolated browser/Mongo integration now passes credential-form submission, encrypted
storage, durable grant claiming/restoration, authenticated HTTPS requests and revocation.
See [the security review](http-outbound-security-review.md) for scope and findings.
OutboundHttpSession is pre-production; compatibility must not constrain security fixes.
Buffer accounting begins after RPC decoding; it is not a bound on total shell memory.
RPC messages, socket buffers, parser allocations and results held by consumers have
their own lifetimes. Transfer limits count wire-body bytes without decompression.
Repeated requests can each consume their allowance: these are resource protections,
not per-account bandwidth or provider-spending quotas. Limits are currently fixed in
the server; larger transfers require a deliberate policy change.
WebSockets, DAV methods, generic signing/OAuth brokerage, generalized forms and
response-size/billing budgets remain out of scope. Incoming RPC cancellation propagation
is limited by capnp-es; explicit capability release and deadlines provide cancellation.
