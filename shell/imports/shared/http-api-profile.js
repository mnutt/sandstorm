// Declarative settings supplied by requesting apps; labels are never trusted provider identity.
const RESERVED_HEADERS = new Set([
  "authorization", "proxy-authorization", "www-authenticate", "proxy-authenticate",
  "cookie", "cookie2", "set-cookie", "host", "connection", "content-length", "transfer-encoding",
  "te", "trailer", "upgrade", "keep-alive", "expect", "forwarded", "via", "origin", "referer",
  "user-agent", "accept", "accept-encoding", "range", "authorization-token", "api-key", "x-api-key",
]);
function safeDisplayText(value) {
  return Array.from(value).every(char => {
    const code = char.charCodeAt(0);
    return code >= 32 && code !== 127 && !(code >= 0x202a && code <= 0x202e) &&
        !(code >= 0x2066 && code <= 0x2069);
  });
}

export function validateHttpApiKeyHeader(name) {
  if (typeof name !== "string" || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,64}$/.test(name)) {
    throw new Error("Invalid API key header.");
  }
  name = name.toLowerCase();
  if ((RESERVED_HEADERS.has(name) && !["api-key", "x-api-key"].includes(name)) ||
      /^(proxy-|sec-|x-sandstorm-|x-forwarded-|content-|if-|access-control-)/.test(name)) {
    throw new Error("Reserved API key header.");
  }
  return name;
}

export function validateHttpAuthorizationScheme(scheme) {
  if (typeof scheme !== "string" || (scheme &&
      (!/^[A-Za-z][A-Za-z0-9-]{0,31}$/.test(scheme) ||
       ["basic", "digest", "dpop", "negotiate", "aws4-hmac-sha256"].includes(scheme.toLowerCase())))) {
    throw new Error("Unsupported Authorization scheme.");
  }
  return scheme;
}

export function validateHttpAuthenticationMethods(methods = [], required = false) {
  if (!Array.isArray(methods) || methods.length > 1 || (required && methods.length !== 1)) {
    throw new Error("Declare exactly one authentication method, including none for unauthenticated APIs.");
  }
  const seen = new Set();
  return methods.map(method => {
    if (!method || !["none", "bearer", "basic", "apiKey", "rawAuthorization", "authorization", "caller"].includes(method.kind)) {
      throw new Error("Unsupported authentication method.");
    }
    const headerName = method.kind === "apiKey" ? validateHttpApiKeyHeader(method.headerName) : "";
    if (method.kind !== "apiKey" && method.headerName) throw new Error("Unexpected authentication header.");
    const scheme = method.kind === "authorization" ? validateHttpAuthorizationScheme(method.scheme) : "";
    if ((method.kind === "authorization" && !scheme) || (method.kind !== "authorization" && method.scheme)) {
      throw new Error("Unexpected Authorization scheme.");
    }
    const id = method.kind + ":" + headerName + ":" + scheme;
    if (seen.has(id)) throw new Error("Duplicate authentication method.");
    seen.add(id);
    return { kind: method.kind, headerName, ...(scheme ? { scheme } : {}) };
  });
}

export function httpAuthenticationChoices(methods) {
  const choices = validateHttpAuthenticationMethods(methods, true);
  return choices.map(method => ({ ...method,
    id: method.kind === "apiKey" ? "apiKey:" + method.headerName :
        method.kind === "authorization" ? "authorization:" + method.scheme : method.kind,
    label: method.kind === "apiKey" ? "API key (" + method.headerName + ")" :
        method.kind === "authorization" ? method.scheme + " token" :
        ({ none: "None", bearer: "Bearer", basic: "Basic", rawAuthorization: "API key (Authorization)",
          caller: "App supplies credentials" })[method.kind],
  }));
}

export function validateHttpConnectionFields(fields = []) {
  if (!Array.isArray(fields) || fields.length > 16) throw new Error("Invalid connection fields.");
  const seen = new Set();
  return fields.map(field => {
    if (!field || typeof field.headerName !== "string" ||
        !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,64}$/.test(field.headerName)) {
      throw new Error("Invalid connection header name.");
    }
    const name = field.headerName.toLowerCase();
    if (RESERVED_HEADERS.has(name) || /^(proxy-|sec-|x-sandstorm-|x-forwarded-|content-|if-|access-control-)/.test(name) ||
        seen.has(name)) throw new Error("Reserved or duplicate connection header.");
    if (typeof field.label !== "string" || !field.label.trim() || field.label.length > 80 ||
        !safeDisplayText(field.label) ||
        (field.description !== undefined && (typeof field.description !== "string" ||
          field.description.length > 300 || !safeDisplayText(field.description))) ||
        (field.required !== undefined && typeof field.required !== "boolean")) {
      throw new Error("Invalid connection field description.");
    }
    seen.add(name);
    return { headerName: name, label: field.label, description: field.description || "",
      required: field.required || false };
  });
}

export function httpAuthenticationHint(hint) {
  if (!hint) return "none";
  return ["none", "basic", "bearer", "caller"].includes(hint) ? hint : null;
}

export function validateHttpMethods(methods = []) {
  const allowed = ["get", "post", "put", "patch", "delete", "head", "options"];
  if (!Array.isArray(methods) || methods.length > allowed.length ||
      methods.some(method => typeof method !== "string" || !allowed.includes(method.toLowerCase()))) {
    throw new Error("Unsupported HTTP methods.");
  }
  const normalized = methods.map(method => method.toLowerCase());
  if (new Set(normalized).size !== normalized.length) throw new Error("Duplicate HTTP method.");
  return normalized;
}

export function requireHttpCredentialTls(url, auth) {
  if (auth && Object.keys(auth).some(kind => kind !== "none") &&
      new URL(url).protocol !== "https:") {
    throw new Error("Connections with credentials require HTTPS.");
  }
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
  requireHttpCredentialTls(request.url, auth);
  if (!auth || typeof auth !== "object" || Object.keys(auth).length !== 1 ||
      !["none", "bearer", "basic", "apiKey", "oauth", "authorization", "caller"].includes(Object.keys(auth)[0])) {
    throw new Error("Invalid authentication credentials.");
  }
  const methods = validateHttpAuthenticationMethods(request.authenticationMethods);
  if (auth.apiKey) {
    auth.apiKey.headerName = validateHttpApiKeyHeader(auth.apiKey.headerName);
    if (typeof auth.apiKey.value !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(auth.apiKey.value)) {
      throw new Error("Enter a non-empty API key without whitespace.");
    }
  }
  if (auth.authorization) {
    validateHttpAuthorizationScheme(auth.authorization.scheme);
    if (typeof auth.authorization.value !== "string" ||
        !/^[\x21-\x7e]{1,4096}$/.test(auth.authorization.value)) {
      throw new Error("Enter a non-empty Authorization credential without whitespace.");
    }
  }
  if (methods.length && !methods.some(method => {
    if (method.kind === "rawAuthorization") return auth.authorization?.scheme === "";
    if (method.kind === "authorization") return auth.authorization?.scheme === method.scheme;
    return method.kind in auth && (method.kind !== "apiKey" || method.headerName === auth.apiKey.headerName);
  })) {
    throw new Error("Credentials must match the requested authentication method.");
  }
  if ("bearer" in auth && (!auth.bearer || !/^[\x21-\x7e]+$/.test(auth.bearer))) {
    throw new Error("Enter a non-empty bearer credential without whitespace.");
  }

  if (auth.basic && (!auth.basic.username || auth.basic.username.includes(":") ||
      Array.from(auth.basic.username + auth.basic.password)
          .some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))) {
    throw new Error("Invalid Basic authentication fields.");
  }

  const fields = validateHttpConnectionFields(request.connectionFields);
  if (auth.apiKey && fields.some(field => field.headerName === auth.apiKey.headerName)) {
    throw new Error("Connection settings cannot override authentication.");
  }
  const allowed = new Set(fields.map(field => field.headerName));
  const seen = new Set();
  (request.connectionHeaders || []).forEach(header => {
    if (!allowed.has(header.name) || seen.has(header.name) ||
        !header.value || header.value.length > 256 || !/^[\x21-\x7e]+$/.test(header.value)) {
      throw new Error("Invalid connection header.");
    }

    seen.add(header.name);
  });
  if (fields.some(field => field.required && !seen.has(field.headerName))) {
    throw new Error("Complete all required connection settings.");
  }
}
