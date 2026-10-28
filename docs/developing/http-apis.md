Sandstorm apps may wish to respond to HTTP requests from Javascript code, native mobile apps, or
command-line tools, outside of the grain-frame. These clients sometimes need a permanent URL to
reach the app; the Sandstorm **HTTP APIs** feature allows apps to make specific parts of themselves
available this way.

## Overview

Sandstorm allows apps to expose their HTTP APIs at a permanent URL, as opposed to [ephemeral domains
used within the grain-frame](path.md). Sandstorm does access control on each inbound HTTP API
request to the app. Briefly:

- When Sandstorm receives a request for an app's HTTP API via a Sandstorm API subdomain, it verifies
  that the request has a valid API token, then passes it on to the app.

- When the app receives the HTTP request, the token has been removed and typical Sandstorm
  permission headers like `X-Sandstorm-User-Id` have been added instead.

- When the app responds, Sandstorm modifies some HTTP headers in the response, then passes the
  response to the client. This is flexible to any MIME type as well as to WebSockets.

**Try it now.** You can try making a request to a Sandstorm app's JSON API right now via `curl`:

```bash
curl -H "Authorization: Bearer 49Np9sqkYV4g_FpOQk1p0j1yJlvoHrZm9SVhQt7H2-9" https://alpha-api.sandstorm.io/
```

## Configuring an app to permit requests via the API subdomain

The handling of inbound HTTP API requests is configured in `sandstorm-pkgdef.capnp`. Look for this
line.

```bash
    # apiPath = "/api",
```

Before your app will accept requests on an API subdomain, you need to uncomment this line and
specify a string here. All inbound requests to the Sandstorm API subdomain for your app will have
their path prefixed by this string. The empty string (`""`) indicates that your app disallows API
requests; a single slash (`"/"`) indicates that your entire app should be available over the
Sandstorm API subdomain.

For apps not using `sandstorm-http-bridge`, read [the relevant Cap'n Proto
files](https://github.com/sandstorm-io/sandstorm/search?l=cap%27n-proto&type=Code&utf8=%E2%9C%93&q=ApiSession).

## How to generate an API token

Sandstorm uses API tokens to determine the which grain the user is requesting, the identity of the
user, and the permission level to apply to this request.

There are various ways to obtain an API token:

- **Recommended:** Client-side Javascript embedded within your app, aka *offer templates*. The app
  specifies some text which Sandstorm shows to the user, doing string substitution to add an API
  token to the text.

- The user can click the key icon in the top bar when they have an app open.

- Cap'n Proto RPC: Sandstorm's `HackSessionContext` exports a Cap'n Proto RPC method called
  `HackSessionContext.generateApiToken()`. That method is deprecated in favor of offer templates. If
  you need to use it, read the [web publishing guide](web-publishing.md) for more about how to
  access `HackSessionContext`.

In the future, we will implement an OAuth flow allowing a third party to initiate a request for
access to the user's apps.

### Creating an offer template

An _offer template_ is a way for an app to create an element that appears like a DIV, containing
text controlled by the app, which also has an API token inside. Because it is implemented with an
IFRAME, the app cannot read the token out of the offer template, which is good for app isolation.

You can see an example by launching [a GitWeb
demo](https://oasis.sandstorm.io/appdemo/6va4cjamc21j0znf5h5rrgnv0rpyvh1vaxurkrgknefvj0x63ash).

To create an offer template:

- Create full-width, 55-pixel-tall `IFRAME` element within your page with an ID of `offer-iframe`,
  with no margins so as to blend in seamlessly into your app. (The ID can be any valid ID, so long
  as you use the same one in a later step.) For example:

```html
<iframe style="width: 100%; height: 55px; margin: 0; border: 0;" id="offer-iframe">
</iframe>
```

- Modify your page so that when it loads, the page will ask Sandstorm to generate a URL with the
  text of the offer template. (The `rpcId` parameter can be any string, so long as you use the same
  one in this step and the next step. Sandstorm will echo it back with the response.)

```html
<script>
  function requestIframeURL() {
    var template = "You can use the $API_TOKEN key to reach me at $API_HOST.";
    window.parent.postMessage({renderTemplate: {
      rpcId: "0",
      template: template,
      clipboardButton: 'left'
    }}, "*");
  }

  document.addEventListener("DOMContentLoaded", requestIframeURL);
</script>
```

- Modify your page so that when Sandstorm provides the unique URL for this offer template, your page
  will place that URL into the `src` element of the IFRAME.

```html
<script>
  var copyIframeURLToElement = function(event) {
    if (event.data.rpcId === "0") {
      if (event.data.error) {
        console.log("ERROR: " + event.data.error);
      } else {
        var el = document.getElementById("offer-iframe");
        el.setAttribute("src", event.data.uri);
      }
    }
  };

  window.addEventListener("message", copyIframeURLToElement);
</script>
```

- Your offer template will now contain text such as this.

```html
You can use the DT5hkM18CejvQomjIM1AVT4zqQdOdoFCid898bP2hQS key to reach me at https://api-d9bc3de0bed9cb9b321d3c491c10dbca.alpha.sandstorm.io/.
```

**Note**: API tokens created this way must be used within 5 minutes,
or else they [automatically
expire](https://github.com/sandstorm-io/sandstorm/search?utf8=%E2%9C%93&q=selfDestructDuration). To
prevent this from becoming a serious problem, the Sandstorm shell
automatically refreshes the IFRAME every 5 minutes.

### Parameters to renderTemplate()

`renderTemplate()` accepts the following parameters:

* `rpcId`: **String** of a message ID that will be passed back to your
  code.

* `template`: **String** to display to the user, where `$API_HOST`,
  `$API_TOKEN`, and `$GRAIN_TITLE_SLUG` will be replaced.

* `petname`: **String (optional)** of a name that this API token will
  have, when the user lists the API tokens and sharing links they have
  generated.

* `roleAssignment`: **roleAssignmentPattern (optional)** of
  permissions to apply to inbound requests. Use this to create API
  tokens with limited permissions, such as a read-only view.

* `forSharing`: **Boolean (optional)** true if this token should
  represent the anonymous user. You can use this to detach the token
  from the user who created it. **Note** that this also allows users
  to redeem it as a sharing link of the form
  `https://sandstorm.example.com/shared/$API_TOKEN`.

* `clipboardButton`: **String (optional)** to display a copy-to-clipboard
  button in either the top left or top right corner of the `IFRAME`.
  Valid values are `left` and `right`. Left unspecified, no button is shown.

* `style`: **Object (optional)** additional styling to apply to the body
  of the iframe. Note that some styles (e.g. background-color) can be
  set by styling the iframe element itself. We only support the
  following properties:
  * `color`: **String (optional)** The text color. Defaults to black,
    syntax is 6-hex-digit css form, like `#ff00ff` (other ways of
    specifying colors are not supported).

### WebKeys

Sandstorm users can directly create an API token by clicking on the key icon within the [Sandstorm
top bar](../using/top-bar.md). This creates a [webkey](http://waterken.sourceforge.net/web-key/),
which is a combination of an endpoint URL and an API token separated by a `#`. An example is:

    https://alpha-api.sandstorm.io#49Np9sqkYV4g_FpOQk1p0j1yJlvoHrZm9SVhQt7H2-9

This format is intentionally chosen to look like a valid URL that could be opened in a
browser. Eventually, when such a URL is loaded directly in a browser, Sandstorm will show the user
information about the API and possibly offer the ability to explore the API and initiate requests
for debugging purposes. As of this writing, these features are not yet implemented.

The part of the webkey before the `#` is the API endpoint for the server (in this case, for
alpha.sandstorm.io). After the `#` is the API token.

## How to provide the API token with a request

There are two main ways to provide the API token to Sandstorm.

- **Recommended:** OAuth 2.0-style Bearer header. You can pass an `Authorization: Bearer foo` header
  with the HTTP request, replacing `foo` with the API token. For example:

```bash
curl -H "Authorization: Bearer 49Np9sqkYV4g_FpOQk1p0j1yJlvoHrZm9SVhQt7H2-9" https://alpha-api.sandstorm.io/
```

- HTTP Basic auth. You can use any username so long as you provide the API token as the password.
  For example,
  `https://anything:DT5hkM18CejvQomjIM1AVT4zqQdOdoFCid898bP2hQS@api-d9bc3de0bed9cb9b321d3c491c10dbca.alpha.sandstorm.io/`.

We recommend the Bearer header option because web browsers will not cache the API token (unlike
Basic auth), and because one cannot accidentally use the token in a web browser.

### WebSockets

Unfortunately, WebSockets have no way to set headers in most languages (specifically Javascript). To
work around this, you must pass the token as part of the URL path. It must be at the beginning of
the path and of the form:

```
/.sandstorm-token/<token>
```

For example:

```
wss://api-qxJ58hKANkbmJLQdSDk4.oasis.sandstorm.io/.sandstorm-token/RfNqni4FEHXkWC5B8v6t/some/path
```

The "/.sandstorm-token/&lt;token&gt;" part of the path will be stripped, and the remaining
segment of the path will be passed onto your app.


## API hostnames

Each API token has a unique subdomain of the server where it is allowed. This ensures that in the
unlikely case where if a web browser connects to the API endpoint, and if the browser ignores the
Content-Security-Policy header provided by Sandstorm, grains cannot communicate by storing data in
the browser that the other can read.

There is also a generic API hostname that allows all API tokens. However, if you make a request to
the generic API hostname using HTTP Basic auth, then those requests are subject to a [whitelist of
non-web-browser `User-Agent`
strings](https://github.com/sandstorm-io/sandstorm/search?utf8=%E2%9C%93&q=isAllowedBasicAuthUserAgent). Therefore,
it is vastly easier to configure HTTP clients to use the token-specific hostname.

## Header modification by Sandstorm

Sandstorm sanitizes HTTP request and response headers it does not recognize, and adds a few response
headers.

- Sandstorm applies a CORS header of `Access-Control-Allow-Origin: *` to allow Javascript on any
  domain to interact with the app's API. This is safe because the API token serves as the
  access control.

- Sandstorm applies a `Content-Security-Policy: default-src "none"; sandbox` header to ensure that
  if you visit an API host within a web browser, the browser will prevent the API host from reaching
  other domains. This helps keeps the app confined.

- Sandstorm removes cookie-related headers because cookies are not allowed within the Sandstorm HTTP
  API system. The API token should be used for access control.

- Sandstorm applies a HTTP request and response header whitelist because some HTTP headers modify
  the meaning of the request, and we do not have a full list of safe headers. If your app needs HTTP
  headers that Sandstorm does not support, please file an issue similar to [this
  one](https://github.com/sandstorm-io/sandstorm/issues/1897) and accept our apologies.

If you run into trouble with Sandstorm's header modification, please email the [sandstorm-dev Google
Group](groups.google.com/d/forum/sandstorm-dev).

### Getting the user IP address

One special request header modifies Sandstorm's privacy defaults. By default, Sandstorm removes the
user's IP address from API requests. The API **client code** can request that Sandstorm pass the IP
address to the grain by setting a request header on the API call:

```
X-Sandstorm-Passthrough: address
```

When the app receives the request from Sandstorm, it will be enriched by a `X-Real-IP` request
header containing the API user's IP address, assuming it is using `sandstorm-http-bridge`.

If you want to capture IP address by default for your app, you can distribute sample Javascript code
with the app that sets the `X-Sandstorm-Passthrough` header on `XMLHttpRequest` calls. One app that
does this is
[Piwik](https://apps.sandstorm.io/app/xuajusd5d4a9v4js71ru0cwj9wn984q1x8kny10htsp8f5dcfep0).

### Managed credentials in Powerbox

Request `ApiSession` with `PowerboxTag.authentication` set to `"bearer"` or `"basic"`
to prompt for a credential in Sandstorm's UI. With a canonical URL, the URL card
opens the credential form. Without an authentication hint, the existing anonymous
URL card remains available. Unknown authentication hints produce no HTTP driver
cards. The arbitrary URL form allows the user to select authentication explicitly.
Google/GitHub OAuth scope requests retain their existing flow.

For OpenAI, request `canonicalUrl = "https://api.openai.com/v1"` and
`authentication = "bearer"`. The Sandstorm-owned profile labels the secret as an
API key and offers optional organization and project IDs. The driver validates
these settings and injects `OpenAI-Organization` / `OpenAI-Project` with the saved
bearer token. Provider recognition requires the exact base URL (with an optional
trailing slash); an app-provided label is not provider identity. Generic bearer
and Basic authentication also work with other HTTP destinations.

Credentials belong in the form fields, not in the URL. New grants reject URL
userinfo, fragments, and queries. Previously saved references still restore.
Changing an editable destination clears credential and connection-setting inputs.
Secrets use the existing encrypted `frontendRef.http.auth` persistence fields;
optional `connectionHeaders` contain only the approved non-secret provider settings.
Descriptors contain the authentication kind, never the credential. Additional
caller headers cannot override connection-managed headers, regardless of casing.

This grants the service authority associated with the credential, including
potentially billable operations. No method restriction or spending limit is
imposed. Revoking the Sandstorm capability does not revoke the provider's API key.
SSE response streaming is supported as described below. Streaming request uploads
remain separate work.

Focused driver regressions run with the command below.
They use a local HTTP server and mock the Meteor/Cap'n Proto boundary; they do not
replace the browser Powerbox and persistence/revocation integration suite.

### External HTTP transport boundaries

The external `ApiSession` driver and the compatibility `OutboundHttpSession` driver
share `shell/imports/server/http-transport.js`. A base URL must be HTTP(S), with no
userinfo, query, fragment, whitespace, backslash, dot segments, encoded separators,
or malformed percent escapes. These checks also apply when restoring saved grants;
old unsafe base URLs must be re-granted with a valid base URL.

Request paths must be relative. Leading slashes, absolute URLs, fragments, raw
whitespace/backslashes, dot segments (including encoded dots), encoded slashes or
backslashes in the path, and malformed percent escapes are rejected before network
resolution or credential acquisition. Ordinary query strings are allowed on a
request. `post("responses", ...)` against either `/v1` or `/v1/` reaches
`/v1/responses`; an empty request path reaches the exact normalized base URL.
Confinement assumes the provider interprets URL paths normally, without additional
application-specific decoding or rewrite rules.

Every request gets fresh headers and a fresh network-policy lookup. Direct requests
pin the checked address while retaining the approved Host and TLS hostname. Configured
`HTTP_PROXY` / `HTTPS_PROXY` settings use the existing networking helper; the proxy
is responsible for destination-address filtering when it performs DNS resolution.
Redirects are returned without following them. Shared browser/receiving-grain header
whitelists have not been broadened.

A server-controlled 120-second overall deadline includes DNS/proxy setup, credential
acquisition, upload, and response consumption. Transport errors, premature response
closure, and response-consumer failures destroy the request and reject unfinished
work; requests are not automatically retried. Session disposal cancels tracked
operations, and dropping an unfinished compatibility upload stream cancels its request.
The current capnp-es shell adapter does not forward individual incoming RPC
cancellation to JavaScript promises, so per-call RPC cancellation is still a follow-up.
Already-running DNS and OAuth lookup promises cannot be forcibly canceled, but their
late results cannot start an expired HTTP request.

Run the focused suites after installing shell dependencies:

```sh
NODE_PATH="$PWD/shell/node_modules" node --test \
  tests/http-api-powerbox.test.cjs tests/http-transport.test.cjs
```

These exercise both driver adapters and real local HTTP/proxy servers. The tests
mock the Meteor and Cap'n Proto boundary; full browser, persistence, revocation,
and live TLS integration coverage remain separate.

### API errors and response metadata

External API responses preserve 401, 429, and 500–505 statuses with structured
error bodies, including JSON content types. Unknown server status codes fall back
to 500. The grain-local capability proxy forwards the operational metadata listed
in `ApiSession.responseHeaderWhitelist`: retry timing, request IDs, rate-limit
counts/reset times, and OpenAI processing time/version. Browser gateway response
headers retain their existing policy. Provider authentication challenges, cookies,
and provider-controlled browser security policies are not forwarded.

These schema additions require rebuilding consumers for full fidelity. Older C++
bridges fall back to 400 for the new client-error enum values and 500 for server
errors; older generated Rust bindings cannot decode the new enum values. Update
both ApiSession and WebSession schemas together when rebuilding an app.

Native conversion regressions use the existing KJ/CTest framework:

```sh
cmake --build build/dev --target sandstorm-web-session-bridge-test sandstorm-http-bridge-test
ctest --test-dir build/dev -R 'sandstorm/(web-session-bridge|http-bridge)$' --output-on-failure
```

These cover HTTP/RPC error conversion, JSON bodies, metadata filtering, and unknown
enum fallbacks. They do not require a live provider account.

### SSE response streaming

A successful `text/event-stream` response uses the existing `Context.responseStream`
and `content.body.stream` contract. Submit the normal JSON POST, including
`"stream": true` for the Responses API, and supply a ByteStream receiver. Keep the
returned lifetime handle alive while receiving data; drop it to cancel. A plain
HTTP app using the grain-local capability proxy receives an ordinary streamed HTTP
response. No additional public API is needed.

Headers are delivered before the first provider event. Each ByteStream write is
awaited before reading another chunk, so slow receivers apply backpressure.
Provider bytes are forwarded unchanged, including across arbitrary UTF-8/event
boundaries. JSON errors remain buffered and keep their original status and body.
Callers must treat release without `done()` as an incomplete transfer.

DNS, credentials, upload, and response headers retain the 120-second setup limit.
Once SSE headers arrive, the stream has a ten-minute lifetime and a sixty-second
idle limit. Idle time includes a blocked downstream write, not just silence from
the provider. These limits are server controlled. Stream handle release, session
closure, upstream truncation, write failure, or a deadline destroys the upstream
request and releases the receiver; failures never call `done()` or trigger retries.
Per-call RPC cancellation before response headers remains subject to the shell
adapter limitation described above.

The real RPC regression suite uses the capnp-es shell adapter and a C++ HTTP receiver,
covering successful streams, upstream truncation, idle/stalled receivers, and
prompt cancellation by handle release. Use Node 24, matching the shell runtime:

```sh
cmake --build build/dev --target sandstorm-api-stream-probe
API_STREAM_PROBE="$PWD/build/dev/bin/sandstorm-api-stream-probe" \
NODE_PATH="$PWD/shell/node_modules" \
  /path/to/node24 --test tests/http-api-stream-rpc.test.cjs
```

The `llm-proxy` sample app accepts `stream: true`, holds the RPC connection for the
response lifetime, and forwards chunks through a bounded queue. It logs usage from
a terminal Responses event only after a successful `done()`. Missing/truncated or
oversized accounting metadata is left incomplete or unpriced; response bytes are
still forwarded unchanged.
