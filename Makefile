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

# Compatibility entry points for developers with existing Make commands.
# CMake and Ninja are the only build backend; new commands should use the
# presets in CMakePresets.json directly.

CMAKE_PRESET ?= dev
BUILD ?= 0

CMAKE_CONFIGURE = cmake --preset $(CMAKE_PRESET) -DSANDSTORM_BUILD=$(BUILD)
CMAKE_BUILD = cmake --build --preset $(CMAKE_PRESET)

.PHONY: all configure toolchain deps update-deps clean ci-clean \
	package fast install update test isolate-examples-test lint typecheck typecheck-ts installer-test \
	isolate-supervisor-integration-test \
	isolate-supervisor-stress-test \
	isolate-supervisor-syscall-trace \
	isolate-capnp-abi-check \
	isolate-capnp-corpus-test isolate-capnp-fuzz \
	isolate-capnp-toolchain-test isolate-test \
	stage-native workerd verify-workerd-runtime shell-env shell-build shell-build-debug bundle \
	test-app.spk test-app-spk test-app-dev app-index.spk app-index-spk app-index-dev \
	tests/assets/isolate-test-app.spk isolate-test-app-spk isolate-test-app-dev \
	tests/assets/isolate-api-powerbox-test-app.spk \
	tests/assets/isolate-api-provider-test-app.spk \
	meteor-testapp-stage meteor-testapp-spk meteor-testapp-dev \
	tests/assets/meteor-testapp.spk release-gate-upgrade-308

all: package

ifeq ($(filter $(CMAKE_PRESET),dev release),$(CMAKE_PRESET))
configure: toolchain
endif
configure:
	$(CMAKE_CONFIGURE)

toolchain: deps/llvm-build

.PHONY: deps/llvm-build
deps/llvm-build: deps
	deps/clang/scripts/update.py --output-dir deps/llvm-build
	@test -e deps/llvm-build/bin/clang++ || ln -s clang deps/llvm-build/bin/clang++

deps:
	git submodule update --init --recursive

update-deps:
	git submodule update --init --remote --rebase

clean ci-clean:
	@if test -d build/$(CMAKE_PRESET); then \
		$(CMAKE_BUILD) --target clean clean-frontend; \
	fi

define cmake_target
$1: configure
	$$(CMAKE_BUILD) --target $2
endef

$(eval $(call cmake_target,package,package))
$(eval $(call cmake_target,fast,package-fast))
$(eval $(call cmake_target,install,install-local))
$(eval $(call cmake_target,update,update-local))
$(eval $(call cmake_target,test,system-test))
$(eval $(call cmake_target,isolate-examples-test,isolate-examples-test))
$(eval $(call cmake_target,lint,lint))
$(eval $(call cmake_target,typecheck,typecheck))
$(eval $(call cmake_target,typecheck-ts,typecheck))
$(eval $(call cmake_target,installer-test,installer-test))
$(eval $(call cmake_target,stage-native,stage-native))
$(eval $(call cmake_target,workerd,workerd))
$(eval $(call cmake_target,verify-workerd-runtime,verify-workerd-runtime))
$(eval $(call cmake_target,shell-env,shell-env))
$(eval $(call cmake_target,shell-build,shell-build))
$(eval $(call cmake_target,shell-build-debug,shell-build-debug))
$(eval $(call cmake_target,bundle,bundle))
$(eval $(call cmake_target,test-app.spk,test-app-spk))
$(eval $(call cmake_target,test-app-spk,test-app-spk))
$(eval $(call cmake_target,test-app-dev,test-app-dev))
$(eval $(call cmake_target,tests/assets/isolate-test-app.spk,isolate-test-app-spk))
$(eval $(call cmake_target,isolate-test-app-spk,isolate-test-app-spk))
$(eval $(call cmake_target,isolate-test-app-dev,isolate-test-app-dev))
$(eval $(call cmake_target,isolate-supervisor-integration-test,isolate-supervisor-integration-test))
$(eval $(call cmake_target,isolate-supervisor-stress-test,isolate-supervisor-stress-test))
$(eval $(call cmake_target,isolate-supervisor-syscall-trace,isolate-supervisor-syscall-trace))
$(eval $(call cmake_target,isolate-capnp-abi-check,isolate-capnp-abi-check))
$(eval $(call cmake_target,isolate-capnp-corpus-test,isolate-capnp-corpus-test))
$(eval $(call cmake_target,isolate-capnp-fuzz,isolate-capnp-fuzz))
$(eval $(call cmake_target,isolate-capnp-toolchain-test,isolate-capnp-toolchain-test))
$(eval $(call cmake_target,isolate-test,isolate-test))
$(eval $(call cmake_target,tests/assets/isolate-api-powerbox-test-app.spk,isolate-api-powerbox-test-app-spk))
$(eval $(call cmake_target,tests/assets/isolate-api-provider-test-app.spk,isolate-api-provider-test-app-spk))
$(eval $(call cmake_target,app-index.spk,app-index-spk))
$(eval $(call cmake_target,app-index-spk,app-index-spk))
$(eval $(call cmake_target,app-index-dev,app-index-dev))
$(eval $(call cmake_target,meteor-testapp-stage,meteor-testapp-stage))
$(eval $(call cmake_target,meteor-testapp-spk,meteor-testapp-spk))
$(eval $(call cmake_target,meteor-testapp-dev,meteor-testapp-dev))
$(eval $(call cmake_target,tests/assets/meteor-testapp.spk,meteor-testapp-spk))

release-gate-upgrade-308:
	@echo "release-gate-upgrade-308 has not been migrated to CMake." >&2
	@echo "Run tests/release-gates/upgrade-from-308.sh manually with CMake-built packages." >&2
	@false
