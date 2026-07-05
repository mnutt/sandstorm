import { sandstorm } from "sandstorm:api";
import { ObjectStore } from "capnp:./object-store.capnp";

const OBJECTS = Object.freeze({
  photos: Object.freeze({
    "2026/cover.txt": {
      contentType: "text/plain; charset=utf-8",
      body: "cover image placeholder\n",
    },
    "2026/thumb.txt": {
      contentType: "text/plain; charset=utf-8",
      body: "thumbnail placeholder\n",
    },
  }),
  docs: Object.freeze({
    "readme.txt": {
      contentType: "text/plain; charset=utf-8",
      body: "object-store example\n",
    },
  }),
});

function findObject(bucket, key) {
  return OBJECTS[bucket]?.[key] || null;
}

function objectPath(bucket, key) {
  return `/objects/${encodeURIComponent(bucket)}/${encodeURIComponent(key)}`;
}

function objectInfo(key, object) {
  return {
    key,
    size: new TextEncoder().encode(object.body).byteLength,
    contentType: object.contentType,
  };
}

function makeObjectStore(api) {
  return {
    async listObjects({ bucket = "", prefix = "", cursor = "" } = {}) {
      const entries = Object.entries(OBJECTS[bucket] || {})
        .filter(([key]) => key.startsWith(prefix))
        .sort(([left], [right]) => left.localeCompare(right));
      const start = cursor ? Math.max(0, entries.findIndex(([key]) => key > cursor)) : 0;
      const page = entries.slice(start, start + 100);
      return {
        objects: page.map(([key, object]) => objectInfo(key, object)),
        nextCursor: "",
      };
    },

    async openObject({ bucket = "", key = "" } = {}) {
      if (!findObject(bucket, key)) {
        throw new Error(`object not found: ${bucket}/${key}`);
      }
      return api.webSession({ pathPrefix: objectPath(bucket, key) });
    },
  };
}

function serveObject(url) {
  const match = url.pathname.match(/^\/objects\/([^/]+)\/([^/]+)$/);
  if (!match) return null;

  const bucket = decodeURIComponent(match[1]);
  const key = decodeURIComponent(match[2]);
  const object = findObject(bucket, key);
  if (!object) {
    return Response.json({ ok: false, error: "object not found" }, { status: 404 });
  }

  return new Response(object.body, {
    headers: {
      "content-type": object.contentType,
      "etag": `"${bucket}/${key}"`,
    },
  });
}

export default {
  async fetch(request, env) {
    const api = sandstorm(request, env, {
      capabilities: {
        objectStore: ObjectStore.implement(makeObjectStore(
          sandstorm(request, env))),
      },
    });

    const system = await api.serveSystemRoutes();
    if (system) return system;

    const url = new URL(request.url);
    const objectResponse = serveObject(url);
    if (objectResponse) return objectResponse;

    const store = ObjectStore.local(makeObjectStore(api));
    const listing = await store.listObjects({
      bucket: "photos",
      prefix: "2026/",
      cursor: "",
    });
    const object = await store.openObject({
      bucket: "photos",
      key: "2026/cover.txt",
    });
    const response = await object.fetch("", { method: "GET" });

    return Response.json({
      ok: true,
      interfaceName: ObjectStore.interfaceName,
      methodNames: ObjectStore.methodNames,
      listing,
      object: {
        status: response.status,
        contentType: response.headers.get("content-type"),
        body: await response.text(),
      },
    });
  },
};
