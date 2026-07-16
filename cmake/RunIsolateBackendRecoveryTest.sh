#!/usr/bin/env bash

set -euo pipefail

spk=$1
test_spk=$2
client=$3
sandstorm=$4
native_host=$5
root=$6

app_root=$root/apps
grain_root=$root/grains
state_root=$root/state

cleanup() {
  rm -rf "$root"
}
trap cleanup EXIT

rm -rf "$root"
mkdir -p "$app_root" "$grain_root" "$state_root"
"$spk" unpack "$test_spk" "$app_root/testpackage123"
"$client" "$sandstorm" "$native_host" "$app_root" "$grain_root" "$state_root"
