export function renderCapabilityProviderDemo() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Isolate Capability Provider</title>
    <style>
      body {
        color: #1f2933;
        font: 15px/1.45 system-ui, sans-serif;
        margin: 2rem;
      }

      main {
        max-width: 54rem;
      }

      .controls {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        margin: 1rem 0;
      }

      button {
        background: #334155;
        border: 0;
        color: white;
        cursor: pointer;
        font: inherit;
        padding: 0.5rem 0.75rem;
      }

      code {
        background: #eef2f7;
        padding: 0.1rem 0.25rem;
      }

      pre {
        background: #f6f8fb;
        border: 1px solid #d6dee8;
        overflow: auto;
        padding: 1rem;
        white-space: pre-wrap;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Isolate Capability Provider</h1>
      <p>
        This worker mints Sandstorm capabilities backed by its own routes:
        <code>webSession({ pathPrefix })</code> and
        <code>apiSession({ pathPrefix })</code>. Each action creates a
        capability, calls it through <code>cap.fetch()</code>, saves it,
        restores it, calls it again, revokes the saved token, and drops both
        handles.
      </p>

      <div class="controls">
        <button id="web-session" type="button">Exercise WebSession capability</button>
        <button id="api-session" type="button">Exercise ApiSession capability</button>
      </div>

      <pre id="output">Ready.</pre>
    </main>

    <script type="module">
      const output = document.querySelector("#output");

      async function run(path) {
        output.textContent = "calling...";
        try {
          const response = await fetch(path, { method: "POST" });
          const text = await response.text();
          let body;
          try {
            body = text.length > 0 ? JSON.parse(text) : null;
          } catch (error) {
            body = text;
          }
          output.textContent = JSON.stringify({ status: response.status, body }, null, 2);
        } catch (error) {
          output.textContent = (error.message || String(error)) + "\\n\\n" + (error.stack || "");
        }
      }

      document.querySelector("#web-session").addEventListener("click", () => {
        run("/api/export-web-session");
      });

      document.querySelector("#api-session").addEventListener("click", () => {
        run("/api/export-api-session");
      });
    </script>
  </body>
</html>`;
}
