// Generated from worker.ts with npm run build.

// worker.ts
import { RpcTarget, sandstorm, validate } from "sandstorm:api";
var DemoApi = class extends RpcTarget {
  constructor(request, env) {
    super();
    this.request = request;
    this.env = env;
  }
  session() {
    return sandstorm(this.request, this.env).session();
  }
  async increment(step = 1) {
    const amount = validate.integer(step, "step", { min: 1, max: 100 });
    const store = sandstorm(this.request, this.env).storage();
    const current = Number(await store.get("typescript-counter") || "0");
    const value = current + amount;
    await store.put("typescript-counter", String(value));
    return { value };
  }
};
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
      import { newSandstormRpcSession } from "./rpc-client.js";

      const output = document.querySelector("#output");

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
        using rpc = newSandstormRpcSession();
        return await rpc.session();
      }));

      document.querySelector("#increment").addEventListener("click", () => run(async () => {
        using rpc = newSandstormRpcSession();
        return await rpc.increment(1);
      }));
    <\/script>
  </body>
</html>`;
}
var worker_default = {
  async fetch(request, env) {
    const api = sandstorm(request, env);
    const systemRoute = await api.serveSystemRoutes();
    if (systemRoute) return systemRoute;
    const rpcRoute = api.serveRpc(() => new DemoApi(request, env));
    if (rpcRoute) return rpcRoute;
    return new Response(html(), {
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }
};
export {
  worker_default as default
};
