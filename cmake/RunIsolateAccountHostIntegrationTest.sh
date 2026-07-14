#!/usr/bin/env bash

set -euo pipefail

native_host=$1
sandstorm=$2
spk=$3
client=$4
test_spk=$5
root=$6

app_root=$root/apps
grain_root=$root/grains
native_socket=$root/native.sock
account_socket=$root/account.sock
native_pid=
account_pid=

cleanup() {
  if [[ -n "$account_pid" ]]; then
    kill "$account_pid" 2>/dev/null || true
    wait "$account_pid" 2>/dev/null || true
  fi
  if [[ -n "$native_pid" ]]; then
    kill "$native_pid" 2>/dev/null || true
    wait "$native_pid" 2>/dev/null || true
  fi
  rm -rf "$root"
}
trap cleanup EXIT

rm -rf "$root"
mkdir -p "$app_root" "$grain_root"
"$spk" unpack "$test_spk" "$app_root/testpackage123"
ln -s "$sandstorm" "$root/isolate-account-host"

"$native_host" "$native_socket" &
native_pid=$!
for _attempt in $(seq 1 100); do
  [[ -S "$native_socket" ]] && break
  sleep 0.05
done
[[ -S "$native_socket" ]]

"$root/isolate-account-host" \
  --trust-domain testaccount123 \
  --control-socket "$account_socket" \
  --native-control-socket "$native_socket" \
  --app-root "$app_root" \
  --grain-root "$grain_root" &
account_pid=$!
for _attempt in $(seq 1 100); do
  [[ -S "$account_socket" ]] && break
  sleep 0.05
done
[[ -S "$account_socket" ]]

"$client" "$account_socket" testgrain123 testpackage123
grep -q '"topology": "accountSharedHost"' \
  "$grain_root/testgrain123/isolate-runtime/runtime-manifest.json"
grep -q '"topology": "accountSharedHost"' \
  "$grain_root/testgrain456/isolate-runtime/runtime-manifest.json"
