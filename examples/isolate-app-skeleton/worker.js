import { AppRpcTarget, sandstorm, validate } from "sandstorm:api";
import { renderSkeletonPage } from "./ui.js";

class AppApi extends AppRpcTarget {
  hello(name = "there") {
    name = validate.optional(name, "there", validate.string, "name", {
      maxLength: 80,
    });
    const session = this.api.session();
    return {
      greeting: `Hello, ${name}!`,
      user: session.user.displayName || "anonymous user",
      permissions: session.permissions,
    };
  }

  session() {
    return this.api.session();
  }

  async increment() {
    const store = this.api.storage();
    const current = Number(await store.get("skeleton-counter") || "0");
    const next = current + 1;
    await store.put("skeleton-counter", String(next));
    return { value: next };
  }
}

export default {
  async fetch(request, env) {
    const api = sandstorm(request, env);
    const url = new URL(request.url);

    const systemRoute = await api.serveSystemRoutes();
    if (systemRoute) return systemRoute;

    const rpcRoute = api.serveRpc(() => new AppApi(request, env));
    if (rpcRoute) return rpcRoute;

    if (url.pathname === "/health") {
      const session = api.session();
      return Response.json({
        ok: true,
        user: session.user.displayName || null,
        permissions: session.permissions,
        hasStorageBinding: Boolean(env.STORAGE),
        hasPowerboxBinding: Boolean(env.POWERBOX),
      });
    }

    return new Response(renderSkeletonPage(), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};
