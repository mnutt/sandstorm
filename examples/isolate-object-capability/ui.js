function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderObjectCapabilityDemo(state) {
  const cap = state.capability ? JSON.stringify(state.capability, null, 2) : "No capability yet.";
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Isolate Object Capability</title>
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
        background: #0f766e;
        border: 0;
        color: white;
        cursor: pointer;
        padding: 0.5rem 0.75rem;
      }

      input {
        border: 1px solid #c8d1dc;
        padding: 0.45rem 0.55rem;
      }

      label {
        align-items: center;
        display: inline-flex;
        gap: 0.35rem;
      }

      #capability-id {
        width: 11rem;
      }

      #amount {
        width: 5rem;
      }

      pre {
        background: #f3f6f9;
        border: 1px solid #d8e0e8;
        overflow: auto;
        padding: 1rem;
        white-space: pre-wrap;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Isolate Object Capability</h1>
      <p>
        This worker exports a stateful JavaScript object as a Sandstorm claimed
        capability, then calls it through <code>ClaimedCapability.asRpc()</code>.
      </p>

      <div class="controls">
        <input id="capability-id" type="text" value="demo-counter" aria-label="capability id">
        <label><input id="persistent" type="checkbox"> persistent</label>
        <button id="create">Create capability</button>
        <input id="amount" type="number" value="1">
        <button id="increment">increment()</button>
        <button id="get">get()</button>
        <button id="child">returned child capability</button>
        <button id="missing">call missing method</button>
        <button id="save">save()</button>
        <button id="save-restore">save + restore persistent</button>
        <button id="drop">drop()</button>
      </div>

      <h2>Current handle</h2>
      <pre id="capability">${escapeHtml(cap)}</pre>

      <h2>Result</h2>
      <pre id="output">Ready.</pre>
    </main>

    <script type="module">
      const capability = document.querySelector("#capability");
      const output = document.querySelector("#output");
      const amount = document.querySelector("#amount");
      const capabilityId = document.querySelector("#capability-id");
      const persistent = document.querySelector("#persistent");

      function show(value) {
        output.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
        if (value && value.capability) {
          capability.textContent = JSON.stringify(value.capability, null, 2);
        }
      }

      async function request(path, options) {
        output.textContent = "calling...";
        try {
          const response = await fetch(path, options);
          const text = await response.text();
          let body;
          try {
            body = text.length > 0 ? JSON.parse(text) : null;
          } catch (error) {
            body = text;
          }
          show({ status: response.status, body });
        } catch (error) {
          output.textContent = (error.message || String(error)) + "\\n\\n" + (error.stack || "");
        }
      }

      document.querySelector("#create").addEventListener("click", () => {
        request("/api/create", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: capabilityId.value, persistent: persistent.checked }),
        });
      });

      document.querySelector("#increment").addEventListener("click", () => {
        request("/api/increment", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ amount: Number(amount.value) }),
        });
      });

      document.querySelector("#get").addEventListener("click", () => {
        request("/api/get", { method: "POST" });
      });

      document.querySelector("#child").addEventListener("click", () => {
        request("/api/child", { method: "POST" });
      });

      document.querySelector("#missing").addEventListener("click", () => {
        request("/api/missing", { method: "POST" });
      });

      document.querySelector("#save").addEventListener("click", () => {
        request("/api/save", { method: "POST" });
      });

      document.querySelector("#save-restore").addEventListener("click", () => {
        persistent.checked = true;
        capabilityId.value = "demo-counter";
        request("/api/save-restore", { method: "POST" });
      });

      document.querySelector("#drop").addEventListener("click", () => {
        request("/api/drop", { method: "POST" });
        capability.textContent = "No capability yet.";
      });
    </script>
  </body>
</html>`;
}
