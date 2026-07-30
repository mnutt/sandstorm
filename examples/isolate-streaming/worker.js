import { renderPage } from "./ui.js";
import metadata from "./metadata.json";

const encoder = new TextEncoder();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function numberParam(url, name, fallback, min, max) {
  const parsed = Number(url.searchParams.get(name) || fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function makeTextChunk(index, chunkBytes) {
  const prefix = `chunk ${String(index).padStart(4, "0")} `;
  const repeated = prefix.repeat(Math.ceil(chunkBytes / prefix.length));
  return encoder.encode(repeated.slice(0, chunkBytes));
}

function streamDownload(url) {
  const totalBytes = numberParam(url, "totalBytes", 192 * 1024, 1, 16 * 1024 * 1024);
  const chunkBytes = numberParam(url, "chunkBytes", 8192, 1, 65536);
  const delayMs = numberParam(url, "delayMs", 10, 0, 1000);
  let offset = 0;

  return new Response(new ReadableStream({
    async pull(controller) {
      if (offset >= totalBytes) {
        controller.close();
        return;
      }

      if (delayMs > 0) await sleep(delayMs);
      const size = Math.min(chunkBytes, totalBytes - offset);
      controller.enqueue(makeTextChunk(offset / chunkBytes, size));
      offset += size;
    },
  }), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-length": String(totalBytes),
      "x-sandstorm-app-streaming-example": "download",
    },
  });
}

async function readRequestStats(request) {
  const result = await readRequestBody(request, false);
  return {
    chunks: result.chunks,
    bytes: result.bytes,
    checksum: result.checksum,
  };
}

async function readRequestBody(request, keepChunks) {
  if (request.body === null) {
    return { chunks: 0, bytes: 0, checksum: 0, bodyChunks: [] };
  }

  const reader = request.body.getReader();
  let chunks = 0;
  let bytes = 0;
  let checksum = 0;
  const bodyChunks = keepChunks ? [] : null;

  while (true) {
    const result = await reader.read();
    if (result.done) break;

    if (keepChunks) bodyChunks.push(result.value);
    ++chunks;
    bytes += result.value.byteLength;
    for (const byte of result.value) {
      checksum = (checksum + byte) >>> 0;
    }
  }

  return { chunks, bytes, checksum, bodyChunks: bodyChunks || [] };
}

async function streamUploadStats(request) {
  const stats = await readRequestStats(request);
  return Response.json({
    ok: true,
    streamedRequest: true,
    ...stats,
  }, {
    headers: {
      "x-sandstorm-app-streaming-example": "upload",
    },
  });
}

async function roundTrip(request) {
  const body = await readRequestBody(request, true);
  let index = 0;

  return new Response(new ReadableStream({
    async pull(controller) {
      if (index >= body.bodyChunks.length) {
        controller.close();
        return;
      }

      await sleep(25);
      controller.enqueue(body.bodyChunks[index++]);
    },
  }), {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(body.bytes),
      "x-sandstorm-app-upload-chunks": String(body.chunks),
      "x-sandstorm-app-upload-checksum": String(body.checksum),
      "x-sandstorm-app-streaming-example": "roundtrip",
    },
  });
}

export default async function streamingFetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(renderPage(metadata), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (request.method === "GET" && url.pathname === "/download") {
      return streamDownload(url);
    }

    if (request.method === "POST" && url.pathname === "/upload") {
      return streamUploadStats(request);
    }

    if (request.method === "POST" && url.pathname === "/roundtrip") {
      return roundTrip(request);
    }

    return new Response("Not found\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
}
