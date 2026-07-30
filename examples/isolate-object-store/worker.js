import {
  exportCapnp,
  sandstorm,
} from "sandstorm:api";
import { ObjectStore, StoredObject } from "capnp:./object-store.capnp";

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

function objectInfo(key, object) {
  return {
    key,
    size: new TextEncoder().encode(object.body).byteLength,
    contentType: object.contentType,
  };
}

function jsonObjectInfo(info) {
  return {
    key: info.key,
    size: Number(info.size),
    contentType: info.contentType,
  };
}

function jsonObjectListing(listing) {
  return {
    objects: Array.from(listing.objects || []).map(jsonObjectInfo),
    nextCursor: listing.nextCursor,
  };
}

function makeObjectStore() {
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
      const object = findObject(bucket, key);
      return {
        object: new StoredObject.Server({
          read() {
            return {
              body: new TextEncoder().encode(object.body),
              contentType: object.contentType,
              eTag: `"${bucket}/${key}"`,
            };
          },
        }).client(),
      };
    },
  };
}

export default async function objectStoreFetch(request, env) {
    const api = sandstorm(request, env);

    const url = new URL(request.url);

    if (url.pathname === "/export-object-store") {
      const exported = await exportCapnp(api, ObjectStore, makeObjectStore());
      return Response.json({
        ok: true,
        token: await exported.save({ label: "ObjectStore" }),
      });
    }

    const store = new ObjectStore.Server(makeObjectStore()).client();
    const listing = await store.listObjects({
      bucket: "photos",
      prefix: "2026/",
      cursor: "",
    });
    const object = await store.openObject({
      bucket: "photos",
      key: "2026/cover.txt",
    });
    const content = await object.object.read({});
    const bodyBytes = typeof content.body.toUint8Array === "function"
      ? content.body.toUint8Array()
      : content.body;

    return Response.json({
      ok: true,
      interfaceName: "ObjectStore",
      interfaceId: `0x${ObjectStore._capnp.typeIdHex}`,
      listing: jsonObjectListing(listing),
      object: {
        contentType: content.contentType,
        eTag: content.eTag,
        body: new TextDecoder().decode(bodyBytes),
      },
    });
}
