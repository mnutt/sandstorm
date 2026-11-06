# CI Warnings TODO

Source run: https://github.com/mnutt/sandstorm/actions/runs/31287336761/job/93178452319

## First-party warnings

- [ ] Investigate the `MaxListenersExceededWarning` emitted during browser tests.
- [ ] Replace the deprecated Node `util._extend` usage encountered during tests.
- [ ] Resolve Sandstorm C++ compiler warnings:
  - [ ] Replace five variable-length arrays with standard C++ storage.
  - [ ] Replace deprecated `readdir_r` usage.
  - [ ] Replace deprecated Cap'n Proto `parseDiskFile()` usage.
  - [ ] Clarify the lifetime role of `hashThread` and eliminate its unused-variable warning.

## Dependency work

- [ ] Audit npm findings across the shell, icon tooling, tests, and test applications, including
      the reported high-severity findings.
- [ ] Upgrade or replace deprecated npm dependencies, including `glob`, `phin`, `inflight`,
      `sourcemap-codec`, and `whatwg-encoding`.
- [ ] Evaluate the three git-based npm dependencies for which npm skips integrity checks.
- [ ] Address or deliberately suppress the eleven compiler deprecation warnings from vendored
      `node-capnp`.
- [ ] Address or deliberately suppress the seven libsodium/libtool warnings.

## Architectural warnings

- [ ] Evaluate the three static-linker `getaddrinfo()` warnings against Sandstorm's static glibc
      and deployment strategy. Do not suppress these without confirming runtime compatibility.
- [ ] Evaluate the three Rspack bundle-size warnings and determine whether server bundle splitting
      or adjusted thresholds are appropriate.
- [ ] Reduce the existing 537 ESLint warnings while keeping the CI warning baseline accurate.

## Suggested order

1. Browser-test `MaxListenersExceededWarning`.
2. Deprecated `util._extend` usage.
3. First-party C++ warnings.
4. npm dependency and vulnerability audit.
5. Vendored dependency warnings.
6. Static-link and bundle-size architectural decisions.
