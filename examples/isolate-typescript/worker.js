// Generated from worker.ts with npm run build.

// worker.ts
import {
  defineWorker,
  exportCapnp,
  mainViewFromFetch,
  sandstorm,
  validate
} from "sandstorm:api";
import { TypedCounter } from "capnp:./typed-counter.capnp";
var VIEW_INFO = {
  appTitle: { defaultText: "TypeScript Isolate" }
};
async function increment(api, step = 1) {
  const amount = validate.integer(step, "step", { min: 1, max: 100 });
  const store = api.storage();
  const current = Number(await store.get("typescript-counter") || "0");
  const value = current + amount;
  await store.put("typescript-counter", String(value));
  return { value };
}
function typedCounter(api) {
  return {
    async increment({ step }) {
      return increment(api, step);
    }
  };
}
function html() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>TypeScript Isolate</title>
    <style>
      body {
        color: #1f2933;
        font: 15px/1.45 system-ui, sans-serif;
        margin: 2rem;
      }

      main {
        max-width: 46rem;
      }

      button {
        background: #2563eb;
        border: 0;
        color: white;
        cursor: pointer;
        font: inherit;
        margin-right: 0.5rem;
        padding: 0.5rem 0.75rem;
      }

      pre {
        background: #f6f8fb;
        border: 1px solid #d6dee8;
        margin-top: 1rem;
        overflow: auto;
        padding: 1rem;
        white-space: pre-wrap;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>TypeScript Isolate</h1>
      <button id="session" type="button">session()</button>
      <button id="increment" type="button">increment()</button>
      <pre id="output">Ready.</pre>
    </main>
    <script type="module">
      const output = document.querySelector("#output");

      async function jsonFetch(url, options) {
        const response = await fetch(url, options);
        if (!response.ok) {
          throw new Error(await response.text());
        }
        return response.json();
      }

      async function run(callback) {
        output.textContent = "calling...";
        try {
          const value = await callback();
          output.textContent = JSON.stringify(value, null, 2);
        } catch (error) {
          output.textContent = (error.message || String(error)) + "\\n\\n" + (error.stack || "");
        }
      }

      document.querySelector("#session").addEventListener("click", () => run(async () => {
        return jsonFetch("/session");
      }));

      document.querySelector("#increment").addEventListener("click", () => run(async () => {
        return jsonFetch("/increment?step=1", { method: "POST" });
      }));
    <\/script>
  </body>
</html>`;
}
async function typescriptFetch(request, env) {
  const api = sandstorm(request, env);
  const url = new URL(request.url);
  if (url.pathname === "/session") {
    const session = api.session();
    return Response.json(session);
  }
  if (request.method === "POST" && url.pathname === "/increment") {
    return Response.json(await increment(api, Number(url.searchParams.get("step") || "1")));
  }
  if (request.method === "POST" && url.pathname === "/export-counter") {
    const exported = await exportCapnp(api, TypedCounter, typedCounter(api));
    return Response.json({
      ok: true,
      token: await exported.save({ label: "Typed counter" })
    });
  }
  return new Response(html(), {
    headers: { "content-type": "text/html; charset=utf-8" }
  });
}
var worker_default = defineWorker({
  capabilities: {
    ui: mainViewFromFetch({
      fetch: typescriptFetch,
      viewInfo: VIEW_INFO
    })
  }
});
export {
  worker_default as default
};
