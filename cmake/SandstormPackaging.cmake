function(sandstorm_add_packaging_targets)
  set(SANDSTORM_APP_INDEX_KEYRING "$ENV{HOME}/.sandstorm-keyring" CACHE FILEPATH
    "Keyring containing the app-index package signing key")
  set(_package_dir "${CMAKE_BINARY_DIR}/packages")
  set(_spk_stage "${_package_dir}/spk-stage")
  file(MAKE_DIRECTORY "${_package_dir}")

  set(_test_app_source "${PROJECT_SOURCE_DIR}/src/sandstorm/test-app")
  set(_test_app_stage "${_spk_stage}/sandstorm/test-app")
  set(_test_app_stage_stamp "${_package_dir}/test-app-stage.stamp")
  set(_test_app_html
    "${_test_app_source}/test-app.html"
    "${_test_app_source}/test-powerbox.html"
    "${_test_app_source}/shutdown.html"
    "${_test_app_source}/static-index.html")
  add_custom_command(
    OUTPUT "${_test_app_stage_stamp}"
    COMMAND "${CMAKE_COMMAND}" -E make_directory "${_test_app_stage}"
    COMMAND "${CMAKE_COMMAND}" -E copy_if_different
      "$<TARGET_FILE:test-app>"
      "${_test_app_source}/test-app.capnp"
      ${_test_app_html}
      "${_test_app_stage}"
    COMMAND "${CMAKE_COMMAND}" -E touch "${_test_app_stage_stamp}"
    DEPENDS
      test-app
      "${_test_app_source}/test-app.capnp"
      ${_test_app_html}
    COMMENT "Staging the Sandstorm test app package"
    VERBATIM)

  set(_test_app_spk "${_package_dir}/test-app.spk")
  add_custom_command(
    OUTPUT "${_test_app_spk}"
    COMMAND "$<TARGET_FILE:spk>" pack
      -k "${_test_app_source}/test-app.key"
      -I "${PROJECT_SOURCE_DIR}/src"
      -I "${_spk_stage}"
      -p "${_test_app_stage}/test-app.capnp:pkgdef"
      "${_test_app_spk}"
    WORKING_DIRECTORY "${PROJECT_SOURCE_DIR}"
    DEPENDS spk "${_test_app_stage_stamp}" "${_test_app_source}/test-app.key"
    COMMENT "Packing test-app.spk"
    VERBATIM)
  add_custom_target(test-app-spk DEPENDS "${_test_app_spk}")

  set(_app_index_source "${PROJECT_SOURCE_DIR}/src/sandstorm/app-index")
  set(_app_index_stage "${_spk_stage}/sandstorm/app-index")
  set(_app_index_stage_stamp "${_package_dir}/app-index-stage.stamp")
  add_custom_command(
    OUTPUT "${_app_index_stage_stamp}"
    COMMAND "${CMAKE_COMMAND}" -E make_directory "${_app_index_stage}"
    COMMAND "${CMAKE_COMMAND}" -E copy_if_different
      "$<TARGET_FILE:app-index>"
      "${_app_index_source}/app-index.capnp"
      "${_app_index_source}/review.html"
      "${_app_index_stage}"
    COMMAND "${CMAKE_COMMAND}" -E touch "${_app_index_stage_stamp}"
    DEPENDS
      app-index
      "${_app_index_source}/app-index.capnp"
      "${_app_index_source}/review.html"
    COMMENT "Staging the Sandstorm app index package"
    VERBATIM)

  set(_app_index_spk "${_package_dir}/app-index.spk")
  add_custom_command(
    OUTPUT "${_app_index_spk}"
    COMMAND "$<TARGET_FILE:spk>" pack
      -k "${SANDSTORM_APP_INDEX_KEYRING}"
      -I "${PROJECT_SOURCE_DIR}/src"
      -I "${_spk_stage}"
      -p "${_app_index_stage}/app-index.capnp:pkgdef"
      "${_app_index_spk}"
    WORKING_DIRECTORY "${PROJECT_SOURCE_DIR}"
    DEPENDS
      spk
      "${_app_index_stage_stamp}"
      "${PROJECT_SOURCE_DIR}/app-index-sandstorm-files.list"
    COMMENT "Packing app-index.spk"
    VERBATIM)
  add_custom_target(app-index-spk DEPENDS "${_app_index_spk}")

  if(NOT SANDSTORM_BUILD_FRONTEND OR NOT TARGET shell-build)
    return()
  endif()

  find_program(SANDSTORM_TAR_EXECUTABLE NAMES tar REQUIRED)
  find_program(SANDSTORM_XZ_EXECUTABLE NAMES xz REQUIRED)

  set(_bundle_dir "${CMAKE_BINARY_DIR}/bundle")
  set(_bundle_stamp "${CMAKE_BINARY_DIR}/bundle.stamp")
  file(GLOB _bundle_capnp_schemas CONFIGURE_DEPENDS
    "${PROJECT_SOURCE_DIR}/src/capnp/*.capnp"
    "${PROJECT_SOURCE_DIR}/src/sandstorm/*.capnp")
  add_custom_command(
    OUTPUT "${_bundle_stamp}"
    COMMAND "${CMAKE_COMMAND}" -E env
      "CC=${CMAKE_C_COMPILER}"
      "SANDSTORM_SOURCE_ROOT=${PROJECT_SOURCE_DIR}"
      "SANDSTORM_NATIVE_STAGE=${CMAKE_BINARY_DIR}/stage"
      "SANDSTORM_SHELL_BUILD_DIR=${CMAKE_BINARY_DIR}/shell-build"
      "SANDSTORM_BUNDLE_DIR=${_bundle_dir}"
      "SANDSTORM_WORK_DIR=${CMAKE_BINARY_DIR}/bundle-work"
      "${PROJECT_SOURCE_DIR}/make-bundle.sh"
    COMMAND "${CMAKE_COMMAND}" -E touch "${_bundle_stamp}"
    WORKING_DIRECTORY "${PROJECT_SOURCE_DIR}"
    DEPENDS
      shell-build
      stage-native
      "${PROJECT_SOURCE_DIR}/make-bundle.sh"
      "${PROJECT_SOURCE_DIR}/find-meteor-dev-bundle.sh"
      "${PROJECT_SOURCE_DIR}/localedata-C"
      "${PROJECT_SOURCE_DIR}/meteor-bundle-main.js"
      ${_bundle_capnp_schemas}
    COMMENT "Assembling the Sandstorm bundle"
    VERBATIM)
  add_custom_target(bundle DEPENDS "${_bundle_stamp}")

  function(_sandstorm_add_tarball target suffix fast)
    set(_output "${_package_dir}/sandstorm-${SANDSTORM_BUILD}${suffix}.tar.xz")
    add_custom_command(
      OUTPUT "${_output}"
      COMMAND "${CMAKE_COMMAND}"
        "-DBUNDLE_DIR=${_bundle_dir}"
        "-DOUTPUT_FILE=${_output}"
        "-DBUILD_NUMBER=${SANDSTORM_BUILD}"
        "-DTAR=${SANDSTORM_TAR_EXECUTABLE}"
        "-DXZ=${SANDSTORM_XZ_EXECUTABLE}"
        "-DFAST=${fast}"
        -P "${PROJECT_SOURCE_DIR}/cmake/CreateTarball.cmake"
      DEPENDS "${_bundle_stamp}" "${PROJECT_SOURCE_DIR}/cmake/CreateTarball.cmake"
      COMMENT "Creating ${_output}"
      VERBATIM)
    add_custom_target("${target}" DEPENDS "${_output}")
  endfunction()

  _sandstorm_add_tarball(package "" FALSE)
  _sandstorm_add_tarball(package-fast "-fast" TRUE)
endfunction()
