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
state_root=

cleanup() {
  if [[ -n "$state_root" ]]; then
    rm -rf "$state_root"
  fi
  rm -rf "$root"
}
trap cleanup EXIT

# Account sockets must fit in sockaddr_un even with a long CI checkout path.
# Use /tmp explicitly since TMPDIR can itself be under the build directory.
state_root=$(mktemp -d /tmp/ss-recovery.XXXXXXXX)
rm -rf "$root"
mkdir -p "$app_root" "$grain_root" "$state_root"
"$spk" unpack "$test_spk" "$app_root/testpackage123"
"$client" "$sandstorm" "$native_host" "$app_root" "$grain_root" "$state_root"
