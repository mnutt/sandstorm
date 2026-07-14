# Shared isolate host memory benchmark

This benchmark measures the host-process memory benefit from putting multiple
warmed workers in one `isolate-host`. On the test machine, the shared host's
fitted incremental cost was **1.19 MiB PSS per worker**, compared with **8.15
MiB PSS per worker** for one host process per worker. At 32 workers, the shared
host used 72.4 MiB PSS and the equivalent one-worker processes used 279.9 MiB,
a 3.9x reduction in total host-process memory.

These results establish that sharing the V8/workerd host materially reduces
per-grain memory overhead. They are not a production capacity limit: real
application heaps, traffic, bindings, and host-wide admission limits add
workload-dependent memory use.

## Results

The table reports the median of five fresh-process repeats at each worker
count. The regression is ordinary least squares over those seven medians.

| Workers | Shared host PSS | One-worker host PSS |
| ---: | ---: | ---: |
| 0 | 33.0 MiB | 0 MiB |
| 1 | 36.6 MiB | 36.4 MiB |
| 2 | 37.9 MiB | 47.3 MiB |
| 4 | 40.1 MiB | 63.6 MiB |
| 8 | 44.8 MiB | 95.0 MiB |
| 16 | 54.3 MiB | 156.8 MiB |
| 32 | 72.4 MiB | 279.9 MiB |

| Topology | Slope | Intercept | R-squared |
| --- | ---: | ---: | ---: |
| Shared host | 1.19 MiB/worker | 34.9 MiB | 0.995466 |
| One-worker processes | 8.15 MiB/worker | 23.7 MiB | 0.985970 |

The fitted slopes are the useful density comparison. The isolated topology's
intercept is not the size of an actual zero-worker process: that topology has
zero processes at zero workers, and the regression also reflects file-backed
pages shared by the separate processes.

The complete measurements are in
[`isolates-memory-benchmark.csv`](isolates-memory-benchmark.csv).

## Method

The harness compares two topologies using the same `isolate-host` binary and
the same minimal ES module:

- **Shared host:** one host process containing N live workers.
- **One-worker processes:** N host processes containing one live worker each.

Every worker is started through the real control interface and warmed with a
successful HTTP fetch before measurement. The client processes that provision
and retain the workers are excluded from both totals. Each measurement uses
fresh host processes, waits 500 ms after warmup, reads
`/proc/<pid>/smaps_rollup` five times at 100 ms intervals, and records the
median PSS. Counts 0, 1, 2, 4, 8, 16, and 32 are each repeated five times.

PSS is used instead of RSS because it apportions shared physical pages among
the processes mapping them. Summing PSS across the one-worker host processes
therefore counts shared executable pages proportionally while retaining each
process's private cost.

The run was performed on 2026-07-14 UTC with:

- Sandstorm host source parent: `5bb4c04bbd27bda30f400393ddc4e7cdfe40ac6d`
- workerd source: `ea5e86d22f16996a3d8fdb8922c34eb7e8711cd3`
- packaged workerd release: `1.20260610.1`
- Linux `7.0.0-1006-aws`, x86-64, 4 KiB pages
- 8 vCPUs, Intel Xeon 6975P-C under KVM
- 15.3 GiB RAM

## Reproduction

Build the shared native host and run the default matrix:

```sh
make isolate-memory-benchmark
```

Progress and fitted summaries go to stderr; raw CSV goes to stdout, so a new
result can be captured directly:

```sh
make isolate-memory-benchmark > isolates-memory-benchmark.csv
```

For quicker checks, override the matrix and sampling parameters through the
Make variable, for example:

```sh
make isolate-memory-benchmark \
  ISOLATE_MEMORY_BENCHMARK_ARGS='--counts 0,1,4,8 --repeats 1 --samples 3'
```
