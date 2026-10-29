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


  set(_native_stage_stamp "${CMAKE_BINARY_DIR}/stage/.native.stamp")
  add_custom_command(
    OUTPUT "${_native_stage_stamp}"
    COMMAND "${CMAKE_COMMAND}" --install "${CMAKE_BINARY_DIR}"
      --prefix "${CMAKE_BINARY_DIR}/stage"
      --component native
    COMMAND "${CMAKE_COMMAND}" -E touch "${_native_stage_stamp}"
    DEPENDS ${_native_targets}
    COMMENT "Staging native Sandstorm build outputs"
    VERBATIM)
  add_custom_target(stage-native DEPENDS "${_native_stage_stamp}")
  set(SANDSTORM_NATIVE_STAGE_STAMP "${_native_stage_stamp}"
    CACHE INTERNAL "Stamp for staged native Sandstorm outputs" FORCE)
endfunction()
