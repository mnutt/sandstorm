export function renderSkeletonPage() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Isolate App Skeleton</title>
    <style>
      body {
        color: #1f2933;
        font: 15px/1.45 system-ui, sans-serif;
        margin: 2rem;
      }

      main {
        max-width: 52rem;
      }

      .controls {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        margin: 1rem 0;
      }

      button, input {
        font: inherit;
      }

      button {
        background: #2563eb;
        border: 0;
        color: white;
        cursor: pointer;
        padding: 0.5rem 0.75rem;
      }

      input {
        border: 1px solid #c8d1dc;
        padding: 0.45rem 0.55rem;
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
      <h1>Isolate App Skeleton</h1>
      <p>
        A small Worker app with page routes, Sandstorm session metadata,
        storage, and conventional fetch endpoints.
      </p>

      <div class="controls">
        <input id="name" value="Sandstorm">
        <button id="hello" type="button">hello()</button>
        <button id="session" type="button">session()</button>
        <button id="increment" type="button">increment()</button>
        <button id="health" type="button">/health</button>
      </div>

      <pre id="output">Ready.</pre>
    </main>

    <script type="module">
      const output = document.querySelector("#output");
      const name = document.querySelector("#name");

      function show(value) {
        output.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      }

      async function run(callback) {
        output.textContent = "calling...";
        try {
          show(await callback());
        } catch (error) {
          output.textContent = (error.message || String(error)) + "\\n\\n" + (error.stack || "");
        }
      }

      async function jsonFetch(url, options) {
        const response = await fetch(url, options);
        if (!response.ok) {
          throw new Error(await response.text());
        }
        return response.json();
      }

      document.querySelector("#hello").addEventListener("click", () => run(async () => {
        return jsonFetch("/hello?name=" + encodeURIComponent(name.value));
      }));

      document.querySelector("#session").addEventListener("click", () => run(async () => {
        return jsonFetch("/session");
      }));

      document.querySelector("#increment").addEventListener("click", () => run(async () => {
        return jsonFetch("/increment", { method: "POST" });
      }));

      document.querySelector("#health").addEventListener("click", () => run(async () => {
        return jsonFetch("/health");
      }));
    </script>
  </body>
</html>`;
}
