// Sandstorm-owned connection metadata. These bindings never contain credentials.
export const OPENAI_PROFILE = Object.freeze({
  title: "OpenAI API",
  baseUrl: "https://api.openai.com/v1",
  authentication: "bearer",
  secretLabel: "API key",
  headers: ["openai-organization", "openai-project"],
});

export function httpApiProfile(url) {
  // Exact matching avoids presenting an app-supplied lookalike as a trusted provider.
  return url === OPENAI_PROFILE.baseUrl || url === OPENAI_PROFILE.baseUrl + "/"
      ? OPENAI_PROFILE : null;
}

export function httpAuthenticationHint(hint) {
  if (!hint) return "none";
  return ["basic", "bearer"].includes(hint) ? hint : null;
}

export function validateHttpConnection(request) {
  let url;
  try {
    url = new URL(request.url);
  } catch {
    // Do not attach the parser error: it can contain credentials from the submitted URL.
    throw new Error("Invalid HTTP destination.");
  }

  if (!["https:", "http:"].includes(url.protocol) || !url.hostname ||
      url.username || url.password || url.hash || url.search || /[\s\\]/.test(request.url)) {
    throw new Error("Use an HTTP base URL without credentials, query, or fragment.");
  }

  const auth = request.auth;
  if ("bearer" in auth && (!auth.bearer || !/^[\x21-\x7e]+$/.test(auth.bearer))) {
    throw new Error("Enter a non-empty bearer credential without whitespace.");
  }

  if (auth.basic && (!auth.basic.username || auth.basic.username.includes(":") ||
      Array.from(auth.basic.username + auth.basic.password)
          .some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))) {
    throw new Error("Invalid Basic authentication fields.");
  }

  const profile = httpApiProfile(request.url);
  const seen = new Set();
  (request.connectionHeaders || []).forEach(header => {
    if (!profile || !profile.headers.includes(header.name) || seen.has(header.name) ||
        !header.value || header.value.length > 256 || !/^[\x21-\x7e]+$/.test(header.value)) {
      throw new Error("Invalid connection header.");
    }

    seen.add(header.name);
  });
}
