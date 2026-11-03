# Outbound HTTP security review

November 1, 2026. Review of the uncommitted implementation on
`api-session-powerbox-auth`; this is an implementation review, not an independent audit.

ApiSession-specific enhancements have since been [parked separately](api-session-deferred.md).
The active implementation and tests below concern outbound grants; ApiSession retains
its committed independent driver and schema. The separated suite passes 96 tests,
including the existing ApiSession regression tests. The original 107-test run below
records the review before that separation.
The two isolated browser tests also passed again after the separation against a fresh bundle.

November 2 extension: [managed query placement and S3 SigV4](outbound-query-and-sigv4.md)
now have 105 passing standalone tests and four passing browser tests (11 assertions).
Path placement, signed chunks and automatic credential renewal remain deferred.

## Findings corrected

- **Powerbox method attenuation:** intersecting canonical outbound options changed the
  frontend reference but left the credential form's method list unchanged. The form now
  receives the attenuated methods. Regression tests cover outbound method composition.
  The corresponding ApiSession enhancement is deferred with that driver work.
- **Authentication alternatives:** options for the same URL but different authentication
  declarations could merge their method permissions. Option identity now incorporates
  the normalized authentication declarations so these alternatives remain separate.
  Distinct declaration sets fail closed during conjunction rather than computing partial overlaps.
  Subsequent tightening requires exactly one explicit mechanism per new request,
  including `none`. Multiple mechanisms and missing declarations are rejected;
  the credential form no longer offers an authentication selector.
- **Error disclosure:** frontend-reference validation errors serialized untrusted request
  objects that could contain credentials. These errors now return generic messages;
  a regression test checks that secret values are absent.

## Validation

- 107 standalone tests passed, covering authentication, confinement, TLS/proxy behavior,
  encrypted persistence, revocation, stream cancellation, byte/concurrency limits,
  deadlines, Powerbox composition, and native Node/C++ streaming RPC.
- Two browser tests passed (five assertions) against the rebuilt fast tarball using
  isolated Sandstorm, MongoDB and Chrome. The existing outbound regression passed.
  The managed test renders the real credential form, calls `newFrontendRef` over DDP,
  verifies ciphertext in MongoDB and clearing of the password input, claims and restores
  a durable grant, and sends an authenticated request to a local HTTPS fixture. It also
  rejects unauthorized methods and credential overrides, then verifies that root
  revocation blocks requests, saves and child restoration.
- Temporary Powerbox handoffs intentionally copy into durable grants when claimed.
  Revoking the disposable handoff does not revoke its claimed copy. The test checks
  revocation of the durable root and its descendants instead.
- Targeted ESLint completed without errors (four warnings); `git diff --check` passed.

The browser fixture uses test-only credentials and certificates and is registered only
in testing mode. It does not exercise a complete grain-driven Powerbox popup/install
journey, a live provider, OAuth consent or billing. No production service was deployed.

## Remaining boundaries

- Admission and retained-buffer limits are process-local. Accounting starts after RPC
  decoding and does not bound total heap, parser/socket buffers or consumer-held results.
  Fixed transfer limits are not provider-spending or per-account bandwidth budgets.
- Active revocation checks poll every second plus database latency. Cancellation cannot
  undo requests already accepted upstream. Explicit release and deadlines supplement
  the current capnp-es limitations on incoming RPC cancellation propagation.
- Direct connections pin policy-approved addresses and validate the original TLS host.
  Proxy deployments retain responsibility for destination DNS/network policy.
- Redirects are returned, not followed. Connection pooling across requests and HTTP/2
  remain disabled. Exact signed-URL/path preservation needs separate work.
- DAV verbs, WebSockets, private-network onboarding, mTLS, request signing, generalized
  credential declarations and generic OAuth brokerage are separate integration work.
  Existing external ApiSession streaming-upload implementation is also separate.

No failing check remains in this validation scope. The changes remain uncommitted;
these results do not establish compatibility with every provider in the inventory.
