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
account_socket=$root/account.sock
account_pid=

cleanup() {
  if [[ -n "$account_pid" ]]; then
    kill "$account_pid" 2>/dev/null || true
    wait "$account_pid" 2>/dev/null || true
  fi
  rm -rf "$root"
}
trap cleanup EXIT

rm -rf "$root"
mkdir -p "$app_root" "$grain_root"
"$spk" unpack "$test_spk" "$app_root/testpackage123"
cp -a "$app_root/testpackage123" "$app_root/oversizedpackage"
chmod u+w "$app_root/oversizedpackage/isolate-test/worker.js"
truncate -s 8388609 "$app_root/oversizedpackage/isolate-test/worker.js"
ln -s "$sandstorm" "$root/isolate-account-host"

"$root/isolate-account-host" \
  --trust-domain testaccount123 \
  --control-socket "$account_socket" \
  --native-host "$native_host" \
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
