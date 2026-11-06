import { sandstorm } from "sandstorm:api";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const sandstormApi = sandstorm(request, env);
    const session = sandstormApi.session();
    const store = sandstormApi.storage();

    const storageKey = "last-request";
    const storageBody = JSON.stringify({
      method: request.method,
      pathname: url.pathname,
      timestamp: new Date().toISOString(),
    });

    const storagePut = await store.put(storageKey, storageBody);
    const storageHead = await store.head(storageKey);
    const storageText = await store.get(storageKey);
    const storageIndex = await store.list();

    const apiStatus = await sandstormApi.status();
    const apiRuntime = await sandstormApi.runtime();
    const apiBindings = await sandstormApi.bindings();

    return Response.json({
      ok: true,
      message: "hello from an ad hoc isolate worker",
      request: {
        method: request.method,
        pathname: url.pathname,
        search: url.search,
      },
      session,
      sandstormApi: {
        status: apiStatus,
        runtime: apiRuntime,
        bindings: apiBindings,
      },
      storage: {
        put: storagePut,
        head: storageHead,
        text: storageText,
        index: storageIndex,
      },
    }, {
      headers: {
        "cache-control": "no-store",
      },
    });
  },
};
