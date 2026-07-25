import {
  defineWorker,
  mainViewFromFetch,
  sandstorm,
} from "sandstorm:api";
import { renderSkeletonPage } from "./ui.js";

const VIEW_INFO = {
  appTitle: { defaultText: "Isolate App Skeleton" },
};

function hello(api, name) {
  const session = api.session();
  const safeName = String(name || "there").slice(0, 80);
  return {
    greeting: `Hello, ${safeName}!`,
    user: session.user.displayName || "anonymous user",
    permissions: session.permissions,
  };
}

async function increment(api) {
  const store = api.storage();
  const current = Number(await store.get("skeleton-counter") || "0");
  const next = current + 1;
  await store.put("skeleton-counter", String(next));
  return { value: next };
}

async function skeletonFetch(request, env) {
    const api = sandstorm(request, env);
    const url = new URL(request.url);

    if (url.pathname === "/hello") {
      return Response.json(hello(api, url.searchParams.get("name")));
    }

    if (url.pathname === "/session") {
      return Response.json(api.session());
    }

    if (request.method === "POST" && url.pathname === "/increment") {
      return Response.json(await increment(api));
    }

    if (url.pathname === "/health") {
      const session = api.session();
      return Response.json({
        ok: true,
        user: session.user.displayName || null,
        permissions: session.permissions,
      });
    }

    return new Response(renderSkeletonPage(), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
}

export default defineWorker({
  capabilities: {
    ui: mainViewFromFetch({
      fetch: skeletonFetch,
      viewInfo: VIEW_INFO,
    }),
  },
});
