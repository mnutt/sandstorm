#!/usr/bin/env bash

set -euo pipefail

native_host=$1
sandstorm=$2
spk=$3
client=$4
test_spk=$5
node=$6
benchmark_script=$7
root=$8

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
ln -s "$sandstorm" "$root/isolate-account-host"

run_case() {
  local expected=$1
  shift
  rm -rf "$grain_root"
  mkdir -p "$grain_root"
  rm -f "$account_socket"
  "$root/isolate-account-host" \
    --trust-domain benchmarkaccount \
    --control-socket "$account_socket" \
    --native-host "$native_host" \
    --app-root "$app_root" \
    --grain-root "$grain_root" \
    "$@" 2>"$root/$expected.log" &
  account_pid=$!
  for _attempt in $(seq 1 100); do
    [[ -S "$account_socket" ]] && break
    sleep 0.05
  done
  [[ -S "$account_socket" ]]
  if ! "$client" "$account_socket" benchmarkgrain testpackage123 \
      "benchmark-$expected"; then
    cat "$root/$expected.log" >&2
    return 1
  fi
  kill "$account_pid"
  wait "$account_pid" 2>/dev/null || true
  account_pid=
}

local_result=$(run_case local)
fallback_result=$(run_case fallback --disable-local-fast-path)
benchmark_args=()
if [[ -n "${ISOLATE_LOCAL_CAPNP_BENCHMARK_ARGS:-}" ]]; then
  read -r -a benchmark_args <<< "$ISOLATE_LOCAL_CAPNP_BENCHMARK_ARGS"
fi
exec "$node" "$benchmark_script" \
  "$local_result" "$fallback_result" "${benchmark_args[@]}"
