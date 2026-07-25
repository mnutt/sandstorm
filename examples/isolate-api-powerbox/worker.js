import {
  defineWorker,
  mainViewFromFetch,
  sandstorm,
} from "sandstorm:api";

const TOKEN_KEY = "api-powerbox-token";
const API_CANONICAL_URL = "https://api.example.test/v1";
const API_OAUTH_SCOPES = ["read"];
const VIEW_INFO = {
  appTitle: { defaultText: "Isolate API Powerbox" },
  permissions: [{
    name: "view",
    title: { defaultText: "view" },
    description: { defaultText: "allows opening the API Powerbox example" },
  }],
  roles: [{
    title: { defaultText: "viewer" },
    permissions: [true],
    verbPhrase: { defaultText: "can view" },
    default: true,
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

function renderPage(state) {
  const pretty = htmlEscape(JSON.stringify(state.result || state.error || {}, null, 2));
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Isolate API Powerbox</title>
    <style>
      body {
        color: #172033;
        font: 15px/1.5 system-ui, sans-serif;
        margin: 2rem;
        max-width: 840px;
      }
      form {
        display: inline-block;
        margin: 0 0.5rem 1rem 0;
      }
      label {
        display: grid;
        gap: 0.25rem;
        margin: 0.75rem 0;
      }
      input {
        border: 1px solid #94a3b8;
        border-radius: 4px;
        font: inherit;
        max-width: 100%;
        padding: 0.45rem 0.55rem;
        width: min(38rem, calc(100vw - 5rem));
      }
      code {
        background: #f1f5f9;
        border-radius: 4px;
        padding: 0.1rem 0.25rem;
      }
      button {
        border: 1px solid #1d4ed8;
        border-radius: 4px;
        background: #1d4ed8;
        color: white;
        cursor: pointer;
        font: inherit;
        padding: 0.5rem 0.75rem;
      }
      button.secondary {
        background: white;
        color: #1d4ed8;
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
        color: ${state.saved ? "#166534" : "#7f1d1d"};
        font-weight: 600;
      }
    </style>
  </head>
  <body>
    <h1>Isolate API Powerbox</h1>
    <p class="status">${state.saved ? "Saved API capability token present" : "No API capability saved"}</p>
    <p>
      Requests <code>${htmlEscape(state.canonicalUrl)}</code>
      with OAuth scope <code>${htmlEscape(state.oauthScopes)}</code>.
    </p>

    <label>
      Canonical API URL
      <input id="canonical-url" value="${htmlEscape(state.canonicalUrl)}" autocomplete="off">
    </label>
    <label>
      OAuth scopes
      <input id="oauth-scopes" value="${htmlEscape(state.oauthScopes)}" autocomplete="off">
    </label>
    <button id="connect-api" type="button">Connect API</button>

    <form method="post" action="/restore">
      <button type="submit" class="secondary">Restore Saved API</button>
    </form>

    <form method="post" action="/disconnect">
      <button type="submit" class="secondary">Drop Saved API</button>
    </form>

    <pre>${pretty}</pre>

    <script type="module">
      import {
        apiSessionPowerboxDescriptor,
        requestPowerbox,
      } from "/__sandstorm/native-capnp/client.js";

      const button = document.querySelector("#connect-api");
      const output = document.querySelector("pre");
      const canonicalUrl = document.querySelector("#canonical-url");
      const oauthScopes = document.querySelector("#oauth-scopes");
      button.addEventListener("click", async () => {
        output.textContent = "Building Powerbox descriptor...";
        button.disabled = true;
        try {
          output.textContent = "Opening Powerbox...";
          const requested = await requestPowerbox([await apiSessionPowerboxDescriptor({
              canonicalUrl: canonicalUrl.value,
              oauthScopes: oauthScopes.value
              .split(/[,\\s]+/)
              .map((scope) => scope.trim())
              .filter(Boolean),
            })], {
              saveLabel: { defaultText: "Isolate API Powerbox connection" },
            });
          output.textContent = "Saving claimed capability...";
          const response = await fetch("/claim", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              ...requested,
              canonicalUrl: canonicalUrl.value,
              oauthScopes: oauthScopes.value,
              skipApiCall: new URLSearchParams(location.search).has("skipApiCall"),
            }),
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

async function callApi(capability) {
  if (!capability) {
    return {
      status: 0,
      contentType: "application/json",
      body: {
        skipped: true,
        reason: "api call skipped for shell validation",
      },
    };
  }

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

async function readState(request, env, result = null, error = null) {
  const store = sandstorm(request, env).storage();
  const savedToken = await store.get(TOKEN_KEY);
  return {
    canonicalUrl: API_CANONICAL_URL,
    oauthScopes: API_OAUTH_SCOPES.join(" "),
    saved: Boolean(savedToken),
    result,
    error,
  };
}

function errorDetails(error) {
  return {
    ok: false,
    name: String(error?.name || "Error"),
    message: String(error?.message || error),
    stack: String(error?.stack || ""),
  };
}

async function readJsonBody(request) {
  try {
    return await request.json();
  } catch (error) {
    return {};
  }
}

async function powerboxFetch(request, env) {
    const url = new URL(request.url);
    const api = sandstorm(request, env);

    try {
      if (request.method === "POST" && url.pathname === "/claim") {
        const body = await readJsonBody(request);
        const canonicalUrl = String(body.canonicalUrl || API_CANONICAL_URL);
        const capability = await api.powerbox().claim(body);
        let token;
        let call;
        try {
          token = await capability.save({ label: `API: ${canonicalUrl}` });
          await api.storage().put(TOKEN_KEY, token);
          call = await callApi(body.skipApiCall ? null : capability);
        } finally {
          await capability.drop();
        }

        return new Response(renderPage(await readState(request, env, {
          ok: true,
          requested: body,
          storageKey: TOKEN_KEY,
          saved: Boolean(token),
          call,
        })), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      if (request.method === "POST" && url.pathname === "/restore") {
        const token = await api.storage().get(TOKEN_KEY);
        if (!token) {
          throw new Error("No saved API token");
        }
        const response = await api.use(token, capability => capability.fetch(
          "/status",
          { headers: { accept: "application/json" } }));
        const call = await readApiResponse(response);
        return new Response(renderPage(await readState(request, env, {
          ok: true,
          storageKey: TOKEN_KEY,
          call,
        })), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      if (request.method === "POST" && url.pathname === "/disconnect") {
        const token = await api.storage().get(TOKEN_KEY);
        const revoked = token ? await api.revoke(token) : { ok: true, skipped: true };
        const deleted = await api.storage().delete(TOKEN_KEY);
        return new Response(renderPage(await readState(request, env, {
          ok: true,
          revoked,
          deleted,
        })), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      if (url.pathname === "/json") {
        return Response.json(await readState(request, env));
      }

      return new Response(renderPage(await readState(request, env)), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    } catch (error) {
      return new Response(renderPage(await readState(request, env, null, errorDetails(error))), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
}

export default defineWorker({
  capabilities: {
    ui: mainViewFromFetch({
      fetch: powerboxFetch,
      viewInfo: VIEW_INFO,
    }),
  },
});
