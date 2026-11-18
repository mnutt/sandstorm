#!/bin/bash
# Run the bundled setup client before sandstorm.conf or server startup is needed.
set -euo pipefail
bundle=$(cd -- "$(dirname -- "$0")" && pwd)
exec "$bundle/lib64/ld-linux-x86-64.so.2" \
  --library-path "$bundle/usr/lib:$bundle/usr/lib/x86_64-linux-gnu:$bundle/lib:$bundle/lib/x86_64-linux-gnu" \
  "$bundle/bin/node" "$bundle/sandcats-client/setup.js" "$@"
