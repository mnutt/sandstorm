# Isolate hello example

Run:

```sh
spk dev-isolate --title "Isolate Hello" examples/isolate-hello/worker.js
```

This is the smallest useful isolate app shape: a Worker-style module exporting
`fetch(request, env)`.
