import { ClaimedCapability, SavedCapability, sandstorm } from "sandstorm:api";

const TOKEN_KEY = "api-powerbox-token";
const API_CANONICAL_URL = "https://api.example.test/v1";
const API_OAUTH_SCOPES = ["read"];

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
      import { requestApiCapability } from "./rpc-client.js";

      const button = document.querySelector("#connect-api");
      const output = document.querySelector("pre");
      const canonicalUrl = document.querySelector("#canonical-url");
      const oauthScopes = document.querySelector("#oauth-scopes");
      button.addEventListener("click", async () => {
        output.textContent = "Building Powerbox descriptor...";
        button.disabled = true;
        try {
          output.textContent = "Opening Powerbox...";
          const requested = await requestApiCapability({
            canonicalUrl: canonicalUrl.value,
            oauthScopes: oauthScopes.value
              .split(/[,\\s]+/)
              .map((scope) => scope.trim())
              .filter(Boolean),
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const api = sandstorm(request, env);
    const store = api.storage();

    try {
      const descriptorResponse = await api.servePowerboxDescriptors();
      if (descriptorResponse) {
        return descriptorResponse;
      }

      if (url.pathname === "/rpc-client.js") {
        return new Response(api.rpcClientScript(), {
          headers: { "content-type": "text/javascript; charset=utf-8" },
        });
      }

      if (request.method === "POST" && url.pathname === "/claim") {
        const body = await readJsonBody(request);
        const token = String(body.token || "");
        const canonicalUrl = String(body.canonicalUrl || API_CANONICAL_URL);
        let capability;
        let saved;
        if (body.capability?.type === "claimedCapability" && body.capability.id) {
          capability = new ClaimedCapability(env, body.capability.id);
          saved = await capability.save({ label: `API: ${canonicalUrl}` });
          await store.put(TOKEN_KEY, saved.token);
        } else {
          if (!token) {
            throw new Error("Powerbox did not return a request token or claimed capability.");
          }
          const claimed = await api.powerbox().claimAndSave(token, {
            label: `API: ${canonicalUrl}`,
            storageKey: TOKEN_KEY,
          });
          capability = claimed.capability;
          saved = claimed.saved;
        }
        const call = await callApi(body.skipApiCall ? null : capability);
        await capability.drop();

        return new Response(renderPage(await readState(request, env, {
          ok: true,
          capabilityClass: capability instanceof ClaimedCapability,
          savedClass: saved instanceof SavedCapability,
          requested: body,
          saved: JSON.parse(JSON.stringify(saved)),
          storageKey: TOKEN_KEY,
          call,
        })), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      if (request.method === "POST" && url.pathname === "/restore") {
        const restored = await api.powerbox().restoreSaved({ storageKey: TOKEN_KEY });
        if (!restored.ok || !restored.capability) {
          throw new Error("No saved API token is available.");
        }
        const capability = restored.capability;
        const call = await callApi(capability);
        await capability.drop();
        return new Response(renderPage(await readState(request, env, {
          ok: true,
          restoredClass: capability instanceof ClaimedCapability,
          restored: JSON.parse(JSON.stringify(capability)),
          storageKey: restored.storageKey,
          call,
        })), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      if (request.method === "POST" && url.pathname === "/disconnect") {
        const dropSaved = await api.powerbox().dropSavedFromStorage({ storageKey: TOKEN_KEY });
        return new Response(renderPage(await readState(request, env, {
          ok: true,
          dropSaved,
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
  },
};
