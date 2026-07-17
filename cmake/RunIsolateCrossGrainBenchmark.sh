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
account_log=$root/account.log
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
"$spk" unpack "$test_spk" "$app_root/testpackage123" >/dev/null
ln -s "$sandstorm" "$root/isolate-account-host"

"$root/isolate-account-host" \
  --trust-domain benchmarkaccount \
  --control-socket "$account_socket" \
  --native-host "$native_host" \
  --app-root "$app_root" \
  --grain-root "$grain_root" \
  >"$account_log" 2>&1 &
account_pid=$!

for _attempt in $(seq 1 100); do
  [[ -S "$account_socket" ]] && break
  sleep 0.05
done
[[ -S "$account_socket" ]]

benchmark_args=()
if [[ -n "${ISOLATE_CROSS_GRAIN_BENCHMARK_ARGS:-}" ]]; then
  read -r -a benchmark_args <<< "$ISOLATE_CROSS_GRAIN_BENCHMARK_ARGS"
fi

if "$client" "$account_socket" isolatebenchmarkprovider testpackage123 \
    --benchmark "${benchmark_args[@]}"; then
  :
else
  status=$?
  cat "$account_log"
  exit "$status"
fi
