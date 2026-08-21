include(GNUInstallDirs)
find_package(Git REQUIRED)
find_program(SANDSTORM_PATCH_EXECUTABLE NAMES patch REQUIRED)

function(sandstorm_install_native)
  add_custom_target(verify-workerd-source
    COMMAND "${CMAKE_COMMAND}"
      "-DGIT=${GIT_EXECUTABLE}"
      "-DREPOSITORY=${PROJECT_SOURCE_DIR}/deps/workerd"
      "-DEXPECTED=${SANDSTORM_WORKERD_SOURCE_COMMIT}"
      "-DPATCH=${PROJECT_SOURCE_DIR}/patches/workerd/0001-add-sandstorm-isolate-host-target.patch"
      -P "${PROJECT_SOURCE_DIR}/cmake/VerifyGitHead.cmake"
    DEPENDS
      "${PROJECT_SOURCE_DIR}/deps/workerd"
      "${PROJECT_SOURCE_DIR}/cmake/VerifyGitHead.cmake"
      "${PROJECT_SOURCE_DIR}/patches/workerd/0001-add-sandstorm-isolate-host-target.patch"
    COMMENT "Verifying the pinned workerd source checkout"
    VERBATIM)

  set(_bazel "${CMAKE_BINARY_DIR}/tools/bazel-${SANDSTORM_BAZEL_VERSION}")
  add_custom_command(
    OUTPUT "${_bazel}"
    COMMAND "${CMAKE_COMMAND}"
      "-DURL=https://github.com/bazelbuild/bazel/releases/download/${SANDSTORM_BAZEL_VERSION}/bazel-${SANDSTORM_BAZEL_VERSION}-linux-x86_64"
      "-DOUTPUT=${_bazel}"
      "-DSHA256=${SANDSTORM_BAZEL_LINUX_X86_64_SHA256}"
      -P "${PROJECT_SOURCE_DIR}/cmake/DownloadVerified.cmake"
    DEPENDS "${PROJECT_SOURCE_DIR}/cmake/DownloadVerified.cmake"
    COMMENT "Downloading Bazel ${SANDSTORM_BAZEL_VERSION}"
    VERBATIM)

  set(_workerd_embed_dir "${CMAKE_BINARY_DIR}/workerd-embed")
  set(_workerd_embed_stamp "${_workerd_embed_dir}/.sandstorm-source.stamp")
  set(_workerd_patch
    "${PROJECT_SOURCE_DIR}/patches/workerd/0001-add-sandstorm-isolate-host-target.patch")
  add_custom_command(
    OUTPUT "${_workerd_embed_stamp}"
    COMMAND "${CMAKE_COMMAND}" -E remove_directory "${_workerd_embed_dir}"
    COMMAND "${CMAKE_COMMAND}" -E copy_directory
      "${PROJECT_SOURCE_DIR}/deps/workerd" "${_workerd_embed_dir}"
    COMMAND "${CMAKE_COMMAND}" -E copy
      "${PROJECT_SOURCE_DIR}/isolate-host/isolate-host-main.c++"
      "${_workerd_embed_dir}/src/workerd/server/sandstorm-isolate-host.c++"
    COMMAND "${CMAKE_COMMAND}" -E copy
      "${PROJECT_SOURCE_DIR}/src/sandstorm/isolate-host.capnp"
      "${_workerd_embed_dir}/src/workerd/server/sandstorm-isolate-host.capnp"
    COMMAND "${CMAKE_COMMAND}" -E copy
      "${PROJECT_SOURCE_DIR}/src/sandstorm/isolate-worker-source.capnp"
      "${_workerd_embed_dir}/src/workerd/server/sandstorm-isolate-worker-source.capnp"
    COMMAND "${CMAKE_COMMAND}" -E chdir "${_workerd_embed_dir}"
      "${SANDSTORM_PATCH_EXECUTABLE}" --batch --fuzz=0 -p1 -i "${_workerd_patch}"
    COMMAND "${CMAKE_COMMAND}" -E touch "${_workerd_embed_stamp}"
    DEPENDS
      verify-workerd-source
      "${PROJECT_SOURCE_DIR}/deps/workerd"
      "${PROJECT_SOURCE_DIR}/isolate-host/isolate-host-main.c++"
      "${PROJECT_SOURCE_DIR}/src/sandstorm/isolate-host.capnp"
      "${PROJECT_SOURCE_DIR}/src/sandstorm/isolate-worker-source.capnp"
      "${_workerd_patch}"
    COMMENT "Preparing the embedded workerd host source"
    VERBATIM)

  set(_isolate_host_bin "${CMAKE_BINARY_DIR}/bin/isolate-host")
  set(_sqlite_generated_dir "${CMAKE_BINARY_DIR}/generated/sqlite")
  set(_sqlite_source "${_sqlite_generated_dir}/sqlite3.c")
  set(_sqlite_header "${_sqlite_generated_dir}/sqlite3.h")
  # Bazel resolves /usr/lib/ccache/clang to the ccache binary, then invokes it
  # directly with Clang flags. Hide the symlink farm so it finds Clang itself.
  set(_bazel_path "$ENV{PATH}")
  string(REGEX REPLACE "^/usr/lib/ccache:" "" _bazel_path "${_bazel_path}")

  # Keep Bazel's compiler (and its detected standard-library include paths) in
  # sync with the compiler selected by CMake. This also avoids stale Bazel
  # toolchain detection when libc++ is installed after the first build.
  set(_bazel_build_options
    --config=release
    "--repo_env=CC=${CMAKE_C_COMPILER}")

  # Some Linux distributions, including Arch, package the static libc++ ABI
  # runtime separately. Workerd's Linux configuration links libc++.a directly,
  # so add libc++abi.a when the platform provides it as a separate archive.
  set(_saved_find_library_suffixes "${CMAKE_FIND_LIBRARY_SUFFIXES}")
  set(CMAKE_FIND_LIBRARY_SUFFIXES .a)
  find_library(SANDSTORM_LIBCXXABI_STATIC_LIBRARY NAMES c++abi)
  set(CMAKE_FIND_LIBRARY_SUFFIXES "${_saved_find_library_suffixes}")
  if(SANDSTORM_LIBCXXABI_STATIC_LIBRARY)
    list(APPEND _bazel_build_options
      "--linkopt=${SANDSTORM_LIBCXXABI_STATIC_LIBRARY}"
      "--host_linkopt=${SANDSTORM_LIBCXXABI_STATIC_LIBRARY}")
  endif()

  add_custom_command(
    OUTPUT
      "${_sqlite_source}"
      "${_sqlite_header}"
    COMMAND "${CMAKE_COMMAND}" -E env "PATH=${_bazel_path}"
      "${_bazel}" build ${_bazel_build_options}
      @sqlite3//:amalgamation
    COMMAND "${CMAKE_COMMAND}" -E make_directory "${_sqlite_generated_dir}"
    COMMAND "${CMAKE_COMMAND}" -E copy_if_different
      "${_workerd_embed_dir}/bazel-bin/external/sqlite3+/sqlite3.c"
      "${_sqlite_source}"
    COMMAND "${CMAKE_COMMAND}" -E copy_if_different
      "${_workerd_embed_dir}/bazel-bin/external/sqlite3+/sqlite3.h"
      "${_sqlite_header}"
    WORKING_DIRECTORY "${_workerd_embed_dir}"
    DEPENDS "${_bazel}" "${_workerd_embed_stamp}"
    COMMENT "Building the pinned SQLite amalgamation"
    VERBATIM)

  # Use workerd's pinned SQLite amalgamation so Sandstorm's static runtime
  # binaries do not depend on whichever SQLite happens to be installed on the
  # build host.
  add_library(sandstorm_sqlite STATIC "${_sqlite_source}" "${_sqlite_header}")
  target_include_directories(sandstorm_sqlite PUBLIC "${_sqlite_generated_dir}")
  target_compile_definitions(sandstorm_sqlite PRIVATE
    SQLITE_DEFAULT_FOREIGN_KEYS=1
    SQLITE_MAX_ALLOCATION_SIZE=16777216
    SQLITE_OMIT_SHARED_CACHE
    SQLITE_PRINTF_PRECISION_LIMIT=100000)
  target_compile_options(sandstorm_sqlite PRIVATE
    "$<$<COMPILE_LANGUAGE:C>:-w>")
  target_link_libraries(sandstorm_core PRIVATE sandstorm_sqlite)

  add_custom_command(
    OUTPUT "${_isolate_host_bin}"
    COMMAND "${CMAKE_COMMAND}" -E env "PATH=${_bazel_path}"
      "${_bazel}" build ${_bazel_build_options}
      //src/workerd/server:sandstorm-isolate-host
    COMMAND "${CMAKE_COMMAND}" -E copy
      "${_workerd_embed_dir}/bazel-bin/src/workerd/server/sandstorm-isolate-host"
      "${_isolate_host_bin}.new"
    COMMAND "${CMAKE_COMMAND}" -E rename
      "${_isolate_host_bin}.new" "${_isolate_host_bin}"
    WORKING_DIRECTORY "${_workerd_embed_dir}"
    DEPENDS "${_bazel}" "${_workerd_embed_stamp}"
    COMMENT "Building the embedded workerd isolate host"
    VERBATIM)

  add_custom_target(isolate-host DEPENDS "${_isolate_host_bin}")
  install(PROGRAMS "${_isolate_host_bin}"
    DESTINATION "${CMAKE_INSTALL_BINDIR}"
    COMPONENT native)
  add_custom_target(isolate-host-control-test
    COMMAND bash "${PROJECT_SOURCE_DIR}/cmake/RunIsolateHostControlTest.sh"
      "${_isolate_host_bin}"
      "$<TARGET_FILE:isolate-host-client>"
      "${CMAKE_BINARY_DIR}/isolate-host-control-test.sock"
    DEPENDS
      isolate-host
      isolate-host-client
      "${PROJECT_SOURCE_DIR}/cmake/RunIsolateHostControlTest.sh"
    COMMENT "Testing the shared isolate host control plane"
    VERBATIM)
  add_custom_target(isolate-backup-roundtrip-test
    COMMAND bash "${PROJECT_SOURCE_DIR}/cmake/RunIsolateBackupRoundTripTest.sh"
      "$<TARGET_FILE:sandstorm>"
      "${CMAKE_BINARY_DIR}"
      "${PROJECT_SOURCE_DIR}/src/sandstorm/isolate/api.js"
    DEPENDS
      sandstorm
      "${PROJECT_SOURCE_DIR}/cmake/RunIsolateBackupRoundTripTest.sh"
      "${PROJECT_SOURCE_DIR}/src/sandstorm/isolate/api.js"
    COMMENT "Testing isolate KV and file backup round-trips"
    VERBATIM)
  set(_native_targets
    sandstorm
    spk
    sandstorm-http-bridge
    capnp_tool
    capnpc_cpp
    capnpc_capnp)

  install(TARGETS ${_native_targets}
    RUNTIME DESTINATION "${CMAKE_INSTALL_BINDIR}"
    COMPONENT native)

  set(_sandstorm_node_schemas
    activity.capnp
    api-session-impl.capnp
    api-session.capnp
    backend.capnp
    email-impl.capnp
    email.capnp
    grain.capnp
    hack-session.capnp
    identity-impl.capnp
    identity.capnp
    isolate-authoring-impl.capnp
    isolate-authoring.capnp
    isolate-worker-source.capnp
    ip.capnp
    outbound-http-session-impl.capnp
    outbound-http-session.capnp
    package.capnp
    payments.capnp
    persistentuiview.capnp
    powerbox.capnp
    supervisor.capnp
    update-tool.capnp
    util.capnp
    web-session.capnp)
  list(TRANSFORM _sandstorm_node_schemas
    PREPEND "${CMAKE_CURRENT_SOURCE_DIR}/")
  install(FILES ${_sandstorm_node_schemas}
    DESTINATION node_modules/sandstorm
    COMPONENT native)

  set(_capnp_node_schemas
    c++.capnp
    persistent.capnp
    rpc-twoparty.capnp
    rpc.capnp
    schema.capnp
    stream.capnp)
  list(TRANSFORM _capnp_node_schemas
    PREPEND "${PROJECT_SOURCE_DIR}/src/capnp/")
  install(FILES ${_capnp_node_schemas}
    DESTINATION node_modules/capnp
    COMPONENT native)

  if(SANDSTORM_BUILD_NODE_CAPNP)
    install(TARGETS node_capnp
      LIBRARY DESTINATION node_modules
      COMPONENT native)
    install(FILES
      "${PROJECT_SOURCE_DIR}/deps/node-capnp/src/node-capnp/capnp.js"
      DESTINATION node_modules
      COMPONENT native)
    list(APPEND _native_targets node_capnp)
  endif()

  set(_native_stage_stamp "${CMAKE_BINARY_DIR}/stage/.native.stamp")
  add_custom_command(
    OUTPUT "${_native_stage_stamp}"
    COMMAND "${CMAKE_COMMAND}" --install "${CMAKE_BINARY_DIR}"
      --prefix "${CMAKE_BINARY_DIR}/stage"
      --component native
    COMMAND "${CMAKE_COMMAND}" -E touch "${_native_stage_stamp}"
    DEPENDS
      ${_native_targets}
      isolate-host
      "${PROJECT_SOURCE_DIR}/cmake/SandstormInstall.cmake"
    COMMENT "Staging native Sandstorm build outputs"
    VERBATIM)
  add_custom_target(stage-native DEPENDS "${_native_stage_stamp}")
  set(SANDSTORM_NATIVE_STAGE_STAMP "${_native_stage_stamp}"
    CACHE INTERNAL "Stamp for staged native Sandstorm outputs" FORCE)
endfunction()
