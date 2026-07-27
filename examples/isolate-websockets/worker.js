import {
  sandstorm,
  serveCapnp,
} from "sandstorm:api";
import {
  Counter,
  CounterSubscription,
} from "capnp:./counter.capnp";

const COUNTER_KEY = "counter";
const subscribers = new Set();

async function readCounter(env) {
  const stored = await sandstorm(env).storage().get(COUNTER_KEY);
  if (stored === undefined) return 0n;
  return BigInt(stored);
}

async function notifySubscribers(value) {
  await Promise.all(Array.from(subscribers, async (listener) => {
    try {
      await listener.update({ value });
    } catch (error) {
      subscribers.delete(listener);
      console.error("Dropping a disconnected counter listener", error);
    }
  }));
}

const counter = serveCapnp(Counter, {
  async read(_params, { env }) {
    return { value: await readCounter(env) };
  },

  async change({ delta }, { env }) {
    if (delta !== 1 && delta !== -1) {
      throw new RangeError("counter delta must be +1 or -1");
    }
    const value = await sandstorm(env).storage().increment(COUNTER_KEY, delta);
    await notifySubscribers(value);
    return { value };
  },

  async subscribe({ listener }, { env }) {
    subscribers.add(listener);
    try {
      await listener.update({ value: await readCounter(env) });
    } catch (error) {
      subscribers.delete(listener);
      throw error;
    }
    return {
      subscription: new CounterSubscription.Server({
        close() {
          subscribers.delete(listener);
        },
      }).client(),
    };
  },
});

function renderPage() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Isolate Cap'n Proto Counter</title>
    <style>
      :root { color-scheme: light dark; font: 16px/1.5 system-ui, sans-serif; }
      body { display: grid; margin: 0; min-height: 100vh; place-items: center; }
      main { max-width: 34rem; padding: 2rem; text-align: center; }
      .counter { align-items: center; display: flex; gap: 1rem;
        justify-content: center; margin: 2rem 0; }
      button { border: 1px solid currentColor; border-radius: .5rem; cursor: pointer;
        font: inherit; font-size: 1.75rem; height: 3.25rem; width: 3.25rem; }
      button:disabled { cursor: wait; opacity: .45; }
      #value { font-size: 3.5rem; font-variant-numeric: tabular-nums;
        font-weight: 700; min-width: 5ch; }
      #status { font-weight: 600; }
      .hint { opacity: .75; }
    </style>
  </head>
  <body>
    <main>
      <h1>Cap'n Proto counter</h1>
      <p>The durable value and live updates both use the typed Counter interface.</p>
      <div class="counter">
        <button id="decrement" type="button" aria-label="Decrement" disabled>−</button>
        <output id="value" aria-live="polite">…</output>
        <button id="increment" type="button" aria-label="Increment" disabled>+</button>
      </div>
      <p id="status" role="status">Connecting…</p>
      <p class="hint">Open another tab to see callback capabilities update both views.</p>
    </main>

    <script type="module">
      import {
        Counter,
        CounterListener,
      } from "/__sandstorm/capnp/counter.capnp.js";
      import {
        observeBrowserNativeCapnpApplication,
      } from "/__sandstorm/native-capnp/client.js";

      const value = document.querySelector("#value");
      const status = document.querySelector("#status");
      const buttons = [
        document.querySelector("#decrement"),
        document.querySelector("#increment"),
      ];
      let subscription = null;

      function setConnected(connected) {
        for (const button of buttons) button.disabled = !connected;
        status.textContent = connected ? "Live" : "Disconnected; reconnecting…";
      }

      const listener = new CounterListener.Server({
        update({ value: nextValue }) {
          value.value = String(nextValue);
          value.textContent = String(nextValue);
        },
      }).client();

      const observed = observeBrowserNativeCapnpApplication(
        Counter,
        async (counter) => {
          if (counter === null) {
            subscription = null;
            setConnected(false);
            return;
          }
          const result = await counter.subscribe({ listener });
          subscription = result.subscription;
          setConnected(true);
        },
        {
          onError(error) {
            status.textContent = error.message || String(error);
          },
        });

      async function change(delta) {
        if (!observed.client) return;
        setConnected(false);
        try {
          await observed.client.change({ delta });
          setConnected(true);
        } catch (error) {
          status.textContent = error.message || String(error);
        }
      }

      document.querySelector("#decrement").addEventListener("click", () => change(-1));
      document.querySelector("#increment").addEventListener("click", () => change(1));
      window.addEventListener("pagehide", () => {
        subscription?.close().catch(() => {});
        observed.close();
      }, { once: true });
    </script>
  </body>
</html>`;
}

export default {
  browser: counter,
  fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/") {
      return new Response("Not found", { status: 404 });
    }
    return new Response(renderPage(), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};
