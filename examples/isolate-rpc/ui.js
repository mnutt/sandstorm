export function renderRpcDemo() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Isolate RPC</title>
    <style>
      body {
        color: #1f2933;
        font: 15px/1.45 system-ui, sans-serif;
        margin: 2rem;
      }

      main {
        max-width: 48rem;
      }

      .controls {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        margin: 1rem 0;
      }

      input, button {
        font: inherit;
      }

      button {
        background: #174ea6;
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
      <h1>Isolate RPC</h1>
      <div class="controls">
        <input id="name" value="Sandstorm">
        <button id="hello">hello()</button>
        <button id="increment">increment()</button>
        <button id="add">add(2, 40)</button>
        <button id="batch">batch three calls</button>
        <button id="target">returned target</button>
        <button id="pipeline">pipelined target call</button>
        <button id="pipeline-arg">pipelined argument</button>
        <button id="sandstorm-target">Sandstorm target</button>
        <button id="powerbox-request">Powerbox request + claim</button>
        <button id="bad-input">bad input</button>
      </div>
      <pre id="output">ready</pre>
    </main>

    <script type="module">
      import { newSandstormRpcSession, requestAndClaimPowerbox } from "./rpc-client.js";

      const output = document.querySelector("#output");
      const name = document.querySelector("#name");

      function openApi() {
        return newSandstormRpcSession();
      }

      function show(value) {
        output.textContent = JSON.stringify(value, null, 2);
      }

      async function run(action) {
        output.textContent = "calling...";
        try {
          show(await action());
        } catch (error) {
          output.textContent = (error.message || String(error)) + "\\n\\n" + (error.stack || "");
        }
      }

      document.querySelector("#hello").addEventListener("click", () => {
        run(() => openApi().hello(name.value));
      });
      document.querySelector("#increment").addEventListener("click", () => {
        run(() => openApi().increment());
      });
      document.querySelector("#add").addEventListener("click", () => {
        run(() => openApi().add(2, 40));
      });
      document.querySelector("#batch").addEventListener("click", () => {
        run(async () => {
          const api = openApi();
          const [hello, sum, counter] = await Promise.all([
            api.hello(name.value),
            api.add(2, 40),
            api.increment(),
          ]);
          return { hello, sum, counter };
        });
      });
      document.querySelector("#target").addEventListener("click", () => {
        run(async () => {
          const counter = openApi().counter("subtarget");
          const [before, after] = await Promise.all([
            counter.get(),
            counter.increment(),
          ]);
          return { before, after };
        });
      });
      document.querySelector("#pipeline").addEventListener("click", () => {
        run(() => openApi().counter("pipelined").increment());
      });
      document.querySelector("#pipeline-arg").addEventListener("click", () => {
        run(() => {
          const api = openApi();
          return api.add(api.add(20, 20), 2);
        });
      });
      document.querySelector("#sandstorm-target").addEventListener("click", () => {
        run(async () => {
          const system = openApi().sandstorm();
          const storage = system.storage();
          const [session, runtime, write, stored] = await Promise.all([
            system.session(),
            system.runtime(),
            storage.put("rpc-system-target", "available"),
            storage.get("rpc-system-target"),
          ]);
          return { session, runtime, write, stored };
        });
      });
      document.querySelector("#powerbox-request").addEventListener("click", () => {
        run(async () => {
          const requested = await requestAndClaimPowerbox(null, {
            requiredPermissions: ["view"],
          });
          const api = openApi();
          const saved = await api.savePowerboxCapability(
            requested.capability, "Isolate RPC saved capability");
          const stored = await api.storeSavedPowerboxCapability(saved);
          const restored = await api.restorePowerboxCapability(stored.token);
          const dropped = await api.dropPowerboxCapability(requested.capability);
          const droppedRestored = await api.dropPowerboxCapability(restored);
          const droppedSaved = await api.dropSavedPowerboxCapability(stored.token);
          return {
            requested, saved, stored, restored, dropped, droppedRestored, droppedSaved,
          };
        });
      });
      document.querySelector("#bad-input").addEventListener("click", () => {
        run(() => openApi().counter("../bad-key").increment());
      });
    </script>
  </body>
</html>`;
}
