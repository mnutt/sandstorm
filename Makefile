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
<<<<<<< HEAD
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
=======
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

# ====================================================================
# fetch/build workerd

tmp/.workerd-npm: $(WORKERD_NPM_PACKAGE_DIR)/package.json \
    $(wildcard $(WORKERD_NPM_PACKAGE_DIR)/package-lock.json)
	@$(call color,installing npm workerd)
	rm -rf tmp/workerd-npm
	@mkdir -p tmp/workerd-npm
	cp $(WORKERD_NPM_PACKAGE_DIR)/package.json tmp/workerd-npm/package.json
	@if test -e $(WORKERD_NPM_PACKAGE_DIR)/package-lock.json; then cp $(WORKERD_NPM_PACKAGE_DIR)/package-lock.json tmp/workerd-npm/package-lock.json; fi
	cd tmp/workerd-npm && if test -e package-lock.json; then PATH=$(METEOR_DEV_BUNDLE)/bin:$$PATH $(METEOR_DEV_BUNDLE)/bin/npm ci --no-fund; else PATH=$(METEOR_DEV_BUNDLE)/bin:$$PATH $(METEOR_DEV_BUNDLE)/bin/npm install --no-fund --no-save; fi
	@test "$$(cd tmp/workerd-npm && PATH=$(METEOR_DEV_BUNDLE)/bin:$$PATH $(METEOR_DEV_BUNDLE)/bin/node -p 'require("./node_modules/workerd/package.json").version')" = "$(WORKERD_NPM_VERSION)"
	@test -e tmp/workerd-npm/node_modules/.bin/workerd
	@touch $@

ifeq ($(WORKERD_BIN),)
bin/workerd: tmp/.workerd-npm
	@mkdir -p bin
	cp -L "$$(readlink -f tmp/workerd-npm/node_modules/.bin/workerd)" $@
	chmod +x $@
else
bin/workerd:
	@mkdir -p bin
	cp "$(WORKERD_BIN)" $@
endif

workerd: bin/workerd

verify-workerd-runtime: bin/workerd tmp/.workerd-npm
	@$(call color,verifying npm workerd)
	@test -z "$(WORKERD_BIN)" || (echo "error: WORKERD_BIN override cannot be used for reproducible bundles" >&2; exit 1)
	@test "$$(cd tmp/workerd-npm && PATH=$(METEOR_DEV_BUNDLE)/bin:$$PATH $(METEOR_DEV_BUNDLE)/bin/node -p 'require("./package-lock.json").packages[""].dependencies.workerd')" = "$(WORKERD_NPM_VERSION)"
	@test "$$(cd tmp/workerd-npm && PATH=$(METEOR_DEV_BUNDLE)/bin:$$PATH $(METEOR_DEV_BUNDLE)/bin/node -p 'require("./package-lock.json").packages["node_modules/workerd"].version')" = "$(WORKERD_NPM_VERSION)"
	@test "$$(cd tmp/workerd-npm && PATH=$(METEOR_DEV_BUNDLE)/bin:$$PATH $(METEOR_DEV_BUNDLE)/bin/node -p 'require("./node_modules/workerd/package.json").version')" = "$(WORKERD_NPM_VERSION)"
	cmp -s bin/workerd "$$(readlink -f tmp/workerd-npm/node_modules/.bin/workerd)"
	@expected_version="$$(printf '%s\n' "$(WORKERD_NPM_VERSION)" | sed -E 's/^1\.([0-9]{4})([0-9]{2})([0-9]{2})\..*$$/\1-\2-\3/')" && \
		test "$$(bin/workerd --version)" = "workerd $$expected_version"

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

tmp/.ekam-run: tmp/ekam-bin tmp/.capnp-es-npm src/sandstorm/* src/sandstorm/isolate/* tmp/.deps deps/boringssl/build/libssl.a deps/libsodium/build/src/libsodium/.libs/libsodium.a | deps/llvm-build
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

bundle: tmp/.ekam-run shell-build verify-workerd-runtime make-bundle.sh localedata-C meteor-bundle-main.js
	@$(call color,bundle)
	@CC=$(CC) ./make-bundle.sh
	cmp -s bundle/bin/workerd bin/workerd

sandstorm-$(BUILD).tar.xz: bundle
	@$(call color,compress release bundle)
	@tar c --transform="s,^bundle,sandstorm-$(BUILD)," bundle | xz -c -9e > sandstorm-$(BUILD).tar.xz

sandstorm-$(BUILD)-fast.tar.xz: bundle
	@$(call color,compress fast bundle)
	@tar c --transform="s,^bundle,sandstorm-$(BUILD)," bundle | xz -c -0 --threads=0 > sandstorm-$(BUILD)-fast.tar.xz

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
		src/sandstorm/isolate-bridge.capnp \
		src/sandstorm/isolate-supervisor-internal.capnp \
		src/sandstorm/outbound-http-session.capnp
	bin/spk capnp-abi --check tests/capnp-abi/isolate-bridge.capnp-abi.json \
		capnp:/sandstorm/isolate-bridge.capnp
	bin/spk capnp-abi --check tests/capnp-abi/isolate-supervisor-internal.capnp-abi.json \
		capnp:/sandstorm/isolate-supervisor-internal.capnp
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

isolate-supervisor-integration-test: tmp/.ekam-run $(CAPNP_ES_COMPILER_MODULE_DEPS) \
		isolate-capnp-abi-check isolate-capnp-corpus-test tests/assets/isolate-test-app.spk \
		tests/isolate-supervisor-integration.test.js
	CAPNP_ES_COMPILER_MODULE=$(CAPNP_ES_COMPILER_MODULE) \
	$(NODEJS) tests/isolate-supervisor-integration.test.js

isolate-supervisor-stress-test: tmp/.ekam-run tests/assets/isolate-test-app.spk tests/isolate-supervisor-integration.test.js
	ISOLATE_STRESS_64M=1 $(NODEJS) tests/isolate-supervisor-integration.test.js

isolate-supervisor-syscall-trace: tmp/.ekam-run tests/assets/isolate-test-app.spk tests/isolate-supervisor-integration.test.js
	@command -v strace >/dev/null || (echo "strace is required for this target" >&2; exit 1)
	@rm -rf tmp/isolate-syscall-trace
	@mkdir -p tmp/isolate-syscall-trace
	ISOLATE_SYSCALL_TRACE_DIR=$(CURDIR)/tmp/isolate-syscall-trace \
		ISOLATE_SYSCALL_TRACE_PROFILE=representative \
		$(NODEJS) tests/isolate-supervisor-integration.test.js
	@echo "wrote syscall traces to tmp/isolate-syscall-trace"
	@echo "workerd exec traces:"
	@grep -h 'execve.*workerd' tmp/isolate-syscall-trace/* || true

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
>>>>>>> bc4deb64 (add deterministic capnp corpus tests)
