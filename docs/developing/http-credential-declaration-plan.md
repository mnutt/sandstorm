# Declarative external HTTP connections

Status: deferred by user decision, November 1, 2026.

The generalized form/source/binding design below is retained for future discussion,
not the current implementation contract. The prototype has been removed from the
active change set; a checkpoint is preserved outside the checkout in
`/tmp/sandstorm-deferred-declarations/`.

The approved current direction is to use OutboundHttpSession for third-party APIs,
while retaining ApiSession for grain APIs and existing integrations.
Keep simple managed Bearer, Basic, named-header keys, and raw or
named-scheme Authorization. Ordinary organization/project/version headers belong in
grain requests. Complex OAuth and signing can live in grains using scoped outbound
capabilities. ApiSession uses its existing inherited WebSession methods;
both drivers share the internal transport.
Preserve HTTPS, confinement, encryption, redaction, revocation,
stream cancellation and credential-header immutability. See the transport parity
checklist for the active scope.

## Problem and evidence

The API inventory separates several concerns which the existing form conflates:
what values are needed, how credentials are obtained, and how requests authenticate.
A bearer token is a wire format, not necessarily an API key or an OAuth grant.
Alternatives are OR; credentials within a complete alternative are AND.

| Pattern | Inventory examples | Required mechanism |
| --- | --- | --- |
| Anonymous | Crossref, arXiv, public OSM | Explicit anonymous alternative; client identification |
| Static credentials | OpenAI, GitLab, Zulip | User inputs and typed header/Basic bindings |
| Non-Bearer Authorization | Linear, Discord | Raw Authorization and named schemes |
| Compound credentials | Supabase, Apple Music, Plaid | Multiple sources in one alternative |
| URL credentials | Telegram, Mapbox, incoming webhooks | Query/path binding or exact secret-URL capability |
| Acquired tokens | Google, Microsoft, Spotify, PayPal | OAuth source independent of token placement |
| Generated tokens/signatures | Ghost, GitHub Apps, S3, Flickr | Trusted token generator or request signer |
| Protocol authentication | Home Assistant WebSocket, Discord Gateway | Protocol-specific adapter |

Representative primary documentation checked in the preceding review:

- [Linear](https://linear.app/developers/graphql): raw personal-key Authorization versus OAuth Bearer.
- [Supabase](https://supabase.com/docs/guides/getting-started/api-keys): project key plus user identity.
- [Plaid](https://plaid.com/docs/api/): multiple credentials and JSON/header placement.
- [Telegram](https://core.telegram.org/bots/api#making-requests): credential inside URL path.
- [Ghost](https://docs.ghost.org/admin-api): generated JWT with Ghost authorization scheme.
- [AT Protocol](https://atproto.com/specs/oauth): PAR, PKCE, DPoP and nonce state.
- [Amazon SP-API](https://developer-docs.amazon/sp-api/docs/connecting-to-the-selling-partner-api):
  acquired tokens in x-amz-access-token, including restricted-data token substitution.
- [OAuth security BCP](https://www.rfc-editor.org/rfc/rfc9700.html).

These examples establish schema requirements, not verified compatibility with every
provider. Availability, approval, billing, account restrictions and inbound delivery
remain separate integration reviews. An authentication implementation does not imply
support for uploads, custom DAV verbs, WebSockets, webhooks or browser pickers.

## Model

The app declares a versioned connection specification. Sandstorm owns validation,
credential collection, encryption, destination approval and request construction.
The declaration contains no secrets, executable code or general-purpose templates.

1. Targets: stable ID, exact base URL/path boundary, explicitly allowed HTTP methods.
2. Alternatives: stable ID and plain-text label; each is a complete way to connect.
3. Inputs: stable ID, label, description, text/secret/choice type, required flag,
   bounded lengths, and finite choice values where applicable.
4. Sources: initially manual secret input; later OAuth and trusted token generators.
5. Bindings: target ID, typed placement, and references to input/source/literal values.

References are local to one alternative, never IDs for arbitrary existing broker
credentials. Reusing a stored account requires a later broker-owned authorization flow.
An optional absent input omits its binding only when that binding explicitly permits
omission. Empty literals remain distinct from absent input (e.g. a Basic password).
Unknown versions, features, sources, references and bindings must fail closed.

The common one-key connection remains one input and one binding. API version headers
are literals, not questions. All entered values are encrypted, not only password
controls. Secret inputs have no defaults and are masked. Labels describe actual
credentials (API key, personal token, email, application password), rather than forcing
all Bearer values to be called API keys. Sandstorm always shows the actual destination
and granted authority in trusted UI, independently of app-authored labels.

The UI displays one form. No app-requested-versus-authentication split is necessary.
Only multiple alternatives produce a selector. Switching alternative or destination
clears all entered values. OpenAI organization/project settings are ordinary optional
inputs declared by the app; no provider assumptions belong in the renderer.

## Phase 1: manual connections

Implement a new optional PowerboxTag `connection` struct without renumbering existing
fields. Require `authentication = "declarative-v2"` and no legacy method/field/OAuth
lists for this form. Older drivers reject the unknown hint instead of presenting an
anonymous downgrade. Version and required-feature validation remain mandatory on the
new driver. Declarations use explicit driver OR semantics, not generic list matching.
Return an ApiSession descriptor without entered values or copied alternative lists;
form configuration is not an advertisement of cumulative API requirements.

The first increment deliberately supports one target and the existing ApiSession
GET/POST/PUT/DELETE methods. Target is fixed by the declaration. Multiple origins,
user-selected destinations, custom verbs and discovery must not be silently accepted.

Support:

- Text, masked secret and finite choice inputs, with bounded display metadata/values.
- Manual sources referencing local secret inputs, and non-secret literal values.
- Named headers (reserved transport/browser/identity headers remain forbidden).
- Authorization with a validated scheme, raw Authorization, and Basic username/password.
- Multiple simultaneous bindings with case-insensitive duplicate-target rejection.
- Explicit anonymous alternatives; no fallback to anonymous when declarations are invalid.
- Optional settings whose absent values omit the entire binding.
- Server-side compilation into an immutable grant containing only approved headers,
  allowed methods and authentication status. Encrypt all compiled values using the
  existing authenticated settings envelope, never a plaintext declaration field.
- Existing HTTPS, path confinement, no redirect following, header override protection,
  policy lookup, secret redaction, revocation and stream cancellation requirements.

Finish phase 1 by documenting actual wire examples and migrating llm-proxy's request
builder/vendor schema. Keep that separate from committing unrelated app checkout work.

## Phase 2: URL placement and richer routing

Add query credentials with reserved parameter collision checks and end-to-end URL
redaction. Add structured path components with fixed origin and component encoding;
do not allow arbitrary secret interpolation into URLs. Treat incoming webhook and
presigned URLs as exact secret-URL capabilities (signed URLs must retain their exact
encoding and query semantics). Define method/path attenuation and explicit multi-target
credential audiences before exposing multiple origins. No wildcard credential forwarding.

Endpoint selection and sandbox/production selection change grants, not merely labels.
Discovery and returned instance/upload URLs need validated provenance and cannot widen
a grant silently. LAN reachability and local certificate trust are separate policies;
apps cannot set TLS verification bypass flags.

## Phase 3: OAuth sources and credential lifecycle

Implement authorization code with PKCE and client credentials using a shared protocol
engine. Configuration includes issuer or validated discovery, authorization/token
endpoints, client-registration reference, scopes, resource/audience, token endpoint
client authentication, and supported request encoding. Common OAuth providers should
use configuration, not require a new hand-written driver each time.

Client registration belongs to the broker/operator or an explicitly authorized user
setup. App code cannot borrow unrelated OAuth client secrets, existing accounts or
login-provider credentials. Token-endpoint authentication is distinct from resource
request authentication. User-visible consent must name the issuer, target and scopes.

Use mutable authenticated-encryption storage with fresh nonces. Store access token,
refresh token, expiration, account/issuer/audience binding and lifecycle state. Serialize
refresh for a shared grant, atomically retain rotated refresh tokens, and define
crash/retry/re-authentication behavior. Never repeatedly overwrite the legacy immutable
nonce-zero credential field with refreshed secrets. Support revocation and reuse without
returning raw tokens to grains. Implement current OAuth security BCP, including exact
callbacks, session binding, PKCE and mix-up defenses. DPoP remains a separate extension.

## Phase 4: trusted adapters

Add concrete integrations for generated JWTs, SigV4, OAuth 1 signing, DPoP/PAR,
provider-specific exchanges, body credentials and protocol handshakes. A signer sees
the final URL/method/headers/body; it is not a general signing oracle. JSON/form bindings
must enforce content type, size and duplicate-field rules; streaming/multipart bodies
need an explicit compatible model. Proof keys and client certificates remain broker-owned.
Provider adapters may produce operation-specific restricted tokens but must not expand
the grant. Webhook verification is a separate inbound capability.

## Validation and rollout

- Exercise manual single-key, Basic key/empty password, raw Authorization, named scheme,
  compound headers, constants, optional fields, explicit anonymous and alternative switching.
- Round-trip the actual Cap'n Proto schema and test absent/unknown/mixed declarations.
- Reject unknown references, unsafe names, duplicate writers, injected control characters,
  unsupported methods/targets/features, unexpected form values and anonymous secret bindings.
- Test encryption/save/restore, legacy compatibility and descriptors free of entered values.
- Test real local HTTPS and CONNECT proxy requests, overrides, destination confinement,
  redirects, redacted failures, grant revocation and active stream cancellation.
- Render the actual form branches at narrow/desktop widths; run a deployed browser/Mongo
  integration before calling this production-ready. Keep generation/build artifacts current.
- Future OAuth tests must include rotation races, expiration, issuer mismatch, callback
  replay, failed refresh and revocation during exchange.

No form field or account selector establishes resource isolation by itself. Provider
permissions and actual broker checks determine authority. A destination can reflect an
injected credential, so Sandstorm cannot promise that an app can never recover it.
