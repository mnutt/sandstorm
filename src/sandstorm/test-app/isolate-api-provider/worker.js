import { RpcTarget, sandstorm } from "sandstorm:api";

const PROVIDER_DESCRIPTOR = "EAlQAQEAABEBF1EEAQH_y9-dR8kYld8AUAEBAXsRASIHZm9v";

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
    <p>Provides route-backed WebSession and native app-object capabilities.</p>
    <button id="fulfill-api" type="button">Use this provider</button>
    <button id="fulfill-feed" type="button">Use feed provider</button>
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
        fulfill(event.currentTarget, "/fulfill-api");
      });
      document.querySelector("#fulfill-feed").addEventListener("click", (event) => {
        fulfill(event.currentTarget, "/fulfill-feed");
      });
    </script>
  </body>
</html>`;
}

class MailFeed extends RpcTarget {
  #api;

  constructor(api) {
    super();
    this.#api = api;
  }

  async subscribe(receiver) {
    const result = await receiver.call("onMailEvent", {
      subject: "isolate-feed-live-callback",
      unread: 2,
    });
    return {
      ok: true,
      mode: "live",
      result,
    };
  }

  async subscribeSaved(token) {
    const receiver = await this.#api.powerbox().restoreSaved(token);
    try {
      const result = await receiver.asRpc().onMailEvent({
        subject: "isolate-feed-saved-callback",
        unread: 5,
      });
      return {
        ok: true,
        mode: "saved",
        result,
      };
    } finally {
      await receiver.drop();
    }
  }
}

export default {
  async fetch(request, env) {
    const api = sandstorm(request, env);
    const session = api.session();
    const url = new URL(request.url);

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

    if (request.method === "POST" && url.pathname === "/fulfill-api") {
      const capability = await api.webSession({ pathPrefix: "/provided" });
      const fulfill = await capability.fulfillRequest(request, {
        title: "Isolate Capability Provider",
        verbPhrase: "can provide isolate capability responses",
        description: "Provides a route-backed WebSession from an isolate grain.",
        requiredPermissions: ["view"],
        descriptor: PROVIDER_DESCRIPTOR,
      });
      return Response.json({
        ok: true,
        fulfill,
        capability: JSON.parse(JSON.stringify(capability)),
      });
    }

    if (request.method === "POST" && url.pathname === "/fulfill-feed") {
      const capability = await api.capability(new MailFeed(api));
      const fulfill = await capability.fulfillRequest(request, {
        title: "Isolate Feed Provider",
        verbPhrase: "can provide feed events",
        description: "Provides an app-defined feed object from an isolate grain.",
        requiredPermissions: ["view"],
        descriptor: PROVIDER_DESCRIPTOR,
      });
      return Response.json({
        ok: true,
        fulfill,
        capability: JSON.parse(JSON.stringify(capability)),
      });
    }

    return new Response(renderRequestPage(session), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};
