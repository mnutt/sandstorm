import { sandstorm, validate } from "sandstorm:api";
import { exportNativeCapnp } from "sandstorm:capnp";
import { BrowserCounter } from "capnp:./browser-counter.capnp";

let value = 0;
let exportedCounter = null;

const counterMethods = {
  async read() {
    return { value };
  },

  async increment({ amount = 1 } = {}) {
    value += validate.integer(amount, "amount", { coerce: true, min: -100, max: 100 });
    return { value };
  },

  async reset() {
    value = 0;
    return { value };
  },
};

async function exportCounter(api) {
  if (!exportedCounter) {
    exportedCounter = await exportNativeCapnp(api, BrowserCounter, counterMethods, {
      interfaceName: "BrowserCounter",
    });
  }
  return exportedCounter;
}

function renderPage() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Browser Cap'n Proto Counter</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: system-ui, sans-serif;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: Canvas;
        color: CanvasText;
      }
      main {
        width: min(520px, calc(100vw - 32px));
      }
      h1 {
        font-size: 1.5rem;
        margin: 0 0 16px;
      }
      .counter {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 16px;
      }
      output {
        min-width: 5ch;
        font-size: 2.5rem;
        font-variant-numeric: tabular-nums;
        line-height: 1;
      }
      button {
        min-height: 36px;
        padding: 0 14px;
        border: 1px solid color-mix(in srgb, CanvasText 28%, Canvas);
        border-radius: 6px;
        background: ButtonFace;
        color: ButtonText;
        cursor: pointer;
      }
      button:disabled {
        cursor: wait;
        opacity: 0.55;
      }
      input {
        width: 72px;
        min-height: 32px;
        padding: 0 8px;
      }
      pre {
        min-height: 120px;
        overflow: auto;
        padding: 12px;
        border: 1px solid color-mix(in srgb, CanvasText 18%, Canvas);
        border-radius: 6px;
        background: color-mix(in srgb, CanvasText 4%, Canvas);
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Browser Cap'n Proto Counter</h1>
      <section class="counter">
        <output id="value">...</output>
        <input id="amount" type="number" min="-100" max="100" step="1" value="1">
        <button id="increment" type="button" disabled>Increment</button>
        <button id="reset" type="button" disabled>Reset</button>
      </section>
      <pre id="log">Loading...</pre>
    </main>

    <script type="module">
      import { BrowserCounter } from "/__sandstorm/capnp/browser-counter.capnp.js";
      import { connectBrowserNativeCapnp } from "/__sandstorm/native-capnp/client.js";

      const valueOutput = document.querySelector("#value");
      const amountInput = document.querySelector("#amount");
      const incrementButton = document.querySelector("#increment");
      const resetButton = document.querySelector("#reset");
      const log = document.querySelector("#log");
      let counter = null;

      function show(result, operation) {
        valueOutput.value = String(result.value);
        log.textContent = JSON.stringify({
          operation,
          value: result.value,
          transport: "browser-native-capnp",
        }, null, 2);
      }

      function amount() {
        const value = Number(amountInput.value);
        return Number.isFinite(value) ? value : 1;
      }

      async function call(operation, fn) {
        incrementButton.disabled = true;
        resetButton.disabled = true;
        try {
          show(await fn(), operation);
        } catch (error) {
          log.textContent = (error.message || String(error)) + "\\n\\n" + (error.stack || "");
        } finally {
          incrementButton.disabled = false;
          resetButton.disabled = false;
        }
      }

      async function requestCounter(operation, params = {}) {
        if (!counter || typeof counter[operation] !== "function") {
          throw new Error("counter capability is not connected");
        }
        return await counter[operation](params);
      }

      async function connect() {
        const response = await fetch("/counter-capability", { method: "POST" });
        const result = await response.json();
        if (!response.ok || !result.ok) {
          throw new Error(result.error || "counter capability request failed");
        }

        counter = connectBrowserNativeCapnp(result.capability, BrowserCounter, {
          connectionId: "browser-counter-" + result.capability.id,
        });
        show(await requestCounter("read"), "read");
        incrementButton.disabled = false;
        resetButton.disabled = false;
      }

      incrementButton.addEventListener("click", () => call("increment", () =>
        requestCounter("increment", { amount: amount() })));
      resetButton.addEventListener("click", () => call("reset", () => requestCounter("reset")));

      try {
        await connect();
      } catch (error) {
        log.textContent = (error.message || String(error)) + "\\n\\n" + (error.stack || "");
      }
    </script>
  </body>
</html>`;
}

export default {
  async fetch(request, env) {
    const api = sandstorm(request, env);

    const system = await api.serveSystemRoutes();
    if (system) return system;

    const url = new URL(request.url);
    if (url.pathname === "/counter-capability" && request.method === "POST") {
      const counter = await exportCounter(api);
      return Response.json({
        ok: true,
        capability: counter.capability,
        info: await counter.info(),
      });
    }

    return new Response(renderPage(), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};
