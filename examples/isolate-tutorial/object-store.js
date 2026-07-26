import {
  createCapnpStruct,
  defineWorker,
  exportCapnp,
  mainViewFromFetch,
  readCapnpStruct,
  sandstorm,
  storage,
} from "sandstorm:api";
import { ObjectStore, ObjectStoreObjectId, ObjectUploadTarget } from "capnp:./object-store.capnp";

const INDEX_KEY = "object-index";
const MAX_OBJECT_BYTES = 1024 * 1024;
let indexUpdateQueue = Promise.resolve();
const VIEW_INFO = {
  appTitle: { defaultText: "Object Store" },
  matchRequests: [{
    tags: [{
      id: ObjectUploadTarget._capnp.typeId,
    }],
  }],
};

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[ch]);
}

function objectStorageKey() {
  return `object-${crypto.randomUUID()}`;
}

function makeObjectStoreObjectId(type, bucket, prefix = "") {
  return createCapnpStruct(ObjectStoreObjectId, { type, bucket, prefix });
}

function readObjectStoreObjectId(objectId) {
  const decoded = readCapnpStruct(ObjectStoreObjectId, objectId);
  return {
    type: decoded.type,
    bucket: decoded.bucket,
    prefix: decoded.prefix,
  };
}

function validateObjectScope(value, name) {
  value = String(value || "");
  if (value.includes("..") || value.startsWith("/") || value.includes("\0")) {
    throw new Error(`invalid ${name}`);
  }
  return value;
}

function validateObjectKey(value) {
  value = String(value || "");
  if (!value || value.includes("..") || value.startsWith("/") || value.includes("\0")) {
    throw new Error("invalid object key");
  }
  return value;
}

async function loadIndex(store) {
  return (await store.getJson(INDEX_KEY)) || [];
}

async function saveIndex(store, index) {
  await store.putJson(INDEX_KEY, index);
}

async function updateIndex(store, callback) {
  const update = indexUpdateQueue.then(async () => {
    const index = await loadIndex(store);
    const { nextIndex, value } = await callback(index);
    await saveIndex(store, nextIndex);
    return value;
  });
  indexUpdateQueue = update.catch(() => {});
  return update;
}

async function putStorageBytes(store, key, bytes) {
  const result = await store.put(key, bytes);
  if (!result?.ok) {
    throw new Error(`storage put ${key} failed with ${result?.status || "unknown status"}`);
  }
  return result;
}

function createObjectStorage(store) {
  return {
    async list({ bucket = "inbox", prefix = "", cursor = "" }) {
      bucket = validateObjectScope(bucket || "inbox", "bucket");
      prefix = validateObjectScope(prefix || "", "prefix");
      cursor = String(cursor || "");

      const matches = (await loadIndex(store))
        .filter((item) => item.bucket === bucket && item.key.startsWith(prefix))
        .filter((item) => !cursor || item.key > cursor)
        .sort((a, b) => a.key.localeCompare(b.key));
      const page = matches.slice(0, 100);
      const objects = page.map(({ key, size, contentType }) => ({ key, size, contentType }));

      return {
        objects,
        nextCursor: matches.length > page.length ? page[page.length - 1].key : "",
      };
    },

    async putObject({ bucket, key, contentType, data, overwrite = false }) {
      bucket = validateObjectScope(bucket || "inbox", "bucket");
      key = validateObjectKey(key);
      const bytes = data.toUint8Array();

      if (bytes.byteLength >= MAX_OBJECT_BYTES) {
        throw new Error("object is too large; this tutorial accepts files smaller than 1 MiB");
      }

      const storageKey = objectStorageKey();
      await putStorageBytes(store, storageKey, bytes);

      try {
        await updateIndex(store, async (index) => {
          const exists = index.some((item) => item.bucket === bucket && item.key === key);
          if (exists && !overwrite) {
            throw new Error("object already exists");
          }

          const nextIndex = index.filter((item) => !(item.bucket === bucket && item.key === key));
          nextIndex.push({
            bucket,
            key,
            size: bytes.byteLength,
            contentType,
            storageKey,
          });
          return { nextIndex, value: bytes.byteLength };
        });
      } catch (error) {
        await store.delete(storageKey);
        throw error;
      }

      return { size: BigInt(bytes.byteLength) };
    },
  };
}

function makeUploadTarget(store, bucket, prefix = "") {
  bucket = validateObjectScope(bucket || "inbox", "bucket");
  prefix = validateObjectScope(prefix || "", "prefix");
  const objects = createObjectStorage(store);

  return {
    async putObject({ key, contentType = "application/octet-stream", data }) {
      const fullKey = `${prefix}${validateObjectKey(key)}`;
      return await objects.putObject({
        bucket,
        key: fullKey,
        contentType,
        data,
        overwrite: false,
      });
    },

    async save() {
      return {
        objectId: makeObjectStoreObjectId("uploadTarget", bucket, prefix),
        label: { defaultText: `upload to ${bucket}/${prefix || ""}` },
      };
    },
  };
}

function makeUploadTargetClient(store, bucket, prefix = "") {
  return new ObjectUploadTarget.Server(makeUploadTarget(store, bucket, prefix)).client();
}

function makeObjectStore(store) {
  const objects = createObjectStorage(store);

  return {
    async listObjects({ bucket = "inbox", prefix = "", cursor = "" }) {
      return await objects.list({ bucket, prefix, cursor });
    },

    async uploadTarget({ bucket = "inbox", prefix = "" }) {
      return {
        target: makeUploadTargetClient(store, bucket, prefix),
      };
    },
  };
}

async function exportUploader(api, store, bucket, prefix) {
  return exportCapnp(api, ObjectUploadTarget, makeUploadTarget(store, bucket, prefix));
}

function renderPowerboxPicker() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Choose upload destination</title>
  </head>
  <body>
    <main>
      <h1>Choose upload destination</h1>
      <form method="post" action="/powerbox/fulfill-upload">
        <label>
          Bucket
          <input name="bucket" value="inbox">
        </label>
        <label>
          Prefix
          <input name="prefix" value="">
        </label>
        <button type="submit">Allow uploads here</button>
      </form>
    </main>
  </body>
</html>`;
}

async function fulfillUploadRequest(request, env, bucket, prefix) {
  const api = sandstorm(request, env);
  const uploader = await exportUploader(api, api.storage(), bucket, prefix);
  const descriptor = await api.powerbox().appInterfaceDescriptor(ObjectUploadTarget);

  await api.powerbox().fulfillRequest(uploader, {
    descriptor,
    title: { defaultText: `Upload to ${bucket}/${prefix || ""}` },
  });

  return new Response("<!doctype html><p>Upload destination connected.</p>", {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function restoreObjectStoreObject(objectId, { env }) {
  const decoded = readObjectStoreObjectId(objectId);
  if (decoded.type === "uploadTarget") {
    return makeUploadTargetClient(storage(env), decoded.bucket, decoded.prefix);
  }
  throw new Error("unknown object store capability");
}

async function dropObjectStoreObject(objectId) {
  const decoded = readObjectStoreObjectId(objectId);
  if (decoded.type !== "uploadTarget") {
    throw new Error("unknown object store capability");
  }
}

async function renderBrowser(store) {
  const listing = await makeObjectStore(store).listObjects({
    bucket: "inbox",
    prefix: "",
    cursor: "",
  });
  const rows = Array.from(listing.objects || []).map((object) =>
    `<li><code>${htmlEscape(object.key)}</code> ${Number(object.size)} bytes ` +
    `${htmlEscape(object.contentType)}</li>`).join("");

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Object Store</title>
  </head>
  <body>
    <main>
      <h1>Object Store</h1>
      <p>This grain accepts upload-only Powerbox grants for the <code>inbox</code> bucket.</p>
      <h2>Inbox</h2>
      <ul>${rows || "<li>No objects yet.</li>"}</ul>
    </main>
  </body>
</html>`;
}

async function objectStoreFetch(request, env) {
  const api = sandstorm(request, env);
  const url = new URL(request.url);

  if (api.session().sessionType === "request" && url.pathname === "/") {
    return new Response(renderPowerboxPicker(), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  if (api.session().sessionType === "request" &&
      url.pathname === "/powerbox/fulfill-upload" &&
      request.method === "POST") {
    const form = await request.formData();
    return await fulfillUploadRequest(
      request,
      env,
      validateObjectScope(form.get("bucket") || "inbox", "bucket"),
      validateObjectScope(form.get("prefix") || "", "prefix"));
  }

  if (url.pathname === "/" && request.method === "GET") {
    return new Response(await renderBrowser(api.storage()), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  return new Response("not found", { status: 404 });
}

export default defineWorker({
  capabilities: {
    ui: mainViewFromFetch({
      fetch: objectStoreFetch,
      viewInfo: VIEW_INFO,
      restore: restoreObjectStoreObject,
      drop: dropObjectStoreObject,
    }),
  },
});
