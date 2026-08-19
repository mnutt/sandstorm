import {
  IsolateBundle,
  IsolatePreviewer,
  IsolatePublisher,
} from "capnp:/sandstorm/isolate-authoring.capnp";
import {
  byteStreamFromWritable,
  capnpClient,
  exportCapnp,
  sandstorm,
} from "sandstorm:api";

const PREVIEWER_TOKEN_KEY = "isolate-previewer-token";
const CANDIDATE_TOKEN_KEY = "isolate-candidate-token";
const CANDIDATE_INFO_KEY = "isolate-candidate-info";
const PUBLISHED_APP_KEY = "isolate-published-app";
const SOURCE_KEY = "isolate-authoring-source";
const DEFAULT_SOURCE = `export default {
  async fetch(request) {
    console.log("preview request", request.method, request.url);
    return new Response("Hello from an immutable isolate preview!\\n", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};`;

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[character]));
}

function jsonValue(value) {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? item.toString() : item, 2);
}

function renderPage(state) {
  const descriptor = JSON.stringify(state.previewerDescriptor);
  const publisherDescriptor = JSON.stringify(state.publisherDescriptor || "");
  const previewDigest = JSON.stringify(state.result?.candidate?.normalizedDigest || "");
  const output = htmlEscape(jsonValue(state.result || state.error || {}));
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Isolate Authoring Powerbox</title>
    <style>
      body {
        color: #172033;
        font: 15px/1.5 system-ui, sans-serif;
        margin: 2rem;
        max-width: 960px;
      }
      textarea {
        border: 1px solid #94a3b8;
        border-radius: 6px;
        box-sizing: border-box;
        font: 14px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace;
        min-height: 22rem;
        padding: 0.8rem;
        resize: vertical;
        width: 100%;
      }
      button {
        background: #1d4ed8;
        border: 1px solid #1d4ed8;
        border-radius: 4px;
        color: white;
        cursor: pointer;
        font: inherit;
        margin: 0.75rem 0.5rem 0.75rem 0;
        padding: 0.5rem 0.75rem;
      }
      button.secondary {
        background: white;
        color: #1d4ed8;
      }
      button.danger {
        background: white;
        border-color: #b91c1c;
        color: #b91c1c;
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
    <h1>Isolate Authoring Powerbox</h1>
    <p class="status">${state.saved
      ? "Saved isolate preview authority is available."
      : "No isolate preview authority has been granted."}</p>
    <p>
      This grain owns the editable source. Each preview sends Sandstorm a new immutable,
      streamed candidate snapshot. Preview authority cannot publish an app.
    </p>

    <label for="source"><strong>worker.js</strong></label>
    <textarea id="source" spellcheck="false">${htmlEscape(state.source)}</textarea>
    <div>
      <button id="grant-preview" type="button">Grant and preview</button>
      <button id="saved-preview" class="secondary" type="button"
        ${state.saved ? "" : "disabled"}>Preview with saved grant</button>
      <button id="revoke-preview" class="danger" type="button"
        ${state.saved ? "" : "disabled"}>Revoke saved grant</button>
      ${state.candidateInfo ? `
      <button id="read-preview-log" class="secondary" type="button">Read preview logs</button>
      <button id="publish-candidate" type="button">${state.publishedApp
        ? "Publish update"
        : "Publish reviewed candidate"}</button>` : ""}
    </div>

    <pre id="output">${output}</pre>
    <p id="preview-presentation-status" aria-live="polite"></p>

    <script type="module">
      import { requestPowerbox } from "/__sandstorm/native-capnp/client.js";

      const source = document.querySelector("#source");
      const output = document.querySelector("#output");
      const previewPresentationStatus =
        document.querySelector("#preview-presentation-status");
      const buttons = [...document.querySelectorAll("button")];
      const initiallyDisabled = buttons.map(button => button.disabled);

      function setBusy(message) {
        output.textContent = message;
        buttons.forEach(button => { button.disabled = true; });
      }

      function clearBusy() {
        buttons.forEach((button, index) => { button.disabled = initiallyDisabled[index]; });
      }

      async function replacePage(response) {
        const html = await response.text();
        document.open();
        document.write(html);
        document.close();
      }

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

      async function postPreview(powerboxResult = null) {
        setBusy("Streaming immutable candidate and starting preview...");
        const response = await fetch("/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            source: source.value,
            powerboxResult,
          }),
        });
        await replacePage(response);
      }

      document.querySelector("#grant-preview").addEventListener("click", async () => {
        try {
          setBusy("Opening Powerbox for IsolatePreviewer authority...");
          const powerboxResult = await requestPowerbox([${descriptor}], {
            saveLabel: { defaultText: "Isolate preview authority" },
          });
          await postPreview(powerboxResult);
        } catch (error) {
          output.textContent = (error.message || String(error)) + "\\n\\n" + (error.stack || "");
          clearBusy();
        }
      });

      document.querySelector("#saved-preview").addEventListener("click", async () => {
        try {
          await postPreview();
        } catch (error) {
          output.textContent = (error.message || String(error)) + "\\n\\n" + (error.stack || "");
          clearBusy();
        }
      });

      document.querySelector("#revoke-preview").addEventListener("click", async () => {
        try {
          setBusy("Revoking saved preview authority...");
          await replacePage(await fetch("/revoke", { method: "POST" }));
        } catch (error) {
          output.textContent = (error.message || String(error)) + "\\n\\n" + (error.stack || "");
          clearBusy();
        }
      });

      document.querySelector("#read-preview-log")?.addEventListener("click", async () => {
        try {
          setBusy("Reading the current preview log through IsolatePreviewer...");
          const response = await fetch("/preview-log");
          const result = await response.json();
          if (!response.ok) throw new Error(result.message || "Could not read preview logs.");
          output.textContent = result.text || "The preview log is empty.";
        } catch (error) {
          output.textContent = (error.message || String(error)) + "\\n\\n" +
            (error.stack || "");
        } finally {
          clearBusy();
        }
      });

      document.querySelector("#publish-candidate")?.addEventListener("click", async () => {
        try {
          setBusy("Opening Powerbox for one-shot IsolatePublisher authority...");
          const powerboxResult = await requestPowerbox([${publisherDescriptor}], {
            saveLabel: { defaultText: "Publish reviewed isolate candidate" },
          });
          await replacePage(await fetch("/publish", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ powerboxResult }),
          }));
        } catch (error) {
          output.textContent = (error.message || String(error)) + "\\n\\n" +
            (error.stack || "");
          clearBusy();
        }
      });

      const previewDigest = ${previewDigest};
      if (previewDigest) {
        previewPresentationStatus.textContent = "Opening the current preview…";
        showIsolatePreview(previewDigest).then(() => {
          previewPresentationStatus.textContent = "The current preview is open.";
        }, (error) => {
          previewPresentationStatus.textContent =
            "Could not open the current preview: " + (error.message || String(error));
        });
      }
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

function digestHex(data) {
  return Array.from(data, byte => byte.toString(16).padStart(2, "0")).join("");
}

function digestBytes(hex) {
  return Uint8Array.from(hex.match(/../g), byte => Number.parseInt(byte, 16));
}

async function exportSourceBundle(api, sourceText) {
  const sourceBytes = new TextEncoder().encode(sourceText);
  return exportCapnp(api, IsolateBundle, {
    async getInfo() {
      return {
        info: {
          formatVersion: 1,
          mainModule: "worker.js",
          compatibilityDate: "2025-01-01",
          compatibilityFlags: [],
          modules: [{
            name: "worker.js",
            type: "esModule",
            size: BigInt(sourceBytes.byteLength),
          }],
        },
      };
    },

    async transfer({ receiver }) {
      const { stream } = await receiver.beginModule({ index: 0 });
      await stream.expectSize({ size: BigInt(sourceBytes.byteLength) });
      const midpoint = Math.floor(sourceBytes.byteLength / 2);
      await stream.write({ data: sourceBytes.subarray(0, midpoint) });
      await stream.write({ data: sourceBytes.subarray(midpoint) });
      await stream.done({});
      await receiver.finish({});
      return {};
    },
  });
}

async function previewSource(api, previewerCapability, sourceText) {
  const previewer = capnpClient(IsolatePreviewer, previewerCapability);
  const bundle = await exportSourceBundle(api, sourceText);
  try {
    const { candidate, view } = await previewer.preview({
      requestId: `example-preview-${crypto.randomUUID()}`,
      bundle: bundle.client,
      metadata: {
        appTitle: "Isolate Authoring Example Preview",
        nounPhrase: "preview",
        shortDescription: "Immutable preview created by the authoring Powerbox example.",
      },
    });
    const { info } = await candidate.getInfo({});
    const candidateInfo = {
      normalizedDigest: digestHex(info.normalizedDigest),
      title: "Isolate Authoring Example",
    };
    const candidateCapability = previewerCapability.wrapDerived(candidate);
    try {
      const previousToken = await api.storage().get(CANDIDATE_TOKEN_KEY);
      const token = await candidateCapability.save({ label: "Reviewed isolate candidate" });
      await api.storage().put(CANDIDATE_TOKEN_KEY, token);
      if (previousToken) await api.revoke(previousToken);
    } finally {
      await candidateCapability.drop();
    }

    await api.storage().putJson(CANDIDATE_INFO_KEY, candidateInfo);

    const viewInfo = await view.getViewInfo({});
    return {
      ok: true,
      candidate: {
        normalizedDigest: candidateInfo.normalizedDigest,
        compatibilityDate: info.compatibilityDate,
        compatibilityFlags: info.compatibilityFlags,
        modules: info.modules.map(module => ({
          name: module.name,
          type: module.type,
          size: module.size.toString(),
        })),
        validationWarnings: info.validationWarnings,
        createdAtNanoseconds: info.createdAt.toString(),
      },
      previewView: {
        permissions: viewInfo.permissions.length,
        roles: viewInfo.roles.length,
        presentation: "requested by the browser using the candidate digest",
      },
    };
  } finally {
    await bundle.drop();
  }
}

async function readPreviewLog(api) {
  const [token, candidateInfo] = await Promise.all([
    api.storage().get(PREVIEWER_TOKEN_KEY),
    api.storage().getJson(CANDIDATE_INFO_KEY),
  ]);
  if (!token || !candidateInfo) throw new Error("Preview a candidate before reading its log.");

  const restored = await api.restore(token);
  const previewer = capnpClient(IsolatePreviewer, restored);
  const decoder = new TextDecoder();
  let text = "";
  const receiver = byteStreamFromWritable(new WritableStream({
    write(data) {
      text += decoder.decode(data, { stream: true });
      if (text.length > 64 * 1024) text = text.slice(-64 * 1024);
    },
  }));
  let handle;
  try {
    ({ handle } = await previewer.watchPreviewLog({
      normalizedDigest: digestBytes(candidateInfo.normalizedDigest),
      backlogAmount: 8192,
      stream: receiver,
    }));
    await new Promise(resolve => setTimeout(resolve, 300));
    handle.client.close();
    handle = null;
    text += decoder.decode();
    return {
      ok: true,
      normalizedDigest: candidateInfo.normalizedDigest,
      text,
    };
  } finally {
    if (handle) handle.client.close();
    receiver.client.close();
    await restored.drop();
  }
}

async function publishCandidate(api, publisherCapability, requestId) {
  const candidateInfo = await api.storage().getJson(CANDIDATE_INFO_KEY);
  if (!candidateInfo) throw new Error("Preview and save a candidate before publishing.");
  const publisher = capnpClient(IsolatePublisher, publisherCapability);
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
  return {
    ok: true,
    publication,
  };
}

async function readState(api, result = null, error = null) {
  const storage = api.storage();
  const [token, source, candidateInfo, publishedApp] = await Promise.all([
    storage.get(PREVIEWER_TOKEN_KEY),
    storage.get(SOURCE_KEY),
    storage.getJson(CANDIDATE_INFO_KEY),
    storage.getJson(PUBLISHED_APP_KEY),
  ]);
  const publisherDescriptor = candidateInfo
    ? await api.powerbox().appInterfaceDescriptor(IsolatePublisher, {
        normalizedDigest: digestBytes(candidateInfo.normalizedDigest),
        target: publishedApp
          ? { existingApp: publishedApp.createdAppId }
          : { newApp: undefined },
        metadata: {
          title: candidateInfo.title,
          nounPhrase: "app",
          shortDescription: "Published by the isolate authoring Powerbox example.",
          marketingVersion: "1.0",
        },
      })
    : null;
  return {
    saved: Boolean(token),
    source: typeof source === "string" ? source : DEFAULT_SOURCE,
    previewerDescriptor: await api.powerbox().appInterfaceDescriptor(IsolatePreviewer),
    publisherDescriptor,
    candidateInfo,
    publishedApp,
    result,
    error,
  };
}

async function readJson(request) {
  try {
    return await request.json();
  } catch (error) {
    return {};
  }
}

async function render(api, result = null, error = null, status = 200) {
  return new Response(renderPage(await readState(api, result, error)), {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export default {
  async fetch(request, env) {
    const api = sandstorm(request, env);
    const url = new URL(request.url);

    try {
      const systemResponse = await api.serveSystemRoutes();
      if (systemResponse) return systemResponse;

      if (request.method === "POST" && url.pathname === "/preview") {
        const body = await readJson(request);
        const source = typeof body.source === "string" ? body.source : DEFAULT_SOURCE;
        await api.storage().put(SOURCE_KEY, source);

        let claimed;
        let token = await api.storage().get(PREVIEWER_TOKEN_KEY);
        if (body.powerboxResult) {
          const previousToken = token;
          claimed = await api.powerbox().claim(body.powerboxResult);
          try {
            token = await claimed.save({ label: "Isolate preview authority" });
            await api.storage().put(PREVIEWER_TOKEN_KEY, token);
            if (previousToken) await api.revoke(previousToken);
          } finally {
            await claimed.drop();
          }
        }
        if (!token) throw new Error("Grant IsolatePreviewer authority before previewing.");

        const restored = await api.restore(token);
        try {
          return await render(api, await previewSource(api, restored, source));
        } finally {
          await restored.drop();
        }
      }

      if (request.method === "POST" && url.pathname === "/publish") {
        const body = await readJson(request);
        if (!body.powerboxResult) throw new Error("Grant IsolatePublisher authority to publish.");
        const claimed = await api.powerbox().claim(body.powerboxResult);
        try {
          return await render(api, await publishCandidate(
            api, claimed, `example-publish-${crypto.randomUUID()}`));
        } finally {
          await claimed.drop();
        }
      }

      if (request.method === "POST" && url.pathname === "/revoke") {
        const token = await api.storage().get(PREVIEWER_TOKEN_KEY);
        const revoked = token ? await api.revoke(token) : { ok: true, skipped: true };
        const deleted = await api.storage().delete(PREVIEWER_TOKEN_KEY);
        return await render(api, { ok: true, revoked, deleted });
      }

      if (request.method === "GET" && url.pathname === "/preview-log") {
        return Response.json(await readPreviewLog(api));
      }

      return await render(api);
    } catch (error) {
      if (url.pathname === "/preview-log") {
        return Response.json(errorDetails(error), { status: 500 });
      }

      return await render(api, null, errorDetails(error), 500);
    }
  },
};
