#!/usr/bin/env bash
set -euo pipefail

sandstorm=$1
build_dir=$2
fixture=$3

test_dir=$(mktemp -d "${build_dir}/isolate-backup-roundtrip.XXXXXX")
trap 'rm -rf -- "$test_dir"' EXIT

run_backup() {
  local archive=$1
  local grain=$2
  (exec -a backup "$sandstorm" --root / "$archive" "$grain" < /dev/null)
}

run_restore() {
  local archive=$1
  local grain=$2
  mkdir -p "$grain"
  (exec -a backup "$sandstorm" --root / -r "$archive" "$grain" > /dev/null)
  # The production backend removes this empty mountpoint after the sandbox exits.
  rmdir "$grain/data"
}

source_grain="$test_dir/source-grain"
restored_grain="$test_dir/restored-grain"
archive="$test_dir/grain.zip"
mkdir -p "$source_grain/sandbox" "$source_grain/isolate-files/nested"
cp "$fixture" "$source_grain/sandbox/state"
cp "$fixture" "$source_grain/isolate-kv.sqlite"
cp "$fixture" "$source_grain/isolate-files/nested/file.bin"

run_backup "$archive" "$source_grain"
run_restore "$archive" "$restored_grain"
cmp "$source_grain/sandbox/state" "$restored_grain/sandbox/state"
cmp "$source_grain/isolate-kv.sqlite" "$restored_grain/isolate-kv.sqlite"
cmp "$source_grain/isolate-files/nested/file.bin" \
  "$restored_grain/isolate-files/nested/file.bin"

old_source_grain="$test_dir/old-source-grain"
old_restored_grain="$test_dir/old-restored-grain"
old_archive="$test_dir/old-grain.zip"
mkdir -p "$old_source_grain/sandbox"
cp "$fixture" "$old_source_grain/sandbox/state"

run_backup "$old_archive" "$old_source_grain"
run_restore "$old_archive" "$old_restored_grain"
cmp "$old_source_grain/sandbox/state" "$old_restored_grain/sandbox/state"
test ! -e "$old_restored_grain/isolate-kv.sqlite"
test ! -e "$old_restored_grain/isolate-files"

echo "isolate backup round-trip passed"
