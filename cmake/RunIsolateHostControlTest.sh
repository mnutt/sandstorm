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
mkdir -p "$grain_root/missingsource/isolate-runtime"
mkdir -p "$grain_root/invalidjson/isolate-runtime"
mkdir -p "$grain_root/unsupportedversion/isolate-runtime"
mkdir -p "$grain_root/oversizedbundle/isolate-runtime"
printf '{}\n' > "$grain_root/testgrain123/isolate-runtime/runtime-manifest.json"
printf '{}\n' > "$grain_root/missingsource/isolate-runtime/runtime-manifest.json"
printf '{}\n' > "$grain_root/invalidjson/isolate-runtime/runtime-manifest.json"
printf '{}\n' > "$grain_root/unsupportedversion/isolate-runtime/runtime-manifest.json"
printf '{}\n' > "$grain_root/oversizedbundle/isolate-runtime/runtime-manifest.json"
for i in $(seq -w 0 15); do
  mkdir -p "$grain_root/admission$i/isolate-runtime"
  printf '{}\n' > "$grain_root/admission$i/isolate-runtime/runtime-manifest.json"
  mkfifo "$grain_root/admission$i/isolate-runtime/worker-source.capnp.bin"
done
mkdir -p "$grain_root/admission-overload"
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
"$client" "$socket" "$grain_root"
