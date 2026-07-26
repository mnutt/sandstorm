import {
  capnpClient,
  defineWorker,
  mainViewFromFetch,
  sandstorm,
} from "sandstorm:api";
import { ObjectUploadTarget } from "capnp:./object-store.capnp";

const UPLOAD_TOKEN_PREFIX = "saved-upload-target";
const MAX_UPLOAD_BYTES = 1024 * 1024;
const VIEW_INFO = {
  appTitle: { defaultText: "Dropbox Upload" },
};

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[ch]);
}

function storageKeyPart(value) {
  const bytes = new TextEncoder().encode(String(value));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function uploadTokenKey(api) {
  const userId = api.session().user.id || "anonymous";
  return `${UPLOAD_TOKEN_PREFIX}-${storageKeyPart(userId)}`;
}

function canConfigure(api) {
  const permissions = api.session().permissions || [];
  return permissions.includes("configure") || permissions.length === 0;
}

async function claimUploadTarget(request, env) {
  const api = sandstorm(request, env);
  if (!canConfigure(api)) {
    return new Response("missing configure permission", { status: 403 });
  }

  const body = await request.json();
  const descriptor = await api.powerbox().appInterfaceDescriptor(ObjectUploadTarget);
  const claimOptions = { descriptor };
  if ((api.session().permissions || []).includes("configure")) {
    claimOptions.requiredPermissions = ["configure"];
  }

  const capability = await api.powerbox().claim(body, claimOptions);

  try {
    const token = await capability.save({
      label: "Dropbox Upload destination",
    });
    await api.storage().put(uploadTokenKey(api), token);
    return Response.json({ ok: true });
  } finally {
    await capability.drop();
  }
}

async function fileData(file) {
  if (Number.isFinite(file.size) && file.size >= MAX_UPLOAD_BYTES) {
    throw new Error("choose a file smaller than 1 MiB");
  }

  const data = new Uint8Array(await file.arrayBuffer());
  if (data.byteLength >= MAX_UPLOAD_BYTES) {
    throw new Error("choose a file smaller than 1 MiB");
  }
  return data;
}

async function uploadFromWorker(request, env) {
  const api = sandstorm(request, env);
  const form = await request.formData();
  const file = form.get("file");
  if (!file || typeof file.arrayBuffer !== "function") {
    return Response.json({ ok: false, error: "choose a file first" }, { status: 400 });
  }

  const token = await api.storage().get(uploadTokenKey(api));
  if (!token) {
    return Response.json({ ok: false, error: "choose an upload destination first" }, {
      status: 400,
    });
  }

  const data = await fileData(file);
  return api.use(token, async (capability) => {
    const uploader = capnpClient(ObjectUploadTarget, capability);
    const result = await uploader.putObject({
      key: file.name || "upload.bin",
      contentType: file.type || "application/octet-stream",
      data,
    });

    return Response.json({
      ok: true,
      size: Number(result?.size ?? data.byteLength),
    });
  });
}

async function destinationStatus(api) {
  return Boolean(await api.storage().get(uploadTokenKey(api)));
}

async function renderUploadPage(api) {
  const connected = await destinationStatus(api);

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Dropbox Upload</title>
  </head>
  <body>
    <main>
      <h1>Dropbox Upload</h1>
      <p>Status: ${connected ? "upload destination connected" : "no destination selected"}</p>
      <button id="connect" type="button">Choose upload destination</button>
      <form id="upload-form" method="post" action="/upload" enctype="multipart/form-data">
        <input name="file" type="file">
        <button type="submit">Upload via saved capability</button>
      </form>
      <pre id="status"></pre>
    </main>
    <script type="module">
      import { ObjectUploadTarget } from "/__sandstorm/capnp/object-store.capnp.js";
      import {
        nativeCapnpPowerboxDescriptor,
        requestPowerbox,
      } from "/__sandstorm/native-capnp/client.js";

      const status = document.querySelector("#status");
      const MAX_UPLOAD_BYTES = ${MAX_UPLOAD_BYTES};

      async function readJson(response) {
        const text = await response.text();
        try {
          return JSON.parse(text);
        } catch (error) {
          return { ok: false, error: text || "HTTP " + response.status };
        }
      }

      document.querySelector("#connect").addEventListener("click", async () => {
        try {
          const descriptor = await nativeCapnpPowerboxDescriptor(ObjectUploadTarget);
          const requested = await requestPowerbox([descriptor], {
            saveLabel: { defaultText: "upload destination for Dropbox Upload" },
          });
          const response = await fetch("/claim-upload-target", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(requested),
          });
          const body = await readJson(response);
          if (!response.ok || !body.ok) {
            throw new Error(body.error || "claim failed");
          }
          status.textContent = "Upload destination saved.";
        } catch (error) {
          status.textContent = error.message || String(error);
        }
      });

      document.querySelector("#upload-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        try {
          const file = event.currentTarget.elements.file.files[0];
          if (file && file.size >= MAX_UPLOAD_BYTES) {
            throw new Error("choose a file smaller than 1 MiB");
          }

          const response = await fetch("/upload", {
            method: "POST",
            body: new FormData(event.currentTarget),
          });
          const body = await readJson(response);
          if (!response.ok || !body.ok) {
            throw new Error(body.error || "upload failed");
          }
          status.textContent = "Uploaded " + body.size + " bytes.";
        } catch (error) {
          status.textContent = error.message || String(error);
        }
      });
    </script>
  </body>
</html>`;
}

async function dropboxUploadFetch(request, env) {
  const api = sandstorm(request, env);
  const url = new URL(request.url);
  try {
    if (url.pathname === "/claim-upload-target" && request.method === "POST") {
      return await claimUploadTarget(request, env);
    }

    if (url.pathname === "/upload" && request.method === "POST") {
      return await uploadFromWorker(request, env);
    }

    return new Response(await renderUploadPage(api), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  } catch (error) {
    return new Response(htmlEscape(error.stack || error.message || String(error)), {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
}

export default defineWorker({
  capabilities: {
    ui: mainViewFromFetch({
      fetch: dropboxUploadFetch,
      viewInfo: VIEW_INFO,
    }),
  },
});
