import { Capability, RpcTarget, sandstorm } from "sandstorm:api";

const TOKEN_KEY = "api-powerbox-token";
const TOKEN_MODE_KEY = "api-powerbox-token-mode";
const API_CANONICAL_URL = "https://api.example.test/v1";
const API_OAUTH_SCOPES = ["read"];
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
    ${state.providerFlow ? "<p id=\"provider-flow-mode\">Provider descriptor mode</p>" : ""}
    ${state.feedFlow ? "<p id=\"feed-flow-mode\">Feed RPC mode</p>" : ""}
    ${state.llmFlow ? "<p id=\"llm-flow-mode\">LLM RPC mode</p>" : ""}

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
        inspectPowerboxQuery,
        powerboxDescriptors,
        requestApiCapability,
        requestProviderCapability,
      } from "./rpc-client.js";

      const button = document.querySelector("#connect-api");
      const output = document.querySelector("pre");
      const canonicalUrl = document.querySelector("#canonical-url");
      const oauthScopes = document.querySelector("#oauth-scopes");
      button.addEventListener("click", async () => {
        output.textContent = "Building Powerbox descriptor...";
        button.disabled = true;
        try {
          const providerFlow = new URLSearchParams(location.search).has("providerFlow");
          const feedFlow = new URLSearchParams(location.search).has("feedFlow");
          const llmFlow = new URLSearchParams(location.search).has("llmFlow");
          const apiScopes = oauthScopes.value
            .split(/[,\\s]+/)
            .map((scope) => scope.trim())
            .filter(Boolean);
          const queryInspection = await inspectPowerboxQuery(providerFlow || feedFlow || llmFlow
            ? {
                descriptor: powerboxDescriptors.providerTag({
                  descriptor: "${PROVIDER_DESCRIPTOR}",
                }),
              }
            : {
                canonicalUrl: canonicalUrl.value,
                oauthScopes: apiScopes,
              });
          output.textContent = "Opening Powerbox with query:\\n" +
            JSON.stringify(queryInspection, null, 2);
          const requested = providerFlow || feedFlow || llmFlow
            ? await requestProviderCapability({
                descriptor: powerboxDescriptors.providerTag({
                  descriptor: "${PROVIDER_DESCRIPTOR}",
                }),
                saveLabel: {
                  defaultText: feedFlow ? "Isolate feed provider connection" : llmFlow ?
                    "Isolate LLM provider connection" :
                    "Isolate provider connection"
                },
              })
            : await requestApiCapability({
                canonicalUrl: canonicalUrl.value,
                oauthScopes: apiScopes,
                saveLabel: { defaultText: "Isolate API Powerbox connection" },
              });
          output.textContent = "Saving capability...";
          const response = await fetch("/claim", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              ...requested,
              canonicalUrl: canonicalUrl.value,
              oauthScopes: oauthScopes.value,
              skipApiCall: new URLSearchParams(location.search).has("skipApiCall"),
              feedFlow,
              llmFlow,
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

class FeedReceiver extends RpcTarget {
  #events = [];

  onMailEvent(event) {
    this.#events.push(event);
    return {
      ok: true,
      count: this.#events.length,
      subject: event.subject,
    };
  }

  events() {
    return this.#events.slice();
  }
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

async function callFeed(api, capability) {
  const feed = capability.rpc;
  const liveReceiver = new FeedReceiver();
  const live = await feed.subscribe(liveReceiver);
  const durableReceiver = new FeedReceiver();
  const durableId = `isolate-feed-receiver-${crypto.randomUUID()}`;
  const durableStorageKey = `${durableId}-token`;
  const durable = await api.exportDurable(durableReceiver, {
    id: durableId,
    storageKey: durableStorageKey,
    label: "Isolate feed receiver",
  });
  const saved = await feed.subscribeSaved(durable.token);
  const durableDrop = await durable.capability.drop();
  const durableDropSaved = await api.revoke(durable.token);
  const durableDeleteStorage =
    await api.storage().delete(durableStorageKey);

  return {
    ok: true,
    live,
    liveEvents: liveReceiver.events(),
    saved,
    savedEvents: durableReceiver.events(),
    durable: {
      restored: durable.restored,
      storageKey: durable.storageKey,
      capabilityClass: durable.capability instanceof Capability,
      tokenType: typeof durable.token,
      drop: durableDrop,
      dropSaved: durableDropSaved,
      deleteStorage: durableDeleteStorage,
    },
  };
}

async function callLlm(capability) {
  const llm = capability.rpc;
  const session = await llm.startSession({ topic: "phase-7-llm" });
  const sessionInfo = await session.info();
  const first = await session.rpc.complete("draft a summary");
  const second = await session.rpc.complete("include next steps");
  const history = await session.rpc.history();
  const drop = await session.drop();
  return {
    ok: true,
    session: JSON.parse(JSON.stringify(session)),
    sessionInfo,
    first,
    second,
    history,
    drop,
  };
}

function capabilityMode(body) {
  if (body.feedFlow) return "feed";
  if (body.llmFlow) return "llm";
  return "api";
}

async function callRestoredCapability(api, mode) {
  const token = await api.storage().get(TOKEN_KEY);
  if (!token) {
    throw new Error(`No saved Powerbox token is available at ${TOKEN_KEY}`);
  }

  return api.use(token, async (capability) => {
    if (mode === "feed") {
      return callFeed(api, capability);
    } else if (mode === "llm") {
      return callLlm(capability);
    }

    const response = await capability.fetch("/status", {
      headers: { accept: "application/json" },
    });
    return readApiResponse(response);
  });
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
  const savedMode = await store.get(TOKEN_MODE_KEY);
  const url = new URL(request.url);
  return {
    canonicalUrl: API_CANONICAL_URL,
    oauthScopes: API_OAUTH_SCOPES.join(" "),
    providerFlow: url.searchParams.has("providerFlow"),
    feedFlow: url.searchParams.has("feedFlow"),
    llmFlow: url.searchParams.has("llmFlow"),
    saved: Boolean(savedToken),
    savedMode: savedMode || "api",
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

    try {
      const systemRoute = await api.serveSystemRoutes();
      if (systemRoute) {
        return systemRoute;
      }

      if (url.pathname === "/rpc-client.js") {
        return new Response(api.rpcClientScript(), {
          headers: { "content-type": "text/javascript; charset=utf-8" },
        });
      }

      if (request.method === "POST" && url.pathname === "/claim") {
        const body = await readJsonBody(request);
        const canonicalUrl = String(body.canonicalUrl || API_CANONICAL_URL);
        const mode = capabilityMode(body);
        const capability = await api.powerbox().claim(body);
        const token = await capability.save({ label: `API: ${canonicalUrl}` });
        const store = await api.storage().put(TOKEN_KEY, token);
        await api.storage().put(TOKEN_MODE_KEY, mode);
        const call = mode === "feed"
          ? await callFeed(api, capability)
          : mode === "llm"
            ? await callLlm(capability)
            : await callApi(body.skipApiCall ? null : capability);
        await capability.drop();

        return new Response(renderPage(await readState(request, env, {
          ok: true,
          capabilityClass: capability instanceof Capability,
          tokenType: typeof token,
          requested: body,
          token,
          store,
          storageKey: TOKEN_KEY,
          mode,
          call,
        })), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      if (request.method === "POST" && url.pathname === "/restore") {
        const mode = await api.storage().get(TOKEN_MODE_KEY) || "api";
        const call = await callRestoredCapability(api, mode);
        return new Response(renderPage(await readState(request, env, {
          ok: true,
          storageKey: TOKEN_KEY,
          mode,
          call,
        })), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      if (request.method === "POST" && url.pathname === "/disconnect") {
        const token = await api.storage().get(TOKEN_KEY);
        const dropSaved = token ? await api.revoke(token) : { ok: true, found: false };
        const deleteToken = await api.storage().delete(TOKEN_KEY);
        const deleteMode = await api.storage().delete(TOKEN_MODE_KEY);
        return new Response(renderPage(await readState(request, env, {
          ok: true,
          dropSaved,
          deleteToken,
          deleteMode,
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
