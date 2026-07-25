import {
  defineWorker,
  mainViewFromFetch,
  sandstorm,
} from "sandstorm:api";
import { renderCounter } from "./ui.js";
import metadata from "./metadata.json";
import helpText from "./help.txt";

const VIEW_INFO = {
  appTitle: { defaultText: "Isolate Counter" },
};

async function counterFetch(request, env) {
    const api = sandstorm(request, env);
    const store = api.storage();
    const key = "counter";
    const current = Number(await store.get(key) || "0");
    const next = current + 1;
    await store.put(key, String(next));

    return new Response(renderCounter({
      count: next,
      metadata,
      helpText,
      session: api.session(),
    }), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
}

export default defineWorker({
  capabilities: {
    ui: mainViewFromFetch({
      fetch: counterFetch,
      viewInfo: VIEW_INFO,
    }),
  },
});
