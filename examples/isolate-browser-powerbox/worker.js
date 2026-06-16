import { sandstorm } from "sandstorm:api";

const TOKEN_KEY = "browser-powerbox-api-token";
const API_CANONICAL_URL = "https://api.example.test/v1";
const API_SCOPES = ["read"];

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[char]));
}

function jsonBlock(value) {
  return escapeHtml(JSON.stringify(value || {}, null, 2));
}

async function apiCall(capability) {
  const response = await capability.fetch("/status", {
    headers: { accept: "application/json" },
  });
  return readApiResponse(response);
}

async function readApiResponse(response) {
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch (error) {
    body = text;
  }

  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body,
  };
}

async function pageState(request, env, result = null, error = null) {
  const api = sandstorm(request, env);
  const token = await api.storage().get(TOKEN_KEY);
  return {
    saved: Boolean(token),
    canonicalUrl: API_CANONICAL_URL,
    oauthScopes: API_SCOPES,
    storageKey: TOKEN_KEY,
    result,
    error,
  };
}

function renderPage(state) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Browser Powerbox Lifecycle</title>
    <style>
      body {
        color: #162033;
        font: 15px/1.5 system-ui, sans-serif;
        margin: 2rem;
        max-width: 860px;
      }
      code {
        background: #eef2f7;
        border-radius: 4px;
        padding: 0.1rem 0.25rem;
      }
      button {
        border: 1px solid #2251c7;
        border-radius: 4px;
        background: #2251c7;
        color: white;
        cursor: pointer;
        font: inherit;
        margin: 0 0.35rem 0.75rem 0;
        padding: 0.5rem 0.75rem;
      }
      button.secondary {
        background: white;
        color: #2251c7;
      }
      form {
        display: inline;
      }
      pre {
        background: #f8fafc;
        border: 1px solid #cbd5e1;
        border-radius: 6px;
        overflow: auto;
        padding: 1rem;
        white-space: pre-wrap;
      }
      .status {
        color: ${state.saved ? "#166534" : "#8a1f11"};
        font-weight: 700;
      }
    </style>
  </head>
  <body>
    <h1>Browser Powerbox Lifecycle</h1>
    <p class="status">${state.saved ? "saved token present" : "no saved token"}</p>
    <p>
      Query: <code>${escapeHtml(state.canonicalUrl)}</code>
      scopes <code>${escapeHtml(state.oauthScopes.join(" "))}</code>.
      Saved token key: <code>${escapeHtml(state.storageKey)}</code>.
    </p>

    <button id="connect" type="button">request, claim, and save</button>
    <form method="post" action="/use">
      <button class="secondary" type="submit">restore and use</button>
    </form>
    <form method="post" action="/revoke">
      <button class="secondary" type="submit">drop saved token</button>
    </form>

    <pre>${jsonBlock(state.result || state.error)}</pre>

    <script type="module">
      import { inspectPowerboxQuery, requestApiPowerbox } from "./rpc-client.js";

      const button = document.querySelector("#connect");
      const output = document.querySelector("pre");

      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          const query = {
            canonicalUrl: "${API_CANONICAL_URL}",
            oauthScopes: ${JSON.stringify(API_SCOPES)},
          };
          const inspection = await inspectPowerboxQuery(query);
          output.textContent = "Opening Powerbox with query:\\n" +
            JSON.stringify(inspection, null, 2);

          const requested = await requestApiPowerbox({
            ...query,
            saveLabel: { defaultText: "Browser Powerbox Lifecycle API" },
          });

          const response = await fetch("/claim", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token: requested.token }),
          });
          const html = await response.text();
          document.open();
          document.write(html);
          document.close();
        } catch (error) {
          output.textContent = (error.message || String(error)) + "\\n\\n" + (error.stack || "");
          button.disabled = false;
        }
      });
    </script>
  </body>
</html>`;
}

function errorDetails(error) {
  return {
    ok: false,
    name: String(error?.name || "Error"),
    message: String(error?.message || error),
    stack: String(error?.stack || ""),
  };
}

async function render(request, env, result = null, error = null) {
  return new Response(renderPage(await pageState(request, env, result, error)), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export default {
  async fetch(request, env) {
    const api = sandstorm(request, env);
    const url = new URL(request.url);

    const systemRoute = await api.serveSystemRoutes();
    if (systemRoute) return systemRoute;

    try {
      if (url.pathname === "/" && request.method === "GET") {
        return render(request, env);
      }

      if (url.pathname === "/claim" && request.method === "POST") {
        const body = await request.json();
        const claimed = await api.powerbox().claimAndStoreRequest(body, {
          storageKey: TOKEN_KEY,
          label: "Browser Powerbox Lifecycle API",
        });
        const call = await apiCall(claimed.capability);
        await claimed.capability.drop();
        return render(request, env, {
          ok: true,
          step: "claimed and saved",
          saved: JSON.parse(JSON.stringify(claimed.saved)),
          call,
        });
      }

      if (url.pathname === "/use" && request.method === "POST") {
        const response = await api.powerbox().fetchStored(
          { storageKey: TOKEN_KEY },
          "/status",
          { headers: { accept: "application/json" } });
        const call = await readApiResponse(response);
        return render(request, env, {
          ok: true,
          step: "restored and used",
          call,
        });
      }

      if (url.pathname === "/revoke" && request.method === "POST") {
        const dropped = await api.powerbox().dropStored({ storageKey: TOKEN_KEY });
        return render(request, env, {
          ok: true,
          step: "dropped saved token",
          dropped,
        });
      }

      return new Response("Not Found", { status: 404 });
    } catch (error) {
      return render(request, env, null, errorDetails(error));
    }
  },
};
