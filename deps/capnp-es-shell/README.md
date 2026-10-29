# Shell capnp-es dependency

`capnp-es-0.0.14.tgz` is the built shell runtime and schema compiler from
https://github.com/mnutt/capnp-es, revision
`6b427072da39beef24c8d391ba69d012706610af` on `perf/capnp-es-rpc`.
It includes the queued-message ownership fix and compiler traversal-budget fix.

SHA-256: `f598961bca72e1ba743a43b59ffa3c3b011ac8892128d53bc36dd55ea1f97b0b`

The shell installs this archive through its lockfile, including its SHA-512
integrity. CMake uses the compiler from that installation. A clean checkout
needs no personal capnp-es checkout or git-package build hooks.
The isolate runtime's separate pinned `@mnutt/capnp-es` dependency is configured
in `deps/capnp-es-npm`.

To refresh, check out the desired library revision, install its locked build
dependencies, run `pnpm build`, and run `npm pack --ignore-scripts`. Copy the
archive here, refresh the shell lockfile by explicitly installing the tarball,
and update this source revision and checksum. Run the library tests and the
complete Sandstorm schema generator before committing the archive.
