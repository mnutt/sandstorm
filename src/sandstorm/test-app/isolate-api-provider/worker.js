import {
  createCapnpStruct,
  defineWorker,
  mainViewFromFetch,
  sandstorm,
  webSessionFromFetch,
} from "sandstorm:api";
import { TestPowerboxCap } from "capnp:/sandstorm/test-app/test-app.capnp";

const PROVIDER_DESCRIPTOR = "EAlQAQEAABEBF1EEAQH_y9-dR8kYld8AUAEBAXsRASIHZm9v";
const PROVIDER_TAG = createCapnpStruct(
  TestPowerboxCap.PowerboxTag, { i: 123, s: "foo" });
const VIEW_INFO = {
  appTitle: { defaultText: "Isolate Capability Provider" },
  permissions: [{
    name: "view",
    title: { defaultText: "view" },
    description: { defaultText: "allows opening the isolate capability provider" },
  }],
  roles: [{
    title: { defaultText: "viewer" },
    permissions: [true],
    verbPhrase: { defaultText: "can view" },
    default: true,
  }],
  matchRequests: [{
    tags: [{
      id: 0xdf9518c9479ddfcbn,
      value: PROVIDER_TAG,
    }],
  }],
};

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[char]));
}

function renderRequestPage(session) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Isolate Capability Provider</title>
  </head>
  <body>
    <h1>Isolate Capability Provider</h1>
    <p>Provides a typed WebSession capability.</p>
    <button id="fulfill-api" type="button">Use this provider</button>
    <pre id="result">${htmlEscape(JSON.stringify(session, null, 2))}</pre>

    <script type="module">
      const result = document.querySelector("#result");
      async function fulfill(button, path) {
        button.disabled = true;
        result.textContent = "fulfilling";
        try {
          const response = await fetch(path, { method: "POST" });
          const body = await response.json();
          result.textContent = JSON.stringify(body, null, 2);
        } catch (error) {
          result.textContent = (error.message || String(error)) + "\\n" + (error.stack || "");
          button.disabled = false;
        }
      }

      document.querySelector("#fulfill-api").addEventListener("click", (event) => {
        fulfill(event.currentTarget, "/__sandstorm/provider-api/fulfill");
      });
    </script>
  </body>
</html>`;
}

function providerApi(request, env) {
  return sandstorm(request, env);
}

async function providerFetch(request, env) {
    const api = providerApi(request, env);
    const session = api.session();
    const url = new URL(request.url);
    const fulfillApi = api.powerboxFulfillment({
      routePrefix: "/__sandstorm/provider-api",
      title: "Isolate Capability Provider",
      description: "Provides a typed WebSession from an isolate grain.",
      buttonLabel: "Use this provider",
      capability: () => PROVIDED_WEB_SESSION,
      fulfill: {
        title: "Isolate Capability Provider",
        verbPhrase: "can provide isolate capability responses",
        description: "Provides a typed WebSession from an isolate grain.",
        requiredPermissions: ["view"],
        descriptor: PROVIDER_DESCRIPTOR,
      },
    });
    const helperResponse = await fulfillApi.serve();
    if (helperResponse) {
      return helperResponse;
    }

    if (url.pathname === "/provided/status") {
      return Response.json({
        ok: true,
        source: "isolate-capability-provider",
        path: url.pathname,
        search: url.search,
        method: request.method,
        sessionType: session.sessionType,
        user: session.user,
      });
    }

    return new Response(renderRequestPage(session), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
}

const PROVIDED_WEB_SESSION = webSessionFromFetch({
  fetch: providerFetch,
  pathPrefix: "/provided",
  label: "Isolate capability provider WebSession",
});

export default defineWorker({
  capabilities: {
    provided: PROVIDED_WEB_SESSION,
    ui: mainViewFromFetch({
      fetch: providerFetch,
      viewInfo: VIEW_INFO,
    }),
  },
});
