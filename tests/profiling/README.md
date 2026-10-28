# Server end-to-end profiling

This runs a fresh, retained Sandstorm installation and drives Davros using Chrome. It collects
**server** JavaScript CPU profiles, not browser JavaScript profiles. Browser automation provides
user-visible completion times. The JavaScript profiler covers the Sandstorm Meteor process;
it does not instrument Davros's own Node process or MongoDB.

## Prepare

Build an optimized bundle with symbols from this branch (the normal `dev` preset is unoptimized):

```sh
make CMAKE_PRESET=release fast
cd tests
npm ci
# Install the Chrome version matching the installed ChromeDriver:
node_modules/.bin/chromedriver --version
node_modules/.bin/browsers install chrome@VERSION --path .browsers
cd ..
```

Use a pinned local Davros SPK. The scenario targets the current Davros UI with `nav.sidebar`,
`.upload-placeholder`, and `data-file-path` selectors. It fails on an incompatible UI instead of
silently substituting API-only operations. Python 3.11+, Node, unzip, and an environment that can
run Sandstorm's namespaces and Chrome are required. Install dependencies before measuring.

```sh
python3 tests/profiling/run.py \
  --bundle build/release/packages/sandstorm-0-fast.tar.xz \
  --davros /absolute/path/to/davros.spk \
  --chrome /absolute/path/to/chrome-linux64/chrome \
  --output /tmp/e2e-profile-001 \
  --mode js
```

The output directory must not already exist. Use short paths because Unix socket paths have a
length limit. Run as an ordinary user. Ports 9200–9202 must be free; override with `--port`.
The runner always stops its instance and retains it, including on scenario failure. It does not
use or delete `tests/tmp-sandstorm`, and does not install dependencies during the measured run.

Modes:

- `baseline`: phase timings and verified transfers, with no CPU profilers.
- `js` (default): additionally profiles the Meteor server, including startup.
- `native`: additionally records native CPU samples using Linux `perf`.
- `both`: both profilers; use for diagnosis, not baseline performance comparisons.

Native modes require `perf` and permission for per-process user-space CPU sampling (normally
available with `kernel.perf_event_paranoid=2`). The runner does not change kernel settings or
invoke sudo. Recording uses CLOCK_MONOTONIC (matching phase timestamps), 99 Hz DWARF stacks and follows the Sandstorm launcher's descendants,
including its daemon and short-lived supervisors and backup workers. A small helper keeps perf's
workload alive until the runner stops Sandstorm; closing its stdin then flushes the recording.
Chrome and the browser-test driver are outside this process tree. This captures **user-space**
CPU stacks, not kernel stacks or off-CPU waiting.

Use the saved process snapshots and perf process identifiers to separate Sandstorm gateway,
backend, supervisors, backup processes, MongoDB, and Davros. Preserve the retained installation
and build symbols for symbol resolution; namespace paths can require pointing perf at the
matching host binaries. Check lost-sample warnings in `perf.log` before interpreting results.

## Workload and artifacts

The runner generates 50,000,000 random bytes before launch, then measures startup, login, local
SPK upload/install, first grain creation, five page visits (Files, Clients, Publish, About, Files),
file upload, file download, backup export, and five additional grain creations. Grain readiness
means the Davros directory listing (including bundled sample files) or empty-directory UI has rendered. Upload completion waits for the file listing
and disappearance of the progress bar. Downloads wait for the final filename and no Chrome
partial-download files; the downloaded payload is SHA-256 checked. Backup validation checks
ZIP integrity and the payload hash inside the archive, outside the timed export phase.

- `manifest.json`: run status, mode, host, source revision, bundle/SPK/payload hashes.
- `startup.json`: launch-to-shell-readiness time (login is a separate phase).
- `phases.jsonl`: wall times, throughput, phase status, and server profile metadata.
- `sandstorm/var/profile/*.cpuprofile`: V8 CPU profiles, loadable in Chrome DevTools' JavaScript
  Profiler. This is offline viewing of **server** profiles; no browser profile is recorded.
- `sandstorm/var/profile/*.json`: per-phase CPU time, event-loop utilization/delay, endpoint
  memory usage, and Node resource usage. `resourceUsage` counters/maxRSS are process-lifetime
  values, not phase deltas; `cpuUserMs` and `cpuSystemMs` are phase deltas.
- `perf.data`, `perf.log`: native capture when requested; inspect with
  `perf report -i /tmp/e2e-profile-001/perf.data`.
- `verification.json`, `downloads/`, `payload.bin`: transfer and backup verification evidence.
- `processes.txt`, `scenario.log`, `chromedriver.log`, `reports/`, and `sandstorm/var/log/`:
  process snapshots and diagnostic logs. `source.diff` records tracked working-tree edits.

Use at least five fresh baseline runs for comparisons and report median and range per phase.
These are fresh application states, not guaranteed cold OS caches. Record machine load/storage
conditions and keep the same bundle, app, Chrome, and fixture size. Profile matched runs to
explain CPU costs. CPU sampling does not explain time blocked on disk, RPC, or MongoDB; phase
wall time and event-loop measurements help identify where additional tracing is needed.

## Control protocol and validation

`PROFILE_SERVER=true` in sandstorm.conf requires `IS_TESTING=true`. The native launcher exports
a private flag to the bundled bootstrap; inherited `NODE_OPTIONS` is not used. Before Meteor
loads, the bootstrap starts a V8 inspector session and a startup profile. Commands use HTTP over
`var/profile/control.sock` (mode 0600), with no TCP debugger port or remotely callable Meteor method:

- `POST /stop`: flush the active profile and return measurements.
- `POST /start?name=upload`: begin a named phase; rejects overlap and unsafe names.

Profile files are flushed explicitly before stopping the instance. An abrupt process crash may
lose the active phase; completed phases remain on disk and the run is marked failed.

```sh
node --test tests/profiling/server-profiler.test.js
python3 tests/profiling/run.py --help
```

## Request latency through the full stack

The `latency` scenario measures a tiny C++ HTTP server behind `sandstorm-http-bridge`, using the
same authenticated UI-session cookie as the browser. Requests traverse the gateway, grain RPC
path, supervisor, HTTP bridge, and app. Davros is not involved. Browser automation only logs in,
installs the package, creates the grain, and requests shutdown for cold measurements. A local
Node HTTP client drives measured requests; no browser JavaScript profiles are collected.

Build the optimized server bundle and matching benchmark app/control binary:

```sh
make CMAKE_PRESET=release fast
cmake --build --preset release --target latency-test-app-spk
python3 tests/profiling/run.py --scenario latency --mode baseline \
  --bundle build/release/packages/sandstorm-0-fast.tar.xz \
  --latency-app build/release/packages/latency-test-app.spk \
  --latency-binary build/release/bin/latency-test-app \
  --chrome /absolute/path/to/chrome-linux64/chrome \
  --output /tmp/latency-baseline-001
```

Default workload: 100 warm-up requests before every measured batch, 1,000 measured requests per
batch, five repetitions at concurrency 1, 5, and 20, plus five cold requests. Each repetition runs
both the grain and the same binary directly on loopback, alternating order. The direct server
uses the fourth port (`--port + 3`). Override with `--requests`, `--warmup`, `--repetitions`,
`--concurrency 1,5,20`, and `--cold-repetitions`. For a diagnostic run, use a new output directory
and `--mode both`. Timing conclusions should use baseline runs, with profiles used for attribution.

Every request has a unique ID that the app echoes. The app emits `Cache-Control: no-store`,
but the HTTP bridge does not preserve that header. The client performs no caching, and unique
echoed IDs validate that requests reach the app. Responses are fully consumed and validated. Warm-up establishes persistent connections;
connection reuse is recorded for the measured batches. There are no automatic retries. A request
has a five-second total deadline, and any request failure fails the scenario while preserving data.
This is a **closed-loop** benchmark: at most the requested concurrency is in flight, so it measures
latency at that concurrency, not tail latency under a fixed external arrival rate.

The response contains CLOCK_MONOTONIC timestamps at handler entry and just before constructing
and sending the response. On this localhost benchmark, these share a clock with the client:

- `totalMs`: client request invocation through complete response body.
- `ttfbMs`: invocation through response headers (not a packet-level timestamp).
- `toAppMs`: invocation through app-handler entry, including HTTP parsing, gateway/RPC/bridge
  transit, scheduling, and any connection establishment.
- `handlerMs`: the tiny handler's work before response construction.
- `fromAppMs`: response construction through the client's complete body receipt.

These boundaries do not separate individual gateway/backend/supervisor hops, and do not measure
kernel execution independently. Native profiles help locate CPU costs within the transit phases.
The direct control includes the same app's HTTP parsing and response construction. Differences
estimate platform overhead; they are not an exact subtraction of independent latency percentiles.
Remote-client use requires additional clock synchronization and is not supported by this runner.

Cold measurements explicitly shut down the grain, retain its authenticated session, and request
it again over the existing client connection. A per-process monotonic boot identifier must change,
so a silent warm restart cannot pass. These measure **cold grain process startup**, not cold disk
or OS caches. Five cold samples are a smoke measurement, not enough for a dependable p99.

`latency-summary.json` holds per-batch mean, median, p95, p99, maximum, throughput, error count,
connection reuse, and client CPU. Each `grain-c1-r1.json` (etc.) also retains every request record.
The public `latency-app/test-only.key` signs only this benchmark app and must not be reused for a
real application. The app performs no per-request database or filesystem work.

```sh
python3 tests/profiling/summarize-latency.py /tmp/latency-baseline-001
node --test tests/profiling/latency-client.test.js tests/profiling/server-profiler.test.js
```

## Experimental HTTP bridge connection reuse

Set `SANDSTORM_HTTP_BRIDGE_KEEPALIVE=1` in the app manifest command's `environ` (both the
new-grain action and `continueCommand`) to enable the experiment. It is disabled by default.
This changes the bridge packaged **inside the app**, not the Sandstorm host binary. Rebuild
and reinstall the test SPK when comparing versions of the bridge.

The bridge reuses connections for GET requests, including streamed responses once their complete
HTTP framing has been consumed. It keeps at most 20 idle connections per WebSession, checks
idle age on acquisition (less than five seconds), and observes disconnects while idle. Other
methods and upgrades retain their existing connection behavior. Connections are not shared
between WebSessions. Responses requesting closure, EOF-delimited responses, incomplete bodies,
and canceled reads are not returned to the pool. There is no HTTP pipelining or automatic retry.
A peer can still close a socket between acquisition and the next request: handling that race
and broader real-app compatibility testing remain prerequisites to enabling this by default.

The test app now returns a per-process connection ID. `appConnections` counts distinct internal
app connections used in each measured batch; this is separate from the client-facing
`reusedConnections`. Without reuse, 1,000 grain requests use 1,000 app connections. With reuse,
the expected count is around the requested concurrency (scheduling can alter that count).

To produce matching off/on packages after building `latency-test-app-spk`:

```sh
cp build/release/packages/latency-test-app.spk /tmp/latency-off.spk
python3 - <<'PY'
from pathlib import Path
p = Path('build/release/packages/latency-app/package.capnp')
s = p.read_text()
environment = 'environ = [(key = "SANDSTORM_HTTP_BRIDGE_KEEPALIVE", value = "1")], '
s = s.replace('command = (argv =', 'command = (' + environment + 'argv =')
s = s.replace('continueCommand = (argv =', 'continueCommand = (' + environment + 'argv =')
p.with_name('keepalive.capnp').write_text(s)
PY
build/release/bin/spk pack -k tests/profiling/latency-app/test-only.key -I src \
  -p build/release/packages/latency-app/keepalive.capnp:pkgdef /tmp/latency-on.spk
```

Run each package with `--scenario latency --mode baseline`, using different output directories.
Keep the bundle and direct-control binary identical. Run the scenarios sequentially to avoid
competition for CPU, and reverse off/on order in a subsequent comparison if investigating small
differences. `--mode both` is useful for attribution, but baseline runs determine timing.

```sh
cmake --build --preset release --target sandstorm-http-bridge-test
build/release/bin/sandstorm-http-bridge-test
```
