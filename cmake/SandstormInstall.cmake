include(GNUInstallDirs)

function(sandstorm_install_native)
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
