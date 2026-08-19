import {
  IsolateBundle,
  IsolatePreviewer,
  IsolatePublisher,
} from "capnp:/sandstorm/isolate-authoring.capnp";
import {
  Capability,
  byteStreamFromWritable,
  capnpClient,
  exportCapnp,
  sandstorm,
} from "sandstorm:api";

const TOKEN_KEY = "api-powerbox-token";
const CANDIDATE_TOKEN_KEY = "isolate-candidate-token";
const CANDIDATE_INFO_KEY = "isolate-candidate-info";
const PUBLISHED_APP_KEY = "isolate-published-app";
const PUBLISHER_TOKEN_KEY = "isolate-publisher-token";
const PUBLISH_REQUEST_KEY = "isolate-publish-request";
const API_CANONICAL_URL = "https://api.example.test/v1";
const API_OAUTH_SCOPES = ["read"];
const PROVIDER_DESCRIPTOR = "EAlQAQEAABEBF1EEAQH_y9-dR8kYld8AUAEBAXsRASIHZm9v";
const PREVIEW_LOG_MARKER = "Powerbox preview log:";

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
  const previewerDescriptor = JSON.stringify(state.previewerDescriptor || "");
  const publisherDescriptor = JSON.stringify(state.publisherDescriptor || "");
  const createdPreviewDigest = JSON.stringify(
    state.result?.call?.candidate?.normalizedDigest || "");
  const currentPreviewDigest = JSON.stringify(state.candidateInfo?.normalizedDigest || "");
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
    ${state.previewerFlow ?
      "<p id=\"isolate-previewer-flow-mode\">Isolate previewer descriptor mode</p>" : ""}

    <label>
      Canonical API URL
      <input id="canonical-url" value="${htmlEscape(state.canonicalUrl)}" autocomplete="off">
    </label>
    <label>
      OAuth scopes
      <input id="oauth-scopes" value="${htmlEscape(state.oauthScopes)}" autocomplete="off">
    </label>
    <button id="connect-api" type="button">${state.previewerFlow ?
      "Create Isolate Preview" : "Connect API"}</button>

    <form method="post" action="/restore">
      <button type="submit" class="secondary">Restore Saved API</button>
    </form>

    <form method="post" action="/disconnect">
      <button type="submit" class="secondary">Drop Saved API</button>
    </form>

    ${state.candidateInfo ? `
    <button id="open-isolate-preview" type="button">Show Current Isolate Preview</button>` : ""}

    ${state.publisherDescriptor && !state.result?.call?.published ? `
    <button id="publish-isolate" type="button">Publish Isolate as New App</button>` : ""}

    <pre>${pretty}</pre>

    <script type="module">
      import {
        apiSessionPowerboxDescriptor,
        inspectPowerboxQuery,
        requestPowerbox,
      } from "/__sandstorm/native-capnp/client.js";

      const button = document.querySelector("#connect-api");
      const output = document.querySelector("pre");
      const canonicalUrl = document.querySelector("#canonical-url");
      const oauthScopes = document.querySelector("#oauth-scopes");

      function showIsolatePreview(normalizedDigest) {
        const rpcId = typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : "isolate-preview-" + Date.now().toString(36) + "-" +
            Math.random().toString(36).slice(2);

        return new Promise((resolve, reject) => {
          function onMessage(event) {
            if (event.source !== window.parent || event.data?.rpcId !== rpcId) return;
            window.removeEventListener("message", onMessage);
            if (event.data.error) {
              reject(new Error(event.data.error));
            } else {
              resolve();
            }
          }

          window.addEventListener("message", onMessage);
          window.parent.postMessage({
            showIsolatePreview: { rpcId, normalizedDigest },
          }, "*");
        });
      }

      window.showIsolatePreview = showIsolatePreview;
      button.addEventListener("click", async () => {
        output.textContent = "Building Powerbox descriptor...";
        button.disabled = true;
        try {
          const providerFlow = new URLSearchParams(location.search).has("providerFlow");
          const previewerFlow = new URLSearchParams(location.search).has("isolatePreviewer");
          const apiScopes = oauthScopes.value
            .split(/[,\\s]+/)
            .map((scope) => scope.trim())
            .filter(Boolean);
          const queryInspection = await inspectPowerboxQuery(providerFlow
            ? {
                descriptor: "${PROVIDER_DESCRIPTOR}",
              }
            : previewerFlow
            ? {
                descriptor: ${previewerDescriptor},
              }
            : {
                canonicalUrl: canonicalUrl.value,
                oauthScopes: apiScopes,
              });
          output.textContent = "Opening Powerbox with query:\\n" +
            JSON.stringify(queryInspection, null, 2);
          const query = providerFlow
            ? ["${PROVIDER_DESCRIPTOR}"]
            : previewerFlow
            ? [${previewerDescriptor}]
            : [await apiSessionPowerboxDescriptor({
                canonicalUrl: canonicalUrl.value,
                oauthScopes: apiScopes,
              })];
          const requested = await requestPowerbox(query, {
            saveLabel: {
              defaultText: providerFlow
                ? "Isolate provider connection"
                : "Isolate API Powerbox connection",
            },
          });
          output.textContent = "Saving capability...";
          const response = await fetch("/claim", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              ...requested,
              isolatePreviewer: previewerFlow,
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

      const publishButton = document.querySelector("#publish-isolate");
      publishButton?.addEventListener("click", async () => {
        output.textContent = "Opening one-shot isolate publisher grant...";
        publishButton.disabled = true;
        try {
          const descriptor = ${publisherDescriptor};
          const queryInspection = await inspectPowerboxQuery({ descriptor });
          output.textContent = "Opening Powerbox with query:\\n" +
            JSON.stringify(queryInspection, null, 2);
          const requested = await requestPowerbox([descriptor], {
            saveLabel: { defaultText: "Publish reviewed isolate candidate" },
          });
          const response = await fetch("/claim", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...requested, isolatePublisher: true }),
          });
          const html = await response.text();
          document.open();
          document.write(html);
          document.close();
        } catch (error) {
          output.textContent = (error.message || String(error)) + "\\n\\n" +
            (error.stack || "");
          publishButton.disabled = false;
        }
      });

      document.querySelector("#open-isolate-preview")?.addEventListener("click", async () => {
        try {
          await showIsolatePreview(${currentPreviewDigest});
        } catch (error) {
          output.textContent = (error.message || String(error)) + "\\n\\n" +
            (error.stack || "");
        }
      });

      const createdPreviewDigest = ${createdPreviewDigest};
      if (createdPreviewDigest) {
        showIsolatePreview(createdPreviewDigest).catch((error) => {
          output.textContent = (error.message || String(error)) + "\\n\\n" +
            (error.stack || "");
        });
      }
    </script>
  </body>
</html>`;
}

function appApi(request, env) {
  return sandstorm(request, env);
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

async function callIsolatePreviewer(
  api, capability, responseText = "Powerbox isolate preview") {
  const previewer = capnpClient(IsolatePreviewer, capability);
  const previewClient = `
    import { apiSessionPowerboxDescriptor, requestPowerbox } from
      "/__sandstorm/native-capnp/client.js";
    const button = document.querySelector("#request-preview-powerbox");
    const output = document.querySelector("#preview-powerbox-result");
    button.addEventListener("click", async () => {
      try {
        const descriptor = await apiSessionPowerboxDescriptor({
          canonicalUrl: "https://api.example.test/v1",
        });
        const result = await requestPowerbox([descriptor], {
          saveLabel: { defaultText: "Preview API capability" },
        });
        output.textContent = result.token ? "preview powerbox granted" : "missing token";
      } catch (error) {
        output.textContent = error.message || String(error);
      }
    });
    button.dataset.powerboxReady = "true";
  `;
  const previewHtml = `
    <h1>${responseText}</h1>
    <button id="request-preview-powerbox">Request preview capability</button>
    <pre id="preview-powerbox-result"></pre>
    <script type="module">${previewClient}</script>
  `;
  const source = new TextEncoder().encode(`import { sandstorm } from "sandstorm:api";
  export default { async fetch(request, env) {
    const systemResponse = await sandstorm(request, env).serveSystemRoutes();
    if (systemResponse) return systemResponse;
    console.log("Powerbox preview log:", ${JSON.stringify(responseText)});
    return new Response(${JSON.stringify(previewHtml)}, {
      headers: { "content-type": "text/html; charset=UTF-8" },
    });
  } };`);
  const exportedBundle = await exportCapnp(api, IsolateBundle, {
    async getInfo() {
      return {
        info: {
          formatVersion: 1,
          mainModule: "worker.js",
          compatibilityDate: "2025-01-01",
          compatibilityFlags: [],
          modules: [{ name: "worker.js", type: "esModule", size: BigInt(source.byteLength) }],
        },
      };
    },

    async transfer(params) {
      const { stream } = await params.receiver.beginModule({ index: 0 });
      await stream.expectSize({ size: BigInt(source.byteLength) });
      await stream.write({ data: source.subarray(0, 19) });
      await stream.write({ data: source.subarray(19) });
      await stream.done({});
      await params.receiver.finish({});
      return {};
    },
  });

  try {
    const result = await previewer.preview({
      requestId: `powerbox-preview-${crypto.randomUUID()}`,
      bundle: exportedBundle.client,
      metadata: {
        appTitle: "Powerbox Isolate Preview",
        nounPhrase: "preview",
        shortDescription: "Created through the IsolatePreviewer Powerbox capability.",
      },
    });
    const { info } = await result.candidate.getInfo({});
    const candidateDigest = Array.from(info.normalizedDigest, byte =>
      byte.toString(16).padStart(2, "0")).join("");
    const candidateCapability = capability.wrapDerived(result.candidate);
    try {
      const previousToken = await api.storage().get(CANDIDATE_TOKEN_KEY);
      const token = await candidateCapability.save({ label: "Reviewed isolate candidate" });
      await api.storage().put(CANDIDATE_TOKEN_KEY, token);
      if (previousToken) await api.revoke(previousToken);
    } finally {
      await candidateCapability.drop();
    }

    await api.storage().putJson(CANDIDATE_INFO_KEY, {
      normalizedDigest: candidateDigest,
      title: "Powerbox Published Isolate",
    });

    const viewInfo = await result.view.getViewInfo({});
    return {
      ok: true,
      previewerCanPublish: typeof previewer.publish === "function",
      candidate: {
        normalizedDigest: candidateDigest,
        digestBytes: info.normalizedDigest.length,
        compatibilityDate: info.compatibilityDate,
        moduleNames: info.modules.map(module => module.name),
        bindings: info.bindings,
        warnings: info.validationWarnings,
      },
      view: {
        permissionCount: viewInfo.permissions.length,
        roleCount: viewInfo.roles.length,
      },
    };
  } finally {
    await exportedBundle.drop();
  }
}

async function callIsolatePublisher(api, capability) {
  const candidateInfo = await api.storage().getJson(CANDIDATE_INFO_KEY);
  if (!candidateInfo) throw new Error("No reviewed isolate candidate is available.");
  let requestId = await api.storage().get(PUBLISH_REQUEST_KEY);
  if (!requestId) {
    requestId = `powerbox-publish-${crypto.randomUUID()}`;
    await api.storage().put(PUBLISH_REQUEST_KEY, requestId);
  }

  const publisher = capnpClient(IsolatePublisher, capability);
  const { result } = await publisher.publish({ requestId });
  const publication = {
    createdAppId: result.createdAppId,
    revisionId: result.revisionId,
    appId: result.appId,
    appVersion: result.appVersion,
    title: result.title,
  };
  await api.storage().putJson(PUBLISHED_APP_KEY, publication);
  const candidateToken = await api.storage().get(CANDIDATE_TOKEN_KEY);
  if (candidateToken) await api.revoke(candidateToken);
  await api.storage().delete(CANDIDATE_TOKEN_KEY);
  await api.storage().delete(CANDIDATE_INFO_KEY);
  await api.storage().delete(PUBLISH_REQUEST_KEY);
  return {
    ok: true,
    published: true,
    requestId,
    result: publication,
  };
}

async function readCurrentPreviewLog(api) {
  const [token, candidateInfo] = await Promise.all([
    api.storage().get(TOKEN_KEY),
    api.storage().getJson(CANDIDATE_INFO_KEY),
  ]);
  if (!token || !candidateInfo) throw new Error("No current isolate preview is available.");

  const capability = await api.restore(token);
  const previewer = capnpClient(IsolatePreviewer, capability);
  const decoder = new TextDecoder();
  let text = "";
  let resolveMarker;
  const marker = new Promise((resolve) => {
    resolveMarker = resolve;
  });
  const receiver = byteStreamFromWritable(new WritableStream({
    write(data) {
      text += decoder.decode(data, { stream: true });
      if (text.length > 64 * 1024) text = text.slice(-64 * 1024);
      if (text.includes(PREVIEW_LOG_MARKER)) resolveMarker();
    },
  }));
  let handle;
  let timeout;
  try {
    const result = await previewer.watchPreviewLog({
      normalizedDigest: Uint8Array.from(candidateInfo.normalizedDigest.match(/../g),
        byte => Number.parseInt(byte, 16)),
      backlogAmount: 8192,
      stream: receiver,
    });
    handle = result.handle;
    await Promise.race([
      marker,
      new Promise((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("Timed out waiting for the current preview log."));
        }, 5000);
      }),
    ]);
    return {
      ok: true,
      normalizedDigest: candidateInfo.normalizedDigest,
      text,
    };
  } finally {
    clearTimeout(timeout);
    if (handle) handle.client.close();
    receiver.client.close();
    await capability.drop();
  }
}

async function callRestoredCapability(api) {
  const token = await api.storage().get(TOKEN_KEY);
  if (!token) {
    throw new Error(`No saved Powerbox token is available at ${TOKEN_KEY}`);
  }

  return api.use(token, async (capability) => {
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
  const api = appApi(request, env);
  const store = api.storage();
  const savedToken = await store.get(TOKEN_KEY);
  const url = new URL(request.url);
  const previewerFlow = url.searchParams.has("isolatePreviewer");
  const candidateInfo = await store.getJson(CANDIDATE_INFO_KEY);
  const publishedApp = await store.getJson(PUBLISHED_APP_KEY);
  const publisherDescriptor = candidateInfo
    ? await api.powerbox().appInterfaceDescriptor(IsolatePublisher, {
        normalizedDigest: Uint8Array.from(candidateInfo.normalizedDigest.match(/../g),
          byte => Number.parseInt(byte, 16)),
        target: publishedApp
          ? { existingApp: publishedApp.createdAppId }
          : { newApp: undefined },
        metadata: {
          title: candidateInfo.title,
          nounPhrase: "app",
          shortDescription: "Published through a one-shot IsolatePublisher capability.",
          marketingVersion: "1.0",
        },
      })
    : null;
  return {
    canonicalUrl: API_CANONICAL_URL,
    oauthScopes: API_OAUTH_SCOPES.join(" "),
    providerFlow: url.searchParams.has("providerFlow"),
    previewerFlow,
    previewerDescriptor: previewerFlow
      ? await api.powerbox().appInterfaceDescriptor(IsolatePreviewer)
      : null,
    publisherDescriptor,
    candidateInfo,
    publishedApp,
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
    const api = appApi(request, env);

    try {
      const systemRoute = await api.serveSystemRoutes();
      if (systemRoute) {
        return systemRoute;
      }

      if (request.method === "POST" && url.pathname === "/claim") {
        const body = await readJsonBody(request);
        const canonicalUrl = String(body.canonicalUrl || API_CANONICAL_URL);
        const capability = await api.powerbox().claim(body);
        const tokenKey = body.isolatePublisher ? PUBLISHER_TOKEN_KEY : TOKEN_KEY;
        const previousPublisherToken = body.isolatePublisher
          ? await api.storage().get(tokenKey)
          : null;
        const token = await capability.save({
          label: body.isolatePublisher
            ? "One-shot isolate publication authority"
            : body.isolatePreviewer
            ? "Isolate preview authority"
            : `API: ${canonicalUrl}`,
        });
        const store = await api.storage().put(tokenKey, token);
        if (previousPublisherToken) await api.revoke(previousPublisherToken);
        const savedCapability = await api.restore(token);
        const savedClass = savedCapability instanceof Capability;
        const call = body.isolatePublisher
          ? await callIsolatePublisher(api, savedCapability)
          : body.isolatePreviewer
          ? await callIsolatePreviewer(api, savedCapability)
          : await callApi(body.skipApiCall ? null : capability);
        const savedDrop = await savedCapability.drop();
        await capability.drop();

        return new Response(renderPage(await readState(request, env, {
          ok: true,
          capabilityClass: capability instanceof Capability,
          savedClass,
          tokenType: typeof token,
          requested: body,
          token,
          store,
          savedDrop,
          storageKey: tokenKey,
          call,
        })), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      if (request.method === "POST" && url.pathname === "/restore") {
        const call = await callRestoredCapability(api);
        return new Response(renderPage(await readState(request, env, {
          ok: true,
          storageKey: TOKEN_KEY,
          call,
        })), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      if (request.method === "POST" && url.pathname === "/offer-preview") {
        const token = await api.storage().get(TOKEN_KEY);
        if (!token) throw new Error("No saved IsolatePreviewer capability.");
        const capability = await api.restore(token);
        try {
          const updated = url.searchParams.get("updated");
          const responseText = updated === "2"
            ? "Powerbox isolate preview revision two"
            : updated
            ? "Powerbox isolate preview updated"
            : "Powerbox isolate preview";
          const call = await callIsolatePreviewer(api, capability, responseText);
          return Response.json({ ok: true, call });
        } finally {
          await capability.drop();
        }
      }

      if (request.method === "POST" && url.pathname === "/disconnect") {
        const token = await api.storage().get(TOKEN_KEY);
        const dropSaved = token ? await api.revoke(token) : { ok: true, found: false };
        const deleteToken = await api.storage().delete(TOKEN_KEY);
        return new Response(renderPage(await readState(request, env, {
          ok: true,
          dropSaved,
          deleteToken,
        })), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      if (url.pathname === "/json") {
        return Response.json(await readState(request, env));
      }

      if (url.pathname === "/preview-log") {
        return Response.json(await readCurrentPreviewLog(api));
      }

      return new Response(renderPage(await readState(request, env)), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    } catch (error) {
      if (url.pathname === "/preview-log") {
        return Response.json(errorDetails(error), { status: 500 });
      }

      return new Response(renderPage(await readState(request, env, null, errorDetails(error))), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};
