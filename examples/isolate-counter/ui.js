function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderCounter({ count, metadata, helpText, session }) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml(metadata.title)}</title>
    <style>
      body {
        color: #171717;
        font: 16px/1.5 system-ui, sans-serif;
        margin: 2rem;
      }

      main {
        max-width: 42rem;
      }

      .count {
        font-size: 3rem;
        font-weight: 700;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(metadata.title)}</h1>
      <p>${escapeHtml(helpText)}</p>
      <p class="count">${count}</p>
      <p>Signed in as ${escapeHtml(session.user.displayName || "anonymous user")}.</p>
    </main>
  </body>
</html>`;
}
