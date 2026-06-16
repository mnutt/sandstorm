function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[char]));
}

function renderPage(result) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Isolate Service Binding</title>
    <style>
      body {
        color: #1f2937;
        font: 16px/1.5 system-ui, sans-serif;
        margin: 2rem;
        max-width: 760px;
      }
      pre {
        background: #f3f4f6;
        border: 1px solid #d1d5db;
        border-radius: 6px;
        overflow: auto;
        padding: 1rem;
      }
    </style>
  </head>
  <body>
    <h1>Isolate Service Binding</h1>
    <p>This worker called its own <code>/target</code> route through <code>env.LOOPBACK</code>.</p>
    <pre>${htmlEscape(JSON.stringify(result, null, 2))}</pre>
  </body>
</html>`;
}

function bytesFromBinding(value) {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  } else if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else if (typeof value === "string") {
    return new TextEncoder().encode(value);
  } else {
    return new Uint8Array();
  }
}

function checksum(bytes) {
  let result = 0;
  for (const byte of bytes) {
    result = (result + byte) >>> 0;
  }
  return result;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/target") {
      return Response.json({
        ok: true,
        route: "/target",
        method: request.method,
        search: url.search,
        body: await request.text(),
        header: request.headers.get("x-service-binding-example"),
      });
    }

    const response = await env.LOOPBACK.fetch("http://loopback/target?via=service-binding", {
      method: "POST",
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-service-binding-example": "present",
      },
      body: "hello from the caller route",
    });
    const payload = bytesFromBinding(env.PAYLOAD);

    const result = {
      ok: response.ok,
      status: response.status,
      textBinding: env.MESSAGE || null,
      jsonBinding: env.SETTINGS || null,
      dataBinding: {
        bytes: payload.byteLength,
        checksum: checksum(payload),
      },
      body: await response.json(),
    };

    if (url.pathname === "/json") {
      return Response.json(result);
    }

    return new Response(renderPage(result), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};
