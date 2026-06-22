import { RpcTarget, sandstorm } from "sandstorm:api";

const PROVIDER_DESCRIPTOR = "EAlQAQEAABEBF1EEAQH_y9-dR8kYld8AUAEBAXsRASIHZm9v";

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[char]));
}

function renderRequestPage(session) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Isolate Capability Provider</title>
  </head>
  <body>
    <h1>Isolate Capability Provider</h1>
    <p>Provides route-backed WebSession and native app-object capabilities.</p>
    <button id="fulfill-api" type="button">Use this provider</button>
    <button id="fulfill-feed" type="button">Use feed provider</button>
    <button id="fulfill-llm" type="button">Use LLM provider</button>
    <pre id="result">${htmlEscape(JSON.stringify(session, null, 2))}</pre>

    <script type="module">
      const result = document.querySelector("#result");
      async function fulfill(button, path) {
        button.disabled = true;
        result.textContent = "fulfilling";
        try {
          const response = await fetch(path, { method: "POST" });
          const body = await response.json();
          result.textContent = JSON.stringify(body, null, 2);
        } catch (error) {
          result.textContent = (error.message || String(error)) + "\\n" + (error.stack || "");
          button.disabled = false;
        }
      }

      document.querySelector("#fulfill-api").addEventListener("click", (event) => {
        fulfill(event.currentTarget, "/__sandstorm/provider-api/fulfill");
      });
      document.querySelector("#fulfill-feed").addEventListener("click", (event) => {
        fulfill(event.currentTarget, "/__sandstorm/provider-feed/fulfill");
      });
      document.querySelector("#fulfill-llm").addEventListener("click", (event) => {
        fulfill(event.currentTarget, "/__sandstorm/provider-llm/fulfill");
      });
    </script>
  </body>
</html>`;
}

class MailFeed extends RpcTarget {
  #api;

  constructor(api) {
    super();
    this.#api = api;
  }

  async subscribe(receiver) {
    const result = await receiver.call("onMailEvent", {
      subject: "isolate-feed-live-callback",
      unread: 2,
    });
    return {
      ok: true,
      mode: "live",
      result,
    };
  }

  async subscribeSaved(token) {
    const receiver = await this.#api.restore(token);
    try {
      const result = await receiver.rpc.onMailEvent({
        subject: "isolate-feed-saved-callback",
        unread: 5,
      });
      return {
        ok: true,
        mode: "saved",
        result,
      };
    } finally {
      await receiver.drop();
    }
  }
}

class LlmSession extends RpcTarget {
  #topic;
  #turns = [];

  constructor(topic) {
    super();
    this.#topic = topic;
  }

  async complete(prompt) {
    const text = String(prompt);
    this.#turns.push(text);
    return {
      ok: true,
      topic: this.#topic,
      turn: this.#turns.length,
      text: `reply(${this.#topic}): ${text}`,
    };
  }

  history() {
    return this.#turns.map((prompt, index) => ({
      turn: index + 1,
      prompt,
    }));
  }
}

class ConversationalLlm extends RpcTarget {
  startSession(options = {}) {
    return new LlmSession(String(options.topic || "general"));
  }
}

export default {
  async fetch(request, env) {
    const api = sandstorm(request, env);
    const session = api.session();
    const url = new URL(request.url);
    const fulfillApi = api.powerboxFulfillment({
      routePrefix: "/__sandstorm/provider-api",
      title: "Isolate Capability Provider",
      description: "Provides a route-backed WebSession from an isolate grain.",
      buttonLabel: "Use this provider",
      capability: () => api.webSession({ pathPrefix: "/provided" }),
      fulfill: {
        title: "Isolate Capability Provider",
        verbPhrase: "can provide isolate capability responses",
        description: "Provides a route-backed WebSession from an isolate grain.",
        requiredPermissions: ["view"],
        descriptor: PROVIDER_DESCRIPTOR,
      },
    });
    const fulfillFeed = api.powerboxFulfillment({
      routePrefix: "/__sandstorm/provider-feed",
      title: "Isolate Feed Provider",
      description: "Provides an app-defined feed object from an isolate grain.",
      buttonLabel: "Use feed provider",
      capability: () => api.export(new MailFeed(api)),
      fulfill: {
        title: "Isolate Feed Provider",
        verbPhrase: "can provide feed events",
        description: "Provides an app-defined feed object from an isolate grain.",
        requiredPermissions: ["view"],
        descriptor: PROVIDER_DESCRIPTOR,
      },
    });
    const fulfillLlm = api.powerboxFulfillment({
      routePrefix: "/__sandstorm/provider-llm",
      title: "Isolate LLM Provider",
      description: "Provides an app-defined LLM object with returned child sessions.",
      buttonLabel: "Use LLM provider",
      capability: () => api.export(new ConversationalLlm()),
      fulfill: {
        title: "Isolate LLM Provider",
        verbPhrase: "can provide conversational sessions",
        description: "Provides an app-defined LLM object with returned child sessions.",
        requiredPermissions: ["view"],
        descriptor: PROVIDER_DESCRIPTOR,
      },
    });
    const helperResponse =
      await fulfillApi.serve() ||
      await fulfillFeed.serve() ||
      await fulfillLlm.serve();
    if (helperResponse) {
      return helperResponse;
    }

    if (url.pathname === "/provided/status") {
      return Response.json({
        ok: true,
        source: "isolate-capability-provider",
        path: url.pathname,
        search: url.search,
        method: request.method,
        sessionType: session.sessionType,
        user: session.user,
      });
    }

    return new Response(renderRequestPage(session), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};
