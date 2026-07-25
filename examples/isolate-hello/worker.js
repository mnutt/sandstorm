import { defineWorker, mainViewFromFetch } from "sandstorm:api";

const VIEW_INFO = {
  appTitle: { defaultText: "Hello Isolate" },
};

function helloFetch(request) {
    const url = new URL(request.url);
    return Response.json({
      ok: true,
      message: "hello from an isolate grain",
      method: request.method,
      pathname: url.pathname,
      hasAmbientPlatformBindings: false,
    });
}

export default defineWorker({
  capabilities: {
    ui: mainViewFromFetch({
      fetch: helloFetch,
      viewInfo: VIEW_INFO,
    }),
  },
});
