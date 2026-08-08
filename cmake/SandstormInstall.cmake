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

  add_custom_target(stage-native
    COMMAND "${CMAKE_COMMAND}" --install "${CMAKE_BINARY_DIR}"
      --prefix "${CMAKE_BINARY_DIR}/stage"
      --component native
    DEPENDS ${_native_targets}
    COMMENT "Staging native Sandstorm build outputs"
    VERBATIM)
endfunction()
