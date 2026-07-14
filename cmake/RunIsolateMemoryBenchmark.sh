#!/usr/bin/env bash

set -euo pipefail

node=$1
script=$2
host=$3
client=$4

benchmark_args=()
if [[ -n "${ISOLATE_MEMORY_BENCHMARK_ARGS:-}" ]]; then
  read -r -a benchmark_args <<< "$ISOLATE_MEMORY_BENCHMARK_ARGS"
fi

ISOLATE_HOST_BIN=$host \
ISOLATE_MEMORY_CLIENT=$client \
  exec "$node" "$script" "${benchmark_args[@]}"
