#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
native_build=${SANDSTORM_NATIVE_BUILD_DIR:-"$repo_root/build/dev"}
test_build=${SANDSTORM_EMAIL_RPC_TEST_DIR:-"$repo_root/tmp/email-rpc-regression"}
capnp_source="$repo_root/deps/capnproto/c++/src"
mkdir -p "$test_build"

# Reuse a matching Sandstorm native build's schemas and libraries, but always
# compile rpc.c++ from source so a local submodule fix is actually exercised.
for artifact in bin/capnp bin/capnpc-c++ lib/libsandstorm_schemas.a lib/libcapnp-rpc.a \
    lib/libcapnp.a lib/libkj-test.a lib/libkj-async.a lib/libkj.a; do
  if [[ ! -f "$native_build/$artifact" ]]; then
    echo "Missing $native_build/$artifact; build the native libraries first." >&2
    exit 1
  fi
done

"$native_build/bin/capnp" compile -I "$repo_root/src" -I "$capnp_source" \
  --src-prefix="$repo_root/src" \
  -o "$native_build/bin/capnpc-c++:$test_build" \
  "$repo_root/src/sandstorm/email-rpc-test.capnp"

"${CXX:-c++}" -std=c++17 -g -I "$capnp_source" \
  -c "$capnp_source/capnp/rpc.c++" -o "$test_build/rpc.o"

"${CXX:-c++}" -std=c++17 -g \
  -I "$test_build/sandstorm" -I "$test_build" \
  -I "$native_build/generated/sandstorm" -I "$native_build/generated" \
  -I "$capnp_source" \
  "$repo_root/src/sandstorm/email-rpc-test.c++" \
  "$test_build/sandstorm/email-rpc-test.capnp.c++" "$test_build/rpc.o" \
  -L "$native_build/lib" -lsandstorm_schemas -lcapnp-rpc -lcapnp \
  -lkj-test -lkj-async -lkj -pthread -o "$test_build/email-rpc-test"

exec "$test_build/email-rpc-test" "$@"
