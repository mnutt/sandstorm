#!/usr/bin/env bash

set -euo pipefail

host=$1
client=$2
socket=$3

rm -f "$socket"
"$host" "$socket" &
host_pid=$!

cleanup() {
  kill "$host_pid" 2>/dev/null || true
  wait "$host_pid" 2>/dev/null || true
  rm -f "$socket"
}
trap cleanup EXIT

for _attempt in $(seq 1 100); do
  if [[ -S "$socket" ]]; then
    break
  fi
  sleep 0.05
done

[[ -S "$socket" ]]
"$client" "$socket"
