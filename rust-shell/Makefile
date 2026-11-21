.PHONY: build check test test-package test-recovery run dev cpp-fixture

cpp-fixture: target/cpp-fixture

target/cpp-fixture: fixture/main.c++ schema/fixture.capnp
	mkdir -p target/cpp
	capnp compile -Ischema --src-prefix=schema -oc++:target/cpp schema/fixture.capnp
	$(CXX) -std=c++17 -Wall -Wextra -Werror -Itarget/cpp fixture/main.c++ target/cpp/fixture.capnp.c++ -o $@ $$(pkg-config --cflags --libs capnp-rpc)

build:
	cd frontend && npm ci --ignore-scripts
	cd frontend && npm run build
	cargo build --locked

check:
	cargo fmt --check
	cargo clippy --locked --all-targets -- -D warnings
	cd frontend && npm run check

test: build check cpp-fixture
	cargo test --locked
	cd frontend && npm test

# Tests the fast bundle in an isolated server, not the user's running install.
# Build the bundle with `make fast` at the repository root first.
test-package:
	cd .. && TESTCASE=tests/rust-grain-session.js tests/run-local.sh build/dev/packages/sandstorm-0-fast.tar.xz build/dev/packages/test-app.spk

run:
	cargo run --locked

# Run on the same host as the installed Sandstorm server. The HTTPS gateway proxies this port.
dev:
	@echo "Open the existing Rust-shell HTTPS URL for hot reload."
	cd frontend && npm run dev

# Destructive only to tests/tmp-sandstorm, guarded by the recovery runner.
test-recovery:
	cd .. && RUN_RUST_RECOVERY=1 TESTCASE=tests/rust-recovery.js tests/run-local.sh build/dev/packages/sandstorm-0-fast.tar.xz build/dev/packages/test-app.spk
