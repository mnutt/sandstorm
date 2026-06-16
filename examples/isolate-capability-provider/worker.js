import { ClaimedCapability, SavedCapability, sandstorm } from "sandstorm:api";
import { renderCapabilityProviderDemo } from "./ui.js";

function jsonError(error) {
  return Response.json({
    ok: false,
    name: String(error?.name || "Error"),
    message: String(error?.message || error),
    stack: String(error?.stack || ""),
  }, { status: 500 });
}

async function callJson(capability, path, init) {
  const response = await capability.fetch(path, init);
  const text = await response.text();
  let body = text;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch (error) {
    body = text;
  }

  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    etag: response.headers.get("etag"),
    appHeader: response.headers.get("x-sandstorm-app-provider-demo"),
    body,
  };
}

function serializeCapability(capability) {
  return JSON.parse(JSON.stringify(capability));
}

async function exerciseCapability(capability, options) {
  const saved = await capability.save({ label: options.label });
  const directCall = await callJson(capability, options.path, options.fetchInit);
  const dropOriginal = await capability.drop();
  const restored = await saved.restore();
  const restoredCall = await callJson(restored, options.restoredPath || options.path);
  const dropRestored = await restored.drop();
  const dropSaved = await saved.drop();

  return {
    ok: true,
    capabilityClass: capability instanceof ClaimedCapability,
    savedClass: saved instanceof SavedCapability,
    restoredClass: restored instanceof ClaimedCapability,
    capability: serializeCapability(capability),
    saved: serializeCapability(saved),
    restored: serializeCapability(restored),
    directCall,
    dropOriginal,
    restoredCall,
    dropRestored,
    dropSaved,
  };
}

export default {
  async fetch(request, env) {
    const api = sandstorm(request, env);
    const url = new URL(request.url);

    try {
      if (url.pathname === "/shared/info") {
        return Response.json({
          ok: true,
          type: "webSession",
          path: url.pathname,
          search: url.search,
          session: api.session(),
          forwardedHeader: request.headers.get("x-sandstorm-app-provider-demo"),
        }, {
          headers: {
            "etag": "\"provider-web-session\"",
            "x-sandstorm-app-provider-demo": "web-session",
          },
        });
      }

      if (url.pathname === "/api/v1/status") {
        return Response.json({
          ok: true,
          type: "apiSession",
          path: url.pathname,
          search: url.search,
          sessionType: request.headers.get("x-sandstorm-session-type"),
        }, {
          headers: {
            "etag": "\"provider-api-session\"",
            "x-sandstorm-app-provider-demo": "api-session",
          },
        });
      }

      if (request.method === "POST" && url.pathname === "/api/export-web-session") {
        const capability = await api.webSession({ pathPrefix: "/shared" });
        return Response.json(await exerciseCapability(capability, {
          label: "Isolate provider WebSession",
          path: "/info?source=direct",
          restoredPath: "/info?source=restored",
          fetchInit: {
            headers: {
              "x-sandstorm-app-provider-demo": "from-claimed-fetch",
              "x-not-forwarded": "blocked",
            },
          },
        }));
      }

      if (request.method === "POST" && url.pathname === "/api/export-api-session") {
        const capability = await api.apiSession({ pathPrefix: "/api/v1" });
        return Response.json(await exerciseCapability(capability, {
          label: "Isolate provider ApiSession",
          path: "/status?source=direct",
          restoredPath: "/status?source=restored",
        }));
      }

      return new Response(renderCapabilityProviderDemo(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    } catch (error) {
      return jsonError(error);
    }
  },
};
