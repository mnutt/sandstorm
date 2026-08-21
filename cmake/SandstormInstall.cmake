include(GNUInstallDirs)
function(sandstorm_install_native)
  # Keep staging progress and errors without listing every installed file and license.
  set(CMAKE_INSTALL_MESSAGE NEVER)
  set(_isolate_host_bin "${CMAKE_BINARY_DIR}/bin/isolate-host")
  set(_host_release "${CMAKE_BINARY_DIR}/isolate-host-${SANDSTORM_ISOLATE_HOST_VERSION}")
  set(_archive "${_host_release}.tar.xz")
  if(SANDSTORM_ISOLATE_HOST_EXECUTABLE)
    get_filename_component(_host_source "${SANDSTORM_ISOLATE_HOST_EXECUTABLE}" ABSOLUTE)
    set(_host_hash "")
    set(_host_deps "${_host_source}")
  else()
    if(NOT CMAKE_SYSTEM_PROCESSOR MATCHES "^(x86_64|AMD64)$")
      message(FATAL_ERROR "The isolate-host release supports Linux x86-64 only; supply SANDSTORM_ISOLATE_HOST_EXECUTABLE for this platform.")
    endif()
    add_custom_command(OUTPUT "${_archive}"
      COMMAND "${CMAKE_COMMAND}"
        "-DURL=https://github.com/mnutt/isolate-host/releases/download/v${SANDSTORM_ISOLATE_HOST_VERSION}/isolate-host-${SANDSTORM_ISOLATE_HOST_VERSION}-linux-x86_64.tar.xz"
        "-DOUTPUT=${_archive}"
        "-DSHA256=${SANDSTORM_ISOLATE_HOST_SHA256}"
        -P "${PROJECT_SOURCE_DIR}/cmake/DownloadVerified.cmake"
      DEPENDS "${PROJECT_SOURCE_DIR}/cmake/DownloadVerified.cmake"
      COMMENT "Downloading isolate-host ${SANDSTORM_ISOLATE_HOST_VERSION}"
      VERBATIM)
    set(_host_source "${_host_release}/bin/isolate-host")
    set(_host_hash "${SANDSTORM_ISOLATE_HOST_BINARY_SHA256}")
    set(_host_deps "${_archive}")
    install(DIRECTORY "${_host_release}/licenses/"
      DESTINATION "${CMAKE_INSTALL_DATADIR}/isolate-host/licenses" COMPONENT native)
    install(FILES "${_host_release}/LICENSE" "${_host_release}/NOTICE"
      "${_host_release}/manifest.json"
      DESTINATION "${CMAKE_INSTALL_DATADIR}/isolate-host" COMPONENT native)
  endif()
  set(_host_args
    "-DSOURCE=${_host_source}" "-DOUTPUT=${_isolate_host_bin}"
    "-DARCHIVE=${_archive}" "-DRELEASE_DIR=${_host_release}"
    "-DARCHIVE_SHA256=${SANDSTORM_ISOLATE_HOST_SHA256}"
    "-DBINARY_SHA256=${_host_hash}"
    "-DLOCAL_OVERRIDE=${SANDSTORM_ISOLATE_HOST_EXECUTABLE}")
  add_custom_command(OUTPUT "${_isolate_host_bin}"
    COMMAND "${CMAKE_COMMAND}" ${_host_args}
      -P "${PROJECT_SOURCE_DIR}/cmake/InstallIsolateHost.cmake"
    DEPENDS ${_host_deps} "${PROJECT_SOURCE_DIR}/cmake/InstallIsolateHost.cmake"
    COMMENT "Installing the prebuilt isolate host"
    VERBATIM)

  add_custom_target(isolate-host DEPENDS "${_isolate_host_bin}")
  add_custom_target(verify-isolate-host-artifact
    COMMAND "${CMAKE_COMMAND}" ${_host_args} -DVERIFY_ONLY=ON
      -P "${PROJECT_SOURCE_DIR}/cmake/InstallIsolateHost.cmake"
    DEPENDS isolate-host
    COMMENT "Verifying the selected isolate-host artifact"
    VERBATIM)
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

  # KV storage needs SQLite in Sandstorm, independently of the prebuilt worker host.
  set(_sqlite_dir "${CMAKE_BINARY_DIR}/generated/sqlite")
  set(_sqlite_archive "${_sqlite_dir}/sqlite-amalgamation-3470000.zip")
  set(_sqlite_source_dir "${_sqlite_dir}/sqlite-amalgamation-3470000")
  add_custom_command(
    OUTPUT "${_sqlite_source_dir}/sqlite3.c" "${_sqlite_source_dir}/sqlite3.h"
    COMMAND "${CMAKE_COMMAND}"
      "-DURL=https://sqlite.org/2024/sqlite-amalgamation-3470000.zip"
      "-DOUTPUT=${_sqlite_archive}"
      "-DSHA256=2842fddbb1cc33f66c7da998a57535f14a6bfee159676a07bb4bf3e59375d93e"
      -P "${PROJECT_SOURCE_DIR}/cmake/DownloadVerified.cmake"
    COMMAND "${CMAKE_COMMAND}" -E chdir "${_sqlite_dir}"
      "${CMAKE_COMMAND}" -E tar xf "${_sqlite_archive}"
    DEPENDS "${PROJECT_SOURCE_DIR}/cmake/DownloadVerified.cmake"
    COMMENT "Downloading the pinned SQLite amalgamation"
    VERBATIM)
  add_library(sandstorm_sqlite STATIC
    "${_sqlite_source_dir}/sqlite3.c" "${_sqlite_source_dir}/sqlite3.h")
  target_include_directories(sandstorm_sqlite PUBLIC "${_sqlite_source_dir}")
  target_compile_definitions(sandstorm_sqlite PRIVATE
    SQLITE_DEFAULT_FOREIGN_KEYS=1
    SQLITE_MAX_ALLOCATION_SIZE=16777216
    SQLITE_OMIT_SHARED_CACHE
    SQLITE_PRINTF_PRECISION_LIMIT=100000)
  target_compile_options(sandstorm_sqlite PRIVATE "$<$<COMPILE_LANGUAGE:C>:-w>")
  target_link_libraries(sandstorm_core PRIVATE sandstorm_sqlite)

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
