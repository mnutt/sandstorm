function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderPage(metadata) {
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
        max-width: 52rem;
      }

      button {
        font: inherit;
        margin: 0 0.5rem 0.5rem 0;
        padding: 0.45rem 0.7rem;
      }

      label {
        display: inline-grid;
        gap: 0.25rem;
        margin: 0 1rem 1rem 0;
      }

      select {
        font: inherit;
        min-width: 12rem;
        padding: 0.35rem;
      }

      pre {
        background: #f4f4f5;
        border: 1px solid #d4d4d8;
        overflow: auto;
        padding: 1rem;
        white-space: pre-wrap;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(metadata.title)}</h1>
      <p>This isolate worker streams generated downloads and accepts streamed uploads.</p>
      <p>
        <label>
          Total size
          <select id="total-bytes">
            <option value="16384">16 KiB</option>
            <option value="65536">64 KiB</option>
            <option value="65537">64 KiB + 1 byte</option>
            <option value="262144">256 KiB</option>
            <option value="1048576" selected>1 MiB</option>
            <option value="10485760">10 MiB</option>
          </select>
        </label>
        <label>
          Chunk size
          <select id="chunk-bytes">
            <option value="1024">1 KiB</option>
            <option value="8192" selected>8 KiB</option>
            <option value="32768">32 KiB</option>
            <option value="65536">64 KiB</option>
          </select>
        </label>
      </p>
      <p>
        <button id="download">Download</button>
        <button id="upload">Upload</button>
        <button id="roundtrip">Upload, then response</button>
      </p>
      <pre id="log">Ready.</pre>
    </main>
    <script type="module">
      const log = document.querySelector("#log");
      const totalBytesSelect = document.querySelector("#total-bytes");
      const chunkBytesSelect = document.querySelector("#chunk-bytes");

      function write(message) {
        log.textContent += "\\n" + message;
      }

      function selectedBytes(select) {
        return Number(select.value);
      }

      function selectedSettings() {
        return {
          totalBytes: selectedBytes(totalBytesSelect),
          chunkBytes: selectedBytes(chunkBytesSelect),
        };
      }

      function makeUploadBytes(totalBytes) {
        const bytes = new Uint8Array(totalBytes);
        for (let i = 0; i < bytes.byteLength; ++i) {
          bytes[i] = expectedByte(i);
        }
        return bytes;
      }

      function expectedByte(offset) {
        return offset & 255;
      }

      async function readStream(response) {
        const reader = response.body.getReader();
        let chunks = 0;
        let bytes = 0;
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          ++chunks;
          bytes += result.value.byteLength;
          write("received chunk " + chunks + " (" + result.value.byteLength + " bytes)");
        }
        return { chunks, bytes };
      }

      async function verifyEchoStream(response, expectedBytes) {
        const reader = response.body.getReader();
        let chunks = 0;
        let bytes = 0;
        let mismatch = null;

        while (true) {
          const result = await reader.read();
          if (result.done) break;

          ++chunks;
          for (let i = 0; i < result.value.byteLength; ++i) {
            const expected = expectedByte(bytes + i);
            if (mismatch === null && result.value[i] !== expected) {
              mismatch = {
                offset: bytes + i,
                expected,
                actual: result.value[i],
              };
            }
          }
          bytes += result.value.byteLength;
          write("received echo chunk " + chunks + " (" + result.value.byteLength + " bytes)");
        }

        return {
          chunks,
          bytes,
          expectedBytes,
          byteForByteMatch: mismatch === null && bytes === expectedBytes,
          mismatch,
        };
      }

      async function postStream(path) {
        const settings = selectedSettings();
        return fetch(path, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: makeUploadBytes(settings.totalBytes),
        });
      }

      document.querySelector("#download").addEventListener("click", async () => {
        const settings = selectedSettings();
        log.textContent = "Starting download: " + JSON.stringify(settings);
        const response = await fetch("/download?totalBytes=" + settings.totalBytes +
          "&chunkBytes=" + settings.chunkBytes + "&delayMs=15");
        write("status " + response.status);
        const stats = await readStream(response);
        write("done " + JSON.stringify(stats));
      });

      document.querySelector("#upload").addEventListener("click", async () => {
        log.textContent = "Starting upload: " + JSON.stringify(selectedSettings());
        const response = await postStream("/upload");
        write("status " + response.status);
        write(await response.text());
      });

      document.querySelector("#roundtrip").addEventListener("click", async () => {
        const settings = selectedSettings();
        log.textContent = "Starting upload + response: " + JSON.stringify(settings);
        const response = await postStream("/roundtrip");
        write("status " + response.status);
        const stats = await verifyEchoStream(response, settings.totalBytes);
        write("done " + JSON.stringify(stats));
      });
    </script>
  </body>
</html>`;
}
