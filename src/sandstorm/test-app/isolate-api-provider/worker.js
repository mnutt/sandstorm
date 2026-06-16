import { sandstorm } from "sandstorm:api";

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
    <p>Provides a route-backed WebSession capability.</p>
    <button id="fulfill-api" type="button">Use this provider</button>
    <pre id="result">${htmlEscape(JSON.stringify(session, null, 2))}</pre>

    <script type="module">
      const result = document.querySelector("#result");
      const button = document.querySelector("#fulfill-api");
      button.addEventListener("click", async () => {
        button.disabled = true;
        result.textContent = "fulfilling";
        try {
          const response = await fetch("/fulfill-api", { method: "POST" });
          const body = await response.json();
          result.textContent = JSON.stringify(body, null, 2);
        } catch (error) {
          result.textContent = (error.message || String(error)) + "\\n" + (error.stack || "");
          button.disabled = false;
        }
      });
    </script>
  </body>
</html>`;
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
