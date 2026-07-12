#!/usr/bin/env bash

set -euo pipefail

host=$1
client=$2
socket=$3
grain_root=${socket}.grains

rm -f "$socket"
rm -rf "$grain_root"
mkdir -p "$grain_root/testgrain123/isolate-runtime"
mkdir -p "$grain_root/missingmanifest/isolate-runtime"
printf '{}\n' > "$grain_root/testgrain123/isolate-runtime/runtime-manifest.json"
ln -s testgrain123 "$grain_root/linkgrain123"

"$host" "$socket" "$grain_root" &
host_pid=$!

cleanup() {
  kill "$host_pid" 2>/dev/null || true
  wait "$host_pid" 2>/dev/null || true
  rm -f "$socket"
  rm -rf "$grain_root"
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
