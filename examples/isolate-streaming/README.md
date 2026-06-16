# Isolate Streaming Example

Run:

```sh
spk dev-isolate --title "Isolate Streaming" examples/isolate-streaming/worker.js
```

This example exercises both isolate streaming paths:

- `GET /download` returns a generated `ReadableStream` response.
- `POST /upload` consumes a request body stream and returns byte/chunk stats.
- `POST /roundtrip` consumes a request body stream, then streams the exact bytes back.

The UI includes size presets below, at, and above 64 KiB so you can exercise
both buffered and streamed response paths. Upload presets above 64 KiB should
also exercise `WebSession.postStreaming()`. The roundtrip action verifies that
the response body matches the request body byte-for-byte.
