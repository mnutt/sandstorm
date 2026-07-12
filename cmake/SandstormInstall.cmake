include(GNUInstallDirs)
find_package(Git REQUIRED)
find_program(SANDSTORM_PATCH_EXECUTABLE NAMES patch REQUIRED)

function(sandstorm_install_native)
  add_custom_target(verify-workerd-source
    COMMAND "${CMAKE_COMMAND}"
      "-DGIT=${GIT_EXECUTABLE}"
      "-DREPOSITORY=${PROJECT_SOURCE_DIR}/deps/workerd"
      "-DEXPECTED=${SANDSTORM_WORKERD_SOURCE_COMMIT}"
      -P "${PROJECT_SOURCE_DIR}/cmake/VerifyGitHead.cmake"
    DEPENDS
      "${PROJECT_SOURCE_DIR}/deps/workerd"
      "${PROJECT_SOURCE_DIR}/cmake/VerifyGitHead.cmake"
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
      "${PROJECT_SOURCE_DIR}/src/sandstorm/isolate-host-main.c++"
      "${_workerd_embed_dir}/src/workerd/server/sandstorm-isolate-host.c++"
    COMMAND "${CMAKE_COMMAND}" -E chdir "${_workerd_embed_dir}"
      "${SANDSTORM_PATCH_EXECUTABLE}" -p1 -i "${_workerd_patch}"
    COMMAND "${CMAKE_COMMAND}" -E touch "${_workerd_embed_stamp}"
    DEPENDS
      verify-workerd-source
      "${PROJECT_SOURCE_DIR}/deps/workerd"
      "${PROJECT_SOURCE_DIR}/src/sandstorm/isolate-host-main.c++"
      "${_workerd_patch}"
    COMMENT "Preparing the embedded workerd host source"
    VERBATIM)

  set(_isolate_host_bin "${CMAKE_BINARY_DIR}/bin/isolate-host")
  add_custom_command(
    OUTPUT "${_isolate_host_bin}"
    COMMAND "${_bazel}" build --config=release
      //src/workerd/server:sandstorm-isolate-host
    COMMAND "${CMAKE_COMMAND}" -E copy
      "${_workerd_embed_dir}/bazel-bin/src/workerd/server/sandstorm-isolate-host"
      "${_isolate_host_bin}"
    WORKING_DIRECTORY "${_workerd_embed_dir}"
    DEPENDS "${_bazel}" "${_workerd_embed_stamp}"
    COMMENT "Building the embedded workerd isolate host"
    VERBATIM)
  add_custom_target(isolate-host DEPENDS "${_isolate_host_bin}")
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

  set(_workerd_dir "${CMAKE_BINARY_DIR}/workerd-npm")
  set(_workerd_bin "${CMAKE_BINARY_DIR}/bin/workerd")
  set(_workerd_package_dir "${PROJECT_SOURCE_DIR}/deps/workerd-npm")
  if(SANDSTORM_WORKERD_BIN)
    add_custom_command(
      OUTPUT "${_workerd_bin}"
      COMMAND "${CMAKE_COMMAND}" -E make_directory "${CMAKE_BINARY_DIR}/bin"
      COMMAND "${CMAKE_COMMAND}" -E copy
        "${SANDSTORM_WORKERD_BIN}" "${_workerd_bin}"
      DEPENDS "${SANDSTORM_WORKERD_BIN}"
      COMMENT "Staging the configured workerd binary"
      VERBATIM)
  else()
    add_custom_command(
      OUTPUT "${_workerd_bin}"
      COMMAND "${CMAKE_COMMAND}" -E remove_directory "${_workerd_dir}"
      COMMAND "${CMAKE_COMMAND}" -E make_directory
        "${_workerd_dir}" "${CMAKE_BINARY_DIR}/bin"
      COMMAND "${CMAKE_COMMAND}" -E copy
        "${_workerd_package_dir}/package.json"
        "${_workerd_package_dir}/package-lock.json"
        "${_workerd_dir}"
      COMMAND "${CMAKE_COMMAND}" -E env
        "PATH=${SANDSTORM_METEOR_DEV_BUNDLE}/bin:$ENV{PATH}"
        "${SANDSTORM_METEOR_DEV_BUNDLE}/bin/npm" ci
          --no-fund --prefix "${_workerd_dir}"
      COMMAND "${SANDSTORM_METEOR_DEV_BUNDLE}/bin/node" -e
        "const v=require('${_workerd_dir}/node_modules/workerd/package.json').version;if(v!=='${SANDSTORM_WORKERD_NPM_VERSION}')process.exit(1)"
      COMMAND "${CMAKE_COMMAND}" -E copy
        "${_workerd_dir}/node_modules/.bin/workerd" "${_workerd_bin}"
      DEPENDS
        "${_workerd_package_dir}/package.json"
        "${_workerd_package_dir}/package-lock.json"
      COMMENT "Installing workerd from npm"
      VERBATIM)
  endif()
  add_custom_target(workerd DEPENDS "${_workerd_bin}")
  if(SANDSTORM_WORKERD_BIN)
    add_custom_target(verify-workerd-runtime
      COMMAND "${CMAKE_COMMAND}" -E echo
        "SANDSTORM_WORKERD_BIN cannot be used for reproducible bundles"
      COMMAND "${CMAKE_COMMAND}" -E false
      DEPENDS workerd
      VERBATIM)
  else()
    string(REGEX REPLACE
      "^1\\.([0-9][0-9][0-9][0-9])([0-9][0-9])([0-9][0-9])\\..*$"
      "\\1-\\2-\\3" _workerd_release_date "${SANDSTORM_WORKERD_NPM_VERSION}")
    add_custom_target(verify-workerd-runtime
      COMMAND "${SANDSTORM_METEOR_DEV_BUNDLE}/bin/node" -e
        "const l=require('${_workerd_dir}/package-lock.json');const p=require('${_workerd_dir}/node_modules/workerd/package.json');const v='${SANDSTORM_WORKERD_NPM_VERSION}';if(l.packages[''].dependencies.workerd!==v||l.packages['node_modules/workerd'].version!==v||p.version!==v)process.exit(1)"
      COMMAND "${CMAKE_COMMAND}" -E compare_files
        "${_workerd_bin}" "${_workerd_dir}/node_modules/.bin/workerd"
      COMMAND "${CMAKE_COMMAND}"
        "-DCOMMAND=${_workerd_bin}"
        "-DARGUMENTS=--version"
        "-DEXPECTED=workerd ${_workerd_release_date}"
        -P "${PROJECT_SOURCE_DIR}/cmake/VerifyCommandOutput.cmake"
      DEPENDS workerd "${PROJECT_SOURCE_DIR}/cmake/VerifyCommandOutput.cmake"
      COMMENT "Verifying the bundled workerd runtime"
      VERBATIM)
  endif()
  install(PROGRAMS "${_workerd_bin}"
    DESTINATION "${CMAKE_INSTALL_BINDIR}"
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
    ip.capnp
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
    DEPENDS ${_native_targets} workerd
    COMMENT "Staging native Sandstorm build outputs"
    VERBATIM)
  add_custom_target(stage-native DEPENDS "${_native_stage_stamp}")
  set(SANDSTORM_NATIVE_STAGE_STAMP "${_native_stage_stamp}"
    CACHE INTERNAL "Stamp for staged native Sandstorm outputs" FORCE)
endfunction()
