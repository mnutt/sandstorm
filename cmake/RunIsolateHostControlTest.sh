#!/usr/bin/env bash

set -euo pipefail

host=$1
client=$2
socket=$3
log=${socket}.log

rm -f "$socket" "$log"
"$host" "$socket" >"$log" 2>&1 &
host_pid=$!

cleanup() {
  kill "$host_pid" 2>/dev/null || true
  wait "$host_pid" 2>/dev/null || true
  rm -f "$socket" "$log"
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
grep -q '"message":"sandstorm-grain-log-marker","worker":"sandstorm-grains:testgrain123"' "$log"
grep -q '"message":"sandstorm-grain-log-marker","worker":"sandstorm-grains:cpugrain123"' "$log"

kill "$host_pid"
wait "$host_pid" 2>/dev/null || true
rm -f "$socket"

SANDSTORM_ISOLATE_HOST_IDLE_TIMEOUT_MS=200 "$host" "$socket" >>"$log" 2>&1 &
host_pid=$!
for _attempt in $(seq 1 100); do
  if [[ -S "$socket" ]]; then
    break
  fi
  sleep 0.05
done

[[ -S "$socket" ]]
"$client" "$socket" --idle-eviction
