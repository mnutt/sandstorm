# Sandstorm - Personal Cloud Sandbox
# Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
# All rights reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# You may override the following vars on the command line to suit
# your config.
CC=$(shell pwd)/deps/llvm-build/Release+Asserts/bin/clang
CXX=$(shell pwd)/deps/llvm-build/Release+Asserts/bin/clang++
CFLAGS=-O2 -Wall -g
CXXFLAGS=$(CFLAGS)
BUILD=0
PARALLEL=$(shell nproc)
LIBS=
EKAM=ekam
WORKERD_SOURCE_COMMIT=ea5e86d22f16996a3d8fdb8922c34eb7e8711cd3
BAZEL_VERSION=9.1.0
BAZEL_LINUX_X86_64_SHA256=a667454f3f4f8878df8199136b82c199f6ada8477b337fae3b1ef854f01e4e2f
CAPNP_ES_NPM_VERSION=0.3.0
CAPNP_ES_NPM_PACKAGE_DIR=deps/capnp-es-npm
CAPNP_ES_NPM_COMPILER_MODULE=$(abspath tmp/capnp-es-npm/node_modules/@mnutt/capnp-es/dist/compiler/index.mjs)
CAPNP_ES_COMPILER_MODULE?=$(CAPNP_ES_NPM_COMPILER_MODULE)

ifeq ($(CAPNP_ES_COMPILER_MODULE),$(CAPNP_ES_NPM_COMPILER_MODULE))
CAPNP_ES_COMPILER_MODULE_DEPS=tmp/.capnp-es-npm
else
CAPNP_ES_COMPILER_MODULE_DEPS=
endif

# You generally should not modify this.
# TODO(cleanup): -fPIC is unfortunate since most of our code is static binaries
#   but we also need to build a .node module which is a shared library, and it
#   needs to include all the Cap'n Proto code. Do we double-compile or do we
#   just accept it? Perhaps it's for the best since we probably should build
#   position-independent executables for security reasons?
# NOTE: Emperically -DKJ_STD_COMPAT appears to be necessary on recent ditros
#   (as of Jan 2020), notably Debian Sid, Fedora 30 and Archlinux. We're not
#   entirely sure what changed, but this seems like a backwards incompatibility
#   in libstdc++. See also issue #3171.
METEOR_DEV_BUNDLE=$(shell ./find-meteor-dev-bundle.sh)
METEOR_SPK_VERSION=0.6.0
METEOR_SPK=$(PWD)/meteor-spk-$(METEOR_SPK_VERSION)/meteor-spk
NODEJS=$(METEOR_DEV_BUNDLE)/bin/node
NODE_HEADERS=$(METEOR_DEV_BUNDLE)/include/node
WARNINGS=-Wall -Wextra -Wglobal-constructors -Wno-sign-compare -Wno-unused-parameter
CXXFLAGS2=-std=c++1z -include cstdint $(WARNINGS) $(CXXFLAGS) -DSANDSTORM_BUILD=$(BUILD) -DKJ_HAS_OPENSSL -DKJ_HAS_ZLIB -DKJ_HAS_LIBDL -pthread -fPIC -I$(NODE_HEADERS) -DKJ_STD_COMPAT
CFLAGS2=$(CFLAGS) -pthread -fPIC -DKJ_STD_COMPAT
# -lrt is not used by sandstorm itself, but the test app uses it. It would be
#  nice if we could not link everything against it.
LIBS2=$(LIBS) deps/libsodium/build/src/libsodium/.libs/libsodium.a deps/boringssl/build/libssl.a deps/boringssl/build/libcrypto.a -lz -ldl -pthread -lrt

define color
  printf '\033[0;34m==== $1 ====\033[0m\n'
endef


IMAGES= \
    shell/public/apps.svg \
    shell/public/appmarket.svg \
    shell/public/battery.svg \
    shell/public/bug.svg \
    shell/public/close.svg \
    shell/public/copy.svg \
    shell/public/debug.svg \
    shell/public/download.svg \
    shell/public/down.svg \
    shell/public/email.svg \
    shell/public/github.svg \
    shell/public/google.svg \
    shell/public/key.svg \
    shell/public/ldap.svg \
    shell/public/link.svg \
    shell/public/menu.svg \
    shell/public/notification.svg \
    shell/public/open-grain.svg \
    shell/public/openid.svg \
    shell/public/people.svg \
    shell/public/question-727272.svg \
    shell/public/question-a9a9a9.svg \
    shell/public/restart.svg \
    shell/public/restore.svg \
    shell/public/settings.svg \
    shell/public/source.svg \
    shell/public/share.svg \
    shell/public/search.svg \
    shell/public/trash.svg \
    shell/public/troubleshoot.svg \
    shell/public/upload.svg \
    shell/public/up.svg \
    shell/public/web.svg \
                             \
    shell/public/add-credit-m.svg \
    shell/public/add-email-m.svg \
    shell/public/apps-m.svg \
    shell/public/appmarket-m.svg \
    shell/public/bug-m.svg \
    shell/public/clipboard-m.svg \
    shell/public/close-m.svg \
    shell/public/copy-m.svg \
    shell/public/credit-m.svg \
    shell/public/down-m.svg \
    shell/public/debug-m.svg \
    shell/public/download-m.svg \
    shell/public/email-m.svg \
    shell/public/github-m.svg \
    shell/public/key-m.svg \
    shell/public/ldap-m.svg \
    shell/public/keybase-m.svg \
    shell/public/link-m.svg \
    shell/public/notification-m.svg \
    shell/public/open-grain-m.svg \
    shell/public/people-m.svg \
    shell/public/pronoun-m.svg \
    shell/public/restart-m.svg \
    shell/public/settings-m.svg \
    shell/public/share-m.svg \
    shell/public/source-m.svg \
    shell/public/trash-m.svg \
    shell/public/troubleshoot-m.svg \
    shell/public/twitter-m.svg \
    shell/public/up-m.svg \
    shell/public/unlink-m.svg \
    shell/public/web-m.svg \
                                  \
    shell/public/github-color.svg \
    shell/public/google-color.svg \
    shell/public/openid-color.svg \
    shell/public/email-494949.svg \
    shell/public/close-FFFFFF.svg \
                                  \
    shell/public/install-714DAA.svg \
    shell/public/install-896AC6.svg \
    shell/public/plus-6A237C.svg \
    shell/public/plus-9E40B5.svg \
    shell/public/upload-B7B7B7.svg \
    shell/public/upload-5D5D5D.svg \
    shell/public/restore-B7B7B7.svg \
    shell/public/restore-5D5D5D.svg

CAPNP_SCHEMAS=$(filter-out src/capnp/test%.capnp,$(wildcard src/capnp/*.capnp))
ISOLATE_CAPNP_ABI_BASELINES= \
    tests/capnp-abi/isolate-config.capnp-abi.json \
    tests/capnp-abi/isolate-account-host.capnp-abi.json \
    tests/capnp-abi/isolate-bridge.capnp-abi.json \
    tests/capnp-abi/isolate-exports.capnp-abi.json \
    tests/capnp-abi/isolate-host.capnp-abi.json \
    tests/capnp-abi/isolate-session-exports.capnp-abi.json \
    tests/capnp-abi/isolate-supervisor-internal.capnp-abi.json \
    tests/capnp-abi/isolate-worker-source.capnp-abi.json \
    tests/capnp-abi/outbound-http-session.capnp-abi.json

# ====================================================================
# Meta rules

.SUFFIXES:
.PHONY: all install clean clean-deps ci-clean continuous shell-env fast deps bootstrap-ekam update-deps test isolate-examples-test installer-test app-index-dev lint verify-workerd-source verify-isolate-release-bundle isolate-host isolate-host-control-test isolate-account-host-integration-test isolate-main-view-role-integration-test isolate-service-only-integration-test isolate-backend-recovery-test isolate-memory-benchmark isolate-cross-grain-benchmark isolate-capnp-abi-check isolate-capnp-corpus-test isolate-capnp-fuzz isolate-capnp-types-test isolate-capnp-toolchain-test isolate-test isolate-ci

all: sandstorm-$(BUILD).tar.xz

clean: ci-clean
	rm -rf shell/node_modules shell/.meteor/local $(IMAGES) shell/imports/client/changelog.html *.sig *.update-sig icons/node_modules shell/public/icons/icons-*.eot shell/public/icons/icons-*.ttf shell/public/icons/icons-*.svg shell/public/icons/icons-*.woff icons/package-lock.json tests/package-lock.json deps/llvm-build meteor-testapp/node_modules meteor-testapp/package-lock.json
	@# Note: capnproto, libseccomp, and node-capnp are integrated into the common build.
	cd deps/ekam && make clean
	rm -rf deps/libsodium/build
	rm -rf deps/boringssl/build

ci-clean:
	@# Clean only the stuff that we want to clean between CI builds.
	rm -rf bin tmp node_modules bundle shell-build sandstorm-*.tar.xz
	rm -rf test-app.spk isolate-test-app.spk isolate-api-powerbox-test-app.spk
	rm -rf isolate-api-provider-test-app.spk
	rm -rf tests/assets/meteor-testapp.spk tests/assets/isolate-test-app.spk
	rm -rf tests/assets/isolate-api-powerbox-test-app.spk
	rm -rf tests/assets/isolate-api-provider-test-app.spk
	rm -rf meteor-testapp/.meteor-spk

install: sandstorm-$(BUILD)-fast.tar.xz install.sh
	@$(call color,install)
	@./install.sh $<

update: sandstorm-$(BUILD)-fast.tar.xz
	@$(call color,update local server)
	@sudo sandstorm update $<

fast: sandstorm-$(BUILD)-fast.tar.xz

test: sandstorm-$(BUILD)-fast.tar.xz test-app.spk tests/assets/meteor-testapp.spk \
		tests/assets/isolate-test-app.spk \
		tests/assets/isolate-api-powerbox-test-app.spk \
		tests/assets/isolate-api-provider-test-app.spk
	tests/run-local.sh sandstorm-$(BUILD)-fast.tar.xz test-app.spk

isolate-examples-test: sandstorm-$(BUILD)-fast.tar.xz test-app.spk \
		tests/assets/isolate-api-powerbox-test-app.spk \
		tests/assets/isolate-api-provider-test-app.spk
	TESTCASE=apps/isolate-examples.js \
		tests/run-local.sh sandstorm-$(BUILD)-fast.tar.xz test-app.spk

lint: shell-env
	cd shell && meteor npm run lint
typecheck-ts:
	cd shell && meteor npm run typecheck

installer-test:
	(cd installer-tests && bash prepare-for-tests.sh && PYTHONUNBUFFERED=yes TERM=xterm SLOW_TEXT_TIMEOUT=120 ~/.local/bin/stodgy-tester --plugin stodgy_tester.plugins.sandstorm_installer_tests --on-vm-start=uninstall_sandstorm --rsync)

stylecheck:
	@which jscs > /dev/null 2>&1 || ( echo "You need jscs installed. Consider installing with e.g."; echo ; echo "npm -g install jscs"; echo ; exit 1)
	cd shell && jscs .

# ====================================================================
# Dependencies

DEPS=capnproto ekam libsodium node-capnp boringssl clang

# We list remotes so that if projects move hosts, we can pull from their new
# canonical location.
REMOTE_capnproto=https://github.com/sandstorm-io/capnproto.git master
REMOTE_ekam=https://github.com/sandstorm-io/ekam.git master
REMOTE_libseccomp=https://github.com/seccomp/libseccomp master
REMOTE_libsodium=https://github.com/jedisct1/libsodium.git stable
REMOTE_node-capnp=https://github.com/kentonv/node-capnp.git node10
REMOTE_boringssl=https://boringssl.googlesource.com/boringssl main
REMOTE_clang=https://chromium.googlesource.com/chromium/src/tools/clang.git main
deps/capnproto/.git:
	@# Probably user forgot to checkout submodules. Do it for them.
	@$(call color,"fetching submodules")
	git submodule update --init --recursive

deps: tmp/.deps

tmp/.deps: | deps/capnproto/.git
	@mkdir -p tmp
	@touch tmp/.deps

update-deps:
	@$(call color,updating all dependencies)
	@$(foreach DEP,$(DEPS), \
	    cd deps/$(DEP) && \
	    echo "pulling $(DEP)..." && \
	    git fetch $(REMOTE_$(DEP)) && \
	    git rebase FETCH_HEAD && \
	    cd ../..;)

# ====================================================================
# Get Clang
#
# We use the prebuilt Clang binaries from the Chromium project. We do this because I've observed
# Sandstorm contributors have a very hard time installing up-to-date versions of Clang on typcial
# Linux distros. Ubuntu and Debian ship with outdated versions of Clang, which means people have
# to install Clang from the LLVM apt repo. However, people struggle to set that up, and the repo
# has been known to randomly break from time to time. OTOH, the Chromium project maintains a very
# up-to-date version of Clang which is used to build Chrome, conveniently maintained as a git repo
# (which we can pin to a commit) containing a nice script that will download precompiled binaries.

deps/llvm-build: | tmp/.deps
	@$(call color,downloading Clang binaries from Chromium project)
	@deps/clang/scripts/update.py
	@mv third_party/llvm-build deps
	@rmdir third_party

# ====================================================================
# build BoringSSL

deps/boringssl/build/Makefile: | tmp/.deps deps/llvm-build
	@$(call color,configuring BoringSSL)
	@mkdir -p deps/boringssl/build
	cd deps/boringssl/build && cmake -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_COMPILER="$(CC)" -DCMAKE_CXX_COMPILER="$(CXX)" -DCMAKE_C_FLAGS="-fPIE" -DCMAKE_CXX_FLAGS="-fPIE" ..

deps/boringssl/build/libssl.a: deps/boringssl/build/Makefile
	@$(call color,building BoringSSL)
	cd deps/boringssl/build && make -j$(PARALLEL)

# ====================================================================
# build libsodium

deps/libsodium/build/Makefile: | tmp/.deps deps/llvm-build
	@$(call color,configuring libsodium)
	@mkdir -p deps/libsodium/build
	cd deps/libsodium/build && ../configure --disable-shared CC="$(CC)"

deps/libsodium/build/src/libsodium/.libs/libsodium.a: deps/libsodium/build/Makefile
	@$(call color,building libsodium)
	cd deps/libsodium/build && make -j$(PARALLEL)

verify-workerd-source:
	@test "$$(git -C deps/workerd rev-parse HEAD)" = "$(WORKERD_SOURCE_COMMIT)"
	@test -z "$$(git -C deps/workerd status --porcelain)"
	@cd deps/workerd && git apply --check \
		../../patches/workerd/0001-add-sandstorm-isolate-host-target.patch

tmp/bazel-$(BAZEL_VERSION):
	@$(call color,downloading Bazel $(BAZEL_VERSION))
	curl --proto '=https' --tlsv1.2 -L --fail \
		https://github.com/bazelbuild/bazel/releases/download/$(BAZEL_VERSION)/bazel-$(BAZEL_VERSION)-linux-x86_64 \
		-o $@.download
	@echo "$(BAZEL_LINUX_X86_64_SHA256)  $@.download" | sha256sum --check
	mv $@.download $@
	chmod +x $@

tmp/.workerd-embed-source: deps/workerd isolate-host/isolate-host-main.c++ \
		src/sandstorm/isolate-host.capnp \
		src/sandstorm/isolate-session-exports.capnp \
		src/sandstorm/isolate-exports.capnp \
		src/sandstorm/isolate-worker-source.capnp \
		patches/workerd/0001-add-sandstorm-isolate-host-target.patch
	rm -rf tmp/workerd-embed
	cp -a --reflink=auto deps/workerd tmp/workerd-embed
	cp isolate-host/isolate-host-main.c++ \
		tmp/workerd-embed/src/workerd/server/sandstorm-isolate-host.c++
	cp src/sandstorm/isolate-host.capnp \
		tmp/workerd-embed/src/workerd/server/sandstorm-isolate-host.capnp
	cp src/sandstorm/isolate-exports.capnp \
		tmp/workerd-embed/src/workerd/server/sandstorm-isolate-exports.capnp
	cp src/sandstorm/isolate-worker-source.capnp \
		tmp/workerd-embed/src/workerd/server/sandstorm-isolate-worker-source.capnp
	cd tmp/workerd-embed && patch --batch --fuzz=0 -p1 < \
		../../patches/workerd/0001-add-sandstorm-isolate-host-target.patch
	@touch $@

bin/isolate-host: tmp/bazel-$(BAZEL_VERSION) tmp/.workerd-embed-source
	# Bazel resolves /usr/lib/ccache/clang to the ccache binary, then invokes it
	# directly with Clang flags. Hide the symlink farm so it finds Clang itself.
	cd tmp/workerd-embed && PATH="$${PATH#/usr/lib/ccache:}" \
		../../tmp/bazel-$(BAZEL_VERSION) build --config=release \
		//src/workerd/server:sandstorm-isolate-host
	cp tmp/workerd-embed/bazel-bin/src/workerd/server/sandstorm-isolate-host $@.new
	mv -f $@.new $@

isolate-host: bin/isolate-host

isolate-host-control-test: bin/isolate-host tmp/.ekam-run
	@set -e; \
		socket="$(PWD)/tmp/isolate-host-control-test.sock"; \
		log="$(PWD)/tmp/isolate-host-control-test.log"; \
		baseline_tasks="$$log.baseline-tasks"; \
		rm -f "$$socket" "$$log" "$$baseline_tasks"; \
		bin/isolate-host "$$socket" >"$$log" 2>&1 & host_pid=$$!; \
		trap 'status=$$?; kill $$host_pid 2>/dev/null || true; wait $$host_pid 2>/dev/null || true; \
			if test $$status -ne 0; then cat "$$log"; fi; \
			rm -f "$$socket" "$$log" "$$baseline_tasks"; exit $$status' EXIT; \
		for attempt in $$(seq 1 100); do test -S "$$socket" && break; sleep 0.05; done; \
		test -S "$$socket"; \
		set -- /proc/$$host_pid/task/*; baseline_threads=$$#; \
		for task in "$$@"; do printf '%s %s\n' "$${task##*/}" "$$(cat "$$task/comm")"; done \
			>"$$baseline_tasks"; \
		tmp/sandstorm/isolate-host-client "$$socket"; \
		for attempt in $$(seq 1 100); do \
			set -- /proc/$$host_pid/task/*; \
			test "$$#" -le "$$((baseline_threads + 2))" && break; \
			sleep 0.01; \
		done; \
		set -- /proc/$$host_pid/task/*; final_threads=$$#; \
		test "$$final_threads" -le "$$((baseline_threads + 2))" || { \
			echo "isolate host leaked threads: $$baseline_threads -> $$final_threads" >&2; \
			echo "baseline threads:" >&2; cat "$$baseline_tasks" >&2; \
			echo "final threads:" >&2; \
			for task in "$$@"; do printf '%s %s\n' "$${task##*/}" "$$(cat "$$task/comm")"; done >&2; \
			exit 1; }; \
		grep -q '"message":"sandstorm-grain-log-marker","worker":"sandstorm-grains:testgrain123"' "$$log" || { \
			echo "isolate host log omitted testgrain123 worker attribution" >&2; exit 1; }; \
		grep -q '"message":"sandstorm-grain-log-marker","worker":"sandstorm-grains:cpugrain123"' "$$log" || { \
			echo "isolate host log omitted cpugrain123 worker attribution" >&2; exit 1; }; \
		kill $$host_pid; wait $$host_pid 2>/dev/null || true; rm -f "$$socket"; \
		SANDSTORM_ISOLATE_HOST_IDLE_TIMEOUT_MS=200 \
			bin/isolate-host "$$socket" >>"$$log" 2>&1 & host_pid=$$!; \
		for attempt in $$(seq 1 100); do test -S "$$socket" && break; sleep 0.05; done; \
		test -S "$$socket"; \
		tmp/sandstorm/isolate-host-client "$$socket" --idle-eviction

isolate-account-host-integration-test: bin/isolate-host tmp/.ekam-run \
		tests/assets/isolate-test-app.spk
	@set -e; root="$(PWD)/tmp/isolate-account-host-test"; \
		app_root="$$root/apps"; grain_root="$$root/grains"; \
		account_socket="$$root/account.sock"; \
		rm -rf "$$root"; mkdir -p "$$app_root" "$$grain_root"; \
		bin/spk unpack tests/assets/isolate-test-app.spk "$$app_root/testpackage123"; \
		cp -a "$$app_root/testpackage123" "$$app_root/oversizedpackage"; \
		chmod u+w "$$app_root/oversizedpackage/isolate-test/worker.js"; \
		: "Keep this one byte above MAX_ISOLATE_TOTAL_MODULE_BYTES in isolate-supervisor.c++."; \
		truncate -s 16777217 "$$app_root/oversizedpackage/isolate-test/worker.js"; \
		test "$$(stat -c %s "$$app_root/oversizedpackage/isolate-test/worker.js")" -eq 16777217; \
		ln -s "$(PWD)/bin/sandstorm" "$$root/isolate-account-host"; \
		trap 'kill $$account_pid 2>/dev/null || true; wait $$account_pid 2>/dev/null || true; rm -rf "$$root"' EXIT; \
		"$$root/isolate-account-host" \
			--trust-domain testaccount123 \
			--control-socket "$$account_socket" \
			--native-host "$(PWD)/bin/isolate-host" \
			--app-root "$$app_root" --grain-root "$$grain_root" & account_pid=$$!; \
		for attempt in $$(seq 1 100); do test -S "$$account_socket" && break; sleep 0.05; done; \
		test -S "$$account_socket"; \
		tmp/sandstorm/isolate-account-host-client \
			"$$account_socket" testgrain123 testpackage123; \
		grep -q '"topology": "accountSharedHost"' \
			"$$grain_root/testgrain123/isolate-runtime/runtime-manifest.json"; \
		grep -q '"topology": "accountSharedHost"' \
			"$$grain_root/testgrain456/isolate-runtime/runtime-manifest.json"; \
		grep -q '"topology": "accountSharedHost"' \
			"$$grain_root/concurrentgrain789/isolate-runtime/runtime-manifest.json"

isolate-main-view-role-integration-test: bin/isolate-host tmp/.ekam-run \
		tests/assets/isolate-test-app.spk
	@set -e; root="$(PWD)/tmp/isolate-main-view-role-test"; \
		app_root="$$root/apps"; grain_root="$$root/grains"; \
		account_socket="$$root/account.sock"; \
		rm -rf "$$root"; mkdir -p "$$app_root" "$$grain_root"; \
		bin/spk unpack tests/assets/isolate-test-app.spk "$$app_root/testpackage123"; \
		ln -s "$(PWD)/bin/sandstorm" "$$root/isolate-account-host"; \
		trap 'kill $$account_pid 2>/dev/null || true; wait $$account_pid 2>/dev/null || true; rm -rf "$$root"' EXIT; \
		"$$root/isolate-account-host" \
			--trust-domain mainviewtestaccount \
			--control-socket "$$account_socket" \
			--native-host "$(PWD)/bin/isolate-host" \
			--app-root "$$app_root" --grain-root "$$grain_root" & account_pid=$$!; \
		for attempt in $$(seq 1 100); do test -S "$$account_socket" && break; sleep 0.05; done; \
		test -S "$$account_socket"; \
		tmp/sandstorm/isolate-account-host-client \
			"$$account_socket" mainviewgrain testpackage123 --main-view-role; \
		grep -q '"topology": "accountSharedHost"' \
			"$$grain_root/mainviewgrain/isolate-runtime/runtime-manifest.json"

isolate-service-only-integration-test: bin/isolate-host tmp/.ekam-run \
		tests/assets/isolate-test-app.spk
	@set -e; root="$(PWD)/tmp/isolate-service-only-test"; \
		app_root="$$root/apps"; grain_root="$$root/grains"; \
		account_socket="$$root/account.sock"; \
		rm -rf "$$root"; mkdir -p "$$app_root" "$$grain_root"; \
		bin/spk unpack tests/assets/isolate-test-app.spk "$$app_root/testpackage123"; \
		ln -s "$(PWD)/bin/sandstorm" "$$root/isolate-account-host"; \
		trap 'kill $$account_pid 2>/dev/null || true; wait $$account_pid 2>/dev/null || true; rm -rf "$$root"' EXIT; \
		"$$root/isolate-account-host" \
			--trust-domain servicetestaccount \
			--control-socket "$$account_socket" \
			--native-host "$(PWD)/bin/isolate-host" \
			--app-root "$$app_root" --grain-root "$$grain_root" & account_pid=$$!; \
		for attempt in $$(seq 1 100); do test -S "$$account_socket" && break; sleep 0.05; done; \
		test -S "$$account_socket"; \
		tmp/sandstorm/isolate-account-host-client \
			"$$account_socket" servicegrain testpackage123 --service-only; \
		grep -q '"topology": "accountSharedHost"' \
			"$$grain_root/servicegrain/isolate-runtime/runtime-manifest.json"

isolate-backend-recovery-test: bin/isolate-host tmp/.ekam-run \
		tests/assets/isolate-test-app.spk
	@root="$(PWD)/tmp/isolate-backend-recovery-test"; \
		app_root="$$root/apps"; grain_root="$$root/grains"; state_root="$$root/state"; \
		rm -rf "$$root"; mkdir -p "$$app_root" "$$grain_root" "$$state_root"; \
		trap 'rm -rf "$$root"' EXIT; \
		bin/spk unpack tests/assets/isolate-test-app.spk "$$app_root/testpackage123"; \
		tmp/sandstorm/isolate-backend-recovery-client \
			"$(PWD)/bin/sandstorm" "$(PWD)/bin/isolate-host" \
			"$$app_root" "$$grain_root" "$$state_root"

isolate-memory-benchmark: bin/isolate-host tmp/.ekam-run
	@$(NODEJS) tests/isolate-memory-benchmark.js $(ISOLATE_MEMORY_BENCHMARK_ARGS)

isolate-cross-grain-benchmark: bin/isolate-host tmp/.ekam-run \
		tests/assets/isolate-test-app.spk
	@set -e; root="$(PWD)/tmp/isolate-cross-grain-benchmark"; \
		app_root="$$root/apps"; grain_root="$$root/grains"; \
		account_socket="$$root/account.sock"; account_log="$$root/account.log"; \
		rm -rf "$$root"; mkdir -p "$$app_root" "$$grain_root"; \
		bin/spk unpack tests/assets/isolate-test-app.spk "$$app_root/testpackage123" >/dev/null; \
		ln -s "$(PWD)/bin/sandstorm" "$$root/isolate-account-host"; \
		trap 'kill $$account_pid 2>/dev/null || true; wait $$account_pid 2>/dev/null || true; rm -rf "$$root"' EXIT; \
		"$$root/isolate-account-host" \
			--trust-domain benchmarkaccount \
			--control-socket "$$account_socket" \
			--native-host "$(PWD)/bin/isolate-host" \
			--app-root "$$app_root" --grain-root "$$grain_root" \
			>"$$account_log" 2>&1 & account_pid=$$!; \
		for attempt in $$(seq 1 100); do test -S "$$account_socket" && break; sleep 0.05; done; \
		test -S "$$account_socket"; \
		tmp/sandstorm/isolate-account-host-client \
			"$$account_socket" isolatebenchmarkprovider testpackage123 --benchmark \
			$(ISOLATE_CROSS_GRAIN_BENCHMARK_ARGS) || \
			{ status=$$?; cat "$$account_log"; exit $$status; }

# ====================================================================
# fetch capnp-es

tmp/.capnp-es-npm: $(CAPNP_ES_NPM_PACKAGE_DIR)/package.json \
    $(wildcard $(CAPNP_ES_NPM_PACKAGE_DIR)/package-lock.json)
	@$(call color,installing npm capnp-es)
	rm -rf tmp/capnp-es-npm
	@mkdir -p tmp/capnp-es-npm
	cp $(CAPNP_ES_NPM_PACKAGE_DIR)/package.json tmp/capnp-es-npm/package.json
	@if test -e $(CAPNP_ES_NPM_PACKAGE_DIR)/package-lock.json; then cp $(CAPNP_ES_NPM_PACKAGE_DIR)/package-lock.json tmp/capnp-es-npm/package-lock.json; fi
	cd tmp/capnp-es-npm && if test -e package-lock.json; then PATH=$(METEOR_DEV_BUNDLE)/bin:$$PATH $(METEOR_DEV_BUNDLE)/bin/npm ci --no-fund; else PATH=$(METEOR_DEV_BUNDLE)/bin:$$PATH $(METEOR_DEV_BUNDLE)/bin/npm install --no-fund --no-save; fi
	@test "$$(cd tmp/capnp-es-npm && PATH=$(METEOR_DEV_BUNDLE)/bin:$$PATH $(METEOR_DEV_BUNDLE)/bin/node -p 'require("./node_modules/@mnutt/capnp-es/package.json").version')" = "$(CAPNP_ES_NPM_VERSION)"
	@test -e "$(CAPNP_ES_NPM_COMPILER_MODULE)"
	@touch $@

# ====================================================================
# Ekam bootstrap and C++ binaries

tmp/ekam-bin: tmp/.deps
	@mkdir -p tmp
	@rm -f tmp/ekam-bin
	@which ekam >/dev/null && ln -s "`which ekam`" tmp/ekam-bin || \
	    (cd deps/ekam && $(MAKE) bin/ekam-bootstrap && \
	     cd ../.. && ln -s ../deps/ekam/bin/ekam-bootstrap tmp/ekam-bin)

tmp/.ekam-run: tmp/ekam-bin tmp/.capnp-es-npm src/sandstorm/* src/sandstorm/isolate/* \
		src/sandstorm/isolate/*/* tmp/.deps deps/boringssl/build/libssl.a \
		deps/libsodium/build/src/libsodium/.libs/libsodium.a | deps/llvm-build
	@$(call color,building sandstorm with ekam)
	@CC="$(CC)" CXX="$(CXX)" CFLAGS="$(CFLAGS2)" CXXFLAGS="$(CXXFLAGS2)" \
	    LIBS="$(LIBS2)" NODEJS=$(NODEJS) tmp/ekam-bin -j$(PARALLEL)
	@touch tmp/.ekam-run

continuous: tmp/.deps deps/boringssl/build/libssl.a deps/libsodium/build/src/libsodium/.libs/libsodium.a | deps/llvm-build
	@CC="$(CC)" CXX="$(CXX)" CFLAGS="$(CFLAGS2)" CXXFLAGS="$(CXXFLAGS2)" \
	    LIBS="$(LIBS2)" NODEJS=$(NODEJS) $(EKAM) -j$(PARALLEL) -c -n :41315 || \
	    ($(call color,You probably need to install ekam and put it on your path; see github.com/sandstorm-io/ekam) && false)

# ====================================================================
# Front-end shell

shell-env: tmp/.shell-env

# Meteor needs node-capnp available under node_modules. Depend on the copied
# files themselves so unrelated Ekam rebuilds do not invalidate the frontend.
tmp/.shell-env: node_modules/capnp node_modules/capnp.js node_modules/capnp.node $(IMAGES) shell/imports/client/changelog.html shell/client/styles/_icons.scss shell/package.json shell/package-lock.json
	@$(call color,configuring meteor frontend)
	@mkdir -p tmp
	@cd shell/ && PATH=$(METEOR_DEV_BUNDLE)/bin:$$PATH $(METEOR_DEV_BUNDLE)/bin/npm install --no-fund
	@touch tmp/.shell-env

node_modules/capnp: $(CAPNP_SCHEMAS)
	@mkdir -p node_modules/capnp
	@rm -f node_modules/capnp/*.capnp
	@cp $(CAPNP_SCHEMAS) node_modules/capnp

node_modules/capnp.js: deps/node-capnp/src/node-capnp/capnp.js
	@mkdir -p node_modules
	@cp $< $@

node_modules/capnp.node: tmp/node-capnp/capnp.node
	@mkdir -p node_modules
	@cp $< $@

icons/node_modules: icons/package.json
	cd icons && PATH=$(METEOR_DEV_BUNDLE)/bin:$$PATH $(METEOR_DEV_BUNDLE)/bin/npm install --no-fund

shell/client/styles/_icons.scss: icons/node_modules icons/*svg icons/Gruntfile.js
	cd icons && PATH=$(METEOR_DEV_BUNDLE)/bin:$$PATH ./node_modules/.bin/grunt

shell/imports/client/changelog.html: CHANGELOG.md
	@mkdir -p tmp
	@echo '<template name="changelog">' > tmp/changelog.html
	@markdown CHANGELOG.md >> tmp/changelog.html
	@echo '</template>' >> tmp/changelog.html
	@cp tmp/changelog.html shell/imports/client/changelog.html

shell/public/close-FFFFFF.svg: icons/close.svg
	@$(call color,custom color $<)
	@sed -e 's/#111111/#FFFFFF/g' < $< > $@

shell/public/install-714DAA.svg: icons/install.svg
	@$(call color,custom color $<)
	@sed -e 's/#111111/#714DAA/g' < $< > $@

shell/public/install-896AC6.svg: icons/install.svg
	@$(call color,custom color $<)
	@sed -e 's/#111111/#896AC6/g' < $< > $@

shell/public/plus-6A237C.svg: icons/plus.svg
	@$(call color,custom color $<)
	@sed -e 's/#111111/#6A237C/g' < $< > $@

shell/public/plus-9E40B5.svg: icons/plus.svg
	@$(call color,custom color $<)
	@sed -e 's/#111111/#9E40B5/g' < $< > $@

shell/public/upload-B7B7B7.svg: icons/upload.svg
	@$(call color,custom color $<)
	@sed -e 's/#111111/#B7B7B7/g' < $< > $@

shell/public/upload-5D5D5D.svg: icons/upload.svg
	@$(call color,custom color $<)
	@sed -e 's/#111111/#5D5D5D/g' < $< > $@

shell/public/restore-B7B7B7.svg: icons/restore.svg
	@$(call color,custom color $<)
	@sed -e 's/#111111/#B7B7B7/g' < $< > $@

shell/public/restore-5D5D5D.svg: icons/restore.svg
	@$(call color,custom color $<)
	@sed -e 's/#111111/#5D5D5D/g' < $< > $@

shell/public/%.svg: icons/%.svg
	@$(call color,color for dark background $<)
	@sed -e 's/#111111/#CCCCCC/g' < $< > $@

shell/public/google-color.svg: icons/google.svg
	@$(call color,custom color $<)
	@sed -e 's/#111111/#a53232/g' < $< > $@
shell/public/github-color.svg: icons/github.svg
	@$(call color,custom color $<)
	@sed -e 's/#111111/#191919/g' < $< > $@

shell/public/email-494949.svg: icons/email.svg
	@$(call color,custom color $<)
	@sed -e 's/#111111/#494949/g' < $< > $@

shell/public/question-a9a9a9.svg: icons/question.svg
	@$(call color,custom color $<)
	@sed -e 's/#111111/#A9A9A9/g' < $< > $@

shell/public/question-727272.svg: icons/question.svg
	@$(call color,custom color $<)
	@sed -e 's/#111111/#727272/g' < $< > $@

shell/public/%-m.svg: icons/%.svg
	@$(call color,color for light background $<)
	@# Make completely black.
	@sed -e 's/#111111/#000000/g' < $< > $@

shell-build: shell/imports/* shell/imports/*/* shell/imports/*/*/* shell/imports/*/*/*/* shell/client/main.ts shell/server/main.ts shell/public/* shell/i18n/* shell/.meteor/packages shell/.meteor/release shell/.meteor/versions tmp/.shell-env
	@$(call color,building meteor frontend)
	@test -z "$$(find -L shell/* -type l)" || (echo "error: broken symlinks in shell: $$(find -L shell/* -type l)" >&2 && exit 1)
	@OLD=`pwd` && cd shell && meteor build --directory "$$OLD/shell-build" --debug

# ====================================================================
# Bundle

bundle: tmp/.ekam-run shell-build isolate-host make-bundle.sh localedata-C meteor-bundle-main.js | verify-workerd-source
	@$(call color,bundle)
	@CC=$(CC) ./make-bundle.sh
	cmp -s bundle/bin/isolate-host bin/isolate-host

sandstorm-$(BUILD).tar.xz: bundle
	@$(call color,compress release bundle)
	@tar c --transform="s,^bundle,sandstorm-$(BUILD)," bundle | xz -c -9e > sandstorm-$(BUILD).tar.xz

sandstorm-$(BUILD)-fast.tar.xz: bundle
	@$(call color,compress fast bundle)
	@tar c --transform="s,^bundle,sandstorm-$(BUILD)," bundle | xz -c -0 --threads=0 > sandstorm-$(BUILD)-fast.tar.xz

verify-isolate-release-bundle: sandstorm-$(BUILD)-fast.tar.xz
	@test -x bundle/bin/isolate-host
	@test ! -e bundle/bin/workerd
	@cmp -s bundle/bin/isolate-host bin/isolate-host
	@test -f bundle/usr/lib/capnp-es/dist/compiler/index.mjs
	@test -f bundle/usr/include/sandstorm/package.capnp
	@test -f bundle/usr/include/sandstorm/isolate-bridge.capnp

# ====================================================================
# app-index.spk

# This is currently really really hacky because spk is not good at using a package definition file
# that is not located at the root of the source tree. In particular it is hard for the package
# definition file (living in the src tree) to refer to the `app-index` binary (living in the
# tmp tree).
#
# TODO(cleanup): Make spk better so that it can handle this.

app-index.spk: tmp/.ekam-run
	@cp src/sandstorm/app-index/app-index.capnp tmp/sandstorm/app-index/app-index.capnp
	@cp src/sandstorm/app-index/review.html tmp/sandstorm/app-index/review.html
	spk pack -Isrc -Itmp -ptmp/sandstorm/app-index/app-index.capnp:pkgdef app-index.spk

app-index-dev: tmp/.ekam-run
	@cp src/sandstorm/app-index/app-index.capnp tmp/sandstorm/app-index/app-index.capnp
	@cp src/sandstorm/app-index/review.html tmp/sandstorm/app-index/review.html
	spk dev -Isrc -Itmp -ptmp/sandstorm/app-index/app-index.capnp:pkgdef

# ====================================================================
# test-app.spk

# This is currently really really hacky because spk is not good at using a package definition file
# that is not located at the root of the source tree. In particular it is hard for the package
# definition file (living in the src tree) to refer to the `test-app` binary (living in the
# tmp tree).
#
# TODO(cleanup): Make spk better so that it can handle this.

test-app.spk: tmp/.ekam-run
	@cp src/sandstorm/test-app/test-app.capnp tmp/sandstorm/test-app/test-app.capnp
	@cp src/sandstorm/test-app/*.html tmp/sandstorm/test-app
	bin/spk pack -ksrc/sandstorm/test-app/test-app.key -Isrc -Itmp -ptmp/sandstorm/test-app/test-app.capnp:pkgdef test-app.spk

test-app-dev: tmp/.ekam-run
	@cp src/sandstorm/test-app/test-app.capnp tmp/sandstorm/test-app/test-app.capnp
	@cp src/sandstorm/test-app/*.html tmp/sandstorm/test-app
	spk dev -Isrc -Itmp -ptmp/sandstorm/test-app/test-app.capnp:pkgdef

isolate-capnp-abi-check: tmp/.ekam-run $(ISOLATE_CAPNP_ABI_BASELINES) \
		src/sandstorm/package.capnp \
		src/sandstorm/isolate-account-host.capnp \
		src/sandstorm/isolate-bridge.capnp \
		src/sandstorm/isolate-exports.capnp \
		src/sandstorm/isolate-host.capnp \
		src/sandstorm/isolate-supervisor-internal.capnp \
		src/sandstorm/isolate-worker-source.capnp \
		src/sandstorm/outbound-http-session.capnp
	bin/spk capnp-abi --struct Manifest.IsolateConfig \
		--check tests/capnp-abi/isolate-config.capnp-abi.json \
		capnp:/sandstorm/package.capnp
	bin/spk capnp-abi --check tests/capnp-abi/isolate-account-host.capnp-abi.json \
		capnp:/sandstorm/isolate-account-host.capnp
	bin/spk capnp-abi --check tests/capnp-abi/isolate-bridge.capnp-abi.json \
		capnp:/sandstorm/isolate-bridge.capnp
	bin/spk capnp-abi --check tests/capnp-abi/isolate-exports.capnp-abi.json \
		capnp:/sandstorm/isolate-exports.capnp
	bin/spk capnp-abi --check tests/capnp-abi/isolate-host.capnp-abi.json \
		capnp:/sandstorm/isolate-host.capnp
	bin/spk capnp-abi --check tests/capnp-abi/isolate-session-exports.capnp-abi.json \
		capnp:/sandstorm/isolate-session-exports.capnp
	bin/spk capnp-abi --check tests/capnp-abi/isolate-supervisor-internal.capnp-abi.json \
		capnp:/sandstorm/isolate-supervisor-internal.capnp
	bin/spk capnp-abi --check tests/capnp-abi/isolate-worker-source.capnp-abi.json \
		capnp:/sandstorm/isolate-worker-source.capnp
	bin/spk capnp-abi --check tests/capnp-abi/outbound-http-session.capnp-abi.json \
		capnp:/sandstorm/outbound-http-session.capnp

isolate-capnp-corpus-test: tmp/.ekam-run $(CAPNP_ES_COMPILER_MODULE_DEPS) \
		tests/isolate-capnp-corpus.test.js tests/capnp-corpus/corpus.capnp
	CAPNP_ES_COMPILER_MODULE=$(CAPNP_ES_COMPILER_MODULE) \
	$(NODEJS) tests/isolate-capnp-corpus.test.js

isolate-capnp-fuzz: tmp/.ekam-run $(CAPNP_ES_COMPILER_MODULE_DEPS) \
		tests/isolate-capnp-corpus.test.js tests/capnp-corpus/corpus.capnp
	ISOLATE_CAPNP_CORPUS_EXTRA_CASES=$${ISOLATE_CAPNP_CORPUS_EXTRA_CASES:-1024} \
	CAPNP_ES_COMPILER_MODULE=$(CAPNP_ES_COMPILER_MODULE) \
	$(NODEJS) tests/isolate-capnp-corpus.test.js

isolate-capnp-types-test: tmp/.ekam-run $(CAPNP_ES_COMPILER_MODULE_DEPS) \
		tests/isolate-capnp-types.test.js \
		src/sandstorm/isolate/api.d.ts src/sandstorm/isolate/capnp.d.ts
	@test -x tmp/capnp-es-npm/node_modules/typescript/bin/tsc
	$(NODEJS) tests/isolate-capnp-types.test.js

tests/assets/isolate-test-app.spk: tmp/.ekam-run $(CAPNP_ES_COMPILER_MODULE_DEPS) src/sandstorm/test-app/isolate-test-app.capnp src/sandstorm/test-app/isolate-test/*
	@mkdir -p tests/assets
	@mkdir -p tmp/sandstorm/isolate-test-app
	@cp src/sandstorm/test-app/isolate-test-app.capnp tmp/sandstorm/isolate-test-app/isolate-test-app.capnp
	@rm -rf tmp/sandstorm/isolate-test-app/isolate-test
	@cp -R src/sandstorm/test-app/isolate-test tmp/sandstorm/isolate-test-app/isolate-test
	SANDSTORM_CAPNP_ES_COMPILER_MODULE=$(CAPNP_ES_COMPILER_MODULE) \
	bin/spk pack -ksrc/sandstorm/test-app/isolate-test-app.key -Isrc -Itmp \
		-ptmp/sandstorm/isolate-test-app/isolate-test-app.capnp:pkgdef tests/assets/isolate-test-app.spk

isolate-test-app-dev: tmp/.ekam-run src/sandstorm/test-app/isolate-test-app.capnp src/sandstorm/test-app/isolate-test/*
	@mkdir -p tmp/sandstorm/isolate-test-app
	@cp src/sandstorm/test-app/isolate-test-app.capnp tmp/sandstorm/isolate-test-app/isolate-test-app.capnp
	@rm -rf tmp/sandstorm/isolate-test-app/isolate-test
	@cp -R src/sandstorm/test-app/isolate-test tmp/sandstorm/isolate-test-app/isolate-test
	spk dev -Isrc -Itmp -ptmp/sandstorm/isolate-test-app/isolate-test-app.capnp:pkgdef

isolate-capnp-toolchain-test: tmp/.ekam-run $(CAPNP_ES_COMPILER_MODULE_DEPS) \
		isolate-capnp-abi-check isolate-capnp-corpus-test isolate-capnp-types-test \
		tests/isolate-capnp-toolchain.test.js
	CAPNP_ES_COMPILER_MODULE=$(CAPNP_ES_COMPILER_MODULE) \
	$(NODEJS) tests/isolate-capnp-toolchain.test.js

isolate-test: isolate-capnp-toolchain-test

# Release gate for isolate support. Keep the account-shared topology,
# native host, and backend recovery in one CI target
# so adding a narrower test step cannot accidentally omit the released path.
isolate-ci:
	$(MAKE) verify-workerd-source
	$(MAKE) verify-isolate-release-bundle
	$(MAKE) isolate-test
	$(MAKE) isolate-host-control-test
	$(MAKE) isolate-main-view-role-integration-test
	$(MAKE) isolate-service-only-integration-test
	$(MAKE) isolate-account-host-integration-test
	$(MAKE) isolate-backend-recovery-test

tests/assets/isolate-api-powerbox-test-app.spk: \
		tmp/.ekam-run \
		src/sandstorm/test-app/isolate-api-powerbox-app.capnp \
		src/sandstorm/test-app/isolate-api-powerbox-app.key \
		src/sandstorm/test-app/isolate-api-powerbox/worker.js
	@mkdir -p tests/assets
	@mkdir -p tmp/sandstorm/isolate-api-powerbox-test-app
	@cp src/sandstorm/test-app/isolate-api-powerbox-app.capnp \
		tmp/sandstorm/isolate-api-powerbox-test-app/isolate-api-powerbox-app.capnp
	@rm -rf tmp/sandstorm/isolate-api-powerbox-test-app/isolate-api-powerbox
	@cp -R src/sandstorm/test-app/isolate-api-powerbox \
		tmp/sandstorm/isolate-api-powerbox-test-app/isolate-api-powerbox
	bin/spk pack -ksrc/sandstorm/test-app/isolate-api-powerbox-app.key -Isrc -Itmp \
		-ptmp/sandstorm/isolate-api-powerbox-test-app/isolate-api-powerbox-app.capnp:pkgdef \
		tests/assets/isolate-api-powerbox-test-app.spk

tests/assets/isolate-api-provider-test-app.spk: \
		tmp/.ekam-run \
		src/sandstorm/test-app/isolate-api-provider-app.capnp \
		src/sandstorm/test-app/isolate-api-provider-app.key \
		src/sandstorm/test-app/isolate-api-provider/worker.js
	@mkdir -p tests/assets
	@mkdir -p tmp/sandstorm/isolate-api-provider-test-app
	@cp src/sandstorm/test-app/isolate-api-provider-app.capnp \
		tmp/sandstorm/isolate-api-provider-test-app/isolate-api-provider-app.capnp
	@rm -rf tmp/sandstorm/isolate-api-provider-test-app/isolate-api-provider
	@cp -R src/sandstorm/test-app/isolate-api-provider \
		tmp/sandstorm/isolate-api-provider-test-app/isolate-api-provider
	bin/spk pack -ksrc/sandstorm/test-app/isolate-api-provider-app.key -Isrc -Itmp \
		-ptmp/sandstorm/isolate-api-provider-test-app/isolate-api-provider-app.capnp:pkgdef \
		tests/assets/isolate-api-provider-test-app.spk

# ====================================================================
# meteor-testapp.spk

$(METEOR_SPK):
	@$(call color,downloading meteor-spk)
	@curl https://dl.sandstorm.io/meteor-spk-$(METEOR_SPK_VERSION).tar.xz | tar Jxf -

meteor-testapp-dev: $(METEOR_SPK)
	cd meteor-testapp && PATH="$(PWD)/bin:$(PATH)" \
		$(METEOR_SPK) dev -I../src -I../tmp -s /opt/sandstorm

tests/assets/meteor-testapp.spk: \
		meteor-testapp \
		$(METEOR_SPK) \
		meteor-testapp/client/* \
		meteor-testapp/server/* \
		meteor-testapp/.meteor/*
	@cd meteor-testapp && PATH="$(PWD)/bin:$(PATH)" \
		$(METEOR_SPK) pack -kmeteor-testapp.key -I../src -I../tmp ../tests/assets/meteor-testapp.spk
