# Outgoing HTTP

## External HTTP and credential custody through OutboundHttpSession

Prefer Sandstorm-managed credentials where supported. Apps opt into this facility
by declaring a managed authentication mechanism: Sandstorm collects, encrypts and
injects the credential, while the grain holds a capability to use it. This reduces
credential exposure and centralizes revocation of access through that capability.
It does not prevent the grain from exercising the credential's authority, including
changing data or spending money. The destination receives the credential and could
return it to the grain; managed custody is not a guarantee against that disclosure.

Apps choose exactly one mode before opening Powerbox:

| Mode | Declaration | Who holds the credentials? |
| --- | --- | --- |
| Sandstorm-managed | `bearer`, `basic`, `apiKey`, `rawAuthorization`, `authorization`, `queryKey`, or `sigV4` | Sandstorm collects credentials and injects them or signs requests. |
| App-managed | `caller` | The grain obtains, stores and sends them. Sandstorm collects none. |
| Unauthenticated | `none` | No credentials are needed or collected. |

Caller authentication is a supported choice when an integration needs its own
credential lifecycle or authentication protocol. It retains destination and method
restrictions, HTTPS requirements, revocation and transport limits. Opting out of
managed custody does not grant unrestricted network access. This facility provides
HTTP credential injection, not a general-purpose secret store.

For third-party HTTP APIs, request `OutboundHttpSession` (interface ID
`0xbf91271b527d6f33`) with an `OutboundHttpSession.PowerboxTag`, for example:

```js
{
  baseUrl: "https://api.example.com/v1",
  methods: ["get", "post"],
  authenticationMethods: [{ kind: "bearer" }]
}
```

The Powerbox collects the credential in Sandstorm's UI. The resulting capability's
`request` and `requestStreaming` methods inject it; the grain receives no credential.
Supported mechanisms are `none`, `bearer`, `basic`, `apiKey` with `headerName`,
`rawAuthorization`, `authorization` with a scheme such as `Bot`, `queryKey`, `sigV4`, and `caller`.
See [query placement and S3 SigV4](outbound-query-and-sigv4.md) for their declarations,
streaming policy and compatibility limits. Secret path placement remains deferred.
Declare exactly one mechanism. Its credential controls are shown directly; `none`
shows no credential fields. Missing or multiple mechanisms are rejected. The app
selects the mechanism before opening Powerbox. Provider metadata belongs in ordinary
per-request headers.

Managed grants require HTTPS, including after restore, and reject caller overrides of
Authorization and managed key headers. The whole credential, including Basic username,
uses a randomized AES-GCM envelope keyed by the sturdy ref and authenticated against
the destination and method scope. Plaintext stored credentials are rejected. Destination/method restrictions,
redirect handling and revocation apply to both buffered and streaming requests.

Existing saved grants retain their behavior, including legacy HTTP grants. New requests
must explicitly declare a mechanism; use `none` for unauthenticated APIs. Explicit `caller` grants
require HTTPS. Older servers ignore the new declaration field and do not provide
managed authentication; applications must not treat a completed Powerbox request alone
as proof that the server supports it. No generic OAuth flow is added here;
the managed signer currently supports only S3-compatible SigV4.

ApiSession remains available for grain-provided APIs and existing external integrations.
ApiSession enhancements are maintained separately above this branch.

For app-managed authentication, use the same interface with an explicit caller grant:

```js
{
  baseUrl: "https://api.example.com/v1",
  methods: ["get", "post"],
  authenticationMethods: [{ kind: "caller" }]
}
```

The grain supplies its credentials in requests. Token endpoints need separately
scoped grants. Revoking this capability blocks access through it; it neither erases
credentials held by the grain nor revokes them at the provider.

The outbound HTTP driver uses Undici's low-level dispatcher through its transport.
Direct connections pin the policy-approved IP while validating TLS against the original
hostname. Configured proxies retain responsibility for destination DNS/network policy.
The adapter preserves compressed response bytes and does not automatically follow
redirects or replay failed requests. Each request owns its dispatcher; cross-request
pooling and HTTP/2 remain disabled. Existing total/idle deadlines and revocation checks
also cover RPC consumer stalls.

For known-length streaming uploads, call the returned RequestStream's inherited
`expectSize(size)` before its first `write()`. Sandstorm sends Content-Length and rejects
size mismatches. Late `expectSize()` calls specify the remaining bytes and must agree
with previous announcements; already-sent headers cannot change. `done()` waits until
the request body has been sent, rather than merely queued locally.

Setup and response-header waits each allow up to 120 seconds. Uploads allow ten minutes
total with a sixty-second idle deadline based on bytes sent. Response streams retain
their own ten-minute total and sixty-second idle deadlines. A duplex response does not
disable the upload deadline. Requests exceeding concurrency caps fail with `overloaded`:
sixteen outbound requests per session and per saved-token ancestry root, plus 256 shared
transport requests per shell process. Root limits cover restored/delegated sessions;
unsaved grants use session/process limits. These are not byte or spending budgets.

Body limits also apply: buffered OutboundHttpSession requests are limited to 8 MiB;
larger uploads must use requestStreaming(). Each streaming write may contain at most
1 MiB. Waiting for write completion provides backpressure; more than 4 MiB or 64 writes
outstanding on an upload cancels it. Each request allows up to 8 GiB uploaded and 8 GiB
received. Buffered transport response collection is limited to 16 MiB. OutboundHttpSession always streams its responses.

The shell tracks a shared 64 MiB budget for retained buffered request bodies, queued
upload data and buffered-response assembly, including the final contiguous copy.
Limits fail with overloaded errors; an already-started response stream is released
without done(), so clients must treat that as failure. These limits start after RPC
decoding and do not bound all shell/RPC/socket memory or cumulative provider spending.
They are fixed server policy for now and cannot be raised by an app's request.


New `OutboundHttpSession` Powerbox requests must supply a valid `baseUrl`. Sandstorm
shows that destination read-only and offers no custom-URL alternative. Apps that
support configurable providers should collect the URL before requesting access.
Missing or invalid destinations produce no outbound card; existing saved grants
continue to restore unchanged.

## Validation

Use Node 24 and installed shell dependencies:

```sh
NODE_PATH="$PWD/shell/node_modules" node --test tests/http-*.test.cjs
```

For the native RPC upload test, build `sandstorm-outbound-http-stream-probe` and set
`OUTBOUND_HTTP_STREAM_PROBE` to its executable path. The test otherwise skips the
native peer while still checking schema serialization.
