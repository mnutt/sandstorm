# Managed query credentials and S3 SigV4

These mechanisms belong to OutboundHttpSession. ApiSession enhancements remain deferred.
Requests still declare exactly one authentication mechanism; a mechanism can require
several related credentials. Secret path placement is intentionally not implemented.

## Query parameter credentials

```js
{
  baseUrl: "https://api.example.com/v1",
  methods: ["get"],
  authenticationMethods: [{ kind: "queryKey", parameterName: "api_key" }]
}
```

Sandstorm collects one secret and appends it as an encoded query parameter value.
The name must contain only ASCII letters, digits, underscore, dot, tilde or hyphen,
with a maximum length of 64. Existing query bytes are preserved. Caller parameters
with the same decoded name (case-insensitive) are rejected before network lookup.
This is whole-value insertion, not an arbitrary URL template.

The secret is stored in the existing authenticated encryption envelope. It is added
only after network-policy lookup and authorization checks; policy lookup receives
the URL without the secret. Transport errors do not expose the generated URL.
The approved destination can still log, redirect with, or return the credential.
Redirects are returned without being followed. HTTPS is required.

## S3-compatible Signature Version 4

```js
{
  baseUrl: "https://my-bucket.s3.us-east-1.amazonaws.com",
  methods: ["get", "head", "put", "delete"],
  authenticationMethods: [{
    kind: "sigV4",
    region: "us-east-1",
    allowUnsignedPayload: false
  }]
}
```

`sigV4` currently means the S3 signing variant, with service fixed to `s3`.
Custom HTTPS endpoints and signing regions such as `auto` are accepted for compatible
providers. Credentials are access key ID, secret access key and optional session token.
All fields are stored encrypted; the secret access key is used for signing and is
never sent as a credential header. Region and unsigned-payload permission are bound
to the saved credential configuration and must match the declaration.

Buffered requests hash their exact request body. The signer runs immediately before
dispatch, after the driver has supplied the final Host and Content-Length. It signs
the method, canonical path/query, supplied headers, timestamp and payload hash.
All supplied request headers are signed, including S3 metadata headers. The driver
owns Authorization, X-Amz-Date, X-Amz-Content-Sha256 and X-Amz-Security-Token; attempts
to override signing fields or supply X-Amz-* query parameters are rejected.

The grant does not follow region redirects or retry a signed request automatically.
The app must request the correct endpoint and signing region.

### Streaming uploads

By default `requestStreaming` is rejected for SigV4. An app can explicitly request
`allowUnsignedPayload: true`; the form discloses that policy. The grain must call
`expectSize(totalBytes)` before the first write, including `expectSize(0)` for an empty
stream. This emits a known-length HTTPS upload with `UNSIGNED-PAYLOAD`. Providers or
bucket policies that require signed bodies will reject it; there is no silent fallback.
Buffered requests remain body-hashed even when unsigned streaming is allowed.

AWS signed chunks, trailers, SigV4a, generated presigned URLs, automatic STS acquisition
and credential refresh are not implemented. Supplied temporary credentials work until
the provider expires or revokes them; the user must supply replacements.

### Scope and compatibility

The existing URL-confinement rules remain in force. Accepted object paths preserve
repeated slashes and percent encoding; dot segments, encoded slashes/backslashes and
leading-slash relative paths are rejected. Consequently, some valid S3 object names
are deliberately unsupported. No generic path normalization is added for S3.

URL and method scope are not a complete S3 permission model. Listing, copy-source,
bucket subresources and other query/header semantics can refer to authority beyond
an apparent object prefix. Use provider IAM policies restricted to intended buckets,
prefixes and actions. A path-prefix grant must not be described as a complete S3 sandbox.

Tests cover AWS's published signature vectors, local HTTPS wire requests, duplicate
query parameters, secret encoding, credential override rejection, encrypted persistence,
schema round-trips and the credential form. Provider compatibility beyond these tests
requires testing the selected provider and payload policy.

Validation on November 2, 2026: all 105 standalone regression tests passed, including
four AWS reference signatures. The native build and fast test bundle build passed.
Four isolated browser tests passed (11 assertions), covering the existing outbound
regression and bearer/query-key/SigV4 form submission, encrypted MongoDB persistence,
capability restoration, HTTPS requests and revocation. Targeted lint had no errors.
No live AWS or other provider account was used.

References: [AWS canonical requests and reference vectors](https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html),
[AWS signed streaming](https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sigv4-streaming.html).
