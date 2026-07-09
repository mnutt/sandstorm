import { sandstorm } from "sandstorm:api";
import {
  exportNativeCapnp,
  nativeCapnpPowerboxDescriptor,
} from "sandstorm:capnp";
import { File, FileStore } from "capnp:./file-store.capnp";

const encoder = new TextEncoder();

const FILES = Object.freeze({
  "readme.txt": Object.freeze({
    contentType: "text/plain; charset=utf-8",
    content: encoder.encode("hello from the file-store RPC example\n"),
  }),
  "docs/intro.txt": Object.freeze({
    contentType: "text/plain; charset=utf-8",
    content: encoder.encode("this file is served through capnp-shaped RPC\n"),
  }),
  "docs/api/listing.txt": Object.freeze({
    contentType: "text/plain; charset=utf-8",
    content: encoder.encode("listDirectory(path) returns direct children\n"),
  }),
});

function normalizePath(path = "") {
  return String(path).replace(/^\/+/, "").replace(/\/+$/, "");
}

function basename(path) {
  const parts = normalizePath(path).split("/");
  return parts[parts.length - 1] || "";
}

function directoryPrefix(path) {
  path = normalizePath(path);
  return path === "" ? "" : `${path}/`;
}

function fileRecord(path) {
  return FILES[normalizePath(path)] || null;
}

function directoryExists(path) {
  const prefix = directoryPrefix(path);
  return Object.keys(FILES).some((filePath) => filePath.startsWith(prefix));
}

function statPath(path) {
  path = normalizePath(path);
  const file = fileRecord(path);
  if (file) {
    return {
      name: basename(path),
      path,
      kind: "file",
      size: file.content.byteLength,
      contentType: file.contentType,
    };
  }

  if (directoryExists(path)) {
    return {
      name: basename(path),
      path,
      kind: "directory",
      size: 0,
      contentType: "",
    };
  }

  throw new Error(`not found: ${path}`);
}

function jsonEntry(entry) {
  return {
    name: entry.name,
    path: entry.path,
    kind: entry.kind,
    size: Number(entry.size),
    contentType: entry.contentType,
  };
}

function jsonListing(listing) {
  return {
    entries: Array.from(listing.entries || []).map(jsonEntry),
  };
}

function jsonStat(stat) {
  return {
    entry: jsonEntry(stat.entry),
  };
}

function bytesFromData(data) {
  return typeof data?.toUint8Array === "function" ? data.toUint8Array() : data;
}

function listDirectory(path) {
  path = normalizePath(path);
  const prefix = directoryPrefix(path);
  const children = new Map();

  for (const filePath of Object.keys(FILES)) {
    if (!filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    if (rest === "") continue;

    const first = rest.split("/")[0];
    const childPath = prefix + first;
    if (!children.has(first)) {
      children.set(first, statPath(childPath));
    }
  }

  if (children.size === 0 && !directoryExists(path)) {
    throw new Error(`not a directory: ${path}`);
  }

  return [...children.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function makeFile(path) {
  path = normalizePath(path);
  if (!fileRecord(path)) {
    throw new Error(`not a file: ${path}`);
  }

  return new File.Server({
    async stat() {
      return { entry: statPath(path) };
    },

    async read() {
      const file = fileRecord(path);
      return {
        content: file.content,
        contentType: file.contentType,
      };
    },
  }).client();
}

function makeFileStore() {
  return {
    async listDirectory({ path = "" } = {}) {
      return { entries: listDirectory(path) };
    },

    async stat({ path = "" } = {}) {
      return { entry: statPath(path) };
    },

    async readFile({ path = "" } = {}) {
      const file = fileRecord(path);
      if (!file) {
        throw new Error(`not a file: ${normalizePath(path)}`);
      }
      return {
        content: file.content,
        contentType: file.contentType,
      };
    },

    async openFile({ path = "" } = {}) {
      return { file: makeFile(path) };
    },
  };
}

function renderPage() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>File Store RPC</title>
  </head>
  <body>
    <h1>File Store RPC</h1>
    <form method="post" action="/export-file-store">
      <button type="submit">Export file-store capability</button>
    </form>
    <p><a href="/self-test">Run local self-test</a></p>
  </body>
</html>`;
}

async function descriptor(env) {
  return nativeCapnpPowerboxDescriptor(env, FileStore, { interfaceName: "FileStore" });
}

export default {
  async fetch(request, env) {
    const api = sandstorm(request, env);

    const system = await api.serveSystemRoutes();
    if (system) return system;

    const url = new URL(request.url);

    if (url.pathname === "/self-test") {
      const store = new FileStore.Server(makeFileStore()).client();
      const root = await store.listDirectory({ path: "" });
      const docs = await store.listDirectory({ path: "docs" });
      const stat = await store.stat({ path: "docs/intro.txt" });
      const opened = await store.openFile({ path: "docs/intro.txt" });
      const read = await opened.file.read();
      return Response.json({
        ok: true,
        interfaceName: FileStore.interfaceName || "FileStore",
        methodNames: Array.from(FileStore.methodNames || []),
        root: jsonListing(root),
        docs: jsonListing(docs),
        stat: jsonStat(stat),
        read: {
          contentType: read.contentType,
          text: new TextDecoder().decode(bytesFromData(read.content)),
        },
      });
    }

    if (url.pathname === "/export-file-store" && request.method === "POST") {
      const capability = await exportNativeCapnp(api, FileStore, makeFileStore(), {
        interfaceName: "FileStore",
      });
      return Response.json({
        ok: true,
        info: await capability.info(),
        descriptor: await descriptor(env),
      });
    }

    return new Response(renderPage(), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};
